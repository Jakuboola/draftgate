/**
 * What each routing field is CALLED on screen.
 *
 * Pure, so it needs no DOM: the decision is about names, and the layout it exists to relieve is
 * asserted in `surface/harness/probe.ts` against the real window.
 */
import { describe, expect, test } from 'bun:test';
import { contextLabels } from './src/contextLabels';

describe('contextLabels', () => {
  test('a wildcard route shows the field, not the container', () => {
    // Showing the path would put `fields.` on every label, which is draftgate's addressing detail
    // and costs width on the one strip that has none to spare.
    const out = contextLabels(['cloudId', 'fields.labels', 'fields.priority', 'fields.assignee']);
    expect(out.get('fields.labels')).toBe('labels');
    expect(out.get('fields.priority')).toBe('priority');
    // A field that names no container is already its own leaf.
    expect(out.get('cloudId')).toBe('cloudId');
  });

  test('a leaf shared by two fields falls back to the FULL path, for both', () => {
    /*
     * A reviewer reading a value under the wrong label is worse than one reading a longer label --
     * the same asymmetry that makes pointing at the wrong node worse than pointing at nothing.
     * Both rows revert, because disambiguating only one of them still leaves two rows that differ
     * in a way the reviewer has to notice.
     */
    const out = contextLabels(['summary', 'fields.summary']);
    expect(out.get('summary')).toBe('summary');
    expect(out.get('fields.summary')).toBe('fields.summary');
  });

  test('three-deep paths use the leaf too, and collisions still revert', () => {
    expect(contextLabels(['a.b.c']).get('a.b.c')).toBe('c');
    const clash = contextLabels(['a.b.c', 'x.y.c']);
    expect(clash.get('a.b.c')).toBe('a.b.c');
    expect(clash.get('x.y.c')).toBe('x.y.c');
  });

  test('an empty list is an empty map, and nothing throws on one field', () => {
    expect(contextLabels([]).size).toBe(0);
    expect(contextLabels(['channel_id']).get('channel_id')).toBe('channel_id');
  });
});

/**
 * The prose labels use the same resolver, and the two lists are resolved SEPARATELY.
 *
 * A leaf is only ambiguous against its own list: a `summary` prose input and a `summary` context
 * row are different rows in different places, and collapsing them into one namespace would make
 * both revert to their paths for a collision that is not one.
 */
describe('prose labels', () => {
  test('a nested prose field shows its own name', () => {
    expect(contextLabels(['fields.summary']).get('fields.summary')).toBe('summary');
  });

  test('two prose fields sharing a leaf still revert', () => {
    const out = contextLabels(['fields.summary', 'other.summary']);
    expect(out.get('fields.summary')).toBe('fields.summary');
    expect(out.get('other.summary')).toBe('other.summary');
  });
});
