/**
 * The bundle ships woff2 and nothing else: the host's scheme handler maps `.woff2` and no `.woff`
 * (`draftgate.m`).
 *
 * The first describe needs no build: every face lives in `fonts.css` with a single woff2 `src`, so a
 * package font sheet (every `@fontsource` one lists a `.woff` fallback) fails here.
 * `cli/test/surfaceBundle.test.ts`'s real build asserts no `.woff` was read. The second checks what
 * was emitted, and only when a bundle exists: `bun test` builds nothing, and says so.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bundledFaces, SURFACE } from './shared';

const DIST = join(SURFACE, 'dist', 'assets');

describe('every face is declared in fonts.css, woff2 only', () => {
  // The one reading of every bundled face, shared with `tokens.test.ts`. It includes any package
  // stylesheet `main.tsx` imports, whose faces then name that package's sheet and fail here.
  const FACES = bundledFaces();

  test('no sheet but fonts.css declares an @font-face -- no package sheet either', () => {
    expect(FACES.length).toBeGreaterThan(0);
    expect(FACES.filter((f) => basename(f.sheet) !== 'fonts.css').map((f) => f.sheet)).toEqual([]);
  });

  test('every face has one src, and it is woff2', () => {
    for (const face of FACES) {
      expect(face.urls.length, face.family).toBe(1);
      expect(face.urls[0], face.family).toMatch(/\.woff2(\?|$)/);
    }
  });
});

describe('the review window bundles woff2 only', () => {
  test('nothing emitted into surface/dist is a .woff', () => {
    if (!existsSync(DIST)) {
      // Not a silent skip: say why this run proved nothing. `bun run build:surface` first.
      console.log('        (no surface/dist -- run `bun run build:surface` to check the bundle)');
      return;
    }
    const assets = readdirSync(DIST);
    expect(assets.filter((f) => f.endsWith('.woff'))).toEqual([]);
    // Vacuity control: an empty assets directory would satisfy the line above.
    expect(assets.filter((f) => f.endsWith('.woff2')).length).toBeGreaterThan(0);
  });

  test('every @font-face in the built stylesheet names woff2 and only woff2', () => {
    if (!existsSync(DIST)) return;
    const sheet = readdirSync(DIST).find((f) => f.endsWith('.css'));
    expect(sheet).toBeDefined();
    const css = readFileSync(join(DIST, sheet!), 'utf8');
    const faces = css.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toContain('woff2');
      // `format("woff")` with no `2`. The fallback's own signature.
      expect(face).not.toMatch(/format\((['"])woff\1\)/);
    }
  });
});
