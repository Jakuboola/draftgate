/**
 * The two rules every operator config file follows. A file that parses and is not a usable object
 * must not be written over wholesale by a single click.
 */

import { describe, expect, test } from 'bun:test';
import { configMergeBase, namedSample } from '../src/configFiles';

describe('namedSample', () => {
  test('names the first few and marks that there are more', () => {
    expect(namedSample(['a', 'b'])).toBe('a; b');
    expect(namedSample(['a', 'b', 'c'])).toBe('a; b; c');
    expect(namedSample(['a', 'b', 'c', 'd'])).toBe('a; b; c; …');
  });

  test('is BOUNDED, so a file with many bad entries is one short line', () => {
    const out = namedSample(Array.from({ length: 50 }, (_, i) => `t${i}`));
    expect(out.split('; ')).toHaveLength(4);
    expect(out.endsWith('…')).toBe(true);
  });

  test('nothing in, nothing out', () => {
    expect(namedSample([])).toBe('');
  });
});

describe('configMergeBase refuses rather than degrading', () => {
  // A reader may drop what it does not understand; a writer that did would delete the config.
  test('an absent or empty file is the ordinary first write, not a fault', () => {
    expect(configMergeBase('', '/p.json', 'sites')).toEqual({});
    expect(configMergeBase('   \n', '/p.json', 'sites')).toEqual({});
  });

  test('invalid JSON is refused, and the message says the answer was not saved', () => {
    const out = configMergeBase('{ broken', '/p.json', 'sites');
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toContain('/p.json');
    expect((out as Error).message).toContain('not saved');
  });

  for (const [label, text] of [
    ['an array', '[]'],
    ['a string', '"x"'],
    ['a number', '42'],
  ] as const) {
    test(`${label} PARSES and is refused anyway`, () => {
      // Falling through to `{}`, each would be replaced wholesale by one click, silently.
      const out = configMergeBase(text, '/p.json', 'repos');
      expect(out, `${label} was accepted as a merge base`).toBeInstanceOf(Error);
      expect((out as Error).message).toContain('not saved');
    });
  }

  test('a container key that is not an object is refused', () => {
    expect(configMergeBase('{"repos": 5}', '/p.json', 'repos')).toBeInstanceOf(Error);
    expect(configMergeBase('{"sites": []}', '/p.json', 'sites')).toBeInstanceOf(Error);
    // The key is the caller's.
    expect(configMergeBase('{"repos": 5}', '/p.json', 'sites')).toEqual({ repos: 5 });
  });

  test('unknown top-level keys survive, because the files are hand-editable', () => {
    // A writer that serialises only its own container (`JSON.stringify({ sites })`) destroys this.
    expect(configMergeBase('{"version":1,"sites":{"a":{}},"mine":true}', '/p.json', 'sites')).toEqual({
      version: 1,
      sites: { a: {} },
      mine: true,
    });
  });
});
