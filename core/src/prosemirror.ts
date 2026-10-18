/**
 * ADF <-> ProseMirror (TipTap) document mapping.
 *
 * ADF is a ProseMirror schema (both are `{ type, content, attrs, marks, text }` trees), so the
 * editor reuses the markdown <-> ADF converter and renames the few nodes whose names differ. For
 * Jira ADF is what is sent; for the other destinations it is an intermediate and markdown is sent.
 *
 * The round trip is not byte-identical (a bare URL comes back as an explicit link), so the body the
 * editor serialises can differ from `canonical` untouched: comparing them does not say whether a
 * human edited (see `silencedWarnings`, `surface/src/useReview.ts`, and `round-trip.md`).
 */

import type { AdfDocument, AdfNode, AdfMark } from './adf/types';
import { hoistMedia } from './hoistMedia';
import { INLINE_ONLY } from './adfSchema';

// ---------------------------------------------------------------------------
// Node and mark name maps
// ---------------------------------------------------------------------------

/** ADF node name -> TipTap node name. Anything absent keeps its name. */
const NODE_TO_PM: Record<string, string> = {
  rule: 'horizontalRule',
};
const NODE_TO_ADF: Record<string, string> = invert(NODE_TO_PM);

/**
 * Node types the editor actually registers: StarterKit + TableKit + Image + TaskList/TaskItem +
 * CodeBlockLowlight + Mention. ProseMirror throws when a document contains anything else, so
 * `toEditorDoc` must never hand it an unregistered type.
 */
export const PM_KNOWN = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak',
  'table', 'tableRow', 'tableHeader', 'tableCell', 'image', 'mention',
]);

/**
 * TipTap nodes whose content expression is inline, so a block child there is invalid. Read off the
 * built schema: `paragraph` and `heading` are both `inline*`.
 */
const PM_INLINE_CONTENT = new Set(['paragraph', 'heading']);

/**
 * TipTap nodes that hold blocks, so an inline child there must be wrapped.
 *
 * `taskItem` and `listItem` are `paragraph block*` in TipTap while their ADF counterparts
 * (`taskItem`, `decisionItem`) are inline-only, so a 1:1 copy gives an invalid `taskItem > text`
 * (cost: see `mapChildren`). `doc` is here because `image` is inline in this editor, so a top-level
 * `mediaSingle` lands inline at a block position. The list wrappers hold only their own item type.
 */
const PM_BLOCK_CONTENT = new Set([
  'doc', 'blockquote', 'listItem', 'taskItem', 'tableCell', 'tableHeader',
]);

/** TipTap nodes in the `inline` group. `image` is one because markdown's image is inline. */
const PM_INLINE = new Set(['text', 'hardBreak', 'mention', 'image']);

/**
 * Container-ish ADF nodes with no TipTap equivalent, mapped to the nearest registered node.
 *
 * The realistic trigger is `expand`: the converter turns any line beginning with `+++` into one (a
 * unified-diff header outside a fence), and ProseMirror refuses to load it. The degrade is one-way
 * and silent. Measured against `+++ Notes\n...\n+++`: the window draws a blockquote and the title
 * attribute becomes a first paragraph; the approval sends `> Notes\n> \n> some text inside`; and
 * `+++ Notes\n# A heading\n\nbody\n+++`, approvable as written, shows as
 * `jira/blockquote-child-rejected`. Kept because without it there is no review at all
 * (`EditorBoundary`). Pinned in `core/test/editor.test.ts`.
 */
const PM_FALLBACK: Record<string, string> = {
  expand: 'blockquote',
  nestedExpand: 'blockquote',
  panel: 'blockquote',
  decisionList: 'bulletList',
  decisionItem: 'listItem',
};

/** ADF mark name -> TipTap mark name. `strike` is the same in both, so absent. */
const MARK_TO_PM: Record<string, string> = {
  strong: 'bold',
  em: 'italic',
};
const MARK_TO_ADF: Record<string, string> = invert(MARK_TO_PM);

/**
 * The TipTap spelling of an ADF mark name. For `surface/src/Editor.tsx`, which derives the `code`
 * mark's `excludes` from ADF-spelled `CODE_MARK_COMBINES_WITH` against TipTap-spelled
 * `TOOLBAR_MARKS` (they differ for `strong`/`em`).
 */
export function pmMarkName(adfMark: string): string {
  return MARK_TO_PM[adfMark] ?? adfMark;
}

function invert(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
}

export interface PmNode {
  type: string;
  content?: PmNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// ADF -> ProseMirror
// ---------------------------------------------------------------------------

export function adfToProseMirror(adf: AdfDocument | AdfNode): PmNode {
  const out = mapNodeToPm(adf as AdfNode) as PmNode;
  // TipTap requires at least one block in the doc.
  if (out.type === 'doc' && (!out.content || out.content.length === 0)) {
    out.content = [{ type: 'paragraph' }];
  }
  return out;
}

/**
 * Map a node's children, flattening the media cases and satisfying the parent's content model.
 *
 * The result must be valid under the editor's schema. The window loads with
 * `enableContentCheck: true`, so an invalid document throws into `EditorBoundary` (reject-only).
 * Without the check it loads and then throws out of `DOMObserver.flush()`, which has no try/catch,
 * on the first transform near the node: no transaction, no `edited` badge, and Approve sends the
 * body without the change. With `taskItem > text`, clicking a checkbox ticks it, logs
 * `Uncaught RangeError: Invalid content for node type taskItem`, and sends the task unchecked.
 */
function mapChildren(node: AdfNode, pmType: string): PmNode[] {
  const out: PmNode[] = [];
  for (const child of node.content ?? []) {
    const mapped = mapNodeToPm(child, node.type);
    if (Array.isArray(mapped)) out.push(...mapped);
    else out.push(mapped);
  }
  // A checklist item's text is its first paragraph, so one is supplied when missing: TipTap's
  // `paragraph block*` refuses a non-paragraph first child or no child (a bare `- [ ]` is
  // `taskItem > []` for every destination but Jira), and `- [x]` over an indented block would
  // otherwise make that block the item's text.
  if (pmType === 'taskItem' && (out.length === 0 || !PM_INLINE.has(out[0].type))) {
    return [{ type: 'paragraph' }, ...blockify(out)];
  }
  if (PM_BLOCK_CONTENT.has(pmType)) return blockify(out);
  if (PM_INLINE_CONTENT.has(pmType)) return inlinify(out);
  if (pmType === 'taskList') return foldNestedTaskLists(out);
  return out;
}

/**
 * ADF nests a checklist as a sibling of its item (`taskList > [taskItem, taskList]`, see
 * `TASK_LIST_CHILDREN`); TipTap nests through the item (`taskItem > [paragraph, taskList]`). Each
 * nested list joins the item before it; one with no item before it has its items joined to the
 * parent list: nesting lost, words kept. The inverse is `liftNestedTaskLists`.
 */
function foldNestedTaskLists(children: PmNode[]): PmNode[] {
  if (!children.some((c) => c.type === 'taskList')) return children;
  const out: PmNode[] = [];
  for (const child of children) {
    const prev = out[out.length - 1];
    if (child.type !== 'taskList') out.push(child);
    else if (prev?.type === 'taskItem') prev.content = [...(prev.content ?? []), child];
    else out.push(...(child.content ?? []));
  }
  return out;
}

/**
 * Unwrap a block child that has landed inside an inline-only parent, keeping every word. An
 * unrecognised node becomes a `paragraph`, so an unmapped inline node (`inlineCard`, `status`)
 * inside a paragraph would otherwise give an invalid `paragraph > paragraph`.
 */
function inlinify(children: PmNode[]): PmNode[] {
  if (!children.some((c) => !PM_INLINE.has(c.type))) return children;
  const out: PmNode[] = [];
  for (const child of children) {
    if (PM_INLINE.has(child.type)) out.push(child);
    else out.push(...inlinify(child.content ?? []));
  }
  return out;
}

/**
 * Wrap runs of inline nodes in paragraphs, for a parent that holds blocks: `taskItem > ["x"]` ->
 * `taskItem > paragraph > ["x"]`, `doc > image` -> `doc > paragraph > image`. One paragraph per run,
 * so `taskItem > [text, image]` keeps the image in its sentence.
 */
function blockify(children: PmNode[]): PmNode[] {
  if (!children.some((c) => PM_INLINE.has(c.type))) return children;
  const out: PmNode[] = [];
  let run: PmNode[] = [];
  const flush = () => {
    if (run.length) out.push({ type: 'paragraph', content: run });
    run = [];
  };
  for (const child of children) {
    if (PM_INLINE.has(child.type)) run.push(child);
    else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}

function mapNodeToPm(node: AdfNode, adfParentType?: string): PmNode | PmNode[] {
  // TipTap's `image` is inline (markdown's image is), so the ADF position decides the wrapper:
  //  - where ADF allows block media (`doc`, `listItem`, `blockquote`, a table cell) it is a block
  //    and gets one paragraph per group, so two consecutive `mediaSingle`s stay two blocks rather
  //    than `blockify`'s one paragraph holding two images;
  //  - inside an inline-only container it can only be an inline markdown image, and stays in place,
  //    as the markdown destinations render it. For Jira it was hoisted before this runs.
  if (node.type === 'mediaSingle' || node.type === 'mediaGroup') {
    const images = (node.content ?? []).filter((c) => c.type === 'media').map(mediaToImage);
    if (adfParentType !== undefined && !INLINE_ONLY.has(adfParentType)) {
      return { type: 'paragraph', content: images };
    }
    return images.length === 1 ? images[0]! : images;
  }
  if (node.type === 'media') return mediaToImage(node);

  const mapped = NODE_TO_PM[node.type] ?? node.type;
  const pmType = PM_KNOWN.has(mapped) ? mapped : (PM_FALLBACK[mapped] ?? 'paragraph');
  const pm: PmNode = { type: pmType };

  const attrs = attrsToPm(node);
  if (attrs) pm.attrs = attrs;

  if (typeof node.text === 'string') pm.text = node.text;

  if (node.marks?.length) {
    /*
     * At most one mark of each type, keeping the first. ProseMirror refuses two ("Invalid
     * collection of marks for node text: link,link") and ADF does not. The converter emits one per
     * type (`*a *b* c*` goes through `addMark`; `[https://x.com](https://x.com)`'s text is not
     * autolinked), but nothing else guarantees it. A duplicate in the editor throws into
     * `EditorBoundary`; with `enableContentCheck` off the document is silently replaced by an empty
     * one. The ADF side is left alone: probed, Jira accepts the duplicate (201) and normalises it.
     */
    const seen = new Set<string>();
    pm.marks = node.marks
      .map((m) => ({
        type: MARK_TO_PM[m.type] ?? m.type,
        ...(m.attrs ? { attrs: { ...m.attrs } } : {}),
      }))
      .filter((m) => !seen.has(m.type) && seen.add(m.type));
  }

  if (node.content) pm.content = mapChildren(node, pmType);

  // A degraded container's attributes (an expand's `title`, a panel's `panelType`) have nowhere to
  // live on the node it became: drop them, but keep a title as a first paragraph.
  if (pmType !== mapped) {
    delete pm.attrs;
    const title = node.attrs?.title;
    if (typeof title === 'string' && title) {
      pm.content = [
        { type: 'paragraph', content: [{ type: 'text', text: title }] },
        ...(pm.content ?? []),
      ];
    }
  }

  return pm;
}

function mediaToImage(media: AdfNode): PmNode {
  const a = media.attrs ?? {};
  const attrs: Record<string, unknown> = {};
  // External media carries its URL inline; file media carries an id we cannot resolve here.
  if (typeof a.url === 'string') attrs.src = a.url;
  else if (typeof a.id === 'string') attrs.src = `jira-media:${a.id}`;
  if (typeof a.alt === 'string' && a.alt) attrs.alt = a.alt;
  return { type: 'image', attrs };
}

function attrsToPm(node: AdfNode): Record<string, unknown> | undefined {
  const a = node.attrs;
  if (!a) return undefined;
  const out: Record<string, unknown> = { ...a };

  switch (node.type) {
    case 'taskItem':
      // ADF: state 'TODO' | 'DONE'.  TipTap: checked boolean.
      out.checked = a.state === 'DONE';
      delete out.state;
      break;
    case 'orderedList':
      // ADF calls the first number `order`; TipTap calls it `start`.
      if (a.order !== undefined) {
        out.start = a.order;
        delete out.order;
      }
      break;
    case 'mention':
      // ADF: { id, text }.  TipTap: { id, label }.
      if (a.text !== undefined) {
        out.label = String(a.text).replace(/^@/, '');
        delete out.text;
      }
      break;
  }

  // localId is an ADF bookkeeping field with no TipTap equivalent; drop empties.
  if (out.localId === '') delete out.localId;

  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// ProseMirror -> ADF
// ---------------------------------------------------------------------------

export function proseMirrorToAdf(pm: PmNode, options: { inlineMedia?: boolean } = {}): AdfDocument {
  const doc = mapNodeToAdf(pm);
  const adf: AdfDocument = { version: 1, type: 'doc', content: doc.content ?? [] };
  /*
   * `inlineMedia` leaves media where the editor had it, the out half of
   * `MarkdownToAdfOptions.inlineMedia`; otherwise `hoistMedia` would re-split the reviewer's
   * `paragraph > [text, image, text]`. Off by default, so Jira hoists: there a `mediaSingle` in an
   * inline container is a 400 that loses the whole comment.
   */
  return options.inlineMedia ? adf : hoistMedia(adf);
}

/**
 * ADF requires `localId` on these and TipTap has no attribute to carry it. Defaulted in
 * `mapNodeToAdf`, not `attrsToAdf`: a taskList with no other attributes reaches there with none.
 */
const NEEDS_LOCAL_ID = new Set(['taskList', 'taskItem']);

function mapNodeToAdf(node: PmNode): AdfNode {
  if (node.type === 'image') return imageToMediaSingle(node);

  const adf: AdfNode = { type: NODE_TO_ADF[node.type] ?? node.type };

  const attrs = attrsToAdf(node);
  if (attrs) adf.attrs = attrs;
  if (NEEDS_LOCAL_ID.has(adf.type)) adf.attrs = { localId: '', ...adf.attrs };

  if (typeof node.text === 'string') adf.text = node.text;

  if (node.marks?.length) {
    adf.marks = node.marks.map((m) => ({
      type: MARK_TO_ADF[m.type] ?? m.type,
      ...(m.attrs ? { attrs: { ...m.attrs } } : {}),
    })) as AdfMark[];
  }

  if (node.content) {
    const kids = node.content.map(mapNodeToAdf);
    // The inverse of `blockify`: the paragraph TipTap requires in an inline-only ADF container comes
    // off, or `hoistMedia`, which looks among a task item's own children, misses a `mediaSingle`
    // buried in it and Jira answers 400. Only `paragraph` is unwrapped: a `mediaSingle` must survive
    // as the block `hoistMedia` bubbles, and other block children are left for the profile's checker.
    // For a `taskItem` only the leading paragraph (its text): unwrapping all would glue `- [ ] a`
    // and the paragraph under it into `- [ ] ab`, with no warning.
    adf.content = !INLINE_ONLY.has(adf.type)
      ? kids
      : adf.type === 'taskItem' && kids[0]?.type === 'paragraph'
        ? [...unwrapParagraphs(kids.slice(0, 1)), ...kids.slice(1)]
        : unwrapParagraphs(kids);
    // A checklist nested under a checklist item goes back to being its sibling, the spelling Jira
    // accepts. A bullet or numbered list under a task item stays: it has no ADF spelling (400,
    // probed), and the markdown writer indents it beneath the item.
    if (adf.type === 'taskList') adf.content = liftNestedTaskLists(adf.content);
  }

  return adf;
}

/**
 * The inverse of `foldNestedTaskLists`: `taskItem > [..., taskList]` -> `[taskItem, taskList]`.
 *
 * Only a trailing run of nested checklists is lifted. `- [ ] a` / `  - [ ] d` / `  - e` holds
 * `taskItem > [paragraph, taskList(d), bulletList(e)]`; lifting every `taskList` would write
 * `- [ ] a` / `  - e` / `  - [ ] d`, d and e swapped, with no warning. A checklist that is not
 * trailing stays put. The shape arrives only where ADF is an intermediate for markdown (Jira's
 * `listItemBlocks: 'adf'` never mixes both kinds in an item) or from a reviewer's edit, which
 * Jira's profile checker reports.
 */
function liftNestedTaskLists(children: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const child of children) {
    if (child.type !== 'taskItem' || !child.content?.some((c) => c.type === 'taskList')) {
      out.push(child);
      continue;
    }
    // Only the checklists after the last non-`taskList` child can move without crossing a sibling.
    const content = child.content;
    let split = content.length;
    while (split > 0 && content[split - 1].type === 'taskList') split -= 1;
    if (split === content.length) {
      out.push(child);
      continue;
    }
    out.push({ ...child, content: content.slice(0, split) }, ...content.slice(split));
  }
  return out;
}

/** Replace every `paragraph` child with its own content, recursively. See `mapNodeToAdf`. */
function unwrapParagraphs(children: AdfNode[]): AdfNode[] {
  if (!children.some((c) => c.type === 'paragraph')) return children;
  const out: AdfNode[] = [];
  for (const child of children) {
    if (child.type === 'paragraph') out.push(...unwrapParagraphs(child.content ?? []));
    else out.push(child);
  }
  return out;
}

function imageToMediaSingle(node: PmNode): AdfNode {
  const a = node.attrs ?? {};
  const src = typeof a.src === 'string' ? a.src : '';
  const alt = typeof a.alt === 'string' ? a.alt : '';
  const isJiraMedia = src.startsWith('jira-media:');
  return {
    type: 'mediaSingle',
    attrs: { layout: 'center' },
    content: [
      {
        type: 'media',
        attrs: isJiraMedia
          ? { type: 'file', id: src.slice('jira-media:'.length), ...(alt ? { alt } : {}) }
          : { type: 'external', url: src, alt: alt || 'image' },
      },
    ],
  };
}

function attrsToAdf(node: PmNode): Record<string, unknown> | undefined {
  const a = node.attrs;
  if (!a) return undefined;
  const out: Record<string, unknown> = { ...a };

  switch (node.type) {
    case 'taskItem':
      out.state = a.checked ? 'DONE' : 'TODO';
      delete out.checked;
      break;
    case 'orderedList':
      if (a.start !== undefined) {
        out.order = a.start;
        delete out.start;
      }
      break;
    case 'mention':
      if (a.label !== undefined) {
        out.text = `@${String(a.label).replace(/^@/, '')}`;
        delete out.label;
      }
      break;
  }

  // TipTap emits explicit nulls for unset attributes; ADF should simply omit them.
  for (const [k, v] of Object.entries(out)) if (v === null) delete out[k];

  return Object.keys(out).length > 0 ? out : undefined;
}
