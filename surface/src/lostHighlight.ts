/**
 * Point at the node a warning is about, in the editor, without touching the document.
 *
 * `body/structure-lost` is the only blocking warning that offers no repair: the reviewer built a
 * shape markdown has no spelling for (a quote inside a checklist item), and only they know what they
 * meant. So the window says where.
 *
 * It is also one of only three warnings that can be pointed at (with `body/mark-lost` and
 * `body/text-changed`, which carry `editorPath`). `lostInMarkdown` walks the editor's own
 * document; Jira's nesting rules walk the converted ADF tree, whose paths do not index this
 * document, and the bare-URL and image rules scan markdown text and have no path. A highlight on the
 * wrong node sends a reviewer to edit innocent prose, so those get none.
 *
 * `core` reports child indices (`LostNode.path`), not a position: computing a ProseMirror position
 * from JSON would re-implement node sizing against a schema `core` lacks. They are resolved here
 * against the real document.
 *
 * A decoration, not `setNodeSelection`: a selection arms the next keystroke to replace the outlined
 * node. A decoration draws only; no transaction changes the document and `edited` does not move.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmDocNode } from '@tiptap/pm/model';

/** How long the outline stays before fading itself out. */
export const HIGHLIGHT_MS = 4000;

const KEY = new PluginKey<DecorationSet>('draftgate-lost-highlight');

/** The meta a transaction carries to set or clear the outline. */
interface HighlightMeta {
  /** `null` clears it. */
  range: { from: number; to: number } | null;
}

/**
 * Resolve child indices against a real document, returning a range that can be drawn.
 *
 * Returns `null` (callers do not highlight) when the path runs off the tree: it comes from a render
 * of a document the reviewer may have typed past since, so that is an ordinary outcome.
 *
 * An inline leaf is widened to the block holding it. A draft with a `hardBreak` inside a paragraph
 * can be blocked and the path resolves to the `hardBreak`, which renders as a `<br>` with no box:
 * `outline` and `background` draw nothing, so "Show me" would show an unchanged screen. The rule is
 * structural (inline and leaf), not a list of type names, and the block still contains the lost
 * node. Other inline leaves (`image`, `mention`) widen too, for one rule instead of two. `doc` is
 * never the widened-to node (the guard on `parent !== doc`).
 */
export function rangeOfPath(doc: PmDocNode, path: number[]): { from: number; to: number } | null {
  if (path.length === 0) return null;
  let node = doc;
  /*
   * Where the current node's children begin. Zero for the document: every other container opens
   * with a token, but `doc` is the root, so its first child starts at 0. Adding the token at the
   * root too puts the range one position early and `nodeAt` returns the paragraph before the
   * blockquote. The test asks `nodeAt` what it landed on rather than comparing a number.
   */
  let contentStart = 0;
  let nodeStart = 0;
  // The node one level up and where it begins, so an inline leaf can be widened to a drawable box.
  let parent: PmDocNode | null = null;
  let parentStart = 0;
  for (const index of path) {
    if (index < 0 || index >= node.childCount) return null;
    // Past every earlier sibling, each of which occupies its whole `nodeSize`.
    let pos = contentStart;
    for (let i = 0; i < index; i++) pos += node.child(i).nodeSize;
    parent = node;
    parentStart = nodeStart;
    nodeStart = pos;
    node = node.child(index);
    contentStart = nodeStart + 1;
  }
  // A `<br>` has nothing to outline, so the block holding it is outlined instead.
  if (node.isInline && node.isLeaf && parent !== null && parent !== doc) {
    return { from: parentStart, to: parentStart + parent.nodeSize };
  }
  return { from: nodeStart, to: nodeStart + node.nodeSize };
}

/**
 * The extension the editor registers.
 *
 * Its state is a `DecorationSet` only. `DecorationSet.map` moves the outline with the reviewer's
 * edits; a change that deletes the node removes the decoration.
 */
export const LostHighlight = Extension.create({
  name: 'draftgateLostHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: KEY,
        state: {
          init: () => DecorationSet.empty,
          apply(tr: Transaction, value: DecorationSet, _old, state: EditorState) {
            const meta = tr.getMeta(KEY) as HighlightMeta | undefined;
            if (meta) {
              return meta.range === null
                ? DecorationSet.empty
                : DecorationSet.create(state.doc, [
                    Decoration.node(meta.range.from, meta.range.to, {
                      class: 'dg-lost-highlight',
                    }),
                  ]);
            }
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => KEY.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

/** Set the outline on a resolved range, or clear it with `null`. */
export function setHighlight(
  view: { state: EditorState; dispatch(tr: Transaction): void },
  range: { from: number; to: number } | null
): void {
  view.dispatch(view.state.tr.setMeta(KEY, { range } satisfies HighlightMeta));
}
