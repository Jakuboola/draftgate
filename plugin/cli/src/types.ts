/**
 * The CLI's contract:
 *
 *   draftgate review --dest jira --in payload.json
 *     owns the review surface; blocks; edited payload on stdout
 *     exit 0 = approved, 1 = rejected, 2 = timeout
 */

import type { RenderResult, PmNode, Audience } from '../../core/src/index';
import type { ReviewFieldValue } from './reviewPlan';
import type { BODY_FAILURES } from './payload';
import type { HumanDecision } from './surfaces/windowProtocol';
import type { AuditRecord } from './audit';

/**
 * What the surface is asked to show a human. `destination`, `mode` and `canonical` live on `render`
 * only. `preview` and `doc` are bound functions: a surface re-renders as the human edits without
 * importing `core`, and `doc` (a full markdown -> ADF -> ProseMirror conversion) is built only when
 * read, not kept alive for the minutes the process blocks on a human.
 */
export interface ReviewRequest {
  /** The originating tool call, when the request came from a hook. */
  toolName?: string;
  /** Routing context (channel, issue key, ...), shown read-only. */
  context: Record<string, unknown>;
  /**
   * Who receives this, when the destination has more than one possible answer. `undefined` means
   * the question does not arise (Slack and Linear have one audience each, a Jira software project
   * has no customer); "we do not know" is `kind: 'unknown'`, a banner. Beside `render`, which sees
   * only the body. See `core/src/audience.ts`.
   */
  audience?: Audience;
  /**
   * Where this is going, in words (`acme-dev.atlassian.net / SUPPORT-123`), from the operator's
   * config. `undefined` when nothing verifiable can be composed; the surface then shows the raw
   * routing fields.
   */
  destinationLabel?: string;
  /**
   * The mapped tool whose half this one shared, when nobody configured it. Only the caller that
   * resolved the route knows, so it arrives on `--route-inferred-from`.
   */
  inferredFrom?: string;
  /**
   * Every field this review shows, in reading order: the route's `reviewPlan` with the payload's
   * values, the body included. A field the payload does not carry is omitted, not empty
   * (`save_issue` with an `id` may leave `title` unset to keep it). The block entry's `value` is
   * the body `render` was computed from, so it equals `render.canonical`.
   */
  fields: readonly ReviewFieldValue[];
  /** Conversion result and warnings for the body as first received. */
  render: RenderResult;
  /** Re-render an edited body. Surfaces call this instead of importing `core`. */
  preview(body: string): RenderResult;
  /** Build the editor document for a body, on demand. */
  doc(body: string): PmNode;
  timeoutMs: number;
}

/**
 * How a review ended, in one union so `runReview` handles every ending: `timeout` is nobody
 * deciding in time, `unavailable` the surface never managing to ask.
 *
 * An approval's `fields` holds the value of every field the reviewer was shown, by path, the body
 * (after the editor's round trip) included. Absent is a stale renderer and is denied; the wire
 * keeps it optional (see `HumanDecision`).
 */
export type Decision =
  | HumanDecision
  | { action: 'timeout' }
  /**
   * The surface could not ask a human at all (no binary, no window, a crash). Not `reject`: told to
   * "revise and try once", an agent whose window cannot start rewrites a good message and fails
   * again.
   */
  | {
      action: 'unavailable';
      reason: string;
      /**
       * Which kind of unavailable, when the surface can tell. Of the failures `surfaces/window.ts`
       * reports, a decision `parseWireDecision` refuses is a stale build a human already clicked
       * in, and its fix (`bun run build:surface`) differs from the others'
       * (`xcode-select --install`, `bun run build:host`, `bun install` then a build, "update or
       * reinstall", nothing for a crash). Absent means `SURFACE_UNAVAILABLE`.
       */
      cause?: typeof SURFACE_UNAVAILABLE | typeof SURFACE_STALE;
    };

/** The review surface: an interface, so the orchestration is testable with no window. */
export interface ReviewSurface {
  /**
   * Whether a person answers this surface, stated by the surface itself: `webkit` asks a human,
   * `auto-approve` and `auto-reject` are machines. It rides the decision file to the hook adapter,
   * whose approval wording keys on it rather than on names, so a new human surface needs no
   * adapter edit.
   */
  readonly human: boolean;
  review(request: ReviewRequest): Promise<Decision>;
}

/**
 * Every tag a denial can carry. A union, not `string`, so a typo such as `body/missing_field` is a
 * type error rather than a branch that never fires (that branch is the missing-body fail-open). The
 * body codes come from `BODY_FAILURES`; the rest are declared below, beside `Denial`, to avoid an
 * import cycle with `review.ts`.
 */
export type DenialCode =
  | (typeof BODY_FAILURES)[keyof typeof BODY_FAILURES]['code']
  | typeof BLOCKED_AFTER_APPROVAL
  | typeof REVIEW_CRASHED
  | typeof CONTEXT_UNADDRESSABLE
  | typeof SURFACE_UNAVAILABLE
  | typeof SURFACE_STALE;

/**
 * The window approved a draft that `render()` then reported as blocked: window/core skew, a stale
 * window build the build stamp (`bundleStamp.ts`) did not catch. `PROTOCOL_VERSION` covers the
 * wire's shape, not which drafts are blocked. The outcome stays `rejected`, so the adapter denies
 * rather than asks (`CODE_POLICY`); the code marks the log row as this backstop, not a person's
 * rejection.
 */
export const BLOCKED_AFTER_APPROVAL = 'body/blocked-after-approval';

/**
 * The payload carries a key the context wildcard cannot address (a dot, an empty name, `__proto__`),
 * so the read-only half of the review is incomplete. Denied, never dropped (wire.md).
 */
export const CONTEXT_UNADDRESSABLE = 'context/unaddressable';

/** The gate itself threw. Everything about the review is best-effort from that point. */
export const REVIEW_CRASHED = 'review/crashed';

/**
 * The surface never managed to ask a human (a host that could not be built, no `surface/dist/`, a
 * crash on start). This and `SURFACE_STALE` exist for the log: every `unavailable` denial carries a
 * code, so a row with none is an older row, not a window that would not start. The adapter has no
 * branch for either; its generic `unavailable` row takes only its headline from the code.
 */
export const SURFACE_UNAVAILABLE = 'surface/unavailable';

/** The window answered, but it is older than the CLI driving it. See `staleSurfaceDenial`. */
export const SURFACE_STALE = 'surface/stale';

/**
 * Structured denial: the agent needs a reason specific enough that it does not immediately retry
 * the identical send.
 */
export interface Denial {
  /**
   * `unavailable` means the gate could not run, not that a human said no. The adapter's one
   * fail-open branch requires it together with `code === 'body/missing-field'`; every other
   * `unavailable` asks (`adapters/hook/src/decide.ts`).
   */
  outcome: 'rejected' | 'timeout' | 'unavailable';
  /**
   * A stable tag for the denials a caller acts on specifically (`body/missing-field` fails open,
   * unlike every other `unavailable`). Absent unless a caller needs it. Never switch on `reason`,
   * which is prose.
   */
  code?: DenialCode;
  destination: string;
  reason: string;
  /** Explicit instruction to the agent. Vague denials cause retry loops. */
  guidance: string;
}

export interface ReviewOutcome {
  /** `ReviewSurface.human`, carried so the decision file can state it. */
  human: boolean;
  /**
   * 0 approved, 1 denied, 2 timed out: a published contract (`review --help`), so 1 covers both a
   * rejection and a surface that failed to start. `denial.outcome` tells them apart.
   */
  exitCode: 0 | 1 | 2;
  /** The complete tool input to send, present only on approval; never a patch (wire.md). */
  updatedInput?: Record<string, unknown>;
  denial?: Denial;
  /** True when a human changed the draft: the body or a line. */
  edited: boolean;
  /**
   * What a person's edit sent in place of the agent's draft: the body when they changed it, and
   * each line they changed. Approvals with `edited` only; the decision file hands it to the agent.
   */
  sent?: { body?: string; lines: { field: string; value: string }[] };
  /**
   * Everything the audit log needs, gathered where each fact is known (`main.ts` holds neither the
   * canonical body nor the body sent). Present on every outcome, denials included.
   */
  audit: AuditRecord;
}
