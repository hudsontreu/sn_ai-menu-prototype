import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BG_SRC_DIR = path.join(DATA_DIR, 'menus', 'background');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const OVERLAYS_DIR = path.join(PUBLIC_DIR, 'overlays');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');

const FORMATTERS = {
  price: (v) => (v == null ? null : `${Number(v).toFixed(2)}`),
  calories: (v) => (v == null ? null : `${v} cal`),
};

const MISSING_TEXT = '—';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function isNonEmpty(v) {
  return v != null && String(v).trim() !== '';
}

function nonZero(v) {
  if (!isNonEmpty(v)) return null;
  const s = String(v).trim();
  return Number(s) === 0 ? null : s;
}

function composeCalories(item) {
  const single = nonZero(item.Calories);
  if (single) return single;
  const lo = nonZero(item.CaloriesLow);
  const hi = nonZero(item.CaloriesHigh);
  if (lo || hi) return `${lo ?? '0'}/${hi ?? '0'}`;
  return null;
}

async function loadPricingXml(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = xmlParser.parse(raw);
  const items = parsed?.Items?.Item ?? [];
  const list = Array.isArray(items) ? items : [items];
  const map = new Map();
  for (const it of list) {
    const tag = isNonEmpty(it.Tag) ? String(it.Tag).trim() : null;
    if (!tag) continue;
    map.set(tag, {
      price: isNonEmpty(it.Price) ? Number(it.Price) : null,
      calories: composeCalories(it),
    });
  }
  return map;
}

function renderOverlayHtml(design, pricing) {
  const lines = [];
  for (const slot of design.slots) {
    const raw = pricing.get(slot.tag)?.[slot.field];
    const format = FORMATTERS[slot.field] ?? ((v) => (v == null ? null : String(v)));
    const formatted = format(raw);
    const classes = ['overlay', `${slot.field}-e`];
    let text;
    if (formatted == null) {
      classes.push('missing');
      text = MISSING_TEXT;
    } else {
      text = formatted;
    }
    lines.push(
      `<div class="${classes.join(' ')}" data-tag="${slot.tag}" style="left:${slot.x}px;top:${slot.y}px"><span class="value">${text}</span></div>`
    );
  }
  return lines.join('\n');
}

async function main() {
  const registry = await loadJson(path.join(DATA_DIR, 'registry.json'));

  await mkdir(OVERLAYS_DIR, { recursive: true });
  await mkdir(ASSETS_DIR, { recursive: true });

  const bgFiles = await readdir(BG_SRC_DIR);
  await Promise.all(
    bgFiles.map((f) => copyFile(path.join(BG_SRC_DIR, f), path.join(ASSETS_DIR, f)))
  );
  console.log(`Copied ${bgFiles.length} background image(s) → public/assets/`);

  const designCache = new Map();
  const pricingCache = new Map();

  const loadDesign = async (designId) => {
    if (!designCache.has(designId)) {
      try {
        designCache.set(designId, await loadJson(path.join(DATA_DIR, 'post-output', `${designId}.json`)));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        designCache.set(designId, null);
      }
    }
    return designCache.get(designId);
  };

  const loadPricing = async (storeId) => {
    if (!pricingCache.has(storeId)) {
      pricingCache.set(storeId, await loadPricingXml(path.join(DATA_DIR, 'pricing', `${storeId}.xml`)));
    }
    return pricingCache.get(storeId);
  };

  const manifest = {
    generatedAt: new Date().toISOString(),
    stores: {},
  };

  let overlayCount = 0;
  let skippedCount = 0;
  for (const [storeId, store] of Object.entries(registry.stores)) {
    const storeEntry = { name: store.name, screens: {} };
    for (const [screenId, designId] of Object.entries(store.screens)) {
      const design = await loadDesign(designId);
      if (!design) {
        console.warn(`Skipping ${storeId}/${screenId}: design "${designId}" not found in data/post-output/`);
        skippedCount++;
        continue;
      }
      const pricing = await loadPricing(storeId);
      const html = renderOverlayHtml(design, pricing);
      const overlayFile = `${storeId}-${screenId}.html`;
      await writeFile(path.join(OVERLAYS_DIR, overlayFile), `${html}\n`, 'utf8');
      storeEntry.screens[screenId] = {
        designId,
        background: design.backgroundImage,
        overlay: `/overlays/${overlayFile}`,
      };
      overlayCount++;
    }
    manifest.stores[storeId] = storeEntry;
  }

  await writeFile(
    path.join(ASSETS_DIR, 'active.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  console.log(`Wrote ${overlayCount} overlay HTML files → public/overlays/`);
  if (skippedCount) console.log(`Skipped ${skippedCount} screen(s) due to missing designs`);
  console.log(`Wrote manifest → public/assets/active.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
