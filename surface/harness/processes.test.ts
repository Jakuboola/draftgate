/**
 * The orphan check must never answer "everything is fine" to a question it could not ask. `e2e.ts`
 * finds processes two ways, each of which can go blind:
 *
 *   1. Looking in the wrong place: `orphanedHosts` matches the directory every host build lives
 *      under, so a process running any build of this layout counts.
 *   2. Reading a failure as zero: `pgrep` exits >= 2 on an error, and an `error` handler fires only
 *      when the spawn fails, so a pgrep that complained would count as no processes.
 *
 * Against real processes, because a stub would agree with a broken version.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { orphanedHosts, pgrep } from './processes';
import { hostLayout } from '../../cli/src/reviewHost';
import { until } from './shared';

const started: ChildProcess[] = [];

/**
 * A process whose argv contains `marker` (the shell's `-c`), plus a backgrounded `sleep` that does
 * not: the shape `pgrep -P` catches and `pgrep -f` cannot. Its own process group, so `afterEach`
 * takes the child down too.
 */
function sleeper(marker: string): ChildProcess {
  const child = spawn('sh', ['-c', `sleep 8 & wait # ${marker}`], {
    stdio: 'ignore',
    detached: true,
  });
  started.push(child);
  return child;
}

afterEach(() => {
  for (const c of started.splice(0)) {
    try {
      process.kill(-c.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

describe('pgrep tells "none" apart from "it did not work"', () => {
  test('no matches is an empty list, not an error', async () => {
    expect(await pgrep(['-f', 'draftgate-no-such-process-marker-9f3a'])).toEqual([]);
  });

  test('a match comes back as pids', async () => {
    const marker = `draftgate-pgrep-match-${process.pid}`;
    sleeper(marker);
    // The process takes a moment to appear; `until` is what `e2e.ts` polls this with.
    let pids: number[] = [];
    const appeared = await until(async () => (pids = await pgrep(['-f', marker])).length > 0, {
      timeoutMs: 2_000,
      everyMs: 20,
    });
    expect(appeared, 'the marker process never appeared in the process table').toBe(true);
    expect(pids.length).toBeGreaterThan(0);
  });

  test('an ERROR EXIT rejects rather than reporting nothing', async () => {
    // `pgrep` runs, refuses the option and exits 2: the `close` branch.
    await expect(pgrep(['-Z', 'anything'])).rejects.toThrow(/exited 2/);
  });

  test('and a pgrep that cannot even START rejects too -- the OTHER handler', async () => {
    // Only a missing binary reaches the spawn-failure handler, which is why `pgrep()` takes the name.
    await expect(pgrep(['-f', 'anything'], '/nonexistent/draftgate-not-a-binary')).rejects.toThrow(
      /could not run/
    );
  });
});

describe('orphanedHosts looks where the host is BUILT', () => {
  test('a process running from any build of this layout is counted, and none means none', async () => {
    const layout = hostLayout(`/draftgate-host-root-${process.pid}`);
    expect(orphanedHosts(layout)).toEqual([]);
    sleeper(join(layout.buildDir, '0123456789abcdef', 'draftgate.app', 'Contents', 'MacOS', 'draftgate'));
    let found: number[] = [];
    expect(await until(() => (found = orphanedHosts(layout)).length >= 1, { timeoutMs: 2_000, everyMs: 20 })).toBe(true);
    expect(found.length).toBeGreaterThan(0);
  });
});
