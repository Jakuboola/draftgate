/**
 * The temp directory a review passes its payload through, and getting rid of it.
 *
 * It holds `request.json` (surface side) or `payload.json` / `decision.json` (hook side): the draft
 * in plaintext plus the approved payload, the content `audit.ts` keeps at 0600.
 *
 * A `finally` does not run when the process dies by signal, so this helper also removes the
 * directory on `SIGINT`, `SIGTERM` and `SIGHUP`, then exits with the conventional 128+signal
 * status. `SIGKILL` cannot be caught: a review killed with `-9` leaves its directory, which is
 * 0700 with 0600 files under the reviewer's own account.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The signals a process can catch; `SIGKILL` cannot be. */
const CATCHABLE = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const SIGNAL_NUMBER: Record<(typeof CATCHABLE)[number], number> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGHUP: 1,
};

export interface Scratch {
  /** The directory. Created 0700 by `mkdtemp`. */
  dir: string;
  /** Remove it and unregister the signal handlers. Safe to call more than once. */
  release(): void;
}

/**
 * A scratch directory that is removed on the way out, including on a catchable signal.
 *
 * `process.once` per signal, and `release()` removes the handlers, so a long-lived process that runs
 * several reviews keeps no handler per review and none pointing at a removed directory.
 */
export function scratchDir(prefix: string): Scratch {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let released = false;

  const remove = () => {
    if (released) return;
    released = true;
    for (const sig of CATCHABLE) process.off(sig, handlers[sig]);
    rmSync(dir, { recursive: true, force: true });
  };

  const handlers = {} as Record<(typeof CATCHABLE)[number], () => void>;
  for (const sig of CATCHABLE) {
    handlers[sig] = () => {
      // Never let a cleanup failure change how the process dies.
      try {
        remove();
      } catch {
        /* the directory is 0700 under this user; a failure here is not worth a different exit */
      }
      process.exit(128 + SIGNAL_NUMBER[sig]);
    };
    process.once(sig, handlers[sig]);
  }

  return { dir, release: remove };
}
