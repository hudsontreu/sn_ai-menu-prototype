const FORMATTERS = {
  price: (v) => (v == null ? null : `$${Number(v).toFixed(2)}`),
  calories: (v) => (v == null ? null : `${v} cal`),
};

function clearOverlays(frame) {
  frame.querySelectorAll('.overlay').forEach((el) => el.remove());
}

function resolveValue(pricing, slot) {
  const variant = pricing?.items?.[slot.itemId]?.variants?.[slot.variantId];
  return variant?.[slot.field];
}

export function renderDesign({ frame, design, pricing, items }) {
  frame.style.backgroundImage = `url("${design.backgroundImage}")`;
  clearOverlays(frame);

  for (const slot of design.slots) {
    const raw = resolveValue(pricing, slot);
    const format = FORMATTERS[slot.field] ?? ((v) => (v == null ? null : String(v)));
    const text = format(raw);

    const overlay = document.createElement('div');
    overlay.className = `overlay field-${slot.field}`;
    overlay.style.left = `${slot.x}%`;
    overlay.style.top = `${slot.y}%`;
    overlay.dataset.itemId = slot.itemId;
    overlay.dataset.variantId = slot.variantId;
    overlay.title = `${items?.[slot.itemId]?.name ?? slot.itemId} · ${slot.variantId}`;

    const valueEl = document.createElement('div');
    valueEl.className = 'value';
    if (text != null) {
      valueEl.textContent = text;
    } else {
      valueEl.textContent = '—';
      overlay.classList.add('missing');
    }
    overlay.appendChild(valueEl);
    frame.appendChild(overlay);
  }
}
