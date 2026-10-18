/**
 * The document API the review surface uses: markdown -> TipTap document -> (human edits) -> markdown.
 * Both directions route through ADF, already a ProseMirror schema, with a converter verified both
 * ways. See `prosemirror.ts` for why that is a mapping rather than a second parser.
 */

import { convertMarkdownToAdf, type ConversionReport, type ItemBlocks } from './adf/markdownToAdf';
import { convertAdfToMarkdown } from './adf/adfToMarkdown';
import { hoistMedia } from './hoistMedia';
import { adfToProseMirror, proseMirrorToAdf, type PmNode } from './prosemirror';
import { decodeMentions, encodeMentions } from './mentions';
import type { AdfDocument } from './adf/types';
import { withoutSpace } from './adf/util';
import { matchTrailingNewline } from './markdown';
import type { CodeSpanMarks, MediaPlacement } from './profiles/index';
import type { MentionSupport } from './mentionTokens';

/**
 * The destination facts that change which document the editor should hold, derived from the
 * profile only by `editorOptionsFor`. An object, since `toEditorDoc(body, true)` would read as
 * either of two booleans.
 */
export interface EditorDocOptions {
  /** Whether a `mention:` link decodes to a mention NODE. See `MentionSupport.chips`. */
  structuralMentions?: boolean;
  /** See `MediaPlacement`. Defaults to `inline`: leave media where markdown put it. */
  mediaPlacement?: MediaPlacement;
  /** See the profile's `rendersMedia`. Defaults to true: an image stays an image unless the destination draws something else. */
  rendersMedia?: boolean;
  /**
   * Which blocks a list item keeps, the profile's `listItemBlocks`. Defaults to `adf`, Jira's shape,
   * which cannot produce a 400: what an item cannot hold, the converter moves out. See `ItemBlocks`.
   */
  listItemBlocks?: ItemBlocks;
  /**
   * Whether emphasis may span a code span here. Defaults to `link-only`, ADF's rule, which cannot
   * produce a tree Jira answers 400 to. Becomes the converter's `combineCodeSpanMarks`.
   */
  codeSpanMarks?: CodeSpanMarks;
  /** Whether `<url|label>` is a link here. The profile's `angleLinkLabels`, passed to the converter as is. */
  angleLinkLabels?: boolean;
}

/**
 * Load canonical markdown into a TipTap/ProseMirror document, through `markdownToAdfFor`, the
 * pipeline `profiles/jira.ts` converts through. Where the destination draws mentions,
 * `[@Label](mention:ID)` becomes a mention node, so editing keeps the id (`MentionSupport.chips`).
 * Without Jira's hoist the window would draw an image in a heading or task item that the CLI sends
 * at the end of the nearest block container, and an unedited approval (`edited: false`) would
 * record no move.
 */
export function toEditorDoc(markdown: string, options: EditorDocOptions = {}): PmNode {
  return adfToProseMirror(markdownToAdfFor(markdown, options).adf);
}

/** The profile fields the editor pipeline reads. Both a profile and a `RenderResult` carry them. */
export interface DocumentFacts {
  readonly mentions: MentionSupport;
  readonly mediaPlacement: MediaPlacement;
  readonly rendersMedia: boolean;
  readonly codeSpanMarks: CodeSpanMarks;
  readonly listItemBlocks: ItemBlocks;
  readonly angleLinkLabels: boolean;
}

/**
 * `EditorDocOptions` for a destination, from its profile or the `RenderResult` that copied it: the
 * one spelling of how those fields become pipeline flags, `render()` included.
 */
export function editorOptionsFor(facts: DocumentFacts): EditorDocOptions {
  return {
    structuralMentions: facts.mentions.chips !== null,
    mediaPlacement: facts.mediaPlacement,
    rendersMedia: facts.rendersMedia,
    listItemBlocks: facts.listItemBlocks,
    codeSpanMarks: facts.codeSpanMarks,
    angleLinkLabels: facts.angleLinkLabels,
  };
}

/**
 * markdown -> ADF as the destination would have it: the one pipeline under the editor
 * (`toEditorDoc`) and Jira's `convert`, so the window shows the tree Jira is sent. Returns `raw` too,
 * for Jira's `inspect()`: which items held only media is visible only before the hoist
 * (`mediaOnlyItems`).
 *  - `rendersMedia: false`: the converter emits each image as the link the destination draws
 *    (`imagesAsLinks`), so the preview promises no picture and ADF (no inline media) splits no
 *    sentence around one.
 *  - `mediaPlacement`: sets `inlineMedia` and whether `hoistMedia` runs; `block` shows the image
 *    where Jira puts it, `inline` (Linear) leaves it where markdown wrote it.
 *  - `structuralMentions`: decodes `[@Label](mention:ID)` into a mention node only where the
 *    destination renders one; Slack and Linear ship that link as literal characters.
 */
export function markdownToAdfFor(
  markdown: string,
  options: EditorDocOptions = {}
): { raw: AdfDocument; adf: AdfDocument; report: ConversionReport } {
  // The converter's tally of what it un-nested, for the profile to disclose. Supplied here, so no
  // caller reads zero off a forgotten sink. See `MarkdownToAdfOptions.report`.
  const report: ConversionReport = { unnestedFromTasks: 0, movedOutOfListItems: 0, codeSpanMarksLost: 0 };
  const raw = convertMarkdownToAdf(markdown, {
    inlineMedia: options.mediaPlacement !== 'block',
    itemBlocks: options.listItemBlocks,
    combineCodeSpanMarks: options.codeSpanMarks === 'any',
    imagesAsLinks: options.rendersMedia === false,
    angleLinkLabels: options.angleLinkLabels,
    report,
  });
  const hoisted = options.mediaPlacement === 'block' ? hoistMedia(raw) : raw;
  return { raw, adf: options.structuralMentions ? decodeMentions(hoisted) : hoisted, report };
}

/**
 * The document the review surface should display, for this render: the one call a surface makes,
 * so no destination flag passes through the window by hand. `body` defaults to the rendered body;
 * the one-click repair passes its replacement text.
 */
export function editorDocFor(
  render: DocumentFacts & { canonical: string },
  body: string = render.canonical
): PmNode {
  return toEditorDoc(body, editorOptionsFor(render));
}

/**
 * The markdown a document serialises to, for a destination: the out leg of `editorDocFor`, so no
 * call site hand-writes the placement. It ends the way `render.canonical` does (see
 * `matchTrailingNewline`); this is the only place that input is in scope, so not `fromEditorDoc`.
 * On a keystroke the caller passes the current render, whose body already ends that way.
 */
export function markdownFor(
  render: { canonical: string; mediaPlacement: MediaPlacement },
  doc: PmNode
): string {
  return matchTrailingNewline(
    fromEditorDoc(doc, { mediaPlacement: render.mediaPlacement }),
    render.canonical
  );
}

/**
 * The baseline: the document the editor opens with and the body it serialises to. It is what the
 * reviewer reads, what an untouched approval sends, the yardstick for `edited` and one half of every
 * `silenced` computation, so the window and the tests take it from here. Not
 * `fromEditorDoc(toEditorDoc(...))`, which applies no destination facts and differs by four bytes on
 * the torture fixture.
 */
export function baselineFor(render: DocumentFacts & { canonical: string }): {
  doc: PmNode;
  body: string;
} {
  const doc = editorDocFor(render);
  return { doc, body: markdownFor(render, doc) };
}

/**
 * Serialise a TipTap document back to canonical markdown.
 *
 * The round trip is clean but not byte-identical: a bare URL comes back as an explicit link
 * (`see https://example.com now` -> `see [https://example.com](https://example.com) now`). At load
 * the body sent is this output, so that holds for every review; `silencedWarnings`
 * (`surface/src/useReview.ts`) reports it. A nested list comes back tight (`walkListItem` emits no
 * blank line before it): `- a\n  - b\n  - c\n- d\n` comes back byte-identical but for the trailing
 * newline, which `markdownFor` matches. No image rewrite on the way out: see `lostInMarkdown`.
 */
export function fromEditorDoc(
  doc: PmNode,
  // Placement is the only fact this leg reads; a wider type would let
  // `fromEditorDoc(doc, { rendersMedia: false })` type-check and do nothing.
  options: Pick<EditorDocOptions, 'mediaPlacement'> = {}
): string {
  return markdownFromAdf(
    proseMirrorToAdf(doc, {
      inlineMedia: options.mediaPlacement !== 'block',
    }) as AdfDocument
  );
}

/**
 * ADF -> canonical markdown, with every mention's id kept: the one way a tree becomes a sendable
 * body, for the editor (`fromEditorDoc`) and Jira's one-click repair (`suggestFix`). The converter
 * alone writes a mention as its `@Label`, which reads as a name and pings nobody.
 */
export function markdownFromAdf(adf: AdfDocument): string {
  return convertAdfToMarkdown(encodeMentions(adf));
}

/**
 * ProseMirror -> ADF, without the markdown step. A test seam, not a send path (draftgate is markdown
 * end to end): the ADF-level tests (`core/test/editor.test.ts`, `cli/test/regressions.test.ts`)
 * assert nesting rules about the ADF a document produces.
 */
export function editorDocToAdf(doc: PmNode): AdfDocument {
  return proseMirrorToAdf(doc);
}

export type { PmNode };

/**
 * One structural node the editor holds that markdown cannot carry back. `parent` is what it sits
 * inside, so the message says where to look ("a blockquote inside a checklist item").
 */
export interface LostNode {
  type: string;
  parent: string;
  /**
   * Where it is, as child indices from the document root (`[0, 1]` is the second child of the first
   * block). Indices, not a ProseMirror position: `core` is pure and has no schema, so a position
   * would re-implement ProseMirror's node sizing, and one wrong rule outlines innocent prose. The
   * renderer resolves them against the real document (`surface/src/lostHighlight.ts`). Only the
   * `editor`-reach warnings carry such a path, since only they walk the editor's document; the rest
   * come from the markdown text or the converted tree.
   */
  path: number[];
}

/** Every node type in the tree with its count, but `text` and empty paragraphs (`lostInMarkdown`). */
function structuralCounts(root: PmNode): Map<string, number> {
  const counts = new Map<string, number>();
  (function walk(node: PmNode) {
    if (node.type && node.type !== 'text' && !isEmptyParagraph(node)) {
      counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    }
    for (const child of node.content ?? []) walk(child);
  })(root);
  return counts;
}

/** A paragraph holding nothing: editor chrome, not content (see `lostInMarkdown`). */
function isEmptyParagraph(node: PmNode): boolean {
  return node.type === 'paragraph' && (node.content?.length ?? 0) === 0;
}

/**
 * What would be lost if this editor document were sent as markdown. The editor's schema is wider
 * than markdown, and `fromEditorDoc` silently writes the closest thing. Measured, document in ->
 * markdown out:
 *
 *   taskItem > [paragraph, blockquote]  ->  "- [ ] x> quoted"   the runs are CONCATENATED and the
 *                                                               quote is gone
 *   tableCell > bulletList              ->  "| - a |\n| --- |"   the list flattens into the cell
 *   listItem > heading                  ->  "- ## H"            the heading does not survive
 *
 * The first is reachable by ordinary editing: `TaskItem` is `nested: true` with `paragraph block*`,
 * so Enter in a checklist item and then a quote gets there. Nothing throws, so Approve stays live.
 *
 * A round trip, not a hand-written table of legal shapes (a second grammar beside the converter's):
 * `back` is the re-parse, made once by `render()` and shared with `lostMarks`. Not reported:
 * - `text` nodes: equal-mark runs coalesce on re-parse; counting them flags 4% of 16,000 generated
 *   documents, none of which lost a character.
 * - An empty paragraph: ProseMirror keeps a trailing one so a reviewer can type below the last
 *   block, markdown cannot carry it, and counting it would make ticking a checkbox block the send.
 *   Only the live editor has one (`surface/harness/probe.ts`); `toEditorDoc` builds none.
 * - Characters: the writer does not re-escape what it need not (`e\*sc **b**` loses the escape), so
 *   comparing text would block untouched drafts. What is left of text loss is `lostText`'s warning.
 * - Moves: counting, not comparing shape, leaves `hoistMedia`'s moves alone.
 *
 * No `image` exemption, though a destination that draws no picture re-parses an image as a link:
 * `editorExtensions` registers no image node there, so neither a pasted `img[src]` nor `before` can
 * hold one (`surface/schema.test.ts` asserts the absence), and the converter's `imagesAsLinks` keeps
 * images out of that editor. A markdown rewrite in its place can miss an image the converter reads
 * (a `<...>` destination, a code span inside the image). For the same reason `fromEditorDoc` rewrites
 * no image on the way out.
 *
 * Verified: zero reports across every document this repo ships, under all four option combinations,
 * and 154 of 16,000 generated markdown-originated documents, each a real loss (an image-only
 * checklist item or heading, whose emptied container the writer drops), two of which no destination
 * profile discloses.
 */
export function lostInMarkdown(doc: PmNode, back: PmNode): LostNode[] {
  const before = structuralCounts(doc);
  const after = structuralCounts(back);

  const missing = new Set<string>();
  for (const [type, n] of before) {
    if ((after.get(type) ?? 0) < n) missing.add(type);
  }
  if (missing.size === 0) return [];

  // `paragraph` is usually the mechanism, not the loss (a flattened block merges two paragraphs), so
  // it is reported only when nothing else was lost.
  if (missing.size > 1) missing.delete('paragraph');

  // Where each lost type sits on the original document, outermost first. First occurrence only: the
  // message names a shape.
  const lost: LostNode[] = [];
  const named = new Set<string>();
  (function walk(node: PmNode, parent: string, path: number[]) {
    if (missing.has(node.type) && !named.has(node.type)) {
      named.add(node.type);
      lost.push({ type: node.type, parent, path });
    }
    (node.content ?? []).forEach((child, i) => walk(child, node.type, [...path, i]));
  })(doc, 'doc', []);
  return lost;
}

/**
 * How many non-whitespace characters each mark type covers, across `nodes`.
 *
 * Whitespace is not counted because the writer moves it outside a mark on purpose (`** a**` is not
 * emphasis, so a bold `a ` goes out as `**a** `), and a bold space is nothing a reader can see.
 */
function markCoverage(nodes: PmNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  (function walk(node: PmNode) {
    if (node.text !== undefined && node.marks?.length) {
      const n = node.text.replace(/\s/g, '').length;
      for (const m of node.marks) counts.set(m.type, (counts.get(m.type) ?? 0) + n);
    }
    for (const child of node.content ?? []) walk(child);
  })({ type: 'doc', content: nodes });
  return counts;
}

/**
 * The top-level blocks `lostMarks` and `lostText` pair, each with its index in the editor document.
 * One spelling, so both warnings point "Show me" at the same block for one change.
 */
function topLevelBlocks(root: PmNode): { node: PmNode; i: number }[] {
  return (root.content ?? []).flatMap((node, i) => (isEmptyParagraph(node) ? [] : [{ node, i }]));
}

/** Formatting the editor holds that markdown would not carry back. See `lostMarks`. */
export interface LostMarks {
  /** Mark types whose coverage dropped, in the order the document first holds them. */
  types: string[];
  /** The first top-level block that lost one, when blocks could be paired. See `LostNode.path`. */
  editorPath?: number[];
}

/**
 * The formatting the editor document holds that would not survive being sent as markdown, a milder
 * warning than `lostInMarkdown`'s since the text arrives. A reviewer strikes `(b)` inside `a(b)c`;
 * the writer spells it `a~~(b)~~c`, which does not flank, so it comes back as text. Compares coverage
 * per mark type, not characters (the round trip does not keep text aligned; see `lostInMarkdown`):
 * a type whose coverage drops is reported, one that grows (a typed bare URL coming back as a link)
 * is not. Per top-level block when both sides have as many, so a loss cannot cancel against a gain
 * and the warning can point at the block; otherwise across the whole document.
 */
export function lostMarks(doc: PmNode, back: PmNode): LostMarks | undefined {
  const before = topLevelBlocks(doc);
  const after = topLevelBlocks(back);
  const pairs =
    before.length === after.length
      ? before.map((b, k) => ({ path: [b.i], was: [b.node], back: [after[k]!.node] }))
      : [{ path: undefined, was: before.map((b) => b.node), back: after.map((a) => a.node) }];

  const types = new Set<string>();
  let editorPath: number[] | undefined;
  for (const pair of pairs) {
    const came = markCoverage(pair.back);
    const lost = [...markCoverage(pair.was)].filter(([type, n]) => (came.get(type) ?? 0) < n);
    if (lost.length > 0) editorPath ??= pair.path;
    for (const [type] of lost) types.add(type);
  }
  if (types.size === 0) return undefined;
  return { types: [...types], ...(editorPath ? { editorPath } : {}) };
}

/** Where the text the editor holds would not come back as text. See `lostText`. */
export interface LostText {
  /** The first top-level block whose text differs, when blocks could be paired. See `LostNode.path`. */
  editorPath?: number[];
}

/**
 * Text on screen that the serialised markdown does not read back as the same text: a character that
 * turns into structure or markup (`# of tickets` sent as a heading `of tickets`), which neither
 * `lostInMarkdown` nor `lostMarks` sees. The backstop for what `escapeLineStarts` and the writer's
 * per-block inline repair miss, so it runs at load too, where an agent's draft is normalised.
 * Whitespace is not compared (`withoutSpace`, the writer's rule): a whitespace-only paragraph in a
 * quote and a trailing empty paragraph are both whitespace, and CommonMark drops a paragraph's
 * leading spaces. Paired per top-level block as in `lostMarks`; when the counts differ the whole
 * document is compared, since a block split in two with every character kept is not a text loss.
 */
export function lostText(doc: PmNode, back: PmNode): LostText | undefined {
  const before = topLevelBlocks(doc);
  const after = topLevelBlocks(back);
  if (before.length !== after.length) {
    return comparableText(doc) === comparableText(back) ? undefined : {};
  }
  for (let k = 0; k < before.length; k++) {
    if (comparableText(before[k]!.node) !== comparableText(after[k]!.node)) {
      return { editorPath: [before[k]!.i] };
    }
  }
  return undefined;
}

/** Every character a reader sees, in order, compared without whitespace -- the writer's rule. */
function comparableText(node: PmNode): string {
  let out = '';
  (function walk(n: PmNode) {
    if (n.text !== undefined) out += n.text;
    for (const child of n.content ?? []) walk(child);
  })(node);
  return withoutSpace(out);
}
