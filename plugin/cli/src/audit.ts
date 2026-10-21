/**
 * The audit log: append-only JSONL, local, one line per review.
 *
 * In the CLI, not the hook adapter, because `runReview` is the one place every review passes
 * through, a hand-driven `draftgate review` included. `review.ts` does no I/O, so `runReview`
 * gathers the record and hands it back, and `main.ts` writes it.
 *
 * Both sides of an edit are stored as markdown, not a diff (`digest.ts`). The converted ADF is not
 * stored either: `core` is pure, so `render(after, destination)` reproduces it.
 *
 * A failed log write never changes a decision: every failure here is a warning on stderr.
 */

import {
  appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isPlainObject } from './json';
import type { Denial, DenialCode } from './types';
import type { AudienceKind } from '../../core/src/index';
import type { AppliedFix } from './surfaces/windowProtocol';

/** Environment override for the log path. Also the switch the tests use to stay out of `~`. */
export const AUDIT_ENV = 'DRAFTGATE_AUDIT_LOG';

/**
 * Where draftgate keeps its own state: this log, the hook adapter's `tools.json` and the other
 * stores. Defined once, so `DRAFTGATE_HOME` cannot move `tools.json` while message bodies keep
 * going to `~/.draftgate/audit.jsonl`.
 */
export function draftgateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DRAFTGATE_HOME || join(homedir(), '.draftgate');
}

export const AUDIT_BASENAME = 'audit.jsonl';

/**
 * The permissions of every file draftgate keeps for itself. The log is the plaintext before/after
 * of every message reviewed, on by default, and 0755/0644 would leave it readable by any other
 * local user. Everything else under `draftgateHome()` names or describes that content.
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * `mkdir -p` the directory a private file is going into, and tighten draftgate's own home if it is
 * looser than the rule.
 *
 * `mkdirSync`'s `mode` applies at creation only, so a `~/.draftgate` that exists at 0755 stays so
 * without the chmod. Only `draftgateHome()` is tightened: `--audit` and `DRAFTGATE_AUDIT_LOG` can
 * point into a directory the operator chose (a team share), which is not draftgate's to narrow.
 * Narrowing only: a home with no group or other bits (say 0500) is left as it is.
 */
export function ensurePrivateDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (resolve(dir) !== resolve(draftgateHome(env))) return;
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // A home we cannot stat or chmod is not a reason to lose a log line; the write below will
    // report its own failure if there is one.
  }
}

/**
 * Write one of draftgate's output files at 0600, narrowing an existing one.
 *
 * `--decision` and `--out` carry the complete approved body. `writeFileSync`'s `mode` applies at
 * creation only, so the chmod is what holds on a rewrite. Throws, unlike `writePrivateFile`: both
 * callers have a `try` that keeps a failed write from changing the decision. A chmod that fails
 * after the bytes landed is a write failure, so `--out` also goes to stdout: twice, not lost.
 */
export function writeOwnedFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

/**
 * Replace one of draftgate's own state files atomically, with the permissions above.
 *
 * Write-then-rename because a file can hold state for more than this write (the watermark file
 * carries every log's mark), and `rename` within a directory is atomic. Returns the error rather
 * than throwing, like `appendAudit`, so it never changes a decision.
 *
 * The scratch name carries the pid. `pruneAudit` rewrites `audit.jsonl`, which concurrent processes
 * write; two crossing a retention boundary on a fixed `<path>.tmp` would both open it with `'w'`,
 * which truncates at open only, so the shorter write lands inside the longer one: a torn line in
 * the middle of the log. A SIGKILL between write and rename leaves one file per pid, which the next
 * process with that pid truncates (the residual `scratch.ts` documents). The failure path unlinks
 * its own.
 */
export function writePrivateFile(path: string, text: string): Error | null {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    ensurePrivateDir(dirname(path));
    writeFileSync(tmp, text, { mode: PRIVATE_FILE_MODE });
    // `mode` applies at creation only, and a crash can leave this path behind at 0644, to be
    // truncated and renamed over the real file. Pids are reused, so the chmod is still needed.
    chmodSync(tmp, PRIVATE_FILE_MODE);
    renameSync(tmp, path);
    return null;
  } catch (e) {
    // Best-effort cleanup of our own scratch file; the caller's error is the one worth reporting.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing to add -- the real failure is already on its way back to the caller.
    }
    return e as Error;
  }
}

/** One edit of a reviewed patch, in the review log (`AuditRecord.patch`). */
export interface PatchAuditRow {
  /** The path the text is written at (`patch.0.new_string`). */
  field: string;
  op: string;
  /** What it applies at, by the payload's key (`old_string`, `anchor`, `from`, `to`). */
  anchors: Record<string, string>;
  /** The flags set `true`, by their window label (`every occurrence`); absent when none. */
  flags?: string[];
  before: string;
  after?: string;
}

/**
 * Everything the log needs, gathered by `runReview` where each fact is known: `main.ts` has the tool
 * input but not the canonical body, the final body or the reason.
 *
 * An absent field and an empty one are different facts throughout (see `fixes`).
 */
export interface AuditRecord {
  destination: string;
  toolName?: string;
  /**
   * The agent session this review came from: Claude Code's `PreToolUse` `session_id`, passed by the
   * hook. Without it a retried draft and a second message look the same, and the digest would count
   * rounds. Not a message identity (two messages to one channel in one session share it), so the
   * digest reports it as the lower end of a bracket.
   *
   * Absent with no `--session` (a direct CLI run) and on older rows; absent groups by routing alone,
   * and nothing turns it into `''`.
   */
  session?: string;
  /** Routing fields (issue key, channel, ...) so a log line says where it was going. */
  context: Record<string, unknown>;
  /**
   * Who the message was going to, when the destination has more than one possible answer.
   *
   * Three-state, like `fixes`: a value is what the reviewer was shown. Absent means none was
   * determined (an older row, Slack or Linear, a Jira project declared not a service desk) and is
   * never read as `'public'`, which feeds the digest's customer-visible count. `'unknown'` is
   * written: the review ran with no classification on file for the target (`jira-projects.json`,
   * `github-repos.json`), a gap the digest counts.
   */
  audience?: AudienceKind;
  outcome: 'approved' | Denial['outcome'];
  /**
   * Which kind of failure this was, for the denials that can say. `outcome` is coarse: `unavailable`
   * covers an unreadable patch and an agent sending ADF (a prompt change) as well as a misrouted tool
   * and a window that would not start (an install problem). The code, never the `reason`, which is
   * prose carrying payload values (wire.md).
   *
   * Absent on an approval, a human's rejection, a timeout and older rows. A code does not mean the
   * gate broke: `blockedDenial` is `rejected` and carries `body/blocked-after-approval`, so the
   * digest keys on the outcome and counts a code only on an `unavailable` row. There, absent means
   * "this reader cannot say" (an older row, an unparseable code) and gets a bucket of its own.
   */
  code?: DenialCode;
  /**
   * True only when a human changed the body, as the surface reports it (`HumanDecision.edited`,
   * measured against `baseline`, what the editor makes of an untouched draft, which also gets undo
   * right). Not derived by comparing with the raw `canonical`: loading a draft normalises it, so an
   * untouched approval differs from `canonical`, and the digest's edit rate would count
   * normalisation as rewrites. A surface that does not report it falls back to that comparison in
   * `runReview`, which is correct there: such a surface sends a body only when the reviewer gave one.
   */
  edited: boolean;
  /**
   * The warning codes draftgate silenced: true of `before`, not of what was sent. This field and
   * the row it draws on screen keep the window from changing a message invisibly (round-trip.md).
   * Only codes in `WARNING_CODES`' `silencedByRoundTrip` column reach here, and not all are
   * improvements: `slack/image-becomes-link` reads the same, `slack/url-label-elided` better, and
   * `jira/task-item-media-only` destroys a checkbox. `surface/silencedWarnings.test.ts` derives that
   * set, so no count of it is kept here.
   *
   * Draftgate's work only: `render(before)` minus the render of the body first shown, narrowed
   * against the live body. Comparing `before` with the live body alone would credit draftgate with
   * every warning the reviewer edited away (`silencedWarnings` in `surface/src/useReview.ts`). Not
   * in `fixes`, which holds the reviewer's own accepted repairs.
   *
   * Three-state, like `fixes`: absent when the surface does not report it (`auto-approve`, a stale
   * `surface/dist`), `[]` when a reporting surface silenced nothing. Codes only, like `warnings`.
   */
  silenced?: string[];
  /**
   * The markdown the agent wrote. Absent when the review had no body (a title-only `issue_write`, a
   * `create_pull_request` with no description), never `''`: an approval of `''` would read as a
   * human approving an empty message, which `body/empty` makes impossible.
   */
  before?: string;
  /**
   * The markdown sent, when it differs from `before`. Absent on a denial and when the sent body is
   * byte-identical; what was sent is `after ?? before`.
   *
   * Not a synonym for `edited`: the window sends the body it displayed, `canonical` after a round
   * trip, so an untouched approval carries `after` (and both bodies) whenever normalisation changed
   * a byte, usually a stripped trailing newline. Human edits are `edited`; `cli/src/digest.ts` keys
   * its edit sample on `edited` and `after` together.
   */
  after?: string;
  /**
   * The prose fields beside the body that the reviewer changed, before and after; `before`/`after`
   * above stay the body. Absent for a review with no prose fields or a surface that does not edit
   * them (`auto-approve`, an older row). Only changed fields appear, so a non-edit is not booked as
   * an edit. Both halves are kept: "Update" -> "Export fails on empty tables" is the signal.
   */
  prose?: { field: string; before: string; after: string }[];
  /**
   * A reviewed patch (`extractPatch`): EVERY edit, in order, since the edits are the message and a
   * patch has no `before`. Each row is the operation as shown (its kind, what it applies at, its
   * set flags), the agent's text as `before`, and the text sent as `after` when the reviewer
   * changed it, so what was sent is `after ?? before` per edit, as for the body. Absent on any
   * review that was not of a patch; a patch draftgate could NOT show records none
   * (`BODY_FAILURES.delta.logs`), since nobody saw one.
   */
  patch?: PatchAuditRow[];
  /** The denial's reason. Absent on approval. */
  reason?: string;
  /**
   * The warning codes that fired on the agent's draft, in order: `render(before).warnings`. The
   * reviewer was shown these minus `silenced`.
   *
   * Stored, unlike the ADF, because a warning set is a fact about what a reviewer was shown at
   * review time: after a profile gains or rewords a warning, a recomputation reports what nobody
   * saw. Codes only, the stable identity `core/src/warnings.ts` promises; no severity, which is not
   * stable across versions. Duplicates are kept: one warning firing four times is a different fact
   * from once, and answers whether a rule is noise.
   */
  warnings: string[];
  /**
   * The repairs the reviewer accepted, in order. Approvals only.
   *
   * Three-state (round-trip.md): `[]` is a reporting surface that saw no
   * repair accepted, so an edit was a rewrite; absent is a surface that cannot report
   * (`auto-approve`), which is unknown and never counted as a rewrite. Nothing on this path writes
   * `?? []`, which would turn "we do not know" into "nothing happened". With `edited`, this separates
   * a mechanical lesson told once from a prose lesson read out of the before/after. Records what was
   * accepted, not what survives in `after`.
   */
  fixes?: AppliedFix[];
  /**
   * Which surface decided this: `webkit`, `auto-approve` or `auto-reject` (`SURFACES` in `args.ts`).
   * A `string`, because the log is append-only and a row may name a surface not in `SURFACES`;
   * nothing here interprets it. Without it a machine approval and a human one are the same shape.
   * Absent means unknown, never a human surface.
   */
  surface?: string;
}

/**
 * Resolve where the log goes. `null` means logging is off.
 *
 * An empty `DRAFTGATE_AUDIT_LOG` counts as off, so an environment that cannot pass a flag can turn
 * it off. The parser rejects `--audit ""`, the opposite policy, and
 * `export DRAFTGATE_AUDIT_LOG="$SOMETHING_UNSET"` turns the log off with output identical to a
 * normal run: hence `auditSilencedByEnv`.
 */
export function auditPath(
  flag: string | undefined,
  disabled: boolean,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (disabled) return null;
  if (flag) return flag;
  const fromEnv = env[AUDIT_ENV];
  if (fromEnv === undefined) return join(draftgateHome(env), AUDIT_BASENAME);
  return fromEnv.trim() === '' ? null : fromEnv;
}

/**
 * Is the log off because the environment emptied it, rather than because someone asked? The caller
 * says so on stderr: otherwise an accidental empty export and `--no-audit` are byte-identical runs.
 */
export function auditSilencedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const fromEnv = env[AUDIT_ENV];
  return fromEnv !== undefined && fromEnv.trim() === '';
}

/**
 * One line as this module writes it: the record, stamped with the time. Exported so a reader states
 * its relaxations against it: a reader that rebuilt the shape would start requiring the next field
 * added to `AuditRecord`, which no existing line carries. See `digest.ts`'s `AuditEntry`.
 */
export type AuditLine = { ts: string } & AuditRecord;

/**
 * Serialise one entry: the record, prefixed with an ISO-8601 UTC `ts`.
 *
 * Exported so a test can assert the line shape, and inject a clock, without touching a disk.
 */
export function auditLine(record: AuditRecord, now: Date = new Date()): string {
  const entry: AuditLine = { ts: now.toISOString(), ...record };
  // One line, no pretty printing: the file is append-only and read line by line.
  return JSON.stringify(entry) + '\n';
}

/**
 * Does the log end with a newline? `false` means the last write was torn (killed, out of disk): the
 * next append would join the fragment, and `parseAuditLog` reads the pair as one malformed entry,
 * `entries 0, malformed 1`.
 *
 * Reads one byte: a real log runs to tens of megabytes and this is on every review's path. A
 * missing or empty file is not torn, and neither is one that cannot be read: the append reports its
 * own failure, and guessing "torn" would insert a stray blank line.
 */
function endsWithNewline(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (size === 0) return true;
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, size - 1);
    return byte[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const MS_PER_DAY = 86_400_000;

/**
 * Is this an ISO-8601 instant, as opposed to something `Date.parse` accepts? The rule for a
 * draftgate timestamp, beside `auditLine`, which writes `ts`.
 *
 * The digest and `pruneAudit` share it. `Date.parse` accepts "December 17, 1995", so with a looser
 * pruner a foreign JSONL would be malformed to the digest and expired to the pruner, and a two-line
 * file of such timestamps would be truncated to empty past the `sawExpired` guard. The shape matters
 * too: these strings sort as text to find a log's span, and a non-ISO one orders by code point.
 * `digest.ts` imports it as a value; nothing here imports from there.
 */
export function isInstant(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
    Number.isFinite(Date.parse(v))
  );
}

/**
 * How much of the file's head to read for the oldest entry's timestamp. `ts` is the first key of
 * every line `auditLine` writes, so the answer is in the first ~34 bytes; 512 is slack for a future
 * field order.
 */
const HEAD_BYTES = 512;

/** `{"ts":"<instant>"` at the very start of a line, which is what this module's own writer emits. */
const HEAD_TS = /^\{"ts":"([^"]{1,64})"/;

/**
 * The oldest entry's timestamp, read without loading the log.
 *
 * `null` means "no cheap answer", never "nothing here": no file, an empty one, or a head not in
 * draftgate's format. Each falls through to the full read, so a torn first line cannot freeze
 * retention.
 *
 * Matches the first key's bytes rather than parsing the first line: the head entry is the oldest
 * and can be a 300 KB draft, so a line-length bound would make every review read the whole file for
 * up to a retention period.
 *
 * Exported for its test: `pruneAudit` answers `null` whether this guard fired or the full read did,
 * so a test of `pruneAudit` alone cannot see a guard that gave up.
 */
export function headTs(path: string): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = Math.min(HEAD_BYTES, fstatSync(fd).size);
    if (size === 0) return null;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    const found = HEAD_TS.exec(buf.toString('utf8'));
    return found !== null && isInstant(found[1]) ? Date.parse(found[1]!) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * When one log line was written, in ms, or `null` if it cannot say. Not `parseAuditLog`, which lives
 * in `digest.ts` (a cycle) and validates a whole record; the `ts` rule is shared through
 * `isInstant`. An undatable line is not dropped for that alone (`pruneAudit`).
 */
function entryTs(line: string): number | null {
  if (line.trim() === '') return null;
  try {
    const raw: unknown = JSON.parse(line);
    if (!isPlainObject(raw) || !isInstant(raw.ts)) return null;
    return Date.parse(raw.ts);
  } catch {
    return null;
  }
}

/**
 * Drop entries older than `retentionDays` (`auditRetentionDays`, `reviewConfig.ts`); `<= 0` keeps
 * everything and does no I/O. Returns the error rather than throwing, like `appendAudit`.
 *
 * The file is append-only, so "older than the cutoff" is a prefix: everything from the first
 * datable line inside the window is kept, an undatable line after it survives (a torn write is no
 * reason to destroy a record), and the order holds. A pruned log reads as `'replaced'` in
 * `markState` (`Mark.firstTs`), so the next digest reports all of what is left.
 *
 * A rewrite is not an `O_APPEND` write: a rename between another process's open and its write loses
 * that line. It runs only when the oldest entry has aged out, about once a day, and risks a log
 * line, never a decision.
 *
 * It prunes whatever log is being written, `--audit` included: every line in it is draftgate's, and
 * pruning only the default path would leave a moved log with no retention, silently.
 */
export function pruneAudit(
  path: string,
  retentionDays: number,
  /** Injected for the tests. Nothing in production passes it. */
  now: number = Date.now()
): Error | null {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return null;
  const cutoff = now - retentionDays * MS_PER_DAY;

  /*
   * Where one line sits relative to the window, written once: the cheap guard and the search both
   * read it, and with two copies a `>=` changed to `>` in the search alone leaves the tests green.
   * `>=`, so an entry exactly `retentionDays` old is kept. Three answers, because `undatable` is
   * not `expired` (see `sawExpired`).
   */
  const place = (line: string): 'expired' | 'within' | 'undatable' => {
    const ts = entryTs(line);
    if (ts === null) return 'undatable';
    return ts >= cutoff ? 'within' : 'expired';
  };

  /*
   * The cheap guard: the oldest entry is the first line, so one small read answers "anything to
   * do?" for every review where nothing ages out, instead of reading several 300 KB drafts. A `null`
   * head falls through to the full read (`headTs`).
   */
  const head = headTs(path);
  if (head !== null && head >= cutoff) return null;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // No log yet, or one we cannot read. Neither is a reason to fail a review, and neither is
    // something pruning can fix.
    return null;
  }

  const lines = text.split('\n');
  let keepFrom = -1;
  let sawExpired = false;
  for (const [i, line] of lines.entries()) {
    const where = place(line);
    if (where === 'within') {
      keepFrom = i;
      break;
    }
    if (where === 'expired') sawExpired = true;
  }

  /*
   * Nothing is removed unless something expired.
   *
   * `keepFrom === -1` is also what a file with no datable line produces, so gating on the index
   * would empty a notes file, or a log without `ts`, that `DRAFTGATE_AUDIT_LOG` points at:
   * "important line one\nimportant line two\n" -> "". An undatable line is not old, it is
   * unreadable. The gate also stops a rewrite per review on an empty log (`split` yields one
   * undatable entry), and covers `keepFrom === 0`, where no earlier line set `sawExpired`.
   */
  if (!sawExpired) return null;

  const kept = keepFrom === -1 ? [] : lines.slice(keepFrom);
  return writePrivateFile(path, kept.join('\n'));
}

/**
 * `pruneAudit`, with the one line a failure gets on stderr. Called on the review's write, on
 * `draftgate digest` and on the hook's `--doctor`, so a log nobody writes to still expires. A
 * failure changes none of their answers.
 */
export function applyRetention(
  path: string,
  retentionDays: number,
  report: (line: string) => void = (line) => process.stderr.write(line)
): void {
  const err = pruneAudit(path, retentionDays);
  if (err) report(`draftgate: could not apply the audit log retention: ${err.message}\n`);
}

/**
 * Append one entry. Returns the error rather than throwing, so the caller decides how loud to be
 * and the decision path cannot be diverted by a logging failure.
 */
export function appendAudit(path: string, record: AuditRecord): Error | null {
  try {
    // 0700 / 0600 (`PRIVATE_FILE_MODE`). `mode` applies at creation only; `ensurePrivateDir`
    // narrows draftgate's own home, and the log file is left alone because `--audit` may name a file
    // the operator created.
    ensurePrivateDir(dirname(path));
    // One `appendFileSync` per entry, opened O_APPEND, so each line is one write to the kernel.
    // Concurrent reviews are real: two Claude Code sessions each fire their own hook. Measured on
    // macOS/APFS: 40 processes appending 25 lines each of ~64 KB (past PIPE_BUF) yield 1000 lines,
    // none unparseable; `cli/test/audit.test.ts` keeps a smaller version. A platform result, not a
    // promise.
    //
    // A leading newline when the previous write was torn, so this record is not swallowed by the
    // fragment. `parseAuditLog` skips blank lines, so two processes healing at once cost an empty line.
    const heal = endsWithNewline(path) ? '' : '\n';
    appendFileSync(path, heal + auditLine(record), { mode: PRIVATE_FILE_MODE });
    return null;
  } catch (e) {
    return e as Error;
  }
}
