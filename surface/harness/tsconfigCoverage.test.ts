/**
 * Every TypeScript file under `surface/` is typechecked by exactly one config: `harness/` by the
 * root tsconfig (node), the rest by `surface/tsconfig.json` (DOM). `include` cannot say "everything
 * except `harness/`", so the globs are hand-kept and each way of keeping them leaves a hole (a
 * `surface/zz/scratch.ts` with a type error passes `bun run typecheck` under `surface/*.ts`). A file
 * in neither is invisible to `bun test` too, which erases `type` imports.
 *
 * `--listFilesOnly` asks the compiler what each config resolves rather than re-implementing its glob
 * matching, and skips type checking: both configs cost ~0.7s.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './shared';

const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');
const SURFACE = join(ROOT, 'surface');

/** Which files a config resolves, as repo-relative paths, restricted to `surface/`. */
function filesFor(args: string[]): Set<string> {
  const run = spawnSync(TSC, [...args, '--listFilesOnly', '--noEmit'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(run.error, `tsc ${args.join(' ')} failed to run`).toBeUndefined();
  return new Set(
    run.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(SURFACE + '/') && !l.includes('/node_modules/'))
      .map((l) => relative(ROOT, l))
  );
}

/** Every `.ts`/`.tsx` under `surface/`, walked rather than globbed. `dist/` is build output. */
function surfaceSources(dir = SURFACE): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'probe-result' || entry.name === 'node_modules') continue;
      out.push(...surfaceSources(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(relative(ROOT, full));
    }
  }
  return out;
}

describe('the surface type-flavour split', () => {
  const root = filesFor([]);
  const surface = filesFor(['-p', 'surface']);
  const sources = surfaceSources();

  test('there are files to check, so this cannot pass vacuously', () => {
    expect(sources.length).toBeGreaterThanOrEqual(12);
  });

  test('every file is covered by exactly one config', () => {
    const uncovered = sources.filter((f) => !root.has(f) && !surface.has(f));
    const both = sources.filter((f) => root.has(f) && surface.has(f));

    expect(
      uncovered,
      'these are typechecked by NOTHING. `bun test` will not catch a type error in them (it ' +
        'erases type imports) and neither will `bun run typecheck`. Add the directory to the right ' +
        "config's include: `surface/harness/` is node-typed and belongs to the ROOT tsconfig, " +
        'everything else under `surface/` is DOM-typed and belongs to `surface/tsconfig.json`.'
    ).toEqual([]);

    expect(
      both,
      'these are typechecked TWICE, under contradictory lib settings -- one of the two results is ' +
        'meaningless and it is not obvious which. Narrow one config.'
    ).toEqual([]);
  });

  test('and the split is by DIRECTORY, which is what makes it predictable', () => {
    // By the config its location implies: a harness file in the DOM config would typecheck
    // against `lib.dom`.
    for (const f of sources) {
      const isHarness = f.startsWith('surface/harness/');
      expect(root.has(f), `${f}: expected the ROOT config to own it = ${isHarness}`).toBe(isHarness);
      expect(surface.has(f), `${f}: expected the SURFACE config to own it = ${!isHarness}`).toBe(!isHarness);
    }
  });
});
