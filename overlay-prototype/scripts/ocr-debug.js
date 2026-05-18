// Renders OCR output as a debug HTML overlay on the source PNG.
// Usage: npm run ocr:debug [designId]   (omit designId to process all)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const MENUS_FULL_DIR = path.join(PROJECT_ROOT, 'data', 'menus', 'full');
const OCR_DIR = path.join(PROJECT_ROOT, 'data', 'ocr');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug-ocr');

function escapeHtml(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function generateHtml(designId, ocr, imgDataUri) {
  const { width: imgW, height: imgH } = ocr.imageSize;

  const wordDivs = ocr.words
    .map((w, i) => {
      const looksLikePrice = /^\$?\d+(\.\d+)?$/.test(w.text);
      const looksLikeCal = /\d/.test(w.text) || /^cal$/i.test(w.text);
      const color = looksLikePrice ? '#22d3ee' : looksLikeCal ? '#facc15' : '#9ca3af';
      const label = `[${i}] "${w.text}"${w.confidence != null ? ` ${(w.confidence * 100).toFixed(0)}%` : ''}`;
      return `
<div class="box"
     style="left:${w.bbox.x}px;top:${w.bbox.y}px;width:${w.bbox.w}px;height:${w.bbox.h}px;border-color:${color}"
     title="${escapeHtml(label)}">
  <span class="label" style="background:${color}">${escapeHtml(label)}</span>
</div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>OCR debug — ${escapeHtml(designId)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0b0d; color: #e5e7eb; font: 12px ui-sans-serif, system-ui, sans-serif; }
  .meta { padding: 10px 14px; background: #111114; border-bottom: 1px solid #27272a; position: sticky; top: 0; z-index: 10; }
  .stage { position: relative; width: ${imgW}px; height: ${imgH}px; margin: 16px auto; }
  .stage img { display: block; width: 100%; height: 100%; }
  .box { position: absolute; border: 2px solid; box-sizing: border-box; pointer-events: auto; }
  .box:hover { background: rgba(255, 255, 255, 0.08); z-index: 5; }
  .label {
    position: absolute; top: -16px; left: -2px; padding: 1px 4px;
    font-size: 10px; color: #0b0b0d; white-space: nowrap; border-radius: 2px;
    opacity: 0; transition: opacity 0.1s;
  }
  .box:hover .label { opacity: 1; }
  .legend { display: inline-flex; gap: 14px; margin-left: 16px; font-size: 11px; }
  .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: middle; border: 1px solid; }
</style>
</head>
<body>
<div class="meta">
  <strong>${escapeHtml(designId)}</strong>
  — ${ocr.wordCount} words, ${ocr.lineCount} lines
  — ${imgW}×${imgH}px
  <span class="legend">
    <span><span class="swatch" style="border-color:#22d3ee"></span>price-like</span>
    <span><span class="swatch" style="border-color:#facc15"></span>contains digit / "cal"</span>
    <span><span class="swatch" style="border-color:#9ca3af"></span>other text</span>
  </span>
  <span style="margin-left:16px; opacity:0.6">hover a box to see index + text</span>
</div>
<div class="stage">
  <img src="${imgDataUri}" alt="${escapeHtml(designId)}" />
  ${wordDivs}
</div>
</body>
</html>
`;
}

async function processDesign(designId) {
  const imagePath = path.join(MENUS_FULL_DIR, `${designId}.png`);
  const ocrPath = path.join(OCR_DIR, `${designId}.json`);

  const [imageBuf, ocrRaw] = await Promise.all([readFile(imagePath), readFile(ocrPath, 'utf8')]);
  const ocr = JSON.parse(ocrRaw);
  const imgDataUri = `data:image/png;base64,${imageBuf.toString('base64')}`;

  const html = generateHtml(designId, ocr, imgDataUri);
  const outPath = path.join(DEBUG_DIR, `${designId}.html`);
  await writeFile(outPath, html, 'utf8');
  console.log(`  wrote debug-ocr/${designId}.html (${ocr.wordCount} words)`);
}

async function main() {
  await mkdir(DEBUG_DIR, { recursive: true });

  const filter = process.argv.slice(2).map((a) => a.replace(/\.(json|png)$/i, '').trim()).filter(Boolean);

  const cached = (await readdir(OCR_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'));
  const ids = filter.length ? cached.filter((id) => filter.includes(id)) : cached;

  if (filter.length) {
    const missing = filter.filter((id) => !cached.includes(id));
    if (missing.length) console.warn(`Warning: no OCR cache for: ${missing.join(', ')}. Run \`npm run ocr -- ${missing.join(' ')}\` first.`);
  }
  if (!ids.length) throw new Error('No OCR cache files found. Run `npm run ocr` first.');

  for (const id of ids) {
    console.log(`\n=== ${id} ===`);
    await processDesign(id);
  }
  console.log(`\nDone. Open debug-ocr/*.html in a browser.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
