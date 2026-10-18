/**
 * The release check's state, as the tests that read it need it: the line in a review's decision, in
 * `--doctor` and in `digest`. One copy of the on-disk shape. Not a test file: imported by them.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RELEASE_STATE_BASENAME,
  RELEASE_STATE_VERSION,
  headCommit,
  readReleaseState,
  releaseNotice,
  type ReleaseState,
} from '../src/releaseCheck';

/** Long ago, so a check would be due: what lets a test show that nothing started one. */
export const LONG_AGO = '2026-01-01T00:00:00.000Z';

/**
 * Write a finished check that saw `checkout`'s HEAD at v0.1.0 with v0.2.0 out, into `home`, and
 * return the line every reader must print for it.
 */
export function seedNewerRelease(home: string, checkout: string): string {
  const head = headCommit(checkout);
  if (head === null) throw new Error(`${checkout} has no readable HEAD`);
  const state: ReleaseState = {
    attemptedAt: LONG_AGO,
    result: {
      attemptedAt: LONG_AGO,
      finishedAt: LONG_AGO,
      head,
      have: 'v0.1.0',
      remote: { latest: 'v0.2.0', stable: '0'.repeat(40) },
    },
  };
  writeFileSync(
    join(home, RELEASE_STATE_BASENAME),
    JSON.stringify({ version: RELEASE_STATE_VERSION, ...state })
  );
  const line = releaseNotice(state, head);
  if (line === null) throw new Error('the seeded state carries no notice');
  return line;
}

/** The state once the check its claim started has written its answer. */
export function checkFinished(env: NodeJS.ProcessEnv): ReleaseState | undefined {
  const state = readReleaseState(env);
  return state?.result?.attemptedAt === state?.attemptedAt ? state! : undefined;
}

/** Poll `read` until it answers, or fail naming `what`. */
export async function until<T>(read: () => T | undefined | null, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}
