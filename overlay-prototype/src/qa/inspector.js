const FIELDS = ['price', 'calories'];
const STYLE_GROUPS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

export function createInspector({ tbody, getState, onChange }) {
  let cachedTagOptions = null;
  let cachedTagSet = null;
  function tagOptions() {
    if (cachedTagOptions != null) return cachedTagOptions;
    const { catalog } = getState();
    if (!catalog) return '';
    const tags = Object.keys(catalog).sort();
    cachedTagSet = new Set(tags);
    cachedTagOptions = tags
      .map((tag) => {
        const meta = catalog[tag];
        const label = meta && meta['menu-item'] ? `${tag} — ${meta['menu-item']}` : tag;
        return `<option value="${tag}">${label}</option>`;
      })
      .join('');
    return cachedTagOptions;
  }

  function selectMarkup(name, value, options) {
    const opts = options
      .map((o) => `<option value="${o}"${o === value ? ' selected' : ''}>${capitalize(o)}</option>`)
      .join('');
    return `<div class="qa-select-wrap"><select data-prop="${name}" class="qa-select">${opts}</select><span class="qa-select-chevron" aria-hidden="true"></span></div>`;
  }

  function tagSelectMarkup(value, optionsHtml) {
    const orphan = cachedTagSet && !cachedTagSet.has(value)
      ? `<option value="${value}">${value} (not in catalog)</option>`
      : '';
    return `<div class="qa-select-wrap"><select data-prop="tag" class="qa-select qa-tag-select">${orphan}${optionsHtml}</select><span class="qa-select-chevron" aria-hidden="true"></span></div>`;
  }

  function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function render() {
    const { design, selectedIndex } = getState();
    tbody.innerHTML = '';
    if (!design) return;
    const opts = tagOptions();
    design.slots.forEach((slot, i) => {
      const tr = document.createElement('tr');
      tr.dataset.index = String(i);
      if (i === selectedIndex) tr.classList.add('selected');
      tr.innerHTML = `
        <td class="qa-idx">${i + 1}</td>
        <td>${tagSelectMarkup(slot.tag, opts)}</td>
        <td>${selectMarkup('field', slot.field, FIELDS)}</td>
        <td>${selectMarkup('styleGroup', (slot.styleGroup || 'a'), STYLE_GROUPS)}</td>
        <td><input type="number" data-prop="x" class="qa-input" value="${slot.x}" step="0.1" /></td>
        <td><input type="number" data-prop="y" class="qa-input" value="${slot.y}" step="0.1" /></td>
        <td><button type="button" class="qa-row-delete" title="Delete">×</button></td>
      `;
      const tagSel = tr.querySelector('select[data-prop="tag"]');
      if (tagSel) tagSel.value = slot.tag;
      tbody.appendChild(tr);
    });

    if (selectedIndex != null) {
      const row = tbody.querySelector(`tr[data-index="${selectedIndex}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function refreshRow(index) {
    const { design } = getState();
    const tr = tbody.querySelector(`tr[data-index="${index}"]`);
    if (!tr || !design) return;
    const slot = design.slots[index];
    const xIn = tr.querySelector('input[data-prop="x"]');
    const yIn = tr.querySelector('input[data-prop="y"]');
    if (xIn && document.activeElement !== xIn) xIn.value = String(slot.x);
    if (yIn && document.activeElement !== yIn) yIn.value = String(slot.y);
  }

  function refreshSelection() {
    const { selectedIndex } = getState();
    tbody.querySelectorAll('tr').forEach((tr) => {
      const i = Number(tr.dataset.index);
      tr.classList.toggle('selected', i === selectedIndex);
    });
    if (selectedIndex != null) {
      const row = tbody.querySelector(`tr[data-index="${selectedIndex}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  tbody.addEventListener('change', (ev) => {
    const target = ev.target;
    const tr = target.closest('tr');
    if (!tr) return;
    const i = Number(tr.dataset.index);
    const prop = target.dataset.prop;
    if (!prop) return;
    const { design } = getState();
    if (!design) return;
    const slot = design.slots[i];
    if (prop === 'x' || prop === 'y') {
      const v = Number(target.value);
      if (!Number.isFinite(v)) return;
      slot[prop] = v;
      onChange({ dirty: true, positionChanged: i });
    } else {
      slot[prop] = target.value;
      onChange({ dirty: true, propertyChanged: { index: i, prop } });
    }
  });

  tbody.addEventListener('click', (ev) => {
    const delBtn = ev.target.closest('.qa-row-delete');
    if (delBtn) {
      const tr = delBtn.closest('tr');
      const i = Number(tr.dataset.index);
      const { design } = getState();
      const slot = design.slots[i];
      if (!confirm(`Delete slot #${i + 1} (${slot.tag} · ${slot.field})?`)) return;
      design.slots.splice(i, 1);
      onChange({ dirty: true, structureChanged: true });
      return;
    }
    const tr = ev.target.closest('tr');
    if (!tr) return;
    if (ev.target.matches('input, select, button')) return;
    const i = Number(tr.dataset.index);
    onChange({ selectRow: i });
  });

  return { render, refreshRow, refreshSelection };
}
