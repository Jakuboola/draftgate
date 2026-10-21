/**
 * Where a bare URL ENDS, for both scans that find one: the converter's autolink
 * (`adf/markdownToAdf.ts`, 9b) and the Slack scanner. Each matches a greedy candidate and this
 * decides how much of it is the URL, so a sentence's full stop does not go into the href.
 *
 * GitHub's rule, read off its own renderer (`POST /markdown`, `mode=gfm`); the probe
 * table is `core/test/bareUrl.test.ts`. Trailing `? ! . , : * _ ~ ' " ;` go, repeatedly, and an
 * `&name;` goes whole (letters only). A trailing `)` goes only while the URL has more closing
 * parentheses than opening ones, so `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its
 * own. Punctuation inside the URL stays.
 *
 * The converter's candidate stops at whitespace, `<` and `>`; Slack's also at `|` and `)`, so its
 * warnings do not fire on a shape nobody measured there (a Wikipedia link ending a line).
 */
export function bareUrlEnd(candidate: string): string {
  // Counted once, then kept in step as `)` is trimmed -- recounting per `)` would be quadratic.
  let surplus = 0;
  for (const c of candidate) surplus += c === ')' ? 1 : c === '(' ? -1 : 0;

  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1]!;
    if (TRAILING.has(last)) {
      end--;
    } else if (last === ';') {
      // `&` plus letters before the `;` is an entity reference and goes whole; otherwise just `;`.
      let at = end - 2;
      while (at >= 0 && isAsciiLetter(candidate[at]!)) at--;
      end = at < end - 2 && at >= 0 && candidate[at] === '&' ? at : end - 1;
    } else if (last === ')' && surplus > 0) {
      end--;
      surplus--;
    } else {
      break;
    }
  }
  return candidate.slice(0, end);
}

const TRAILING = new Set(['?', '!', '.', ',', ':', '*', '_', '~', "'", '"']);

function isAsciiLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
