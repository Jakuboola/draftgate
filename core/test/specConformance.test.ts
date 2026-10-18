/**
 * The converter against CommonMark 0.31.2 + GFM: each input read twice, through the converter and
 * through micromark + GFM, normalised to one shape (`spec/normalise.ts`, which holds the deliberate
 * differences), and compared with `spec/baseline.ts`, a ratchet in both directions:
 *  - a row going up is a regression: fix it, or add the reading to `DELIBERATE` with its reason;
 *  - a row going down is a gap closing, and fails until the same PR runs `bun run spec:baseline`,
 *    or the next regression in that row would be absorbed by the slack.
 * Inputs: `spec/inputs.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SPEC_BASELINE } from './spec/baseline';
import { FUZZ_FAMILIES, measure } from './spec/measure';
import { FUZZ_BASELINES, moved, rows, type Row } from './spec/ratchet';
import { compare, DELIBERATE, tidy } from './spec/normalise';

const m = measure();

/**
 * Fail if a row moved, with both readings of up to three new differences. Thrown rather than
 * `expect`ed, so the message prints as lines.
 */
function ratchet(row: Row): void {
  const r = moved(row);
  if (!r) return;
  const lines = [r.line];
  if (r.worse.length) {
    lines.push(
      'UP means this change made the converter read these differently from the spec. Fix it, or add the reading to',
      '`DELIBERATE` in core/test/spec/normalise.ts with its reason. `bun run spec:report <number>` shows every entry.'
    );
    for (const key of r.worse.slice(0, 3)) {
      const d = m.detail.get(key);
      if (d) lines.push(`  ${key}: ${JSON.stringify(d.markdown)}`, `    converter: ${d.converter}`, `    spec:      ${d.spec}`);
    }
  }
  if (r.better.length) {
    lines.push('DOWN means a gap closed. Lower the baseline in this PR: `bun run spec:baseline`, then read what it prints.');
  }
  throw new Error(lines.join('\n'));
}

const all = rows(m);

test('every spec section and every fuzz block has a baseline row, and nothing else does', () => {
  expect(Object.keys(SPEC_BASELINE).sort()).toEqual([...m.spec.keys()].sort());
  for (const { key } of FUZZ_FAMILIES) expect(Object.keys(FUZZ_BASELINES[key].rows).map(Number)).toEqual([...m.fuzz[key].keys()]);
});

test.each(all.map((r) => [r.row, r] as const))('%s', (_row, r) => ratchet(r));

/**
 * Each deliberate difference, held to its input, so a rewrite that stops matching fails under its
 * own name rather than as a baseline row rising. With that one rule off the readings must part, so
 * the input reaches its rule.
 */
describe('the deliberate differences are applied', () => {
  test.each(DELIBERATE.map((d) => [d.what, d] as const))('%s', (_what, d) => {
    expect(compare(d.example).kind).toBe(d.where === 'exempt' ? 'exempt' : 'agree');
    expect(compare(d.example, d.id).kind).toBe('differ');
  });
});

test('block-edge whitespace is trimmed, except inside a code span, where it is padding', () => {
  // Trimmed there too, a reader that keeps `` ` a ` ``'s padding reads the same as the spec: the
  // ratchet goes blind to it (mutation-proved: drop `stripsPadding` in `codeSpan.ts` and only this
  // exception makes Code spans and Backslash escapes move).
  expect(tidy([{ t: ' a ', m: [] }])).toEqual([{ t: 'a', m: [] }]);
  expect(tidy([{ t: ' a ', m: ['code'] }])).toEqual([{ t: ' a ', m: ['code'] }]);
  expect(tidy([{ t: 'x \n', m: [] }, { t: ' a ', m: ['code'] }])).toEqual([{ t: 'x\n', m: [] }, { t: ' a ', m: ['code'] }]);
});

describe('the spec parser reaches no shipped code', () => {
  // Dev dependencies, test-only: `core` must stay pure and the review bundle must not grow a parser.
  const ROOT = join(import.meta.dir, '..', '..');
  const PARSERS = ['micromark', 'micromark-extension-gfm', 'mdast-util-from-markdown', 'mdast-util-gfm', 'commonmark-spec', '@types/mdast'];

  test('no shipped source names one, by import, require or dynamic import', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) {
          // Any quoted specifier naming a parser package, however it is loaded.
          if (/['"`](micromark|mdast|commonmark-spec)[\w\-/]*['"`]/.test(readFileSync(p, 'utf8'))) hits.push(relative(ROOT, p));
        }
      }
    };
    for (const dir of ['core/src', 'cli/src', 'adapters', 'surface']) walk(join(ROOT, dir));
    expect(hits).toEqual([]);
  });

  test('each is a devDependency, never a dependency', () => {
    const pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(PARSERS.filter((p) => !pkg.devDependencies?.[p] || pkg.dependencies?.[p])).toEqual([]);
  });
});
