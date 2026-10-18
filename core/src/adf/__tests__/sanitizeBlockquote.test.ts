import { describe, expect, it } from 'bun:test';
import { sanitizeAdfForJsm } from '../sanitizeBlockquote';
import { INLINE_TYPES } from '../../adfSchema';
import { AdfDocument, AdfNode } from '../types';

const para = (text: string): AdfNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const wrap = (children: AdfNode[]): AdfDocument => ({
  version: 1,
  type: 'doc',
  content: [{ type: 'blockquote', content: children }],
});

const ALLOWED = new Set([
  'paragraph',
  'bulletList',
  'orderedList',
  'codeBlock',
  'mediaSingle',
  'mediaGroup',
]);

/*
 * Both `expect`s sit inside loops, so without the counter a document with no blockquote (or an
 * emptied one) would pass. The helper fails if it never reached a child to judge.
 */
function assertBlockquoteChildrenAllowed(doc: AdfDocument) {
  let checked = 0;
  for (const top of doc.content) {
    if (top.type !== 'blockquote') continue;
    for (const child of top.content ?? []) {
      expect(ALLOWED.has(child.type)).toBe(true);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
}

describe('sanitizeAdfForJsm', () => {
  it('passes allowed children through unchanged', () => {
    const doc = wrap([
      para('text'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para('a')] }] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x' }] },
    ]);
    const out = sanitizeAdfForJsm(doc);
    assertBlockquoteChildrenAllowed(out);
    expect((out.content[0].content ?? []).map((n) => n.type)).toEqual([
      'paragraph',
      'bulletList',
      'codeBlock',
    ]);
  });

  it('coerces heading to bold paragraph', () => {
    const doc = wrap([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const child = (out.content[0].content ?? [])[0];
    expect(child.type).toBe('paragraph');
    expect(child.content?.[0].marks).toEqual([{ type: 'strong' }]);
    expect(child.content?.[0].text).toBe('Title');
  });

  it('preserves existing inline marks when adding strong', () => {
    const doc = wrap([
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [
          {
            type: 'text',
            text: 'See docs',
            marks: [{ type: 'em' }, { type: 'link', attrs: { href: 'https://x' } }],
          },
        ],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const inline = (out.content[0].content ?? [])[0].content?.[0];
    expect(inline?.marks).toEqual([
      { type: 'em' },
      { type: 'link', attrs: { href: 'https://x' } },
      { type: 'strong' },
    ]);
  });

  it('does not double-add strong if already present', () => {
    const doc = wrap([
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Bold', marks: [{ type: 'strong' }] }],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const inline = (out.content[0].content ?? [])[0].content?.[0];
    expect(inline?.marks).toEqual([{ type: 'strong' }]);
  });

  it('leaves non-text inline nodes untouched when coercing heading', () => {
    const mention = {
      type: 'mention',
      attrs: { id: 'user-1', text: '@user' },
    };
    const doc = wrap([
      { type: 'heading', attrs: { level: 2 }, content: [mention] },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const inline = (out.content[0].content ?? [])[0].content?.[0];
    expect(inline).toEqual(mention);
  });

  it('coerces rule to em-dash paragraph', () => {
    const doc = wrap([{ type: 'rule' }]);
    const out = sanitizeAdfForJsm(doc);
    const child = (out.content[0].content ?? [])[0];
    expect(child.type).toBe('paragraph');
    expect(child.content?.[0].text).toBe('———');
  });

  it('inlines panel content with type label', () => {
    const doc = wrap([
      {
        type: 'panel',
        attrs: { panelType: 'warning' },
        content: [para('be careful')],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const children = out.content[0].content ?? [];
    expect(children[0].content?.[0].text).toBe('Warning:');
    expect(children[0].content?.[0].marks).toEqual([{ type: 'em' }]);
    expect(children[1].content?.[0].text).toBe('be careful');
  });

  it('inlines expand with bold title', () => {
    const doc = wrap([
      {
        type: 'expand',
        attrs: { title: 'Details' },
        content: [para('hidden body')],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const children = out.content[0].content ?? [];
    expect(children[0].content?.[0].text).toBe('Details');
    expect(children[0].content?.[0].marks).toEqual([{ type: 'strong' }]);
    expect(children[1].content?.[0].text).toBe('hidden body');
  });

  it('unwraps nested blockquote', () => {
    const doc = wrap([
      { type: 'blockquote', content: [para('inner')] },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const children = out.content[0].content ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].type).toBe('paragraph');
    expect(children[0].content?.[0].text).toBe('inner');
  });

  it('coerces taskList to bulletList with state prefix', () => {
    const doc = wrap([
      {
        type: 'taskList',
        attrs: { localId: 'tl' },
        content: [
          {
            type: 'taskItem',
            attrs: { localId: 't1', state: 'TODO' },
            content: [{ type: 'text', text: 'todo task' }],
          },
          {
            type: 'taskItem',
            attrs: { localId: 't2', state: 'DONE' },
            content: [{ type: 'text', text: 'done task' }],
          },
        ],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const list = (out.content[0].content ?? [])[0];
    expect(list.type).toBe('bulletList');
    const items = list.content ?? [];
    expect(items[0].content?.[0].content?.[0].text).toBe('[ ] ');
    expect(items[0].content?.[0].content?.[1].text).toBe('todo task');
    expect(items[1].content?.[0].content?.[0].text).toBe('[x] ');
  });

  it('coerces table to row paragraphs', () => {
    const cell = (text: string): AdfNode => ({
      type: 'tableCell',
      attrs: {},
      content: [para(text)],
    });
    const doc = wrap([
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('a'), cell('b')] },
          { type: 'tableRow', content: [cell('c'), cell('d')] },
        ],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const children = out.content[0].content ?? [];
    expect(children).toHaveLength(2);
    const rowOneText = (children[0].content ?? []).map((n) => n.text).join('');
    expect(rowOneText).toBe('a | b');
  });

  it('lifts non-paragraph table cell content out as separate blocks', () => {
    const codeCell: AdfNode = {
      type: 'tableCell',
      attrs: {},
      content: [
        para('label'),
        { type: 'codeBlock', content: [{ type: 'text', text: 'fn();' }] },
      ],
    };
    const textCell: AdfNode = {
      type: 'tableCell',
      attrs: {},
      content: [para('y')],
    };
    const doc = wrap([
      {
        type: 'table',
        content: [{ type: 'tableRow', content: [codeCell, textCell] }],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const children = out.content[0].content ?? [];
    expect(children.map((n) => n.type)).toEqual(['paragraph', 'codeBlock']);
    expect(children[1].content?.[0].text).toBe('fn();');
  });

  it('passes mediaSingle through unchanged', () => {
    const media: AdfNode = {
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{ type: 'media', attrs: { id: 'abc', type: 'file', collection: '' } }],
    };
    const doc = wrap([media]);
    const out = sanitizeAdfForJsm(doc);
    expect((out.content[0].content ?? [])[0]).toEqual(media);
  });

  it('recursively sanitizes nested invalid children', () => {
    const doc = wrap([
      {
        type: 'panel',
        attrs: { panelType: 'info' },
        content: [
          { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'inner' }] },
          { type: 'rule' },
        ],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    assertBlockquoteChildrenAllowed(out);
    const children = out.content[0].content ?? [];
    expect(children.every((c) => c.type === 'paragraph')).toBe(true);
  });

  it('leaves non-blockquote sections of the doc untouched', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Top' }] },
        { type: 'blockquote', content: [{ type: 'rule' }] },
      ],
    };
    const out = sanitizeAdfForJsm(doc);
    expect(out.content[0].type).toBe('heading');
    expect(out.content[1].type).toBe('blockquote');
    expect((out.content[1].content ?? [])[0].type).toBe('paragraph');
  });

  it('handles a heading + rule + nested list mix in a blockquote', () => {
    const doc = wrap([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Core Issue' }] },
      para('The user provided ...'),
      { type: 'rule' },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '3 Failures' }] },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para('item')] }],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    assertBlockquoteChildrenAllowed(out);
  });

  it('handles an empty blockquote', () => {
    const doc = wrap([]);
    const out = sanitizeAdfForJsm(doc);
    expect(out.content[0]).toEqual({ type: 'blockquote', content: [] });
  });

  it('falls back to Details for an expand without a title', () => {
    const doc = wrap([{ type: 'expand', attrs: {}, content: [para('body')] }]);
    const out = sanitizeAdfForJsm(doc);
    const children = out.content[0].content ?? [];
    expect(children[0].content?.[0].text).toBe('Details');
  });

  it('coerces decisionList to a bulletList with arrow prefix', () => {
    const doc = wrap([
      {
        type: 'decisionList',
        attrs: { localId: 'dl' },
        content: [
          {
            type: 'decisionItem',
            attrs: { localId: 'd1', state: 'DECIDED' },
            content: [{ type: 'text', text: 'ship it' }],
          },
        ],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const list = (out.content[0].content ?? [])[0];
    expect(list.type).toBe('bulletList');
    expect(list.content?.[0].content?.[0].content?.[0].text).toBe('→ ');
    expect(list.content?.[0].content?.[0].content?.[1].text).toBe('ship it');
  });

  it('falls back gracefully on an unknown block type by extracting inline content', () => {
    const doc = wrap([
      {
        type: 'someUnknownNode',
        content: [{ type: 'text', text: 'hello' }],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const child = (out.content[0].content ?? [])[0];
    expect(child.type).toBe('paragraph');
    expect(child.content?.[0].text).toBe('hello');
  });

  it('recurses into a nested blockquote inside an allowed list parent', () => {
    const doc = wrap([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'blockquote', content: [{ type: 'rule' }] },
            ],
          },
        ],
      },
    ]);
    const out = sanitizeAdfForJsm(doc);
    const inner = out.content[0].content?.[0].content?.[0].content?.[0];
    expect(inner?.type).toBe('blockquote');
    expect(inner?.content?.[0].type).toBe('paragraph');
    expect(inner?.content?.[0].content?.[0].text).toBe('———');
  });
});

/**
 * The inline vocabulary is `adfSchema.ts`'s, not a second copy. A copy missing `mediaInline` makes
 * the fixer treat it as a block where the checker (`profiles/jira.ts`) treats it as inline:
 * `fallbackCoerce` sends it to `coerceForBlockquote`, which has no branch for it, and the node is
 * silently dropped. Reaching `fallbackCoerce` needs an unknown block type (a paragraph or panel
 * fixture has its own branch). Unreachable through markdown only because `markdownToAdf` never
 * emits `mediaInline`.
 */
describe('the inline set is shared with adfSchema', () => {
  const withUnknownBlock = {
    version: 1,
    type: 'doc',
    content: [
      {
        type: 'blockquote',
        content: [
          {
            type: 'someUnknownBlock',
            content: [
              { type: 'text', text: 'see ' },
              { type: 'mediaInline', attrs: { id: 'abc', collection: 'c', type: 'file' } },
            ],
          },
        ],
      },
    ],
  };

  it('a mediaInline in an unknown container SURVIVES, in the paragraph with its text', () => {
    const out = sanitizeAdfForJsm(withUnknownBlock as never);
    const quote = out.content[0]!;
    expect(quote.content).toHaveLength(1);
    expect(quote.content![0]!.type).toBe('paragraph');
    // Both children, in order. A set missing `mediaInline` gives `['text']`: the media gone with
    // nothing reporting it.
    expect(quote.content![0]!.content!.map((n) => n.type)).toEqual(['text', 'mediaInline']);
  });

  it('and the set really is the schema module\'s, not a copy that agrees today', () => {
    expect(INLINE_TYPES.has('mediaInline')).toBe(true);
    expect(INLINE_TYPES.size).toBe(8);
  });
});
