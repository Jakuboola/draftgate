/**
 * Characters in a single-line prose field that the review window cannot show.
 *
 * An `<input>` strips CR and LF from what it displays (HTML's value sanitization, every engine):
 * `'Fix crash\nSecond line'` reads back `'Fix crashSecond line'`, while the window sends the break.
 * The C0/C1 and bidi controls draw nothing, or (U+202E) reverse what is drawn.
 *
 * PROBED:
 *
 *     Jira `summary` (PUT)     LF  -> 400 "The summary is invalid because it contains newline
 *                                     characters.", nothing written. TAB -> 204, stored verbatim.
 *     GitHub issue `title`     LF, CR, TAB, U+202E -> stored verbatim.
 *     Linear issue `title`     LF -> stored as a SPACE. CR, U+202E -> stored verbatim.
 *
 * A break is an `error` only where probed refused, a `warning` elsewhere; each destination's fate
 * is `DestinationProfile.lineBreaks`. TAB is not flagged: the input draws it as a gap.
 */

import { warn, type Warning } from './warnings';

/** What a destination does with one kind of line break in a single-line field. */
export type LineBreakFate = 'refused' | 'stored' | 'space' | 'unprobed';

/**
 * What a destination does with a break in one line field, and the tools that was probed on, scoped
 * and keyed like `LineLimit` (`DestinationProfile.lineBreaks[field]`). A field or tool with no fact
 * is `unprobed` for both breaks.
 */
export interface LineBreakFact {
  readonly lf: LineBreakFate;
  readonly cr: LineBreakFate;
  readonly tools: RegExp;
}

/**
 * How the window draws a break it would otherwise strip: the control pictures U+240A (LF) and
 * U+240D (CR), mapped back on every change. Identity when the agent's value already holds a picture
 * (`Legend: U+240A = newline`), else mapping back would turn it into a break nobody typed;
 * `prose/line-break` still names any break. Otherwise exact inverses, so an untouched field sends
 * the agent's value byte for byte.
 */
const PICTURE = { '\n': '\u240A', '\r': '\u240D' } as const;
const BREAK = { '\u240A': '\n', '\u240D': '\r' } as const;
const PICTURE_RE = /[\u240A\u240D]/;

export function showLineBreaks(value: string, agentValue: string): string {
  if (PICTURE_RE.test(agentValue)) return value;
  return value.replace(/[\r\n]/g, (c) => PICTURE[c as '\n' | '\r']);
}

export function hideLineBreaks(shown: string, agentValue: string): string {
  if (PICTURE_RE.test(agentValue)) return shown;
  return shown.replace(/[\u240A\u240D]/g, (c) => BREAK[c as keyof typeof BREAK]);
}

/**
 * What draws nothing, or changes what is drawn, in a line field. Escapes throughout: a literal bidi
 * control reverses how the rest of the source line displays in an editor and a diff.
 *
 *  - C0 controls except TAB, LF and CR (TAB draws as a gap; the breaks have their own code), DEL,
 *    and C1.
 *  - U+2028 / U+2029, the line and paragraph separators: a destination may store either as a break.
 *    Not probed, so a warning here rather than a fate in `lineBreaks`. (`cli/src/text.ts`'s
 *    `CONTROLS` escapes C0, C1 and these two when it prints, but not the bidi or zero-width ones.)
 *  - The bidi controls: ALM, LRM, RLM, the embeddings and overrides (U+202A-U+202E), the isolates
 *    (U+2066-U+2069).
 *  - Zero-width U+200B, U+2060 and U+FEFF: `render.ts`'s `ZERO_WIDTH_RE` minus the joiners
 *    U+200C/U+200D, which emoji and several scripts need.
 */
const CONTROL_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/;

function codePointName(c: string): string {
  return `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Worded for both readers: the reviewer in the window, and the agent reading the CLI backstop's
 * denial under `auto-approve`, where there is no picture.
 */
function breakMessage(field: string, which: string, fate: LineBreakFate): string {
  const holds = `${field} holds a ${which}, which a one-line field cannot show`;
  switch (fate) {
    case 'refused':
      return `${holds}, and this destination refuses the whole call for it. Put it on one line.`;
    case 'stored':
      return `${holds}. This destination stores it as it is, so the field arrives on two lines.`;
    case 'space':
      return `${holds}. This destination stores it as a space.`;
    case 'unprobed':
      return `${holds}. What this destination does with it has not been measured.`;
  }
}

/** The `prose/line-break` and `prose/control-character` warnings for one line field. */
export function lineCharacterWarnings(
  field: string,
  value: string,
  fact: LineBreakFact | undefined,
  toolName: string | undefined
): Warning[] {
  const probed = fact !== undefined && toolName !== undefined && fact.tools.test(toolName) ? fact : undefined;
  const out: Warning[] = [];
  for (const [char, which, fate] of [
    ['\n', 'line break', probed?.lf ?? 'unprobed'],
    ['\r', 'carriage return', probed?.cr ?? 'unprobed'],
  ] as const) {
    if (!value.includes(char)) continue;
    out.push(
      warn({
        code: 'prose/line-break',
        severity: fate === 'refused' ? 'error' : 'warning',
        field,
        message: breakMessage(field, which, fate),
      })
    );
  }
  const control = CONTROL_RE.exec(value);
  if (control !== null) {
    out.push(
      warn({
        code: 'prose/control-character',
        severity: 'warning',
        field,
        message:
          `${field} holds an invisible control character (${codePointName(control[0])}), ` +
          'which is sent as it is and can change or hide what the field shows.',
      })
    );
  }
  return out;
}
