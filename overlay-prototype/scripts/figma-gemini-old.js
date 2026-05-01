import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { GoogleGenAI, mcpToTool } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const TEST_DESIGN_ID = 'design-a';
const TEST_DESIGN_URL = 'https://www.figma.com/design/DveUacGuz5nlURkX6OSrto/AI-Menu-Board-Pipeline?node-id=86-385&m=dev';
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

const DESIGN_PATH = path.join(PROJECT_ROOT, 'data', 'designs', `${TEST_DESIGN_ID}.json`);
const ITEMS_PATH = path.join(PROJECT_ROOT, 'data', 'items.json');

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          variantId: { type: 'string' },
          field: { type: 'string', enum: ['price', 'calories'] },
          // [ymin, xmin, ymax, xmax] normalized to 0-1000 — Gemini's native detection format
          box_2d: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
          confidence: { type: 'number' },
          reasoning: { type: 'string' },
        },
        required: ['itemId', 'variantId', 'field', 'box_2d', 'confidence', 'reasoning'],
      },
    },
  },
  required: ['slots'],
};

const DEBUG = process.argv.includes('--debug');
const MIN_SLOT_COUNT = 4;

function round(value, decimals = 3) {
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

function normalizeSlot(slot) {
  const itemId = String(slot.itemId || '').trim();
  const variantId = String(slot.variantId || '').trim();
  const field = String(slot.field || '').trim();
  const confidence = Number(slot.confidence);

  if (!itemId || !variantId) throw new Error('slot.itemId and slot.variantId are required');
  if (field !== 'price' && field !== 'calories') throw new Error(`Invalid field: ${field}`);
  if (!Number.isFinite(confidence)) throw new Error(`Invalid confidence: ${slot.confidence}`);

  const box = slot.box_2d;
  if (!Array.isArray(box) || box.length !== 4) throw new Error(`Invalid box_2d for ${itemId}/${variantId}/${field}`);
  const [ymin, xmin, ymax, xmax] = box.map(Number);
  if ([ymin, xmin, ymax, xmax].some((v) => !Number.isFinite(v))) {
    throw new Error(`Non-numeric box_2d values for ${itemId}/${variantId}/${field}`);
  }

  // Descale from Gemini's normalized 0-1000 range to canvas pixels (top-left of bounding box)
  const x = round((xmin / 1000) * CANVAS_WIDTH, 4);
  const y = round((ymin / 1000) * CANVAS_HEIGHT, 4);

  if (x < 0 || x > CANVAS_WIDTH || y < 0 || y > CANVAS_HEIGHT) {
    throw new Error(`Coordinates out of range for ${itemId}/${variantId}/${field}`);
  }

  return {
    itemId,
    variantId,
    field,
    x,
    y,
    confidence: Math.max(0, Math.min(1, round(confidence, 4))),
    reasoning: String(slot.reasoning || '').trim(),
  };
}

function validateSemanticQuality(slots) {
  if (!Array.isArray(slots) || slots.length < MIN_SLOT_COUNT) {
    throw new Error(
      `Extraction quality gate failed: expected at least ${MIN_SLOT_COUNT} slots, received ${slots?.length || 0}`
    );
  }

  const invalidVariant = slots.find((s) => {
    const v = String(s.variantId || '').toLowerCase();
    return !v || v === 'unknown' || v === 'n/a' || v === 'na';
  });
  if (invalidVariant) {
    throw new Error(
      `Extraction quality gate failed: invalid variantId "${invalidVariant.variantId}" for item "${invalidVariant.itemId}"`
    );
  }

  const allZero = slots.filter((s) => Number(s.x) === 0 && Number(s.y) === 0);
  if (allZero.length > 0) {
    throw new Error(
      `Extraction quality gate failed: ${allZero.length} slots returned 0,0 coordinates`
    );
  }

  const lowConfidence = slots.filter((s) => Number(s.confidence) <= 0.01);
  if (lowConfidence.length > 0) {
    throw new Error(
      `Extraction quality gate failed: ${lowConfidence.length} slots have confidence <= 0.01`
    );
  }

  const uniquePositions = new Set(slots.map((s) => `${s.x}:${s.y}`));
  if (uniquePositions.size < Math.max(6, Math.floor(slots.length * 0.5))) {
    throw new Error(
      'Extraction quality gate failed: too many overlapping/repeated coordinates'
    );
  }
}


async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
  if (!process.env.FIGMA_MCP_URL) throw new Error('FIGMA_MCP_URL is required');

  const existingDesign = JSON.parse(await readFile(DESIGN_PATH, 'utf8'));
  const items = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));

  // ── Clients ────────────────────────────────────────────────────────────────
  // JSON output + tools requires a Gemini 3 series model.
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

  const mcpClient = new Client({ name: 'figma-gemini', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(cleanUrl(process.env.FIGMA_MCP_URL)));
  await mcpClient.connect(transport);
  if (DEBUG) console.log('[debug] MCP connected');

  // ── Prompts ────────────────────────────────────────────────────────────────
  const systemInstruction = [
    'You are visually analyzing JPG images of a menu board design to extract the position of price and calorie values.',
    'The position coordinates you identify will be used to produce dynamic HTML overlays.',
    'Use the provided Figma tools to view the design images.',
    'Return structured JSON only — no placeholder values, no "unknown" variants.',
    'For each text element, return its bounding box as box_2d: [ymin, xmin, ymax, xmax] normalized to 0-1000.',
  ].join(' ');

  const prompt = [
    'Task: Extract dynamic overlay slot data from a Chick-fil-A menu board design.',
    '',
    'Background:',
    'You are analyzing a JPG image of a Chick-fil-A menu board. The image shows the board with price',
    'and calorie text populated. Your job is to identify every price and calorie value in the image',
    'and record the bounding box of each text element.',
    '',
    'Each menu item may have multiple price/calorie values depending on its variants. To locate them,',
    'use visual keywords: the item name (matched against the catalog), variant labels such as "Meal" or',
    '"Entree", and the values themselves — prices look like "7.50" or "10.25", calories look like "690 cal".',
    '',
    'Steps:',
    '1) Use Figma tools to view the design image.',
    '2) Identify every menu item visible on the board by identifying text that matches an item name.',
    '3) Match each item name to an itemId from the items catalog below.',
    '4) Identify the variant(s) for each item (meal, entree, meal-3ct, meal-8ct, entree-3ct, entree-8ct, etc.).',
    '   If an item has no visible variant label — just a single price and calories — use variantId "base".',
    '   Variants that include a count (like "3ct" or "8ct") can be identified by looking for the number followed by "ct".',
    '5) For each price and calorie value, return its bounding box as box_2d: [ymin, xmin, ymax, xmax]',
    '   with all four values normalized to 0-1000, where 0 is the top/left edge and 1000 is the bottom/right edge.',
    '   Draw a tight box around only the text value itself (e.g. "10.25" or "690 cal"), not the whole item block.',
    '6) Return one slot per value with field exactly "price" or "calories".',
    '',
    'Coordinate rules:',
    '- box_2d format is [ymin, xmin, ymax, xmax] normalized to 0-1000.',
    '- 0,0 is the top-left corner; 1000,1000 is the bottom-right corner.',
    '- Draw the tightest box that fully contains the text value.',
    '- Provide an honest confidence score (0–1) for each. Consider why you are more or less confident',
    '  (e.g. text is partially obscured, small, ambiguous variant label) and provide an accurate value.',
    '',
    'Output rules:',
    '- Cover the entire design — every visible price and calorie value.',
    '- No placeholders: no "unknown" variants, no confidence 0.',
    '- For each slot, include a "reasoning" string that explains: how you identified the item and variant,',
    '  how you determined the bounding box, what visual cues you used, and anything you were uncertain about.',
    '- Return only structured output matching the schema.',
    '',
    `Design ID: ${TEST_DESIGN_ID}`,
    `Design URL: ${TEST_DESIGN_URL}`,
    '',
    'Item catalog (id -> name):',
    JSON.stringify(items, null, 2),
  ].join('\n');

  // ── Single call: mcpToTool bridges the MCP server and the SDK auto-executes
  //   tool calls. JSON output + tools requires a Gemini 3 series model. ───────
  let result;
  try {
    result = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction,
        tools: [mcpToTool(mcpClient)],
        responseMimeType: 'application/json',
        responseJsonSchema: OUTPUT_SCHEMA,
      },
    });
  } finally {
    await mcpClient.close().catch(() => {});
  }

  if (DEBUG) {
    console.log('[debug] usage:', result.usageMetadata);
    console.log('[debug] raw (first 1000 chars):', result.text?.slice(0, 1000));
  }

  const raw = result.text ?? '';
  if (!raw.trim()) {
    throw new Error('Gemini returned an empty response. Re-run with --debug to inspect.');
  }
  let structured;
  try {
    structured = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse Gemini structured output: ${e.message}\nRaw (first 500 chars): ${raw.slice(0, 500)}`);
  }

  const rawSlots = structured?.slots || [];
  if (!rawSlots.length) {
    throw new Error(
      'No structured slots returned for design-a. The run succeeded but produced no slots. Re-run with --debug to inspect Gemini tool calls and responses.'
    );
  }

  const slots = rawSlots.map(normalizeSlot);
  validateSemanticQuality(slots);

  const updated = {
    id: existingDesign.id,
    name: existingDesign.name,
    backgroundImage: existingDesign.backgroundImage || '/assets/test-bg.png',
    slots,
  };

  await writeFile(DESIGN_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  console.log(`Updated ${TEST_DESIGN_ID} with ${slots.length} slots.`);
  console.log('Run npm run build:overlays next.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
