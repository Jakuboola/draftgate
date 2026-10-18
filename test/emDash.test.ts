/**
 * No em dash in the text the review window shows.
 *
 * The window's words come from its own components (`surface/src/`) and the profiles, warnings and
 * remedies in `core/src/`. Comments are scanned too: the rule is the same there, and telling a
 * comment from a string is a parser's job. `core/src/adf/` is left out: it converts a message's own
 * characters (a horizontal rule becomes a row of em dashes).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIRS = ['surface/src', 'core/src'];
const SKIP = new Set(['core/src/adf']);
const SOURCE = /\.(ts|tsx|css)$/;
/** The character, its HTML entity and its escape. */
const EM_DASH = /\u2014|&mdash;|&#8212;|\\u2014/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (SKIP.has(p)) continue;
    if (e.isDirectory()) sourceFiles(p, out);
    else if (SOURCE.test(e.name)) out.push(p);
  }
  return out;
}

/** Each `path:line` that holds an em dash. */
function emDashes(files: readonly string[]): string[] {
  return files.flatMap((f) =>
    readFileSync(join(ROOT, f), 'utf8')
      .split('\n')
      .flatMap((line, i) => (EM_DASH.test(line) ? [`${f}:${i + 1}`] : []))
  );
}

const FILES = DIRS.flatMap((d) => sourceFiles(d));

describe('no em dash in window text', () => {
  test('the scan sees the files the window takes its words from', () => {
    // A guard that cannot see its subject passes vacuously.
    expect(FILES).toContain('surface/src/App.tsx');
    expect(FILES).toContain('core/src/profiles/github.ts');
    expect(FILES).toContain('core/src/warnings.ts');
    expect(FILES).not.toContain('core/src/adf/sanitizeBlockquote.ts');
  });

  test('each spelling of it is caught', () => {
    for (const s of ['a \u2014 b', 'a &mdash; b', 'a &#8212; b', 'a \\u2014 b']) expect(EM_DASH.test(s)).toBe(true);
    expect(EM_DASH.test('a -- b, a – b')).toBe(false);
  });

  test('and none of them holds one', () => {
    expect(emDashes(FILES), 'write `--`, or rewrite the sentence').toEqual([]);
  });
});
