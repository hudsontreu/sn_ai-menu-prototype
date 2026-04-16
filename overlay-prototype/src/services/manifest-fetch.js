export async function fetchActiveManifest() {
  const res = await fetch('/assets/active.json');
  if (!res.ok) throw new Error(`Failed to load manifest: ${res.status} ${res.statusText}`);
  return res.json();
}
