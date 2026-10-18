/**
 * Reading a body out of a tool payload and putting one back.
 *
 * The field names come from the destination profile, and they are the connectors' real names
 * (Slack's `message`, Jira's `commentBody`), not the obvious guesses (`text`, `body`). They are
 * checked against the payload here rather than assumed.
 */

import { profiles, type DestinationName, type RenderResult } from '../../core/src/index';
import { isPlainObject } from './json';

/**
 * Why a body could not be read. Only `drift` (schema drift) may fail open. The hook adapter keys its
 * policy on the shape, so collapsing them would fail open on a payload draftgate does not understand,
 * or ask on real drift.
 *
 * `preformatted`: the body is a readable string, but not markdown. `delta`: the payload carries edit
 * operations against text that lives at the destination (see `deltaBy`).
 */
export type BodyFailure =
  | 'drift'
  | 'wrong-type'
  | 'unrecognised'
  | 'preformatted'
  | 'delta'
  | 'nested';

/**
 * A string in a field nobody declared that plausibly holds prose rather than an identifier: the
 * check behind the drift fail-open, so that it covers a renamed body and not every missing one.
 * `looksLikeProse` decides: `C1`, `SUPPORT-123` and a cloudId UUID fail, `"Deploy finished, see the
 * thread"` passes, and a one-word message fails and degrades to `ask`.
 *
 * Every declared field is excluded, or `issue_write` with a `title` and no `body` reads its own title
 * as a renamed body and fails open with the title unread. Scans the top level and a nested body's own
 * container, or a body renamed from `fields.description` to `fields.body` beside a reviewable
 * `fields.summary` goes out unread under an approval. Returns a path, for the denial and the audit
 * row (`loggedField`).
 */
function plausibleProseField(
  toolInput: Record<string, unknown>,
  bodyField: string,
  declared: ReadonlySet<string>
): string | undefined {
  for (const prefix of scannedContainers(bodyField)) {
    const container = containerAt(toolInput, prefix);
    if (container === undefined) continue;
    for (const [key, value] of Object.entries(container)) {
      const path = [...prefix, key].join('.');
      if (declared.has(path)) continue;
      if (typeof value === 'string' && looksLikeProse(value)) return path;
    }
  }
  return undefined;
}

/**
 * Prose nested inside an array or an object, in a field nobody declared. GitHub `issue_write`'s
 * `issue_fields: [{field_name, value}]` is the case: without this, a call carrying only that text is
 * `body/unrecognised`, which the route's `bodyOptional` allows unread.
 *
 * Its own failure, not drift (`plausibleProseField`), because drift fails open; the adapter asks. A
 * declared path and everything under it is accounted for, so a route naming `labels` keeps a
 * label-only `issue_write` (`labels: ["good first issue"]`) off the permission prompt. Returns the
 * path, array indices included.
 */
function nestedProseField(
  toolInput: Record<string, unknown>,
  declared: ReadonlySet<string>
): string | undefined {
  // Iterative and depth-capped: a recursive walk overflows the stack on a 30,000-deep junk value, and
  // a path rebuilt at every node is quadratic in depth, spent out of the review deadline. Past the
  // cap the value is reported, not skipped, so text nested that deep does not read as "no message".
  const stack: [value: unknown, path: string, depth: number][] = Object.entries(toolInput).map(
    ([key, value]) => [value, key, 1]
  );
  while (stack.length > 0) {
    const [value, path, depth] = stack.pop()!;
    if (declared.has(path)) continue;
    // A top-level string (depth 1) is `plausibleProseField`'s question, not this one.
    if (typeof value === 'string') {
      if (depth > 1 && looksLikeProse(value)) return path;
      continue;
    }
    const children: [string, unknown][] = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : isPlainObject(value)
        ? Object.entries(value)
        : [];
    if (children.length === 0) continue;
    if (depth >= MAX_NESTED_DEPTH) return path;
    // Reversed so the walk reads in payload order and names the first text, not the last.
    for (let i = children.length - 1; i >= 0; i--) {
      const [key, child] = children[i]!;
      stack.push([child, `${path}.${key}`, depth + 1]);
    }
  }
  return undefined;
}

/** Deeper than any connector schema read so far nests (GitHub `issue_fields[].value` is 3). */
const MAX_NESTED_DEPTH = 32;

/**
 * Every path a route accounts for, which neither prose scan reads: the body, the declared prose
 * lines, and the context fields the route or profile names. A wildcard entry adds nothing, or `*`
 * would declare every payload.
 */
function declaredPaths(
  bodyField: string,
  lineFields: readonly string[],
  contextFields: readonly string[]
): Set<string> {
  const named = contextFields.filter((f) => !isWildcardField(f));
  return new Set([bodyField, ...lineFields, ...named]);
}

/**
 * The prose discriminator both scans use: whitespace between two non-space characters. Shared
 * because drift fails open and nested text asks; a string one reads as prose and the other does not
 * would fall through both as `unrecognised`, which a `bodyOptional` route allows.
 */
function looksLikeProse(value: string): boolean {
  return /\S\s+\S/.test(value);
}

/**
 * Which containers the drift scan looks in: the top level always (a nested body does not stop a
 * connector moving the prose to the top), and the body's own when it is nested. One level of nesting
 * is all any connector uses (`editJiraIssue`'s `fields`); a body three deep would skip the middle
 * container, which holds no prose in any schema read so far.
 */
function scannedContainers(bodyField: string): string[][] {
  const segments = parseBodyPath(bodyField);
  return segments.length > 1 ? [[], segments.slice(0, -1)] : [[]];
}

/**
 * The payload already says its body is in the destination's native format, not markdown: it sets a
 * profile's `extraToolInput` field to that value (Jira's `contentFormat: 'adf'`), read from the
 * profile so the list is kept once. `contentFormat: 'markdown'`, the connector's default, does not
 * match.
 *
 * The keys stay top-level while `bodyField` may be a path. PROBED: `contentFormat` at the top level
 * of `editJiraIssue`'s input governs the nested `fields.description` (an ADF JSON string sent there
 * reads back through REST as a real ADF tree). Returns the field that made the claim.
 */
function preformattedBy(
  destination: DestinationName,
  toolInput: Record<string, unknown>
): string | undefined {
  for (const [key, value] of Object.entries(profiles[destination].extraToolInput)) {
    if (toolInput[key] === value) return key;
  }
  return undefined;
}

/**
 * The payload carries a delta against content that lives at the destination. Linear's `patch` is
 * the case: edit operations applied server-side in place of the whole `description`. draftgate holds
 * no credentials and never calls the destination, so there is no body to review.
 *
 * Read off the profile's `deltaFields` (`[]` where there is none). Presence is the test, not shape:
 * judging whether the operations look like a patch would guess at a schema draftgate does not own.
 * Returns the field that carried it.
 */
function deltaBy(
  destination: DestinationName,
  toolInput: Record<string, unknown>
): string | undefined {
  return profiles[destination].deltaFields.find((field) => Object.hasOwn(toolInput, field));
}

/**
 * Which field a failure can name, when it can name one. A union, not same-typed optional trailing
 * parameters, where transposing two of them would compile.
 */
export type BodyFailureDetail =
  | { failure: 'drift'; field: string }
  | { failure: 'preformatted'; field: string }
  | { failure: 'delta'; field: string }
  | { failure: 'nested'; field: string }
  | { failure: 'wrong-type' }
  | { failure: 'unrecognised' };

/**
 * Everything that follows from a body failure, in one table that `missingBodyDenial` and
 * `failedBodyText` (`review.ts`) read. A member missing from a separate switch gives a denial `code`
 * no adapter row matches, which falls through to "the review window could not open".
 *
 * `guidance` stops the agent retrying the identical send. `logs` is the field the audit log quotes,
 * not always the one the message names: `preformatted` names `contentFormat` but quotes the body,
 * because "a Jira draft arrived as ADF and was never reviewed" is not recoverable later.
 */
export const BODY_FAILURES = {
  'wrong-type': {
    code: 'body/wrong-type',
    logs: 'nothing',
    guidance:
      'This is a problem with the payload or the tool schema, NOT with the message. Do not ' +
      'rewrite the message. Report the reason above to the user so they can fix the ' +
      'destination profile.',
    // Not "has no X": X is among the present keys, and a reader (or an agent) acting on that
    // sentence looks for a missing field that is right there.
    describe: (d: string, f: string, keys: string) =>
      `Payload for "${d}" has a "${f}" field, but its value is not a string, ` +
      `so there is no message to review. Present keys: ${keys}.`,
  },
  drift: {
    code: 'body/missing-field',
    logs: 'named',
    guidance:
      'This is a problem with the payload or the tool schema, NOT with the message. Do not ' +
      'rewrite the message. Report the reason above to the user so they can fix the ' +
      'destination profile.',
    describe: (d: string, f: string, keys: string, named?: string) =>
      `Payload for "${d}" has no "${f}" field, but "${named}" looks like ` +
      `it holds the message -- so the tool's schema has probably changed. ` +
      `Present keys: ${keys}.`,
  },
  unrecognised: {
    code: 'body/unrecognised',
    logs: 'nothing',
    guidance:
      'This is a problem with the payload or the tool schema, NOT with the message. Do not ' +
      'rewrite the message. Report the reason above to the user so they can fix the ' +
      'destination profile.',
    describe: (d: string, f: string, keys: string) =>
      `Payload for "${d}" has no "${f}" field and nothing else in it looks ` +
      `like a message. Present keys: ${keys}. This payload is probably not for this ` +
      `destination -- check the tool map.`,
  },
  preformatted: {
    code: 'body/preformatted',
    logs: 'body',
    // Its own guidance: the payload is well formed, so "fix the destination profile" names the wrong
    // thing. The format the agent chose is what it can change.
    guidance:
      'Nothing is wrong with the payload or with the message. draftgate can only preview ' +
      'markdown, so it could not show this draft to a human. Do not rewrite the message. If ' +
      'you want it reviewed, send the same message as markdown and let draftgate convert it.',
    describe: (d: string, f: string, keys: string, named?: string) =>
      `Payload for "${d}" sets "${named}", so its "${f}" is already in ` +
      `${d}'s own format rather than markdown. draftgate reviews markdown and cannot ` +
      `show this draft as its reader will see it. Present keys: ${keys}.`,
  },
  delta: {
    code: 'body/patch-unreadable',
    // No concatenation of the ops is the message, so logging one would record a document that never
    // existed.
    logs: 'nothing',
    // Like `preformatted`: what can change is what the agent sends ("send the whole description"),
    // not the tool map.
    guidance:
      'Nothing is wrong with the payload or with the message, and nothing needs rewriting. ' +
      'draftgate reviews a whole message and cannot read the content your edits apply to, so it ' +
      'could not show this draft to a human. If you want it reviewed, send the full new text of ' +
      'the field instead of a patch.',
    describe: (d: string, f: string, keys: string, named?: string) =>
      `Payload for "${d}" carries "${named}" rather than a whole "${f}": a list of edits ` +
      `applied to content that already lives in ${d}. draftgate holds no ${d} credentials and ` +
      `never calls ${d}, so it cannot read that content -- there is no draft to show a ` +
      `reviewer. Present keys: ${keys}.`,
  },
  nested: {
    code: 'body/nested-prose',
    // The text is one leaf of a structure; a default route's `*` disclosure already puts the whole
    // structure in the row's `context`.
    logs: 'nothing',
    // Like `preformatted` and `delta`: the message is real and has no editable place, so the
    // instruction is about the permission prompt, not the tool map.
    guidance:
      'Do not rewrite the message. draftgate reviews a body and title fields, and this call ' +
      'carries text nested inside a structured field, which it cannot show as a draft. The user ' +
      'decides at the permission prompt. If the text sits in an OBJECT (not an array) and is the ' +
      'whole message, a route bodyField naming its path would let draftgate review it.',
    describe: (d: string, f: string, keys: string, named?: string) =>
      `Payload for "${d}" has no "${f}" field, and "${named}" holds text nested inside a ` +
      'structured field -- a message with no draft draftgate can show a reviewer. ' +
      `Present keys: ${keys}.`,
  },
} as const satisfies Record<
  BodyFailure,
  { code: string; logs: 'named' | 'body' | 'nothing'; guidance: string; describe: unknown }
>;

export class MissingBodyFieldError extends Error {
  constructor(
    readonly destination: string,
    readonly bodyField: string,
    readonly presentKeys: string[],
    /** Which of the shapes this is, and the field it can name. Only `drift` may fail open. */
    readonly detail: BodyFailureDetail
  ) {
    const spec = BODY_FAILURES[detail.failure];
    super(
      spec.describe(
        destination,
        bodyField,
        presentKeys.join(', ') || '(none)',
        'field' in detail ? detail.field : undefined
      )
    );
    this.name = 'MissingBodyFieldError';
  }

  get failure(): BodyFailure {
    return this.detail.failure;
  }

  /** The denial code the CLI reports and the hook adapter keys its policy on. */
  get code(): string {
    return BODY_FAILURES[this.detail.failure].code;
  }

  /** The field this failure's message names, for the shapes that name one. */
  get namedField(): string | undefined {
    return 'field' in this.detail ? this.detail.field : undefined;
  }

  /**
   * The payload field holding the text the audit log quotes, when there is one. Not `namedField`:
   * a `preformatted` message names `contentFormat` and its row quotes `commentBody`.
   */
  get loggedField(): string | undefined {
    const { logs } = BODY_FAILURES[this.detail.failure];
    if (logs === 'body') return this.bodyField;
    if (logs === 'named') return this.namedField;
    return undefined;
  }
}

/**
 * Which field the message is in: the route's `bodyField` when given, else the profile's default.
 * `extractBody` reads it and `buildUpdatedInput` writes it back; two spellings could read
 * `description` and write `body`, sending the agent's original text with the edit in a field the
 * tool ignores.
 */
export function bodyFieldFor(destination: DestinationName, override?: string): string {
  return override ?? profiles[destination].bodyField;
}

/**
 * Segments a body path may never name. `writeBodyPath` assigns into fresh objects, so a path ending
 * in `__proto__` would set a prototype, not a field, and hand the tool a payload with no body and an
 * altered object graph. `constructor` and `prototype` go with it; no connector uses any of the three.
 */
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export class BodyPathError extends Error {}

/**
 * Split a body field into the segments that address it, and refuse the ones that cannot mean a
 * field. A dot always separates segments: `editJiraIssue`'s live schema has no `description`
 * parameter, and the prose sits at `fields.description`. There is no escape, so a field name
 * containing a dot is not addressable; no connector here has one.
 *
 * `parseRoute` calls it at config time and the payload functions at review time (which covers
 * `--body-field`), so there is one validator for the grammar.
 */
export function parseBodyPath(field: string): string[] {
  const segments = field.split('.');
  // A `*` means something only as the leaf (`expandContextFields`). Anywhere else it would be a
  // literal key `*`, `valueAtPath` would find nothing, and the strip would hide what the operator
  // asked to disclose.
  if (segments.slice(0, -1).includes('*')) {
    throw new BodyPathError(
      `"${field}" uses "*" before the end. A wildcard names every key of ONE container, so it can ` +
        'only be the last segment.'
    );
  }
  if (segments.some((s) => s === '')) {
    throw new BodyPathError(
      `"${field}" is not a field name: a dot separates segments, so an empty one cannot address ` +
        'anything.'
    );
  }
  const unsafe = segments.find((s) => UNSAFE_PATH_SEGMENTS.has(s));
  if (unsafe !== undefined) {
    throw new BodyPathError(
      `"${field}" names "${unsafe}", which addresses an object's machinery rather than a field. ` +
        'Writing a body there would alter the payload rather than fill it in.'
    );
  }
  return segments;
}

/**
 * The object a path's last segment lives in, or `undefined` when the route to it does not exist.
 * The container, so a caller can tell present-and-wrong-typed (which must not fail open) from absent.
 */
function bodyParent(
  toolInput: Record<string, unknown>,
  segments: string[]
): Record<string, unknown> | undefined {
  return containerAt(toolInput, segments.slice(0, -1));
}

/**
 * The object a path names, or `undefined` when the route to it does not exist. `bodyParent` wants the
 * container a leaf lives in, `plausibleProseField` a container named outright.
 */
function containerAt(
  toolInput: Record<string, unknown>,
  segments: readonly string[]
): Record<string, unknown> | undefined {
  let node: Record<string, unknown> = toolInput;
  for (const segment of segments) {
    const next = Object.hasOwn(node, segment) ? node[segment] : undefined;
    // A non-object on the way down makes the field absent, not wrong-typed: `fields: "oops"` has no
    // `description` to be the wrong type.
    if (!isPlainObject(next)) return undefined;
    node = next;
  }
  return node;
}

/**
 * The value at a (possibly dotted) field path, or `undefined` when nothing is there. One walk, so a
 * dotted field means the same everywhere; a literal-key lookup would log `before: ''` for a nested
 * `preformatted` body.
 */
export function valueAtPath(toolInput: Record<string, unknown>, field: string): unknown {
  return readPath(toolInput, field).value;
}

/**
 * A field's state, read once. `present` is separate from `value` because present-but-not-a-string
 * must not fail open and absent may.
 */
function readPath(
  toolInput: Record<string, unknown>,
  field: string
): { present: boolean; value: unknown } {
  const segments = parseBodyPath(field);
  const leaf = segments[segments.length - 1]!;
  const parent = bodyParent(toolInput, segments);
  // `Object.hasOwn`, not a bare index: `toString` and friends read as values otherwise.
  return parent !== undefined && Object.hasOwn(parent, leaf)
    ? { present: true, value: parent[leaf] }
    : { present: false, value: undefined };
}

/**
 * The payload with `body` written at `segments`, rebuilt rather than mutated. Every level on the way
 * down is copied, so the body's siblings (`summary`, `labels`, a transition) survive; `updatedInput`
 * replaces tool input wholesale (wire.md). An absent container is created rather than crashing the
 * approve path.
 */
function writeBodyPath(
  toolInput: Record<string, unknown>,
  segments: string[],
  body: unknown
): Record<string, unknown> {
  const [head, ...rest] = segments as [string, ...string[]];
  if (rest.length === 0) return { ...toolInput, [head]: body };
  const child = Object.hasOwn(toolInput, head) ? toolInput[head] : undefined;
  return { ...toolInput, [head]: writeBodyPath(isPlainObject(child) ? child : {}, rest, body) };
}

/**
 * Pull the canonical markdown out of a tool payload, or answer that there is none.
 *
 * `undefined` is a review, not a failure: the body is absent, nothing unaccounted-for looks like
 * prose, and the route's `lineFields` carry something (a title-only `issue_write`, a
 * `create_pull_request` with no description). Throwing `body/missing-field` there would take the
 * drift fail-open with the title unread. Every other absence throws; empty `lineFields` makes every
 * absence a failure.
 */
export function extractBody(
  destination: DestinationName,
  toolInput: Record<string, unknown>,
  bodyField?: string,
  /** The route's declared line fields, by path. */
  lineFields: readonly string[] = [],
  /**
   * The route's context fields, as `extractContext` takes them. Their named entries, with the
   * profile's, are accounted for: a `labels` shown as routing is not unaccounted-for prose.
   */
  contextFields?: readonly string[]
): string | undefined {
  const field = bodyFieldFor(destination, bodyField);

  /*
   * First, before the body is looked for. Linear's schema says `patch` stands "in place of the full
   * content/description field" but does not make the two exclusive, and which wins when both are
   * sent is not probed; reviewing the `description` could show a body the send does not apply. So a
   * payload carrying both asks. It also outranks `wrong-type` and `unrecognised`, which are guesses
   * where this is stated.
   */
  const deltaField = deltaBy(destination, toolInput);
  if (deltaField !== undefined) {
    throw new MissingBodyFieldError(destination, field, Object.keys(toolInput), {
      failure: 'delta',
      field: deltaField,
    });
  }

  const { present, value } = readPath(toolInput, field);
  if (typeof value === 'string') {
    // An already-converted body read as markdown shows the reviewer raw JSON, and approving it wraps
    // that JSON as a text node in a new ADF document: visible garbage, sent. Refused rather than
    // round-tripped through two lossy passes, neither probed on arbitrary ADF; the adapter asks, and
    // approving there sends the agent's document untouched.
    const formatField = preformattedBy(destination, toolInput);
    if (formatField !== undefined) {
      throw new MissingBodyFieldError(destination, field, Object.keys(toolInput), {
        failure: 'preformatted',
        field: formatField,
      });
    }
    return value;
  }

  // Present but not a string (`commentBody: 123`, `{...}`, `null`, `["x"]`, `true`) is not drift and
  // must not reach the fail-open. What the destination does with such a value is not probed.
  if (present) {
    throw new MissingBodyFieldError(destination, field, Object.keys(toolInput), {
      failure: 'wrong-type',
    });
  }

  /*
   * Absent. Unaccounted-for prose first: drift outranks a reviewable title, since approving the title
   * while a renamed body goes out unseen is worse than not gating (`WireRequest.fields`). Then the
   * route's own prose: a review with no draft. Then nested prose, else `body/unrecognised`.
   */
  const declared = declaredPaths(field, lineFields, contextFieldsFor(destination, contextFields));
  const prose = plausibleProseField(toolInput, field, declared);
  // `extractProse` decides which declared fields the window draws a box for, so a review here always
  // has one.
  if (prose === undefined && extractProse(toolInput, lineFields).length > 0) return undefined;
  // Last, so it only replaces `unrecognised` (and its `bodyOptional` allow); beside a declared title
  // the nested value is disclosed read-only in the context strip.
  const nested = prose === undefined ? nestedProseField(toolInput, declared) : undefined;
  throw new MissingBodyFieldError(
    destination,
    field,
    Object.keys(toolInput),
    prose !== undefined
      ? { failure: 'drift', field: prose }
      : nested !== undefined
        ? { failure: 'nested', field: nested }
        : { failure: 'unrecognised' }
  );
}

/**
 * Which routing fields a review shows: the profile's list, plus the route's additions, deduped, in
 * that order.
 *
 * A union, never a replace: `extractContext`'s output is the sole input to `audienceFor` and
 * `destinationLabel` (Jira reads `cloudId` and `issueIdOrKey` from it) and what `rememberJiraProject`
 * keys on. MEASURED on a real `addCommentToJiraIssue` payload: the profile's list records `audience:
 * public`, a replacing `contextFields: ["issueIdOrKey"]` records `audience: unknown`, losing the JSM
 * banner. The cost is that a route cannot hide a profile key the payload carries.
 */
export function contextFieldsFor(
  destination: DestinationName,
  override?: readonly string[]
): readonly string[] {
  const base = profiles[destination].contextFields;
  if (override === undefined) return base;
  return [...new Set([...base, ...override])];
}

/**
 * The routing fields worth showing a human, read-only. Keys the list does not name are dropped
 * silently, which is why a route can add to it (`RouteFacts.contextFields`). Not only display: see
 * `contextFieldsFor`.
 */
export function extractContext(
  destination: DestinationName,
  toolInput: Record<string, unknown>,
  fields: { contextFields?: readonly string[]; editable?: readonly string[] } = {}
): Record<string, unknown> {
  return readContext(destination, toolInput, fields).context;
}

/**
 * `extractContext`, plus the keys the wildcard found and could not disclose (see
 * `isAddressableKey`). `review.ts` reads both and refuses a review with any; every other caller
 * wants the record alone.
 */
export function readContext(
  destination: DestinationName,
  toolInput: Record<string, unknown>,
  /**
   * An object, because two adjacent `readonly string[]` positionals transpose silently. `editable` is
   * the body plus any `proseFields`, which a wildcard must not draw a second time as a read-only copy.
   */
  fields: { contextFields?: readonly string[]; editable?: readonly string[] } = {}
): { context: Record<string, unknown>; unaddressable: string[] } {
  const { contextFields, editable } = fields;
  const out: Record<string, unknown> = {};
  const { paths, unaddressable } = expandContextFields(
    contextFieldsFor(destination, contextFields),
    toolInput,
    editable
  );
  for (const key of paths) {
    // A path, by the `bodyField` grammar: `editJiraIssue`'s title is `fields.summary`, which a
    // description review can show read-only.
    const value = valueAtPath(toolInput, key);
    if (value !== undefined) out[key] = value;
  }
  return { context: out, unaddressable };
}

/** The wildcard leaf: every own key of a container, minus whatever is editable. */
export const ALL = '*';

/** Whether a context entry is a wildcard (`*`, `fields.*`) rather than a field it names. */
export function isWildcardField(field: string): boolean {
  return parseBodyPath(field).at(-1) === ALL;
}

/**
 * Whether the wildcard can disclose a key it found, by `parseBodyPath`'s rules for one segment. A key
 * holding a dot (`{"fields": {"labels.extra": 1}}`) reads back as `fields -> labels -> extra` and
 * would be silently omitted; an empty key or `__proto__` would throw out of `extractContext`.
 * `readContext` reports such keys and `review.ts` refuses the review (`context/unaddressable`). Not
 * shown under an escaped name: the row label is the path's leaf (`contextLabels`), so it would read
 * `extra`. No connector here has such a key.
 */
function isAddressableKey(key: string): boolean {
  return key !== '' && key !== ALL && !key.includes('.') && !UNSAFE_PATH_SEGMENTS.has(key);
}

/**
 * Expand any `*` entry into the keys the payload has there: `"fields.*"` is every key of `fields`, a
 * bare `"*"` every top-level key, minus the editable set (body and `proseFields`). The operator opts
 * in per route, and values print verbatim.
 *
 * `editJiraIssue.fields` is free-form. MEASURED on a real payload: a route naming `fields.summary`,
 * `fields.status` and `fields.labels` silently hides the `fields.assignee` and `fields.priority` the
 * agent also set.
 */
function expandContextFields(
  fields: readonly string[],
  toolInput: Record<string, unknown>,
  editable: readonly string[] = []
): { paths: string[]; unaddressable: string[] } {
  const hidden = new Set(editable);
  const out: string[] = [];
  const unaddressable: string[] = [];
  for (const field of fields) {
    const segments = parseBodyPath(field);
    if (segments[segments.length - 1] !== ALL) {
      out.push(field);
      continue;
    }
    const container = bodyParent(toolInput, segments);
    if (container === undefined) continue;
    const prefix = segments.slice(0, -1);
    for (const key of Object.keys(container)) {
      if (!isAddressableKey(key)) {
        unaddressable.push(key);
        continue;
      }
      const path = [...prefix, key].join('.');
      // Skipped rather than renamed: an editable field is already on screen as an input.
      if (!hidden.has(path)) out.push(path);
    }
  }
  // A route may name a field and wildcard its container. First occurrence wins, so an explicit name
  // keeps its position.
  return { paths: [...new Set(out)], unaddressable };
}

/**
 * The two rules relating a body field to the prose fields beside it, for `parseRoute` (`tools.json`)
 * and `main.ts` (the CLI flags) alike. Returns the complaint rather than throwing: one caller raises
 * a `ToolMapError` naming the file, the other writes to stderr and exits.
 */
export function proseFieldsComplaint(
  bodyField: string,
  proseFields: readonly string[]
): string | null {
  if (proseFields.includes(bodyField)) {
    return (
      `"${bodyField}" is both the body field and a prose field. The body is already editable as ` +
      'the draft; listing it again would draw it twice and discard one of the two edits.'
    );
  }
  // A wildcard names a set; these address one field each.
  for (const field of [bodyField, ...proseFields]) {
    if (field.includes('*')) {
      return `"${field}" uses "*", which names a SET of fields. Only contextFields may use one.`;
    }
  }
  return null;
}

/**
 * The other prose in a payload: the fields the agent wrote that are not the body, as plain lines
 * (`RouteFacts.proseFields`). A list, because order is what the reviewer reads.
 *
 * A field the payload does not carry is omitted, not drawn empty: `save_issue` with an `id` may
 * leave `title` unset to mean "leave it alone", and an empty box would invite the reviewer to blank
 * it. A non-string is skipped: what a destination does with one is not probed.
 */
export function extractProse(
  toolInput: Record<string, unknown>,
  proseFields: readonly string[] | undefined
): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  for (const field of proseFields ?? []) {
    const value = valueAtPath(toolInput, field);
    if (typeof value === 'string') out.push({ field, value });
  }
  return out;
}

/**
 * Build the complete tool input to send (`updatedInput` replaces tool input wholesale, wire.md): the
 * original payload with the edited prose, the body and the render's `extraToolInput` written over
 * it. For Jira that sets `contentFormat: "adf"`, without which Jira renders the ADF JSON as literal
 * text.
 */
export function buildUpdatedInput(
  /**
   * The render that produced this body, not the destination: `renderPlain` returns `{}`, and read off
   * the profile a `--body-format plain` Jira review would send `contentFormat: "adf"` beside plain
   * text.
   */
  render: Pick<RenderResult, 'destination' | 'extraToolInput'>,
  toolInput: Record<string, unknown>,
  /**
   * The body to write, or `undefined` when this review had none (`review.ts` holds that first-hand).
   * `undefined` writes neither the body field nor `extraToolInput`: creating the omitted field with
   * `""` is `prose/empty`'s probed 400 one field over, and `contentFormat: "adf"` would announce a
   * document that does not exist.
   */
  body: unknown,
  bodyField?: string,
  /** The prose fields the reviewer edited, by path. Untouched ones are already in `toolInput`. */
  prose?: Readonly<Record<string, string>>
): Record<string, unknown> {
  const { destination } = render;
  // The edited prose first: it can share a container with the body (`fields.summary` and
  // `fields.description`), and each write rebuilds that container from what it is handed.
  let withProse = toolInput;
  for (const [field, value] of Object.entries(prose ?? {})) {
    withProse = writeBodyPath(withProse, parseBodyPath(field), value);
  }
  // No body: the prose edits over the complete original.
  if (body === undefined) return withProse;
  return {
    // The field `extractBody` read (`bodyFieldFor`), not `profile.bodyField`.
    ...writeBodyPath(withProse, parseBodyPath(bodyFieldFor(destination, bodyField)), body),
    ...render.extraToolInput,
  };
}

/**
 * Serialise an approved body into the shape the destination's tool accepts. PROBED against a real
 * Jira site: `addCommentToJiraIssue.commentBody` is typed `string`, and the ADF document as a JSON
 * string with `contentFormat: "adf"` returns 201 and stores the document correctly. So
 * convert-and-replace stringifies; preview-only sends the markdown untouched.
 */
export function wireBody(
  /**
   * The render that produced `converted`, not the destination: `renderPlain` returns `preview-only`
   * everywhere, and read off the profile a plain Jira body would be sent JSON-stringified.
   */
  render: Pick<RenderResult, 'mode'>,
  converted: unknown
): unknown {
  if (render.mode === 'convert-and-replace') return JSON.stringify(converted);
  return converted;
}
