import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const OVERLAYS_DIR = path.join(PUBLIC_DIR, 'overlays');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');

const FORMATTERS = {
  price: (v) => (v == null ? null : `${Number(v).toFixed(2)}`),
  calories: (v) => (v == null ? null : `${v} cal`),
};

const MISSING_TEXT = '—';

async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function resolveValue(pricing, slot) {
  return pricing?.items?.[slot.itemId]?.variants?.[slot.variantId]?.[slot.field];
}

function renderOverlayHtml(design, pricing) {
  const lines = [];
  for (const slot of design.slots) {
    const raw = resolveValue(pricing, slot);
    const format = FORMATTERS[slot.field] ?? ((v) => (v == null ? null : String(v)));
    const formatted = format(raw);
    const classes = ['overlay', `field-${slot.field}`];
    let text;
    if (formatted == null) {
      classes.push('missing');
      text = MISSING_TEXT;
    } else {
      text = formatted;
    }
    lines.push(
      `<div class="${classes.join(' ')}" data-item="${slot.itemId}" data-variant="${slot.variantId}" style="left:${slot.x}%;top:${slot.y}%"><span class="value">${text}</span></div>`
    );
  }
  return lines.join('\n');
}

async function main() {
  const registry = await loadJson(path.join(DATA_DIR, 'registry.json'));

  await mkdir(OVERLAYS_DIR, { recursive: true });
  await mkdir(ASSETS_DIR, { recursive: true });

  const designCache = new Map();
  const pricingCache = new Map();

  const loadDesign = async (designId) => {
    if (!designCache.has(designId)) {
      designCache.set(designId, await loadJson(path.join(DATA_DIR, 'designs', `${designId}.json`)));
    }
    return designCache.get(designId);
  };

  const loadPricing = async (storeId) => {
    if (!pricingCache.has(storeId)) {
      pricingCache.set(storeId, await loadJson(path.join(DATA_DIR, 'pricing', `${storeId}.json`)));
    }
    return pricingCache.get(storeId);
  };

  const manifest = {
    generatedAt: new Date().toISOString(),
    stores: {},
  };

  let overlayCount = 0;
  for (const [storeId, store] of Object.entries(registry.stores)) {
    const storeEntry = { name: store.name, screens: {} };
    for (const [screenId, designId] of Object.entries(store.screens)) {
      const design = await loadDesign(designId);
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
  console.log(`Wrote manifest → public/assets/active.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
