async function jsonOrThrow(res) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

export const api = {
  async listDesigns() {
    return jsonOrThrow(await fetch('/api/qa/designs'));
  },
  async getDesign(id) {
    return jsonOrThrow(await fetch(`/api/qa/design/${encodeURIComponent(id)}`));
  },
  async putDesign(id, design) {
    return jsonOrThrow(
      await fetch(`/api/qa/design/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(design),
      })
    );
  },
  async getCatalog() {
    return jsonOrThrow(await fetch('/api/qa/catalog'));
  },
};
