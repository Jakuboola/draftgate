/**
 * The terminal recording's format and the readings of it both sides need: `terminal.ts` writes
 * `recording/terminal.json` in it and `Terminal.tsx` draws from it. One copy, so the producer and the
 * consumer cannot disagree about which row is the prompt box.
 */

/** A run of cells sharing one style. */
export interface Run {
  t: string;
  fg?: string;
  bg?: string;
  b?: 1;
  d?: 1;
  i?: 1;
  /** The terminal's own cursor is on this cell, drawn as a block. */
  c?: 1;
  /** A wide character, two cells, as xterm measured it: always a run of its own. */
  w?: 2;
}
export type Row = Run[];

export const textOf = (row: Row) => row.map((r) => r.t).join('');

/** A rule row (`────`); a replacement glyph inside one is a split character, repaired by `terminal.ts`. */
export const RULE = /^─{10}[─�]*\s*$/;

/** The prompt box's row: a row that starts with the prompt mark, directly under a rule; -1 if none. */
export function inputOf(rows: readonly string[]): number {
  for (let i = rows.length - 1; i > 0; i--) if (rows[i]!.startsWith('❯') && RULE.test(rows[i - 1]!)) return i;
  return -1;
}
