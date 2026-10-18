/**
 * `pruneAudit`: keeps the audit log from being a permanent archive. Every assertion reads the file
 * back, never the return value, which says only whether something failed.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headTs, MS_PER_DAY, PRIVATE_FILE_MODE, pruneAudit } from '../src/audit';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-prune-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * MS_PER_DAY).toISOString();

/** One log line, dated. The other fields are whatever a record carries; only `ts` is read. */
const line = (n: number, body: string) =>
  JSON.stringify({ ts: daysAgo(n), destination: 'jira', outcome: 'approved', before: body });

let seq = 0;
function logOf(...lines: string[]): string {
  const path = join(dir, `log-${seq++}.jsonl`);
  writeFileSync(path, lines.length === 0 ? '' : lines.join('\n') + '\n');
  return path;
}

/**
 * Assert `pruneAudit` did not touch the file at all. mtime, not content: several cases would
 * produce byte-identical output if the file were rewritten, so content passes with the guard idle.
 */
function untouched(path: string, days = 60): void {
  const before = statSync(path).mtimeMs;
  const text = readFileSync(path, 'utf8');
  expect(pruneAudit(path, days, NOW)).toBeNull();
  expect(statSync(path).mtimeMs).toBe(before);
  expect(readFileSync(path, 'utf8')).toBe(text);
}

/** The `ts` of every entry left on disk, oldest first. */
function tsLeft(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l).ts as string);
}

describe('pruneAudit', () => {
  test('drops entries past the window and keeps the rest, in file order', () => {
    const path = logOf(line(90, 'ancient'), line(70, 'old'), line(10, 'recent'), line(0, 'today'));
    expect(pruneAudit(path, 60, NOW)).toBeNull();
    expect(tsLeft(path)).toEqual([daysAgo(10), daysAgo(0)]);
  });

  test('an entry exactly at the boundary is KEPT', () => {
    // `>= cutoff`, not `>`: never delete the day the operator asked to keep.
    const path = logOf(line(60, 'boundary'), line(1, 'recent'));
    pruneAudit(path, 60, NOW);
    expect(tsLeft(path)).toEqual([daysAgo(60), daysAgo(1)]);
  });

  test('a log entirely inside the window is not rewritten at all', () => {
    const path = logOf(line(3, 'a'), line(1, 'b'));
    untouched(path);
    expect(tsLeft(path)).toEqual([daysAgo(3), daysAgo(1)]);
  });

  test('a log entirely past the window is emptied', () => {
    const path = logOf(line(400, 'a'), line(300, 'b'));
    expect(pruneAudit(path, 60, NOW)).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  test('0 keeps everything, and does so without touching the file', () => {
    const path = logOf(line(4000, 'ancient'));
    untouched(path, 0);
    expect(tsLeft(path)).toEqual([daysAgo(4000)]);
  });

  describe('nothing is removed unless something actually EXPIRED', () => {
    /*
     * `keepFrom === -1` reads as "the whole file is past the cutoff", but a file with no datable
     * line produces it too, so acting on it alone would empty a file that is not draftgate JSONL.
     * Reachable through `--audit`.
     */
    test('a file with no datable line is left completely alone', () => {
      const path = join(dir, 'notes.txt');
      writeFileSync(path, 'important line one\nimportant line two\n');
      untouched(path);
    });

    test('nor one whose timestamps Date.parse accepts but ISO-8601 does not', () => {
      // `Date.parse` accepts "December 17, 1995"; `isInstant` does not. Under `Date.parse` these
      // lines read as expired, `sawExpired` is true, and the file is emptied.
      const path = join(dir, 'foreign.jsonl');
      writeFileSync(
        path,
        '{"ts":"December 17, 1995","note":"keep me"}\n{"ts":"January 2, 1996","note":"me too"}\n'
      );
      untouched(path);
    });

    test('an empty log is not rewritten on every review', () => {
      // `split` yields one undatable entry, so without the guard every review pays a tmp-write, a
      // chmod and a rename to write nothing back.
      const path = join(dir, 'empty.jsonl');
      writeFileSync(path, '');
      untouched(path);
    });

    test('an undatable line before an in-window one survives when nothing has expired', () => {
      // Prefix truncation would drop it, but unreadable is not old.
      const path = logOf('garbage', line(2, 'recent'));
      untouched(path);
      expect(readFileSync(path, 'utf8')).toContain('garbage');
    });

    test('but it does NOT protect a file where something genuinely aged out', () => {
      // The gate is "something expired", not "everything is datable", or one torn line would freeze
      // retention.
      const path = logOf('garbage', line(90, 'ancient'), line(2, 'recent'));
      pruneAudit(path, 60, NOW);
      const left = readFileSync(path, 'utf8');
      expect(left).not.toContain('garbage');
      expect(left).not.toContain('ancient');
      expect(tsLeft(path)).toEqual([daysAgo(2)]);
    });
  });

  test('a missing log is not an error', () => {
    expect(pruneAudit(join(dir, 'nope.jsonl'), 60, NOW)).toBeNull();
  });

  test('what it rewrites, it rewrites 0600', () => {
    // It holds the plaintext of every message in the window. `mode` is honoured at creation only,
    // which is why `writePrivateFile` chmods.
    const path = logOf(line(90, 'ancient'), line(1, 'recent'));
    pruneAudit(path, 60, NOW);
    expect(statSync(path).mode & 0o777).toBe(PRIVATE_FILE_MODE);
  });

  describe('a line it cannot date', () => {
    test('is kept when it sits after the cutoff', () => {
      // A torn write is not evidence a record should be destroyed; prefix truncation keeps it.
      const path = logOf(line(90, 'ancient'), line(1, 'recent'), '{"half-writ');
      pruneAudit(path, 60, NOW);
      const left = readFileSync(path, 'utf8');
      expect(left).toContain('{"half-writ');
      expect(left).not.toContain('ancient');
    });

    test('and does not stop the prune when it sits BEFORE it', () => {
      // An undatable head must fall through to the full read, or one torn line freezes retention
      // forever.
      const path = logOf('not json at all', line(90, 'ancient'), line(2, 'recent'));
      pruneAudit(path, 60, NOW);
      const left = readFileSync(path, 'utf8');
      expect(left).not.toContain('not json at all');
      expect(left).not.toContain('ancient');
      expect(tsLeft(path)).toEqual([daysAgo(2)]);
    });
  });

  describe('a very large first entry', () => {
    /*
     * The head carries the draft it reviewed, so a 300 KB head is ordinary. A guard that reads a
     * bounded line falls through to a whole-file read on every review for a full retention period;
     * `headTs` reads a fixed 512-byte prefix, since `auditLine` writes `ts` first.
     */
    const huge = () => line(90, 'x'.repeat(300 * 1024));

    test('still prunes correctly', () => {
      const path = logOf(huge(), line(1, 'recent'));
      pruneAudit(path, 60, NOW);
      expect(tsLeft(path)).toEqual([daysAgo(1)]);
    });

    test('and does not disable the cheap guard when it is INSIDE the window', () => {
      const path = logOf(line(3, 'x'.repeat(300 * 1024)), line(1, 'recent'));
      untouched(path);
      // On `headTs` directly: a full read also produces no rewrite, so `untouched` passes either
      // way. A `headTs` that gives up on a large head fails only this line.
      expect(headTs(path)).toBe(Date.parse(daysAgo(3)));
    });
  });

  test('pruning twice is the same as pruning once', () => {
    const path = logOf(line(90, 'ancient'), line(5, 'recent'));
    pruneAudit(path, 60, NOW);
    const after = readFileSync(path, 'utf8');
    pruneAudit(path, 60, NOW);
    expect(readFileSync(path, 'utf8')).toBe(after);
  });

  test('the pruned file is still appendable as JSONL', () => {
    // Without a final newline the next append concatenates onto the last entry and both are lost
    // as malformed.
    const path = logOf(line(90, 'ancient'), line(5, 'recent'), line(1, 'newer'));
    pruneAudit(path, 60, NOW);
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter((l) => l.trim() !== '')).toHaveLength(2);
  });
});
