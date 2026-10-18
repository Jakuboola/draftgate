/**
 * The Electron the rulers (`measure:*`) and `icon:build` run under, installed here and nowhere else.
 * A dev tool: not a dependency, not in the plugin tree.
 *
 * `bun tools/electron/run.ts [--unpinned] <script|app dir> [args...]` runs `<script>` as an
 * Electron main process, on the display the rulers measure on (`RULER_DISPLAY`) unless `--unpinned`
 * comes first; an app directory (an interactive app's `.`) runs on the display it is given.
 * `electronBinary()` and `electronEnv()` are the same binary and environment for a caller that
 * spawns it itself (`tools/icon/build.ts`).
 *
 * The root `bun install` does not see this package (the root has no `workspaces`), so a contributor
 * who only runs the tests fetches no Electron (320 MB extracted, plus a 130 MB zip per version in
 * Electron's cache). The first run here installs it, and so does any run that finds it is not the
 * version `package.json` pins, exactly:
 *
 *  - `bun install --frozen-lockfile` in this directory, so the package and its chain are the locked
 *    ones (a lock that disagrees with the pin fails here).
 *  - Electron's own `install.js`, which fetches the binary (or takes it from the cache). From
 *    Electron 42 on no install step fetches it; `index.js` would, the first time it is required,
 *    but it prints to stdout, and the editor-core probes' stdout is their JSON output. So it runs
 *    here first, with its stdout sent to stderr.
 *
 * `require('electron')` in a main process is built in, so the scripts need nothing resolvable from
 * where they live.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';

const DIR = import.meta.dir;
const PKG = join(DIR, 'node_modules', 'electron');
/** The one Electron version, pinned exactly in this directory's `package.json`. */
const PINNED: string = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')).devDependencies.electron;

/**
 * The binary, if what is installed here is the pinned version, whole: the package, the `dist/`
 * its installer extracted (`dist/version` is how that installer asks the same question), and the
 * executable `path.txt` names.
 *
 * Read off `path.txt`, which Electron's installer writes, and NOT through `require('electron')`:
 * bun caches the directory listings it has seen, so in the process that just created
 * `node_modules/` the resolver still sees none and walks up -- to a parent directory's `electron`
 * if one is there, and to nothing otherwise.
 */
function installedBinary(): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
    if (version !== PINNED) return null;
    if (readFileSync(join(PKG, 'dist', 'version'), 'utf8').replace(/^v/, '') !== version) return null;
    const bin = join(PKG, 'dist', readFileSync(join(PKG, 'path.txt'), 'utf8'));
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** One install step under bun, in this directory, its stdout sent to our stderr. */
function step(what: string, args: string[]): void {
  const r = spawnSync(process.execPath, args, { cwd: DIR, stdio: ['ignore', 2, 2] });
  if (r.status !== 0) {
    throw new Error(`tools/electron: ${what} failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`);
  }
}

/**
 * The Electron binary, installed into this directory first if it is not. Nothing is spawned when
 * it is, and everything an install prints is on stderr: a download is 130 MB, and one that looked
 * like a hang would be interrupted.
 */
export function electronBinary(): string {
  const ready = installedBinary();
  if (ready) return ready;
  process.stderr.write(`tools/electron: installing Electron ${PINNED} here (the root install has none)\n`);
  step('bun install', ['install', '--frozen-lockfile']);
  step("Electron's installer", [join(PKG, 'install.js')]);
  const bin = installedBinary();
  if (!bin) throw new Error(`tools/electron: the install finished and left no Electron ${PINNED} in ${PKG}`);
  return bin;
}

/**
 * The environment to start Electron in: ours, without the run-as-Node switch, which a shell inside
 * an Electron app's terminal can carry and which would start Electron as plain Node -- no `app`, and
 * a script dies on its first line, or draws nothing.
 */
export function electronEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
}

/**
 * The display a ruler measures on: a device scale of 1, with legacy scroll bars. A box's geometry
 * follows the display a run has and a computed style does not -- a legacy scroll bar, which macOS
 * draws when a mouse is attached, takes 15px off the content width, and heights snap to 1/64px at a
 * scale of 1 and 1/128px at 2 -- so two runs are comparable only on one display, and this is it.
 * The committed `tools/github-ruler/measured-github.json` was taken on it.
 *
 * Here, in the launcher, because `-AppleShowScrollBars` is an NSUserDefaults ARGUMENT, read off the
 * command line, and only the process that starts Electron writes that. LAST, after the caller's own
 * arguments, because both are last-wins, so nothing appended to a `measure:*` moves them. And a
 * pinned run's arguments may not hold a `--`: Chromium reads no switch after one and NSUserDefaults
 * reads past it, so no one position is last for both.
 *
 * Applied to every script by default, because every script run here is a ruler and the way this
 * fails is a run nobody pinned: a probe run by hand, and the renderer and GitHub rulers write their
 * output file in place. An app directory is an interactive app, whose window is for a human on the
 * display they have. `--unpinned` measures on yours; anywhere but first it reaches Electron as an
 * argument, and the run stays pinned.
 */
const RULER_DISPLAY = ['--force-device-scale-factor=1', '-AppleShowScrollBars', 'Always'];

/** A command line this launcher will not run, said, with the usage. */
function refuse(why: string): never {
  process.stderr.write(`tools/electron: ${why}\nusage: bun tools/electron/run.ts [--unpinned] <script|app dir> [args...]\n`);
  process.exit(2);
}

if (import.meta.main) {
  const unpinned = process.argv[2] === '--unpinned';
  const args = process.argv.slice(unpinned ? 3 : 2);
  if (args.length === 0) refuse('nothing to run');
  if (!unpinned && !statSync(args[0]!, { throwIfNoEntry: false })?.isDirectory()) {
    if (args.includes('--')) refuse('a pinned run takes no `--`: Chromium reads no switch after one');
    args.push(...RULER_DISPLAY);
  }
  let bin: string;
  try {
    bin = electronBinary();
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  const child = spawn(bin, args, { stdio: 'inherit', env: electronEnv() });
  child.on('error', (e) => {
    process.stderr.write(`tools/electron: could not start ${bin}: ${e.message}\n`);
    process.exit(1);
  });
  // The signals that can be caught are passed on, so a SIGTERM or a hang-up aimed at this launcher
  // does not leave Electron's window up. A SIGKILL cannot be passed on: a caller that needs a hard
  // deadline spawns Electron itself, as `icon:build` does. (Electron's own `cli.js` passes SIGINT
  // and SIGTERM on the same way.)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('close', (code, signal) => {
    if (signal) {
      process.stderr.write(`tools/electron: Electron exited on ${signal}\n`);
      process.exit(128 + (constants.signals[signal] ?? 0));
    }
    process.exit(code ?? 1);
  });
}
