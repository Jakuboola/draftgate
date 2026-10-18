/**
 * ADF structural knowledge, in one place.
 *
 * The fixer (`hoistMedia.ts`), the checker (`profiles/jira.ts`) and the converter read these sets.
 * If the fixer and the checker disagree, the fixer can produce a shape the checker approves and the
 * JSM comment endpoint answers a generic 400 that loses the whole comment.
 *
 * Every set is probed against a real Jira instance or quoted from Atlassian's own tool
 * documentation, and changes only when one of those does. Each set's comment states its evidence.
 */

import type { AdfDocument, AdfNode } from './adf/types';

/** Block-level media. Inline in markdown and in ProseMirror, block-level in ADF. */
export const BLOCK_MEDIA = new Set(['mediaSingle', 'mediaGroup']);

/**
 * Containers whose content must be inline only.
 *
 * Source: the Atlassian MCP `createConfluenceFooterComment` tool description -- "task/decision
 * items, headings, and captions are inline-only" -- plus `paragraph`, which ADF has always
 * restricted to inline content. Verified: `heading > [text, mediaSingle]` returns 400.
 */
export const INLINE_ONLY = new Set(['paragraph', 'taskItem', 'decisionItem', 'heading', 'caption']);

/**
 * Inline-only containers with no legal position for media at all.
 *
 * `paragraph` is absent: it can be split in place around the media. These cannot, because their
 * parent accepts only their own item type, so media has to leave entirely. Verified:
 * `taskItem > [text, mediaSingle]` is 400, while `taskList` followed by a sibling `mediaSingle` is
 * 201.
 */
export const NO_MEDIA_ANYWHERE = new Set(['taskItem', 'decisionItem', 'heading', 'caption']);

/**
 * What a `taskList` may hold: its own items, and another `taskList` -- which is how ADF spells a
 * nested checklist (a sibling after the item it belongs to, not a child of it).
 *
 * PROBED against a scratch issue, each 201 deleted:
 *
 *   listItem > taskList                              201   (bullet and ordered parents, with and
 *                                                           without a paragraph before it)
 *   listItem > [paragraph, taskList > [taskItem, taskList > taskItem]]   201   (two levels)
 *   taskList > [taskItem, bulletList]                400 INVALID_INPUT
 *   taskList > [taskItem, orderedList]               400 INVALID_INPUT
 *   taskList > [bulletList, taskItem]                400 INVALID_INPUT
 *
 * So a checklist nests under a bullet and under a checklist, and a bullet never nests under a
 * checklist. The converter (`markdownToAdf.ts`, `listToAdf`) emits the first two shapes and
 * un-nests the third; the Jira profile checks a hand-built tree against this set
 * (`jira/task-list-child-rejected`). Flattening every nested checklist would drop a nested `- [ ]`'s
 * checkbox under a bullet and retype a nested bullet under a checklist into a to-do.
 */
export const TASK_LIST_CHILDREN = new Set(['taskItem', 'taskList']);

/**
 * The three list nodes, which nest and which the writer spells by indentation -- so two of one type
 * side by side in an item are one list in markdown. The reader (`markdownToAdf.ts`, `appendToItem`)
 * and the writer (`adfToMarkdown.ts`) must agree on which they are.
 */
export const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * What a `listItem` may not hold -- the fixer's and the checker's one answer.
 *
 * PROBED against a scratch issue, each 201 deleted and read back 404:
 *
 *   listItem > heading | table | panel | expand                   400 INVALID_INPUT
 *   listItem > [paragraph, blockquote]     (bullet, ordered, nested)  400 INVALID_INPUT
 *   listItem > [paragraph, blockquote > codeBlock | bulletList]   400 INVALID_INPUT
 *   listItem > [paragraph, rule]                                  400 INVALID_INPUT
 *
 * and what it may: `[paragraph, codeBlock]`, `[paragraph, codeBlock, paragraph]`, `[paragraph,
 * codeBlock, codeBlock]`, `[paragraph, paragraph]` and `[paragraph, bulletList, paragraph]`, all
 * 201 under a bullet, under a numbered list and one level nested, plus the probes
 * `TASK_LIST_CHILDREN` and `ACCEPTS_BLOCKS` record. A heading, quote, rule or table the converter
 * reads inside an item is therefore moved out for Jira (`markdownToAdf.ts`, `listToAdf`), and
 * `jira/list-item-block-child` blocks a hand-built tree that has one. A quote is accepted at the top
 * level and refused in a list item.
 */
export const LIST_ITEM_FORBIDDEN = new Set(['heading', 'table', 'panel', 'expand', 'blockquote', 'rule']);

/**
 * Containers ADF requires to hold at least one child: list wrappers whose content model is
 * `<item>+`.
 *
 * PROBED, all four, against a scratch issue. Each is a 400 INVALID_INPUT from the JSM comment
 * endpoint, which loses the whole comment:
 *
 *   doc > [paragraph, taskList{content: []}]        400 INVALID_INPUT
 *   doc > [paragraph, decisionList{content: []}]    400 INVALID_INPUT
 *   doc > [paragraph, bulletList{content: []}]      400 INVALID_INPUT
 *   doc > [paragraph, orderedList{content: []}]     400 INVALID_INPUT
 *
 * with the same three lists holding one item accepted (201) as controls. The shape a media fixer
 * leaves by dropping an emptied item but keeping the list, `doc > [taskList{content: []},
 * mediaSingle]` (`- [ ] ![img](url)`), is 400 too.
 *
 * The boundary is the list, not the item: `taskList > taskItem{content: []}` is 201, probed in the
 * same run, so `taskItem`, `decisionItem` and `listItem` never belong here
 * (`core/test/hoistMedia.test.ts` pins both halves). `paragraph` stays absent: `doc > [paragraph []]`
 * is how ADF spells an empty document. Only `taskList` and `decisionList` are reachable from
 * `hoistMedia`; the set states the content model, not that reachability.
 */
export const EMPTY_FORBIDDEN = new Set(['taskList', 'decisionList', 'bulletList', 'orderedList']);

/**
 * Containers that accept arbitrary block children: an allow-list of legal destinations, so a media
 * fixer built on it cannot move media into a shape nobody listed as broken.
 *
 * `taskList`, `bulletList` and `orderedList` are absent: each accepts only its own item type, so
 * media must bubble past them. Verified: `listItem > [paragraph, mediaSingle]` is 201.
 */
export const ACCEPTS_BLOCKS = new Set([
  'doc',
  'blockquote',
  'listItem',
  'tableCell',
  'tableHeader',
  'panel',
  'expand',
  'nestedExpand',
]);

/**
 * Nodes that put something on screen without carrying text of their own: "would a reader see
 * anything at all?", the question behind Jira's empty-comment 400. A copy that counted `mention`
 * but not `emoji`, `date`, `status`, `inlineCard` or `mediaInline` would refuse a comment a reader
 * sees. `media` covers both `mediaSingle` and `mediaGroup`, since the walk reaches the inner node.
 *
 * `rule` is PROBED: `doc > [rule]` on a scratch issue is 201, and the divider is visible. `media`
 * and `mention` also come out of the converter; the rest are atoms it never emits from markdown,
 * listed because they render. None of the others is individually probed.
 */
export const VISIBLE_ATOMS = new Set([
  'media',
  'rule',
  'mention',
  'emoji',
  'date',
  'status',
  'inlineCard',
  'blockCard',
  'mediaInline',
]);

/** Inline node types, i.e. what an INLINE_ONLY container may legally contain. */
export const INLINE_TYPES = new Set([
  'text',
  'mention',
  'emoji',
  'date',
  'status',
  'hardBreak',
  'inlineCard',
  'mediaInline',
]);

/**
 * What the JSM comment endpoint accepts inside a `blockquote`.
 *
 * Probed against a scratch Jira site in both directions: all six together return 201, while
 * `heading`, `table`, `rule`, `taskList`, `panel`, `expand` and a nested `blockquote` each return
 * 400, which loses the whole comment. `adf/sanitizeBlockquote.ts` holds the same list for its own
 * coercion pass; this is the copy the profiles read.
 */
export const JSM_BLOCKQUOTE_ALLOWED = new Set([
  'paragraph',
  'bulletList',
  'orderedList',
  'codeBlock',
  'mediaSingle',
  'mediaGroup',
]);

// ---------------------------------------------------------------------------
// Tree traversal, shared by the source and the tests.
// ---------------------------------------------------------------------------

/**
 * Like `walk`, but the visitor can stop the traversal by returning `true`; returns whether it did,
 * so it works as `some()`. Measured on `hasVisibleContent`, which runs on every keystroke in the
 * review window: 0.109ms -> ~0.000ms on a 20 KB document.
 */
export function walkUntil(
  node: AdfDocument | AdfNode,
  visit: (node: AdfNode) => boolean
): boolean {
  const n = node as AdfNode;
  if (visit(n)) return true;
  for (const child of n.content ?? []) {
    if (walkUntil(child, visit)) return true;
  }
  return false;
}

/**
 * Depth-first walk, passing each node's readable path and its immediate parent. Only the parent:
 * every rule reads no further, and an ancestor array costs O(nodes x depth) copying.
 */
export function walk(
  node: AdfDocument | AdfNode,
  visit: (node: AdfNode, path: string, parent: AdfNode | undefined) => void,
  path = 'doc',
  parent?: AdfNode
): void {
  const n = node as AdfNode;
  visit(n, path, parent);
  n.content?.forEach((child, i) => walk(child, visit, `${path}.content[${i}]`, n));
}

/** Every node matching a predicate, with its path. */
export function collect(
  root: AdfDocument | AdfNode,
  pred: (node: AdfNode) => boolean
): { node: AdfNode; path: string }[] {
  const out: { node: AdfNode; path: string }[] = [];
  walk(root, (n, path) => {
    if (pred(n)) out.push({ node: n, path });
  });
  return out;
}

/** The set of node types present in a tree. */
export function nodeTypes(root: AdfDocument | AdfNode): Set<string> {
  const types = new Set<string>();
  walk(root, (n) => {
    if (n.type) types.add(n.type);
  });
  return types;
}

/** The set of mark types present in a tree. */
export function markTypes(root: AdfDocument | AdfNode): Set<string> {
  const types = new Set<string>();
  walk(root, (n) => {
    for (const m of n.marks ?? []) types.add(m.type);
  });
  return types;
}

/**
 * Media sitting somewhere ADF forbids: inside an inline-only container. The invariant `hoistMedia`
 * maintains, shared so every suite checks the same thing.
 */
export function illegalMediaPlacements(root: AdfDocument | AdfNode): string[] {
  const bad: string[] = [];
  walk(root, (node, path, parent) => {
    if (parent && INLINE_ONLY.has(parent.type) && BLOCK_MEDIA.has(node.type)) bad.push(path);
  });
  return bad;
}

/**
 * Items whose entire content is block media, so the media fixer will drop the item itself.
 *
 * `- [ ] ![img](url)`: `taskItem` is inline-only, so the media bubbles out, the emptied item is
 * dropped, and (per `EMPTY_FORBIDDEN`) an emptied `taskList` goes with it. The image survives; the
 * checkbox, including a `- [x]`'s checked state, does not. No legal position exists for such an
 * item, so this is reported rather than repaired, detected on the raw converter output before the
 * fixer runs.
 */
export function mediaOnlyItems(root: AdfDocument | AdfNode): string[] {
  const found: string[] = [];
  walk(root, (node, path) => {
    if (!NO_MEDIA_ANYWHERE.has(node.type)) return;
    const kids = node.content ?? [];
    if (kids.length > 0 && kids.every((k) => BLOCK_MEDIA.has(k.type))) found.push(path);
  });
  return found;
}

/**
 * Containers left with no children that ADF requires to have some (see `EMPTY_FORBIDDEN`). Like
 * `illegalMediaPlacements`, an invariant `hoistMedia` maintains: a repair that leaves an empty list
 * behind has moved the 400, not removed it.
 */
export function emptyContainers(root: AdfDocument | AdfNode): string[] {
  const bad: string[] = [];
  walk(root, (node, path) => {
    if (EMPTY_FORBIDDEN.has(node.type) && (node.content?.length ?? 0) === 0) bad.push(path);
  });
  return bad;
}

/**
 * A nested `taskList` with no `taskItem` before it to belong to: a shape outside the recorded
 * `TASK_LIST_CHILDREN` (`taskList > [taskItem, taskList]`).
 *
 * Probed against a scratch issue: `doc > taskList > taskList > taskItem` is 201, not 400 (artifact
 * deleted, 204), so this is a fidelity rule, not a delivery one. Jira renders the item indented
 * under nothing, and `foldNestedTaskLists` (`prosemirror.ts`) flattens it in the editor, so preview
 * and destination disagree for surfaces that send `canonical` unaltered.
 *
 * Two producers can reach it; each avoids it where it would emit it and sweeps this detector in its
 * own suite: `listToAdf` meeting a nested checklist after closing one for an un-nested bullet
 * (`- [ ] a` / `  - e` / `  - [ ] d`), and `hoistMedia` dropping a media-only `taskItem` a nested
 * checklist hung under (`- [ ] ![i](u)` / `  - [ ] d`).
 */
export function orphanedTaskLists(root: AdfDocument | AdfNode): string[] {
  const bad: string[] = [];
  walk(root, (node, path) => {
    if (node.type !== 'taskList') return;
    // Everything before the first `taskItem`. A leading run, not "the previous sibling is an item":
    // `taskList > [taskItem, taskList, taskList]` is two nested runs under one item, which the
    // converter emits on purpose (see `liftNestedTaskLists`).
    for (const [i, kid] of (node.content ?? []).entries()) {
      if (kid.type === 'taskItem') return;
      if (kid.type === 'taskList') bad.push(`${path}.content[${i}]`);
    }
  });
  return bad;
}

/**
 * Marks the `code` mark may share a text node with. PROBED against a scratch issue, one comment per
 * pair, every 201 deleted afterwards:
 *
 *   code                    201   stored marks ["code"]
 *   code + link             201   stored marks ["code", "link"]
 *   code + strong           400   INVALID_INPUT
 *   strong + code           400   INVALID_INPUT   (mark ORDER is not the variable)
 *   code + em               400   INVALID_INPUT
 *   code + strike           400   INVALID_INPUT
 *   strong + em             201   the control, so the shape of the document is not what is refused
 *
 * A 400 there loses the whole comment. A set rather than a boolean because `link` is a real
 * exception: a linked code span is `[`x`](url)`, which both the writer and `handleLink` produce.
 */
export const CODE_MARK_COMBINES_WITH = new Set(['link']);
