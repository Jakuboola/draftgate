/**
 * Structured warnings emitted by `render()`.
 *
 * The idea comes from `markdown-to-adf`'s `markdownToAdfWithWarnings`; that library is not used.
 *
 * Severity is about *what the destination will do*, not about how bad it looks:
 *
 *   error   - the send will not deliver what you wrote. Do not send as-is.
 *   warning - delivered, but altered in a way the reviewer should see before approving.
 *   info    - delivered intact; only the rendering differs from the source.
 *
 * `error` covers two destination behaviours, because they need the same response from a human:
 *
 *   1. Outright rejection. Jira returns 400 INVALID_INPUT for a heading inside a blockquote and
 *      loses the entire comment.
 *   2. Silent destruction. The send succeeds and the recipient does not get what was written.
 *
 * Narrowing `error` to "the API rejects it" would make case 2 approvable.
 *
 * Case 2 has two instances. `body/structure-lost`: the reviewer builds something markdown cannot
 * spell, the serialiser writes the closest thing, and the draft arrives missing a piece
 * (destination-agnostic, so in `render.ts`; see `lostInMarkdown`). `jira/empty-body` on the shapes
 * Jira accepts (probed 201: an empty quote, code block, table or list), where the reader gets a
 * blank comment; its other shapes are a 400. Every other `error` is case 1, except `body/empty`,
 * which blocks unprobed for Slack and Linear: a body with nothing in it is nothing to send.
 *
 * A GFM table sent to Slack is not case 2: the rendered client draws it with borders and a bold
 * header row (`profiles/slack.ts`); only `slack_read_channel`, a read-back API, flattens it.
 *
 * Otherwise only claims backed by evidence get `error`; anything inferred is `warning` at most.
 * `Warning.unverified` marks an unconfirmed claim and the window labels it; no rule sets it at
 * present.
 */

export type Severity = 'error' | 'warning' | 'info';

/**
 * The optional fields a warning may carry: six of `Warning`'s nine fields are per-code, and the
 * registry below, not the consumers, says which code carries which.
 */
export type Carried = 'path' | 'nodeType' | 'unverified' | 'editorPath' | 'fixes' | 'field';

/**
 * What kind of input can produce a code.
 *
 *  - `markdown`  a markdown body reaches it through `render()`, so a fixture can exercise it.
 *  - `editor`    only a document the reviewer built reaches it (`render(body, dest, editorDoc)`).
 *  - `prose`     the other fields the agent wrote (a title, a summary), out of `render()`'s reach:
 *                `proseWarnings()` produces it, and the window merges it into its list and `blocked`.
 *  - `patch`     an edit operation's new text, when the payload is a delta (`core/src/patch.ts`):
 *                `patchWarnings()` produces it, and the window merges it as it does `prose`.
 *  - `adf`       only hand-built ADF reaches it: the converter never produces the shape, or a fixer
 *                removes it first (`core/test/acceptance.test.ts`). Kept because each is a probed
 *                Jira 400 that loses the whole comment.
 */
export type Reach = 'markdown' | 'editor' | 'adf' | 'prose' | 'patch';

export interface WarningSpec {
  /** Which module emits it. Informational; the code's prefix says the same thing. */
  readonly owner: 'render' | 'patch' | 'jira' | 'slack' | 'linear' | 'github';
  readonly reach: Reach;
  /** Every optional `Warning` field this code may set. `core/test/warnings.test.ts` sweeps it. */
  readonly carries: readonly Carried[];
  /**
   * Whether loading a draft into the editor can make this code disappear (true of `canonical`, not
   * of the body first shown), so it lands in `silenced` (`surface/src/useReview.ts`). Not a claim
   * that the round trip improves things: one of these means a checkbox was destroyed.
   * `surface/silencedWarnings.test.ts` derives the set from live probes and compares it with this
   * column; its `CASES` must reach each flagged code, or the guard is inert for it.
   */
  readonly silencedByRoundTrip?: true;
  /**
   * The destination refuses the call for the body's length. Read by `isLengthRefusal`: no repair can
   * fix it, so `render()` skips `suggestFix`, and the CLI denies it as a message to shorten rather
   * than as `BLOCKED_AFTER_APPROVAL`, which means a stale install.
   */
  readonly lengthRefusal?: true;
}

/**
 * Every warning code `core` can emit, as a registry; `WarningCode` is its keys, not `string`, so a
 * typo fails to typecheck in the producer and in every consumer (`review.ts`'s empty-body backstop,
 * the window's silenced set, tests asserting a code by name), as with `DenialCode` in
 * `cli/src/types.ts`. Each row states what input reaches the code, which optional fields it carries
 * and whether the round trip can silence it; `core/test/warnings.test.ts` checks all three against
 * `render()` over the shipped fixtures plus one minimal body per code.
 *
 * The CLI's `body/` denial codes (`body/missing-field`, `body/wrong-type` and the rest, in
 * `cli/src/payload.ts` and `cli/src/types.ts`) share the namespace by convention only: they describe
 * the payload, which `render()` never sees.
 */
export const WARNING_CODES = {
  'body/empty': { owner: 'render', reach: 'markdown', carries: [] },
  // `body/empty` one field over: a prose field set to nothing. An `error`: Jira answers 400 and
  // writes nothing, the body included (the probe is at `proseWarnings` in `render.ts`).
  'prose/empty': { owner: 'render', reach: 'prose', carries: ['field'] },
  /*
   * A title the destination refuses for its length: `error` past a probed refusal, `warning` inside
   * the bracket nobody has resolved (GitHub's title, accepted at 1,024 and refused at 4,096). The
   * limits are `DestinationProfile.lineLimits`; the producer is `prose/empty`'s.
   */
  'prose/too-long': { owner: 'render', reach: 'prose', carries: ['field'] },
  /*
   * A CR or LF in a line field, which the window's `<input>` strips from what it shows while the
   * agent's value is still sent. `error` where the destination was probed refusing it (Jira's
   * `summary`: 400, nothing written), `warning` elsewhere. The facts are
   * `DestinationProfile.lineBreaks`; the window draws the break as a control picture.
   */
  'prose/line-break': { owner: 'render', reach: 'prose', carries: ['field'] },
  /*
   * A C0/C1 or bidi control in a line field: draws nothing, or reverses what is drawn
   * (U+202E), and is stored verbatim where probed (GitHub, Linear). Always a `warning`.
   */
  'prose/control-character': { owner: 'render', reach: 'prose', carries: ['field'] },
  /*
   * An edit whose new text the tool's schema refuses empty (`minLength: 1` on an insertion, read off
   * the live schema): Claude Code validates the tool input against it, so the whole call fails. An
   * `error`; `field` is the edit's path. A replacement's empty text is a deletion and never warns.
   */
  'patch/empty-text': { owner: 'patch', reach: 'patch', carries: ['field'] },
  'body/structure-lost': { owner: 'render', reach: 'editor', carries: ['editorPath'] },
  /*
   * `body/structure-lost`'s sibling for formatting: a mark the reviewer applied that the markdown
   * does not carry back, so the reader may see literal `~~` or `*`. `warning`: the text arrives.
   * `editorPath` is the top-level block that lost it, when blocks pair up (`lostMarks`). Not
   * `silencedByRoundTrip`: it needs a document, and the load path passes none.
   */
  'body/mark-lost': { owner: 'render', reach: 'editor', carries: ['editorPath'] },
  /*
   * The text sibling: characters on screen that the markdown reads back as something else (a
   * line-start `#` sent as a heading). A backstop over the writer's escaping, so `warning`. Asked at
   * load and on an edit, but it needs a document: `editor` reach. `editorPath` as for
   * `body/mark-lost`. Not `silencedByRoundTrip`: `canonical`'s own render passes no document.
   */
  'body/text-changed': { owner: 'render', reach: 'editor', carries: ['editorPath'] },
  'link/unsafe-href': { owner: 'render', reach: 'markdown', carries: [] },
  /*
   * A link whose text reads as one host and whose target is another. `warning`: the send delivers
   * what was written, and every destination shows its recipient the real target before opening
   * (probed); the gap is the reviewer's. Reached from markdown (`[https://a.test](https://b.test)`)
   * and, where no picture is drawn, from an image whose alt text is a URL, since it arrives as a
   * link. Not `silencedByRoundTrip`: loading keeps every label and href. See `core/src/linkHosts.ts`.
   */
  'link/text-host-mismatch': { owner: 'render', reach: 'markdown', carries: [] },
  'jira/blockquote-child-rejected': { owner: 'jira', reach: 'markdown', carries: ['path', 'nodeType'] },
  'jira/list-item-block-child': { owner: 'jira', reach: 'adf', carries: ['path', 'nodeType'] },
  'jira/panel-child-rejected': { owner: 'jira', reach: 'adf', carries: ['path', 'nodeType'] },
  'jira/table-cell-forbidden-child': { owner: 'jira', reach: 'adf', carries: ['path', 'nodeType'] },
  // `taskList > bulletList` is a probed 400 the converter never emits from markdown
  // (`listToAdf` un-nests it and discloses that below), so this is defence behind the fixer.
  'jira/task-list-child-rejected': { owner: 'jira', reach: 'adf', carries: ['path', 'nodeType'] },
  // `listItem > paragraph > mediaSingle` is a live 400 that markdown produces; `hoistMedia` moves
  // the media before the checker looks, so from markdown this rule is defence behind the fixer.
  'jira/block-child-in-inline-container': { owner: 'jira', reach: 'adf', carries: ['path', 'nodeType'] },
  'jira/task-item-media-only': { owner: 'jira', reach: 'markdown', carries: [], silencedByRoundTrip: true },
  /*
   * Silenceable, and not an improvement, like `jira/task-item-media-only`: `- [ ] a` over a
   * two-space `- b` warns on `canonical` and not on the body first shown, because loading applies
   * the un-nesting the warning discloses.
   */
  'jira/task-item-nested-list-unnested': {
    owner: 'jira',
    reach: 'markdown',
    carries: [],
    silencedByRoundTrip: true,
  },
  // Silenceable, like the row above: loading moves an indented `> quote` under `- a` out of the
  // item, which is what the warning discloses.
  'jira/list-item-block-moved-out': {
    owner: 'jira',
    reach: 'markdown',
    carries: [],
    silencedByRoundTrip: true,
  },
  /*
   * Silenceable, like the rows above: loading applies the strip the warning discloses. `warning`:
   * the strip prevents the 400, so Jira delivers the message, with the emphasis no longer covering
   * the code span.
   */
  'jira/code-span-emphasis-lost': {
    owner: 'jira',
    reach: 'markdown',
    carries: [],
    silencedByRoundTrip: true,
  },
  /*
   * The length refusals, one per destination. Past a probed limit the call is refused after the
   * reviewer approved (a Jira 400, a GitHub 422, a Linear `INVALID_INPUT`, Slack's `msg_too_long`),
   * so each is an `error`. Jira's count is not the ADF it sends and is known only as a lower bound,
   * so it has a second code: a `warning` near the limit, where the lower bound cannot say. See
   * `core/src/lengthLimit.ts`.
   */
  'jira/body-too-long': { owner: 'jira', reach: 'markdown', carries: [], lengthRefusal: true },
  'jira/body-near-limit': { owner: 'jira', reach: 'markdown', carries: [] },
  'slack/body-too-long': { owner: 'slack', reach: 'markdown', carries: [], lengthRefusal: true },
  'linear/body-too-long': { owner: 'linear', reach: 'markdown', carries: [], lengthRefusal: true },
  'github/body-too-long': { owner: 'github', reach: 'markdown', carries: [], lengthRefusal: true },
  // `path` here points at the document root.
  'jira/empty-body': { owner: 'jira', reach: 'markdown', carries: ['path', 'nodeType'] },
  'jira/image-degraded-to-text': { owner: 'jira', reach: 'markdown', carries: [] },
  'jira/external-image-embedded': { owner: 'jira', reach: 'markdown', carries: [] },
  'slack/image-becomes-link': { owner: 'slack', reach: 'markdown', carries: [], silencedByRoundTrip: true },
  'slack/heading-level-collapsed': { owner: 'slack', reach: 'markdown', carries: [] },
  // Not `silencedByRoundTrip`: the round trip keeps `- a` as `- a`, so the code is as true of the
  // body shown as of `canonical`.
  'slack/list-item-becomes-task': { owner: 'slack', reach: 'markdown', carries: [] },
  /*
   * A line starting `\>` that Slack draws as a quote (probed). Not `silencedByRoundTrip`: loading
   * keeps a column-0 `\>` where it is. Loading can add one (an indented `\>` whose indent the writer
   * drops), which puts the warning on screen rather than in the silenced column.
   */
  'slack/escaped-quote-marker': { owner: 'slack', reach: 'markdown', carries: [] },
  'slack/url-swallows-next-line': { owner: 'slack', reach: 'markdown', carries: ['fixes'], silencedByRoundTrip: true },
  'slack/url-label-elided': { owner: 'slack', reach: 'markdown', carries: [], silencedByRoundTrip: true },
  // Silenceable: `jira/list-item-block-moved-out`'s Slack twin. Loading moves the code block,
  // paragraph or quote out of the item.
  'slack/list-item-block-moved-out': {
    owner: 'slack',
    reach: 'markdown',
    carries: [],
    silencedByRoundTrip: true,
  },
  /*
   * GitHub's five rendering codes: three `info`, two `warning` (`github/body-too-long` is a length
   * refusal, above). GitHub stores the markdown and renders more of it than this preview draws, and
   * rejects no structure a GFM body can express, so there is no rendering `error`.
   * `github/html-stripped` is a `warning`: GitHub silently deletes `<u>`, `<small>`, `<abbr>` and a
   * dozen others, keeping the text (probed tag by tag through `POST /markdown`, GitHub's own
   * renderer; see `github.ts`). `<u>` is the sharp case, since markdown has no underline. None of the
   * five is `silencedByRoundTrip`, measured: the editor returns every one of these inputs byte for
   * byte (twelve GFM shapes, only a table's `|---|` re-spelled).
   */
  'github/alert-becomes-callout': { owner: 'github', reach: 'markdown', carries: [] },
  'github/html-rendered': { owner: 'github', reach: 'markdown', carries: [] },
  'github/html-stripped': { owner: 'github', reach: 'markdown', carries: [] },
  'github/image-proxied': { owner: 'github', reach: 'markdown', carries: [] },
  /*
   * An HTML comment GitHub hides from readers (probed), a `warning` like `github/html-stripped`:
   * delivered byte for byte, and not shown. Not `silencedByRoundTrip`: the editor keeps the comment
   * as text.
   */
  'github/html-comment-hidden': { owner: 'github', reach: 'markdown', carries: [] },
} as const satisfies Record<string, WarningSpec>;

export type WarningCode = keyof typeof WARNING_CODES;

export interface Warning {
  /**
   * Stable, greppable identifier. Never reword these -- the audit log is keyed on them. A member of
   * `WARNING_CODES`, so a new code is a new row there first.
   */
  code: WarningCode;
  severity: Severity;
  /** One line, written for a human glancing at a review surface. */
  message: string;
  /** Where in the converted tree, as a readable path: `doc.content[7].content[0]`. */
  path?: string;
  /** The offending node type, when there is one. */
  nodeType?: string;
  /**
   * Which prose field this is about, as the path the operator wrote (`fields.summary`). Set by the
   * `prose/` warnings, since a route may carry several prose fields; the same string the window puts
   * in the input's `placeholder`, `title` and `aria-label`. Not `path`, which points into the
   * converted ADF tree (`doc.content[7]`).
   */
  field?: string;
  /**
   * True when the claim has not been confirmed against a real destination. The window marks such a
   * row "(unverified)"; no rule in `core` sets it at present.
   */
  unverified?: boolean;
  /**
   * Where in the editor's document this warning is, as child indices from the root (see
   * `LostNode.path`). Set by the three `editor`-reach codes, `body/structure-lost`, `body/mark-lost`
   * and `body/text-changed`, which walk the editor's document; every other warning comes from the
   * markdown text or the converted tree, which cannot index it. Not `path`, a readable string into
   * the converted tree for a log reader. Never crosses the wire: the window calls `render()` itself.
   */
  editorPath?: number[];
  /**
   * One-click repairs for this warning, when the profile can derive them from the draft. A list:
   * `slack/url-swallows-next-line` offers two that render differently (an explicit link shows the
   * full URL; a blank line after the bare URL keeps Slack's elided `example.org`). Each `body` is the
   * whole repaired canonical markdown, as `RenderResult.suggestedFix` is, and `render()` recomputes
   * every warning after one is applied.
   *
   * Offered, not applied. `hoistMedia` repairs silently because not repairing is a certain Jira 400
   * that loses the comment, there is exactly one correct repair, and it keeps the image immediately
   * after the container it could not stay inside (probed: 201), not at the end of the accepting
   * ancestor, past every later sibling. Even so, a checklist item holding only an image loses its
   * checkbox, so that is disclosed (`jira/task-item-media-only`). A warning's draft sends fine, often
   * has more than one repair, and auto-applying would make `edited` misreport what the human changed.
   * `slack/image-becomes-link` names a fix in prose ("upload the file to the channel") and gets no
   * button: draftgate holds no destination credentials and never contacts a destination.
   */
  fixes?: FixOffer[];
}

/**
 * One repair the reviewer can accept, as offered. No `code`: a warning's repairs inherit its code,
 * which the audit log groups by. `RenderResult.suggestedFix` has no warning, so it is a full `Fix`.
 */
export interface FixOffer {
  /** What the reviewer reads on the button and at the head of the before/after preview. */
  label: string;
  /** The whole repaired canonical markdown, not a patch. */
  body: string;
}

/**
 * A repair that names itself, for the one that belongs to no warning. `code` is what the audit log
 * and the digest group by: never reword it.
 */
export interface Fix extends FixOffer {
  code: FixCode;
}

/**
 * What a repair may be named after: the warning it remedies, or the one whole-document repair a
 * blocked draft offers. The wire and the audit log keep `string` -- a stale renderer may name a code
 * this build does not know -- so this union is the producer's vocabulary only.
 */
export type FixCode = WarningCode | typeof SUGGESTED_FIX_CODE;

/**
 * The reserved code for the whole-document repair a blocked draft offers: the name of a thing
 * `render()` produces, in `core` beside every other repair identity so the window does not compose it.
 */
export const SUGGESTED_FIX_CODE = 'render/suggested-fix';

/**
 * The label the whole-document repair is offered under, for any destination (only Jira offers one
 * today). A profile that wants its own wording returns a `Fix` instead of a body (see `render()`).
 */
export const SUGGESTED_FIX_LABEL = 'Suggested fix';

export function warn(w: Warning): Warning {
  return w;
}

/**
 * Sort most-severe-first, then by path, so review surfaces get a stable order. Code points, not
 * `localeCompare`, whose tie-break follows the runtime's locale (the OS's, in the renderer), so two
 * machines would order the rows, and the logged `warnings`, differently. Paths are machine-written
 * (`doc.content[0].content[1]`), so no human collation is lost.
 */
export function sortWarnings(ws: Warning[]): Warning[] {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return [...ws].sort((a, b) => {
    const bySeverity = rank[a.severity] - rank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const x = a.path ?? '';
    const y = b.path ?? '';
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * Does this one warning block the send? Its own function so `surface/src/settledWarnings.ts`, which
 * needs the blocking subset, uses the same predicate that decides whether Approve is live.
 */
export function isBlocking(w: Warning): boolean {
  return w.severity === 'error';
}

/** Is this a refusal for length? See `WarningSpec.lengthRefusal`. */
export function isLengthRefusal(w: Pick<Warning, 'code'>): boolean {
  const spec: WarningSpec = WARNING_CODES[w.code];
  return spec.lengthRefusal === true;
}

export function hasBlockingWarning(ws: Warning[]): boolean {
  return ws.some(isBlocking);
}
