/**
 * What differs today, in the shape `baseline.ts` records it. Shared by the test and by
 * `bun run spec:baseline`, so the two cannot measure different things.
 */

import { compare, type Verdict } from './normalise';
import { fixtures, fuzzBodies, GFM_TABLE_EXAMPLES, specExamples, UNDERSCORE_FUZZ } from './inputs';

/** How many fuzz bodies, and how many share one line of the baseline. */
export const FUZZ_COUNT = 400;
export const FUZZ_BLOCK = 25;
/** The underscore family's, in blocks of the same size, and the one call that draws it (own seed). */
export const UNDERSCORE_FUZZ_COUNT = 200;
export const underscoreFuzzBodies = (): string[] => fuzzBodies(UNDERSCORE_FUZZ_COUNT, 164, UNDERSCORE_FUZZ);

/**
 * The fuzz families, each with its own rows and baseline (`ratchet.ts`'s `FUZZ_BASELINES`): its
 * key in `Measurement.fuzz`, what its rows and bodies are called, and the bodies.
 */
export const FUZZ_FAMILIES = [
  { key: 'fuzz', prefix: 'fuzz', bodies: () => fuzzBodies(FUZZ_COUNT) },
  { key: 'underscoreFuzz', prefix: 'underscore fuzz', bodies: underscoreFuzzBodies },
] as const;
export type FuzzFamily = (typeof FUZZ_FAMILIES)[number]['key'];

/** A fuzz body's name, in a failure message and as its key in `Measurement.detail`. */
export const fuzzName = (prefix: string, i: number): string => `${prefix} ${i}`;

/** A GFM table example's name, likewise -- not `#N`, which is CommonMark's numbering. */
export const gfmName = (n: number): string => `gfm #${n}`;

export interface Measurement {
  /** Section -> differing example numbers, ascending. Every section appears, even at zero. */
  readonly spec: Map<string, number[]>;
  /** GFM table example numbers that differ, ascending. */
  readonly gfm: number[];
  /** Differing fixture names. */
  readonly fixtures: string[];
  /** Per fuzz family: first index of a block of `FUZZ_BLOCK` -> differing indices in it. Every block appears. */
  readonly fuzz: Readonly<Record<FuzzFamily, Map<number, number[]>>>;
  /** Every differing input's markdown and both readings, keyed `#12`, `gfm #200`, a fixture name, `fuzz 12` or `underscore fuzz 12`. */
  readonly detail: Map<string, { markdown: string; converter: string; spec: string }>;
}

/** Each body's verdict, by block of `FUZZ_BLOCK`, under `name`. */
function fuzzRows(bodies: string[], name: (i: number) => string, note: (key: string, markdown: string, v: Verdict) => boolean): Map<number, number[]> {
  const rows = new Map<number, number[]>();
  bodies.forEach((body, i) => {
    const block = i - (i % FUZZ_BLOCK);
    const row = rows.get(block) ?? [];
    rows.set(block, row);
    if (note(name(i), body, compare(body))) row.push(i);
  });
  return rows;
}

export function measure(): Measurement {
  const detail: Measurement['detail'] = new Map();
  const note = (key: string, markdown: string, v: Verdict): boolean => {
    if (v.kind !== 'differ') return false;
    detail.set(key, { markdown, converter: v.converter, spec: v.spec });
    return true;
  };

  const spec = new Map<string, number[]>();
  for (const ex of specExamples()) {
    const row = spec.get(ex.section) ?? [];
    spec.set(ex.section, row);
    if (note(`#${ex.number}`, ex.markdown, compare(ex.markdown))) row.push(ex.number);
  }

  const gfm = GFM_TABLE_EXAMPLES.filter((ex) => note(gfmName(ex.number), ex.markdown, compare(ex.markdown))).map((ex) => ex.number);

  const fixtureRows: string[] = [];
  for (const f of fixtures()) if (note(f.name, f.markdown, compare(f.markdown))) fixtureRows.push(f.name);

  const fuzz = Object.fromEntries(
    FUZZ_FAMILIES.map(({ key, prefix, bodies }) => [key, fuzzRows(bodies(), (i) => fuzzName(prefix, i), note)])
  ) as Record<FuzzFamily, Map<number, number[]>>;

  return { spec, gfm, fixtures: fixtureRows, fuzz, detail };
}
