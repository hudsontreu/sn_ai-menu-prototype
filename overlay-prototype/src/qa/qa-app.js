import { api } from './api.js';
import { createStage } from './stage.js';
import { createInspector } from './inspector.js';

const els = {
  designSelect: document.getElementById('qa-design-select'),
  bgToggle: document.getElementById('qa-bg-toggle'),
  addBtn: document.getElementById('qa-add-slot'),
  saveBtn: document.getElementById('qa-save'),
  status: document.getElementById('qa-status'),
  stageRoot: document.getElementById('qa-stage'),
  slotLayer: document.getElementById('qa-slot-layer'),
  bgImg: document.getElementById('qa-bg'),
  placeHint: document.getElementById('qa-place-hint'),
  tbody: document.getElementById('qa-tbody'),
  countEl: document.getElementById('qa-count'),
};

const state = {
  designs: [],
  designId: null,
  design: null,
  catalog: null,
  selectedIndex: null,
  placingNew: false,
  background: 'full',
  dirty: false,
};

const getState = () => state;
const setState = (patch) => Object.assign(state, patch);

let stage;
let inspector;

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `qa-status ${kind}`;
}

function setDirty(d) {
  state.dirty = d;
  els.saveBtn.disabled = !d;
  setStatus(d ? 'Unsaved changes' : 'Saved', d ? 'dirty' : 'clean');
}

function onChange(evt) {
  if (evt.dirty) setDirty(true);
  if (evt.selectionChanged || evt.structureChanged) {
    inspector.render();
  } else if (evt.positionChanged != null) {
    inspector.refreshRow(evt.positionChanged);
  } else if (evt.propertyChanged) {
    // value change comes from inspector itself; no re-render needed unless field changed
    if (evt.propertyChanged.prop === 'tag' || evt.propertyChanged.prop === 'field' || evt.propertyChanged.prop === 'styleGroup') {
      stage.render();
    }
  }
  if (evt.structureChanged) {
    stage.render();
  }
  if (evt.selectRow != null) {
    setState({ selectedIndex: evt.selectRow });
    stage.render();
    inspector.refreshSelection();
  }
  if (evt.selectionChanged) {
    stage.render();
    inspector.refreshSelection();
  }
}

async function loadDesign(id) {
  if (state.dirty) {
    if (!confirm('You have unsaved changes. Discard and switch design?')) {
      els.designSelect.value = state.designId;
      return;
    }
  }
  setStatus('Loading…');
  const design = await api.getDesign(id);
  state.designId = id;
  state.design = design;
  state.selectedIndex = null;
  state.placingNew = false;
  els.placeHint.hidden = true;
  setDirty(false);
  setStatus('Loaded', 'clean');
  stage.render();
  inspector.render();
}

async function init() {
  try {
    const [designsRes, catalogRes] = await Promise.all([api.listDesigns(), api.getCatalog()]);
    state.designs = designsRes.designs;
    state.catalog = catalogRes;

    els.designSelect.innerHTML = state.designs
      .map((id) => `<option value="${id}">${id}</option>`)
      .join('');

    stage = createStage({
      root: els.stageRoot,
      slotLayer: els.slotLayer,
      bgImg: els.bgImg,
      placeHint: els.placeHint,
      getState,
      setState,
      onChange,
    });
    inspector = createInspector({
      tbody: els.tbody,
      countEl: els.countEl,
      getState,
      onChange,
    });

    els.designSelect.addEventListener('change', () => loadDesign(els.designSelect.value));

    els.bgToggle.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-bg]');
      if (!btn) return;
      const bg = btn.dataset.bg;
      if (bg === state.background) return;
      state.background = bg;
      [...els.bgToggle.querySelectorAll('button')].forEach((b) =>
        b.classList.toggle('active', b === btn)
      );
      stage.render();
    });

    els.addBtn.addEventListener('click', () => {
      if (!state.design) return;
      stage.enterPlaceMode();
      setStatus('Click on the stage to place the new slot…', 'placing');
    });

    els.saveBtn.addEventListener('click', async () => {
      if (!state.design || !state.dirty) return;
      els.saveBtn.disabled = true;
      setStatus('Saving…');
      try {
        await api.putDesign(state.designId, state.design);
        setDirty(false);
        setStatus('Saved · run `npm run build:overlays` to regenerate store HTML', 'clean');
      } catch (err) {
        setStatus(`Save failed: ${err.message}`, 'error');
        els.saveBtn.disabled = false;
      }
    });

    window.addEventListener('beforeunload', (ev) => {
      if (state.dirty) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });

    if (state.designs.length) {
      els.designSelect.value = state.designs[0];
      await loadDesign(state.designs[0]);
    } else {
      setStatus('No designs found in data/post-output/', 'error');
    }
  } catch (err) {
    setStatus(`Init failed: ${err.message}`, 'error');
    console.error(err);
  }
}

init();
