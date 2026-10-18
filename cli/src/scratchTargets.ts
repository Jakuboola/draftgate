/**
 * Which destinations in the audit log are scratch targets, so the digest can stop counting them.
 *
 * Not the scratch directory a review passes its payload through (`scratch.ts`).
 *
 *     ~/.draftgate/scratch.json
 *     {
 *       "version": 1,
 *       "targets": [
 *         { "destination": "jira",
 *           "context": { "cloudId": "0a1b2c3d-...", "issueIdOrKey": "SUPPORT-123" },
 *           "why": "scratch issue on the dev site" },
 *         { "destination": "linear", "context": { "issueId": "HELP-42" } },
 *         { "destination": "slack",  "context": { "channel_id": "U0123ABCDEF" }, "why": "self-DM" },
 *         { "destination": "github", "context": { "owner": "acme", "repo": "scratch" } }
 *       ]
 *     }
 *
 * The digest asks whether a destination shows ~95% unedited approvals. On a machine where draftgate
 * is developed, most reviews in the log go to scratch targets, so unsegmented numbers describe
 * draftgate being tested rather than an agent writing to a person.
 *
 * Operator config, not a constant: the targets are one operator's, and `digest.ts` prints no
 * judgement of its own. Same shape as `jiraProjects.ts`: nothing here throws, and a file that is
 * present and broken says so once on stderr. A matched review is counted in its own table, and the
 * digest says how many it moved and on whose authority; with no file it says nothing was excluded.
 *
 * A Jira target must declare `cloudId`: a project key is unique only within a site, so one issue key
 * can be a scratch issue on a dev site and a customer ticket on production. A target with only
 * `issueIdOrKey` would move a real approval out of the headline, so it is refused and named in
 * `problem`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftgateHome } from './audit';
import { isPlainObject } from './json';
import { namedSample } from './configFiles';
import { isKnownDestination, profiles, type TargetIdentity } from '../../core/src/index';

export const SCRATCH_BASENAME = 'scratch.json';
export const SCRATCH_VERSION = 1;

/** One declared scratch destination. Every `context` pair must match for a review to be one. */
export interface ScratchTarget {
  destination: string;
  /**
   * Context fields the review must carry, all of them, compared as strings. A subset of the record's
   * `context`, so a Slack thread in a scratch channel matches on `channel_id` alone.
   */
  context: Record<string, string>;
  /** Free text for the reader. Printed with the exclusion so the declaration explains itself. */
  why?: string;
}

export interface ScratchList {
  targets: ScratchTarget[];
  /** Whether a file was there at all, as distinct from a file that declared nothing. */
  present: boolean;
  /** What a file that exists could not give, for one line on stderr. See `jiraProjects.ts`. */
  problem?: string;
}

export function scratchPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(draftgateHome(env), SCRATCH_BASENAME);
}

/**
 * Parse the file's text. Pure, so every degradation is testable with no filesystem.
 *
 * Partial credit, like `parseJiraProjects`: one bad target costs that target and is named, so a
 * typo does not silently un-exclude everything the operator declared.
 */
export function parseScratchList(text: string, source: string): ScratchList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { targets: [], present: true, problem: `${source} is not valid JSON (${why})` };
  }
  if (!isPlainObject(parsed)) {
    return { targets: [], present: true, problem: `${source} is not a JSON object` };
  }
  if (parsed.version !== SCRATCH_VERSION) {
    return {
      targets: [],
      present: true,
      problem: `${source} declares version ${JSON.stringify(parsed.version)}, expected ${SCRATCH_VERSION}`,
    };
  }
  if (!Array.isArray(parsed.targets)) {
    return { targets: [], present: true, problem: `${source} has no "targets" array` };
  }

  const targets: ScratchTarget[] = [];
  const dropped: string[] = [];
  for (const [i, raw] of parsed.targets.entries()) {
    const at = `targets[${i}]`;
    if (!isPlainObject(raw)) {
      dropped.push(`${at} is not an object`);
      continue;
    }
    const { destination, context, why } = raw;
    if (typeof destination !== 'string' || destination === '') {
      dropped.push(`${at} has no "destination"`);
      continue;
    }
    if (!isPlainObject(context)) {
      dropped.push(`${at} has no "context" object`);
      continue;
    }
    const pairs: Record<string, string> = {};
    let bad = false;
    for (const [k, v] of Object.entries(context)) {
      // Strings only: a number or a boolean never equals the log's string, so the target would
      // silently never match. No sentinel key here: it would share the operator's field namespace.
      if (typeof v !== 'string') {
        dropped.push(`${at}.context.${k} is not a string`);
        bad = true;
        break;
      }
      pairs[k] = v;
    }
    if (bad) continue;
    if (Object.keys(pairs).length === 0) {
      dropped.push(`${at}.context declares nothing, so it would match every ${destination} review`);
      continue;
    }
    // What names one target is the profile's `TargetIdentity`, not a branch here. An unknown
    // destination is refused: the log's destination comes from the same closed set, so it could
    // never match.
    if (!isKnownDestination(destination)) {
      dropped.push(
        `${at} names destination ${JSON.stringify(destination)}, which is not one of ` +
          `${Object.keys(profiles).join(', ')} -- it could never match a review`
      );
      continue;
    }
    const identity: TargetIdentity = profiles[destination].targetIdentity;
    const missing = identity.requiredFields.filter((f) => pairs[f] === undefined);
    if (missing.length > 0) {
      dropped.push(
        `${at} is a ${destination} target with no ${missing.map((f) => `"${f}"`).join(' and ')}, ` +
          `and ${identity.ambiguity}`
      );
      continue;
    }
    targets.push({ destination, context: pairs, ...(typeof why === 'string' ? { why } : {}) });
  }

  return {
    targets,
    present: true,
    ...(dropped.length > 0 ? { problem: `${source}: ${namedSample(dropped)}` } : {}),
  };
}

/** Read the file. Absent is the ordinary state and not a problem. */
export function readScratchList(env: NodeJS.ProcessEnv = process.env): ScratchList {
  const path = scratchPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { targets: [], present: false };
  }
  return parseScratchList(text, path);
}

/**
 * Does this review's routing match a declared scratch target?
 *
 * Takes the two fields it reads, not an `AuditEntry`, so it is testable on two literals.
 */
export function isScratch(
  targets: readonly ScratchTarget[],
  destination: string,
  context: Record<string, unknown> | undefined
): boolean {
  if (targets.length === 0) return false;
  const ctx = context ?? {};
  // `destination` is a plain string on an audit row and may name something this build does not
  // know; an unknown one folds nothing, so every field compares exactly.
  const caseFolded = isKnownDestination(destination)
    ? profiles[destination].targetIdentity.caseFolded
    : [];
  return targets.some(
    (t) =>
      t.destination === destination &&
      Object.entries(t.context).every(([k, v]) => same(caseFolded, k, ctx[k], v))
  );
}

/**
 * Whether a payload's routing value is the one a target declared.
 *
 * `===` except for the fields the destination treats case-insensitively, named in
 * `TargetIdentity.caseFolded`: GitHub's `owner` and `repo`, where `Owner/Repo` and `owner/repo` are
 * one repository. Without folding, a target declared in one spelling misses a payload in the other
 * and that review lands in the headline numbers. Slack ids and Jira issue keys are case-sensitive,
 * so folding everything would match payloads a target was not written for.
 */
function same(
  caseFolded: readonly string[],
  key: string,
  actual: unknown,
  declared: string
): boolean {
  if (caseFolded.includes(key)) {
    return typeof actual === 'string' && actual.toLowerCase() === declared.toLowerCase();
  }
  return actual === declared;
}
