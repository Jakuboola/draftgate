/**
 * Jira destination profile.
 *
 * Mode is `convert-and-replace` because the Atlassian MCP tool accepts ADF
 * (`addCommentToJiraIssue.contentFormat: "markdown" | "adf"`), the only destination that does.
 * The acceptance checks exist because structurally valid ADF is not the same as accepted ADF.
 *
 * Four of the six `RULES` read their sets from `adfSchema.ts`, three of them shared with the code
 * that fixes or emits the shape:
 *
 *   blockquote            `JSM_BLOCKQUOTE_ALLOWED`      probed both ways, shared with the converter
 *   inline-only parents   `INLINE_ONLY`/`INLINE_TYPES`  shared with `hoistMedia`
 *   listItem              `LIST_ITEM_FORBIDDEN`         probed, shared with the converter
 *   taskList              `TASK_LIST_CHILDREN`          probed, read by this checker only: the
 *                                                       converter's `listToAdf` spells the legal
 *                                                       shapes itself and does not read the set
 *
 * The other two, `panel` and `tableCell`/`tableHeader`, carry hand-written `forbidden` sets here.
 * Every pair in them is probed 400 (the table inside `RULES`), and nothing else reads them: the
 * converter never puts those children there.
 */

import type { AdfDocument, AdfNode } from '../adf/types';
import {
  INLINE_ONLY,
  INLINE_TYPES,
  JSM_BLOCKQUOTE_ALLOWED,
  LIST_ITEM_FORBIDDEN,
  VISIBLE_ATOMS,
  mediaOnlyItems,
  TASK_LIST_CHILDREN,
  walk,
  walkUntil,
} from '../adfSchema';
import { sanitizeAdfForJsm } from '../adf/sanitizeBlockquote';
import type { ConversionReport } from '../adf/markdownToAdf';
import { bareDestination } from '../linkDestination';
import { markdownImages, maskCode, matchTrailingNewline } from '../markdown';
import { JIRA_ATTACHMENT_SCHEME } from '../adf/util';
import { type Warning, type WarningCode, warn } from '../warnings';
import { codePointLength, formatCount, judge } from '../lengthLimit';
import type { Audience, AudienceAnswer } from '../audience';
import type { DestinationProfile } from './index';
import { editorOptionsFor, markdownFromAdf, markdownToAdfFor } from '../editor';

// ---------------------------------------------------------------------------
// Acceptance rules
//
// Each rule names the parent it constrains and either the children it allows (anything else is an
// error) or the children it forbids.
// ---------------------------------------------------------------------------

interface Rule {
  /** Which parent this rule constrains. */
  parent: (type: string) => boolean;
  allowed?: Set<string>;
  forbidden?: Set<string>;
  code: WarningCode;
  message: (child: string, parent: string) => string;
}

const is = (...types: string[]) => (t: string) => types.includes(t);

/**
 * A node type in the reviewer's words, where they differ from the ADF name: every type markdown can
 * produce, the `RULES` parents, and `JSM_BLOCKQUOTE_ALLOWED`. Any other type keeps its ADF name.
 */
const READER_NAMES: Record<string, string> = {
  bulletList: 'bulleted list',
  orderedList: 'numbered list',
  listItem: 'list item',
  taskList: 'checklist',
  taskItem: 'checklist item',
  blockquote: 'quote',
  codeBlock: 'code block',
  rule: 'divider',
  tableCell: 'table cell',
  tableHeader: 'table header',
  mediaSingle: 'image',
  mediaGroup: 'image',
  media: 'image',
  expand: 'collapsible section',
};
const readerName = (type: string): string => READER_NAMES[type] ?? type;
const aReaderName = (type: string): string => {
  const name = readerName(type);
  return `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
};
/** Deduplicated: `mediaSingle` and `mediaGroup` are both an image to the reviewer. */
const QUOTE_HOLDS = [...new Set([...JSM_BLOCKQUOTE_ALLOWED].map(readerName))].join(', ');
/** The probed 400 every `RULES` entry but the inline-only one rests on. */
const refused = (child: string, parent: string): string =>
  `Jira refuses ${aReaderName(child)} inside ${aReaderName(parent)}, so the whole comment would be lost.`;

const RULES: Rule[] = [
  {
    // Probed: a rejected blockquote child loses the whole comment.
    parent: is('blockquote'),
    allowed: JSM_BLOCKQUOTE_ALLOWED,
    code: 'jira/blockquote-child-rejected',
    message: (child, parent) =>
      `${refused(child, parent)} Move it out of the quote. A quote can hold: ${QUOTE_HOLDS}.`,
  },
  /*
   * PROBED, all ten pairs: `render()`'s contract requires each `error` rule to name its probe, so
   * Atlassian's tool description is not enough. Every pair was POSTed to the JSM comment endpoint
   * on a scratch issue:
   *
   *   listItem > heading      400 INVALID_INPUT      panel > table       400 INVALID_INPUT
   *   listItem > table        400 INVALID_INPUT      panel > expand      400 INVALID_INPUT
   *   listItem > panel        400 INVALID_INPUT      panel > blockquote  400 INVALID_INPUT
   *   listItem > expand       400 INVALID_INPUT      panel > panel       400 INVALID_INPUT
   *   tableCell > table       400 INVALID_INPUT      tableCell > expand  400 INVALID_INPUT
   *
   * plus two controls that must not 400 and did not: `doc > paragraph` (201) and
   * `tableCell > nestedExpand` (201), the shape a collapsible section in a cell must take. Both
   * created comments were deleted (204, re-read 404).
   *
   * `INVALID_INPUT` is the same generic 400 the blockquote rule rests on, and it loses the whole
   * comment rather than the offending node.
   */
  {
    // `blockquote` and `rule` are in the set too, probed. See `LIST_ITEM_FORBIDDEN`.
    parent: is('listItem'),
    forbidden: LIST_ITEM_FORBIDDEN,
    code: 'jira/list-item-block-child',
    message: (child, parent) => `${refused(child, parent)} Move it out of the list.`,
  },
  {
    parent: is('panel'),
    forbidden: new Set(['table', 'expand', 'blockquote', 'panel']),
    code: 'jira/panel-child-rejected',
    message: (child, parent) => `${refused(child, parent)} Move it out of the panel.`,
  },
  {
    // Probed: `taskList > bulletList` and `taskList > orderedList` are 400 in any position;
    // `taskList > taskList` is 201. `listToAdf` un-nests the rejected shape, so from markdown this
    // is defence behind the fixer. See `TASK_LIST_CHILDREN`.
    parent: is('taskList'),
    allowed: TASK_LIST_CHILDREN,
    code: 'jira/task-list-child-rejected',
    message: (child, parent) =>
      `${refused(child, parent)} A checklist can hold only checklist items and nested checklists.`,
  },
  {
    parent: is('tableCell', 'tableHeader'),
    forbidden: new Set(['table', 'expand']),
    code: 'jira/table-cell-forbidden-child',
    // A collapsible section in a cell must be ADF's `nestedExpand`, which is accepted (probed 201).
    message: (child, parent) => `${refused(child, parent)} Move it out of the table.`,
  },
  {
    // Paragraph, taskItem, decisionItem, heading and caption. `paragraph` is here because of a
    // live 400: `listItem > paragraph > mediaSingle` is rejected.
    parent: (t) => INLINE_ONLY.has(t),
    allowed: INLINE_TYPES,
    code: 'jira/block-child-in-inline-container',
    message: (child, parent) =>
      // No 400 claimed here: only the paragraph case is probed.
      `Jira cannot take ${aReaderName(child)} inside ${aReaderName(parent)}, which holds only ` +
      'text. Put it on a line of its own.',
  },
];

// ---------------------------------------------------------------------------
// Audience
//
// PROBED against a scratch issue in a `service_desk` project. A JSM
// comment's audience is the comment property `sd.public.comment`, read back as `jsdPublic`. The
// rows that constrain the code below, lettered as the comments in this file cite them:
//
//   B  REST comment + `sd.public.comment {internal: true}`   201, jsdPublic FALSE
//   C  Rovo `addCommentToJiraIssue`, no visibility argument   201, jsdPublic TRUE
//   F  Rovo + an extra top-level `properties` key             201, jsdPublic TRUE, key DROPPED
//   G  create internal, then edit it through Rovo             jsdPublic FALSE -- preserved
//   H  set the property AFTER creation                        201, jsdPublic stays TRUE
//   J  REST worklog (`timeSpent` + an ADF `comment`)          201; the platform and PORTAL
//                                                              comment lists are unchanged
//
// B is how an internal note is posted; C is why `public` says the tool cannot do otherwise; F is why
// `updatedInput` (which does carry `contentFormat: "adf"`) cannot fix it; G is why an edit reports
// `unchanged`; H is why none of this is recoverable afterwards; J is why a worklog has no audience.
// ---------------------------------------------------------------------------

/**
 * Atlassian's own `projectTypeKey` values, as `/rest/api/3/project/search` returns them. All four
 * observed live on one production site; `product_discovery` is here because it was seen, not
 * because the docs mention it. Only `service_desk` has a customer; the other three get no banner.
 *
 * A value with the type derived from it, because `cli/src/jiraProjects.ts` validates the
 * operator's file against the same four strings at runtime.
 */
export const JIRA_PROJECT_TYPES = [
  'service_desk',
  'software',
  'business',
  'product_discovery',
] as const;

/**
 * The one predicate for that vocabulary (the sibling of `isGitHubRepoVisibility`);
 * `cli/src/jiraProjects.ts` re-exports it. Its callers are the config readers: a reviewer's answer
 * is checked against `reviewerAnswers` by `audienceFor` instead.
 */
export function isProjectType(v: unknown): v is JiraProjectType {
  return typeof v === 'string' && (JIRA_PROJECT_TYPES as readonly string[]).includes(v);
}

export type JiraProjectType = (typeof JIRA_PROJECT_TYPES)[number];

/**
 * Where one project's classification came from: `jira` was measured (`tools/jira-projects/` asked
 * `/rest/api/3/project/search`), `reviewer` is an answer given in the review window.
 *
 * A measurement outranks a reviewer's answer, and a reviewer's answer may replace another, so a
 * second click fixes a mis-click without an API token.
 */
export type JiraProjectSource = 'jira' | 'reviewer';

/**
 * One Jira site's project classification. Per site because a project key is unique within a site
 * and nowhere else: `SUPPORT-123` can name a scratch issue on a dev site and a customer ticket on
 * production.
 */
export interface JiraSite {
  /**
   * The site's hostname, because the tool's schema takes "Cloud ID (UUID or site URL)", so an agent
   * may pass `acme.atlassian.net` as `cloudId`.
   */
  host?: string;
  projects: Record<string, JiraProjectType>;
  /**
   * Which of `projects` came from where, by the same keys. A sibling map so a hand-written
   * `{"SUPPORT": "service_desk"}` keeps working. A key missing here is unmarked, and unmarked counts
   * as authoritative (hand-written, or written without sources), so no file needs migrating.
   */
  sources?: Record<string, JiraProjectSource>;
}

/**
 * What a Jira audience decision needs that the payload does not carry: Jira's half of the composed
 * `AudienceFacts` in `profiles/index.ts`, which also carries `toolName`.
 */
export interface JiraAudienceFacts {
  /** Keyed by cloud id, from the operator's config. See `cli/src/jiraProjects.ts`. */
  sites?: Record<string, JiraSite>;
}

/**
 * The reviewer's own answer about this target, which outranks the config lookup. The window sets
 * it the moment someone answers and re-asks the profile, so the banner changes before they decide.
 * The CLI never sets it: it persists the answer, and the next review reads it through `sites`.
 *
 * Beside `JiraAudienceFacts` rather than in it, because the composed `AudienceFacts` carries
 * `classified` wide (any destination, any string). `audienceFor` checks the destination and the
 * value against `reviewerAnswers` first, so `jiraAudience` reads it with no guard.
 */
export type JiraAudienceAnswer = AudienceAnswer<'jira', JiraProjectType>;

/**
 * The tools this profile has evidence about, matched on the tool half of an MCP name: the
 * `mcp__<server>__` prefix is one installation's name for a connector (see `toolMap.ts`), so a
 * renamed Atlassian connector keeps the right audience.
 */
const POSTS_REQUEST_COMMENT = /(?:^|__)addCommentToJiraIssue$/;
const POSTS_WORKLOG = /(?:^|__)addWorklogToJiraIssue$/;
/**
 * A tool that posts an internal note, via the comment property Rovo cannot reach. Recognised by
 * name here, never by an operator-declared field on `ToolRoute`, which could assert `internal` for a
 * tool that replies to customers (`adapters/hook/test/toolAudience.test.ts`; see `audience.md`).
 *
 * Probe B: `POST /rest/api/3/issue/{k}/comment` with
 * `properties: [{key: "sd.public.comment", value: {internal: true}}]` returns 201 and
 * `jsdPublic: false`.
 *
 * Only on a configured route. An inferred route's server was named by its author, and
 * `sooperset/mcp-atlassian` names its tools `jira_<verb>_<noun>` and has an open request for
 * internal comments, so `facts.routeInferred` makes this `unknown`.
 */
const POSTS_INTERNAL_NOTE = /(?:^|__)jira_add_internal_note$/;

/**
 * A tool that writes the request's own title and body: what the customer reads in the portal, not
 * one entry in the thread under it.
 *
 * PROBED against a scratch issue in a `service_desk` project whose request type is
 * `Product request and feedback`. `editJiraIssue` setting `fields.summary` and
 * `fields.description` changed both in the portal's own projection
 * (`GET /rest/servicedeskapi/request/{key}` -> `requestFieldValues`) immediately. Restored
 * afterwards; the stored ADF read back identical. `requestFieldValues`, not `expand=renderedBody`,
 * is the instrument: the customer surface probe J also read.
 *
 * Conditional on the project, so `jiraAudience` tests it after the project-type check.
 */
const EDITS_REQUEST_FIELDS = /(?:^|__)editJiraIssue$/;

/**
 * A tool that creates the issue whose title and body a customer reads. PROBED, both ways:
 *
 * - With the dedicated parameters only (no `requestType` among them), the issue is not a portal
 *   request: `GET /rest/servicedeskapi/request/<key>` answers 404
 *   `sd.customerview.error.vpOriginMissing`.
 * - With `additional_fields: {"customfield_10010": "40"}` (Request Type is a custom field), it is a
 *   portal request on arrival: a 200 carrying the summary and description verbatim, with a real
 *   `/servicedesk/customer/portal/...` URL.
 *
 * So portal visibility on a create is a property of the payload. The banner states neither timing:
 * a custom field id is per-site, so draftgate cannot tell them apart, and the reviewer is looking at
 * the customer-facing title and body either way. `kind` is `public` because the styling must err
 * that way; the window uses it only as a CSS hook.
 */
const CREATES_REQUEST = /(?:^|__)createJiraIssue$/;

/**
 * Matcher -> the one sentence the reviewer reads. The single source for both the claim and
 * `probedHere`, so a tool cannot be evidence-listed without a claim or vice versa. A list, so the
 * order holds if a broader matcher is added.
 */
const WRITES_REQUEST_FIELDS: readonly (readonly [RegExp, string])[] = [
  [
    EDITS_REQUEST_FIELDS,
    'The summary and description are the request as the reporter sees it in the portal: its title ' +
      'and its body, not one entry in the thread below them.',
  ],
  [CREATES_REQUEST, 'This writes the title and body of a service-desk request.'],
];

/**
 * Has anything in this file been probed against this tool? Read by `--doctor` (as this profile's
 * `audienceProbed`, via `profiles/index.ts`) to report gated Jira tools whose reviews will always
 * say `Audience unknown`.
 *
 * "Probed" is not "has a banner": a worklog's evidence (probe J) is that it has no audience. Derived
 * from the same matchers `jiraAudience` branches on, and its fallthrough asks this, so the two agree
 * on every configured route. An inferred `jira_add_internal_note` is `unknown` in the banner but
 * probed here: this asks about the name, and inference is a fact about the route.
 */
export function jiraToolProbed(tool: string): boolean {
  return (
    POSTS_WORKLOG.test(tool) ||
    POSTS_INTERNAL_NOTE.test(tool) ||
    POSTS_REQUEST_COMMENT.test(tool) ||
    WRITES_REQUEST_FIELDS.some(([match]) => match.test(tool))
  );
}

/**
 * What a Jira project key looks like, for `jiraProjectKey` (inside an issue reference) and
 * `jiraTargetProjectKey` (bare, from a create payload).
 */
const PROJECT_KEY = '[A-Za-z][A-Za-z0-9_]*';

/**
 * The project key an issue reference belongs to, normalised, or `undefined` if there is none.
 *
 * Uppercased because Jira issue keys are case-insensitive (probed: 200 in upper, lower and mixed
 * case), so a lower-case key must still find the operator's config entry. `undefined` for a numeric
 * issue ID (`25664`), which the tool accepts and which carries no project.
 */
export function jiraProjectKey(issueIdOrKey: unknown): string | undefined {
  if (typeof issueIdOrKey !== 'string') return undefined;
  const m = new RegExp(`^(${PROJECT_KEY})-\\d+$`).exec(issueIdOrKey.trim());
  return m ? jiraProjectKeyOf(m[1]!) : undefined;
}

/**
 * A project key reduced to the form the config is keyed by: `parseJiraProjects` normalises on read
 * and `rememberJiraProject` on write, both through this (the sibling of `jiraSiteKey`).
 */
export function jiraProjectKeyOf(key: string): string {
  return key.trim().toUpperCase();
}

/**
 * The project a Jira payload is about. Shared by the reader (`jiraAudience`) and the writer
 * (`cli/src/classificationStores.ts`), so a reviewer's answer is filed under the project it was
 * asked about.
 *
 * An issue reference wins: it names an existing issue. `projectKey` is what a create carries.
 */
export function jiraTargetProjectKey(context: Record<string, unknown>): string | undefined {
  const fromIssue = jiraProjectKey(context.issueIdOrKey);
  if (fromIssue !== undefined) return fromIssue;
  // A value that is not key-shaped yields `undefined`, not a string no configured key can match.
  if (typeof context.projectKey !== 'string') return undefined;
  const trimmed = context.projectKey.trim();
  return new RegExp(`^${PROJECT_KEY}$`).test(trimmed) ? jiraProjectKeyOf(trimmed) : undefined;
}

/**
 * A `cloudId` reduced to the form the config is keyed by. Exported for the writer
 * (`rememberJiraProject`): a raw `https://acme.atlassian.net` stored beside a normalised lookup is
 * an entry no review finds again. The tool takes "Cloud ID (UUID or site URL)"; a UUID is unchanged,
 * so generator files match.
 */
export function jiraSiteKey(cloudId: string): string {
  // Case-insensitive because the lowercase comes last: `Https://acme.atlassian.net` would otherwise
  // keep its scheme and become one more duplicate site row.
  const host = cloudId.trim().replace(/^https?:\/\//i, '');
  // A loop and not `/\/+$/`, which backtracks quadratically on a slash run that is not at the end.
  let end = host.length;
  while (end > 0 && host[end - 1] === '/') end--;
  return host.slice(0, end).toLowerCase();
}

/**
 * Every key in the file that names one of these spellings, matching on the normalised key or on
 * `host`. Shared by the reader and the writers so an answer for a UUID-keyed site, sent with
 * `cloudId` spelled as the site URL, merges into the existing row instead of a shadowed second one.
 * Returns keys, not entries, so the writer can merge.
 *
 * `unknown` values because the writers pass the file's raw JSON; a non-string `host` does not match.
 * Plural because `withJiraSite` passes the cloud id and the host and merges every match;
 * `jiraSiteFor` and `withJiraProject` take the first.
 */
export function jiraSiteKeysFor(
  spellings: readonly unknown[],
  sites: Record<string, unknown> | undefined
): string[] {
  if (sites === undefined) return [];
  const want = new Set(
    spellings.filter((s): s is string => typeof s === 'string').map(jiraSiteKey).filter((k) => k !== '')
  );
  if (want.size === 0) return [];
  const found: string[] = [];
  for (const [id, site] of Object.entries(sites)) {
    // Both sides normalised: `parseJiraProjects` keeps the file's raw key and `host` is
    // hand-written, so a `host` of `https://acme.atlassian.net` must still match.
    const host = (site as { host?: unknown } | null)?.host;
    if (want.has(jiraSiteKey(id)) || (typeof host === 'string' && want.has(jiraSiteKey(host)))) {
      found.push(id);
    }
  }
  return found;
}

/** The one key a payload's `cloudId` refers to, or none. */
export function jiraSiteKeyFor(
  cloudId: unknown,
  sites: Record<string, unknown> | undefined
): string | undefined {
  return jiraSiteKeysFor([cloudId], sites)[0];
}

/** The configured site a payload's `cloudId` refers to, by cloud id or by hostname. */
export function jiraSiteFor(
  cloudId: unknown,
  sites: Record<string, JiraSite> | undefined
): JiraSite | undefined {
  const id = jiraSiteKeyFor(cloudId, sites);
  return id === undefined ? undefined : sites?.[id];
}

/**
 * Where this is going, as `host / ISSUE-1`: a `cloudId` UUID does not say whether the target is a
 * dev site or production, and one issue key can exist on both. The host comes from the operator's
 * `jira-projects.json`, already read for the audience.
 *
 * `undefined` when the site is not configured or has no `host`, so the window shows the raw fields:
 * never half a label like "? / SUPPORT-123". The issue reference is as the payload wrote it, to
 * compare against the ticket a human has open; with none, the host alone.
 */
export function jiraDestinationLabel(
  context: Record<string, unknown>,
  facts: JiraAudienceFacts = {}
): string | undefined {
  const host = jiraSiteFor(context.cloudId, facts.sites)?.host;
  if (host === undefined || host.trim() === '') return undefined;
  const issue = typeof context.issueIdOrKey === 'string' ? context.issueIdOrKey.trim() : '';
  return issue === '' ? host.trim() : `${host.trim()} / ${issue}`;
}

/**
 * Who receives this Jira message. `undefined` means the question does not arise (no customer, or
 * not a request comment), so no banner. The branches, in order:
 *
 *  1. A worklog: no audience. Probe J: posting one with a comment leaves the platform and portal
 *     comment lists unchanged, and the worklog carries no `jsdPublic`.
 *     Then the internal note, on a configured route (on an inferred one it is unprobed, 4).
 *  2. A project type with no customer: silent.
 *  3. The field writers (`WRITES_REQUEST_FIELDS`), conditional on the project.
 *  4. A tool nobody has probed: `unknown`, naming itself, rather than the comment tool's claims.
 *  5. An edit of an existing comment: `unchanged` whatever the project (probe G).
 *  6. A service desk: `public`.
 *  7. Everything else: `unknown`, which is loud.
 */
export function jiraAudience(
  context: Record<string, unknown>,
  facts: JiraAudienceFacts & JiraAudienceAnswer = {}
): Audience | undefined {
  const tool = facts.toolName;
  if (tool !== undefined && POSTS_WORKLOG.test(tool)) return undefined;

  // An internal note is a claim about the tool (it sets `sd.public.comment {internal: true}`
  // unconditionally, probe B), so it comes before the project-type check. `unavailable` names the
  // other tab, as the public case does.
  const internalNote = tool !== undefined && POSTS_INTERNAL_NOTE.test(tool);
  // On an inferred route the name asserts nothing: it falls through as an unprobed tool.
  if (internalNote && facts.routeInferred !== true) {
    return {
      kind: 'internal',
      label: 'Internal note',
      detail:
        'The reporter never sees this. Only people with access to the project can read it, and ' +
        'this tool cannot post a customer-visible reply.',
      unavailable: 'Reply to customer',
    };
  }

  // The CLI loads the operator's file; this profile does the lookup, so the caller stays
  // destination-blind.
  const key = jiraTargetProjectKey(context);
  const site = jiraSiteFor(context.cloudId, facts.sites);
  // The reviewer's answer first. No runtime narrowing: `audienceFor` drops a foreign answer before
  // this is called (a GitHub value here would pass the `!== 'service_desk'` test below and hide the
  // banner).
  const answered = facts.classified?.value;
  const projectType = answered ?? (key === undefined ? undefined : site?.projects[key]);

  // No type but `service_desk` has a portal. Written as "not a service desk", not a list of the other
  // three; `parseJiraProjects` refuses an unrecognised string before it reaches this.
  if (projectType !== undefined && projectType !== 'service_desk') return undefined;

  // The field writers, from `WRITES_REQUEST_FIELDS` (evidence on each matcher). After the project
  // check because both are conditional on the project; an unclassified project falls through to the
  // `ask` at the end, as the comment tool does.
  const writer = WRITES_REQUEST_FIELDS.find(([match]) => tool !== undefined && match.test(tool));
  if (projectType === 'service_desk' && writer !== undefined) {
    return { kind: 'public', label: 'The customer reads this', detail: writer[1] };
  }

  // An unnamed caller (`review --dest jira --in payload.json`, no `--tool`) lands here too: the
  // evidence was gathered against the named tools only, so naming none must not inherit
  // `addCommentToJiraIssue`'s claims. `jiraToolProbed` is the question `--doctor` asks, so the two
  // agree. An internal-note name on an inferred route is unprobed too.
  const probedHere =
    tool !== undefined && jiraToolProbed(tool) && !(internalNote && facts.routeInferred === true);
  if (!probedHere) {
    return {
      kind: 'unknown',
      label: 'Audience unknown',
      detail:
        (tool === undefined
          ? 'draftgate was not told which tool is sending this. '
          : `draftgate has no evidence about who sees what ${tool} posts. `) +
        'Its Jira audience facts were probed against particular tools, and this is not one of them.',
    };
  }

  const editing = typeof context.commentId === 'string' && context.commentId.trim() !== '';
  if (editing) {
    return {
      kind: 'unchanged',
      label: 'Editing an existing comment',
      detail:
        'This keeps the visibility the comment already has, public or internal. draftgate cannot ' +
        'read which it is.',
    };
  }

  if (projectType === 'service_desk') {
    return {
      kind: 'public',
      label: 'Reply to customer',
      detail:
        'The reporter sees this in the portal. This tool cannot post an internal note, and the ' +
        'visibility cannot be changed after sending.',
      // JSM's other tab, shown struck through: the choice exists and this tool cannot make it.
      unavailable: 'Add internal note',
    };
  }

  return {
    kind: 'unknown',
    label: 'Audience unknown',
    detail:
      `draftgate does not know whether ${key ?? 'this project'} is a service desk. If it is, this ` +
      'goes to the customer and cannot be made internal.',
    /*
     * Only when there is a project to ask about (a numeric issue id carries none). "No" records
     * `software`: the rule distinguishes `service_desk` from everything else, so it may be a
     * `business` or `product_discovery` project, and the label says what is recorded. Corrections:
     * the window's undo before submitting, a later click (see `JiraProjectSource`), or
     * `bun run jira:projects <site>`, which needs an API token and rewrites the whole site.
     */
    ...(key === undefined
      ? {}
      : {
          ask: {
            question: `Is ${key} a service desk?`,
            options: [
              { label: 'Yes -- customers read replies', value: 'service_desk' as const },
              { label: 'No -- record it as internal', value: 'software' as const },
            ],
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const jiraProfile = {
  name: 'jira' as const,
  displayName: 'Jira',
  /** Required field, no default. Jira is the only destination that can do this. */
  mode: 'convert-and-replace' as const,
  /**
   * The extra field the hook must set alongside the substituted body. Missing this makes Jira
   * render the ADF JSON as literal text: a successful send of visible garbage.
   */
  extraToolInput: { contentFormat: 'adf' } as const,
  bodyField: 'commentBody',
  /*
   * `projectKey` because `jiraAudience` reads it, and a create names its project nowhere else: the
   * keys a destination's own logic reads must be in its profile list (`cli/src/payload.ts`), or a
   * short-form route loses the classification and its `ask`.
   */
  contextFields: ['cloudId', 'issueIdOrKey', 'commentId', 'projectKey'],

  /**
   * Who receives this comment (`core/src/audience.ts`). The rule lives here and the project type
   * arrives as a fact from the operator's config, because `core` is pure.
   *
   * Method shorthand, not `audienceFor: jiraAudience`: method parameters are bivariant, so the
   * narrower annotation against the composed `AudienceFacts` compiles without a cast (as for
   * `convert` and `suggestFix`; see `DestinationProfile`).
   */
  audienceFor(context: Record<string, unknown>, facts: JiraAudienceFacts & JiraAudienceAnswer) {
    return jiraAudience(context, facts);
  },
  /**
   * The values `ask` offers: service desk or internal. Narrower than `JIRA_PROJECT_TYPES` (the config
   * vocabulary), so the wire refuses `business` or `product_discovery` as an answer.
   * `core/test/audience.test.ts` holds this equal to the `ask` options.
   */
  reviewerAnswers: ['service_desk', 'software'],
  audienceProbed: jiraToolProbed,

  /**
   * Where it is going: the site's hostname, from the operator config the audience reads. On the
   * profile because only Jira knows that `cloudId` names a site.
   */
  destinationLabel(context: Record<string, unknown>, facts: JiraAudienceFacts) {
    return jiraDestinationLabel(context, facts);
  },

  /**
   * The preview's styling is Atlassian's own numbers: token values recovered from
   * `@atlaskit/editor-core`'s built CSS, plus computed styles read off its live render, asserted
   * back out of the rendered window by `surface/harness/probe.ts`.
   */
  previewFidelity: 'probe-derived' as const,
  /**
   * Both derived from `@atlaskit/tokens`, which publishes light and dark; the light values
   * cross-validate against an independent ruler measurement. See `tools/atlassian-tokens/`.
   */
  themes: ['light', 'dark'] as const,
  /**
   * Everything. Six heading levels: the real Jira editor gives h1-h6 six different sizes and
   * line-heights (`tools/jira-ruler/probe-headings.cjs`). Every block appears in the torture
   * fixture, converts to ADF and is asserted in the goldens; tables, task lists, code blocks and
   * rules were accepted by live Jira (201). Nesting limits (a quote may not hold a heading or a
   * table) are checked on the converted tree, as `jira/blockquote-child-rejected`.
   */
  toolbar: {
    headingLevels: [1, 2, 3, 4, 5, 6],
    marks: ['bold', 'italic', 'strike', 'code', 'link'],
    blocks: ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'rule'],
    /* Emoji is Unicode and survives byte-identically. No `image` insert (see `ToolbarInsert`); an
     * image an agent writes still converts to external media (`mediaSingle`, verified live at 201). */
    inserts: ['emoji'],
  } as const,

  /**
   * Every kind of mention, as one descriptor (`MentionSupport`).
   *
   * `tokens: null`, probed: Jira's `[~accountid:x]` renders as literal characters (logged-in
   * screenshot), so marking it would promise a ping that never happens. Jira's mention is a node.
   *
   * `chips`, verified live: an ADF `mention` node POSTs 201 and is stored verbatim (the stored ADF,
   * not `expand=renderedBody`, which re-parses through a legacy wiki path), and Jira resolves the
   * display name from the id. So the account id is what notifies, and the chip's name is the
   * agent's text, which the advice says.
   */
  mentions: {
    tokens: null,
    chips: {
      advice:
        'A mention chip notifies the account it carries. The name shown is the label the agent ' +
        'supplied; the destination resolves the account id behind it, so the two can disagree.',
    },
    // No link is a mention here: Jira's mention is the node above, and a link stays a link.
    links: null,
  },

  // Jira receives ADF, and `convert` below hoists media out of every inline-only container.
  mediaPlacement: 'block' as const,
  // Jira fetches the URL and draws the picture -- verified live at 201, and
  // `jira/external-image-embedded` says so at review time.
  rendersMedia: true,
  /*
   * The one destination that cannot carry emphasis across a code span: `code`+`strong` is a 400
   * INVALID_INPUT that loses the whole comment (probed, table at `CODE_MARK_COMBINES_WITH` in
   * `core/src/adfSchema.ts`). Disclosed as `jira/code-span-emphasis-lost`.
   */
  codeSpanMarks: 'link-only',
  listItemBlocks: 'adf',
  // Not probed here, so the converter keeps `<url|label>` as the text it was written as.
  angleLinkLabels: false,
  targetIdentity: {
    requiredFields: ['cloudId'],
    caseFolded: [],
    ambiguity:
      'an issue key is unique within a site and nowhere else -- it would match the same key on ' +
      'production',
  },
  /**
   * No delta spelling on any Jira tool draftgate gates or could gate. Checked against the live
   * schemas: `editJiraIssue` takes a `fields` object whose values are set wholesale, and the
   * comment tools carry a whole body.
   */
  deltaFields: [],

  /**
   * 32,767 on Jira's own count, which is not the ADF this sends (`jiraLengthLowerBound`). Past it a
   * comment is refused with a 400 `CONTENT_LIMIT_EXCEEDED` that loses it. PROBED against a scratch
   * issue. `fields.summary` is absent from `lineLimits` because nobody probed its length.
   */
  bodyLimit: { accepted: 32_767, refused: 32_768, unit: 'characters' },
  lineLimits: {},
  /*
   * PROBED on `summary` (PUT /rest/api/3/issue): an LF answers 400 "The summary is invalid because
   * it contains newline characters." and writes nothing. CR was not probed. Scoped to the edit tool,
   * because the probe was the PUT `editJiraIssue` makes; `createJiraIssue`'s summary gets the
   * unprobed warning.
   */
  lineBreaks: { 'fields.summary': { lf: 'refused', cr: 'unprobed', tools: EDITS_REQUEST_FIELDS } },

  convert(markdown: string): { converted: AdfDocument; warnings: Warning[] } {
    // The editor's pipeline (`markdownToAdfFor`), so the reviewer and Jira see one tree. It hoists
    // media out of every inline-only container (the converter alone does top-level paragraphs
    // only; a nested image is a 400 that loses the comment) and decodes `[@Label](mention:ID)` into
    // a mention node that notifies. `raw` is the pre-hoist tree, the only place media-only items
    // are still visible (`mediaOnlyItems`); everything else is inspected on what is sent.
    const { raw, adf: converted, report } = markdownToAdfFor(markdown, editorOptionsFor(jiraProfile));
    return {
      converted,
      warnings: [...inspect(converted, markdown, raw, report), ...jiraLengthWarnings(converted)],
    };
  },

  /**
   * The one-click remedy offered when this destination will not deliver the draft. On the profile
   * because only it knows the shape of `RenderResult.converted`.
   *
   * `sanitizeAdfForJsm` coerces the children Jira's blockquote rejects into allowed equivalents,
   * preserving text and degrading only visual hierarchy, so it is offered as one click behind a
   * diff. Null when there is nothing to offer.
   */
  suggestFix(converted: AdfDocument, markdown: string): string | null {
    try {
      // See `matchTrailingNewline`; without it the equality below never holds for a body ending in
      // a newline.
      const fixed = matchTrailingNewline(
        markdownFromAdf(sanitizeAdfForJsm(converted)),
        markdown
      );
      return fixed === markdown ? null : fixed;
    } catch {
      return null;
    }
  },
} satisfies DestinationProfile;

/**
 * A lower bound on the length Jira checks against its 32,767 limit, from the ADF this sends. Jira
 * counts neither the ADF JSON nor the text alone. The probes, all against a scratch issue:
 *
 *     one paragraph of 32,767                              -> 201
 *     two paragraphs, 16,383 + 16,382  (32,765 text)       -> 201
 *     two paragraphs, 16,383 + 16,383  (32,766 text)       -> 400 CONTENT_LIMIT_EXCEEDED
 *     32 paragraphs x 1,000  (32,000 text; ADF 34,154 B)   -> 201
 *     one link, text 16,000 + href 16,760                  -> 201
 *     one link, text 20,000 + href 14,015                  -> 400
 *
 * So a paragraph break costs exactly 2 (the second and third rows pin it from both sides), and a
 * link's href is counted beside its text (the last row is refused on 34,015 though its text is only
 * 20,000): what legacy wiki markup would cost (`\n\n` between paragraphs, `[text|href]`).
 *
 * `jira/body-too-long` blocks, so it must never fire on a body Jira would accept: every term here is
 * one a probe established, and everything else counts zero: the `[`, `|` and `]` of a link (the
 * accepted link row allows up to 7 characters of overhead, so none is certain), the separator
 * between any two blocks that are not both top-level paragraphs, and every heading, list, table,
 * code-block or mark delimiter. A link whose text is its href counts once, as wiki markup writes
 * the bare URL. Counted in code points, the smallest plausible unit (`lengthLimit.ts`). The real
 * count is usually more, which is what `jira/body-near-limit` is for.
 */
export function jiraLengthLowerBound(doc: AdfDocument): number {
  return jiraLength(doc, NOTHING_UNPROBED);
}

/**
 * How close to its limit a body may come before the reviewer is told it may be refused. A margin,
 * chosen rather than measured, for the unprobed nodes `jiraLengthLowerBound` counts as nothing.
 */
const JIRA_NEAR_LIMIT = 0.9;

/**
 * What wiki markup would most likely spend on each thing the lower bound counts as zero. Not
 * probed: read off the wiki syntax (`h2. `, `* `, `{code}`, `||`, `*x*`, `{{x}}`, `[x|u]`), and
 * used only by `jira/body-near-limit`, a `warning` that says it is an estimate.
 */
const WIKI_COST: LengthCosts = {
  link: 3,
  blockBreak: 2,
  node: {
    heading: 4, listItem: 2, codeBlock: 14, blockquote: 4, rule: 4,
    tableRow: 1, tableHeader: 2, tableCell: 1, mediaSingle: 2, panel: 14,
  },
  mark: { strong: 2, em: 2, strike: 2, underline: 2, code: 4 },
};
const NOTHING_UNPROBED: LengthCosts = { link: 0, blockBreak: 0, node: {}, mark: {} };

interface LengthCosts {
  /** A link's `[`, `|` and `]`. */
  readonly link: number;
  /** Between two sibling blocks that are not both top-level paragraphs (those are probed: 2). */
  readonly blockBreak: number;
  readonly node: Readonly<Record<string, number>>;
  readonly mark: Readonly<Record<string, number>>;
}

/** The one walk behind both counts, so the estimate can only add to the lower bound. */
function jiraLength(doc: AdfDocument, costs: LengthCosts): number {
  let total = 0;
  const visit = (nodes: readonly AdfNode[], topLevel: boolean) => {
    // The href of the link the previous inline sibling carried: a link split across several text
    // nodes (`[**a** b](u)`) is one `[a b|u]` in wiki markup, so its href is counted once.
    let openHref: string | undefined;
    let prev: AdfNode | undefined;
    for (const node of nodes) {
      if (prev !== undefined && !INLINE_TYPES.has(node.type) && !INLINE_TYPES.has(prev.type)) {
        total += topLevel && prev.type === 'paragraph' && node.type === 'paragraph' ? 2 : costs.blockBreak;
      }
      prev = node;
      total += costs.node[node.type] ?? 0;
      if (typeof node.text === 'string') {
        total += codePointLength(node.text);
        for (const m of node.marks ?? []) total += costs.mark[m.type] ?? 0;
        const href = node.marks?.find((m) => m.type === 'link')?.attrs?.href;
        if (typeof href === 'string') {
          if (href !== openHref && href !== node.text) total += codePointLength(href) + costs.link;
          openHref = href;
        } else openHref = undefined;
      } else openHref = undefined;
      if (node.content) visit(node.content, false);
    }
  };
  visit(doc.content, true);
  return total;
}

/**
 * `jira/body-too-long` when the lower bound is past the limit, which is certain; otherwise
 * `jira/body-near-limit` when the estimate (the lower bound plus `WIKI_COST`) reaches
 * `JIRA_NEAR_LIMIT` of it. Built from the ADF, not the markdown's length: loading a draft spells a
 * bare URL `[u](u)`, which would double a comment of links.
 */
function jiraLengthWarnings(doc: AdfDocument): Warning[] {
  const limit = jiraProfile.bodyLimit;
  const lower = jiraLengthLowerBound(doc);
  if (judge(lower, limit) === 'over') {
    return [
      warn({
        code: 'jira/body-too-long',
        severity: 'error',
        message:
          `This draft is at least ${formatCount(lower)} characters as Jira counts them. Jira ` +
          `refuses a comment over ${formatCount(limit.accepted)}, so nothing would be sent. ` +
          `Shorten it.`,
      }),
    ];
  }
  const estimate = jiraLength(doc, WIKI_COST);
  if (estimate < limit.accepted * JIRA_NEAR_LIMIT) return [];
  return [
    warn({
      code: 'jira/body-near-limit',
      severity: 'warning',
      message:
        `This draft is about ${formatCount(estimate)} characters, close to Jira's ` +
        `${formatCount(limit.accepted)} limit. It is an estimate, because Jira also counts ` +
        `formatting. Past the limit Jira refuses the whole comment. Shorten it to be safe.`,
    }),
  ];
}

/**
 * Does this document carry anything a reader would see? Whitespace-only text does not; an atom
 * in `VISIBLE_ATOMS` (media, a rule) does. `walkUntil` stops at the first hit; `walk` has no
 * break, which is measurable on a 20 KB document on every keystroke.
 */
function hasVisibleContent(doc: AdfDocument): boolean {
  return walkUntil(
    doc,
    (node) =>
      (typeof node.text === 'string' && node.text.trim() !== '') || VISIBLE_ATOMS.has(node.type)
  );
}

// ---------------------------------------------------------------------------
// One traversal
//
// Acceptance, lossiness and the embedded-media note all come from a single walk.
// ---------------------------------------------------------------------------


/**
 * A URL short enough for a one-line warning: a `data:` image would put the whole base64 payload in
 * the line. Middle-elided so the scheme and the filename both survive.
 */
function shortUrl(url: string, max = 80): string {
  if (url.length <= max) return url;
  const head = Math.ceil((max - 1) / 2);
  return `${url.slice(0, head)}…${url.slice(url.length - (max - 1 - head))}`;
}

/**
 * Exported for `core/test/render.test.ts` only (`convert` above is the production caller): most
 * of `RULES` fire on shapes the converter never emits from markdown (`listItem > table`,
 * `panel > expand`, `tableCell > table`), so only this seam lets a test reach them. `markdown` is
 * what the degraded-image scan reads and `raw` is the pre-hoist tree; a nesting test passes the
 * same document for all three.
 */
export function inspect(
  doc: AdfDocument,
  markdown: string,
  raw: AdfDocument,
  /**
   * The fixer's own tally of what it changed (`MarkdownToAdfOptions.report`), read here so the
   * checker cannot disagree with it. All-zero for hand-built ADF, where nothing was changed.
   */
  report: ConversionReport = { unnestedFromTasks: 0, movedOutOfListItems: 0, codeSpanMarksLost: 0 }
): Warning[] {
  const { unnestedFromTasks: unnested, movedOutOfListItems: movedOut, codeSpanMarksLost } = report;
  const out: Warning[] = [];
  const embedded: string[] = [];

  /*
   * A checklist item that holds nothing but an image loses its checkbox: `hoistMedia` moves the
   * image to just after the list (probed 201) and drops the emptied item with its `- [x]` state.
   * ADF has no checklist item that holds only a picture, so this is disclosed, not repaired. A
   * `warning`: the send succeeds and the image arrives, but something the reviewer wrote does not.
   */
  const mediaOnly = mediaOnlyItems(raw);
  if (mediaOnly.length > 0) {
    out.push(
      warn({
        code: 'jira/task-item-media-only',
        severity: 'warning',
        message:
          mediaOnly.length === 1
            ? 'A checklist item holds only an image, which Jira cannot put there: the image is ' +
              'sent after the list and the checkbox dropped, tick included. Add text on that line ' +
              'to keep it.'
            : `${mediaOnly.length} checklist items hold only an image, which Jira cannot put ` +
              'there: the images are sent after the list and the checkboxes dropped, ticks ' +
              'included. Add text on each line to keep them.',
      })
    );
  }

  /*
   * A bullet or numbered list nested under a checklist item is sent un-nested: the checklist
   * closes, the list follows as a sibling, and a checklist reopens for any items after it. Probed:
   * `taskList` holds only `taskItem` and `taskList` (`TASK_LIST_CHILDREN`), and `listToAdf` keeps
   * every item's kind and order rather than retyping bullets into to-dos. A `warning`: every word
   * arrives.
   *
   * Counted by the converter (`MarkdownToAdfOptions.report`): after un-nesting, an indented list and
   * a list after a blank line are the same ADF, and a second `parseBlocks` would be the fixer
   * written twice (a nested checklist can be un-nested too, depending on earlier siblings).
   */
  if (unnested > 0) {
    out.push(
      warn({
        code: 'jira/task-item-nested-list-unnested',
        severity: 'warning',
        message:
          `${unnested === 1 ? 'A list nested under a checklist item arrives as a separate list' : `${unnested} lists nested under checklist items arrive as separate lists`} ` +
          'after the checklist, because a Jira checklist cannot hold a bulleted or numbered list. ' +
          'Only the indentation is lost.',
      })
    );
  }

  /*
   * A block Jira cannot hold inside a list item is sent just after its item, outside the list, and
   * the list resumes. Two shapes: anything but a nested list under a checklist item (`taskItem` is
   * inline-only), and a heading, quote, rule or table under any other item (`LIST_ITEM_FORBIDDEN`,
   * probed 400). Moved rather than blocked, since every word arrives. Counted by the converter.
   */
  if (movedOut > 0) {
    out.push(
      warn({
        code: 'jira/list-item-block-moved-out',
        severity: 'warning',
        message:
          `${movedOut === 1 ? 'A block inside a list item arrives' : `${movedOut} blocks inside list items arrive`} ` +
          'just after the item, outside the list, because Jira cannot hold ' +
          `${movedOut === 1 ? 'it' : 'them'} there. Every word arrives; only the indentation is lost.`,
      })
    );
  }

  /*
   * Emphasis that covered a code span, and no longer does. `code` combines with `link` only
   * (`CODE_MARK_COMBINES_WITH`), so the converter turns `**`x` and words**` into
   * `` `x` **and words** ``. No `suggestedFix`: dropping the backticks or the bold is the
   * reviewer's call. Counted by the converter.
   */
  if (codeSpanMarksLost > 0) {
    out.push(
      warn({
        code: 'jira/code-span-emphasis-lost',
        severity: 'warning',
        message:
          `Bold, italic or strikethrough on ${codeSpanMarksLost === 1 ? 'a code span' : `${codeSpanMarksLost} code spans`} ` +
          'is dropped from the code, because Jira allows only a link there. The words around it ' +
          'keep theirs. Rephrase if the code must be emphasised.',
      })
    );
  }

  /*
   * Markdown that is not blank but renders to nothing, which no structural check can see. A blank
   * source is `render()`'s `body/empty`; the `markdown.trim()` guard keeps the two apart.
   *
   * Probed against a scratch issue, one comment per shape, each deleted afterwards (204):
   *
   *   doc > [paragraph []]                    400  "Comment body can not be empty!"
   *   doc > []                                400  same
   *   doc > [blockquote > paragraph []]       201  ACCEPTED
   *   doc > [codeBlock []]                    201  ACCEPTED
   *   doc > [table > row > cell > para []]    201  ACCEPTED
   *   doc > [bulletList > listItem > para []] 201  ACCEPTED
   *   doc > [taskList > taskItem []]          201  ACCEPTED
   *   doc > [rule]                            201  ACCEPTED  (and VISIBLE -- see VISIBLE_ATOMS)
   *
   * So `> ` is accepted and the reader gets a blank comment, as with a zero-width-space body (also
   * probed 201). An `error` because nobody can read the message, not because the API refuses it
   * (see `render.ts`).
   */
  if (markdown.trim() !== '' && !hasVisibleContent(doc)) {
    out.push(
      warn({
        code: 'jira/empty-body',
        severity: 'error',
        message:
          // Jira refuses some of these (400 "Comment body can not be empty!") and accepts the rest:
          // an empty quote or code block posts fine and shows nothing.
          'This renders as an empty comment: there is markup, but nothing a reader would see. ' +
          'Jira either refuses it or posts a blank comment. Add some text.',
        path: 'doc',
        nodeType: 'doc',
      })
    );
  }

  // The images the source asked for, so the degraded ones are a difference rather than a grep.
  // `maskCode` first: an image inside a code span or fence is content, not a request to embed.
  const sourceImages = markdownImages(maskCode(markdown));

  walk(doc, (node, path, parent) => {
    // --- will Jira accept this shape? ---
    if (parent) {
      for (const rule of RULES) {
        if (!rule.parent(parent.type)) continue;
        const rejected = rule.allowed
          ? !rule.allowed.has(node.type)
          : rule.forbidden!.has(node.type);
        if (!rejected) continue;
        out.push(
          warn({
            code: rule.code,
            severity: 'error',
            nodeType: node.type,
            path,
            message: rule.message(node.type, parent.type),
          })
        );
      }
    }

    // --- media Jira renders by fetching a URL ---
    if (node.type === 'media' && node.attrs?.type === 'external' && typeof node.attrs.url === 'string') {
      embedded.push(node.attrs.url);
    }
  });

  /*
   * --- images the converter could not embed: source minus media ---
   *
   * Not a search for the converter's `[Image: alt]` fallback text, which cannot tell a degraded
   * image from a reviewer who typed `[Image: the diagram]`; and this way the message can name the
   * lost URL.
   *
   * Checked against fifteen shapes (see `core/test/markdown.test.ts`): an image in a heading, a
   * table cell, a blockquote, a list item and a task item all produce media and are correctly
   * silent; relative, `data:`, `ftp:` and protocol-relative URLs are all correctly reported. One
   * blind spot: an image nested in a link label (`[![alt](url)](href)`) is not seen by
   * `markdownLinkSpans` as an image at all, so it is not reported. Deduplicated by URL.
   */
  const embeddedUrls = new Set(embedded);
  /*
   * Both spellings the converter normalises away, so a source image can be matched to its media:
   *
   *  - `jira-attachment:<contentUrl>`: the media node carries the contentUrl without the scheme.
   *  - `<url>`: `markdownLinkSpans` keeps the angle brackets and the converter strips them, so
   *    `![a](<http://example.com/y.png>)` would report both `jira/image-degraded-to-text` and
   *    `jira/external-image-embedded` for one image.
   */
  const normaliseImageUrl = (raw: string): string => {
    // The grammar module's own unwrap, the one the converter uses.
    const bare = bareDestination(raw);
    return bare.startsWith(JIRA_ATTACHMENT_SCHEME)
      ? bare.slice(JIRA_ATTACHMENT_SCHEME.length)
      : bare;
  };
  const lost = new Map<string, number>();
  for (const image of sourceImages) {
    // Normalised (see above), or every attachment-backed image reads as lost. The `images.md`
    // golden holds this.
    const url = normaliseImageUrl(image.url);
    if (embeddedUrls.has(url)) continue;
    lost.set(url, (lost.get(url) ?? 0) + 1);
  }
  for (const [url, times] of lost) {
    out.push(
      warn({
        code: 'jira/image-degraded-to-text',
        severity: 'warning',
        message:
          `The image ${shortUrl(url)} cannot be embedded${times > 1 ? ` (${times} times)` : ''} ` +
          'and arrives as plain text without its URL: Jira fetches only absolute http(s) URLs. ' +
          'Attach the file to the issue instead.',
      })
    );
  }

  for (const url of embedded) {
    out.push(
      warn({
        code: 'jira/external-image-embedded',
        severity: 'info',
        message:
          `Jira shows the image ${url} by fetching that URL, so it must stay reachable for ` +
          `anyone reading the comment.`,
      })
    );
  }

  return out;
}
