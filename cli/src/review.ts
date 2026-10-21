/**
 * Review orchestration: payload in, decision out. No I/O and no window, so the whole gate is tested
 * against a stub surface.
 */

import {
  render, renderPlain, renderNoBody, proseWarnings, patchWarnings, patchEditPath, isBlocking,
  isLengthRefusal, editorDocFor, audienceFor, destinationLabelFor, ownAnswerFor, profiles,
  type AudienceFacts, type DestinationName, type TargetAnswer, type Warning,
} from '../../core/src/index';
import {
  extractBody, extractContext, extractPatch, extractProse, buildUpdatedInput, wireBody, valueAtPath,
  writePatchEdits, MissingBodyFieldError, BODY_FAILURES, readContext, type ReadPatch,
} from './payload';
// The line cap: its number is in `contract.json`, and it is enforced here, where lines are known.
import { MAX_PROSE_LENGTH } from './surfaces/windowProtocol';
import type { RouteFacts } from './routeFacts';
import {
  reviewPlan, blockFieldOf, editFieldsOf, lineFieldsOf, type ReviewFieldValue,
} from './reviewPlan';
import type { AuditRecord, PatchAuditRow } from './audit';
import {
  BLOCKED_AFTER_APPROVAL, CONTEXT_UNADDRESSABLE, REVIEW_CRASHED, SURFACE_STALE, SURFACE_UNAVAILABLE,
} from './types';
import type { Decision, Denial, ReviewOutcome, ReviewRequest, ReviewSurface } from './types';
import { REMEDY } from '../../core/src/remedies';

// Declared in `types.ts` beside `Denial`; re-exported for callers that import them from here.
export { BLOCKED_AFTER_APPROVAL, REVIEW_CRASHED } from './types';

/**
 * How long a reviewer gets when nobody says otherwise: twenty minutes, since one long draft read
 * with an interruption outlasts ten. A timeout still recovers (a structured denial, and the agent
 * retries).
 *
 * Claude Code's per-hook `timeout` must fire later, or its fail-open path sends the input
 * unreviewed. Its default for a command hook is 600 s (`DEFAULT_TIMEOUT=600000`, read out of the
 * installed binary), so every registration carries a longer one (`hookTimeoutSecondsFor`), and the
 * adapter (`adapters/hook/src/reviewTimeout.ts`) passes the smaller of the registration and the time
 * asked for (this default, or `~/.draftgate/config.json`'s) as `--timeout`.
 */
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * How much later this module's timer fires than the surface's. A surface that owns a child owns
 * its kill (`runChild`'s timer: SIGKILL and denial in one callback), and `main.ts` exits once an
 * outcome exists, so if this timer won, the window would outlive the denial. Equal delays are not
 * enough: Node fires them in registration order, and this timer registers first (the window
 * awaits its bundle check).
 *
 * The margin comes after the reviewer's deadline (what the window counts down and `timeoutDenial`
 * names): far more than the microtask turn a surface needs, far less than a human notices. The only
 * timer for `auto-approve` and `auto-reject`, which have none of their own.
 */
export const TIMEOUT_BACKSTOP_MS = 500;

/**
 * The route facts are injected (`RouteFacts`, embedded rather than retyped as optional fields; see
 * `routeFacts.ts`): each is a claim about a tool's schema, and the tool map lives in the hook
 * adapter. Absent means the destination profile's own answer stands.
 */
export interface ReviewOptions extends RouteFacts {
  destination: DestinationName;
  toolInput: Record<string, unknown>;
  toolName?: string;
  surface: ReviewSurface;
  /** The surface's name, for the audit log and the decision file; the interface cannot say it. */
  surfaceName?: string;
  timeoutMs?: number;
  /**
   * The operator facts a profile needs to say who receives this. `main.ts` reads the files (this
   * module does no I/O); absent means `unknown`, which draws a loud banner.
   */
  audienceFacts?: AudienceFacts;
  /** The mapped tool whose half this one shared, when the caller inferred it; absent: mapped. */
  inferredFrom?: string;
  /**
   * Remember the reviewer's classification of the target, on a rejection as well as an approval.
   * Injected (it writes a file) and handed only the value: this layer has already checked the
   * answer is about this destination, and `main.ts` knows which store it belongs in.
   */
  rememberProject?(context: Record<string, unknown>, type: string): void;
}

/**
 * Run one review, and turn any failure, a throw included, into an outcome with an audit line and a
 * `--decision` file. A 10,000-deep nested list overflows the stack in `hoistMedia`'s recursion;
 * uncaught, that is exit 1 with `RangeError: Maximum call stack size exceeded` on stderr, no audit
 * line and no decision file. That fails closed (the hook's missing-decision path asks), so the
 * catch protects the evidence, not the send. It is here because this function knows the
 * destination, tool and context the audit line needs; `main.ts` keeps a last-resort handler.
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewOutcome> {
  try {
    return await review(opts);
  } catch (e) {
    return crashOutcome(opts, e as Error);
  }
}

/**
 * The outcome for a review that threw. Every step is best effort and guarded on its own, since the
 * throw may have come from any of them (a `render()` that overflows, an `extractContext` that trips
 * on a hostile payload).
 */
function crashOutcome(opts: ReviewOptions, error: Error): ReviewOutcome {
  const { destination, toolInput, toolName, contextFields } = opts;
  const attempt = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  // The editable set from the plan, as the live path reads it: a hand-built copy that missed a
  // prose field would record context the live path excludes on a wildcard route.
  const plan = reviewPlan(destination, opts);
  const context = attempt(
    () => extractContext(destination, toolInput, { contextFields, editable: plan.map((f) => f.field) }),
    {}
  );
  // A crashed review still says where it was going: for a service desk, the most useful half.
  const audience = attempt(
    () => audienceFor(destination, context, audienceFactsFor(opts)),
    undefined
  );
  // The draft, so the log shows what broke the gate, capped (the only cap in this file): nobody
  // reviewed it, and a 10,000-deep nested list is 100 MB of markdown. Read with the plan's line
  // fields as the live path reads it; without them a title-only call logs `before: ''` here.
  const before = attempt(
    () =>
      extractBody(
        destination, toolInput, opts.bodyField, lineFieldsOf(plan).map((f) => f.field), contextFields
      ),
    undefined
  );

  const denial: Denial = {
    outcome: 'unavailable',
    code: REVIEW_CRASHED,
    destination,
    reason: `draftgate failed while preparing this ${destination} review: ${error.message}`,
    guidance:
      'This is a fault in the review tool, NOT a judgement about the message. Nothing was sent and ' +
      'nothing was reviewed. Do not retry the send; report the reason above to the user.',
  };
  return {
    exitCode: 1,
    human: opts.surface.human,
    edited: false,
    denial,
    audit: {
      destination, toolName, context, outcome: 'unavailable', edited: false,
      // Absent when there was no body; see `AuditRecord.before`.
      ...(before === undefined ? {} : { before: truncateForLog(before) }),
      reason: denial.reason, warnings: [], ...(denial.code ? { code: denial.code } : {}),
      ...(audience ? { audience: audience.kind } : {}),
      ...(opts.surfaceName ? { surface: opts.surfaceName } : {}),
    },
  };
}

/**
 * The draft a body failure can name, for the audit log. Drift names the field `extractBody` took
 * for the prose (see the call site); `preformatted` names the body field itself, a string that is
 * not markdown ("a Jira draft arrived as ADF" is recoverable from nowhere else). The rest name
 * nothing.
 */
function failedBodyText(error: unknown, toolInput: Record<string, unknown>): string {
  if (!(error instanceof MissingBodyFieldError)) return '';
  // `valueAtPath`, not an index: `loggedField` may be dotted, and indexing would log `before: ''`
  // where `BODY_FAILURES.preformatted.logs === 'body'` promises the message.
  const value =
    error.loggedField === undefined ? undefined : valueAtPath(toolInput, error.loggedField);
  return typeof value === 'string' ? value : '';
}

/**
 * The audience facts every question about this review asks with: the operator's plus the tool's.
 * One spelling for the crash path, the live path and the label, so none drops `routeInferred`,
 * which stops a tool nobody mapped borrowing the internal-note claim.
 */
function audienceFactsFor(opts: ReviewOptions): AudienceFacts {
  return {
    ...opts.audienceFacts,
    toolName: opts.toolName,
    routeInferred: Boolean(opts.inferredFrom),
  };
}

/** Diagnostic bodies only. See `crashOutcome`; nothing on the reviewed path goes through this. */
function truncateForLog(body: string, max = 4_000): string {
  return body.length <= max
    ? body
    : `${body.slice(0, max)}… [truncated for the log; ${body.length} characters in total]`;
}

async function review(opts: ReviewOptions): Promise<ReviewOutcome> {
  const { destination, toolInput, toolName, surface, surfaceName, bodyField, contextFields } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Which fields this review shows and how, derived once; everything below reads the plan, not
  // `proseFields` or `bodyFormat` (see `reviewPlan.ts`).
  const plan = reviewPlan(destination, opts);
  const block = blockFieldOf(plan);

  // The editable set, so a `fields.*` wildcard does not draw the body or a title again as a stale
  // read-only copy. An unaddressable key is held here and refused, with an audit row, once `deny`
  // exists.
  const { context, unaddressable } = readContext(destination, toolInput, {
    contextFields,
    // A delta field is shown as its edits, never as a read-only copy of the raw list.
    editable: [...plan.map((f) => f.field), ...profiles[destination].deltaFields.map((d) => d.field)],
  });
  // The plan's line fields, one list for `extractProse` here and `extractBody` below.
  // `extractProse` keeps plan order and omits a field the payload does not carry: an empty box
  // invites a reviewer to blank a title the agent left alone.
  const lineFields = lineFieldsOf(plan).map((f) => f.field);
  const prose = extractProse(toolInput, lineFields);
  // The audience can change before the decision: a reviewer who classifies the project in the
  // window approves under the new banner, and a value fixed here would log `unknown` and leave the
  // review out of `customerVisible`. An explicit `classified: undefined` reads as absent.
  const askAudience = (classified?: TargetAnswer) =>
    audienceFor(destination, context, { ...audienceFactsFor(opts), classified });

  let audience = askAudience();
  // One conditional at every exit, so an absent audience stays absent.
  const audienceRow = () => (audience ? { audience: audience.kind } : {});

  /*
   * A patch's edits once they are shown: a denial after the window (a rejection, a timeout) records
   * what the reviewer read, as a body's `before` does. Empty until then, and for any other review.
   */
  let shownEdits: readonly (ReviewFieldValue & { kind: 'edit' })[] = [];

  // Every exit carries an audit record. `deny` builds the whole outcome from a `Denial`, so the
  // exit code, the denial and the log line cannot disagree.
  const deny = (
    denial: Denial,
    {
      exitCode = 1,
      edited = false,
      before,
      warnings = [],
    }: { exitCode?: 1 | 2; edited?: boolean; before?: string; warnings?: string[] } = {}
  ): ReviewOutcome => ({
    exitCode,
    human: surface.human,
    edited,
    denial,
    audit: {
      destination, toolName, context, outcome: denial.outcome, edited,
      // Absent, not `''`, when there is nothing to quote (`AuditRecord.before`).
      ...(before === undefined ? {} : { before }),
      reason: denial.reason, warnings, ...(surfaceName ? { surface: surfaceName } : {}),
      // Absent on a rejection or a timeout, which are not kinds of brokenness (`AuditRecord.code`).
      ...(denial.code ? { code: denial.code } : {}),
      ...audienceRow(),
      // As shown: a denial sends nothing, so there is no `after`.
      ...(shownEdits.length > 0
        ? { patch: shownEdits.map((f) => patchRow({ ...f, sent: f.value })) }
        : {}),
    },
  });

  // A body failure becomes a denial with a `code` and an audit row; the hook adapter keys its
  // schema-drift policy on the code (detection here, policy there). `undefined` is a review, not a
  // failure: a title-only `issue_write` or a `create_pull_request` with no description has a
  // message and no draft, so there is no render of a body, no `before` and no body written back.
  let canonical: string | undefined;
  // A delta draftgate can show: its edits stand in place of the body (`extractPatch`).
  let patch: ReadPatch | undefined;
  try {
    patch = extractPatch(destination, toolInput, bodyField);
    if (patch === undefined) {
      canonical = extractBody(destination, toolInput, bodyField, lineFields, contextFields);
    }
  } catch (e) {
    // Anything but a body failure is the gate breaking. Read as `unrecognised` it would become
    // `bodyOptional`'s allow; rethrown, it is `runReview`'s crash row, which asks.
    if (!(e instanceof MissingBodyFieldError)) throw e;
    // `before` names the message where it can. `body/missing-field` is the one outcome that sends
    // unreviewed (the schema-drift fail-open), so its row is the log's only record of that message.
    return deny(missingBodyDenial(destination, e as Error), {
      before: failedBodyText(e, toolInput),
    });
  }

  // After the body read, so a more specific diagnosis (a patch, a preformatted body, drift) keeps
  // its own guidance and digest cause.
  if (unaddressable.length > 0) {
    return deny({
      outcome: 'unavailable',
      code: CONTEXT_UNADDRESSABLE,
      destination,
      reason:
        `draftgate could not show everything this ${destination} tool call sets: the payload has ` +
        `${unaddressable.map((k) => JSON.stringify(k)).join(', ')}, which it cannot address as a ` +
        'field (a dot, an empty name, "*" or an object-machinery name), so no reviewer could see it.',
      guidance:
        'Nothing is wrong with the message and nothing needs rewriting. The call carries a field ' +
        'draftgate cannot display, so it was not reviewed; the user decides at the permission prompt.',
    });
  }

  // Markdown or text, by the route. `renderPlain` is a different set of claims, not `render` with a
  // flag: no conversion, toolbar, warnings taxonomy, repairs or `extraToolInput`.
  const renderFor = (body: string) =>
    block?.kind === 'text' ? renderPlain(body, destination) : render(body, destination);
  // No body at all. Not `render('')`, whose `body/empty` would put a dead Approve over a title; its
  // `format: 'absent'` stops `buildUpdatedInput` writing a body beside prose edits.
  const rendered = canonical === undefined ? renderNoBody(destination) : renderFor(canonical);

  /**
   * The patch's edits as fields, one per operation in the order the destination applies them, each
   * at the path its text is written back to. Their value is the agent's text.
   */
  const edits: (ReviewFieldValue & { kind: 'edit' })[] =
    patch === undefined
      ? []
      : patch.edits.map(({ edit, text }) => ({
          field: patchEditPath(patch.delta, edit.index, edit.textKey),
          kind: 'edit' as const,
          edit,
          value: text,
        }));
  shownEdits = edits;

  // The codes as first rendered: the verdict on the agent's draft, not what the reviewer saw (that
  // is these minus `silenced`). Every denial carries them too; `audit.ts` says why they are stored.
  // A patch's own codes join them: they are the verdict on the agent's edits.
  const warnings = [
    ...rendered.warnings,
    ...patchWarnings(edits),
  ].map((w) => w.code);

  /**
   * What the reviewer is shown: the plan's fields with this payload's values, lines then block
   * (`cli/test/reviewPlan.test.ts`). The block's value is `canonical`, the string `rendered`
   * describes.
   */
  const fields: readonly ReviewFieldValue[] = [
    ...prose.map((p) => ({ field: p.field, kind: 'line' as const, value: p.value })),
    // No block when the payload carried no body, as for lines: the window reads it as "no draft".
    ...(block === undefined || canonical === undefined ? [] : [{ ...block, value: canonical }]),
    // A patch has no body; its edits stand where the body would be.
    ...edits,
  ];

  const request: ReviewRequest = {
    toolName,
    context,
    audience,
    // Every field the reviewer may edit, in reading order.
    fields,
    // Computed once, unlike `audience`: a classification cannot move the target to another site.
    // The profile returns `undefined` rather than throwing when it has nothing verifiable to say.
    destinationLabel: destinationLabelFor(destination, context, audienceFactsFor(opts)),
    ...(opts.inferredFrom ? { inferredFrom: opts.inferredFrom } : {}),
    render: rendered,
    preview: (body) => renderFor(body),
    // Mention chips only where the destination renders one from a structural node; elsewhere a
    // `mention:` link ships as characters.
    doc: (body) => editorDocFor(rendered, body),
    timeoutMs,
  };

  // A backstop, not a competitor: see `TIMEOUT_BACKSTOP_MS`.
  const decision = await raceTimeout(surface.review(request), timeoutMs + TIMEOUT_BACKSTOP_MS);

  // Remembered before the outcome, so a reviewer who classifies the target and rejects is not asked
  // again. `timeout` and `unavailable` carry none.
  const said = ownAnswerFor(
    destination,
    'classifyProject' in decision ? decision.classifyProject : undefined
  );
  // An answer about another destination is dropped, not denied (`ownAnswerFor`, audience.md).
  if (said !== undefined) {
    opts.rememberProject?.(context, said.value);
    // The row records the audience they decided under, asked as the window asked it.
    audience = askAudience(said);
  }

  if (decision.action === 'timeout') {
    return deny(timeoutDenial(destination, timeoutMs), { exitCode: 2, before: canonical, warnings });
  }
  if (decision.action === 'unavailable') {
    return deny(unavailableDenial(destination, decision.reason, decision.cause), {
      before: canonical,
      warnings,
    });
  }
  if (decision.action === 'reject') {
    return deny(rejectDenial(destination, decision.reason), { before: canonical, warnings });
  }

  // --- approved ---
  /*
   * An approval that reports no field values is denied as stale. A stale bundle is caught first: it
   * compares its own protocol to the request's (`useReview.ts`), and a review rebuilds a bundle
   * whose stamp is stale (`bundleStamp.ts`). This is the read-back guard behind both, on a decision
   * file the bridge may not have written. It covers every review: a stale renderer reports under
   * keys nothing reads, so on a body-only review the reviewer's rewrite would be replaced by the
   * agent's original. Every approving surface reports `fields` (`auto-approve` echoes the list).
   *
   * An empty map is the same silence: a surface reports every shown field, so "changed none" is a
   * full map. `{}` comes from allow-list drift: `sanitiseFields` (`surface/rendererBridge.cjs`)
   * dropping a non-string entry that `parseFields` would refuse, instead of the whole key;
   * `surface/harness/decisionFields.test.ts` holds both to dropping the key. `fields.length > 0` is
   * defence in depth: a review with no body always shows a line field (`extractBody`).
   */
  if (decision.fields === undefined || (fields.length > 0 && Object.keys(decision.fields).length === 0)) {
    return deny(
      staleSurfaceDenial(
        destination,
        `draftgate showed the reviewer ${fields.length} field(s) of this ${destination} call, and ` +
          'the review surface returned a decision that reports none of them. That is what an ' +
          'out-of-date review window looks like: what it approved and what would be sent are not ' +
          'the same text.'
      ),
      { before: canonical, warnings }
    );
  }

  /**
   * What is sent for each field: the surface's value, or the shown one where it reported none
   * (the guard above refuses silence, not a short map). Walking `fields` ignores a path nobody was
   * shown, so `writeBodyPath` never creates a body field the agent omitted. `sent === value` is
   * what "unchanged" means, so reporting every shown field cannot invent an edit.
   */
  const reported = decision.fields;
  // `Object.hasOwn`, not `??`: `reported` came out of `JSON.parse` and carries `Object.prototype`,
  // so a field named `toString` would read a function. `parseBodyPath` refuses only `__proto__`,
  // `constructor` and `prototype`.
  const sending = fields.map((f) => ({
    ...f,
    sent: Object.hasOwn(reported, f.field) ? reported[f.field]! : f.value,
  }));

  /*
   * A line the surface changed to something longer than its own input accepts. `MAX_PROSE_LENGTH`
   * is the `maxLength` of every `.dg-prose-field`, which bounds pasting too, so no reviewer could
   * produce it. Here, not in the wire parser, which cannot tell a line from a body (a body has no
   * such bound). Changed lines only: an agent's 2,500-character `editJiraIssue` summary approved
   * unedited would otherwise deny as `surface/stale`, a retry loop with a human approval on record.
   * Refused, not truncated: half a title under a human's approval is worse than the agent's own.
   */
  const overlong = lineFieldsOf(sending).find(
    (f) => f.sent !== f.value && f.sent.length > MAX_PROSE_LENGTH
  );
  if (overlong !== undefined) {
    return deny(
      staleSurfaceDenial(
        destination,
        `The review surface reported ${overlong.sent.length} characters for "${overlong.field}", ` +
          `which is a single line and is capped at ${MAX_PROSE_LENGTH}.`
      ),
      { before: canonical, warnings }
    );
  }

  /**
   * The lines the reviewer changed, each with both halves, so an untouched title logs no edit. One
   * list for the payload write, the `edited` flag and the audit row's `before` and `after`.
   */
  const lineEdits = lineFieldsOf(sending).filter((f) => f.sent !== f.value);
  const proseEdits = Object.fromEntries(lineEdits.map((f) => [f.field, f.sent]));
  // Every edit of a patch, with what is sent for it; the changed ones are a person's edit.
  const patchSending = editFieldsOf(sending);
  const textEdits = patchSending.filter((f) => f.sent !== f.value);

  // The body the reviewer was shown, edited or not, never `canonical` (round-trip.md). `undefined`
  // when the review had no body.
  const finalBody = blockFieldOf(sending)?.sent;

  /*
   * Did a human change the draft? The surface says so. `body !== canonical` is only the fallback
   * for a surface that does not report `edited` (round-trip.md): the window's round trip normalises
   * an untouched draft, and `auto-approve` reports `canonical` unless a caller overrode it. A line
   * edit is OR-ed in, since a surface may report `edited` about the body alone.
   */
  const bodyDiffers = finalBody !== undefined && finalBody !== canonical;
  const edited = (decision.edited ?? bodyDiffers) || lineEdits.length > 0 || textEdits.length > 0;
  // The body a person changed, by the surface's own word where it gives one: `edited` cannot say,
  // since it counts a changed line too, and a body the editor only reformatted differs as well.
  const bodyEdited = (decision.bodyEdited ?? bodyDiffers) && bodyDiffers;

  /*
   * The prose backstop: the window blocks these, and this refuses them again on the way out, since
   * `auto-approve` never calls `proseWarnings` and a stale window can show a live Approve (see
   * `BLOCKED_AFTER_APPROVAL`). Read off `sending`, the merge the payload is written from, so a
   * reviewer emptying a title is caught. Errors only: `prose/too-long` is a warning, the reviewer's
   * to overrule. PROBED: Jira answers 400 to both `""` and `"   "` on `fields.summary`, writing
   * nothing, so the body is lost too.
   */
  const proseErrors = [
    ...proseWarnings(
      lineFieldsOf(sending).map((f) => ({ field: f.field, value: f.sent })),
      destination,
      toolName
    ),
    // The window blocks an emptied insertion too; the tool's schema refuses the whole call.
    ...patchWarnings(patchSending.map((f) => ({ ...f, value: f.sent }))),
  ].filter(isBlocking);
  if (proseErrors.length > 0) {
    return deny(
      proseErrors.every((w) => w.code === 'prose/empty')
        ? emptyProseDenial(destination, proseErrors)
        : refusedDenial(destination, proseErrors),
      { edited, before: canonical, warnings }
    );
  }

  /*
   * Re-render what is sent and refuse what the destination rejects: a heading inside a blockquote
   * is a verified Jira 400 that loses the whole comment. The backstop behind the window's disabled
   * Approve (`BLOCKED_AFTER_APPROVAL`). Keyed on the body, not `edited`: an unedited approval
   * usually carries the round trip, not `canonical`.
   */
  const finalRender =
    finalBody === undefined || finalBody === canonical ? rendered : renderFor(finalBody);
  if (finalRender.blocked) {
    const errors = finalRender.warnings.filter((w) => w.severity === 'error');
    // An empty body is `render()`'s `body/empty` error, so the window blocks it too; it gets its
    // own message here because "fix the structural problems" is wrong for a deleted draft.
    return deny(
      errors.some((w) => w.code === 'body/empty')
        ? emptyBodyDenial(destination)
        : errors.every(isLengthRefusal)
          ? refusedDenial(destination, errors)
          : blockedDenial(destination, errors),
      { edited, before: canonical, warnings }
    );
  }

  return {
    exitCode: 0,
    human: surface.human,
    edited,
    ...(edited
      ? {
          sent: {
            ...(bodyEdited ? { body: finalBody } : {}),
            // A changed edit is reported as its path and text, as a line is.
            lines: [...lineEdits, ...textEdits].map((f) => ({ field: f.field, value: f.sent })),
          },
        }
      : {}),
    updatedInput: buildUpdatedInput(
      // The render of the body being sent: it knows whether that body was converted and what is
      // stamped beside it.
      finalRender,
      // The patch with the reviewer's text in it, when this was one: same operations, same order.
      patch === undefined
        ? toolInput
        : writePatchEdits(toolInput, patch.delta, textEdits.map((f) => ({ edit: f.edit, sent: f.sent }))),
      // `undefined` with no body, spelled only here: `buildUpdatedInput` then writes neither the
      // field nor `extraToolInput`.
      finalBody === undefined ? undefined : wireBody(finalRender, finalRender.converted),
      bodyField,
      proseEdits
    ),
    audit: {
      destination,
      toolName,
      context,
      outcome: 'approved',
      edited,
      // Absent when the review had no body (`AuditRecord.before`).
      ...(canonical === undefined ? {} : { before: canonical }),
      // The audience the reviewer was shown, not one recomputed after the config changes.
      ...audienceRow(),
      // The markdown sent, whenever it differs from `before`, edited or not (`AuditRecord.after`).
      ...(finalBody === canonical ? {} : { after: finalBody }),
      // `silenced` and `fixes` pass straight through, never defaulted: only the surface knows them,
      // and absent differs from `[]` (`AuditRecord.silenced`, `AuditRecord.fixes`).
      ...(decision.silenced === undefined ? {} : { silenced: decision.silenced }),
      warnings,
      ...(decision.fixes === undefined ? {} : { fixes: decision.fixes }),
      // Changed lines only, both halves; no key when none changed (`AuditRecord.prose`).
      ...(lineEdits.length > 0
        ? { prose: lineEdits.map((f) => ({ field: f.field, before: f.value, after: f.sent })) }
        : {}),
      // A reviewed patch: every edit, as shown and as sent (`AuditRecord.patch`).
      ...(patchSending.length > 0 ? { patch: patchSending.map(patchRow) } : {}),
      ...(surfaceName ? { surface: surfaceName } : {}),
    } satisfies AuditRecord,
  };
}

/** One edit of the patch as the log keeps it (`AuditRecord.patch`). */
function patchRow(f: ReviewFieldValue & { kind: 'edit'; sent: string }): PatchAuditRow {
  return {
    field: f.field,
    op: f.edit.op,
    anchors: Object.fromEntries(f.edit.anchors.map((a) => [a.key, a.value])),
    ...(f.edit.flags.length > 0 ? { flags: f.edit.flags } : {}),
    before: f.value,
    ...(f.sent === f.value ? {} : { after: f.sent }),
  };
}

// ---------------------------------------------------------------------------
// Denials. Each carries explicit `guidance`, so the agent does not retry the identical send.
// ---------------------------------------------------------------------------

/**
 * No body could be read out of the payload. `unavailable`: nobody objected, the gate could not
 * run. One code per shape, so the adapter's schema-drift fail-open applies to drift alone: a
 * `commentBody: 123` or a Slack tool routed to the Jira profile must not become an unreviewed
 * allow.
 *
 *   body/missing-field      absent, and another field looks like prose. Schema drift: the fail-open
 *                           keeps a renamed field from making draftgate a wall.
 *   body/wrong-type         present and not a string. A non-string body is unprobed. Asks.
 *   body/unrecognised       absent, and nothing looks like a message: a misrouted tool. Asks.
 *   body/preformatted       a string in the destination's own format (Jira's
 *                           `contentFormat: "adf"`). As markdown it would show raw JSON, then wrap
 *                           it in a new ADF document. Asks.
 *   body/patch-unreadable   a delta instead of a body (Linear's `patch`) whose edits the window
 *                           cannot show (`extractPatch`; one it can show is reviewed). Asks; the
 *                           code gives the agent, the log's `reason` and the digest the true cause.
 *   body/nested-prose       absent, and undeclared prose sits inside a structured field. Asks.
 */
function missingBodyDenial(destination: string, error: Error): Denial {
  // Code and failure both come from the error, read out of the one table in `payload.ts`. The
  // fallback is unreachable from `review()`, which rethrows anything else as a crash.
  const failure = error instanceof MissingBodyFieldError ? error.failure : 'unrecognised';
  return {
    outcome: 'unavailable',
    code: BODY_FAILURES[failure].code,
    destination,
    reason: error.message,
    // From the table too: several shapes need their own advice.
    guidance: BODY_FAILURES[failure].guidance,
  };
}

/**
 * The decision does not match the review that was shown: an out-of-date window. Two cases differ
 * only in the sentence: no shown field reported, or a changed line over the cap. `unavailable`:
 * nobody objected, so the call goes to the permission prompt.
 */
function staleSurfaceDenial(destination: string, reason: string): Denial {
  return {
    outcome: 'unavailable',
    code: SURFACE_STALE,
    destination,
    // The remedy is in `reason`, the half the hook's fallback row shows the user; `guidance` is
    // the agent's.
    reason: `${reason} Run ${REMEDY.rebuildWindow} to rebuild it before the next send.`,
    guidance:
      'This is a problem with the installed review window, NOT with the message. Do not rewrite ' +
      'the message, and report the reason above to the user.',
  };
}

function timeoutDenial(destination: string, timeoutMs: number): Denial {
  return {
    outcome: 'timeout',
    destination,
    reason: `No decision within ${Math.round(timeoutMs / 1000)}s, so the send was denied.`,
    guidance:
      'Do not resend. The reviewer was not available. Report that the message is awaiting review ' +
      'and move on to other work.',
  };
}

function rejectDenial(destination: string, reason?: string): Denial {
  return {
    outcome: 'rejected',
    destination,
    reason: reason?.trim() || 'The reviewer rejected the message without giving a reason.',
    guidance:
      'Do not resend this message unchanged. If the reason above says what to change, revise and ' +
      'try once. Otherwise ask the user what they want changed.',
  };
}

/** The gate could not run. Not phrased as feedback on the message (see `Decision`'s `unavailable`). */
function unavailableDenial(
  destination: string,
  reason: string,
  // What the surface said this was, when it could tell (see `Decision`'s `cause`).
  cause: typeof SURFACE_UNAVAILABLE | typeof SURFACE_STALE = SURFACE_UNAVAILABLE
): Denial {
  return {
    outcome: 'unavailable',
    code: cause,
    destination,
    reason,
    guidance:
      'This is a problem with the review tool, NOT with the message. Do not rewrite the message ' +
      'and do not retry the send. Report the reason above to the user so they can fix their ' +
      'draftgate installation.',
  };
}

/**
 * Deleting the whole draft is a rejection, and the agent should be told that rather than told to
 * repair structure.
 */
function emptyBodyDenial(destination: string): Denial {
  return {
    outcome: 'rejected',
    destination,
    reason: 'The approved body is empty, so there is nothing to send.',
    guidance:
      'Nothing was sent. The reviewer deleted the whole message, which is equivalent to rejecting ' +
      'it. Ask the user what they want said before trying again.',
  };
}

/**
 * A prose field that would go out blank. Its own denial, naming the field, and not
 * `BLOCKED_AFTER_APPROVAL`: this is a report about the message, not a stale install.
 */
function emptyProseDenial(destination: string, empty: { field?: string }[]): Denial {
  const fields = empty.map((w) => w.field ?? '(unnamed)').join(', ');
  return {
    outcome: 'rejected',
    destination,
    reason: `Not sent: ${fields} would go out empty.`,
    guidance:
      'Nothing was sent. Sending a field blank is not the same as leaving it alone -- omit the ' +
      'field entirely to leave it unchanged, or supply a value. Jira rejects an empty summary ' +
      'outright (400), which loses the body as well. Ask the user what it should say.',
  };
}

/** The errors behind a denial, each with its code, as one line of the audit log's `reason`. */
function listed(errors: { code: string; message: string }[]): string {
  return errors.map((e) => `[${e.code}] ${e.message}`).join(' ');
}

/**
 * What to tell the agent about one refused code. A length refusal is recognised by its registry
 * column (`isLengthRefusal`), so a new body limit needs no line here; anything else gets a neutral
 * remedy.
 */
function refusalRemedy({ code }: Pick<Warning, 'code'>): string {
  if (code === 'prose/line-break') return 'Put the field on one line.';
  if (code === 'prose/empty') return 'Omit a field you do not mean to change, or give it a value.';
  if (code === 'patch/empty-text') return 'Give every insertion some text.';
  if (code === 'prose/too-long' || isLengthRefusal({ code })) {
    return 'Shorten it, or ask the user how to split it.';
  }
  return 'Fix what the reason names.';
}

/**
 * Something the destination would refuse (a body or title past its probed length, a line break in
 * a field that refuses one), as opposed to a structure core blocks. Not `BLOCKED_AFTER_APPROVAL`:
 * this is usually `auto-approve`, which never asks core, passing an oversized draft, not a stale
 * install. Every error is listed, with one remedy per kind present.
 */
function refusedDenial(destination: string, errors: Warning[]): Denial {
  // Deduplicated: a title can be refused for more than one reason at once.
  const remedies = [...new Set(errors.map(refusalRemedy))];
  return {
    outcome: 'rejected',
    destination,
    reason: `Not sent: ${listed(errors)}`,
    guidance:
      'Nothing was sent. The destination refuses the whole call for this, so resending it ' +
      `unchanged fails the same way. ${remedies.join(' ')}`,
  };
}

function blockedDenial(destination: string, errors: { code: string; message: string }[]): Denial {
  return {
    // `rejected`, so the adapter denies; the code tells it from a person saying no (types.ts).
    outcome: 'rejected',
    code: BLOCKED_AFTER_APPROVAL,
    destination,
    reason:
      `The approved text would not be delivered by ${destination}: ${listed(errors)}`,
    guidance:
      'Do not resend unchanged. Fix the problems listed above first. This was caught ' +
      'before sending, so nothing was posted. If the review surface showed Approve as available, ' +
      `it is out of date with core -- run ${REMEDY.rebuildWindow}.`,
  };
}

// ---------------------------------------------------------------------------

async function raceTimeout(p: Promise<Decision>, ms: number): Promise<Decision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Decision>((resolve) => {
    timer = setTimeout(() => resolve({ action: 'timeout' }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
