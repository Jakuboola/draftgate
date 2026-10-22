/**
 * How long `⌘↵` stays dead after the window appears or regains focus.
 *
 * A real review orders an always-on-top window front and activates the app once the page has
 * loaded (`show` in `surface/host/draftgate.m`). Whether it gets the keyboard is macOS's call
 * (measured below: with the terminal in front the app came forward about 0.4 s after the review
 * started, before the page ran its script; with TextEdit in front the window sat on top for the
 * whole review while TextEdit kept the keyboard). When it does take the keyboard it takes it from
 * whatever the reviewer was typing into: without a grace, a `⌘↵` meant for that app approves and
 * sends a draft nobody has read.
 *
 * So the shortcut is ignored for about a second after every show or focus event. A repeat never
 * acts either (`App.tsx` checks it): a `⌘↵` still held from the other app arrives as repeats. A
 * click on Approve stays live, because it is aimed at a button the reviewer can see. The other half
 * is in `App.tsx`: nothing is focused on open, which on the WebKit host also needs the host to give
 * the page no initial focus. `⌘J` waits out the same grace (`draftKey.ts`).
 *
 * The clock is `performance.now()`, a duration the wall clock cannot jump. The mount counts as a
 * show: the shell mounts once the request has loaded, after any earlier `focus` event.
 *
 * Both anchors are needed, and since either restarts the grace, whichever comes later governs it.
 * Measured on the review build (WebKit 22625, macOS 27.0): a by-hand `draftgate review --dest
 * slack` of the Slack example payload with `lsappinfo front` polled from its start, and the page's
 * side read through a temporary listener.
 *
 * - The terminal in front (one review): the app came forward before the page's script ran, which
 *   already saw `hasFocus() === true`, so no `focus` event reached a listener. The shell mounted
 *   about 0.1 s after the handover, and the MOUNT is what starts the grace.
 * - TextEdit in front (four reviews): `hasFocus()` stayed false and no `focus` fired while TextEdit
 *   kept the keyboard. Activated later (`open -a` on the running app), the page's `focus` fired
 *   within about 20 ms of the app coming to the front, so when the reviewer brings the window
 *   forward, the FOCUS event is what restarts the grace.
 *
 * `visibilitychange` fired once, as the page loaded and before the shell mounted, and the page
 * already reported `visible` before it, so it marks no handover; it covers only a window hidden and
 * shown again. The harness cannot activate a window (it never takes this Mac's keyboard), so it
 * checks only its STAND-IN for becoming key, which delivers the page's `focus`.
 */
import { useCallback, useEffect, useRef } from 'react';

export const SHORTCUT_GRACE_MS = 1000;

/**
 * A function answering "may `⌘↵` act now?": nothing re-renders when the grace runs out, so the
 * keydown handler asks at the keystroke.
 */
export function useShortcutArmed(graceMs: number = SHORTCUT_GRACE_MS): () => boolean {
  const since = useRef(performance.now());

  useEffect(() => {
    const restart = () => {
      since.current = performance.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') restart();
    };
    window.addEventListener('focus', restart);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', restart);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return useCallback(() => performance.now() - since.current >= graceMs, [graceMs]);
}
