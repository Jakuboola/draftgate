/**
 * Let a warning's arrival settle while the reviewer types, without ever holding the list back.
 *
 * `render()` runs on every keystroke (`useReview.ts`'s header says why), and that stays. What
 * distracts is the display: redrawn mid-word, half-typed prose produces warnings that appear and
 * vanish. So only the ARRIVAL of a warning waits; `current` stays live everywhere it matters
 * (`blocked` still disables Approve on the current keystroke and `approve()` still returns early).
 * Nothing here can send anything.
 *
 * Debouncing the whole list (a snapshot republished `SETTLE_MS` after the last change) would make
 * every displayed row potentially stale and need flush rules plus re-resolution in `App.tsx`. This
 * instead renders the live list minus any non-blocking warning whose code has not been continuously
 * present for `delayMs`:
 *
 *   - a blocking warning is never eligible to be withheld, so a dead Approve always has its reason
 *     on screen on the keystroke that killed it;
 *   - a removal is immediate, so applying a repair makes its warning vanish on the click;
 *   - every displayed row is a live object from the current render, so `App.tsx` reads
 *     `editorPath` and `fix.body` straight off it. A repair body computed from a draft the reviewer
 *     has typed past would silently discard their keystrokes; this cannot produce one.
 *
 * The trade: a settled warning disappears the moment it stops being true, where a snapshot would
 * hold it. A code that comes and goes restarts its wait each time it returns, so warnings appearing
 * mid-word stay quiet.
 */

import { useEffect, useReducer, useRef } from 'react';
import { isBlocking } from '../../core/src/index';
import type { Warning } from '../../core/src/index';

/**
 * How long a new warning waits before it may be shown: long enough to cover the gap between words,
 * short enough that a reviewer who stops to read is never reading a stale list. Not measured; no
 * probe answers "distracting".
 */
export const SETTLE_MS = 600;

/**
 * The arrival time given to the warnings a review opens with: a loaded draft is already judged and
 * nothing is typing, so they show on the first render. Epoch, so `now - arrival >= delayMs` says
 * "due" without a second branch.
 */
const AT_MOUNT = 0;

/**
 * When each code in `warnings` was first seen, carried forward from `previous`.
 *
 * Built fresh from the live list, so a code that leaves and comes back is a new arrival and waits
 * again. Keyed on the code, so two reports of one rule appear and disappear together.
 */
export function arrivals(
  warnings: Warning[],
  previous: ReadonlyMap<string, number>,
  now: number
): Map<string, number> {
  const next = new Map<string, number>();
  for (const w of warnings) next.set(w.code, previous.get(w.code) ?? now);
  return next;
}

/**
 * Which warnings may be shown, and when to look again, in one pass: the live list minus the
 * non-blocking warnings whose code has not been present for `delayMs`, plus the absolute moment the
 * soonest withheld one comes due (`undefined` if none).
 *
 * One function so there is one clock. As two, a filter on the render's `Date.now()` and a deadline
 * test on the commit's could withhold a warning and judge it "already due" at once: nothing is armed
 * and it stays hidden until an unrelated re-render.
 *
 * `shown` is a filter, so every element is an object from `warnings` in `render()`'s order. `wakeAt`
 * is absolute, so a re-render mid-wait re-arms the same moment. `isBlocking` is `core`'s predicate
 * (the one that decides whether Approve is alive); a blocking warning is shown at once.
 */
export function settle(
  warnings: Warning[],
  since: ReadonlyMap<string, number>,
  now: number,
  delayMs: number
): { shown: Warning[]; wakeAt: number | undefined } {
  const shown: Warning[] = [];
  let wakeAt = Infinity;
  for (const w of warnings) {
    // `-Infinity` for a blocking warning, so "never withheld" needs no second branch. `?? now`
    // cannot fire: `arrivals` builds the map from this very list.
    const due = isBlocking(w) ? -Infinity : (since.get(w.code) ?? now) + delayMs;
    if (due <= now) shown.push(w);
    else if (due < wakeAt) wakeAt = due;
  }
  return { shown, wakeAt: wakeAt === Infinity ? undefined : wakeAt };
}

/** The list to display: always live objects (see the header). */
export function useSettledWarnings(warnings: Warning[], delayMs: number = SETTLE_MS): Warning[] {
  /**
   * When each currently-present code arrived. A ref written during render, not state: the answer
   * is needed in the same render that first sees the warning. The write is idempotent for a given
   * `warnings`, and the window mounts no `StrictMode` (`main.tsx`).
   */
  const since = useRef<Map<string, number>>();
  /** Nothing reads the value; a fired timer needs a re-render to recompute the partition. */
  const [, recheck] = useReducer((n: number) => n + 1, 0);

  const now = Date.now();
  since.current =
    since.current === undefined
      ? arrivals(warnings, new Map(), AT_MOUNT)
      : arrivals(warnings, since.current, now);

  const { shown, wakeAt } = settle(warnings, since.current, now, delayMs);

  /*
   * One timer for the list, armed to `wakeAt`. Nothing withheld arms nothing, which ends the loop.
   * Only the delay is measured from the commit, floored at zero, so a warning that came due between
   * render and effect is republished on the next tick.
   */
  useEffect(() => {
    if (wakeAt === undefined) return;
    const timer = setTimeout(recheck, Math.max(0, wakeAt - Date.now()));
    return () => clearTimeout(timer);
  });

  return shown;
}
