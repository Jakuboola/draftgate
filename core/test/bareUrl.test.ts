import { describe, expect, test } from 'bun:test';
import { bareUrlEnd } from '../src/bareUrl';

/**
 * Where a bare URL ends. Every row is a case put through GitHub's renderer (`POST /markdown`,
 * `mode=gfm`) with the href it produced. The input is the greedy candidate a scanner hands over,
 * which stops at whitespace, `<` and `>`.
 */
const PROBED: [candidate: string, githubLinks: string][] = [
  ['https://example.com/a/b.', 'https://example.com/a/b'],
  ['https://example.com/a,', 'https://example.com/a'],
  ['https://example.com/a?', 'https://example.com/a'],
  ['https://example.com/a:', 'https://example.com/a'],
  ['https://example.com/a!', 'https://example.com/a'],
  ['https://example.com/a*', 'https://example.com/a'],
  ['https://example.com/a_', 'https://example.com/a'],
  ['https://example.com/a~', 'https://example.com/a'],
  ["https://example.com/a'", 'https://example.com/a'],
  ['https://example.com/a"', 'https://example.com/a'],
  ['https://example.com/a;', 'https://example.com/a'],
  ['https://example.com/a...', 'https://example.com/a'],
  ['https://example.com/a.b,c', 'https://example.com/a.b,c'],
  ['https://example.com/search?q=x&hl;', 'https://example.com/search?q=x'],
  ['https://example.com/search?q=x&y=1', 'https://example.com/search?q=x&y=1'],
  ['https://example.com/a&x1;', 'https://example.com/a&x1'],
  ['https://example.com/a&;', 'https://example.com/a&'],
  ['https://example.com/a&xy;.', 'https://example.com/a'],
  // Parentheses: balanced ones are the URL's, a surplus `)` is the sentence's.
  ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
  ['https://en.wikipedia.org/wiki/Foo_(bar).', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
  ['https://example.com/a)', 'https://example.com/a'],
  ['https://example.com/(a)(b))', 'https://example.com/(a)(b)'],
  ['https://example.com/a).', 'https://example.com/a'],
  ['https://example.com/a.).', 'https://example.com/a'],
];

describe('bareUrlEnd -- GitHub’s own answer, probed', () => {
  for (const [candidate, expected] of PROBED) {
    test(JSON.stringify(candidate), () => {
      expect(bareUrlEnd(candidate)).toBe(expected);
    });
  }

});
