/**
 * Was the review window built from the source beside it?
 *
 * The window runs its own bundled `core` out of `surface/dist/`, which a pull does not rebuild, and
 * `PROTOCOL_VERSION` catches only a wire change. So a stale bundle is silent: for Slack, Linear and
 * GitHub the window builds the body that is sent, and for Jira the reviewer reads the old
 * converter's preview. This module asks; `cli/src/buildSurface.ts` builds, and `window.ts` refuses
 * or rebuilds.
 *
 * `surface/dist/build-stamp.json` hashes every input the build read: every module in Vite's graph,
 * every emitted asset's source (the fonts), the config and what Vite says it imported, the lockfile
 * (toolchain versions no graph sees) and the build script. No hand-kept list: an unlisted input could
 * change while the check says fresh. A new source file is caught through its importer's hash; the
 * one blind spot is a file that changes how an unchanged specifier resolves (a new `foo.ts` beside
 * the `foo/index.ts` that `./foo` meant). The stamp is written last, so a build that died halfway
 * reads as stale.
 *
 * | Install | Toolchain | On a stamp mismatch |
 * |---|---|---|
 * | dev checkout | Vite config + `vite` in `node_modules` | expected stamp computed from source; rebuild |
 * | release (`stable`) | none: ships `surface/dist/` and its stamp | `foreign`: update or reinstall |
 * | plugin tree | none, and no `bun.lock` (Claude Code installs what a plugin's lockfile names) | `foreign` |
 *
 * With no toolchain the check re-hashes every recorded file except the packages. `bun.lock` pins
 * those and is itself checked where present; where absent, the packages are not re-checked, since
 * such an install never builds or runs them. The stamp is read at runtime, not baked in by a
 * bundler, which a CLI run from source (the release route) would lack.
 *
 * Node APIs only: this runs in the CLI. The rebuild's lock is `buildSurface.ts`'s.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isPlainObject } from '../json';
import { pluginManifest } from '../claudePlugin';
import { REMEDY } from '../../../core/src/remedies';

/** Everything a checkout's window build is made of, derived from one root. */
export interface SurfaceLayout {
  root: string;
  /** The Vite config. Its presence is half of "this is a dev checkout". */
  viteConfig: string;
  /** `vite`'s own package manifest: the other half. */
  vitePackage: string;
  distDir: string;
  builtRenderer: string;
  stampFile: string;
  /** The build lock, beside `dist/` rather than in it: Vite empties `dist/` on every build. */
  lockFile: string;
}

export const STAMP_BASENAME = 'build-stamp.json';

/** `distDir` defaults to `surface/dist`; only a test builds anywhere else. */
export function surfaceLayout(root: string, distDir = join(root, 'surface', 'dist')): SurfaceLayout {
  return {
    root,
    viteConfig: join(root, 'surface', 'vite.config.mts'),
    vitePackage: join(root, 'node_modules', 'vite', 'package.json'),
    distDir,
    builtRenderer: join(distDir, 'index.html'),
    stampFile: join(distDir, STAMP_BASENAME),
    lockFile: join(root, 'surface', '.build.lock'),
  };
}

export interface BuildStamp {
  version: 1;
  /** The hash over `inputs`: one value for the whole set, so a hand-edited record does not add up. */
  stamp: string;
  /** Input path (relative to the root where it lives under it) -> sha256 of its bytes. */
  inputs: Record<string, string>;
}

export const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** One value for the whole input set: order-independent, and a renamed file changes it. */
export function stampOf(inputs: Record<string, string>): string {
  const lines = Object.keys(inputs)
    .sort()
    .map((path) => `${path}\0${inputs[path]}\n`);
  return sha256(lines.join(''));
}

/** Where an input's path is stored: relative under the root (so a moved checkout still matches). */
export function inputKey(root: string, file: string): string {
  const rel = relative(root, file);
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel.split(sep).join('/');
}

export const inputPath = (root: string, key: string) =>
  isAbsolute(key) ? key : resolve(root, key);

/**
 * A file's hash as it is on disk now, or null when it cannot be read. The one spelling, used by the
 * build that writes the stamp and the check that reads it, so the two cannot hash differently.
 */
export function hashFile(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** The stamp in `dist/`, or null when it is absent or not one this build writes. */
export function readStamp(stampFile: string): BuildStamp | null {
  let text: string;
  try {
    text = readFileSync(stampFile, 'utf8');
  } catch {
    return null;
  }
  return parseStamp(text);
}

/** A stamp's text as `readStamp` reads it, for one read out of git rather than off disk. */
export function parseStamp(text: string): BuildStamp | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw) || raw.version !== 1 || typeof raw.stamp !== 'string') return null;
  const inputs = raw.inputs;
  if (!isPlainObject(inputs)) return null;
  if (!Object.values(inputs).every((h) => typeof h === 'string')) return null;
  return { version: 1, stamp: raw.stamp, inputs: inputs as Record<string, string> };
}

export type BundleState =
  /** Built from exactly the source this checkout has. */
  | { state: 'fresh' }
  /** A dev checkout whose bundle does not match its source: rebuild it. */
  | { state: 'stale'; why: string }
  /** No toolchain, and the bundle was not built from this checkout's source: update or reinstall. */
  | { state: 'foreign'; why: string }
  /** No toolchain, and no bundle at all. */
  | { state: 'absent' };

/**
 * Can this checkout rebuild its own window?
 *
 * The Vite config (the source) and `vite` in `node_modules` (the toolchain), plus bun to run the
 * build script under.
 */
export function hasToolchain(layout: SurfaceLayout): boolean {
  return (
    typeof process.versions.bun === 'string' &&
    existsSync(layout.viteConfig) &&
    existsSync(layout.vitePackage)
  );
}

/** The lockfile, which pins every package an install without `node_modules` cannot re-hash. */
const LOCKFILE = 'bun.lock';

/**
 * An input that is the toolchain rather than the window's source: a package, or the lockfile that
 * pins them. A dev checkout re-hashes these too; an install with no toolchain has no packages, and
 * the plugin tree has no lockfile either.
 */
export const isToolchainInput = (key: string) => key === LOCKFILE || key.startsWith('node_modules/');

/** `N changed` phrasing for the first of a list, one line. */
function firstOf(keys: string[], what: string): string {
  const more = keys.length > 1 ? ` and ${keys.length - 1} more` : '';
  return `${keys[0]}${more} ${what}`;
}

/**
 * The question `window.ts` asks before a window is spawned, and every report of the window asks. `toolchain` is
 * whether this checkout can rebuild its own window (`hasToolchain`), which decides what the stamp
 * is compared against.
 */
export function bundleState(layout: SurfaceLayout, toolchain = hasToolchain(layout)): BundleState {
  const built = existsSync(layout.builtRenderer);
  const stamp = readStamp(layout.stampFile);

  if (toolchain) {
    if (!built) return { state: 'stale', why: 'it has not been built' };
    if (!stamp) return { state: 'stale', why: 'it carries no build stamp' };
    const changed = Object.keys(stamp.inputs).filter(
      (k) => hashFile(inputPath(layout.root, k)) !== stamp.inputs[k]
    );
    if (changed.length === 0) return { state: 'fresh' };
    return { state: 'stale', why: firstOf(changed, 'changed since it was built') };
  }

  // No toolchain: the stamp the window was shipped with, against what this checkout has.
  if (!built) return { state: 'absent' };
  if (!stamp) return { state: 'foreign', why: 'it carries no build stamp' };
  // Not a defence against a forger, who could recompute it: the release commits this file, so a
  // record merged or edited by hand would no longer be the list of what the build read.
  if (stampOf(stamp.inputs) !== stamp.stamp) return { state: 'foreign', why: 'its build stamp does not add up' };
  const sources = Object.keys(stamp.inputs).filter((k) => !isToolchainInput(k));
  // A build reads the window's source, so a stamp with none vouches for nothing.
  if (sources.length === 0) return { state: 'foreign', why: 'its build stamp records no source' };
  // A tree with the lockfile checks it, so skipping the packages is never skipping them unchecked.
  const locked = existsSync(inputPath(layout.root, LOCKFILE));
  if (locked && !(LOCKFILE in stamp.inputs)) return { state: 'foreign', why: `its build stamp records no ${LOCKFILE}` };
  const checked = locked ? [...sources, LOCKFILE] : sources;
  // An input outside the checkout (`inputKey` keeps those absolute) is one no install of this
  // release can have, so the build cannot be vouched for anywhere but the machine that made it.
  // Refused by name, not skipped: skipping would check less than the stamp says.
  const outside = checked.filter((k) => isAbsolute(k));
  if (outside.length > 0) {
    return { state: 'foreign', why: firstOf(outside, 'is outside the checkout, so its build stamp cannot be checked here') };
  }
  const differs = checked.filter((k) => hashFile(inputPath(layout.root, k)) !== stamp.inputs[k]);
  if (differs.length === 0) return { state: 'fresh' };
  return { state: 'foreign', why: firstOf(differs, 'is not what it was built from') };
}

/** A state as one phrase: `foreign, bun.lock is not what it was built from`. */
export const describeState = (state: BundleState): string => `${state.state}${'why' in state ? `, ${state.why}` : ''}`;

/** Every file under `dir`, relative to it, with its hash: what "the same window" means. */
export function windowManifest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p), hashFile(p) ?? '');
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
  return out;
}

/** How two manifests differ, as one phrase naming the first path, or null when they are the same. */
export function manifestDiff(want: Map<string, string>, have: Map<string, string>): string | null {
  const paths = [...new Set([...want.keys(), ...have.keys()])].sort();
  const differs = paths.filter((p) => want.get(p) !== have.get(p));
  if (differs.length === 0) return null;
  const more = differs.length > 1 ? ` and ${differs.length - 1} more` : '';
  return `${differs[0]}${more}`;
}

/**
 * Why a tree that ships a window would not run the one that was built, or null: its window must be
 * `built`, byte for byte, and accepted with no toolchain, as a user's copy checks it. The one
 * read-back for `release` and `build:plugin`, which must not disagree about what ships.
 */
export function shippedWindowProblem(root: string, built: Map<string, string>): string | null {
  const layout = surfaceLayout(root);
  const differs = manifestDiff(built, windowManifest(layout.distDir));
  if (differs !== null) return `its window is not the one built (${differs} differs)`;
  const state = bundleState(layout, false);
  return state.state === 'fresh' ? null : `it would refuse its window (${describeState(state)})`;
}

/**
 * What to tell a person about a bundle with no toolchain to repair it, or null when there is nothing
 * to say. One wording for the review's `unavailable` reason and `--doctor`. A
 * window in a plugin's version folder (`root` holds the plugin's manifest) is Claude Code's install,
 * which nothing of draftgate's rewrites; the manifest is read only when there is something to say.
 */
export function bundleRemedy(state: BundleState, root?: string): string | null {
  const plugin = () => root !== undefined && pluginManifest(root) !== null;
  if ((state.state === 'absent' || state.state === 'foreign') && plugin()) {
    const what =
      state.state === 'absent'
        ? 'This copy of the draftgate plugin has no review window'
        : `The review window in this copy of the draftgate plugin was built for a different version (${state.why})`;
    return `${what}. Install the plugin again (${REMEDY.pluginManager}), then run ${REMEDY.reloadPlugins}.`;
  }
  switch (state.state) {
    case 'absent':
      // A contributor's clone before `bun install`: an install of `stable` ships the window built.
      return (
        'The review window has not been built, and this checkout has no toolchain to build it. ' +
        `Run ${REMEDY.installDependencies} in it, then ${REMEDY.rebuildWindow}.`
      );
    case 'foreign':
      // Never a rebuild: there is no toolchain, and a release install lives somewhere that must
      // not be written at runtime.
      return (
        `The review window was built for a different version of draftgate (${state.why}), and ` +
        `this checkout cannot rebuild it. Run ${REMEDY.installPlugin}.`
      );
    default:
      return null;
  }
}
