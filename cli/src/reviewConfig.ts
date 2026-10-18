/**
 * The three operator knobs draftgate keeps in one file.
 *
 *     ~/.draftgate/config.json
 *     { "version": 1, "reviewSeconds": 1800, "auditRetentionDays": 60, "releaseCheck": true }
 *
 * How long a reviewer gets, how long the audit log keeps what they reviewed, and whether draftgate
 * asks `origin` once a day if a newer release exists (`releaseCheck.ts`).
 *
 * The CLI's file, not the hook adapter's: the deadline is a fact about the reviewer, and read in
 * the adapter it would not apply to `bun cli/src/main.ts review`. `main.ts` reads it and injects it
 * as `timeoutMs`. The ceiling stays in the adapter, which alone knows what registration has to
 * outlive it (`adapters/hook/src/reviewTimeout.ts`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftgateHome } from './audit';
import { isPlainObject } from './json';
import { MAX_TIMEOUT_MS } from './args';
import { DEFAULT_TIMEOUT_MS } from './review';

export const REVIEW_CONFIG_BASENAME = 'config.json';
export const REVIEW_CONFIG_VERSION = 1;

/**
 * How long the audit log keeps a review, when the operator does not say.
 *
 * The log is the plaintext before/after of every message reviewed, on by default; 0600 says who may
 * read it, not how long it should exist. Sixty days is the operator's number: long enough for
 * `draftgate digest` to see a prompt problem across many reviews, short enough that a drafting
 * session does not sit on disk indefinitely. `0` keeps everything, and must be written to apply.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 60;

export interface ReviewConfig {
  /** What the operator asked for, in ms. The shipped default when no file says otherwise. */
  wantedMs: number;
  /**
   * How many days of audit log to keep. `0` means keep everything. Beside `wantedMs` because it is
   * the same kind of fact: only the operator knows it, `main.ts` reads it once and injects it.
   */
  retentionDays: number;
  /**
   * Whether the daily release check runs: the one network call draftgate makes, to `origin` and
   * never to a destination, carrying nothing about a message. `true` unless the file says `false`
   * or exists and cannot be read (`parseReleaseCheck`).
   */
  releaseCheck: boolean;
  /**
   * The problem that turned `releaseCheck` off when the file did not say `false`: a value that is
   * not a boolean, or a file that cannot be read or parsed. `--doctor` prints it in the release
   * paragraph, so it does not claim the file says `false`.
   */
  releaseCheckOffBecause?: string;
  /** Whether a file was there at all, which is different from a file that declared nothing. */
  present: boolean;
  /** Where it came from, so a report never re-derives a path its own input already knows. */
  path: string;
  /** What a file that exists could not give. One line on stderr, like `scratchTargets.ts`. */
  problem?: string;
}

export function reviewConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(draftgateHome(env), REVIEW_CONFIG_BASENAME);
}

/**
 * Every shipped default, in one place: `parseReviewConfig`'s fallback and `loadReviewConfig`'s
 * missing-file return differ only in `present`.
 */
function shippedDefaults(path: string, present: boolean): ReviewConfig {
  return {
    wantedMs: DEFAULT_TIMEOUT_MS,
    retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
    releaseCheck: true,
    present,
    path,
  };
}

/**
 * The answer for a file that exists and cannot be read as a file: bad JSON, not an object, the
 * wrong version. The shipped defaults, except the release check is off: the file might be the one
 * that says `"releaseCheck": false`, and a syntax error elsewhere must not turn the call back on.
 */
function unreadableFile(path: string, problem: string): ReviewConfig {
  return {
    ...shippedDefaults(path, true),
    releaseCheck: false,
    releaseCheckOffBecause: problem,
    problem,
  };
}

/**
 * Parse the config text. Pure, so every degradation is testable with no filesystem.
 *
 * A broken file falls back to the default deadline, never a longer one, and says so.
 *
 * The fields degrade independently: a typo in `reviewSeconds` must not discard a good
 * `auditRetentionDays` beside it. Each field states its own problem and the problems are joined, so
 * a file with two mistakes says two things. Only a file unreadable as a file (bad JSON, not an
 * object, the wrong version) falls back as a whole (`unreadableFile`).
 */
export function parseReviewConfig(text: string, source: string): ReviewConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return unreadableFile(source, `${source} is not valid JSON (${why})`);
  }
  if (!isPlainObject(parsed)) return unreadableFile(source, `${source} is not a JSON object`);
  if (parsed.version !== REVIEW_CONFIG_VERSION) {
    return unreadableFile(
      source,
      `${source} declares version ${JSON.stringify(parsed.version)}, ` +
        `expected ${REVIEW_CONFIG_VERSION}`
    );
  }

  const deadline = parseReviewSeconds(parsed.reviewSeconds, source);
  const retention = parseRetentionDays(parsed.auditRetentionDays, source);
  const release = parseReleaseCheck(parsed.releaseCheck, source);
  const problems = [deadline.problem, retention.problem, release.problem].filter(
    (p): p is string => p !== undefined
  );

  return {
    ...shippedDefaults(source, true),
    wantedMs: deadline.value,
    retentionDays: retention.value,
    releaseCheck: release.value,
    ...(release.problem !== undefined ? { releaseCheckOffBecause: release.problem } : {}),
    ...(problems.length > 0 ? { problem: problems.join('; ') } : {}),
  };
}

/**
 * One field's answer: what to use, and what was wrong with what was written.
 *
 * A `problem` states the consequence of its own fallback, not just the complaint: `main.ts` prints
 * it under a sentence about the deadline and `doctor.ts` in its "Review deadline" paragraph, so a
 * generic complaint would hide which setting fell back.
 */
interface Field<T = number> {
  value: T;
  problem?: string;
}

function parseReviewSeconds(seconds: unknown, source: string): Field {
  if (seconds === undefined) return { value: DEFAULT_TIMEOUT_MS };
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return {
      value: DEFAULT_TIMEOUT_MS,
      problem:
        `${source}: "reviewSeconds" must be a positive number, got ${JSON.stringify(seconds)}; ` +
        'the review continues on the default deadline',
    };
  }
  const ms = Math.round(seconds * 1000);
  // The bound `--timeout` enforces (`MAX_TIMEOUT_MS`). A registration derives its `timeout` from this number
  // (`hookTimeoutSecondsFor`), so an unchecked value would be frozen into `settings.json`.
  if (ms > MAX_TIMEOUT_MS) {
    return {
      value: DEFAULT_TIMEOUT_MS,
      problem:
        `${source}: "reviewSeconds" must be at most ${Math.floor(MAX_TIMEOUT_MS / 1000)} ` +
        `(about 24 days), got ${seconds}; larger values overflow the timer and deny at once, so ` +
        'the review continues on the default deadline',
    };
  }
  return { value: ms };
}

/**
 * `auditRetentionDays`: a whole number of days, or `0` to keep everything.
 *
 * A bad value falls back to sixty days, not zero: zero keeps every reviewed message forever, and a
 * typo must not become an unbounded retention nobody chose. Whole days only, so no fraction is
 * silently rounded into a number the file does not hold.
 */
function parseRetentionDays(days: unknown, source: string): Field {
  if (days === undefined) return { value: DEFAULT_AUDIT_RETENTION_DAYS };
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
    return {
      value: DEFAULT_AUDIT_RETENTION_DAYS,
      problem:
        `${source}: "auditRetentionDays" must be a whole number of days, 0 or more ` +
        `(0 keeps everything), got ${JSON.stringify(days)}; the log keeps ` +
        `${DEFAULT_AUDIT_RETENTION_DAYS} days`,
    };
  }
  return { value: days };
}

/**
 * `releaseCheck`: `true` or `false`, and absent is `true`.
 *
 * A value that is neither falls back to off, the opposite of the shipped default: somebody who wrote
 * the key at all was most likely turning the check off (`"false"`, `0`, `"no"`). The problem says so.
 */
function parseReleaseCheck(value: unknown, source: string): Field<boolean> {
  if (value === undefined) return { value: true };
  if (typeof value !== 'boolean') {
    return {
      value: false,
      problem:
        `${source}: "releaseCheck" must be true or false, got ${JSON.stringify(value)}; ` +
        'the daily release check stays off until it is one of the two',
    };
  }
  return { value };
}

export function loadReviewConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const path = reviewConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    // Absent is the ordinary state. A file that is there and cannot be read (a permission, a macOS
    // privacy denial) gets `unreadableFile`, like one that does not parse. The sentence and codes are
    // `readConfigText`'s (`configFiles.ts`), which cannot be called here: it reads an empty file as
    // absent, and this file must report an empty one as bad JSON.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return shippedDefaults(path, false);
    return unreadableFile(path, `${path}: could not be read (${code ?? (e as Error).message})`);
  }
  return parseReviewConfig(text, path);
}
