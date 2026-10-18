/**
 * The reviewer's edits, as a pure function of time applied to the real editor.
 *
 * Remotion renders frames out of order and in several tabs at once, so the editor cannot be typed
 * into as time passes. Every frame instead resets the editor to the draft as it loaded and replays
 * the edits that have happened by `t`, through ProseMirror transactions on the window's own TipTap
 * editor. Each transaction reaches the window's `onUpdate`, so the window's own state (the warnings,
 * whether the draft was edited) follows the edits as it does for a person typing.
 *
 * A selection is drawn as a decoration, not the browser's: the editor is never focused (the window
 * opens unfocused), and an unfocused selection is not painted.
 */
import type { Editor, JSONContent } from '@tiptap/react';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import { GREETING, LAST_LINE_CUT, PADDING, SUFFIX, T } from './script';

interface EditState {
  /** Where the caret is drawn, or null when there is none. */
  caret: number | null;
  /** Whether the reviewer is mid-typing, so the caret does not blink. */
  typing: boolean;
}

const selectionKey = new PluginKey<{ from: number; to: number } | null>('demo-selection');

/** Register the decoration that paints the demo's selection. Once per editor. */
export function installSelection(editor: Editor): void {
  if (selectionKey.getState(editor.state) !== undefined) return;
  editor.registerPlugin(
    new Plugin({
      key: selectionKey,
      state: {
        init: () => null,
        apply: (tr, value) => {
          const meta = tr.getMeta(selectionKey);
          if (meta !== undefined) return meta;
          return tr.docChanged ? null : value;
        },
      },
      props: {
        decorations: (state) => {
          const range = selectionKey.getState(state);
          return range ? DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: 'demo-selection' })]) : null;
        },
      },
    })
  );
}

/** Graphemes, so an emoji is one keystroke and never half a character. */
const graphemes = (s: string) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);

/** A deterministic 0-1 value per index, for uneven keystroke timing. */
const jitter = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** How much of `text` has been typed by `t`, between `start` and `end`, at an uneven human pace. */
function typed(text: string, start: number, end: number, t: number): string {
  const keys = graphemes(text);
  if (t <= start) return '';
  if (t >= end) return text;
  const weights = keys.map((_, i) => 0.55 + jitter(i) * 0.9);
  const total = weights.reduce((a, b) => a + b, 0);
  let at = start;
  let n = 0;
  for (const w of weights) {
    at += ((end - start) * w) / total;
    if (at > t) break;
    n++;
  }
  return keys.slice(0, n).join('');
}

/** The position just inside the start and end of a list item's text. */
function itemText(doc: PmNode, index: number): { from: number; to: number; node: { from: number; to: number } } {
  let listPos = -1;
  doc.forEach((node, offset) => {
    if (listPos < 0 && node.type.name === 'bulletList') listPos = offset;
  });
  if (listPos < 0) throw new Error('the draft has no bullet list');
  const list = doc.nodeAt(listPos)!;
  let found: { from: number; to: number; node: { from: number; to: number } } | null = null;
  list.forEach((item, offset, i) => {
    if (i !== index) return;
    const from = listPos + 1 + offset;
    found = { from: from + 2, to: from + item.nodeSize - 2, node: { from, to: from + item.nodeSize } };
  });
  if (!found) throw new Error(`the draft has no bullet ${index + 1}`);
  return found;
}

/** The last top-level paragraph's text range. */
function lastLine(doc: PmNode): { from: number; to: number } {
  let pos = -1;
  let size = 0;
  doc.forEach((node, offset) => {
    if (node.type.name === 'paragraph') {
      pos = offset;
      size = node.nodeSize;
    }
  });
  return { from: pos + 1, to: pos + size - 1 };
}

/** Points the cursor travels to, in document positions, in the document as it stands at `t`. */
export function anchors(editor: Editor) {
  const doc = editor.state.doc;
  return {
    bulletsStart: () => itemText(doc, PADDING.first).from,
    bulletsEnd: () => itemText(doc, PADDING.last).to,
    firstLineStart: () => 1,
    lastLineStart: () => lastLine(doc).from,
    lastLineCut: () => lastLine(doc).from + LAST_LINE_CUT.length,
    lastLineEnd: () => lastLine(doc).to,
  };
}

/** Put the editor in its state at `t`. */
export function applyEdits(editor: Editor, initial: JSONContent, t: number): EditState {
  editor.commands.setContent(initial, { emitUpdate: true });
  const view = editor.view;
  let caret: number | null = null;
  let typing = false;
  let selection: { from: number; to: number } | null = null;

  // Edit 1: drag across the padding bullets, then delete them.
  if (t >= T.dragStart && t < T.deleteBullets) {
    const doc = editor.state.doc;
    const from = itemText(doc, PADDING.first).from;
    const end = itemText(doc, PADDING.last).to;
    const p = Math.min(1, (t - T.dragStart) / (T.dragEnd - T.dragStart));
    const to = from + Math.round((end - from) * p);
    if (to > from) selection = { from, to };
  }
  if (t >= T.deleteBullets) {
    const doc = editor.state.doc;
    view.dispatch(editor.state.tr.delete(itemText(doc, PADDING.first).node.from, itemText(doc, PADDING.last).node.to));
    if (t < T.toTop) caret = itemText(editor.state.doc, PADDING.first - 1).to;
  }

  // Edit 2: click the first line, Enter, up, type the greeting.
  if (t >= T.clickTop) caret = 1;
  if (t >= T.newLine) {
    const tr = editor.state.tr.insert(0, editor.schema.nodes.paragraph!.create());
    view.dispatch(tr);
    const text = typed(GREETING, T.greetStart, T.greetEnd, t);
    if (text) view.dispatch(editor.state.tr.insertText(text, 1));
    caret = 1 + text.length;
    typing = t >= T.greetStart && t < T.greetEnd + 0.3;
  }

  // Edit 3: select the last line's first word, delete it, click the end, type the rest.
  if (t >= T.toLast) caret = null;
  if (t >= T.selectHasStart && t < T.deleteHas) {
    const line = lastLine(editor.state.doc);
    const p = Math.min(1, (t - T.selectHasStart) / (T.selectHasEnd - T.selectHasStart));
    const to = line.from + Math.round(LAST_LINE_CUT.length * p);
    if (to > line.from) selection = { from: line.from, to };
  }
  if (t >= T.deleteHas) {
    const line = lastLine(editor.state.doc);
    const cut = editor.state.doc.textBetween(line.from, line.from + LAST_LINE_CUT.length);
    if (cut !== LAST_LINE_CUT) throw new Error(`the draft's last line starts "${cut}", not "${LAST_LINE_CUT}" (script.ts)`);
    view.dispatch(editor.state.tr.delete(line.from, line.from + LAST_LINE_CUT.length));
    caret = lastLine(editor.state.doc).from;
  }
  if (t >= T.clickLineEnd) {
    const text = typed(SUFFIX, T.suffixStart, T.suffixEnd, t);
    const end = lastLine(editor.state.doc).to;
    if (text) view.dispatch(editor.state.tr.insertText(text, end));
    caret = end + text.length;
    typing = t >= T.suffixStart && t < T.suffixEnd + 0.3;
  }
  if (t >= T.zoomOut) caret = null;

  // The decoration, and a collapsed real selection where the caret is, so the toolbar's mark state
  // reads from where the reviewer is.
  view.dispatch(editor.state.tr.setMeta(selectionKey, selection));
  if (caret !== null) view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)));
  return { caret, typing };
}
