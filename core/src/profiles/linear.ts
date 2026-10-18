/**
 * Linear destination profile: the simplest destination, verified against a scratch Linear issue.
 * The torture fixture was sent as raw markdown through `mcp__claude_ai_Linear__save_comment` and
 * read back through `list_comments` and directly via the GraphQL API.
 *
 * Linear stores the markdown byte-identically, but for a trailing newline, which it trims.
 * Everything survives:
 *
 *   headings, GFM tables (pipes intact), ordered lists with correct numbering, nested bullet
 *   lists, `- [ ]` / `- [x]` task state, blockquotes, fenced code *including its language*,
 *   horizontal rules, bare URLs, image syntax, and every inline mark.
 *
 * Underscores render as CommonMark reads them: `_x_` italic, `__x__` bold, `___x___` both, and an
 * underscore inside a word text (probed: ten lines through a gated `save_comment` on a scratch
 * issue, read off a screenshot).
 *
 * So there is no conversion and no rendering warning; `core/test/linear.test.ts`'s golden test
 * catches a change. The one code, `linear/body-too-long`, is a refusal: past 100,000 characters
 * the call is `INVALID_INPUT` (probed).
 */

import { type Warning } from '../warnings';
import { lengthWarnings } from '../lengthLimit';

import type { DestinationProfile } from './index';
import type { MentionTokenPattern } from '../mentionTokens';

/**
 * Linear's user mention, `@displayName`. Verified with a screenshot: Linear resolves this and
 * `@[name](uuid)`, both rendering as real mentions; only this one is matched.
 *
 * `@slug` cannot be told from prose, so `@todo` in a sentence is marked as a mention Linear will
 * not resolve. Accepted for visual coherence because the mark is Linear's own typography (weight
 * 500, no ground, no colour change), so an over-mark reads as slightly bold prose rather than a
 * chip promising a ping; Linear's `@` is a mention trigger (its editor docs list users, issues,
 * projects, dates and documents); and the `advice` says draftgate cannot verify the name.
 *
 * Dots are matched only between segments, so `@ada.lovelace.` keeps its full stop out. The
 * lookbehind rejects a word character (`someone@example.com`), another `@` (`@@x`), `<` (inside
 * Slack's `<@U0123ABCDEF>`, held by the test that each destination's patterns are its own) and `/`
 * (`.../blob/main/@types/x.ts`). The lookahead rejects `/` after the name (`install @scope/pkg`),
 * and `\w` and `-` too: without them the greedy name backtracks, so `@types/x.ts` would retry as
 * `@type` and match, the `s` satisfying a bare `(?!\/)`.
 */
const LINEAR_TOKENS: readonly MentionTokenPattern[] = [
  { re: /(?<![\w@<\/])@[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?![\w\-\/])/, kind: 'user' },
];

/**
 * A link to a Linear profile, which Linear turns into a mention of that user. Probed on a scratch
 * issue, a comment body sent through Linear's API as written: both
 * `[Label](https://linear.app/<workspace>/profiles/<slug>)` and the bare URL are stored as a
 * user-mention node carrying the user's id, and the client draws both as `@` and the user's display
 * name, not the label. So the person is notified.
 *
 * The capture group is the slug, the one name the window can show without inventing it
 * (`mentionLinkName`). Any workspace, matched on shape: the probe used one. A trailing slash, a
 * query or a further path segment is unprobed and not matched.
 */
const LINEAR_PROFILE_LINK = /^https:\/\/linear\.app\/[a-zA-Z0-9._-]+\/profiles\/([a-zA-Z0-9._-]+)$/;

/** The tool both of this profile's probed title facts (length, line breaks) were measured on. */
const SAVE_ISSUE = /(?:^|__)save_issue$/;

export const linearProfile = {
  name: 'linear' as const,
  displayName: 'Linear',
  /**
   * `save_comment.body` is documented as "Content as Markdown", and the converted output is the
   * canonical markdown, so substituting would change nothing. Linear exposes a structured
   * `bodyData` (its ProseMirror document) on reads, but the write-side `descriptionData` is marked
   * [Internal] and rejects external API keys.
   */
  mode: 'preview-only' as const,
  extraToolInput: {} as const,
  /**
   * Structure needs no prediction (the markdown is stored byte-identically); only typography and
   * spacing are uncertain. The heading sizes, line-heights, weights, spacings and radii in
   * `surface/src/styles/linear.css` are read from the public application stylesheet,
   * `static.linear.app/client/assets/style-<hash>.css` (linked `id=app-stylesheet` off the login
   * page, no session needed). A comment's headings carry `.heading-node`, semibold, not the medium
   * of Linear's bare `h1..h6` rule.
   *
   * That sheet supplies no colour: it declares no `[data-theme]` block (`themes: []` in
   * `tools/linear-tokens/tokens.json`), and every colour token is registered `initial` (literally
   * `--color-text-primary: initial`) because Linear uses StyleX and fills the values from
   * JavaScript at run time. So the palettes come from the marketing site (`tools/linear-tokens/`):
   * vendor-authored, not measured off the surface a comment renders on, hence `indicative`.
   * `bodyData` exposes Linear's real ProseMirror schema on reads, so it could be measured as Jira
   * is.
   */
  previewFidelity: 'indicative' as const,
  /**
   * Both: the palette is generated from Linear's marketing-site stylesheets
   * (`tools/linear-tokens/`), and light and dark are halves of that one source, so the dark column
   * is no worse a claim than the light. See `previewFidelity` and `surface/src/styles/linear.css`.
   */
  themes: ['light', 'dark'] as const,
  /**
   * Everything: `convert()` is the identity function and Linear stores the markdown
   * byte-identically. Verified against a scratch issue with the torture fixture: all six heading
   * levels, tables, task lists, nested lists, a fenced block and a rule.
   */
  toolbar: {
    headingLevels: [1, 2, 3, 4, 5, 6],
    marks: ['bold', 'italic', 'strike', 'code', 'link'],
    blocks: ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'rule'],
    /* Emoji is Unicode and reaches Linear byte-identically. */
    inserts: ['emoji'],
  } as const,

  /**
   * `tokens`: a bare `@displayName`, matched on shape (`LINEAR_TOKENS` has the trade). The caveat
   * is the opposite of Slack's: the name is readable but unverifiable, so the risk is a name that
   * looks like a mention and resolves to nobody.
   *
   * `chips: null`: Linear resolves `@displayName` from text; a `mention:` link would ship as
   * literal characters.
   *
   * `links`: a link to a profile, labelled or bare (`LINEAR_PROFILE_LINK`), sent as the link it is;
   * the window draws it in the mention's typography and the strip counts it. Linear draws the
   * person's display name in place of whatever the link says, and draftgate cannot look it up.
   */
  mentions: {
    tokens: {
      patterns: LINEAR_TOKENS,
      advice:
        'draftgate cannot check whether a name is a real Linear user -- it holds no Linear credentials ' +
        '-- so this is marked on the shape of the text alone. Linear notifies a name it recognises and ' +
        'sends one it does not as plain text.',
    },
    chips: null,
    links: {
      href: LINEAR_PROFILE_LINK,
      advice:
        'A link to a Linear profile notifies that person: Linear replaces it with @ and their ' +
        'display name, whatever the link says. draftgate cannot look the name up, so it shows the ' +
        "link's text, or the name in the address.",
    },
  },

  /**
   * The editor passes `inlineMedia` whenever placement is not `block` (`MediaPlacement`), so the
   * round trip is a fixed point: `core/test/editor.test.ts` ("an inline image does not split the
   * sentence around it").
   */
  mediaPlacement: 'inline' as const,
  // Linear draws the picture, inline, where the agent wrote it.
  rendersMedia: true,
  // Linear stores the markdown byte-identically, so `**`code` and words**` arrives as the agent
  // wrote it. See `CodeSpanMarks`.
  codeSpanMarks: 'any',
  listItemBlocks: 'all',
  // Not probed here, so the converter keeps `<url|label>` as the text it was written as.
  angleLinkLabels: false,
  // One id names one issue, and Linear's are case-sensitive. Nothing to require and nothing to fold.
  targetIdentity: { requiredFields: [], caseFolded: [] },
  /**
   * `patch` is `save_issue`, `save_project`, `save_initiative`, `save_document` and
   * `save_release_note`'s alternative to `description` / `content`, valid only on update (a create
   * carries the whole content and is reviewed normally). Of these only `save_issue` is gated, and
   * `cli/src/payload.ts` refuses a payload carrying `patch` before the body is read.
   * `save_comment`, `save_status_update`, `save_diff_comment` and `save_customer_need` carry no
   * `patch` (read against the live schemas).
   */
  deltaFields: ['patch'],

  // One audience, so nothing to ask: `audienceFor` is absent and `cli/src/classificationStores.ts`
  // has no row for Linear.
  reviewerAnswers: [],

  bodyField: 'body',
  /**
   * `save_comment` accepts exactly one of six mutually exclusive parents, plus `parentId` for
   * replies and `id` for updates. Listing only `issueId` would silently fail to show routing for
   * the other five.
   */
  contextFields: [
    'issueId',
    'projectId',
    'initiativeId',
    'documentId',
    'milestoneId',
    'statusUpdateId',
    'parentId',
    'id',
  ],

  /**
   * PROBED through GraphQL: a comment body over 100,000 characters is `INVALID_INPUT` (`body must
   * be shorter than or equal to 100000 characters`), and an issue title over 512 is the same
   * refusal. Both lose the whole call.
   */
  bodyLimit: { accepted: 100_000, refused: 100_001, unit: 'characters' },
  // Probed through GraphQL's `issueUpdate`, which is what `save_issue` writes.
  lineLimits: { title: { accepted: 512, refused: 513, unit: 'characters', tools: SAVE_ISSUE } },
  // PROBED on an issue `title` (GraphQL): LF is stored as a SPACE, CR verbatim.
  lineBreaks: { title: { lf: 'space', cr: 'stored', tools: SAVE_ISSUE } },

  convert(markdown: string): { converted: string; warnings: Warning[] } {
    // The identity function: the canonical markdown is what Linear stores and renders. Its one
    // warning is the length limit, a refusal rather than a rendering difference.
    return {
      converted: markdown,
      warnings: lengthWarnings({
          code: 'linear/body-too-long',
          subject: 'This draft',
          value: markdown,
          limit: linearProfile.bodyLimit,
          refuses: 'Linear refuses a comment',
        }),
    };
  },
} satisfies DestinationProfile;
