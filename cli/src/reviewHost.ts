/**
 * The review window's native host on the system WebKit, and building it.
 *
 * `surface/host/` is the source: `draftgate.m`, the window a review opens, and `harness.m`, the
 * verifier's half, compiled only into a second bundle. This module compiles them into two app
 * bundles, ad-hoc signs them, and answers whether the ones on disk were built from the source beside
 * them.
 *
 * Compiled on this Mac, never shipped as a binary: Objective-C with the Command Line Tools' `clang`
 * (an install needs them for git anyway), about a second, nothing cached. Swift with the same
 * frameworks takes tens of seconds cold and leaves a module cache of hundreds of MB, and the install
 * must fit an agent's two-minute command limit. A binary built here carries no quarantine and is the
 * machine's own architecture.
 *
 * Builds go to `surface/host/build/<inputs hash>/draftgate.app` and `.../draftgate-harness.app`,
 * git-ignored. The hash covers every file in `surface/host/` (the directory is the input list), the
 * icon, and this file (the compiler flags and the `Info.plist`). A different source is a different
 * directory, so a build never replaces a bundle anything could be launching: it is made beside and
 * renamed into place, and a concurrent build of the same source that loses the rename keeps the
 * winner's. `built.json` is written last, so a pair without one reads as not built.
 *
 * Node APIs only: the CLI asks this before every review.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMEDY } from '../../core/src/remedies';
import { processGone, runChild, type ChildOutcome } from './child';
import { writeStdout } from './stdout';
import { lastLines } from './text';

/** What the Dock and the app switcher call the review window. */
export const HOST_NAME = 'draftgate';
/**
 * The review host's bundle id: the id existing installs already have, so the Dock, the app switcher
 * and anything keyed on the id keep seeing the same app. Do not change it lightly.
 */
export const HOST_BUNDLE_ID = 'io.github.jakuboola.draftgate';
export const HARNESS_BUNDLE_ID = 'io.github.jakuboola.draftgate.harness';
/** The oldest macOS the host is built for and runs on. */
export const MIN_MACOS = '26.0';
/** Bumped whenever what `buildHost` writes changes, beyond what the hashed inputs already say. */
const FORMAT = 1;
const EXECUTABLE = 'draftgate';
const STAMP_FILE = 'built.json';
/** How much of the inputs' sha256 names a build directory, and what such a name looks like. */
const HASH_LENGTH = 16;
const isBuildName = (name: string) => new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`).test(name);

export interface HostLayout {
  root: string;
  /** `surface/host/`: every file in it except `build/` is an input. */
  sourceDir: string;
  icon: string;
  /** This file: the flags and the plist are inputs too. */
  buildScript: string;
  /**
   * Every build of every source, and so where a host window can run from: a window keeps running
   * from the directory it started in after a newer source builds beside it. The orphan check reads
   * this field, not a spelled-out path.
   */
  buildDir: string;
}

export function hostLayout(root: string, buildDir = join(root, 'surface', 'host', 'build')): HostLayout {
  return {
    root,
    sourceDir: join(root, 'surface', 'host'),
    icon: join(root, 'surface', 'icon', 'draftgate.icns'),
    buildScript: join(root, 'cli', 'src', 'reviewHost.ts'),
    buildDir,
  };
}

export interface HostApp {
  app: string;
  bin: string;
}

export interface HostApps {
  /** `<buildDir>/<hash>`: both bundles and the stamp. */
  dir: string;
  hash: string;
  review: HostApp;
  harness: HostApp;
}

/** Every input, as paths relative to the root, sorted: what the hash is taken over. */
export function hostInputs(layout: HostLayout): string[] {
  const out: string[] = [];
  // Both: the checkout's own build directory is inside the source one whichever `buildDir` this
  // layout builds into, and a test's build directory may be anywhere.
  const skip = new Set([layout.buildDir, join(layout.sourceDir, 'build')]);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (skip.has(path) || name === '.DS_Store') continue;
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(layout.root, path));
    }
  };
  walk(layout.sourceDir);
  out.push(relative(layout.root, layout.icon), relative(layout.root, layout.buildScript));
  return out.sort();
}

/**
 * The hash that names the build directory: every input's path and content, `FORMAT`, the package
 * version, which the `Info.plist` carries, and the CPU architecture `clang` builds for by default --
 * so a build directory carried to a Mac of the other architecture (a synced checkout) reads as
 * missing there, rather than current and unlaunchable.
 */
export function hostInputsHash(layout: HostLayout): string {
  const h = createHash('sha256').update(
    `format ${FORMAT}\nversion ${packageVersion(layout.root)}\narch ${process.arch}\n`
  );
  for (const rel of hostInputs(layout)) {
    h.update(`${rel}\n`).update(readFileSync(join(layout.root, rel))).update('\n');
  }
  return h.digest('hex').slice(0, HASH_LENGTH);
}

const appOf = (dir: string, name: string): HostApp => {
  const app = join(dir, `${name}.app`);
  return { app, bin: join(app, 'Contents', 'MacOS', EXECUTABLE) };
};

export function hostApps(layout: HostLayout): HostApps {
  const hash = hostInputsHash(layout);
  const dir = join(layout.buildDir, hash);
  return { dir, hash, review: appOf(dir, HOST_NAME), harness: appOf(dir, `${HOST_NAME}-harness`) };
}

/** A complete build in `dir`: `built.json` is written last. */
const built = (dir: string) => existsSync(join(dir, STAMP_FILE));

export type HostState =
  | { state: 'current'; apps: HostApps }
  | { state: 'missing'; why: string }
  | { state: 'stale'; why: string };

/** Is there a complete build of this source? Never throws: an unreadable input is `missing`. */
export function hostState(layout: HostLayout): HostState {
  let apps: HostApps;
  try {
    apps = hostApps(layout);
  } catch (e) {
    return { state: 'missing', why: `its source cannot be read (${(e as Error).message})` };
  }
  if (built(apps.dir)) return { state: 'current', apps };
  const others = existsSync(layout.buildDir)
    ? readdirSync(layout.buildDir).filter((n) => isBuildName(n) && built(join(layout.buildDir, n)))
    : [];
  return others.length > 0
    ? { state: 'stale', why: `it was built from another source (${others.join(', ')}), not ${apps.hash}` }
    : { state: 'missing', why: 'it has not been built' };
}

/** A tool that did not succeed, and how, in `runChild`'s own words. */
export class ToolFailure extends Error {
  constructor(
    readonly kind: ChildOutcome['kind'],
    message: string
  ) {
    super(message);
  }
}

type Run = (cmd: string, args: string[]) => Promise<void>;

/** `runChild`, killed at the deadline, as a promise that rejects with a `ToolFailure`. */
export function runner(deadline: number): Run {
  return async (cmd, args) => {
    const outcome = await runChild(cmd, args, { captureStdout: true, timeoutMs: Math.max(0, deadline - Date.now()) });
    if (outcome.kind === 'timeout') throw new ToolFailure('timeout', `${cmd} ran past its deadline and was killed`);
    if (outcome.kind === 'error') throw new ToolFailure('error', `${cmd}: ${outcome.message}`);
    if (outcome.code === 0) return;
    const tail = outcome.output.trim() ? `: ${lastLines(outcome.output, 3)}` : '';
    throw new ToolFailure('exit', `${cmd} ${outcome.signal ?? `exited ${outcome.code}`}${tail}`);
  };
}

/** The compiler flags, one list for both bundles. `-DDG_HARNESS` is the only difference. */
function compileArgs(sources: string[], out: string, harness: boolean): string[] {
  return [
    '-fobjc-arc',
    // Traditional headers, no Clang module cache: what makes the build a second rather than 36 s,
    // and leaves nothing behind in ~/Library.
    '-fno-modules',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Wno-unused-parameter',
    '-Werror',
    // The deployment target is the floor: an API newer than it is a compile error.
    `-mmacosx-version-min=${MIN_MACOS}`,
    ...(harness ? ['-DDG_HARNESS'] : []),
    '-framework', 'Cocoa',
    '-framework', 'WebKit',
    '-framework', 'JavaScriptCore',
    '-o', out,
    ...sources,
  ];
}

/** The `Info.plist`. The harness bundle is an agent app (`LSUIElement`): never in the Dock. */
function infoPlist(opts: { id: string; version: string; build: string; harness: boolean }): string {
  const entries: [string, string][] = [
    ['CFBundleName', `<string>${HOST_NAME}</string>`],
    ['CFBundleDisplayName', `<string>${HOST_NAME}</string>`],
    ['CFBundleExecutable', `<string>${EXECUTABLE}</string>`],
    ['CFBundleIdentifier', `<string>${opts.id}</string>`],
    ['CFBundleIconFile', '<string>draftgate</string>'],
    ['CFBundlePackageType', '<string>APPL</string>'],
    ['CFBundleShortVersionString', `<string>${opts.version}</string>`],
    // Dotted integers, the form LaunchServices compares. The inputs hash goes under our own key.
    ['CFBundleVersion', `<string>${opts.version}</string>`],
    ['DraftgateInputsHash', `<string>${opts.build}</string>`],
    ['LSMinimumSystemVersion', `<string>${MIN_MACOS}</string>`],
    ['NSHighResolutionCapable', '<true/>'],
    ['NSPrincipalClass', '<string>NSApplication</string>'],
    ...(opts.harness ? ([['LSUIElement', '<true/>']] as [string, string][]) : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.map(([k, v]) => `  <key>${k}</key>${v}`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * A build refused for a reason whose sentence already says what to do -- this machine is below the
 * floor, or it has no compiler -- so a caller adds no "run build:host" after it: that command would
 * only say the same thing again.
 */
export class HostBuildRefusal extends Error {}

export interface BuildOptions {
  /** Epoch ms. The compiler and `codesign` are killed at it, and the build fails. */
  deadline?: number;
  /** Replaced in tests. */
  run?: Run;
  /** The macOS version, as `macosVersion` reads it. Replaced in tests. */
  macos?: string | null;
}

/** Where macOS says which version it is, as a file: no process to spawn on the way to a review. */
const SYSTEM_VERSION = '/System/Library/CoreServices/SystemVersion.plist';

/**
 * This Mac's macOS version (`27.0`); null when this is not macOS; `''` on a Mac whose
 * `SystemVersion.plist` cannot be read or names none. Only `belowFloor` reads the difference. Read
 * off `SystemVersion.plist`, not derived from the Darwin kernel version, which does not map:
 * macOS 27.0 runs Darwin 27, and macOS 26 runs Darwin 25 (`sw_vers`).
 */
export function macosVersion(plist = SYSTEM_VERSION, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'darwin') return null;
  try {
    return /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, 'utf8'))?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Why this machine cannot run the review window, or null when it can. The floor is where the window
 * has been verified: WebKit follows the installed macOS, and nothing vouches for an older one.
 */
export function belowFloor(version: string | null = macosVersion()): string | null {
  const major = (v: string) => Number(v.split('.')[0]);
  const needs = `the review window needs macOS ${MIN_MACOS} or newer`;
  if (version === null) return `${needs}, and this is not macOS`;
  if (version === '') return `${needs}, and this Mac's version could not be read`;
  if (!(major(version) >= major(MIN_MACOS))) return `${needs}, and this Mac runs macOS ${version}`;
  return null;
}

/**
 * Build both bundles for this source, unless a complete build of it is already there. Throws with
 * a message naming what failed; leaves no half-built bundle where `hostState` would find it.
 */
export async function buildHost(layout: HostLayout, opts: BuildOptions = {}): Promise<HostApps> {
  let apps = hostApps(layout);
  if (built(apps.dir)) return apps;
  // Refused before the compiler runs: a binary built for a newer macOS would only fail to launch.
  const floor = belowFloor(opts.macos);
  if (floor !== null) throw new HostBuildRefusal(floor);
  const run = opts.run ?? runner(opts.deadline ?? Date.now() + 120_000);
  // `/usr/bin/clang` without the Command Line Tools is a stub that opens an installer dialog, which
  // from a hook or an agent's shell just hangs. `xcode-select -p` answers without one: it exits
  // non-zero when there is no developer directory. Only that is "not installed"; a deadline or a
  // spawn failure is itself, not advice to install tools this Mac may already have.
  try {
    await run('xcode-select', ['-p']);
  } catch (e) {
    if (!(e instanceof ToolFailure && e.kind === 'exit')) throw e;
    throw new HostBuildRefusal(`the Command Line Tools are not installed; run ${REMEDY.installCommandLineTools}`);
  }
  mkdirSync(layout.buildDir, { recursive: true });
  // The directory is named for the source as it was when the build began, and the compiler read it
  // later: an edit landing between the two (a save, a checkout) would file a binary of the new
  // source under the old name, to be launched the day the edit is reverted. So a build that finds
  // the source moved files nothing, and the source that is there now is built once more.
  for (let attempt = 1; ; attempt++) {
    if (await compileInto(layout, apps, run)) return apps;
    if (attempt === 2) throw new Error("the host's source changed while it was being built, twice; build it again");
    apps = hostApps(layout);
    if (built(apps.dir)) return apps;
  }
}

/** Build `apps` into place, or answer false -- having filed nothing -- when the source moved under it. */
async function compileInto(layout: HostLayout, apps: HostApps, run: Run): Promise<boolean> {
  sweep(layout, apps.hash);
  // The pid is what the sweep reads; the random part keeps two builds in one process apart.
  const building = join(layout.buildDir, `.building-${process.pid}-${randomBytes(4).toString('hex')}-${apps.hash}`);
  rmSync(building, { recursive: true, force: true });
  try {
    const version = packageVersion(layout.root);
    const main = join(layout.sourceDir, 'draftgate.m');
    const harness = join(layout.sourceDir, 'harness.m');
    // The two bundles share nothing but the icon they copy, so they build at once.
    const bundle = async (name: string, id: string, sources: string[], isHarness: boolean) => {
      const { app, bin } = appOf(building, name);
      mkdirSync(dirname(bin), { recursive: true });
      mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
      await run('clang', compileArgs(sources, bin, isHarness));
      writeFileSync(join(app, 'Contents', 'Info.plist'), infoPlist({ id, version, build: apps.hash, harness: isHarness }));
      copyFileSync(layout.icon, join(app, 'Contents', 'Resources', 'draftgate.icns'));
      await run('codesign', ['--force', '--sign', '-', app]);
      await run('codesign', ['--verify', app]);
    };
    await Promise.all([
      bundle(HOST_NAME, HOST_BUNDLE_ID, [main], false),
      bundle(`${HOST_NAME}-harness`, HARNESS_BUNDLE_ID, [main, harness], true),
    ]);
    if (hostInputsHash(layout) !== apps.hash) return false;
    writeFileSync(join(building, STAMP_FILE), JSON.stringify({ format: FORMAT, hash: apps.hash, inputs: hostInputs(layout) }, null, 2) + '\n');
    try {
      renameSync(building, apps.dir);
    } catch (e) {
      // Another build of the same source got there first. Its result is as good as ours.
      if (!built(apps.dir)) throw e;
    }
    return true;
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
}

/**
 * Remove builds of other sources, and what a killed build left. A bundle a window is running from
 * can go: WebKit's helpers are system services rather than anything inside it, and the executable
 * stays mapped until that window exits. A `.building-<pid>-` directory is removed only once its pid
 * is dead.
 */
function sweep(layout: HostLayout, keep: string): void {
  for (const name of readdirSync(layout.buildDir)) {
    const path = join(layout.buildDir, name);
    const building = /^\.building-(\d+)-/.exec(name);
    if (building) {
      if (processGone(Number(building[1]))) rmSync(path, { recursive: true, force: true });
    } else if (isBuildName(name) && name !== keep) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

function packageVersion(root: string): string {
  try {
    const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** This checkout's layout. */
export const HOST_LAYOUT = hostLayout(ROOT);

/**
 * Whether the review window can open here, as one verdict both reports give, decided in this
 * order: a machine below the floor runs nothing whatever else is true, a current host needs nothing, and
 * otherwise a review builds it first -- which needs the Command Line Tools, so without them it
 * cannot be built and every review is `unavailable`.
 */
export type HostVerdict =
  | { kind: 'below-floor'; why: string }
  | { kind: 'current' }
  | { kind: 'no-compiler' }
  | { kind: 'builds-on-review' };

/** What this machine and checkout say about the review window, as `setup` and `--doctor` report it. */
export interface HostFacts {
  host: HostState;
  macos: string | null;
  verdict: HostVerdict;
}

/** What `hostFacts` asks this machine. Replaced in tests. */
export interface HostQuestions {
  macos?: string | null;
  /** Whether `xcode-select -p` finds a developer directory. Asked only of a host that needs building. */
  commandLineTools?: () => boolean;
}

/** One reading for both reports, so `setup` and `--doctor` cannot answer it two ways. */
export function hostFacts(layout: HostLayout = HOST_LAYOUT, ask: HostQuestions = {}): HostFacts {
  const macos = ask.macos === undefined ? macosVersion() : ask.macos;
  const host = hostState(layout);
  const floor = belowFloor(macos);
  const commandLineTools = ask.commandLineTools ?? (() => spawnSync('xcode-select', ['-p'], { stdio: 'ignore' }).status === 0);
  return {
    host,
    macos,
    verdict:
      floor !== null ? { kind: 'below-floor', why: floor }
      : host.state === 'current' ? { kind: 'current' }
      // `buildHost`'s own first question. A spawn that fails outright reads as no compiler too: the
      // build would fail on the same spawn, and `xcode-select` is in the base system of every macOS
      // above the floor.
      : commandLineTools() ? { kind: 'builds-on-review' }
      : { kind: 'no-compiler' },
  };
}

if (import.meta.main) {
  const started = Date.now();
  try {
    const before = hostState(HOST_LAYOUT);
    const apps = await buildHost(HOST_LAYOUT);
    const verb = before.state === 'current' ? 'is current' : `built in ${((Date.now() - started) / 1000).toFixed(1)}s`;
    await writeStdout(`draftgate: the review host ${verb} (${apps.review.app}).\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`draftgate: could not build the review host: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
