import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const POST_OUTPUT_DIR = path.join(DATA_DIR, 'post-output');
const FULL_DIR = path.join(DATA_DIR, 'menus', 'full');
const BG_DIR = path.join(DATA_DIR, 'menus', 'background');
const CATALOG_PATH = path.join(DATA_DIR, 'cfa-items.json');

const PRICING_DIR = path.join(DATA_DIR, 'pricing');
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');
const DESIGN_ID_RE = /^[a-z0-9._-]+$/i;

const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

function isNonEmpty(v) { return v != null && String(v).trim() !== ''; }
function nonZero(v) {
  if (!isNonEmpty(v)) return null;
  const s = String(v).trim();
  return Number(s) === 0 ? null : s;
}
function composeCalories(item) {
  const single = nonZero(item.Calories);
  if (single) return single;
  const lo = nonZero(item.CaloriesLow);
  const hi = nonZero(item.CaloriesHigh);
  if (lo || hi) return `${lo ?? '0'}/${hi ?? '0'}`;
  return null;
}

async function loadPricingForStore(storeId) {
  const raw = await readFile(path.join(PRICING_DIR, `${storeId}.xml`), 'utf8');
  const parsed = xmlParser.parse(raw);
  const items = parsed?.Items?.Item ?? [];
  const list = Array.isArray(items) ? items : [items];
  const out = {};
  for (const it of list) {
    const tag = isNonEmpty(it.Tag) ? String(it.Tag).trim() : null;
    if (!tag) continue;
    out[tag] = {
      price: isNonEmpty(it.Price) ? Number(it.Price) : null,
      calories: composeCalories(it),
    };
  }
  return out;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function servePng(res, absPath) {
  try {
    const s = await stat(absPath);
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', s.size);
    res.setHeader('cache-control', 'no-store');
    createReadStream(absPath).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

export function qaPlugin() {
  return {
    name: 'qa-portal',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';
        if (!url.startsWith('/api/qa/') && !url.startsWith('/qa-assets/')) {
          return next();
        }

        try {
          // GET /api/qa/designs
          if (req.method === 'GET' && url === '/api/qa/designs') {
            const files = await readdir(POST_OUTPUT_DIR);
            const ids = files
              .filter((f) => f.endsWith('.json'))
              .map((f) => f.replace(/\.json$/, ''))
              .sort();
            return sendJson(res, 200, { designs: ids });
          }

          // GET /api/qa/pricing  — first available store's pricing as {TAG: {price, calories}}
          if (req.method === 'GET' && url === '/api/qa/pricing') {
            try {
              const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
              const storeIds = Object.keys(registry.stores || {});
              if (!storeIds.length) return sendJson(res, 200, {});
              const pricing = await loadPricingForStore(storeIds[0]);
              return sendJson(res, 200, pricing);
            } catch (err) {
              if (err.code === 'ENOENT') return sendJson(res, 200, {});
              throw err;
            }
          }

          // GET /api/qa/catalog
          if (req.method === 'GET' && url === '/api/qa/catalog') {
            const raw = await readFile(CATALOG_PATH, 'utf8');
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            return res.end(raw);
          }

          // GET/PUT /api/qa/design/:id
          const designMatch = url.match(/^\/api\/qa\/design\/([^/?]+)$/);
          if (designMatch) {
            const id = decodeURIComponent(designMatch[1]);
            if (!DESIGN_ID_RE.test(id)) return sendText(res, 400, 'Bad design id');
            const filePath = path.join(POST_OUTPUT_DIR, `${id}.json`);

            if (req.method === 'GET') {
              try {
                const raw = await readFile(filePath, 'utf8');
                res.statusCode = 200;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.setHeader('cache-control', 'no-store');
                return res.end(raw);
              } catch (err) {
                if (err.code === 'ENOENT') return sendText(res, 404, 'Design not found');
                throw err;
              }
            }

            if (req.method === 'PUT') {
              const body = await readJsonBody(req);
              if (!body || !Array.isArray(body.slots)) {
                return sendText(res, 400, 'Body must be a design JSON with a slots array');
              }
              await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
              return sendJson(res, 200, { ok: true, path: `data/post-output/${id}.json` });
            }

            return sendText(res, 405, 'Method not allowed');
          }

          // GET /qa-assets/menus/full/:file
          const fullMatch = url.match(/^\/qa-assets\/menus\/full\/([^/?]+\.png)$/);
          if (fullMatch && req.method === 'GET') {
            const file = decodeURIComponent(fullMatch[1]);
            return servePng(res, path.join(FULL_DIR, file));
          }

          // GET /qa-assets/menus/background/:file
          const bgMatch = url.match(/^\/qa-assets\/menus\/background\/([^/?]+\.png)$/);
          if (bgMatch && req.method === 'GET') {
            const file = decodeURIComponent(bgMatch[1]);
            return servePng(res, path.join(BG_DIR, file));
          }

          return sendText(res, 404, 'Not found');
        } catch (err) {
          console.error('[qa-plugin]', err);
          return sendText(res, 500, `Internal error: ${err.message}`);
        }
      });
    },
  };
}
