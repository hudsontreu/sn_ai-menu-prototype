// Post-processes Gemini slot output to align coordinates.
// Groups x and y values independently — any values within 3px are averaged.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.resolve(__dirname, '..', 'data', 'gemini-output');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'data', 'post-output');

function alignAxis(slots, axis) {
  const values = slots.map((s, i) => ({ i, val: s[axis] }));
  values.sort((a, b) => a.val - b.val);

  const groups = [];
  let current = [values[0]];

  for (let k = 1; k < values.length; k++) {
    if (values[k].val - current[current.length - 1].val <= 3) {
      current.push(values[k]);
    } else {
      groups.push(current);
      current = [values[k]];
    }
  }
  groups.push(current);

  const changes = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const avg = Math.round((group.reduce((s, g) => s + g.val, 0) / group.length) * 10) / 10;
    for (const member of group) {
      if (member.val !== avg) {
        changes.push({ tag: slots[member.i].tag, field: slots[member.i].field, axis, from: member.val, to: avg });
        slots[member.i][axis] = avg;
      }
    }
  }
  return changes;
}

async function main() {
  const files = (await readdir(INPUT_DIR)).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    console.log('No design JSON files found in data/gemini-output/.');
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  let totalChanges = 0;

  for (const file of files) {
    const design = JSON.parse(await readFile(path.join(INPUT_DIR, file), 'utf8'));
    if (!design.slots?.length) continue;

    const changes = [...alignAxis(design.slots, 'x'), ...alignAxis(design.slots, 'y')];

    await writeFile(path.join(OUTPUT_DIR, file), `${JSON.stringify(design, null, 2)}\n`, 'utf8');

    if (changes.length) {
      console.log(`\n${design.id}:`);
      for (const c of changes) {
        console.log(`  ${c.tag} [${c.field}] ${c.axis}: ${c.from} → ${c.to}`);
      }
      totalChanges += changes.length;
    } else {
      console.log(`\n${design.id}: no adjustments needed`);
    }
  }

  if (totalChanges === 0) {
    console.log('No alignment adjustments needed.');
  } else {
    console.log(`\nDone. ${totalChanges} value(s) adjusted.`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
