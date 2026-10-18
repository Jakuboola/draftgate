/**
 * Where a link goes, shown to the reviewer. `[https://id.example.org/reset](https://id-example.evil.test/reset)`
 * loads as the text of your own address with the look-alike in a mark attribute: `openOnClick` is
 * off, TipTap's `title` is null, no sheet draws `attr(href)`. Every destination shows its recipient
 * the real target before opening (probed); the reviewer must see it too. Neither disclosure reflows
 * the draft:
 *
 *  - Caret in a link: a floating bubble under it, `Opens <full href>`, appended to <body> like the
 *    formatting bubble. It follows the caret, not the pointer, so the keyboard gets it, and the probe
 *    and mount test reach it.
 *  - Hover: every link's `title` is its href, as a decoration, so the body sent does not change. The
 *    mark's own `title` is never shown: agent-controlled text over a look-alike is the same lie.
 *
 * The href is shown in full (`deferredImage.ts`'s reason: a truncated host is how a look-alike gets
 * through). `link/text-host-mismatch` points at the dangerous one; this lets the reviewer check any.
 */

import { useCallback } from 'react';
import { useEditorState, type Editor as TiptapEditor } from '@tiptap/react';
import type { EditorState } from '@tiptap/pm/state';
import type { Mark } from '@tiptap/pm/model';
import { Decoration } from '@tiptap/pm/view';
import { derivedDecorations } from './derivedDecorations';
import { GuardedBubbleMenu } from './GuardedBubbleMenu';

/** The href of the link among `marks`, if there is one. */
export function hrefOf(state: EditorState, marks: readonly Mark[]): string | undefined {
  const href = state.schema.marks.link?.isInSet(marks)?.attrs.href;
  return typeof href === 'string' ? href : undefined;
}

/** Every link's text, decorated with `title` = its href. Pure over the state, so testable. */
export function linkTitleDecorations(state: EditorState): Decoration[] {
  const out: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    const href = node.isText ? hrefOf(state, node.marks) : undefined;
    if (href !== undefined) out.push(Decoration.inline(pos, pos + node.nodeSize, { title: href }));
  });
  return out;
}

export const LinkTitles = derivedDecorations('draftgateLinkTitles', linkTitleDecorations);

/** Is any link under the selection? Stops at the first one, so `shouldShow` stays cheap. */
function touchesLink(state: EditorState): boolean {
  const link = state.schema.marks.link;
  const { from, to, empty, $from } = state.selection;
  if (!link) return false;
  return empty ? link.isInSet($from.marks()) !== undefined : state.doc.rangeHasMark(from, to, link);
}

/**
 * Every distinct target the selection touches, in document order: the link under a collapsed caret,
 * or each link a RANGE crosses. Not `getAttributes('link')`, which answers with one href for a
 * selection spanning `[a.com](https://a.com)[b.com](https://evil.test)` -- the disclosure would
 * then hide the very address it exists to show.
 */
export function hrefsInSelection(state: EditorState): string[] {
  if (!touchesLink(state)) return [];
  const { from, to, empty, $from } = state.selection;
  if (empty) return [hrefOf(state, $from.marks())!];
  const out = new Set<string>();
  state.doc.nodesBetween(from, to, (node) => {
    const href = node.isText ? hrefOf(state, node.marks) : undefined;
    if (href !== undefined) out.add(href);
  });
  return [...out];
}

export function LinkTarget({ editor }: { editor: TiptapEditor | null }) {
  // `useEditorState` compares results deeply, so an unchanged list does not re-render the bubble.
  const hrefs = useEditorState({ editor, selector: ({ editor: e }) => (e ? hrefsInSelection(e.state) : []) });
  const shouldShow = useCallback(({ editor: e }: { editor: TiptapEditor }) => touchesLink(e.state), []);

  if (!editor) return null;
  return (
    <GuardedBubbleMenu
      name="linkTarget"
      editor={editor}
      shouldShow={shouldShow}
      // No debounce: a status line has no flicker worth delaying it. A late timer could not leave it
      // behind either way (`GuardedBubbleMenu.tsx`).
      updateDelay={0}
      appendTo={() => document.body}
      // Below the selection, where the formatting bubble (above it) is not. Floating UI may flip it
      // up near the window's foot; `shell.css` then stacks it UNDER the formatting bubble, so the
      // controls stay usable and the target is still one hover away (every link's `title`).
      options={{ placement: 'bottom-start', offset: 6, flip: true, shift: true }}
      className="dg-linktarget"
      role="status"
      aria-label="Link target"
    >
      <span className="dg-linktarget-label">Opens</span>
      <span className="dg-linktarget-urls">
        {(hrefs ?? []).map((href) => (
          <code key={href} className="dg-linktarget-url">
            {href}
          </code>
        ))}
      </span>
    </GuardedBubbleMenu>
  );
}
