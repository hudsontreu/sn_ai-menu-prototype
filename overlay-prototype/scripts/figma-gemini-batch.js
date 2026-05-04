// Loops over all PNGs in data/menus/full/ and writes slot output to data/output/

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { VARIANTS } from '../data/variants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const MENUS_FULL_DIR = path.join(PROJECT_ROOT, 'data', 'menus', 'full');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'output');
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

function readPngSize(buf) {
  // PNG signature is 8 bytes; IHDR width is bytes 16-19, height 20-23 (big-endian).
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('Not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function processDesign(designId, imagePath, items, ai, model) {
  const imageBuf = await readFile(imagePath);
  const { width: imgW, height: imgH } = readPngSize(imageBuf);

  console.log(`Image: ${imagePath} (${imgW}x${imgH}, ${imageBuf.length} bytes)`);

  const systemInstruction = [
    'You are a visual analyst extracting the on-image position of price and calorie text from a menu board image.',
    'The bounding boxes you return will be used to render dynamic HTML overlays on top of the design.',
    'Look only at the provided image — do not invent items, prices, or layouts you cannot see.',
    'Return structured JSON only — no placeholder values, no "unknown" variants, no zero confidence.',
  ].join(' ');

  const prompt = [
    '## Task',
    'Detect every price and calorie text value in the attached menu board image, and for each one return:',
    '  - the menu item it belongs to (itemId, from the catalog below)',
    '  - the variant of that item (variantId)',
    '  - which value it is (field: "price" or "calories")',
    '  - a tight bounding box around the text (box_2d)',
    '  - a confidence score and reasoning',
    '',
    '## Inputs',
    `- Design ID: ${designId}`,
    `- Image dimensions: ${imgW} x ${imgH} pixels`,
    '- Item catalog (itemId -> name) — itemId MUST be one of these keys:',
    JSON.stringify(items, null, 2),
    '',
    '## Procedure',
    '1. Locate every menu item in the image. Match each visible item-name text to an itemId in the catalog above.',
    '   If a text label does not match any item in the catalog, do NOT invent an itemId — skip it.',
    '2. For each item, identify its variant(s) from nearby labels. variantId MUST be one of these keys:',
    `   ${JSON.stringify(VARIANTS)}`,
    '   Detection notes for specific variants:',
    '     - "base" — only when the item has a single price/calories pair and NO visible variant label.',
    '     - "meal", "entree" — the common variants, usually shown as labels next to price/calorie pairs.',
    '     - "meal-Nct", "entree-Nct" — when a count appears (e.g. "8ct" → "meal-8ct"). Use the integer N shown in the image.',
    '     - "toppings" — typically associated with items in the salad category. Identified by the text "with toppings"',
    '       appearing AFTER the calorie value and not in bold.',
    '     - "m", "l" — medium and large size labels used for drinks.',
    '     - "1ct", "6ct" — count-based variants primarily used for desert (e.g. cookies sold individually or in packs).',
    '     - "chocolate", "vanilla", "strawberry", "cookies-&-cream" - these are flavor names used for milkshakes.',
    '3. For each variant, find its price text and calorie text:',
    '     - Price looks like a decimal number, e.g. "7.50", "10.25".',
    '     - Calories looks like a number or pair of numbers followed by "cal", e.g. "690 cal", "1050 cal", "0/360 cal", or "0-500 cal".',
    '     - Price and calorie values are typically positioned to the left and right of the variant label.',
    '     - Associate values with an item by their proximity to the item name and variant label.',
    '4. For each value, draw the tightest bounding box that contains ONLY the text itself (e.g. just "10.25" or "690 cal"),',
    '   not the surrounding item block.',
    '5. Emit one slot per value, with field exactly "price" or "calories".',
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
    '- itemId must be a key from the catalog above. If you cannot match, skip the slot rather than inventing.',
    '- Return only structured JSON matching the response schema.',
  ].join('\n');

  console.log(`Calling Gemini (${model})...`);
  const t0 = Date.now();
  const result = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: imageBuf.toString('base64') } },
          { text: prompt },
        ],
      },
    ],
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseJsonSchema: OUTPUT_SCHEMA,
    },
  });
  console.log(`Gemini responded in ${((Date.now() - t0) / 1000).toFixed(1)}s. usage:`, result.usageMetadata);

  const raw = result.text ?? '';
  if (!raw.trim()) throw new Error('Gemini returned an empty response.');

  const structured = JSON.parse(raw);
  const rawSlots = structured?.slots || [];
  if (!rawSlots.length) throw new Error('No slots returned.');

  // Convert normalized boxes to pixel coordinates and the (x, y) anchor used by the renderer.
  const slots = rawSlots.map((s) => {
    const [ymin, xmin, ymax, xmax] = s.box_2d.map(Number);
    const px = {
      xmin: (xmin / 1000) * imgW,
      ymin: (ymin / 1000) * imgH,
      xmax: (xmax / 1000) * imgW,
      ymax: (ymax / 1000) * imgH,
    };
    return {
      itemId: s.itemId,
      variantId: s.variantId,
      field: s.field,
      x: Math.round(px.xmin * 10) / 10,
      y: Math.round(px.ymin * 10) / 10,
      confidence: s.confidence,
      reasoning: s.reasoning,
    };
  });

  const output = {
    id: designId,
    name: designId,
    backgroundImage: `/assets/${designId}.png`,
    slots,
  };

  await writeFile(
    path.join(OUTPUT_DIR, `${designId}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8'
  );

  console.log(`Wrote data/output/${designId}.json (${slots.length} slots)`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

  await mkdir(OUTPUT_DIR, { recursive: true });

  const items = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.MODEL_NAME || 'gemini-3-flash-preview';

  const files = (await readdir(MENUS_FULL_DIR)).filter((f) => f.endsWith('.png'));
  if (!files.length) throw new Error(`No PNG files found in ${MENUS_FULL_DIR}`);

  for (const file of files) {
    const designId = path.basename(file, '.png');
    const imagePath = path.join(MENUS_FULL_DIR, file);
    console.log(`\n=== Processing ${designId} ===`);
    await processDesign(designId, imagePath, items, ai, model);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
