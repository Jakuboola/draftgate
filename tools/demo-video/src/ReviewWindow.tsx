/**
 * The review window as it opens, drawn by the window's own `App` and stylesheets.
 *
 * `App` asks `window.draftgate` for its request, as it does in the WebKit host; here the bridge
 * answers with `dist/request.json`, which the gate itself produced (`request.ts`). Nothing in
 * `surface/src` is copied or changed.
 *
 * `App` assumes it owns the page: it sets `data-destination` and `data-theme` on `<html>` and
 * `shell.css` sizes `html, body, #root`. The box below stands in for the window's content area, and
 * its `transform` makes it the containing block for the window's `position: fixed` layers, so they
 * land inside the window rather than on the 1920x1080 frame.
 *
 * The title bar is the host's native chrome, not part of the page, so it is drawn here: a plain bar
 * with the title the host composes (`surface/windowTitle.cjs`).
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { continueRender, delayRender } from 'remotion';
import { App } from '../../../surface/src/App';
import type { WireRequest } from '../../../surface/src/bridge';
// The window's own stylesheet list, the one `surface/src/main.tsx` imports.
import '../../../surface/src/styles/index';
import request from '../dist/request.json';
import frame from '../dist/frame.json';
import { TrafficLights } from './overlays';

const TITLE_BAR = 28;

/**
 * Hold the frame until the editor holds the draft and every face the page asked for has loaded, then
 * hand the window's box to `onReady`.
 */
function useWindowReady(box: RefObject<HTMLDivElement | null>, onReady?: (box: HTMLDivElement) => void): void {
  const [handle] = useState(() => delayRender('the review window loads its request'));
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const editor = document.querySelector('.ProseMirror');
      // The editor is filled in one step, so any text at all means the whole draft is in.
      if (!editor || !editor.textContent?.trim()) {
        if (live) setTimeout(poll, 50);
        return;
      }
      await document.fonts.ready;
      if (!live) return;
      if (box.current) onReady?.(box.current);
      continueRender(handle);
    };
    void poll();
    return () => {
      live = false;
    };
  }, [handle]);
}

/** The host's title bar, light and dark: a stand-in for native chrome, not a measured surface. */
const CHROME = {
  light: { bar: '#e8e8e8', rule: '#d0d0d0', text: '#4a4a4a' },
  dark: { bar: '#2c2c2e', rule: '#1c1c1e', text: '#d0d0d0' },
};

interface ReviewWindowProps {
  dark?: boolean;
  /** Extra style on the window's box: its position, a camera move, a pop-in. */
  style?: CSSProperties;
  onReady?: (box: HTMLDivElement) => void;
}

/** The review window alone: its box, the title bar, and the real `App` inside. */
export const ReviewWindow = ({ dark = false, style, onReady }: ReviewWindowProps) => {
  const box = useRef<HTMLDivElement>(null);
  // Before `App` mounts, so its first request sees it. `theme` is the wire's optional explicit theme
  // (`WireRequest.theme`), which outranks the OS preference the way a reviewer's choice would.
  useState(() => {
    const wire = { ...(request as unknown as WireRequest), ...(dark ? { theme: 'dark' as const } : {}) };
    window.draftgate = { request: async () => wire, decide: () => {} };
  });
  useWindowReady(box, onReady);
  const chrome = dark ? CHROME.dark : CHROME.light;
  return (
    <div
      ref={box}
      style={{
        width: frame.width,
        height: frame.height,
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08)',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      <div
        style={{
          height: TITLE_BAR,
          flex: 'none',
          background: chrome.bar,
          borderBottom: `1px solid ${chrome.rule}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          font: '13px -apple-system, BlinkMacSystemFont, sans-serif',
          color: chrome.text,
        }}
      >
        <TrafficLights left={12} />
        {frame.title}
      </div>
      <div id="root" style={{ flex: 1, minHeight: 0, position: 'relative', transform: 'translateZ(0)' }}>
        <App />
      </div>
    </div>
  );
};
