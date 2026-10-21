/**
 * Links whose text names one host and whose target is another:
 * `[https://id.example.org/reset](https://id-example.evil.test/reset)`. Probed: Slack, Linear, Jira
 * and GitHub all show the recipient the real target or warn before opening, so the gap is the
 * reviewer's. The window shows every target; this warning says which one to look at.
 *
 * Reads the converter's link marks, not the markdown (see `converter.md`): they already handle a
 * label split across marks (`[**https**://a.com](b)`), a code span inside it, and an image that
 * arrives as a link whose label is the alt text.
 *
 * The whole trimmed label names a host when it is an absolute URL with an authority
 * (`scheme://host...`), or a bare host (optional port and path) that starts `www.` or ends in a
 * `READS_AS_HOST` TLD, so `Node.js`, `README.md` and `setup.py` stay prose. Hosts compare via
 * `hostOf`; a subdomain is a different host (`example.org` labelling `https://help.example.org`
 * warns), since collapsing parents needs the public-suffix list (`github.io` is a thousand owners).
 * A target with no host (`mailto:`, `javascript:`) is left to `link/unsafe-href`.
 */

import type { AdfDocument, AdfNode } from './adf/types';
import { walk } from './adfSchema';

/**
 * TLDs a bare label may end in and still be read as a host. The commonest generic and country
 * codes, minus the ones that are also everyday file extensions (`md`, `py`, `sh`, `rs`, `so`).
 * `pl` is kept: Poland outweighs Perl in a support channel.
 */
const READS_AS_HOST = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'io', 'co', 'ai', 'app', 'dev',
  'me', 'xyz', 'cloud', 'tech', 'online', 'site', 'link', 'page',
  'eu', 'uk', 'de', 'cz', 'sk', 'pl', 'at', 'ch', 'fr', 'it', 'es', 'nl', 'be', 'se', 'no', 'dk',
  'fi', 'ie', 'pt', 'hu', 'ro', 'us', 'ca', 'au', 'nz', 'jp', 'cn', 'in', 'br', 'ru', 'ua',
]);

const WITH_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
/*
 * A bare host: dot-separated labels of letters, digits and inner hyphens (Unicode letters too, so
 * an IDN label is read rather than skipped), then an optional port and an optional path. No
 * whitespace anywhere -- "see example.org" is a sentence, not a host.
 */
const BARE_HOST = /^((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+([\p{L}]{2,63}))(?::\d+)?(?:[/?#]\S*)?$/iu;

/** Schemes WHATWG calls special: any run of `/` or `\` after the colon leads into the host. */
const SPECIAL = new Set(['http', 'https', 'ftp', 'ws', 'wss']);

/**
 * The host a URL opens, lowercased, with a trailing dot and a leading `www.` removed, or `null` for
 * no host (`mailto:`, `javascript:`) or no scheme. A scheme-relative `//host` has one.
 *
 * By hand: `core` has no `URL` global (`core/tsconfig.json`, `types: []`). Follows WHATWG where a
 * difference would hide a host: userinfo runs to the last `@` (`https://example.org@evil.test` opens
 * `evil.test`), a port is dropped, and a special scheme takes any run of slashes or backslashes
 * (`https:\\evil.test` opens `evil.test` in every browser). No IDN encoding, so a Cyrillic
 * look-alike compares unequal; the cost is a warning on a Unicode label over a punycode target.
 */
function hostOf(url: string): string | null {
  const clean = url.replace(/[\t\n\r]/g, '').trim();
  // Scheme-relative (`//evil.test/x`): the page's scheme is taken and the host is whatever follows.
  const m = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(clean.startsWith('//') ? `https:${clean}` : clean);
  if (!m) return null;
  const special = SPECIAL.has(m[1]!.toLowerCase());
  let rest = m[2]!;
  if (special) rest = rest.replace(/^[/\\]+/, '');
  else if (rest.startsWith('//')) rest = rest.slice(2);
  else return null;
  let authority = rest.split(special ? /[/\\?#]/ : /[/?#]/)[0]!;
  authority = authority.slice(authority.lastIndexOf('@') + 1);
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.replace(/:\d*$/, '');
  const normal = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return normal || null;
}

/** The host a link's text names, or `null` when the text is not a URL or a host. */
export function hostNamedBy(label: string): string | null {
  const text = label.trim();
  // The whole label: "https://example.org docs" is a sentence that starts with a URL, not a host.
  if (/\s/.test(text)) return null;
  if (WITH_AUTHORITY.test(text)) return hostOf(text);
  const m = BARE_HOST.exec(text);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  if (!host.startsWith('www.') && !READS_AS_HOST.has(m[2]!.toLowerCase())) return null;
  return host.replace(/^www\./, '');
}

export interface MisleadingLink {
  /** The text the reader sees, whole. */
  label: string;
  href: string;
  /** Normalised, as compared. */
  labelHost: string;
  hrefHost: string;
}

function linkHref(node: AdfNode): string | undefined {
  const mark = node.marks?.find((m) => m.type === 'link');
  const href = mark?.attrs?.href;
  return typeof href === 'string' ? href : undefined;
}

/**
 * Every link in `doc` whose text names a host other than the one it opens, once per distinct label
 * and target, in document order.
 *
 * A link is a maximal run of adjacent text nodes with the same link href: the converter spells
 * `[**https**://a.com](b)` as two nodes. Two adjacent links to one target are already one by then
 * (`[example.org](evil)[ now](evil)` is `example.org now`, no host), as the window shows and sends.
 */
export function misleadingLinks(doc: AdfDocument): MisleadingLink[] {
  const found = new Map<string, MisleadingLink>();
  const judge = (text: string, href: string) => {
    const label = text.trim();
    const labelHost = hostNamedBy(label);
    if (labelHost === null) return;
    const hrefHost = hostOf(href);
    if (hrefHost === null || hrefHost === labelHost) return;
    const key = `${label}\u0000${href}`;
    if (!found.has(key)) found.set(key, { label, href, labelHost, hrefHost });
  };
  // Every parent's children, scanned for runs; the text nodes a run is made of have none.
  walk(doc, (parent) => {
    // The open link: its target, and the text gathered so far.
    let href: string | undefined;
    let text = '';
    for (const node of parent.content ?? []) {
      const next = node.type === 'text' ? linkHref(node) : undefined;
      if (next !== undefined && next === href) {
        text += node.text ?? '';
        continue;
      }
      if (href !== undefined) judge(text, href);
      href = next;
      text = node.text ?? '';
    }
    if (href !== undefined) judge(text, href);
  });
  return [...found.values()];
}
