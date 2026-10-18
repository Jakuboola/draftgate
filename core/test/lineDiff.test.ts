/**
 * `lineDiff` strips the identical head and tail before building the O(n*m) LCS table (measured:
 * 6,000 lines cost 274ms and 175 MB). These pin the behaviour the trim's index arithmetic must keep.
 */

import { describe, expect, test } from 'bun:test';
import { collapseUnchanged, lineDiff } from '../src/lineDiff';

/** Reconstruct each side from the diff. Both must come back exactly, or the diff lost something. */
function sides(before: string, after: string) {
  const rows = lineDiff(before, after);
  return {
    before: rows.filter((r) => r.kind !== 'added').map((r) => r.text).join('\n'),
    after: rows.filter((r) => r.kind !== 'removed').map((r) => r.text).join('\n'),
    rows,
  };
}

describe('lineDiff', () => {
  /**
   * The kinds, not just the reconstruction: `sides()` cannot tell removed-then-added from `same`, so
   * `if (a[i] === b[j])` -> `if (false)` leaves every reconstruction test green while every row of
   * the fix modal turns red and green.
   */
  test('unchanged lines INSIDE the diff region are marked same, not removed and re-added', () => {
    // Head and tail are trimmed before the table is built, so the shared `keep` line here is the
    // only thing that exercises the equal-line branch: it is surrounded by changes on both sides.
    const rows = lineDiff('start\nA\nkeep\nB\nend', 'start\nX\nkeep\nY\nend');
    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
      'same:start',
      'removed:A',
      'added:X',
      'same:keep',
      'removed:B',
      'added:Y',
      'same:end',
    ]);
  });

  test('and a long shared run inside the region stays shared', () => {
    const before = ['head', 'A', 'x', 'y', 'z', 'B', 'tail'].join('\n');
    const after = ['head', 'Q', 'x', 'y', 'z', 'R', 'tail'].join('\n');
    const kinds = lineDiff(before, after).filter((r) => r.kind === 'same').map((r) => r.text);
    expect(kinds).toEqual(['head', 'x', 'y', 'z', 'tail']);
  });

  test('identical input produces no changes', () => {
    const rows = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(rows.every((r) => r.kind === 'same')).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'c']);
  });

  test('both sides reconstruct exactly, across shapes the trim has to handle', () => {
    const cases: [string, string][] = [
      ['a\nb\nc', 'a\nB\nc'],                    // change in the middle
      ['a\nb\nc', 'x\nb\nc'],                    // change at the head
      ['a\nb\nc', 'a\nb\nz'],                    // change at the tail
      ['a\nb\nc', 'a\nb\nc\nd'],                 // pure append
      ['a\nb\nc\nd', 'a\nb\nc'],                 // pure truncation
      ['a\nb\nc', 'q\nr\ns'],                    // nothing in common
      ['', 'a'],                                 // empty before
      ['a', ''],                                 // empty after
      ['', ''],                                  // both empty
      ['a\na\na', 'a\na'],                       // repeated lines, which confuse naive trims
      ['x\na\nb\nx', 'x\nb\nx'],                 // identical head AND tail around a deletion
    ];
    for (const [before, after] of cases) {
      const got = sides(before, after);
      expect(got.before).toBe(before);
      expect(got.after).toBe(after);
    }
  });

  test('an unchanged head and tail are reported as unchanged, not rewritten', () => {
    const rows = lineDiff('keep1\nkeep2\nOLD\nkeep3', 'keep1\nkeep2\nNEW\nkeep3');
    expect(rows.filter((r) => r.kind === 'removed').map((r) => r.text)).toEqual(['OLD']);
    expect(rows.filter((r) => r.kind === 'added').map((r) => r.text)).toEqual(['NEW']);
    expect(rows.filter((r) => r.kind === 'same').map((r) => r.text)).toEqual([
      'keep1', 'keep2', 'keep3',
    ]);
  });

  test('a long document with one changed line stays cheap', () => {
    /*
     * The point of the trim: without it, N lines allocate an N x N table. Not a wall-clock budget
     * (a claim about the machine): at the SAME size, a document with an identical head and tail
     * must cost a small fraction of one with nothing in common.
     *
     * Measured, 1,000 lines each side:
     *
     *              one changed line     nothing in common     ratio
     *   with       0.08 - 0.10 ms       6.4 - 7.4 ms          ~1/75
     *   without    ~6.3 ms              5.4 ms                ~1/1
     *
     * A tenth sits clear of both.
     */
    const lines = Array.from({ length: 1_000 }, (_, i) => `line ${i}`);
    const before = lines.join('\n');
    const oneChanged = [...lines.slice(0, 500), 'CHANGED', ...lines.slice(501)].join('\n');
    const nothingShared = Array.from({ length: 1_000 }, (_, i) => `other ${i}`).join('\n');

    /** Median of three after a warm-up: one sample of a sub-millisecond run is noise. */
    const cost = (a: string, b: string) => {
      lineDiff(a, b);
      const runs = [0, 0, 0].map(() => {
        const t = Bun.nanoseconds();
        lineDiff(a, b);
        return Bun.nanoseconds() - t;
      });
      return runs.sort((x, y) => x - y)[1]!;
    };

    const trimmable = cost(before, oneChanged);
    const opaque = cost(before, nothingShared);

    const rows = lineDiff(before, oneChanged);
    expect(rows.filter((r) => r.kind === 'removed').map((r) => r.text)).toEqual(['line 500']);
    expect(rows.filter((r) => r.kind === 'added').map((r) => r.text)).toEqual(['CHANGED']);

    expect(
      trimmable * 10 < opaque,
      `the trim is not happening: one changed line cost ${(trimmable / 1e6).toFixed(2)}ms against ` +
        `${(opaque / 1e6).toFixed(2)}ms for a document with nothing in common, at the same size`
    ).toBe(true);
  });
});

describe('collapseUnchanged', () => {
  test('keeps context around each change and reports the gap', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'CHANGED');
    const rows = collapseUnchanged(lineDiff(before, after), 2);

    const gaps = rows.filter((r) => r.kind === 'gap') as { kind: 'gap'; count: number }[];
    expect(gaps.length).toBe(2);
    // Every line is either shown or accounted for in a gap.
    const shown = rows.filter((r) => r.kind !== 'gap').length;
    const skipped = gaps.reduce((n, g) => n + g.count, 0);
    expect(shown + skipped).toBe(lineDiff(before, after).length);
  });

  test('an unchanged document collapses to a single gap', () => {
    const doc = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    const rows = collapseUnchanged(lineDiff(doc, doc));
    expect(rows).toEqual([{ kind: 'gap', count: 10 }]);
  });
});
