/**
 * `core` is pure (CLAUDE.md, "Map"): the review window imports it directly, so a `node:` import
 * breaks the window's bundle at load time.
 *
 * `core/tsconfig.json` (`types: []`, `lib: ["ES2022"]`) already makes `setTimeout`, `crypto`,
 * `fetch`, `process`, `Buffer` and `import.meta` compile errors. This file exists for the three it
 * cannot reach: `Date.now()`, a zero-argument `new Date()` and `Math.random` are legal ES2022. The
 * root config cannot stand in: `bun-types` declares every `node:` module (verified). `new Date(ms)`
 * is allowed. `core/src/adf/` is scanned, its `__tests__` are not.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const CORE = join(import.meta.dir, '..', 'src');
const ROOT = join(import.meta.dir, '..', '..');

/** Every shipped `.ts` under `core/src`, as repo-relative paths. Tests excluded. */
function shipped(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) shipped(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(relative(ROOT, p));
  }
  return out;
}

const FILES = shipped(CORE);

/** Strip line and block comments, so a rule named in prose is not a violation. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * `by` names the instrument holding each row: `compiler` (`core/tsconfig.json` refuses it too) or
 * `scan` (only this sees it). Nothing reads it.
 */
const FORBIDDEN: { name: string; re: RegExp; by: 'compiler' | 'scan' }[] = [
  { name: "a `node:` import", re: /from\s*['"]node:/, by: 'compiler' },
  { name: 'require()', re: /\brequire\s*\(/, by: 'compiler' },
  { name: 'process', re: /\bprocess\s*[.[]/, by: 'compiler' },
  { name: 'Buffer', re: /\bBuffer\s*[.(]/, by: 'compiler' },
  { name: '__dirname / __filename', re: /\b__(dirname|filename)\b/, by: 'compiler' },
  { name: 'import.meta', re: /\bimport\.meta\b/, by: 'compiler' },
  { name: 'the clock (Date.now)', re: /\bDate\.now\s*\(/, by: 'scan' },
  { name: 'the clock (new Date with no argument)', re: /new\s+Date\s*\(\s*\)/, by: 'scan' },
  { name: 'Math.random', re: /\bMath\.random\s*\(/, by: 'scan' },
  { name: 'crypto', re: /\bcrypto\s*[.[]/, by: 'compiler' },
  { name: 'the network', re: /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/, by: 'compiler' },
  {
    name: 'a timer',
    re: /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/,
    by: 'compiler',
  },
];

/** Every file read and comment-stripped once, not once per rule. */
const SOURCES: [string, string][] =
  FILES.map((f) => [f, code(readFileSync(join(ROOT, f), 'utf8'))]);

describe('core is pure, so the renderer can import it', () => {
  test('the scan sees the whole of core, the ADF converter included', () => {
    // A guard that cannot see its subject passes vacuously.
    expect(FILES.length).toBeGreaterThan(10);
    for (const f of [
      'core/src/render.ts',
      'core/src/editor.ts',
      'core/src/prosemirror.ts',
      'core/src/adfSchema.ts',
      'core/src/adf/markdownToAdf.ts',
      'core/src/adf/adfToMarkdown.ts',
      'core/src/profiles/jira.ts',
    ]) {
      expect(FILES).toContain(f);
    }
    // ...and not the converter's own tests, which are allowed everything.
    expect(FILES.some((f) => f.includes('__tests__'))).toBe(false);
  });

  for (const { name, re } of FORBIDDEN) {
    test(`no file uses ${name}`, () => {
      const hits = SOURCES.filter(([, src]) => re.test(src)).map(([f]) => f);
      expect(
        hits,
        `core must run unchanged in the review window's renderer, so it may not use ${name}`
      ).toEqual([]);
    });
  }

  test('the patterns themselves match what they are meant to match', () => {
    // A typo'd regex matches nothing and reports a clean core forever.
    const sample = `
      import { readFileSync } from 'node:fs';
      const x = require('fs');
      process.env.HOME; Buffer.from('a'); __dirname; import.meta.dir;
      Date.now(); new Date(); Math.random(); fetch('https://x');
      crypto.randomUUID(); setTimeout(f, 0); setInterval(f, 1);
      setImmediate(f); queueMicrotask(f);
    `;
    for (const { name, re } of FORBIDDEN) {
      expect(re.test(sample), `${name} pattern matched nothing in the sample`).toBe(true);
    }
    // And the one form that must NOT trip: converting a caller's value.
    expect(/new\s+Date\s*\(\s*\)/.test('new Date(ms).toISOString()')).toBe(false);
  });
});
