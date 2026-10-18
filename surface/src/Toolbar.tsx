/**
 * The editor's full toolbar. It renders `RenderResult.toolbar`, the profile's list of what the
 * destination renders, with no `destination === ...` here: never offer a control whose effect the
 * recipient will not see. Slack has three heading renderings (`#` large, `##` body size in black,
 * `###` and below body size in bold, read off the live DOM; the weight split at one size is not
 * visible by eye), so its profile declares three levels and this file offers three. Offering six
 * would invite a hierarchy the reader cannot perceive, which `slack/heading-level-collapsed`
 * already reports. A destination's own controls (Jira's `Suggest reply`, Slack's attach and send)
 * are not drawn: every control here is a real one. The control table, button and subscription are
 * in `controls.tsx`.
 */

import { useRef, useState } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import type { ToolbarMark, ToolbarSupport } from '../../core/src/index';
import {
  BLOCK_CONTROLS,
  EMOJI_CONTROL,
  HISTORY_CONTROLS,
  LINK_CONTROL,
  MARK_CONTROLS,
  ToolbarButton,
  useControlState,
  type Control,
} from './controls';
import { EmojiPicker } from './EmojiPicker';
import { LINK, UrlInput, useUrlEditor } from './linkEditor';

interface ToolbarProps {
  editor: TiptapEditor | null;
  support: ToolbarSupport;
}

export function Toolbar({ editor, support }: ToolbarProps) {
  const link = useUrlEditor(editor, LINK);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Wraps the emoji toggle AND its popover, so the picker's outside-click handler does not treat
  // the toggle as outside -- which would make the button unable to close what it had opened.
  const emojiHost = useRef<HTMLSpanElement>(null);
  const state = useControlState(editor);

  if (!editor || !state) return null;

  const setHeading = (level: number) => {
    const chain = editor.chain().focus();
    if (level === 0) chain.setParagraph().run();
    else chain.setNode('heading', { level }).run();
  };

  const button = (id: string, c: Control) => (
    <ToolbarButton
      key={id}
      control={c}
      className="dg-tb-btn"
      active={c.activeAs ? state.active[id] : undefined}
      disabled={!state.enabled[id]}
      onRun={() => c.run(editor)}
    />
  );

  return (
    // `data-popover-open` lifts the pinned toolbar over the warning list while its picker is open
    // (`shell.css`, `.dg-toolbar`).
    <div
      className="dg-toolbar"
      role="toolbar"
      aria-label="Formatting"
      data-popover-open={emojiOpen || undefined}
    >
      {/* Heading levels come from the profile. Slack gets three; the others get six. */}
      <select
        className="dg-tb-select"
        aria-label="Text style"
        value={state.heading}
        onChange={(e) => setHeading(Number(e.target.value))}
      >
        <option value={0}>Normal</option>
        {support.headingLevels.map((l) => (
          <option key={l} value={l}>
            Heading {l}
          </option>
        ))}
        {/* The caret is in a heading this destination does not draw distinctly. It exists in the
            document and the reviewer must be able to see that, rather than being told "Normal". */}
        {state.heading > 0 && !support.headingLevels.includes(state.heading) && (
          <option value={state.heading}>Heading {state.heading} (not distinct here)</option>
        )}
      </select>

      <span className="dg-tb-sep" aria-hidden="true" />
      {support.marks
        .filter((m): m is Exclude<ToolbarMark, 'link'> => m !== 'link')
        .map((m) => button(m, MARK_CONTROLS[m]))}
      {support.marks.includes('link') && (
        <ToolbarButton
          control={LINK_CONTROL}
          className="dg-tb-btn"
          active={state.link}
          onRun={link.open}
        />
      )}

      <span className="dg-tb-sep" aria-hidden="true" />
      {support.blocks.map((b) => button(b, BLOCK_CONTROLS[b]))}

      {/*
       * Inserts: things that put something in the DOCUMENT rather than toggling a structure.
       *
       * There is no image insert: it could never do the thing anyone reaches for -- draftgate
       * holds no destination credentials, so it cannot upload a screenshot, and pasting a URL is
       * what the Link control two positions to the left already does. `ToolbarInsert` carries the
       * full reasoning. An image an agent wrote is still displayed.
       */}
      {support.inserts.length > 0 && <span className="dg-tb-sep" aria-hidden="true" />}
      {support.inserts.includes('emoji') && (
        <span className="dg-tb-host" ref={emojiHost}>
          <ToolbarButton
            control={EMOJI_CONTROL}
            className="dg-tb-btn"
            active={emojiOpen}
            onRun={() => setEmojiOpen((v) => !v)}
          />
          {emojiOpen && (
            <EmojiPicker
              hostRef={emojiHost}
              onPick={(e) => {
                editor.chain().focus().insertContent(e).run();
                setEmojiOpen(false);
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </span>
      )}

      {/* History last, and separated: it acts on the editor rather than on the message. */}
      <span className="dg-tb-sep" aria-hidden="true" />
      {Object.entries(HISTORY_CONTROLS).map(([id, c]) => button(id, c))}

      {link.editing && <UrlInput url={link} canRemove={state.link} />}
    </div>
  );
}
