#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * One thing per command is on stdout (`review`: the approved payload; `digest`: the digest), and
 * every human-facing byte goes to stderr (wire.md).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, ArgError, COMMAND_HELP, HELP, type ParsedArgs } from './args';
import {
  appendAudit, applyRetention, auditPath, auditSilencedByEnv, draftgateHome, writeOwnedFile,
  writePrivateFile,
} from './audit';
import { bodyFieldFor, proseFieldsComplaint } from './payload';
import { claimedRouteFacts } from './routeFacts';
import { classificationStore } from './classificationStores';
import {
  buildDigest,
  formatDigest,
  markFor,
  markState,
  parseAuditLog,
  parseWatermarkFile,
  withMark,
  WATERMARK_BASENAME,
  type ParsedLog,
  type WatermarkFile,
} from './digest';
import { readScratchList } from './scratchTargets';
import { loadReviewConfig } from './reviewConfig';
import { runHookMode } from './hookModes';
import { encodeDecisionFile } from './decisionFile';
import { readerHungUp, writeStdout } from './stdout';
import { oneLine } from './text';
import { runReview } from './review';
import { webkitSurface } from './surfaces/webkit';
import { autoApprove, autoReject } from './surfaces/autoApprove';
import type { ReviewOutcome, ReviewSurface } from './types';

function readInput(path: string): string {
  if (path === '-') return readFileSync(0, 'utf8');
  return readFileSync(path, 'utf8');
}

/**
 * Write the machine-readable outcome, if `--decision` asked for one.
 *
 * Approval and denial alike, so an adapter never scans stderr for a decision. A failure here is
 * reported and nothing more: it must not turn an approval into a denial.
 */
function writeDecisionFile(args: ParsedArgs, outcome: ReviewOutcome): void {
  if (!args.decision) return;
  // Encoded beside its decoder, so one test table can hold the two together. See `decisionFile.ts`.
  const file = encodeDecisionFile(outcome, args.surface);
  try {
    // 0600: this file carries the whole approved payload, exactly like the audit log.
    writeOwnedFile(args.decision, JSON.stringify(file));
  } catch (e) {
    process.stderr.write(`draftgate: could not write --decision ${args.decision}: ${(e as Error).message}\n`);
  }
}

/**
 * Append one audit log entry, if logging is on.
 *
 * A logging failure is reported on stderr and the review proceeds (`audit.ts`).
 *
 * The session is stamped here, at the one place a record is written, rather than threaded through
 * `ReviewOptions` into every row `runReview` builds: it is a fact about this invocation, and it
 * cannot be forgotten on `body/missing-field`, the one outcome that lets a send through unreviewed.
 */
function writeAudit(
  args: ParsedArgs,
  record: ReviewOutcome['audit'],
  /**
   * How many days of log to keep, from `~/.draftgate/config.json`. `0` keeps everything. Applied
   * wherever the log is written, and on `digest` and `--doctor`, so it expires once nobody writes.
   */
  retentionDays: number
): void {
  const logPath = auditPath(args.audit, args.noAudit);
  if (!logPath) {
    // Say so, unless the reviewer asked for it: an empty `DRAFTGATE_AUDIT_LOG` disables the log, and
    // in silence an accidental export would look like a normal run.
    if (!args.noAudit && auditSilencedByEnv()) {
      process.stderr.write(
        'draftgate: DRAFTGATE_AUDIT_LOG is set but EMPTY, so this review was not logged. ' +
          'Unset it to log to the default path, or pass --no-audit if that is what you meant.\n'
      );
    }
    return;
  }
  // Prune before appending: a rewrite is the one thing that can lose a concurrent `O_APPEND` line
  // (see `pruneAudit`), so this invocation's line lands after it.
  applyRetention(logPath, retentionDays);
  // Spread so an absent session stays absent (`AuditRecord.session`); the digest then groups by
  // routing alone.
  const err = appendAudit(logPath, {
    ...record,
    ...(args.sessionId ? { session: args.sessionId } : {}),
  });
  if (err) process.stderr.write(`draftgate: could not write the audit log: ${err.message}\n`);
}

/**
 * `draftgate digest`: read the audit log, print counts, interpret nothing.
 *
 * Every failure here is reported and returns 1 without touching the watermark: unlike the review
 * path, a reader loses nothing by being strict. Its one write to the log is retention, and only to
 * the log reviews write.
 */
async function digestCommand(args: ParsedArgs): Promise<number> {
  // `false` for `disabled`: `--no-audit` is rejected by the parser for this command, because
  // "do not write a log" is not a thing a reader can honour.
  const logPath = auditPath(args.audit, false);
  if (!logPath) {
    process.stderr.write(
      `draftgate: the audit log is disabled (${'DRAFTGATE_AUDIT_LOG'} is set to empty), ` +
        'so there is nothing to read. Pass --audit <path> to read a specific log.\n'
    );
    return 1;
  }

  // Retention first, so an idle log still expires and what is counted is what is kept. Never on a
  // file named with `--audit`: that is somebody's archive, and a count must not destroy it.
  const reviewConfig = loadReviewConfig();
  if (!args.audit) {
    if (reviewConfig.problem) process.stderr.write(`draftgate: ${reviewConfig.problem}\n`);
    applyRetention(logPath, reviewConfig.retentionDays);
  }

  // Read and parse in one expression, for clarity: on bun 1.4.0 a 30 MB log uses the same heap
  // either way.
  let log: ParsedLog;
  try {
    log = parseAuditLog(readFileSync(logPath, 'utf8'));
  } catch (e) {
    // No log yet is normal before the first review, but still a failed read, not an empty digest.
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    process.stderr.write(
      missing
        ? `draftgate: no audit log at ${logPath} yet -- nothing has been reviewed.\n`
        : `draftgate: could not read ${logPath}: ${(e as Error).message}\n`
    );
    return 1;
  }

  const markPath = join(draftgateHome(), WATERMARK_BASENAME);
  // Absolute, because the mark is keyed by it: `--audit ./audit.jsonl` and the default path must
  // not end up as two separate keys for one file.
  const markKey = resolve(logPath);
  let markFile: WatermarkFile | null = null;
  /*
   * A watermark file that exists but this build cannot read, as opposed to no file yet. For the
   * write below the two are opposite: `parseWatermarkFile` returns null for a newer version or a
   * corrupt file, and `withMark(null, ...)` would build a fresh file holding only this log's mark,
   * silently dropping every other log's. Reading stays silent: the digest says "never marked".
   */
  let markFileUnreadable = false;
  try {
    markFile = parseWatermarkFile(JSON.parse(readFileSync(markPath, 'utf8')));
    markFileUnreadable = markFile === null;
  } catch (e) {
    markFileUnreadable = (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  // Scratch targets, read here and injected so `buildDigest` is testable with no filesystem. A file
  // that is present and broken says so once on stderr; absent is silent here, because the digest
  // prints a line saying nothing was held apart.
  const scratch = readScratchList();
  if (scratch.problem) {
    process.stderr.write(`draftgate: ${scratch.problem}\n`);
  }
  const digest = buildDigest(log, {
    limit: args.limit ?? 0,
    // What the mark means for this file, decided once: `markState` also says whether it can be
    // trusted, and `buildDigest` slices from that.
    mark: markState(markFor(markFile, markKey), log.entries),
    sinceLast: args.sinceLast,
    scratch: scratch.targets,
    includeScratch: args.includeScratch,
  });

  // The release notice a review carries, on stderr: it is about this install, and stdout is the
  // digest alone, `--json` included. Imported here: a review never reads it, and the CLI is spawned
  // for every one.
  const notice = (await import('./releaseCheck')).currentReleaseNotice(reviewConfig);
  if (notice) process.stderr.write(`${notice}\n`);

  // Drained, like the approved payload: a digest carrying twenty before/after pairs is easily past
  // the 128 KB pipe buffer, and this command's output is meant to be piped into an agent.
  try {
    await writeStdout(
      args.json ? JSON.stringify(digest, null, 2) + '\n' : formatDigest(digest, logPath)
    );
  } catch (e) {
    if (!readerHungUp(e)) throw e;
    // `head`, or a pager quit early. Returns before `--mark`, so a digest nobody finished reading
    // does not move the boundary.
    return 0;
  }

  if (args.mark && markFileUnreadable) {
    // Refuse rather than overwrite: rewriting costs every other log its mark, and a newer draftgate
    // its format.
    process.stderr.write(
      `draftgate: ${markPath} exists but this build cannot read it (a newer format, or corrupt), ` +
        'so it was NOT rewritten -- that would discard every other log\'s mark. ' +
        'The digest above is complete; move the file aside to start marking again.\n'
    );
  } else if (args.mark) {
    const next = withMark(markFile, markKey, {
      lines: log.entries.length,
      markedAt: new Date().toISOString(),
      // The file's identity, so a log rotated and grown back past this count is recognised rather
      // than silently sliced. See `Mark.firstTs`.
      ...(log.entries[0] ? { firstTs: log.entries[0].ts } : {}),
    });
    // `writePrivateFile`: 0700/0600 and write-then-rename, as for the log. The digest is already
    // out, so a failed mark costs the next run its "since" line and is a warning.
    const err = writePrivateFile(markPath, JSON.stringify(next));
    if (err) process.stderr.write(`draftgate: could not write ${markPath}: ${err.message}\n`);
  }
  return 0;
}

function surfaceFor(kind: ParsedArgs['surface']): ReviewSurface {
  switch (kind) {
    case 'auto-approve': return autoApprove();
    case 'auto-reject': return autoReject('rejected by --surface auto-reject');
    // The window, the default. When it cannot be built or opened it is `unavailable`, which the
    // adapter turns into a permission prompt.
    default: return webkitSurface();
  }
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      process.stderr.write(`draftgate: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (args.command === 'help') {
    process.stderr.write(args.helpFor === undefined ? HELP : COMMAND_HELP[args.helpFor]);
    return 0;
  }
  if (args.command === 'version') {
    // The release this checkout carries, read as the release check reads it: the newest `vX.Y.Z`
    // tag reachable from HEAD. A git that cannot answer says so, not "unreleased".
    const { CHECKOUT, headCommit, installedRelease, versionTag } = await import('./releaseCheck');
    // A plugin's version folder has no git: its manifest says which release it is, as it tells
    // Claude Code.
    const manifest = (await import('./claudePlugin')).pluginManifest(CHECKOUT);
    if (manifest !== null) {
      process.stderr.write(
        `${versionTag(manifest.version) ?? `unreleased (the plugin's version, ${oneLine(manifest.version)}, is not a release)`}\n`
      );
      return 0;
    }
    const local = installedRelease(CHECKOUT);
    const head = headCommit(CHECKOUT)?.slice(0, 7) ?? 'HEAD';
    if ('failed' in local) {
      process.stderr.write(`unknown (git could not list the tags at ${head}: ${local.failed})\n`);
      return 1;
    }
    process.stderr.write(`${local.have ?? `unreleased (no vX.Y.Z tag reachable from ${head})`}\n`);
    return 0;
  }
  // Imported here, not at the top, like the release check: the CLI is spawned for every review.
  if (args.command === 'uninstall') {
    const { uninstall, uninstallContext } = await import('./uninstall');
    return uninstall(uninstallContext(args.deleteDir ?? null));
  }
  if (args.command === 'register') return runHookMode('--register');
  if (args.command === 'doctor') return runHookMode('--doctor', ...(args.setup ? ['--setup'] : []));
  if (args.command === 'propose-tools') return runHookMode('--propose-tools', ...args.proposeArgs!);
  if (args.command === 'digest') return digestCommand(args);

  let toolInput: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readInput(args.input!));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      process.stderr.write('draftgate: payload must be a JSON object\n');
      return 1;
    }
    toolInput = parsed as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(`draftgate: could not read payload: ${(e as Error).message}\n`);
    return 1;
  }

  /*
   * The one destination fact draftgate cannot derive: which Jira projects are service desks, and
   * which GitHub repositories are public. Loaded here, at the I/O edge, so `review.ts` stays
   * testable with no filesystem. A missing file says nothing; one that exists and cannot be used
   * says so once.
   *
   * Only for the destination under review (`CLASSIFICATION_STORES`; Slack and Linear have none).
   */
  const store = classificationStore(args.destination!);
  const classifications = store?.load();
  if (classifications?.problem) {
    // Says what was kept, not just what broke: both parsers give partial credit, so one typo in
    // forty projects leaves the other thirty-nine declared.
    process.stderr.write(
      `draftgate: ${classifications.problem}\n` +
        'draftgate: the review continues; anything not declared is reported as an unknown ' +
        'audience.\n'
    );
  }

  // The review deadline when the caller did not state one (`reviewConfig.ts`). `--timeout` wins:
  // the hook adapter always passes it, bounded by what its registration can outlive.
  const reviewConfig = loadReviewConfig();
  if (reviewConfig.problem) {
    // The problem carries its own consequence; do not add one here. See `Field` in `reviewConfig.ts`.
    process.stderr.write(`draftgate: ${reviewConfig.problem}\n`);
  }

  /*
   * A prose field may not be the body, as `parseRoute` refuses in `tools.json`. `--body-field
   * fields.description --prose-field fields.description` would draw it as a single-line input and as
   * the editor, and `buildUpdatedInput` writes the prose first and the body over it, discarding what
   * the reviewer typed in the input. Here, not in `args.ts`, which checks one flag at a time.
   */
  const complaint = proseFieldsComplaint(
    bodyFieldFor(args.destination!, args.bodyField),
    args.proseFields ?? []
  );
  if (complaint !== null) {
    process.stderr.write(`draftgate: ${complaint}\n`);
    return 2;
  }

  // No try/catch: every way a review can fail comes back as a structured outcome, so the audit
  // record is built in one place.
  const outcome = await runReview({
    destination: args.destination!,
    toolInput,
    toolName: args.toolName,
    surface: surfaceFor(args.surface),
    surfaceName: args.surface,
    timeoutMs: args.timeoutMs ?? reviewConfig.wantedMs,
    ...(args.inferredFrom ? { inferredFrom: args.inferredFrom } : {}),
    // Every route fact this invocation states, from the one table of them. Dropped here, the window
    // shows the body alone; `cli/test/cli.test.ts`'s "the route facts reach the review itself"
    // asserts each where its consequence is visible.
    ...claimedRouteFacts(args),
    // Exactly the facts this destination's own store supplies, and nothing for a destination that
    // has no such question.
    audienceFacts: classifications?.facts ?? {},
    // Which file a classification belongs in, chosen by destination, never by value (audience.md).
    // An answer matching a declaration on file says nothing (`ClassificationStore.remember`).
    rememberProject: (context, type) => {
      const said = store?.remember(context, type);
      if (said) process.stderr.write(`draftgate: ${said}\n`);
    },
  });

  /*
   * The decision first, then the log. `writeAudit` can prune, which rewrites a log of several
   * 300 KB drafts, and the review may already have spent its deadline down to the grace
   * `reviewTimeout.ts` reserves before Claude Code's fail-open hook timeout. A crash between the two
   * then loses a log row, not the decision. The log is written for every outcome, failures included.
   */
  writeDecisionFile(args, outcome);
  writeAudit(args, outcome.audit, reviewConfig.retentionDays);

  if (outcome.exitCode === 0) {
    const json = JSON.stringify(outcome.updatedInput, null, 2) + '\n';
    let wrote = false;
    if (args.output) {
      try {
        // 0600, like the decision file: this is the message about to be sent.
        writeOwnedFile(args.output, json);
        wrote = true;
      } catch (e) {
        // An approved payload must never be lost to a bad --out path. Fall through to stdout so
        // the human's decision still reaches the caller, and say what happened.
        process.stderr.write(
          `draftgate: could not write --out ${args.output}: ${(e as Error).message}\n` +
            'draftgate: writing the approved payload to stdout instead\n'
        );
      }
    }
    if (!wrote) await writeStdout(json);
    process.stderr.write(`draftgate: approved${outcome.edited ? ' (edited)' : ''}\n`);
    return 0;
  }

  const d = outcome.denial!;
  if (args.json) process.stderr.write(JSON.stringify(d, null, 2) + '\n');
  else process.stderr.write(`draftgate: ${d.outcome}\n  ${d.reason}\n  ${d.guidance}\n`);
  return outcome.exitCode;
}

// Only run when executed directly, so tests can import `main`.
if (import.meta.main) {
  // Exit explicitly, after `main` has awaited its stdout write (see `writeStdout`): waiting for the
  // event loop instead hangs whenever a surface holds a handle open.
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`draftgate: unexpected failure: ${(e as Error)?.stack ?? e}\n`);
      process.exit(1);
    });
}
