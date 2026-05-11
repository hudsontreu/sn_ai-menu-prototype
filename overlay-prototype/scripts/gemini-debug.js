// Generates debug HTML overlays from existing data/output/*.json files.
// Opens bounding boxes on top of source PNGs for visual accuracy inspection.
// Usage: npm run figma:debug [designId]   (omit designId to process all)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const MENUS_FULL_DIR = path.join(PROJECT_ROOT, 'data', 'menus', 'full');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'output');
const ITEMS_PATH = path.join(PROJECT_ROOT, 'data', 'cfa-items.json');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

function readPngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('Not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function generateDebugHtml(designId, slots, imgDataUri, imgW, imgH, catalog) {
  const boxDivs = slots
    .map((s, i) => {
      const inCatalog = Object.prototype.hasOwnProperty.call(catalog, s.tag);
      const hasBox = s.w > 0 && s.h > 0;
      const labelColor = !inCatalog ? '#ff5577' : s.field === 'price' ? '#22d3ee' : '#facc15';
      const label = `${i + 1}. ${s.tag}/${s.field} (${s.confidence.toFixed(2)})${inCatalog ? '' : ' ⚠ NOT IN CATALOG'}`;

      if (hasBox) {
        return `
<div class="box ${s.field}${inCatalog ? '' : ' invalid'}"
     style="left:${Math.round(s.x)}px;top:${Math.round(s.y)}px;width:${s.w}px;height:${s.h}px;border-color:${labelColor}"
     title="${escapeHtml(s.reasoning)}">
  <span class="label" style="background:${labelColor}">${escapeHtml(label)}</span>
  <span class="anchor" title="render anchor (x=${s.x}, y=${s.y})"></span>
</div>`;
      }
      // Fallback for slots without w/h — render as anchor dot with label
      return `
<div class="dot ${s.field}${inCatalog ? '' : ' invalid'}"
     style="left:${Math.round(s.x)}px;top:${Math.round(s.y)}px;border-color:${labelColor}"
     title="${escapeHtml(s.reasoning)}">
  <span class="label" style="background:${labelColor}">${escapeHtml(label)}</span>
</div>`;
    })
    .join('');

  const summaryRows = slots
    .map((s, i) => {
      const inCatalog = Object.prototype.hasOwnProperty.call(catalog, s.tag);
      const sizeStr = s.w > 0 && s.h > 0 ? `${s.w}×${s.h}` : '—';
      return `<tr class="${inCatalog ? '' : 'bad'}"><td>${i + 1}</td><td>${escapeHtml(s.tag)}</td><td>${s.field}</td><td>${s.x}, ${s.y}</td><td>${sizeStr}</td><td>${s.confidence.toFixed(2)}</td><td>${escapeHtml(s.reasoning)}</td></tr>`;
    })
    .join('');

  const notInCatalog = slots.filter((s) => !Object.prototype.hasOwnProperty.call(catalog, s.tag));

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${designId} debug</title>
<style>
  body { margin:0; background:#0b0d10; color:#e5e7eb; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .stage { position:relative; width:${imgW}px; height:${imgH}px; }
  .stage img { position:absolute; inset:0; width:100%; height:100%; }
  .box { position:absolute; border:2px solid; box-sizing:border-box; pointer-events:auto; }
  .box.invalid { border-style:dashed; }
  .box .label { position:absolute; top:-20px; left:-2px; padding:1px 6px; font-size:11px; color:#0b0d10; white-space:nowrap; font-weight:600; }
  .box .anchor { position:absolute; left:-4px; top:-4px; width:8px; height:8px; background:#fff; border:1px solid #000; border-radius:50%; }
  .dot { position:absolute; width:12px; height:12px; border:2px solid; border-radius:50%; background:rgba(255,255,255,0.3); margin-left:-6px; margin-top:-6px; pointer-events:auto; }
  .dot .label { position:absolute; top:-20px; left:-2px; padding:1px 6px; font-size:11px; color:#0b0d10; white-space:nowrap; font-weight:600; }
  table { width:${imgW}px; margin-top:24px; border-collapse:collapse; }
  th, td { padding:6px 10px; border-bottom:1px solid #2a2e35; text-align:left; vertical-align:top; }
  th { background:#1c1f24; position:sticky; top:0; }
  tr.bad { background:#3a1414; }
  td:nth-child(7) { max-width:480px; font-size:12px; color:#9ca3af; }
  h2 { padding:12px 16px; margin:0; background:#1c1f24; }
</style></head>
<body>
<h2>${designId} — ${slots.length} slots${notInCatalog.length ? ` (${notInCatalog.length} not in catalog)` : ''}</h2>
<div class="stage"><img src="${imgDataUri}" alt="">${boxDivs}</div>
<table>
  <thead><tr><th>#</th><th>tag</th><th>field</th><th>anchor (x,y)</th><th>box w×h</th><th>conf</th><th>reasoning</th></tr></thead>
  <tbody>${summaryRows}</tbody>
</table>
</body></html>`;
}

async function processDesign(designId, catalog) {
  const outputPath = path.join(OUTPUT_DIR, `${designId}.json`);
  const imagePath = path.join(MENUS_FULL_DIR, `${designId}.png`);

  let design;
  try {
    design = JSON.parse(await readFile(outputPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`Skipping ${designId}: no output file at data/output/${designId}.json`);
      return;
    }
    throw err;
  }

  let imageBuf;
  try {
    imageBuf = await readFile(imagePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`Skipping ${designId}: no source PNG at data/menus/full/${designId}.png`);
      return;
    }
    throw err;
  }

  const { width: imgW, height: imgH } = readPngSize(imageBuf);
  const slots = design.slots || [];
  if (!slots.length) {
    console.warn(`Skipping ${designId}: no slots in output`);
    return;
  }

  const imgDataUri = `data:image/png;base64,${imageBuf.toString('base64')}`;
  const html = generateDebugHtml(designId, slots, imgDataUri, imgW, imgH, catalog);
  await writeFile(path.join(DEBUG_DIR, `${designId}.html`), html, 'utf8');

  const notInCatalog = slots.filter((s) => !Object.prototype.hasOwnProperty.call(catalog, s.tag));
  console.log(`  ${designId}.html — ${slots.length} slots${notInCatalog.length ? `, ${notInCatalog.length} not in catalog` : ''}`);
}

async function main() {
  await mkdir(DEBUG_DIR, { recursive: true });

  const catalog = JSON.parse(await readFile(ITEMS_PATH, 'utf8'));
  const targetDesign = process.argv[2];

  if (targetDesign) {
    console.log(`Generating debug HTML for: ${targetDesign}`);
    await processDesign(targetDesign, catalog);
  } else {
    const outputFiles = (await readdir(OUTPUT_DIR)).filter((f) => f.endsWith('.json'));
    if (!outputFiles.length) {
      throw new Error(`No output files in ${OUTPUT_DIR}. Run npm run figma:batch first.`);
    }
    console.log(`Generating debug HTML for ${outputFiles.length} design(s):`);
    for (const file of outputFiles) {
      await processDesign(path.basename(file, '.json'), catalog);
    }
  }

  console.log(`\nDebug files written to debug/. Open in a browser to inspect.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
