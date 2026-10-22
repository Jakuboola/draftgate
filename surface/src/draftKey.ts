/**
 * `⌘J`: the keyboard's way into the draft, and the only one while nothing in the page holds the
 * keyboard.
 *
 * The window focuses nothing when it comes forward (`shortcutGrace.ts`, `draftgate.m`'s `-show`), so
 * whatever the reviewer was typing into another app reaches the page and does nothing. Measured in
 * the harness on a drawn page, once the window is key: `document.hasFocus()` is true, the active
 * element is `<body>`, and a letter's `keydown` targets `<body>` and changes nothing. But a Tab
 * there is the browser's focus navigation: it moved the focus to the toolbar's text-style select, a
 * title's `<input>` or a plain body's textarea, and a Shift-Tab straight into the draft, and the
 * next character typed landed in the draft. So with nothing focused a Tab does nothing, at any
 * time, and `⌘J`, honoured only once the `⌘↵` grace has passed, is how the keyboard gets in.
 *
 * Why `⌘J`. A stray keystroke is typing aimed at another app, and plain typing never holds `⌘`.
 * Tab and Shift-Tab are keys a terminal running Claude Code is pressed with all the time, and ↵ ends
 * nearly every line typed. Nothing in the window binds `⌘J`: not the host's menu (`draftgate.m`'s
 * `installMenu`), not the editor's shortcuts (`⌘E`, the obvious "edit", is TipTap's inline code).
 *
 * Once something is focused, Tab is the browser's again: in a patch review it moves between the
 * edit boxes, the previews between them taking no stop.
 */
import type { TiptapEditorHTMLElement } from '@tiptap/core';

/** How the footer names the key. */
export const DRAFT_KEY = '⌘J';

/** `⌘J` and no other modifier, on any keyboard layout that types a J. */
export function isDraftKey(e: KeyboardEvent): boolean {
  return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j';
}

/** Does nothing in the page hold the keyboard, as on open? Keys then go to the page itself. */
export function nothingFocused(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * Put the caret where the reviewer edits first: the draft (the editor, or a plain body's textarea),
 * else a patch's first edit box, else the first line field of a call with no body. The editor keeps
 * its own selection, so a reviewer who tabbed out comes back where they were.
 */
export function focusDraft(): void {
  const editor = document.querySelector<TiptapEditorHTMLElement>('.dg-compose .ProseMirror');
  if (editor?.editor) {
    editor.editor.commands.focus();
    return;
  }
  const box =
    document.querySelector<HTMLElement>('.dg-compose textarea') ??
    document.querySelector<HTMLElement>('textarea.dg-edit-text') ??
    document.querySelector<HTMLElement>('input.dg-prose-field');
  box?.focus();
}
