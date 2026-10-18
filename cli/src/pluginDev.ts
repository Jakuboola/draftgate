#!/usr/bin/env bun
/**
 * Assemble the plugin tree out of this checkout, for a contributor:
 *
 *   bun run build:plugin [--out <dir>]
 *
 * `build:plugin` builds the window first, then runs this. It writes the tree a release puts on
 * `stable` (`pluginTree.ts`, the one mapping) into `<dir>/plugin`, from the files on disk: every
 * tracked file and every new one git does not ignore, so an edit not yet committed is in it. Beside
 * it, `<dir>/.claude-plugin/marketplace.json` is the repository's marketplace with the plugin's
 * source pointed at `./plugin`. `<dir>` is `dist/marketplace` unless `--out` names another, and is
 * replaced on every run; one that holds anything but a previous assembly is refused.
 *
 * Then either of:
 *
 *   claude --plugin-dir <dir>/plugin
 *   claude plugin marketplace add <dir>    then    claude plugin install draftgate@draftgate
 *
 * Both run the tree in place (a directory marketplace is read where it is), so rerunning this and
 * `/reload-plugins` picks up a change. The copy is read back before it replaces the last one: its
 * window is the one built, byte for byte, and is accepted with no toolchain, as a user's cache copy
 * checks it. `build:plugin` builds into `surface/dist` like the verifiers do, so it runs one at a
 * time with them (`.claude/CLAUDE.md`, "Verifiers"); a build that lands mid-copy is caught here.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REMEDY, typed } from '../../core/src/remedies';
import { PLUGIN_ID } from './claudePlugin';
import { CHECKOUT } from './releaseCheck';
import { MARKETPLACE_MANIFEST, PLUGIN_DIR, PLUGIN_MANIFEST, WINDOW_DIR, localMarketplace, pluginTree } from './pluginTree';
import { writeStdout } from './stdout';
import { bundleState, describeState, manifestDiff, readStamp, shippedWindowProblem, surfaceLayout, windowManifest } from './surfaces/bundleStamp';

/** Where the tree goes when `--out` names nothing else: under `dist/`, which git ignores. */
const DEFAULT_OUT = join('dist', 'marketplace');

/** Does `out` hold nothing, or only what a previous run wrote? */
function replaceable(out: string): boolean {
  const st = statSync(out, { throwIfNoEntry: false });
  if (st === undefined) return true;
  if (!st.isDirectory()) return false;
  const names = readdirSync(out).sort();
  if (names.length === 0) return true;
  return names.join('\n') === `.claude-plugin\n${PLUGIN_DIR}` && existsSync(join(out, PLUGIN_MANIFEST));
}

/**
 * Write the plugin tree of `root` into `out`. Answers the lines to print, or throws an Error saying
 * why. It is written beside `out` and renamed into place once read back, so a failed run leaves
 * `out` as it was.
 */
export function assemblePlugin(root: string, out: string): string[] {
  const layout = surfaceLayout(root);
  const state = bundleState(layout, true);
  if (state.state !== 'fresh') throw new Error(`the window is not built from this checkout (${describeState(state)}): run ${REMEDY.rebuildWindow}`);
  const stamp = readStamp(layout.stampFile)!;
  const window = windowManifest(layout.distDir);
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.error?.message ?? listed.stderr.trim()}`);
  const files = [
    // A file deleted and not yet committed is still listed; it is not in the tree.
    ...listed.stdout.split('\0').filter((p) => p !== '' && existsSync(join(root, p))),
    ...[...window.keys()].map((p) => `${WINDOW_DIR}/${p}`),
  ];
  const tree = pluginTree(files, stamp);
  if ('error' in tree) throw new Error(`the plugin tree cannot be assembled: ${tree.error}`);
  if (!replaceable(out)) throw new Error(`${out} holds something other than a plugin tree this wrote: name another with --out`);

  const next = `${out}.assembling-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  try {
    for (const [at, from] of tree) {
      const dest = join(next, at);
      mkdirSync(dirname(dest), { recursive: true });
      // The mode comes along: `bin/draftgate` stays executable.
      copyFileSync(join(root, from), dest);
    }
    const marketplace = localMarketplace(JSON.parse(readFileSync(join(root, MARKETPLACE_MANIFEST), 'utf8')));
    mkdirSync(join(next, dirname(MARKETPLACE_MANIFEST)), { recursive: true });
    writeFileSync(join(next, MARKETPLACE_MANIFEST), `${JSON.stringify(marketplace, null, 2)}\n`);

    // Read back, as a user's cache copy is checked: a build landing mid-copy tears the window and
    // leaves every source as it was, so the stamp alone cannot see it.
    const moved = manifestDiff(window, windowManifest(layout.distDir));
    if (moved !== null) throw new Error(`${WINDOW_DIR} changed while it was copied (${moved}; something built meanwhile): run this again`);
    const problem = shippedWindowProblem(join(next, PLUGIN_DIR), window);
    if (problem !== null) throw new Error(`the copy would not run the window built here: ${problem}`);
    rmSync(out, { recursive: true, force: true });
    renameSync(next, out);
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
  const plugin = join(out, PLUGIN_DIR);
  return [
    `draftgate: assembled the plugin in ${plugin} (${tree.size} files, the window from ${WINDOW_DIR}).`,
    'Run it with either of:',
    `  claude --plugin-dir ${plugin}`,
    `  claude plugin marketplace add ${out}    then    claude plugin install ${PLUGIN_ID}`,
  ];
}

/** `[--out <dir>]`, or why it is not that. */
export function parseOut(argv: string[], root: string): string | { error: string } {
  if (argv.length === 0) return join(root, DEFAULT_OUT);
  if (argv.length === 2 && argv[0] === '--out' && argv[1] !== '') return resolve(argv[1]!);
  return { error: `usage: ${typed(REMEDY.buildPlugin)} [--out <dir>]` };
}

if (import.meta.main) {
  const out = parseOut(process.argv.slice(2), CHECKOUT);
  let lines: string[];
  try {
    if (typeof out !== 'string') throw new Error(out.error);
    lines = assemblePlugin(CHECKOUT, out);
  } catch (e) {
    process.stderr.write(`draftgate: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  await writeStdout(`${lines.join('\n')}\n`);
  process.exit(0);
}
