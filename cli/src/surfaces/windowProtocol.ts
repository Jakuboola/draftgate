/**
 * The wire contract between the CLI process and the review window.
 *
 * `ReviewRequest`'s `preview()` and `doc()` are bound functions and cannot cross a process, so the
 * window gets data (the destination and the canonical markdown) and renders with `core` itself.
 * `core` is pure, so the result matches the CLI's; the window re-renders on every keystroke anyway.
 *
 * Two temp files, not stdio: AppKit and WebKit write their own `objc[...]` lines to the child's
 * stdout and stderr. The paths travel in the environment, not argv: the host reads exactly three
 * variables (`surface/harness/host.test.ts` pins them), and a launcher parsing argv would consume a
 * `--draftgate-request`. `protocol` is checked at both ends, so a mismatch fails loudly instead of
 * misreading a decision (wire.md).
 */

import {
  isKnownDestination,
  ownAnswerFor,
  // The field vocabulary. In `core` because the renderer reads this list too and the bundle may
  // import exactly one `cli` module; `cli/src/reviewPlan.ts` is only the derivation.
  type ReviewFieldValue,
  type Audience,
  type DestinationName,
  type TargetAnswer,
  isThemeChoice,
  type ThemeChoice,
} from '../../../core/src/index';
import contract from '../../../surface/contract.json';
// The path grammar, from the module that writes through it: a renderer must not be able to name
// a field `buildUpdatedInput` would refuse -- or one it would not.
import { parseBodyPath } from '../payload';

// The plain-object guard, once: an open-coded copy needs an `as Record<string, unknown>`
// afterwards to get back the narrowing the guard gives.
import { isPlainObject } from '../json';

/**
 * Bump on any incompatible change to either shape below. Read from `surface/contract.json` because
 * the host (Objective-C) and its rules (CommonJS) cannot import this module.
 */
export const PROTOCOL_VERSION: number = contract.protocolVersion;

/** Env var carrying the path the CLI wrote the request to. Read-only to the window. */
export const REQUEST_ENV = 'DRAFTGATE_REQUEST';
/** Env var carrying the path the window must write its decision to. */
export const DECISION_ENV = 'DRAFTGATE_DECISION';

/**
 * Where the window remembers its position and size between reviews. A path, like the request and
 * decision paths, so the surface does not know where draftgate keeps state and the probe and tests
 * can point it somewhere disposable. Absent means do not persist: the window opens centred.
 */
export const WINDOW_STATE_ENV = 'DRAFTGATE_WINDOW_STATE';

/** What the window is given: serialisable data only, not a render snapshot (see the header). */
export interface WireRequest {
  protocol: number;
  destination: DestinationName;
  /** The originating tool call, shown to the reviewer. */
  toolName?: string;
  /** Routing context, displayed read-only. */
  context: Record<string, unknown>;
  /**
   * Who receives this, when the destination has more than one possible answer. It travels because
   * the renderer cannot derive it: it depends on the operator's `jira-projects.json`, and the
   * renderer has no filesystem. Additive and optional, so no protocol bump: a stale renderer draws
   * no banner.
   */
  audience?: Audience;
  /**
   * Where this is going, in words a human recognises. Travels for `audience`'s reason (the hostname
   * behind a `cloudId` is in `jira-projects.json`). Additive and optional: a stale renderer shows
   * the raw routing fields.
   */
  destinationLabel?: string;
  /**
   * Set when nobody configured this tool: its name only shares a tool half with `matchedEntry`,
   * under a server draftgate was never told about (`resolveRoute`). The matched entry, not a
   * boolean, so the reviewer can judge the inference that the destination, stylesheet, warnings and
   * audience on screen all rest on. Additive and optional: a stale renderer draws no note.
   */
  routeInferred?: { matchedEntry: string };
  /**
   * Every field of the payload the reviewer may read and edit, in reading order: one list for the
   * body and every other field (`cli/src/reviewPlan.ts`), with `kind` per field. `markdown` is the
   * editor and `render()`, `text` a textarea and `renderPlain()`, `line` a single-line input and
   * `proseWarnings()` alone. Exactly one entry is `markdown` or `text` (`blockFieldOf`).
   *
   * A field the payload does not carry is omitted, not sent empty: "leave the title alone" and
   * "blank the title" are different instructions.
   *
   * A change here bumps the version: a renderer that ignored a field would send it unseen under a
   * human approval. The number alone cannot catch a stale bundle (both ends read `contract.json` at
   * runtime); `useReview.ts` checks the bundle's baked-in copy and `staleSurfaceDenial` in
   * `cli/src/review.ts` checks the fact (wire.md).
   */
  fields: readonly ReviewFieldValue[];
  /**
   * An explicit theme, overriding the reviewer's system preference; absent means follow the OS.
   * Intersected with the palettes the destination's profile has measured, so `dark` on a
   * light-only destination renders light. Additive and optional: no protocol bump.
   */
  theme?: ThemeChoice;
  /**
   * The theme the reviewer chose in an earlier review (`cli/src/themePreference.ts`). Not an
   * instruction like `theme`: the window ranks it below a click in this window or `theme`. It
   * travels because the host's `draftgate://` storage keeps nothing between reviews.
   */
  rememberedTheme?: ThemeChoice;
  /** How long the window has before the CLI denies the send. Drives the countdown. */
  timeoutMs: number;
}

/**
 * A repair the reviewer accepted, identified well enough for the digest to group it. Both halves
 * come from `core`: `code` is the warning's code, or `SUGGESTED_FIX_CODE` for the blocked draft's
 * whole-document repair; `label` is the title of the before/after preview they accepted (for a
 * warning's repair, also its button; not the button that opens the preview: "Review suggested fix"
 * opens "Suggested fix"). The label says which repair: `slack/url-swallows-next-line` offers two
 * that render differently.
 */
export interface AppliedFix {
  code: string;
  label: string;
}

/**
 * Caps on what the renderer may report: it displays agent-authored content and the audit log is
 * append-only. No review reaches them (64 accepted repairs is not a review; `core`'s labels are a
 * few words). From `contract.json` because the host truncates to these first (`rendererBridge.cjs`'s
 * `sanitiseDecision`) and this module checks them again, and neither can import the other: a cap
 * raised on one side only would drop accepted repairs silently, past every unit test of
 * `parseWireDecision`.
 */
export const MAX_APPLIED_FIXES: number = contract.maxAppliedFixes;
export const MAX_FIX_FIELD_LENGTH: number = contract.maxFixFieldLength;

/**
 * How long a line field's input accepts, in characters. A bound on the renderer, not a destination
 * rule: `App.tsx` sets it as every `.dg-prose-field`'s `maxLength` (pasting included), so a changed
 * line longer than this is a surface writing what no reviewer could, and `cli/src/review.ts` refuses
 * it. Nobody measured a destination refusing more, so a value the agent wrote goes out unrefused.
 */
export const MAX_PROSE_LENGTH: number = contract.maxProseLength;
/**
 * How many fields one decision may report (`contract.json`, like `MAX_PROSE_LENGTH`). It counts the
 * body too: nothing bounds a route's `proseFields`, and a cap that forgot the body would make
 * `parseFields` return `null` on every review of a route at the cap.
 */
export const MAX_DECISION_FIELDS: number = contract.maxDecisionFields;

/**
 * What the window writes back.
 *
 * The body (in `fields`) is the markdown the reviewer read, on every approval, edited or not
 * (`surface/src/useReview.ts`). `edited` travels on its own because loading a draft normalises it
 * (a bare URL comes back `[url](url)`, media follows the destination): an untouched body can differ
 * from `canonical`. `silenced` is the warning codes true of `canonical` and not of the body sent, so
 * draftgate never changes a message invisibly (`jira/task-item-media-only` destroys a checkbox).
 *
 * `edited`, `bodyEdited`, `silenced` and `fixes` are three-state (`AuditRecord` in `cli/src/audit.ts`), all
 * additive with no protocol bump. With `edited` absent the CLI compares the body with `canonical`,
 * right for `auto-approve`. The window sends `fixes` on every approve, even `[]`, so a stale
 * renderer's silence reads as unknown, not as zero repairs.
 */
export type HumanDecision = (
  | {
      action: 'approve';
      /**
       * The value of every field the reviewer was shown, by path: the decision's half of
       * `WireRequest.fields`. `cli/src/review.ts` compares each with what was shown and drops an
       * entry for a field this review never showed (one `shown.has(field)` filter, the body
       * included), so a surface cannot invent an edit. `{}` is not "no changes" (unchanged is a
       * full map) and reads as no map. Absent is a stale build, which `review.ts` denies; optional
       * here so it reaches that denial, which names `bun run build:surface`, instead of parsing as
       * `null` (wire.md).
       */
      fields?: Readonly<Record<string, string>>;
      /** Did a human change the draft? Never inferred from the body; see above. */
      edited?: boolean;
      /**
       * Did a human change the BODY? `edited` counts a changed line too, so only this tells a
       * title-only edit from a body edit, which is what the agent is shown (`cli/src/decisionFile.ts`).
       * Absent: the CLI compares the body with `canonical`, as for `edited`.
       */
      bodyEdited?: boolean;
      /** Codes true of the agent's draft and not of what is being sent. See above. */
      silenced?: string[];
      fixes?: AppliedFix[];
    }
  | { action: 'reject'; reason?: string }
) &
  DecisionExtras;

/**
 * What rides either decision beside the send itself: the reviewer's answer about the target, and
 * the theme they chose for the window. One place, so the next such field is one edit.
 */
export interface DecisionExtras {
  /**
   * What the reviewer said about the target, when asked. Rides the decision, not a second channel
   * (the page's bridge is two functions, `surface/host/draftgate.m`), and is recorded on a rejection
   * too. A destination and a value, never a key: the renderer displays agent-authored content, so
   * the CLI applies the answer to the `cloudId` and project key it parsed itself. The destination
   * is checked by `ownAnswerFor` (audience.md). A bare string is dropped, silently, so the protocol
   * version carries this shape.
   */
  classifyProject?: TargetAnswer<DestinationName>;
  theme?: ThemeChoice;
}

/** The same shape, stamped with the version both ends check. */
export type WireDecision = HumanDecision & { protocol: number };

/**
 * One field the renderer may report: a non-empty string within the cap. Shared by `isAppliedFix`
 * (each half of a fix) and `parseSilenced` (each code).
 */
export function isReportableString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FIX_FIELD_LENGTH;
}

/**
 * The three-state list rule (absent, `[]`, or what was reported), written once. `keep` returns the
 * value to keep, or `undefined` to drop the entry. A non-empty input that yields nothing valid
 * returns `undefined`, never `[]`: `[]` claims "this surface reports and there was nothing", so a
 * drifted renderer lands on unknown instead of logging clicked repairs as rewrites. Once, not per
 * field, because `decisionFields.test.ts` binds this module to `surface/rendererBridge.cjs` by
 * field parity only.
 */
function reportedList<T>(raw: unknown, keep: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: T[] = [];
  for (const v of raw.slice(0, MAX_APPLIED_FIXES)) {
    const kept = keep(v);
    if (kept !== undefined) out.push(kept);
  }
  return out.length === 0 && raw.length > 0 ? undefined : out;
}

/**
 * Is this one well-formed `AppliedFix`, within the caps? Exported so every reader shares the shape
 * and picks its own policy: `parseAppliedFixes` drops a bad entry, `digest.ts`'s `readFixes`
 * rejects the whole array.
 */
export function isAppliedFix(v: unknown): v is AppliedFix {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const f = v as AppliedFix;
  return isReportableString(f.code) && isReportableString(f.label);
}

/**
 * Validate the reported repairs. Malformed is `undefined` (unknown) and never rejects the decision:
 * like `audit.ts`'s failure policy, metadata does not withdraw a human's approval, while `body` and
 * `protocol` refuse. A bad entry is dropped and the rest kept, since the reviewer did accept them;
 * a drifted shape (`{ id, title }` for `{ code, label }`) lands on unknown through `reportedList`.
 */
function parseAppliedFixes(raw: unknown): AppliedFix[] | undefined {
  return reportedList(raw, (v) => (isAppliedFix(v) ? { code: v.code, label: v.label } : undefined));
}

/**
 * The warning codes the round trip silenced, validated the way `fixes` is (`reportedList`: a
 * drifted shape lands on unknown, never on "silenced nothing"). It shares `fixes`' caps: both bound
 * how much a renderer may write into a decision file, not the vocabulary, and a warning code is far
 * shorter than `MAX_FIX_FIELD_LENGTH`.
 */
function parseSilenced(raw: unknown): string[] | undefined {
  return reportedList(raw, (v) => (isReportableString(v) ? v : undefined));
}

/**
 * The field values a renderer reports: an object, `undefined` when it reported none usably, or
 * `null` to refuse the decision. Absent is a stale build, which `cli/src/review.ts` denies; kept
 * apart from `null` (`surface/unavailable`) so that denial can name `bun run build:surface`. `{}`
 * is not a positive claim (unchanged is a full map) and `review.ts` denies it. A malformed entry
 * refuses the whole decision (see the check).
 *
 * No length cap here: the map carries the uncapped body, so `MAX_PROSE_LENGTH` is enforced in
 * `cli/src/review.ts`, which knows each field's kind; this layer owns the count. Names are checked
 * as paths because `buildUpdatedInput` writes through them (`parseBodyPath` refuses `__proto__`).
 */
function parseFields(raw: unknown): Record<string, string> | undefined | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  // Over the count is a refusal, for the malformed check's reason: `break` would drop the
  // remaining values, and a dropped edit sends the agent's text under the human's approval.
  if (Object.keys(raw as object).length > MAX_DECISION_FIELDS) return null;
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    /*
     * An unaddressable or non-string value refuses the decision instead of being dropped, the one
     * inversion of the metadata asymmetry: dropping a rewritten title leaves the field unchanged, so
     * the agent's text is sent under a human approval with `edited: true`. Refusing makes
     * `parseWireDecision` return null, and the adapter asks.
     */
    if (typeof value !== 'string') return null;
    try {
      parseBodyPath(field);
    } catch {
      return null;
    }
    out[field] = value;
  }
  return out;
}

/**
 * The one place a classification off disk becomes a fact about a destination. `isKnownDestination`
 * first: without it `profiles[name]` on a plain object reaches `toString` (the `in`-versus-`hasOwn`
 * defect `core` records). Then `ownAnswerFor` checks the value is one that destination offers,
 * given `destination` twice because the wire claims only internal consistency; `review.ts` compares
 * it with the destination under review. Case matters: Atlassian's values are lower-case, and
 * `SERVICE_DESK` would write a value the config reader rejects.
 */
function parseClassification(raw: unknown): TargetAnswer<DestinationName> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { destination, value } = raw;
  if (typeof destination !== 'string' || !isKnownDestination(destination)) return undefined;
  if (typeof value !== 'string') return undefined;
  return ownAnswerFor(destination, { destination, value });
}

/**
 * Validate a decision read back off disk.
 *
 * Returns `null` for anything unrecognised rather than throwing, because every caller's response is
 * the same and is not an exception: refuse to approve. The window renders agent-authored content,
 * so its output is checked, not trusted.
 */
export function parseWireDecision(raw: unknown): WireDecision | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.protocol !== PROTOCOL_VERSION) return null;

  // Checked against the vocabulary of the destination the answer names. Anything unrecognised is
  // dropped, not refused: metadata does not withdraw an approval (`parseAppliedFixes`).
  const answer = parseClassification(d.classifyProject);
  // The theme chosen in this window: metadata too, so a value outside the vocabulary is dropped.
  const extras: DecisionExtras = {
    ...(answer === undefined ? {} : { classifyProject: answer }),
    ...(isThemeChoice(d.theme) ? { theme: d.theme } : {}),
  };

  if (d.action === 'approve') {
    // Spread, so an absent or malformed `fixes` leaves the key off: every reader tests presence,
    // and a `satisfies AuditRecord` would otherwise have to allow `undefined`.
    const fixes = parseAppliedFixes(d.fixes);
    const extra = fixes === undefined ? {} : { fixes };
    // Spread likewise. Only a real boolean survives, so `"true"` reads as unreported and falls
    // back to the body comparison.
    const wasEdited = typeof d.edited === 'boolean' ? { edited: d.edited } : {};
    const bodyWasEdited = typeof d.bodyEdited === 'boolean' ? { bodyEdited: d.bodyEdited } : {};
    const silenced = parseSilenced(d.silenced);
    const quieted = silenced === undefined ? {} : { silenced };
    // null refuses, undefined is a surface that does not report field values, an object is the
    // answer (`parseFields`).
    const reported = parseFields(d.fields);
    if (reported === null) return null;
    const values = reported === undefined ? {} : { fields: reported };
    return {
      protocol: PROTOCOL_VERSION,
      action: 'approve',
      ...wasEdited,
      ...bodyWasEdited,
      ...quieted,
      ...extra,
      ...values,
      ...extras,
    };
  }
  if (d.action === 'reject') {
    if (d.reason === undefined || d.reason === null) {
      return { protocol: PROTOCOL_VERSION, action: 'reject', ...extras };
    }
    if (typeof d.reason !== 'string') return null;
    return { protocol: PROTOCOL_VERSION, action: 'reject', reason: d.reason, ...extras };
  }
  return null;
}
