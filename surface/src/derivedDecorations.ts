/**
 * An editor extension whose decorations are a pure function of the document.
 *
 * Shared by `mentionPills.ts` (a mention token drawn as a pill) and `linkTarget.tsx` (a link's href
 * as its hover title). Both decorate without changing a character and are recomputed from the
 * document, not mapped through transactions: a `>` typed into the middle of a token would leave a
 * mapped decoration sitting on it (`mentionPills.ts` has the longer argument).
 *
 * Memoised on document identity: `props.decorations` runs on every state update, selection-only
 * ones included, so an arrow key or a drag would rebuild an identical set. Measured on the mention
 * pills: 9.9µs on a typical draft, 115µs on a mark-heavy one, plus the `DecorationSet.eq`
 * prosemirror then pays; returning the same instance short-circuits that. The document is held in
 * plugin state (released with the plugin) and compared by identity, not `tr.docChanged` alone.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { Node as PmDocNode } from '@tiptap/pm/model';
import { DecorationSet, type Decoration } from '@tiptap/pm/view';

interface Derived {
  doc: PmDocNode;
  set: DecorationSet;
}

export function derivedDecorations(name: string, compute: (state: EditorState) => Decoration[]) {
  const key = new PluginKey<Derived>(name);
  const build = (state: EditorState): Derived => ({
    doc: state.doc,
    set: DecorationSet.create(state.doc, compute(state)),
  });
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [
        new Plugin<Derived>({
          key,
          state: {
            init: (_config, state) => build(state),
            apply: (tr, value, _old, state) => (tr.docChanged || value.doc !== tr.doc ? build(state) : value),
          },
          props: {
            decorations: (state) => key.getState(state)?.set ?? DecorationSet.empty,
          },
        }),
      ];
    },
  });
}
