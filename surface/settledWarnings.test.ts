/**
 * The two pure rules that decide when a warning may be shown: `arrivals` and `displayable`.
 *
 * Pure, so they are tested here rather than through a mounted tree; the hook's TIMING is in
 * `window.test.tsx`, which is the only file that mounts React. The two halves are worth separating,
 * because this is the half that has to be right for the window to stay honest -- it is what keeps a
 * disabled Approve from sitting above a list that has not caught up to why.
 *
 * There is no snapshot of the list to flush: the display is a filter of the live list, so a
 * blocking warning is not exempted from a wait, it is never eligible for one.
 */

import { describe, expect, test } from 'bun:test';
import { arrivals, settle, SETTLE_MS } from './src/settledWarnings';
import type { Warning } from '../core/src/index';

// Fabricated codes: this file tests TIMING, not codes, so the cast says "any code will do here".
function w(code: string, severity: Warning['severity'], message = 'anything'): Warning {
  return { code: code as Warning['code'], severity, message };
}

/** `now`, `now + SETTLE_MS`, and the instant before it is due. Absolute, so the maths is visible. */
const T0 = 1_000_000;
const DUE = T0 + SETTLE_MS;

/** The map a list would have if every code in it arrived at `at`. */
const seenAt = (warnings: Warning[], at: number) => arrivals(warnings, new Map(), at);

/*
 * `settle` returns both halves in one pass, and most tests below are about one of them.
 *
 * These read that one out. NOT a second implementation -- each is one property access on the real
 * function's result -- which is the whole reason `settle` is one call: the two halves cannot be
 * asked on different clocks, so a test cannot express the bug the property sweep at the bottom
 * guards against. It can only observe that they agree.
 */
const shownOf = (ws: Warning[], since: ReadonlyMap<string, number>, now: number, delay: number) =>
  settle(ws, since, now, delay).shown;
const wakeOf = (ws: Warning[], since: ReadonlyMap<string, number>, now: number, delay: number) =>
  settle(ws, since, now, delay).wakeAt;

describe('when a warning arrived', () => {
  test('a code not seen before is stamped now', () => {
    expect(arrivals([w('a/one', 'warning')], new Map(), T0).get('a/one')).toBe(T0);
  });

  test('a code already present keeps its ORIGINAL stamp, which is what makes it a wait', () => {
    // Re-stamping on every render is a wait that never ends: `render()` produces a fresh array per
    // keystroke, so the code would look new each time and never come due.
    const first = arrivals([w('a/one', 'warning')], new Map(), T0);
    expect(arrivals([w('a/one', 'warning')], first, T0 + 500).get('a/one')).toBe(T0);
  });

  test('a code that LEAVES is forgotten, so its return is a fresh arrival', () => {
    // Otherwise a warning that flickered once, minutes ago, reappears instantly the next time --
    // the flicker this exists to stop, merely delayed.
    const first = arrivals([w('a/one', 'warning')], new Map(), T0);
    const gone = arrivals([], first, T0 + 100);
    expect(gone.has('a/one')).toBe(false);
    expect(arrivals([w('a/one', 'warning')], gone, T0 + 200).get('a/one')).toBe(T0 + 200);
  });

  test('two warnings sharing a code share one arrival', () => {
    // They are two reports of one rule. Showing one and withholding the other would be a list that
    // disagrees with itself, and there is nothing to key the difference on.
    const both = arrivals([w('a/one', 'warning'), w('a/one', 'warning')], new Map(), T0);
    expect([...both.keys()]).toEqual(['a/one']);
  });

  test('an empty list yields an empty map, which is the clean draft', () => {
    expect(arrivals([], seenAt([w('a/one', 'warning')], T0), T0).size).toBe(0);
  });
});

describe('what may be displayed', () => {
  test('a non-blocking warning is withheld until it has been present for the delay', () => {
    const ws = [w('slack/url-swallows-next-line', 'warning')];
    const seen = seenAt(ws, T0);
    expect(shownOf(ws, seen, T0, SETTLE_MS)).toEqual([]);
    expect(shownOf(ws, seen, DUE - 1, SETTLE_MS)).toEqual([]);
    expect(shownOf(ws, seen, DUE, SETTLE_MS)).toEqual(ws);
  });

  test('a BLOCKING warning is shown at once, however new it is', () => {
    // Not an exemption: a blocking warning is never eligible to be withheld, so there is no rule
    // to get wrong. Approve
    // is already dead on this keystroke and a dead button with no reason on screen is worse than
    // any flicker.
    const ws = [w('body/empty', 'error')];
    expect(shownOf(ws, seenAt(ws, T0), T0, SETTLE_MS)).toEqual(ws);
  });

  test('one blocking defect SWAPPED for another shows the new reason at once', () => {
    // A count would miss this and so would a boolean: Approve is dead either way, and the reason is
    // the only thing on screen telling the reviewer what to do about it.
    const before = [w('body/empty', 'error')];
    const after = [w('body/structure-lost', 'error')];
    const seen = arrivals(after, seenAt(before, T0), T0 + 10);
    expect(shownOf(after, seen, T0 + 10, SETTLE_MS)).toEqual(after);
  });

  test('a blocking one is shown while a new non-blocking one beside it still waits', () => {
    // The mixed list, which a whole-list snapshot cannot express: it would publish both or
    // neither.
    const ws = [w('body/empty', 'error'), w('a/slow', 'warning')];
    expect(shownOf(ws, seenAt(ws, T0), T0, SETTLE_MS)).toEqual([ws[0]!]);
  });

  test('the warnings a review OPENS with are shown immediately', () => {
    // `AT_MOUNT` in the hook. A loaded draft arrives already judged and there is no typing for its
    // verdict to flicker under, so waiting 600ms to say so is a delay with nothing behind it.
    const ws = [w('a/one', 'warning')];
    expect(shownOf(ws, seenAt(ws, 0), T0, SETTLE_MS)).toEqual(ws);
  });

  test('a removal is immediate -- a warning gone from the live list has no row', () => {
    // So an applied repair's row goes on the click. There is no snapshot to hold the row open.
    expect(shownOf([], seenAt([w('a/one', 'warning')], 0), T0, SETTLE_MS)).toEqual([]);
  });

  test('every element is the SAME OBJECT the live list held, which is the whole design', () => {
    // Identity, not equality. It is what lets `App.tsx` read `fix.body` and `editorPath` straight
    // off a clicked row: a filter cannot produce a row describing a draft that is not on screen.
    const ws = [w('body/empty', 'error'), w('a/one', 'warning')];
    const out = shownOf(ws, seenAt(ws, 0), T0, SETTLE_MS);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ws[0]!);
    expect(out[1]).toBe(ws[1]!);
  });

  test('and order is preserved, because `sortWarnings` already ranked them', () => {
    // The strip shows `shownWarnings[0]` as the most severe. A filter that reordered would put the
    // wrong warning on the collapsed row.
    const ws = [w('a/err', 'error'), w('a/warn', 'warning'), w('a/info', 'info')];
    expect(shownOf(ws, seenAt(ws, 0), T0, SETTLE_MS).map((x) => x.code as string)).toEqual([
      'a/err', 'a/warn', 'a/info',
    ]);
  });

  test('a message that changes over the same code does not restart the wait', () => {
    // Messages carry the body's own text -- a URL, a heading, a node type -- so keying on anything
    // but the code would restart the wait on nearly every keystroke and the warning would never
    // appear at all.
    const before = [w('jira/empty-body', 'error', 'the draft is empty')];
    const after = [w('jira/empty-body', 'error', 'the draft is empty after the edit')];
    const seen = arrivals(after, seenAt(before, T0), T0 + 500);
    expect(seen.get('jira/empty-body')).toBe(T0);
  });

  test('a zero delay shows everything, which is what the tests that want no wait rely on', () => {
    const ws = [w('a/one', 'warning')];
    expect(shownOf(ws, seenAt(ws, T0), T0, 0)).toEqual(ws);
  });
});

/**
 * The timer's deadline, which must be the exact complement of `displayable`.
 *
 * These are two answers to one question -- is this warning due yet -- and they must read ONE
 * clock. Withhold on the render's `now` and test the deadline against the commit's `Date.now()`,
 * and a warning whose deadline falls in between is withheld and judged already-due, so nothing is
 * armed and it stays hidden until some unrelated re-render happens along. A reviewer who stops
 * typing in that gap never sees it.
 *
 * Pure so the agreement is assertable at all; the tests below are the pair, run against one clock,
 * over exactly that boundary.
 */
describe('when the timer wakes up', () => {
  test('nothing is armed for a list that is entirely displayable', () => {
    const warnings = [w('a/one', 'warning')];
    expect(wakeOf(warnings, seenAt(warnings, T0), DUE, SETTLE_MS)).toBeUndefined();
  });

  test('nothing is armed for a blocking warning, which is never withheld', () => {
    const warnings = [w('a/err', 'error')];
    expect(shownOf(warnings, seenAt(warnings, T0), T0, SETTLE_MS)).toEqual(warnings);
    expect(wakeOf(warnings, seenAt(warnings, T0), T0, SETTLE_MS)).toBeUndefined();
  });

  test('a pending warning arms its own deadline, absolutely', () => {
    const warnings = [w('a/one', 'warning')];
    expect(wakeOf(warnings, seenAt(warnings, T0), T0 + 100, SETTLE_MS)).toBe(DUE);
  });

  test('the SOONEST of several, so one timer serves the whole list', () => {
    const early = w('a/early', 'warning');
    const late = w('a/late', 'warning');
    const since = new Map([
      [early.code, T0],
      [late.code, T0 + 200],
    ]);
    expect(wakeOf([late, early], since, T0 + 300, SETTLE_MS)).toBe(DUE);
  });

  test('every warning is either shown or waited for, at every instant', () => {
    /*
     * The property, swept across the boundary rather than sampled at it: a warning that is neither
     * shown nor armed for has been dropped, which is what two clocks produce for one render's worth
     * of time.
     *
     * `settle` returns both halves from one pass, so this cannot FAIL by the two-clock mechanism --
     * there is no second clock to pass. It stays because the property is what matters rather than
     * the shape that guarantees it: a future `settle` that partitions
     * differently would still have to satisfy this, and the sweep says so at every millisecond
     * across the deadline instead of at the one point a hand-written case would pick.
     */
    const warnings = [w('a/one', 'warning'), w('a/two', 'warning')];
    const since = new Map([
      ['a/one', T0],
      ['a/two', T0 + 7],
    ]);
    for (let now = T0; now <= DUE + 20; now++) {
      // ONE call, which is the point: the two halves cannot disagree about the clock.
      const settled = settle(warnings, since, now, SETTLE_MS);
      const shown = new Set(settled.shown.map((x) => x.code));
      const armed = settled.wakeAt;
      const withheld = warnings.filter((x) => !shown.has(x.code));
      if (withheld.length === 0) {
        expect(armed, `nothing withheld at ${now - T0}, so nothing to wait for`).toBeUndefined();
        continue;
      }
      // Something is withheld, so a wakeup MUST be armed, and it must be the soonest one's.
      const soonest = Math.min(...withheld.map((x) => since.get(x.code)! + SETTLE_MS));
      expect(armed, `withheld but unarmed at ${now - T0}`).toBe(soonest);
      // And it is in the future on the same clock, so the timer cannot be armed for the past.
      expect(armed! > now, `armed deadline at ${now - T0} is not ahead of now`).toBe(true);
    }
  });
});
