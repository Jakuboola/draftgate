/**
 * TipTap's `BubbleMenu`, made safe against TipTap's own timers. Every bubble in the window is one.
 *
 * The bubble plugin starts timers it never cancels: a `setTimeout(0)` on every editor focus, and the
 * `updateDelay` debounce (250ms by default) on every change to a range selection. Either can fire
 * after the plugin is gone, and `show()` then appends the bubble to <body>, where nothing removes it:
 * a visible toolbar that takes clicks, over a window whose editor is gone. Measured in the real
 * window: a repair applied within 250ms of a range selection changing leaves the formatting bubble
 * there for good. Both timers end in `shouldShow`, so answering `false` for a plugin that is no
 * longer installed turns the late `show()` into a `hide()`, which does nothing to a hidden bubble.
 * Installed means a live editor with this mount's own key still in its state (`window.test.tsx`
 * has the case each half catches).
 */

import { useCallback, useState } from 'react';
import { BubbleMenu, type BubbleMenuProps } from '@tiptap/react/menus';
import { PluginKey } from '@tiptap/pm/state';
import type { Editor as TiptapEditor } from '@tiptap/react';

type ShouldShow = NonNullable<BubbleMenuProps['shouldShow']>;

export function bubbleInstalled(editor: TiptapEditor, key: PluginKey): boolean {
  return !editor.isDestroyed && key.get(editor.state) !== undefined;
}

type GuardedBubbleMenuProps = Omit<BubbleMenuProps, 'pluginKey' | 'shouldShow'> & {
  /** Names the plugin key, which also gives the bubble's plugin a findable name in the state. */
  name: string;
  shouldShow: ShouldShow;
};

export function GuardedBubbleMenu({ name, shouldShow, ...props }: GuardedBubbleMenuProps) {
  const [key] = useState(() => new PluginKey(name));
  const guarded = useCallback<ShouldShow>(
    (args) => bubbleInstalled(args.editor, key) && shouldShow(args),
    [key, shouldShow]
  );
  return <BubbleMenu {...props} pluginKey={key} shouldShow={guarded} />;
}
