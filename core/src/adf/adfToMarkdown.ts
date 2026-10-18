/**
 * ADF → Markdown recursive tree walker.
 *
 * Guiding principles:
 * - Recursive tree walker, never regex-based string replacement
 * - Unhandled nodes produce visible placeholders, never silent drops
 * - Media resolved inline via pre-built mediaMap
 * - A mention is written as its @display text; a body that keeps the id is written by
 *   `markdownFromAdf` (`core/src/editor.ts`), which encodes it first
 */

import { AdfNode, AdfDocument, AdfMark, MediaMap } from './types';
import { convertMarkdownToAdf, isBlockStart, isFlankingBoundary, isRule, TASK_ITEM_RE, verbatimSpans } from './markdownToAdf';
// The same table the other direction reads. See `walkChildren`.
import { BLOCK_MEDIA, INLINE_ONLY, INLINE_TYPES, LIST_TYPES } from '../adfSchema';
// How a link is spelled so the converter reads it back.
import { isEscaped, writeCodeSpan } from '../codeSpan';
import { type AngleSpelling, writeAngleLink, writeLink } from '../linkDestination';
import {
  stripFilenameUuid,
  isImageReference,
  escapeTableCell,
  withoutSpace,
} from './util';

// ---------------------------------------------------------------------------
// Walk context (tracks list nesting and table state)
// ---------------------------------------------------------------------------

interface WalkContext {
  listTypes: ('bullet' | 'ordered' | 'task')[];
  orderedCounters: number[];
  /** Marker indentation for items at each active list level */
  listIndents: string[];
  inTableCell: boolean;
}

function defaultContext(): WalkContext {
  return {
    listTypes: [],
    orderedCounters: [],
    listIndents: [],
    inTableCell: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function convertAdfToMarkdown(
  doc: AdfDocument | AdfNode,
  mediaMap: MediaMap = {}
): string {
  const raw = walkNode(doc as AdfNode, defaultContext(), mediaMap);
  return raw.replace(FENCE_OR_BLANK_RUN, (_, fence) => fence ?? '\n\n').trim();
}

/**
 * One textblock's inline run (a paragraph, heading, checklist item's text or table cell's paragraph),
 * with the inline escapes applied only if it needs them (see `walkText`). Decided per textblock: one
 * unrepairable `\# of tickets` line in a wider unit would send the plain form for all of it, and
 * literal `**URGENT**` elsewhere would go out bold.
 *
 * Two gates, cheapest first. A scan for escapable characters: without it every `fromEditorDoc` call,
 * i.e. every keystroke, pays a full parse (6.9 ms vs 2.6 ms per call on a 51 KB draft that never needs
 * escaping). Then a verified repair, as `hoistMedia`'s is: an escaped form that does not read back is
 * discarded and the plain form goes out. The run is read back as its own paragraph, line starts
 * escaped as `walkParagraph` escapes them; block context never changes how inline characters pair.
 */
function writeInline(
  node: AdfNode,
  ctx: WalkContext,
  writeChild: (child: AdfNode) => string
): string {
  const children = withAngleRunsMerged(node.content!);
  const plain = writeInlineRuns(children, ctx, writeChild, false);
  if (!textCouldNeedEscaping(node)) return plain;
  const text = withoutSpace(textOf(node));
  // A block holding an angle link was read by a converter that reads `<url|label>`, so it is read
  // back the same way: read without, the label comes back as its raw span and no repair can pass.
  const angleLinkLabels = children.some((child) => angleLinkOf(child.marks) !== undefined);
  if (readsBackAs(text, plain, angleLinkLabels)) return plain;
  const escaped = writeInlineRuns(children, ctx, writeChild, true);
  return readsBackAs(text, escaped, angleLinkLabels) ? escaped : plain;
}

/**
 * A fence `walkCodeBlock` wrote, or a run of blank lines between blocks. The `\n{3,}` tidy is for block
 * spacing, so a fence is matched first and written back untouched (its `a\n\n\n\nb` is content). It
 * opens at a line start, after a list item's indent and marker if it is that item's first block, and
 * closes on the next line that is only indent and the same backticks, as `walkCodeBlock` ends it.
 */
const FENCE_OR_BLANK_RUN = /^( *(?:(?:[-+*]|\d+\.) +)?(`{3,})[^`\n]*\n[\s\S]*?\n *\2$)|\n{3,}/gm;

/** Does any text node hold a character that escaping would change? A scan, not a parse. */
function textCouldNeedEscaping(node: AdfDocument | AdfNode): boolean {
  const text = inlineText(node as AdfNode);
  if (typeof text === 'string' && (TEXT_NEEDS_ESCAPE.test(text) || underscoreCouldPair(text))) return true;
  for (const child of (node as AdfNode).content ?? []) {
    if (textCouldNeedEscaping(child)) return true;
  }
  return false;
}

/**
 * Does this inline markdown, read back as a paragraph, give back `text` (whitespace removed)? The
 * oracle for "does this run need escaping". Text only, in order: escaping cannot fix a structural
 * difference, and `hoistMedia`'s re-hoist moves media between passes on purpose. Whitespace aside, as
 * in `withoutSpace`. A static import: `markdownToAdf` does not import this module, and
 * `core/test/purity.test.ts` forbids `require()`.
 */
function readsBackAs(text: string, inline: string, angleLinkLabels: boolean): boolean {
  const readBack = (markdown: string) => withoutSpace(textOf(convertMarkdownToAdf(markdown, { angleLinkLabels })));
  try {
    const written = escapeLineStarts(inline);
    if (text !== readBack(written)) return false;
    // And with each line break a space: this converter reads a paragraph a line at a time, but every
    // markdown destination reads a hard break written as `\n` as a soft line ending, so a delimiter
    // pairs across it (`Set \_foo to 1` over `and type_ to 2` sent bare is italic on GitHub between
    // the two). The same holds for `*` and a backtick.
    return !mayPairAcrossLines(written) || text === readBack(written.replace(/\n/g, ' '));
  } catch {
    // A run the parser cannot read is not evidence that escaping would help.
    return true;
  }
}

/**
 * Whether anything in `written` could pair across a line break: a delimiter character on one line
 * and the same one on a later line, or a `[` with a `]` after it. Nothing else can make the joined
 * read differ, and that read is a second parse on the keystroke path: measured on a 40 KB draft whose
 * two-line blocks all take the read-back, 3.70 ms per `fromEditorDoc` without this check against
 * 1.72 ms with no joined read at all.
 */
function mayPairAcrossLines(written: string): boolean {
  if (!written.includes('\n')) return false;
  const seen = new Set<string>();
  for (const line of written.split('\n')) {
    for (const c of PAIRS_ACROSS) {
      // An underscore between two letters pairs with nothing, as at the cheap gate.
      const holds = c === '_' ? underscoreCouldPair(line) : line.includes(c);
      if (seen.has(c) && (c === '[' ? line.includes(']') : holds)) return true;
      if (holds) seen.add(c);
    }
  }
  return false;
}

/** Every text node's content, concatenated in document order. */
function textOf(node: AdfDocument | AdfNode): string {
  let out = inlineText(node as AdfNode) ?? '';
  for (const child of (node as AdfNode).content ?? []) out += textOf(child);
  return out;
}

// ---------------------------------------------------------------------------
// Node dispatcher
// ---------------------------------------------------------------------------

function walkNode(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  switch (node.type) {
    // Document root
    case 'doc':
      return walkChildren(node, ctx, mediaMap);

    // Block nodes
    case 'paragraph':
      return walkParagraph(node, ctx, mediaMap);
    case 'heading':
      return walkHeading(node, ctx, mediaMap);
    case 'bulletList':
      return walkList(node, ctx, mediaMap, 'bullet');
    case 'orderedList':
      return walkList(node, ctx, mediaMap, 'ordered');
    case 'listItem':
      return walkListItem(node, ctx, mediaMap);
    case 'codeBlock':
      return walkCodeBlock(node);
    case 'blockquote':
      return walkBlockquote(node, ctx, mediaMap);
    case 'rule':
      return '---\n\n';
    case 'mediaSingle':
      return walkMediaSingle(node, ctx, mediaMap);
    case 'media':
      return walkMedia(node, mediaMap);
    case 'table':
      return walkTable(node, ctx, mediaMap);
    case 'tableRow':
    case 'tableHeader':
    case 'tableCell':
      // Handled by walkTable -- standalone calls fall through
      return walkChildren(node, ctx, mediaMap);
    case 'taskList':
      return walkTaskList(node, ctx, mediaMap);
    case 'taskItem':
      return walkTaskItem(node, ctx, mediaMap);
    case 'expand':
      return walkExpand(node, ctx, mediaMap);

    // Inline nodes
    case 'text':
      return walkText(node);
    case 'mention':
      // Outside an inline container -- none the converter produces; inside one, `nextInlinePiece`
      // writes it, escaped as text.
      return mentionText(node);
    case 'hardBreak':
      return ctx.inTableCell ? ' ' : '\n';

    // Visible fallback -- never silent drops
    default:
      return `[unsupported: ${node.type}]`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/*
 * Media inside an inline-only container is written inline. `walkMediaSingle` ends every media with
 * `\n\n`, right for ADF's block position and wrong for the shape `inlineMedia` produces (an image kept
 * where markdown wrote it): `See ![x](url) for the timeline.` would come back as three blocks.
 *
 * `INLINE_ONLY` (`core/src/adfSchema.ts`, read by both directions), not `'paragraph'`: trimming in
 * `walkParagraph` alone turns `"# See ![d](url) here"` into `"# See ![d](url)\n\n here"`, and a task
 * item likewise, which `lostInMarkdown` cannot see because the paragraph count goes up. Any other
 * container (`doc`, list item, blockquote, table cell) keeps the separator.
 */
function walkChildren(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  if (!node.content) return '';
  const inline = INLINE_ONLY.has(node.type);
  const writeChild = (child: AdfNode): string => {
    const written = walkNode(child, ctx, mediaMap);
    return inline && BLOCK_MEDIA.has(child.type) && written.endsWith('\n\n')
      ? written.slice(0, -2)
      : written;
  };
  if (!inline) return node.content.map(writeChild).join('');
  return writeInline(node, ctx, writeChild);
}

/** Shared by every unmarked node rather than allocated per node. Never mutated. */
const NO_MARKS: AdfMark[] = [];

/**
 * Inline children, written as stretches that share a mark rather than one node at a time. Per node,
 * `**a *b***` comes out `**a** ***b***`, `**`code` and words**` comes out `**`code`** **and words**`
 * (an approval sends the body shown, so each logs an `after`), and `[**`c` x**](url)` becomes two
 * links, since each node carries its own copy of the `link` mark.
 *
 * Stretches are greedy and maximal and may begin anywhere: extend while the mark intersection stays
 * non-empty, emit, continue from the node that failed (linear). Lifting only what the whole run shares
 * would let one plain word defeat it (`a **`c`** b`). Greedy is not always widest (`[strong]`,
 * `[strong, em]`, `[em]` groups the first two) but every split is valid with the marks intact.
 * Stretches break at any non-text node (a `mention`, a `hardBreak`, an inline image).
 *
 * This is the keystroke path (`markdownFor` -> `fromEditorDoc`), hence the unmarked fast path.
 * Measured against per-node writing, 400 paragraphs x 12 text nodes, best of 7 x 30: all-plain
 * **0.221 ms vs 0.271**, all-marked **0.563 vs 0.605**, sparsely marked **0.456 vs 0.365** (+25%,
 * the cost of grouping).
 */
function writeInlineRuns(
  children: AdfNode[],
  ctx: WalkContext,
  writeChild: (child: AdfNode) => string,
  escape: boolean
): string {
  let out = '';
  let i = 0;
  while (i < children.length) {
    const [piece, next] = nextInlinePiece(children, i, writeChild, escape);
    // One join for every branch, so none can skip the `!` rule.
    out = appendInline(out, piece);
    i = next;
  }
  return out;
}

/** The piece that starts at `children[i]`, and the index after it. See `writeInlineRuns`. */
function nextInlinePiece(
  children: AdfNode[],
  i: number,
  writeChild: (child: AdfNode) => string,
  escape: boolean
): [string, number] {
  const node = children[i];
  // A mention's label is text to every reader, so it is escaped as text is.
  if (node.type === 'mention') return [writeText({ type: 'text', text: mentionText(node) }, escape, NO_MARKS, AT_EDGES), i + 1];
  if (node.type !== 'text') return [writeChild(node), i + 1];
  const own = node.marks;
  if (own === undefined || own.length === 0) return [writeText(node, escape, NO_MARKS, AT_EDGES), i + 1];
  let shared = liftable(own);
  let end = i;
  while (shared.length > 0 && end + 1 < children.length) {
    const next = children[end + 1];
    if (next.type !== 'text') break;
    const narrowed = intersectMarks(shared, next);
    if (narrowed.length === 0) break;
    shared = narrowed;
    end++;
  }
  // A node whose only mark is `code` opens no stretch: `applyMarks` puts any emphasis around the
  // backticks itself, because in markdown the span is innermost. An angle link is innermost too.
  if (shared.length === 0) return [writeText(node, escape, own, neighboursOf(children, i, i)), i + 1];
  return [writeStretch(children, i, end, shared, escape), end + 1];
}

/**
 * `out` followed by the next inline piece, with a `!` that would become an image marker escaped. Text
 * ending in `!` beside a piece starting `[` (a link, a hoisted bold link, a bare URL as `[url](url)`)
 * is `![label](url)` to every reader: the `!` vanishes and the link becomes a broken image. Probed:
 * Linear stores `Yes![docs](url)` verbatim and renders a broken image. The inline repair cannot see
 * it: `!` is not in its set, and the text survives as the image's alt. Only an unescaped `!` counts.
 */
function appendInline(out: string, piece: string): string {
  const last = out.length - 1;
  // `](` rather than `[` alone: `[card]` or `[Attachment ... could not be resolved]` after a `!` is
  // no image, and escaping there would change bytes nobody edited.
  if (piece[0] !== '[' || out[last] !== '!' || isEscaped(out, last) || !piece.includes('](')) {
    return out + piece;
  }
  return out.slice(0, last) + '\\!' + piece;
}

/** One stretch, with the marks it shares written once around the lot. Indices, so nothing is sliced. */
function writeStretch(
  children: AdfNode[],
  from: number,
  to: number,
  shared: AdfMark[],
  escape: boolean
): string {
  const lifted = shared.map(markKey);
  let inner = '';
  for (let k = from; k <= to; k++) {
    const node = children[k];
    inner = appendInline(
      inner,
      writeText(node, escape, (node.marks ?? []).filter((m) => !lifted.includes(markKey(m))), neighboursOf(children, k, k))
    );
  }
  return wrapMarks(inner, shared, neighboursOf(children, from, to));
}

/** What sits beside `children[from..to]`. */
function neighboursOf(children: AdfNode[], from: number, to: number): Neighbours {
  return { before: edgeChar(children[from - 1], -1), after: edgeChar(children[to + 1], 0) };
}

/**
 * The character a neighbouring inline node puts beside a stretch, for `wrapMarks`' choice of
 * delimiter: `undefined` at the block's edge, a newline for a hard break, a text node's own first or
 * last character (an escape only ever adds a backslash before punctuation, so the class is the
 * same written). Anything else -- a mention, an image, a card -- counts as a letter, which keeps
 * the stars.
 */
function edgeChar(node: AdfNode | undefined, at: 0 | -1): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'hardBreak') return '\n';
  return node.type === 'text' && node.text ? node.text.at(at) : 'x';
}

/**
 * A mark's identity for "do these two nodes carry the same mark". `link` by href (adjacent spans to
 * different pages are two links) and by angle spelling; every other mark by type, since none carries
 * an attribute that changes its markdown.
 */
function markKey(mark: AdfMark): string {
  return mark.type === 'link' ? `link:${String(mark.attrs?.href ?? '')}:${angleOf(mark) ?? ''}` : mark.type;
}

/** How a link mark was spelled as an angle link, or `undefined` for every other mark. See `writeAngleLink`. */
function angleOf(mark: AdfMark): AngleSpelling | undefined {
  const angle = mark.type === 'link' ? mark.attrs?.angle : undefined;
  return angle === 'bare' || angle === 'labelled' ? angle : undefined;
}

/** The angle link among `marks`, if there is one. */
function angleLinkOf(marks: readonly AdfMark[] | undefined): AdfMark | undefined {
  return marks?.find((m) => angleOf(m) !== undefined);
}

/**
 * The marks a stretch may lift off a node: everything but `code` and an angle link, which are both
 * innermost. An angle link's label is written as its characters, so nothing can sit inside it.
 */
function liftable(marks: readonly AdfMark[]): AdfMark[] {
  return marks.filter((m) => m.type !== 'code' && angleOf(m) === undefined);
}

/**
 * `children` with each run of text nodes sharing one angle link merged into one node, so the link is
 * written once: a reviewer who bolds half a label would otherwise send two links, `<u|ab><u|*c*>`.
 * The merged node keeps the marks the whole run shared; one that covered only part of the label has
 * no spelling inside `<url|label>` and is dropped, which `lostMarks` reports. The same array when
 * nothing merges, which is every draft without one: this is the keystroke path.
 */
function withAngleRunsMerged(children: AdfNode[]): AdfNode[] {
  let out: AdfNode[] | undefined;
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    const link = node.type === 'text' ? angleLinkOf(node.marks) : undefined;
    let end = i;
    while (link !== undefined && children[end + 1]?.type === 'text' && intersectMarks([link], children[end + 1]!).length > 0) end++;
    if (end === i) {
      out?.push(node);
      continue;
    }
    out ??= children.slice(0, i);
    const run = children.slice(i, end + 1);
    out.push({
      type: 'text',
      text: run.map((n) => n.text ?? '').join(''),
      marks: run.reduce(intersectMarks, [...(node.marks ?? [])]),
    });
    i = end;
  }
  return out ?? children;
}

/** Everything but `code`: the marks that go outside a code span. `liftable` is the stretch's set. */
function withoutCode(marks: readonly AdfMark[]): AdfMark[] {
  return marks.filter((m) => m.type !== 'code');
}

/**
 * Those of `shared` that `node` carries too, keeping `shared`'s order. A linear scan, not a `Set`: one
 * to three marks per candidate node on the keystroke path.
 */
function intersectMarks(shared: AdfMark[], node: AdfNode): AdfMark[] {
  const theirs = node.marks;
  if (theirs === undefined || theirs.length === 0) return [];
  return shared.filter((mark) => {
    const key = markKey(mark);
    return theirs.some((other) => markKey(other) === key);
  });
}

// ---------------------------------------------------------------------------
// Block node walkers
// ---------------------------------------------------------------------------

function walkParagraph(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  const content = walkChildren(node, ctx, mediaMap);
  if (ctx.inTableCell) return content;
  return escapeLineStarts(content) + '\n\n';
}

/*
 * A paragraph's line that would re-parse as a block is escaped, always: `# of tickets`, `- 50 EUR`,
 * `2020. was`, `> not a quote` or `---` would otherwise go out as a heading, list, quote or rule while
 * the editor showed text. Not left to the inline repair, whose re-parse by this converter does not
 * read `1)` as a list, `===` as a setext underline, a fence with a spaced info string, a pipe-less
 * delimiter row or a link reference definition, though every markdown destination does. Only a line
 * that would start a block in one reader or the other is escaped, so ordinary prose gains nothing.
 * Every line, since a `hardBreak` is a newline and all of these interrupt a paragraph.
 *
 * Applied to the written line, after marks and inline escapes: `**# x**`, or a line the repair already
 * starts with `\`, needs nothing. The first line loses its leading whitespace, which markdown cannot
 * spell (four spaces read as an indented code block). `firstLine` is false for a checklist item's
 * continuation, whose first line here is the item's second.
 */
function escapeLineStarts(content: string, firstLine = true): string {
  return content
    .split('\n')
    .map((line, i) => escapeLineStart(line, firstLine && i === 0))
    .join('\n');
}

/**
 * What opens a block to CommonMark + GFM and not to this converter, whose own answer is `isBlockStart`.
 * Up to three columns in: a bare `#`, `-`, `+` or `*`, an ordered marker with `)` or nothing after it,
 * a tilde fence with any info string, a link reference definition, and a pipe-less delimiter row
 * (`--- | ---`, which makes the line above a table header).
 */
const GFM_ONLY_BLOCK_START =
  /^(?:#{1,6}$|[-+*]$|\d+[.)](?:[ \t]|$)|~{3,}|\[(?:[^\]\\]|\\.)*\]:|:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$)/;
/** A setext underline, which turns the line above into a heading -- so never on a first line. */
const SETEXT_LINE = /^(?:=+|-+)[ \t]*$/;
/** A fence opener: every character of the run is escaped, or the rest can still open a code span. */
const FENCE_RUN = /^(?:`{3,}|~{3,})/;
/** An ordered item's number: the backslash goes before its `.` or `)`. */
const ORDERED_NUMBER = /^\d+(?=[.)])/;

/**
 * One line, escaped if it would open a block. Up to three columns in, whichever reader would open one;
 * past that, only what this converter reads at any indent (a bullet, a number, a rule, a table row),
 * which is `isBlockStart` of the raw line. Escaping more there would only cost the indent, which this
 * reader drops from a line that could not have started a block.
 */
function escapeLineStart(line: string, first: boolean): string {
  let indent = 0;
  let column = 0;
  for (; line[indent] === ' ' || line[indent] === '\t'; indent++) {
    // A tab moves to the next multiple of four, as CommonMark counts it.
    column = line[indent] === '\t' ? column + 4 - (column % 4) : column + 1;
  }
  if (first && indent > 0) return escapeLineStart(line.slice(indent), true);
  const rest = line.slice(indent);
  if (rest === '') return line;
  const opens =
    column <= 3
      ? isBlockStart(rest) || GFM_ONLY_BLOCK_START.test(rest) || (!first && SETEXT_LINE.test(rest))
      : isBlockStart(line);
  if (!opens) return line;
  const fence = FENCE_RUN.exec(rest);
  if (fence) return line.slice(0, indent) + fence[0].replace(/./g, '\\$&') + rest.slice(fence[0].length);
  const at = indent + (ORDERED_NUMBER.exec(rest)?.[0].length ?? 0);
  return line.slice(0, at) + '\\' + line.slice(at);
}

function walkHeading(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  /*
   * h4-h6 keep their level: the interchange is markdown for all four destinations, and Jira renders
   * six distinct levels (six sizes and six line-heights, measured off Atlassian's own editor by
   * `tools/jira-ruler`; `jiraProfile.toolbar.headingLevels` is `[1,2,3,4,5,6]`). A clamp here would
   * turn an h5 into an h3 on `applyFix`'s path, and the reviewer's next edit would ship that. A
   * destination with fewer levels is its profile's business: `slackProfile.toolbar.headingLevels`
   * offers three, and `slack/heading-level-collapsed` reports the loss.
   */
  const level = Math.min(Math.max((node.attrs?.level as number) || 1, 1), 6);
  const prefix = '#'.repeat(level);
  // A heading's trailing run of `#` behind a space is a closing sequence to every markdown reader
  // but this converter, and CommonMark drops it: `## Fix for C #` would arrive as `Fix for C`.
  const content = walkChildren(node, ctx, mediaMap).replace(CLOSING_HASHES, '$1\\$2');
  return `${prefix} ${content}\n\n`;
}

/** A heading's closing `#` run: at the end, after a space or as the whole content. */
const CLOSING_HASHES = /(^|[ \t])(#+[ \t]*)$/;

/**
 * The number an ordered list starts at, for `walkList` and `walkItemBlock`. `??`, not `||`: `|| 1`
 * would send `0. zero` as `1. zero` (probed: Jira stores `order: 0`, 201).
 */
function listStart(node: AdfNode): number {
  return (node.attrs?.order as number | undefined) ?? 1;
}

function walkList(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap,
  // Carries `'task'` too: `walkTaskList` is this function with the ordered-counter work skipped, so
  // the indent rule (wrong, it flattens the nesting) lives in one place.
  listType: 'bullet' | 'ordered' | 'task'
): string {
  // Nested list markers must sit at the parent item's content column --
  // a marker left of it is parsed as a same-level item (flattens the list).
  let indent = '';
  if (ctx.listIndents.length > 0) {
    const parentIndent = ctx.listIndents[ctx.listIndents.length - 1];
    const parentType = ctx.listTypes[ctx.listTypes.length - 1];
    const parentMarkerWidth =
      parentType === 'ordered'
        ? `${ctx.orderedCounters[ctx.orderedCounters.length - 1]}.`.length
        : 1;
    indent = parentIndent + ' '.repeat(parentMarkerWidth + 1);
  }

  ctx.listTypes.push(listType);
  ctx.listIndents.push(indent);
  if (listType === 'ordered') {
    const startOrder = listStart(node);
    ctx.orderedCounters.push(startOrder - 1);
  }

  const result = walkChildren(node, ctx, mediaMap);

  if (listType === 'ordered') ctx.orderedCounters.pop();
  ctx.listIndents.pop();
  ctx.listTypes.pop();

  // Add trailing newline only at top-level lists
  return ctx.listIndents.length === 0 ? result + '\n' : result;
}

function walkListItem(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  const indent = ctx.listIndents[ctx.listIndents.length - 1] || '';
  const currentType = ctx.listTypes[ctx.listTypes.length - 1];

  let marker: string;
  if (currentType === 'ordered') {
    const idx = ctx.orderedCounters.length - 1;
    ctx.orderedCounters[idx]++;
    marker = `${ctx.orderedCounters[idx]}.`;
  } else {
    marker = '-';
  }

  if (!node.content || node.content.length === 0) {
    return `${indent}${marker} \n`;
  }

  // Continuation lines must sit at the item's content column, otherwise the
  // block (code fence, quote, second paragraph) escapes the list and breaks
  // numbering in Linear's renderer.
  const contentIndent = indent + ' '.repeat(marker.length + 1);

  let out = '';
  let opened = false; // marker line emitted
  let previous: AdfNode | undefined;
  for (const child of node.content) {
    if (!opened && !LIST_TYPES.has(child.type)) {
      const block = itemBlockText(child, ctx, mediaMap);
      if (block === null) continue;
      // A bullet whose text is only dashes, `- --`, would read back as a rule: use `*`.
      const m = marker === '-' && isRule(`- ${block.split('\n', 1)[0]}`) ? '*' : marker;
      // Text starting `[ ]` or `[x]` would read back as a checkbox, in both readers.
      const text = child.type === 'paragraph' && readsAsTask(block) ? `\\${block}` : block;
      out += `${indent}${m} ${indentContinuation(text, contentIndent)}\n`;
      opened = true;
      previous = child;
      continue;
    }
    if (!opened) {
      out += `${indent}${marker} \n`;
      opened = true;
    }
    out += walkItemBlock(child, previous, ctx, mediaMap, contentIndent);
    previous = child;
  }
  return out;
}

/**
 * Would this item text read back as a checkbox? The reader's own `TASK_ITEM_RE`, except before a `(`:
 * that is a link this writer wrote (`writeLink` spells `[label](`), which a backslash would break.
 * Literal text shaped like one never gets here bare: the inline repair escapes its `[`.
 */
function readsAsTask(text: string): boolean {
  return TASK_ITEM_RE.test(text) && text[3] !== '(';
}

/**
 * Blocks that may follow an item's text on the very next line. Each interrupts a paragraph in
 * CommonMark and in this module's own reader, so the tight spelling reads back as written.
 * Everything else takes a blank line first: a second paragraph would otherwise join the first, a
 * `---` under text is a setext heading on GitHub, and an image on the next line is the same
 * paragraph's second line.
 */
const TIGHT_IN_ITEM = new Set(['codeBlock', 'heading', 'blockquote']);

/**
 * What a paragraph may follow on the very next line: a block that cannot run on into it. Code
 * written as ```` ``` ```` / `then check X` is the commonest shape in an agent's notes, and a blank
 * line there would make a tight list loose on GitHub. After a quote or a list the next line is a
 * lazy continuation of it, and after a table another row, so those keep the blank line.
 */
const CLOSED_IN_ITEM = new Set(['codeBlock', 'heading']);

/**
 * One block after an item's first, at the item's content column. A nested list indents
 * itself off `ctx.listIndents`; anything else is written as if at the top level and then indented,
 * so a list inside a quote inside an item starts again at column zero rather than at its
 * grandparent's.
 */
function walkItemBlock(
  child: AdfNode,
  previous: AdfNode | undefined,
  ctx: WalkContext,
  mediaMap: MediaMap,
  contentIndent: string
): string {
  // A nested list sits directly under the item's text -- the canonical GFM form, a tight list --
  // unless it is an ordered list starting at anything but 1 right after a paragraph: CommonMark lets
  // only a list starting at 1 interrupt one, so `- a` / `  3. c` is one paragraph, "a 3. c", on every
  // markdown destination. That takes a blank line, which both readers keep nested, since the reader
  // owns an item's indented lines.
  if (LIST_TYPES.has(child.type)) {
    const needsBlank = child.type === 'orderedList' && listStart(child) !== 1 && previous?.type === 'paragraph';
    return (needsBlank ? '\n' : '') + walkNode(child, ctx, mediaMap);
  }
  const block = itemBlockText(child, ctx, mediaMap);
  if (block === null) return '';
  const tight =
    // Two quotes need the blank line between them, or they are one quote.
    (TIGHT_IN_ITEM.has(child.type) && !(child.type === 'blockquote' && previous?.type === 'blockquote')) ||
    (child.type === 'paragraph' && previous !== undefined && CLOSED_IN_ITEM.has(previous.type));
  const lead = tight ? '' : '\n';
  return lead + indentAllLines(block, contentIndent) + '\n';
}

/**
 * A block inside an item, written as if at the top level -- or `null` for one that writes nothing.
 * An empty paragraph still counts, since it opens the item's marker line; other empty blocks
 * contribute nothing.
 */
function itemBlockText(
  child: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string | null {
  const block = walkNode(child, itemContext(ctx), mediaMap).trimEnd();
  return !block && child.type !== 'paragraph' ? null : block;
}

/** `ctx` for a block inside an item that is not a nested list: no list is open inside it yet. */
function itemContext(ctx: WalkContext): WalkContext {
  return { ...ctx, listTypes: [], orderedCounters: [], listIndents: [] };
}

/** Indent every line to the list item's content column (blank lines untouched). */
function indentAllLines(text: string, contentIndent: string): string {
  return text
    .split('\n')
    .map((line) => (line ? contentIndent + line : line))
    .join('\n');
}

/** Indent all lines except the first -- the first goes inline after the marker. */
function indentContinuation(text: string, contentIndent: string): string {
  const newline = text.indexOf('\n');
  if (newline === -1) return text;
  const first = text.slice(0, newline);
  return first + '\n' + indentAllLines(text.slice(newline + 1), contentIndent);
}

function walkCodeBlock(node: AdfNode): string {
  const lang = (node.attrs?.language as string) || '';
  const text =
    node.content?.map((c) => c.text || '').join('') || '';
  // One backtick longer than any run that could close it -- at the start of a line, indented at
  // most three spaces -- so a ``` line inside stays code.
  let longest = 2;
  for (const m of text.matchAll(/^ {0,3}(`+)/gm)) longest = Math.max(longest, m[1].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}\n\n`;
}

function walkBlockquote(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  const content = walkChildren(node, ctx, mediaMap).trimEnd();
  const quoted = content
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return quoted + '\n\n';
}

function walkMediaSingle(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  if (!node.content) return '';
  const inner = node.content
    .map((child) => walkNode(child, ctx, mediaMap))
    .join('');
  return inner + '\n\n';
}

function walkMedia(node: AdfNode, mediaMap: MediaMap): string {
  const id = (node.attrs?.id as string) || '';
  const collection = (node.attrs?.collection as string) || '';
  const mediaType = (node.attrs?.type as string) || 'file';
  const alt = (node.attrs?.alt as string) || '';
  const cachedName = (node.attrs?.__fileName as string) || '';

  // Resolve URL from media map (try id, then collection:id)
  const entry = mediaMap[id] || mediaMap[`${collection}:${id}`] || '';
  let url = typeof entry === 'string' ? entry : entry.url;

  // External media carries its URL in attrs.url and has no media-services id, so the lookup above
  // always misses; without this it would degrade to `[Attachment "..." could not be resolved]`.
  // Verified: Jira accepts, stores and renders external media.
  if (!url && mediaType === 'external' && typeof node.attrs?.url === 'string') {
    url = node.attrs.url;
  }
  // Filename hint from mediaMap (set during attachment resolution when ADF lacks alt/__fileName)
  const mapFilename = typeof entry === 'object' ? entry.filename : '';
  const filename = alt || stripFilenameUuid(cachedName) || mapFilename || stripFilenameUuid(id);

  if (!url) {
    return `[Attachment "${filename}" could not be resolved]`;
  }

  if (
    mediaType === 'image' ||
    // External media is always type 'external', never 'image', so an image URL with no extension (a
    // CDN path, a query string) would fall through to a plain link and be lost on any edit. Verified:
    //   ![d](https://example.com/timeline)      -> [d](...)   image lost
    //   ![d](https://example.com/render?id=7)   -> [d](...)   image lost
    mediaType === 'external' ||
    isImageReference(url) ||
    isImageReference(filename)
  ) {
    return '!' + writeLink(filename, url);
  }
  return writeLink(filename, url);
}

function walkTable(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  if (!node.content) return '';
  const rows = node.content.filter((c) => c.type === 'tableRow');
  if (rows.length === 0) return '';

  const tableCtx: WalkContext = { ...ctx, inTableCell: true };
  const rendered: string[][] = [];

  for (const row of rows) {
    const cells = (row.content || [])
      .filter((c) => c.type === 'tableHeader' || c.type === 'tableCell')
      .map((cell) =>
        escapeTableCell(
          walkChildren(cell, tableCtx, mediaMap).trim()
        )
      );
    rendered.push(cells);
  }

  if (rendered.length === 0) return '';
  const colCount = Math.max(...rendered.map((r) => r.length));
  for (const row of rendered) {
    while (row.length < colCount) row.push('');
  }

  let out = '| ' + rendered[0].join(' | ') + ' |\n';
  out += '| ' + rendered[0].map(() => '---').join(' | ') + ' |\n';
  for (let i = 1; i < rendered.length; i++) {
    out += '| ' + rendered[i].join(' | ') + ' |\n';
  }
  return out + '\n';
}

/**
 * A checklist nests (probed: `listItem > taskList` and `taskList > taskList` are both 201), so it is
 * written at the parent's content column with `walkList`'s rule and stack, or the nesting is lost.
 */
function walkTaskList(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  return walkList(node, ctx, mediaMap, 'task');
}


function walkTaskItem(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  const indent = ctx.listIndents[ctx.listIndents.length - 1] ?? '';
  const checked = node.attrs?.state === 'DONE';
  const checkbox = checked ? '- [x]' : '- [ ]';
  /*
   * A block inside the item is written beneath it, indented. ADF's `taskItem` is inline-only, so this
   * shape is never Jira's: it is the editor's (TipTap's `taskItem` is `paragraph block*`) and
   * `markdownToAdf`'s under `itemBlocks: 'all'`. The item's text is the inline run it starts with,
   * media included (an inline-only container is where `hoistMedia` looks for it). Its line breaks are
   * indented too, or the second line would read back as a paragraph after the list.
   */
  const kids = node.content ?? [];
  let split = kids.findIndex((c) => !INLINE_TYPES.has(c.type) && !BLOCK_MEDIA.has(c.type));
  if (split === -1) split = kids.length;
  const contentIndent = indent + '  ';
  // The first line follows the checkbox and is inline text to every reader; the lines after it are
  // paragraph lines at the content column, where a marker starts a block.
  const written = walkChildren({ ...node, content: kids.slice(0, split) }, ctx, mediaMap).trimEnd();
  const newline = written.indexOf('\n');
  const text = newline === -1 ? written : written.slice(0, newline + 1) + escapeLineStarts(written.slice(newline + 1), false);
  let out = `${indent}${checkbox} ${indentContinuation(text, contentIndent)}\n`;
  // The item's text is a paragraph's worth of inline, so it is what the first block follows.
  let previous: AdfNode | undefined = { type: 'paragraph' };
  for (const child of kids.slice(split)) {
    out += walkItemBlock(child, previous, ctx, mediaMap, contentIndent);
    previous = child;
  }
  return out;
}

function walkExpand(
  node: AdfNode,
  ctx: WalkContext,
  mediaMap: MediaMap
): string {
  const title = (node.attrs?.title as string) || 'Details';
  const content = walkChildren(node, ctx, mediaMap).trimEnd();
  return `+++ ${title}\n${content}\n+++\n\n`;
}

// ---------------------------------------------------------------------------
// Inline node walkers
// ---------------------------------------------------------------------------

/*
 * Text is re-escaped on the way out. Written back verbatim, a character escaped in the source comes
 * back bare and the next parse reads it as markup:
 *
 *   `e\*sc **b**`   pass 1 -> `e*sc **b**`   pass 2 -> `e*sc b**`     the bold is gone
 *   `a\*b **c** *d*`                          pass 2 -> `a*b c* d*`   both marks mangled
 *   `back \\\*`     pass 1 -> `back \*`       pass 2 -> `back *`      the backslash is gone
 *
 * `applyFix` re-parses a body that has been through the converter once; one round trip (the
 * window's, per keystroke) stays faithful without escaping.
 *
 * The escape set is measured against this converter's `parseInline`, not copied from CommonMark
 * (which would backslash every `-`, `#` and `.` in prose): an escaped literal beside a real construct
 * of the same kind, three passes:
 *
 *   `*` `[` `~` `\`   UNSTABLE -- pass 2 differs from pass 1. Escaped here.
 *   `]` `!` `|` `#` `-`   stable. Left alone.
 *
 * `!` beside a link is `appendInline`'s; a line-start `#` or `-` is `escapeLineStarts`'. `_` is in the
 * set because the converter reads it as emphasis (`_x_` italic, `__init__` bold); like the rest it is
 * escaped only when the block needs it, so `snake_case` goes out as written. `` ` `` is in the set
 * though three passes cannot find it: its escape is lost on the first pass (`a \`b\` c` written bare
 * comes back a code span). Not applied under a `code` mark, where a backslash is literal; `applyMarks`
 * gets the raw text.
 */
const ESCAPED = ['\\', '*', '_', '[', '~', '`'];
const inClass = (chars: readonly string[]) => chars.map((c) => `\\${c}`).join('');

/**
 * The cheap gate, `textCouldNeedEscaping`'s, is narrower than the set for `_` (`underscoreCouldPair`).
 * Separate from `TEXT_NEEDS_ESCAPE_ALL` because `.test()` on a `g` regex is stateful.
 */
const TEXT_NEEDS_ESCAPE = new RegExp(`[${inClass(ESCAPED.filter((c) => c !== '_'))}]`);
const TEXT_NEEDS_ESCAPE_ALL = new RegExp(`[${inClass(ESCAPED)}]`, 'g');
/** Every escaped character but the backslash, which pairs with nothing: `mayPairAcrossLines`'. */
const PAIRS_ACROSS = ESCAPED.filter((c) => c !== '\\');

/**
 * Whether an underscore in `text` could open or close: one beside an edge, whitespace or
 * punctuation (`isFlankingBoundary`). One between two letters or digits stays between them however
 * the block is written, so a block holding only those needs no read-back. Without that, every
 * `snake_case` block takes the slow path on every keystroke: measured on a 48 KB draft of them,
 * 4.96 ms per `fromEditorDoc` against 0.35 ms with `_` out of the escape set altogether.
 * Conservative at a node's edges.
 */
function underscoreCouldPair(text: string): boolean {
  for (let i = text.indexOf('_'); i !== -1; i = text.indexOf('_', i + 1)) {
    if (isFlankingBoundary(text[i - 1]) || isFlankingBoundary(text[i + 1])) return true;
  }
  return false;
}

/**
 * The escape pass, outside every span a reader keeps verbatim (`verbatimSpans`): a backslash in a
 * URL is a different URL, and `https://e.test/my_page_.html` escaped would break the block's
 * read-back, so a reviewer's literal `*x*` beside it would go out italic. Inside a link's label a
 * bare URL is not one, and is escaped like any text.
 */
function escapeMarkdownText(text: string, insideLink: boolean): string {
  let out = '';
  let from = 0;
  for (const [start, end] of verbatimSpans(text, insideLink)) {
    out += text.slice(from, start).replace(TEXT_NEEDS_ESCAPE_ALL, '\\$&') + text.slice(start, end);
    from = end;
  }
  return out + text.slice(from).replace(TEXT_NEEDS_ESCAPE_ALL, '\\$&');
}

/** A text node outside any inline container -- none the converter produces -- is written as is. */
function walkText(node: AdfNode): string {
  return writeText(node, false, node.marks ?? NO_MARKS, AT_EDGES);
}

/** What sits beside a piece of inline markdown, for `wrapMarks`' choice of delimiter. */
interface Neighbours {
  readonly before: string | undefined;
  readonly after: string | undefined;
}

const AT_EDGES: Neighbours = { before: undefined, after: undefined };

/**
 * One text node, with the marks the caller says are still its to write (`writeStretch` lifts the
 * shared marks out and hands each node the rest). Escaping still reads the node's own marks: whether a
 * backslash is literal is a fact about the characters.
 */
function writeText(node: AdfNode, escape: boolean, marks: readonly AdfMark[], around: Neighbours): string {
  const raw = node.text || '';
  const angle = angleLinkOf(marks);
  const spelled = angle && writeAngleLink(raw, String(angle.attrs?.href ?? ''), angle.attrs!.angle as AngleSpelling);
  if (spelled) {
    // The label as its characters, and whatever else the node carries around the whole link.
    // `wrapMarks` writes no `code`, which has no spelling there; `lostMarks` reports it.
    const outside = marks.filter((m) => m !== angle);
    return outside.length === 0 ? spelled : wrapMarks(spelled, outside, around);
  }
  // Code content is literal: a backslash inside a code span is a backslash the reader sees.
  const hasCode = node.marks?.some((m) => m.type === 'code') ?? false;
  const insideLink = node.marks?.some((m) => m.type === 'link') ?? false;
  const text = escape && !hasCode ? escapeMarkdownText(raw, insideLink) : raw;
  if (marks.length === 0) return text;
  return applyMarks(text, marks, around);
}

/**
 * Apply ADF marks to text, producing valid Markdown.
 *
 * Whitespace is moved outside mark delimiters to satisfy
 * CommonMark's flanking delimiter rules. Without this, `** bold **`
 * produces broken rendering because the delimiters are adjacent to spaces.
 */
function applyMarks(text: string, marks: readonly AdfMark[], around: Neighbours): string {
  /*
   * The code span is innermost, and everything else goes around it: `codeSpanMarks: 'any'` lets a
   * `code` node carry `strong`, `em` and `strike` (in `a **`c`** b` the emphasis covers exactly the
   * span, so the stretch scan hands the whole set here). `wrapMarks`, so `**` and `[](…)` nest in one
   * order everywhere and a linked code span writes `[`x`](url)`. The `some` guard leads because almost
   * no call carries `code`, and this is the keystroke path.
   */
  if (!marks.some((m) => m.type === 'code')) return wrapMarks(text, marks, around);
  const rest = withoutCode(marks);
  // A span holding a backtick needs a longer delimiter, or no reader gets it back.
  const coded = writeCodeSpan(text);
  return rest.length === 0 ? coded : wrapMarks(coded, rest, around);
}

/**
 * The non-`code` half of `applyMarks`, around text already written. Separate for `writeStretch`, which
 * has no single text node; the flanking rule then applies to the delimiter actually emitted.
 */
function wrapMarks(text: string, marks: readonly AdfMark[], around: Neighbours): string {
  // Extract leading/trailing whitespace -- delimiters must flank non-space. `trimStart`/`trimEnd`, not
  // `/(\s+)$/`: that regex backtracks quadratically on a long run of whitespace that is not at the
  // end (1.2 s at 50k, measured), and this runs per marked node per keystroke. Both trim
  // exactly the set `\s` matches.
  const leading = text.slice(0, text.length - text.trimStart().length);
  const trailing = text.slice(text.trimEnd().length);
  const inner = text.trim();

  // If text is all whitespace, don't wrap in marks
  if (!inner) return text;

  let result = inner;
  let linkHref: string | undefined;
  /*
   * Underscores where stars would touch a star the stretch already holds. An italic around
   * `**init**.py` with stars is `***init**.py*`, a run of three against a run of one that no
   * scan-per-opener reader splits, so it comes back as literal asterisks (on Jira, in the payload) and
   * `body/text-changed` fires on an untouched draft; `*__init__.py*` and `_**Note:** text_` load that
   * way. `_**init**.py_` reads back everywhere. Decided on the stretch as it arrived, so marks on one
   * node keep `***x***`, whose runs match. Only where underscores can flank: beside a letter they pair
   * with nothing (`pre_**init**.py_post` loses the italic everywhere; `pre***init**.py*post` reads on
   * GitHub). `around` is what sits beside the piece being wrapped.
   */
  const flanks = (space: string, c: string | undefined) => space !== '' || isFlankingBoundary(c);
  const touches =
    /^\*|\*$/.test(inner) && !/^_|_$/.test(inner) && flanks(leading, around.before) && flanks(trailing, around.after);

  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        result = touches ? `__${result}__` : `**${result}**`;
        break;
      case 'em':
        result = touches ? `_${result}_` : `*${result}*`;
        break;
      case 'strike':
        result = `~~${result}~~`;
        break;
      case 'link':
        linkHref = mark.attrs?.href as string;
        break;
      case 'underline':
      case 'textColor':
      case 'subsup':
      case 'annotation':
      case 'backgroundColor':
      case 'confluence-inline-comment':
        // No Markdown equivalent -- pass through plain text
        break;
    }
  }

  if (linkHref) {
    result = writeLink(result, linkHref);
  }

  return leading + result + trailing;
}

/** A mention's `@Display Name`, which is all of it the converter writes (no notification). */
function mentionText(node: AdfNode): string {
  const displayText = (node.attrs?.text as string) || '@Unknown';
  return displayText.startsWith('@') ? displayText : `@${displayText}`;
}

/**
 * The characters an inline node puts in its block, for the escape decision: a text node's text,
 * and a mention's label, which reads back as text. Undefined for every other node.
 */
function inlineText(node: AdfNode): string | undefined {
  if (node.type === 'mention') return mentionText(node);
  return typeof node.text === 'string' ? node.text : undefined;
}
