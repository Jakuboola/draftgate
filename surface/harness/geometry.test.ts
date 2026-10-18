/**
 * Review window geometry: pure arithmetic, so the WebKit host runs `geometry.cjs` unchanged in
 * JavaScriptCore. `surface:host` covers one restored rectangle and zoom level and the three zoom
 * keys; the centring, the clamps and the refusals have only this file.
 */

import { describe, expect, test } from 'bun:test';
// @ts-expect-error -- CommonJS module, deliberately free of imports so the host can load it.
import { reviewWindowBounds, restoreBounds, minimumSize, zoomLevelAfter, zoomFactor, restoreZoomLevel, windowState, MIN, MAX } from '../geometry.cjs';

/** A 14" MacBook work area: menu bar and dock already excluded. */
const LAPTOP = { x: 0, y: 38, width: 1512, height: 944 };
/** A 5K display, where a fixed 1040x860 would be a postage stamp. */
const BIG = { x: 0, y: 0, width: 2560, height: 1440 };
/** A secondary monitor to the right, which centring on the primary display gets wrong. */
const SECOND = { x: 1512, y: 0, width: 1920, height: 1080 };

describe('the window sits over the terminal without covering it', () => {
  test('it is meaningfully smaller than the display, on all four sides', () => {
    const b = reviewWindowBounds(LAPTOP);
    expect(b.width).toBeLessThan(LAPTOP.width);
    expect(b.height).toBeLessThan(LAPTOP.height);
    // The point of the sizing: the terminal shows around every edge, not just left and right.
    expect(b.x).toBeGreaterThan(0);
    expect(b.y).toBeGreaterThan(LAPTOP.y);
    expect(b.x + b.width).toBeLessThan(LAPTOP.x + LAPTOP.width);
    expect(b.y + b.height).toBeLessThan(LAPTOP.y + LAPTOP.height);
  });

  test('it is centred within the work area', () => {
    const b = reviewWindowBounds(LAPTOP);
    expect(b.x - LAPTOP.x).toBe(LAPTOP.width - b.width - (b.x - LAPTOP.x));
    expect(b.y - LAPTOP.y).toBe(LAPTOP.height - b.height - (b.y - LAPTOP.y));
  });

  test('it centres on a SECONDARY display, offset included', () => {
    // Centred on the primary, it could open on a screen the reviewer is not looking at.
    const b = reviewWindowBounds(SECOND);
    expect(b.x).toBeGreaterThanOrEqual(SECOND.x);
    expect(b.x + b.width).toBeLessThanOrEqual(SECOND.x + SECOND.width);
    expect(b.x - SECOND.x).toBe(SECOND.width - b.width - (b.x - SECOND.x));
  });
});

describe('clamping', () => {
  test('a huge display does not give a huge window', () => {
    const b = reviewWindowBounds(BIG);
    expect(b.width).toBeLessThanOrEqual(MAX.width);
    expect(b.height).toBeLessThanOrEqual(MAX.height);
  });

  test('a small display gets a usable window rather than the minimum', () => {
    // Strictly above: `>=` would hold with the window clamped to `MIN` and the fractions at 0.
    const b = reviewWindowBounds(LAPTOP);
    expect(b.width).toBeGreaterThan(MIN.width);
    expect(b.height).toBeGreaterThan(MIN.height);
  });

  test('a display SMALLER than the minimum wins, or the window hangs off the edge', () => {
    const tiny = { x: 0, y: 0, width: 600, height: 400 };
    const b = reviewWindowBounds(tiny);
    expect(b.width).toBeLessThanOrEqual(tiny.width);
    expect(b.height).toBeLessThanOrEqual(tiny.height);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
  });
});

describe('remembering where the reviewer put the window', () => {
  // The terminal's position cannot be detected (the environment can name the wrong app, Ghostty's
  // AppleScript has no `bounds`, System Events means an Accessibility prompt), so the window remembers.
  const displays = [{ workArea: LAPTOP }, { workArea: SECOND }];
  const saved = { x: 200, y: 150, width: 900, height: 700 };

  test('a usable saved rectangle comes back unchanged', () => {
    expect(restoreBounds(saved, displays)).toEqual(saved);
  });

  test('it restores onto a SECONDARY display too', () => {
    const onSecond = { x: 1700, y: 100, width: 900, height: 700 };
    expect(restoreBounds(onSecond, displays)).toEqual(onSecond);
  });

  test('bounds from an UNPLUGGED monitor are refused', () => {
    // Off-screen, a window blocking a send could not be seen or dragged; the centred default can.
    const gone = { x: 4000, y: 200, width: 900, height: 700 };
    expect(restoreBounds(gone, displays)).toBeNull();
  });

  test('a rectangle whose CENTRE is off-display is refused, even if a corner overlaps', () => {
    // Overlap is not enough. Single display: with the second attached this centre lands on it.
    const clipping = { x: LAPTOP.x + LAPTOP.width - 40, y: 200, width: 900, height: 700 };
    expect(restoreBounds(clipping, [{ workArea: LAPTOP }])).toBeNull();
  });

  test('a window saved on a big monitor is shrunk to fit a small one', () => {
    // Centre must still land on the laptop, or this is the unplugged-monitor case instead.
    const huge = { x: -700, y: -600, width: 3000, height: 2000 };
    const b = restoreBounds(huge, [{ workArea: LAPTOP }]);
    expect(b).not.toBeNull();
    expect(b!.width).toBeLessThanOrEqual(LAPTOP.width);
    expect(b!.height).toBeLessThanOrEqual(LAPTOP.height);
    // And brought back on-screen: a size-only clamp leaves the title bar at -600, undraggable.
    expect(b!.x).toBeGreaterThanOrEqual(LAPTOP.x);
    expect(b!.y).toBeGreaterThanOrEqual(LAPTOP.y);
  });

  test('a restored window never hangs off the BOTTOM, where the decision buttons are', () => {
    // 1180x900 saved at y=100, restored on a 1280x720 work area. A height clamped to the display
    // rather than to the room below `y` gives 1180x720 at y=100: the footer 100px below the screen.
    const small = { x: 0, y: 0, width: 1280, height: 720 };
    const b = restoreBounds({ x: 60, y: 100, width: 1180, height: 900 }, [{ workArea: small }]);
    expect(b).not.toBeNull();
    expect(b!.x + b!.width).toBeLessThanOrEqual(small.x + small.width);
    expect(b!.y + b!.height).toBeLessThanOrEqual(small.y + small.height);
  });

  test('a rectangle smaller than the minimum keeps its PLACE and grows to the floor', () => {
    // `minimumSize` prevents this from the UI; a smaller display can still produce it.
    const b = restoreBounds({ x: 300, y: 200, width: 200, height: 100 }, displays);
    expect(b).toEqual({ x: 300, y: 200, width: MIN.width, height: MIN.height });
  });

  test('the resize floor and the restore floor are the SAME number', () => {
    // The host takes its `minSize` from here; a lower one would let the reviewer make a window
    // `restoreBounds` forgets.
    expect(minimumSize(LAPTOP)).toEqual(MIN);
    // Bounded by the display, for the same reason `reviewWindowBounds` is.
    expect(minimumSize({ x: 0, y: 0, width: 600, height: 400 })).toEqual({ width: 600, height: 400 });
  });

  for (const [name, bad] of [
    ['null', null],
    ['not an object', 42],
    ['missing fields', { x: 1, y: 2 }],
    ['NaN', { x: NaN, y: 0, width: 900, height: 700 }],
  ] as [string, unknown][]) {
    test(`refuses ${name}`, () => expect(restoreBounds(bad, displays)).toBeNull());
  }
});

/* The edges the suite above does not reach: the x-axis clamps, the display-centre boundary, and
 * `minimumSize`'s work-area cap. */
describe('restoreBounds: the x axis, pinned like the y axis', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1280, height: 800 } }];

  test('a window hanging off the RIGHT is pulled back inside', () => {
    // `x + width` past the right edge. Clamping only the size would leave it there.
    // Centre still ON the display (700 + 900/2 = 1150), so it is restored rather than refused --
    // and its right edge at 1600 is 320px past the screen.
    const out = restoreBounds({ x: 700, y: 100, width: 900, height: 600 }, displays)!;
    expect(out.x + out.width).toBeLessThanOrEqual(1280);
    expect(out.x).toBe(1280 - out.width);
  });

  test('a window hanging off the LEFT is pushed back inside', () => {
    // A negative x on a display whose work area starts at 0 -- the other end of the same clamp.
    // Centre at -300 + 450 = 150, on the display; the left edge is 300px off it.
    const out = restoreBounds({ x: -300, y: 100, width: 900, height: 600 }, displays)!;
    expect(out.x).toBe(0);
  });

  test('and on a SECONDARY display the clamp is to that display, not to zero', () => {
    // The bug a bare `Math.max(0, x)` would have: correct on the primary, wrong on every other.
    const second = [{ workArea: { x: 1440, y: 0, width: 1280, height: 800 } }];
    // Centre at 1400 + 450 = 1850, inside the secondary work area; the left edge is 40px outside.
    const out = restoreBounds({ x: 1400, y: 10, width: 900, height: 600 }, second)!;
    expect(out.x).toBe(1440);
    expect(out.x + out.width).toBeLessThanOrEqual(1440 + 1280);
  });

  test('the width is clamped to the display as well as the origin', () => {
    // Centre at 800, on the display; the width is 320px wider than it.
    const out = restoreBounds({ x: 0, y: 0, width: 1600, height: 600 }, displays)!;
    expect(out.width).toBe(1280);
    expect(out.x).toBe(0);
  });
});

describe('restoreBounds: the display-centre boundary itself', () => {
  // `cx >= d.x && cx <= d.x + d.width` -- inclusive at both ends. A window whose centre sits
  // exactly on the edge belongs to that display; one pixel further out belongs to none.
  const displays = [{ workArea: { x: 0, y: 0, width: 1000, height: 1000 } }];

  test('a centre exactly on the right edge is accepted', () => {
    // centre x = 900 + 200/2 = 1000, exactly the boundary.
    expect(restoreBounds({ x: 900, y: 400, width: 200, height: 200 }, displays)).not.toBeNull();
  });

  test('a centre exactly on the left edge is accepted', () => {
    expect(restoreBounds({ x: -100, y: 400, width: 200, height: 200 }, displays)).not.toBeNull();
  });

  test('one pixel past it is refused', () => {
    // centre x = 901 + 200/2 = 1001.
    expect(restoreBounds({ x: 901, y: 400, width: 200, height: 200 }, displays)).toBeNull();
    expect(restoreBounds({ x: -101, y: 400, width: 200, height: 200 }, displays)).toBeNull();
  });

  test('the same on the y axis, both ends', () => {
    expect(restoreBounds({ x: 400, y: 900, width: 200, height: 200 }, displays)).not.toBeNull();
    expect(restoreBounds({ x: 400, y: 901, width: 200, height: 200 }, displays)).toBeNull();
    expect(restoreBounds({ x: 400, y: -100, width: 200, height: 200 }, displays)).not.toBeNull();
    expect(restoreBounds({ x: 400, y: -101, width: 200, height: 200 }, displays)).toBeNull();
  });
});

describe('minimumSize is capped by the work area, per axis', () => {
  test('a display bigger than MIN gets MIN', () => {
    expect(minimumSize({ x: 0, y: 0, width: 3000, height: 2000 })).toEqual(MIN);
  });

  test('a display smaller on ONE axis is capped on that axis only', () => {
    // Per axis, not "smaller display wins": a wide, short screen must keep the full MIN width.
    const short = minimumSize({ x: 0, y: 0, width: 3000, height: MIN.height - 100 });
    expect(short.width).toBe(MIN.width);
    expect(short.height).toBe(MIN.height - 100);

    const narrow = minimumSize({ x: 0, y: 0, width: MIN.width - 100, height: 2000 });
    expect(narrow.width).toBe(MIN.width - 100);
    expect(narrow.height).toBe(MIN.height);
  });

  test('and the floor never exceeds the display, which is what it is for', () => {
    // A floor larger than the screen would force a window off the edge.
    for (const area of [
      { x: 0, y: 0, width: 320, height: 240 },
      { x: 0, y: 0, width: MIN.width, height: MIN.height },
      { x: 0, y: 0, width: 1, height: 1 },
    ]) {
      const floor = minimumSize(area);
      expect(floor.width).toBeLessThanOrEqual(area.width);
      expect(floor.height).toBeLessThanOrEqual(area.height);
    }
  });

  test('restoreBounds uses that capped floor, so a tiny display does not re-inflate a window', () => {
    // The floors' equality is pinned above; this pins that the cap travels with it.
    const tiny = [{ workArea: { x: 0, y: 0, width: 400, height: 300 } }];
    const out = restoreBounds({ x: 0, y: 0, width: 380, height: 280 }, tiny)!;
    expect(out.width).toBeLessThanOrEqual(400);
    expect(out.height).toBeLessThanOrEqual(300);
  });
});

/*
 * The View menu's zoom: half a level a press, drawn at 1.2^level (Chromium's step and base, cited
 * in `geometry.cjs`). The level is saved, so a new step or base changes every saved level.
 */
describe('zoom moves half a level a press, drawn at 1.2^level', () => {
  test('each press moves the level by 0.5, with no clamp at 24 presses', () => {
    let level = 0;
    const ins: number[] = [];
    for (let k = 0; k < 24; k++) ins.push((level = zoomLevelAfter(level, 'in')));
    expect(ins[0]).toBe(0.5);
    expect(ins.at(-1)).toBe(12);
    level = zoomLevelAfter(level, 'reset');
    expect(level).toBe(0);
    for (let k = 0; k < 24; k++) level = zoomLevelAfter(level, 'out');
    expect(level).toBe(-12);
  });

  test('the page is drawn at 1.2^level', () => {
    expect(zoomFactor(0)).toBe(1);
    expect(zoomFactor(1)).toBeCloseTo(1.2, 12);
    expect(zoomFactor(12)).toBeCloseTo(8.916100448255996, 9);
    expect(zoomFactor(-12)).toBeCloseTo(0.11215665478461513, 12);
  });

  test('a remembered level comes back, beside bounds restoreBounds still accepts', () => {
    const saved = { x: 100, y: 100, width: 900, height: 700, zoomLevel: 1.5 };
    expect(restoreZoomLevel(saved)).toBe(1.5);
    expect(restoreBounds(saved, [{ workArea: LAPTOP }])).toEqual({ x: 100, y: 100, width: 900, height: 700 });
  });

  test('what the host writes is what the two readers read back', () => {
    const written = windowState({ x: 100.4, y: 120.6, width: 900.2, height: 699.5 }, -1.5);
    expect(written).toEqual({ x: 100, y: 121, width: 900, height: 700, zoomLevel: -1.5 });
    const read = JSON.parse(JSON.stringify(written));
    expect(restoreBounds(read, [{ workArea: LAPTOP }])).toEqual({ x: 100, y: 121, width: 900, height: 700 });
    expect(restoreZoomLevel(read)).toBe(-1.5);
  });

  test('a file with no level, or a garbled one, opens at Actual Size', () => {
    for (const saved of [null, 'x', {}, { zoomLevel: '1' }, { zoomLevel: NaN }, { zoomLevel: Infinity }, { zoomLevel: 24.5 }]) {
      expect(restoreZoomLevel(saved)).toBe(0);
    }
    expect(restoreZoomLevel({ zoomLevel: -24 })).toBe(-24);
  });
});
