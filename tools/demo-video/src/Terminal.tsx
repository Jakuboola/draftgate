/**
 * The terminal, drawn from `recording/terminal.json` (`terminal.ts`): the screen Claude Code drew at
 * a given time in the recording, cell for cell.
 *
 * Each cell sits in a fixed-width slot, so a glyph the monospace face lacks (`⏺`, `✻`, the logo's
 * blocks) falls back to another face without pushing the rest of its row sideways, as a terminal
 * would. Rows in `blurRows` are blurred: the earlier conversation is there, as it is in a real
 * session, but it is not what the scene is about.
 *
 * The window chrome and the colours a recording leaves at their defaults are a stand-in dark
 * terminal, not a measured one.
 */
import { memo, type CSSProperties } from 'react';
import recording from '../recording/terminal.json';
import { inputOf, textOf, type Run } from './recording';
import { TrafficLights } from './overlays';
import { PROMPTS, REPLY } from './script';

const DEFAULT = { fg: '#e6e6e6', bg: '#16171d' };
export const TERMINAL = {
  cols: recording.cols,
  rows: recording.rows,
  cell: { w: 17, h: 31 },
  pad: 22,
  titleBar: 36,
};
export const TERMINAL_SIZE = {
  width: TERMINAL.cols * TERMINAL.cell.w + TERMINAL.pad * 2,
  height: TERMINAL.rows * TERMINAL.cell.h + TERMINAL.pad * 2 + TERMINAL.titleBar,
};

const table = recording.table as Run[][];
/** Each distinct row's text, once: every reading below searches these, not the runs. */
const tableText = table.map(textOf);
const frames = recording.frames as { t: number; rows: number[] }[];

/** The index of the screen at or before `t` seconds into the recording. */
export function frameAt(t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A screen's rows, as text. */
export const textsOf = (frame: number) => frames[frame]!.rows.map((i) => tableText[i]!);

/** The first row of a screen whose text contains `needle`, or -1. */
export const rowOf = (frame: number, needle: string) => textsOf(frame).findIndex((r) => r.includes(needle));

/** The prompt box's row in a screen. */
export const inputRowOf = (frame: number) => inputOf(textsOf(frame));

/** A cell's top-left in the terminal window's own pixels. */
export function cellAt(col: number, row: number): { x: number; y: number } {
  return {
    x: TERMINAL.pad + col * TERMINAL.cell.w,
    y: TERMINAL.titleBar + TERMINAL.pad + row * TERMINAL.cell.h,
  };
}

function Cells({ run }: { run: Run }) {
  const style: CSSProperties = {
    color: run.c ? DEFAULT.bg : run.fg === 'default-fg' ? DEFAULT.fg : run.fg ?? DEFAULT.fg,
    background: run.c ? DEFAULT.fg : run.bg === 'default-bg' ? DEFAULT.bg : run.bg,
    fontWeight: run.b ? 700 : 400,
    fontStyle: run.i ? 'italic' : 'normal',
    opacity: run.d ? 0.6 : 1,
    display: 'inline-block',
    width: TERMINAL.cell.w * (run.w ?? 1),
    textAlign: 'center',
  };
  return (
    <>
      {[...run.t].map((ch, i) => (
        <span key={i} style={style}>
          {ch === ' ' ? '\u00a0' : ch}
        </span>
      ))}
    </>
  );
}

interface TerminalProps {
  /** The recorded screen to draw (`frameAt`). */
  frame: number;
  /** Rows `[from, to)` are blurred. */
  blurFrom: number;
  blurTo: number;
  style?: CSSProperties;
}

/** Memoised on its props: a frame's second render pass, and frames that share a screen, redraw nothing. */
export const Terminal = memo(({ frame, blurFrom, blurTo, style }: TerminalProps) => (
  <div
    style={{
      ...TERMINAL_SIZE,
      background: DEFAULT.bg,
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: '0 30px 80px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.07)',
      position: 'relative',
      ...style,
    }}
  >
    <div
      style={{
        height: TERMINAL.titleBar,
        background: '#24252c',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        font: '14px -apple-system, BlinkMacSystemFont, sans-serif',
        color: '#9a9aa2',
      }}
    >
      <TrafficLights left={14} />
      claude · ~/shop
    </div>
    <div
      style={{
        padding: TERMINAL.pad,
        font: `${Math.round(TERMINAL.cell.w / 0.6)}px/${TERMINAL.cell.h}px Menlo, "SF Mono", monospace`,
        whiteSpace: 'pre',
      }}
    >
      {frames[frame]!.rows.map((i, y) => (
        <div key={y} style={{ height: TERMINAL.cell.h, ...(y >= blurFrom && y < blurTo ? { filter: 'blur(7px)', opacity: 0.55 } : {}) }}>
          {table[i]!.map((run, j) => (
            <Cells key={j} run={run} />
          ))}
        </div>
      ))}
    </div>
  </div>
));

/** The time of the first recorded screen whose rows satisfy `test`; throws if none does. */
function firstTime(test: (rows: string[]) => boolean, label: string): number {
  for (let f = 0; f < frames.length; f++) if (test(textsOf(f))) return frames[f]!.t;
  throw new Error(`the recording never shows ${label}`);
}

const has = (needle: string) => (rows: string[]) => rows.some((r) => r.includes(needle));
const typedInput = (rows: string[]) => (rows[inputOf(rows)] ?? '').replace(/^❯\s?/, '').trimEnd();

/**
 * The beats of the recording, found in it rather than written down, so a new recording needs no
 * edit here: when typing starts and ends, when the prompt is sent, and when each line appears. The
 * prompt and the reply are `draft.json`'s, the copy the recording was made from.
 */
export const BEATS = (() => {
  const prompt = PROMPTS[PROMPTS.length - 1]!;
  return {
    typeStart: firstTime((r) => typedInput(r).length > 0, 'the prompt being typed'),
    typeEnd: firstTime((r) => typedInput(r) === prompt, 'the whole prompt typed'),
    sent: firstTime((r) => typedInput(r) === '' && has(`❯ ${prompt}`)(r), 'the prompt sent'),
    posting: firstTime(has(REPLY), 'the agent answering'),
    calling: firstTime(has('Calling claude_ai_Slack'), 'the tool call'),
    waiting: firstTime(has('Waiting for draftgate review'), 'the review starting'),
    called: firstTime(has('Called claude_ai_Slack'), 'the tool call finishing'),
  };
})();
