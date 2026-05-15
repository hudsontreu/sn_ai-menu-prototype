const DESIGN_W = 1920;
const DESIGN_H = 1080;

const FORMATTERS = {
  price: (v) => (v == null ? null : Number(v).toFixed(2)),
  calories: (v) => (v == null ? null : `${v} cal`),
};

function formatSlotValue(slot, pricing) {
  const entry = pricing && pricing[slot.tag];
  const raw = entry ? entry[slot.field] : null;
  const fmt = FORMATTERS[slot.field] ?? ((v) => (v == null ? null : String(v)));
  const result = fmt(raw);
  if (result != null) return result;
  return slot.field === 'price' ? '—.——' : '— cal';
}

export function createStage({ root, frame, slotLayer, bgImg, placeHint, getState, setState, onChange }) {
  let scale = 1;
  let drag = null;

  function fit() {
    if (!frame) return;
    const frameW = frame.clientWidth;
    if (!frameW) return;
    scale = frameW / DESIGN_W;
    root.style.transform = `scale(${scale})`;
  }

  function setBackground() {
    const { design, view } = getState();
    if (!design) {
      bgImg.removeAttribute('src');
      return;
    }
    const fileName = `${design.id}.png`;
    // 'generated' → clean bg; 'compare' and 'boxes' → full menu image
    bgImg.src = view === 'generated'
      ? `/qa-assets/menus/background/${fileName}`
      : `/qa-assets/menus/full/${fileName}`;
  }

  function renderSlots() {
    const { design, selectedIndex, pricing, view } = getState();
    slotLayer.innerHTML = '';
    root.dataset.view = view || 'generated';
    if (!design) return;
    design.slots.forEach((slot, i) => {
      const el = document.createElement('div');
      el.className = 'qa-slot';
      if (i === selectedIndex) el.classList.add('selected');
      el.dataset.index = String(i);
      el.style.left = `${slot.x}px`;
      el.style.top = `${slot.y}px`;
      el.style.width = `${slot.w || 40}px`;
      el.style.height = `${slot.h || 24}px`;

      const group = slot.styleGroup || 'a';
      const textEl = document.createElement('div');
      textEl.className = `overlay ${slot.field}-${group}`;
      textEl.style.top = '0';
      textEl.style.left = '0';
      const span = document.createElement('span');
      span.className = 'value';
      span.textContent = formatSlotValue(slot, pricing);
      textEl.appendChild(span);
      el.appendChild(textEl);

      const label = document.createElement('span');
      label.className = 'qa-slot-label';
      label.textContent = `${i + 1}`;
      el.appendChild(label);

      slotLayer.appendChild(el);
    });
  }

  function render() {
    setBackground();
    renderSlots();
    fit();
  }

  function pointerToDesign(ev) {
    const rect = root.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / scale;
    const y = (ev.clientY - rect.top) / scale;
    return { x: Math.max(0, Math.min(DESIGN_W, x)), y: Math.max(0, Math.min(DESIGN_H, y)) };
  }

  slotLayer.addEventListener('pointerdown', (ev) => {
    const target = ev.target.closest('.qa-slot');
    if (!target) return;
    const index = Number(target.dataset.index);
    const { design } = getState();
    const slot = design.slots[index];
    drag = {
      index,
      startPointerX: ev.clientX,
      startPointerY: ev.clientY,
      startX: slot.x,
      startY: slot.y,
      moved: false,
    };
    try { target.setPointerCapture(ev.pointerId); } catch {}
    setState({ selectedIndex: index });
    onChange({ selectionChanged: true });
    ev.stopPropagation();
  });

  slotLayer.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = (ev.clientX - drag.startPointerX) / scale;
    const dy = (ev.clientY - drag.startPointerY) / scale;
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
    const { design } = getState();
    const slot = design.slots[drag.index];
    slot.x = Math.round((drag.startX + dx) * 10) / 10;
    slot.y = Math.round((drag.startY + dy) * 10) / 10;
    const el = slotLayer.querySelector(`[data-index="${drag.index}"]`);
    if (el) {
      el.style.left = `${slot.x}px`;
      el.style.top = `${slot.y}px`;
    }
    onChange({ positionChanged: drag.index });
  });

  slotLayer.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    if (drag.moved) onChange({ dirty: true });
    drag = null;
    ev.stopPropagation();
  });

  root.addEventListener('click', (ev) => {
    if (ev.target.closest('.qa-slot')) return;
    const state = getState();
    if (state.placingNew) {
      const { x, y } = pointerToDesign(ev);
      const newSlot = {
        tag: state.defaultTag || Object.keys(state.catalog || {})[0] || '',
        field: 'price',
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        w: 60,
        h: 24,
        confidence: 1,
        reasoning: 'Added via QA portal',
        styleGroup: 'a',
      };
      const { design } = state;
      design.slots.push(newSlot);
      setState({ placingNew: false, selectedIndex: design.slots.length - 1 });
      placeHint.hidden = true;
      onChange({ dirty: true, structureChanged: true, selectionChanged: true });
      render();
    } else {
      setState({ selectedIndex: null });
      onChange({ selectionChanged: true });
      renderSlots();
    }
  });

  window.addEventListener('keydown', (ev) => {
    const state = getState();
    if (state.selectedIndex == null || !state.design) return;
    if (document.activeElement && document.activeElement.matches('input, select, textarea')) return;
    const slot = state.design.slots[state.selectedIndex];
    const step = ev.shiftKey ? 10 : 1;
    let handled = true;
    if (ev.key === 'ArrowLeft') slot.x = Math.round((slot.x - step) * 10) / 10;
    else if (ev.key === 'ArrowRight') slot.x = Math.round((slot.x + step) * 10) / 10;
    else if (ev.key === 'ArrowUp') slot.y = Math.round((slot.y - step) * 10) / 10;
    else if (ev.key === 'ArrowDown') slot.y = Math.round((slot.y + step) * 10) / 10;
    else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (!confirm(`Delete slot #${state.selectedIndex + 1} (${slot.tag} · ${slot.field})?`)) return;
      state.design.slots.splice(state.selectedIndex, 1);
      setState({ selectedIndex: null });
      onChange({ dirty: true, structureChanged: true, selectionChanged: true });
      render();
      ev.preventDefault();
      return;
    } else if (ev.key === 'Escape') {
      setState({ placingNew: false, selectedIndex: null });
      placeHint.hidden = true;
      onChange({ selectionChanged: true });
      renderSlots();
      return;
    } else {
      handled = false;
    }
    if (handled) {
      ev.preventDefault();
      onChange({ dirty: true, positionChanged: state.selectedIndex });
      const el = slotLayer.querySelector(`[data-index="${state.selectedIndex}"]`);
      if (el) {
        el.style.left = `${slot.x}px`;
        el.style.top = `${slot.y}px`;
      }
    }
  });

  window.addEventListener('resize', fit);

  // refit when frame size changes (resize handle dragging or window resizes)
  if (window.ResizeObserver && frame) {
    const ro = new ResizeObserver(() => fit());
    ro.observe(frame);
  }

  fit();

  return {
    render,
    refit: fit,
    enterPlaceMode() {
      setState({ placingNew: true });
      placeHint.hidden = false;
    },
  };
}
