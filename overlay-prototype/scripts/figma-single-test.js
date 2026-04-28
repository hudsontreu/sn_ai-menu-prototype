import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const TEST_DESIGN_ID = 'design-a';
const TEST_DESIGN_URL = 'https://www.figma.com/design/DveUacGuz5nlURkX6OSrto/AI-Menu-Board-Pipeline?node-id=51-63&m=dev';
const TEST_BLANK_URL = 'https://www.figma.com/design/DveUacGuz5nlURkX6OSrto/AI-Menu-Board-Pipeline?node-id=51-76&m=dev';
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
          x: { type: 'number' },
          y: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['itemId', 'variantId', 'field', 'x', 'y', 'confidence'],
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
  const x = Number(slot.x);
  const y = Number(slot.y);

  if (!itemId || !variantId) throw new Error('slot.itemId and slot.variantId are required');
  if (field !== 'price' && field !== 'calories') throw new Error(`Invalid field: ${field}`);
  if (!Number.isFinite(confidence)) throw new Error(`Invalid confidence: ${slot.confidence}`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coordinates for ${itemId}/${variantId}/${field}`);
  if (x < 0 || x > 100 || y < 0 || y > 100) throw new Error(`Coordinates out of range for ${itemId}/${variantId}/${field}`);

  return {
    itemId,
    variantId,
    field,
    x: round(x, 4),
    y: round(y, 4),
    confidence: Math.max(0, Math.min(1, round(confidence, 4))),
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
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  if (!process.env.FIGMA_MCP_URL) throw new Error('FIGMA_MCP_URL is required');

  const existingDesign = JSON.parse(await readFile(DESIGN_PATH, 'utf8'));
  const items = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));

  const systemPromptAppend = [
    'You are visually analyzing JPG images of a menu board design to extract the position of price and calorie values.',
    'The position coordinates you identify will be used to produce dynamic HTML overlays.',
    'Use Figma MCP tools to view the design images.',
    'Return structured JSON only — no placeholder values, no zero coordinates, no "unknown" variants.',
  ].join(' ');

  const prompt = [
    'Task: Extract dynamic overlay slot data from a Chick-fil-A menu board design.',
    '',
    'Background:',
    'You are analyzing a JPG image of a Chick-fil-A menu board. The image shows the board with price',
    'and calorie text populated. Your job is to identify every price and calorie value in the image',
    'and record its position as a percentage of the 1920x1080 frame.',
    '',
    'Each menu item may have multiple price/calorie values depending on its variants. To locate them,',
    'use visual keywords: the item name (matched against the catalog), variant labels such as "Meal" or',
    '"Entree", and the values themselves — prices look like "7.50" or "10.25", calories look like "690 cal".',
    '',
    'Steps:',
    '1) Use Figma MCP tools to view the design image.',
    '2) Identify every menu item visible on the board by reading the item name text.',
    '3) Match each item name to an itemId from the items catalog below.',
    '4) Identify the variant(s) for each item (meal, entree, meal-3ct, meal-8ct, entree-3ct, entree-8ct, etc.).',
    '   If an item has no visible variant label — just a single price and calories — use variantId "base".',
    '5) For each price and calorie value, visually estimate its position as accurately as possible.',
    '6) Return one slot per value with field exactly "price" or "calories".',
    '',
    'Coordinate rules:',
    `- x and y are percentages of the ${CANVAS_WIDTH}x${CANVAS_HEIGHT} frame: x=0 left edge, x=100 right edge; y=0 top, y=100 bottom.`,
    '- Coordinates mark the top-left corner of where the text value begins.',
    '- These are visual estimates — provide an honest confidence score (0–1) for each.',
    '',
    'Output rules:',
    '- Cover the entire design — every visible price and calorie value.',
    '- No placeholders: no "unknown" variants, no confidence 0, no 0,0 coordinates.',
    '- Return only structured output matching the schema.',
    '',
    `Design ID: ${TEST_DESIGN_ID}`,
    `Design URL: ${TEST_DESIGN_URL}`,
    '',
    'Item catalog (id -> name):',
    JSON.stringify(items, null, 2),
  ].join('\n');

  let structured = null;
  for await (const message of query({
    prompt,
    options: {
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-7',
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemPromptAppend,
      },
      mcpServers: {
        figma: {
          type: 'http',
          url: cleanUrl(process.env.FIGMA_MCP_URL),
        },
      },
      allowedTools: ['mcp__figma__*'],
      outputFormat: {
        type: 'json_schema',
        schema: OUTPUT_SCHEMA,
      },
    },
  })) {
    if (DEBUG) {
      const type = message?.type || 'unknown';
      const subtype = message?.subtype || '';
      const tool = message?.tool_name || message?.name || '';
      const hasStructured =
        Boolean(message?.structured_output) ||
        Boolean(message?.result?.structured_output);
      console.log(
        `[debug] message type=${type}${subtype ? ` subtype=${subtype}` : ''}${tool ? ` tool=${tool}` : ''}${
          hasStructured ? ' structured_output=true' : ''
        }`
      );
    }

    if (message?.structured_output && typeof message.structured_output === 'object') {
      structured = message.structured_output;
    }
    if (message?.result?.structured_output && typeof message.result.structured_output === 'object') {
      structured = message.result.structured_output;
    }

    if (message.type === 'result') {
      if (DEBUG) {
        console.log('[debug] final result payload keys:', Object.keys(message || {}));
        if (message?.result && typeof message.result === 'object') {
          console.log('[debug] final result.result keys:', Object.keys(message.result));
        }
      }
      if (message.subtype !== 'success') {
        throw new Error(`Extraction failed: ${message.subtype}`);
      }
    }
  }

  const rawSlots = structured?.slots || [];
  if (!rawSlots.length) {
    throw new Error(
      'No structured slots returned for design-a. The run succeeded but did not produce schema output. Re-run with `npm run figma:sync:test -- --debug` and verify Figma MCP tool calls + structured_output presence.'
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
