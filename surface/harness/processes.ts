/**
 * Finding the processes a review window leaves behind.
 *
 * Its own module so it can be TESTED. `e2e.ts` calls `main()` at import and therefore cannot be
 * imported by anything, and this is the one check standing between a timed-out review and a window
 * left on the reviewer's screen: inside `e2e.ts` it would have no test of its own.
 */

import { execFileSync, spawn } from 'node:child_process';
import { sep } from 'node:path';
import { HOST_LAYOUT, type HostLayout } from '../../cli/src/reviewHost';

/**
 * The pids whose command line holds `path`, matched LITERALLY. `ps` rather than `pgrep -f`, whose
 * pattern is a regex: a checkout path holding `(`, `+` or `[` would match too few processes and let
 * a check that counts them pass.
 */
export function pidsInside(path: string): number[] {
  const out: number[] = [];
  for (const line of execFileSync('ps', ['-Aww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m && m[1] !== String(process.pid) && m[2]!.includes(path)) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Run one `pgrep` and return the pids, distinguishing "no matches" from "pgrep did not work".
 *
 * `pgrep` exits 0 with matches, 1 with none, and >= 2 on an error -- a bad option, a pattern it
 * refuses. Do not read any of those as zero processes: the `error` handler only fires when the
 * spawn itself fails, so a pgrep that ran and complained arrives through `close` with empty stdout.
 * A check whose failure mode is "everything is fine" is not a check, and this is the one that
 * stands between a timed-out review and a review window left on the user's screen.
 *
 * `bin` is a parameter ONLY so the spawn-failure path can be tested. `pgrep --bad-option` spawns
 * fine and exits 2, so it exercises the `close` branch and not the `error` one; only a binary that
 * does not exist reaches the `error` handler, and `bin` is how a test names one. Nothing in the
 * harness passes it.
 */
export function pgrep(args: string[], bin = 'pgrep'): Promise<number[]> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn(bin, args);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', (e) => reject(new Error(`${bin} ${args.join(' ')} could not run: ${e.message}`)));
    // `close`, not `exit`, for the reason `cli/src/child.ts` records: `exit`
    // fires when the process dies, `close` once its stdio has drained. Reading stdout at `exit`
    // time can catch it short -- and a short read here is an UNDER-COUNT of surviving processes,
    // which is the "everything is fine" failure this module exists to prevent. bun on macOS does
    // not show the short read (200 iterations of 746 lines), so this follows the contract rather
    // than working around an observed bug.
    child.on('close', (code) => {
      if (code === 1) return resolve([]);
      if (code !== 0) {
        return reject(new Error(`${bin} ${args.join(' ')} exited ${code}: ${err.trim() || '(silent)'}`));
      }
      resolve(out.trim().split('\n').filter(Boolean).map(Number));
    });
  });
}



/**
 * Every process still running a review host this checkout built. By binary path alone:
 * the host has no helpers of its own under it -- its WebContent is launchd's child, so the timeout
 * flow checks that one by the pid the window reported.
 */
export function orphanedHosts(layout: HostLayout = HOST_LAYOUT): number[] {
  return pidsInside(layout.buildDir + sep);
}
