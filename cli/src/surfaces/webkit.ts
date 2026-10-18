/**
 * The review surface and `--surface`'s default: the window, in draftgate's own host on the system
 * WebKit. Everything after "which binary" is `window.ts`'s `windowSurface`.
 *
 * A review that finds no host build of this source (a fresh checkout, a pull that moved the host)
 * builds it first (`cli/src/reviewHost.ts`, about a second), inside the review's one deadline. A
 * failed or timed-out build is `unavailable`, naming the command that fixes it, and never spawns an
 * older host.
 *
 * `draftgate-harness.app` can evaluate script in the window, so it can click Approve: the CLI spawns
 * it only when `DRAFTGATE_HARNESS` names a channel directory and `DRAFTGATE_HARNESS_NONCE` is live
 * (`nonceIsLive`, the hook's own gate). A stale variable is ignored, loudly. Node APIs only.
 */
import { join } from 'node:path';
import { REMEDY } from '../../../core/src/remedies';
import { NONCE_FILE, nonceIsLive } from '../harnessNonce';
import { HOST_LAYOUT, HostBuildRefusal, buildHost, hostState, type HostApps, type HostLayout } from '../reviewHost';
import { sentence } from '../text';
import type { ReviewSurface } from '../types';
import { windowSurface, type WindowBinary } from './window';

/** The two variables a harness sets to be handed the harness binary. */
export const HARNESS_ENV = 'DRAFTGATE_HARNESS';
export const HARNESS_NONCE_ENV = 'DRAFTGATE_HARNESS_NONCE';

/** Is a live harness asking for the harness binary? `why` says why a request was refused. */
export function harnessRequested(env: NodeJS.ProcessEnv): { open: boolean; why: string | null } {
  const dir = env[HARNESS_ENV];
  if (!dir) return { open: false, why: null };
  const verdict = nonceIsLive(env[HARNESS_NONCE_ENV], join(dir, NONCE_FILE));
  return verdict.live ? { open: true, why: null } : { open: false, why: verdict.why };
}

export interface HostResolution {
  layout: HostLayout;
  env: NodeJS.ProcessEnv;
  /** Where the one line about a build, or an ignored harness request, goes. stderr by default. */
  log: (line: string) => void;
  /** The macOS version, as `macosVersion` reads it, for the build's floor. Read when absent; set in tests. */
  macos?: string | null;
}

/**
 * The binary this review spawns: this source's host, built first if it has to be, and the harness
 * build only for a live harness.
 */
export async function resolveHostBinary(deadline: number, r: HostResolution): Promise<WindowBinary> {
  const state = hostState(r.layout);
  let apps: HostApps;
  let built = false;
  if (state.state === 'current') {
    apps = state.apps;
  } else {
    r.log(`the review host is ${state.state} (${state.why}); building it before the review`);
    try {
      apps = await buildHost(r.layout, { deadline, macos: r.macos });
    } catch (e) {
      // A refusal's sentence already says what to do; anything else carries the compiler's own
      // words, and is told to run the check that reports what this Mac is missing.
      const then = e instanceof HostBuildRefusal ? '' : ` Run ${REMEDY.doctor} and read what it says.`;
      return {
        refusal: `The review host could not be built, so no window was shown: ${sentence((e as Error).message)}${then}`,
      };
    }
    built = true;
  }
  const harness = harnessRequested(r.env);
  if (harness.why) r.log(`ignoring ${HARNESS_ENV}: ${harness.why}; opening the real review window`);
  // A build spent some of the deadline, which `windowSurface` holds to the rule the bundle rebuild
  // is held to: enough left for a window, or `unavailable`.
  return {
    bin: harness.open ? apps.harness.bin : apps.review.bin,
    ...(built ? { spent: { what: 'Building the review host' } } : {}),
  };
}

/** The review window: this checkout's host, under `windowSurface`'s one lifecycle. */
export function webkitSurface(): ReviewSurface {
  const resolution: HostResolution = {
    layout: HOST_LAYOUT,
    env: process.env,
    log: (line) => process.stderr.write(`draftgate: ${line}\n`),
  };
  return windowSurface((deadline) => resolveHostBinary(deadline, resolution));
}
