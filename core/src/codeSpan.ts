/**
 * Backslash escapes and code spans, as CommonMark 0.31.2 reads them (sections 2.4 and 6.1), written
 * once for the converter's `parseInline` and for the scanners that must agree with it.
 *
 * Not narrower than the spec: a single-backtick reader (`` /^`([^`]+)`/ ``) misplaces
 * ``` `` a`b `` ```, and a short escapable list sends `\"` to Jira with its backslash. GitHub,
 * commonmark.js, micromark and markdown-it read it the spec's way, apart from one GitHub quirk not
 * copied: after an unmatched ``` `` ```, GitHub stops pairing later single-backtick spans on that
 * line.
 */

/**
 * A character a backslash may escape: any ASCII punctuation (CommonMark 2.4) except `<` and `&`.
 *
 * The converter reads raw HTML and entities as text, so `\<br>` and `<br>` would be one text node
 * and `Use \<br> for a break` would go out as `Use <br> for a break` (a GitHub line break; `\<!--`
 * a comment hiding the rest of the line). Kept as a literal backslash, the body goes out byte for
 * byte. Jira shows the backslash.
 */
export function isEscapable(c: string | undefined): boolean {
  return c !== undefined && c !== '<' && c !== '&' && ASCII_PUNCTUATION.test(c);
}

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;

/**
 * Whether the character at `index` is escaped by a backslash: an odd run before it (`\\*` is a
 * backslash then a live delimiter, `\*` a literal asterisk). Also used by the writer
 * (`appendInline`) and `markdownLinkSpans`, both for an escaped `!`.
 */
export function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * Every maximal backtick run in a text, grouped by length, so "the next run of exactly N" (the
 * closer of an N-run opener) is a binary search rather than a quadratic walk; the twin of
 * `closableRuns` in `adf/markdownToAdf.ts`.
 *
 * Runs are raw, backslashes ignored: they are looked up only as closers, and inside a code span a
 * backslash is literal. Whether an opener is escaped is the caller's question.
 */
export type BacktickRuns = Map<number, number[]>;

export function backtickRuns(text: string): BacktickRuns {
  const runs: BacktickRuns = new Map();
  for (let i = text.indexOf('`'); i !== -1; i = text.indexOf('`', i)) {
    const start = i;
    while (text[i] === '`') i++;
    const length = i - start;
    const starts = runs.get(length);
    if (starts) starts.push(start);
    else runs.set(length, [start]);
  }
  return runs;
}

/** What `codeSpanAt` found: the span's `code` and where it ends, or `code: null` for a literal run. */
export interface CodeSpanAt {
  /** Exclusive end: past the closing run, or past the opening run when it is literal. */
  end: number;
  /** The span's content, spaces stripped as the spec says, or `null` when nothing closes it. */
  code: string | null;
}

/**
 * The code span opened by the unescaped backtick run at `pos`. The closer must start before
 * `limit`, which keeps a span on one line as the per-line `parseInline` does. One leading and one
 * trailing space are stripped when both are there and the content is not all spaces, so
 * ``` `` `a` `` ``` is the code `` `a` ``.
 */
export function codeSpanAt(
  text: string,
  pos: number,
  runs: BacktickRuns,
  limit = text.length
): CodeSpanAt {
  let open = pos;
  while (text[open] === '`') open++;
  const close = firstAtOrAfter(runs.get(open - pos), open);
  if (close === -1 || close >= limit) return { end: open, code: null };

  const content = text.slice(open, close);
  return { end: close + (open - pos), code: stripsPadding(content) ? content.slice(1, -1) : content };
}

/**
 * Whether the reader strips one space from each end: both ends are a space and the content is not
 * all spaces. `writeCodeSpan` pads exactly when this would strip.
 */
function stripsPadding(content: string): boolean {
  return content[0] === ' ' && content.at(-1) === ' ' && /[^ ]/.test(content);
}

/** The first entry of an ascending list that is at least `from`, or -1. */
function firstAtOrAfter(starts: number[] | undefined, from: number): number {
  if (!starts) return -1;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length ? starts[lo]! : -1;
}

/**
 * `code` as a span the reader gives back byte for byte: the shortest delimiter no run inside has
 * exactly, padded with a space on both sides when the content starts or ends with a backtick, or
 * starts and ends with a space. Shortest, so `` `render('- ```')` `` keeps its one backtick.
 * All-space content is not padded: the reader strips nothing from it.
 */
export function writeCodeSpan(code: string): string {
  const inside = backtickRuns(code);
  let length = 1;
  while (inside.has(length)) length++;
  const fence = '`'.repeat(length);
  const pad = code.startsWith('`') || code.endsWith('`') || stripsPadding(code);
  return pad ? `${fence} ${code} ${fence}` : `${fence}${code}${fence}`;
}
