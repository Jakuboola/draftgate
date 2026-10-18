/**
 * Where the review window goes, and how big it is.
 *
 * CommonJS with no imports, so the arithmetic is unit-testable without a window and the WebKit host
 * (`surface/host/draftgate.m`) runs it unchanged in JavaScriptCore. The host supplies the work area
 * (`visibleFrame`) of the display the cursor is on; everything here is pure.
 *
 * Coordinates are top-left (origin at the primary display's top-left, y down), not AppKit's: the
 * host converts, and every saved `window.json` is in these.
 *
 * Sized from the display (a fixed size is most of a laptop screen or a stamp on a 5K) and placed on
 * the cursor's display, not the primary one. It does not fill the screen: the terminal behind it
 * stays visible. It cannot centre on the terminal itself, because another application's window
 * bounds need Accessibility permission.
 */

/** Fraction of the display's work area, so a near-fullscreen terminal shows around all four edges. */
const FRACTION = { width: 0.64, height: 0.72 };

/** Below this the editor stops being usable; above it the window stops feeling like an overlay. */
const MIN = { width: 720, height: 520 };
const MAX = { width: 1180, height: 900 };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * The smallest window the host lets the reviewer make: its `minSize`. One floor, not a host copy: a
 * host floor below `MIN` makes a window `restoreBounds` will not reopen at that size. Bounded by the
 * work area, so a small screen is not forced off its edge.
 */
function minimumSize(workArea) {
  return {
    width: Math.min(MIN.width, workArea.width),
    height: Math.min(MIN.height, workArea.height),
  };
}

/**
 * Bounds for a review window on the given work area (`{ x, y, width, height }`, menu bar and dock
 * excluded, offset by the display's position, so a secondary monitor works). A display smaller than
 * `MIN` wins over the floor.
 */
function reviewWindowBounds(workArea) {
  const floor = minimumSize(workArea);
  const width = clamp(
    Math.round(workArea.width * FRACTION.width),
    floor.width,
    Math.min(MAX.width, workArea.width)
  );
  const height = clamp(
    Math.round(workArea.height * FRACTION.height),
    floor.height,
    Math.min(MAX.height, workArea.height)
  );
  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
  };
}

/**
 * Bounds to reuse from a previous review, if they are still usable.
 *
 * The window remembers instead of detecting the terminal: its rectangle is not available.
 * `TERM_PROGRAM` and the `GHOSTTY_*`/`CMUX_*` variables can name the wrong application (shell
 * profiles export them regardless of what is on screen); Ghostty's AppleScript dictionary exposes
 * only actions, `bounds` appears zero times; the rest is System Events, i.e. Accessibility
 * permission. The first review lands centred on the cursor's display, and after one drag or resize
 * every review opens there.
 *
 * The round trip must be exact, or the window walks across the screen one review at a time.
 * `surface:host` holds the conversion: a rectangle goes into AppKit's coordinates and comes back
 * unchanged. Where a review window then lands is not verified (a harness window is off every screen).
 *
 * Spaces are not remembered: each review is a new host process, and a new window opens on the
 * ACTIVE Space. Keep it so, a window pinned to a Space the reviewer left looks like a hung send.
 *
 * Returns `null` when the rectangle cannot be trusted (saved on a monitor no longer connected), so
 * the caller centres. Anything else is clamped, size and origin, into the work area of the display
 * the rectangle's centre lands on.
 */
function restoreBounds(saved, displays) {
  if (!saved || typeof saved !== 'object') return null;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;

  // The CENTRE must land on a connected display, not merely overlap one: a clipped corner is still
  // a window you cannot read or drag.
  const cx = x + width / 2;
  const cy = y + height / 2;
  const home = displays.find(
    (d) =>
      cx >= d.workArea.x &&
      cx <= d.workArea.x + d.workArea.width &&
      cy >= d.workArea.y &&
      cy <= d.workArea.y + d.workArea.height
  );
  if (!home) return null;

  const area = home.workArea;
  const floor = minimumSize(area);

  // Size first, then origin, and both are clamped. Clamping only the size, to the display's height
  // rather than the room below `y`, restores a 1180x900 rectangle saved at y=100 on a 1280x720
  // screen as 1180x720 at y=100: bottom edge at 820, Reject and `Approve & send` off the screen.
  // Sizes are clamped up to the floor too, keeping the reviewer's placement.
  const w = Math.round(clamp(width, floor.width, area.width));
  const h = Math.round(clamp(height, floor.height, area.height));
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - w)),
    y: Math.round(clamp(y, area.y, area.y + area.height - h)),
    width: w,
    height: h,
  };
}

/**
 * The View menu's zoom, which the WebKit host spells itself (Cmd+Plus, Cmd+-, Cmd+0): each Zoom In
 * or Zoom Out moves the zoom LEVEL by 0.5, the host sets `pageZoom` to 1.2^level, Actual Size is
 * level 0, and nothing clamps (level +-12 is factor 8.92 and 0.112). The scale is Chromium's zoom
 * level, measured off Electron 44.3.0's zoom menu roles (level 1 read back as factor 1.2; 24 presses
 * reached +-12 unclamped), so the keys step as they do elsewhere.
 *
 * The level persists beside the window's bounds in `DRAFTGATE_WINDOW_STATE`, which `restoreBounds`
 * reads without looking at the extra key. A `window.json` with no `zoomLevel` opens at level 0.
 */
const ZOOM = { step: 0.5, base: 1.2 };

/** The level after one of the View menu's three items: `in`, `out` or `reset`. */
function zoomLevelAfter(level, item) {
  if (item === 'reset') return 0;
  return level + (item === 'in' ? ZOOM.step : -ZOOM.step);
}

/** The factor a level draws the page at. */
function zoomFactor(level) {
  return Math.pow(ZOOM.base, level);
}

/**
 * The remembered level, or 0. Only a corrupt file is refused: beyond `ZOOM_REMEMBERED` steps either
 * way (48 presses of one key; Actual Size undoes any of it) the level would open a review at a
 * factor nothing can read.
 */
const ZOOM_REMEMBERED = 24;
function restoreZoomLevel(saved) {
  const level = saved && typeof saved === 'object' ? saved.zoomLevel : undefined;
  if (typeof level !== 'number' || !Number.isFinite(level)) return 0;
  return Math.abs(level) <= ZOOM_REMEMBERED ? level : 0;
}

/**
 * What the host writes to `DRAFTGATE_WINDOW_STATE`: the bounds in whole pixels (the last frame
 * neither zoomed nor full screen, top-left coordinates) and the zoom level. Spelled once, here
 * beside its two readers, so a `bun test` can put it through them.
 */
function windowState(bounds, zoomLevel) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    zoomLevel,
  };
}

module.exports = {
  reviewWindowBounds,
  restoreBounds,
  minimumSize,
  zoomLevelAfter,
  zoomFactor,
  restoreZoomLevel,
  windowState,
  MIN,
  MAX,
};
