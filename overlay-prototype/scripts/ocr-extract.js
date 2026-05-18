// Runs Google Cloud Vision DOCUMENT_TEXT_DETECTION over data/menus/full/*.png
// and caches per-design word + line boxes to data/ocr/{designId}.json.
//
// Re-run only when the source PNG changes — OCR output is deterministic for a
// given image, so the downstream Gemini step can rely on this cache.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import vision from '@google-cloud/vision';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const MENUS_FULL_DIR = path.join(PROJECT_ROOT, 'data', 'menus', 'full');
const OCR_DIR = path.join(PROJECT_ROOT, 'data', 'ocr');

function polyToRect(vertices) {
  // Vision returns a 4-point polygon. Menu text is upright, so axis-align it.
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  const xmin = Math.min(...xs);
  const ymin = Math.min(...ys);
  const xmax = Math.max(...xs);
  const ymax = Math.max(...ys);
  return { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
}

function wordText(word) {
  return (word.symbols ?? []).map((s) => s.text ?? '').join('');
}

function extractStructured(fullTextAnnotation) {
  const words = [];
  const lines = [];

  for (const page of fullTextAnnotation?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        // Reconstruct lines by splitting paragraph words on detected breaks.
        let currentLine = [];
        const flushLine = () => {
          if (!currentLine.length) return;
          const text = currentLine.map(wordText).join(' ');
          const xs = currentLine.flatMap((w) => (w.boundingBox?.vertices ?? []).map((v) => v.x ?? 0));
          const ys = currentLine.flatMap((w) => (w.boundingBox?.vertices ?? []).map((v) => v.y ?? 0));
          lines.push({
            text,
            bbox: {
              x: Math.min(...xs),
              y: Math.min(...ys),
              w: Math.max(...xs) - Math.min(...xs),
              h: Math.max(...ys) - Math.min(...ys),
            },
            wordIndices: currentLine.map((_, i) => words.length - currentLine.length + i),
          });
          currentLine = [];
        };

        for (const word of paragraph.words ?? []) {
          words.push({
            text: wordText(word),
            bbox: polyToRect(word.boundingBox?.vertices ?? []),
            confidence: word.confidence ?? null,
          });
          currentLine.push(word);

          // Detected break types: SPACE, SURE_SPACE, EOL_SURE_SPACE, LINE_BREAK, HYPHEN.
          const breakType = word.symbols?.[word.symbols.length - 1]?.property?.detectedBreak?.type;
          if (breakType === 'LINE_BREAK' || breakType === 'EOL_SURE_SPACE') flushLine();
        }
        flushLine();
      }
    }
  }

  return { words, lines };
}

function readPngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function isCacheFresh(cachePath, sourcePath) {
  try {
    const [c, s] = await Promise.all([stat(cachePath), stat(sourcePath)]);
    return c.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

async function processDesign(designId, imagePath, client, { force }) {
  const cachePath = path.join(OCR_DIR, `${designId}.json`);
  if (!force && (await isCacheFresh(cachePath, imagePath))) {
    console.log(`  cache fresh, skipping (use --force to re-run)`);
    return;
  }

  const imageBuf = await readFile(imagePath);
  const { width, height } = readPngSize(imageBuf);
  console.log(`  image: ${width}x${height} (${imageBuf.length} bytes)`);

  const t0 = Date.now();
  const [result] = await client.documentTextDetection({
    image: { content: imageBuf },
  });
  console.log(`  vision responded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (result.error?.message) throw new Error(`Vision error: ${result.error.message}`);

  const { words, lines } = extractStructured(result.fullTextAnnotation);

  const output = {
    designId,
    imageSize: { width, height },
    generatedAt: new Date().toISOString(),
    wordCount: words.length,
    lineCount: lines.length,
    words,
    lines,
  };

  await writeFile(cachePath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`  wrote data/ocr/${designId}.json (${words.length} words, ${lines.length} lines)`);
}

async function main() {
  await mkdir(OCR_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const filter = args
    .filter((a) => !a.startsWith('--'))
    .map((a) => a.replace(/\.png$/i, '').trim())
    .filter(Boolean);

  const allFiles = (await readdir(MENUS_FULL_DIR)).filter((f) => f.endsWith('.png'));
  const files = filter.length
    ? allFiles.filter((f) => filter.includes(path.basename(f, '.png')))
    : allFiles;

  if (filter.length) {
    const missing = filter.filter((id) => !allFiles.some((f) => path.basename(f, '.png') === id));
    if (missing.length) console.warn(`Warning: no PNG found for: ${missing.join(', ')}`);
  }

  if (!files.length) throw new Error(`No PNG files found in ${MENUS_FULL_DIR}`);

  // ImageAnnotatorClient picks up ADC from `gcloud auth application-default login`.
  // GCP_PROJECT_ID env var is optional — ADC carries the project — but passing it
  // explicitly avoids a "could not determine project ID" warning on some setups.
  const client = new vision.ImageAnnotatorClient({
    projectId: process.env.GCP_PROJECT_ID,
  });

  for (const file of files) {
    const designId = path.basename(file, '.png');
    const imagePath = path.join(MENUS_FULL_DIR, file);
    console.log(`\n=== ${designId} ===`);
    await processDesign(designId, imagePath, client, { force });
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
