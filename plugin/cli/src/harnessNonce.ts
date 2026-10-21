/**
 * "Is a harness alive right now?": the question every harness-only capability turns on.
 *
 * Two gates ask it, both approval paths: the hook's `DRAFTGATE_HOOK_SURFACE` override (an
 * auto-approving surface) and the CLI's choice of the host's harness binary, which can evaluate
 * script in the review window and so click Approve. Both processes inherit the whole environment,
 * so a variable left exported in a shell profile or a CI config would otherwise make every review
 * approve itself. `cli/test/harnessNonce.test.ts` is the table both callers rest on.
 */
import { readFileSync, statSync } from 'node:fs';

/**
 * Shortest nonce this gate will look at, and how old its file may be. See `nonceIsLive`.
 *
 * The length: every harness writes `randomUUID()`, 36 characters, so a shorter value is one somebody
 * could guess. The age: a harness writes the file under a second before a gate reads it, so ten
 * minutes is generous and still refuses the realistic leftover, hours or days old. Not derived from
 * `DEFAULT_TIMEOUT_MS`: it bounds staleness, and nothing has to agree with it.
 */
export const NONCE_MIN_LENGTH = 32;
export const NONCE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * What a harness calls its nonce file, in the directory it hands a gate. One spelling for the
 * writer (`surface/harness/shared.ts`) and every reader: a drifted name is a live harness the gate
 * refuses, and for the WebKit surface that is a real window on the operator's screen.
 */
export const NONCE_FILE = 'nonce';

/**
 * Is `nonce` proof of a harness that is running now, and wrote `noncePath` for this run? Three
 * facts, and a leftover file fails at least two: the nonce is long enough to be real, the file still
 * holds exactly it, and the file was written recently. The harness deletes the file when its run
 * ends (`surface/harness/shared.ts`'s `releaseNonces`); the age bound covers a run killed before its
 * cleanup (an interrupted `surface:e2e`, a SIGKILL). Comparing contents alone is not enough:
 *
 *  - a test that never removes its `mkdtemp` directory leaves nonce files in `$TMPDIR`, and any one
 *    of them, with no test process running, makes the hook answer `allow` with the reason "A human
 *    reviewed this jira message in draftgate and approved it" and log `outcome: approved`;
 *  - `.trim()` on both sides lets `' '` match `/dev/null`, so the gate opens with a nonce nobody
 *    has to know.
 *
 * It returns `{ live: false, why }`, and every caller prints `why`, so a refusal is never silent.
 * `now` is injected for the tests; nothing in production passes it.
 */
export function nonceIsLive(
  nonce: string | undefined,
  noncePath: string | undefined,
  now: number = Date.now()
): { live: true } | { live: false; why: string } {
  if (typeof nonce !== 'string' || typeof noncePath !== 'string' || noncePath === '') {
    return { live: false, why: 'no nonce and no nonce file were supplied' };
  }
  const value = nonce.trim();
  if (value.length < NONCE_MIN_LENGTH) {
    return {
      live: false,
      why:
        `the nonce is ${value.length} characters after trimming and a harness writes a UUID ` +
        `(at least ${NONCE_MIN_LENGTH}); whitespace and empty values are not nonces`,
    };
  }

  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(noncePath, 'utf8');
    mtimeMs = statSync(noncePath).mtimeMs;
  } catch {
    return { live: false, why: `no readable nonce file at ${noncePath}` };
  }
  if (content.trim() !== value) {
    return { live: false, why: `the nonce file at ${noncePath} holds a different value` };
  }

  // `Math.abs`, so a file dated in the future is refused too.
  const age = Math.abs(now - mtimeMs);
  if (!(age <= NONCE_MAX_AGE_MS)) {
    return {
      live: false,
      why:
        `the nonce file at ${noncePath} was last written ${Math.round(age / 1000)}s away from now, ` +
        `past the ${NONCE_MAX_AGE_MS / 1000}s a live harness run can be; it is left over`,
    };
  }
  return { live: true };
}
