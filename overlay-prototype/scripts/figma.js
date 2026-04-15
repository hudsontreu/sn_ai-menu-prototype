import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { FIGMA_SYNC_CONFIG } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DESIGNS_DIR = path.join(PROJECT_ROOT, 'public', 'data', 'designs');
const ITEMS_PATH = path.join(PROJECT_ROOT, 'public', 'data', 'items.json');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'public', 'assets');

const SLOT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    backgroundImageUrl: { type: 'string' },
    slots: {
      type: 'array',
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

function parseRequestedDesignIds(argv, configuredIds) {
  const explicit = argv
    .filter((v) => !v.startsWith('--'))
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  if (!explicit.length) return configuredIds;
  return [...new Set(explicit)];
}

function normalizeMcpServer(serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') {
    throw new Error('Missing FIGMA_SYNC_CONFIG.mcpServer in config.js');
  }

  if ('type' in serverConfig) {
    if (!serverConfig.url) {
      throw new Error('FIGMA MCP HTTP/SSE server requires a url. Set FIGMA_MCP_URL or config.js mcpServer.url');
    }
    return serverConfig;
  }

  if ('command' in serverConfig) {
    if (!serverConfig.command) {
      throw new Error('FIGMA MCP stdio server requires command in config.js');
    }
    return serverConfig;
  }

  throw new Error('Invalid mcpServer config. Use either {type,url} or {command,args}');
}

function round(value, decimals = 3) {
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function ensureFiniteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${label}: ${value}`);
  return n;
}

function normalizeSlot(slot, canvas) {
  const itemId = String(slot.itemId || '').trim();
  const variantId = String(slot.variantId || '').trim();
  const field = String(slot.field || '').trim();
  const confidenceRaw = ensureFiniteNumber(slot.confidence, 'confidence');

  if (!itemId) throw new Error('slot.itemId is required');
  if (!variantId) throw new Error('slot.variantId is required');
  if (field !== 'price' && field !== 'calories') {
    throw new Error(`slot.field must be price|calories. Received: ${field}`);
  }

  let xPx = Number.isFinite(Number(slot.xPx)) ? Number(slot.xPx) : null;
  let yPx = Number.isFinite(Number(slot.yPx)) ? Number(slot.yPx) : null;
  let x = Number.isFinite(Number(slot.x)) ? Number(slot.x) : null;
  let y = Number.isFinite(Number(slot.y)) ? Number(slot.y) : null;

  if (xPx == null || yPx == null) {
    if (x == null || y == null) {
      throw new Error(`slot ${itemId}/${variantId}/${field} must include x/y or xPx/yPx`);
    }
    xPx = (x / 100) * canvas.width;
    yPx = (y / 100) * canvas.height;
  }

  if (x == null || y == null) {
    x = (xPx / canvas.width) * 100;
    y = (yPx / canvas.height) * 100;
  }

  if (xPx < 0 || xPx > canvas.width || yPx < 0 || yPx > canvas.height) {
    throw new Error(`slot ${itemId}/${variantId}/${field} outside canvas bounds`);
  }

  if (x < 0 || x > 100 || y < 0 || y > 100) {
    throw new Error(`slot ${itemId}/${variantId}/${field} has out-of-range percent coordinates`);
  }

  return {
    itemId,
    variantId,
    field,
    x: round(x, 4),
    y: round(y, 4),
    xPx: round(xPx, 2),
    yPx: round(yPx, 2),
    confidence: Math.max(0, Math.min(1, round(confidenceRaw, 4))),
  };
}

function inferExtFromUrl(url) {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'jpg';
  if (clean.endsWith('.webp')) return 'webp';
  return 'png';
}

async function downloadImageToAssets(url, preferredName) {
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

  const baseName = preferredName.replace(/\.[a-z0-9]+$/i, '');
  const fileName = `${baseName}.${ext}`;
  const target = path.join(ASSETS_DIR, fileName);

  await mkdir(ASSETS_DIR, { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(target, bytes);

  return `/assets/${fileName}`;
}

function buildPrompt({ designId, designUrl, blankUrl, itemsCatalog, canvas }) {
  return [
    'Use Figma MCP tools to inspect the following menu design references and extract dynamic overlay slots.',
    `Design ID: ${designId}`,
    `Filled design URL (contains values): ${designUrl}`,
    `Blank design URL (no values): ${blankUrl}`,
    `Canvas size: ${canvas.width}x${canvas.height}`,
    'Task requirements:',
    '- Identify each dynamic price and calories value that should be overlaid.',
    '- Output one slot per dynamic value.',
    '- field must be exactly "price" or "calories".',
    '- Provide both pixel coordinates (xPx/yPx) and percent coordinates (x/y).',
    '- confidence must be 0..1 for each slot.',
    '- Use itemIds from catalog when possible, but you may propose new itemIds if needed.',
    '- Return only structured output matching schema.',
    'Item catalog (id -> name):',
    JSON.stringify(itemsCatalog, null, 2),
  ].join('\n');
}

async function runExtraction({ design, itemsCatalog, canvas, mcpServer }) {
  const prompt = buildPrompt({
    designId: design.designId,
    designUrl: design.designUrl,
    blankUrl: design.blankUrl,
    itemsCatalog,
    canvas,
  });

  let resultPayload = null;

  for await (const message of query({
    prompt,
    options: {
      model: FIGMA_SYNC_CONFIG.model,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: FIGMA_SYNC_CONFIG.systemPromptAppend,
      },
      mcpServers: {
        figma: mcpServer,
      },
      allowedTools: ['mcp__figma__*', 'WebFetch'],
      outputFormat: {
        type: 'json_schema',
        schema: SLOT_OUTPUT_SCHEMA,
      },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype === 'success' && message.structured_output) {
        resultPayload = message.structured_output;
      } else {
        throw new Error(`Extraction failed for ${design.designId}: ${message.subtype}`);
      }
    }
  }

  if (!resultPayload) {
    throw new Error(`No structured output returned for ${design.designId}`);
  }

  return resultPayload;
}

async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function validateConfiguredDesigns(designs) {
  const ids = new Set();
  for (const design of designs) {
    if (!design.designId || !design.designUrl || !design.blankUrl) {
      throw new Error(`Each configured design requires designId, designUrl, and blankUrl. Invalid: ${JSON.stringify(design)}`);
    }
    if (ids.has(design.designId)) {
      throw new Error(`Duplicate designId in config.js: ${design.designId}`);
    }
    ids.add(design.designId);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const canvas = FIGMA_SYNC_CONFIG.canvas;
  if (!canvas?.width || !canvas?.height) {
    throw new Error('FIGMA_SYNC_CONFIG.canvas.width/height are required');
  }

  const configuredDesigns = FIGMA_SYNC_CONFIG.designs || [];
  validateConfiguredDesigns(configuredDesigns);

  const mcpServer = normalizeMcpServer(FIGMA_SYNC_CONFIG.mcpServer);
  const requestedIds = parseRequestedDesignIds(process.argv.slice(2), configuredDesigns.map((d) => d.designId));
  const selected = configuredDesigns.filter((d) => requestedIds.includes(d.designId));

  if (!selected.length) {
    throw new Error(`No matching design IDs selected. Requested: ${requestedIds.join(', ')}`);
  }

  const itemsCatalog = await loadJson(ITEMS_PATH);
  const knownItemIds = new Set(Object.keys(itemsCatalog));

  for (const design of selected) {
    const designPath = path.join(DESIGNS_DIR, `${design.designId}.json`);
    const existing = await loadJson(designPath);

    console.log(`Extracting ${design.designId} ...`);
    const extracted = await runExtraction({
      design,
      itemsCatalog,
      canvas,
      mcpServer,
    });

    const normalizedSlots = (extracted.slots || []).map((slot) => normalizeSlot(slot, canvas));
    if (!normalizedSlots.length) {
      throw new Error(`No slots returned for ${design.designId}`);
    }

    const unknownItems = [...new Set(normalizedSlots.map((s) => s.itemId).filter((itemId) => !knownItemIds.has(itemId)))];
    if (unknownItems.length) {
      console.warn(`Warning: ${design.designId} proposed unknown itemIds: ${unknownItems.join(', ')}`);
    }

    const outputAssetName = design.outputAssetName || `${design.designId}-blank.png`;
    const blankImageSource = extracted.backgroundImageUrl || design.blankUrl;
    const backgroundImage = await downloadImageToAssets(blankImageSource, outputAssetName);

    const nextDesign = {
      id: existing.id,
      name: existing.name,
      backgroundImage,
      slots: normalizedSlots,
    };

    await writeFile(designPath, `${JSON.stringify(nextDesign, null, 2)}\n`, 'utf8');
    console.log(`Updated ${path.relative(PROJECT_ROOT, designPath)} with ${normalizedSlots.length} slots.`);
  }

  console.log('Done.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
