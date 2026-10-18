#!/usr/bin/env bun
/**
 * Build the review window, under this checkout's lock, and stamp it.
 *
 *   bun cli/src/buildSurface.ts [--if-stale] [--root <checkout>] [--out-dir <dir>]
 *
 * `bun run build:surface` is this with no flags, and the first step of `surface:probe` and
 * `surface:e2e`. The CLI runs it with `--if-stale` as a subprocess before spawning a window whose
 * bundle no longer matches its source, so the review deadline can SIGKILL it and the one `bun:ffi`
 * import stays out of the CLI.
 *
 * Every build of a checkout takes `surface/.build.lock` exclusively with `flock(2)`: two reviews can
 * find one stale bundle at once (duplicate hook registrations fire concurrently), and a build landing
 * while a window loads tears its bundle. A kernel lock, not a pid file, because the kernel releases
 * it when a SIGKILLed build dies. Per checkout: a sibling worktree has its own `surface/dist/` and
 * lock. `--if-stale` re-asks inside the lock, so the second of two reviews waits and finds nothing
 * to build.
 *
 * The stamp (`surfaces/bundleStamp.ts`) hashes each module when Vite loads it, so a file edited
 * mid-build is recorded as the version bundled and the next check rebuilds. It is written after the
 * bundle and renamed into place. The notices (`surfaces/thirdPartyNotices.ts`) are written from the
 * same inputs, after the bundle and before the stamp, and every licence file they read is an input.
 *
 * Everything this says goes to stderr; the CLI does not forward this child's stdout in any case.
 */

import { dlopen, FFIType } from 'bun:ffi';
import {
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import {
  bundleState,
  hashFile,
  inputKey,
  stampOf,
  surfaceLayout,
  type BuildStamp,
  type SurfaceLayout,
} from './surfaces/bundleStamp';
import { repoNotice, writeNotices, type EmittedAsset } from './surfaces/thirdPartyNotices';

/** Repo root, from `cli/src/`. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/**
 * The lockfile, the one input no module graph can see: it pins Vite, the React plugin and every
 * other tool that shapes the output without being bundled. A literal because it names the
 * toolchain's record, not a source file -- and a pull that changes it costs one ~1s build.
 */
const LOCKFILE = 'bun.lock';

const LOCK_EX = 2;
const LOCK_NB = 4;

/**
 * Hold `path` exclusively until this process exits. Polls rather than blocking so it can say, once,
 * that it is waiting -- a build that sits silent behind another looks exactly like a hung one.
 */
function lockExclusive(path: string, say: (line: string) => void): void {
  const libc = openLibc();
  if (libc === null) {
    // Building unlocked beats not building: a torn bundle fails the window, which is `unavailable`
    // and asks, while no build at all fails every review after a pull. Said, never silent.
    say('could not load libc for flock(2), so this build is NOT serialised with other builds');
    return;
  }
  // Never closed: closing the descriptor releases the lock, and exit releases both.
  const fd = openSync(path, 'a');
  let told = false;
  while (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    if (!told) say('waiting for another build of this checkout\'s review window to finish');
    told = true;
    Bun.sleepSync(50);
  }
}

/** `flock` out of the C library, or null on a platform where none of the known names loads. */
function openLibc() {
  const names =
    process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib'] : ['libc.so.6', 'libc.so'];
  for (const name of names) {
    try {
      return dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    } catch {
      // Next name.
    }
  }
  return null;
}

/**
 * The tsconfig files the build's transforms read: for each first-party input, the nearest
 * `tsconfig.json` up to the root, which is how Vite finds them, and whatever each `extends`. They
 * reach no module graph and still shape the output -- `target`, `jsx`, `verbatimModuleSyntax`.
 * Derived from the recorded inputs, never listed.
 */
function tsconfigsFor(root: string, keys: Iterable<string>): string[] {
  const found = new Set<string>();
  const follow = (config: string) => {
    if (found.has(config)) return;
    found.add(config);
    // A base config shapes the output as much as the one naming it, and would otherwise be the one
    // input found by hand rather than read off the build. A regex rather than a parse: tsconfig is
    // JSONC, and `extends` is a string or a list of strings.
    const text = readFileSync(config, 'utf8');
    const value = /"extends"\s*:\s*(\[[^\]]*\]|"[^"]*")/.exec(text)?.[1] ?? '';
    for (const [, spec] of value.matchAll(/"([^"]+)"/g)) {
      follow(Bun.resolveSync(spec!.endsWith('.json') ? spec! : `${spec}.json`, dirname(config)));
    }
  };
  for (const key of keys) {
    if (isAbsolute(key) || key.startsWith('node_modules/')) continue;
    for (let dir = dirname(resolve(root, key)); ; dir = dirname(dir)) {
      const candidate = join(dir, 'tsconfig.json');
      if (existsSync(candidate)) {
        follow(candidate);
        break;
      }
      if (relative(root, dir) === '' || dir === dirname(dir)) break;
    }
  }
  return [...found];
}

/** Record one input under its stamp key, first sighting wins. Not a file on disk: nothing to hash. */
function record(root: string, into: Map<string, string>, file: string): void {
  const key = inputKey(root, file);
  if (into.has(key)) return;
  const hash = hashFile(file);
  if (hash !== null) into.set(key, hash);
}

/** What the notices need from a build beyond its inputs. */
interface Emitted {
  /** Each asset: the file it was made from and where it landed under `dist/`. */
  assets: EmittedAsset[];
  /** Every virtual module rendered into a chunk: toolchain code that no file holds. */
  virtual: Set<string>;
}

/**
 * This script and every first-party module it imports. They shape what lands in `dist/` (the
 * notices, the stamp) from outside the bundle's graph, so each is an input; walked rather than
 * listed, so a new helper is recorded the moment it is imported.
 */
function scriptModules(entry: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const found = new Set<string>();
  const visit = (file: string) => {
    if (found.has(file)) return;
    found.add(file);
    // Less a `#!` line, which the transpiler rejects and this script starts with.
    const source = readFileSync(file, 'utf8').replace(/^#!.*/, '');
    for (const { path } of transpiler.scanImports(source)) {
      if (path.startsWith('.')) visit(Bun.resolveSync(path, dirname(file)));
    }
  };
  visit(entry);
  return [...found];
}

/**
 * Records what the build read, hashed at the moment it read it.
 *
 * Every module through `load` (Vite's whole graph: first-party source, `contract.json`, CSS,
 * `node_modules`), every emitted asset's source (the fonts, which reach the bundle as files rather
 * than modules), and the config with whatever Vite says the config itself imported. Each asset and
 * each virtual module is also kept in `emitted`, for the notices.
 */
function collector(root: string, into: Map<string, string>, emitted: Emitted): Plugin {
  const add = (file: string) => record(root, into, file);
  let viteRoot = root;
  return {
    name: 'draftgate:build-stamp',
    enforce: 'pre',
    configResolved(config) {
      viteRoot = config.root;
      // Includes the config file itself (measured), so it needs no line of its own.
      for (const dep of config.configFileDependencies) add(dep);
    },
    load(id) {
      // `\0` marks a virtual module; a `?query` is a view of a file that is already recorded.
      if (!id.startsWith('\0')) {
        const file = id.split('?')[0]!;
        if (isAbsolute(file)) add(file);
      }
      return null;
    },
    generateBundle(_options, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type === 'chunk') {
          for (const id of Object.keys(out.modules)) if (id.startsWith('\0')) emitted.virtual.add(id);
          continue;
        }
        for (const name of out.originalFileNames ?? []) {
          const source = resolve(viteRoot, name);
          add(source);
          emitted.assets.push({ source, fileName: out.fileName });
        }
      }
    },
  };
}

export interface BuildOptions {
  layout: SurfaceLayout;
  ifStale: boolean;
  say: (line: string) => void;
}

/** Build and stamp, under the lock. Resolves to whether a build actually ran. */
export async function buildSurface({ layout, ifStale, say }: BuildOptions): Promise<boolean> {
  lockExclusive(layout.lockFile, say);

  if (ifStale && bundleState(layout, true).state === 'fresh') {
    say('the review window is already up to date');
    return false;
  }

  // Before anything else is written: a build that dies from here on must read as stale.
  rmSync(layout.stampFile, { force: true });

  // Checked before the build rather than found missing after it.
  repoNotice(layout.root);

  const inputs = new Map<string, string>();
  const emitted: Emitted = { assets: [], virtual: new Set() };
  // A checkout with no lockfile has no toolchain record to hash; the graph still covers it.
  for (const file of [resolve(layout.root, LOCKFILE), ...scriptModules(SELF)]) record(layout.root, inputs, file);

  // Pinned, so the environment cannot shape the bundle behind the stamp's back: an exported
  // `NODE_ENV=development` would otherwise ship React's development build under a fresh stamp.
  process.env.NODE_ENV = 'production';
  await build({
    configFile: layout.viteConfig,
    mode: 'production',
    build: { outDir: layout.distDir },
    plugins: [collector(layout.root, inputs, emitted)],
  });

  for (const file of tsconfigsFor(layout.root, [...inputs.keys()])) record(layout.root, inputs, file);
  const notices = writeNotices({
    root: layout.root,
    distDir: layout.distDir,
    keys: inputs.keys(),
    toolchainDir: dirname(layout.vitePackage),
    ...emitted,
  });
  for (const file of notices) record(layout.root, inputs, file);

  // Sorted for a stable, diffable file only; `stampOf` sorts for itself.
  const recorded = Object.fromEntries([...inputs].sort());
  const stamp: BuildStamp = { version: 1, stamp: stampOf(recorded), inputs: recorded };
  const tmp = `${layout.stampFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stamp, null, 1));
  renameSync(tmp, layout.stampFile);
  say(`built the review window (${inputs.size} inputs, stamp ${stamp.stamp.slice(0, 12)})`);
  return true;
}

function parseArgs(argv: string[]): { root: string; outDir?: string; ifStale: boolean } {
  let root = REPO_ROOT;
  let outDir: string | undefined;
  let ifStale = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--if-stale') ifStale = true;
    else if (arg === '--root' && argv[i + 1]) root = resolve(argv[++i]!);
    else if (arg === '--out-dir' && argv[i + 1]) outDir = resolve(argv[++i]!);
    else throw new Error(`unknown argument: ${arg}`);
  }
  // Real paths: Vite reports module ids through `realpath`, so a root reached through a symlink
  // (macOS's `/var` -> `/private/var`, or a symlinked checkout) would store every input absolute
  // and tie the stamp to one spelling of the path.
  return { root: realpathSync(root), outDir, ifStale };
}

/**
 * The one line a failed build is known by: the first line of the error that is not Vite's
 * "Build failed with N error(s)" header, with the colour codes rolldown writes whatever `NO_COLOR`
 * says. Printed last, so it is what the CLI's `unavailable` reason ends on, rather than the tail of
 * a code frame.
 */
function failureSummary(message: string): string {
  const lines = message
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Build failed with \d+ errors?:?$/.test(l));
  return lines[0] ?? 'no error message';
}

if (import.meta.main) {
  const say = (line: string) => process.stderr.write(`draftgate: ${line}\n`);
  try {
    const { root, outDir, ifStale } = parseArgs(process.argv.slice(2));
    await buildSurface({ layout: surfaceLayout(root, outDir), ifStale, say });
  } catch (e) {
    const message = (e as Error).message;
    process.stderr.write(`${message}\n`);
    say(`the review window could not be built: ${failureSummary(message)}`);
    process.exit(1);
  }
}
