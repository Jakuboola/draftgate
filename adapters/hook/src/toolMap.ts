/**
 * Which tool calls are outbound prose, and where they are going.
 *
 * Exact tool names, never a hand-written regex. The filter is "does this carry agent-authored prose
 * a human would want to read first", not "is it outbound" (`slack_add_reaction` is outbound and
 * irrelevant). This table is the source of truth and `matcherFor` generates the registration's
 * `matcher` from it: a tool a hand-written matcher missed would never be reviewed, silently.
 *
 * How the runtime applies the matcher string is not established from the binary
 * (`makeRegexMatcher` in 2.1.261 is `fs.watch`'s ignore matcher, guarded by `instanceof RegExp`).
 * What is established is that the anchored pattern works against a real `claude -p` session.
 *
 * The anchors matter: `mcp__claude_ai_Slack__slack_send_message` is a prefix of
 * `..._slack_send_message_draft`, which writes to "Drafts & Sent" and is not a send. `^(?:...)$`
 * keeps it out whether the runtime uses `.test()` or a whole-string match.
 *
 * The table is overridable (`tools.json`) because the server half of `mcp__<server>__<tool>` is one
 * installation's name for a connector (`mcp__atlassian__addCommentToJiraIssue`); the tool half is
 * stable.
 */

import { isKnownDestination, profiles, type DestinationName } from '../../../core/src/index';

// The destination list for messages, derived from the profiles so a new one is never refused.
const KNOWN_DESTINATION_NAMES = Object.keys(profiles).join(', ');
const KNOWN_DESTINATIONS = Object.keys(profiles)
  .map((d) => `"${d}"`)
  .join(', ');
// The body-path grammar, from the module that reads it, so a route accepted here is one
// `extractBody` can address.
import {
  ALL, parseBodyPath, BodyPathError, isWildcardField, proseFieldsComplaint,
} from '../../../cli/src/payload';
// The facts a route carries about a payload, and their wire encoding (`routeFacts.ts`).
import { ROUTE_FLAGS, claimedRouteFacts, type RouteFacts } from '../../../cli/src/routeFacts';

/**
 * Where one tool's prose goes, and what draftgate may assume about its body field.
 *
 * The four `RouteFacts` fields are facts about the tool's payload and travel into the review
 * (`routeFacts.ts`). `bodyOptional` and `schemaOwner` are policy the adapter applies before a
 * review; the CLI is never told them, so `ROUTE_FLAGS` gives them no wire encoding.
 */
export interface ToolRoute extends RouteFacts {
  destination: DestinationName;
  /**
   * The body field is optional in this tool's schema, so a call that omits it carries no prose.
   *
   * `addWorklogToJiraIssue` is the case: `commentBody` is optional and `timeSpent` required, and a
   * comment-less worklog is common. Without the flag each one would reach the permission prompt.
   * It changes only what happens on `body/unrecognised` (no body field and nothing else that looks
   * like a message); a worklog with a comment is reviewed like any Jira comment. Policy and bounds:
   * `decide.ts`.
   */
  bodyOptional?: boolean;
  /**
   * Who authored the input schema this route's body-field claim rests on.
   *
   *  - `connector`  a vendor's MCP server draftgate does not control. `body/missing-field` here is
   *                 the schema-drift fail-open: allowed through, loudly.
   *  - `operator`   typed into `~/.draftgate/tools.json`. Nobody probed the schema, so a missing
   *                 field asks. That includes a local server's `jira_add_internal_note`: no body
   *                 there is the implementer breaking their own contract, not drift.
   *
   * Stamped by `mergeToolMap` at merge time, never read from `tools.json`, so an operator cannot
   * claim `connector` (`hook.test.ts`, "an operator cannot claim..."), and an entry that only
   * restates a default keeps the default's owner.
   */
  schemaOwner: SchemaOwner;
}

/**
 *  - `connector-open`  a connector whose body lives inside an open object: Jira `editJiraIssue`'s
 *                 `fields`, keyed by any field name (`environment`, custom text fields). The drift
 *                 scan reads that container (`scannedContainers` in `cli/src/payload.ts`), where a
 *                 spaced value is ordinary data as often as a renamed body, so the schema-drift
 *                 hatch would send `fields.environment` and the `fields.summary` beside it
 *                 unreviewed. This asks instead; `bodyOptional` is unaffected.
 *  - `inferred`   nobody configured this tool: its name matched a routed tool half under a server
 *                 nobody named (`resolveRoute`). Takes neither fail-open.
 */
export type SchemaOwner = 'connector' | 'connector-open' | 'operator' | 'inferred';

/**
 * Which of a route's own facts travel, and where. `resolveRoute` and `proposedToolsJson` read this
 * table, so a new `ToolRoute` field is a compile error until both answers are given. Enumerated at
 * each site, a field missed in one would make `--propose-tools` emit `{destination}` alone: an
 * operator route with no body field, which shows the reviewer nothing.
 *
 *  - `inferred`  travels onto a route nobody configured, whose name shares a tool half.
 *  - `proposed`  written into a `tools.json` proposal for an alias of a mapped tool.
 *
 * Whether a fact reaches a review is settled by its type (`RouteFacts`), so there is no column for
 * it. `bodyOptional` is `false` twice: it is a fail-open, and draftgate neither infers one for an
 * unconfigured server nor writes one on an operator's behalf.
 */
export const ROUTE_FACTS: Record<
  Exclude<keyof ToolRoute, 'destination' | 'schemaOwner'>,
  { inferred: boolean; proposed: boolean }
> = {
  bodyOptional: { inferred: false, proposed: false },
  bodyField: { inferred: true, proposed: true },
  contextFields: { inferred: true, proposed: true },
  proseFields: { inferred: true, proposed: true },
  bodyFormat: { inferred: true, proposed: true },
};

/** A route's facts, filtered by `ROUTE_FACTS`. `destination` always travels; it IS the route. */
export function routeFactsFor(
  route: ToolRoute,
  which: 'inferred' | 'proposed'
): Partial<ToolRoute> {
  const out: Record<string, unknown> = {};
  for (const [field, travels] of Object.entries(ROUTE_FACTS)) {
    const value = route[field as keyof ToolRoute];
    if (travels[which] && value !== undefined) out[field] = value;
  }
  return out as Partial<ToolRoute>;
}

/**
 * Which fail-open each kind of route may take. One table, so a new `SchemaOwner` is a type error
 * here until both answers are given (asked inline at each hatch, it could be closed out of one and
 * not the other).
 *
 *  - `schemaDrift`  the body field is missing and the payload has prose elsewhere, so a connector
 *                   probably renamed a field. Only a connector draftgate has probed earns this.
 *  - `bodyOptional` the schema says the body is optional and this call omitted it. Open to operator
 *                   routes too (a renamed connector is why `tools.json` exists), never to an
 *                   inferred one.
 */
export const FAIL_OPEN: Record<SchemaOwner, { schemaDrift: boolean; bodyOptional: boolean }> = {
  connector: { schemaDrift: true, bodyOptional: true },
  'connector-open': { schemaDrift: false, bodyOptional: true },
  operator: { schemaDrift: false, bodyOptional: true },
  inferred: { schemaDrift: false, bodyOptional: false },
};

export type ToolMap = Record<string, ToolRoute>;

/**
 * Every default route ends its `contextFields` with `*`, appended here once.
 *
 * The shown half of a review has to be complete: a curated list hides `issue_write`'s
 * `issue_fields`, `assignees` and `milestone`, `slack_send_message`'s `reply_broadcast` (a reply
 * that also posts to the channel would review as a quiet thread reply), and any key the agent adds
 * beyond the schema. The wildcard is opt-in so an operator route states its own intent.
 *
 * The named entries stay, first: they fix the order the strip reads in, and a named field is
 * accounted for by the prose scans (`extractBody`), so `labels: ["good first issue"]` is not prose.
 * An inferred route copies the list (`routeFactsFor`); an operator list is unioned with the
 * default's (`mergeToolConfig`).
 */
function disclosingEverything(map: ToolMap): ToolMap {
  const out: ToolMap = {};
  for (const [tool, route] of Object.entries(map)) {
    out[tool] = { ...route, contextFields: [...(route.contextFields ?? []), ALL] };
  }
  return out;
}

/**
 * The outbound tools, read off the live connector list. Short on purpose: a broad filter blocks
 * reads (Jira and Confluence expose a dozen comment-shaped tools that only fetch).
 *
 * In: one conversational-prose tool per destination plus any exact sibling (same body field, same
 * audience). `slack_schedule_message` is one: live schema `{channel_id, message, post_at}`, and once
 * scheduled it "cannot be edited via API". Plus each destination's tools that create or edit an
 * issue (see the entries below); `bodyField` takes a dotted path, and `contentFormat: "adf"` reaches
 * a nested field (probed). Both Jira issue tools' audience is probed (`WRITES_REQUEST_FIELDS` in
 * `core/src/profiles/jira.ts`).
 *
 * Out, and so not gated:
 *  - `slack_send_message_draft`: writes to "Drafts & Sent", not a send.
 *  - the four Confluence tools (`createConfluenceFooterComment`, `createConfluenceInlineComment`,
 *    `createConfluencePage`, `updateConfluencePage`): Confluence is out of scope.
 *  - `slack_create_canvas` / `slack_update_canvas`: the body is "Canvas-flavored Markdown", which
 *    the tool description says "is different from Slack message formatting"; the slack profile
 *    would preview it against the message renderer (`p-header_block`).
 *  - a tool on a local server, such as `jira_add_internal_note`: its server key is whatever one
 *    `.mcp.json` calls it, and `core/src/profiles/jira.ts` trusts the tool name of a configured
 *    route, so a default entry would give a stranger's tool an "internal" banner. The operator
 *    declares it in `tools.json`.
 *
 * An agent that picks an ungated tool avoids the gate.
 */
export const DEFAULT_TOOL_MAP: ToolMap = disclosingEverything({
  mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue: {
    destination: 'jira', schemaOwner: 'connector',
  },
  mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue: {
    destination: 'jira',
    bodyOptional: true,
    // NAMED, not only wildcarded, because a named field is ACCOUNTED FOR and neither prose scan
    // reads it (`extractBody`). All three hold spaces in ordinary calls and none is a message:
    //  - `timeSpent`: Jira's multi-unit durations, `2h 30m` and `1d 4h`. Read as a renamed body,
    //    they would take the schema-drift hatch with "NOT REVIEWED, the schema has probably
    //    changed" on this route and ASK on an operator alias carrying `bodyOptional`. The
    //    schema's examples are single-unit; whether Rovo accepts the multi-unit form is not probed.
    //    The cost of exempting by NAME: prose an agent writes INTO `timeSpent` now reads as no
    //    message and is allowed like any comment-less worklog. That is not ordinary output, and
    //    what Jira does with a non-duration `timeSpent` is not probed.
    //  - `started`: an ISO date-time in the schema, but `2026-03-09 09:00` is how people write one.
    //  - `visibility`: a group or role name (`Service Desk Team`), nested, so unnamed it would be
    //    `body/nested-prose` and reach the permission prompt.
    // Aliases inherit the list by tool half (`mergeToolConfig`), and an inferred route copies it --
    // but neither gets `bodyOptional` unless the operator wrote it, so a comment-less worklog on
    // those still ASKS, `2h` or `2h 30m` alike. That is the flag's bound, not this list's.
    contextFields: ['timeSpent', 'started', 'visibility'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Slack__slack_send_message: {
    destination: 'slack', schemaOwner: 'connector',
  },
  mcp__claude_ai_Slack__slack_schedule_message: {
    destination: 'slack', schemaOwner: 'connector',
  },
  mcp__claude_ai_Linear__save_comment: {
    destination: 'linear', schemaOwner: 'connector',
  },

  /*
   * GitHub's seven write tools, read off the live `Github_MCP` schemas. Every one spells the body
   * `body`. `issue_number` and `pullNumber` are in the profile's default list, so each route adds
   * only what is particular to it.
   *
   * Five are `bodyOptional`, each for a real call with no prose:
   *   - `add_issue_comment` and `add_reply_to_pull_request_comment` take a `reaction`; body is
   *     "required unless reaction is provided".
   *   - `issue_write` can close an issue or set labels with no body.
   *   - `create_pull_request` and `update_pull_request` can carry a title and no description, and
   *     `update_pull_request` can change only `state` or `base`.
   *   - `pull_request_review_write`'s `resolve_thread`, `unresolve_thread` and `delete_pending`
   *     carry only a `threadId`.
   * `add_comment_to_pending_review` has no flag: its schema makes `body` required.
   *
   * A title with no body is reviewed, not allowed: `plausibleProseField` excludes the route's own
   * `proseFields`, so the review runs with the title and no draft. Without that exclusion the title
   * would read as a renamed body (`body/missing-field`) and the schema-drift hatch would send it
   * unreviewed. Prose in a field nobody declared still takes the hatch.
   */
  mcp__claude_ai_Github_MCP__add_issue_comment: {
    destination: 'github',
    bodyOptional: true,
    // `comment_id` makes a reaction one to a comment rather than the issue; `reaction` is what is
    // sent when there is no body.
    contextFields: ['comment_id', 'reaction'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Github_MCP__issue_write: {
    destination: 'github',
    bodyOptional: true,
    // `title` is prose the reviewer may edit; `prose/empty` blocks blanking it.
    proseFields: ['title'],
    // `method` separates a create from an edit to somebody's issue; `state` and `state_reason`
    // close it. The rest are named for order. `issue_fields` is not named: that would make its
    // nested text accounted for, and a call carrying only that text would take `bodyOptional`'s
    // allow. `*` shows it read-only (its values sit in an array the path grammar cannot address).
    contextFields: [
      'method', 'state', 'state_reason', 'labels', 'assignees', 'milestone', 'type',
      'parent_issue_number', 'duplicate_of',
    ],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Github_MCP__create_pull_request: {
    destination: 'github',
    bodyOptional: true,
    proseFields: ['title'],
    // `head` -> `base` is what the PR proposes; `draft` decides whether opening it requests review;
    // `reviewers` are notified.
    contextFields: ['head', 'base', 'draft', 'reviewers'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Github_MCP__update_pull_request: {
    destination: 'github',
    bodyOptional: true,
    proseFields: ['title'],
    contextFields: ['state', 'base', 'draft', 'reviewers'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Github_MCP__add_comment_to_pending_review: {
    destination: 'github',
    // No `bodyOptional`: `body` is required. `path`, `line` and `side` are the diff line the comment
    // lands on; against the wrong hunk it is a different message.
    contextFields: ['path', 'line', 'side', 'startLine', 'startSide', 'subjectType'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Github_MCP__add_reply_to_pull_request_comment: {
    destination: 'github',
    bodyOptional: true,
    contextFields: ['commentId', 'reaction'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Github_MCP__pull_request_review_write: {
    destination: 'github',
    bodyOptional: true,
    /*
     * `event` is an action (`APPROVE`, `REQUEST_CHANGES` or `COMMENT`), shown read-only so the
     * reviewer reads the verdict they attach their name to. `method`: `create` without an `event`
     * leaves a pending review only the author sees; `submit_pending` publishes one.
     *
     * Known gap, kept by the operator's decision: `{method: "submit_pending", event: "APPROVE"}`
     * with no body is allowed unreviewed (`bodyOptional`). Removing the flag would send
     * `resolve_thread`, `unresolve_thread` and `delete_pending` to the permission prompt, and the
     * flag cannot depend on a field value without a new route fact.
     */
    contextFields: ['method', 'event', 'commitID', 'threadId'],
    schemaOwner: 'connector',
  },

  /*
   * The issue tools, read off the live Rovo and Linear schemas.
   *
   * Every routing key is named, because the drift scan's only test is a space (`looksLikeProse`):
   * on a `connector` route a spaced string in an undeclared field is schema drift, an allow that
   * outranks a reviewable title, and a wildcard declares nothing (`declaredPaths`). Unnamed,
   * `issueTypeName: "Service Request"` on a create with no description, or `state: "In Progress"`
   * beside a new Linear title, would send the title unreviewed. Both schemas are closed
   * (`additionalProperties: false`), so only a key the connector adds later trips the scan.
   *
   * Jira's `additional_fields` is not named, for `issue_fields`' reason above; a create always
   * carries `summary`, so it is always reviewed, with `*` showing that object beside it.
   *
   * `bodyOptional` where a call can carry no prose: an edit setting only labels, an assignee or a
   * state, a status update changing only its health, a customer need changing only its priority. A
   * create always has a title, and a diff comment's `body` is required (`minLength: 1`).
   */
  mcp__claude_ai_Atlassian_Rovo__createJiraIssue: {
    destination: 'jira',
    bodyField: 'description',
    proseFields: ['summary'],
    // `projectKey` and `cloudId` come from the profile. `transition` applies a workflow step as the
    // issue is created.
    contextFields: ['issueTypeName', 'parent', 'assignee_account_id', 'transition'],
    schemaOwner: 'connector',
  },
  /*
   * `connector-open` (see `SchemaOwner`). The named `fields.` keys are the common routing ones, in
   * strip order, and accounted for so a label or component edit with a space in it takes
   * `bodyOptional` rather than the permission prompt. `fields.*` shows the rest.
   */
  mcp__claude_ai_Atlassian_Rovo__editJiraIssue: {
    destination: 'jira',
    bodyOptional: true,
    bodyField: 'fields.description',
    proseFields: ['fields.summary'],
    contextFields: [
      'fields.issuetype', 'fields.priority', 'fields.assignee', 'fields.labels', 'fields.components',
      'fields.fixVersions', 'fields.duedate', 'fields.parent', 'fields.resolution', 'fields.*',
    ],
    schemaOwner: 'connector-open',
  },
  /*
   * `id` separates an edit from a create, as `method` does for `issue_write`. `patch` is not here:
   * the Linear profile's `deltaFields` reads it, before any of this, as the edits under review.
   */
  mcp__claude_ai_Linear__save_issue: {
    destination: 'linear',
    bodyOptional: true,
    bodyField: 'description',
    proseFields: ['title'],
    contextFields: [
      'id', 'team', 'state', 'assignee', 'delegate', 'project', 'priority', 'estimate', 'cycle',
      'milestone', 'parentId', 'labels', 'addLabels', 'removeLabels', 'dueDate', 'duplicateOf',
      'template', 'links', 'blocks', 'blockedBy', 'relatedTo', 'removeBlocks', 'removeBlockedBy',
      'removeRelatedTo', 'addReleases', 'removeReleases', 'setReleases', 'slaBreachesAt', 'slaType',
    ],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Linear__save_status_update: {
    destination: 'linear',
    bodyOptional: true,
    // `health` is the update's verdict (`onTrack` / `atRisk` / `offTrack`), read before the body.
    contextFields: ['type', 'project', 'initiative', 'health', 'id', 'isDiffHidden'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Linear__save_diff_comment: {
    destination: 'linear',
    // `anchor` and `anchorContent` are the line the comment lands on (`anchorContent` is source
    // text, spaces and all). `draft: true` saves privately rather than posting.
    contextFields: ['urlOrId', 'parentId', 'commentId', 'draftId', 'draft', 'anchor', 'anchorContent'],
    schemaOwner: 'connector',
  },
  mcp__claude_ai_Linear__save_customer_need: {
    destination: 'linear',
    bodyOptional: true,
    contextFields: ['customer', 'issue', 'project', 'source', 'priority', 'id'],
    schemaOwner: 'connector',
  },
});

/** Config file consulted for overrides, if it exists. */
export const CONFIG_BASENAME = 'tools.json';

export class ToolMapError extends Error {}

/**
 * Merge an override object into a base map, so adding one renamed connector does not mean
 * restating the rest.
 *
 * `null` removes an entry, not the name's gating: a remaining entry sharing its tool half still
 * routes it, as `inferred` (pinned in `reconcile.test.ts`). The registered matcher also keeps firing
 * for it and an unmapped tool is denied, so a removal needs `/draftgate:setup` again. A default half
 * stops being gated only when it is declined.
 */
export function mergeToolMap(base: ToolMap, override: unknown, source: string): ToolMap {
  return mergeToolConfig(base, override, source).map;
}

/**
 * The key in `tools.json` that records tool halves the operator chose not to gate. A list of
 * halves, because the same tool under two servers (or a third one later) is one decision; and a
 * record, because `--doctor` can tell a decline from a removed entry.
 */
export const DECLINED_KEY = 'declined';

/** The merged map plus the operator's recorded declines, which `decide` and `--doctor` read. */
export interface ToolConfig {
  map: ToolMap;
  /** Tool halves deliberately not gated, sorted. Every entry using one is removed from `map`. */
  declined: string[];
  /** The entries a decline removed, so a checklist can still say where a declined tool goes. */
  declinedRoutes: ToolMap;
  /**
   * `tools.json` entries kept dormant by a decline of their half: validated, not routed, and
   * restored exactly as written the moment the half is re-enabled. `--doctor` names them.
   */
  dormant: string[];
  /**
   * Declined halves no entry used: a decline of nothing, almost always a typo, so the tool meant is
   * still gated. `--doctor` names these.
   */
  declinedUnrouted: string[];
}

/**
 * The tool half of `name` when that half is declined, else null. The loader, the policy, the
 * registration reader and the checklist all ask through this.
 */
export function declinedHalfOf(name: string, declined: readonly string[]): string | null {
  const half = toolHalfOf(name);
  return half !== null && declined.includes(half) ? half : null;
}

/**
 * `mergeToolMap`, plus the `declined` list.
 *
 * Every entry using a declined half is removed from the map, so the matcher, inference and
 * `--doctor`'s coverage, all derived from the map, cannot gate it. An operator entry for a declined
 * half is kept dormant rather than refused, so a re-enable restores its custom `bodyField`.
 */
export function mergeToolConfig(base: ToolMap, override: unknown, source: string): ToolConfig {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new ToolMapError(
      `${source}: expected a JSON object of {"toolName": "destination"}, where a destination is ` +
        `${KNOWN_DESTINATIONS}, or an object like {"destination": "jira", ` +
        '"bodyOptional": true} or {"destination": "linear", "bodyField": "description"}.'
    );
  }
  const { [DECLINED_KEY]: declinedRaw, ...entries } = override as Record<string, unknown>;
  const declined = parseDeclined(declinedRaw, source);
  const out: ToolMap = { ...base };
  const dormant: string[] = [];
  for (const [tool, value] of Object.entries(entries)) {
    if (value === null) {
      delete out[tool];
      continue;
    }
    const existing = base[tool];
    const typed = withDefaultDisclosure(parseRoute(tool, value, source), disclosureFor(base, tool));
    if (declinedHalfOf(tool, declined) !== null) dormant.push(tool);
    // An entry that restates a default keeps the default's owner; anything else is the operator's.
    out[tool] = existing !== undefined && sameRoute(existing, typed) ? existing : typed;
  }
  const declinedRoutes: ToolMap = {};
  for (const name of Object.keys(out)) {
    if (declinedHalfOf(name, declined) === null) continue;
    declinedRoutes[name] = out[name]!;
    delete out[name];
  }
  const removed = new Set(Object.keys(declinedRoutes).map(toolHalfOf));
  return {
    map: out,
    declined,
    declinedRoutes,
    dormant: dormant.sort(),
    declinedUnrouted: declined.filter((h) => !removed.has(h)),
  };
}

/**
 * An operator entry for a default tool discloses at least what the default does. Without the union,
 * `"...slack_send_message": "slack"` would drop the default's `*` and hide `reply_broadcast`.
 * The operator's fields first (their order is a claim), wildcards last.
 */
function withDefaultDisclosure(typed: ToolRoute, existing: ToolRoute | undefined): ToolRoute {
  if (existing?.contextFields === undefined) return typed;
  const all = [...new Set([...(typed.contextFields ?? []), ...existing.contextFields])];
  return {
    ...typed,
    contextFields: [...all.filter((f) => !isWildcardField(f)), ...all.filter(isWildcardField)],
  };
}

/**
 * The base route whose disclosure an operator entry inherits: the same name, else the same tool
 * half under another server (through `resolveRoute`). By half, because operator entries are
 * typically aliases (`mcp__atlassian__addCommentToJiraIssue`), which would otherwise get no `*`.
 */
function disclosureFor(base: ToolMap, tool: string): ToolRoute | undefined {
  return resolveRoute(tool, base)?.route;
}

/**
 * The `declined` list: absent means none, anything else must be a list of tool halves. A full name
 * (`mcp__slack__slack_send_message`) is refused with the half it probably meant: as a half it would
 * match nothing.
 */
function parseDeclined(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  // `isFieldName` rather than `isFieldNameList`, which requires a non-empty list: `[]` is legal.
  if (!Array.isArray(value) || !value.every(isFieldName)) {
    throw new ToolMapError(
      `${source}: "${DECLINED_KEY}" is ${JSON.stringify(value)}, which is not a list of tool ` +
        'halves like ["slack_send_message"]. These are the tools deliberately NOT reviewed, so ' +
        'the list is not guessed at.'
    );
  }
  // A full name is anything `toolHalfOf` would split, not anything containing `__`: a half may hold
  // one (`mcp__srv__foo__bar` has the half `foo__bar`), and the checklist offers it.
  for (const half of value) {
    const full = toolHalfOf(half);
    if (full !== null) {
      throw new ToolMapError(
        `${source}: "${DECLINED_KEY}" holds "${half}", which is a full tool name. List the tool ` +
          `half ("${full}"): a decline covers that tool under every server.`
      );
    }
  }
  return [...new Set(value)].sort();
}

/**
 * Do two routes make the same claim, ignoring `schemaOwner` (the answer, not the question)?
 *
 * Compared over the routes' own keys, so a field added later is included: an enumeration missing
 * it would read a changed operator entry as a restatement, keep `connector` ownership, and fail
 * open on `body/missing-field` for a route the operator wrote.
 */
function sameRoute(a: ToolRoute, b: ToolRoute): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== 'schemaOwner'));
  for (const key of keys) {
    const left = a[key as keyof ToolRoute];
    const right = b[key as keyof ToolRoute];
    if (!sameClaim(left, right)) return false;
  }
  return true;
}

/**
 * Do two route values say the same thing? Lists compare by element, since identity would read
 * every restated `contextFields` as a change. Order counts: it is the order a reviewer reads in.
 */
function sameClaim(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
  // An absent optional flag and an explicit `false` are the same claim.
  return (left ?? false) === (right ?? false);
}

/**
 * A field name, as `tools.json` may state one. A type predicate, so `parseRoute` narrows through it.
 * The trim test is not `parseBodyPath`'s: `'  '` is a legal-looking single segment there.
 */
function isFieldName(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function isFieldNameList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(isFieldName);
}

/**
 * "This path must be addressable", for every path-shaped field. A `BodyPathError` is reported
 * against the file; anything else is a programming error and is rethrown as it is.
 */
function checkPath(source: string, tool: string, what: string, field: string): void {
  try {
    parseBodyPath(field);
  } catch (e) {
    if (!(e instanceof BodyPathError)) throw e;
    throw new ToolMapError(`${source}: "${tool}" has an unusable ${what}. ${e.message}`);
  }
}

/**
 * One `tools.json` entry, in either spelling. `"tool": "jira"` is the form to use; the long form
 * (`{"destination": "jira", "bodyOptional": true}`) exists for the facts few operators have.
 * Everything is refused rather than coerced, with a message naming the file.
 */
function parseRoute(tool: string, value: unknown, source: string): ToolRoute {
  if (typeof value === 'string') {
    if (!isKnownDestination(value)) throw unknownDestination(tool, value, source);
    return { destination: value, schemaOwner: 'operator' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolMapError(
      `${source}: "${tool}" maps to ${JSON.stringify(value)}. Use a destination name ` +
        `(${KNOWN_DESTINATIONS}), an object like ` +
        '{"destination": "linear", "bodyField": "description"}, or null to remove the entry.'
    );
  }
  const entry = value as Record<string, unknown>;
  const { destination, bodyOptional } = entry;
  // Every `RouteFacts` key, through a total `Record`, so a new fact is a compile error here: a
  // dropped field would make `sameRoute` read the entry as a restatement of the default.
  const claimed: Record<keyof RouteFacts, unknown> = {
    bodyField: entry.bodyField,
    contextFields: entry.contextFields,
    proseFields: entry.proseFields,
    bodyFormat: entry.bodyFormat,
  };
  const { bodyField, contextFields, proseFields, bodyFormat } = claimed;
  if (typeof destination !== 'string' || !isKnownDestination(destination)) {
    throw unknownDestination(tool, destination, source);
  }
  // `"bodyOptional": "false"` is truthy; read as true, comment-less calls would go unreviewed.
  if (bodyOptional !== undefined && typeof bodyOptional !== 'boolean') {
    throw new ToolMapError(
      `${source}: "${tool}" has "bodyOptional": ${JSON.stringify(bodyOptional)}, which is not ` +
        'true or false. This flag decides whether a call with no message is allowed through ' +
        'unreviewed, so it is not guessed at.'
    );
  }
  // `""` would reach `extractBody` and be reported as a missing field named `""`.
  if (bodyField !== undefined && !isFieldName(bodyField)) {
    throw new ToolMapError(
      `${source}: "${tool}" has "bodyField": ${JSON.stringify(bodyField)}, which is not a field ` +
        'name. This names the tool-input field the message travels in, so it is not guessed at.'
    );
  }
  // Checked here as well as at review time, so the message can name the file. A dotted path reaches
  // a nested field (`fields.description`).
  if (bodyField !== undefined) checkPath(source, tool, 'bodyField', bodyField);
  // Non-empty: the list adds to the profile's, so `[]` would read as "show no routing" and do
  // nothing (it reaches the CLI as no `--context-field` flag at all).
  if (contextFields !== undefined && !isFieldNameList(contextFields)) {
    throw new ToolMapError(
      `${source}: "${tool}" has "contextFields": ${JSON.stringify(contextFields)}, which is not a ` +
        'non-empty list of field names. These are the routing fields shown beside the draft; omit ' +
        "the key to keep the destination's own list."
    );
  }
  // Each entry is a path, by `bodyField`'s grammar; one that addresses nothing would draw an empty
  // strip that looks complete.
  for (const field of contextFields ?? []) checkPath(source, tool, 'contextFields entry', field);
  if (proseFields !== undefined && !isFieldNameList(proseFields)) {
    throw new ToolMapError(
      `${source}: "${tool}" has "proseFields": ${JSON.stringify(proseFields)}, which is not a ` +
        'non-empty list of field names. These are the prose fields the reviewer may EDIT beside ' +
        'the body; omit the key if the body is the only prose this tool carries.'
    );
  }
  for (const field of proseFields ?? []) checkPath(source, tool, 'proseFields entry', field);

  // The rules relating a body to the prose beside it, shared with the CLI's flags.
  const complaint = proseFieldsComplaint(
    typeof bodyField === 'string' ? bodyField : '',
    (proseFields ?? []) as string[]
  );
  if (complaint !== null) throw new ToolMapError(`${source}: "${tool}": ${complaint}`);
  // An unknown value read as `markdown` would give a plain field a toolbar. The set comes from the
  // flag table.
  const formats = FORMAT_FLAG.values;
  if (bodyFormat !== undefined && !formats.includes(bodyFormat as 'markdown')) {
    throw new ToolMapError(
      `${source}: "${tool}" has "bodyFormat": ${JSON.stringify(bodyFormat)}, which is not ` +
        `${formats.map((f) => `"${f}"`).join(' or ')}. This decides whether the reviewer is ` +
        'offered formatting at all.'
    );
  }
  return {
    destination,
    ...(bodyOptional === true ? { bodyOptional: true } : {}),
    // Every fact the entry claims, minus a restated default (`bodyFormat: "markdown"`), which would
    // make `sameRoute` read the entry as a change. Shared with `routeFlagArgs`.
    ...claimedRouteFacts(claimed as RouteFacts),
    schemaOwner: 'operator',
  };
}

/** `bodyFormat`'s flag spec, narrowed to `kind: 'choice'` once. */
const FORMAT_FLAG = ROUTE_FLAGS.bodyFormat as Extract<
  (typeof ROUTE_FLAGS)['bodyFormat'],
  { kind: 'choice' }
>;

function unknownDestination(tool: string, dest: unknown, source: string): ToolMapError {
  return new ToolMapError(
    `${source}: "${tool}" maps to ${JSON.stringify(dest)}, which is not a known destination. ` +
      `Use ${KNOWN_DESTINATION_NAMES}, or null to remove the entry.`
  );
}

/**
 * The anchored regex for a `matcher`, sorted so the same map always writes the same registration.
 *
 * `halves` are the tool halves the second branch infers from: every half the map routes, unless a
 * caller narrows it (`extraToolsBlock` leaves out the halves the plugin's own matcher infers from).
 */
export function matcherFor(map: ToolMap, halves: readonly string[] = toolHalvesOf(map)): string {
  const names = Object.keys(map).sort();
  if (names.length === 0) throw new ToolMapError('The tool map is empty; there is nothing to gate.');
  const branches = names.map(escapeRegex);
  // The half branch fires for a connector nobody named (`mcp__whatever__slack_send_message` in a
  // project elsewhere), which would otherwise send with no window and no log row; see
  // `resolveRoute`. The exact names cover a `tools.json` tool whose half draftgate does not know.
  if (halves.length > 0) {
    branches.push(`mcp__(?:${SERVER_CHARS})__(?:${halves.map(escapeRegex).join('|')})`);
  }
  return `^(?:${branches.join('|')})$`;
}

/** Does a registered matcher fire for this tool name? A pattern that will not compile fires for nothing. */
export function matcherCovers(matcher: string, toolName: string): boolean {
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

/**
 * The character class a server half may use, from names seen in use: `linear-server` has a hyphen,
 * `claude_ai_Atlassian_Rovo` underscores and capitals, and a dot is plausible in a hostname-derived
 * name. Not `.+`, which could swallow the separator and match a tool half inside a longer name.
 *
 * It permits SINGLE underscores and never a double, which is not pedantry: `toolHalfOf` splits at
 * the FIRST `__`, and a greedy `[A-Za-z0-9_.-]+` could split at any of them. On a server named
 * `my__server`, `mcp__my__server__slack_send_message` would make the matcher fire while
 * `resolveRoute` returns null, so `decide` would take the hard-deny branch and tell the reader to
 * "re-register the hook" -- advice that cannot help, because re-registering regenerates the same
 * matcher. The two agree by construction: a name this class matches has exactly one `__` before
 * the tool half.
 */
const SERVER_CHARS = '[A-Za-z0-9.-]+(?:_[A-Za-z0-9.-]+)*';

/** Every distinct TOOL half the map routes, sorted. The stable half of an MCP tool name. */
export function toolHalvesOf(map: ToolMap): string[] {
  const halves = new Set<string>();
  for (const name of Object.keys(map)) {
    const half = toolHalfOf(name);
    if (half !== null) halves.add(half);
  }
  return [...halves].sort();
}

/** `mcp__<server>__<tool>` -> `<tool>`, or null when the name is not an MCP tool name. */
export function toolHalfOf(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const cut = rest.indexOf('__');
  if (cut <= 0) return null;
  const tool = rest.slice(cut + 2);
  return tool === '' ? null : tool;
}

/**
 * Which mapped entry owns a tool half, or null. Shared by `reconcileTools` and `resolveRoute`, so
 * `--propose-tools` copies facts from the entry the gate uses. Sorted, so the choice does not
 * depend on the order `tools.json` was written in.
 */
export function entryForHalf(map: ToolMap, half: string): string | null {
  for (const mapped of Object.keys(map).sort()) {
    if (toolHalfOf(mapped) === half) return mapped;
  }
  return null;
}

/**
 * Which route a tool name takes, and whether anybody configured it.
 *
 * An exact entry is a configuration. A tool half a configured entry also uses, under a server
 * nobody named, is an inference: a wrong one is still reviewed by a human who can reject, while
 * none would send with nobody looking. `schemaOwner: 'inferred'` keeps `decide.ts`'s fail-opens
 * off such a route.
 */
export function resolveRoute(
  name: string,
  map: ToolMap
): { route: ToolRoute; inferred: boolean; matchedEntry?: string } | null {
  // `Object.hasOwn`, not a bare index: `toString` and friends read as entries otherwise.
  if (Object.hasOwn(map, name)) return { route: map[name]!, inferred: false };
  const half = toolHalfOf(name);
  if (half === null) return null;
  const mapped = entryForHalf(map, half);
  if (mapped !== null) {
    const from = map[mapped]!;
    return {
      /*
       * `destination` plus the facts `ROUTE_FACTS` marks `inferred` (`bodyField`, `contextFields`,
       * `proseFields`, `bodyFormat`): the same half is the same tool, so its schema facts hold. A
       * wrong body field can only ask or deny (`FAIL_OPEN.inferred`); a missing one would ask with
       * no draft shown. Not `bodyOptional`, which `decide.ts` turns into `allow`; and
       * `schemaOwner` is `inferred`, which `decide.ts` checks as a second guard.
       */
      route: { destination: from.destination, ...routeFactsFor(from, 'inferred'), schemaOwner: 'inferred' },
      inferred: true,
      /** Which entry the half matched, so a reviewer can judge the guess. */
      matchedEntry: mapped,
    };
  }
  return null;
}

/**
 * The characters `escapeRegex` escapes and `registration.ts`'s reader refuses to unescape: one
 * definition for `matcherFor` (writer) and `matcherNames` (reader).
 */
export const REGEX_META = /[.*+?^${}()|[\]\\]/;

/** MCP tool names are `[A-Za-z0-9_]` in practice, but a map is user-supplied. Escape anyway. */
function escapeRegex(s: string): string {
  return s.replace(new RegExp(REGEX_META, 'g'), '\\$&');
}
