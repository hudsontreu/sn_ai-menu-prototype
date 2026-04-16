import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const TEST_DESIGN_ID = 'design-a';
const TEST_DESIGN_URL = 'https://www.figma.com/design/DveUacGuz5nlURkX6OSrto/AI-Menu-Board-Pipeline?node-id=1-2&m=dev';
const TEST_BLANK_URL = 'https://www.figma.com/design/DveUacGuz5nlURkX6OSrto/AI-Menu-Board-Pipeline?node-id=3-35&m=dev';
const TEST_OUTPUT_ASSET_NAME = 'design-a-blank.png';

const CANVAS_WIDTH = 2102;
const CANVAS_HEIGHT = 1336;

const DESIGN_PATH = path.join(PROJECT_ROOT, 'data', 'designs', `${TEST_DESIGN_ID}.json`);
const ITEMS_PATH = path.join(PROJECT_ROOT, 'data', 'items.json');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'public', 'assets');

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    backgroundImageUrl: { type: 'string' },
    slots: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          variantId: { type: 'string' },
          field: { type: 'string', enum: ['price', 'calories'] },
          xPx: { type: 'number' },
          yPx: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['itemId', 'variantId', 'field', 'confidence'],
      },
    },
  },
  required: ['slots'],
};

const DEBUG = process.argv.includes('--debug');
const MIN_SLOT_COUNT = 8;

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

  let xPx = Number.isFinite(Number(slot.xPx)) ? Number(slot.xPx) : null;
  let yPx = Number.isFinite(Number(slot.yPx)) ? Number(slot.yPx) : null;
  let x = Number.isFinite(Number(slot.x)) ? Number(slot.x) : null;
  let y = Number.isFinite(Number(slot.y)) ? Number(slot.y) : null;

  if (xPx == null || yPx == null) {
    if (x == null || y == null) throw new Error('Each slot needs x/y or xPx/yPx');
    xPx = (x / 100) * CANVAS_WIDTH;
    yPx = (y / 100) * CANVAS_HEIGHT;
  }

  if (x == null || y == null) {
    x = (xPx / CANVAS_WIDTH) * 100;
    y = (yPx / CANVAS_HEIGHT) * 100;
  }

  return {
    itemId,
    variantId,
    field,
    x: round(x, 4),
    y: round(y, 4),
    xPx: round(xPx, 2),
    yPx: round(yPx, 2),
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

  const allZero = slots.filter(
    (s) => Number(s.x) === 0 && Number(s.y) === 0 && Number(s.xPx) === 0 && Number(s.yPx) === 0
  );
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

  const uniquePositions = new Set(slots.map((s) => `${s.xPx}:${s.yPx}`));
  if (uniquePositions.size < Math.max(6, Math.floor(slots.length * 0.5))) {
    throw new Error(
      'Extraction quality gate failed: too many overlapping/repeated coordinates'
    );
  }
}

function inferExtFromUrl(url) {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'jpg';
  if (clean.endsWith('.webp')) return 'webp';
  return 'png';
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download blank image: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const ext = contentType.includes('image/jpeg')
    ? 'jpg'
    : contentType.includes('image/webp')
      ? 'webp'
      : inferExtFromUrl(url);

  const baseName = TEST_OUTPUT_ASSET_NAME.replace(/\.[a-z0-9]+$/i, '');
  const fileName = `${baseName}.${ext}`;
  const targetPath = path.join(ASSETS_DIR, fileName);

  await mkdir(ASSETS_DIR, { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, bytes);
  return `/assets/${fileName}`;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  if (!process.env.FIGMA_MCP_URL) throw new Error('FIGMA_MCP_URL is required');

  const existingDesign = JSON.parse(await readFile(DESIGN_PATH, 'utf8'));
  const items = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));

  const systemPromptAppend = [
    'You are extracting dynamic pricing and calorie overlay coordinates from one menu-board design.',
    'Use Figma MCP tools and return structured JSON only.',
    'Do not output placeholder values such as variantId "unknown", confidence 0, or 0/0 coordinates.',
    'Extract all visible dynamic price and calories values, not just one example.',
  ].join(' ');

  const prompt = [
    'Task: Build design slot data for a Chick-fil-A menu board design.',
    '',
    'Task Outline:',
    '1) Identify each menu item entity in the filled design, found at the filled design url shared below (item name + dynamic price/calorie values).',
    '2) Match each detected item name to an itemId in the provided items catalog.',
    '3) Identify variants for each item. Valid examples include:',
    '- meal',
    '- entree',
    '- meal-3ct, meal-4ct, meal-8ct, meal-12ct',
    '- entree-3ct, entree-4ct, entree-8ct, entree-12ct',
    '4) For every dynamic value, extract exact coordinates for the start of the rendered text element.',
    '5) Return one slot per value with field exactly "price" or "calories".',
    '',
    'Rules:',
    '- Extract complete coverage for the entire design (all visible dynamic values).',
    '- Do not output placeholders: no "unknown" variants, no confidence 0, no 0/0 coordinates.',
    '- Provide both x/y percentages and xPx/yPx pixels.',
    '- Coordinates are based on a 2102x1336 frame.',
    '- If uncertain, still provide best estimate with honest confidence > 0.',
    '- Return only structured output matching schema.',
    '',
    `Design ID: ${TEST_DESIGN_ID}`,
    `Filled design URL: ${TEST_DESIGN_URL}`,
    `Blank design URL: ${TEST_BLANK_URL}`,
    `Canvas size: ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
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
  const backgroundImageSource = cleanUrl(structured.backgroundImageUrl) || TEST_BLANK_URL;
  let backgroundImage = existingDesign.backgroundImage || '/assets/test-bg.png';
  try {
    backgroundImage = await downloadImage(backgroundImageSource);
  } catch (error) {
    console.warn(
      `[warn] Could not download background image from source URL (${backgroundImageSource}). ` +
      `Falling back to existing background path: ${backgroundImage}`
    );
    if (DEBUG) {
      console.warn(`[warn] download error: ${error?.message || error}`);
    }
  }

  const updated = {
    id: existingDesign.id,
    name: existingDesign.name,
    backgroundImage,
    slots,
  };

  await writeFile(DESIGN_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  console.log(`Updated ${TEST_DESIGN_ID} with ${slots.length} slots.`);
  console.log(`Background image saved to ${backgroundImage}.`);
  console.log('Run npm run build:overlays next.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
