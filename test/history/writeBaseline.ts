/**
 * `bun run history:baseline <area>... | all [--raise]` -- rewrite each area's baseline from the
 * tree as it is, and print every file whose count moved.
 *
 * It only lowers a baseline: an area where some file has more hits than allowed is printed and left
 * unwritten, and the command exits 1. `--raise` records the increase, for the rare history that is
 * meant to stay; read what it prints before committing. An area left with nothing to allow loses
 * its baseline file.
 */

import { AREA_NAMES, counts, moves, readBaseline, scanTree, writeBaseline, type Area } from './history';

const raise = process.argv.includes('--raise');
const args = process.argv.slice(2).filter((a) => a !== '--raise');
const unknown = args.filter((a) => a !== 'all' && !(AREA_NAMES as readonly string[]).includes(a));
if (args.length === 0 || unknown.length > 0) {
  console.error(`usage: bun run history:baseline <area>... | all [--raise]\nareas: ${AREA_NAMES.join(', ')}`);
  if (unknown.length > 0) console.error(`not an area: ${unknown.join(', ')}`);
  process.exit(2);
}

const areas: readonly Area[] = args.includes('all') ? AREA_NAMES : (args as Area[]);
const scan = scanTree();
let refused = false;
for (const area of areas) {
  const after = counts(scan, area);
  const moved = moves(readBaseline(area), after);
  const lines = moved.map(({ path, was, is }) => `  ${path}: ${was} -> ${is}${is > was ? '   MORE history' : ''}`);
  const more = moved.some(({ was, is }) => is > was);
  if (more && !raise) {
    refused = true;
    console.log(`${area}: NOT written -- a count went up; rewrite that history, or pass --raise`);
  } else {
    writeBaseline(area, after);
    const total = Object.values(after).reduce((a, b) => a + b, 0);
    const files = Object.keys(after).length;
    console.log(`${area}: ${total} hits in ${files} files${files === 0 ? ' (baseline file removed)' : ''}`);
  }
  console.log(lines.length > 0 ? lines.join('\n') : '  nothing moved');
}
process.exit(refused ? 1 : 0);
