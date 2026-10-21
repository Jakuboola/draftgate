/**
 * The CLI's machine-readable outcome, approval and denial alike, in one versioned file; stderr is
 * for humans (wire.md). `--out` carries only the approved payload, and recovering a denial from
 * stderr, which also carries the window's native notices and macOS `objc[...]` warnings, would turn
 * a rejection into a permission prompt the day one more line lands there.
 *
 * The exit codes stay the published contract (`draftgate review --help`). This file is for the hook
 * adapter, which must tell `unavailable` from `rejected`; the exit code cannot.
 */

import type { Denial, DenialCode, ReviewOutcome } from './types';

/** Bumped when the shape changes incompatibly; a reader treats an unknown version as unreadable. */
export const DECISION_FILE_VERSION = 1;

export interface DecisionFile {
  version: number;
  outcome: 'approved' | Denial['outcome'];
  edited: boolean;
  /**
   * Whether a person made this decision (`ReviewSurface.human`). The encoder always writes it;
   * optional on the read side, where absent reads as unknown and the adapter treats it as not a
   * person.
   */
  human?: boolean;
  updatedInput?: Record<string, unknown>;
  denial?: Denial;
  /**
   * Which `--surface` produced this, by name, for the wording ("draftgate's "auto-approve"
   * surface") and the audit log. The adapter's policy keys on `human`, not on this.
   */
  surface?: string;
  /**
   * What a person's edit sent in place of the agent's draft (`ReviewOutcome.sent`): the body when
   * they changed it, and each line they changed. The adapter repeats them to the agent, which sees
   * nothing else of the edit. Only on an approval a person edited.
   */
  sentBody?: string;
  sentLines?: { field: string; value: string }[];
}

/**
 * The file the CLI writes for a `ReviewOutcome`: the encoder, beside its decoder.
 * `cli/test/decisionFile.test.ts` puts one table through this and `parseDecisionFile`.
 */
export function encodeDecisionFile(outcome: ReviewOutcome, surfaceName?: string): DecisionFile {
  return {
    version: DECISION_FILE_VERSION,
    outcome: outcome.denial?.outcome ?? 'approved',
    edited: outcome.edited,
    human: outcome.human,
    ...(outcome.updatedInput ? { updatedInput: outcome.updatedInput } : {}),
    ...(outcome.denial ? { denial: outcome.denial } : {}),
    ...(surfaceName === undefined ? {} : { surface: surfaceName }),
    ...(outcome.sent?.body === undefined ? {} : { sentBody: outcome.sent.body }),
    ...(outcome.sent?.lines.length ? { sentLines: outcome.sent.lines } : {}),
  };
}

const OUTCOMES = new Set<DecisionFile['outcome']>(['approved', 'rejected', 'timeout', 'unavailable']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The denial, field by field. Every consumer in the adapter reads `reason` and `guidance` into the
 * wording it hands the agent, so a file missing them is not a denial this build can act on.
 */
function parseDenial(raw: unknown, outcome: DecisionFile['outcome']): Denial | null {
  if (!isRecord(raw)) return null;
  const { outcome: o, code, destination, reason, guidance } = raw;
  // The denial's outcome must equal the file's (`cli/test/audit.test.ts` pins the writer): the
  // adapter's fail-open row reads one and its wording the other.
  if (o !== outcome) return null;
  if (typeof destination !== 'string' || typeof reason !== 'string' || typeof guidance !== 'string') {
    return null;
  }
  if (code !== undefined && typeof code !== 'string') return null;
  return {
    outcome: o as Denial['outcome'],
    destination,
    reason,
    guidance,
    // Kept as written: a code this build does not know matches no branch and lands in `ask`.
    ...(code === undefined ? {} : { code: code as DenialCode }),
  };
}

/** `sentLines`, entry by entry; `null` for anything but an array of `{ field, value }` strings. */
function parseSentLines(raw: unknown): DecisionFile['sentLines'] | null {
  if (!Array.isArray(raw)) return null;
  const lines: NonNullable<DecisionFile['sentLines']> = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.field !== 'string' || typeof entry.value !== 'string') return null;
    lines.push({ field: entry.field, value: entry.value });
  }
  return lines;
}

/**
 * Read a decision file. `null` means absent, malformed, or an unknown version, and the caller
 * treats all three alike. Every field is checked and the result built field by field, so nothing
 * reaches the adapter typed as present without being looked at. Unknown keys are dropped, not
 * refused, so a file from a slightly newer CLI still reads.
 */
export function parseDecisionFile(text: string): DecisionFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.version !== DECISION_FILE_VERSION) return null;
  const outcome = raw.outcome;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome as DecisionFile['outcome'])) return null;
  if (typeof raw.edited !== 'boolean') return null;
  if (raw.human !== undefined && typeof raw.human !== 'boolean') return null;
  if (raw.surface !== undefined && typeof raw.surface !== 'string') return null;
  if (raw.sentBody !== undefined && typeof raw.sentBody !== 'string') return null;
  const sentLines = raw.sentLines === undefined ? undefined : parseSentLines(raw.sentLines);
  if (sentLines === null) return null;

  const out: DecisionFile = {
    version: DECISION_FILE_VERSION,
    outcome: outcome as DecisionFile['outcome'],
    edited: raw.edited,
    ...(raw.human === undefined ? {} : { human: raw.human }),
    ...(raw.surface === undefined ? {} : { surface: raw.surface }),
    ...(raw.sentBody === undefined ? {} : { sentBody: raw.sentBody }),
    ...(sentLines === undefined ? {} : { sentLines }),
  };
  if (outcome === 'approved') {
    // An approval with no payload is not an approval this file can express.
    if (!isRecord(raw.updatedInput)) return null;
    out.updatedInput = raw.updatedInput;
  } else {
    const denial = parseDenial(raw.denial, out.outcome);
    if (denial === null) return null;
    out.denial = denial;
  }
  return out;
}
