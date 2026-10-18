import { describe, expect, test } from 'bun:test';
import { writeLink } from '../src/linkDestination';
import { render } from '../src/render';

/**
 * The writer's contract, held as a property rather than by examples: whatever href
 * `writeLink` spells, the converter reads back exactly that href.
 *
 * A fixed-seed generator over the characters that make a destination hard -- parentheses,
 * backslashes, whitespace -- so a failure is reproducible and the sweep is fast enough to run every
 * time. `<` and `>` are in it because the converter's angle rule is the shared destination grammar
 * and reads the escapes the writer puts on them.
 */
describe('writeLink', () => {
  test('whatever href it spells, the converter reads back that exact href', () => {
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['a', '(', ')', '\\', ' ', '.', '_', '%', '<', '>'];
    for (let i = 0; i < 3_000; i++) {
      let path = '';
      for (let j = 1 + Math.floor(next() * 10); j > 0; j--) path += alphabet[Math.floor(next() * alphabet.length)];
      const url = `https://x.com/${path}`;
      const adf = JSON.stringify(render(writeLink('t', url), 'jira').converted);
      expect(adf, JSON.stringify(url)).toContain(`"href":${JSON.stringify(url)}`);
    }
  });

  test('an href starting with `<` is written in the `<...>` form, which reads it back', () => {
    // A plain destination may not start with `<`, so written plain this would not be a link.
    const adf = JSON.stringify(render(writeLink('t', '<x>'), 'jira').converted);
    expect(adf).toContain('"href":"<x>"');
  });
});
