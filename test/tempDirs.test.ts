/**
 * No test suite may leave a scratch directory behind in `$TMPDIR`: a leaked one holds draft bodies
 * in audit logs, and from `hook.test.ts` a `surface-nonce` the real hook would honour (the gate also
 * refuses an old nonce, so that one is guarded twice).
 *
 * It reads source text: running the suite under an isolated `TMPDIR` would spawn `bun test` inside
 * `bun test` and double its time. It catches a `mkdtempSync` under `tmpdir()` named in no `rmSync`;
 * one nested in another scratch directory is cleaned with its parent.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'tools', 'probe-result']);

/** Every `*.test.ts` / `*.test.tsx` in the repo, as repo-relative paths. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(e.name)) out.push(relative(ROOT, p));
  }
  return out;
}

const FILES = testFiles(ROOT);

/**
 * `NAME = mkdtempSync(join(SCOPE, ...))` -> [name, scope], declared or assigned, and wrapped in one
 * call (`realpathSync(...)`) or not.
 */
function scratchDirs(src: string): { name: string; scope: string }[] {
  return [...src.matchAll(/\b(\w+)\s*=\s*(?:\w+\(\s*)?mkdtempSync\(\s*join\(\s*(\w+)\(?\)?/g)].map(
    (m) => ({ name: m[1]!, scope: m[2]! })
  );
}

/** The scratch directories under `$TMPDIR` that `src` names in no `rmSync`. */
function leaksIn(src: string): string[] {
  return scratchDirs(src)
    // Nested under another scratch directory: cleaned with its parent, which this same scan checks.
    .filter(({ scope }) => scope === 'tmpdir')
    .filter(({ name }) => !new RegExp(`rmSync\\(\\s*${name}\\b`).test(src))
    .map(({ name }) => name);
}

describe('no test suite leaves a scratch directory in $TMPDIR', () => {
  // A guard that cannot see its subject passes vacuously, so pin that the scan finds the suites it
  // is meant to be scanning: each of these creates a scratch directory.
  test('the scan sees the suites that create scratch directories', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(30);
    for (const f of [
      'cli/test/audit.test.ts',
      'cli/test/cli.test.ts',
      'cli/test/digest.test.ts',
      'cli/test/regressions.test.ts',
      'adapters/hook/test/hook.test.ts',
      'cli/test/harnessNonce.test.ts',
      'surface/harness/probe.test.ts',
    ]) {
      expect(FILES).toContain(f);
      expect(scratchDirs(readFileSync(join(ROOT, f), 'utf8')).length).toBeGreaterThan(0);
    }
  });

  test('every mkdtemp directory is either removed or nested inside one that is', () => {
    const leaks = FILES.flatMap((f) => leaksIn(readFileSync(join(ROOT, f), 'utf8')).map((name) => `${f}: ${name}`));
    expect(
      leaks,
      'these suites create a directory under $TMPDIR and never remove it; add ' +
        'afterAll(() => rmSync(<dir>, { recursive: true, force: true }))'
    ).toEqual([]);
  });

  test('the scan flags a directory nobody removes, and only that one', () => {
    // Spelled so this file's own source does not match the scan.
    const mk = 'mkdtemp' + 'Sync';
    const src = [
      `const kept = ${mk}(join(tmpdir(), 'a-'));`,
      `const removed = ${mk}(join(tmpdir(), 'b-'));`,
      `const nested = ${mk}(join(removed, 'c-'));`,
      'afterAll(() => rmSync(removed, { recursive: true, force: true }));',
      `const real = realpathSync(${mk}(join(tmpdir(), 'd-')));`,
      'let assigned;',
      `assigned = ${mk}(join(tmpdir(), 'e-'));`,
    ].join('\n');
    expect(leaksIn(src)).toEqual(['kept', 'real', 'assigned']);
  });
});
