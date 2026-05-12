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
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'gemini-output');
const ITEMS_PATH = path.join(PROJECT_ROOT, 'data', 'cfa-items.json');

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
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
          styleGroup: { type: 'string', enum: ['a', 'b', 'c', 'd', 'e'] },
        },
        required: ['tag', 'field', 'box_2d', 'confidence', 'reasoning', 'styleGroup'],
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

function buildCatalog(itemsRaw) {
  // Strip pricing-tag/group; Gemini only needs tag → menu-item for vision matching.
  const out = {};
  for (const [tag, entry] of Object.entries(itemsRaw)) {
    out[tag] = entry['menu-item'];
  }
  return out;
}

async function processDesign(designId, imagePath, catalog, ai, model) {
  const imageBuf = await readFile(imagePath);
  const { width: imgW, height: imgH } = readPngSize(imageBuf);

  console.log(`Image: ${imagePath} (${imgW}x${imgH}, ${imageBuf.length} bytes)`);

  const systemInstruction = [
    'You are a visual analyst extracting the on-image position of price and calorie text from a menu board image.',
    'The bounding boxes you return will be used to render dynamic HTML overlays on top of the design.',
    'Look only at the provided image — do not invent items, prices, or layouts you cannot see.',
    'Return structured JSON only — no placeholder values, no zero confidence.',
  ].join(' ');

  const prompt = [
    '## Task',
    'Detect every price and calorie text value in the attached menu board image. For each value return:',
    '  - the catalog tag of the item-and-variant entity it belongs to (tag, from the catalog below)',
    '  - which value it is (field: "price" or "calories")',
    '  - a tight bounding box around the text (box_2d)',
    '  - a visual style group (styleGroup: "a" through "e", see Style Groups section below)',
    '  - a confidence score and reasoning',
    '',
    '## Inputs',
    `- Design ID: ${designId}`,
    `- Image dimensions: ${imgW} x ${imgH} pixels`,
    '- Catalog (tag -> menu-item description). Each tag represents a specific item-and-variant combination',
    '  already collapsed into a single entity (e.g. HONEY_PEP_PIM_CFA_MEAL = "Honey Pepper Pimento CFA Filet Meal").',
    '  The slot `tag` MUST be one of these keys:',
    JSON.stringify(catalog, null, 2),
    '',
    '## Procedure',
    '1. Identify every menu item visible on the board, including any subtext (e.g. "w/ Spicy Filet").',
    '2. For each item, identify its variant(s) by proximity to a variant label. Variant labels you may see:',
    `   ${JSON.stringify(VARIANTS)}`,
    '   Variant detection notes:',
    '     - "meal", "entree" — common variants, usually printed next to price/calorie pairs.',
    '     - "meal-Nct", "entree-Nct" — when a count appears (e.g. "8ct" → "meal-8ct"). N is the integer shown.',
    '     - "1ct", "6ct" — count-based variants for items like cookies sold individually or in packs.',
    '     - "m", "l" — medium/large size labels for drinks.',
    '       Some beverages display price and calorie values without any visible size label.',
    '       When a drink has no size variant shown, assume the values represent Medium ("m").',
    '     - "chocolate", "vanilla", "strawberry", "cookies-&-cream" — milkshake flavors.',
    '     - "toppings" — typically salads. Identified by "with toppings" appearing AFTER the calorie value, not bold.',
    '     - "base" — the item has a single price/calorie pair and NO visible variant label.',
    '   Variants are NOT part of the output schema. They are only a hint to help you correctly group price/calorie',
    '   values with the right entity.',
    '3. Treat each item-and-variant pair as a unique ENTITY (e.g. "Grilled Chicken Club Colby Jack Meal").',
    '   For each entity, find the catalog tag whose menu-item string is the closest match (semantic match, not exact).',
    '     - The catalog already encodes the variant in the menu-item string (e.g. "...Meal", "...Entrée", "8ct").',
    '     - If no catalog entry is a reasonable match, SKIP the entity entirely. Do not invent a tag.',
    '4. For each entity, locate its price text and calorie text:',
    '     - Price looks like a decimal number, e.g. "7.50", "10.25".',
    '     - Most price values are displayed only as digits. However, some may be prefixed with a $ symbol. The $ symbol is not to be included in the bounding box. Only the digits should be inside the bounding box.',
    '     - Calories looks like a number or pair of numbers followed by "cal", e.g. "690 cal", "1050 cal", "0/360 cal", or "0-500 cal".',
    '     - Occasionally, a calorie text will be prefixed with the word "add", such as "add 100 cal". In these cases, remember that the coordinate begins at the actual digit value (ie. 100), not the "add" text. This situation can be found in the dressings and sauces sections',
    '     - Price and calorie values are typically positioned to the left and right of the variant label.',
    '5. For each value, draw the tightest bounding box that contains ONLY the text itself (e.g. just "10.25" or "690 cal"),',
    '   not the surrounding item block.',
    '6. Emit one slot per value: { tag, field, box_2d, confidence, reasoning, styleGroup }.',
    '',
    '## Bounding box format',
    '- box_2d is [ymin, xmin, ymax, xmax], all normalized to 0–1000.',
    '- (0, 0) is the top-left corner of the image; (1000, 1000) is the bottom-right.',
    '- Tighter is better — the box should hug the text.',
    '',
    '## Coordinate accuracy',
    'Each bounding box must be located independently by looking at the actual pixels for that',
    'specific text element. Do NOT estimate a value\'s position based on another value you already',
    'identified — locate each one from scratch.',
    '',
    'Common failure mode: layouts often have near-uniform vertical or horizontal alignment across',
    'items, which can tempt you into assuming all values share the same coordinate on one axis.',
    'While many values will be close, they are not always identical — some layouts use staggered',
    'or offset positioning. When you anchor to one incorrect position and apply it uniformly,',
    'every value ends up wrong by the same amount.',
    '',
    'For each slot, re-examine the image at that specific location. Do not propagate assumptions',
    'from neighboring items.',
    '',
    '## Confidence and reasoning',
    '- confidence is 0–1 and must be honest. Lower it when the text is small, partially obscured, or the entity-to-tag',
    '  match is uncertain. Do not return 0 — if you are that unsure, omit the slot.',
    '- reasoning is a short string per slot explaining: how you matched the entity to a catalog tag, what visual cues',
    '  located the bounding box, and anything you were uncertain about.',
    '',
    '## Style Groups',
    'Every price and calorie value on the board belongs to one of five visual style groups.',
    'Classify each slot by inspecting the text\'s size, weight, and color relative to other values on the board.',
    '',
    '- "a" — Price and calorie text is medium sized, light/medium gray color. The most common group. Found for items that fall under the section groups',
       'including meals & entrees, drinks, treats, salads, grilled meals.',
    '- "b" — Larger, darker gray text. Typically found in "Meals Include" or sides sections or associated with the text "SUSTITUTE".',
    '- "c" — Very small gray text, calories only (no price). Found exclusively in dressings and sauces sections.',
    '- "d" — Medium sized, red text. The price and calorie values share uniform, equivalent styling. This is the only group that has equivalent price and',
      'calorie style. Used for promotional menu views with items like Strawberry Hibiscus beverages.',
    '- "e" — Large red text (both price and calories). Used for full-page hero items like Iced Coffee promotions.',
    '',
    'When unsure, prefer "a" — it is the default/most common group.',
    '',
    '## Output rules',
    '- Cover the entire design: every visible price and every visible calorie value.',
    '- No placeholders, no confidence 0.',
    '- tag must be a key from the catalog above. If you cannot find a reasonable match, skip the slot.',
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

  const slots = rawSlots.map((s) => {
    const [ymin, xmin, ymax, xmax] = s.box_2d.map(Number);
    const px = {
      xmin: (xmin / 1000) * imgW,
      ymin: (ymin / 1000) * imgH,
      xmax: (xmax / 1000) * imgW,
      ymax: (ymax / 1000) * imgH,
    };
    return {
      tag: s.tag,
      field: s.field,
      x: Math.round(px.xmin * 10) / 10,
      y: Math.round(px.ymin * 10) / 10,
      w: Math.round(px.xmax - px.xmin),
      h: Math.round(px.ymax - px.ymin),
      confidence: s.confidence,
      reasoning: s.reasoning,
      styleGroup: s.styleGroup,
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

  console.log(`Wrote data/gemini-output/${designId}.json (${slots.length} slots)`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

  await mkdir(OUTPUT_DIR, { recursive: true });

  const itemsRaw = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));
  const catalog = buildCatalog(itemsRaw);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.MODEL_NAME || 'gemini-3-flash-preview';

  const files = (await readdir(MENUS_FULL_DIR)).filter((f) => f.endsWith('.png'));
  if (!files.length) throw new Error(`No PNG files found in ${MENUS_FULL_DIR}`);

  for (const file of files) {
    const designId = path.basename(file, '.png');
    const imagePath = path.join(MENUS_FULL_DIR, file);
    console.log(`\n=== Processing ${designId} ===`);
    await processDesign(designId, imagePath, catalog, ai, model);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
