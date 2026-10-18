/**
 * No source file in this repo is classified as binary.
 *
 * One literal U+0000 byte in a source file -- say inside a template literal used as a `Map` key
 * separator -- is invisible to everything that reads the file as text (bun, tsc, the editor), and
 * makes everything that sniffs for binary skip it: `file(1)` reports it as `data`, and plain `grep`
 * prints "binary file matches" or, with a pattern that misses, nothing at all -- a search comes back
 * empty rather than wrong. A NUL is the only byte that does this, so the check stays narrow.
 *
 * The escape form (a backslash, then u0000) is fine and is what `cli/src/digest.ts` uses.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'probe-result', 'ruler-result']);
const SOURCE = /\.(ts|tsx|cjs|mjs|js|css|json|md|html)$/;

/** Every source file in the repo, as repo-relative paths. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (SOURCE.test(e.name)) out.push(relative(ROOT, p));
  }
  return out;
}

const FILES = sourceFiles(ROOT);

describe('no source file holds a NUL byte', () => {
  test('the scan sees the tree it is meant to be scanning', () => {
    // A guard that cannot see its subject passes vacuously.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('cli/src/digest.ts');
    expect(FILES).toContain('surface/request.cjs');
  });

  test('and none of them does', () => {
    const binary = FILES.filter((f) => readFileSync(join(ROOT, f)).includes(0));
    expect(
      binary,
      'these files hold a literal NUL, so file(1) reports them as data and grep skips them; ' +
        'write it as the escape \\u0000 instead'
    ).toEqual([]);
  });
});
