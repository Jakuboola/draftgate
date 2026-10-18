/**
 * The media fixer's own invariants: what it emits must be valid ADF, not merely media-legal.
 *
 * The trap: `- [ ] ![img](https://example.com/1.png)` bubbles the media out of the `taskItem`,
 * `keepNode` drops the emptied item, and an empty `taskList` stays behind -- an `INVALID_INPUT`
 * 400 (`EMPTY_FORBIDDEN`, probed below) with `blocked: false`. A fuzz run over 3,029 generated
 * documents found 56 unblocked outputs of this shape. Both invariants (`illegalMediaPlacements`,
 * `emptyContainers`) run over every document the repo ships and the shapes that produce it.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import {
  EMPTY_FORBIDDEN,
  emptyContainers,
  illegalMediaPlacements,
  orphanedTaskLists,
} from '../src/adfSchema';
import { shippedBodies } from './golden';
import type { AdfDocument } from '../src/adf/types';

/** Jira is the destination whose `converted` IS the payload, so it is the one that must be valid. */
const adf = (md: string) => render(md, 'jira').converted as AdfDocument;

describe('an image-only task item', () => {
  // The exact document, pinned. Two mutations only this catches: removing `taskItem` from
  // `INLINE_ONLY` (gives `taskList > taskItem{content: []}`), and the empty-container drop itself.
  // Not guarded anywhere: the checker's half. With `taskItem` out of `INLINE_ONLY`, `hoistMedia`
  // and `illegalMediaPlacements` move together, and `render.test.ts`'s
  // `jira/block-child-in-inline-container` case is `heading > mediaSingle`, which stays flagged.
  test('emits the media alone, with no list wrapper left behind', () => {
    expect(adf('- [ ] ![img](https://example.com/1.png)\n')).toEqual({
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'mediaSingle',
          attrs: { layout: 'center' },
          content: [
            {
              type: 'media',
              attrs: { type: 'external', url: 'https://example.com/1.png', alt: 'img' },
            },
          ],
        },
      ],
    });
  });

  test('and is not blocked, so this is a document a human can actually approve', () => {
    const r = render('- [ ] ![img](https://example.com/1.png)\n', 'jira');
    expect(r.blocked).toBe(false);
    // Both disclosed: the external image, and the dropped checkbox (ADF has no checklist item that
    // holds only a picture), a `warning` because something the reviewer wrote will not be there.
    expect(r.warnings.map((w) => w.code).sort()).toEqual([
      'jira/external-image-embedded',
      'jira/task-item-media-only',
    ]);
    expect(r.warnings.find((w) => w.code === 'jira/task-item-media-only')?.severity).toBe('warning');
  });

  test('an item with TEXT beside the image keeps its checkbox and gets no such warning', () => {
    // The negative control: no checkbox is lost, so no warning.
    const r = render('- [ ] keep me ![a](https://example.com/1.png)\n', 'jira');
    expect(r.warnings.map((w) => w.code)).toEqual(['jira/external-image-embedded']);
  });

  test('and it counts them, because two dropped checkboxes is a different sentence', () => {
    const r = render(
      '- [x] ![a](https://e.com/1.png)\n- [ ] ![b](https://e.com/2.png)\n',
      'jira'
    );
    const w = r.warnings.find((x) => x.code === 'jira/task-item-media-only');
    expect(w?.message).toContain('2 checklist items');
  });

  test('a CHECKED image-only item goes the same way', () => {
    // `- [x]` carries one more fact than `- [ ]`, and the bubble drops it with the item.
    const doc = adf('- [x] ![a](https://example.com/1.png)\n');
    expect(JSON.stringify(doc)).not.toContain('taskList');
    expect(JSON.stringify(doc)).not.toContain('DONE');
  });

  test('an item that still has TEXT keeps its list, and the media becomes a sibling', () => {
    const doc = adf('- [ ] keep me ![a](https://example.com/1.png)\n- [x] and me\n');
    expect(doc.content.map((n) => n.type)).toEqual(['taskList', 'mediaSingle']);
    expect(doc.content[0]?.content).toHaveLength(2);
  });
});

describe('every document this repo ships is valid ADF after the fixer', () => {
  const bodies: Array<[string, string]> = [
    // Enumerated from disk, so a new fixture is swept without anyone adding it.
    ...shippedBodies(),
    // Media in each kind of container: inline-only (emptied), block-accepting (split), a list
    // wrapper (bubbled past).
    ['an image-only task item', '- [ ] ![a](https://example.com/1.png)\n'],
    ['two image-only task items', '- [ ] ![a](https://e.com/1.png)\n- [x] ![b](https://e.com/2.png)\n'],
    ['an image-only task item in a quote', '> - [ ] ![a](https://example.com/1.png)\n'],
    ['an image in a heading', '# Title ![img](https://example.com/a.png)\n'],
    ['an image mid-sentence', 'before ![img](https://example.com/a.png) after\n'],
    ['an image-only list item', '- ![a](https://example.com/1.png)\n'],
    ['an image in a table cell', '| a |\n| --- |\n| ![i](https://example.com/1.png) |\n'],
    ['a task item followed by prose', '- [ ] t ![a](https://e.com/1.png)\n\nAfter the list.\n'],
    ['nothing at all', ''],
    // Dropping the media-only item leaves its nested checklist with no `taskItem` to belong to.
    ['an image-only task item with a nested checklist', '- [ ] ![a](https://e.com/1.png)\n  - [ ] d\n'],
    ['...and with a nested bullet under that', '- [ ] ![a](https://e.com/1.png)\n  - [ ] d\n    - e\n'],
    ['an image-only item BETWEEN two checked ones', '- [x] a\n- [ ] ![i](https://e.com/1.png)\n  - [ ] d\n- [x] c\n'],
  ];

  for (const [label, body] of bodies) {
    test(`${label}: no media in an inline-only container`, () => {
      expect(illegalMediaPlacements(adf(body))).toEqual([]);
    });

    test(`${label}: no container ADF requires to be non-empty is empty`, () => {
      expect(emptyContainers(adf(body))).toEqual([]);
    });

    // Not a 400 (Jira answers 201); swept for the reasons `orphanedTaskLists` gives.
    test(`${label}: no nested checklist without an item to hang from`, () => {
      expect(orphanedTaskLists(adf(body))).toEqual([]);
    });
  }

  test('and an empty document keeps its empty paragraph, which is how ADF spells one', () => {
    // The other direction: `doc > [paragraph []]` survives the empty-container drop.
    expect(adf('')).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    });
  });
});

/**
 * The bubbled media lands immediately after the container it came out of, not at the end of the
 * accepting ancestor, where `- [ ] task ![shot](url)` followed by three blocks would send the image
 * as the document's last node. The repair is silent, so it must not move anything visibly.
 *
 * Probed: `doc[paragraph, mediaSingle, heading, paragraph]` returns 201 and reads back in order.
 */
describe('a hoisted image keeps its place in the document', () => {
  /** The document's top-level shape, with a lone-media paragraph collapsed to `media`. */
  const shape = (md: string) =>
    (adf(md).content ?? []).map((n) => (n.type === 'mediaSingle' ? 'media' : n.type));

  test('out of a task item: after the list, BEFORE everything that followed it', () => {
    expect(
      shape('- [ ] task ![shot](https://e.com/a.png)\n- [x] two\n\nClosing.\n\n## Next\n\nmore\n')
    ).toEqual(['taskList', 'media', 'paragraph', 'heading', 'paragraph']);
  });

  test('out of a heading: directly after the heading', () => {
    expect(shape('# Title ![i](https://e.com/a.png)\n\nafter\n')).toEqual([
      'heading',
      'media',
      'paragraph',
    ]);
  });

  test('two images from one item stay in the order they were written', () => {
    const doc = adf('- [ ] a ![one](https://e.com/1.png) ![two](https://e.com/2.png)\n\nafter\n');
    expect(doc.content.map((n) => n.type)).toEqual([
      'taskList', 'mediaSingle', 'mediaSingle', 'paragraph',
    ]);
    expect(JSON.stringify(doc).indexOf('/1.png')).toBeLessThan(JSON.stringify(doc).indexOf('/2.png'));
  });

  test('inside a blockquote it stays inside the blockquote', () => {
    const doc = adf('> - [ ] q ![i](https://e.com/a.png)\n>\n> after\n');
    expect(doc.content.map((n) => n.type)).toEqual(['blockquote']);
    expect((doc.content[0]?.content ?? []).map((n) => n.type)).toEqual([
      'taskList', 'mediaSingle', 'paragraph',
    ]);
  });

  test('a list item ACCEPTS blocks, so the image does not leave it at all', () => {
    const doc = adf('- item ![i](https://e.com/a.png)\n- second\n\nafter\n');
    const firstItem = doc.content[0]?.content?.[0];
    expect((firstItem?.content ?? []).map((n) => n.type)).toEqual(['paragraph', 'mediaSingle']);
  });

  test('and a mid-sentence image still splits its paragraph in place', () => {
    // The `split` half of the pass, asserted here so the two cannot be confused.
    expect(shape('before ![i](https://e.com/a.png) after\n\nnext\n')).toEqual([
      'paragraph', 'media', 'paragraph', 'paragraph',
    ]);
  });
});

/*
 * `EMPTY_FORBIDDEN` is about the list wrapper, never the item. Probed: each of the four wrappers
 * empty is a 400 `INVALID_INPUT`, holding one item a 201; `taskList > taskItem{content: []}` (an
 * empty item) is 201. Adding an item type would block a send Jira accepts, so both directions are
 * pinned.
 */
describe('EMPTY_FORBIDDEN holds list wrappers and no item types (probed)', () => {
  const WRAPPERS = ['taskList', 'decisionList', 'bulletList', 'orderedList'];
  const ITEMS = ['taskItem', 'decisionItem', 'listItem'];

  test('exactly the four wrappers Jira 400s on when they are empty', () => {
    expect([...EMPTY_FORBIDDEN].sort()).toEqual([...WRAPPERS].sort());
  });

  test('and no item type, because an empty ITEM is a 201', () => {
    for (const item of ITEMS) {
      expect(
        EMPTY_FORBIDDEN.has(item),
        `${item} must not be here: taskList > taskItem{content: []} was probed at 201, so ` +
          'blocking it would refuse a send Jira accepts'
      ).toBe(false);
    }
  });

  test('`paragraph` stays out, because `doc > [paragraph []]` is how ADF spells an empty document', () => {
    expect(EMPTY_FORBIDDEN.has('paragraph')).toBe(false);
  });

  test('emptyContainers flags an empty wrapper and not an empty item', () => {
    // Through the real function, on the two shapes the probe separated.
    const withEmptyList = {
      version: 1,
      type: 'doc',
      content: [{ type: 'taskList', attrs: { localId: 'l1' }, content: [] }],
    } as unknown as AdfDocument;
    expect(emptyContainers(withEmptyList).length).toBe(1);

    const withEmptyItem = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'taskList',
          attrs: { localId: 'l1' },
          content: [{ type: 'taskItem', attrs: { localId: 't1', state: 'TODO' }, content: [] }],
        },
      ],
    } as unknown as AdfDocument;
    expect(emptyContainers(withEmptyItem)).toEqual([]);
  });
});
