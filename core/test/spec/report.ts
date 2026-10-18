/**
 * `bun run spec:report [section | example number]...` -- both readings of every differing spec
 * example; with no arguments, the per-section counts. GFM's tables are the section `gfm` (or
 * `'gfm #200'`), the fuzz families `fuzz` and `'underscore fuzz'` (or `'fuzz 12'`). Reads the same
 * measurement as `specConformance.test.ts`.
 */

import { FUZZ_FAMILIES, fuzzName, gfmName, measure } from './measure';
import { GFM_TABLE_EXAMPLES, specExamples } from './inputs';

const args = process.argv.slice(2);
const m = measure();
const totals = new Map<string, number>();
for (const ex of specExamples()) totals.set(ex.section, (totals.get(ex.section) ?? 0) + 1);

/** One differing entry, by its `Measurement.detail` key. */
function print(key: string, label: string): void {
  const d = m.detail.get(key);
  if (d) console.log(`--- ${key} (${label})\n${JSON.stringify(d.markdown)}\n  converter: ${d.converter}\n  spec:      ${d.spec}`);
}

if (!args.length) {
  for (const [s, differ] of m.spec) console.log(`${String(differ.length).padStart(3)}/${String(totals.get(s)).padEnd(3)} ${s}`);
  console.log(`${String(m.gfm.length).padStart(3)}/${String(GFM_TABLE_EXAMPLES.length).padEnd(3)} gfm (GFM 0.29 tables)`);
}
for (const [section, differ] of m.spec) {
  for (const n of differ) if (args.includes(section) || args.includes(String(n))) print(`#${n}`, section);
}
for (const n of m.gfm) if (args.includes('gfm') || args.includes(gfmName(n))) print(gfmName(n), 'GFM tables');
for (const { key, prefix } of FUZZ_FAMILIES) {
  for (const differ of m.fuzz[key].values()) {
    for (const i of differ) if (args.includes(prefix) || args.includes(fuzzName(prefix, i))) print(fuzzName(prefix, i), prefix);
  }
}
