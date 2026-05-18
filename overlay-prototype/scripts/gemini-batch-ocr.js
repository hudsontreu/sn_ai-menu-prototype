// OCR-grounded slot extractor.
//
// Pipeline: ocr-extract.js writes pixel-accurate word boxes to data/ocr/{id}.json.
// This script gives Gemini the image + that OCR word list + the catalog, and asks
// it to PICK which word(s) hold each catalog tag's price and calories. Coordinates
// come from OCR, not from the model — Gemini can't hallucinate positions because
// it isn't producing them.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { VARIANTS } from '../data/variants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const MENUS_FULL_DIR = path.join(PROJECT_ROOT, 'data', 'menus', 'full');
const OCR_DIR = path.join(PROJECT_ROOT, 'data', 'ocr');
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
          // Indices into the OCR word list. Multiple indices = value spans words
          // (e.g. "0/360 cal" or "10 . 25" if Vision split on the decimal).
          ocrWordIndices: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            minItems: 1,
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reasoning: { type: 'string' },
          styleGroup: { type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
        },
        required: ['tag', 'field', 'ocrWordIndices', 'confidence', 'reasoning', 'styleGroup'],
      },
    },
  },
  required: ['slots'],
};

function buildCatalog(itemsRaw) {
  const out = {};
  for (const [tag, entry] of Object.entries(itemsRaw)) out[tag] = entry['menu-item'];
  return out;
}

function summarizeOcrForPrompt(ocr) {
  // Send a compact word list. Keep coordinates so Gemini can reason about
  // spatial proximity (which word is "next to" which item name).
  return ocr.words.map((w, i) => ({
    i,
    text: w.text,
    x: Math.round(w.bbox.x),
    y: Math.round(w.bbox.y),
    w: Math.round(w.bbox.w),
    h: Math.round(w.bbox.h),
  }));
}

function unionBox(boxes) {
  const xmin = Math.min(...boxes.map((b) => b.x));
  const ymin = Math.min(...boxes.map((b) => b.y));
  const xmax = Math.max(...boxes.map((b) => b.x + b.w));
  const ymax = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
}

async function processDesign(designId, imagePath, ocrPath, catalog, ai, model) {
  const [imageBuf, ocrRaw] = await Promise.all([readFile(imagePath), readFile(ocrPath, 'utf8')]);
  const ocr = JSON.parse(ocrRaw);
  const { width: imgW, height: imgH } = ocr.imageSize;

  console.log(`  image: ${imgW}x${imgH}, ocr words: ${ocr.wordCount}`);

  const ocrSummary = summarizeOcrForPrompt(ocr);

  const systemInstruction = [
    'You are matching OCR-detected text regions to catalog item prices and calories on a menu board.',
    'You are given the image AND the exhaustive OCR word list with pixel coordinates.',
    'You MUST select coordinates only by referencing OCR word indices — never invent positions.',
    'Return structured JSON only.',
  ].join(' ');

  const prompt = [
    '## Task',
    'For every menu item visible on the board, identify which OCR word(s) hold its price and which hold its calories.',
    'Output one slot per (tag, field), referencing OCR words by their index in the list below.',
    '',
    '## Inputs',
    `- Design ID: ${designId}`,
    `- Image dimensions: ${imgW} x ${imgH} pixels`,
    '- Catalog (tag -> menu-item). The slot `tag` MUST be one of these keys:',
    JSON.stringify(catalog, null, 2),
    '',
    '- OCR word list. Every text region detected on the image, with index, text, and pixel bbox (x, y, w, h, top-left origin):',
    JSON.stringify(ocrSummary),
    '',
    '## Procedure',
    '1. Visually identify every menu item on the board, including subtext (e.g. "w/ Spicy Filet").',
    '2. For each item, identify its variant(s) by proximity to a variant label. Known labels:',
    `   ${JSON.stringify(VARIANTS)}`,
    '   Variant detection notes (variants are NOT in the output — they only help you group values to entities):',
    '     - "meal", "entree" — common, usually printed next to price/calorie pairs.',
    '     - "meal-Nct", "entree-Nct" — when a count appears (e.g. "8ct" -> "meal-8ct").',
    '     - "1ct", "6ct" — count-based variants for cookies, etc.',
    '     - "m", "l" — drink size. Beverages without a visible size label: assume Medium ("m").',
    '     - "chocolate", "vanilla", "strawberry", "cookies-&-cream" — milkshake flavors.',
    '     - "toppings" — salads, identified by "with toppings" AFTER the calorie value.',
    '     - "base" — single price/calorie pair, no visible variant.',
    '3. For each (item, variant) entity, find the catalog tag whose menu-item string best matches semantically.',
    '   If no catalog entry is a reasonable match, SKIP the entity. Do not invent a tag.',
    '4. For each entity, locate its price text and calorie text visually:',
    '     - Price: decimal number like "7.50", "10.25". May be prefixed with "$" — exclude the "$" from the selection.',
    '     - Calories: number(s) followed by "cal", e.g. "690 cal", "0/360 cal", "0-500 cal".',
    '     - "add" prefix (e.g. "add 100 cal"): select only the digit word(s), not the "add" word.',
    '5. Find the OCR word index(es) for that text. The numeric/textual content of the OCR word MUST match what you',
    '   visually see at that position. If the value spans multiple OCR words (e.g. "0/360" detected as ["0","/","360"],',
    '   or "690 cal" as ["690","cal"]), list ALL the indices that make up the value — but EXCLUDE the unit word "cal"',
    '   and any "$" / "add" prefix words. The bounding box should hug ONLY the numeric value.',
    '6. Emit one slot per value: { tag, field, ocrWordIndices, confidence, reasoning, styleGroup }.',
    '',
    '## Hard rules on OCR matching',
    '- Coordinates come from OCR — you must never invent them. Always reference an existing OCR word by its index.',
    '- If a value you can see is NOT in the OCR word list (rare — OCR missed it), SKIP that slot rather than guessing.',
    '  Lower-than-usual coverage is acceptable; hallucinated indices are not.',
    '- The OCR text of your selected word(s) must plausibly match the value. If you cannot find any OCR word whose',
    '  text resembles a price or a calorie at the expected location, skip the slot.',
    '',
    '## Confidence and reasoning',
    '- confidence is 0-1, honest. Lower when text is small/obscured or the tag match is uncertain. Do not return 0.',
    '- reasoning: short string per slot. Mention which catalog tag you matched, why these OCR indices, and any uncertainty.',
    '',
    '## Style Groups (classify each slot by inspecting the text style in the image)',
    '- "a" — Medium, light/medium gray. Most common. Meals, entrees, drinks, treats, salads, grilled meals.',
    '- "b" — Larger, darker gray. "Meals Include" / sides sections, or near "SUBSTITUTE".',
    '- "c" — Very small gray, calories only. Dressings and sauces.',
    '- "d" — Medium red. Price and calorie have uniform styling. Promotional items (e.g. Strawberry Hibiscus).',
    '- "e" — Large red. Full-page hero items (e.g. Iced Coffee promos).',
    '- "f" — Medium white, uniform price/calorie styling. Like d but white.',
    '- "g" — Large white. Like e but white.',
    '- a/b/c are typical for standard white-background menu screens; d/e/f/g for promo screens with product imagery.',
    '',
    '## Output rules',
    '- Cover the entire design: every visible price and every visible calorie value you can match to a catalog tag.',
    '- No placeholders, no confidence 0.',
    '- Return only structured JSON matching the response schema.',
  ].join('\n');

  console.log(`  calling Gemini (${model})...`);
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
  console.log(`  gemini responded in ${((Date.now() - t0) / 1000).toFixed(1)}s. usage:`, result.usageMetadata);

  const raw = result.text ?? '';
  if (!raw.trim()) throw new Error('Gemini returned an empty response.');

  const structured = JSON.parse(raw);
  const rawSlots = structured?.slots || [];
  if (!rawSlots.length) throw new Error('No slots returned.');

  const slots = [];
  const dropped = [];
  for (const s of rawSlots) {
    const indices = s.ocrWordIndices ?? [];
    const wordBoxes = indices
      .map((i) => ocr.words[i]?.bbox)
      .filter(Boolean);

    if (wordBoxes.length !== indices.length || !wordBoxes.length) {
      dropped.push({ tag: s.tag, field: s.field, reason: 'invalid OCR index', indices });
      continue;
    }

    const box = unionBox(wordBoxes);
    slots.push({
      tag: s.tag,
      field: s.field,
      x: Math.round(box.x * 10) / 10,
      y: Math.round(box.y * 10) / 10,
      w: box.w,
      h: box.h,
      confidence: s.confidence,
      reasoning: s.reasoning,
      styleGroup: s.styleGroup,
      ocrWordIndices: indices,
      ocrText: indices.map((i) => ocr.words[i]?.text).join(' '),
    });
  }

  if (dropped.length) {
    console.warn(`  dropped ${dropped.length} slots with bad OCR indices:`);
    for (const d of dropped) console.warn(`    ${d.tag}/${d.field}: ${d.reason} (${JSON.stringify(d.indices)})`);
  }

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

  console.log(`  wrote data/gemini-output/${designId}.json (${slots.length} slots)`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

  await mkdir(OUTPUT_DIR, { recursive: true });

  const itemsRaw = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));
  const catalog = buildCatalog(itemsRaw);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.MODEL_NAME || 'gemini-3-flash-preview';

  const filter = process.argv.slice(2).map((a) => a.replace(/\.png$/i, '').trim()).filter(Boolean);
  const allFiles = (await readdir(MENUS_FULL_DIR)).filter((f) => f.endsWith('.png'));
  const files = filter.length
    ? allFiles.filter((f) => filter.includes(path.basename(f, '.png')))
    : allFiles;

  if (filter.length) {
    const missing = filter.filter((id) => !allFiles.some((f) => path.basename(f, '.png') === id));
    if (missing.length) console.warn(`Warning: no PNG found for: ${missing.join(', ')}`);
  }
  if (!files.length) throw new Error(`No PNG files found in ${MENUS_FULL_DIR}`);

  for (const file of files) {
    const designId = path.basename(file, '.png');
    const imagePath = path.join(MENUS_FULL_DIR, file);
    const ocrPath = path.join(OCR_DIR, `${designId}.json`);

    console.log(`\n=== ${designId} ===`);
    try {
      await readFile(ocrPath);
    } catch {
      console.warn(`  no OCR cache at data/ocr/${designId}.json — run \`npm run ocr\` first. Skipping.`);
      continue;
    }
    await processDesign(designId, imagePath, ocrPath, catalog, ai, model);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
