/**
 * What a user install runs imports no npm package.
 *
 * A plugin install has no `node_modules`: the plugin tree ships no lockfile, the window ships built,
 * and the host is compiled from Objective-C. So the CLI and the hook adapter -- the second runs on
 * every gated tool call -- may reach Node and bun built-ins and this repo's own files, and nothing
 * else.
 *
 * A failure would not be loud: bun auto-installs a package it cannot find when there is no
 * `node_modules` to look in. A file importing `is-odd`, run from such a directory, prints its answer,
 * having fetched `is-odd` and `is-number` from the registry (bun 1.4.0); with `--no-install` it fails
 * "Cannot find package". So a stray import would make every review fetch code, silently.
 *
 * `Bun.build` follows every import, dynamic ones with a literal specifier included, and resolves
 * built-ins before any plugin is asked, so a plugin recording every specifier sees exactly the
 * packages: `node:fs`, `child_process` and `bun:ffi` never reach it, `react` and `vite` do.
 */

import { describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import { CLASSIFIERS_IN_REPO, CLI_IN_REPO, HOOK_IN_REPO } from '../cli/src/hookModes';
import { isRuntimeFile } from '../cli/src/pluginTree';

const ROOT = join(import.meta.dir, '..');

type Graph = { ok: boolean; packages: string[]; files: string[] };
const graphs = new Map<string, Promise<Graph>>();

/** Every package specifier the graph from `entry` reaches, and every file in it; read once per entry. */
function graphOf(entry: string): Promise<Graph> {
  let graph = graphs.get(entry);
  if (graph === undefined) graphs.set(entry, (graph = readGraph(entry)));
  return graph;
}

async function readGraph(entry: string): Promise<Graph> {
  const packages = new Set<string>();
  const files = new Set<string>();
  const result = await Bun.build({
    entrypoints: [join(ROOT, entry)],
    target: 'bun',
    // Nothing is bundled from a package, so a package that is not installed cannot fail the build
    // and hide behind the failure: it is recorded and left external.
    packages: 'external',
    plugins: [
      {
        name: 'record',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind !== 'entry-point-build' && !/^[./]/.test(args.path)) packages.add(args.path);
            return undefined;
          });
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
            files.add(relative(ROOT, args.path));
            return undefined;
          });
        },
      },
    ],
  });
  return { ok: result.success, packages: [...packages].sort(), files: [...files].sort() };
}

describe('what a user install runs reaches no npm package', () => {
  /*
   * `cli/src/buildSurface.ts` is spawned by path (`surfaces/window.ts`), only in a checkout with the
   * Vite toolchain: it imports `vite` and is the control below. The hook's other modes are in its
   * own graph.
   */
  for (const entry of ['cli/src/main.ts', 'adapters/hook/src/main.ts']) {
    test(entry, async () => {
      const graph = await graphOf(entry);
      expect(graph.ok).toBe(true);
      expect(graph.packages).toEqual([]);
    });
  }

  test('the graph includes what uninstall and a review run, dynamic imports too, so it was not read short', async () => {
    const cli = await graphOf('cli/src/main.ts');
    for (const f of ['cli/src/uninstall.ts', 'cli/src/cliLink.ts', 'cli/src/reviewHost.ts', 'cli/src/surfaces/bundleStamp.ts']) {
      expect(cli.files).toContain(f);
    }
    const hook = await graphOf('adapters/hook/src/main.ts');
    // Both loaded with `await import(...)` from a mode, never at the top.
    expect(hook.files).toContain('adapters/hook/src/register.ts');
    expect(hook.files).toContain('cli/src/reviewHost.ts');
  });

  test('the recorder sees a package when there is one, so an empty list means none', async () => {
    const graph = await graphOf('cli/src/buildSurface.ts');
    expect(graph.packages).toContain('vite');
  });
});

describe('the plugin tree holds what a user install runs', () => {
  /*
   * A module the release leaves out of `plugin/` makes the hook die importing it: a fail-closed
   * `ask` on every gated send. The mapping is `isRuntimeFile` plus the window's stamp. The
   * classifiers are run by path from what `setup` and `doctor` print, so they are entry points too.
   */
  for (const entry of [CLI_IN_REPO, HOOK_IN_REPO, ...CLASSIFIERS_IN_REPO]) {
    test(entry, async () => {
      const graph = await graphOf(entry);
      expect(graph.ok).toBe(true);
      expect(graph.files.length).toBeGreaterThan(2);
      expect(graph.files.filter((f) => !isRuntimeFile(f))).toEqual([]);
    });
  }

  test('and the guard can fail: a test file is not runtime', async () => {
    const graph = await graphOf('cli/test/pluginTree.test.ts');
    expect(graph.files.filter((f) => !isRuntimeFile(f))).toContain('cli/test/pluginTree.test.ts');
  });
});
