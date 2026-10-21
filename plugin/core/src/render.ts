/**
 * `render(body, destination) -> { converted, warnings }`: the whole of `core`. Nothing in this file
 * or below it may import a network client, read a file, or touch a clock.
 */

import { LABELLED_ANGLE_LINK_START_SOURCE } from './linkDestination';
import {
  profiles,
  isKnownDestination,
  type DestinationName,
  type DestinationProfile,
  type MediaPlacement,
  type Mode,
  type PreviewFidelity,
  type SupportedThemes,
  type Theme,
  type ToolbarSupport,
} from './profiles';
import {
  sortWarnings,
  hasBlockingWarning,
  isBlocking,
  isLengthRefusal,
  warn,
  SUGGESTED_FIX_CODE,
  SUGGESTED_FIX_LABEL,
  type Fix,
  type Warning,
} from './warnings';
import { MENTION_SCHEME } from './mentions';
import { lengthWarnings } from './lengthLimit';
import { lineCharacterWarnings } from './lineCharacters';
import {
  editorOptionsFor,
  lostInMarkdown,
  lostMarks,
  lostText,
  markdownToAdfFor,
  type LostMarks,
  type LostNode,
  type LostText,
} from './editor';
import { misleadingLinks } from './linkHosts';
import { adfToProseMirror, type PmNode } from './prosemirror';
import type { AdfDocument } from './adf/types';
import { linkLabelStart } from './markdown';
import { JIRA_ATTACHMENT_SCHEME } from './adf/util';
import { NO_MENTIONS, type MentionSupport } from './mentionTokens';
import type { CodeSpanMarks } from './profiles/index';
import type { ItemBlocks } from './adf/markdownToAdf';


/**
 * The one rule that needs no destination knowledge: a blank body is nothing to post anywhere, so
 * `render()` checks it rather than each profile, and it sets `blocked`, which disables Approve. A
 * guard in `runReview` would deny only after the window closed as though it had sent.
 * Select-all-delete is one keystroke, which makes this the gate's most reachable refusal.
 */
const EMPTY_BODY = warn({
  code: 'body/empty',
  severity: 'error',
  message: 'The body is empty, so there is nothing to send.',
});

/**
 * The other fields the agent wrote, checked for emptiness, unseen characters and length. A second
 * pure producer, since `render()` sees only the body; the window merges its output into its list
 * and into `blocked`.
 *
 * `prose/empty` blocks. PROBED against a scratch issue:
 *
 *     PUT /rest/api/3/issue/{key}  {"fields":{"summary":""}}
 *       -> 400 {"errors":{"summary":"You must specify a summary of the issue."}}
 *     ... and `"   "` -> the same 400, with nothing written either time.
 *
 * The whole call is rejected, the body the reviewer read included. Jira trims first, hence
 * `isBlankBody` rather than `=== ''`; `"   "` also draws a box that looks empty with no placeholder
 * behind it. Destination-agnostic for `body/empty`'s reason: a field set to nothing is nothing to
 * send. An absent field never reaches here: `extractProse` omits it, since leaving a title alone is
 * not blanking it.
 */
export function proseWarnings(
  prose: readonly { field: string; value: string }[],
  destination: DestinationName,
  toolName?: string
): Warning[] {
  const limits: DestinationProfile['lineLimits'] = profiles[destination].lineLimits;
  return prose.flatMap((p) => {
    if (isBlankBody(p.value)) {
      return [
        warn({
          code: 'prose/empty',
          severity: 'error',
          // See `Warning.field`.
          field: p.field,
          message: `${p.field} is empty, so approving would send it blank.`,
        }),
      ];
    }
    // What the input cannot show: a line break it strips, a control that draws nothing. Before the
    // length, because it is about what the reviewer read at all.
    const breaks: DestinationProfile['lineBreaks'] = profiles[destination].lineBreaks;
    const unseen = lineCharacterWarnings(
      p.field, p.value, Object.hasOwn(breaks, p.field) ? breaks[p.field] : undefined, toolName
    );
    // Only on a tool the limit was probed on: an unnamed tool, or another tool with a field of the
    // same name, gets no claim (`LineLimit.tools`).
    const limit = Object.hasOwn(limits, p.field) ? limits[p.field] : undefined;
    const probed = limit !== undefined && toolName !== undefined && limit.tools.test(toolName);
    // `error` past a probed refusal (the whole call is refused), a `warning` inside an unresolved
    // bracket (GitHub's title, accepted at 1,024 and refused at 4,096): blocking there asserts a cutoff.
    const long = !probed ? [] : lengthWarnings({
      code: 'prose/too-long',
      subject: p.field,
      value: p.value,
      limit,
      refuses: 'this destination refuses a title',
      field: p.field,
    });
    return [...unseen, ...long];
  });
}

/**
 * Characters that occupy no space, so a body made only of them has nothing in it. `trim()` strips
 * White_Space, and a zero-width character is a format character: `'\u200b'.trim()` is `'\u200b'`
 * (`U+FEFF` it strips, as JavaScript treats the BOM as whitespace). PROBED against a scratch issue:
 * a comment of one zero-width space is accepted, **HTTP 201**, stored verbatim, and the reader gets
 * a blank comment. Stripped only for the emptiness test, never from the body: `U+200D` matters
 * inside emoji sequences (👨‍👩‍👧 is three people joined by two of them), so removing it
 * from the text would corrupt real content.
 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Is there anything in this body a reader would see? Whitespace and zero-width both count as no. */
export function isBlankBody(body: string): boolean {
  return body.replace(ZERO_WIDTH_RE, '').trim() === '';
}

/*
 * Anchored on `](` and sticky: the label is found by `linkLabelStart`, since `\[[^\]]*\]` is
 * quadratic in unclosed `[` (1.7 s on 100 KB of them). `<?` and its whitespace because `<url>` is
 * CommonMark's destination syntax: without them `[x](<javascript:alert(1)>)` gets no warning while
 * `[x](javascript:alert(1))` does. A backslash may escape `+`, `.`, `-` or the scheme's `:`, which
 * the converter resolves (`[x](javascript\:alert(1))` is a `javascript:` link). Wider than the
 * converter on purpose: Slack and Linear parse the markdown themselves, and a false match costs
 * only a `warning`.
 */
const UNSAFE_SCHEME_RE = /\]\(\s*<?\s*([a-z](?:[a-z0-9]|\\?[+.-])*\\?:)/iy;

/**
 * Ordinary message-link schemes, plus the two the pipeline produces: `mention:` (`mentions.ts`) and
 * `jira-attachment:`, an already-uploaded Jira asset (`adf/util.ts`). The `images.md` golden catches
 * the check firing on its own output.
 */
const SAFE_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  MENTION_SCHEME,
  JIRA_ATTACHMENT_SCHEME,
]);

/**
 * Link and image targets whose scheme is not http, https or mailto. At the gate, not only at the
 * link field: `surface/src/href.ts` allowlists what the reviewer types, but the agent's
 * `[click here](javascript:alert(1))` would otherwise pass `render()`, show as an ordinary link and
 * go out verbatim, and the terminal and auto-approve surfaces never load `href.ts`. Destination-
 * agnostic, like `body/empty`. A `warning`: no destination has been probed for what it does with an
 * unsafe URL (most likely they sanitise it), and `error` needs evidence (see `warnings.ts`).
 */
function unsafeHrefs(markdown: string): Warning[] {
  const seen = new Set<string>();
  for (let i = markdown.indexOf(']('); i !== -1; i = markdown.indexOf('](', i + 1)) {
    if (linkLabelStart(markdown, i) === -1) continue;
    UNSAFE_SCHEME_RE.lastIndex = i;
    const m = UNSAFE_SCHEME_RE.exec(markdown);
    if (!m) continue;
    const scheme = m[1]!.replace(/\\/g, '').toLowerCase();
    if (!SAFE_SCHEMES.has(scheme)) seen.add(scheme);
  }
  return [...seen].map((scheme) =>
    warn({
      code: 'link/unsafe-href',
      severity: 'warning',
      message:
        `A link or image in this draft points at a "${scheme}" address. Only http, https and ` +
        `mailto are ordinary message links -- most destinations strip anything else, so it will ` +
        `most likely render as dead text, and it is worth checking why the draft contains one.`,
    })
  );
}

/** Where a `<url|label>` could begin: a table's or a sentence's `|` alone asks for no parse. */
const LABELLED_LINK_START = new RegExp(LABELLED_ANGLE_LINK_START_SOURCE);

/**
 * Links whose text names another host than the one they open (`linkHosts.ts`). Read off the tree
 * the editor builds for this destination, so check and window agree on what a link is, Slack's
 * image-as-link included. `render()` passes `undefined` for a body with no `](` (nor, where the
 * destination reads `<url|label>`, the start of one), which cannot mislead: an autolink and a bare
 * URL are their own label. One warning per distinct link, naming both hosts and the full target,
 * since an elided target is how a look-alike gets through (`deferredImage.ts`). Unlike
 * `unsafeHrefs`, which reads wider than the converter, this names the host the reader sees.
 */
function mismatchedLinkHosts(tree: AdfDocument | undefined): Warning[] {
  if (!tree) return [];
  return misleadingLinks(tree).map((l) =>
    warn({
      code: 'link/text-host-mismatch',
      severity: 'warning',
      message:
        `A link reads as ${l.labelHost} but opens ${l.hrefHost}: "${l.label}" goes to ${l.href}. ` +
        `The reader sees the text, so check the address is the one you mean to send.`,
    })
  );
}

export interface RenderResult {
  destination: DestinationName;
  /** Whether the caller may substitute `converted` into the outbound tool input. */
  mode: Mode;
  /** The markdown as given. The single source of truth. */
  canonical: string;
  /** ADF document for Jira; a string for preview-only destinations. */
  converted: unknown;
  /**
   * Was this body markdown, plain text, or absent? The discriminator (`previewFidelity` is about the
   * stylesheet). Consumers read payload facts off this object, never off `profiles[destination]`:
   * for a plain body `mode` and `extraToolInput` differ from the profile, and reading the profile
   * would JSON-stringify a Jira plain body and stamp it `contentFormat: "adf"`. Only a test
   * asserting the payload can see that.
   */
  format: 'markdown' | 'plain' | 'absent';
  /**
   * How far the preview's styling can be trusted. Structure and warnings are verified against a
   * live instance for every destination; visual fidelity is not. Nothing displays this, at the
   * operator's request (asserted only by `core/test/render.test.ts`); it is the channel a profile
   * has for "this preview is approximate".
   */
  previewFidelity: PreviewFidelity;
  /**
   * Which themes this destination's preview can render, from the profile; the window intersects it
   * with the reviewer's system preference. See `SupportedThemes`.
   */
  themes: SupportedThemes;
  /**
   * What the editor's toolbar may offer, from the profile: membership, not layout. A claim about
   * what the destination renders, like `themes`.
   */
  toolbar: ToolbarSupport;
  /**
   * Every kind of mention this destination has and what to tell the reviewer about each, from the
   * profile (`MentionSupport`). Patterns, not matches: the window applies them to the live document
   * on every keystroke. Never crosses the wire: the window calls `render()` itself.
   */
  mentions: MentionSupport;
  /**
   * Whether the destination puts media in its own block, so the editor must show it hoisted. Read
   * through `editorDocFor`, not directly. See the profile field.
   */
  mediaPlacement: MediaPlacement;
  /** Whether an image is drawn as a picture here at all. See the profile field. */
  rendersMedia: boolean;
  /**
   * Whether emphasis may span a code span here (`CodeSpanMarks`). On the result, like
   * `mediaPlacement`, because the window builds its document from a `RenderResult`, not a profile.
   */
  codeSpanMarks: CodeSpanMarks;
  /** Which blocks a list item keeps here. See the profile field and `ItemBlocks`; on the result for `codeSpanMarks`' reason. */
  listItemBlocks: ItemBlocks;
  /** Whether `<url|label>` is a link here. See the profile field; on the result for `codeSpanMarks`' reason. */
  angleLinkLabels: boolean;
  /**
   * A repaired body the reviewer can accept in one click, present only when `blocked` and when the
   * profile offers one that changes something and unblocks the draft (`repairs`). A `Fix`, so it
   * names itself and the window composes no part of its identity, as with `Warning.fixes`.
   */
  suggestedFix?: Fix;
  /**
   * Extra tool-input fields the adapter must set alongside the body. For Jira this is
   * `{ contentFormat: 'adf' }` -- omitting it makes Jira render the ADF JSON as literal text.
   */
  extraToolInput: Record<string, unknown>;
  warnings: Warning[];
  /**
   * True when at least one warning is an `error`: the send will not deliver what was written,
   * whether the API rejects it or the send succeeds and content is lost (see `warnings.ts`).
   */
  blocked: boolean;
}

/**
 * Which theme the preview should use: an explicit request (config, or the probe forcing one), then
 * the reviewer's system preference, then light, clamped to what the destination `supports`. In
 * `core`, not the window, so it is testable without a browser engine.
 */
export function resolveTheme(
  supported: SupportedThemes,
  system: Theme | undefined,
  requested?: ThemeChoice
): Theme {
  const wanted = requested && requested !== 'system' ? requested : (system ?? 'light');
  return supported.includes(wanted) ? wanted : supported[0];
}

/**
 * Which theme choices may be offered for a destination, in cycle order, read from the same
 * `SupportedThemes` as `resolveTheme`'s clamp. Empty with fewer than two palettes, so no switcher
 * cycles through options it cannot render. `system` leads because following the OS is the default.
 */
export function themeChoices(supported: SupportedThemes): readonly ThemeChoice[] {
  if (supported.length < 2) return [];
  return ['system', ...supported];
}

/** A theme a reviewer can ask for: one of the two palettes, or following the OS. */
export type ThemeChoice = Theme | 'system';

/**
 * Every `ThemeChoice`, as a value. A `Record` over the union makes a missing or stray key a compile
 * error, so a theme added to `Theme` cannot be one `isThemeChoice` silently refuses.
 */
const THEME_CHOICES: Record<ThemeChoice, true> = { system: true, light: true, dark: true };

/**
 * Is `v` a `ThemeChoice`? For every place a choice arrives untyped: the window's storage, the
 * request, the decision the window writes, and the file the CLI keeps it in.
 */
export function isThemeChoice(v: unknown): v is ThemeChoice {
  return typeof v === 'string' && Object.hasOwn(THEME_CHOICES, v);
}

export class UnknownDestinationError extends Error {
  constructor(readonly destination: string) {
    super(
      `Unknown destination "${destination}". Known: ${Object.keys(profiles).join(', ')}.`
    );
    this.name = 'UnknownDestinationError';
  }
}

/**
 * The reviewer's own edit would not survive the trip out: an `error`, the "silent destruction" case
 * `warnings.ts` defines. Owned by `render()` for `body/empty`'s reason: markdown is every
 * destination's interchange, so what it cannot carry is broken everywhere. See `lostInMarkdown`.
 */
function structureLost(lost: LostNode[]): Warning {
  // At most three: a document losing more distinct shapes has one problem, and the sentence has to
  // stay readable at the top of a review window.
  const named = lost.slice(0, 3);
  const shapes =
    named.map((l) => `a <${l.type}> inside a <${l.parent}>`).join(', ') +
    (lost.length > named.length ? `, and ${lost.length - named.length} more` : '');
  return warn({
    code: 'body/structure-lost',
    severity: 'error',
    message:
      `This draft holds ${shapes}, which markdown cannot express -- so what would be sent is not ` +
      `what is on screen. The content would be flattened into the line around it or dropped. ` +
      `Undo the change, or move it out of the container it is in.`,
    // The first shape's location, for the surface to point at; `named[0]` is the outermost
    // occurrence, since `lostInMarkdown` walks the document in order.
    ...(named[0] ? { editorPath: named[0].path } : {}),
  });
}

/**
 * Formatting the reviewer applied that markdown cannot carry where it is (`lostMarks`). A `warning`:
 * the text arrives. It names no cause, since causes differ by mark (a mid-word strike against
 * punctuation does not flank; a code span has no flanking), and says "may" because the judge is
 * draftgate's own parser: that is what Jira receives, and GitHub probes agree for `a~~(b)~~c`, but
 * a destination that parses the markdown itself is not checked shape by shape.
 */
function marksLost({ types, editorPath }: LostMarks): Warning {
  // The toolbar's word for `strike` (`surface/src/controls.tsx`); the others are named as they are.
  const names = types.map((t) => (t === 'strike' ? 'strikethrough' : t)).join(', ');
  return warn({
    code: 'body/mark-lost',
    severity: 'warning',
    message:
      `Some ${names} formatting on screen may not survive the send: read back from the markdown ` +
      `this draft becomes, it is gone, so the reader may see the marker characters instead. ` +
      `Check the text around it, or remove the formatting.`,
    ...(editorPath ? { editorPath } : {}),
  });
}

/**
 * Text on screen that would not arrive as text (`lostText`): a `#` becomes a heading, a `-` a
 * bullet, two `*` bold. A `warning`: a backstop over the writer's escaping, not a probed loss, run on
 * drafts the reviewer has not touched, which may render as shown where a destination's parser
 * differs from draftgate's. Suppressed when either sibling fires: a lost mark or node changes the
 * text too.
 */
function textChanged({ editorPath }: LostText): Warning {
  return warn({
    code: 'body/text-changed',
    severity: 'warning',
    message:
      `Some text on screen may not arrive as written: read back from the markdown this draft ` +
      `becomes, its characters differ -- a marker at the start of a line can turn it into a ` +
      `heading, list or quote, and paired markers into formatting. Check the text around it.`,
    ...(editorPath ? { editorPath } : {}),
  });
}

/**
 * Every warning a body earns for a destination: the profile's, plus `render`'s own. Shared with
 * `repairs`, so a repair is judged by the rule that will judge it a moment later.
 */
function allWarnings(
  body: string,
  profileWarnings: Warning[],
  lost: LostNode[] = [],
  lostFormatting?: LostMarks,
  lostCharacters?: LostText
): Warning[] {
  return sortWarnings([
    ...(isBlankBody(body) ? [EMPTY_BODY] : []),
    ...(lost.length > 0 ? [structureLost(lost)] : []),
    ...(lostFormatting ? [marksLost(lostFormatting)] : []),
    ...(lostCharacters ? [textChanged(lostCharacters)] : []),
    ...unsafeHrefs(body),
    ...profileWarnings,
  ]);
}

/**
 * Does this repaired body come back unblocked? A `suggestedFix` promises a sendable draft; without
 * this, three shapes reproduced against the Jira profile are offered that stay blocked:
 *
 *   `- [ ]` alone                       repaired to the EMPTY STRING -- the reviewer clicks a
 *                                       remedy and gets a blank draft, blocked on `body/empty`
 *   `> - [ ] a\n>\n> # tail`             the heading is repaired, the task list is not: still
 *                                       `jira/blockquote-child-rejected`
 *   `> - [ ] `                          repaired to `">"`, blocked on `jira/empty-body`
 *
 * Each would leave a draft the reviewer did not write and no way forward, so no button is offered
 * (as `suggestFix` promises). Not `render(body, destination)`, which would recompute a suggestion
 * and recurse through still-blocked repairs: one extra `convert` per blocked draft. `Warning.fixes`
 * entries are not held to this: each remedies one warning, most of them not errors.
 */
function repairs(profile: DestinationProfile, candidate: string): boolean {
  try {
    const { warnings } = profile.convert(candidate);
    return !hasBlockingWarning(allWarnings(candidate, warnings));
  } catch {
    // A repair that cannot even be converted is certainly not offerable.
    return false;
  }
}

/**
 * What a result with no editor says about its toolbar (its mentions are `NO_MENTIONS`): no button
 * could apply formatting. One literal for `renderPlain` and `renderNoBody`.
 */
const NO_TOOLBAR: RenderResult['toolbar'] = { headingLevels: [], marks: [], blocks: [], inserts: [] };

/**
 * A body that is text, not markdown: a field the destination stores verbatim, like Linear's
 * `Release.description` and `Release.name`, plain `String` columns with no document state, unlike
 * `Issue.description`, which has `descriptionState` (probed). Every markdown behaviour would offer
 * what the destination will not honour, so: no conversion (`converted` is the body; `**bold**`
 * stays nine characters), no toolbar (an empty `ToolbarSupport`, not a flag), no warnings taxonomy
 * or repairs, no mentions, no media. Only `body/empty` survives: it reads the body, not a
 * conversion. A tool whose body is optional says so with `bodyOptional`, settled before a review.
 */
export function renderPlain(body: string, destination: string): RenderResult {
  if (!isKnownDestination(destination)) throw new UnknownDestinationError(destination);
  const profile: DestinationProfile = profiles[destination];
  // The rule, stated, not `allWarnings` filtered: a filter names a code, so a rule added there later
  // would be dropped here silently. `unsafeHrefs` is absent because a field stored verbatim renders
  // no links: a `javascript:` URL there is literal text.
  const warnings = isBlankBody(body) ? [EMPTY_BODY] : [];
  return {
    destination,
    // `preview-only` whatever the profile says: the payload carries this body verbatim. Otherwise a
    // `convert-and-replace` destination would make `wireBody` stringify it into a JSON document.
    mode: 'preview-only',
    canonical: body,
    converted: body,
    format: 'plain',
    // `indicative`: the field is about the stylesheet, and a plain body is drawn in the window's own
    // monospace, not the destination's face.
    previewFidelity: 'indicative',
    themes: profile.themes,
    toolbar: NO_TOOLBAR,
    mentions: NO_MENTIONS,
    mediaPlacement: profile.mediaPlacement,
    rendersMedia: false,
    // The profile's own, unlike the two above (a plain body has no media or conversion): a markdown
    // document built for this destination would still follow them.
    codeSpanMarks: profile.codeSpanMarks,
    listItemBlocks: profile.listItemBlocks,
    angleLinkLabels: profile.angleLinkLabels,
    // Not the profile's: `contentFormat: "adf"` announces a converted document, and there is none.
    extraToolInput: {},
    warnings,
    blocked: hasBlockingWarning(warnings),
  };
}

/** Does this render describe a plain body? `format` says so (see `RenderResult.format`). */
export function isPlainBody(result: Pick<RenderResult, 'format'>): boolean {
  return result.format === 'plain';
}

/**
 * The review that has no body: the route names a body field and this payload carries none
 * (`issue_write` with a `title` and no `body`). The title still reaches a human audience, the
 * internet on a public repository; without this the call would take the schema-drift hatch unread.
 * A third sibling of `render` and `renderPlain`, so each `RenderResult` is true of what it
 * describes: no conversion, no editor, no warnings. `body/empty` does not fire: that means a
 * reviewer deleted the message, and this is a call the tool's schema allows. `canonical` is `''`
 * only because the type says `string`, and nothing may send it (a `prose/empty`-shaped 400 setting
 * a field the agent left alone): `surface/src/App.tsx` sends no `body`, and `cli/src/review.ts`
 * refuses a decision carrying one and passes `buildUpdatedInput` none.
 */
export function renderNoBody(destination: string): RenderResult {
  if (!isKnownDestination(destination)) throw new UnknownDestinationError(destination);
  const profile: DestinationProfile = profiles[destination];
  return {
    destination,
    // `preview-only`, so `wireBody` cannot JSON-stringify the empty `converted` below into a
    // document; nothing reads it.
    mode: 'preview-only',
    canonical: '',
    converted: '',
    format: 'absent',
    // No body preview to be faithful about; `indicative` is the weaker claim.
    previewFidelity: 'indicative',
    // The profile's own: the window still draws this review in the destination's ground, because
    // the prose fields beside the missing body are going to that destination.
    themes: profile.themes,
    toolbar: NO_TOOLBAR,
    mentions: NO_MENTIONS,
    mediaPlacement: profile.mediaPlacement,
    rendersMedia: false,
    codeSpanMarks: profile.codeSpanMarks,
    listItemBlocks: profile.listItemBlocks,
    angleLinkLabels: profile.angleLinkLabels,
    // Not the profile's: `contentFormat: "adf"` announces a converted document, and there is no body.
    extraToolInput: {},
    warnings: [],
    blocked: false,
  };
}

/**
 * `editorDoc` is the document on screen, and `built` says whether the reviewer built it. Only then
 * are `body/structure-lost` and `body/mark-lost` asked: on a parse of the body being judged they
 * block on artifacts of the parse (`surface/src/useReview.ts`'s load path). `body/text-changed` is
 * asked whenever a document is passed, since the load is where an agent's draft is normalised.
 * Without `editorDoc` no editor question is asked: the CLI's re-render of an approved body has no
 * document, so these checks live in the window, where `blocked` disables Approve and `approve()`
 * returns early on it, keyboard included.
 */
export function render(
  body: string,
  destination: string,
  editorDoc?: PmNode,
  built = true
): RenderResult {
  if (!isKnownDestination(destination)) throw new UnknownDestinationError(destination);

  // Typed as the contract, not the union of the profile literals, so the optional methods below are
  // optional calls instead of `'suggestFix' in profile` plus an `as never` cast.
  const profile: DestinationProfile = profiles[destination];
  const { converted, warnings } = profile.convert(body);
  // Re-parsed with `editorDocFor`'s options, or the round trip compares two different things. Once,
  // for the round trip and the link-host check, and only when one needs it: this runs on every
  // keystroke. `repairs` skips the link check, which is only a warning.
  const tree =
    editorDoc || body.includes('](') || (profile.angleLinkLabels && LABELLED_LINK_START.test(body))
      ? markdownToAdfFor(body, editorOptionsFor(profile)).adf
      : undefined;
  let lost: LostNode[] = [];
  let lostFormatting: LostMarks | undefined;
  let lostCharacters: LostText | undefined;
  if (editorDoc && tree) {
    const back = adfToProseMirror(tree);
    if (built) {
      lost = lostInMarkdown(editorDoc, back);
      lostFormatting = lostMarks(editorDoc, back);
    }
    if (lost.length === 0 && !lostFormatting) lostCharacters = lostText(editorDoc, back);
  }
  const sorted = allWarnings(
    body,
    [...warnings, ...mismatchedLinkHosts(tree)],
    lost,
    lostFormatting,
    lostCharacters
  );
  const blocked = hasBlockingWarning(sorted);

  // Only when blocked, and not when length is all that blocks: no repair shortens a draft, and this
  // costs a second serialisation and conversion per keystroke. A profile's body is named here; a
  // profile returning a `Fix` keeps its own wording.
  const repairable = sorted.some((w) => isBlocking(w) && !isLengthRefusal(w));
  const repaired = repairable ? (profile.suggestFix?.(converted, body) ?? undefined) : undefined;
  const offered: Fix | undefined =
    typeof repaired === 'string'
      ? { code: SUGGESTED_FIX_CODE, label: SUGGESTED_FIX_LABEL, body: repaired }
      : repaired;
  // ...and only if it actually repairs the draft.
  const suggestedFix = offered !== undefined && repairs(profile, offered.body) ? offered : undefined;

  return {
    destination,
    mode: profile.mode,
    canonical: body,
    converted,
    format: 'markdown',
    previewFidelity: profile.previewFidelity,
    themes: profile.themes,
    toolbar: profile.toolbar,
    mentions: profile.mentions,
    mediaPlacement: profile.mediaPlacement,
    rendersMedia: profile.rendersMedia,
    codeSpanMarks: profile.codeSpanMarks,
    listItemBlocks: profile.listItemBlocks,
    angleLinkLabels: profile.angleLinkLabels,
    ...(suggestedFix === undefined ? {} : { suggestedFix }),
    extraToolInput: { ...profile.extraToolInput },
    warnings: sorted,
    blocked,
  };
}
