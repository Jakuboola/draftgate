/**
 * Child processes the CLI runs under a deadline, and asking whether one is gone.
 *
 * One runner behind the window, its rebuild, the WebKit host's build (`reviewHost.ts`) and the
 * release check. Settling on `close` alone waits for every process holding the child's pipes, so a
 * killed `clang` whose `ld` is still linking would hold the build past its deadline.
 *
 * Node APIs only: it runs inside the CLI.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export type ChildOutcome =
  | {
      kind: 'exit';
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
      /** stdout alone, from its start, when `stdoutCap` asked for it. */
      stdout?: string;
    }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/**
 * Spawn a child, keep the tail of what it says, and SIGKILL it at the deadline.
 *
 * - `timer` is a `let` declared before `settle`, which closes over it. As a `const` below the spawn,
 *   the spawn-failure path would call `settle` while `timer` is in its temporal dead zone and throw
 *   a ReferenceError that hides the real spawn error.
 * - SIGKILL, no SIGTERM and no escalation: the kill must be done when the timer callback returns,
 *   because `main.ts` exits the moment an outcome exists (see `TIMEOUT_BACKSTOP_MS` in `review.ts`).
 *   On macOS, SIGKILL to the WebKit host takes its WebContent process with it (`surface:host`,
 *   "nothing outlives a killed host").
 * - `close`, not `exit`: `close` fires once stdio has drained. Read at `exit`, the captured output
 *   can be half-written, and a test of it passes only on scheduling luck.
 * - Nothing it prints can reach our stdout, which carries the approved payload and nothing else.
 * - `group` kills the child's whole process group, for a child whose helpers do not go with it.
 *   A SIGKILL to `git ls-remote` against a remote that never answers leaves `git remote-http` and
 *   `git-remote-http` running, reparented to launchd and still connected. `detached` gives the
 *   child a group of its own, so the kill reaches its helpers and nothing else.
 * - `output` is a diagnostic tail, both streams merged. A caller that parses stdout asks for
 *   `stdoutCap` instead: stdout alone, from its start, up to the cap, whatever `captureStdout` says.
 *   A tail would drop the head of a listing, which for `ls-remote` is `refs/heads/stable`.
 */
export function runChild(
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    captureStdout: boolean;
    timeoutMs: number;
    group?: boolean;
    stdoutCap?: number;
  }
): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolveOutcome) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A promise settles once anyway; `timer` is what must not outlive the first outcome.
    const settle = (outcome: ChildOutcome) => {
      if (timer) clearTimeout(timer);
      resolveOutcome(outcome);
    };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        // `stdoutCap` is a reader of stdout, so it opens the pipe itself: a cap on an ignored
        // stream would come back empty and look like a child that printed nothing.
        stdio: [
          'ignore',
          opts.captureStdout || opts.stdoutCap !== undefined ? 'pipe' : 'ignore',
          'pipe',
        ],
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.group ? { detached: true } : {}),
      });
    } catch (e) {
      settle({ kind: 'error', message: (e as Error).message });
      return;
    }

    let output = '';
    const keep = (chunk: string) => {
      output = (output + chunk).slice(-4000);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', keep);
    }
    let stdout = '';
    const cap = opts.stdoutCap;
    if (cap !== undefined) {
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < cap) stdout = (stdout + chunk).slice(0, cap);
      });
    }

    timer = setTimeout(() => {
      try {
        // A negative pid is the group, which `detached` made the child's own.
        if (opts.group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone: what the kill was for.
      }
      settle({ kind: 'timeout' });
    }, opts.timeoutMs);

    child.on('error', (e) => settle({ kind: 'error', message: e.message }));
    child.on('close', (code, signal) =>
      settle({ kind: 'exit', code, signal, output, ...(cap !== undefined ? { stdout } : {}) })
    );
  });
}

/**
 * Is this pid gone? `kill(pid, 0)` delivers nothing: it asks whether the process exists. EPERM
 * means it does and belongs to someone else, which is not gone.
 */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
