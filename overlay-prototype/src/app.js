import { fetchActiveManifest } from './services/manifest-fetch.js';
import { mount } from './views/dynamic-view.js';

const storeSelect = document.getElementById('store-select');
const screenSelect = document.getElementById('screen-select');
const toolbarMeta = document.getElementById('toolbar-meta');
const menuFrame = document.getElementById('menu-frame');
const menuEmpty = document.getElementById('menu-empty');

const state = { manifest: null };

function populateStores() {
  storeSelect.innerHTML = '';
  const sorted = Object.entries(state.manifest.stores).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  for (const [storeId, store] of sorted) {
    const opt = document.createElement('option');
    opt.value = storeId;
    opt.textContent = `${storeId} — ${store.name}`;
    storeSelect.appendChild(opt);
  }
}

function populateScreens(storeId) {
  screenSelect.innerHTML = '';
  const store = state.manifest.stores[storeId];
  const sorted = Object.entries(store.screens).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  for (const [screenId, entry] of sorted) {
    const opt = document.createElement('option');
    opt.value = screenId;
    opt.textContent = `Screen ${screenId} (${entry.designId})`;
    screenSelect.appendChild(opt);
  }
}

async function renderCurrent() {
  const storeId = storeSelect.value;
  const screenId = screenSelect.value;
  if (!storeId || !screenId) return;

  const store = state.manifest.stores[storeId];
  const entry = store.screens[screenId];

  if (menuEmpty) menuEmpty.style.display = 'none';
  await mount(menuFrame, entry);
  toolbarMeta.textContent = `${store.name} · ${entry.designId}`;
}

async function init() {
  try {
    state.manifest = await fetchActiveManifest();
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
    if (menuEmpty) menuEmpty.textContent = `Failed to load: ${err.message}`;
    console.error(err);
  }
}

init();
