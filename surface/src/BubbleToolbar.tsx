/**
 * The selection toolbar: the marks, on the selected text, at the point of use. The companion to
 * `Toolbar.tsx` (always visible, everything the destination renders), not a subset: block-shaped
 * controls belong to a caret position and live there. The control table, button and subscription
 * are in `controls.tsx`.
 *
 * The five marks (bold, italic, strike, inline code, link) render on all four destinations: Slack's
 * dialect was measured live as GFM (`**bold**`, `~~strike~~`, `*star*`), Linear stores the markdown
 * byte-identically, and Jira's ADF carries all five with the round trip asserted in `core/test`.
 * The set is still read from `RenderResult.toolbar.marks`. Underline is absent because markdown has
 * none (see `Editor.tsx`).
 */

import { useCallback } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import type { ToolbarMark } from '../../core/src/index';
import { LINK_CONTROL, MARK_CONTROLS, ToolbarButton, useControlState } from './controls';
import { LINK, UrlInput, useUrlEditor } from './linkEditor';
import { GuardedBubbleMenu } from './GuardedBubbleMenu';

interface BubbleToolbarProps {
  editor: TiptapEditor | null;
  /** From the profile, so membership is a destination claim rather than a window decision. */
  marks: readonly ToolbarMark[];
}

export function BubbleToolbar({ editor, marks }: BubbleToolbarProps) {
  // Shared with the full toolbar: prefill, validate, apply, remove. Two copies of the URL
  // validation would be two places for a `javascript:` address to reach an approved payload.
  const link = useUrlEditor(editor, LINK);
  // `marksOnly`: the block and history `can()` probes are not needed here, and they are the
  // expensive half of the subscription.
  const state = useControlState(editor, true);

  /*
   * Only over a real text selection, and never inside a code block.
   *
   * A code block's content is plain text in this schema -- marks cannot apply to it -- so offering
   * Bold there would be a control that silently does nothing. The default `shouldShow` does not know
   * that.
   */
  const shouldShow = useCallback(
    ({ editor: e, from, to }: { editor: TiptapEditor; from: number; to: number }) =>
      from !== to && !e.isActive('codeBlock'),
    []
  );

  if (!editor || !state) return null;

  return (
    <GuardedBubbleMenu
      name="formattingBubble"
      editor={editor}
      shouldShow={shouldShow}
      // Appended to <body> so a scrolling ancestor cannot clip it. The destination sheets still
      // reach it: `data-destination` lives on <html>, above both.
      appendTo={() => document.body}
      options={{ placement: 'top', offset: 8, flip: true, shift: true }}
      className="dg-bubble"
      // A toolbar, so arrow-key semantics and screen-reader grouping are correct.
      role="toolbar"
      aria-label="Formatting"
    >
      {link.editing ? (
        <UrlInput url={link} canRemove={state.link} />
      ) : (
        <>
          {marks
            .filter((m): m is Exclude<ToolbarMark, 'link'> => m !== 'link')
            .map((m) => (
              <ToolbarButton
                key={m}
                control={MARK_CONTROLS[m]}
                className="dg-bubble-btn"
                active={state.active[m]}
                onRun={() => MARK_CONTROLS[m].run(editor)}
              />
            ))}
          {marks.includes('link') && (
            <>
              <span className="dg-bubble-sep" aria-hidden="true" />
              {/*
               * `ToolbarButton` with the SHARED control, not a hand-rolled `<button>`.
               *
               * A hand-rolled one carries its own `aria-label`, its own `title` and its own copy of
               * the `onMouseDown` guard, and drifts from the main toolbar's (a word here, a glyph
               * there). Both are properties of the component, and the glyph is `LINK_CONTROL`'s.
               */}
              <ToolbarButton
                control={LINK_CONTROL}
                className="dg-bubble-btn"
                active={state.link}
                onRun={link.open}
              />
            </>
          )}
        </>
      )}
    </GuardedBubbleMenu>
  );
}
