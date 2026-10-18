/**
 * The demo: Claude Code in a terminal, the review window opening over it, the reviewer's edits and
 * approval, and the message where it landed. `script.ts` holds the timing and the words.
 *
 * Everything sits on one 1920x1080 "screen" that the camera moves over, as a screen recording's
 * zoom would: the pointer is on the screen, so it scales with the zoom like everything else.
 *
 * Each frame runs in two passes. The first puts the editor in its state at this frame
 * (`applyEdits`); once the window has re-rendered for it and painted, the second draws what can only
 * be measured then, the caret and the chat message's box. A `delayRender` per frame holds the capture
 * until the second pass has painted. The cursor's path and the camera's targets are measured once,
 * when the window loads, by putting the editor in the state each move starts from; each of those
 * states is flushed through the window's React state first, so anything it draws around the editor
 * has moved before the editor is measured.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Editor, JSONContent } from '@tiptap/react';
import { AbsoluteFill, Easing, continueRender, delayRender, interpolate, useCurrentFrame } from 'remotion';
import { ReviewWindow } from './ReviewWindow';
import { BEATS, TERMINAL, TERMINAL_SIZE, Terminal, cellAt, frameAt, inputRowOf, rowOf, textsOf } from './Terminal';
import { clamp, progress } from './motion';
import { CHAT_SIZE, Chat } from './Chat';
import { Caret, Pointer, Ripple, type Point } from './overlays';
import { EndCard } from './EndCard';
import { anchors, applyEdits, installSelection } from './edits';
import { DURATION, FPS, PROMPTS, T } from './script';
import frame from '../dist/frame.json';

const SCREEN = { width: 1920, height: 1080 };
const CENTRE = { x: SCREEN.width / 2, y: SCREEN.height / 2 };
const at = (size: { width: number; height: number }) => ({ x: (SCREEN.width - size.width) / 2, y: (SCREEN.height - size.height) / 2 });
const TERM_AT = at(TERMINAL_SIZE);
const WIN_AT = at(frame);
const CHAT_AT = at(CHAT_SIZE);

/** Each desktop's own wallpaper, so the slide between them reads as motion. Plain stand-ins. */
const WALLPAPER = {
  work: 'radial-gradient(120% 90% at 20% 10%, #1f2a44 0%, #0e1220 55%, #080a10 100%)',
  chat: 'radial-gradient(120% 90% at 80% 10%, #3a2348 0%, #171021 55%, #0a070e 100%)',
};
const DESKTOP_GAP = 60;
const TERM_STYLE = { position: 'absolute', left: TERM_AT.x, top: TERM_AT.y } as const;

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
/** The prompt row of the exchange the video is about, and of the one before it. */
const SENT = `❯ ${PROMPTS[PROMPTS.length - 1]}`;
const EARLIER = `❯ ${PROMPTS[0]}`;

/** Video seconds to recording seconds: the recording's own pace while typing and waiting, its pauses cut. */
const castTime = (t: number) =>
  interpolate(
    t,
    [0, T.typeStart, T.typeEnd, T.sent, T.posting, T.calling, T.answered, T.close, T.closeEnd, DURATION],
    [BEATS.typeStart - 0.3, BEATS.typeStart, BEATS.typeEnd, BEATS.sent, BEATS.posting, BEATS.calling, BEATS.waiting, BEATS.called - 0.05, BEATS.called, BEATS.called + 1.5],
    clamp
  );

interface Cam {
  x: number;
  y: number;
  s: number;
}
const FULL: Cam = { ...CENTRE, s: 1 };

/** Keep the view on the screen: no camera shows past its edge. */
const bounded = ({ x, y, s }: Cam): Cam => ({
  s,
  x: Math.min(Math.max(x, CENTRE.x / s), SCREEN.width - CENTRE.x / s),
  y: Math.min(Math.max(y, CENTRE.y / s), SCREEN.height - CENTRE.y / s),
});
const mix = (a: Cam, b: Cam, p: number): Cam => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), s: lerp(a.s, b.s, p) });

/** A cell's centre on the screen. */
const cellCentre = (col: number, row: number): Point => {
  const c = cellAt(col, row);
  return { x: TERM_AT.x + c.x + TERMINAL.cell.w / 2, y: TERM_AT.y + c.y + TERMINAL.cell.h / 2 };
};

/** While typing: on the prompt box, following the caret; averaged over a moment so it glides. */
function followTyping(t: number): Cam {
  const samples = [0, 0.05, 0.1, 0.15, 0.2].map((d) => {
    const frame = frameAt(castTime(Math.max(0, t - d)));
    const row = inputRowOf(frame);
    return cellCentre(textsOf(frame)[row]!.trimEnd().length, row);
  });
  const s = 1.6;
  const caret = samples.reduce((a, p) => a + p.x, 0) / samples.length;
  // The line's start stays in view until the caret reaches the right side, then the view follows it.
  const start = cellCentre(0, inputRowOf(frameAt(castTime(t)))).x - TERMINAL.cell.w * 2;
  const x = Math.max(start + CENTRE.x / s, caret - CENTRE.x / s + TERMINAL.cell.w * 6);
  return bounded({ x, y: samples[0]!.y - TERMINAL.cell.h * 2, s });
}

/** Once sent: on the exchange, from the prompt to the spinner, as the screen stands when the review starts. */
const ON_EXCHANGE: Cam = (() => {
  const frame = frameAt(BEATS.waiting);
  const a = cellCentre(0, rowOf(frame, SENT));
  const b = cellCentre(0, rowOf(frame, 'Waiting for draftgate'));
  return bounded({ x: a.x + 520, y: (a.y + b.y) / 2, s: 1.7 });
})();

interface Measured {
  /** The cursor's stops, in screen pixels. */
  stops: Record<'bulletsStart' | 'bulletsEnd' | 'firstLineStart' | 'lastLineStart' | 'lastLineCut' | 'lastLineEnd' | 'approve', Point>;
  /** The camera on the draft while it is edited. */
  draft: Cam;
  /** The posted message, as the chat shows it. */
  html: string;
}

/** A viewport point inside the window, as a screen point: unaffected by the camera or the pop-in. */
function toScreen(box: HTMLElement, x: number, y: number): Point {
  const r = box.getBoundingClientRect();
  const k = r.width / box.offsetWidth;
  return { x: WIN_AT.x + (x - r.left) / k, y: WIN_AT.y + (y - r.top) / k };
}

function measure(editor: Editor, initial: JSONContent, box: HTMLElement): Measured {
  const view = editor.view;
  // The window's state follows each edit before anything is measured.
  const settle = (t: number) => flushSync(() => applyEdits(editor, initial, t));
  const point = (t: number, pick: (a: ReturnType<typeof anchors>) => number): Point => {
    settle(t);
    const c = view.coordsAtPos(pick(anchors(editor)));
    return toScreen(box, c.left, (c.top + c.bottom) / 2);
  };
  const stops = {
    bulletsStart: point(T.toBullets, (a) => a.bulletsStart()),
    bulletsEnd: point(T.toBullets, (a) => a.bulletsEnd()),
    firstLineStart: point(T.toTop, (a) => a.firstLineStart()),
    lastLineStart: point(T.toLast, (a) => a.lastLineStart()),
    lastLineCut: point(T.toLast, (a) => a.lastLineCut()),
    lastLineEnd: point(T.toLineEnd, (a) => a.lastLineEnd()),
    approve: (() => {
      const button = [...box.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'));
      if (!button) throw new Error('the review window has no Approve button');
      const r = button.getBoundingClientRect();
      return toScreen(box, r.left + r.width / 2, r.top + r.height / 2);
    })(),
  };

  // The draft's text as it is at its fullest (greeting typed, last line not yet cut), framed with
  // room around it.
  settle(T.toLast);
  const rects: DOMRect[] = [];
  const walk = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(n);
    rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
  }
  const tl = toScreen(box, Math.min(...rects.map((r) => r.left)), Math.min(...rects.map((r) => r.top)));
  const br = toScreen(box, Math.max(...rects.map((r) => r.right)), Math.max(...rects.map((r) => r.bottom)));
  const s = Math.min(1.85, (SCREEN.width * 0.78) / (br.x - tl.x), (SCREEN.height * 0.62) / (br.y - tl.y));
  const draft = bounded({ x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 + 30, s });

  settle(DURATION);
  const html = editor.getHTML();
  settle(0);
  return { stops, draft, html };
}

/** The cursor's moves: where it goes, between which times. */
function cursorAt(t: number, m: Measured): { at: Point; kind: 'arrow' | 'ibeam' } {
  const start: Point = { x: WIN_AT.x + frame.width * 0.78, y: WIN_AT.y + frame.height * 0.82 };
  const moves: [number, number, Point][] = [
    [T.toBullets, T.dragStart - 0.08, m.stops.bulletsStart],
    [T.dragStart, T.dragEnd, m.stops.bulletsEnd],
    [T.toTop, T.clickTop - 0.05, m.stops.firstLineStart],
    [T.toLast, T.selectHasStart - 0.05, m.stops.lastLineStart],
    [T.selectHasStart, T.selectHasEnd, m.stops.lastLineCut],
    [T.toLineEnd, T.clickLineEnd - 0.04, m.stops.lastLineEnd],
    [T.toApprove, T.click - 0.08, m.stops.approve],
  ];
  let pos = start;
  for (const [t0, t1, to] of moves) {
    if (t < t0) break;
    const p = progress(t, t0, t1);
    pos = { x: lerp(pos.x, to.x, p), y: lerp(pos.y, to.y, p) };
  }
  const overText = t >= T.toBullets + 0.25 && t < T.toApprove + 0.2;
  return { at: pos, kind: overText ? 'ibeam' : 'arrow' };
}

function cameraAt(t: number, m: Measured | null, message: Cam | null): Cam {
  if (t < T.zoomTerm) return FULL;
  if (t < T.zoomTermEnd) return mix(FULL, followTyping(t), progress(t, T.zoomTerm, T.zoomTermEnd));
  if (t < T.typeEnd + 0.05) return followTyping(t);
  if (t < T.answered + 0.05) return mix(followTyping(T.typeEnd + 0.05), ON_EXCHANGE, progress(t, T.typeEnd + 0.05, T.answered + 0.05));
  if (t < T.popEnd + 0.15) return mix(ON_EXCHANGE, FULL, progress(t, T.answered + 0.05, T.popEnd + 0.15));
  if (!m) return FULL;
  if (t < T.zoomIn) return FULL;
  if (t < T.zoomOut) return mix(FULL, m.draft, progress(t, T.zoomIn, T.zoomInEnd));
  if (t < T.chatZoom) return mix(m.draft, FULL, progress(t, T.zoomOut, T.zoomOutEnd));
  return message ? mix(FULL, message, progress(t, T.chatZoom, T.chatZoomEnd)) : FULL;
}

const CLICKS = [T.dragStart, T.clickTop, T.selectHasStart, T.clickLineEnd, T.click];

export const Demo = () => {
  const f = useCurrentFrame();
  const t = f / FPS;
  const editorRef = useRef<{ editor: Editor; initial: JSONContent; box: HTMLDivElement } | null>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [pass, setPass] = useState<{ f: number; caret: { x: number; top: number; bottom: number } | null; typing: boolean; message: Cam | null } | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLDivElement | null>(null);

  /*
   * The window's countdown and its warning timers run on `Date.now()` from when the window mounted,
   * which differs from one render tab to the next; the countdown would jump between frames. Frozen
   * for as long as this composition is mounted (before the window mounts, so it reads the frozen
   * clock from the start), it reads the review's full time on every frame, as in the first seconds of
   * a real review. The other compositions keep the real clock.
   */
  const [realNow] = useState(() => {
    const real = Date.now;
    const frozen = real();
    Date.now = () => frozen;
    return real;
  });
  useEffect(() => () => void (Date.now = realNow), [realNow]);

  // Nothing is captured until the window is measured: the window's own hold ends before that.
  const [loading] = useState(() => delayRender('the demo measures the review window'));
  useEffect(() => {
    if (measured) continueRender(loading);
  }, [measured, loading]);

  const onReady = useCallback((box: HTMLDivElement) => {
    const dom = box.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
    const editor = dom?.editor;
    if (!editor) throw new Error('the review window has no editor');
    installSelection(editor);
    const initial = editor.getJSON();
    editorRef.current = { editor, initial, box };
    setMeasured(measure(editor, initial, box));
  }, []);

  useLayoutEffect(() => {
    const ref = editorRef.current;
    if (!ref || !measured) return;
    const handle = delayRender(`frame ${f}`);
    const state = applyEdits(ref.editor, ref.initial, t);
    const painted = (then: () => void) => requestAnimationFrame(() => requestAnimationFrame(then));
    // Measured once the window has re-rendered for this frame's edits and painted.
    painted(() => {
      let caret = null;
      if (state.caret !== null) {
        const c = ref.editor.view.coordsAtPos(state.caret);
        const top = toScreen(ref.box, c.left, c.top);
        const bottom = toScreen(ref.box, c.left, c.bottom);
        caret = { x: top.x, top: top.y, bottom: bottom.y };
      }
      let message: Cam | null = null;
      const screen = screenRef.current;
      if (messageRef.current && screen && t >= T.slideEnd) {
        const s = screen.getBoundingClientRect();
        const k = s.width / SCREEN.width;
        // The row is as wide as the pane; its content (avatar to the longest line) is what to frame.
        const row = messageRef.current.getBoundingClientRect();
        const body = messageRef.current.lastElementChild!.getBoundingClientRect();
        const r = { left: row.left, top: row.top, right: body.right, bottom: row.bottom };
        // The camera's own transform is in that rect; undo it to get screen pixels.
        const cam = cameraAt(t, measured, null);
        const unproject = (x: number, y: number) => ({
          x: CENTRE.x + ((x - s.left) / k - CENTRE.x) / cam.s + (cam.x - CENTRE.x),
          y: CENTRE.y + ((y - s.top) / k - CENTRE.y) / cam.s + (cam.y - CENTRE.y),
        });
        const tl = unproject(r.left, r.top);
        const br = unproject(r.right, r.bottom);
        message = bounded({ x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2, s: 1.6 });
      }
      setPass({ f, caret, typing: state.typing, message });
      painted(() => continueRender(handle));
    });
  }, [f, measured]);

  const here = pass?.f === f ? pass : null;
  const cam = cameraAt(t, measured, here?.message ?? null);
  const translate = { x: -cam.s * (cam.x - CENTRE.x), y: -cam.s * (cam.y - CENTRE.y) };

  const castT = castTime(t);
  const termFrame = frameAt(castT);
  const sentRow = rowOf(termFrame, SENT);
  const firstRow = rowOf(termFrame, EARLIER);
  const crispFrom = sentRow >= 0 ? sentRow : inputRowOf(termFrame) - 1;

  const pop = interpolate(t, [T.pop, T.popEnd], [0, 1], { ...clamp, easing: Easing.out(Easing.back(1.4)) });
  const shut = interpolate(t, [T.close, T.closeEnd], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  const windowOpacity = Math.min(interpolate(t, [T.pop, T.pop + 0.12], [0, 1], clamp), 1 - shut);
  const windowScale = t < T.close ? 0.92 + 0.08 * pop : 1 - 0.04 * shut;
  // Both desktops move together, a gap between them, as a swipe between macOS Spaces does.
  const slide = -progress(t, T.slide, T.slideEnd) * (SCREEN.width + DESKTOP_GAP);
  const cursor = measured ? cursorAt(t, measured) : null;
  const pressed = CLICKS.some((c) => t >= c && t < c + 0.12);
  const ripple = CLICKS.map((c) => (t - c) / 0.45).find((p) => p > 0 && p < 1) ?? 0;
  const blink = here?.typing || Math.floor(t * 2) % 2 === 0;

  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <style>{`.demo-selection { background: rgba(63, 99, 139, 0.85); }`}</style>
      <div
        ref={screenRef}
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${cam.s})`,
          transformOrigin: `${CENTRE.x}px ${CENTRE.y}px`,
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: WALLPAPER.work, transform: `translateX(${slide}px)` }}>
          {/* Off-screen once the desktop has slid away; the review window stays mounted for its editor. */}
          {t < T.slideEnd && <Terminal frame={termFrame} blurFrom={Math.max(firstRow, 0)} blurTo={crispFrom} style={TERM_STYLE} />}
          <ReviewWindow
            dark
            onReady={onReady}
            style={{ position: 'absolute', left: WIN_AT.x, top: WIN_AT.y, opacity: windowOpacity, transform: `scale(${windowScale})` }}
          />
          {here?.caret && t >= T.pop && t < T.close && <Caret x={here.caret.x} top={here.caret.top} bottom={here.caret.bottom} visible={blink} />}
          {cursor && t >= T.pop && t < T.close + 0.1 && (
            <>
              <Ripple at={cursor.at} progress={ripple} />
              <Pointer at={cursor.at} kind={cursor.kind} pressed={pressed} />
            </>
          )}
        </div>
        {t >= T.slide && (
          <div style={{ position: 'absolute', inset: 0, background: WALLPAPER.chat, transform: `translateX(${slide + SCREEN.width + DESKTOP_GAP}px)` }}>
            <Chat html={measured?.html ?? ''} messageRef={(el) => (messageRef.current = el)} style={{ position: 'absolute', left: CHAT_AT.x, top: CHAT_AT.y }} />
          </div>
        )}
      </div>
      <EndCard t={t} start={T.endCard} end={T.endCardEnd} />
    </AbsoluteFill>
  );
};
