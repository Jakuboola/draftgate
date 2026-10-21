/**
 * The hook's decision logic, with the subprocess factored out so it can be tested without one.
 *
 * | situation                                   | decision | why |
 * |---------------------------------------------|----------|-----|
 * | stdin unparseable / no `tool_name`          | `ask`    | cannot gate what cannot be read |
 * | `tool_input` is not an object               | `ask`    | no field to read a body out of |
 * | tool not in the map                         | `deny`   | the matcher is generated from the map, so reaching here is a configuration error |
 * | ...but its half is in `declined`            | (none)   | only a stale matcher sends a declined tool here; Claude Code's own flow decides |
 * | CLI denial `code: body/missing-field`       | `allow`  | schema drift: warn loudly, fail open |
 * | CLI denial `code: body/preformatted`        | `ask`    | the body is not markdown, so there is nothing to preview |
 * | CLI denial `code: body/patch-unreadable`    | `ask`    | a delta whose edits draftgate cannot show (a readable one is reviewed) |
 * | `body/unrecognised` on a `bodyOptional` tool | `allow`  | the tool's body is optional and this call omitted it |
 * | CLI exit 0                                  | `allow`  | a human approved; send the complete `updatedInput`, and tell the agent what they changed |
 * | CLI exit 0, payload unreadable              | `ask`    | their approval survived, their edit did not |
 * | CLI exit 1/2, `outcome: rejected\|timeout`   | `deny`   | a human said no, or nobody did in time |
 * | CLI exit 1, `outcome: unavailable`          | `ask`    | see below |
 * | CLI failed with no parseable denial         | `ask`    | not a human decision either |
 *
 * `surfaces/window.ts` fails closed and reports `outcome: 'unavailable'` when it never asked a human
 * (missing binary, unbuilt window, crash); what that means is decided here. Allowing would let a
 * window that cannot start disable the whole gate unnoticed; denying would block every send until
 * the install is repaired. `ask` routes to Claude Code's own prompt, so a human still decides, without
 * the preview, editing or (for Jira) the ADF substitution, and the prompt's first line says so.
 */

import { profiles, type DestinationName } from '../../../core/src/index';
import type { Denial, DenialCode } from '../../../cli/src/types';
import type { DecisionFile } from '../../../cli/src/decisionFile';
import { claimedRouteFacts, type RouteFacts } from '../../../cli/src/routeFacts';
import type { HookDecision } from './hookOutput';
import { FAIL_OPEN, declinedHalfOf, resolveRoute, type ToolMap } from './toolMap';
import { REMEDY } from '../../../core/src/remedies';
import { sentence } from '../../../cli/src/text';


/** The `PreToolUse` payload, as far as this adapter reads it. */
export interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
}

/**
 * What `runReview` reported, as the adapter recovers it from the CLI process. The decision file's
 * facts ride along as the file states them, each absent when unknown: which surface decided (the
 * wording falls back to a claim true either way), whether a person made the decision (absent reads
 * as not a person), and whether they edited it, with what the edit sent.
 */
export interface CliResult
  extends Partial<Pick<DecisionFile, 'surface' | 'human' | 'edited' | 'sentBody' | 'sentLines'>> {
  exitCode: number;
  /** The payload out of the `--decision` file, when the CLI approved and it could be read. */
  updatedInput?: Record<string, unknown>;
  /**
   * The CLI's structured denial, typed by the CLI's own `Denial`, so a renamed field cannot
   * type-check on both sides. `parseDecisionFile` builds it field by field: a file missing `reason`
   * is unreadable, not a denial with no reason.
   */
  denial?: Denial;
  /** Anything that stopped the CLI from producing either of the above. */
  failure?: string;
}

/**
 * What the adapter hands the CLI for one review. `RouteFacts` is embedded, not restated: every route
 * fact is often absent, so a restated list could not show one had been forgotten. The tool map lives
 * here and the CLI is blind to it, so route facts are forwarded, not re-derived.
 */
export interface HookReviewRequest extends RouteFacts {
  destination: DestinationName;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId?: string;
  /**
   * The mapped entry whose tool half this name matched, when nobody configured it. A name, so the
   * reviewer can check what the route was inferred from. Absent means the route was configured.
   */
  inferredFrom?: string;
}

export interface DecideOptions {
  toolMap: ToolMap;
  /**
   * Tool halves the operator does not gate (`tools.json`'s `declined`). Their entries are already
   * gone from `toolMap`; this tells a stale matcher firing for one apart from a tool nobody
   * configured. Required, so a new caller cannot turn a decline back into a denial.
   */
  declined: readonly string[];
  /**
   * Run a review; injected so the policy is testable with no subprocess and no window. `sessionId`
   * is `PreToolUse`'s `session_id`, so the review log can tell a retry from a second message.
   */
  review(req: HookReviewRequest): Promise<CliResult>;
}

/**
 * Every denial code, and what this adapter does with it. The branches below decide; this table only
 * makes `DenialCode` impossible to extend without a line here, because `Record<DenialCode, …>` will
 * not compile until the new code is named. A typo in a `string` code (`body/missing_field`) would
 * type-check everywhere and silently disable the schema-drift branch.
 */
const CODE_POLICY: Record<DenialCode, string> = {
  'body/missing-field':
    'ALLOW, but only on a default-mapped route and only when the gate could not run (schema drift)',
  'body/unrecognised':
    'ALLOW when the route is bodyOptional -- the tool has no body field and this call carried ' +
    'none; otherwise ASK, because the payload is probably misrouted',
  'body/wrong-type':
    'ASK: a present-but-wrong-typed body is not schema drift, and nobody reviewed it',
  'body/preformatted':
    'ASK: the body is already converted, so there is nothing this gate can show a reviewer',
  'body/patch-unreadable':
    'ASK: the payload edits content only the destination holds, and its edits are not ones the ' +
    'window can show (a patch it can show is reviewed edit by edit)',
  'body/blocked-after-approval':
    'ASK: the window approved what the CLI reports as blocked, which means a stale window build',
  'body/nested-prose':
    'ASK: the call carries text nested in a structured field (GitHub `issue_fields`) and nothing ' +
    'draftgate can show as a draft, so `bodyOptional` must not read it as a call with no message',
  'context/unaddressable':
    'ASK: a key the context strip cannot address means the review could not be complete',
  'review/crashed': 'ASK: the gate broke, and a broken gate is not a person objecting',
  // Both reach the generic `unavailable` row; they name a cause in the review log.
  'surface/unavailable':
    'ASK: the window never opened, so nobody reviewed this -- the header says why not allow or deny',
  'surface/stale':
    'ASK: the window answered but is older than the CLI, so it may have shown less than it was sent',
};

/** Read once so the table cannot be dropped as unused, and so a reader can find it. */
export function codePolicy(code: DenialCode): string {
  return CODE_POLICY[code];
}

/**
 * Claude Code's caps on the fields this adapter fills, read out of the Claude Code 2.1.261 binary.
 *
 *   dKr = { reason: 2000, stopReason: 2000, systemMessage: 4000, additionalContext: 8000,
 *           permissionDecisionReason: 2000 }
 *   fKr = { reason: 20,   stopReason: 20,   systemMessage: 20,   additionalContext: ...,
 *           permissionDecisionReason: 20 }
 *
 * and the trim itself:
 *
 *   function o_n(e,t,r){ let o=e.replace(/\r\n?/g,"\n").split("\n"),
 *                        d=o.slice(0,r)... ; return { text: oe(d,t)..., truncated: ... } }
 *
 * The first 20 lines, then the first 2000 characters of those: both cuts are from the end. A
 * denial's anti-retry `guidance` comes after its `reason`, so `denialReason` trims the reason itself.
 */
export const REASON_MAX_CHARS = 2000;
export const REASON_MAX_LINES = 20;

/**
 * Cut `text` to at most `lines` lines and `chars` characters, saying so when it cuts. The mark fits
 * inside `chars`, and a cut never splits a surrogate pair. Line endings come back as `\n`, as
 * Claude Code splits them.
 */
function clampCut(text: string, chars: number, lines: number): { text: string; cut: boolean } {
  const MARK = ' [...]';
  const byLine = text.replace(/\r\n?/g, '\n').split('\n');
  const out = byLine.slice(0, lines).join('\n');
  if (byLine.length <= lines && out.length <= chars) return { text: out, cut: false };
  const kept = out.slice(0, Math.max(0, chars - MARK.length)).replace(/[\uD800-\uDBFF]$/, '');
  return { text: kept.replace(/\s+$/, '') + MARK, cut: true };
}

function clamp(text: string, chars: number, lines: number): string {
  return clampCut(text, chars, lines).text;
}

/**
 * A denial's reason with its guidance, composed so the guidance always survives the harness's trim:
 * the reason (a human's or a profile's text) is the half that gets cut. Order stays why, then what
 * to do.
 */
export function denialReason(reason?: string, guidance?: string): string {
  const tail = (guidance ?? '').trim();
  const head = (reason ?? '').trim();
  if (tail === '') return clampReason(head);
  if (head === '') return clampReason(tail);
  // The tail is never trimmed: it is draftgate's own short sentence.
  const tailLines = tail.split('\n').length + 1;
  const budget = {
    chars: Math.max(0, REASON_MAX_CHARS - tail.length - 2),
    lines: Math.max(1, REASON_MAX_LINES - tailLines),
  };
  return `${clamp(head, budget.chars, budget.lines)}\n\n${tail}`;
}

export async function decide(raw: string, opts: DecideOptions): Promise<HookDecision> {
  let input: HookInput;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hook input is not a JSON object');
    }
    input = parsed as HookInput;
  } catch (e) {
    return unreadable('it could not read the hook input', (e as Error).message);
  }

  const toolName = input.tool_name;
  if (typeof toolName !== 'string' || toolName === '') {
    return unreadable('the hook input names no tool');
  }

  // A configured entry, or an inferred one: a tool half a configured entry uses, under a server
  // nobody named (a project in another folder with its own server prefix). `resolveRoute` uses
  // `Object.hasOwn`, so `tool_name: "toString"` is an unknown tool, not a Function route.
  const resolved = resolveRoute(toolName, opts.toolMap);
  const half = resolved === null ? declinedHalfOf(toolName, opts.declined) : null;
  if (half !== null) {
    // Declined, and the matcher still fires because the registration predates the decline. No
    // decision, not `allow`: `allow` would skip Claude Code's own permission flow, guarding the tool
    // less than a re-register does. `--doctor` names the stale matcher.
    return { permissionDecision: 'none' };
  }
  if (resolved === null) {
    // `settings.json` names a tool the map does not: a hand-edited matcher, or a tool removed from
    // the map (`"tool": null`) without registering again. Deny, not ask: a matcher entry means
    // someone asked for that tool to be reviewed, and one distracted "yes" would send it ungated.
    return {
      permissionDecision: 'deny',
      reason:
        `draftgate was asked to review "${toolName}", which is not in its tool map, so it cannot ` +
        'tell which destination this is going to and cannot show a faithful preview. Nothing was ' +
        'sent. Do not retry: report this to the user, who needs to add the tool to ' +
        `~/.draftgate/tools.json, or decline it there, and run ${REMEDY.pluginSetup} again.`,
      systemMessage:
        `draftgate: the PreToolUse matcher fired for "${toolName}" but the tool map has no entry ` +
        `for it. Run ${REMEDY.pluginSetup}.`,
    };
  }
  const { route, inferred, matchedEntry } = resolved;
  const { destination } = route;
  const word = profiles[destination].displayName;

  // Never coerce a non-object `tool_input` to `{}`: that falls through to the fail-open below and
  // allows a call nobody read.
  if (
    input.tool_input === null ||
    typeof input.tool_input !== 'object' ||
    Array.isArray(input.tool_input)
  ) {
    return unreadable(`this "${toolName}" call's input is not a JSON object`);
  }
  const toolInput = input.tool_input as Record<string, unknown>;

  const result = await opts.review({
    destination,
    toolName,
    toolInput,
    ...(input.session_id ? { sessionId: input.session_id } : {}),
    ...(inferred && matchedEntry ? { inferredFrom: matchedEntry } : {}),
    // Every route fact the route claims, by the type that defines them, so a new fact cannot be
    // left off this hop (the window would show the body without it).
    ...claimedRouteFacts(route),
  });

  if (result.exitCode === 0) {
    if (!result.updatedInput) {
      // Approved, and the payload was lost on the way back. Denying discards the decision; allowing
      // the original input sends unconverted markdown after they approved a converted preview.
      return ask({
        headline: `draftgate: the reviewer approved this ${word} message, but the approved text could not be read back.`,
        approving:
          `Approving here sends the ORIGINAL text, discarding any edit${inMarkdown(destination)}; ` +
          'decline and resend if the draft was edited.',
        detail: result.failure,
        agent:
          `The reviewer approved this ${word} message in draftgate, but the approved text could not ` +
          `be read back, so the ORIGINAL text went ahead${inMarkdown(destination)}, without any edit ` +
          'the reviewer made. Tell the user, in case the draft had been edited.',
      });
    }
    const context = approvalContext(word, result);
    // The reason is a record in the session's transcript file (`hookOutput.ts`): what the agent read.
    return {
      permissionDecision: 'allow',
      updatedInput: result.updatedInput,
      reason: clampReason(context),
      additionalContext: context,
    };
  }

  const denial = result.denial;
  if (!denial || typeof denial.outcome !== 'string') {
    return notReviewed({
      cause: 'it could not run the review',
      approving: asWritten(destination),
      detail: result.failure ?? `The CLI exited ${result.exitCode}.`,
    });
  }

  /*
   * Everything below reads a code, and nothing below may run for a human's refusal: a code says what
   * the payload looked like, never whether a person objected. As control flow, a new code branch
   * cannot be written without this guard; on the two `allow` branches below, missing it would turn
   * an explicit rejection into a send of the reviewer's own input. No CLI path produces a code with
   * `rejected` or `timeout` today, so the guard is pinned rather than trusted.
   */
  if (denial.outcome !== 'unavailable') {
    return { permissionDecision: 'deny', reason: denialReason(denial.reason, denial.guidance) };
  }

  // Schema drift: the body field is absent and another field looks like it holds the prose. Fail
  // open, loudly, so draftgate is not a wall the week a connector changes. The CLI detects it
  // (`extractBody`) and writes the review log row; the policy is here.
  //
  // Only for a route the default map assigns (`ToolRoute.schemaOwner` through `FAIL_OPEN`, never
  // recomputed from `DEFAULT_TOOL_MAP`): a typo
  // in an operator's `tools.json` (`{"mcp__claude_ai_Slack__slack_send_message": "jira"}`) finds no
  // `commentBody` either, and a mistake belongs at Claude Code's prompt.
  if (denial.code === 'body/missing-field' && FAIL_OPEN[route.schemaOwner].schemaDrift) {
    const cause = `the ${word} tool's schema seems to have changed`;
    return allowUnreviewed(toolInput, {
      cause,
      detail: denial.reason,
      systemMessage:
        `draftgate: not reviewed -- ${cause}, so this and later sends through it go out unreviewed ` +
        `until draftgate is updated for it (check ${REMEDY.pluginManager}). ${sentence(denial.reason)}`,
    });
  }

  /*
   * A tool whose body is optional, called without one (`addWorklogToJiraIssue` with `{cloudId,
   * issueIdOrKey, timeSpent: "2h"}`): nothing to review, and asking would put every comment-less
   * worklog at the prompt. Only `body/unrecognised`; a worklog with a comment is reviewed.
   *
   * The residual risk is `plausibleProseField`'s conservatism: a one-word message in a misrouted
   * payload reads as "not prose". That also needs `bodyOptional` on the misrouted tool, which is why
   * the flag is refused unless literally `true`.
   *
   * Never on an inferred route: `resolveRoute` does not copy `bodyOptional` onto one, and
   * `FAIL_OPEN.inferred.bodyOptional` is false as a second guard. `bodyOptional` is a claim about a
   * tool's schema, and nobody made it about a tool nobody named. No `systemMessage`: the review log
   * has the row.
   */
  if (
    denial.code === 'body/unrecognised' &&
    route.bodyOptional &&
    FAIL_OPEN[route.schemaOwner].bodyOptional
  ) {
    return allowUnreviewed(toolInput, {
      cause: `"${toolName}" takes an optional message and this call carries none, so there was nothing to review`,
    });
  }

  // Already in the destination's own format: nothing is missing or misrouted, and approving sends
  // the agent's document exactly as written.
  if (denial.code === 'body/preformatted') {
    return notReviewed({
      cause: `this ${word} body is already in ${word}'s own format, not markdown`,
      approving: AS_WRITTEN,
      next: 'To have a later message reviewed, send its body as markdown.',
    });
  }

  // A delta whose edits the window cannot show, not a missing message: without its own code it
  // would read as `body/unrecognised` and point the user at a tool map that is fine. The CLI's
  // reason names what could not be shown.
  if (denial.code === 'body/patch-unreadable') {
    return notReviewed({
      cause: `a ${word} patch whose edits draftgate cannot show`,
      approving: AS_WRITTEN,
      detail: denial.reason,
      next: 'To have a later edit reviewed, send the full new text of the field instead of a patch.',
    });
  }

  // A payload draftgate can describe and cannot show: text nested in `issue_fields` (else
  // `body/unrecognised`, which a `bodyOptional` route allows), or a context key the window cannot
  // address (a dot, an empty key, `__proto__`). The CLI's reason names the field.
  if (denial.code === 'body/nested-prose' || denial.code === 'context/unaddressable') {
    return notReviewed({
      cause: `the review window cannot show everything in this ${word} call`,
      approving: asWritten(destination),
      detail: denial.reason,
    });
  }

  // An unreadable payload, not an unreadable window. `body/missing-field` reaches here only when the
  // fail-open above declined (an operator, inferred or `connector-open` route).
  if (
    denial.code === 'body/wrong-type' ||
    denial.code === 'body/unrecognised' ||
    denial.code === 'body/missing-field'
  ) {
    return notReviewed({
      cause: `no message it can read in this ${word} call`,
      approving: asWritten(destination),
      detail:
        `${sentence(denial.reason)} Check ~/.draftgate/tools.json and the destination's body ` +
        'field; this is not a problem with the review window.',
    });
  }

  // An unavailable gate. The remedy is the CLI's, inside `denial.reason`: only the layer that saw
  // the failure knows which fits. This row picks the headline from the code.
  return notReviewed({
    cause: `it ${unavailableHeadline(denial.code)}`,
    approving: asWritten(destination),
    detail: denial.reason,
  });
}

/**
 * The generic `unavailable` row's headline. `review/crashed` fails before any window, and
 * `surface/stale` is a window that did open.
 */
function unavailableHeadline(code: DenialCode | undefined): string {
  switch (code) {
    case 'review/crashed':
      return 'hit an internal error before it could show a review';
    case 'surface/stale':
      return 'opened a review window older than itself';
    default:
      return 'could not open its review window';
  }
}

/**
 * An approval no person made. Said by the surface (`ReviewSurface.human`), not its name; absent
 * reads as not a person.
 */
function machineApproval(word: string, surface: string | undefined): string {
  const named = surface ? `draftgate's "${surface}" surface` : 'a draftgate surface that did not identify itself';
  return `draftgate: this ${word} message was approved by ${named}, not by a person; nobody read it.`;
}

/**
 * What the agent reads after an approval's tool result, its only word of the review (`hookOutput.ts`):
 * whether a person saw the message and, if they edited it, what the tool received instead of the
 * draft. The changed lines and body are repeated because nothing else shows the agent an edit, and
 * an agent that does not know quotes words the reviewer removed. It says what happened, never what
 * to send next, and never which part the person changed: `sentBody` is any body that differs from
 * the draft, and the editor's own reformatting differs too.
 */
function approvalContext(word: string, result: CliResult): string {
  if (result.human !== true) return machineApproval(word, result.surface);
  if (result.edited !== true) {
    return `draftgate: a person reviewed this ${word} message and approved it as written.`;
  }
  const edited = `draftgate: a person reviewed this ${word} message and edited it before approving it`;
  const lines = result.sentLines ?? [];
  if (result.sentBody === undefined && lines.length === 0) {
    return `${edited}; draftgate cannot show you what changed.`;
  }
  const head = [
    `${edited}, so the tool received their version, not your draft. What they changed (everything ` +
      'else is as you wrote it):',
    ...lines.map((l) => `${l.field}: ${l.value}`),
  ].join('\n');
  if (result.sentBody === undefined) return clampContext(head).text;
  const whole = clampContext(`${head}\nThe body, in markdown:\n\n${result.sentBody}`);
  if (!whole.cut) return whole.text;
  return clampContext(`${head}\nThe body, in markdown, cut to fit here (only its start):\n\n${result.sentBody}`).text;
}

/**
 * What the agent reads of a call that went ahead unreviewed, `ask` and `allow` alike: what
 * happened, and that sending it again would not get it reviewed.
 */
function notReviewedContext(cause: string, next?: string): string {
  return (
    `draftgate did not review this tool call: ${cause}. It went ahead without that review, ` +
    `so do not send it again to have it reviewed.${next ? ` ${next}` : ''}`
  );
}

/**
 * Claude Code's caps on `additionalContext`, read out of the Claude Code 2.1.302 binary:
 *
 *   zN = { ..., additionalContext: 8000, ... },  mb = 200,  WN = { ..., additionalContext: mb, ... }
 *
 * through the same trim as `REASON_MAX_CHARS`: the first 200 lines, then the first 8000 characters,
 * cut silently. `clampContext` cuts first and says so.
 */
export const CONTEXT_MAX_CHARS = 8000;
export const CONTEXT_MAX_LINES = 200;

function clampContext(text: string): { text: string; cut: boolean } {
  return clampCut(text, CONTEXT_MAX_CHARS, CONTEXT_MAX_LINES);
}

/**
 * What a send loses by bypassing draftgate beyond the preview: the conversion, read off the
 * profile's `mode`, so a Slack prompt never mentions ADF.
 */
function inMarkdown(destination: DestinationName): string {
  return profiles[destination].mode === 'convert-and-replace'
    ? `, in markdown rather than ${profiles[destination].displayName}'s own format`
    : '';
}

/**
 * The approving line; it adds the markdown note only for a destination that converts. A patch and
 * an already-converted body say `AS_WRITTEN`: there was no markdown to convert.
 */
function asWritten(destination: DestinationName): string {
  return `Approving sends it as written${inMarkdown(destination)}.`;
}

const AS_WRITTEN = 'Approving sends it as written.';

/**
 * Every `ask`, laid out for who reads each field (`hookOutput.ts`). The reason's first line is the
 * whole message for the person deciding: what happened and what approving does; the detail goes
 * after it, since Claude Code trims from the end. `systemMessage` is the headline alone. `agent` is
 * read only after an approval, so it says what already happened, never the CLI's `guidance` (written
 * for an unsent message, it would invite a duplicate send).
 */
function ask(parts: { headline: string; approving: string; detail?: string; agent: string }): HookDecision {
  const first = `${parts.headline} ${parts.approving}`;
  const detail = parts.detail?.trim();
  return {
    permissionDecision: 'ask',
    reason: clampReason(detail ? `${first}\n${sentence(detail)}` : first),
    systemMessage: parts.headline,
    additionalContext: parts.agent,
  };
}

/**
 * The `ask` for a call nobody reviewed. `cause` finishes "draftgate: not reviewed --"; `next` is
 * what the agent can do differently on a later call, never a reason to send this one again.
 */
function notReviewed(parts: { cause: string; approving: string; detail?: string; next?: string }): HookDecision {
  return ask({
    headline: `draftgate: not reviewed -- ${parts.cause}.`,
    approving: parts.approving,
    detail: parts.detail,
    agent: notReviewedContext(parts.cause, parts.next),
  });
}

/**
 * An `allow` for a call nobody reviewed (the two hatches in `FAIL_OPEN`): the reason (a transcript
 * record) and the agent's context from one `cause`, as `notReviewed` does for an `ask`.
 */
function allowUnreviewed(
  updatedInput: Record<string, unknown>,
  parts: { cause: string; detail?: string; systemMessage?: string }
): HookDecision {
  const headline = `draftgate: not reviewed -- ${parts.cause}.`;
  return {
    permissionDecision: 'allow',
    updatedInput,
    reason: clampReason(parts.detail ? `${headline}\n${sentence(parts.detail)}` : headline),
    additionalContext: notReviewedContext(parts.cause),
    ...(parts.systemMessage ? { systemMessage: parts.systemMessage } : {}),
  };
}

/** A reason cut to what Claude Code draws, from the end, saying so when it cuts. */
export function clampReason(text: string): string {
  return clamp(text, REASON_MAX_CHARS, REASON_MAX_LINES);
}

/**
 * The gate could not be applied, and no human said anything either way: `ask`, never `deny` (a
 * person objected) or `allow` (nobody saw it). `detail` is the error or the fix, on the next line.
 */
export function unreadable(cause: string, detail?: string): HookDecision {
  return notReviewed({ cause, approving: AS_WRITTEN, detail });
}
