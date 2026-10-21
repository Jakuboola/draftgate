/**
 * A markdown link destination, the `(...)` of `[label](...)`, written once for the converter's link
 * and image rules, the link scanner and every link writer.
 *
 * CommonMark's grammar, in its two forms below. GitHub reads it the same way (probed through
 * `POST /markdown`), so `https://en.wikipedia.org/wiki/Foo_(bar)` is one URL and `\(` is a `(`.
 * Parentheses nest one level: every alternative starts on a different character, so nothing
 * backtracks and the scan stays linear. A deeper or unbalanced destination is not a link, as on
 * GitHub.
 */

/**
 * The `<...>` form, the only one that may hold a space: anything but `<`, `>` or a line ending, or
 * a backslash escape, so `<a<b c>` is not a destination. Non-empty, unlike CommonMark: no
 * destination here was probed with an empty href.
 */
const ANGLE_SOURCE = String.raw`<(?:\\[^\n\r]|[^<>\\\n\r])+>`;

/**
 * The plain form: characters that are neither whitespace nor a parenthesis, a backslash escape, or
 * one `(...)` group of those. It may not start with `<` (CommonMark), or `<a<b.png>` would be one.
 */
const PLAIN_SOURCE = String.raw`(?!<)(?:\\[^\s]|[^()\s\\]|\((?:\\[^\s]|[^()\s\\])*\))+`;

/** The destination grammar, both forms, as a regex source. */
export const DESTINATION_SOURCE = `(?:${ANGLE_SOURCE}|${PLAIN_SOURCE})`;

const DESTINATION_END = new RegExp(DESTINATION_SOURCE + String.raw`\)`, 'y');

/** The index of the `)` that closes a destination starting at `from`, or -1 when there is none. */
export function destinationEnd(text: string, from: number): number {
  DESTINATION_END.lastIndex = from;
  return DESTINATION_END.test(text) ? DESTINATION_END.lastIndex - 1 : -1;
}

/**
 * A destination as CommonMark reads it: `<...>` unwrapped and backslash escapes resolved for all
 * ASCII punctuation, `<` and `&` included (unlike `isEscapable`, whose exception is about text; a
 * destination is written by `writeLink`).
 */
export function bareDestination(dest: string): string {
  const inner = dest.startsWith('<') && dest.endsWith('>') ? dest.slice(1, -1) : dest;
  return inner.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * `[label](href)` spelled so the converter and GitHub read back exactly `label` and `href`.
 *
 * A space in the href, or a leading `<`, needs the `<...>` form. Otherwise a backslash is escaped,
 * and so is every parenthesis unless they make one balanced level (a Wikipedia URL stays raw).
 * Escaped, not percent-encoded: `%28` need not name the same resource as `(` (RFC 3986, 2.2). A
 * label ending in a lone backslash would escape its own `]`, so that backslash is escaped too.
 */
export function writeLink(label: string, href: string): string {
  return `[${writeLabel(label)}](${writeDestination(href)})`;
}

function writeDestination(href: string): string {
  if (/\s/.test(href) || href.startsWith('<')) return `<${href.replace(/[\\<>]/g, '\\$&')}>`;
  const escaped = href.replace(/\\/g, '\\\\');
  return ONE_BALANCED_LEVEL.test(href) ? escaped : escaped.replace(/[()]/g, '\\$&');
}

function writeLabel(label: string): string {
  // A loop, not `/\\+$/`: that regex backtracks quadratically on a long run of backslashes that is
  // not at the end (22 s at 200k characters, measured), and this runs per link per keystroke.
  let i = label.length;
  while (i > 0 && label.charCodeAt(i - 1) === 92 /* \ */) i--;
  return (label.length - i) % 2 === 1 ? label + '\\' : label;
}

const ONE_BALANCED_LEVEL = /^(?:[^()]|\([^()]*\))*$/;

/**
 * The angle link, `<url>` and Slack's labelled `<url|label>`, written once for the converter that
 * reads it and the writer that spells it back.
 *
 * The URL holds no whitespace, `<`, `>` or `|` (RFC 3986 has no bare `|`, so the first one starts
 * the label). The label is what was probed: no `<`, `>`, `|` or line ending, and something other
 * than whitespace; anything wider stays text. The lazy lookahead stops at the label's first
 * non-whitespace character.
 */
const ANGLE_URL_SOURCE = String.raw`https?:\/\/[^\s<>|]+`;
const ANGLE_LABEL_SOURCE = String.raw`(?=[^<>|\n\r]*?[^\s<>|])[^<>|\n\r]+`;

/**
 * `<url>` or `<url|label>`, the URL and any label captured. One pattern for both, so a reader asks
 * once per `<`; a reader that does not take labels treats a match with one as no match.
 */
export const ANGLE_LINK_SOURCE = String.raw`<(${ANGLE_URL_SOURCE})(?:\|(${ANGLE_LABEL_SOURCE}))?>`;

/** Where a labelled one could begin, `<url|`: a cheap test for "might this text hold one". */
export const LABELLED_ANGLE_LINK_START_SOURCE = String.raw`<${ANGLE_URL_SOURCE}\|`;

const WHOLE_ANGLE_URL = new RegExp(`^${ANGLE_URL_SOURCE}$`);
const WHOLE_ANGLE_LABEL = new RegExp(`^${ANGLE_LABEL_SOURCE}$`);

/**
 * How an angle link was written, kept on its link mark as `angle` so an approval spells it the same
 * way: `bare` for `<url>`, `labelled` for `<url|label>`, so `<url|url>` comes back as written.
 */
export type AngleSpelling = 'bare' | 'labelled';

/**
 * A link written as an angle link, or `null` when `label` and `href` no longer fit the form (a `>`
 * in the label, a non-http(s) address) and the caller writes a markdown link instead. The label is
 * never escaped: the destination shows its characters literally (probed).
 */
export function writeAngleLink(label: string, href: string, spelling: AngleSpelling): string | null {
  if (!WHOLE_ANGLE_URL.test(href)) return null;
  if (spelling === 'bare' && label === href) return `<${href}>`;
  return WHOLE_ANGLE_LABEL.test(label) ? `<${href}|${label}>` : null;
}
