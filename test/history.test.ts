/**
 * No file describes how draftgate was developed: no issue or PR numbers, review finding IDs, `§`
 * references, dates of what happened, or pointers to docs this repo does not have. A comment says
 * why the code is the way it is now.
 *
 * What counts as a hit, and where it is looked for, is `history/history.ts`. An area of the tree may
 * have a baseline in `history/baseline/<area>.json` (file -> hit count): a file may not hold more
 * hits than its count, and a count that drops must be lowered, so the allowance only shrinks. An
 * area with no baseline file allows nothing.
 *
 *   bun run history:report <area | path>   every hit, with its line
 *   bun run history:baseline <area>        rewrite the area's baseline from the tree, printing moves
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyExceptions,
  AREA_NAMES,
  baselineFiles,
  areaOf,
  compare,
  counts,
  EXCEPTIONS,
  readBaseline,
  scanText,
  scanTree,
  type Hit,
} from './history/history';

const SCAN = scanTree();

/** `[code, match]` for each hit in `text`, read as a file at `path`. */
const hitsIn = (path: string, text: string) => scanText(path, text).map((h) => [h.code, h.match]);

describe('the scan', () => {
  test('sees the tree, every kind of file in it, and every area', () => {
    expect(SCAN.files.length).toBeGreaterThan(250);
    for (const f of [
      'cli/src/main.ts',
      'surface/src/App.tsx',
      'surface/request.cjs',
      'surface/src/styles/jira.css',
      'surface/host/draftgate.m',
      'surface/icon/draftgate.svg',
      'install.sh',
      'tsconfig.json',
      '.claude/CLAUDE.md',
      'test/history/writeBaseline.ts',
    ]) {
      expect(SCAN.files).toContain(f);
    }
    for (const area of AREA_NAMES) expect(SCAN.files.some((f) => areaOf(f) === area)).toBe(true);
  });

  test('skips only itself, lockfiles and binaries', () => {
    expect(SCAN.files).not.toContain('test/history.test.ts');
    expect(SCAN.files).not.toContain('test/history/history.ts');
    expect(SCAN.files).not.toContain('bun.lock');
    expect(SCAN.files).not.toContain('surface/icon/draftgate.icns');
  });

  test('every file belongs to an area', () => {
    expect(SCAN.files.filter((f) => areaOf(f) === undefined)).toEqual([]);
  });
});

describe('what is history', () => {
  test('an issue reference in a comment, a test name, markdown and every other kind of file', () => {
    expect(hitsIn('a.ts', '// fixed in #152\nconst x = 1; /* (issue #9) */')).toEqual([
      ['issue', '#152'],
      ['issue', '#9'],
    ]);
    expect(hitsIn('a.test.ts', "test('keeps the title (#111)', () => {});")).toEqual([['issue', '#111']]);
    expect(hitsIn('a.test.ts', 'describe.each(rows)(`%s since #40`, () => {});')).toEqual([['issue', '#40']]);
    // The table `test.each` takes is data, not a name.
    expect(hitsIn('a.test.ts', "test.each([['see #12']])('autolinks %s', () => {});")).toEqual([]);
    expect(hitsIn('a.md', 'Decided in #41.')).toEqual([['issue', '#41']]);
    expect(hitsIn('a.css', '/* the box (#171) */ a { color: #333; }')).toEqual([['issue', '#171']]);
    expect(hitsIn('a.m', '// #150\nNSString *s = @"#1";')).toEqual([['issue', '#150']]);
    expect(hitsIn('a.sh', '# see #9\necho "fixed in #9" # and #10')).toEqual([
      ['issue', '#9'],
      ['issue', '#10'],
    ]);
    expect(hitsIn('a.svg', '<!-- chosen in #149 --><path fill="#151"/>')).toEqual([['issue', '#149']]);
    expect(hitsIn('tsconfig.json', '{\n  // (#22)\n  "a": "#22"\n}')).toEqual([['issue', '#22']]);
  });

  test('an issue named as one, in a string as well as in prose', () => {
    expect(hitsIn('a.ts', "throw new Error('see issue #12');")).toEqual([['issue', '#12']]);
    expect(hitsIn('a.ts', "const s = 'archive#9, PR #3';")).toEqual([
      ['issue', '#9'],
      ['issue', '#3'],
    ]);
    expect(hitsIn('a.json', '{ "description": "(issue #157)" }')).toEqual([['issue', '#157']]);
    expect(hitsIn('a.md', 'Moved to `other-archive#9`, and draftgate#30.')).toEqual([['issue', '#30']]);
    expect(hitsIn('a.ts', "const u = 'https://github.com/Jakuboola/draftgate/pull/7';")).toEqual([
      ['issue', 'github.com/Jakuboola/draftgate/pull/7'],
    ]);
    expect(hitsIn('a.md', 'See https://github.com/Jakuboola/draftgate-docs/issues/3.')).toEqual([
      ['issue', 'github.com/Jakuboola/draftgate-docs/issues/3'],
    ]);
  });

  test('not a colour, an anchor, an entity, a path, quoted syntax or a spec example', () => {
    expect(hitsIn('a.ts', "const c = '#444'; // the panel is #333337")).toEqual([]);
    expect(hitsIn('a.md', 'See [the list](#12), `#123` and `owner/repo#5`, &#123;, ##4.')).toEqual([]);
    expect(hitsIn('a.ts', '// as CommonMark spec #276 has it, and example #342')).toEqual([]);
    expect(hitsIn('a.test.ts', "expect(kinds('see #30')).toContain('see Jakuboola/draftgate#30');")).toEqual([]);
  });

  test("a review finding's ID, anywhere", () => {
    expect(hitsIn('a.ts', "// (low-85)\nmkdtempSync(join(dir, 'g008-'));")).toEqual([
      ['finding', 'low-85'],
      ['finding', 'g008'],
    ]);
    expect(hitsIn('a.ts', "const g = 'g12'; // below-85, flow-8, g1234")).toEqual([]);
  });

  test('a commit hash in prose, and not a colour, a UUID, a font build or a quoted ID', () => {
    expect(hitsIn('a.ts', '// joined as before (84c4abd)\n/* in commit `199ed7b` */')).toEqual([
      ['commit', '84c4abd'],
      ['commit', '199ed7b'],
    ]);
    expect(
      hitsIn('a.ts', '// #e3e4f21f, 0a1b2c3d-4e5f-4a6b, git-9221beed3, comment `0123abcd`, v1.2abc4d5, deadbeef\nconst h = "84c4abd";')
    ).toEqual([]);
  });

  test('a section sign and a pointer to the archive docs, anywhere', () => {
    expect(hitsIn('a.ts', "const s = 'the §4.9 log'; // docs/decisions.md and layout.md")).toEqual([
      ['section', '§'],
      ['pointer', 'decisions.md'],
      ['pointer', 'layout.md'],
    ]);
    expect(hitsIn('a.md', 'Its story is in docs/decisions.')).toEqual([['pointer', 'docs/decisions']]);
  });

  test('a date in prose and in a message, but not a timestamp or a value under test', () => {
    expect(hitsIn('a.ts', "// measured 2026-09-02\nlines.push('Measured 2026-09-11 live');")).toEqual([
      ['date', '2026-09-02'],
      ['date', '2026-09-11'],
    ]);
    expect(
      hitsIn(
        'a.ts',
        "const a = '2026-09-02T10:00:00Z', b = '2026-10-02 10:00 UTC', c = '2026-09-12.1', d = new Date('2024-03-15');"
      )
    ).toEqual([]);
    expect(hitsIn('a.json', '{ "retrieved": "2026-09-25", "version": "2.015; 2015-08-06" }')).toEqual([]);
  });

  test('a regex or code that merely contains the characters is not prose', () => {
    expect(hitsIn('a.ts', 'const re = /#\\d+ 2026-09-02 §/; const n = x#1;')).toEqual([]);
  });
});

describe('the exceptions', () => {
  const hit = (path: string, text: string): Hit => ({ path, line: 1, code: 'section', match: '§', text });

  test('cover their own match on their own line of their own file, and nothing else', () => {
    const ex = { path: 'a.ts', match: '§', line: "not.toContain('§')", why: 'tested' };
    const { kept, used } = applyExceptions(
      [
        hit('a.ts', "expect(x).not.toContain('§')"),
        { ...hit('a.ts', "expect(x).not.toContain('§') // #12"), code: 'issue', match: '#12' },
        hit('a.ts', 'the §4.9 log'),
        hit('b.ts', "not.toContain('§')"),
      ],
      [ex]
    );
    expect(kept.map((h) => `${h.path} ${h.match} ${h.text}`)).toEqual([
      "a.ts #12 expect(x).not.toContain('§') // #12",
      'a.ts § the §4.9 log',
      "b.ts § not.toContain('§')",
    ]);
    expect([...used]).toEqual([ex]);
    // A second `§` written beside the excepted one is still a hit.
    const twice = applyExceptions([hit('a.ts', "not.toContain('§'); // the §4.9 log"), hit('a.ts', "not.toContain('§'); // the §4.9 log")], [ex]);
    expect(twice.kept).toHaveLength(1);
  });

  test('each says why, and each still matches a hit', () => {
    for (const e of EXCEPTIONS) expect(e.why.length).toBeGreaterThan(10);
    expect(SCAN.unusedExceptions).toEqual([]);
  });
});

describe('the baselines', () => {
  test('compare names a file that grew and one that shrank without the baseline lowered', () => {
    expect(compare('cli-src', { 'a.ts': 2, 'b.ts': 3, 'c.ts': 1 }, { 'a.ts': 3, 'b.ts': 1, 'c.ts': 1, 'd.ts': 1 })).toEqual([
      'a.ts: 3 history hits, 2 allowed -- rewrite them (`bun run history:report a.ts`)',
      'b.ts: 1 history hits, 3 still allowed -- lower it: `bun run history:baseline cli-src`',
      'd.ts: 1 history hits, 0 allowed -- rewrite them (`bun run history:report d.ts`)',
    ]);
  });

  test('every baseline file is named for an area', () => {
    // `.json` only: Finder's `.DS_Store` is no baseline. An area with no file allows nothing; with no
    // file at all, git keeps no directory. The listing itself is checked on a scratch directory,
    // since the real one is usually absent.
    const dir = mkdtempSync(join(tmpdir(), 'draftgate-history-'));
    try {
      expect(baselineFiles(join(dir, 'missing'))).toEqual([]);
      writeFileSync(join(dir, 'stray.json'), '{}');
      writeFileSync(join(dir, '.DS_Store'), '');
      expect(baselineFiles(dir)).toEqual(['stray.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const n of baselineFiles()) expect(AREA_NAMES.map((a) => `${a}.json`)).toContain(n);
  });

  for (const area of AREA_NAMES) {
    test(`${area}: no file holds more history than its baseline, or less`, () => {
      expect(compare(area, readBaseline(area), counts(SCAN, area))).toEqual([]);
    });
  }
});
