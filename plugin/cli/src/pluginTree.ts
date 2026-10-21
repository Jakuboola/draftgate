/**
 * The plugin tree: what Claude Code installs as draftgate (installer.md, "The release").
 *
 * `main`'s `plugin/` holds only the plugin's own files (the manifest, `hooks/hooks.json`, `bin/`,
 * `skills/`). Their commands name the runtime relative to the plugin root
 * (`${CLAUDE_PLUGIN_ROOT}/adapters/hook/src/main.ts`, `$root/cli/src/main.ts`), so the tree mirrors
 * the repository's paths under `plugin/`:
 *
 *  - every file under `plugin/` as it is;
 *  - the runtime (`isRuntimeFile`) at `plugin/<its path>`;
 *  - every source the window's build stamp records, at `plugin/<its path>`, so a tree with no
 *    toolchain can check its window (`bundleState`) from the stamp itself, not a list kept beside it;
 *  - the built window, `surface/dist/`, at `plugin/surface/dist/`.
 *
 * Left out: `bun.lock` above all, since Claude Code installs every package a plugin's lockfile names
 * into its cache copy, which here is every devDependency (173 MB against 6.7 MB, measured). Also the
 * tests, the harness, the dev tools (except the two classifiers the runtime names) and the docs.
 *
 * `release` builds this tree out of git blobs (`release.ts`) and `build:plugin` copies it out of a
 * checkout (`pluginDev.ts`), through this one mapping.
 */

import { isAbsolute } from 'node:path';
import { CLASSIFIERS_IN_REPO } from './hookModes';
import { isPlainObject } from './json';
import { MARKETPLACE_MANIFEST, PLUGIN_MANIFEST_IN_ROOT } from './claudePlugin';
import { versionTag } from './releaseCheck';
import { isToolchainInput, type BuildStamp } from './surfaces/bundleStamp';

/** Where the plugin lives in the repository, and the plugin root on `stable`. */
export const PLUGIN_DIR = 'plugin';
/** The plugin's manifest, whose `version` is the release's. */
export const PLUGIN_MANIFEST = `${PLUGIN_DIR}/${PLUGIN_MANIFEST_IN_ROOT}`;
/** The marketplace's manifest, at the repository root. */
export { MARKETPLACE_MANIFEST };
/** The built window, relative to a root. */
export const WINDOW_DIR = 'surface/dist';
/**
 * The lockfiles that make Claude Code install a plugin's packages into its cache copy, when one sits
 * at the plugin root beside a `package.json` (its plugin loading reference, "Node.js package
 * dependencies"). The plugin tree must hold none.
 */
const PLUGIN_LOCKFILES = ['bun.lock', 'npm-shrinkwrap.json', 'package-lock.json'];

/** The directories a review runs from: the CLI, the hook, the converter and the window's host. */
const RUNTIME_DIRS = ['cli/src/', 'adapters/hook/src/', 'core/src/', 'surface/'];
/**
 * Single files the runtime reads (`package.json`: the host's version, `checkoutKind`), and the
 * classifiers its messages tell a person to run by their path under the root.
 */
const RUNTIME_FILES = ['package.json', 'LICENSE', ...CLASSIFIERS_IN_REPO];
/** Inside those, what verifies the window rather than runs it. */
const NOT_RUNTIME = [/^surface\/harness\//, /\.test\.tsx?$/];

/**
 * The release a `plugin.json`'s text names, as its tag (`vX.Y.Z`), or why it names none. Strict
 * `X.Y.Z`: a release's version is its tag's, and a tag is only ever that (`isReleaseTag`).
 */
export function pluginVersion(text: string): { tag: string } | { error: string } {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { error: `${PLUGIN_MANIFEST} is not JSON` };
  }
  const version = isPlainObject(manifest) ? manifest.version : undefined;
  if (typeof version !== 'string') return { error: `${PLUGIN_MANIFEST} has no "version"` };
  const tag = versionTag(version);
  if (tag === null) return { error: `${PLUGIN_MANIFEST}'s version "${version}" is not X.Y.Z, three numbers with no leading zeros` };
  return { tag };
}

/** Is this repository path part of what a review runs? */
export function isRuntimeFile(path: string): boolean {
  if (RUNTIME_FILES.includes(path)) return true;
  if (!RUNTIME_DIRS.some((d) => path.startsWith(d))) return false;
  if (path.startsWith(`${WINDOW_DIR}/`)) return false;
  return !NOT_RUNTIME.some((re) => re.test(path));
}

/**
 * The plugin tree, as `plugin/...` path -> the repository path its bytes come from. `files` is every
 * path the source tree holds, the window's included; `stamp` is the window's build stamp. Answers
 * why it cannot be assembled instead, naming the first path: a tree with no plugin manifest, a
 * lockfile among the plugin's own files, a stamp input the tree does not hold (the window was built
 * from a file that would not ship), or one of the plugin's own files where the runtime puts one.
 */
export function pluginTree(files: readonly string[], stamp: BuildStamp): Map<string, string> | { error: string } {
  const have = new Set(files);
  if (!have.has(PLUGIN_MANIFEST)) return { error: `there is no ${PLUGIN_MANIFEST}` };
  const tree = new Map<string, string>();
  const own = files.filter((p) => p.startsWith(`${PLUGIN_DIR}/`));
  const lockfile = own.find((p) => PLUGIN_LOCKFILES.some((f) => p === `${PLUGIN_DIR}/${f}`));
  if (lockfile !== undefined) return { error: `${lockfile} is a lockfile, so Claude Code would install its packages into every user's copy` };
  for (const p of own) tree.set(p, p);

  const sources = Object.keys(stamp.inputs).filter((k) => !isToolchainInput(k));
  const missing = sources.find((k) => isAbsolute(k) || !have.has(k));
  if (missing !== undefined) return { error: `the window was built from ${missing}, which this tree does not hold` };
  const window = files.filter((p) => p.startsWith(`${WINDOW_DIR}/`));
  if (window.length === 0) return { error: `there is no built window in ${WINDOW_DIR}` };

  const runtime = new Set([...files.filter(isRuntimeFile), ...sources, ...window]);
  for (const p of [...runtime].sort()) {
    const at = `${PLUGIN_DIR}/${p}`;
    if (tree.has(at)) return { error: `${at} is one of the plugin's own files and also where ${p} goes` };
    tree.set(at, p);
  }
  return tree;
}

/**
 * The marketplace manifest for a local directory holding the tree at `./plugin`: the repository's
 * own, with each plugin's source pointed there. The repository's names `stable` on GitHub
 * (`git-subdir`), which a directory beside the tree must not fetch.
 */
export function localMarketplace(manifest: unknown): unknown {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.plugins) || !manifest.plugins.every(isPlainObject)) {
    throw new Error(`${MARKETPLACE_MANIFEST} has no plugins list`);
  }
  return { ...manifest, plugins: manifest.plugins.map((p) => ({ ...p, source: `./${PLUGIN_DIR}` })) };
}
