/**
 * The review window surface, in draftgate's own host on the system WebKit (`surface/host/`;
 * `webkit.ts` picks which of its two builds to spawn).
 *
 * One host per review: the hook invokes the CLI once per tool call and blocks on it, so a daemon
 * would add a port, a lifecycle and a stale-process failure with no second reviewer to justify them.
 * The transport is a file contract (`windowProtocol.ts`), so a long-lived host would change only it.
 *
 * Fails closed: no window means no approval, and the hook adapter, which sees the denial reason,
 * owns any availability policy. Every path out of `review()` is an approval, a rejection, a timeout,
 * or `unavailable` naming what went wrong.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { scratchDir } from '../scratch';
import { runChild } from '../child';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastLines, sentence } from '../text';
import { REMEDY } from '../../../core/src/remedies';
import { SURFACE_STALE } from '../types';
import type { Decision, ReviewRequest, ReviewSurface } from '../types';
import { draftgateHome } from '../audit';
import { THEME_STORE, type ThemeStore } from '../themePreference';
import type { ThemeChoice } from '../../../core/src/index';
import {
  bundleRemedy,
  bundleState,
  hasToolchain,
  surfaceLayout,
  type BundleState,
  type SurfaceLayout,
} from './bundleStamp';
import {
  DECISION_ENV,
  PROTOCOL_VERSION,
  REQUEST_ENV,
  WINDOW_STATE_ENV,
  parseWireDecision,
  type WireRequest,
} from './windowProtocol';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root, from `cli/src/surfaces/`. */
const ROOT = resolve(HERE, '..', '..', '..');

/** The directory both host builds are handed: the built window lives under it, in `dist/`. */
const DEFAULT_APP_DIR = join(ROOT, 'surface');

/**
 * This checkout's window bundle: where it is built, stamped and locked. Exported so a report asks
 * the same question this file asks before spawning, instead of re-deriving the renderer path.
 */
export const SURFACE_LAYOUT = surfaceLayout(ROOT);

/** The build `review()` runs when the bundle is stale. See its header for the lock. */
const BUILD_SCRIPT = join(ROOT, 'cli', 'src', 'buildSurface.ts');

/** The question `review()` asks before spawning, for a report that states it. */
export function surfaceBundleState(): BundleState {
  return bundleState(SURFACE_LAYOUT);
}

/**
 * The least a window may be given after a rebuild. Less than this and the review is refused as
 * `unavailable`: a window SIGKILLed a moment after it appears would report `timeout`, which tells
 * the agent and the audit log a person ignored a message nobody was shown.
 */
const MIN_WINDOW_AFTER_REBUILD_MS = 10_000;

/**
 * A step that spent some of the review's deadline before the window. Only a step that succeeded
 * spends, so there is nothing to run afterwards: what it built is there for the next review.
 */
export interface Spent {
  what: string;
}

/**
 * The one check that any step spending the deadline -- the bundle's rebuild, the host's build --
 * left the window enough of it. Once, in `windowSurface`, so no next such step has to remember it.
 * Null means go ahead.
 */
export function tooLittleLeft(deadline: number, spent: readonly (Spent | undefined)[]): string | null {
  const steps = spent.filter((s): s is Spent => s !== undefined);
  if (steps.length === 0 || deadline - Date.now() >= MIN_WINDOW_AFTER_REBUILD_MS) return null;
  return (
    `${steps.map((s) => s.what).join(' and ')} left too little of the review deadline to show it ` +
    `(under ${MIN_WINDOW_AFTER_REBUILD_MS / 1000}s). The next send opens the window.`
  );
}

/** One rebuild, and one more if the source moved under the first (a save mid-build). */
const REBUILD_ATTEMPTS = 2;

export interface BundleOptions {
  layout: SurfaceLayout;
  /** Where the rebuild's one line goes. stderr: the CLI's stdout is the payload. */
  log?: (line: string) => void;
}

/** What `windowSurface` takes beyond the binary: each a default the fake-app tests replace. */
export interface WindowSurfaceOptions {
  /** The directory the host is handed, which holds the built window. Overridden by fake-app tests. */
  appDir?: string;
  /**
   * The bundle whose freshness is checked (and repaired, in a dev checkout) before spawning, so the
   * preview never comes from an older converter than the one that sends. `null` skips the check,
   * for the fake-app tests.
   */
  bundle?: BundleOptions | null;
  /**
   * Where the reviewer's theme is remembered between reviews: read when a window is
   * about to open, and a changed choice kept from its decision. Window state, like `window.json`
   * below, so the surface owns it and `runReview` never sees it. The reviewer's own file by default.
   */
  theme?: ThemeStore;
}

/**
 * What a window surface spawns for one review -- and what, if anything, getting it spent of the
 * deadline -- or why it cannot spawn anything.
 */
export type WindowBinary = { bin: string; spent?: Spent } | { refusal: string };

/**
 * A surface that is a window. `resolveBinary` says only which binary to spawn -- resolved per
 * review, inside its deadline, because the host may have to be built first (`webkit.ts`) -- and
 * everything after that is this: the bundle check and rebuild beside it, the request file, the
 * SIGKILL at the deadline, and reading the decision. It is also the seam a fake app is tested
 * through.
 */
export function windowSurface(
  resolveBinary: (deadline: number) => Promise<WindowBinary>,
  opts: WindowSurfaceOptions = {}
): ReviewSurface {
  const appDir = opts.appDir ?? DEFAULT_APP_DIR;
  const bundle = opts.bundle === undefined ? { layout: SURFACE_LAYOUT } : opts.bundle;
  const themes = opts.theme ?? THEME_STORE;

  return {
    human: true,
    async review(request: ReviewRequest): Promise<Decision> {
      // One deadline for the rebuild and the window together: a window given the full budget after
      // a rebuild would outlive `runReview`'s backstop (`TIMEOUT_BACKSTOP_MS`) and be orphaned.
      const deadline = Date.now() + request.timeoutMs;
      // Side by side: the host build and the bundle rebuild share no inputs or outputs, so after a
      // pull that moved both, neither waits for the other inside the one deadline.
      const [binary, ready] = await Promise.all([
        resolveBinary(deadline),
        bundle === null ? Promise.resolve<BundleReady>({}) : ensureCurrentBundle(bundle, deadline),
      ]);
      if ('refusal' in binary) return unavailableDecision(binary.refusal);
      if ('refusal' in ready) return unavailableDecision(ready.refusal);
      const late = tooLittleLeft(deadline, [binary.spent, ready.spent]);
      if (late !== null) return unavailableDecision(late);
      const timeoutMs = Math.max(0, deadline - Date.now());
      const remembered = themes.read();
      if (remembered.problem) process.stderr.write(`draftgate: ${remembered.problem}\n`);

      // `scratchDir`, not a bare `mkdtemp`: the `finally` below does not run when this
      // process dies by signal, and what is left behind is `request.json` -- the draft, in
      // plaintext -- beside an orphaned window. SIGKILL still cannot be covered; see that module.
      const scratch = scratchDir('draftgate-surface-');
      const requestPath = join(scratch.dir, 'request.json');
      const decisionPath = join(scratch.dir, 'decision.json');

      try {
        // The window's countdown shows what is left, which a rebuild has spent some of.
        writeFileSync(
          requestPath,
          JSON.stringify(toWireRequest({ ...request, timeoutMs }, { rememberedTheme: remembered.theme }))
        );
        const decision = await runWindow({
          bin: binary.bin,
          appDir,
          requestPath,
          decisionPath,
          timeoutMs,
        });
        keepTheme(decision, remembered.theme, themes);
        return decision;
      } catch (e) {
        return unavailableDecision(`The review window could not be started: ${sentence((e as Error).message)}`);
      } finally {
        scratch.release();
      }
    },
  };
}

/** `refusal` is the `unavailable` reason; `spent` says a rebuild used some of the deadline. */
type BundleReady = { refusal: string } | { spent?: Spent };

/**
 * Make sure the window about to be spawned was built from this source. Every path that cannot vouch
 * for the bundle fails closed: a failed or timed-out rebuild never spawns the old bundle (wire.md),
 * and `unavailable` becomes `ask` in the hook.
 */
async function ensureCurrentBundle(bundle: BundleOptions, deadline: number): Promise<BundleReady> {
  const { layout } = bundle;
  const toolchain = hasToolchain(layout);
  let state = bundleState(layout, toolchain);
  if (state.state !== 'stale') {
    const remedy = bundleRemedy(state, layout.root);
    return remedy === null ? {} : { refusal: remedy };
  }

  const log = bundle.log ?? ((line) => process.stderr.write(`draftgate: ${line}\n`));
  log(`the review window is older than its source (${state.why}); rebuilding it before the review`);
  // One more build if the first leaves it stale: hashes are taken as Vite loads each file, so a
  // file saved during the build reads as changed here.
  for (let attempt = 0; attempt < REBUILD_ATTEMPTS && state.state === 'stale'; attempt++) {
    const failure = await runBuild(layout, deadline);
    if (failure !== null) return { refusal: failure };
    state = bundleState(layout, toolchain);
  }
  if (state.state === 'stale') {
    return {
      refusal:
        `The review window still does not match its source after a rebuild (${state.why}). ` +
        `Run ${REMEDY.rebuildWindow} and read what it says.`,
    };
  }
  return { spent: { what: 'Rebuilding the stale review window' } };
}

/** Run the build as a child, killed outright at the deadline. Null on success. */
async function runBuild(layout: SurfaceLayout, deadline: number): Promise<string | null> {
  const remedy =
    `Run ${REMEDY.installDependencies} (a pull may have added dependencies), then ` +
    `${REMEDY.rebuildWindow}.`;
  // Nothing is torn that matters when the deadline kills it: the stamp is removed before the build
  // writes anything and renamed in after, so a killed build reads as stale to the next review, and
  // the kernel frees the build lock with the process.
  const outcome = await runChild(
    process.execPath,
    [BUILD_SCRIPT, '--if-stale', '--root', layout.root, '--out-dir', layout.distDir],
    {
      captureStdout: true,
      timeoutMs: Math.max(0, deadline - Date.now()),
      env: process.env,
    }
  );
  switch (outcome.kind) {
    case 'timeout':
      return (
        'Rebuilding the stale review window did not finish before the review deadline, so the ' +
        `old window was not shown. ${remedy}`
      );
    case 'error':
      return `The review window is stale and could not be rebuilt: ${outcome.message}. ${remedy}`;
    case 'exit': {
      if (outcome.code === 0) return null;
      // One line: the build script ends on its own summary, and a code frame above it is noise.
      const tail = outcome.output.trim() ? ` Last output: ${lastLines(outcome.output, 1)}` : '';
      const how = outcome.signal ?? `exit ${outcome.code}`;
      return `The review window is stale and rebuilding it failed (${how}).${tail} ${remedy}`;
    }
  }
}

/**
 * The request's projection onto the wire, exported for its test. A field this hand-built literal
 * forgets fails no test upstream (`runReview`'s assert the `ReviewRequest`) or downstream (the
 * window's tests and the probe supply a `WireRequest`), so one table in
 * `cli/test/windowSurface.test.ts` fails when an optional field stops crossing.
 */
export function toWireRequest(request: ReviewRequest, window: WindowFacts = {}): WireRequest {
  return {
    protocol: PROTOCOL_VERSION,
    destination: request.render.destination,
    toolName: request.toolName,
    context: request.context,
    ...(window.rememberedTheme ? { rememberedTheme: window.rememberedTheme } : {}),
    ...(request.audience ? { audience: request.audience } : {}),
    ...(request.destinationLabel ? { destinationLabel: request.destinationLabel } : {}),
    ...(request.inferredFrom ? { routeInferred: { matchedEntry: request.inferredFrom } } : {}),
    // Straight through, as one field: the CLI already walked the route's plan and attached the
    // payload's values, so there is nothing to project here and no part of it to drop.
    fields: request.fields,
    timeoutMs: request.timeoutMs,
  };
}

/** What the window surface adds to a request from its own state, rather than the gate's. */
export interface WindowFacts {
  rememberedTheme?: ThemeChoice;
}

/**
 * Keep the theme a decision carries, when it differs from the one remembered. Either way the
 * reviewer decided, like a classification; a timeout or a crash carries none. A write that fails is
 * said on stderr and changes nothing about the decision.
 */
function keepTheme(decision: Decision, remembered: ThemeChoice | undefined, themes: ThemeStore): void {
  if (!('theme' in decision) || decision.theme === undefined || decision.theme === remembered) return;
  const failed = themes.keep(decision.theme);
  if (failed) process.stderr.write(`draftgate: the theme choice was not kept: ${failed.message}\n`);
}

interface RunOptions {
  bin: string;
  appDir: string;
  requestPath: string;
  decisionPath: string;
  timeoutMs: number;
}

/**
 * Spawn the window and wait for it to write a decision. The timeout is enforced here too:
 * `runReview`'s `raceTimeout` only abandons the promise, so a window it cannot kill would stay on
 * screen after `main.ts` exits. This timer (`deadline - now`) must fire first: see `TIMEOUT_BACKSTOP_MS`
 * in `review.ts`.
 */
async function runWindow(opts: RunOptions): Promise<Decision> {
  const outcome = await runChild(opts.bin, [opts.appDir], {
    // The window's stdout is not captured at all: AppKit's and WebKit's diagnostics are noise on a
    // healthy run, and its stderr is kept for when something failed.
    captureStdout: false,
    timeoutMs: opts.timeoutMs,
    env: {
      ...process.env,
      [REQUEST_ENV]: opts.requestPath,
      [DECISION_ENV]: opts.decisionPath,
      // Where the window remembers its placement, resolved here (see `WINDOW_STATE_ENV`).
      [WINDOW_STATE_ENV]: join(draftgateHome(), 'window.json'),
    },
  });
  switch (outcome.kind) {
    // A decision landed after the deadline is discarded by `runChild`'s single settle: the send is
    // denied either way.
    case 'timeout':
      return { action: 'timeout' };
    case 'error':
      return unavailableDecision(`The review window failed to start: ${sentence(outcome.message)}`);
    case 'exit':
      return readDecision(opts.decisionPath, outcome.code, outcome.signal, outcome.output);
  }
}

/**
 * Turn the child's exit into a decision. The decision file is authoritative, not the exit code: a
 * window that crashed on the way out still recorded what the human chose. A missing or unreadable
 * file is never an approval (see the header).
 */
function readDecision(
  path: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string
): Decision {
  const tail = stderr.trim() ? ` Last output: ${lastLines(stderr)}` : '';

  // Absent and corrupt differ: no file after a clean exit is the human closing the window, a
  // rejection; a corrupt file is the window malfunctioning, not feedback about the message.
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    if (signal !== null) {
      return unavailableDecision(`The review window was killed by ${signal}.${tail}`);
    }
    if (code !== 0) {
      return unavailableDecision(`The review window exited with code ${code}.${tail}`);
    }
    return rejectDecision(`The review window closed without a decision.${tail}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unavailableDecision(`The review window wrote a decision that is not valid JSON.${tail}`);
  }

  const decision = parseWireDecision(raw);
  if (!decision) {
    // A stale or corrupt build, not a human decision. The audit row says stale, not unavailable:
    // the window opened, a human clicked in it, and the repair is `build:surface`, not the host.
    return unavailableDecision(
      'The review window wrote a decision this version of draftgate does not understand ' +
        `(expected protocol ${PROTOCOL_VERSION}). The built window is probably stale: run ` +
        `${REMEDY.rebuildWindow}.`,
      SURFACE_STALE
    );
  }

  /*
   * `protocol` off, everything else through, not a field list: `parseWireDecision` already validated
   * and rebuilt the decision, and `WireDecision` is `HumanDecision & { protocol }`, so a list here
   * could only forget a field. The two rebuilds that guard something (the host's `sanitiseDecision`
   * and `parseWireDecision`) are held together by `surface/harness/decisionFields.test.ts`.
   */
  const { protocol: _protocol, ...human } = decision;
  return human;
}

const rejectDecision = (reason: string): Decision => ({ action: 'reject', reason });
const unavailableDecision = (
  reason: string,
  cause?: typeof SURFACE_STALE
): Decision => ({ action: 'unavailable', reason, ...(cause ? { cause } : {}) });
