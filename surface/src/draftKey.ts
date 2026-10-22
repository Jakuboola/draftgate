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
 * next character typed landed in the draft. So until the reviewer has done something deliberate in
 * the page (pressed a pointer in it, or a `⌘J` that was honoured), a Tab with nothing focused does
 * nothing, and `⌘J`, honoured only once the `⌘↵` grace has passed, is how the keyboard gets in.
 * After that, Tab is the browser's again, so a reviewer whose focus fell back to the page (a click
 * on a button, a closed repair preview) can still Tab to the buttons. The window taking the
 * keyboard again (its `focus` event, or being shown again) starts it over, as it restarts the grace.
 *
 * Why `⌘J`. A stray keystroke is typing aimed at another app, and plain typing never holds `⌘`.
 * Tab and Shift-Tab are keys a terminal running Claude Code is pressed with all the time, and ↵ ends
 * nearly every line typed. Nothing in the window binds `⌘J`: not the host's menu (`draftgate.m`'s
 * `installMenu`), not the editor's shortcuts (`⌘E`, the obvious "edit", is TipTap's inline code).
 */
import { useCallback, useEffect, useRef } from 'react';
import type { TiptapEditorHTMLElement } from '@tiptap/core';

/** How the footer names the key. */
export const DRAFT_KEY = '⌘J';

/**
 * `⌘J` and no other modifier: the key that types a J, or on a layout whose letters are not Latin
 * (where `key` is the layout's own letter), the key where a J sits.
 */
export function isDraftKey(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === 'j' : e.code === 'KeyJ';
}

/** Does nothing in the page hold the keyboard, as on open? Keys then go to the page itself. */
function nothingFocused(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * Hold a Tab with nothing focused until the reviewer engages, for as long as the window is mounted
 * (the fatal screen too). Returns what an honoured `⌘J` calls to engage. A ref: nothing redraws on it.
 */
export function useTabGuard(): () => void {
  const engaged = useRef(false);
  useEffect(() => {
    const engage = () => {
      engaged.current = true;
    };
    const restart = () => {
      engaged.current = false;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') restart();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !engaged.current && nothingFocused()) e.preventDefault();
    };
    window.addEventListener('pointerdown', engage, true);
    window.addEventListener('focus', restart);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', engage, true);
      window.removeEventListener('focus', restart);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return useCallback(() => {
    engaged.current = true;
  }, []);
}

/**
 * Put the caret where the reviewer edits first: the draft (the editor, or a plain body's textarea),
 * else a patch's first edit box, else the first line field of a call with no body. The editor keeps
 * its own selection, so a reviewer who tabbed out comes back where they were.
 */
export function focusDraft(): void {
  // A draft drawn in the editor is the target even while TipTap has no handle on it (a remount),
  // so the caret never falls through to the title above it.
  const editor = document.querySelector<TiptapEditorHTMLElement>('.dg-compose .ProseMirror');
  if (editor !== null) {
    editor.editor?.commands.focus();
    return;
  }
  const box =
    document.querySelector<HTMLElement>('textarea.dg-plain-body') ??
    document.querySelector<HTMLElement>('textarea.dg-edit-text') ??
    document.querySelector<HTMLElement>('input.dg-prose-field');
  box?.focus();
}
