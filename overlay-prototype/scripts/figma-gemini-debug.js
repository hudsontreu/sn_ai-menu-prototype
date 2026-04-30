import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DESIGN_ID = 'design-b';
const IMAGE_PATH = path.join(PROJECT_ROOT, 'data', 'test-data', `${DESIGN_ID}.png`);
const ITEMS_PATH = path.join(PROJECT_ROOT, 'data', 'items.json');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

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

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

  const imageBuf = await readFile(IMAGE_PATH);
  const { width: imgW, height: imgH } = readPngSize(imageBuf);
  const items = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));

  console.log(`Image: ${IMAGE_PATH} (${imgW}x${imgH}, ${imageBuf.length} bytes)`);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

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
    `- Design ID: ${DESIGN_ID}`,
    `- Image dimensions: ${imgW} x ${imgH} pixels`,
    '- Item catalog (itemId -> name) — itemId MUST be one of these keys:',
    JSON.stringify(items, null, 2),
    '',
    '## Procedure',
    '1. Locate every menu item in the image. Match each visible item-name text to an itemId in the catalog above.',
    '   If a text label does not match any item in the catalog, do NOT invent an itemId — skip it.',
    '2. For each item, identify its variant(s) from nearby labels:',
    '     - "meal", "entree" — the common variants.',
    '     - "meal-Nct", "entree-Nct" — when a count appears (e.g. "8ct" → "meal-8ct"). N is whatever integer is shown.',
    '     - "base" — only when the item has a single price/calories pair and NO visible variant label.',
    '3. For each variant, find its price text and calorie text:',
    '     - Price looks like a decimal number, e.g. "7.50", "10.25".',
    '     - Calories looks like a number followed by "cal", e.g. "690 cal", "1050 cal".',
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

  await mkdir(DEBUG_DIR, { recursive: true });
  await writeFile(path.join(DEBUG_DIR, `${DESIGN_ID}.raw.json`), raw, 'utf8');

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
      box_px: {
        x: Math.round(px.xmin),
        y: Math.round(px.ymin),
        w: Math.round(px.xmax - px.xmin),
        h: Math.round(px.ymax - px.ymin),
      },
      confidence: s.confidence,
      reasoning: s.reasoning,
      inCatalog: Object.prototype.hasOwnProperty.call(items, s.itemId),
    };
  });

  await writeFile(
    path.join(DEBUG_DIR, `${DESIGN_ID}.slots.json`),
    `${JSON.stringify({ image: { width: imgW, height: imgH }, slots }, null, 2)}\n`,
    'utf8'
  );

  // ── Debug HTML ────────────────────────────────────────────────────────────
  const imgDataUri = `data:image/png;base64,${imageBuf.toString('base64')}`;
  const boxDivs = slots
    .map((s, i) => {
      const labelColor = !s.inCatalog ? '#ff5577' : s.field === 'price' ? '#22d3ee' : '#facc15';
      const escape = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const label = `${i + 1}. ${s.itemId}/${s.variantId}/${s.field} (${s.confidence.toFixed(2)})${s.inCatalog ? '' : ' ⚠️ NOT IN CATALOG'}`;
      return `
<div class="box ${s.field}${s.inCatalog ? '' : ' invalid'}"
     style="left:${s.box_px.x}px;top:${s.box_px.y}px;width:${s.box_px.w}px;height:${s.box_px.h}px;border-color:${labelColor}"
     title="${escape(s.reasoning)}">
  <span class="label" style="background:${labelColor}">${escape(label)}</span>
  <span class="anchor" title="render anchor (x=${s.x}, y=${s.y})"></span>
</div>`;
    })
    .join('');

  const summary = slots
    .map(
      (s, i) =>
        `<tr class="${s.inCatalog ? '' : 'bad'}"><td>${i + 1}</td><td>${s.itemId}</td><td>${s.variantId}</td><td>${s.field}</td><td>${s.x}, ${s.y}</td><td>${s.box_px.w}×${s.box_px.h}</td><td>${s.confidence.toFixed(2)}</td><td>${s.reasoning.replace(/</g, '&lt;')}</td></tr>`
    )
    .join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${DESIGN_ID} debug</title>
<style>
  body { margin:0; background:#0b0d10; color:#e5e7eb; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .stage { position:relative; width:${imgW}px; height:${imgH}px; }
  .stage img { position:absolute; inset:0; width:100%; height:100%; }
  .box { position:absolute; border:2px solid; box-sizing:border-box; pointer-events:auto; }
  .box.invalid { border-style:dashed; }
  .box .label { position:absolute; top:-20px; left:-2px; padding:1px 6px; font-size:11px; color:#0b0d10; white-space:nowrap; font-weight:600; }
  .box .anchor { position:absolute; left:-4px; top:-4px; width:8px; height:8px; background:#fff; border:1px solid #000; border-radius:50%; }
  table { width:${imgW}px; margin-top:24px; border-collapse:collapse; }
  th, td { padding:6px 10px; border-bottom:1px solid #2a2e35; text-align:left; vertical-align:top; }
  th { background:#1c1f24; position:sticky; top:0; }
  tr.bad { background:#3a1414; }
  td:nth-child(8) { max-width:480px; font-size:12px; color:#9ca3af; }
  h2 { padding:12px 16px; margin:0; background:#1c1f24; }
</style></head>
<body>
<h2>${DESIGN_ID} — ${slots.length} slots ${slots.filter((s) => !s.inCatalog).length ? `(${slots.filter((s) => !s.inCatalog).length} not in catalog)` : ''}</h2>
<div class="stage"><img src="${imgDataUri}" alt="">${boxDivs}</div>
<table>
  <thead><tr><th>#</th><th>itemId</th><th>variantId</th><th>field</th><th>anchor (x,y)</th><th>box w×h</th><th>conf</th><th>reasoning</th></tr></thead>
  <tbody>${summary}</tbody>
</table>
</body></html>`;

  await writeFile(path.join(DEBUG_DIR, `${DESIGN_ID}.boxes.html`), html, 'utf8');

  const notInCatalog = slots.filter((s) => !s.inCatalog);
  console.log(`\nWrote:`);
  console.log(`  debug/${DESIGN_ID}.raw.json     — Gemini's raw structured response`);
  console.log(`  debug/${DESIGN_ID}.slots.json   — pixel-space slots`);
  console.log(`  debug/${DESIGN_ID}.boxes.html   — open in a browser to inspect`);
  console.log(`\n${slots.length} slots. ${notInCatalog.length} not in catalog.`);
  if (notInCatalog.length) {
    console.log('Items invented by the model:');
    for (const s of notInCatalog) console.log(`  - ${s.itemId} (${s.field}, conf=${s.confidence.toFixed(2)})`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
