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
          box_2d: {
            type: 'array',
            items: { type: 'number', minimum: 0, maximum: 1000 },
            minItems: 4,
            maxItems: 4,
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
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
    'You are a visual analyst extracting the on-image position of price and calorie text from a menu board JPG.',
    'The bounding boxes you return will be used to render dynamic HTML overlays on top of the design.',
    'Use the provided Figma tools to fetch and view the design image, and refer back to it as often as needed.',
    'Return structured JSON only — no placeholder values, no "unknown" variants, no zero confidence.',
  ].join(' ');

  const prompt = [
    '## Task',
    'Detect every price and calorie text value on a menu board design image, and for each one return:',
    '  - the menu item it belongs to (itemId, from the catalog below)',
    '  - the variant of that item (variantId)',
    '  - which value it is (field: "price" or "calories")',
    '  - a tight bounding box around the text (box_2d)',
    '  - a confidence score and reasoning',
    '',
    '## Inputs',
    `- Design ID: ${TEST_DESIGN_ID}`,
    `- Figma design URL: ${TEST_DESIGN_URL}`,
    '- Item catalog (itemId -> name):',
    JSON.stringify(items, null, 2),
    '',
    '## Procedure',
    '1. Use the Figma tools to fetch a screenshot of the design at the URL above. Keep referring back to it as you work.',
    '2. Locate every menu item on the board. Match each visible item-name text to an itemId in the catalog.',
    '3. For each item, identify its variant(s) from nearby labels:',
    '     - "meal", "entree" — the common variants.',
    '     - "meal-Nct", "entree-Nct" — when a count appears (e.g. "8ct" → "meal-8ct"). N is whatever integer is shown.',
    '     - "base" — use this only when the item has a single price/calories pair and NO visible variant label.',
    '4. For each variant, find its price text and calorie text:',
    '     - Price looks like a decimal number, e.g. "7.50", "10.25".',
    '     - Calories looks like a number followed by "cal", e.g. "690 cal", "1050 cal".',
    '     - Price and calorie values are typically positioned to the left and right of the variant label.',
    '     - Associate values with an item by their proximity to the item name and variant label.',
    '5. For each value, draw the tightest bounding box that contains ONLY the text itself (e.g. just "10.25" or "690 cal"),',
    '   not the surrounding item block.',
    '6. Emit one slot per value, with field exactly "price" or "calories".',
    '',
    '## Bounding box format',
    '- box_2d is [ymin, xmin, ymax, xmax], all normalized to 0–1000.',
    '- (0, 0) is the top-left corner of the image; (1000, 1000) is the bottom-right.',
    '- Tighter is better — the box should hug the text.',
    '',
    '## Confidence and reasoning',
    '- confidence is 0–1 and must be honest. Lower it when the text is small, partially obscured, or the variant',
    '  label is ambiguous. Do not return 0 — if you are that unsure, omit the slot.',
    '- reasoning is a short string per slot explaining: how you identified the item and variant, what visual cues',
    '  located the bounding box, and anything you were uncertain about.',
    '',
    '## Output rules',
    '- Cover the entire design: every visible price and every visible calorie value.',
    '- No placeholders, no "unknown" variants, no confidence 0.',
    '- Return only structured JSON matching the response schema.',
  ].join('\n');

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
