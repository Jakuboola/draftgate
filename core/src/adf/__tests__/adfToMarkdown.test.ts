import { describe, expect, it } from 'bun:test';
import { convertAdfToMarkdown } from '../adfToMarkdown';
import { AdfDocument, AdfNode, MediaMap } from '../types';

function doc(...content: AdfNode[]): AdfDocument {
  return { version: 1, type: 'doc', content };
}

function p(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function text(t: string, marks?: AdfNode['marks']): AdfNode {
  return marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
}

describe('convertAdfToMarkdown', () => {
  it('writes each basic block and mark', () => {
    const li = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });
    const link = { type: 'link', attrs: { href: 'https://example.com' } };
    const ROWS: [AdfNode[], string][] = [
      [[p(text('Hello world'))], 'Hello world'],
      [[p(text('First')), p(text('Second'))], 'First\n\nSecond'],
      [
        [
          { type: 'heading', attrs: { level: 1 }, content: [text('H1')] },
          { type: 'heading', attrs: { level: 3 }, content: [text('H3')] },
        ],
        '# H1\n\n### H3',
      ],
      [[p(text('bold', [{ type: 'strong' }]))], '**bold**'],
      [[p(text('italic', [{ type: 'em' }]))], '*italic*'],
      [[p(text('deleted', [{ type: 'strike' }]))], '~~deleted~~'],
      [[p(text('click', [link]))], '[click](https://example.com)'],
      // No markdown spelling, so the text alone.
      [[p(text('styled', [{ type: 'underline' }, { type: 'textColor' }]))], 'styled'],
      [[p(text('line1'), { type: 'hardBreak' }, text('line2'))], 'line1\nline2'],
      [[{ type: 'bulletList', content: [li(p(text('one'))), li(p(text('two')))] }], '- one\n- two'],
      [[{ type: 'orderedList', content: [li(p(text('first'))), li(p(text('second')))] }], '1. first\n2. second'],
      [
        [{ type: 'orderedList', attrs: { order: 5 }, content: [li(p(text('fifth'))), li(p(text('sixth')))] }],
        '5. fifth\n6. sixth',
      ],
      [
        [{ type: 'bulletList', content: [li(p(text('parent')), { type: 'bulletList', content: [li(p(text('child')))] })] }],
        '- parent\n  - child',
      ],
      [
        [
          {
            type: 'taskList',
            content: [
              { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('done task')] },
              { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('open task')] },
            ],
          },
        ],
        '- [x] done task\n- [ ] open task',
      ],
      [[{ type: 'codeBlock', attrs: { language: 'typescript' }, content: [text('const x = 1;')] }], '```typescript\nconst x = 1;\n```'],
      [[{ type: 'codeBlock', content: [text('plain code')] }], '```\nplain code\n```'],
      [[{ type: 'blockquote', content: [p(text('quoted text'))] }], '> quoted text'],
      [[p(text('before')), { type: 'rule' }, p(text('after'))], 'before\n\n---\n\nafter'],
      [
        [
          {
            type: 'table',
            content: [
              { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(text('Name'))] }, { type: 'tableHeader', content: [p(text('Value'))] }] },
              { type: 'tableRow', content: [{ type: 'tableCell', content: [p(text('a'))] }, { type: 'tableCell', content: [p(text('1'))] }] },
            ],
          },
        ],
        '| Name | Value |\n| --- | --- |\n| a | 1 |',
      ],
      [[{ type: 'expand', attrs: { title: 'More info' }, content: [p(text('details here'))] }], '+++ More info\ndetails here\n+++'],
      // A node the writer has no branch for stays visible rather than vanishing.
      [[{ type: 'unknownWidget', content: [] }], '[unsupported: unknownWidget]'],
      [[], ''],
    ];
    for (const [content, expected] of ROWS) {
      expect(convertAdfToMarkdown(doc(...content)), JSON.stringify(content)).toBe(expected);
    }
  });

  // No clamp to H3: Jira renders six distinct levels (measured), and a destination with fewer is
  // its profile's business (see `walkHeading`).
  it('keeps H4-H6 at their own level', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 4 }, content: [text('H4')] },
      { type: 'heading', attrs: { level: 6 }, content: [text('H6')] }
    );
    const result = convertAdfToMarkdown(d);
    expect(result).toBe('#### H4\n\n###### H6');
  });

  it('and still clamps a level outside ADF\'s own range', () => {
    // The one clamp: ADF headings are 1-6, and `#`.repeat(9) is not markdown.
    const d = doc(
      { type: 'heading', attrs: { level: 9 }, content: [text('too deep')] },
      { type: 'heading', attrs: { level: 0 }, content: [text('too shallow')] }
    );
    expect(convertAdfToMarkdown(d)).toBe('###### too deep\n\n# too shallow');
  });

  it('writes a code span INSIDE the emphasis that covers it', () => {
    // `**`code`**` is what CommonMark says and GitHub's renderer returns. Where the combination
    // cannot be sent, the converter strips it and the profile says so
    // (`jira/code-span-emphasis-lost`); the writer is destination-blind.
    const result = convertAdfToMarkdown(
      doc(p(text('code', [{ type: 'code' }, { type: 'strong' }])))
    );
    expect(result).toBe('**`code`**');
  });

  it('applies code + link marks together', () => {
    const result = convertAdfToMarkdown(
      doc(p(text('code', [{ type: 'code' }, { type: 'link', attrs: { href: 'https://example.com' } }])))
    );
    expect(result).toBe('[`code`](https://example.com)');
  });

  it('applies combined strong + link marks', () => {
    const result = convertAdfToMarkdown(
      doc(
        p(
          text('bold link', [
            { type: 'strong' },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ])
        )
      )
    );
    expect(result).toBe('[**bold link**](https://example.com)');
  });

  it('moves leading whitespace outside mark delimiters', () => {
    const result = convertAdfToMarkdown(
      doc(p(text('hello'), text(' bold', [{ type: 'strong' }])))
    );
    expect(result).toBe('hello **bold**');
  });

  it('moves trailing whitespace outside mark delimiters', () => {
    const result = convertAdfToMarkdown(
      doc(p(text('bold ', [{ type: 'strong' }]), text('world')))
    );
    expect(result).toBe('**bold** world');
  });

  it('handles text with both leading and trailing whitespace', () => {
    const result = convertAdfToMarkdown(
      doc(p(text('a'), text(' bold ', [{ type: 'strong' }]), text('b')))
    );
    expect(result).toBe('a **bold** b');
  });

  it('preserves all-whitespace text nodes without wrapping', () => {
    const result = convertAdfToMarkdown(
      doc(p(text('a'), text(' ', [{ type: 'strong' }]), text('b')))
    );
    expect(result).toBe('a b');
  });

  it('handles adjacent strong and em text nodes correctly', () => {
    const result = convertAdfToMarkdown(
      doc(
        p(
          text('bold', [{ type: 'strong' }]),
          text(' '),
          text('italic', [{ type: 'em' }])
        )
      )
    );
    expect(result).toBe('**bold** *italic*');
  });

  it('indents a code block that is the sole child of a list item', () => {
    const result = convertAdfToMarkdown(
      doc({
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'codeBlock', content: [text('line one\nline two')] },
            ],
          },
          { type: 'listItem', content: [p(text('after'))] },
        ],
      })
    );
    expect(result).toBe(
      '1. ```\n   line one\n   line two\n   ```\n2. after'
    );
  });

  it('indents a code block following a paragraph in a list item', () => {
    const result = convertAdfToMarkdown(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              p(text('intro')),
              { type: 'codeBlock', content: [text('x = 1')] },
            ],
          },
        ],
      })
    );
    expect(result).toBe('- intro\n  ```\n  x = 1\n  ```');
  });

  it('keeps a code block inside a nested list item without breaking numbering', () => {
    // A code fence in a nested item must stay inside the list, and the outer numbering must go on.
    const result = convertAdfToMarkdown(
      doc({
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [
              p(text('observations:')),
              {
                type: 'orderedList',
                content: [
                  {
                    type: 'listItem',
                    content: [
                      { type: 'codeBlock', content: [text('ERROR: dev mode')] },
                    ],
                  },
                  { type: 'listItem', content: [p(text('fixed by Claude'))] },
                ],
              },
            ],
          },
          { type: 'listItem', content: [p(text('branch removal'))] },
        ],
      })
    );
    // Nested markers sit at the parent's content column (3 for "1. ")
    expect(result).toContain('   1. ```\n      ERROR: dev mode\n      ```');
    expect(result).toContain('\n   2. fixed by Claude\n2. branch removal');
  });

  it('indents nested ordered list past the parent marker width', () => {
    const result = convertAdfToMarkdown(
      doc({
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [
              p(text('parent')),
              {
                type: 'orderedList',
                content: [
                  { type: 'listItem', content: [p(text('child'))] },
                ],
              },
            ],
          },
          { type: 'listItem', content: [p(text('sibling'))] },
        ],
      })
    );
    // The tight form, with no blank line before the nested list.
    expect(result).toBe('1. parent\n   1. child\n2. sibling');
  });

  it('keeps a second paragraph inside its list item', () => {
    const result = convertAdfToMarkdown(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [p(text('first para')), p(text('second para'))],
          },
          { type: 'listItem', content: [p(text('next'))] },
        ],
      })
    );
    expect(result).toBe('- first para\n\n  second para\n- next');
  });

  it('indents hardBreak continuation lines inside a list item', () => {
    const result = convertAdfToMarkdown(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [p(text('line a'), { type: 'hardBreak' }, text('line b'))],
          },
        ],
      })
    );
    expect(result).toBe('- line a\n  line b');
  });

  it('converts media with resolved URL (image)', () => {
    const mediaMap: MediaMap = { 'uuid-123': 'https://cdn.example.com/img.png' };
    const result = convertAdfToMarkdown(
      doc({
        type: 'mediaSingle',
        content: [
          {
            type: 'media',
            attrs: { id: 'uuid-123', type: 'image', collection: '' },
          },
        ],
      }),
      mediaMap
    );
    expect(result).toContain('![uuid-123](https://cdn.example.com/img.png)');
  });

  it('converts media with alt text', () => {
    const mediaMap: MediaMap = { 'uuid-456': 'https://cdn.example.com/file.pdf' };
    const result = convertAdfToMarkdown(
      doc({
        type: 'mediaSingle',
        content: [
          {
            type: 'media',
            attrs: { id: 'uuid-456', type: 'file', collection: '', alt: 'report' },
          },
        ],
      }),
      mediaMap
    );
    expect(result).toContain('[report](https://cdn.example.com/file.pdf)');
  });

  it('produces placeholder for unresolved media', () => {
    const result = convertAdfToMarkdown(
      doc({
        type: 'mediaSingle',
        content: [
          { type: 'media', attrs: { id: 'missing-uuid', type: 'file' } },
        ],
      })
    );
    expect(result).toContain('[Attachment "missing-uuid" could not be resolved]');
  });

  it('uses __fileName for media display name when available', () => {
    const mediaMap: MediaMap = { 'uuid-789': 'https://cdn.example.com/file.png' };
    const result = convertAdfToMarkdown(
      doc({
        type: 'mediaSingle',
        content: [
          {
            type: 'media',
            attrs: { id: 'uuid-789', type: 'file', __fileName: 'screenshot.png' },
          },
        ],
      }),
      mediaMap
    );
    expect(result).toContain('![screenshot.png](https://cdn.example.com/file.png)');
  });

  it('writes a mention as its @display text', () => {
    const mention = (attrs: Record<string, unknown>) => convertAdfToMarkdown(doc(p({ type: 'mention', attrs })));
    expect(mention({ id: 'acc-1', text: '@John' })).toBe('@John');
    expect(mention({ id: 'acc-1', text: 'John' })).toBe('@John');
    expect(mention({ id: 'acc-1' })).toBe('@Unknown');
  });

  it('counts a mention as text when its block decides whether it needs escaping', () => {
    const jane = { type: 'mention', attrs: { id: 'acc-1', text: '@Jane' } };
    // Beside a mention, a literal `*lit*` is still literal.
    expect(convertAdfToMarkdown(doc(p(text('hi '), jane, text(' and *lit*'))))).toBe('hi @Jane and \\*lit\\*');
    // And the label is text too: bare, `@J*ne*` reads back as `@J` and an italic `ne`.
    const starred = { type: 'mention', attrs: { id: 'acc-1', text: '@J*ne*' } };
    expect(convertAdfToMarkdown(doc(p(text('hi '), starred)))).toBe('hi @J\\*ne\\*');
  });

});
