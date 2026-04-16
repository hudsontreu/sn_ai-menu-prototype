export async function mount(root, { background, overlay }) {
  const preserved = [...root.children].filter(
    (el) => !el.classList.contains('layer-bg') && !el.classList.contains('layer-overlay')
  );
  root.replaceChildren(...preserved);

  const bgEl = document.createElement('img');
  bgEl.className = 'layer-bg';
  bgEl.src = background;
  bgEl.alt = '';
  root.appendChild(bgEl);

  const overlayEl = document.createElement('div');
  overlayEl.className = 'layer-overlay';
  root.appendChild(overlayEl);

  const res = await fetch(overlay);
  if (!res.ok) throw new Error(`Failed to load overlay: ${res.status} ${res.statusText}`);
  overlayEl.innerHTML = await res.text();
}
