/**
 * Small markdown helpers shared by the destination profiles. They scan markdown on behalf of a
 * destination's rules; `adf/` converts between the document models and knows nothing of destinations.
 */

import { backtickRuns, codeSpanAt, isEscapable, isEscaped, type BacktickRuns } from './codeSpan';
import { destinationEnd } from './linkDestination';

/*
 * Every fenced code region, including an unterminated fence (inline spans are `codeRegions`' job).
 * It mirrors the converter's reading of fences:
 * - Unterminated: `parseBlocks` runs an unclosed fence to the end of the input. Without this form,
 *   `render('```\n![a](http://example.com/y.png)\n', 'jira')` reports `jira/image-degraded-to-text`
 *   for an image inside code.
 * - Line-anchored, because `FENCE_RE` tests a whole line: a mid-sentence ``` opens nothing. By a
 *   lookbehind, `(?<=^|\n)`: alternation is tried left to right at one start position, and a
 *   `(?:^|\n)` alternative starts one character earlier and wins, swallowing the torture fixture's
 *   closed ```python block and dropping a Slack warning from the goldens.
 * - A fence closes on a run as long as its whole opener, so a ```` block holding a ``` line is one
 *   region. A tilde fence opens and closes at a line start: `~~~ x ~~~` mid-line is prose.
 * - A closed fence may be indented up to three spaces; four or more is masked here and prose to the
 *   converter, which hides a warning rather than raising a false one. The unterminated form stays at
 *   column zero: an indented unclosed fence is literal to the converter.
 */
const FENCE_REGION_RE =
  /(?<!`)(`{3,})(?!`)[\s\S]*?\1|(?<=(?:^|\n) *)(~{3,}) *[\w.+#-]* *\n(?:[\s\S]*?\n)? *\2|(?<=^|\n)(?:```|~{3,} *[\w.+#-]* *(?=\n|$))[\s\S]*$/y;

/**
 * Every code region in `markdown`, as `[start, end)` offsets in order: fences, and inline code
 * spans read as the converter reads them (`codeSpan.ts`). A walk, not a regex: a run of N backticks
 * closes only on the next run of exactly N on its line, where `` `[^`\n]*` `` closes on any backtick
 * and masks `` `render('- ` `` in `` `render('- ```')` ``, leaving a fence-looking rest that swallows
 * the lines after it. It skips a backslash escape, as the converter's rule 1 does. At each position
 * the fence forms are tried before the inline span.
 */
function codeRegions(markdown: string): [number, number][] {
  const regions: [number, number][] = [];
  let backticks: BacktickRuns | undefined;
  let lineEnd = -1;
  for (let i = 0; i < markdown.length; ) {
    const c = markdown[i];
    if (c === '\\' && isEscapable(markdown[i + 1])) {
      i += 2;
      continue;
    }
    if (c !== '`' && c !== '~') {
      i++;
      continue;
    }
    FENCE_REGION_RE.lastIndex = i;
    const fence = FENCE_REGION_RE.exec(markdown);
    if (fence) {
      regions.push([i, i + fence[0].length]);
      i += fence[0].length;
      continue;
    }
    if (c === '~') {
      i++;
      continue;
    }
    if (lineEnd < i) {
      lineEnd = markdown.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = markdown.length;
    }
    backticks ??= backtickRuns(markdown);
    const span = codeSpanAt(markdown, i, backticks, lineEnd);
    if (span.code !== null) regions.push([i, span.end]);
    i = span.end;
  }
  return regions;
}

/**
 * `markdown`, ending in a newline exactly when `like` does: matched, not imposed.
 *
 * The writer emits no trailing newline, so a round trip turns `"Hello\n"` into `"Hello"` and
 * `cli/src/review.ts` would log an `after` one byte off `before`. Measured: without this, 12 of 21
 * draft x destination pairs differ only by this, including every plain-prose, list, heading and
 * checklist draft. Always appending one would break the mirror case, a draft sent without it.
 * Both serialisers use it, `markdownFor` and Jira's `suggestFix`: `suggestFix` returns `null` when
 * its output equals its input, so normalising one side only would offer every blocked Jira draft a
 * repair that only adds a newline.
 */
export function matchTrailingNewline(markdown: string, like: string): string {
  const wanted = like.endsWith('\n');
  if (markdown === '' || wanted === markdown.endsWith('\n')) return markdown;
  if (wanted) return markdown + '\n';
  // A loop and not `/\n+$/`, which backtracks quadratically on a newline run that is not at the end.
  let end = markdown.length;
  while (end > 0 && markdown[end - 1] === '\n') end--;
  return markdown.slice(0, end);
}

/**
 * Blank out every code region, preserving length and line structure: `segments()` for a scan that
 * needs line adjacency, which a segment boundary can split. A caller matches the masked text and
 * reads the raw text at the same offset. It keeps one model of code: a scan with its own ```/~~~
 * toggle misses inline spans, so Slack's line-swallow scan would report the URL in
 * ``Run `curl https://example.org` ``.
 */
export function maskCode(markdown: string): string {
  return blankRanges(markdown, codeRegions(markdown), '\u00b7');
}

/**
 * Replace every character of each `[start, end)` range but a newline with `fill`, so offsets and
 * line structure survive. The ranges must be sorted and disjoint. `maskCode` is one caller; the
 * GitHub profile's hidden-comment blanking is the other.
 */
export function blankRanges(
  markdown: string,
  ranges: Iterable<readonly [number, number]>,
  fill: string
): string {
  let out = '';
  let last = 0;
  for (const [start, end] of ranges) {
    out += markdown.slice(last, start) + markdown.slice(start, end).replace(/[^\n]/g, fill);
    last = end;
  }
  return out + markdown.slice(last);
}

/**
 * Split markdown into code and non-code regions.
 *
 * Anything that rewrites or scans markdown must skip fenced blocks and inline code, or a code
 * sample containing `![...](...)` gets mangled or falsely reported.
 */
export function segments(markdown: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let last = 0;
  for (const [start, end] of codeRegions(markdown)) {
    if (start > last) out.push({ code: false, text: markdown.slice(last, start) });
    out.push({ code: true, text: markdown.slice(start, end) });
    last = end;
  }
  if (last < markdown.length) out.push({ code: false, text: markdown.slice(last) });
  return out;
}

/**
 * Where the label of the markdown link whose `](` sits at `closeBracket` begins, or -1.
 *
 * A walk, because `\[[^\]]*\]` is quadratic in unclosed `[`: it starts at each one and backtracks
 * `[^\]]*` from the end of the string. Measured on 100 KB of `[`:
 *
 *     render(body, 'linear')   1.7 s      -- `unsafeHrefs` alone
 *     render(body, 'slack')    3.4 s      -- plus `maskLinks`, run twice per segment
 *     render(body, 'jira')     6.5 s
 *
 * a clean quadratic: 10/25/50/100 KB cost 81/413/1626/6531 ms, where 100 KB of ordinary prose costs
 * 1.8 ms and 97 KB of link-heavy prose 52 ms. The window re-renders as the reviewer types. Anchored
 * on `](`, each backward walk stops at the previous `]`, so the walks are disjoint and linear in
 * total. It returns the leftmost `[` in the window, as the regex matched: `[a[b](x)` from the first.
 */
export function linkLabelStart(text: string, closeBracket: number): number {
  let found = -1;
  for (let i = closeBracket - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ']') break;
    if (c === '[') found = i;
  }
  return found;
}

/**
 * Every `!?[label](destination)` span in `text`, as `[start, end)` offsets in order, a leading `!`
 * included: the linear form of `!?\[[^\]]*\]\(DESTINATION\)` with `linkDestination.ts`'s grammar
 * (see `linkLabelStart`). `slack/image-becomes-link` reads this scan, so a missed image goes
 * undisclosed; what reaches Slack's editor is the converter's (`imagesAsLinks`).
 * Linear because each scan stops by the next candidate: the angle form at an unescaped `<` or a line
 * ending, the plain form at whitespace, an unescaped `)` or a second `(` in a group. (A scan to the
 * first `)`, even with an early return, is quadratic on `[a](` repeated before a space: 1.2 s at
 * 47 KB.)
 */
export function markdownLinkSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let from = 0;
  for (;;) {
    const close = text.indexOf('](', from);
    if (close === -1) return spans;
    // Advance one character; a match advances past its own end, since matches never overlap.
    from = close + 1;

    const label = linkLabelStart(text, close);
    if (label === -1) continue;

    const p = destinationEnd(text, close + 2);
    if (p === -1) continue;

    // An escaped `!` is text and the span a link: the writer escapes one before a link it would
    // otherwise turn into an image.
    const start = label > 0 && text[label - 1] === '!' && !isEscaped(text, label - 1) ? label - 1 : label;
    spans.push([start, p + 1]);
    from = p + 1;
  }
}

/**
 * Replace every markdown link span, preserving offsets when the replacement is one character wide.
 *
 * `spans` lets a caller scan once: the Slack profile uses one segment's spans to collect images and
 * to blank links, and two scans measured 0.464 ms against 0.214 ms for one on a 51 KB segment, about
 * a third of the whole Slack convert.
 */
export function replaceLinkSpans(
  text: string,
  replace: (span: string) => string,
  spans: [number, number][] = markdownLinkSpans(text)
): string {
  if (spans.length === 0) return text;
  let out = '';
  let last = 0;
  for (const [start, end] of spans) {
    out += text.slice(last, start) + replace(text.slice(start, end));
    last = end;
  }
  return out + text.slice(last);
}

/**
 * Every markdown image in `text`, as `{ alt, url }`, in order: a link span that starts with `!`.
 * Linear, where `/!\[([^\]]*)\]\(([^)\s]+)\)/g` is the quadratic `linkLabelStart` avoids, reached by
 * `![` and not by `[`, so a guard timing only a body of `[` misses it:
 *
 *     render('!['.repeat(n), 'slack')   10 KB 29 ms | 25 KB 152 ms | 50 KB 598 ms | 100 KB 2403 ms
 *     render('['.repeat(200 KB), 'slack')                                                    1 ms
 */
export function markdownImages(
  text: string,
  spans: [number, number][] = markdownLinkSpans(text)
): { alt: string; url: string }[] {
  const out: { alt: string; url: string }[] = [];
  for (const [start, end] of spans) {
    if (text[start] !== '!') continue;
    const { label, destination } = spanParts(text.slice(start, end));
    out.push({ alt: label, url: destination });
  }
  return out;
}

/**
 * A span `markdownLinkSpans` matched, split into label and destination (delimiters kept on the
 * destination). The first `](` is the split, since `linkLabelStart` never lets a label hold a `]`.
 */
export function spanParts(span: string): { label: string; destination: string } {
  const mid = span.indexOf('](');
  return { label: span.slice(span[0] === '!' ? 2 : 1, mid), destination: span.slice(mid + 2, -1) };
}
