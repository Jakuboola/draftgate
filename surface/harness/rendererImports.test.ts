/**
 * What the renderer bundle may reach: `core` in full, and from `cli` only
 * `cli/src/surfaces/windowProtocol.ts`, the wire contract.
 *
 * `surface/tsconfig.json`'s `include` enforces nothing, and typing does not either: `bun-types`
 * declares every `node:` module, so a `surface/src` file importing `cli/src/audit` typechecks clean
 * and pulls `node:fs` into a browser bundle.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SURFACE } from './shared';

const SRC = join(SURFACE, 'src');

/** The one `cli` module the renderer may see. */
const ALLOWED_CLI = 'cli/src/surfaces/windowProtocol';

/** Every renderer source file, as paths relative to `surface/`. */
function rendererFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rendererFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(relative(SURFACE, p));
  }
  return out;
}

const FILES = rendererFiles(SRC);

/** Every module specifier a file imports: `import ... from`, `export ... from`, `import 'x'` and `import('x')`. */
function specifiers(src: string): string[] {
  return [
    ...src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]!);
}

describe('the renderer bundle reaches only core and the wire contract', () => {
  test('the scan sees the renderer', () => {
    // A guard that cannot see its subject passes vacuously.
    expect(FILES.length).toBeGreaterThan(5);
    expect(FILES).toContain('src/App.tsx');
    expect(FILES).toContain('src/bridge.ts');
    expect(FILES).toContain('src/Editor.tsx');
    // Each import form the scan reads, seen where the renderer uses it.
    const of = (f: string) => specifiers(readFileSync(join(SURFACE, f), 'utf8'));
    expect(of('src/EmojiPicker.tsx')).toContain('unicode-emoji-json/data-by-group.json');
    expect(of('src/styles/index.ts')).toContain('./fonts.css');
  });

  test('no renderer file imports a `node:` builtin', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const spec of specifiers(readFileSync(join(SURFACE, f), 'utf8'))) {
        if (spec.startsWith('node:')) bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad, 'the renderer runs in a browser; a `node:` import breaks the bundle at load').toEqual([]);
  });

  test('the only `cli` module it may import is the wire contract', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const spec of specifiers(readFileSync(join(SURFACE, f), 'utf8'))) {
        if (!spec.includes('cli/')) continue;
        if (spec.endsWith(ALLOWED_CLI) || spec.endsWith(`${ALLOWED_CLI}.ts`)) continue;
        bad.push(`${f}: ${spec}`);
      }
    }
    expect(
      bad,
      'the renderer may reach `cli` only through windowProtocol.ts -- anything else pulls I/O ' +
        'and `node:` modules into a browser bundle, and typechecks clean while doing it'
    ).toEqual([]);
  });

  test('and it DOES reach that one, so the rule is not vacuous', () => {
    const bridge = readFileSync(join(SURFACE, 'src', 'bridge.ts'), 'utf8');
    expect(specifiers(bridge).some((sp) => sp.endsWith(ALLOWED_CLI))).toBe(true);
  });
});
