/**
 * The ratchet's rows, and how a baseline row and a measured one compare -- in words that say which
 * row moved and which way. One list of rows for the test and for `writeBaseline.ts`, so a new input
 * class cannot be checked by one and forgotten by the other.
 */

import { FIXTURE_BASELINE, FUZZ_BASELINE, GFM_BASELINE, SPEC_BASELINE, UNDERSCORE_FUZZ_BASELINE } from './baseline';
import { FUZZ_BLOCK, FUZZ_FAMILIES, fuzzName, gfmName, type FuzzFamily, type Measurement } from './measure';

export interface Row {
  /** What the failure message calls it. */
  readonly row: string;
  readonly before: readonly (number | string)[];
  readonly after: readonly (number | string)[];
  /** An entry's name in a message, which is also its key in `Measurement.detail`. */
  readonly name: (x: number | string) => string;
}

const exampleName = (x: number | string): string => (typeof x === 'number' ? `#${x}` : x);
const gfmEntry = (x: number | string): string => gfmName(Number(x));

/** Every row: one per spec section, GFM's tables, the fixtures, one per block of each fuzz family. */
export function rows(m: Measurement): Row[] {
  return [
    ...[...m.spec].map(([row, after]) => ({ row, before: SPEC_BASELINE[row] ?? [], after, name: exampleName })),
    { row: 'GFM tables', before: GFM_BASELINE, after: m.gfm, name: gfmEntry },
    { row: 'fixtures', before: FIXTURE_BASELINE, after: m.fixtures, name: exampleName },
    ...FUZZ_FAMILIES.flatMap(({ key, prefix }) =>
      [...m.fuzz[key]].map(([block, after]) => ({
        row: `${prefix} ${block}-${block + FUZZ_BLOCK - 1}`,
        before: FUZZ_BASELINES[key].rows[block] ?? [],
        after,
        name: (x: number | string) => fuzzName(prefix, Number(x)),
      }))
    ),
  ];
}

/** Each fuzz family's baseline, with the export and doc line `writeBaseline.ts` gives it. */
export const FUZZ_BASELINES: Readonly<
  Record<FuzzFamily, { readonly rows: Readonly<Record<number, readonly number[]>>; readonly exported: string; readonly doc: string }>
> = {
  fuzz: {
    rows: FUZZ_BASELINE,
    exported: 'FUZZ_BASELINE',
    doc: 'First index of a block of fuzz bodies -> the indices in it that read differently.',
  },
  underscoreFuzz: {
    rows: UNDERSCORE_FUZZ_BASELINE,
    exported: 'UNDERSCORE_FUZZ_BASELINE',
    doc: 'The same, for the underscore family (`inputs.ts` `UNDERSCORE_FUZZ`).',
  },
};

/**
 * `undefined` when the row is unchanged; otherwise one line naming the row, the counts and the
 * direction, plus the entries that moved each way, by name.
 */
export function moved({ row, before, after, name }: Row): { line: string; worse: string[]; better: string[] } | undefined {
  const was = new Set(before);
  const now = new Set(after);
  const worse = after.filter((x) => !was.has(x)).map(name);
  const better = before.filter((x) => !now.has(x)).map(name);
  if (!worse.length && !better.length) return undefined;
  const direction = worse.length && better.length ? 'UP and DOWN' : worse.length ? 'UP' : 'DOWN';
  const parts = [`${row}: ${before.length} -> ${after.length} (${direction})`];
  if (worse.length) parts.push(`now differ: ${worse.join(', ')}`);
  if (better.length) parts.push(`now agree: ${better.join(', ')}`);
  return { line: parts.join('; '), worse, better };
}
