/**
 * The scratch directory a review passes its payload through, and the signals that would strand it.
 *
 * A `finally` does not run when the process dies by signal, so `scratchDir` also removes it on
 * SIGINT, SIGTERM and SIGHUP. A real subprocess and a real signal: nothing in-process can tell "the
 * handler is registered" from "the handler runs and removes the directory".
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchDir } from '../src/scratch';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-scratch-test-'));
// Without this the directory leaks into $TMPDIR on every run; `test/tempDirs.test.ts` is the guard.
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REPO = join(import.meta.dir, '..', '..');

/**
 * Run a child that makes a scratch directory, announces its path, and then waits forever.
 * Resolves once the path has been announced.
 */
function childHoldingAScratch(tmp: string): Promise<{ pid: number; scratch: string; done: Promise<void> }> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `import { scratchDir } from ${JSON.stringify(join(REPO, 'cli', 'src', 'scratch.ts'))};\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `const s = scratchDir('draftgate-signal-test-');\n` +
        `writeFileSync(join(s.dir, 'request.json'), 'the draft');\n` +
        `console.log(s.dir);\n` +
        `setInterval(() => {}, 1000);\n`,
    ],
    { cwd: REPO, env: { ...process.env, TMPDIR: tmp } }
  );

  const done = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return new Promise((resolve) => {
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
      const line = out.split('\n')[0];
      if (out.includes('\n') && line) resolve({ pid: child.pid!, scratch: line.trim(), done });
    });
  });
}

describe('a scratch directory does not outlive its process', () => {
  test('SIGTERM removes it, which a `finally` would not', async () => {
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    const { pid, scratch, done } = await childHoldingAScratch(tmp);

    expect(existsSync(scratch)).toBe(true);
    expect(readFileSync(join(scratch, 'request.json'), 'utf8')).toBe('the draft');

    process.kill(pid, 'SIGTERM');
    await done;

    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  test('SIGINT too, which is Ctrl+C at a terminal', async () => {
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    const { pid, scratch, done } = await childHoldingAScratch(tmp);
    process.kill(pid, 'SIGINT');
    await done;
    expect(existsSync(scratch)).toBe(false);
  }, 30_000);

  test('SIGKILL still strands it, and the residual is bounded to 0700', async () => {
    // `-9` cannot be caught (the module's header says so); the mode makes it litter, not exposure.
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    const { pid, scratch, done } = await childHoldingAScratch(tmp);
    process.kill(pid, 'SIGKILL');
    await done;
    expect(existsSync(scratch)).toBe(true);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
  }, 30_000);
});

describe('scratchDir in process', () => {
  test('release() removes the directory and can be called twice', () => {
    const s = scratchDir('draftgate-release-test-');
    expect(existsSync(s.dir)).toBe(true);
    s.release();
    expect(existsSync(s.dir)).toBe(false);
    expect(() => s.release()).not.toThrow();
  });

  test('release() takes its signal handlers away, so reviews do not accumulate them', () => {
    const before = process.listenerCount('SIGTERM');
    const a = scratchDir('draftgate-handler-test-');
    const b = scratchDir('draftgate-handler-test-');
    expect(process.listenerCount('SIGTERM')).toBe(before + 2);
    a.release();
    b.release();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
