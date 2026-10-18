/**
 * Destination profile registry. Each destination was verified against a live instance:
 *
 *   jira   -- rejects invalid structure with a 400 and loses the whole comment
 *   slack  -- renders markdown close to losslessly, tables included; what it loses is listed in
 *             `slack.ts`. It does not delete tables: a read-back API says it does, and the rendered
 *             message says otherwise
 *   linear -- stores the markdown byte-identically
 *   github -- renders GFM almost entirely, and rejects no structure a GFM body can express
 *
 * Every profile declares `mode` explicitly, with no default: convert-and-replace is possible for
 * exactly one of the known destinations, so either default would mislead.
 */

import { jiraProfile, type JiraAudienceFacts } from './jira';
import { slackProfile } from './slack';
import { linearProfile } from './linear';
import { githubProfile, type GitHubAudienceFacts } from './github';
import type { Audience, TargetAnswer } from '../audience';
import type { Fix, Warning } from '../warnings';
import type { MentionSupport } from '../mentionTokens';
import type { LengthLimit, LineLimit } from '../lengthLimit';
import type { LineBreakFact } from '../lineCharacters';
import type { ItemBlocks } from '../adf/markdownToAdf';

export type { MentionSupport };
export type { TargetAnswer };

/**
 * Whether a destination can carry emphasis across a code span. A destination vocabulary that
 * `editorOptionsFor` turns into the converter's ADF-level flag, as `mediaPlacement` becomes
 * `inlineMedia`; not in `core/src/adfSchema.ts`, because `'any'` is defined by GitHub's renderer
 * and Linear's storage, not by Atlassian.
 *
 *  - `link-only`  the body sent is the converted ADF, so `CODE_MARK_COMBINES_WITH` is the law and
 *                 anything else is stripped before the tree leaves. Jira, probed: `code` plus
 *                 `strong`, `em` or `strike` is a 400 that loses the whole comment.
 *  - `any`        the body sent is the markdown; ADF is only the editor pipeline's intermediate.
 *                 `**`code` and words**` travels verbatim: GitHub's renderer returns
 *                 `<strong><code>code</code> and words</strong>` (`POST /markdown`, gfm), and
 *                 Linear stores markdown byte-identically.
 */
export type CodeSpanMarks = 'link-only' | 'any';

export type Mode = 'convert-and-replace' | 'preview-only';

/**
 * How far the preview's styling can be trusted against the destination's own rendering.
 *
 *  - `probe-derived`  the values were read off the destination's own editor or rendered surface,
 *                     and are asserted back out of the rendered window.
 *  - `indicative`     a likeness: the structure is right, the typography is approximate.
 *
 * A statement about the conversion rather than the stylesheet is `RenderResult.format`.
 */
export type PreviewFidelity = 'probe-derived' | 'indicative';

export type Theme = 'light' | 'dark';

/**
 * Which themes a destination's preview can honestly render. On the profile, like
 * `previewFidelity`, because it says how far a destination has been measured; a destination listing
 * only `light` renders light on a dark system rather than invent a palette nobody checked.
 *
 * Every destination declares both. Slack's and Linear's palettes are generated from their vendors'
 * sources (`tools/slack-tokens/` from `app.slack.com/client`, `tools/linear-tokens/` from
 * linear.app), with `tokens.json` committed and `surface/harness/tokens.test.ts` failing if either
 * sheet drifts. Jira and GitHub are measured off their own rendered surfaces by a ruler, hence
 * `probe-derived`; vendor-authored is not probe-derived, so the other two stay `indicative`.
 */
export type SupportedThemes = readonly [Theme, ...Theme[]];

/**
 * Inline marks a destination renders; every destination renders all five (verified). A runtime
 * list because `surface/src/Editor.tsx` builds the `code` mark's ProseMirror `excludes` out of it.
 *
 * No `underline`, though Jira and Linear render it: markdown has no underline, each vendor's
 * markdown serialiser drops it, and draftgate's wire is markdown end to end. The same excludes
 * every other mark on `adfToMarkdown`'s discard list.
 */
export const TOOLBAR_MARKS = ['bold', 'italic', 'strike', 'code', 'link'] as const;
/** Derived from `TOOLBAR_MARKS`, so the two cannot drift. */
export type ToolbarMark = (typeof TOOLBAR_MARKS)[number];

/** Block structures a destination renders. */
export type ToolbarBlock =
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'table'
  | 'rule';

/**
 * Things the toolbar can insert, as opposed to structures it toggles. `emoji` is Unicode, carried
 * byte-identically and rendered by every destination (verified through the editor round trip).
 *
 * No `image` insert: draftgate holds no destination credentials, so it cannot upload, and no gated
 * tool has a file parameter, so a by-URL insert would only duplicate Link. Display is separate: an
 * image an agent writes is still drawn, converted and warned about (Jira embeds it as external
 * media, Linear renders it inline, Slack turns it into a plain link).
 *
 * No `mention` insert, and not because of the converter: `core/src/mentions.ts` round-trips
 * `[@Label](mention:ID)`, and a Jira mention arrives as a real, notifying mention (verified live);
 * `mentions.chips` decides whether the editor draws a chip. What is missing is a user directory
 * for a picker to offer, which neither draftgate nor the hook payload can supply.
 */
export type ToolbarInsert = 'emoji';

/**
 * Where this destination's document model puts media: in its own block, or inline. The editor is
 * built markdown -> ADF -> ProseMirror and ADF has no inline media, so unless placement is
 * `inline`, `See ![x](url) for the timeline.` is drawn as three blocks, which is only true of Jira.
 *
 *  - `block`   the body sent is the converted ADF, where a `mediaSingle` cannot sit inside a
 *              heading or a task item, so `hoistMedia` moves it before the window draws it. Jira.
 *  - `inline`  the body sent is the markdown and the image stays where the agent wrote it. Linear,
 *              GitHub, and Slack vacuously (`rendersMedia: false`: no image reaches the editor).
 */
export type MediaPlacement = 'block' | 'inline';

/**
 * What the editor's toolbar may offer for this destination: a capability list, not a layout. The
 * window owns which control looks like what and where; the profile owns whether it appears.
 *
 * Never offer a control whose effect the recipient will not see: a heading picker offering h4 to
 * Slack would invite a level Slack draws identically to h3, the loss
 * `slack/heading-level-collapsed` reports in words.
 */
export interface ToolbarSupport {
  /**
   * Heading levels the destination renders distinctly, ascending. Slack accepts `####` and
   * renders it identically to `###` (see `slackProfile.toolbar`).
   */
  headingLevels: readonly number[];
  marks: readonly ToolbarMark[];
  blocks: readonly ToolbarBlock[];
  inserts: readonly ToolbarInsert[];
}

/**
 * What it takes to name one target at this destination, as opposed to a family of them. Here,
 * not in `destination === '...'` branches in `cli/src/scratchTargets.ts`: the CLI compares routing
 * values without knowing what they mean.
 *
 * `requiredFields`: what a declaration must carry to identify anything. An issue key is unique
 * within a Jira site and nowhere else -- `SUPPORT-123` can be a scratch issue on a dev site and a
 * real customer ticket on production -- so a Jira target needs `cloudId`. A GitHub repository
 * needs `owner` and `repo`: either alone matches other repositories.
 *
 * `caseFolded`: the values the destination treats case-insensitively. GitHub's names are
 * (`Jakuboola/draftgate` and `jakuboola/draftgate` are one repository); Slack's `C…`/`U…` ids and
 * Jira's issue keys are case-sensitive.
 *
 * `ambiguity`: the sentence saying what goes wrong if `requiredFields` is not honoured, so the
 * loop that reads it names no destination.
 */
export interface TargetIdentity {
  readonly requiredFields: readonly string[];
  readonly caseFolded: readonly string[];
  /** Required exactly when `requiredFields` is non-empty. */
  readonly ambiguity?: string;
}

/**
 * What every destination profile declares. Each profile is `satisfies DestinationProfile`, so the
 * literals keep their narrow types (`mode: 'convert-and-replace'`) and a stray field is an
 * excess-property error. A field with no safe default is required even where it is empty: an
 * absent one would read as some default, wrong for a connector nobody has checked.
 *
 * `convert` and `suggestFix` are method signatures so their parameters are bivariant: Jira may
 * declare `suggestFix(converted: AdfDocument, …)` against `unknown`, since a profile is only handed
 * what its own `convert` produced. `converted` is `unknown` because only the profile knows its
 * shape (see `RenderResult.suggestedFix`).
 */
export interface DestinationProfile {
  readonly name: string;
  /** What a person reads it as: a prompt, a heading, a remembered answer's source. */
  readonly displayName: string;
  /** Required, no default: see this module's header. */
  readonly mode: Mode;
  /** Extra tool-input fields the adapter must set alongside the body (`cli/src/payload.ts`). */
  readonly extraToolInput: Readonly<Record<string, unknown>>;
  /**
   * The field this destination's comment tool carries its body in: a default. Linear spells it
   * `body`, `description` and `content` depending on the tool (read off the live schemas); the
   * per-tool answer is `ToolRoute.bodyField`, which may be a dotted path.
   */
  readonly bodyField: string;
  /**
   * Routing fields shown beside the draft: a default, and the sole input to `audienceFor` and
   * `destinationLabel` below and to the CLI's `rememberJiraProject`. A route's own
   * `contextFields` adds to this list rather than replacing it, so an operator cannot drop
   * `cloudId` and take a Jira review from `audience: public` to `audience: unknown`.
   */
  readonly contextFields: readonly string[];
  readonly previewFidelity: PreviewFidelity;
  readonly themes: SupportedThemes;
  readonly toolbar: ToolbarSupport;
  /** Every kind of mention, and what to say about each. See `MentionSupport`. */
  readonly mentions: MentionSupport;
  readonly mediaPlacement: MediaPlacement;
  /** Whether an image is drawn as a picture here at all. */
  readonly rendersMedia: boolean;
  /**
   * Whether emphasis may span a code span here (see `CodeSpanMarks` for the probe); only Jira is
   * `link-only`. The editor pipeline is markdown -> ADF -> ProseMirror for every destination, so
   * without this `**`code` and words**` would go out as `` `code` **and words** `` for Slack,
   * Linear and GitHub too, unwarned. Either default is wrong for somebody: `link-only` silently
   * rewrites the message, `any` loses a Jira comment to a 400.
   */
  readonly codeSpanMarks: CodeSpanMarks;
  /**
   * Which blocks a list item keeps here beyond its own text; anything else the converter moves out
   * to right after the item, and the profile discloses the move. See `ItemBlocks`: `adf` (Jira),
   * `lists` (Slack), `all` (Linear, GitHub).
   *
   * Probed: Slack flattens a code block, a second paragraph or a quote into the item's text and
   * renders each correctly once written after the item; nested lists render inside it. Linear,
   * read back through `bodyData`, keeps every block inside its item. GitHub renders CommonMark's
   * reading, checked against `POST /markdown`. Not derived from `mode`: Slack receives the markdown
   * and still flattens those blocks.
   */
  readonly listItemBlocks: ItemBlocks;
  /**
   * Whether `<url|label>` reads as a link showing its label, characters as written. Slack does
   * (probed, at `slackProfile.angleLinkLabels`); the others are unprobed and keep the span as text.
   * Where true, the editor holds it as a link and the writer spells it back as `<url|label>`
   * (`writeAngleLink`).
   */
  readonly angleLinkLabels: boolean;
  /**
   * What names one target here (`TargetIdentity`). Required even when it requires nothing: an
   * absent one would read as "nothing is needed", which lets a Jira target match production.
   */
  readonly targetIdentity: TargetIdentity;
  /**
   * Fields that carry a delta against content only the destination holds. Linear's `patch` is the
   * only case: per the live `save_issue` schema, up to 50 edit operations applied server-side, "in
   * place of the full content/description field". draftgate never calls a destination, so it
   * cannot read what they apply to, and there is nothing to render, warn about or edit.
   *
   * A list of spellings, which `cli/src/payload.ts` reads rather than keeping a second copy of the
   * word `patch`. An absent declaration would read as "no delta here" and send unreviewed.
   */
  readonly deltaFields: readonly string[];
  /**
   * Every value a reviewer may answer this destination's question with, and nothing else; what
   * `ownAnswerFor` checks for `audienceFor` and `parseWireDecision`. `[]` for Slack and Linear,
   * which have one audience each. Per destination, because a merged list could only say that
   * somebody, somewhere, could have been offered the string.
   *
   * The answer vocabulary, not the config one. `JIRA_PROJECT_TYPES` is Atlassian's four, what
   * `jira-projects.json` may hold; a Jira reviewer is asked a binary (service desk, or internal
   * only), so the wire refuses values no renderer can produce. `Audience.ask.options` is written
   * out per profile for its labels; `core/test/audience.test.ts` holds the two sets equal.
   */
  readonly reviewerAnswers: readonly string[];
  /**
   * How long a body may be before this destination refuses the call, as probed (see
   * `core/src/lengthLimit.ts` for the bracket and the unit). Applied by the profile's own
   * `convert()`, because only it knows what is counted: the string it sends, or for Jira a lower
   * bound on a representation that is not the ADF it sends (`jiraLengthLowerBound`).
   *
   * Probed on each destination's comment (Slack: message) tool and applied to every markdown body
   * routed here. A route field with a higher limit would be blocked wrongly; none is known.
   */
  readonly bodyLimit: LengthLimit;
  /**
   * Limits on a single-line prose field, keyed by the field path the route declares (`title`), each
   * naming the tools it was probed on (`LineLimit.tools`). Read by `proseWarnings`. Only fields a
   * probe measured: Jira's `fields.summary` has none because nobody probed its length.
   */
  readonly lineLimits: Readonly<Record<string, LineLimit>>;
  /**
   * What this destination does with a CR or LF in a single-line prose field, keyed and scoped like
   * `lineLimits` (`LineBreakFact.tools`). Read by `proseWarnings`: `refused` is an `error`,
   * anything else -- an absent field included -- a `warning`.
   */
  readonly lineBreaks: Readonly<Record<string, LineBreakFact>>;
  convert(markdown: string): { converted: unknown; warnings: Warning[] };
  /**
   * The one-click remedy for a blocked draft, or `null` for nothing to offer. A bare string is a
   * body `render()` names for you; a `Fix` is used as given.
   */
  suggestFix?(converted: unknown, markdown: string): string | Fix | null;
  /** Who receives this message, when the destination has more than one possible answer. */
  audienceFor?(context: Record<string, unknown>, facts: AudienceFacts): Audience | undefined;
  /**
   * Whether `audienceFor`'s evidence covers this tool, as opposed to this target: a probe, which
   * no config supplies and no reviewer answers. A profile with `audienceFor` should declare it, so
   * `--doctor` can report gated tools whose reviews will always say `Audience unknown`.
   */
  audienceProbed?(tool: string): boolean;
  /** Where it is going, in words a human recognises. */
  destinationLabel?(context: Record<string, unknown>, facts: AudienceFacts): string | undefined;
}


/**
 * What an audience decision needs that the payload does not carry: the facts of the two
 * destinations that have one, composed here in the registry. Each shape stays in its profile
 * because its keying is a destination claim: a Jira row by cloud id (a project key is unique only
 * within a site), a GitHub row by `owner/repo` (globally unique).
 *
 * `classified` is one field that names its destination: one review has one answer
 * (`classifyProject` on the decision), and `audienceFor` drops an answer about another destination
 * before any profile sees it. Without that, a GitHub value reaching `jiraAudience` would fall
 * through its `!== 'service_desk'` test and suppress the audience banner.
 */
export interface AudienceFacts extends JiraAudienceFacts, GitHubAudienceFacts {
  classified?: TargetAnswer;
  /**
   * The tool being gated, when the caller knows it; common to every destination's answer. Jira's
   * comment probes were run against `addCommentToJiraIssue` while `addWorklogToJiraIssue` routes to
   * the same profile, so without it a worklog on a service-desk project would claim "Reply to
   * customer -- the reporter sees this in the portal", every clause of which probe J
   * (`profiles/jira.ts`) shows false. GitHub uses it to refuse a claim made about seven tools for
   * an eighth.
   */
  toolName?: string;
  /** `toolName` was routed by inference, not by a map entry. See `AudienceAnswer.routeInferred`. */
  routeInferred?: boolean;
}

export const profiles = {
  jira: jiraProfile,
  slack: slackProfile,
  linear: linearProfile,
  github: githubProfile,
} as const;

export type DestinationName = keyof typeof profiles;

/**
 * `Object.hasOwn`, not `in`: `'toString' in profiles` (and `'constructor'`, `'valueOf'`,
 * `'__proto__'`) is true, so `--dest toString` would pass, narrow to `DestinationName` and index
 * `profiles` to a Function -- the crash `adapters/hook/src/decide.ts` guards against one layer up.
 * Pinned in `core/test/render.test.ts`, so the `in` mutant fails the suite.
 */
export function isKnownDestination(name: string): name is DestinationName {
  return Object.hasOwn(profiles, name);
}

/**
 * Who receives this message, if the destination has more than one possible answer.
 * Destination-blind: it asks the profile and hands over the operator's facts. In `core` because the
 * renderer needs it too: the window recomputes the audience the moment a reviewer classifies a
 * project.
 *
 * `undefined` when the destination has one audience (Slack, Linear) or the question does not arise
 * (a Jira software project); not the same as `kind: 'unknown'`, a missing fact with a banner.
 */
export function audienceFor(
  destination: DestinationName,
  context: Record<string, unknown>,
  facts: AudienceFacts = {}
): Audience | undefined {
  const profile: DestinationProfile = profiles[destination];
  return profile.audienceFor?.(context, withOwnAnswer(destination, facts));
}

/**
 * The runtime check that makes every profile's narrow `classified` true. `AudienceFacts.classified`
 * is wide (what the wire carries); each profile declares the narrow shape
 * (`AudienceAnswer<'jira', JiraProjectType>`), licensed by method bivariance. This is the only
 * layer holding both the destination and the answer.
 *
 * A foreign answer is dropped, not refused: the config lookup and the question remain, and
 * refusing would withdraw a human's decision over metadata (the asymmetry `parseAppliedFixes`
 * documents). Covers a value from another destination's vocabulary and one from no vocabulary (a
 * renderer whose options drifted from its profile).
 */
function withOwnAnswer(destination: DestinationName, facts: AudienceFacts): AudienceFacts {
  if (facts.classified === undefined) return facts;
  if (ownAnswerFor(destination, facts.classified) !== undefined) return facts;
  // The key removed, not set to `undefined`: a `classified: undefined` spread again would out-rank
  // a real answer beneath it.
  const { classified: _dropped, ...rest } = facts;
  return rest;
}

/**
 * "Is this answer about this destination, in a vocabulary it offers?" -- the one spelling of the
 * question three layers ask: `parseWireDecision` (the off-disk trust boundary), `cli/src/review.ts`
 * (the destination under review) and `audienceFor` (the renderer's in-process path, where no wire
 * parser runs). Asked different ways, the banner can revert to asking while the store prints
 * "ignored the answer".
 *
 * Returns the answer narrowed to the destination, or `undefined`. The destination check catches
 * another vocabulary (they do not overlap); only the value check catches a value from none.
 */
export function ownAnswerFor(
  destination: DestinationName,
  answer: TargetAnswer | undefined
): TargetAnswer<DestinationName> | undefined {
  if (answer === undefined || answer.destination !== destination) return undefined;
  // Widened: `includes` on each profile's own union array refuses an arbitrary string.
  const offered: readonly string[] = profiles[destination].reviewerAnswers;
  return offered.includes(answer.value) ? { destination, value: answer.value } : undefined;
}

/**
 * Has this destination's audience rule been probed against this tool? Destination-blind, like the
 * other two dispatchers.
 *
 * `true` for a profile that declares nothing: Slack and Linear have one audience and no
 * `audienceFor`, so there is no evidence to be missing. "Probed" is not "has a banner": a Jira
 * worklog's evidence is that it has no audience.
 */
export function toolAudienceProbed(destination: DestinationName, tool: string): boolean {
  const profile: DestinationProfile = profiles[destination];
  return profile.audienceProbed?.(tool) ?? true;
}

/**
 * Where this is going, in words a human recognises, or `undefined` for nothing composable;
 * dispatched like `audienceFor`. Jira and GitHub answer. Slack's `channel_id` and Linear's
 * `issueId` cannot be resolved to a name without a network call draftgate does not make, so the
 * surface falls back to the raw routing fields.
 */
export function destinationLabelFor(
  destination: DestinationName,
  context: Record<string, unknown>,
  facts: AudienceFacts = {}
): string | undefined {
  const profile: DestinationProfile = profiles[destination];
  return profile.destinationLabel?.(context, facts);
}


