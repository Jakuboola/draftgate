/**
 * Write to stdout and wait for it to drain, for both processes whose stdout is a contract.
 *
 * `process.stdout.write` is asynchronous when stdout is a pipe, and both entry points end in
 * `process.exit`. Exiting before the drain silently truncates the write at whatever the pipe held,
 * producing invalid JSON, on both legs:
 *
 *  - the CLI's approved payload: a 300 KB payload comes out as exactly 131072 bytes. A unit test
 *    that stubs `process.stdout.write` cannot see it.
 *  - the HOOK's decision: a 1 MB decision comes out cut short through real Claude Code, and as
 *    exactly 65,536 bytes into a kernel pipe whose reader starts a second late. Claude Code reads a
 *    truncated decision as plain text, takes no permission decision from it, and runs the tool with
 *    the agent's ORIGINAL input -- so a reviewer's edited, approved Jira comment goes out as the
 *    unedited raw markdown. A round trip through `spawnSync` cannot see it, because `spawnSync`
 *    drains as the child writes.
 *
 * One copy for both, in `cli/` because the hook imports from there.
 *
 * An EPIPE rejects; `readerHungUp` below is the opt-in for a caller whose reader is a human. The
 * hook turns a failed decision write into exit 1 (`answer` in `adapters/hook/src/main.ts`), which
 * the fail-closed registration answers `ask` for (`adapters/hook/src/hookCommand.ts`).
 * `test/stdoutWrites.test.ts` fails on a bare `process.stdout.write` anywhere else.
 */
export function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Did a write fail because the reader went away?
 *
 * `draftgate digest | head`, or a pager the reader quits, closes the pipe mid-write, the ordinary
 * Unix ending. Without this the command exits 1 with
 * `draftgate: unexpected failure: Error: EPIPE: broken pipe, write`.
 *
 * Opt-in (the digest path, the hook's print modes), never in `review`: there an EPIPE means an
 * approved payload did not reach the caller, and swallowing it would report a send that never left.
 */
export function readerHungUp(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'EPIPE';
}
