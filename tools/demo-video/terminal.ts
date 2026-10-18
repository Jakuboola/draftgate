/**
 * The terminal scene's frames, taken from a real Claude Code session recording.
 *
 * `bun terminal.ts <session.cast>` replays an asciicast v2 recording (`record/record.py` makes one)
 * through a headless xterm and writes `recording/terminal.json`: every distinct screen from the end
 * of the session's first exchange to the Ctrl-C that closes it, as styled runs of cells, keyed by the
 * time in the recording. The video picks the latest screen at or before the recording time it maps
 * a frame to, so what the terminal shows is what Claude Code drew, frame for frame. Startup (the
 * folder-trust dialog names the recording's directory) is never captured.
 *
 * The recording is the operator's own session, so it is never committed. What is committed is this
 * file's output, cleaned at the cell level: the rows below that describe the recording machine
 * (its path, plan, login notice, and every row below the prompt box: the operator's own status and
 * mode lines) are rewritten or blanked. Where a dropped row frees a line and the screen has scrolled,
 * the line goes back to the row that scrolled off the top, read from the session's first screen
 * (the header there does not change), so the cleaned screen scrolls when its own content fills it,
 * as a session without those rows would. Claude Code redraws in place, so the terminal's own
 * scrollback holds stale copies and is not read.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import xterm from '@xterm/headless';
import { RULE, inputOf, textOf, type Row, type Run } from './src/recording';

/** What each machine-specific row becomes. A row matching none is kept as recorded. */
const SCRUB: { match: RegExp; replace: (row: string) => string | null }[] = [
  { match: /^\s*⚠ Your login expires/, replace: () => null },
  { match: /Your login expires in/, replace: () => '' },
  // The header's third row: the logo's feet, then the working directory.
  { match: /^\s*▝▝\s+▝▝\s+\S/, replace: (row) => row.replace(/(▝▝\s+▝▝\s+)\S.*$/, '$1~/shop') },
  { match: / · Claude \w+\s*$/, replace: (row) => row.replace(/ · Claude \w+\s*$/, '') },
];

/**
 * Claude Code appends `…` to a hook's status message, so a message that ends in its own dots shows
 * both. Cut, the spinner reads as `adapters/hook/src/hookCommand.ts` writes the message.
 */
const ELLIPSIS = '...…';

const castPath = process.argv[2];
if (!castPath) throw new Error('usage: bun terminal.ts <session.cast>');
const lines = readFileSync(castPath, 'utf8').trim().split('\n');
const header = JSON.parse(lines[0]!);
const term = new xterm.Terminal({ cols: header.width, rows: header.height, allowProposedApi: true });

/** xterm's own default 16-colour palette; the recording asked for truecolor, so few cells use it. */
const PALETTE = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

function colour(mode: 'fg' | 'bg', cell: xterm.IBufferCell): string | undefined {
  const rgb = mode === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const pal = mode === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const v = mode === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return `#${v.toString(16).padStart(6, '0')}`;
  if (pal) {
    if (v < 16) return PALETTE[v];
    if (v < 232) {
      const c = v - 16;
      const step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
      return `#${[Math.floor(c / 36), Math.floor(c / 6) % 6, c % 6].map((n) => step(n).toString(16).padStart(2, '0')).join('')}`;
    }
    const g = (8 + (v - 232) * 10).toString(16).padStart(2, '0');
    return `#${g}${g}${g}`;
  }
  return undefined;
}

/** Whether the program has the cursor shown (DECTCEM), from the last `?25h` / `?25l` it wrote. */
let cursorShown = true;

/** The visible screen, as styled rows. */
function snapshot(): Row[] {
  const buf = term.buffer.active;
  const cursor = cursorShown && buf.viewportY === buf.baseY ? { x: buf.cursorX, y: buf.cursorY } : null;
  const rows: Row[] = [];
  const cell = buf.getNullCell();
  for (let y = 0; y < header.height; y++) {
    const line = buf.getLine(buf.viewportY + y)!;
    const row: Row = [];
    for (let x = 0; x < header.width; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      const run: Run = { t: cell.getChars() || ' ' };
      let fg = colour('fg', cell);
      let bg = colour('bg', cell);
      if (cell.isInverse()) [fg, bg] = [bg ?? 'default-bg', fg ?? 'default-fg'];
      if (fg) run.fg = fg;
      if (bg) run.bg = bg;
      if (cell.isBold()) run.b = 1;
      if (cell.isDim()) run.d = 1;
      if (cell.isItalic()) run.i = 1;
      if (cursor && cursor.x === x && cursor.y === y) run.c = 1;
      if (cell.getWidth() === 2) run.w = 2;
      const last = row[row.length - 1];
      if (last && !last.c && !run.c && !last.w && !run.w && last.fg === run.fg && last.bg === run.bg && last.b === run.b && last.d === run.d && last.i === run.i) last.t += run.t;
      else row.push(run);
    }
    rows.push(row);
  }
  return rows;
}

/** Rewrite a row's text in place, keeping the first run's style for what replaces it. */
function retext(row: Row, text: string): Row {
  if (text === textOf(row)) return row;
  // A rewrite keeps styling only where the text before the change is unchanged; past it the row
  // takes the style of the run the change starts in.
  const old = textOf(row);
  let same = 0;
  while (same < old.length && same < text.length && old[same] === text[same]) same++;
  const out: Row = [];
  let pos = 0;
  for (const r of row) {
    if (pos + r.t.length <= same) out.push(r);
    else {
      out.push({ ...r, t: text.slice(pos) });
      return out;
    }
    pos += r.t.length;
  }
  if (pos < text.length) out.push({ t: text.slice(pos) });
  return out;
}

/** Remove `n` characters at `at`, every run keeping its style; the rest of the row moves left. */
function cut(row: Row, at: number, n: number): Row {
  let pos = 0;
  return row.map((r) => {
    const start = pos;
    pos += r.t.length;
    const lo = Math.max(at, start) - start;
    const hi = Math.min(at + n, pos) - start;
    return lo < hi ? { ...r, t: r.t.slice(0, lo) + r.t.slice(hi) } : r;
  });
}

/**
 * Rule rows (`────`) drawn whole. A character split across two reads of the recording reaches the
 * terminal as replacement glyphs, which wrap the rule onto the next row; the repair draws the rule
 * as the program meant it.
 */
function rules(rows: Row[]): Row[] {
  return rows.map((row, i) => {
    const text = textOf(row);
    if (RULE.test(text)) return [{ ...row[0]!, t: '─'.repeat(header.width) }];
    if (i > 0 && RULE.test(textOf(rows[i - 1]!)) && /^─{1,10}\s*$/.test(text)) return [{ t: '' }];
    return row;
  });
}

const blank = (row: Row | undefined) => row !== undefined && textOf(row).trim() === '';

/** One row through the scrub list: rewritten, kept, or null to drop. */
function scrubRow(row: Row): Row | null {
  let text = textOf(row);
  let next: Row = row;
  for (const s of SCRUB) {
    if (!s.match.test(text)) continue;
    const r = s.replace(text);
    if (r === null) return null;
    next = retext(next, r);
    text = r;
  }
  return text.includes(ELLIPSIS) ? cut(next, text.indexOf(ELLIPSIS), ELLIPSIS.length - 1) : next;
}

/** The screen a session without the machine's rows would show. `first` is the session's first screen. */
function scrub(recorded: Row[], first: Row[]): Row[] {
  const rows = rules(recorded);
  const input = inputOf(rows.map(textOf));
  // Below the prompt box's closing rule: the operator's status and mode lines.
  const closing = input >= 0 ? rows.findIndex((r, j) => j > input && RULE.test(textOf(r))) : -1;
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (closing >= 0 && i > closing) {
      out.push([{ t: '' }]);
      continue;
    }
    const next = scrubRow(rows[i]!);
    if (next) out.push(next);
    // A dropped row between two blank ones takes one of them with it, as if it had never been drawn.
    else if (blank(out[out.length - 1]) && blank(rows[i + 1])) i++;
  }
  const at = inputOf(out.map(textOf));
  if (at < 0) return out;
  const top = at - 1;
  const bottom = out.slice(top);
  let above = out.slice(0, top);
  const freed = header.height - out.length;
  // The rows that scrolled off the top, from the first screen, as many as the dropped rows freed.
  const firstRows = rules(first);
  const from = firstRows.map(textOf).indexOf(textOf(rows[0]!));
  if (freed > 0 && from > 0) {
    const back = firstRows.slice(Math.max(0, from - freed), from).map(scrubRow).filter((r): r is Row => r !== null);
    above = [...back, ...above];
  }
  const room = header.height - bottom.length;
  above = above.slice(-room);
  return [...above, ...Array.from({ length: room - above.length }, () => [{ t: '' }]), ...bottom];
}

const frames: { t: number; rows: Row[] }[] = [];
let last = '';
let capturing = false;
let first: Row[] = [];
for (const l of lines.slice(1)) {
  const [t, kind, data] = JSON.parse(l);
  if (kind !== 'o') continue;
  await new Promise<void>((r) => term.write(data, r));
  const shown = [...data.matchAll(/\x1b\[\?25([hl])/g)].pop();
  if (shown) cursorShown = shown[1] === 'h';
  const screen = snapshot();
  // From the first reply on screen (startup and the first prompt are not part of any scene) to the
  // Ctrl-C that ends the recording, when the prompt box goes.
  if (!capturing && screen.some((r) => textOf(r).startsWith('⏺'))) {
    capturing = true;
    first = screen;
  }
  if (!capturing) continue;
  if (inputOf(rules(screen).map(textOf)) < 0 || screen.some((r) => textOf(r).includes('Press Ctrl-C again'))) break;
  const rows = scrub(screen, first);
  const key = JSON.stringify(rows);
  if (key === last) continue;
  last = key;
  frames.push({ t: Math.round(t * 1000) / 1000, rows });
}

/**
 * A screen that lasts under this long is Claude Code midway through a redraw (it clears and rewrites
 * in place): a terminal repainting at 60 Hz would almost never show it, so neither does the video.
 * Typing and the spinner change at 50 ms and slower.
 */
const TRANSIENT = 0.03;
const lasting = frames.filter((f, i) => i === frames.length - 1 || frames[i + 1]!.t - f.t >= TRANSIENT);
frames.splice(0, frames.length, ...lasting);

const out = join(import.meta.dir, 'recording');
mkdirSync(out, { recursive: true });
// Each distinct row once; a frame is a list of indexes into it. Most rows repeat across frames.
const table: Row[] = [];
const index = new Map<string, number>();
const indexed = frames.map((f) => ({
  t: f.t,
  rows: f.rows.map((r) => {
    const k = JSON.stringify(r);
    if (!index.has(k)) {
      index.set(k, table.length);
      table.push(r);
    }
    return index.get(k)!;
  }),
}));
writeFileSync(
  join(out, 'terminal.json'),
  `${JSON.stringify({ cols: header.width, rows: header.height, table, frames: indexed })}\n`
);
process.stderr.write(`demo-video: ${frames.length} terminal frames -> ${out}/terminal.json\n`);
