/**
 * Markdown → ADF converter using a custom block/inline parser.
 *
 * Produces a valid ADF document tree. Handles:
 * - Block: paragraphs, headings, lists (bullet/ordered/task), code blocks,
 *          blockquotes, horizontal rules, GFM tables
 * - Inline: bold, italic, bold italic, strikethrough, code, links, images, hard breaks
 * - jira-attachment:{contentUrl} URLs → ADF external mediaSingle nodes
 * - Unhandled constructs → readable ADF paragraph with raw text
 */

import {
  AdfNode,
  AdfDocument,
  AdfMark,
} from './types';
import {
  JIRA_ATTACHMENT_SCHEME,
  tableRowCells,
} from './util';
// The shared set, rather than a second copy. See `TOP_LEVEL_ONLY`.
import {
  BLOCK_MEDIA,
  CODE_MARK_COMBINES_WITH,
  JSM_BLOCKQUOTE_ALLOWED,
  LIST_ITEM_FORBIDDEN,
  LIST_TYPES,
} from '../adfSchema';
import { bareUrlEnd } from '../bareUrl';
import { backtickRuns, codeSpanAt, isEscapable, isEscaped, type BacktickRuns } from '../codeSpan';
import { ANGLE_LINK_SOURCE, bareDestination, DESTINATION_SOURCE, destinationEnd } from '../linkDestination';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MarkdownToAdfOptions {
  /**
   * Keep media where it was written instead of hoisting it out of its paragraph. Off by default: ADF
   * has no inline media, so `paragraphToAdf` splits a paragraph around an image, right for Jira and
   * wrong for a destination that receives markdown (`See ![x](url) for the timeline.` would draw as
   * three blocks). `markdownToAdfFor` sets it unless `mediaPlacement` is `'block'` (Jira's). The
   * result is not valid ADF and is never sent: `adfToProseMirror` maps a paragraph-nested media to
   * the editor's inline `image` node.
   */
  inlineMedia?: boolean;
  /**
   * What a list item may hold beyond its own text (`ItemBlocks`), `adf` by default. A block an item
   * cannot hold moves out (`listToAdf`).
   */
  itemBlocks?: ItemBlocks;
  /**
   * The converter's own tally of what it changed, written as it converts; `markdownToAdfFor`
   * (`core/src/editor.ts`) supplies the sink. An out-channel so `convertMarkdownToAdf`'s signature
   * stays as it is. The checker reads this count rather than a second `parseBlocks`: un-nesting a
   * checklist depends on what earlier siblings did, and a second traversal is a fixer/checker split.
   */
  report?: ConversionReport;
  /**
   * Keep every mark on a code span, instead of stripping down to `CODE_MARK_COMBINES_WITH`. False by
   * default, ADF's own rule, so a caller that says nothing gets a tree Jira accepts; true for a
   * destination that receives the markdown. The profile's vocabulary is `CodeSpanMarks`, translated
   * on the way in as `mediaPlacement` -> `inlineMedia` is.
   */
  combineCodeSpanMarks?: boolean;
  /**
   * Convert every image to the link a destination that draws no picture shows instead: alt as the
   * label, or the URL when there is none. Off by default; set from `rendersMedia: false`. In the image
   * branch rather than a markdown rewrite, which could miss an image and put an `image` node into
   * Slack's editor, which registers none.
   */
  imagesAsLinks?: boolean;
  /**
   * Read `<url|label>` as a link labelled with its label's characters as written, and remember on
   * the link mark how an angle link was spelled (`angle`), so the writer spells it back that way.
   * Off by default, which leaves `<url|label>` text; `editorOptionsFor` sets it from the profile's
   * `angleLinkLabels`. See rule 9a.
   */
  angleLinkLabels?: boolean;
}

/**
 * What a list item may hold beyond its first paragraph, in document-model terms. The profile's
 * `listItemBlocks` is typed with it and holds the probes behind each destination's answer.
 *
 *  - `adf`    Jira's model, and the default, since it cannot produce a tree Jira 400s. A `taskList`
 *             holds only `taskItem` and `taskList` (probed, `TASK_LIST_CHILDREN`), so only a nested
 *             checklist sits under a checklist item, as the parent list's sibling; a `listItem`
 *             refuses a heading, quote, rule or table (`LIST_ITEM_FORBIDDEN`, probed). Each is a 400
 *             INVALID_INPUT that loses the whole comment.
 *  - `lists`  nested lists only, inside the item (as the editor nests them); every other block
 *             moves out.
 *  - `all`    every block stays inside the item. Not valid ADF under a `taskItem` and never sent as
 *             ADF: the editor's intermediate for a markdown destination, like `inlineMedia`.
 */
export type ItemBlocks = 'adf' | 'lists' | 'all';

/** What `MarkdownToAdfOptions.report` collects. See that field. */
export interface ConversionReport {
  /**
   * Nested list runs sent un-nested out of a checklist item, because ADF's `taskList` has no
   * spelling for where they were written. Disclosed by `jira/task-item-nested-list-unnested`.
   */
  unnestedFromTasks: number;
  /**
   * Blocks sent outside the list item they were written in, because Jira cannot hold them there:
   * anything but a list under a checklist item, and a heading, quote, rule or table under any
   * other. A list orphaned behind one counts too. Disclosed by `jira/list-item-block-moved-out`.
   */
  movedOutOfListItems: number;
  /**
   * Code spans that lost an emphasis mark; non-zero only under `codeSpanMarks: 'link-only'`, disclosed
   * by `jira/code-span-emphasis-lost`. Counted by the fixer where it strips, as `unnestedFromTasks` is.
   */
  codeSpanMarksLost: number;
}

export function convertMarkdownToAdf(
  markdown: string,
  options: MarkdownToAdfOptions = {}
): AdfDocument {
  const blocks = parseBlocks(markdown.split('\n'));
  const content = blocks
    .map((b) => blockToAdf(b, options))
    .flat()
    .filter((n): n is AdfNode => n !== null);

  // ADF requires at least one block
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] });
  }

  return { version: 1, type: 'doc', content };
}

// =========================================================================
// Block-level types
// =========================================================================

interface ParagraphBlock {
  kind: 'paragraph';
  lines: string[];
}
interface HeadingBlock {
  kind: 'heading';
  level: number;
  text: string;
}
interface CodeBlock {
  kind: 'code';
  lang: string;
  text: string;
}
interface BlockquoteBlock {
  kind: 'blockquote';
  lines: string[];
}
interface RuleBlock {
  kind: 'rule';
}
type ListKind = 'bullet' | 'ordered' | 'task';

/**
 * A list block carries its kind, and its items' nested lists are blocks of their own. A block is
 * homogeneous (the run ends when the kind changes, `parseListItems`), so the converter never picks a
 * winner among kinds: `- a` / `  - b` / `  - [ ] c` is one item with two child blocks.
 */
interface ListBlock {
  kind: 'list';
  listKind: ListKind;
  /** Starting number of an ordered list (from the first item's marker). */
  start?: number;
  items: ListItem[];
}
interface TableBlock {
  kind: 'table';
  header: string[];
  rows: string[][];
}
interface ExpandBlock {
  kind: 'expand';
  title: string;
  bodyLines: string[];
}

type Block =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | BlockquoteBlock
  | RuleBlock
  | ListBlock
  | TableBlock
  | ExpandBlock;

interface ListItem {
  /** The item's first paragraph, one line per source line: they are joined by hard breaks. */
  text: string;
  /** Set only under a `task` block. The block's kind decides the node type, not this. */
  checked?: boolean;
  /**
   * What the item holds after its first paragraph, in document order: any block, nested runs among
   * them (each homogeneous, see `ListBlock`). Whether the destination can hold each one there is
   * `listToAdf`'s question, not the parser's.
   */
  children: Block[];
}

// =========================================================================
// Block parser
// =========================================================================

/**
 * A fence's opening line: backticks or tildes, then an optional language, which may follow a
 * space.
 */
const FENCE_RE = /^(`{3,}|~{3,}) *([\w.+#-]*)\s*$/;

/**
 * A list item's closing fence: at least as many of the opener's character, and nothing after them, so
 * a line like ```` ```trailing ```` does not close one and lose its text. The top-level reader keeps
 * its looser `startsWith`, which `markdown.ts`'s code-region scan mirrors.
 */
function closesFence(line: string, fence: string): boolean {
  return line.startsWith(fence) && /^(`+|~+)\s*$/.test(line);
}

/**
 * `item` is set for the lines a list item owns, once its indent is stripped. As in CommonMark, a block
 * may start up to three spaces in and a paragraph's lines lose their leading spaces. Otherwise `- a`
 * over three-space `# Head` is text on the way in and a heading once the writer puts it at the content
 * column, and a paragraph moved out of an item, or a top-level `  b` after `-   a` (written `- a`),
 * keeps the indent that puts it inside the item on the next read.
 *
 * In an item, and for an indented top-level fence, an unclosed fence stays literal (as `markdown.ts`'s
 * code-region scan assumes), so it cannot swallow the rest of a bullet; only a column-zero one runs to
 * the end. An expand's closer, Jira's syntax, is no deeper than its opener at the top level
 * (`expandCloser`).
 */
function parseBlocks(
  lines: string[],
  item = false,
  shape: LineShape = shapeOf(lines),
  depth = 0
): Block[] {
  const blocks: Block[] = [];
  // Where a closer search last failed, per fence character, and for how short a fence. A closer for
  // a fence closes every shorter one, so a later opener at least that long, further on, cannot
  // close either: without this, N unclosed fences in one item each scanned to its end (quadratic;
  // 3,000 of them took 1.7 s on a keystroke path).
  const unclosed = new Map<string, { from: number; length: number }>();
  const paragraph = (text: string[]): ParagraphBlock => ({ kind: 'paragraph', lines: text.map(paragraphLine) });
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line → skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block
    const fenceIndent = leadingSpaces(line);
    const fenceMatch = fenceIndent <= 3 ? line.slice(fenceIndent).match(FENCE_RE) : null;
    // In an item and for an indented fence, closed is code and unclosed is literal; only a
    // column-zero fence at the top level runs to the end.
    if (fenceMatch && (item || fenceIndent > 0)) {
      const fence = fenceMatch[1];
      const failed = unclosed.get(fence[0]);
      const hopeless = failed !== undefined && i >= failed.from && fence.length >= failed.length;
      const code = hopeless ? null : listFence(lines, i + 1, fenceIndent, fence, fenceMatch[2]);
      if (!code && !hopeless) unclosed.set(fence[0], { from: i, length: fence.length });
      if (code) {
        blocks.push(code.block);
        i = code.end;
        continue;
      }
      // Unclosed: literal, through the paragraph branch's progress guarantee below.
    } else if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ kind: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    const text = upToThreeIn(line);

    // Heading
    const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i++;
      continue;
    }

    // Horizontal rule (---, ***, ___)
    if (isRule(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    // Blockquote
    if (text.startsWith('> ') || text === '>') {
      const quoteLines: string[] = [];
      for (; i < lines.length; i++) {
        const quoted = upToThreeIn(lines[i]);
        if (!quoted.startsWith('> ') && quoted !== '>') break;
        quoteLines.push(quoted === '>' ? '' : quoted.slice(2));
      }
      blocks.push({ kind: 'blockquote', lines: quoteLines });
      continue;
    }

    // Expand/collapse (+++ title ... +++)
    if (text.startsWith('+++')) {
      const title = text.slice(3).trim();
      const bodyLines: string[] = [];
      const opener = leadingSpaces(line);
      i++;
      while (i < lines.length && !expandCloser(lines[i], item, opener)) {
        bodyLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing +++
      blocks.push({ kind: 'expand', title, bodyLines });
      continue;
    }

    // List item (bullet, ordered, or task)
    if (isListItemLine(line)) {
      const { items, listKind, start, nextIndex } = parseListItems(lines, i, shape, depth);
      // Defensive: an empty item list would produce an empty bulletList/
      // orderedList node, which Jira rejects with 400 INVALID_INPUT.
      if (items.length > 0) {
        blocks.push({ kind: 'list', listKind, start, items });
      }
      // Progress guarantee: never let an empty parse leave `i` in place.
      i = Math.max(nextIndex, i + 1);
      continue;
    }

    // Table (line starts with |)
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trimStart().startsWith('|')
      ) {
        tableLines.push(lines[i]);
        i++;
      }
      // The rows lose their indent outright, for the fallback too: they were read as a table here
      // and were not one, so no position makes them one. At the top level as well, or rows kept two
      // spaces in are read into the item above once its marker is spelled `- `.
      const rows = tableLines.map((l) => l.trimStart());
      const table = parseTable(rows);
      if (table) {
        blocks.push(table);
      } else {
        // Fallback: treat as paragraph
        blocks.push({ kind: 'paragraph', lines: rows });
      }
      continue;
    }

    // Paragraph (consecutive non-blank, non-block-start lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isBlockStart(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(paragraph(paraLines));
    } else {
      // Progress guarantee: isBlockStart() is looser than the per-block parsers,
      // so a non-blank lookalike (e.g. empty heading "### ", spaceless ">foo",
      // fence "```js extra") can collect zero paragraph lines. Emit it as literal
      // text and advance, or `i` never moves and the loop spins forever.
      blocks.push(paragraph([line]));
      i++;
    }
  }

  return blocks;
}

/**
 * A paragraph line without its leading spaces as CommonMark reads it -- unless
 * losing them would make it start a block, as `    # not a heading` would. Those keep the indent
 * that made them text, or the writer puts them at the content column and the next read makes them
 * a heading, a quote or a fence.
 */
function paragraphLine(line: string): string {
  const trimmed = line.trimStart();
  return isBlockStart(trimmed) ? line : trimmed;
}

/** A line with the up-to-three spaces removed that CommonMark lets a block start behind. */
function upToThreeIn(line: string): string {
  return line.replace(/^ {1,3}/, '');
}

/**
 * Whether `line` closes an expand opened `opener` spaces in. An expand opens up to three spaces in
 * like every block, but it is Jira's and not CommonMark's and closes on the first `+++` line, so at
 * the top level that line may be no deeper than its opener: `+++ Title` over an item holding an
 * indented expand must not close on the inner one's `  +++`. In an item, any `+++` line up to three
 * spaces in.
 */
function expandCloser(line: string, item: boolean, opener: number): boolean {
  return (item || leadingSpaces(line) <= opener) && upToThreeIn(line).startsWith('+++');
}

function isListItemLine(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s/.test(line);
}

/**
 * Whether any line of `markdown` could start a list item, behind a quote's `>` as well: the cheap
 * question a caller asks before paying a whole conversion for what `listToAdf` might move.
 * `isListItemLine`'s marker, loosened so it can only over-answer: `\s` here also spans a
 * newline, and a `>` prefix is skipped. A `false` is exact -- no list, nothing to move.
 */
export function mayHoldListItem(markdown: string): boolean {
  return /^[\s>]*([-*+]|\d+\.)\s/m.test(markdown);
}

/**
 * Three or more of one marker, whitespace allowed (CommonMark). Do not swap in a pattern that
 * backtracks exponentially on a long run of markers: every line of every draft passes through it.
 * A rule wins over a bullet item (`- - -`, `* * *`), as in CommonMark and on GitHub.
 */
export function isRule(line: string): boolean {
  return /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

/** Exported for the writer, which escapes a line this answers `true` for. */
export function isBlockStart(raw: string): boolean {
  // A block may start up to three spaces in, as `parseBlocks` reads it.
  const line = upToThreeIn(raw);
  // Any backtick run; a tilde line only when it is a fence, so `~~~b~~~ c` stays prose.
  if (/^`{3,}/.test(line) || FENCE_RE.test(line)) return true;
  if (/^#{1,6}\s/.test(line)) return true;
  if (isRule(line)) return true;
  if (/^>\s?/.test(line)) return true;
  if (isListItemLine(line)) return true;
  if (line.trimStart().startsWith('|')) return true;
  if (line.startsWith('+++')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// List parser
// ---------------------------------------------------------------------------

/**
 * A task item's marker, and the only spelling of that test: the run-break (`firstTask`) and the
 * per-item parse must agree. If one required whitespace after `]` and the other did not, `- [x]` /
 * `- a` / `- b` would go to Jira as `- [ ] a` / `- [ ] b`: the checked item dropped and both bullets
 * turned into unchecked to-dos. Group 1 is the checked state, group 2 the text; `.test` and `.match`
 * are both stateless on a non-global regex.
 */
export const TASK_ITEM_RE = /^\[([ xX])\]\s*(.*)/;

/**
 * An ordered item's marker, one spelling for the same reason as `TASK_ITEM_RE`: `parseListItems`
 * compares the block's answer (its first item's) with the current item's.
 */
const ORDERED_MARKER_RE = /^\d+\./;

function parseListItems(
  lines: string[],
  startIndex: number,
  shape: LineShape,
  depth: number
): { items: ListItem[]; listKind: ListKind; start?: number; nextIndex: number } {
  if (depth >= MAX_LIST_DEPTH) {
    throw new RangeError(
      `lists nested more than ${MAX_LIST_DEPTH} deep, which this reader refuses rather than meet ` +
        'the engine\'s own "Maximum call stack size exceeded" further down'
    );
  }
  const firstMatch = lines[startIndex].match(/^(\s*)([-*+]|\d+\.)\s(.*)/);
  if (!firstMatch)
    return { items: [], listKind: 'bullet', nextIndex: startIndex + 1 };

  // The list's base indent is the first item's own indent. Deriving it here
  // (rather than taking it from the caller) means a list resuming at nesting
  // depth after an interrupting paragraph parses as same-level items instead
  // of a nested orphan whose items get dropped, leaving an empty bulletList
  // that Jira rejects with 400 INVALID_INPUT.
  const baseIndent = firstMatch[1].length;
  const ordered = ORDERED_MARKER_RE.test(firstMatch[2]);
  const start = ordered ? parseInt(firstMatch[2], 10) : undefined;
  /*
   * The run ends when the item kind changes. One `ListBlock` becomes one ADF list node, and each list
   * type accepts only its own item type, so a mixed block would make `listToAdf` rewrite the losers:
   *
   *   - a           -> - [ ] a      a bullet becomes an unchecked TO-DO
   *   - [ ] b          - [ ] b
   *
   *   1. a          -> - [ ] a      numbering DESTROYED, and both become to-dos
   *   - [ ] b          - [ ] b
   *
   *   1. a          -> 1. a         a bullet gains a number it never had
   *   - b              2. b
   *
   *   - a           -> - a          an ordered item LOSES its number
   *   1. b             - b
   *
   * Nothing downstream can see it: the damage happens on the way in, so `render()` and
   * `lostInMarkdown` stay quiet, the reviewer sees checkboxes and the log records `edited: false`.
   * Breaking here lets `parseBlocks` re-enter at `nextIndex`, so a mixed run becomes two adjacent
   * lists, as a blank line between the items would. CommonMark reads `- a` / `- [ ] b` as one list,
   * but ADF has no mixed list; the two blocks re-parse as two, so the round trip is stable.
   */
  const firstTask = TASK_ITEM_RE.test(itemContent(firstMatch[3]).content);
  // The block's kind, decided once by the item that defines the run.
  const listKind: ListKind = firstTask ? 'task' : ordered ? 'ordered' : 'bullet';
  const items: ListItem[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (shape.blank[i]) {
      // Blank line ends the current list block. Consecutive list items
      // separated by blank lines become separate list blocks, which
      // prevents bullet/ordered/task lists from merging into one.
      break;
    }

    // A rule ends the list, at any depth, rather than becoming an item.
    if (isRule(line)) break;
    const itemMatch = line.match(/^(\s*)([-*+]|\d+\.)\s(.*)/);
    if (!itemMatch) break;

    const indent = itemMatch[1].length;
    if (indent < baseIndent) break;

    // Deeper than the run and not owned by the item above: only a tab indent gets here, which the
    // item regex counts and `leadingSpaces` does not. It starts a new list.
    if (indent > baseIndent) break;

    // Same-level item
    const { absorbed, content: rawContent } = itemContent(itemMatch[3]);
    const taskMatch = rawContent.match(TASK_ITEM_RE);

    /*
     * A kind change ends the run (see above). Task-ness and ordered-ness both decide the block's
     * `listKind`, captured from the first item, which defines it and so is not checked.
     */
    if (i > startIndex) {
      const isTask = taskMatch !== null;
      const isOrdered = ORDERED_MARKER_RE.test(itemMatch[2]);
      if (isTask !== firstTask || isOrdered !== ordered) break;
    }

    /*
     * The item owns every following line indented to its content column, and the blank lines between
     * them (CommonMark's container rule); owning less splits the list at the first such line. With the
     * indent stripped they are read as blocks, nested lists included (`parseBlocks`, `itemChildren`).
     */
    const col = indent + itemMatch[2].length + absorbed;
    const end = ownedEnd(lines, shape, i + 1, baseIndent, col);
    const owned = stripIndent(lines, shape, i + 1, end, col);
    const item: ListItem = { text: taskMatch ? taskMatch[2] : rawContent, children: [] };
    if (taskMatch) item.checked = taskMatch[1] !== ' ';
    // An item that opens with its fence, which is how the writer spells `listItem > [codeBlock]`.
    // Not a checklist item's: `- [ ] ```` is text after a checkbox.
    // Asked of the fence alone before anything is parsed: parsing the lines both ways and keeping
    // one doubles the work at every depth, which makes nested `- ```` exponential.
    const opener = taskMatch ? null : rawContent.match(FENCE_RE);
    const opens = opener !== null && listFence(owned.lines, 0, 0, opener[1], opener[2]) !== null;
    if (opens) {
      item.text = '';
      item.children = itemChildren(parseBlocks([rawContent, ...owned.lines], true, undefined, depth + 1));
    } else {
      // The item's first paragraph runs on through lines that start no block, as CommonMark's does.
      let k = 0;
      while (k < owned.lines.length && !owned.shape.blank[k] && !isBlockStart(owned.lines[k])) k++;
      item.text = [item.text, ...owned.lines.slice(0, k).map(paragraphLine)].join('\n');
      // No copy when nothing continued -- a nested item on the next line, at every depth of a chain.
      const rest =
        k === 0
          ? owned
          : { lines: owned.lines.slice(k), shape: { indent: owned.shape.indent.slice(k), blank: owned.shape.blank.slice(k) } };
      item.children = itemChildren(parseBlocks(rest.lines, true, rest.shape, depth + 1));
    }
    items.push(item);
    i = end;
  }

  return { items, listKind, start, nextIndex: i };
}

/**
 * How deep a list may nest before the reader gives up, with an error the review turns into
 * `review/crashed` (ask), as the engine's stack overflow would. Each level scans what it owns (linear
 * in the input's bytes), but a 10,000-deep chain is 100 MB and reaching the overflow takes one to two
 * seconds, past a test's deadline on a loaded machine. Nothing real nests past ten.
 */
const MAX_LIST_DEPTH = 1_000;

/**
 * A list item's marker line past the marker's one required space: how many spaces the content column
 * absorbs, and the text that starts there. CommonMark's column is past the marker and the one to four
 * spaces after it, or one when there are five or more (indented code) or nothing follows (spec #276).
 *
 * The absorbed spaces are not the item's text. Kept, `-   [ ] a` would be no checkbox, `-   ````
 * would open no fence, and the writer's `- ` would put later blocks short of the column, so the
 * re-parse drops them out of the item (for Jira, a code block becomes literal fences). `-   ` and
 * `1.  ` are remark's and pandoc's spelling.
 */
function itemContent(afterMarker: string): { absorbed: number; content: string } {
  const gap = 1 + leadingSpaces(afterMarker);
  const absorbed = gap <= 4 && afterMarker.trim() !== '' ? gap : 1;
  return { absorbed, content: afterMarker.slice(absorbed - 1) };
}

function leadingSpaces(line: string): number {
  return line.match(/^ */)![0].length;
}

/**
 * What the list parser asks of every line (its leading spaces, whether it is blank), worked out once
 * and carried beside the lines, stripped item by item. A line ten items deep is visited by all ten;
 * re-reading its indent on each visit is quadratic in the line: 10,000 nested items, each two spaces
 * deeper, hang `render()`.
 */
interface LineShape {
  indent: number[];
  blank: boolean[];
}

function shapeOf(lines: string[]): LineShape {
  const indent = lines.map(leadingSpaces);
  return { indent, blank: lines.map((line, i) => line.slice(indent[i]).trim() === '') };
}

/**
 * Where the lines a list item owns end: past every line indented to `col`, and the blank lines
 * between them, but never a trailing blank. A deeper list item right under the item is owned too,
 * short of `col` -- `1. a` over two-space `- b` nests here, where CommonMark would start a new
 * list.
 */
function ownedEnd(lines: string[], shape: LineShape, from: number, baseIndent: number, col: number): number {
  let end = from;
  for (;;) {
    let k = end;
    while (k < lines.length && shape.blank[k]) k++;
    if (k === lines.length) return end;
    const spaces = shape.indent[k];
    // Tested only short of `col`: a regex per line per depth is the cost `LineShape` exists to avoid.
    const nested = () => k === end && spaces > baseIndent && isListItemLine(lines[k]) && !isRule(lines[k]);
    if (spaces < col && !nested()) return end;
    end = k + 1;
  }
}

/**
 * An item's owned lines with its indent removed: `col`, or less when a nested item sits short of it,
 * by the same amount on every line so what was nested under what is kept.
 */
function stripIndent(
  lines: string[],
  shape: LineShape,
  from: number,
  end: number,
  col: number
): { lines: string[]; shape: LineShape } {
  let strip = col;
  for (let j = from; j < end; j++) if (!shape.blank[j]) strip = Math.min(strip, shape.indent[j]);
  const out: { lines: string[]; shape: LineShape } = { lines: [], shape: { indent: [], blank: [] } };
  for (let j = from; j < end; j++) {
    const cut = Math.min(strip, shape.indent[j]);
    out.lines.push(lines[j].slice(cut));
    out.shape.indent.push(shape.indent[j] - cut);
    out.shape.blank.push(shape.blank[j]);
  }
  return out;
}

/**
 * The blocks an item holds after its first paragraph, with adjacent nested runs of one kind merged:
 * `- a` / four-space `- b` / two-space `- c`, or two runs a blank line apart. ADF permits
 * `listItem > [paragraph, bulletList, bulletList]` but markdown cannot spell it (the writer indents by
 * depth), so kept apart the round trip reads one list back and `lostInMarkdown` raises
 * `body/structure-lost`, blocking, for a three-line list. The kind check keeps the run-break intact.
 * `start` is not compared: `1. a`, a blank line, `10. b` is written as one list numbered 1, 2, which
 * the next read merges. The first run's number is the list's, as in CommonMark.
 */
function itemChildren(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    const previous = out[out.length - 1];
    if (block.kind === 'list' && previous?.kind === 'list' && previous.listKind === block.listKind) {
      previous.items.push(...block.items);
    } else {
      out.push(block);
    }
  }
  return out;
}

/**
 * The code block a fence inside a list item holds, read from the line after its opener, and the
 * line after its closer -- or `null` when it never closes, so an unclosed fence stays literal, which
 * is also what `markdown.ts`'s code-region scan assumes. The lines are the item's own, indent
 * already stripped, so the item's end bounds the search.
 */
function listFence(
  lines: string[],
  from: number,
  indent: number,
  fence: string,
  lang: string
): { block: CodeBlock; end: number } | null {
  for (let j = from; j < lines.length; j++) {
    const spaces = leadingSpaces(lines[j]);
    if (spaces <= 3 && closesFence(lines[j].slice(spaces), fence)) {
      const code = lines.slice(from, j).map((l) => l.slice(Math.min(leadingSpaces(l), indent)));
      return { block: { kind: 'code', lang, text: code.join('\n') }, end: j + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Table parser
// ---------------------------------------------------------------------------

function parseTable(lines: string[]): TableBlock | null {
  if (lines.length < 2) return null;

  const header = tableRowCells(lines[0]);

  // Check for separator row (| --- | --- |)
  const sepCells = tableRowCells(lines[1]);
  const isSeparator = sepCells.every((c) => /^:?-+:?$/.test(c));
  if (!isSeparator) return null;

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    rows.push(tableRowCells(lines[i]));
  }

  return { kind: 'table', header, rows };
}

// =========================================================================
// Block → ADF conversion
// =========================================================================

/*
 * Block-level node types that must not be nested inside a paragraph. From `core/src/adfSchema.ts`,
 * the table both directions and `prosemirror.ts` read.
 */
const TOP_LEVEL_ONLY = BLOCK_MEDIA;

function blockToAdf(
  block: Block,
  options: MarkdownToAdfOptions = {}
): AdfNode[] {
  switch (block.kind) {
    case 'paragraph':
      return paragraphToAdf(block, options);
    case 'heading':
      return [headingToAdf(block, options)];
    case 'code':
      return [codeBlockToAdf(block)];
    case 'blockquote':
      return blockquoteToAdf(block, options);
    case 'rule':
      return [{ type: 'rule' }];
    case 'list':
      return listToAdf(block, options);
    case 'table':
      return [tableToAdf(block, options)];
    case 'expand':
      return expandToAdf(block, options);
  }
}

function paragraphToAdf(
  block: ParagraphBlock,
  options: MarkdownToAdfOptions = {}
): AdfNode[] {
  // Join lines with hardBreak nodes for single newlines within a paragraph
  const content = inlineLines(block.lines, options);

  // Hoist block-level nodes (mediaSingle) out of the paragraph.
  // ADF requires these as top-level siblings, not nested inside paragraphs.
  //
  // Unless the caller asked for inline media (`MarkdownToAdfOptions.inlineMedia`): the paragraph is
  // returned whole, which is not valid ADF and is never sent as ADF.
  if (options.inlineMedia || !content.some((n) => TOP_LEVEL_ONLY.has(n.type))) {
    return [{ type: 'paragraph', content }];
  }

  const result: AdfNode[] = [];
  let inlineBuf: AdfNode[] = [];
  for (const node of content) {
    if (TOP_LEVEL_ONLY.has(node.type)) {
      if (inlineBuf.length > 0) {
        result.push({ type: 'paragraph', content: inlineBuf });
        inlineBuf = [];
      }
      result.push(node);
    } else {
      inlineBuf.push(node);
    }
  }
  if (inlineBuf.length > 0) {
    result.push({ type: 'paragraph', content: inlineBuf });
  }
  return result;
}

function headingToAdf(
  block: HeadingBlock,
  options: MarkdownToAdfOptions
): AdfNode {
  return {
    type: 'heading',
    attrs: { level: block.level },
    content: parseInline(block.text, [], options),
  };
}

function codeBlockToAdf(block: CodeBlock): AdfNode {
  const content: AdfNode[] = block.text
    ? [{ type: 'text', text: block.text }]
    : [];
  return {
    type: 'codeBlock',
    ...(block.lang ? { attrs: { language: block.lang } } : {}),
    content,
  };
}

/** Parse lines as nested block content, ensuring at least one paragraph. */
function parseNestedBlocks(
  lines: string[],
  options: MarkdownToAdfOptions = {}
): AdfNode[] {
  const content = parseBlocks(lines)
    .map((b) => blockToAdf(b, options))
    .flat();
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] });
  }
  return content;
}

/**
 * A container's content, split around any block a list inside it moved out that the container cannot
 * hold either. `> - a` over `>   > q` would otherwise leave `blockquote > blockquote`, a probed JSM 400
 * (`JSM_BLOCKQUOTE_ALLOWED`), and an expand would hold an `expand` (ADF spells it `nestedExpand`). A
 * block written straight into the container is not moved: `> # H` stays a blocking error, with its
 * repair. Only under `adf`: nothing is lifted under `all`, and under `lists` what Slack's quote holds
 * is unprobed, so a block Slack's list moved out stays in the quote.
 */
function splitAround(
  content: AdfNode[],
  options: MarkdownToAdfOptions,
  holds: (node: AdfNode) => boolean,
  wrap: (content: AdfNode[]) => AdfNode
): AdfNode[] {
  if ((options.itemBlocks ?? 'adf') !== 'adf') return [wrap(content)];
  const out: AdfNode[] = [];
  let current: AdfNode[] = [];
  for (const node of content) {
    if (LIFTED.has(node) && !holds(node)) {
      if (current.length > 0) out.push(wrap(current));
      current = [];
      out.push(node);
    } else {
      current.push(node);
    }
  }
  if (current.length > 0 || out.length === 0) out.push(wrap(current));
  return out;
}

function blockquoteToAdf(
  block: BlockquoteBlock,
  options: MarkdownToAdfOptions = {}
): AdfNode[] {
  return splitAround(
    parseNestedBlocks(block.lines, options),
    options,
    (node) => JSM_BLOCKQUOTE_ALLOWED.has(node.type),
    (content) => ({ type: 'blockquote', content })
  );
}

function expandToAdf(
  block: ExpandBlock,
  options: MarkdownToAdfOptions = {}
): AdfNode[] {
  return splitAround(
    parseNestedBlocks(block.bodyLines, options),
    options,
    (node) => node.type !== 'expand',
    (content) => ({ type: 'expand', attrs: { title: block.title || '' }, content })
  );
}

/**
 * One homogeneous block becomes ADF list node(s), no item retyped to fit and each block an item holds
 * kept inside it where the destination can hold it. Probed against Jira: `listItem > taskList` 201,
 * `taskList > taskList` 201, `taskList > bulletList` 400. Under `itemBlocks: 'adf'` a `listItem`
 * holds anything but `LIST_ITEM_FORBIDDEN` (paragraphs, code blocks, lists and media probed 201 in any
 * order and number), and a `taskItem` is inline-only: a nested checklist goes in the parent `taskList`
 * after its item (`taskList > [taskItem, taskList]`), anything else there is a 400. The editor's
 * `taskItem > [paragraph, taskList]` is `prosemirror.ts`'s business.
 *
 * A block with no spelling where it was written moves out: the list so far is closed, the block
 * emitted as a sibling, and a new list opens for the items after, numbered on. Order and kind survive,
 * indentation does not; the writer's blank line between siblings makes the round trip a fixed point.
 * The profile discloses it from `report`. Never emits an empty list (`EMPTY_FORBIDDEN`, a probed 400).
 */
function listToAdf(
  block: ListBlock,
  options: MarkdownToAdfOptions
): AdfNode[] {
  const task = block.listKind === 'task';
  const out: AdfNode[] = [];
  let current: AdfNode[] = [];
  // Items already sent in an earlier piece of this list, so a numbered list resumes where it stopped.
  let sent = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    if (task) {
      out.push({ type: 'taskList', attrs: { localId: '' }, content: current });
    } else {
      const order = (block.start ?? 1) + sent;
      out.push({
        type: block.listKind === 'ordered' ? 'orderedList' : 'bulletList',
        // Preserve the markdown numbering: a list split by blank lines or by a block moved out of it
        // becomes separate orderedList nodes, which would each restart at 1 without an explicit order.
        ...(block.listKind === 'ordered' && order !== 1 ? { attrs: { order } } : {}),
        content: current,
      });
      sent += current.length;
    }
    current = [];
  };
  // Where a node may go inside this list, or `false` for "only outside it".
  const itemBlocks = options.itemBlocks ?? 'adf';
  const holds = (node: AdfNode): boolean => {
    switch (itemBlocks) {
      case 'all': return true;
      case 'lists': return LIST_TYPES.has(node.type);
      case 'adf': return task ? node.type === 'taskList' : !LIST_ITEM_FORBIDDEN.has(node.type);
    }
  };
  // ADF spells a nested checklist as the parent `taskList`'s sibling; everywhere else it nests.
  const beside = task && itemBlocks === 'adf';

  for (const item of block.items) {
    const itemNode = task ? taskItemToAdf(item, options) : listItemToAdf(item, options);
    current.push(itemNode);
    // Once one block has moved out, the item is behind it: everything after goes out too, in order
    // (the orphan rule). Reopening the list to hold it would put it before a sibling written earlier.
    let closed = false;
    for (const child of item.children) {
      let moved = false;
      for (const node of blockToAdf(child, options)) {
        if (!closed && holds(node)) {
          // A nested checklist is the parent `taskList`'s sibling, not the item's child -- unless the
          // item keeps its blocks, when every nested run stays inside it in the order it was written.
          if (beside) current.push(node);
          else appendToItem(itemNode, node);
          continue;
        }
        if (!closed) flush();
        closed = true;
        // A node a deeper list already moved out was counted there: `- [ ] a` / `  - [ ] b` /
        // `    - c` is one list lifted, not two.
        if (!LIFTED.has(node)) moved = true;
        LIFTED.add(node);
        out.push(node);
      }
      // Counted once per block as written, not per node (a nested list may come back as several), and
      // here, where it is decided (see `MarkdownToAdfOptions.report`).
      if (moved && options.report) {
        if (task && child.kind === 'list') options.report.unnestedFromTasks++;
        else options.report.movedOutOfListItems++;
      }
    }
  }
  flush();
  return out;
}

/**
 * Put `node` last in an item, joining a list of its own type already there. A block moved out of a
 * nested list can leave two such lists side by side -- an orphaned checklist beside the one that
 * resumed -- and the writer spells them as one, so the first edit would read back one list fewer
 * and `lostInMarkdown` would block it. `itemChildren` is the same rule at parse time.
 */
function appendToItem(item: AdfNode, node: AdfNode): void {
  // In place: every node here was built by this conversion, and copying the array per child makes
  // an item of many blocks quadratic (32,000 paragraphs: 849 ms against 25).
  const content = (item.content ??= []);
  const previous = content[content.length - 1];
  if (previous?.type === node.type && LIST_TYPES.has(node.type)) {
    (previous.content ??= []).push(...(node.content ?? []));
  } else {
    content.push(node);
  }
}

/** Nodes a list has already moved out of an item, so an enclosing list does not count them again. */
const LIFTED = new WeakSet<AdfNode>();

/** A paragraph's source lines as inline nodes, joined by hard breaks. */
function inlineLines(
  lines: string[],
  options: MarkdownToAdfOptions
): AdfNode[] {
  const content: AdfNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...parseInline(lines[i], [], options));
  }
  return content;
}

function listItemToAdf(
  item: ListItem,
  options: MarkdownToAdfOptions
): AdfNode {
  return { type: 'listItem', content: [{ type: 'paragraph', content: inlineLines(item.text.split('\n'), options) }] };
}

function taskItemToAdf(
  item: ListItem,
  options: MarkdownToAdfOptions
): AdfNode {
  return {
    type: 'taskItem',
    attrs: {
      localId: '',
      state: item.checked ? 'DONE' : 'TODO',
    },
    content: inlineLines(item.text.split('\n'), options),
  };
}

function tableToAdf(
  block: TableBlock,
  options: MarkdownToAdfOptions
): AdfNode {
  const headerRow: AdfNode = {
    type: 'tableRow',
    content: block.header.map((cell) => ({
      type: 'tableHeader',
      content: [
        {
          type: 'paragraph',
          content: parseInline(cell, [], options),
        },
      ],
    })),
  };

  const bodyRows: AdfNode[] = block.rows.map((row) => ({
    type: 'tableRow',
    content: row.map((cell) => ({
      type: 'tableCell',
      content: [
        {
          type: 'paragraph',
          content: parseInline(cell, [], options),
        },
      ],
    })),
  }));

  return {
    type: 'table',
    content: [headerRow, ...bodyRows],
  };
}

// =========================================================================
// Inline parser
// =========================================================================

// A link or image whose destination is the shared grammar, both forms (`linkDestination.ts`).
const LINK_RE = new RegExp(String.raw`^\[([^\]]+)\]\((` + DESTINATION_SOURCE + String.raw`)\)`);
const IMAGE_RE = new RegExp(String.raw`^!\[([^\]]*)\]\((` + DESTINATION_SOURCE + String.raw`)\)`);

/**
 * What may come right before a bare URL for it to be autolinked: GFM's list -- the start of the
 * text, whitespace, `*`, `_`, `~` or `(` -- so `(https://x.com/a)` links as it does on GitHub
 * (probed). A space alone would leave the commonest parenthesised shape unlinked.
 */
const AUTOLINK_AFTER = /[\s*_~(]/;

/** Rule 9a's angle autolinks and 9b's bare-URL candidate, shared with `wholeSpans`. */
const ANGLE_LINK_RE = new RegExp(`^${ANGLE_LINK_SOURCE}`);

/**
 * The angle link at `pos`, if this reader takes it: `<url>` always, `<url|label>` only with
 * `angleLinkLabels` and outside another link's label, where neither autolink adds a link.
 */
function angleLinkAt(text: string, pos: number, angleLinkLabels: boolean, insideLink: boolean) {
  const match = matchAt(text, pos, ANGLE_LINK_RE);
  return match && (match[2] === undefined || (angleLinkLabels && !insideLink)) ? match : null;
}
const BARE_URL_RE = /^(https?:\/\/[^\s<>]+)/;

/**
 * Where the next `]` is, so an unclosable `[` is not quadratic: rules 3 and 4's gate, and
 * `wholeSpans`'. Given input with no `]`, `\[([^\]]+)\]\(` consumes the remainder, fails on `\]` and
 * backtracks across all of it: O(n^2) over the input. Measured on `render(body, 'jira')` without this
 * gate: 25 KB of `[` takes 0.36 s, 50 KB 1.20 s, 100 KB 4.82 s and 200 KB 19.4 s. Specific to `[`: 40 KB
 * of `*` is 0.000 s, of `!` 0.028 s, and prose never gets here (`findNextSpecial` skips whole runs).
 *
 * `[^\]]+` cannot cross a `]`, so a bracket pattern can only match if the first `]` at or after `pos`
 * is followed by `(`; the gate only declines a regex whose failure is certain. `pos` only advances,
 * so the `indexOf` scans are amortised O(n) across the whole loop.
 */
function bracketCursor(text: string): (pos: number) => boolean {
  let nextClose = text.indexOf(']');
  let decidedFor = -1;
  let destinationOk = false;
  return (pos) => {
    if (nextClose !== -1 && nextClose < pos) nextClose = text.indexOf(']', pos);
    if (nextClose === -1 || text[nextClose + 1] !== '(') return false;
    /*
     * The URL half, decided once per `]`: every `[` before it is tried against the same destination,
     * and each would otherwise backtrack the whole label to find it fails (`'['.repeat(n) + '](x y)'`:
     * 1.1 s at 48 KB, quadrupling with each doubling).
     */
    if (decidedFor !== nextClose) {
      decidedFor = nextClose;
      destinationOk = destinationEnd(text, nextClose + 2) !== -1;
    }
    return destinationOk;
  };
}

/**
 * Rule 9b's bare URL at `pos`, or null: GFM's preceding characters, never inside a link's label,
 * and `bareUrlEnd`'s end. Shared with `wholeSpans`.
 */
function bareUrlAt(text: string, pos: number, insideLink: boolean): string | null {
  if (!autolinkMayStartAt(text, pos, insideLink)) return null;
  const candidate = matchAt(text, pos, BARE_URL_RE);
  return candidate ? bareUrlEnd(candidate[1]) : null;
}

/** GFM's rule for where an autolink literal may start, `http` or `www.`: see `AUTOLINK_AFTER`. */
function autolinkMayStartAt(text: string, pos: number, insideLink: boolean): boolean {
  return !insideLink && (pos === 0 || AUTOLINK_AFTER.test(text[pos - 1]!));
}

/**
 * Parse inline Markdown text into ADF inline nodes.
 * Handles nesting via recursive calls that accumulate marks.
 */
function parseInline(
  text: string,
  marks: AdfMark[],
  options: MarkdownToAdfOptions
): AdfNode[] {
  if (!text) return [];

  const nodes: AdfNode[] = [];
  let pos = 0;
  /*
   * Neither autolink (9a, 9b) adds a link inside a link's label. Otherwise
   * `[docs at https://x.com](https://y.com)` gives Jira one text node with two link marks and two
   * different hrefs -- a shape only ever probed with matching hrefs -- while ProseMirror keeps the
   * first and shows the reviewer just one.
   */
  const insideLink = marks.some((m) => m.type === 'link');

  /*
   * Emphasis-close answers for this text, shared by every delimiter in it. Kept per `findClosingRun`
   * call, every opener would rebuild the table, which is quadratic: on a line of globs, 100 patterns
   * 15ms, 200 96ms, 400 648ms. Sound because the answer depends only on `text`; a nested
   * `parseInline` gets a substring and its own cache.
   */
  const closeRuns = new Map<string, number>();

  /*
   * Every `*` and `_` run in this text that could close something, indexed by character. One boolean
   * ("does any asterisk have a non-whitespace character before it") turns true on a single closable
   * asterisk, and then every later opener scans the remainder. Measured through this converter with
   * only the boolean, one line, the emphasis placed before the globs:
   *
   *    11,701 chars    70ms
   *    24,501 chars   254ms
   *    50,101 chars  1016ms
   *   114,901 chars  5112ms
   *
   * With the index, `findClosingRun` answers "nothing at or after here is long enough" by binary search.
   */
  const backticks = backtickRuns(text);
  // Only a text holding a delimiter has a scan to keep out of a link: this is the keystroke path.
  const whole = /[*_]/.test(text) ? wholeSpans(text, backticks, insideLink, options.angleLinkLabels ?? false) : NO_SPANS;
  const scan: EmphasisScan = { text, memo: closeRuns, closable: closableRuns(text, whole), whole };
  // The span `pos` sits in, if any, asked as `pos` advances. See rule 5-7.
  let spanIndex = 0;
  const spanEndAround = (at: number): number => {
    while (spanIndex < whole.ends.length && whole.ends[spanIndex]! <= at) spanIndex++;
    return spanIndex < whole.starts.length && whole.starts[spanIndex]! <= at ? whole.ends[spanIndex]! : -1;
  };

  // Rules 3 and 4's gate, shared with `wholeSpans` so the two cannot disagree about a link.
  const bracketCouldMatch = bracketCursor(text);

  while (pos < text.length) {
    // 1. Escaped character: ASCII punctuation, as CommonMark says, bar `<` and `&`
    // (`isEscapable` says why). Every one of them: a shorter list sends `\"` to Jira as `\"` where
    // every other reader shows `"`.
    if (text[pos] === '\\' && isEscapable(text[pos + 1])) {
      nodes.push(mkText(text[pos + 1]!, marks));
      pos += 2;
      continue;
    }

    // 2. Code span (no nesting inside code)
    //
    // ADF's `code` mark combines with `link` and nothing else. PROBED against Jira, one comment per
    // pair: `code` alone 201, `code`+`link` 201, `code`+`strong` **400 INVALID_INPUT**, `code`+`em`
    // 400, `code`+`strike` 400, mark order irrelevant, and `strong`+`em` 201 as the control. Slack,
    // Linear and GitHub receive the markdown, so the strip is a destination fact (`codeSpanMarks`):
    // GitHub's renderer (`POST /markdown`, gfm) gives `**`code` and words**` as
    // `<strong><code>code</code> and words</strong>` and keeps `[**`c` x**](url)` one link.
    //
    // A run of N backticks closes on the next run of exactly N, and a run nothing closes is literal as
    // a whole (CommonMark 6.1, `codeSpan.ts`). `` /^`([^`]+)`/ `` would put the code in ``` `` a`b `` ```
    // on the wrong stretch, and let an unmatched ``` `` ``` open a span of its own one character on.
    if (text[pos] === '`') {
      const span = codeSpanAt(text, pos, backticks);
      if (span.code === null) {
        nodes.push(mkText(text.slice(pos, span.end), marks));
        pos = span.end;
        continue;
      }
      const kept = options.combineCodeSpanMarks
        ? marks
        : marks.filter((m) => CODE_MARK_COMBINES_WITH.has(m.type));
      if (options.report && kept.length < marks.length) options.report.codeSpanMarksLost++;
      nodes.push({ type: 'text', text: span.code, marks: addMark(kept, { type: 'code' }) });
      pos = span.end;
      continue;
    }

    // 3. Image ![alt](url)
    //
    // Both bracket blocks are behind `bracketCouldMatch` -- see `bracketCursor`.
    const imgMatch = bracketCouldMatch(pos)
      ? matchAt(text, pos, IMAGE_RE)
      : null;
    if (imgMatch) {
      const url = bareDestination(imgMatch[2]);
      nodes.push(...(options.imagesAsLinks
        ? handleLink(imgMatch[1] || url, url, marks, options)
        : handleImage(imgMatch[1], url, marks)));
      pos += imgMatch[0].length;
      continue;
    }

    // 4. Link [text](url)
    const linkMatch = bracketCouldMatch(pos)
      ? matchAt(text, pos, LINK_RE)
      : null;
    if (linkMatch) {
      nodes.push(...handleLink(linkMatch[1], bareDestination(linkMatch[2]), marks, options));
      pos += linkMatch[0].length;
      continue;
    }

    // 5-7. Emphasis: `***both***`, `**bold**`, `*italic*`, and the same three in underscores.
    //
    // `_` is read as CommonMark reads it: Slack, Linear and GitHub draw `_x_` italic, `__x__` bold and
    // `___x___` both, and leave `snake_case_name` and `foo_bar_ and _baz_qux` as text (probed on ten
    // shapes); an unbackticked `__init__` is a bold "init", as on GitHub. One scan for both: an
    // underscore run flanked on both sides opens only after punctuation and closes only before it
    // (`canOpenRun`, `canCloseRun`), and a closer must be the opener's character. `*a _b *c_ d*` departs
    // from the spec: the outer `*` finds no closer and stays text (the scan-per-opener limit).
    //
    // The run is the unit, not the delimiter count: per-count regexes (`/^\*{3}(.+?)\*{3}/`,
    // `/^\*{2}(.+?)\*{2}/`, `/^\*([^*]+?)\*/`) cannot see their run, and without flanking they delete
    // the delimiters from the stored ADF:
    //
    //   SELECT * FROM events WHERE name * 2  ->  SELECT [em: FROM events WHERE name ] 2
    //   use the wildcard *.csv and *.json    ->  use the wildcard [em:.csv and ].json
    //   run on **/*.csv and **/*.json        ->  run on [strong:/*.csv and ]/*.json
    //   a *** b *** c                        ->  a [em+strong: b ] c
    //
    // `(?!\s)` / `(?<!\s)` guards fix `** a **` but not `**/*.csv`, and turn `a *** b *** c` into
    // `a [strong:* b *] c`: `matchAt` slices at `pos`, so no rule sees the character before its opener,
    // and rule 10 advances one character, so the second `*` of `**` is re-examined. So: count the run
    // at `pos`, decide once whether it can open, find a closer, else emit the whole run as text.
    //
    // Checked by a differential through GitHub's renderer (`POST /markdown`, as `measure:github` uses
    // it), compared as per-character mark sets: on 3,008 random asterisk-heavy strings, 8 cases delete
    // a star the spec keeps, all dense punctuation soup (`*(**"-.*:***`) where scan-per-opener differs
    // from the spec's delimiter stack (`findClosingRun`). Every other difference keeps a delimiter the
    // spec consumes (`****a****`, `***a* b**`, `***Note:** text*`): no character is lost. A glob pair is
    // not a defect: GitHub renders `run on **/*.csv and **/*.json` as
    // `run on **/<em>.csv and **/</em>.json` too. A run longer than three is left alone.
    //
    // A code span is skipped whole by both scans (`closableRuns`, `findClosingRun`): in
    // `*see the (`cloud-*`) buckets*` the star in the backticks would close the italic. For `*` and `_`
    // only: the strike rule's `~~` and the link label's `]` cursor still read raw text.
    const delimiter = text[pos];
    if (delimiter === '*' || delimiter === '_') {
      let openEnd = pos;
      while (openEnd < text.length && text[openEnd] === delimiter) openEnd++;

      // Inside a URL, an autolink or a tag a reader takes whole, a delimiter is a character, and it
      // opens nothing: `<https://e.test/_a|b> c_` is one link and a stray `_` (`wholeSpans`).
      const inside = spanEndAround(pos);
      if (inside !== -1) {
        const end = Math.min(openEnd, inside);
        nodes.push(mkText(text.slice(pos, end), marks));
        pos = end;
        continue;
      }
      const runLength = openEnd - pos;

      // Flanking and the rule of 3 read the whole run, which can start before `pos`: what is left
      // of a longer closer is still that run, not a fresh one, so `*b**.b*` must not reopen on the
      // leftover star and delete the next two.
      const fullStart = runStartOf(text, pos, delimiter);
      const canOpen = runLength <= 3 && canOpenRun(text, fullStart, openEnd, delimiter);

      const closeStart = canOpen
        ? findClosingRun(scan, openEnd, runLength, delimiter, {
            both: canCloseRun(text, fullStart, openEnd, delimiter),
            length: openEnd - fullStart,
          })
        : -1;

      if (closeStart === -1) {
        nodes.push(mkText(text.slice(pos, openEnd), marks));
        pos = openEnd;
        continue;
      }

      const emphasised =
        runLength === 3
          ? addMarks(marks, [{ type: 'strong' }, { type: 'em' }])
          : addMark(marks, { type: runLength === 2 ? 'strong' : 'em' });

      nodes.push(...parseInline(text.slice(openEnd, closeStart), emphasised, options));
      // Only `runLength` of the closing run is consumed; anything longer is
      // left for the next pass, which is how `**a***` keeps its stray star.
      pos = closeStart + runLength;
      continue;
    }

    // 8. Strikethrough ~~text~~
    /*
     * With CommonMark's flanking rules, as `*` has them, and exactly two tildes at each end:
     * without them `a ~~ b ~~ c` and `a ~~~b~~~ c` are sent struck, on every destination, where
     * GitHub leaves both as text (probed). The closer is still the nearest `~~`, so the rare
     * `~~a ~~ b~~`, which GitHub strikes past the middle pair, stays text here -- a tilde kept
     * rather than a strike invented.
     */
    const strikeMatch = matchAt(text, pos, /^~~(.+?)~~/);
    const strikeClose = strikeMatch ? pos + 2 + strikeMatch[1].length : -1;
    if (
      strikeMatch &&
      text[pos - 1] !== '~' &&
      text[pos + 2] !== '~' &&
      text[strikeClose - 1] !== '~' &&
      text[strikeClose + 2] !== '~' &&
      leftFlanking(text, pos, pos + 2) &&
      rightFlanking(text, strikeClose, strikeClose + 2) &&
      !isEscaped(text, strikeClose)
    ) {
      const inner = parseInline(
        strikeMatch[1],
        addMark(marks, { type: 'strike' }),
        options
      );
      nodes.push(...inner);
      pos += strikeMatch[0].length;
      continue;
    }

    // 9a. Angle-bracket auto-link <https://url>
    /*
     * The destination cannot hold whitespace, `<` or `|` (CommonMark's autolink grammar; RFC 3986 has
     * no bare `|`). Measured with `[^>]+` on Slack's own link syntax:
     *
     *   in    see <https://e.test/x|the docs>
     *   sent  see [https://e.test/x|the docs](https://e.test/x|the docs)
     *
     * A silent mangled send: Slack is `preview-only`, and the editor draws a plausible link. With the
     * narrow class the span stays text and round-trips byte-identically; 9b cannot take the URL either
     * (`AUTOLINK_AFTER` does not admit `<`).
     *
     * Where the destination reads `<url|label>` itself (`angleLinkLabels`, Slack's profile), the span
     * is that link: the label's characters as written (probed: Slack shows `*bold* _it_` literally),
     * and the mark keeps the spelling (`angle`), so an unedited approval sends the agent's bytes. Not
     * inside another link's label.
     */
    const angleLinkMatch = angleLinkAt(text, pos, options.angleLinkLabels ?? false, insideLink);
    if (angleLinkMatch) {
      const [, url, label] = angleLinkMatch;
      const attrs = options.angleLinkLabels ? { href: url, angle: label === undefined ? 'bare' : 'labelled' } : { href: url };
      nodes.push({
        type: 'text',
        text: label ?? url,
        // Inside a label the URL keeps the label's link and gains no second one.
        marks: insideLink ? marks : addMark(marks, { type: 'link', attrs }),
      });
      pos += angleLinkMatch[0].length;
      continue;
    }

    // 9b. Bare URL (auto-link)
    /*
     * The candidate is greedy and `bareUrlEnd` decides where the URL stops, so a sentence's full stop
     * stays out of the href; what it trims is parsed as text. The guard runs first, so a token full of
     * `https://` with no word boundary before it is not matched greedily at each one.
     */
    const urlText = bareUrlAt(text, pos, insideLink);
    if (urlText) {
      nodes.push({
        type: 'text',
        text: urlText,
        marks: addMark(marks, { type: 'link', attrs: { href: urlText } }),
      });
      pos += urlText.length;
      continue;
    }

    // 10. Plain text -- consume until next potential special character
    const nextSpecialIdx = findNextSpecial(text, pos + 1);
    const plain = text.slice(pos, nextSpecialIdx);
    if (plain) {
      nodes.push(mkText(plain, marks));
    }
    pos = nextSpecialIdx;
  }

  return mergeAdjacentText(nodes);
}

// ---------------------------------------------------------------------------
// Inline helpers
// ---------------------------------------------------------------------------

function handleImage(
  alt: string,
  url: string,
  marks: AdfMark[]
): AdfNode[] {
  // Any http(s) URL takes the media branch, not only `jira-attachment:`. Verified against a real Jira
  // instance: `media { type: "external", url }` is accepted (201) and stored verbatim, and `walkMedia`
  // (`adfToMarkdown.ts`) reads such nodes back. Whether Jira paints it as an `<img>` is unverified
  // (`expand=renderedFields` is a legacy wiki renderer, not evidence); literal text would lose the
  // URL either way. Relative and `data:` URLs degrade to text, because Jira cannot fetch them.
  const isAttachment = url.startsWith(JIRA_ATTACHMENT_SCHEME);
  if (isAttachment || /^https?:\/\//i.test(url)) {
    const contentUrl = isAttachment ? url.slice(JIRA_ATTACHMENT_SCHEME.length) : url;
    return [
      {
        type: 'mediaSingle',
        attrs: { layout: 'center' },
        content: [
          {
            type: 'media',
            attrs: {
              type: 'external',
              url: contentUrl,
              alt: alt || 'image',
            },
          },
        ],
      },
    ];
  }

  // Relative or `data:` URL → text fallback: Jira cannot fetch it
  return [mkText(alt ? `[Image: ${alt}]` : `[Image]`, marks)];
}

function handleLink(
  linkText: string,
  url: string,
  marks: AdfMark[],
  options: MarkdownToAdfOptions
): AdfNode[] {
  // jira-attachment: scheme → link to Jira attachment content URL
  if (url.startsWith(JIRA_ATTACHMENT_SCHEME)) {
    const contentUrl = url.slice(JIRA_ATTACHMENT_SCHEME.length);
    const linkMark: AdfMark = {
      type: 'link',
      attrs: { href: contentUrl },
    };
    return [mkText(linkText, addMark(marks, linkMark))];
  }

  // Regular link
  const linkMark: AdfMark = { type: 'link', attrs: { href: url } };
  return parseInline(linkText, addMark(marks, linkMark), options);
}

const WHITESPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;

/**
 * Whether `c` -- the character beside a delimiter run, `undefined` for the edge of the text -- is an
 * edge, whitespace or punctuation: the class each flanking rule tests the far side against, and
 * where an underscore run can open or close. The writer asks it too: before spelling
 * an emphasis with underscores (`wrapMarks`), and in its cheap escape gate.
 */
export function isFlankingBoundary(c: string | undefined): boolean {
  return c === undefined || WHITESPACE.test(c) || PUNCTUATION.test(c);
}

/**
 * CommonMark's flanking rules for the delimiter run `text[start, end)`, both halves of each.
 *
 * Whitespace alone is only the first half, and the second is what a glob beside a word needs:
 * `report*.csv and data*.json` has both stars preceded by a letter and followed by punctuation, so
 * neither is left-flanking and CommonMark keeps them as text. Checking whitespace alone pairs them
 * and deletes both. The start and end of the text count as whitespace, as they do in the spec.
 */
function leftFlanking(text: string, start: number, end: number): boolean {
  const after = text[end];
  if (after === undefined || WHITESPACE.test(after)) return false;
  return !PUNCTUATION.test(after) || isFlankingBoundary(text[start - 1]);
}

function rightFlanking(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  if (before === undefined || WHITESPACE.test(before)) return false;
  return !PUNCTUATION.test(before) || isFlankingBoundary(text[end]);
}

/** The two characters that delimit emphasis. */
type EmphasisDelimiter = '*' | '_';

const isPunctuation = (c: string | undefined): boolean => c !== undefined && PUNCTUATION.test(c);

/** The code at `i` is an ASCII letter or digit: the common "neither whitespace nor punctuation", tested without a regex. */
function isAsciiWordAt(text: string, i: number): boolean {
  const c = text.charCodeAt(i); // NaN outside the text, which no range holds
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
}

/** An underscore run with a letter or digit on both sides, as in `snake_case`: it neither opens nor closes. */
function isIntraword(text: string, start: number, end: number): boolean {
  return isAsciiWordAt(text, start - 1) && isAsciiWordAt(text, end);
}

/**
 * Whether the run `text[start, end)` can open emphasis (CommonMark 6.2, rules 1 and 5). A star run
 * can whenever it is left-flanking. An underscore run that is right-flanking as well -- inside a
 * word, as in `snake_case` -- can only after punctuation, which is the one rule `_` does not share
 * with `*` and what keeps `foo_bar_` text.
 */
function canOpenRun(text: string, start: number, end: number, delimiter: EmphasisDelimiter): boolean {
  if ((delimiter === '_' && isIntraword(text, start, end)) || !leftFlanking(text, start, end)) return false;
  return delimiter === '*' || !rightFlanking(text, start, end) || isPunctuation(text[start - 1]);
}

/** Whether the run can close emphasis (rules 3 and 7), the mirror of `canOpenRun`. */
function canCloseRun(text: string, start: number, end: number, delimiter: EmphasisDelimiter): boolean {
  if ((delimiter === '_' && isIntraword(text, start, end)) || !rightFlanking(text, start, end)) return false;
  return delimiter === '*' || !leftFlanking(text, start, end) || isPunctuation(text[end]);
}

/**
 * Where the run of `delimiter` holding `index` starts: back over every unescaped one before it. A
 * partly consumed closer leaves its tail to be parsed next, and that tail is still the same run.
 */
function runStartOf(text: string, index: number, delimiter: EmphasisDelimiter): number {
  let start = index;
  while (start > 0 && text[start - 1] === delimiter && !isEscaped(text, start - 1)) start--;
  return start;
}

/**
 * CommonMark's "rule of 3": when either run can both open and close, the two may not pair if their
 * lengths sum to a multiple of three, unless both are. It is what keeps `*a**b*` an italic with its
 * `**` intact -- without it the `**` closes the `*` and two asterisks are deleted.
 */
function ruleOfThreeForbids(
  eitherBoth: boolean,
  openerLength: number,
  closerLength: number
): boolean {
  return (
    eitherBoth &&
    (openerLength + closerLength) % 3 === 0 &&
    !(openerLength % 3 === 0 && closerLength % 3 === 0)
  );
}

/**
 * The runs of one delimiter in `text` that are eligible to close something, in order.
 *
 * "Eligible" is the closing half of the flanking rule and nothing else: the run is not escaped, and
 * it can close (`canCloseRun`). Whether it closes a *particular* opener also depends
 * on its length, which is why `longestFrom` is carried alongside -- a suffix maximum, so "is there
 * anything at or after position p that is at least this long" is one binary search rather than a
 * walk.
 */
interface ClosableRuns {
  /** Start index of each eligible run, ascending. */
  starts: number[];
  /** Length of the run at the same index. */
  lengths: number[];
  /** `longestFrom[i]` is the greatest length among runs `i` and later. */
  longestFrom: number[];
}

/**
 * Both delimiters' indexes: a closer only ever pairs with its own character, so one `indexOf` walk
 * each, past a span (`wholeSpans`) with a cursor. It runs on every text that holds a delimiter, and
 * walking each character instead costs plain prose 55% (measured).
 */
function closableRuns(text: string, whole: WholeSpans): Record<EmphasisDelimiter, ClosableRuns> {
  const found: Record<EmphasisDelimiter, { starts: number[]; lengths: number[] }> = {
    '*': { starts: [], lengths: [] },
    _: { starts: [], lengths: [] },
  };

  for (const delimiter of ['*', '_'] as const) {
    let span = 0;
    for (let i = text.indexOf(delimiter); i !== -1; ) {
      // The commonest underscore by far, inside an identifier, closes nothing: step straight on.
      if (delimiter === '_' && isIntraword(text, i, i + 1)) {
        i = text.indexOf(delimiter, i + 1);
        continue;
      }
      while (span < whole.ends.length && whole.ends[span]! <= i) span++;
      if (span < whole.starts.length && whole.starts[span]! <= i) {
        i = text.indexOf(delimiter, whole.ends[span]!);
        continue;
      }
      if (isEscaped(text, i)) {
        i = text.indexOf(delimiter, i + 1);
        continue;
      }

      let end = i;
      while (end < text.length && text[end] === delimiter) end++;

      if (canCloseRun(text, i, end, delimiter)) {
        found[delimiter].starts.push(i);
        found[delimiter].lengths.push(end - i);
      }
      i = text.indexOf(delimiter, end);
    }
  }

  return { '*': withLongest(found['*']), _: withLongest(found._) };
}

/** The index of the span holding `at`, or -1: a binary search, since a nested scan starts anywhere. */
function spanHolding(whole: WholeSpans, at: number): number {
  const { starts, ends } = whole;
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid]! <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length && starts[lo]! <= at ? lo : -1;
}

/**
 * What both emphasis scans step over whole, and inside which no delimiter opens, as ascending,
 * non-overlapping `[starts[i], ends[i])`. `kinds` says whether a reader keeps its characters as they
 * are (`verbatim`: a URL, an autolink, a tag), which is what the writer's escape pass asks
 * (`verbatimSpans`); a code span and a link's label are not, since a literal backtick or `[` in text
 * still needs its backslash.
 */
interface WholeSpans {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  readonly kinds: readonly ('code' | 'link' | 'verbatim')[];
}

const NO_SPANS: WholeSpans = { starts: [], ends: [], kinds: [] };

/**
 * The spans a reader takes as one unit, so no emphasis pairs across or inside them (CommonMark 6.2,
 * rule 17: code spans, links, autolinks and raw HTML bind tighter). `_foo [bar_](/url)` is an
 * underscore and a link, `_see https://e.test/a_.b now_` an italic holding the whole URL. One walk:
 *
 *  - what `parseInline` reads whole, asked with its own predicates (`bracketCursor`, the regexes,
 *    `bareUrlAt`): a code span, an inline link or image, an angle autolink, a bare URL, and
 *    `<url|label>` under `angleLinkLabels`;
 *  - what a reader takes whole and this converter keeps as text: any other CommonMark autolink, an
 *    email autolink, an inline HTML tag, GFM's `www.` and email literals (`<https://e.test/_a|b> c_`).
 *
 * Slack's other tokens (`<#C123|dev_team>`, `<@U1>`) are text to CommonMark and unprobed on Slack, so
 * left to the scan. Checked against micromark (`core/test/underscoreEmphasis.test.ts`), and linear:
 * each test is bounded by its construct, the `]` gate is `bracketCursor`, and the email test runs only
 * where an `@` follows in the word.
 */
function wholeSpans(
  text: string,
  backticks: BacktickRuns,
  insideLink: boolean,
  angleLinkLabels: boolean
): WholeSpans {
  const starts: number[] = [];
  const ends: number[] = [];
  const kinds: WholeSpans['kinds'][number][] = [];
  const linkCouldMatch = bracketCursor(text);
  // An email literal needs an `@` later in the same word: two cursors, so asking is O(1).
  let nextAt = text.indexOf('@');
  let nextSpace = -1;
  const spaceFrom = (from: number): number => {
    WHITESPACE_G.lastIndex = from;
    return WHITESPACE_G.exec(text)?.index ?? text.length;
  };
  // Where a span can start, so the walk jumps between those rather than visiting every character:
  // visiting every character costs a line of identifiers three times as much. An email starts where
  // its local part does.
  const emailStarts = nextAt === -1 || insideLink ? [] : emailCandidates(text);
  let emailIndex = 0;
  const nextCandidate = (from: number): number => {
    SPAN_START.lastIndex = from;
    const fixed = SPAN_START.exec(text)?.index ?? text.length;
    while (emailIndex < emailStarts.length && emailStarts[emailIndex]! < from) emailIndex++;
    return Math.min(fixed, emailStarts[emailIndex] ?? text.length);
  };

  for (let i = nextCandidate(0); i < text.length; i = nextCandidate(i)) {
    const c = text[i]!;
    if (c === '\\' && isEscapable(text[i + 1])) {
      i += 2;
      continue;
    }
    let end = -1;
    let kind: WholeSpans['kinds'][number] = 'verbatim';
    if (c === '`') {
      const span = codeSpanAt(text, i, backticks);
      if (span.code === null) {
        i = span.end;
        continue;
      }
      end = span.end;
      kind = 'code';
    } else if ((c === '!' || c === '[') && linkCouldMatch(i)) {
      end = matchedEnd(text, i, c === '!' ? IMAGE_RE : LINK_RE);
      kind = 'link';
    } else if (c === '<') {
      const angle = angleLinkAt(text, i, angleLinkLabels, insideLink);
      if (angle) {
        end = i + angle[0].length;
        if (angle[2] !== undefined) kind = 'link';
      } else {
        end = matchedEnd(text, i, READER_ANGLE_RE);
      }
    } else if (c === 'h' && text.startsWith('http', i)) {
      const url = bareUrlAt(text, i, insideLink);
      if (url) end = i + url.length;
    } else if (c === 'w' && text.startsWith('www.', i) && autolinkMayStartAt(text, i, insideLink)) {
      const www = matchAt(text, i, WWW_CANDIDATE_RE);
      const length = www ? bareUrlEnd(www[0]).length : 0;
      if (length > 'www.'.length) end = i + length;
    }
    if (end === -1 && nextAt !== -1 && !insideLink && EMAIL_LOCAL.test(c) && (i === 0 || !EMAIL_LOCAL.test(text[i - 1]!))) {
      if (nextAt < i) nextAt = text.indexOf('@', i);
      if (nextSpace < i) nextSpace = spaceFrom(i);
      if (nextAt !== -1 && nextAt < nextSpace) end = emailLiteralEnd(text, i);
    }
    if (end === -1) {
      i++;
      continue;
    }
    starts.push(i);
    ends.push(end);
    kinds.push(kind);
    i = end;
  }
  return { starts, ends, kinds };
}

/** Every character a span in `wholeSpans` can start at, bar an email: an escape, a backtick, `!`, `[`, `<`, `http`, `www.`. */
const SPAN_START = /[\\`![<hw]/g;

/** Where each email local part ends at an `@` begins, ascending: the only places one can start. */
function emailCandidates(text: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > 0 && EMAIL_LOCAL.test(text[start - 1]!)) start--;
    if (start < at && start !== out.at(-1)) out.push(start);
  }
  return out;
}

/**
 * The spans of `text` whose characters every reader keeps as they are -- a URL, an autolink, an
 * HTML tag, a `www.` or email literal -- as `[start, end)`, for the writer's escape pass. A backslash
 * put inside one is a backslash the reader sees, and in a URL a different URL: escaping
 * `https://e.test/my_page_.html` breaks its read-back, so a block that needs a literal `*x*` escaped
 * falls back to plain and goes out italic.
 */
export function verbatimSpans(text: string, insideLink: boolean): [number, number][] {
  const { starts, ends, kinds } = wholeSpans(text, backtickRuns(text), insideLink, false);
  return kinds.flatMap((kind, i) => (kind === 'verbatim' ? [[starts[i]!, ends[i]!] as [number, number]] : []));
}

/**
 * An angle-bracket span a reader takes whole and this converter keeps as text (`wholeSpans`):
 * CommonMark's autolink of any scheme, its email autolink, and its inline open and closing tags
 * (6.5, 6.6). Spelled as the spec spells them, so a `<` that is none of them stays live. Linear:
 * every repetition is anchored on a character the one before it cannot take.
 */
const READER_ANGLE_RE = new RegExp(
  '^(?:' +
    [
      /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/,
      /<[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/,
      /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?)*\s*\/?>/,
      /<\/[A-Za-z][A-Za-z0-9-]*\s*>/,
    ]
      .map((r) => r.source)
      .join('|') +
    ')'
);

/** GFM's `www.` literal, before `bareUrlEnd` trims it as it trims a URL. */
const WWW_CANDIDATE_RE = /^www\.[^\s<>]*/;

/** GFM's email literal: what its local part holds, and the whole of it. */
const EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
const EMAIL_LITERAL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/;
const WHITESPACE_G = /\s/g;

/**
 * Where the email literal at `pos` ends, or -1. A final `.`, `_` or `-` is not part of it, as
 * micromark reads `_mail me@x.com_`: an italic holding the address.
 */
function emailLiteralEnd(text: string, pos: number): number {
  const m = matchAt(text, pos, EMAIL_LITERAL_RE);
  if (!m) return -1;
  // A loop, not `/[._-]+$/`: that backtracks quadratically on a long run of them that is not at the
  // end (5.8 s at 100 KB, measured).
  let end = m[0].length;
  while (end > 0 && '._-'.includes(m[0][end - 1]!)) end--;
  const email = m[0].slice(0, end);
  const domain = email.slice(email.indexOf('@') + 1);
  return domain.includes('.') && !domain.startsWith('.') ? pos + end : -1;
}

/** Where `pattern` matching at `pos` ends, or -1. */
function matchedEnd(text: string, pos: number, pattern: RegExp): number {
  const m = matchAt(text, pos, pattern);
  return m ? pos + m[0].length : -1;
}

function withLongest({ starts, lengths }: { starts: number[]; lengths: number[] }): ClosableRuns {
  const longestFrom: number[] = new Array(starts.length);
  let longest = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    longest = Math.max(longest, lengths[i]);
    longestFrom[i] = longest;
  }

  return { starts, lengths, longestFrom };
}

/**
 * Whether any eligible run at or after `from` is long enough to close a run of `runLength`. Binary
 * search plus one lookup.
 *
 * A false answer is exact, not a heuristic: every position `findClosingRun` could return is in this
 * index, so if none of them qualifies there is nothing to find and the scan can be skipped entirely.
 */
function anyCloserAtOrAfter(closable: ClosableRuns, from: number, runLength: number): boolean {
  const { starts, longestFrom } = closable;

  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < from) lo = mid + 1;
    else hi = mid;
  }

  return lo < starts.length && longestFrom[lo] >= runLength;
}

/**
 * Where a run of `runLength` of `delimiter` is closed, or -1: the same character, at least as long,
 * able to close (`canCloseRun`), and allowed by the rule of 3 (`opener`: could the opening run also
 * close, and its whole length). The caller consumes only `runLength`, so `**a***` keeps its stray star.
 *
 * "Can it close" is tested before "can it open", keeping `*a* and *b*` two emphases. A run that can
 * only open is skipped with its own close, so `*a **b** c*` nests; only a run at least as long as
 * mine, or in `**a*b**` the lone `*` eats the real closer's first asterisk and a delimiter is deleted.
 *
 * `memo` makes this linear rather than exponential: an opener that never closes is recursed into and
 * scanned past, and the next repeats the tail (a list of globs: every `*` after a space, before a `.`).
 * Measured through the real converter without it: 20 globs 68ms, 24 globs 1.07s, **26 globs (145
 * characters) 4.27s**.
 *
 * `depth < 32` is a latency bound, and inexact: past 33 opener-only runs on one line, a later emphasis
 * can pair wrongly and lose two asterisks. Measured alternatives: uncapped, the stack overflows at
 * ~5,000 runs; a heap stack is exact but quadratic, 8.5s at the body cap; exact and linear needs
 * CommonMark's delimiter stack, a rewrite. Block parsing splits per paragraph: 101 KB of text, 12ms.
 */
function findClosingRun(
  scan: EmphasisScan,
  from: number,
  runLength: number,
  delimiter: EmphasisDelimiter,
  opener: { both: boolean; length: number },
  depth = 0
): number {
  const { text, memo, whole } = scan;
  const key = `${delimiter}${from}:${runLength}:${opener.both}:${opener.length}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  // A failure, the quadratic case, costs a binary search rather than a walk to the end of the text.
  if (!anyCloserAtOrAfter(scan.closable[delimiter], from, runLength)) {
    memo.set(key, -1);
    return -1;
  }

  let answer = -1;

  // From one of my delimiters to the next: the other character is content.
  for (let at = text.indexOf(delimiter, from); at !== -1; ) {
    // A code span, a link or a URL is content, skipped whole.
    const span = spanHolding(whole, at);
    if (span !== -1) {
      at = text.indexOf(delimiter, whole.ends[span]!);
      continue;
    }

    // Step over just this one: the rest of the run is still live, so `\**` escapes the first and
    // leaves a delimiter of length one behind it.
    if (isEscaped(text, at)) {
      at = text.indexOf(delimiter, at + 1);
      continue;
    }

    let runEnd = at;
    while (runEnd < text.length && text[runEnd] === delimiter) runEnd++;
    const length = runEnd - at;

    // `at > from` always holds: the caller's run consumed every delimiter adjacent to itself, so
    // the content between is never empty.
    // `at` can sit partway into a run, after a nested skip consumed its head: flanking and the
    // rule of 3 still belong to the whole run.
    const fullStart = runStartOf(text, at, delimiter);
    const canOpen = canOpenRun(text, fullStart, runEnd, delimiter);
    const canClose = canCloseRun(text, fullStart, runEnd, delimiter);
    if (
      length >= runLength &&
      canClose &&
      !ruleOfThreeForbids(opener.both || canOpen, opener.length, runEnd - fullStart)
    ) {
      answer = at;
      break;
    }

    const opensOnly = length >= runLength && length <= 3 && canOpen;
    const inner =
      opensOnly && depth < 32
        ? findClosingRun(scan, runEnd, length, delimiter, { both: canClose, length: runEnd - fullStart }, depth + 1)
        : -1;
    at = text.indexOf(delimiter, inner === -1 ? runEnd : inner + length);
  }

  memo.set(key, answer);
  return answer;
}

/** What every scan of one text shares, fixed for one `parseInline` call (see `closeRuns` there). */
interface EmphasisScan {
  readonly text: string;
  readonly memo: Map<string, number>;
  readonly closable: Record<EmphasisDelimiter, ClosableRuns>;
  readonly whole: WholeSpans;
}

function matchAt(
  text: string,
  pos: number,
  pattern: RegExp
): RegExpMatchArray | null {
  const slice = text.slice(pos);
  return slice.match(pattern);
}

/** The characters rule 10's plain run stops at, by code, for `findNextSpecial`'s per-character loop. */
const SPECIAL_CODES = new Set([...'`[!*_~\\@<'].map((c) => c.charCodeAt(0)));
const UNDERSCORE = 95;

function findNextSpecial(text: string, startPos: number): number {
  for (let i = startPos; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (SPECIAL_CODES.has(code)) {
      // An underscore inside a word (`snake_case`) is text, so it need not stop the plain run:
      // otherwise a line dense with identifiers becomes one text node per underscore.
      if (code !== UNDERSCORE || !isIntraword(text, i, i + 1)) return i;
      continue;
    }
    // Also break on http(s):// for bare URL detection
    if (
      text[i] === 'h' &&
      text[i + 1] === 't' &&
      text[i + 2] === 't' &&
      text[i + 3] === 'p' &&
      (text[i + 4] === ':' || (text[i + 4] === 's' && text[i + 5] === ':'))
    ) {
      return i;
    }
  }
  return text.length;
}

function mkText(text: string, marks: AdfMark[]): AdfNode {
  if (marks.length === 0) return { type: 'text', text };
  return { type: 'text', text, marks: [...marks] };
}

/**
 * `marks` plus `mark`, unless an emphasis of that type is already there. Nested same-type emphasis
 * (`**a **b** c**`, `**__init__.py**`) must not give the inner run the mark twice: ProseMirror keeps
 * one, but `init` and `.py` then stay two text nodes, and inside an italic the writer gives each its
 * own pair, `**init****.py**`, a run of four that reads back as text. A link is left alone: one inside
 * another cannot be written, and two would be two hrefs.
 */
function addMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  if (mark.type !== 'link' && marks.some((m) => m.type === mark.type)) return marks;
  return [...marks, mark];
}

function addMarks(marks: AdfMark[], newMarks: AdfMark[]): AdfMark[] {
  return newMarks.reduce(addMark, marks);
}

/** Merge consecutive text nodes that have identical mark sets */
function mergeAdjacentText(nodes: AdfNode[]): AdfNode[] {
  if (nodes.length <= 1) return nodes;
  const result: AdfNode[] = [nodes[0]];
  for (let i = 1; i < nodes.length; i++) {
    const prev = result[result.length - 1];
    const curr = nodes[i];
    if (
      prev.type === 'text' &&
      curr.type === 'text' &&
      marksEqual(prev.marks, curr.marks)
    ) {
      prev.text = (prev.text || '') + (curr.text || '');
    } else {
      result.push(curr);
    }
  }
  return result;
}

function marksEqual(
  a: AdfMark[] | undefined,
  b: AdfMark[] | undefined
): boolean {
  const aa = a || [];
  const bb = b || [];
  if (aa.length !== bb.length) return false;
  return aa.every((m, i) => {
    if (m.type !== bb[i].type) return false;
    const aAttrs = m.attrs;
    const bAttrs = bb[i].attrs;
    if (!aAttrs && !bAttrs) return true;
    if (!aAttrs || !bAttrs) return false;
    const aKeys = Object.keys(aAttrs);
    const bKeys = Object.keys(bAttrs);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => aAttrs[k] === bAttrs[k]);
  });
}
