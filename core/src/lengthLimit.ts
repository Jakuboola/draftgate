/**
 * How long a destination lets a message be, and how to count it.
 *
 * Past a limit the destination refuses the call after approval (Jira 400 `CONTENT_LIMIT_EXCEEDED`,
 * GitHub 422, Linear `INVALID_INPUT`, Slack `msg_too_long`), so a body certainly over it is an
 * `error` and sets `blocked`. Every number below was PROBED.
 *
 * A limit is a bracket: the longest value seen accepted and the shortest seen refused. Adjacent, it
 * is exact; apart (a GitHub title: accepted at 1,024, refused at 4,096), the gap is a `warning`.
 *
 * GitHub counts UTF-8 bytes, probed both ways (262,144 ASCII accepted; 131,073 x `é`, 262,146 bytes,
 * refused). The others say "characters" and were probed only in ASCII, so they count code points,
 * the smallest plausible count: "certainly over" stays certain, at the price of an unwarned refusal
 * the other way. No `TextEncoder` (`core` compiles at `types: []`), so both counts are loops.
 */

import { warn, type Warning, type WarningCode } from './warnings';

export type LengthUnit = 'characters' | 'utf8-bytes';

export interface LengthLimit {
  /** The longest value a probe saw accepted. */
  readonly accepted: number;
  /** The shortest value a probe saw refused. `accepted + 1` when the limit is exact. */
  readonly refused: number;
  readonly unit: LengthUnit;
}

/** Code points, not UTF-16 code units: a surrogate pair is one. See the header for why. */
export function codePointLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}

/** What `TextEncoder` would produce, a lone surrogate encoding as U+FFFD (three bytes) like it. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export function measure(s: string, unit: LengthUnit): number {
  return unit === 'utf8-bytes' ? utf8Length(s) : codePointLength(s);
}

/**
 * Where a length falls against a limit: `over` (certainly refused), `unknown` (between the last
 * value seen accepted and the first seen refused), or `within`.
 */
type LimitVerdict = 'within' | 'unknown' | 'over';

export function judge(length: number, limit: LengthLimit): LimitVerdict {
  if (length >= limit.refused) return 'over';
  if (length > limit.accepted) return 'unknown';
  return 'within';
}

/**
 * A limit on a single-line prose field, and the tools it was probed on (matched on the tool half, so
 * any server prefix counts). A same-named field on another tool gets no claim.
 */
export interface LineLimit extends LengthLimit {
  readonly tools: RegExp;
}

/** `12,000`, the way the probes and every message here write a number. Locale-free, like `core`. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function unitWord(unit: LengthUnit): string {
  return unit === 'utf8-bytes' ? 'bytes' : 'characters';
}

/**
 * What a value earns against its destination's limit: an `error` past the shortest value seen
 * refused, a `warning` inside an unresolved bracket, nothing within. One builder for a body and a
 * title. `subject` is what the message is about ("This draft", `title`), `refuses` what the
 * destination was seen refusing ("Slack refuses a message"). An exact limit reads "over N"; a
 * bracket names both ends.
 */
export function lengthWarnings(opts: {
  code: WarningCode;
  subject: string;
  value: string;
  limit: LengthLimit;
  refuses: string;
  field?: string;
}): Warning[] {
  const { code, subject, value, limit, refuses, field } = opts;
  const length = measure(value, limit.unit);
  const verdict = judge(length, limit);
  if (verdict === 'within') return [];
  const n = `${subject} is ${formatCount(length)} ${unitWord(limit.unit)} long`;
  const exact = limit.refused === limit.accepted + 1;
  return [
    warn({
      code,
      ...(field === undefined ? {} : { field }),
      ...(verdict === 'over'
        ? {
            severity: 'error' as const,
            message:
              `${n}, and ${refuses} ` +
              (exact ? `over ${formatCount(limit.accepted)}` : `of ${formatCount(limit.refused)}`) +
              ` -- after you approve, so the whole call would be lost. Shorten it.`,
          }
        : {
            severity: 'warning' as const,
            message:
              `${n}. It was accepted at ${formatCount(limit.accepted)} and refused at ` +
              `${formatCount(limit.refused)}, and where between them it stops is not known, so this ` +
              `may be refused after you approve, losing the whole call.`,
          }),
    }),
  ];
}
