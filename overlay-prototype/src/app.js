import { renderDesign } from './renderer.js';

const storeSelect = document.getElementById('store-select');
const screenSelect = document.getElementById('screen-select');
const toolbarMeta = document.getElementById('toolbar-meta');
const menuFrame = document.getElementById('menu-frame');
const menuEmpty = document.getElementById('menu-empty');

const state = {
  registry: null,
  items: null,
  designCache: new Map(),
  pricingCache: new Map(),
};

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

async function loadDesign(designId) {
  if (!state.designCache.has(designId)) {
    state.designCache.set(designId, await fetchJson(`/data/designs/${designId}.json`));
  }
  return state.designCache.get(designId);
}

async function loadPricing(storeId) {
  if (!state.pricingCache.has(storeId)) {
    state.pricingCache.set(storeId, await fetchJson(`/data/pricing/${storeId}.json`));
  }
  return state.pricingCache.get(storeId);
}

function populateStores() {
  storeSelect.innerHTML = '';
  for (const [storeId, store] of Object.entries(state.registry.stores)) {
    const opt = document.createElement('option');
    opt.value = storeId;
    opt.textContent = `${storeId} — ${store.name}`;
    storeSelect.appendChild(opt);
  }
}

function populateScreens(storeId) {
  screenSelect.innerHTML = '';
  const store = state.registry.stores[storeId];
  const screenIds = Object.keys(store.screens);
  for (const screenId of screenIds) {
    const designId = store.screens[screenId];
    const opt = document.createElement('option');
    opt.value = screenId;
    opt.textContent = `Screen ${screenId} (${designId})`;
    screenSelect.appendChild(opt);
  }
}

async function renderCurrent() {
  const storeId = storeSelect.value;
  const screenId = screenSelect.value;
  if (!storeId || !screenId) return;

  const store = state.registry.stores[storeId];
  const designId = store.screens[screenId];

  const [design, pricing] = await Promise.all([
    loadDesign(designId),
    loadPricing(storeId),
  ]);

  menuEmpty.style.display = 'none';
  renderDesign({
    frame: menuFrame,
    design,
    pricing,
    items: state.items,
  });

  toolbarMeta.textContent = `${store.name} · ${designId} · ${design.overlays.length} items`;
}

async function init() {
  try {
    const [registry, items] = await Promise.all([
      fetchJson('/data/registry.json'),
      fetchJson('/data/items.json'),
    ]);
    state.registry = registry;
    state.items = items;

    populateStores();
    const firstStore = storeSelect.value;
    if (firstStore) {
      populateScreens(firstStore);
      await renderCurrent();
    }

    storeSelect.addEventListener('change', async () => {
      populateScreens(storeSelect.value);
      await renderCurrent();
    });
    screenSelect.addEventListener('change', renderCurrent);
  } catch (err) {
    menuEmpty.textContent = `Failed to load: ${err.message}`;
    console.error(err);
  }
}

init();
