/**
 * `bun run history:report [area | path ...]` -- every history hit, one per line, as
 * `path:line  code  match  | the line`. With no argument, a count per area and per pattern.
 *
 * For a cleanup PR: report your area, rewrite what it lists, then `bun run history:baseline <area>`.
 */

import { AREA_NAMES, areaOf, counts, PATTERNS, scanTree, type Code } from './history';

const args = process.argv.slice(2);
const scan = scanTree();
const all = [...scan.hits.values()].flat();

if (args.length === 0) {
  for (const a of AREA_NAMES) {
    const c = Object.values(counts(scan, a));
    if (c.length > 0) console.log(`${a.padEnd(13)} ${String(c.reduce((x, y) => x + y, 0)).padStart(5)} hits in ${c.length} files`);
  }
  console.log(`${'total'.padEnd(13)} ${String(all.length).padStart(5)} hits in ${scan.hits.size} files`);
  for (const code of Object.keys(PATTERNS) as Code[]) {
    console.log(`  ${code.padEnd(8)} ${String(all.filter((h) => h.code === code).length).padStart(5)}  ${PATTERNS[code]}`);
  }
} else {
  const wanted = (path: string) => args.some((a) => a === areaOf(path) || path === a || path.startsWith(`${a.replace(/\/$/, '')}/`));
  for (const h of all.filter((h) => wanted(h.path))) {
    console.log(`${h.path}:${h.line}  ${h.code}  ${h.match}  | ${h.text}`);
  }
}
