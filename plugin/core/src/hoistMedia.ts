/**
 * Move `mediaSingle` / `mediaGroup` to a position ADF allows. Markdown and TipTap images are inline,
 * ADF media is block-level, and an image in a paragraph, task item or heading gets a generic 400
 * from the JSM comment endpoint that loses the whole comment.
 *
 * - **Split** a paragraph inside a block container: `before [img] after` becomes paragraph / media /
 *   paragraph, in order.
 * - **Bubble** out of a container with no legal media position (`taskItem`, `heading`) to the
 *   nearest `ACCEPTS_BLOCKS` ancestor (past `taskList`), emitted right after the container it left;
 *   see `lift`.
 *
 * The schema sets live in `adfSchema.ts`, shared with the checker: if the two disagree, the fixer
 * produces shapes the checker approves and Jira rejects.
 */

import {
  ACCEPTS_BLOCKS,
  BLOCK_MEDIA,
  EMPTY_FORBIDDEN,
  INLINE_ONLY,
  NO_MEDIA_ANYWHERE,
} from './adfSchema';
import type { AdfDocument, AdfNode } from './adf/types';

export function hoistMedia<T extends AdfDocument | AdfNode>(doc: T): T {
  const { node } = lift(doc as AdfNode);
  // ADF requires at least one block in a doc, and the converter is careful to emit an empty
  // paragraph for empty input. This pass must not filter that away.
  if (node.type === 'doc' && (node.content?.length ?? 0) === 0) {
    return { ...node, content: [{ type: 'paragraph', content: [] }] } as unknown as T;
  }
  return node as T;
}

/**
 * Returns the rewritten node plus media that must be emitted as a sibling further up.
 *
 * Bubbled media goes right after the child it came out of, not appended after the loop: appended,
 * `- [ ] task ![shot](url)` followed by a paragraph, a heading and a paragraph would send the image
 * as the last node of the document, with `blocked: false` and only an `info` warning. Probed against
 * Jira: `doc[paragraph, mediaSingle, heading, paragraph]` returns **201** and reads back in that
 * order.
 */
function lift(node: AdfNode): { node: AdfNode; bubbled: AdfNode[] } {
  if (!node.content) return { node, bubbled: [] };

  // Each child with its own bubbled media, so position is recoverable.
  const results = node.content.map(lift);

  // No legal position for media here, so it leaves entirely, in the order it appeared.
  if (NO_MEDIA_ANYWHERE.has(node.type)) {
    const keep: AdfNode[] = [];
    const bubbled: AdfNode[] = [];
    for (const r of results) {
      bubbled.push(...r.bubbled);
      if (BLOCK_MEDIA.has(r.node.type)) bubbled.push(r.node);
      else keep.push(r.node);
    }
    return { node: { ...node, content: keep }, bubbled };
  }

  if (ACCEPTS_BLOCKS.has(node.type)) {
    const out: AdfNode[] = [];
    for (const r of results) {
      const k = r.node;
      if (k.type === 'paragraph' && k.content?.some((c) => BLOCK_MEDIA.has(c.type))) {
        out.push(...splitParagraph(k));
      } else if (keepNode(k)) {
        out.push(k);
      }
      // Immediately after the child it came out of.
      out.push(...r.bubbled);
    }
    return { node: { ...node, content: out }, bubbled: [] };
  }

  // A paragraph keeps its media for its parent to split. A list wrapper accepts only its own item
  // type, so anything from below keeps rising and lands directly after the wrapper.
  const kids: AdfNode[] = [];
  const bubbled: AdfNode[] = [];
  for (const r of results) {
    if (keepNode(r.node)) kids.push(r.node);
    bubbled.push(...r.bubbled);
  }
  return { node: { ...node, content: liftOrphans(node, kids) }, bubbled };
}

/**
 * The orphaned task lists this fixer makes itself. `- [ ] ![i](u)` / `  - [ ] d` converts to
 * `taskList > [taskItem(media only), taskList[taskItem d]]`; once the media bubbles out and
 * `keepNode` drops the emptied item, the nested list is the first child with no item to belong to.
 * Jira answers 201 (probe at `orphanedTaskLists`). Its items are spliced in place: nesting lost,
 * every word and checkbox kept, matching what `foldNestedTaskLists` shows the reviewer.
 * `jira/task-item-media-only` already discloses the dropped checkbox.
 */
function liftOrphans(parent: AdfNode, kids: AdfNode[]): AdfNode[] {
  if (parent.type !== 'taskList') return kids;
  const out: AdfNode[] = [];
  let anchored = false;
  for (const kid of kids) {
    if (kid.type === 'taskItem') anchored = true;
    if (!anchored && kid.type === 'taskList') out.push(...(kid.content ?? []));
    else out.push(kid);
  }
  return out;
}

/** paragraph[text, media, text] -> paragraph[text], media, paragraph[text], in that order. */
function splitParagraph(p: AdfNode): AdfNode[] {
  const out: AdfNode[] = [];
  let inline: AdfNode[] = [];
  for (const child of p.content ?? []) {
    if (BLOCK_MEDIA.has(child.type)) {
      if (inline.length) out.push({ ...p, content: inline });
      inline = [];
      out.push(child);
    } else {
      inline.push(child);
    }
  }
  // Trailing inline content keeps its own paragraph, or the text after an inline image is lost.
  if (inline.length) out.push({ ...p, content: inline });
  return out;
}

/**
 * Drop a container this pass emptied, but never a paragraph: an empty `doc > paragraph` is how ADF
 * represents an empty document. Two kinds of emptying:
 *
 *  - an INLINE_ONLY container whose only child was media (`- [ ] ![img](url)` -> empty `taskItem`);
 *  - the wrapper that item left behind: `taskList{content:[]}` is a 400 too.
 *
 * Dropped rather than given a placeholder `taskItem{content:[]}`, which is unprobed. The checkbox is
 * lost, including a `- [x]`'s checked state.
 */
function keepNode(n: AdfNode): boolean {
  if (n.type === 'paragraph') return true;
  const empty = (n.content?.length ?? 0) === 0;
  if (empty && EMPTY_FORBIDDEN.has(n.type)) return false;
  return !INLINE_ONLY.has(n.type) || !empty;
}
