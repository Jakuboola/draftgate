#!/usr/bin/env bun
/**
 * Verify the review window against the real thing: `bun run surface:probe [<scenario>|all]`, the
 * names being the keys of `SCENARIOS`. `e2e.ts`'s header divides the work between the verifiers.
 *
 * It launches the HARNESS build of the review host (`surface/host/harness.m` compiled in), which
 * loads the real bundle over `draftgate://` under the real policy, and drives it over the FIFO
 * channel (`wkSession.ts`): counts what rendered, reads computed styles, forces hover states,
 * screenshots. It differs from the review build only by `harness.m` (`host.test.ts` checks the
 * review build holds none of it) and the `DG_HARNESS` branches that keep it off screen. It catches:
 *
 *   - a CSP that blocks the window's own bundle (`'self'` does not reliably match an opaque
 *     `file://` origin, hence the custom scheme)
 *   - a document TipTap refuses to load, which blanks the window
 *   - a stylesheet that ships but does not apply, which is invisible to any DOM count
 *   - a `:hover` or `:disabled` rule that is declared and does not apply
 *
 * The spec, the expectations and the report are all built in this one process, so the properties
 * sampled and compared cannot diverge and a stale report cannot be judged. `report.json` is an
 * artifact for a person; nothing reads it.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  githubAudience, isBlockField, profiles, readPatch, type ReviewField,
  type ReviewFieldValue,
} from '../../core/src/index';
import { reviewPlan } from '../../cli/src/reviewPlan';
import {
  PROTOCOL_VERSION,
  REQUEST_ENV,
  type WireRequest,
} from '../../cli/src/surfaces/windowProtocol';
import { HARNESS_BUNDLE_ID, HOST_LAYOUT, buildHost } from '../../cli/src/reviewHost';
import { WKSession, VIEWPORT, engineRefused, launchHost, type HostMessage, type Isolation, type LaunchedHost, type PlatformFont, type Viewport } from './wkSession';
import {
  BLOCKED_FIXTURE, FIXTURE, INJECTED, JIRA_CONTEXT, SURFACE,
  SETTLE_PAST_MS, reporter, until, waitUntilRendered, type Injected,
} from './shared';

/** The smallest window the host lets a reviewer make (`geometry.cjs`, CommonJS so the host can load it). */
export const { MIN: WINDOW_MIN } = require('../geometry.cjs') as { MIN: Viewport };

/**
 * A scenario's fields, as the CLI would build them.
 *
 * `reviewPlan` decides the order and each field's `kind`; this attaches the scenario's values. The
 * block takes `canonical` and every line takes its own, which is the same walk `cli/src/review.ts`
 * makes over the same plan.
 */
function planFields(scenario: Scenario): ReviewFieldValue[] {
  const plan = reviewPlan(scenario.destination, {
    ...(scenario.prose ? { proseFields: scenario.prose.map((p) => p.field) } : {}),
    ...(scenario.bodyFormat ? { bodyFormat: scenario.bodyFormat } : {}),
  });
  const values = new Map((scenario.prose ?? []).map((p) => [p.field, p.value]));
  const lines = (f: ReviewField) => ({ ...f, value: isBlockField(f) ? scenario.canonical : values.get(f.field)! });
  if (scenario.patch === undefined) return plan.map(lines);
  // A patch: the lines, then its edits through the profile's grammar, as `extractPatch` reads them.
  const [delta] = profiles[scenario.destination].deltaFields;
  const read = readPatch(delta!, scenario.patch);
  if (!read.ok) throw new Error(`the scenario's patch cannot be shown: ${read.why}`);
  return [...plan.filter((f) => !isBlockField(f)).map(lines), ...read.fields];
}

const HERE = SURFACE;
const OUT = join(HERE, 'probe-result');

/** How long a scenario may take before it is killed, so a window that never answers cannot hang the run. */
const SCENARIO_TIMEOUT_MS = 60_000;

/**
 * How many review windows may be open at once. Fixed, not `os.cpus().length`: a load-dependent
 * degree could fail a timing-sensitive check on one machine and pass it on another. At four a
 * scenario takes well under a second, an order of magnitude inside `until`'s 15s and
 * `SCENARIO_TIMEOUT_MS`. Scenarios share no state, so the number changes only wall time.
 */
const CONCURRENCY = 4;

/**
 * The image URL inside `docs/torture-fixture.md`, as the placeholder must show it: the reviewer reads
 * the exact URL before deciding to fetch it. Asserted to be in the fixture; see `checkImages`.
 */
const FIXTURE_IMAGE_URL = 'https://example.com/a.png';

/** What to count, as `key -> selector`. Shipped to the window; asserted below. */
const NODE_SELECTORS: Record<string, string> = {
  prosemirror: '.ProseMirror',
  /** A prose field beside the body -- the editable title. */
  proseInput: 'input.dg-prose-field',
  /** A plain body's editing surface, and the line that says why it has no toolbar. */
  plainBody: 'textarea.dg-plain-body',
  plainNote: '.dg-plain-note',
  /*
   * A patch (`PatchEdits.tsx`): one card per edit, its read-only anchors, its editable text, the
   * preview drawn by the destination sheet (a `.ProseMirror`, so `prosemirror` counts it too), a
   * deletion, a flag chip and the note on what cannot be seen.
   */
  edit: '.dg-edit',
  editAnchor: '.dg-edit-anchor-text',
  editText: 'textarea.dg-edit-text',
  editPreview: '.dg-edit-preview .ProseMirror',
  editDeletes: '.dg-edit[data-deletes="true"]',
  editFlag: '.dg-edit-flag',
  editNote: '.dg-edit-note',
  // The mention chip. `jira.css`'s rule is the only thing that distinguishes it from prose: TipTap
  // 3's Mention ships `HTMLAttributes: {}` and no class of its own.
  mention: '.ProseMirror span[data-type="mention"]',
  // The mention token, a Slack-only decoration; a stylesheet is all that separates it from prose.
  // `slack-mentions` carries five tokens and asserts four (the code exclusion).
  mtok: '.ProseMirror .dg-mtok',
  mtokBroadcast: '.ProseMirror .dg-mtok-broadcast',
  /*
   * A link the destination turns into a mention (`mentions.links`: Linear's profile link). One
   * `mlinkStart` per mention, whatever spans its text is split into, and one `mlinkHidden` per bare
   * URL whose address is not drawn in front of its slug. `link` counts every link, mention or not.
   */
  mlinkStart: '.ProseMirror .dg-mlink-start',
  mlinkHidden: '.ProseMirror .dg-mlink-hidden',
  link: '.ProseMirror a',
  // The strip's own note, and the panel's detail. `.dg-status` is fixed-height; the shared census
  // pins it.
  mentionsNote: '.dg-mentions',
  mentionsDetail: '.dg-warn-mentions',
  h1: '.ProseMirror h1',
  h2: '.ProseMirror h2',
  h3: '.ProseMirror h3',
  h4: '.ProseMirror h4',
  h5: '.ProseMirror h5',
  h6: '.ProseMirror h6',
  table: '.ProseMirror table',
  th: '.ProseMirror th',
  td: '.ProseMirror td',
  ol: '.ProseMirror ol',
  li: '.ProseMirror li',
  checkbox: '.ProseMirror input[type=checkbox]',
  checked: '.ProseMirror input[type=checkbox]:checked',
  blockquote: '.ProseMirror blockquote',
  pre: '.ProseMirror pre',
  highlighted: '.ProseMirror pre .hljs-keyword, .ProseMirror pre .hljs-string',
  // One element per code line, from the CodeBlock node view: the count proves the gutter tracks the code.
  lineno: '.ProseMirror pre .dg-linenos span',
  hr: '.ProseMirror hr',
  // Content images only. prosemirror-view appends `<img class="ProseMirror-separator" alt="">`
  // (`addHackNode`) after an inline leaf that ends a textblock, and `image` is inline, so without the
  // exclusion one picture counts 2. WebKit gets it (`safari || chrome`), happy-dom does not.
  img: '.ProseMirror img:not(.ProseMirror-separator)',
  // A remote image the reviewer has not asked for yet: 1 for the torture fixture, with `img` then 0.
  imgDeferred: '.ProseMirror .dg-img-defer:not(.dg-img-loaded)',
  imgLoadBtn: '.ProseMirror .dg-img-load',
  imgUrl: '.ProseMirror .dg-img-url',
  // The blocked marker, a state of the verdict strip (which is always present, so a warning
  // arriving never moves the editor).
  blockedBar: '.dg-status[data-blocked="true"]',
  // Where it is going, in words: a `cloudId` names nothing to a human.
  destination: '.dg-destination',
  // Who receives this: a banner rendered, it took the customer-visible treatment, and the audience
  // this tool cannot reach is shown beside it (only when there is one to name).
  audienceBanner: '.dg-audience',
  audiencePublic: '.dg-audience-public',
  audienceOff: '.dg-audience-off',
  // The question a reviewer answers once, and its two buttons.
  audienceAsk: '.dg-audience-ask',
  audienceAnswer: '.dg-audience-answer',
  // The destination mark: one per window, and it must draw something. Every mark is official
  // artwork drawn in `path`s; `rect` is admitted so a future mark using one is not a silent zero.
  mark: '.dg-mark',
  markShape: '.dg-mark path, .dg-mark rect',
  // The full toolbar. `tbOption` counts the heading choices, the one place the profile's
  // per-destination capability shows in the DOM.
  toolbar: '.dg-toolbar',
  // The toolbar's own buttons, plus the one wrapped in `.dg-tb-host`. Not a descendant selector,
  // which would also count the emoji picker's ~1900 buttons.
  tbBtn: '.dg-toolbar > button, .dg-toolbar > .dg-tb-host > button',
  // Every toolbar button's glyph, compared with `tbBtn` in `probe()`. A mark drawn as a letterform
  // (`B`, `I`, `</>`) brings its own typeface and size beside the 16px icons.
  tbGlyph: '.dg-toolbar > button > svg, .dg-toolbar > .dg-tb-host > button > svg',
  tbOption: '.dg-tb-select option',
  // The emoji picker: only present once opened, and its data arrives over a dynamic import.
  emojiBtn: '.dg-emoji-btn',
  themeToggle: '.dg-theme-toggle',
  // The footer's warning row, present only when there is a warning; clean scenarios assert 0.
  warnRow: '.dg-warnbar',
  // The hairline between warning rows. `.dg-warn:first-child` has no top border, so it has to be
  // read on the second row.
  warn: '.dg-warn',
  // The per-warning repair button, present only where the profile could derive one.
  warnFix: '.dg-warn-fix',
  // The "N changed on load" marker and the silenced section it unfurls: what stops the window
  // rewriting a draft invisibly. Styles pinned by `jira-silenced` / `jira-silenced-dark`.
  changed: '.dg-changed',
  // "destination inferred", an extra flex item in the header; `.dg-header`'s pinned height catches
  // it wrapping the line.
  inferred: '.dg-inferred',
  silencedHead: '.dg-warn-silenced-head',
  silencedRow: '.dg-warn-silenced',
  // The before/after preview, shared by a blocked draft's repair and a warning's.
  modal: '.dg-modal',
  // The selection toolbar, present only while text is selected (`selectText`); 0 at rest.
  bubble: '.dg-bubble',
  bubbleBtn: '.dg-bubble button',
  // The bubble's glyphs, compared with `bubbleBtn` like `tbGlyph`; their size is `GLYPH_BOX`.
  bubbleGlyph: '.dg-bubble button > svg',
  bubbleActive: '.dg-bubble button[aria-pressed="true"]',
  // Where the link under the caret goes: 0 at rest, one in `linear-link-target`. `titledLink` is the
  // hover half, a link's text carrying its href as `title`, drawn by a decoration.
  linkTarget: '.dg-linktarget',
  linkTargetUrl: '.dg-linktarget .dg-linktarget-url',
  titledLink: '.ProseMirror a [title], .ProseMirror a[title]',
  // A link the converter read from Slack's own `<url|label>` or `<url>`, which goes out in that form.
  angleLink: '.ProseMirror a[data-angle]',
  approveDisabled: '.dg-btn-primary[disabled]',
  // The `edited` badge: 0 everywhere but `jira-task-toggle`. An edit the window never registered
  // shows in no other count (the census sees a ticked checkbox either way).
  edited: '.dg-edited',
};

/**
 * Counts the torture fixture must produce: 1 h1, 3 h2 (two in the document plus the ladder's), one
 * each of h3..h6, a 3x3 table, an ordered list with a nested bullet list, a two-item task list with
 * one checked, a blockquote, a highlighted python code block, a rule, an image. Identical across
 * destinations: one editor, one document.
 */
const FIXTURE_COUNTS: Record<string, number> = {
  prosemirror: 1,
  // The fixture's external image earns a warning on Jira and Slack. Linear renders markdown images
  // and collapses no heading levels, so its scenarios override this to 0: the negative control on
  // the full fixture, with every other piece of chrome present.
  warnRow: 1,
  h1: 1, h2: 3, h3: 1, h4: 1, h5: 1, h6: 1,
  table: 1, th: 3, td: 6,
  ol: 1, li: 7, checkbox: 2, checked: 1,
  blockquote: 1, pre: 1, hr: 1,
  // Zero: the image is remote, so the window shows a placeholder and requests nothing until the
  // reviewer asks. `jira-image-load` clicks it and asserts the 1.
  img: 0, imgDeferred: 1, imgLoadBtn: 1, imgUrl: 1,
  /*
   * The highlighter ran and coloured tokens.
   *
   * The 5 is not "`def`, `int`, `str`, `return` as keywords plus the f-string": `int` and `str`
   * are `hljs-built_in`, which this selector does not match. Derived from lowlight's own output
   * for the fixture's fence and from
   * how TipTap's CodeBlockLowlight flattens it (one decoration per LEAF text node, carrying every
   * ancestor's class names, because ProseMirror decorations cannot nest):
   *
   *   "def"    hljs-keyword
   *   "foo"    hljs-title function_
   *   "x: "    hljs-params
   *   "int"    hljs-params hljs-built_in
   *   "str"    hljs-built_in
   *   "return" hljs-keyword
   *   "f\""    hljs-string
   *   "{x}"    hljs-string hljs-subst      <- still matches .hljs-string
   *   "\""     hljs-string
   *
   * So: 2 keywords and 3 string spans. The f-string splitting into three is the whole reason the
   * number is not 3.

   */
  highlighted: 5,
  // The fixture's fence is two lines. Rendered for every destination; only Slack's sheet shows them.
  lineno: 2,
  // A clean draft is approvable.
  blockedBar: 0, approveDisabled: 0,
  mark: 1, markShape: 1,
  edited: 0,
  // No selection, so no selection toolbar.
  bubble: 0, bubbleBtn: 0,
  // Nor the link-target bubble: the caret starts in the heading, not in a link.
  linkTarget: 0,
  // The fixture's links are markdown links, on every destination.
  angleLink: 0,
  // 15 buttons = 5 marks + 7 blocks + emoji + undo/redo; the heading picker is a <select>, and there
  // is no `Image by URL` control (`ToolbarInsert`). 7 options = Normal + six levels, as Jira and
  // Linear declare; Slack declares three and overrides this to 4.
  toolbar: 1, tbBtn: 15, tbOption: 7,
  // The torture fixture names no derivable repair.
  warnFix: 0, modal: 0, changed: 0, silencedHead: 0, silencedRow: 0,
  // Every destination declares both themes (`supported.length < 2` in `ThemeToggle` hides it).
  themeToggle: 1,
  // Closed unless a scenario opens it.
  emojiBtn: 0,
};

/**
 * Marks a property that must be sampled but not compared: the spec is built from the keys of each
 * expectation map, so this gives `leadingBlock`'s check a value without `mismatches` comparing it.
 */
const SAMPLED_ONLY = '(sampled only)';

/** Both margins flush. */
const FLUSH = { marginTop: '0px', marginBottom: '0px' } as const;

/**
 * What `controls.tsx`'s `ico()` produces, measured. Asserted on `.dg-tb-btn > svg` in
 * `SHARED_STRUCTURE` and on `.dg-bubble-btn > svg` wherever a scenario counts bubble buttons
 * (`stylesFor`): the three `-toolbar` scenarios, one per destination. Lucide's `stroke-width="1.75"`
 * computes to `1.75px`, with its unit.
 */
const GLYPH_BOX = { width: '16px', height: '16px', strokeWidth: '1.75px' } as const;

/**
 * Linear's `.editor .heading-node`, which every heading level carries: the h1 of a live comment
 * computes 600 and `"calt"` (DevTools). One rule there and one here.
 */
const LINEAR_HEADING_NODE = { fontWeight: '600', fontFeatureSettings: '"calt"' } as const;

/**
 * A `<strong>` in a live Linear comment's paragraph (read in DevTools):
 * Linear's `strong` at 600, and the comment's inherited `"calt"` and -0.1px, which here are the
 * editor root's `"calt"` and `-.00666667em` at 15px.
 */
const LINEAR_STRONG = { fontWeight: '600', fontFeatureSettings: '"calt"', letterSpacing: '-0.1px' } as const;

/**
 * Rules every sheet carries, asserted for every destination from one map. The CSS duplicates them
 * because a shared stylesheet loses on specificity (`.claude/rules/styles.md`); a copy here per
 * destination would leave a forgotten one silently unguarded.
 */
const SHARED_STRUCTURE = {
  /*
   * The footer is the same height in every scenario that checks styles: clean, warned, blocked,
   * unfurled. The body pane is `flex: 1` in a fixed-size window, so any pixel the footer takes
   * comes out of the editor's. The trap: "Approve & send (⌘↵)" shrinks before its siblings clip
   * and wraps to two lines, which `tokens.test.ts` (what the sheet says) cannot see;
   * `.dg-actions .dg-btn` is `flex: none; white-space: nowrap`.
   *
   * 52px, MEASURED. The button row plus 10px of padding above and below comes to 51 by arithmetic,
   * so the number is the engine's and the arithmetic is not claimed.
   */
  '.dg-footer': { height: '52px' },
  /*
   * The verdict strip, where the warning row and its two actions live: anything taller than the row
   * grows it and comes out of the body pane, which is why the actions are text links, not buttons.
   * The fixtures span clean, info, warning, blocking and unfurled.
   */
  '.dg-status': { height: '33px' },
  // The header holds nothing that changes with the render.
  '.dg-header': { height: '47px' },
  /*
   * The toolbar's glyphs are one size and one stroke, in every destination: the other half of
   * `tbGlyph`'s count. The toolbar is chrome (no destination sheet carries a `.dg-tb-*` rule), so it
   * is asserted everywhere. `querySelector` reads the first glyph; `probe()`'s count equality makes
   * it representative. `UrlInput`'s textual Apply/Remove also wear `.dg-tb-btn` but carry no `<svg>`,
   * and the count selectors are direct-child, which keeps them out.
   */
  '.dg-tb-btn > svg': GLYPH_BOX,
  '.ProseMirror ul[data-type="taskList"]': { paddingLeft: '2px', listStyleType: 'none' },
  '.ProseMirror ul[data-type="taskList"] li': { display: 'flex', columnGap: '8px' },
  '.ProseMirror li p': FLUSH,
  '.ProseMirror th p': FLUSH,
  '.ProseMirror td p': FLUSH,
  '.ProseMirror blockquote p': FLUSH,
} as const;

/**
 * A checked task box with `--dg-task-tick` cut out of a full square, as the engine
 * parsed the mask: the tick's layer and the square it is excluded from. Jira and Linear; Slack
 * cuts it out of a square of its own size instead, so its second layer is not `auto`.
 */
const TICK_CUT_OUT = { maskSize: '10px 10px, auto', maskComposite: 'exclude, add' };

/**
 * Computed styles that must hold, proving the destination stylesheet applied.
 *
 * Jira's are Atlassian's own numbers, read off the live editor-core render with `getComputedStyle`
 * (`tools/jira-ruler/probe-headings.cjs` and `probe-blocks.cjs`); all six heading levels are
 * measured. Do not derive h4-h6 from the `--ds-font-heading-*` token ladder: editor-core does not
 * use that family, and the ladder agrees on h1-h3 while getting h4's line-height and h6's size wrong.
 */
const EXPECTED_STYLES: Record<string, Record<string, Record<string, string>>> = {
  jira: {
    ...SHARED_STRUCTURE,
    // `auto`, and on purpose: Jira's rendered comments compute it on every element up to `html`
    // (2,749 read on a live Jira Cloud site). Slack and Linear set `antialiased`, so
    // this is the half of the pair that stops one sheet's fix being "harmonised" into all four.
    // `lineHeight` is the READER's `1.714`: 23.996px on a live comment, where the
    // ruler reads the editor's 24px.
    '.ProseMirror p': { fontSize: '14px', lineHeight: '23.996px', fontWeight: '400', webkitFontSmoothing: 'auto' },
    // All six, measured on the editor-core build (`tools/jira-ruler/probe-headings.cjs`). All assert
    // `marginBottom: 0px`: editor-core leaves h4-h6 to the browser's 1.33em-2.33em, and the reader's
    // page zeroes them (AUI's `p, ul, ol, ..., h1..h6 { margin: 10px 0 0 }`).
    '.ProseMirror h1': { fontSize: '24px', lineHeight: '28px', fontWeight: '600', marginBottom: '0px' },
    '.ProseMirror h2': { fontSize: '20px', lineHeight: '24px', fontWeight: '600', marginTop: '28px', marginBottom: '0px' },
    '.ProseMirror h3': { fontSize: '16px', lineHeight: '20px', fontWeight: '600', marginTop: '21px', marginBottom: '0px' },
    '.ProseMirror h4': { fontSize: '14px', lineHeight: '16px', fontWeight: '600', marginTop: '20px', marginBottom: '0px' },
    '.ProseMirror h5': { fontSize: '12px', lineHeight: '16px', fontWeight: '600', marginTop: '17.5px', marginBottom: '0px' },
    '.ProseMirror h6': { fontSize: '11px', lineHeight: '16px', fontWeight: '600', marginTop: '17.5px', marginBottom: '0px' },
    // The cell border is the renderer's opaque `accent.gray.subtler`. On white it is the
    // same pixel the translucent `--ds-border` made, so light cannot tell them apart -- dark does.
    '.ProseMirror th': { backgroundColor: 'rgb(240, 241, 242)', fontWeight: '400', padding: '8px', borderTopColor: 'rgb(221, 222, 225)' },
    '.ProseMirror td': {
      backgroundColor: 'rgb(255, 255, 255)', padding: '8px', verticalAlign: 'top', borderTopColor: 'rgb(221, 222, 225)',
      // A word too long for its fixed-width column wraps, as the reader's cells do. The
      // editor's own `word-wrap: break-word` is inherited, so this pins that nothing overrides it.
      overflowWrap: 'break-word',
    },
    // Jira's own box, not the engine's: a ring masked out of `--ds-border-input`, and
    // checked a `--ds-background-brand-bold` square with the tick cut out of it. The mask's sizes
    // and its composite are what the engine parsed out of the rule: with no mask the box is a solid
    // grey square, which reads as ticked, and every colour here still holds.
    '.ProseMirror input[type=checkbox]': {
      appearance: 'none', width: '14px', height: '14px', borderTopLeftRadius: '2px',
      backgroundColor: 'rgb(140, 143, 151)', maskSize: '14px 14px',
    },
    '.ProseMirror input[type=checkbox]:checked': {
      backgroundColor: 'rgb(24, 104, 219)', ...TICK_CUT_OUT,
    },
    // Blocks, measured (`tools/jira-ruler/probe-blocks.cjs`) on the real rendered
    // nodes -- the fixture contains all of these, so none of it is an injected stand-in.
    '.ProseMirror blockquote': {
      borderLeftWidth: '2px',
      borderLeftColor: 'rgba(11, 18, 14, 0.14)',
      // A comment's quote, read off the reader: a description's has none above and below.
      padding: '10px 20px 10px 16px',
      marginTop: '12px',
      marginBottom: '0px',
    },
    '.ProseMirror table': { borderCollapse: 'collapse', marginTop: '24px', marginBottom: '0px' },
    // Lists as a COMMENT's reader spaces them (`jira.css` has the AUI selectors): 4px
    // above one after another block, 0 below, 4px between items and above a nested list. The
    // editor's 14px/14px is the ruler's, not the reader's. A description would put 10px above.
    '.ProseMirror ol': { marginTop: '4px', marginBottom: '0px', paddingLeft: '24px' },
    '.ProseMirror li + li': { marginTop: '4px' },
    '.ProseMirror li > ul': { marginTop: '4px' },
    // The renderer's own task list rule: 12px above, 0 below.
    '.ProseMirror ul[data-type="taskList"]': {
      ...SHARED_STRUCTURE['.ProseMirror ul[data-type="taskList"]'],
      marginTop: '12px',
      marginBottom: '0px',
    },
    '.ProseMirror pre': {
      // No border: measured. Jira draws no outline round a code block.
      borderTopWidth: '0px',
      // A neutral panel on an 8px radius (`@atlaskit/code`): the reader's token, which
      // logged-in Jira draws in light too. Dark is measured, below.
      backgroundColor: 'rgba(5, 21, 36, 0.06)',
      borderRadius: '8px',
      marginTop: '12px',
      marginBottom: '0px',
      // The reader's code size, `@atlaskit/renderer`'s dense override: 0.875em of 14px on 1.5em
      // lines. The ruler reads 14px/24px off the editor's container; a live Jira page reads these.
      fontSize: '12.25px',
      lineHeight: '18.375px',
    },
    // Inline code is a chip in the reader -- `--ds-background-neutral`, 2px 0.5ch, radius 3px --
    // and 0.875em -- not "no background, padding 0", which is what an element the ruler never
    // styled reads. `paddingLeft` is `0.5ch` of the resolved mono face, so not pinned.
    '.ProseMirror :not(pre) > code': {
      fontSize: '12.25px',
      backgroundColor: 'rgba(5, 21, 36, 0.06)',
      paddingTop: '2px',
      borderTopLeftRadius: '3px',
    },
    // The reader's `1.714em` and round ends; the ruler's 24px and square ends are the editor's.
    '.ProseMirror hr': { height: '2px', marginTop: '23.996px', marginBottom: '23.996px', borderTopLeftRadius: '9999px' },
    // No language label: the reader draws none (no block of thirteen with a language showed its
    // name); a top-right label is editor-core's language picker, on the author's surface.
    '.ProseMirror pre[data-language]::before': { content: 'none' },
    // Links: from editor-core's shipped CSS, not its render -- the ruler stubs the link provider
    // and returns the browser default. `--ds-link`, and underlined. Not #1558bc: that is
    // `--ds-link-pressed`.
    '.ProseMirror a': { color: 'rgb(24, 104, 219)', textDecorationLine: 'underline' },
    // MEASURED (`bun run measure:linenos`): right-aligned in --ds-text-subtlest at the block's own
    // leading, 18.375px (`font: inherit`; 24px would drift a quarter line per line). Padding and
    // margin are the reader's (`@atlaskit/code`'s `.linenumber`); `position: static` lets the column
    // be as wide as its widest number. Tinted --ds-background-neutral, as logged-in Jira draws it.
    '.ProseMirror .dg-linenos': {
      textAlign: 'right',
      color: 'rgb(107, 110, 118)',
      backgroundColor: 'rgba(5, 21, 36, 0.06)',
      paddingLeft: '8px',
      paddingRight: '8px',
      marginRight: '8px',
      position: 'static',
    },
    '.ProseMirror .dg-linenos span': { display: 'block', lineHeight: '18.375px' },
    // Chrome: Jira's brand button, generated: --ds-background-brand-bold #1868DB, and
    // --ds-text-inverse #FFFFFF on it. The compose frame is --ds-border-input #8C8F97.
    '.dg-btn-primary': { backgroundColor: 'rgb(24, 104, 219)', color: 'rgb(255, 255, 255)' },
    '.dg-compose': { borderTopColor: 'rgb(140, 143, 151)', borderTopWidth: '1px' },
    // The warning row in the footer, light; pinned in dark too, since `.dg-hint` could stay light.
    '.dg-warnbar-msg': { color: 'rgb(28, 30, 33)' },
  },
  slack: {
    ...SHARED_STRUCTURE,
    // `none` at rest, `underline` on hover (`hoverStyles`): the opposite of Jira.
    '.ProseMirror a': { textDecorationLine: 'none' },
    // A nested list has no margin: directly under its parent, as Slack draws it.
    '.ProseMirror li ul': FLUSH,
    // Slack's checklist box, in the text colour, shaped by the mask: a ring, and checked a square
    // with the tick cut out. Both states share a colour, so the mask is what is asserted.
    '.ProseMirror input[type=checkbox]': {
      appearance: 'none', width: '14px', height: '14px', backgroundColor: 'rgb(29, 28, 29)', maskSize: '14px 14px',
    },
    '.ProseMirror input[type=checkbox]:checked': { maskSize: '10px 10px, 14px 14px', maskComposite: 'exclude, add' },
    // Slack's `body { -webkit-font-smoothing: antialiased }`, read on `p`, the inherited value.
    '.ProseMirror p': { webkitFontSmoothing: 'antialiased' },
    /*
     * Slack's own header rules (`modern.*.min.css`, `.p-rich_text_header--level_N`): the two-size
     * structure measured off a live render, the numbers the rules'. h1's 900 is
     * `--custom-font-weight-black`; `level_2` is 900 and `level_3` 700. The fractions are Chromium's
     * arithmetic on Slack's ratios (18 x 1.33334 = 24.0001, 15 x 1.46668 = 22.0002), held within
     * `samePixels`' 0.02px.
     */
    '.ProseMirror h1': { fontSize: '18px', lineHeight: '24.0001px', fontWeight: '900' },
    // h2 is 900 and h3..h6 700: three renderings, each level confirmed on the live DOM
    // (`###`..`######` are all `level_3 flat_scale`). The claim is `profiles/slack.ts`'s.
    '.ProseMirror h2': { fontSize: '15px', lineHeight: '22.0002px', fontWeight: '900' },
    '.ProseMirror h3': { fontSize: '15px', lineHeight: '22.0002px', fontWeight: '700' },
    '.ProseMirror h4': { fontSize: '15px', lineHeight: '22.0002px', fontWeight: '700' },
    '.ProseMirror h5': { fontSize: '15px', lineHeight: '22.0002px', fontWeight: '700' },
    '.ProseMirror h6': { fontSize: '15px', lineHeight: '22.0002px', fontWeight: '700' },
    // The quote bar is a rounded pseudo-element, not a border: Slack draws
    // `blockquote.c-mrkdwn__quote:before { border-radius: 8px; width: 4px }`. The census splits a
    // key on `::` to read it.
    '.ProseMirror blockquote::before': { width: '4px', borderTopLeftRadius: '8px' },
    /*
     * The fixture's fence has a language, so this is Slack's code-block card (off a live Slack
     * client and the component's own rules; `slack.css` says how one `<pre>` draws
     * it). The code starts 41px down and 54px in; the visible radius is 12px inside a transparent
     * 12px/8px border that stands for Slack's wrapper padding; the card's 1px border is an inset
     * shadow in `--dt_color-surf-pry` (#1d1c1d0f light).
     */
    '.ProseMirror pre': {
      paddingTop: '41px',
      // 1 + 8: the number column and its 10px margin are in flow (a flex row), so the code's
      // 54px is measured in real layout by the scenario's `codeLayout`, not declared here.
      paddingLeft: '9px',
      paddingRight: '21px',
      paddingBottom: '17px',
      borderTopWidth: '12px',
      borderLeftWidth: '8px',
      borderTopLeftRadius: '20px 24px',
      boxShadow: 'rgba(29, 28, 29, 0.06) 0px 0px 0px 1px inset',
      backgroundColor: 'rgb(248, 248, 248)',
      fontSize: '12px',
      // `.container__*`'s `line-height: 150%`. The live lines read 18.0001px; no rule states that.
      lineHeight: '18px',
    },
    // The language label, drawn in the space the padding above reserves. `content` resolves
    // `attr(data-language)`, so it also proves the attribute reached the DOM.
    '.ProseMirror pre[data-language]::before': {
      content: '"python"',
      position: 'absolute',
      top: '12px',
      left: '13px',
      fontSize: '13px',
      lineHeight: '18px',
      fontWeight: '700',
      // rgb(var(--dt_color-plt-gray-50)), light's triplet 124,122,127.
      color: 'rgb(124, 122, 127)',
    },
    // `.code__* pre.slalabaster .line-number`: 35px (border-box) right-aligned, 10px to the code,
    // in --dt_color-content-sec #454447, sticky at the left edge on the card's own ground.
    '.ProseMirror .dg-linenos': {
      display: 'block',
      position: 'sticky',
      left: '0px',
      width: '35px',
      paddingRight: '10px',
      marginRight: '10px',
      textAlign: 'right',
      color: 'rgb(69, 68, 71)',
    },
    // `.line { white-space: pre }`: a long line scrolls, so each number stays beside its own line.
    '.ProseMirror pre code': { whiteSpace: 'pre' },
    // Chrome: Slack green (a brand colour, see slack.css) and Slack's rounded composer frame.
    '.dg-btn-primary': { backgroundColor: 'rgb(0, 122, 90)' },
    '.dg-compose': { borderRadius: '8px' },
    /*
     * The hairline between warning rows (`--dg-rule`), light, and pinned in dark too. `~`, not `+`:
     * a silenced section's heading row can sit between warning rows, and `+` would read that rule's
     * heavier `--dg-line` instead.
     */
    '.dg-warn ~ .dg-warn': { borderTopColor: 'rgb(242, 243, 244)' },
    // MEASURED: a checked task item is struck through in Slack, the label only, not the checkbox.
    '.ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div': {
      textDecorationLine: 'line-through',
    },
    // One block per line on the code's own 18px (12px at the container's 150%).
    '.dg-linenos span': { display: 'block', lineHeight: '18px' },
  },
  linear: {
    ...SHARED_STRUCTURE,
    // Chrome: Linear's light brand token, --color-brand-bg #7070ff (#5e6ad2 is the dark one).
    '.dg-btn-primary': { backgroundColor: 'rgb(112, 112, 255)' },
    '.dg-compose': { borderRadius: '6px' },
    // GENERATED from Linear's own CSS: --color-text-primary #282a30, --color-link-primary #7070ff
    // (a different token from the brand colour), --color-bg-tint
    // #f4f4f5, --color-border-primary #e9e8ea.
    // `antialiased`: the client sheet's `body` rule, read back out of WebKit.
    // 450 is Linear's own body weight -- reachable because the face is variable.
    // `"calt"` and -0.1px: what a paragraph's `<strong>` inherits in a live comment.
    '.ProseMirror p': {
      fontSize: '15px',
      fontWeight: '450',
      color: 'rgb(40, 42, 48)',
      webkitFontSmoothing: 'antialiased',
      fontFeatureSettings: '"calt"',
      letterSpacing: '-0.1px',
    },
    // Code takes no `calt`: Linear's bare `pre, code { font-feature-settings: normal }`.
    '.ProseMirror p > code': { fontFeatureSettings: 'normal' },
    // `none` at rest, `underline` on hover (`hoverStyles`): the opposite of Jira.

    '.ProseMirror a': { color: 'rgb(112, 112, 255)', textDecorationLine: 'none' },
    // The code block (sources in linear.css). Where the code starts is `codeLayout`'s,
    // and its border is the table's `--ln-hairline`, whose width `tableLayout` measures.
    '.ProseMirror pre': {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopStyle: 'solid',
      borderTopColor: 'rgb(233, 232, 234)',
      borderTopLeftRadius: '6px',
      fontSize: '12px',
      lineHeight: '20px',
      letterSpacing: 'normal',
      fontFeatureSettings: 'normal',
      paddingTop: '12px',
      paddingLeft: '0px',
      paddingRight: '16px',
    },
    '.ProseMirror pre code': { whiteSpace: 'pre' },
    '.ProseMirror .dg-linenos': {
      display: 'block',
      textAlign: 'right',
      color: 'rgb(160, 161, 162)',
      paddingLeft: '16px',
      paddingRight: '20px',
    },
    '.ProseMirror .dg-linenos span': { display: 'block', lineHeight: '20px' },
    '.ProseMirror td': { borderTopColor: 'rgb(233, 232, 234)' },
    // Quote and header cell (sources in linear.css).
    '.ProseMirror blockquote': { color: 'rgb(40, 42, 48)', paddingLeft: '16px' },
    '.ProseMirror blockquote::before': {
      width: '4px', borderTopLeftRadius: '2px', backgroundColor: 'rgb(233, 232, 234)',
    },
    // Linear's table (sources in linear.css): `.editor .cell-content`'s `5px 8px`, the 6px radius
    // on the table and each corner cell (drawn only in the separated border model), and which cells
    // carry a rule: a cell after another on its left, a body cell on top. Widths are `tableLayout`'s.
    '.ProseMirror table': { borderCollapse: 'separate', borderTopLeftRadius: '6px' },
    '.ProseMirror th': {
      fontWeight: '450', paddingTop: '5px', paddingLeft: '8px',
      borderTopLeftRadius: '6px', borderLeftStyle: 'none', borderTopStyle: 'none',
    },
    '.ProseMirror th:last-child': { borderLeftStyle: 'solid', borderTopRightRadius: '6px' },
    '.ProseMirror tr:last-of-type > td:first-child': { borderLeftStyle: 'none', borderBottomLeftRadius: '6px' },
    '.ProseMirror tr:last-of-type > td:last-child': {
      paddingBottom: '5px', paddingRight: '8px', borderLeftStyle: 'solid', borderTopStyle: 'solid',
      borderBottomRightRadius: '6px',
    },
    // Linear's own box: `.editor .todo-checkbox`, the border read off a light-theme capture of a
    // live Linear comment. Checked, the text colour at 0.9 with the tick cut out.
    '.ProseMirror input[type=checkbox]': {
      appearance: 'none', width: '14px', height: '14px',
      borderTopWidth: '1px', borderTopColor: 'rgb(160, 161, 162)', borderTopLeftRadius: '3px',
    },
    '.ProseMirror input[type=checkbox]:checked': {
      backgroundColor: 'rgb(40, 42, 48)', opacity: '0.9', ...TICK_CUT_OUT,
    },
    // A done item's text, at `--editor-todo-checked-opacity` (read off the same capture).
    '.ProseMirror li[data-checked="true"] > div > p': { opacity: '0.75' },
    // Linear's editor tokens, the one part of this that is the editor's rather than the site's:
    // --editor-list-inset 1.5rem, --editor-letter-spacing, --editor-line-height.
    '.ProseMirror ul': { paddingLeft: '24px' },
    /*
     * Headings, from Linear's editor stylesheet: `.editor` declares `--editor-hN-font-size` /
     * `--editor-hN-line-height` and `.editor hN` consumes them. 600 on every level, from
     * `.editor .heading-node` (`LINEAR_HEADING_NODE`); not the bare `h1..h6`'s 500, which the class
     * rule outranks. h5 and h6 pin no line-height: `.editor h5, .editor h6` sets none, so the
     * sheet's 1.5rem is a token nothing consumes. Whether 600 is rendered is `tokens.test.ts`'s.
     * The h1's top margin is 0 because the fixture opens with it; `linear-headings` measures the
     * 48px it has below another block.
     */
    '.ProseMirror h1': { fontSize: '22px', lineHeight: '29.6px', ...LINEAR_HEADING_NODE, marginTop: '0px' },
    '.ProseMirror h2': { fontSize: '19px', lineHeight: '28px', ...LINEAR_HEADING_NODE },
    '.ProseMirror h3': { fontSize: '17px', lineHeight: '24px', ...LINEAR_HEADING_NODE },
    '.ProseMirror h4': { fontSize: '15px', lineHeight: '24px', ...LINEAR_HEADING_NODE },
    '.ProseMirror h5': { fontSize: '14px', ...LINEAR_HEADING_NODE },
    '.ProseMirror h6': { fontSize: '14px', ...LINEAR_HEADING_NODE },
    // Bold in a paragraph; not 700, WebKit's `bolder` on the 450 body. `linear-bold` holds bold in
    // a heading.
    '.ProseMirror strong': LINEAR_STRONG,
  },
  /*
   * GitHub: every number read off GitHub's own rendered comment by `tools/github-ruler/`, not off
   * `.markdown-body`'s declarations, which are wrong for a comment. `tokens.test.ts` holds
   * `github.css` to the same measurement as declared; this reads it back out of WebKit.
   */
  github: {
    ...SHARED_STRUCTURE,
    // Chrome: GitHub's primary button green (`--bgColor-success-emphasis` #1f883d), not the link
    // blue: on GitHub the green button commits an action, as Approve does.
    '.dg-btn-primary': { backgroundColor: 'rgb(31, 136, 61)' },
    '.dg-compose': { borderRadius: '6px' },
    // 14px, the value this destination's ruler exists for: `.markdown-body` says 16px and a comment
    // renders at 14px, because `.comment-body` wins the cascade. Colour `--fgColor-default` #1f2328.
    // `auto`: github.com sets smoothing only off the comment chain (tooltips, marketing) -- read on
    // live issues and the ruler's page.
    '.ProseMirror p': { fontSize: '14px', color: 'rgb(31, 35, 40)', webkitFontSmoothing: 'auto' },
    // Underlined at rest, and the `github` scenario's `hoverStyles` asserts it still is on hover:
    // GitHub serves `data-a11y-link-underlines="true"`.
    '.ProseMirror a': { color: 'rgb(9, 105, 218)', textDecorationLine: 'underline' },
    '.ProseMirror pre': { backgroundColor: 'rgb(246, 248, 250)' },
    '.ProseMirror td': { borderTopColor: 'rgb(209, 217, 224)', textAlign: 'start' },
    // A header cell is centred, as GitHub draws it.
    '.ProseMirror th': { textAlign: 'center' },
    // Primer's checkbox as a comment's task list draws it: 1em, so 14px, a 1px
    // `--control-borderColor-emphasis` border on a 3px radius, on the page's ground; checked,
    // `--control-checked-bgColor-rest`.
    '.ProseMirror input[type=checkbox]': {
      appearance: 'none', width: '14px', height: '14px', borderTopWidth: '1px',
      borderTopColor: 'rgb(129, 139, 152)', borderTopLeftRadius: '3px', backgroundColor: 'rgb(255, 255, 255)',
    },
    '.ProseMirror input[type=checkbox]:checked': { backgroundColor: 'rgb(9, 105, 218)' },
    // Equal-width digits, GitHub's own `.markdown-body table { font-variant: tabular-nums }` --
    // recorded by the ruler as `table.font-variant-numeric`. `jira` and the rest compute `normal`.
    '.ProseMirror table': { fontVariantNumeric: 'tabular-nums' },
    // 28px, GitHub's own list indent -- 2em of the 14px body rather than a round number.
    '.ProseMirror ul': { paddingLeft: '28px' },
    // 1px and filled, GitHub's own rule as the ruler reads it.
    '.ProseMirror hr': { height: '1px', backgroundColor: 'rgb(209, 217, 224)' },
    // Sizes are `em` of a 14px body (2 / 1.5 / 1.25) on a flat 1.25 line-height, hence not round.
    // 600 is GitHub's semibold; whether it renders is `tokens.test.ts`'s.
    '.ProseMirror h1': { fontSize: '28px', lineHeight: '35px', fontWeight: '600' },
    '.ProseMirror h2': { fontSize: '21px', lineHeight: '26.25px', fontWeight: '600' },
    '.ProseMirror h3': { fontSize: '17.5px', lineHeight: '21.875px', fontWeight: '600' },
    // The UA default for `<strong>` is 700 and GitHub renders 600, so the sheet must override it.
    '.ProseMirror strong': { fontWeight: '600' },
  },
};

export interface Scenario {
  destination: 'jira' | 'slack' | 'linear' | 'github';
  /**
   * Routing fields to show, when the default three are not the point: `contextFields: ["fields.*"]`
   * puts every key the agent set in the strip. See `contextLayout`.
   */
  context?: Record<string, unknown>;
  /** Prose fields beside the body -- a title. */
  prose?: { field: string; value: string }[];
  /** The body is plain text, not markdown. */
  bodyFormat?: 'markdown' | 'plain';
  /**
   * A delta's operations, as the agent sent them: the review shows these edits and no body, and
   * `canonical` is unused. Read through the destination's grammar (`readPatch`).
   */
  patch?: Record<string, unknown>[];
  /**
   * Which theme to force; `light` by default, never the OS's. Measured: with the OS in dark mode,
   * `th`, `td` and the blockquote bar come back dark against light expectations.
   */
  theme?: 'light' | 'dark';
  canonical: string;
  counts: Record<string, number>;
  /** Only the full-fixture scenarios assert typography; the blocked ones are about the chrome. */
  checkStyles?: boolean;
  /**
   * The destination's typeface, and whether it must actually render: a computed `font-family`
   * cannot tell a face that loads from one that falls back.
   *
   * Two checks: the width comparison answers "does this family load"; `WKSession.platformFonts`
   * matches the drawn width against each loaded face (`wkFacesByWidth`) for "is it the face that
   * draws the pane" -- a family, never an instance. `resolves: false` means a platform face (Jira's
   * proprietary one, GitHub's never-loaded "Mona Sans VF"). `drawnAs` is the family the font file
   * names itself (`fontFile.ts`: `@fontsource-variable/inter` is `Inter` under the CSS name
   * `Inter Variable`), defaulting to `family`.
   *
   * `italic`: `*italic*` must draw in the family's own italic, not a synthetic slant. The evidence is
   * the italic's own advances plus a loaded italic face covering the em's weight -- CSS matching
   * prefers style over weight, so with no 400 italic the `em` draws in the bold italic
   * (`wkItalicAdvances`).
   */
  fontFamily?: { family: string; resolves: boolean; drawnAs?: string; italic?: boolean };
  /**
   * The family the code face's file names itself, when a destination bundles one (Slack:
   * `Slack-Roboto-Mono`). A code face falling back to Monaco is invisible to the prose checks.
   */
  codeFont?: string;
  /** Expectations for this scenario, merged over the destination's per property (`stylesFor`). */
  styles?: Record<string, Record<string, string>>;
  /**
   * The audience banner to render, as the CLI would supply it. Given, not computed: the window's job
   * is to draw it, and the rule is unit-tested in `core/test/audience.test.ts`.
   */
  audience?: WireRequest['audience'];
  /**
   * Where it is going, in words, as the profile composed it; given for `audience`'s reason
   * (`destinationLabelFor` is tested in `core/test/audience.test.ts`).
   */
  destinationLabel?: string;
  /** The destination was inferred from the tool name; when to infer is `resolveRoute`'s, tested in the adapter. */
  routeInferred?: WireRequest['routeInferred'];
  /**
   * Override the tool name (default `probe:<name>`). The audience rule reads it: an unprobed tool
   * takes the "no evidence about who sees what X posts" branch, which never offers the question.
   */
  toolName?: string;
  /**
   * Text to select before the census, so selection-only UI (the bubble toolbar) can be inspected.
   * A real DOM range ProseMirror syncs from, as a drag would; the editor is not reachable from
   * `window`.
   */
  selectText?: string;
  /**
   * Every link the draft draws, in order -- the text a reader sees and the address it opens -- and
   * the addresses the link-target bubble shows. Text, because a count cannot tell a link reading
   * `ABC-1` from one reading `<https://...|ABC-1>`.
   */
  links?: { text: string; href: string }[];
  linkTargets?: string[];
  /**
   * Text to type before the census, replacing the selection. Loading a draft rewrites a bare URL
   * into `[url](url)`, one of `slack/url-swallows-next-line`'s repairs and the only warning with
   * per-warning repairs, so a `.dg-warn-fix` is reachable only from a typed URL (`Link` has
   * `autolink: false`). Real input through `WKSession.insertText` (NSResponder's `insertText:`), so
   * it goes through ProseMirror's own input pipeline.
   */
  typeText?: string;
  /**
   * Controls to click before the census, as keys into `OPENABLE` (never selectors), in order: the
   * per-warning repair takes two gestures, unfurl then click, and each step reports its own
   * `reveals`. Not a security boundary: a probe run sets no `DRAFTGATE_DECISION`, so nothing it
   * clicks can approve. The emoji picker's dataset is a dynamic `import()`, so opening it proves
   * `script-src 'self'` admits the chunk. `OpenableKey` is `string`; `probe.test.ts` guards an
   * unknown key.
   */
  clickToOpen?: OpenableKey | OpenableKey[];

  /**
   * Computed styles to assert while `:hover` is forced. Without it every `:hover`, `:disabled` and
   * `:focus-visible` rule is checked only as declared text (`tokens.test.ts`), which cannot see a
   * hover value that draws broken in dark. WebKit cannot force a state, so `wkForceHover`
   * (`injected.cjs`) gives every `:hover` rule a twin keyed on an attribute, at the same specificity
   * and order: the cascade's answer, not a real hover, and `:hover` alone. Read after the resting
   * styles and unforced at once, since forcing changes every later read.
   */
  hoverStyles?: Record<string, Record<string, string>>;
  /** This scenario clicks "Load image" (through `clickToOpen`), so the image assertions flip. */
  loadsImage?: boolean;
  /**
   * A top margin that depends on the block's position, checked by its own labelled check. `jira.css`
   * zeroes the leading block for an enumerated set of types that excludes `table` (a leading list
   * or task list too, as Jira's reader does); `linear.css` puts a leading quote 6px down. `label`
   * names the position per scenario.
   */
  leadingBlock?: { selector: string; marginTop: string; label: string };
  /**
   * A code column in real layout. Jira: the text starts `textAfterWidestNumber` px after the left
   * edge of the widest number's ink (8px either side of the number and 8px to the code, 24), on the
   * torture fixture (one digit) and `jira-code-long` (two, which also checks the tinted column meets
   * the panel's top, bottom and left edges). Slack's and Linear's columns are fixed: the code starts
   * `textInside` px inside the border, plus `ch` characters of the code face for Linear's.
   */
  codeLayout?: { textAfterWidestNumber: number } | { textInside: number; ch?: number };
  /**
   * Every table in real layout: equal columns, as Jira's reader and Linear draw them, and their
   * width. `{ width: 'content' }` is Jira's (the editor's content box); `{ columns: n }` is Linear's
   * (n px whatever their number). `hairline`: the table's own border is one device pixel, on top of
   * Linear's total. Measured, since a computed `100%` says nothing about what it resolved against.
   */
  tableLayout?: { width: 'content' } | { columns: number; hairline?: true };
  /**
   * Every table is wider than the editor and scrolls sideways in its own wrapper, and the draft does
   * not: Linear's `.table-wrapper`. Needs a `viewport` narrower than the table.
   */
  tablesScroll?: true;
  /**
   * The draft is taller than the window, and the full toolbar must stay usable scrolled to its foot:
   * `checkPinnedToolbar`. Needs `PINNED_TOOLBAR`'s draft, whose lines it selects by text.
   */
  pinnedToolbar?: true;
  /**
   * The window's size, when the scenario is about a narrow one. Defaults to `VIEWPORT`.
   */
  viewport?: Viewport;
  /**
   * Gaps between blocks in real layout, `[upper, lower, px]`: the lower box's top minus the upper's
   * bottom, first match of each. A margin is a claim about one box and the gap is what two collapse
   * to, which no computed style can say.
   */
  gaps?: [upper: string, lower: string, px: number][];
  /**
   * Image sources to load in the window, to verify they get through the CSP. One scenario only: it
   * costs a network attempt, and the policy is identical across destinations.
   */
  imageSources?: Record<string, string>;
}

/**
 * Slack's fixture holds no image chrome: `rendersMedia: false` means its editor carries the link
 * Slack renders, and registers no `image` node, so there is nothing to defer. Jira and Linear assert
 * the 1s.
 */
const SLACK_NO_IMAGE = { imgDeferred: 0, imgLoadBtn: 0, imgUrl: 0 } as const;
/** A fence without a language -- in Slack the older plain box, not the card. See `slack-code-plain`. */
const SLACK_PLAIN_FENCE = {
  destination: 'slack',
  canonical: '```\nplain fence, no language\nsecond line\n```\n',
  counts: { prosemirror: 1, pre: 1, blockedBar: 0 },
  codeFont: 'Roboto Mono',
} as const;

/**
 * The fixture's image warning is silenced on Slack: `slack/image-becomes-link` fires on the agent's
 * `![x](url)` and not on the body sent, which the round trip rewrites to `[x](url)`. The everyday
 * case of this chrome, beside `jira-silenced`. Only for the Slack scenarios that unfurl: the heading
 * and the row exist only once the list is open.
 */
const SLACK_SILENCED = { changed: 1, silencedHead: 1, silencedRow: 1 } as const;

/** A blocked draft says so and refuses to be approved, with the reason on screen. */
const BLOCKED_CHROME: Record<string, number> = {
  prosemirror: 1,
  blockedBar: 1,
  approveDisabled: 1,
  warnRow: 1,
};

/**
 * Jira's dark palette, merged over the light census by `jira-dark` and asserted alone by
 * `jira-theme-toggle`, which arrives in dark by clicking.
 */
const JIRA_DARK_STYLES: Record<string, Record<string, string>> = {
    // --ds-surface #1F1F21 and --ds-background-accent-gray-subtlest #303134 (light: 255,255,255 /
    // 240,241,242). The border is --ds-background-accent-gray-subtler #4B4D51, the renderer's opaque
    // cell border: the one place the switch away from the translucent --ds-border shows.
    '.ProseMirror td': { backgroundColor: 'rgb(31, 31, 33)', borderTopColor: 'rgb(75, 77, 81)' },
    '.ProseMirror th': { backgroundColor: 'rgb(48, 49, 52)', borderTopColor: 'rgb(75, 77, 81)' },
    '.ProseMirror input[type=checkbox]': { backgroundColor: 'rgb(126, 129, 136)' },
    '.ProseMirror input[type=checkbox]:checked': { backgroundColor: 'rgb(102, 157, 241)' },
    // --ds-link #669DF1: the light value 24,104,219 is unreadable on this surface.
    '.ProseMirror a': { color: 'rgb(102, 157, 241)' },
    // --ds-border #E3E4F21F, still translucent; a flattened #dddee1 is a near-white line on #1F1F21.
    '.ProseMirror blockquote': { borderLeftColor: 'rgba(227, 228, 242, 0.12)' },
    // --ds-text-subtlest #96999E, on the line-number column, and the column's tint follows the
    // theme: --ds-background-neutral #CECED912.
    '.ProseMirror .dg-linenos': { color: 'rgb(150, 153, 158)', backgroundColor: 'rgba(206, 206, 217, 0.07)' },
    // The inline-code chip follows the theme: --ds-background-neutral #CECED912 in dark.
    '.ProseMirror :not(pre) > code': { backgroundColor: 'rgba(206, 206, 217, 0.07)' },
    // The dark code panel is MEASURED, #333337: logged-in Jira's, the same over two grounds, so
    // opaque, and no token has it. Light is the reader's token, rgba(5, 21, 36, 0.06).
    '.ProseMirror pre': { backgroundColor: 'rgb(51, 51, 55)' },
    // Jira's dark brand button is a light blue (#669DF1) with --ds-text-inverse #1F1F21, dark, text.
    '.dg-btn-primary': { backgroundColor: 'rgb(102, 157, 241)', color: 'rgb(31, 31, 33)' },
    '.dg-compose': { borderTopColor: 'rgb(126, 129, 136)' },
    // The footer's warning row inherits `.dg-hint`'s ink, which is themed.
    '.dg-warnbar-msg': { color: 'rgb(206, 207, 210)' },
};

/*
 * The Slack mention token, from Slack's own `.p-rich_text_slug` values. `dg-mtok` is the ordinary
 * mention, Slack's `--link`; the broadcast variant is Slack's `--mention` highlight, used when the
 * mention includes the reader, as a channel-wide ping always includes the sender. MEASURED out of
 * the engine; `#36c5f021` is 8-digit hex with alpha.
 */
const SLACK_TOKEN_LIGHT = {
  backgroundColor: 'rgba(54, 197, 240, 0.13)',
  color: 'rgb(18, 100, 163)',
  borderRadius: '3px',
} as const;

/** Dark, measured. The user token keeps Slack's `--link` pair; only the palette moves. */
const SLACK_TOKEN_DARK = {
  backgroundColor: 'rgba(3, 102, 150, 0.25)',
  color: 'rgb(43, 165, 206)',
} as const;
/** Dark broadcast: Slack's `--mention` sets both colours here, unlike light. */
const SLACK_BROADCAST_DARK = {
  backgroundColor: 'rgba(160, 115, 0, 0.18)',
  color: 'rgb(222, 167, 0)',
} as const;

/*
 * `@atlaskit/mention`'s default state, as the engine computes it from `jira.css`. MEASURED: the
 * tokens are 8-digit hex with alpha (`#0515240F`), and the engine's rounding is not predicted.
 * The self state (`--ds-background-brand-bold`) is not drawn; see the mention rule in `jira.css`.
 */
const MENTION_CHIP_LIGHT = {
  backgroundColor: 'rgba(5, 21, 36, 0.06)',
  color: 'rgb(80, 82, 88)',
  borderRadius: '20px',
  display: 'inline',
  cursor: 'auto',
} as const;
const MENTION_CHIP_DARK = {
  backgroundColor: 'rgba(206, 206, 217, 0.07)',
  color: 'rgb(169, 171, 175)',
  borderRadius: '20px',
} as const;

/**
 * The tables of a live Linear capture (2, 4 and 6 columns, and a long word in a long header's
 * table), with a paragraph after them so the gap below a table has something to measure.
 */
const LINEAR_TABLES_BODY =
  'Linear tables\n\n' +
  '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n' +
  '| one | two | three | four |\n| --- | --- | --- | --- |\n| a | b | c | d |\n\n' +
  '| c1 | c2 | c3 | c4 | c5 | c6 |\n| --- | --- | --- | --- | --- | --- |\n| x | y | z | x | y | z |\n\n' +
  '| short | a much much longer header cell than the other one |\n| --- | --- |\n' +
  '| averyveryverylongunbreakablewordinacellthatgoesonandon | b |\n\n' +
  'A paragraph after the tables.\n';
/** A labelled and a bare link to a Linear profile, for `linear-profile-links`. */
const PROFILE_LINKS_BODY =
  'Hi [Jane](https://linear.app/acme/profiles/jane) and https://linear.app/acme/profiles/jane.doe today.\n';

/**
 * A draft several windows tall, with one line to format at its foot and one to put the caret in
 * halfway down (`checkPinnedToolbar`). It ends in a code block taller than the window, so the code
 * lies under the toolbar at the foot: Slack's line numbers are `position: sticky` at `z-index: 1`,
 * the highest positioned box a draft draws. Its first line triggers `link/text-host-mismatch`, a
 * non-blocking warning on every destination, so the list has something to unfurl over the toolbar.
 */
const PINNED_LAST = 'The closing line to format.';
const PINNED_MIDDLE = 'The midway line for the caret.';
/** How many lines the ArrowUp check climbs, from that many lines below `PINNED_MIDDLE` onto it. */
const ARROW_UPS = 3;
/** `PINNED_MIDDLE` is line 41, so the line `ARROW_UPS` below it is `41 + ARROW_UPS`. */
const PINNED_BELOW_MIDDLE = `Line ${41 + ARROW_UPS} of`;
const PINNED_LINES = (n: number, from: number) =>
  Array.from({ length: n }, (_, i) => `Line ${from + i} of a draft taller than the window.`);
const PINNED_TOOLBAR = {
  canonical: [
    'See [example.com](https://example.org/) for the details.',
    ...PINNED_LINES(40, 1),
    PINNED_MIDDLE, // line 41
    ...PINNED_LINES(30, 42),
    '```ts\n' + Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n```',
    PINNED_LAST,
  ].join('\n\n') + '\n',
  counts: { prosemirror: 1, toolbar: 1, pre: 1 },
  pinnedToolbar: true,
} as const;
const LINEAR_TABLES = {
  destination: 'linear',
  canonical: LINEAR_TABLES_BODY,
  counts: { prosemirror: 1, table: 4, th: 14, td: 14 },
  tableLayout: { columns: 720, hairline: true },
} as const;

export const SCENARIOS: Record<string, Scenario> = {
  /*
   * The full toolbar over a draft taller than the window, one per destination sheet
   * (`checkPinnedToolbar`); the plain-body scenarios pin `toolbar: 0`. First because they are the
   * longest and workers take scenarios in order, so they overlap the rest of the run.
   */
  'jira-pinned-toolbar': { ...PINNED_TOOLBAR, destination: 'jira' },
  'slack-pinned-toolbar': { ...PINNED_TOOLBAR, destination: 'slack' },
  'linear-pinned-toolbar': { ...PINNED_TOOLBAR, destination: 'linear' },
  'github-pinned-toolbar': { ...PINNED_TOOLBAR, destination: 'github' },
  /*
   * The destination was a guess, and the window says so without moving anything: `.dg-inferred` is
   * an extra flex item in `.dg-header`, which has no `flex-wrap`, so the 47px header (pinned here,
   * as this scenario does not check styles) catches it wrapping. Its colours are the warning
   * palette, not error: an inferred route is what lets an unconfigured connector be reviewed.
   */

  'slack-inferred': {
    destination: 'slack',
    toolName: 'mcp__some_other_server__slack_send_message',
    routeInferred: { matchedEntry: 'mcp__claude_ai_Slack__slack_send_message' },
    canonical: 'Deploy is done, all green.\n',
    counts: { prosemirror: 1, inferred: 1, warnRow: 0 },
    styles: {
      '.dg-header': SHARED_STRUCTURE['.dg-header'],
      // Slack's own warning ink, not Jira's.
      '.dg-inferred': { backgroundColor: 'rgb(255, 248, 230)', color: 'rgb(127, 95, 1)' },
    },
  },
  /*
   * Slack's plain-text tokens: five written, four marked, the fifth inside a code span, which
   * `mentionPills` skips structurally (Slack renders it as characters). Jira has no token patterns
   * (`mtok: 0` on its scenarios; `mentionTokens.test.ts` pins which destinations declare
   * `mentions.tokens`); Linear's token is `linear-mentions`.
   */
  'slack-mentions': {
    destination: 'slack',
    canonical:
      'Heads up <@U0123ABCDEF> and <!here>, see <#C0456GHIJ|random> and ' +
      '<!subteam^S0123ABC|@support>. Not a token in code: `<@U0123ABCDEF>`.\n',
    counts: {
      prosemirror: 1,
      // An ordinary configured route draws no inferred chip.
      inferred: 0,
      mention: 0,
      mtok: 4,
      mtokBroadcast: 1,
      warnRow: 0,
      mentionsNote: 1,
      mentionsDetail: 1,
    },
    styles: { '.dg-mtok-user': SLACK_TOKEN_LIGHT },
    // The detail is in the unfurled panel; with no warning on this draft, the note is its toggle.
    clickToOpen: 'mentions',
  },
  /*
   * The dark Slack token. The broadcast variant sets `color` only under `[data-theme="dark"]`,
   * mirroring Slack, whose light `--mention` sets a ground and lets the ink fall through.
   */
  'slack-mentions-dark': {
    destination: 'slack',
    theme: 'dark',
    canonical: 'Heads up <@U0123ABCDEF> and <!here>, please look.\n',
    counts: { prosemirror: 1, mtok: 2, mtokBroadcast: 1, warnRow: 0, mentionsNote: 1 },
    styles: {
      '.dg-mtok-user': SLACK_TOKEN_DARK,
      '.dg-mtok-broadcast': SLACK_BROADCAST_DARK,
    },
  },
  /*
   * Linear's token: its own typography, not Slack's pill. `fontWeight: 500` is Linear's
   * `--font-weight-medium`, from its editor CSS. The pattern matches on shape alone (`@todo` is
   * marked too), so it draws as bold prose: transparent ground, `0px` radius.
   */
  'linear-mentions': {
    destination: 'linear',
    canonical: 'Heads up @ada.lovelace, and not an address: someone@example.com.\n',
    counts: { prosemirror: 1, mention: 0, mtok: 1, mtokBroadcast: 0, warnRow: 0, mentionsNote: 1 },
    styles: {
      '.dg-mtok': {
        fontWeight: '500',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        borderRadius: '0px',
        // The prose's ink: Linear's mention differs by weight alone.
        color: 'rgb(40, 42, 48)',
      },
    },
  },
  /*
   * A Linear profile link, labelled and bare: Linear turns both into a mention drawn `@<display
   * name>` (probed), so the window draws both as Linear's mention -- the token's weight and the
   * prose's ink rather than the link colour, behind Linear's `@`. The window cannot know the
   * display name, so the bare URL shows its slug and the address in front of it is not drawn.
   * Both are still links (`link: 2`), and the strip counts two mentions.
   */
  'linear-profile-links': {
    destination: 'linear',
    canonical: PROFILE_LINKS_BODY,
    counts: { prosemirror: 1, link: 2, mlinkStart: 2, mlinkHidden: 1, mention: 0, warnRow: 0, mentionsNote: 1, mentionsDetail: 1 },
    styles: {
      '.dg-mlink-start': { fontWeight: '500', color: 'rgb(40, 42, 48)' },
      '.dg-mlink-start::before': { content: '"@"' },
      '.dg-mlink-hidden': { display: 'none' },
    },
    clickToOpen: 'mentions',
  },
  /*
   * A mention chip, which no other scenario contains. Jira is the only destination with a `mention`
   * node (`mentions.chips`, gating `decodeMentions`; `tokens.test.ts` asserts it). `cursor: auto` is
   * asserted because upstream's `mention-style.js` declares `pointer` and this window drops it.
   */
  'jira-mention': {
    destination: 'jira',
    canonical: 'Hi [@Ada Lovelace](mention:712020:5e0c4a1b-8d2f-4c3a-9b7e-1f6a2d8c4e90), can you take a look?\n',
    counts: { prosemirror: 1, mention: 1, mtok: 0, warnRow: 0, mentionsNote: 1 },
    styles: { 'span[data-type="mention"]': MENTION_CHIP_LIGHT },
    hoverStyles: { '.ProseMirror span[data-type="mention"]': { backgroundColor: 'rgba(11, 18, 14, 0.14)' } },
  },
  // The dark chip: a token present in one generated palette only fails here.
  'jira-mention-dark': {
    destination: 'jira',
    theme: 'dark',
    canonical: 'Hi [@Ada Lovelace](mention:712020:5e0c4a1b-8d2f-4c3a-9b7e-1f6a2d8c4e90), can you take a look?\n',
    counts: { prosemirror: 1, mention: 1, mtok: 0, warnRow: 0, mentionsNote: 1 },
    styles: { 'span[data-type="mention"]': MENTION_CHIP_DARK },
    hoverStyles: { '.ProseMirror span[data-type="mention"]': { backgroundColor: 'rgba(227, 228, 242, 0.12)' } },
  },

  jira: {
    // MEASURED under a forced `:hover`, Jira light. See `Scenario.hoverStyles`.
    hoverStyles: {
      '.dg-btn-primary': { backgroundColor: 'rgb(21, 88, 188)', borderColor: 'rgb(21, 88, 188)' },
      '.dg-theme-toggle': { backgroundColor: 'rgba(5, 21, 36, 0.06)' },
      '.dg-tb-btn': { backgroundColor: 'rgba(5, 21, 36, 0.06)' },
      '.ProseMirror a': { textDecorationLine: 'none' },
    },
    destination: 'jira',
    canonical: FIXTURE,
    counts: FIXTURE_COUNTS,
    checkStyles: true,
    codeLayout: { textAfterWidestNumber: 24 },
    tableLayout: { width: 'content' },
    // Atlassian Sans is proprietary and cannot be bundled, so Jira falls back; resolving would mean
    // a font shipped without the right to.
    fontFamily: { family: 'Atlassian Sans', resolves: false },
    imageSources: {
      // A 1x1 red PNG: inline, so the assertion on it is network-independent.
      dataUri:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      https: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
    },
  },
  slack: {
    // MEASURED under a forced `:hover`, Slack light. See `Scenario.hoverStyles`.
    hoverStyles: {
      '.dg-btn-primary': { backgroundColor: 'rgb(0, 122, 90)', borderColor: 'rgb(0, 122, 90)' },
      '.dg-theme-toggle': { backgroundColor: 'rgba(29, 28, 29, 0.22)' },
      '.dg-tb-btn': { backgroundColor: 'rgba(29, 28, 29, 0.22)' },
      '.ProseMirror a': { textDecorationLine: 'underline' },
    },
    destination: 'slack',
    canonical: FIXTURE,
    // Unfurled for the hairline between two rows: one live (`slack/heading-level-collapsed`), one
    // silenced (`slack/image-becomes-link`), with the silenced heading between them (hence `~`).
    clickToOpen: 'warnings',
    // 8 shapes: Slack's official mark is an eight-path, four-colour pinwheel.
    // tbOption 4 = Normal + Heading 1-3: the levels a Slack reader can tell apart. The live DOM
    // shows two sizes but three renderings (`#` 18px/900, `##` 15px/900, `###`..`######` 15px/700).
    counts: { ...FIXTURE_COUNTS, ...SLACK_NO_IMAGE, ...SLACK_SILENCED, markShape: 8, tbOption: 4 },
    checkStyles: true,
    // Slack's own face, bundled (OFL-1.1) and self-hosted.
    fontFamily: { family: 'Lato', resolves: true, italic: true },
    codeFont: 'Roboto Mono',
  },
  linear: {
    // MEASURED under a forced `:hover`, Linear light. See `Scenario.hoverStyles`.
    hoverStyles: {
      '.dg-btn-primary': { backgroundColor: 'rgb(137, 137, 240)', borderColor: 'rgb(137, 137, 240)' },
      '.dg-theme-toggle': { backgroundColor: 'rgb(249, 248, 249)' },
      '.dg-tb-btn': { backgroundColor: 'rgb(249, 248, 249)' },
      '.ProseMirror a': { textDecorationLine: 'underline' },
    },
    destination: 'linear', canonical: FIXTURE,
    // No warning on Linear: see `FIXTURE_COUNTS.warnRow`.
    counts: { ...FIXTURE_COUNTS, warnRow: 0 }, checkStyles: true,
    fontFamily: { family: 'Inter Variable', resolves: true, drawnAs: 'Inter', italic: true },
    tableLayout: { columns: 720, hairline: true },
    // The fixture's two-line block: one digit in a column two digits wide, as Linear draws it.
    codeLayout: { textInside: 36, ch: 2 },
  },
  /*
   * GitHub on the full torture draft, in light. `warnRow: 1`: the image earns
   * `github/image-proxied`, and nothing else in the fixture warns. The image is drawn
   * (`rendersMedia: true`), so the deferred-image chrome is present.
   */
  github: {
    // MEASURED under a forced `:hover`, GitHub light. The link stays underlined, unlike every other
    // destination.
    hoverStyles: {
      '.dg-btn-primary': { backgroundColor: 'rgb(28, 129, 57)', borderColor: 'rgb(28, 129, 57)' },
      '.ProseMirror a': { textDecorationLine: 'underline' },
    },
    destination: 'github',
    // GitHub's own routing fields: Jira's context under GitHub's sheet is a strip nobody sees.
    context: { owner: 'Jakuboola', repo: 'draftgate', issue_number: 30 },
    canonical: FIXTURE,
    counts: { ...FIXTURE_COUNTS, warnRow: 1 },
    checkStyles: true,
    // GitHub's stack names "Mona Sans VF" first and loads nothing for it; the system face draws
    // the comment.
    fontFamily: { family: 'Mona Sans VF', resolves: false },
  },
  // GitHub in dark, from the theme sheets github.com serves (`dark-<hash>.css`), read by the same
  // ruler run as the light ones.
  'github-dark': {
    destination: 'github',
    theme: 'dark',
    context: { owner: 'Jakuboola', repo: 'draftgate', issue_number: 30 },
    canonical: FIXTURE,
    counts: { ...FIXTURE_COUNTS, warnRow: 1 },
    // The light map's geometry, with this block's colours over it, as `jira-dark` and the rest do.
    checkStyles: true,
    styles: {
      '.ProseMirror p': { color: 'rgb(240, 246, 252)' },
      // `--fgColor-accent` is a different hue in dark (#4493f8 against #0969da).
      '.ProseMirror a': { color: 'rgb(68, 147, 248)', textDecorationLine: 'underline' },
      '.ProseMirror pre': { backgroundColor: 'rgb(21, 27, 35)' },
      '.ProseMirror td': { borderTopColor: 'rgb(61, 68, 77)' },
      '.ProseMirror hr': { backgroundColor: 'rgb(61, 68, 77)' },
      // Primer's checkbox in dark.
      '.ProseMirror input[type=checkbox]': { borderTopColor: 'rgb(101, 108, 118)', backgroundColor: 'rgb(13, 17, 23)' },
      '.ProseMirror input[type=checkbox]:checked': { backgroundColor: 'rgb(31, 111, 235)' },
      // And the chrome: GitHub's dark primary green is #238636, not the light #1f883d.
      '.dg-btn-primary': { backgroundColor: 'rgb(35, 134, 54)' },
    },
  },
  // Jira in dark: every value is `tools/atlassian-tokens/tokens.json`'s dark column.
  'jira-dark': {
    // MEASURED under a forced `:hover`, Jira dark. See `Scenario.hoverStyles`.
    hoverStyles: {
      '.dg-btn-primary': { backgroundColor: 'rgb(143, 184, 246)', borderColor: 'rgb(143, 184, 246)' },
      '.dg-theme-toggle': { backgroundColor: 'rgba(206, 206, 217, 0.07)' },
      '.dg-tb-btn': { backgroundColor: 'rgba(206, 206, 217, 0.07)' },
      '.ProseMirror a': { textDecorationLine: 'none' },
    },
    destination: 'jira',
    theme: 'dark',
    canonical: FIXTURE,
    counts: FIXTURE_COUNTS,
    // The light census too: the dark block changes only colour.
    checkStyles: true,
    styles: JIRA_DARK_STYLES,
  },
  /*
   * Linear in dark: every value is `tools/linear-tokens/tokens.json`'s dark column (from Linear's
   * site), bar the task box's, read off a dark capture, and each is one the light scenario asserts.
   */
  'linear-dark': {
    // MEASURED under a forced `:hover`, Linear dark. See `Scenario.hoverStyles`.
    hoverStyles: {
      '.dg-btn-primary': { backgroundColor: 'rgb(130, 143, 255)', borderColor: 'rgb(130, 143, 255)' },
      '.dg-theme-toggle': { backgroundColor: 'rgb(28, 28, 31)' },
      '.dg-tb-btn': { backgroundColor: 'rgb(28, 28, 31)' },
      '.ProseMirror a': { textDecorationLine: 'underline' },
    },
    destination: 'linear',
    theme: 'dark',
    canonical: FIXTURE,
    // Clean on Linear; see `FIXTURE_COUNTS.warnRow`.
    counts: { ...FIXTURE_COUNTS, warnRow: 0 },
    checkStyles: true,
    fontFamily: { family: 'Inter Variable', resolves: true, drawnAs: 'Inter', italic: true },
    styles: {
      // --color-text-primary #f7f8f8, against the light scenario's rgb(40,42,48).
      '.ProseMirror p': { color: 'rgb(247, 248, 248)' },
      // --color-link-primary #828fff: Linear's link colour moves between themes.
      '.ProseMirror a': { color: 'rgb(130, 143, 255)' },
      // --color-border-primary #23252a, on the code block and the cells, and the numbers in dark's
      // --editor-label-faint.
      '.ProseMirror pre': { borderTopColor: 'rgb(35, 37, 42)' },
      '.ProseMirror .dg-linenos': { color: 'rgb(92, 92, 96)' },
      '.ProseMirror td': { borderTopColor: 'rgb(35, 37, 42)' },
      '.ProseMirror blockquote': { color: 'rgb(247, 248, 248)' },
      '.ProseMirror blockquote::before': { backgroundColor: 'rgb(35, 37, 42)' },
      // The box's two runtime values move with the theme: the border and the done text's opacity,
      // read off a dark-theme capture. The checked fill is the text colour.
      '.ProseMirror input[type=checkbox]': { borderTopColor: 'rgb(92, 92, 96)' },
      '.ProseMirror input[type=checkbox]:checked': { backgroundColor: 'rgb(247, 248, 248)' },
      '.ProseMirror li[data-checked="true"] > div > p': { opacity: '0.685' },
      // --color-brand-bg is #5e6ad2 in dark, #7070ff in light: one hue, and the theme decides.
      '.dg-btn-primary': { backgroundColor: 'rgb(94, 106, 210)' },
      '.dg-compose': { borderTopColor: 'rgb(35, 37, 42)' },
    },
  },
  // Slack in dark: every value is `tools/slack-tokens/tokens.json`'s dark column, and each is one the
  // light scenario asserts.
  'slack-dark': {
    // MEASURED under a forced `:hover`, Slack dark. See `Scenario.hoverStyles`.
    hoverStyles: {
      '.dg-btn-primary': { backgroundColor: 'rgb(23, 126, 86)', borderColor: 'rgb(23, 126, 86)' },
      '.dg-theme-toggle': { backgroundColor: 'rgba(248, 248, 248, 0.08)' },
      '.dg-tb-btn': { backgroundColor: 'rgba(248, 248, 248, 0.08)' },
      '.ProseMirror a': { textDecorationLine: 'underline' },
    },
    destination: 'slack',
    theme: 'dark',
    canonical: FIXTURE,
    // Unfurled for the warning-row hairline, as in light.
    clickToOpen: 'warnings',
    counts: { ...FIXTURE_COUNTS, ...SLACK_NO_IMAGE, ...SLACK_SILENCED, markShape: 8, tbOption: 4 },
    checkStyles: true,
    fontFamily: { family: 'Lato', resolves: true, italic: true },
    codeFont: 'Roboto Mono',
    styles: {
      // content-pry #f8f8f8, against the light scenario's rgb(29,28,29).
      '.ProseMirror p': { color: 'rgb(248, 248, 248)' },
      // The checklist box is drawn in the text colour.
      '.ProseMirror input[type=checkbox]': { backgroundColor: 'rgb(248, 248, 248)' },
      // content-hgl-1 #2ba5ce -- Slack moves its link colour between themes.
      '.ProseMirror a': { color: 'rgb(43, 165, 206)' },
      // The card's dark ground is base-ter #212428 (`.sk-client-theme--dark .container__*`), not
      // base-sec, the pane's own #1a1d21.
      '.ProseMirror pre': {
        backgroundColor: 'rgb(33, 36, 40)',
        boxShadow: 'rgba(248, 248, 248, 0.06) 0px 0px 0px 1px inset',
      },
      '.ProseMirror pre[data-language]::before': { color: 'rgb(121, 124, 129)' },
      '.ProseMirror .dg-linenos': { color: 'rgb(185, 186, 189)' },
      // Slack's green is #3daa7c in dark, not light's #007a5a.
      '.dg-btn-primary': { backgroundColor: 'rgb(61, 170, 124)' },
      // The warning-row hairline, dark.
      '.dg-warn ~ .dg-warn': { borderTopColor: 'rgba(227, 228, 242, 0.12)' },
    },
  },
  /*
   * The theme switcher, clicked: starting in light, one click must land the root on
   * `data-theme="dark"` and the sheets must follow (Jira's dark palette). The light census it would
   * repeat is `jira`'s and `jira-dark`'s.
   */
  'jira-theme-toggle': {
    destination: 'jira',
    theme: 'light',
    canonical: FIXTURE,
    clickToOpen: 'themeToggle',
    counts: FIXTURE_COUNTS,
    styles: JIRA_DARK_STYLES,
  },
  /*
   * The selection toolbar, one scenario per destination (`bubble: 0` at rest elsewhere). The button
   * set is identical for all three; the border and radius distinguish the sheets, whose grounds are
   * all white in light. Each asserts the bubble only; the census is its base scenario's.
   */
  'jira-toolbar': {
    destination: 'jira',
    canonical: FIXTURE,
    // Plain, unmarked prose: five buttons offered, none of them active.
    selectText: 'Short para',
    counts: { ...FIXTURE_COUNTS, bubble: 1, bubbleBtn: 5, bubbleActive: 0 },
    styles: {
      // Generated Atlassian tokens: --ds-surface #FFFFFF, --ds-text #292A2E, --ds-border #0B120E24
      // (translucent), and --ds-radius-small 3px.
      '.dg-bubble': {
        backgroundColor: 'rgb(255, 255, 255)',
        color: 'rgb(41, 42, 46)',
        borderTopColor: 'rgba(11, 18, 14, 0.14)',
        borderRadius: '3px',
      },
    },
  },
  'slack-toolbar': {
    destination: 'slack',
    canonical: FIXTURE,
    // Inside the `**bold**` run, so exactly one toggle reports `aria-pressed`.
    selectText: 'bold',
    // Unfurled as in `slack`; the overlay is `z-index: 10` and the bubble 20, so the selection holds.
    clickToOpen: 'warnings',
    counts: {
      ...FIXTURE_COUNTS, ...SLACK_NO_IMAGE, ...SLACK_SILENCED,
      markShape: 8, tbOption: 4, bubble: 1, bubbleBtn: 5, bubbleActive: 1,
    },
    styles: {
      '.dg-bubble': {
        backgroundColor: 'rgb(255, 255, 255)',
        color: 'rgb(29, 28, 29)',
        // Slack's own `otl-ter` #5e5d6021, not the text colour at 13%: a different grey, same alpha.
        borderTopColor: 'rgba(94, 93, 96, 0.13)',
        borderRadius: '6px',
      },
    },
  },
  'linear-toolbar': {
    destination: 'linear',
    canonical: FIXTURE,
    selectText: 'Short para',
    counts: { ...FIXTURE_COUNTS, warnRow: 0, bubble: 1, bubbleBtn: 5, bubbleActive: 0 },
    styles: {
      // Generated from Linear's own CSS: --color-bg-primary, --color-text-primary,
      // --color-border-primary.
      '.dg-bubble': {
        backgroundColor: 'rgb(255, 255, 255)',
        color: 'rgb(40, 42, 48)',
        borderTopColor: 'rgb(233, 232, 234)',
        borderRadius: '6px',
      },
    },
  },
  /*
   * A link whose text is one host and whose target another, with the caret in it. Linear, so the
   * target bubble is held to `linear-toolbar`'s palette. `warnRow: 1` is `link/text-host-mismatch`.
   */
  'linear-link-target': {
    destination: 'linear',
    canonical: 'Reset here: [https://id.example.org/reset](https://id-example.evil.test/reset) today.\n',
    selectText: 'id.example.org',
    counts: {
      prosemirror: 1, warnRow: 1, bubble: 1, linkTarget: 1, linkTargetUrl: 1, titledLink: 1,
      // A warning, not a block, and the reviewer has not edited anything.
      blockedBar: 0, approveDisabled: 0, edited: 0,
    },
    styles: {
      '.dg-linktarget': {
        backgroundColor: 'rgb(255, 255, 255)',
        color: 'rgb(40, 42, 48)',
        borderTopColor: 'rgb(233, 232, 234)',
        borderRadius: '6px',
      },
      // The whole href, broken anywhere rather than elided: `.dg-img-url`'s rule, for its reason.
      '.dg-linktarget-url': { wordBreak: 'break-all' },
    },
  },
  /*
   * Slack's own link, `<url|label>`, drawn as Slack draws it: a link reading the label, its
   * characters as written (`*bold* _it_` is not formatted inside a label, PROBED), and the real
   * address one caret away. `warnRow: 1` is `link/text-host-mismatch` on the third, a label that is
   * another address.
   */
  'slack-angle-links': {
    destination: 'slack',
    canonical:
      'Update: <https://e.test/issue/ABC-1/some-slug|ABC-1> is done, see ' +
      '<https://example.com/b|*bold* _it_ label> and <https://example.com/d|https://other.example.org/login>.\n',
    selectText: 'ABC-1',
    counts: {
      prosemirror: 1, angleLink: 3, warnRow: 1, bubble: 1, linkTarget: 1, linkTargetUrl: 1,
      blockedBar: 0, approveDisabled: 0, edited: 0, changed: 0,
    },
    links: [
      { text: 'ABC-1', href: 'https://e.test/issue/ABC-1/some-slug' },
      { text: '*bold* _it_ label', href: 'https://example.com/b' },
      { text: 'https://other.example.org/login', href: 'https://example.com/d' },
    ],
    linkTargets: ['https://e.test/issue/ABC-1/some-slug'],
  },
  /*
   * The emoji picker, opened for real: its dataset is a dynamic import, so this proves
   * `script-src 'self'` admits the chunk. The count is a floor (`-500`): the real Unicode set moves.
   */
  'jira-emoji': {
    destination: 'jira',
    canonical: FIXTURE,
    clickToOpen: 'emoji',
    counts: { ...FIXTURE_COUNTS, emojiBtn: -500 },
  },
  /*
   * A warning that names a repair, and the repair offered: `slack/url-swallows-next-line` names two
   * repairs, so two buttons, and clicking one opens the before/after preview a blocked draft's fix
   * opens. The counts are taken after the click, the warning still there. Applying one is
   * `warnFixApprove` in `e2e.ts`.
   */
  'slack-warn-fix': {
    destination: 'slack',
    // Typed, not loaded: loading would rewrite the URL into one of the warning's own repairs (see
    // `Scenario.typeText`). `PLACEHOLDER` is selected and replaced to put the caret at the end of
    // the first line. The warning arrives rather than loads, so it is withheld for `SETTLE_MS`.
    canonical: 'PLACEHOLDER\nNext sentence here.\n',
    selectText: 'PLACEHOLDER',
    typeText: 'See https://example.org',
    clickToOpen: ['warnings', 'warnFix'],
    counts: { prosemirror: 1, warn: 1, warnFix: 2, modal: 1, blockedBar: 0 },
  },
  /*
   * The reviewer asking for a remote image, the only thing that fetches one: the deferral is a
   * delay, not a refusal. `img: 1` here pairs with `img: 0` in the default scenarios.
   */
  'jira-image-load': {
    destination: 'jira',
    canonical: 'A remote image: ![diagram](https://example.com/a.png)\n',
    clickToOpen: 'imageLoad',
    loadsImage: true,
    counts: { prosemirror: 1, img: 1, imgDeferred: 0, blockedBar: 0, approveDisabled: 0 },
    // The same detached-load census as `jira`, confirming the CSP permits what the window defers.
    imageSources: {
      dataUri:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      https: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
    },
  },
  // Toggling a task checkbox. The trap: a `taskItem > text` from `core` is invalid under the
  // editor's schema, so ProseMirror throws `Invalid content for node type taskItem` out of the
  // MutationObserver, the box shows ticked, no transaction happens, and Approve sends it unchecked.
  // So: ticked (`checked: 2`), edited, and still two checkboxes. The payload half is `e2e.ts`.
  'jira-task-toggle': {
    destination: 'jira',
    canonical: '- [ ] one\n- [x] two\n',
    clickToOpen: 'taskCheckbox',
    counts: {
      prosemirror: 1, checkbox: 2, checked: 2, edited: 1,
      blockedBar: 0, approveDisabled: 0,
    },
  },
  /*
   * A ten-line fence, so Jira's number column holds two digits: the reader's column grows with its
   * widest number (31.36px in with one digit, 38.69px with two, live). Its ninth line is far wider
   * than the pane, so under TipTap's `pre-wrap` the tenth number sits a row above its line.
   */
  'jira-code-long': {
    destination: 'jira',
    canonical:
      '```python\n' +
      Array.from({ length: 10 }, (_, i) => (i === 8 ? `x8 = "${'y'.repeat(240)}"` : `x${i} = ${i}`)).join('\n') +
      '\n```\n',
    counts: { prosemirror: 1, pre: 1, lineno: 10, blockedBar: 0 },
    codeLayout: { textAfterWidestNumber: 24 },
  },
  // Four lines, one blank (still numbered), all on screen, so the numbers' alignment with their
  // lines shows past the first.
  'slack-code': {
    destination: 'slack',
    canonical: '```python\ndef foo(x: int) -> str:\n    return f"{x}"\n\nprint(foo(1))\n```\n',
    counts: { prosemirror: 1, pre: 1, lineno: 4, blockedBar: 0 },
    codeFont: 'Roboto Mono',
    // The code's first glyph in real layout: inside the 8px transparent border (the wrapper's
    // padding), the card's 1px border, the pre's 8px, the 35px number and its 10px margin.
    codeLayout: { textInside: 54 },
  },
  /*
   * Eleven lines (two digits) and one far wider than the card. Slack's number column is a fixed
   * 35px, so the code starts where it does with one digit, and the long line scrolls rather than
   * wrapping, keeping each number beside its line.
   */
  'slack-code-long': {
    destination: 'slack',
    canonical:
      '```js\n' +
      Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join('\n') +
      `\nconst long = "${'x'.repeat(240)}";\n` +
      '```\n',
    counts: { prosemirror: 1, pre: 1, lineno: 11, blockedBar: 0 },
    codeFont: 'Roboto Mono',
    codeLayout: { textInside: 54 },
    styles: { '.ProseMirror pre code': { whiteSpace: 'pre' } },
  },
  /*
   * Ten lines, so two digits, and the last far wider than the pane, the shape of a live capture.
   * Linear's column is two digits wide either way, so the code starts where it does in the
   * fixture's two-line block; and the long line scrolls, so the tenth number stays beside it. The
   * block sits 22px from the paragraphs either side, as the capture measures.
   */
  'linear-code-long': {
    destination: 'linear',
    canonical:
      'A paragraph before the block.\n\n```js\n' +
      Array.from({ length: 9 }, (_, i) => `const v${i} = ${i};`).join('\n') +
      `\nconst long = "${'x'.repeat(240)}";\n` +
      '```\n\nA paragraph after the block.\n',
    counts: { prosemirror: 1, pre: 1, lineno: 10, blockedBar: 0 },
    codeLayout: { textInside: 36, ch: 2 },
    gaps: [
      ['.ProseMirror > p', '.ProseMirror > pre', 22],
      ['.ProseMirror > pre', '.ProseMirror > pre + p', 22],
    ],
  },
  /*
   * A fence without a language, which in Slack is the older `.c-mrkdwn__pre` box: 8px of padding, a
   * 1px border, a 4px radius, no header and no line numbers (measured on a live Slack client). The
   * node view still builds the gutter, so the assertion is that it is not drawn.
   */

  'slack-code-plain': {
    ...SLACK_PLAIN_FENCE,
    styles: {
      '.ProseMirror pre': {
        paddingTop: '8px',
        paddingLeft: '8px',
        borderTopWidth: '1px',
        borderTopLeftRadius: '4px',
        // Light uses the sheet's base-sec and otl-ter tokens here -- UNMEASURED.
        backgroundColor: 'rgb(248, 248, 248)',
        borderTopColor: 'rgba(94, 93, 96, 0.13)',
      },
      '.ProseMirror pre::before': { content: 'none' },
      '.ProseMirror .dg-linenos': { display: 'none' },
    },
  },
  // Its dark pair is the live reading (no public Slack rule states it): #e8e8e8 at 4% and 13%.
  'slack-code-plain-dark': {
    ...SLACK_PLAIN_FENCE,
    theme: 'dark',
    styles: {
      '.ProseMirror pre': {
        backgroundColor: 'rgba(232, 232, 232, 0.04)',
        borderTopColor: 'rgba(232, 232, 232, 0.13)',
      },
      '.ProseMirror .dg-linenos': { display: 'none' },
    },
  },
  /*
   * Drafts that do not open with a heading. The torture fixture opens with `# Deploy postmortem`, a
   * first child whose top margin is zeroed, so h1's 35px and the leading-block reset are invisible
   * to it. No `jira-leads-table`: TipTap wraps a table in `div.tableWrapper`, so a table is never a
   * direct child of `.ProseMirror` and keeps its 24px (inspected on the rendered children), which
   * the `jira` scenario already asserts.
   */
  'jira-leads-list': {
    destination: 'jira',
    canonical: '- one\n- two\n',
    // A two-item bullet list earns no warning on Jira.
    counts: { prosemirror: 1, table: 0, blockedBar: 0, warnRow: 0 },
    // A leading list starts flush, as the reader draws it: a list injected first into a live
    // comment and a live description computes 0 in both. editor-core keeps 14px (the author's).
    leadingBlock: {
      selector: '.ProseMirror ul',
      marginTop: '0px',
      label: 'as the FIRST block in the document, like the reader',
    },
  },
  // A leading task list, flush. Its own 12px rule ties the reset on specificity, so this holds the
  // reset's position below it in `jira.css`.
  'jira-leads-tasklist': {
    destination: 'jira',
    canonical: '- [ ] one\n- [ ] two\n',
    counts: { prosemirror: 1, checkbox: 2, blockedBar: 0, warnRow: 0 },
    leadingBlock: {
      selector: '.ProseMirror ul[data-type="taskList"]',
      marginTop: '0px',
      label: 'as the FIRST block in the document, a task list too',
    },
  },
  // A paragraph first, so the h1 is not a first child (a leading heading is zeroed) and its 35px shows.
  'jira-leads-paragraph': {
    destination: 'jira',
    canonical: 'Intro paragraph.\n\n# Heading after it\n',
    counts: { prosemirror: 1, h1: 1, blockedBar: 0, warnRow: 0 },
    leadingBlock: {
      selector: '.ProseMirror h1',
      marginTop: '35px',
      label: 'when it is not the first block',
    },
  },
  /*
   * An emptied draft: `body/empty` blocks inside `render()`, and the window says so. The one scenario
   * that proves the disabled Approve looks disabled; the button is genuinely disabled here, so no
   * forced state is needed. `styles`, not `checkStyles`: the button, not the body census.
   */

  'jira-empty': {
    destination: 'jira',
    canonical: '   \n\n  ',
    counts: BLOCKED_CHROME,
    styles: { '.dg-btn-primary[disabled]': { opacity: '0.5', cursor: 'not-allowed' } },
  },
  /*
   * Linear's list spacing in real layout: the gaps a live comment measured, 6px into a
   * list and between its items (a nested list too) and 16px out of it into a paragraph, for both
   * list kinds.
   */
  'linear-lists': {
    destination: 'linear',
    canonical:
      'A paragraph before a list.\n\n- first\n- second\n  - nested\n\n' +
      'A paragraph after the list.\n\n' +
      'Then a numbered one.\n\n1. one\n2. two\n\nThe end.\n\n- [ ] parent\n  - child\n- [ ] next\n',
    counts: { prosemirror: 1 },
    gaps: [
      ['.ProseMirror > p', '.ProseMirror > ul', 6],
      ['.ProseMirror > ul > li:first-child', '.ProseMirror > ul > li:nth-child(2)', 6],
      ['.ProseMirror > ul > li:nth-child(2) > p', '.ProseMirror > ul > li:nth-child(2) > ul', 6],
      ['.ProseMirror > ul', '.ProseMirror > ul + p', 16],
      ['.ProseMirror > ul + p + p', '.ProseMirror > ol', 6],
      ['.ProseMirror > ol', '.ProseMirror > ol + p', 16],
      // Not measured live: Linear's rules give a nested list no bottom margin, so the next item is
      // its `li + li` 6px away.
      [
        '.ProseMirror > ul[data-type="taskList"] > li:first-child ul',
        '.ProseMirror > ul[data-type="taskList"] > li:nth-child(2)',
        6,
      ],
    ],
  },
  /*
   * Bold inside a heading: Linear's `strong` rule gives it 600, the heading's own weight. Inferred
   * from the rule, as no comment has one to read; WebKit's `bolder` would draw 900.
   */
  'linear-bold': {
    destination: 'linear',
    canonical: '## A heading with **bold** in it\n\nA paragraph with **bold** in it.\n',
    counts: { prosemirror: 1 },
    styles: {
      '.ProseMirror h2': LINEAR_HEADING_NODE,
      '.ProseMirror h2 strong': LINEAR_HEADING_NODE,
      '.ProseMirror p strong': LINEAR_STRONG,
    },
  },
  // Linear's headings beside paragraphs, a live capture's body (comment `700eb514`) block for block.
  'linear-headings': {
    destination: 'linear',
    canonical:
      'Linear headings\n\nA paragraph.\n\nA second paragraph.\n\n' +
      '# Heading one\n\nA paragraph after h1.\n\n## Heading two\n\nA paragraph after h2.\n\n' +
      '### Heading three\n\nA paragraph after h3.\n\n#### Heading four\n\nA paragraph after h4.\n',
    counts: { prosemirror: 1 },
    gaps: [
      ['.ProseMirror > p', '.ProseMirror > p + p', 16],
      ['.ProseMirror > p:has(+ h1)', '.ProseMirror > h1', 48],
      ['.ProseMirror > h1', '.ProseMirror > h1 + p', 16],
      ['.ProseMirror > p:has(+ h2)', '.ProseMirror > h2', 32],
      ['.ProseMirror > h2', '.ProseMirror > h2 + p', 16],
      ['.ProseMirror > p:has(+ h3)', '.ProseMirror > h3', 24],
      ['.ProseMirror > h3', '.ProseMirror > h3 + p', 6],
      ['.ProseMirror > p:has(+ h4)', '.ProseMirror > h4', 22],
      ['.ProseMirror > h4', '.ProseMirror > h4 + p', 6],
    ],
  },
  // Beside lists, the second capture's body, then a quote 22px from the list and the paragraph.
  'linear-heading-lists': {
    destination: 'linear',
    canonical:
      'Linear headings beside lists\n\nA paragraph before a heading.\n\n' +
      '# Heading one\n\n- a list after h1\n- second item\n\n' +
      '## Heading two\n\n- a list after h2\n- second item\n\n' +
      '### Heading three\n\n- a list after h3\n- second item\n\n' +
      '> a quote after a list\n\nA paragraph after the quote.\n',
    counts: { prosemirror: 1 },
    gaps: [
      ['.ProseMirror > h1', '.ProseMirror > h1 + ul', 16],
      ['.ProseMirror > ul:has(+ h2)', '.ProseMirror > h2', 32],
      ['.ProseMirror > h2', '.ProseMirror > h2 + ul', 16],
      ['.ProseMirror > ul:has(+ h3)', '.ProseMirror > h3', 24],
      ['.ProseMirror > h3', '.ProseMirror > h3 + ul', 6],
      ['.ProseMirror > ul:has(+ blockquote)', '.ProseMirror > blockquote', 22],
      ['.ProseMirror > blockquote', '.ProseMirror > blockquote + p', 22],
    ],
  },
  // A quote that opens the draft is 6px down, Linear's leading `.block-node`, and a heading that
  // opens a quote is flush, so its 32px cannot collapse out through the quote's top and widen the
  // 22px above it. Neither captured live.
  'linear-quotes': {
    destination: 'linear',
    canonical:
      '> A quote that opens the draft.\n\nA paragraph.\n\n' +
      '> ## A heading in a quote\n>\n> The quote goes on.\n',
    counts: { prosemirror: 1 },
    leadingBlock: {
      selector: '.ProseMirror blockquote',
      marginTop: '6px',
      label: 'as the FIRST block in the document, as Linear opens a comment with one',
    },
    gaps: [['.ProseMirror > p', '.ProseMirror > p + blockquote', 22]],
  },
  // Linear's tables: columns total 720px whatever their number, as the captures measure; 22px below
  // a paragraph and 23px above the next block.
  'linear-tables': {
    ...LINEAR_TABLES,
    gaps: [
      ['.ProseMirror > p', '.ProseMirror > .tableWrapper', 22],
      ['.ProseMirror > .tableWrapper', '.ProseMirror > .tableWrapper + .tableWrapper', 23],
      ['.ProseMirror > .tableWrapper:has(+ p)', '.ProseMirror > .tableWrapper + p', 23],
    ],
  },
  // The same tables in the narrowest window the host allows: each scrolls in its own wrapper, as
  // Linear's does, and the draft does not.
  'linear-tables-narrow': {
    ...LINEAR_TABLES,
    viewport: { width: WINDOW_MIN.width, height: VIEWPORT.height },
    tablesScroll: true,
  },
  // A heading and a table inside a blockquote: both verified live 400s that lose the whole comment.
  'jira-blocked': { destination: 'jira', canonical: BLOCKED_FIXTURE, counts: BLOCKED_CHROME },

  /*
   * A plain body: editable, no toolbar, no markdown. `save_release`-shaped (Linear stores
   * `Release.description` verbatim, PROBED); the markdown syntax must stay characters.
   */
  'linear-plain-body': {
    destination: 'linear',
    toolName: 'mcp__claude_ai_Linear__save_release',
    bodyFormat: 'plain',
    canonical: '## Not a heading\n\n**not bold** and _not italic_\n',
    context: { id: 'rel_2026_09_12' },
    prose: [{ field: 'name', value: '2026-09-12.1' }],
    counts: {
      prosemirror: 0,
      plainBody: 1,
      plainNote: 1,
      // No toolbar: every button would apply formatting this field sends literally.
      toolbar: 0,
      tbBtn: 0,
      proseInput: 1,
      blockedBar: 0,
      approveDisabled: 0,
    },
  },

  /*
   * A `save_issue` patch: no body, one card per edit, in order. Four edits, one of each shape that
   * draws differently: a replacement, a deletion of every occurrence, an append that opens a heading
   * and a range whose middle cannot be seen. Three previews (a deletion has no text to draw), each a
   * `.ProseMirror` the Linear sheet draws: the append's heading in Linear's own heading type. No
   * toolbar: the text is edited as characters.
   */
  'linear-patch': {
    destination: 'linear',
    toolName: 'mcp__claude_ai_Linear__save_issue',
    canonical: '',
    context: { id: 'HELP-42' },
    prose: [{ field: 'title', value: 'Rollout' }],
    patch: [
      { op: 'replace', old_string: 'Tuesday', new_string: 'Thursday' },
      { op: 'replace', old_string: 'TODO', new_string: '', replace_all: true },
      { op: 'append', text: '\n\n## Rollout\n\nShip on **Monday**.' },
      { op: 'replace_range', from: '## Old notes', to: '## Risks', new_string: 'Gone.' },
    ],
    counts: {
      edit: 4, editAnchor: 4, editText: 4, editPreview: 3, prosemirror: 3,
      editDeletes: 1, editFlag: 1, editNote: 1, h2: 1,
      plainNote: 1, plainBody: 0, proseInput: 1,
      toolbar: 0, tbBtn: 0, blockedBar: 0, approveDisabled: 0,
    },
    styles: {
      // The preview is the destination's: Linear's heading and bold, from `EXPECTED_STYLES.linear`.
      '.dg-edit-preview .ProseMirror h2': EXPECTED_STYLES.linear!['.ProseMirror h2']!,
      '.dg-edit-preview .ProseMirror strong': EXPECTED_STYLES.linear!['.ProseMirror strong']!,
      // The text is characters, in the window's monospace, every one sent.
      'textarea.dg-edit-text': { whiteSpace: 'pre-wrap' },
    },
  },
  /*
   * An insertion the agent sent empty: the tool's schema refuses the whole call, so the window blocks
   * (`patch/empty-text`) and Approve is dead.
   */
  'linear-patch-empty-insert': {
    destination: 'linear',
    toolName: 'mcp__claude_ai_Linear__save_issue',
    canonical: '',
    context: { id: 'HELP-42' },
    patch: [{ op: 'insert_after', anchor: 'Rollout plan', text: '' }],
    counts: { edit: 1, editAnchor: 1, editText: 1, editPreview: 0, blockedBar: 1, approveDisabled: 1 },
  },

  /*
   * An empty prose field. Prose fields are unlabelled, so with `fields.summary: ""` the placeholder
   * is all that names it; one drawn in the value's own ink reads as the title the agent wrote. Two
   * properties apart, pinned on both halves of the pair.
   */
  'jira-prose-empty': {
    destination: 'jira',
    toolName: 'mcp__claude_ai_Atlassian_Rovo__editJiraIssue',
    canonical: 'The nightly export job fails on **empty tables**.\n',
    context: { issueIdOrKey: 'SUPPORT-123' },
    prose: [{ field: 'fields.summary', value: '' }],
    // Blocked: `prose/empty` is an error. PROBED: Jira answers 400 to an empty summary and writes
    // nothing, losing the body too.
    counts: { prosemirror: 1, proseInput: 1, blockedBar: 1, approveDisabled: 1 },
    styles: {
      'input.dg-prose-field': { color: 'rgb(28, 30, 33)', fontWeight: '500' },
      'input.dg-prose-field::placeholder': { color: 'rgb(107, 110, 118)', fontWeight: '400' },
    },
  },

  // Dark: `--dg-ink` and `--dg-ink-quiet` are both redefined under `[data-theme="dark"]`.
  'jira-prose-empty-dark': {
    destination: 'jira',
    theme: 'dark',
    toolName: 'mcp__claude_ai_Atlassian_Rovo__editJiraIssue',
    canonical: 'The nightly export job fails on **empty tables**.\n',
    context: { issueIdOrKey: 'SUPPORT-123' },
    prose: [{ field: 'fields.summary', value: '' }],
    counts: { prosemirror: 1, proseInput: 1, blockedBar: 1, approveDisabled: 1 },
    styles: {
      'input.dg-prose-field': { color: 'rgb(206, 207, 210)', fontWeight: '500' },
      'input.dg-prose-field::placeholder': { color: 'rgb(150, 153, 158)', fontWeight: '400' },
    },
  },

  /*
   * An `editJiraIssue` review: a title beside the body, and every other field the agent set (the
   * wildcard's shape). The defect is layout: a strip drawing `issueIdOrKey` over `fields.labels` on
   * one clipped line has every count right.
   */
  'jira-wide-context': {
    destination: 'jira',
    toolName: 'mcp__claude_ai_Atlassian_Rovo__editJiraIssue',
    destinationLabel: 'acme-dev.atlassian.net / SUPPORT-123',
    canonical: '## What we found\n\nThe nightly export job fails on **empty tables**.\n',
    // A real review's values, verbatim: shorter invented ones fit in three rows and pass while the
    // live window cuts a fourth in half.
    context: {
      cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      issueIdOrKey: 'SUPPORT-123',
      'fields.labels': '["support","regression","resolved"]',
      'fields.priority': '{"name":"Medium"}',
      'fields.assignee': '{"accountId":"712020:5e0c4a1b-8d2f-4c3a-9b7e-1f6a2d8c4e90"}',
      'fields.status': 'Waiting for L3',
      'fields.components': '[]',
      'fields.reporter': 'Ada Lovelace',
    },
    prose: [{ field: 'fields.summary', value: 'Nightly export fails on empty tables' }],
    // A clean draft: approvable, and carrying exactly one editable title beside it.
    counts: { prosemirror: 1, proseInput: 1, blockedBar: 0, approveDisabled: 0 },
  },

  /*
   * What the round trip changed, on screen. `- [ ] ![i](url)` plus a normal item is sent as one
   * checkbox and a loose image (`hoistMedia`); `jira/task-item-media-only` fires on the agent's draft
   * and not on the body sent, so this chrome is all that shows the destroyed checkbox.
   * `window.test.tsx` proves the wiring; happy-dom mounts no stylesheet, so legibility is here.
   */
  'jira-silenced': {
    destination: 'jira',
    canonical: '- [ ] ![i](https://example.com/a.png)\n- [ ] a normal item\n',
    clickToOpen: ['warnings'],
    // `warn: 2` is one live row plus one silenced row (also a `.dg-warn`), which the styles below
    // tell apart.
    counts: { prosemirror: 1, warn: 2, changed: 1, silencedHead: 1, silencedRow: 1, warnFix: 0 },
    styles: {
      // Quiet ink, no severity colour: it reports no problem with the message.
      '.dg-changed': { color: 'rgb(107, 110, 118)', cursor: 'pointer' },
      // The section's own ground, one step off the panel, marks "what draftgate changed".
      '.dg-warn-silenced-head': {
        backgroundColor: 'rgb(242, 243, 244)',
        color: 'rgb(107, 110, 118)',
      },
      '.dg-warn-silenced': { color: 'rgb(107, 110, 118)' },
    },
  },

  'jira-silenced-dark': {
    destination: 'jira',
    canonical: '- [ ] ![i](https://example.com/a.png)\n- [ ] a normal item\n',
    theme: 'dark',
    clickToOpen: ['warnings'],
    counts: { prosemirror: 1, warn: 2, changed: 1, silencedHead: 1, silencedRow: 1, warnFix: 0 },
    // The same three rules, dark: every value a token resolution.
    styles: {
      '.dg-changed': { color: 'rgb(150, 153, 158)' },
      '.dg-warn-silenced-head': {
        // `--dg-rule` is `#e3e4f21f` in dark: a translucent hairline colour used as a ground.

        backgroundColor: 'rgba(227, 228, 242, 0.12)',
        color: 'rgb(150, 153, 158)',
      },
      '.dg-warn-silenced': { color: 'rgb(150, 153, 158)' },
    },
  },

  /*
   * Who receives this. PROBED: a comment posted to a JSM project through the gated tool is a public
   * reply to the customer, and the tool has no parameter for an internal note. Only a confirmed
   * customer-visible send takes the warning palette; `window.test.tsx` cannot see paint.
   */
  'jira-audience-public': {
    destination: 'jira',
    canonical: 'Thanks for the report -- we are looking into it now.\n',
    audience: {
      kind: 'public',
      label: 'Reply to customer',
      detail: 'The reporter sees this in the portal.',
      unavailable: 'Add internal note',
    },
    counts: {
      prosemirror: 1,
      audienceBanner: 1,
      audiencePublic: 1,
      audienceOff: 1,
      // Nothing to ask: the audience is known.
      audienceAsk: 0,
      audienceAnswer: 0,
      // No `destinationLabel`: an unconfigured site draws no row, not a half-composed one.
      destination: 0,
    },
    styles: {
      '.dg-audience': { backgroundColor: 'rgb(255, 248, 230)' },
      // The colours too: `.dg-banner span` is (0,1,1) and outranks a lone class, so every coloured
      // child is written as a descendant to beat it, a specificity claim read back here.
      '.dg-audience-label': { color: 'rgb(127, 95, 1)' },
      '.dg-audience-detail': { color: 'rgb(107, 110, 118)' },
      '.dg-audience-off': {
        textDecorationLine: 'line-through',
        cursor: 'default',
        color: 'rgb(107, 110, 118)',
      },
      // A public Jira draft keeps the ordinary ground, so the internal note's yellow is conditional.
      '.dg-body': { backgroundColor: 'rgb(255, 255, 255)' },
    },
  },
  // An internal note: `POSTS_INTERNAL_NOTE` produces it, so its rule, which can look like dead CSS,
  // is asserted painted.
  'jira-audience-internal': {
    destination: 'jira',
    canonical: 'Checked the queue table; dedup logic was looping.\n',
    toolName: 'mcp__jsm__jira_add_internal_note',
    audience: {
      kind: 'internal',
      label: 'Internal note',
      detail: 'The reporter never sees this.',
      unavailable: 'Reply to customer',
    },
    counts: {
      prosemirror: 1,
      audienceBanner: 1,
      audiencePublic: 0,
      // The audience this tool cannot reach.
      audienceOff: 1,
      audienceAsk: 0,
      audienceAnswer: 0,
    },
    styles: {
      // Neutral ground, green label. Amber is reserved for a confirmed customer-visible send.
      '.dg-audience': { backgroundColor: 'rgb(240, 245, 255)' },
      '.dg-audience-label': { color: 'rgb(33, 110, 78)' },
      // The body's ground is Jira's: JSM renders an internal note on yellow, measured off a real
      // ticket in both themes. The rule is `(0,3,0)` over `.dg-body`'s `(0,1,0)` and paints only if
      // `data-audience` reached the root.
      '.dg-body': { backgroundColor: 'rgb(254, 247, 200)' },
    },
  },

  // The same note in dark: `jira.css` ships two palettes.
  'jira-audience-internal-dark': {
    destination: 'jira',
    canonical: 'Checked the queue table; dedup logic was looping.\n',
    toolName: 'mcp__jsm__jira_add_internal_note',
    theme: 'dark',
    audience: {
      kind: 'internal',
      label: 'Internal note',
      detail: 'The reporter never sees this.',
      unavailable: 'Reply to customer',
    },
    counts: { prosemirror: 1, audienceBanner: 1 },
    styles: {
      '.dg-body': { backgroundColor: 'rgb(51, 46, 27)' },
    },
  },

  /*
   * The banner with no operator config behind it: a neutral ground, and no struck-through line,
   * since nothing is unavailable when the audience is not known.
   */
  'jira-audience-unknown': {
    destination: 'jira',
    canonical: 'Thanks for the report -- we are looking into it now.\n',
    // A tool the audience rule has evidence about, or the question is never offered (`toolName`).
    toolName: 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue',
    // One issue key can exist on a dev site and on production, so the host is what tells them apart.
    destinationLabel: 'acme-dev.atlassian.net / SUPPORT-123',
    audience: {
      kind: 'unknown',
      label: 'Audience unknown',
      detail: 'draftgate does not know whether SUPPORT is a service desk.',
      ask: {
        question: 'Is SUPPORT a service desk?',
        options: [
          { label: 'Yes -- customers read replies', value: 'service_desk' },
          { label: 'No -- record it as internal', value: 'software' },
        ],
      },
    },
    counts: {
      prosemirror: 1,
      audienceBanner: 1,
      audiencePublic: 0,
      audienceOff: 0,
      // The question is offered; `window.test.tsx` covers what clicking does.
      audienceAsk: 1,
      audienceAnswer: 2,
      destination: 1,
    },
    styles: {
      '.dg-audience': { backgroundColor: 'rgb(240, 245, 255)' },
      // Full-strength ink and weight; the raw `cloudId` rows beside it stay quiet 400/mono, and a
      // shared `.dg-context dd` rule would flatten it.
      '.dg-destination dd': { color: 'rgb(28, 30, 33)', fontWeight: '600' },
      // A real control, unlike `.dg-audience-off`: it answers the cursor and takes focus.
      '.dg-audience-answer': { cursor: 'pointer' },
      // The neutral variant's label is plain ink, not the warning colour.
      '.dg-audience-label': { color: 'rgb(28, 30, 33)' },
    },
  },

  /*
   * GitHub's audience, public: amber, as a customer-visible Jira reply is. `destinationLabel` needs
   * no config, since `owner/repo#number` is already a human name, so the row is there with an empty
   * `github-repos.json`.
   */
  'github-audience-public': {
    destination: 'github',
    context: { owner: 'Jakuboola', repo: 'draftgate', issue_number: 30 },
    canonical: 'Thanks for the report -- we are looking into it now.\n',
    toolName: 'mcp__claude_ai_Github_MCP__add_issue_comment',
    destinationLabel: 'Jakuboola/draftgate#30',
    audience: {
      kind: 'public',
      label: 'Public repository',
      detail: 'Anyone on the internet can read this, and search engines index it.',
    },
    counts: {
      prosemirror: 1,
      audienceBanner: 1,
      audiencePublic: 1,
      // No struck-through sibling: a repository has one audience and no tool chooses it.
      audienceOff: 0,
      audienceAsk: 0,
      audienceAnswer: 0,
      destination: 1,
    },
    styles: {
      // The amber of a customer-visible Jira reply; see `jira-audience-public` for the specificity.
      '.dg-audience': { backgroundColor: 'rgb(255, 248, 230)' },
      '.dg-audience-label': { color: 'rgb(127, 95, 1)' },
      '.dg-destination dd': { fontWeight: '600' },
    },
  },
  /*
   * Unknown, the state every install starts in. Three options where Jira's has two, so `.dg-status`'s
   * fixed height is pinned here too: a third button must not wrap the row.
   */
  'github-audience-unknown': {
    destination: 'github',
    context: { owner: 'Jakuboola', repo: 'draftgate', issue_number: 30 },
    canonical: 'Thanks for the report -- we are looking into it now.\n',
    toolName: 'mcp__claude_ai_Github_MCP__add_issue_comment',
    destinationLabel: 'Jakuboola/draftgate#30',
    audience: {
      kind: 'unknown',
      label: 'Audience unknown',
      detail: 'draftgate does not know whether Jakuboola/draftgate is public or private.',
      // The profile's own question and labels, so the row this pins is the row a review shows.
      ask: githubAudience({ owner: 'Jakuboola', repo: 'draftgate' })!.ask,
    },
    counts: {
      prosemirror: 1,
      audienceBanner: 1,
      audiencePublic: 0,
      audienceOff: 0,
      audienceAsk: 1,
      // Three; Jira's unknown banner offers two.
      audienceAnswer: 3,
      destination: 1,
    },
    styles: {
      '.dg-status': SHARED_STRUCTURE['.dg-status'],
      // Neutral ground and plain ink: not knowing is not a warning.
      '.dg-audience': { backgroundColor: 'rgb(240, 245, 255)' },
      '.dg-audience-label': { color: 'rgb(28, 30, 33)' },
      '.dg-audience-answer': { cursor: 'pointer' },
    },
  },
};

/**
 * Controls a scenario may open before the census, by key, each with what it must reveal. `reveals`
 * is a settle hint the step reports on, so a renamed toggle fails as "clicked, but nothing
 * appeared" instead of as whatever the missing popover breaks.
 */
const OPENABLE: Record<string, { toggle: string; reveals: string }> = {
  emoji: { toggle: '.dg-tb-btn[aria-label="Emoji"]', reveals: '.dg-emoji-btn' },
  // The full toolbar's link row, which opens inside the toolbar.
  link: { toggle: '.dg-toolbar .dg-tb-btn[aria-label="Link"]', reveals: '.dg-toolbar .dg-linkrow-input' },
  // `reveals` names the root's attribute; it is a settle hint, and the scenario's `JIRA_DARK_STYLES`
  // is what proves the switch.
  themeToggle: { toggle: '.dg-theme-toggle', reveals: 'html[data-theme="dark"]' },
  // Unfurls the warning list, furled by default; `reveals` is a row.
  warnings: { toggle: '.dg-warnbar', reveals: '.dg-warn' },
  // The per-warning repair: `reveals` waits for the preview modal. Reachable only once unfurled.
  warnFix: { toggle: '.dg-warn-fix', reveals: '.dg-modal' },
  // A task list's first checkbox; the `edited` badge proves a transaction happened (see
  // `jira-task-toggle`).
  taskCheckbox: { toggle: '.ProseMirror input[type=checkbox]', reveals: '.dg-edited' },
  // "Load image": `reveals` is the real `<img>`, which appears only once requested
  // (`src/deferredImage.ts`).
  imageLoad: { toggle: '.ProseMirror .dg-img-load', reveals: '.ProseMirror img' },
  // The mention note's toggle, for a clean draft where `.dg-warnbar` does not exist
  // (`slack-mentions`).
  mentions: { toggle: '.dg-mentions', reveals: '.dg-warn-mentions' },
};

/** The keys a scenario may name, so `probe.test.ts` can hold the union to them. */
export const OPENABLE_KEYS = Object.keys(OPENABLE);

// `string`, not a union: `OPENABLE` is a `Record<string, ...>`, so the compiler does not reject a
// key the map lacks. `probe.test.ts` holds every `clickToOpen` to `OPENABLE_KEYS`.
type OpenableKey = keyof typeof OPENABLE;

/** One pre-census gesture and whether it took effect. See `runSetup`. */
type SetupStep = { step: string; arg: string; ok: boolean; detail?: string };

/**
 * What `injected.cjs`'s `takeCensus` returns, the renderer's half only: `Report['dom']` also
 * carries facts only this process has (`theme`, `setup`, the forced hover reads, the images).
 */
interface Census {
  destination: string | null;
  counts: Record<string, number>;
  styles: Record<string, Record<string, string> | null>;
  /**
   * Selection state at census time. `collapsed` is what matters: `bubble: 1` was measured passing
   * with `hasFocus` false. Not optional: `injected.cjs` runs from source, so no build can lack it.
   */
  selection: { hasFocus: boolean; collapsed: boolean };
  /** Does the destination's typeface render, measured by string width (see `Scenario.fontFamily`)? */
  font: { family: string; resolved: boolean; width: number; fallbackWidth: number } | null;
  /** Every link in the draft, in order: the text it reads and the address it opens. */
  links: { text: string; href: string | null }[];
  /** The addresses the link-target bubble shows, when it is up. */
  linkTargets: string[];
  diagnostics: Record<string, number>;
}

export interface Report {
  /** The window's isolation facts (`WKSession.isolation`); optional, so a report without them fails the check. */
  isolation?: Isolation;
  /**
   * The CSP engine's own refusal, naming `connect-src`: the positive control that makes every other
   * CSP check, an absence, mean something.
   *
   * Not a rejected fetch: `draftgate://` has no fetch support, so a `fetch()` rejects with or without
   * a CSP, and with `connect-src` relaxed to `'self' https:` it would still pass. The harness
   * composes this sentence from the engine's `securitypolicyviolation` event (`harness.m`), whose
   * `isTrusted` only the engine sets, read in the harness's own content world, with this url and
   * `connect-src` by name (`provesConnectSrc`); `surface:host` forges one both ways a page could.
   * `probeConnectSrc` still performs the fetch, as the provocation.
   */
  cspRefusal?: string;
  /**
   * What the harness learned about the DOM: the renderer's census plus facts only this process has
   * (`theme`, `setup`, `hoverStyles`, the images), beside the census so none is hostage to it.
   */
  dom: Census & {
    /**
     * Which pre-census setup steps ran, and whether each took effect. Not optional: `[]` means none
     * were asked for, and a `?? []` would turn a harness that stopped reporting into zero checks.
     */
    setup: SetupStep[];
    /**
     * `data-theme` at boot, before any setup step: `jira-theme-toggle` clicks to dark, and the click
     * is asserted by its step's `reveals`.
     */
    theme: string | null;
    /** Computed styles read while `:hover` was forced: see `Scenario.hoverStyles`. */
    hoverStyles?: Record<string, Record<string, string> | null>;
    /** The faces that drew `.ProseMirror p`, matched by width. See `fontFamily`. */
    face?: PlatformFont[] | null;
    /** WebKit's evidence for a real italic, which names no instance: see `wkItalicAdvances`. */
    italicAdvances?: { family: string; style: string; italic: number; upright: number; italicFaceLoaded: boolean } | null;
    /** The same for `.ProseMirror pre code`, when the scenario names a `codeFont`. */
    codeFace?: PlatformFont[] | null;
    /** ...and for inline code, `null` when the draft has none. */
    inlineCodeFace?: PlatformFont[] | null;
    images?: Record<string, { loaded: boolean; naturalWidth: number }>;
    /**
     * What the document's own image is doing (`deferredImage.ts`). `deferred.url` is the full URL the
     * reviewer reads before fetching; `loaded` is null until they click: no request at render time.
     */
    renderedImage: {
      deferred: { url: string | null; hasButton: boolean } | null;
      loaded: { src: string; complete: boolean; naturalWidth: number } | null;
    } | null;
  };
  cspViolations: string[];
  consoleErrors: string[];
}

/**
 * This scenario's window (the harness binary, on a channel in the run's own directory) and how to
 * attach to it. No nonce: that gates the CLI's choice of binary, and nothing here goes through it.
 */
function openWindow(dir: string, requestPath: string): { win: LaunchedHost; attach(): Promise<WKSession> } {
  const channel = WKSession.channel(join(dir, 'control'));
  const win = launchHost(WEBKIT_HARNESS!, { [REQUEST_ENV]: requestPath, ...channel.env }, {
    timeoutMs: SCENARIO_TIMEOUT_MS,
    surface: HERE,
  });
  return { win, attach: () => WKSession.attach(channel.dir) };
}

/** The harness binary every scenario opens, built once at the start of `main`. */
let WEBKIT_HARNESS: string | undefined;

/**
 * Two computed values that are the same up to a layout unit: equal as strings, or the same shape
 * with every `px` length within 0.02px. WebKit lays out in 1/64 px, so `23.996px` reads
 * `23.995998px` and an `hr` margin `23.984375px`. Everything but `px` lengths compares exactly.
 */
export function samePixels(want: string, got: string): boolean {
  if (want === got) return true;
  const PX = /-?\d*\.?\d+px/g;
  const shape = (v: string) => v.replace(PX, 'px');
  if (shape(want) !== shape(got)) return false;
  const a = want.match(PX) ?? [];
  const b = got.match(PX) ?? [];
  return a.length > 0 && a.length === b.length && a.every((v, i) => Math.abs(parseFloat(v) - parseFloat(b[i]!)) <= 0.02);
}

/**
 * One comparison, for both counts and computed styles. A negative expected count means "at least
 * this many" (the emoji picker's Unicode set); a `px` length compares by `samePixels`.
 */
export function mismatches<T>(expected: Record<string, T>, actual: Record<string, T>): string[] {
  return Object.entries(expected)
    .filter(([, want]) => want !== SAMPLED_ONLY)
    .filter(([key, want]) => {
      if (typeof want === 'number' && want < 0) return !((actual[key] as number) >= -want);
      if (typeof want === 'string' && typeof actual[key] === 'string') {
        return !samePixels(want, actual[key] as string);
      }
      return actual[key] !== want;
    })
    .map(([key, want]) =>
      typeof want === 'number' && want < 0
        ? `${key}: expected at least ${-want}, got ${actual[key]}`
        : `${key}: expected ${want}, got ${actual[key]}`
    );
}

const report = reporter();
const { check, drain, finish } = report;

/**
 * What the renderer should gather for this scenario, derived from it like `stylesFor`, so the
 * properties sampled and compared cannot diverge.
 */
export function specFor(scenario: Scenario): Record<string, unknown> {
  return {
    nodes: NODE_SELECTORS,
    fontFamily: scenario.fontFamily?.family,
    styles: Object.fromEntries(
      Object.entries(stylesFor(scenario)).map(([sel, props]) => [sel, Object.keys(props)])
    ),
  };
}

/** The expectations a scenario is judged against, as a flat selector -> properties map. */
export function stylesFor(scenario: Scenario): Record<string, Record<string, string>> {
  const base: Record<string, Record<string, string>> = {
    ...(scenario.checkStyles ? (EXPECTED_STYLES[scenario.destination] ?? {}) : {}),
    // Sampled so `leadingBlock` has something to read; compared by that check, not by `mismatches`.
    ...(scenario.leadingBlock
      ? { [scenario.leadingBlock.selector]: { marginTop: SAMPLED_ONLY } }
      : {}),
    /*
     * The bubble's glyph, wherever a scenario counts bubble buttons: one `-toolbar` scenario per
     * destination, so every sheet with the rule. Keyed on `bubbleBtn`, not `bubble`: the link-target
     * bubble has no formatting buttons, and an absent element is a failure, not a skip.
     */
    ...(scenario.counts.bubbleBtn ? { '.dg-bubble-btn > svg': GLYPH_BOX } : {}),
  };

  // Merged per property, not per selector: `jira-dark` overriding `.ProseMirror pre`'s colours must
  // keep its border, radius and margin assertions.
  const merged = { ...base };
  for (const [selector, props] of Object.entries(scenario.styles ?? {})) {
    merged[selector] = { ...merged[selector], ...props };
  }
  return merged;
}

/**
 * Delete what the last run left in a scenario's directory (`probe-result/<scenario>/`, git-ignored)
 * before this run's window starts, so `report.json` and the screenshots never describe an earlier run.
 */
export function clearScenarioOutputs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'report.json' || entry.endsWith('.png')) rmSync(join(dir, entry), { force: true });
  }
}

/**
 * Every step that changes the window before the census, and whether it took effect. A `selectText`
 * that no longer matches reads as a missing feature, a renamed toggle as a CSP regression; so
 * `checkReport` asserts these before any count. An unknown key is recorded, not thrown.
 */
async function runSetup(session: WKSession, scenario: Scenario): Promise<SetupStep[]> {
  const setup: SetupStep[] = [];

  if (scenario.selectText) {
    const ok = (await session.evaluate<ReturnType<Injected['selectText']>>(INJECTED.selectText, scenario.selectText)) !== null;
    setup.push({
      step: 'selectText',
      arg: scenario.selectText,
      ok,
      ...(ok
        ? {}
        : { detail: 'no text node in the editor contained it; the fixture prose has probably changed' }),
    });
  }

  /*
   * Typed after any selection, which it replaces. `focusEditor` first, since inserted text goes to
   * whatever holds focus; its own step, so "never took focus" and "changed nothing" differ.
   */

  if (scenario.typeText !== undefined) {
    const focused = await session.evaluate<boolean>(INJECTED.focusEditor);
    if (!focused) {
      setup.push({
        step: 'typeText',
        arg: scenario.typeText,
        ok: false,
        detail: 'the editor never took focus, so the text would have gone nowhere',
      });
    } else {
      await session.insertText(scenario.typeText);
      // The edited badge is the transaction having reached React.
      const landed = await until(() =>
        session.evaluate<boolean>(INJECTED.isPresent, '.dg-edited')
      );
      // Past the arrival delay: a warning the typing caused is withheld for `SETTLE_MS`, and a
      // `clickToOpen: ['warnings']` would find no `.dg-warnbar`.
      if (landed) await new Promise((r) => setTimeout(r, SETTLE_PAST_MS));
      setup.push({
        step: 'typeText',
        arg: scenario.typeText,
        ok: landed,
        ...(landed ? {} : { detail: 'the text never registered as an edit' }),
      });
    }
  }

  // In order, each waiting for its own `reveals`: the second is usually inside what the first opened.
  for (const key of [scenario.clickToOpen ?? []].flat()) {
    const control = OPENABLE[key];
    if (!control) {
      setup.push({
        step: 'clickToOpen',
        arg: key,
        ok: false,
        detail: `"${key}" is not one of ${OPENABLE_KEYS.join(', ')}`,
      });
      continue;
    }
    const opened = await session.evaluate<{ ok: boolean; detail?: string }>(
      INJECTED.openControl,
      control.toggle,
      control.reveals
    );
    setup.push({ step: 'clickToOpen', arg: key, ...opened });
  }

  return setup;
}

/**
 * Ask the attached window everything this scenario needs to know, and assemble the report. In
 * order: readiness (polled, not slept); the boot theme (`Report.dom.theme`); the setup steps; the
 * census; the images; the forced states last, since forcing changes what `getComputedStyle` returns.
 */
async function gather(session: WKSession, scenario: Scenario, dir: string): Promise<Report> {
  await waitUntilRendered(session, 'on its first load');

  // Before the reload, which the override survives, so the measured render is at the pinned size.
  await session.setViewport(scenario.viewport);

  /*
   * Reload, so a whole load is observed: an attach can land after the first load, and "no CSP
   * violations" would then mean "none since we listened". After the wait, so it never lands on a
   * load in flight. The first load's messages (seeded by `WKSession.attach`) are kept, so a
   * boot-only warning shows; a message from both loads is reported twice.
   */
  await session.reload();
  await waitUntilRendered(session, 'after the reload');

  const theme = await session.evaluate<string | null>(INJECTED.readTheme);

  // The context strip in real layout, in every scenario: a computed `flex-wrap` cannot say whether
  // two pairs collide (`issueIdOrKey` drawn over `fields.labels`).
  const context = await session.evaluate<{
    pairs: number; values: { shown: number; wanted: number }[];
    overlaps: number; height: number; clipped: number;
  } | null>(INJECTED.contextLayout);
  // The scenario's own name, from the directory it writes into: `gather` is handed the dir, not
  // the name, and an unlabelled failure in a run of every scenario says nothing about which one.
  const label = dir.split('/').pop() ?? 'scenario';
  check(context !== null, `${label}: the context strip is present`);
  if (context) {
    check(
      context.overlaps === 0,
      `${label}: no two context pairs overlap`,
      `${context.overlaps} overlapping pair(s) across ${context.pairs}`
    );
    check(
      context.clipped === 0,
      `${label}: every context pair is inside the strip`,
      `${context.clipped} of ${context.pairs} outside its box`
    );
    // Both checks above pass when a flex value with `min-width: 0` shrinks to zero width instead of
    // overflowing: present, inside the box, and invisible.
    const vanished = context.values.filter((v) => v.wanted > 0 && v.shown < 12);
    check(
      vanished.length === 0,
      `${label}: every context VALUE is wide enough to read`,
      `${vanished.length} of ${context.values.length} truncated to nothing ` +
        `(${vanished.map((v) => `${v.shown}/${v.wanted}px`).join(', ')})`
    );
    // Capped, so a wildcard cannot push the draft off screen: `.dg-context`'s `max-height`, four
    // 17px rows plus three 4px gaps = 80. Change both together.
    check(context.height <= 80, `${label}: the strip stays within its cap`, `${context.height}px`);
  }

  // The code column in real layout (`Scenario.codeLayout`): a fixed gutter passes every
  // computed-style check and fails this once the digit count changes.
  if (scenario.codeLayout) {
    const code = await session.evaluate<ReturnType<Injected['codeLayout']>>(INJECTED.codeLayout);
    check(code !== null && code.textLeft !== null, `${label}: the code block has numbered text to measure`);
    if (code && code.textLeft !== null) {
      const want = scenario.codeLayout;
      // Jira's column follows its widest number; Slack's (35px) and Linear's (two digits) are fixed,
      // Linear's partly in characters of the face this machine drew.
      const [expected, claim, detail] =
        'textAfterWidestNumber' in want
          ? [code.widest + want.textAfterWidestNumber, `${want.textAfterWidestNumber}px after its widest line number`, '']
          : [
              code.border + want.textInside + (want.ch ?? 0) * code.ch,
              `${want.ch ? `${want.ch} characters and ` : ''}${want.textInside}px inside the block's border, whatever the digit count`,
              `, border ${code.border}px${want.ch ? `, a character ${code.ch.toFixed(2)}px` : ''}`,
            ];
      check(
        Math.abs(code.textLeft - expected) <= 0.5,
        `${label}: code starts ${claim}`,
        `text at ${code.textLeft.toFixed(2)}px, widest number ${code.widest.toFixed(2)}px over ${code.lines} lines${detail}`
      );
      // One number per logical line, so a wrapped line (TipTap's `pre-wrap`) drifts every later
      // number; the `-long` scenarios carry a line wider than the pane.
      check(
        code.lastNumberTop !== null &&
          code.lastLineTop !== null &&
          Math.abs(code.lastNumberTop - code.lastLineTop) <= 1,
        `${label}: the last line number sits beside the last line`,
        `number at ${code.lastNumberTop?.toFixed(2)}px, line at ${code.lastLineTop?.toFixed(2)}px`
      );
      // Jira's column is tinted, so one that stopped short would float inside the panel.
      if ('textAfterWidestNumber' in want) {
        const { top, bottom, left } = code.column;
        check(
          [top, bottom, left].every((d) => Math.abs(d) <= 0.5),
          `${label}: the number column runs the panel's full height, from its left edge`,
          `top ${top.toFixed(2)}px, bottom ${bottom.toFixed(2)}px, left ${left.toFixed(2)}px in from the panel's edges`
        );
      }
    }
  }

  // Every table in real layout: equal columns, at the destination's width.
  if (scenario.tableLayout) {
    const spec = scenario.tableLayout;
    const { content, dpr, tables } = await session.evaluate<ReturnType<Injected['tableLayout']>>(INJECTED.tableLayout);
    check(tables.length > 0, `${label}: the draft has a table to measure`);
    for (const [i, table] of tables.entries()) {
      const which = `${label}: table ${i + 1} of ${tables.length}`;
      if ('width' in spec) {
        check(
          Math.abs(table.width - content) <= 0.5,
          `${which} spans the document`,
          `table ${table.width.toFixed(2)}px in a ${content.toFixed(2)}px document`
        );
      } else {
        const total = table.columns.reduce((n, w) => n + w, 0);
        check(
          Math.abs(total - spec.columns) <= 0.5,
          `${which}'s ${table.columns.length} columns total ${spec.columns}px`,
          `${total.toFixed(2)}px, in a ${content.toFixed(2)}px document`
        );
        if (spec.hairline) {
          check(
            Math.abs(table.border * dpr - 1) <= 0.01,
            `${which}'s border is one device pixel`,
            `${table.border}px at ${dpr}x`
          );
        }
      }
      // At least two columns, or equality is true of nothing: an empty row's `Math.max()` is -Infinity.
      check(
        table.columns.length >= 2 && Math.max(...table.columns) - Math.min(...table.columns) <= 0.5,
        `${which}'s columns are equal`,
        `columns ${table.columns.map((w) => w.toFixed(2)).join(', ') || 'none'}px`
      );
    }
  }

  // A table wider than the editor scrolls in its own wrapper, and the draft does not.
  if (scenario.tablesScroll) {
    const overflow = await session.evaluate<ReturnType<Injected['tableOverflow']>>(INJECTED.tableOverflow);
    check(overflow.wrappers.length > 0, `${label}: the draft has a table to scroll`);
    for (const [i, w] of overflow.wrappers.entries()) {
      check(
        w.moved > 0,
        `${label}: table ${i + 1} of ${overflow.wrappers.length} scrolls in its own wrapper`,
        `${w.overhang}px past the wrapper, which scrolled ${w.moved}px`
      );
    }
    check(
      overflow.body === 0,
      `${label}: the draft does not scroll sideways`,
      overflow.body === null ? 'no .dg-body' : `${overflow.body}px wider than its box`
    );
  }

  /*
   * A patch's new text is sent character for character, so none of it may sit out of sight in a
   * scrolling box. The control: the five-line edit's box is taller than the one-line edit's.
   */
  if (scenario.patch) {
    const fit = await session.evaluate<ReturnType<Injected['editTextFit']>>(INJECTED.editTextFit);
    check(fit.length === scenario.patch.length, `${label}: one text box per edit`, `${fit.length}`);
    for (const [i, f] of fit.entries()) {
      check(f.hidden <= 0, `${label}: edit ${i + 1}'s text is all in view`, `${f.hidden}px out of sight`);
    }
    // Only where the edits differ in length, or the comparison is true of nothing.
    const tallest = fit.reduce((a, b) => (b.lines > a.lines ? b : a), fit[0]!);
    const shortest = fit.reduce((a, b) => (b.lines < a.lines ? b : a), fit[0]!);
    if (tallest.lines > shortest.lines) {
      check(
        tallest.height > shortest.height,
        `${label}: a longer edit's box is taller`,
        `${tallest.lines} lines in ${tallest.height}px, ${shortest.lines} in ${shortest.height}px`
      );
    }
  }

  if (scenario.gaps) {
    const gaps = await session.evaluate<(number | null)[]>(INJECTED.gapsBetween, scenario.gaps);
    scenario.gaps.forEach(([upper, lower, px], i) => {
      const gap = gaps[i] ?? null;
      check(
        gap !== null && Math.abs(gap - px) <= 0.5,
        `${label}: ${px}px from ${upper} to ${lower}`,
        gap === null ? 'one of the two matched nothing' : `${gap.toFixed(2)}px`
      );
    });
  }

  /*
   * The task checkbox against its text, in real layout: centred on the first line, and
   * no taller than it, so the row is the text's height. Four sheets each spell it as a margin from
   * their own line height, and no computed style can say whether the margin still fits the line.
   */
  if (scenario.checkStyles && (scenario.counts.checkbox ?? 0) > 0) {
    const task = await session.evaluate<ReturnType<Injected['taskLayout']>>(INJECTED.taskLayout);
    check(task !== null, `${label}: the task list has a first item to measure`);
    if (task) {
      check(
        Math.abs(task.boxCentre - task.lineHeight / 2) <= 0.5,
        `${label}: the task checkbox is centred on its first line`,
        `box centre ${task.boxCentre.toFixed(2)}px, line ${task.lineHeight}px`
      );
      check(
        Math.abs(task.rowHeight - task.textHeight) <= 0.5,
        `${label}: a task row is as tall as its text`,
        `row ${task.rowHeight.toFixed(2)}px, text ${task.textHeight.toFixed(2)}px`
      );
    }
  }

  const setup = await runSetup(session, scenario);

  /*
   * Start the image loads before the census and collect them after the local work: `loadImages` is
   * the one network wait (1000ms per source, the helper's own timer), and `WKSession` multiplexes
   * by request id, so the local reads run while it is in flight.
   */
  const images = scenario.imageSources
    ? session.evaluate<Report['dom']['images']>(INJECTED.loadImages, scenario.imageSources)
    : null;

  const census = await session.evaluate<Census>(INJECTED.takeCensus, specFor(scenario));
  const dom: Report['dom'] = { ...census, setup, theme, renderedImage: null };

  // The positive control (`Report.cspRefusal`). Its refusal arrives asynchronously, so it is polled;
  // one that never arrives is what `checkReport` fails on.

  const csp = await session.evaluate<{ url: string }>(INJECTED.probeConnectSrc);
  /*
   * The messages the control caused, which `cspViolations` subtracts: this url and `connect-src` by
   * name, so a genuine `base-uri` or `frame-src` refusal of this document, or a `connect-src`
   * violation of another url, stays. It cannot tell the control's refusal from the window genuinely
   * fetching its own address. Only the harness-composed `security` shape arrives (`harness.m`).
   */
  const isOurRefusal = (text: string) => text.includes(csp.url) && /connect-src/i.test(text);
  // The evidence half: the engine's own refusal, by `wkSession.ts`'s one predicate.
  const provesConnectSrc = (m: HostMessage) => engineRefused(m, 'connect-src', csp.url);
  // `hasMessage`, which copies no array per tick.
  await until(() => session.hasMessage(provesConnectSrc), { timeoutMs: 2_000 });

  // The face that drew the prose, by width -- a resting read, so before the forced states below.
  if (scenario.fontFamily) dom.face = await session.platformFonts('.ProseMirror p');
  // WebKit names no instance, so the italic check reads the advances (`wkItalicAdvances`).
  if (scenario.fontFamily?.italic) {
    dom.italicAdvances = await session.evaluate(INJECTED.wkItalicAdvances, '.ProseMirror em');
  }
  if (scenario.codeFont) {
    dom.codeFace = await session.platformFonts('.ProseMirror pre code');
    dom.inlineCodeFace = await session.platformFonts('.ProseMirror :not(pre) > code');
  }

  // Forced states last, each forced, read and unforced again, since a forced state moves every later read.
  const hoverStyles: Record<string, Record<string, string> | null> = {};
  for (const [selector, props] of Object.entries(scenario.hoverStyles ?? {})) {
    await session.forcePseudo(selector, ['hover']);
    // `stylesOnly`: skip the census's selection read, font probe and `innerText` layout flush.
    const read = await session.evaluate<Pick<Census, 'styles'>>(INJECTED.takeCensus, {
      nodes: {},
      stylesOnly: true,
      styles: { [selector]: Object.keys(props) },
    });
    hoverStyles[selector] = read.styles[selector] ?? null;
    await session.forcePseudo(selector, []);
  }
  if (Object.keys(hoverStyles).length) dom.hoverStyles = hoverStyles;

  // After every resting read, because it scrolls, formats and types; before the screenshot, so the
  // picture is the pinned toolbar over the draft's foot.
  if (scenario.pinnedToolbar) await checkPinnedToolbar(session, label);

  // The image results, collected last; `renderedImage` after the loads it may report.
  if (images) {
    dom.images = await images;
    dom.renderedImage = await session.evaluate(INJECTED.renderedImage);
  }

  // The screenshot, after two animation frames: the DOM reports ready before anything is drawn, so
  // a PNG could show the "loading the draft..." placeholder. One frame runs before the paint commits.
  await session.evaluate(INJECTED.afterTwoFrames);
  writeFileSync(join(dir, `${dom.destination ?? 'unknown'}.png`), await session.screenshot());

  const messages = session.allMessages();

  return {
    isolation: await session.isolation(),
    ...(() => {
      const found = messages.find(provesConnectSrc)?.text;
      return found === undefined ? {} : { cspRefusal: found };
    })(),
    dom,
    // A CSP violation fails either way round (the policy blocks the window's own code, or the window
    // reaches for what it should not), minus the control's own (`isOurRefusal`).
    cspViolations: messages
      .filter((m) => /Content Security Policy/i.test(m.text))
      .filter((m) => !isOurRefusal(m.text))
      .map((m) => `${m.source}/${m.level}: ${m.text}`),
    consoleErrors: messages
      .filter((m) => m.level === 'error' && !/Content Security Policy/i.test(m.text))
      .map((m) => `${m.source}: ${m.text}`),
  };
}

/**
 * The full toolbar over a draft taller than the window, in real layout and by real gestures.
 * Scrolled to the foot it stays at the top of the pane, opaque and over the draft; a real click on
 * Bold formats the selection there without scrolling; a keystroke or ArrowUp never leaves the caret
 * under it; and the bubble, the unfurled list, the emoji picker and the link row stack right.
 * Positions from `getBoundingClientRect`, stacking from `elementFromPoint`.
 */
async function checkPinnedToolbar(session: WKSession, label: string): Promise<void> {
  const px = (n: number) => `${n.toFixed(1)}px`;
  const caretCheck = async (what: string) => {
    const caret = await session.evaluate<ReturnType<Injected['caretInView']>>(INJECTED.caretInView);
    check(
      caret !== null && caret.top >= caret.barBottom - 0.5 && caret.bottom <= caret.paneBottom,
      `${label}: ${what} leaves the caret in view below the pinned toolbar`,
      caret ? `caret ${px(caret.top)}..${px(caret.bottom)}, toolbar foot ${px(caret.barBottom)}` : 'no caret'
    );
  };
  const stacked = async (upper: string, lower: string, what: string) => {
    const at = await session.evaluate<ReturnType<Injected['stackedAt']>>(INJECTED.stackedAt, upper, lower);
    check(
      at !== null && at.upperOnTop,
      `${label}: ${what}`,
      at ? `${lower} is topmost where they overlap (${px(at.top)}..${px(at.bottom)})` : 'the two do not overlap'
    );
  };

  await session.evaluate(INJECTED.scrollPane);
  const view = await session.evaluate<ReturnType<Injected['toolbarInView']>>(INJECTED.toolbarInView);
  check(view !== null, `${label}: the draft has a full toolbar and a pane`);
  if (!view) return;
  check(view.scrollTop > 0, `${label}: the draft is taller than the window`, `scrollTop ${view.scrollTop}`);
  check(
    Math.abs(view.bar.top - view.pane.top) <= 0.5,
    `${label}: scrolled to the foot, the full toolbar is pinned to the top of the pane`,
    `toolbar top ${px(view.bar.top)}, pane top ${px(view.pane.top)}`
  );
  check(
    view.covered === 0,
    `${label}: nothing in the draft draws over the pinned toolbar`,
    `${view.covered} of ${view.samples} points hit something else`
  );
  check(
    /^rgb\(/.test(view.background),
    `${label}: the pinned toolbar is opaque, so the draft does not show through it`,
    view.background
  );

  // Format the line at the foot by a real click, which lands on whatever is topmost at the button's
  // centre. The window becomes key first: a click on a window that is not key only activates it.
  const last = await session.evaluate<ReturnType<Injected['selectText']>>(
    INJECTED.selectText, PINNED_LAST, { preventScroll: true }
  );
  check(
    last !== null && last.top >= view.bar.bottom && last.bottom <= view.pane.bottom,
    `${label}: the line at the draft's foot is selected and in view below the toolbar`,
    last ? `line ${px(last.top)}..${px(last.bottom)}, toolbar foot ${px(view.bar.bottom)}` : 'not found'
  );
  const bold = await session.evaluate<ReturnType<Injected['hostCentre']>>(
    INJECTED.hostCentre, '.dg-toolbar button[aria-label="Bold"]'
  );
  await session.becomeKey();
  if (bold) await session.click(bold.x, bold.y);
  await session.evaluate(INJECTED.afterTwoFrames);
  const marks = await session.evaluate<ReturnType<Injected['selectionMarks']>>(INJECTED.selectionMarks);
  check(
    bold !== null && marks.within.includes('strong') && marks.selected === PINNED_LAST,
    `${label}: a click on the pinned toolbar's Bold bolds the selection at the foot and keeps it selected`,
    bold ? `selected "${marks.selected}", inside ${marks.within.join(' > ') || 'nothing'}` : 'no Bold button'
  );
  check(
    marks.scrollTop === view.scrollTop,
    `${label}: clicking the pinned toolbar does not scroll the pane`,
    `scrollTop ${view.scrollTop} -> ${marks.scrollTop}`
  );

  // A keystroke on a line under the toolbar: unless ProseMirror knows about the pinned toolbar
  // (`PinnedToolbarClearance`), it counts that line as visible.
  const under = await session.evaluate<boolean>(INJECTED.scrollPane, PINNED_MIDDLE);
  check(under, `${label}: a line of the draft can be scrolled under the pinned toolbar`);
  await session.evaluate(INJECTED.selectText, PINNED_MIDDLE, { preventScroll: true, collapsed: true });
  await session.insertText('x');
  await caretCheck('typing on a line under the pinned toolbar');

  // The selection toolbar opens above a selection, which here is just below the pinned one.
  await session.evaluate(INJECTED.selectText, PINNED_MIDDLE, { preventScroll: true });
  await stacked('.dg-bubble', '.dg-toolbar', 'the selection toolbar draws over the pinned toolbar');

  // ArrowUp from a line in view onto the line under the toolbar: ProseMirror scrolls the caret into
  // view after the key, and must count that line as hidden.
  await session.evaluate(INJECTED.scrollPane, PINNED_MIDDLE);
  await session.evaluate(INJECTED.selectText, PINNED_BELOW_MIDDLE, { preventScroll: true, collapsed: true });
  await caretCheck('placing the caret three lines below the toolbar');
  for (let i = 0; i < ARROW_UPS; i++) await session.press('ArrowUp');
  await caretCheck('ArrowUp onto a line under the pinned toolbar');

  // The link row opens inside the toolbar, so it is pinned with it.
  await session.evaluate(INJECTED.selectText, PINNED_MIDDLE, { preventScroll: true });
  const link = await session.evaluate<ReturnType<Injected['openControl']>>(
    INJECTED.openControl, OPENABLE.link!.toggle, OPENABLE.link!.reveals
  );
  const row = await session.evaluate<ReturnType<Injected['topmostAt']>>(INJECTED.topmostAt, OPENABLE.link!.reveals);
  check(
    link.ok && row !== null && row.onTop && row.top >= view.pane.top && row.bottom <= view.pane.bottom,
    `${label}: the link row opens in view on the pinned toolbar`,
    link.ok ? (row ? `row ${px(row.top)}..${px(row.bottom)}` : 'no row') : link.detail
  );
  await session.press('Escape');

  // The unfurled warning list hangs from the strip over the top of the pane, where the toolbar is,
  // and an emoji picker opened under it stays over it.
  const unfurled = await session.evaluate<ReturnType<Injected['openControl']>>(
    INJECTED.openControl, OPENABLE.warnings!.toggle, OPENABLE.warnings!.reveals
  );
  check(unfurled.ok, `${label}: the warning list unfurls over the scrolled draft`, unfurled.detail);
  await stacked('.dg-status .dg-warnings', '.dg-toolbar', 'the unfurled warning list draws over the pinned toolbar');

  // The emoji picker hangs below the toolbar, over the draft.
  const emoji = await session.evaluate<ReturnType<Injected['openControl']>>(
    INJECTED.openControl, OPENABLE.emoji!.toggle, OPENABLE.emoji!.reveals
  );
  const picker = await session.evaluate<ReturnType<Injected['topmostAt']>>(INJECTED.topmostAt, '.dg-emoji');
  check(
    emoji.ok && picker !== null && picker.onTop && picker.top >= view.pane.top,
    `${label}: the emoji picker opens in view and over the draft`,
    emoji.ok ? (picker ? `picker ${px(picker.top)}..${px(picker.bottom)}` : 'no picker') : emoji.detail
  );
  await stacked('.dg-emoji', '.dg-status .dg-warnings', 'the open emoji picker draws over the unfurled warning list');

  // Put everything away and go back to the foot, so the screenshot is the pinned toolbar over it.
  await session.press('Escape');
  await session.evaluate(INJECTED.clickSelector, OPENABLE.warnings!.toggle);
  await session.evaluate(INJECTED.scrollPane);
}

/** A scenario's request, as the CLI would write it; `host.ts` opens the same scenarios with it. */
export function requestFor(name: string, scenario: Scenario): WireRequest {
  return {
    protocol: PROTOCOL_VERSION,
    destination: scenario.destination,
    toolName: scenario.toolName ?? `probe:${name}`,
    context: scenario.context ?? { ...JIRA_CONTEXT },
    ...(scenario.audience ? { audience: scenario.audience } : {}),
    ...(scenario.destinationLabel ? { destinationLabel: scenario.destinationLabel } : {}),
    ...(scenario.routeInferred ? { routeInferred: scenario.routeInferred } : {}),
    // `canonical` / `prose` / `bodyFormat` through the real `reviewPlan`, not a second copy of it.
    fields: planFields(scenario),
    // Explicit, so a scenario asserts the same colours on any machine.
    theme: scenario.theme ?? 'light',
    timeoutMs: 600_000,
  };
}

async function probe(name: string): Promise<string[]> {
  // A private channel: scenarios run concurrently, and `main` prints each one's `lines` in
  // declaration order, so the output matches a sequential run.
  const { lines: entries, check, note } = report.sub();
  const scenario = SCENARIOS[name];
  if (!scenario) {
    check(false, `unknown scenario "${name}"`);
    return entries;
  }
  const { destination } = scenario;
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const styles = stylesFor(scenario);

  const request = requestFor(name, scenario);
  const requestPath = join(dir, 'request.json');
  writeFileSync(requestPath, JSON.stringify(request));

  // Before anything is spawned: this run judges this run's output only. See `clearScenarioOutputs`.
  clearScenarioOutputs(dir);

  // No `DRAFTGATE_DECISION`, so `writeDecision` returns early: nothing clicked here can approve.
  const opened = openWindow(dir, requestPath);
  const win = opened.win;

  /*
   * Race the attach against the window dying, so one that never starts fails as itself, not after
   * the 20s attach timeout. `win.exited` resolves at the end of every scenario, so the `.catch`
   * keeps a passing run from an unhandled rejection.
   */

  const diedFirst = win.exited.then((h): never => {
    throw new Error(`the window exited (code ${h.code}, signal ${h.signal}) before the probe finished`);
  });
  diedFirst.catch(() => {});

  try {
    const session = await Promise.race([opened.attach(), diedFirst]);
    try {
      const report = await gather(session, scenario, dir);
      writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
      checkReport(scenario, report, styles, check, note);
      note(`screenshot: ${join(dir, `${destination}.png`)}`);
    } finally {
      session.close();
    }
  } catch (e) {
    check(
      false,
      'the window answered this run\'s probe',
      `${(e as Error).message}\n${win.stderr().trim() || '(no stderr)'}`
    );
  } finally {
    win.kill();
  }
  return entries;
}

/** The faces `WKSession.platformFonts` matched, as a check's failure detail. */
function describeFaces(faces: PlatformFont[], selector: string): string {
  return faces.length === 0
    ? `no face was matched for ${selector}`
    : `drawn in ${faces.map((f) => `${f.familyName}${f.isCustomFont ? ' (web font)' : ''} x${f.glyphCount}`).join(', ')}`;
}

/**
 * Judge a report against a scenario. Pure (no window, filesystem or subprocess), so
 * `probe.test.ts` exercises it from hand-written reports.
 */
export function checkReport(
  scenario: Scenario,
  report: Report,
  styles: Record<string, Record<string, string>>,
  check: (ok: boolean, label: string, detail?: string) => void,
  note: (text: string) => void
): void {
  const { destination } = scenario;

  check(
    report.dom.destination === destination,
    `styled itself as "${destination}"`,
    `got "${report.dom.destination}"`
  );

  check(report.cspViolations.length === 0, 'no CSP violations', report.cspViolations.join('\n'));
  check(report.consoleErrors.length === 0, 'no console errors', report.consoleErrors.join('\n'));

  // The typeface must render, not merely be declared. See `Scenario.fontFamily`.
  if (scenario.fontFamily) {
    const got = report.dom.font;
    const want = scenario.fontFamily;
    check(
      got != null && got.resolved === want.resolves,
      `"${want.family}" ${want.resolves ? 'renders' : 'falls back (not bundled)'}`,
      got == null
        ? 'the census returned no font measurement'
        : `resolved=${got.resolved}, width=${got.width} vs fallback ${got.fallbackWidth}`
    );
    // The faces that draw the prose, every entry. The width match reads the paragraph's text in its
    // own style, so a run in another face (a `strong`, a mention) is invisible to it.
    const faces = report.dom.face ?? [];
    // Inline code draws in the code face, held by its own check below.
    const webFonts = faces.filter((f) => f.isCustomFont && f.familyName !== scenario.codeFont);
    check(
      faces.length > 0 &&
        (want.resolves
          ? webFonts.length > 0 && webFonts.every((f) => f.familyName === (want.drawnAs ?? want.family))
          : webFonts.length === 0),
      want.resolves
        ? `the prose is rasterised in the bundled "${want.drawnAs ?? want.family}"`
        : 'the prose is rasterised in a platform face, as the destination draws it',
      describeFaces(faces, '.ProseMirror p')
    );
    // The family's own italic, not a slant: see `Scenario.fontFamily`.
    if (want.italic) {
      const adv = report.dom.italicAdvances;
      check(
        adv != null && adv.style === 'italic' && adv.italicFaceLoaded && Math.abs(adv.italic - adv.upright) > 0.5,
        `*italic* is drawn in "${adv?.family ?? want.family}"'s own italic face (its advances differ from the upright's), not a synthetic slant`,
        JSON.stringify(adv)
      );
    }
  }

  // Every face drawing the code, block and inline, is the bundled `codeFont`.
  if (scenario.codeFont) {
    const want = scenario.codeFont;
    const only = (faces: PlatformFont[]) =>
      faces.length > 0 && faces.every((f) => f.isCustomFont && f.familyName === want);
    const block = report.dom.codeFace ?? [];
    check(
      only(block),
      `the code is rasterised in the bundled "${want}"`,
      describeFaces(block, '.ProseMirror pre code')
    );
    const inline = report.dom.inlineCodeFace;
    if (inline !== null && inline !== undefined) {
      check(
        only(inline),
        `inline code is rasterised in the bundled "${want}"`,
        describeFaces(inline, '.ProseMirror :not(pre) > code')
      );
    }
  }

  // The harness must not share the review's state: the bundle the loader launched (so its defaults
  // domain and containers), and whether its store persists -- a read-back of the host's
  // configuration, not an observation of where data went.
  check(
    report.isolation?.bundleId === HARNESS_BUNDLE_ID && report.isolation.persistentStore === false,
    `the window runs as ${HARNESS_BUNDLE_ID}, never the review's bundle, on a store that persists nothing`,
    `the window reported ${JSON.stringify(report.isolation ?? null)}`
  );

  // The policy refused something, which "nothing complained" cannot say. See `Report.cspRefusal`.
  check(
    report.cspRefusal !== undefined,
    "the policy is in force: connect-src 'none' refused the window its own url",
    "no connect-src refusal naming the window's url was reported; if the CSP is missing, every " +
      'other CSP check here is passing vacuously'
  );

  // Every pre-census step took effect, asserted before any count (see `runSetup`). Focus is not an
  // excuse for a missing bubble: `bubble: 1` passes with `document.hasFocus()` false.
  for (const step of report.dom.setup) {
    check(
      step.ok,
      `setup: ${step.step}(${step.arg}) took effect`,
      step.detail ?? 'the harness reported it did not take effect, and said no more'
    );
  }

  // The selection still live at census time, judged by `collapsed`, not focus. Not when the
  // scenario typed over it, which replaces the selection on purpose.
  if (scenario.selectText && scenario.typeText === undefined) {
    check(
      !report.dom.selection.collapsed,
      'the text this scenario selects was still selected at census time',
      'the selection was COLLAPSED when the census ran (document.hasFocus()=' +
        `${report.dom.selection.hasFocus}). Interacting with the machine during a run is enough ` +
        'to clear it, and every bubble-menu assertion below depends on it -- re-run on an idle ' +
        'machine before reading those as a regression.'
    );
  }

  // The theme asked for, asserted directly so one that never applied fails as itself, not as wrong
  // colours.
  check(
    report.dom.theme === (scenario.theme ?? 'light'),
    `booted in the ${scenario.theme ?? 'light'} theme`,
    `data-theme was ${report.dom.theme ?? '(unset)'} before any setup step ran`
  );

  const wrong = mismatches(scenario.counts, report.dom.counts);
  check(
    wrong.length === 0,
    `${Object.keys(scenario.counts).length} node counts`,
    wrong.join('\n')
  );
  if (scenario.links) {
    check(
      JSON.stringify(report.dom.links) === JSON.stringify(scenario.links),
      `the draft's ${scenario.links.length} links read and open what they should`,
      JSON.stringify(report.dom.links)
    );
  }
  if (scenario.linkTargets) {
    check(
      JSON.stringify(report.dom.linkTargets) === JSON.stringify(scenario.linkTargets),
      `the link-target bubble shows ${scenario.linkTargets.join(', ')}`,
      JSON.stringify(report.dom.linkTargets)
    );
  }

  /*
   * Every toolbar button's glyph is an `<svg>` from `ico()`, in every scenario: an equality, not
   * literals in `FIXTURE_COUNTS`, which only some scenarios spread and `mismatches` only compares
   * where declared. Both toolbars; the bubble's Link button is the same `LINK_CONTROL`.
   */
  const sameGlyphCount = (buttons: string, svgs: string) => {
    const { [buttons]: n, [svgs]: drawn } = report.dom.counts;
    check(
      drawn === n,
      `every ${buttons} carries one icon (${n})`,
      `${buttons}: ${n}, ${svgs}: ${drawn} -- a button whose glyph is not an svg is a letterform, ` +
        'which is what `ico()` exists to prevent'
    );
  };
  sameGlyphCount('tbBtn', 'tbGlyph');
  sameGlyphCount('bubbleBtn', 'bubbleGlyph');

  for (const [selector, props] of Object.entries(styles)) {
    const actual = report.dom.styles[selector];
    if (!actual) {
      check(false, `computed styles for ${selector}`, 'no such element to read from');
      continue;
    }
    // A selector that is only `SAMPLED_ONLY` would print a green line for comparing nothing;
    // `leadingBlock` checks it below.
    if (Object.values(props).every((v) => v === SAMPLED_ONLY)) continue;
    const bad = mismatches(props, actual);
    check(bad.length === 0, `${selector} computed as specified`, bad.join('\n'));
  }

  // Against the styles read while `:hover` was forced. A missing entry here is a surprise:
  // `forcePseudo` finding no node raises in `gather`.
  for (const [selector, props] of Object.entries(scenario.hoverStyles ?? {})) {
    const actual = report.dom.hoverStyles?.[selector];
    if (!actual) {
      check(false, `${selector}:hover was measured`, 'no forced-state reading came back for it');
      continue;
    }
    const wrongHover = mismatches(props, actual);
    check(
      wrongHover.length === 0,
      `${selector}:hover computed as specified`,
      wrongHover.join('\n')
    );
  }

  if (scenario.leadingBlock) {
    const { selector, marginTop, label } = scenario.leadingBlock;
    const actual = report.dom.styles[selector];
    check(
      actual?.marginTop === marginTop,
      `${selector} keeps its ${marginTop} top margin ${label}`,
      `got ${actual?.marginTop ?? '(no such element)'}`
    );
  }

  if (scenario.imageSources) {
    const img = report.dom.images;
    if (!img) {
      check(false, 'the window reported an image check');
    } else {
      // Inline data, no network: the policy lets a picture through at all (the fixture's URL serves
      // nothing, so its element is a broken image).
      check(
        img.dataUri.loaded && img.dataUri.naturalWidth > 0,
        'a data: image LOADS through the CSP',
        JSON.stringify(img.dataUri)
      );
      // Reported, not asserted, so no network fails nothing; a blocked fetch is a CSP violation.
      note(
        img.https.loaded
          ? `https: image loaded (${img.https.naturalWidth}px wide) -- img-src https: confirmed live`
          : 'https: image did not load -- offline, or the host is unreachable. Not a failure; a ' +
            'policy block would have surfaced as a CSP violation.'
      );
    }

    // The document pipeline: nothing fetched at render time (rejecting cannot take a fetch back),
    // and the whole URL and a control to fetch it on screen.
    const rendered = report.dom.renderedImage;
    check(rendered !== null, 'the window reported its image state');
    if (scenario.loadsImage) {
      check(
        rendered?.loaded !== null && rendered?.deferred === null,
        'clicking "Load image" fetched it, so the deferral is a delay and not a refusal',
        JSON.stringify(rendered)
      );
      // The fixture's URL serves nothing, so a broken element is correct.
      check(
        rendered?.loaded?.naturalWidth === 0,
        "the fixture's image is broken, as its dud URL implies",
        `naturalWidth ${rendered?.loaded?.naturalWidth} -- if this loaded, the fixture URL changed`
      );
    } else {
      check(
        rendered?.loaded === null,
        'NO image was fetched: a remote URL in a draft must not be requested before the reviewer acts',
        JSON.stringify(rendered?.loaded)
      );
      check(
        rendered?.deferred?.hasButton === true,
        'and the reviewer is offered a control to load it, so fidelity is one click away',
        JSON.stringify(rendered?.deferred)
      );
      // In full: a truncated host is how a lookalike domain gets waved through.
      check(
        rendered?.deferred?.url === FIXTURE_IMAGE_URL,
        'showing the whole URL, not an elision of it',
        `got ${JSON.stringify(rendered?.deferred?.url)}, expected ${FIXTURE_IMAGE_URL}`
      );
    }
  }
}

async function main() {
  if (!existsSync(join(HERE, 'dist', 'index.html'))) {
    console.error('The window is not built. Run: bun run build:surface');
    process.exit(1);
  }

  const arg = process.argv[2] ?? 'all';
  const targets = arg === 'all' ? Object.keys(SCENARIOS) : [arg];
  WEBKIT_HARNESS = (await buildHost(HOST_LAYOUT)).harness.bin;

  /*
   * Run the scenarios `CONCURRENCY` at a time, printed in declaration order. Each has its own
   * channel directory and `reporter().sub()`; the host takes no single-instance lock, and harness
   * windows are never key (`selection` is measured to survive `document.hasFocus() === false`).
   * `printed` trails `next`, so output matches a sequential run.
   */

  const results = new Array<string[] | undefined>(targets.length);
  let next = 0;
  let printed = 0;

  const flush = () => {
    for (let done; (done = results[printed]) !== undefined; printed++) {
      console.log(`\n${targets[printed]}`);
      // Already formatted and already counted, by `sub()`. This only decides when they appear.
      done.forEach((line) => console.log(line));
    }
  };

  const worker = async () => {
    for (let i = next++; i < targets.length; i = next++) {
      results[i] = await probe(targets[i]!);
      flush();
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  // Print anything still accumulated, then the tally. A probe run writes no harness nonce
  // (`openWindow` spawns the harness binary itself), so it has no key to leave behind;
  // `surface:e2e` is the verifier that fails if one survives its run.
  drain();
  finish('probes');
}

// Only when run directly, so `surface/harness/probe.test.ts` can import the pure half.
if (import.meta.main) main();
