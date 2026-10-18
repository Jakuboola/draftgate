/**
 * markdown <-> TipTap document mapping: ADF is already a ProseMirror schema, so the editor needs no
 * second markdown parser, only a node-name mapping over the converter. Checked node type by node
 * type and through the full round trip.
 */

import { describe, expect, test } from 'bun:test';
import {
  toEditorDoc, editorDocFor, fromEditorDoc, editorDocToAdf, editorOptionsFor, lostInMarkdown, lostMarks,
} from '../src/editor';
import { render } from '../src/render';
import { baselineFor } from '../src/editor';
import { matchTrailingNewline } from '../src/markdown';
import type { AdfDocument, AdfNode } from '../src/adf/types';
import type { PmNode } from '../src/prosemirror';
import { adfToProseMirror, proseMirrorToAdf } from '../src/prosemirror';
import { convertAdfToMarkdown, convertMarkdownToAdf } from '../src/adf';
import { nodeTypes, markTypes, PM_KNOWN, profiles, walk } from '../src/index';
import { compare } from './spec/normalise';
import type { DestinationName } from '../src/index';
import { expectGolden, shippedBodies, tortureFixture } from './golden';

// One walk, core's, for the source and the tests.
const types = (n: unknown) => nodeTypes(n as any);
const marks = (n: unknown) => markTypes(n as any);

describe('node names TipTap expects', () => {
  const doc = toEditorDoc(tortureFixture());

  test('every node maps to a name TipTap knows', () => {
    // The registry itself, imported rather than re-listed.
    for (const t of types(doc)) expect(PM_KNOWN).toContain(t);
  });

  test('rule becomes horizontalRule, not ADF rule', () => {
    expect(types(doc)).toContain('horizontalRule');
    expect(types(doc)).not.toContain('rule');
  });

  test('mediaSingle collapses to a flat image node', () => {
    expect(types(doc)).toContain('image');
    expect(types(doc)).not.toContain('mediaSingle');
    expect(types(doc)).not.toContain('media');
  });

  test('marks use TipTap names', () => {
    const m = marks(doc);
    expect(m).toContain('bold');
    expect(m).toContain('italic');
    expect(m).toContain('strike');
    expect(m).toContain('code');
    expect(m).toContain('link');
    // ADF spellings must be gone.
    expect(m).not.toContain('strong');
    expect(m).not.toContain('em');
  });

  test('golden, so a mapping change is visible in a diff', () => {
    expectGolden('torture-fixture.editor-doc.json', doc);
  });
});

describe('attribute translation', () => {
  test('task state becomes a boolean, both ways', () => {
    const doc = toEditorDoc('- [ ] open\n- [x] done\n');
    const items: any[] = [];
    (function w(n: any) {
      if (n?.type === 'taskItem') items.push(n);
      for (const c of n?.content ?? []) w(c);
    })(doc);
    expect(items.map((i) => i.attrs.checked)).toEqual([false, true]);
    expect(items.every((i) => i.attrs.state === undefined)).toBe(true);

    // and back
    const adf = editorDocToAdf(doc);
    const states: string[] = [];
    (function w(n: any) {
      if (n?.type === 'taskItem') states.push(n.attrs.state);
      for (const c of n?.content ?? []) w(c);
    })(adf);
    expect(states).toEqual(['TODO', 'DONE']);
  });

  test('ordered list start survives the round trip', () => {
    const adf = convertMarkdownToAdf('3. three\n4. four\n');
    const pm: any = adfToProseMirror(adf);
    const list = pm.content.find((n: any) => n.type === 'orderedList');
    expect(list.attrs.start).toBe(3);
    expect(list.attrs.order).toBeUndefined();
    const back: any = proseMirrorToAdf(pm);
    expect(back.content.find((n: any) => n.type === 'orderedList').attrs.order).toBe(3);
  });

  test('and a list numbered from 0 is SENT numbered from 0', () => {
    // 0 is the one falsy start: `order || 1` would send `1.`, `2.`. PROBED: Jira stores `order: 0`
    // (201), so nothing is renumbered or warned.
    for (const destination of ['jira', 'slack', 'linear', 'github'] as const) {
      const shown = baselineFor(render('0. zero\n1. one\n', destination)).body;
      expect(shown, destination).toBe('0. zero\n1. one\n');
      // What Jira receives: the shown body, converted.
      if (destination === 'jira') {
        expect((render(shown, 'jira').converted as AdfDocument).content[0]?.attrs?.order).toBe(0);
      }
    }
  });

  test('a nested list numbered from anything but 1 is sent after a blank line, or CommonMark loses it', () => {
    // Only a list starting at 1 may interrupt a paragraph, so `- a` / `  0. zero` is one paragraph to
    // every markdown reader. Checked against micromark + GFM: this converter reads both spellings
    // as nested. Under a bullet and under a checklist item.
    for (const parent of ['- a', '- [ ] a']) {
      for (const [start, next] of [[0, 1], [3, 4]]) {
        const body = `${parent}\n  ${start}. c\n  ${next}. d\n`;
        for (const destination of ['slack', 'linear', 'github'] as const) {
          const out = baselineFor(render(body, destination)).body;
          expect(out, `${destination} ${body}`).toBe(`${parent}\n\n  ${start}. c\n  ${next}. d\n`);
          expect(compare(out).kind, `${destination} ${body}`).not.toBe('differ');
        }
      }
    }
    // A list from 1 still interrupts, so it stays tight.
    expect(baselineFor(render('- a\n  1. c\n', 'github')).body).toBe('- a\n  1. c\n');
  });

  test('heading level and code language pass through untouched', () => {
    const doc: any = toEditorDoc('### Three\n\n```python\nx = 1\n```\n');
    expect(doc.content.find((n: any) => n.type === 'heading').attrs.level).toBe(3);
    expect(doc.content.find((n: any) => n.type === 'codeBlock').attrs.language).toBe('python');
  });

  test('an image keeps its src and alt, inside the paragraph a block position needs', () => {
    // `image` is inline in the editor, as in markdown, so a top-level `mediaSingle` gets a
    // paragraph of its own (`doc` holds blocks). See `Editor.tsx`.
    const doc: any = toEditorDoc('![diagram](https://example.com/d.png)\n');
    const wrapper = doc.content.find((n: any) => n.content?.some((c: any) => c.type === 'image'));
    expect(wrapper.type).toBe('paragraph');
    const img = wrapper.content.find((n: any) => n.type === 'image');
    expect(img.attrs.src).toBe('https://example.com/d.png');
    expect(img.attrs.alt).toBe('diagram');
  });

  test('empty ADF localId is dropped going in and restored coming out', () => {
    // The converter emits `localId: ''` and Jira accepts it (PROBED); TipTap has no such attribute.
    const doc = JSON.stringify(toEditorDoc('- [x] done\n'));
    expect(doc).not.toContain('localId');
    expect(JSON.stringify(editorDocToAdf(toEditorDoc('- [x] done\n')))).toContain('"localId":""');
  });

  test('TipTap null attrs do not leak into ADF', () => {
    const pm: any = { type: 'doc', content: [
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x' }] },
    ] };
    expect(JSON.stringify(proseMirrorToAdf(pm))).not.toContain('null');
  });
});

describe('ADF structural rules are respected on the way back', () => {
  test('an inline image is hoisted out of its paragraph', () => {
    // TipTap keeps `image` inline; ADF requires `mediaSingle` as a block sibling. Jira accepts the
    // hoisted shape (PROBED).
    const pm: any = { type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'before ' },
        { type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'a' } },
        { type: 'text', text: ' after' },
      ] },
    ] };
    const adf: any = proseMirrorToAdf(pm);
    expect(adf.content.map((n: any) => n.type)).toEqual(['paragraph', 'mediaSingle', 'paragraph']);
    expect(JSON.stringify(adf.content[1])).toContain('"type":"external"');
    expect(adf.content[0].content[0].text).toBe('before ');
    expect(adf.content[2].content[0].text).toBe(' after');
  });

  test('a jira-media: src maps back to a file media node, not an external one', () => {
    const pm: any = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'jira-media:abc123' } }] },
    ] };
    const adf: any = proseMirrorToAdf(pm);
    const media = adf.content[0].content[0];
    expect(media.attrs.type).toBe('file');
    expect(media.attrs.id).toBe('abc123');
  });

  test('an empty document still yields a valid doc for TipTap', () => {
    const doc: any = toEditorDoc('');
    expect(doc.type).toBe('doc');
    expect(doc.content.length).toBeGreaterThan(0);
  });
});

describe('full round trip: markdown -> editor -> markdown', () => {
  test('the fixture survives, apart from the known ADF normalisations', () => {
    const back = fromEditorDoc(toEditorDoc(tortureFixture()));
    expectGolden('torture-fixture.editor-roundtrip.json', { markdown: back });

    for (const fragment of [
      '# Deploy postmortem',
      '| 09:12 | Alert fired | Jakub |',
      '- [x] Checked task',
      '- [ ] Unchecked task',
      '> Blockquote with **bold** inside.',
      '```python',
      '---',
      'https://example.com/a.png',
      '`inline code`',
      '~~strike~~',
    ]) {
      expect(back).toContain(fragment);
    }
  });

  test('editing the document changes only what was edited', () => {
    const doc: any = toEditorDoc('# Title\n\nHello world.\n');
    // Simulate a human edit.
    doc.content[1].content[0].text = 'Hello, edited world.';
    const out = fromEditorDoc(doc);
    expect(out).toContain('# Title');
    expect(out).toContain('Hello, edited world.');
    expect(out).not.toContain('Hello world.');
  });

  /**
   * Idempotence over a corpus, not one fixture. A seeded fuzz over 4,000 generated documents found
   * exactly two classes where a second pass changes something, pinned in the next block, so a third
   * class fails here. The fuzz is not in the suite; the shapes it found are.
   */
  describe('the mapping is idempotent -- everywhere it actually is', () => {
    const bodies: [string, string][] = [
      // Every document the repo ships, enumerated from disk.
      ...shippedBodies(),
      ['nothing at all', ''],
      ['a bare paragraph', 'Hello world.\n'],
      ['every mark at once', '**b** *i* `c` ~~s~~ [l](https://x.dev)\n'],
      ['a table', '| a | b |\n| --- | --- |\n| 1 | 2 |\n'],
      ['nested lists', '1. one\n2. two\n   - nested\n     - deeper\n'],
      ['task items', '- [ ] todo\n- [x] done\n'],
      ['a quote holding a list', '> - one\n> - two\n'],
      ['a fenced block with a language', '```py\nz = 1\n```\n'],
      ['a rule between paragraphs', 'above\n\n---\n\nbelow\n'],
      ['a bare URL', 'See https://example.org now.\n'],
      ['an image on its own line', '![i](https://example.com/a.png)\n'],
      ['a mention', 'ping [@Jakub](mention:557058:abc)\n'],
    ];

    for (const [label, body] of bodies) {
      test(label, () => {
        const once = fromEditorDoc(toEditorDoc(body));
        expect(fromEditorDoc(toEditorDoc(once))).toBe(once);
      });
    }
  });

  /** The two classes where a second pass can change something, pinned to exact outputs. */
  describe('and the two shapes where a second pass can change something', () => {
    const passes = (md: string, n: number) => {
      let out = md;
      for (let i = 0; i < n; i++) out = fromEditorDoc(toEditorDoc(out));
      return out;
    };

    test('media in an inline container is STABLE under the default placement', () => {
      /*
       * The default (`mediaPlacement: 'inline'`) leaves media where markdown put it, so one pass is
       * a fixed point. A hoisting placement leaves the image indented under the item, the re-parse
       * reads it as still inside, and the hoist fires again; Jira's case is below.
       *
       * The `#####` comes back escaped: the converter reads an item's first line as text, and
       * written bare every markdown destination would render a heading the preview does not show.
       */
      const md = '1. ##### `c` ![img](https://e.com/a.png)\n';
      expect(passes(md, 1)).toBe('1. \\##### `c` ![img](https://e.com/a.png)');
      expect(passes(md, 2)).toBe(passes(md, 1));
    });

    test('and it still converges when the destination DOES hoist', () => {
      // Jira's placement (inline media is a 400 there): a fixed point within four passes, URL kept.
      const hoisting = (md: string, n: number) => {
        let out = md;
        for (let i = 0; i < n; i++) {
          out = fromEditorDoc(toEditorDoc(out, { mediaPlacement: 'block' }), {
            mediaPlacement: 'block',
          });
        }
        return out;
      };
      const md = '1. ##### `c` ![img](https://e.com/a.png)\n';
      expect(hoisting(md, 4)).toBe(hoisting(md, 3));
      expect(hoisting(md, 4)).toContain('![img](https://e.com/a.png)');
    });

    test('a backslash escape is not NEEDED beside a bold run, and survives where it is', () => {
      // `e\*sc` comes back as `e*sc`. A second parse (reachable through `applyFix`) that ignored
      // flanking would pair the freed `*` with the bold's marker:
      //
      //   pass 1  'e*sc **b**'      pass 2  'e*sc b**'       the bold is gone
      //   'a\*b **c** *d*'  ->     pass 2  'a*b c* d*'      both marks mangled
      //   'back \\\*'      ->     pass 2  'back *'         the backslash is gone
      //
      // The italic rule's flanking guards (`markdownToAdf.ts`) make `e*sc **b**` re-parse to
      // itself, so the conditional escape repair does not fire and the author's backslash is not
      // written back. Not a loss, MEASURED through GitHub's renderer (`POST /markdown`):
      //
      //   'e\*sc **b**'     ->  <p>e*sc <strong>b</strong></p>
      //   'e*sc **b**'      ->  <p>e*sc <strong>b</strong></p>
      //   'a\*b **c** *d*'  ->  <p>a*b <strong>c</strong> <em>d</em></p>
      //   'a*b **c** *d*'   ->  <p>a*b <strong>c</strong> <em>d</em></p>
      expect(passes('e\\*sc **b**\n', 1)).toBe('e*sc **b**');
      expect(passes('e\\*sc **b**\n', 2)).toBe('e*sc **b**');
      expect(passes('a\\*b **c** *d*\n', 2)).toBe('a*b **c** *d*');
      // Still escaped where needed: a literal backslash beside a literal asterisk.
      expect(passes('back \\\\\\*\n', 2)).toBe('back \\\\\\*');
      // Idempotent from the first pass.
      expect(passes('e\\*sc **b**\n', 1)).toBe(passes('e\\*sc **b**\n', 2));
      // And the bold is not eaten.
      expect(passes('e\\*sc **b**\n', 2)).toContain('**b**');
      expect(passes('a\\*b **c** *d*\n', 2)).toContain('**c**');
    });

    test('and ordinary prose gains NO backslashes, which is why escaping is conditional', () => {
      // Escaping always would pass the cases above and send `[~accountid:x]` as `\[\~accountid:x]`
      // on any edit, so escaping applies only to a document whose text does not survive a re-parse.
      for (const md of [
        'a * b',
        '2 * 3 = 6',
        'Hi [~accountid:557058:abc], look.',
        'about ~5 min',
        '[TODO] fix it',
      ]) {
        expect(passes(md, 1)).toBe(md);
        expect(passes(md, 2)).toBe(md);
      }
    });

    test('and the repair applies to EVERY destination, as probed', () => {
      /*
       * Not gated to `convert-and-replace`. PROBED: the same lines through `slack_send_message` to
       * a DM and `save_comment` to a Linear issue, screenshotted:
       *
       *   line          Slack                       Linear
       *   e\*sc **b**   'e*sc b' -- no backslash     same
       *   e*sc **b**    the `*` is consumed          the `*` stays literal
       *   see \[x](y)   literal, no backslash        literal, no backslash
       *   see [x](y)    a live link                  a live link
       *   a \~t\~       literal, no backslash        literal, no backslash
       *   back \\*      'back \' -- one backslash    'back \*'
       *
       * Both honour the escape and render markdown link syntax (Slack's tool converts its `message`
       * on the way in), so ungated the reviewer's literal `[x](y)` stays literal.
       */
      const literal = 'see \\[not a link](x) here';
      for (const dest of ['jira', 'slack', 'linear'] as const) {
        const r = render(literal, dest);
        expect(fromEditorDoc(toEditorDoc(r.canonical))).toBe(literal);
      }
    });

    test('and a code span keeps its backslashes literal', () => {
      // Inside a code span a backslash is a character the recipient sees; `applyMarks` handles the
      // code case itself, with the raw text.
      expect(passes('a `path\\to\\file` and \\* here\n', 1)).toContain('`path\\to\\file`');
    });

    test('and every heading level SURVIVES the round trip -- no clamp to h3', () => {
      // A clamp in the shared writer is stable, so the idempotence tests cannot see it.
      // `tools/jira-ruler` measures six distinct heading sizes, and `applyFix` reaches this writer,
      // so a clamp would ship a reviewer's h5 as h3. A per-destination limit lives in the profile.
      for (const [md, expected] of [
        ['# one\n', '# one'],
        ['## two\n', '## two'],
        ['### three\n', '### three'],
        ['#### four\n', '#### four'],
        ['##### five\n', '##### five'],
        ['###### six\n', '###### six'],
      ] as const) {
        expect(passes(md, 1)).toBe(expected);
        expect(passes(md, 2)).toBe(expected);
      }
    });
  });

  test('mapping is lossless at the ADF level for a document with no media', () => {
    // No media: it changes shape (mediaSingle <-> image).
    const md = '# H\n\n**b** *i* `c` ~~s~~ [l](https://x.dev)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n1. one\n2. two\n   - nested\n\n- [ ] t\n- [x] d\n\n> q\n\n```py\nz=1\n```\n\n---\n';
    const adf = convertMarkdownToAdf(md);
    const back = proseMirrorToAdf(adfToProseMirror(adf));
    // Deep equality: the mapping rebuilds attribute objects, so key order may differ.
    expect(back).toEqual(adf);
  });
});

/**
 * What the editor can hold that markdown cannot carry. `toEditorDoc` loads only what markdown
 * expresses, but TipTap's schema lets a reviewer build more, and `fromEditorDoc` mangles it without
 * complaint. `lostInMarkdown` (bottom of this describe) detects it and `render()` blocks the send.
 * Written as documents, since no markdown produces them.
 */
describe('documents the editor permits that markdown cannot express', () => {
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

  /**
   * Reachable: a table cell is `block+`, so Enter and then a quote builds it. A quote in a checklist
   * item has a spelling (`- [ ] x` over two-space `> quoted`); the test below pins it.
   */
  const quotedCell = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p('x'), { type: 'blockquote', content: [p('quoted')] }] },
            ],
          },
        ],
      },
    ],
  } as unknown as PmNode;

  const quotedTask = {
    type: 'doc',
    content: [
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [p('x'), { type: 'blockquote', content: [p('quoted')] }],
          },
        ],
      },
    ],
  } as unknown as PmNode;

  test('a blockquote inside a table cell is CONCATENATED into the text', () => {
    // Joined with no separator: "x> quoted" is one line of prose, and the quote is gone.
    expect(fromEditorDoc(quotedCell)).toBe('| x> quoted |\n| --- |');
  });

  test('a blockquote inside a task item is CARRIED, indented under the item', () => {
    // An item owns the lines indented under it. Jira moves the quote out and says so
    // (`jira/list-item-block-moved-out`).
    const md = fromEditorDoc(quotedTask);
    expect(md).toBe('- [ ] x\n  > quoted');
    const options = { listItemBlocks: 'all' as const };
    expect(lostInMarkdown(quotedTask, toEditorDoc(md, options))).toEqual([]);
    expect(fromEditorDoc(toEditorDoc(md, options))).toBe(md);
  });

  test('a bullet list inside a table cell flattens, and the row becomes the header', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'bulletList', content: [{ type: 'listItem', content: [p('a')] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as PmNode;
    expect(fromEditorDoc(doc)).toBe('| - a |\n| --- |');
  });

  test('a heading inside a list item is written as one, which GFM does not carry', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
              ],
            },
          ],
        },
      ],
    } as unknown as PmNode;
    expect(fromEditorDoc(doc)).toBe('- ## H');
  });

  test('and the markdown does not read back as the document that produced it', () => {
    // The serialiser does not throw, so EditorBoundary never fires; `lostInMarkdown` detects the
    // difference and `render()` blocks with `body/structure-lost` (below).
    const md = fromEditorDoc(quotedCell);
    const reread = toEditorDoc(md);
    expect(types(quotedCell)).toContain('blockquote');
    expect(types(reread)).not.toContain('blockquote');
    expect(fromEditorDoc(reread)).toBe(md);
  });

  /**
   * The detector, a round trip rather than a hand-written table, so it cannot disagree with the
   * converter. What it reports and ignores, with measurements, is in `lostInMarkdown`'s docstring.
   */
  describe('lostInMarkdown catches them, and stays quiet on everything else', () => {
    const loss = (doc: PmNode) => lostInMarkdown(doc, toEditorDoc(fromEditorDoc(doc)));

    test('a blockquote inside a table cell is reported, and NAMED with its container', () => {
      // `[0, 0, 0, 1]`: table, row, cell, then the blockquote as the cell's second child. The
      // window resolves this path against the real document to outline it.
      expect(loss(quotedCell)).toEqual([
        { type: 'blockquote', parent: 'tableHeader', path: [0, 0, 0, 1] },
      ]);
    });

    test('a bullet list inside a table cell is reported', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      { type: 'bulletList', content: [{ type: 'listItem', content: [p('a')] }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as PmNode;
      expect(loss(doc).map((l) => l.type)).toContain('bulletList');
    });

    test('a heading inside a list item is reported', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
                ],
              },
            ],
          },
        ],
      } as unknown as PmNode;
      expect(loss(doc)).toEqual([{ type: 'heading', parent: 'listItem', path: [0, 0, 0] }]);
    });

    test('every document this repo ships reports NOTHING, under all six option sets', () => {
      // The false-positive test. Every option combination, since `mediaPlacement: 'block'` moves
      // media on purpose. Six: `structuralMentions` x the three media shapes a destination has
      // (block-placed media on one that draws none does not exist).
      for (const [label, body] of shippedBodies()) {
        for (const structuralMentions of [false, true]) {
          for (const [mediaPlacement, rendersMedia] of [
            ['inline', true],
            ['block', true],
            ['inline', false],
          ] as const) {
            const options = { structuralMentions, mediaPlacement, rendersMedia };
            const doc = toEditorDoc(body, options);
            expect(
              lostInMarkdown(doc, toEditorDoc(fromEditorDoc(doc), options)),
              `${label} ${JSON.stringify(options)}`
            ).toEqual([]);
          }
        }
      }
    });

    test('text runs coalescing is not a loss, and neither is media moving', () => {
      // The two shapes that make a naive diff report 4% of generated documents: equal-mark text
      // runs merge on re-parse, and `hoistMedia` relocates media.
      const merging = toEditorDoc('**a** b `c` d\n');
      expect(lostInMarkdown(merging, toEditorDoc(fromEditorDoc(merging)))).toEqual([]);
      const moving = toEditorDoc('- [ ] look ![i](https://example.com/a.png)\n', {
        mediaPlacement: 'block' as const,
        rendersMedia: true,
      });
      const placement = { mediaPlacement: 'block' } as const;
      expect(lostInMarkdown(moving, toEditorDoc(fromEditorDoc(moving, placement), placement))).toEqual([]);
    });

    test("the editor's trailing empty paragraph is not a loss", () => {
      // ProseMirror keeps an empty paragraph at the end so a reviewer can click below the last
      // block. Markdown cannot carry it, and counting it would make ticking a checkbox block the
      // send. `toEditorDoc` never builds it, so this is hand-written in the live editor's shape.
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'taskList',
            content: [
              { type: 'taskItem', attrs: { checked: true }, content: [p('one')] },
              { type: 'taskItem', attrs: { checked: true }, content: [p('two')] },
            ],
          },
          { type: 'paragraph' },
        ],
      } as unknown as PmNode;
      expect(loss(doc)).toEqual([]);
    });

    test('a lone lost paragraph IS reported -- it is only dropped when something else went too', () => {
      // `paragraph` is usually the mechanism (two merge when a block flattens), so it is not named
      // beside a real loss. Here, two paragraphs in one table cell, which markdown writes on one line.
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p('one'), p('two')] }] }],
          },
        ],
      } as unknown as PmNode;
      // The first paragraph: one occurrence per lost type, outermost then earliest.
      expect(loss(doc)).toEqual([{ type: 'paragraph', parent: 'tableHeader', path: [0, 0, 0, 0] }]);
    });
  });
});

describe('what the toolbar may insert must survive the markdown round trip', () => {
  // The rule behind `ToolbarInsert`: no control inserts what the wire cannot carry.
  const rt = (md: string) => fromEditorDoc(toEditorDoc(md));

  test('Unicode emoji survive byte-identically -- which is why the picker is safe', () => {
    expect(rt('Shipped it 🎉 and 🚀 done.')).toBe('Shipped it 🎉 and 🚀 done.');
  });

  test('an image reference survives, though ADF promotes it out of the paragraph', () => {
    // URL and alt text survive; ADF's block promotion is in the round-trip golden.
    const out = rt('See ![diagram](https://example.com/a.png) here.');
    expect(out).toContain('![diagram](https://example.com/a.png)');
  });

  test('markdown CAN carry a user id -- it is text, and text survives', () => {
    // Any string survives. Only a mention node lacks a markdown spelling (next test); Slack's
    // `<@U123>` and Linear's `@displayName` are ids as text.
    expect(rt('Hi [~accountid:557058:abc], look.')).toBe('Hi [~accountid:557058:abc], look.');
    expect(rt('ping <@U0123ABCDEF> please')).toBe('ping <@U0123ABCDEF> please');
    expect(rt('ping @johndoe please')).toBe('ping @johndoe please');
  });

  test('a mention NODE KEEPS its id', () => {
    // `mentions.ts` encodes the node as `[@Label](mention:ID)` and decodes it back, over the
    // converter's output. Without it `fromEditorDoc` gives `Hi @Jakub` and the id is gone. The full
    // round trip and the Jira probe: `core/test/mentions.test.ts`.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hi ' },
            { type: 'mention', attrs: { id: '557058:abc', label: 'Jakub' } },
          ],
        },
      ],
    } as unknown as Parameters<typeof fromEditorDoc>[0];

    expect(JSON.stringify(editorDocToAdf(doc))).toContain('557058:abc');
    expect(fromEditorDoc(doc)).toBe('Hi [@Jakub](mention:557058:abc)');
    expect(fromEditorDoc(doc)).toContain('557058:abc');
  });
});

/**
 * The document the reviewer reads against the document that is sent. Jira hoists media, so a
 * window that did not would draw an image in a heading while the CLI sends it after the block, and
 * an untouched approval would record `edited: false`. The markdown destinations keep media where
 * the agent wrote it, so the profile's `mediaPlacement` decides and `editorDocFor` reads it.
 */
describe('the window shows the tree its destination will receive', () => {
  const withImages =
    '# Title ![img](https://example.com/A.png)\n\n' +
    '- [ ] look ![shot](https://example.com/B.png)\n- [ ] second\n\n' +
    'para after\n\npara two\n';

  test('jira: the editor document IS the converted ADF, node for node', () => {
    // The ADF being sent, in editor terms, equals what the window loads. Not
    // `editorDocToAdf(toEditorDoc(md))`: `proseMirrorToAdf` hoists on the way out, so that is equal
    // whatever the window shows.
    const sent = render(withImages, 'jira');
    expect(editorDocFor(sent)).toEqual(adfToProseMirror(sent.converted as AdfDocument));
  });

  test('jira: the images are where jira puts them, not where the markdown wrote them', () => {
    const doc = editorDocFor(render(withImages, 'jira')) as PmNode;
    const heading = doc.content?.find((n) => n.type === 'heading');
    expect(heading?.content?.some((n) => n.type === 'image')).toBe(false);
    // Out of their containers and immediately after them, not at the end of the document. PROBED:
    // a `mediaSingle` between a paragraph and a heading is a 201 and reads back in that order.
    const types = doc.content?.map((n) =>
      n.type === 'paragraph' && n.content?.length === 1 && n.content[0]?.type === 'image'
        ? 'image'
        : n.type
    );
    expect(types).toEqual([
      'heading',   // '# Title'
      'image',     // ...the image that was inside it
      'taskList',
      'image',     // ...the image that was inside the first task item
      'paragraph', // 'para after'
      'paragraph', // 'para two'
    ]);
  });

  test('slack: the image stays in the heading, as the LINK slack renders there', () => {
    /*
     * `rendersMedia: false`: Slack draws no picture (PROBED; `slack/image-becomes-link`), so the
     * editor holds the link Slack shows, where it shows it. Also keeps the sentence whole: ADF has no
     * inline media, so an image would split `See ![x](url) for the timeline.` into three blocks.
     */
    const doc = editorDocFor(render(withImages, 'slack')) as PmNode;
    const heading = doc.content?.find((n) => n.type === 'heading');
    expect(heading?.content?.map((n) => n.type)).toEqual(['text', 'text']);
    const link = heading?.content?.[1];
    expect(link?.marks?.map((m) => m.type)).toEqual(['link']);
    expect(link?.text).toBe('img');
  });

  test('slack: and an inline image does not split the sentence around it', () => {
    // Through ADF this would be three blocks.
    const doc = editorDocFor(render('See ![x](https://e.test/a.png) for the timeline.\n', 'slack')) as PmNode;
    expect(doc.content?.map((n) => n.type)).toEqual(['paragraph']);
    expect(doc.content?.[0]?.content?.map((n) => n.type)).toEqual(['text', 'text', 'text']);
  });

  test('linear: the image itself, inline, because linear draws a picture there', () => {
    const doc = editorDocFor(render(withImages, 'linear')) as PmNode;
    expect(
      doc.content?.find((n) => n.type === 'heading')?.content?.some((n) => n.type === 'image')
    ).toBe(true);
  });

  test('linear: an inline image does not split the sentence around it, either way', () => {
    /*
     * `mediaPlacement: 'inline'` needs both legs, `inlineMedia` in and the paragraph-child trim out,
     * because the trip goes through ADF (no inline media) twice.
     */
    const body = 'See ![x](https://e.test/a.png) for the timeline.\n';
    const r = render(body, 'linear');
    const doc = editorDocFor(r) as PmNode;
    expect(doc.content?.map((n) => n.type)).toEqual(['paragraph']);
    expect(doc.content?.[0]?.content?.map((n) => n.type)).toEqual(['text', 'image', 'text']);
    // And back out byte-identically: what an approval sends.
    expect(fromEditorDoc(doc, { mediaPlacement: r.mediaPlacement })).toBe(body.trimEnd());
  });

  test('linear: a heading and a checklist item keep their media too', () => {
    /*
     * The trim reads `INLINE_ONLY` from `adfSchema.ts`. A trim in `walkParagraph` only would send
     * `"# See ![d](url)\n\n here"`, and `lostInMarkdown` cannot see it: the paragraph count goes up.
     */
    for (const body of [
      '# See ![d](https://e.test/a.png) here\n',
      '- [ ] task ![d](https://e.test/a.png) here\n',
    ]) {
      const r = render(body, 'linear');
      expect(fromEditorDoc(editorDocFor(r), { mediaPlacement: r.mediaPlacement })).toBe(body.trimEnd());
    }
  });

  test('slack: the editor cannot hold an image at all', () => {
    /*
     * `editorExtensions` also declines to register the image node (TipTap parses `img[src]`, so an
     * HTML paste could add one). With it registered, `imagesAsLinks` drops a pasted image on
     * re-parse and the draft blocks on `body/structure-lost` with no repair. The schema half is
     * `surface/schema.test.ts`.
     */
    expect(render('x', 'slack').rendersMedia).toBe(false);
    expect(render('x', 'jira').rendersMedia).toBe(true);
    expect(render('x', 'linear').rendersMedia).toBe(true);
  });

  test('slack: an image with no alt text becomes a link that IS one', () => {
    // `[](url)` is not a link: the converter leaves an empty label as literal text.
    const r = render('![](https://e.test/a.png)\n', 'slack');
    expect(fromEditorDoc(editorDocFor(r), { mediaPlacement: r.mediaPlacement })).toBe(
      '[https://e.test/a.png](https://e.test/a.png)'
    );
  });

  test('jira: the sentence IS split, and that is the truthful answer for jira', () => {
    // The negative control: ADF cannot hold inline media, so Jira receives three blocks.
    const r = render('See ![x](https://e.test/a.png) for the timeline.\n', 'jira');
    const doc = editorDocFor(r) as PmNode;
    expect(doc.content?.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  test('and the two destinations really do disagree, so neither case is vacuous', () => {
    expect(editorDocFor(render(withImages, 'jira'))).not.toEqual(
      editorDocFor(render(withImages, 'slack'))
    );
  });

  test('a draft with no media loads identically for all three', () => {
    const plain = '# Title\n\n- [ ] one\n- [x] two\n\nbody\n';
    const jira = editorDocFor(render(plain, 'jira'));
    expect(editorDocFor(render(plain, 'slack'))).toEqual(jira);
    expect(editorDocFor(render(plain, 'linear'))).toEqual(jira);
  });
});

/*
 * `PM_FALLBACK` maps ADF's `expand` (any line starting `+++`) to a blockquote. One-way and untold;
 * its consequences are pinned here and described in `core/src/prosemirror.ts`.
 */
describe('the expand -> blockquote degrade, and what it costs', () => {
  const EXPAND = '+++ Notes\nsome text inside\n+++\n';

  test('Jira receives an expand while the editor is handed a blockquote', () => {
    const r = render(EXPAND, 'jira');
    expect(JSON.stringify(r.converted)).toContain('"type":"expand"');
    expect(JSON.stringify(r.converted)).toContain('"title":"Notes"');

    const doc = editorDocFor(r);
    expect(JSON.stringify(doc)).toContain('"type":"blockquote"');
    expect(JSON.stringify(doc)).not.toContain('expand');
    // The title, an ADF attribute, becomes body text in the editor.
    expect(JSON.stringify(doc)).toContain('"text":"Notes"');
  });

  test('`canonical` keeps the expand, but it is not what an approval sends', () => {
    // `canonical` is the agent's body as written; an approval sends the shown body (next test).
    expect(render(EXPAND, 'jira').canonical).toBe(EXPAND);
  });

  test('the body the reviewer is shown, which an approval sends, is a blockquote, silently', () => {
    // No edit, and no warning names the change.
    const doc = editorDocFor(render(EXPAND, 'jira'));
    expect(fromEditorDoc(doc)).toBe('> Notes\n> \n> some text inside');
  });

  test('and an approvable expand loads as a BLOCKED blockquote', () => {
    // An expand may hold a heading or a table; a blockquote may not (PROBED: Jira 400). So the
    // shown body, before any edit, reports an error naming a blockquote nobody wrote.
    for (const body of [
      '+++ Notes\n# A heading\n\nbody\n+++\n',
      '+++ Notes\n| a | b |\n| - | - |\n| 1 | 2 |\n+++\n',
    ]) {
      const first = render(body, 'jira');
      expect(first.blocked).toBe(false);

      const doc = editorDocFor(first);
      const after = render(fromEditorDoc(doc), 'jira', doc);
      expect(after.blocked).toBe(true);
      expect(after.warnings.map((w) => w.code)).toContain('jira/blockquote-child-rejected');
    }
  });
});

/**
 * Syntax the destination owns and markdown does not (`<@U…>`, `:party_parrot:`, `[~accountid:x]`)
 * must reach it as the same bytes: the converter parses it and the writer re-spells it.
 *
 * The `<url|label>` trap: an autolink class like `[^>]+` (the real one is `[^\s<>|]+`,
 * `markdownToAdf.ts`) swallows the label into the href, and the writer sends
 *
 *   in    see <https://e.test/x|the docs>
 *   sent  see [https://e.test/x|the docs](https://e.test/x|the docs)
 *
 * with a link mark drawn in the editor, so nothing on screen shows the change. On Slack these rows
 * are links (`angleLinkLabels`) written back in Slack's form; `slack.test.ts` covers that half.
 * Jira has no custom emoji, so its shortcodes are literal characters.
 */
describe('destination syntax markdown does not own survives byte-identically', () => {
  const NATIVE: [string, string][] = [
    ['a slack user mention', 'Hey <@U0123ABCDEF> can you look?\n'],
    ['a slack channel-wide ping', 'Ping <!here> please\n'],
    ['a slack channel link', 'See <#C0123ABCDEF|general> for it\n'],
    ['a slack user group', 'cc <!subteam^S0123ABC|@support>\n'],
    ['a slack link with a labelled url', 'see <https://e.test/x|the docs>\n'],
    ['a slack link whose label has no space', 'see <https://e.test/x|docs>\n'],
    ['a slack link alone on the line', '<https://e.test/a/b|Report>\n'],
    ['a custom emoji shortcode', 'nice :party_parrot: work :acme:\n'],
    ['shortcodes with punctuation', ':+1: :-1: :e-mail: :100:\n'],
    ['a shortcode with no surrounding spaces', 'a:tada:b :party_parrot::acme:\n'],
    ["jira's own mention syntax", 'Hey [~accountid:557058:abc-def] look\n'],
  ];

  test.each(NATIVE)('%s is carried through untouched, on every destination', (_l, body) => {
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      expect(baselineFor(render(body, dest)).body, dest).toBe(body);
    }
  });

  test.each(NATIVE)('%s draws no warning either', (_l, body) => {
    // A warning here would assert a destination behaviour that does not happen.
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      expect(render(body, dest).warnings, dest).toEqual([]);
    }
  });

  test('and these positions too, where a parser is likeliest to bite', () => {
    const POSITIONS = [
      '- cc <@U1AAA> :tada:\n- and <!here>\n',
      '- [ ] cc <@U1AAA> :party_parrot:\n',
      '| a | b |\n| --- | --- |\n| <@U1AAA> | :tada: |\n',
      '> cc <@U1AAA> <https://e.test/x|docs>\n',
      '## cc <@U1AAA> :tada:\n',
      'type `<@U1AAA>` and `:tada:`\n',
      '```\n<@U1AAA> <https://e.test/x|docs>\n```\n',
      '**<@U1AAA>** ping\n',
    ];
    for (const body of POSITIONS) {
      for (const dest of ['jira', 'slack', 'linear'] as const) {
        expect(baselineFor(render(body, dest)).body, `${dest} ${JSON.stringify(body)}`).toBe(body);
      }
    }
  });

  test('a plain angle-bracket autolink IS a link -- the class is narrow, not closed', () => {
    // The mirror of the rows above. `[url](url)` on the way out proves the link mark: an
    // unrecognised span would come back as its `<...>` characters.
    expect(fromEditorDoc(toEditorDoc('see <https://e.test/x> now'))).toBe(
      'see [https://e.test/x](https://e.test/x) now'
    );
  });
});

/**
 * The wiring of `bareUrl.ts` (rule in `bareUrl.test.ts`): asserted on the body an approval sends
 * and, for Jira, on its ADF. `https://x.com/a.` must not become a link ending in `.`.
 */
describe('a bare URL ends where GitHub ends it, in the body that is sent', () => {
  const CASES: [body: string, sent: string][] = [
    ['The form is https://x.com/a. Not checked.', 'The form is [https://x.com/a](https://x.com/a). Not checked.'],
    // A surplus `)` is the sentence's, not the URL's.
    ['(see https://x.com/a) next', '(see [https://x.com/a](https://x.com/a)) next'],
  ];

  for (const dest of Object.keys(profiles) as DestinationName[]) {
    for (const [body, sent] of CASES) {
      test(`${dest}: ${JSON.stringify(body)}`, () => {
        const shown = baselineFor(render(body, dest)).body;
        expect(shown).toBe(sent);
        if (dest !== 'jira') return;
        // Every link in Jira's ADF is the trimmed URL, and the text is what the author wrote.
        const hrefs = new Set<unknown>();
        let text = '';
        walk(render(shown, 'jira').converted as AdfDocument, (n) => {
          text += n.text ?? '';
          for (const m of n.marks ?? []) if (m.type === 'link') hrefs.add(m.attrs?.href);
        });
        expect(hrefs).toEqual(new Set(['https://x.com/a']));
        expect(text).toBe(body);
      });
    }
  }
});

/**
 * Never rewritten to `@Jane`: Linear and GitHub resolve a bare `@name`, which can notify someone
 * else. Asserted on the body sent and, for Jira, on its ADF.
 */
describe('a link to a Linear profile stays a link, in the body that is sent', () => {
  const href = 'https://linear.app/acme/profiles/jane';

  for (const dest of Object.keys(profiles) as DestinationName[]) {
    test(`${dest}: a labelled link keeps its label and its href`, () => {
      const body = `Hi [Jane](${href}), see this.\n`;
      const rendered = render(body, dest);
      expect(baselineFor(rendered).body).toBe(body);
      expect(rendered.warnings).toEqual([]);
      if (dest !== 'jira') return;
      expect((rendered.converted as AdfDocument).content[0]).toEqual({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hi ' },
          { type: 'text', text: 'Jane', marks: [{ type: 'link', attrs: { href } }] },
          { type: 'text', text: ', see this.' },
        ],
      });
    });

    test(`${dest}: a bare profile URL is linked like any other bare URL`, () => {
      expect(baselineFor(render(`Hey ${href} check this\n`, dest)).body).toBe(`Hey [${href}](${href}) check this\n`);
    });
  }
});

/**
 * Stopping at the first `)` would send `...wiki/Foo_(bar)` as `...Foo_(bar`. The readers take one
 * level of balanced parentheses and CommonMark escapes (`linkDestination.ts`); the writer escapes
 * what it cannot write raw. GitHub renders every `sent` below as a link to `href` (PROBED,
 * `POST /markdown`).
 */
describe('a URL with parentheses reaches every destination whole', () => {
  const WIKI = 'https://en.wikipedia.org/wiki/Foo_(bar)';
  const CASES: [body: string, sent: string, href: string][] = [
    [`[label](${WIKI}) next`, `[label](${WIKI}) next`, WIKI],
    [`Wiki ${WIKI} next`, `Wiki [${WIKI}](${WIKI}) next`, WIKI],
    [`Wiki ${WIKI}.`, `Wiki [${WIKI}](${WIKI}).`, WIKI],
    // GitHub links a URL after `(` too, and so does the converter.
    [`(${WIKI}) next`, `([${WIKI}](${WIKI})) next`, WIKI],
    // What cannot be written raw is backslash-escaped, so the href stays byte-exact.
    ['Open https://x.com/a(b next', 'Open [https://x.com/a(b](https://x.com/a\\(b) next', 'https://x.com/a(b'],
    ['See https://x.com/a)next', 'See [https://x.com/a)next](https://x.com/a\\)next)', 'https://x.com/a)next'],
    // A label ending in `\` would escape its own `]`.
    ['x https://x.com/a\\. next', 'x [https://x.com/a\\\\](https://x.com/a\\\\). next', 'https://x.com/a\\'],
    // An escape the agent wrote is read as CommonMark reads it, not put into the href raw.
    ['[wiki](https://en.wikipedia.org/wiki/Foo_\\(bar\\)) next', `[wiki](${WIKI}) next`, WIKI],
    ['[doc](https://x.com/foo\\_bar)', '[doc](https://x.com/foo_bar)', 'https://x.com/foo_bar'],
    // A space needs the `<...>` form, which the writer keeps.
    ['[x](<https://x.com/a b>) y', '[x](<https://x.com/a b>) y', 'https://x.com/a b'],
  ];
  for (const [body, sent, href] of CASES) {
    test(JSON.stringify(body), () => {
      for (const dest of Object.keys(profiles) as DestinationName[]) {
        const shown = baselineFor(render(body, dest)).body;
        expect(shown, dest).toBe(sent);
        // Stable on a second pass.
        expect(baselineFor(render(shown, dest)).body, `${dest}, again`).toBe(sent);
      }
      const hrefs = new Set<unknown>();
      walk(render(sent, 'jira').converted as AdfDocument, (n) => {
        for (const m of n.marks ?? []) if (m.type === 'link') hrefs.add(m.attrs?.href);
      });
      expect(hrefs).toEqual(new Set([href]));
    });
  }

  test('a check that reads the source reads a URL the way the converter does', () => {
    // Jira's degraded-image check must not compare the escaped source URL with the converter's
    // unescaped one: it would tell the reviewer an image that embeds fine cannot be embedded.
    const codes = (b: string) => render(b, 'jira').warnings.map((w) => w.code);
    expect(codes('![x](https://w.test/foo\\_bar.png) ok')).not.toContain('jira/image-degraded-to-text');
    // The converter resolves `javascript\:` to a `javascript:` link, so the unsafe-link check must.
    expect(codes('[x](javascript\\:alert\\(1\\)) y')).toContain('link/unsafe-href');
  });

  test('the writer is linear on a run of backslashes in a label', () => {
    // Counting trailing backslashes with `/\\+$/` is quadratic on a run that is not at the end (22 s
    // at 200k), so `writeLabel` does not. Only the writer path reaches it, so it is timed through
    // `baselineFor`.
    const started = performance.now();
    baselineFor(render('[' + '\\\\'.repeat(50 * 1024) + 'x](https://a.test)', 'github'));
    render('See https://a.test/' + '\\'.repeat(100 * 1024) + 'x\nNext line.', 'slack');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('an image whose URL holds parentheses keeps all of it', () => {
    const url = 'https://w.test/a_(b).png';
    expect(JSON.stringify(render(`![x](${url}) ok`, 'jira').converted)).toContain(`"url":"${url}"`);
    expect(baselineFor(render(`![x](${url}) ok`, 'github')).body).toBe(`![x](${url}) ok`);
  });
});

describe('the markdown writer is linear on whitespace', () => {
  test('the writer is linear on a run of whitespace inside a mark', () => {
    // Splitting off trailing whitespace with `/(\s+)$/` is quadratic on a run that is not at the
    // end (1.2 s at 50k), so `wrapMarks` does not. Only the writer path reaches it
    // (`render(body, 'jira')` alone never does), so it is timed through `baselineFor`.
    const body = '**a' + ' '.repeat(200 * 1024) + 'b**';
    const started = performance.now();
    const shown = baselineFor(render(body, 'github')).body;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(shown).toBe(body);
  });
});

describe('a code block keeps its blank lines', () => {
  // A `\n{3,}` block-spacing tidy run over the whole document, blind to where a fence is, would
  // bring a run of blank lines inside one back as a single blank line, unwarned.
  const code = '\n\na\n\n\n\nb\n\n\n';
  const body = 'Before.\n\n```js\n' + code + '\n```\n\nAfter.\n';
  const destinations = Object.keys(profiles) as DestinationName[];

  test.each(destinations)('%s sends the code exactly as written', (destination) => {
    expect(baselineFor(render(body, destination)).body).toBe(body);
  });

  test('jira receives the code exactly as written', () => {
    const adf = render(body, 'jira').converted as AdfDocument;
    expect(adf.content[1]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [{ type: 'text', text: code }],
    });
  });

  test('a code block in a list item keeps its blank lines', () => {
    // Straight to the writer, as the item's first block (on the marker line) and after a paragraph.
    const item = (content: AdfNode[]): AdfNode => ({ type: 'listItem', content });
    const codeBlock: AdfNode = { type: 'codeBlock', content: [{ type: 'text', text: 'a\n\n\nb' }] };
    const para: AdfNode = { type: 'paragraph', content: [{ type: 'text', text: 'x' }] };
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'bulletList', content: [item([codeBlock])] },
        { type: 'orderedList', content: [item([para, codeBlock])] },
      ],
    };
    expect(convertAdfToMarkdown(doc)).toBe(
      '- ```\n  a\n\n\n  b\n  ```\n\n1. x\n   ```\n   a\n\n\n   b\n   ```'
    );
  });
});

describe('a fenced code block indented under a list item stays in the item', () => {
  // A reader that ends the list at the fence sends the code as literal paragraphs of backticks
  // between two halves of the list, where GitHub, Slack and Linear render one list holding a block.
  const steps = '1. Run:\n   ```sh\n   npm i\n\n\n   npm test\n   ```\n2. Then start it\n';
  const destinations = Object.keys(profiles) as DestinationName[];

  // Slack is the exception: it flattens a code block into the item's text, so the
  // block moves out to just after its item (`core/test/listItemBlocks.test.ts` pins that).
  const keeping = destinations.filter((d) => profiles[d].listItemBlocks !== 'lists');

  test.each(keeping)('%s sends the list with its code block', (destination) => {
    expect(baselineFor(render(steps, destination)).body).toBe(steps);
    // A blank line before the fence is allowed; the writer then spells the item tight.
    expect(baselineFor(render('- x\n\n  ```\n  a\n\n  b\n  ```\n', destination)).body).toBe(
      '- x\n  ```\n  a\n\n  b\n  ```\n'
    );
  });

  test('jira receives the code block inside the item, and one list', () => {
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    expect((render(steps, 'jira').converted as AdfDocument).content).toEqual([
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [
              para('Run:'),
              { type: 'codeBlock', attrs: { language: 'sh' }, content: [{ type: 'text', text: 'npm i\n\n\nnpm test' }] },
            ],
          },
          { type: 'listItem', content: [para('Then start it')] },
        ],
      },
    ]);
  });

  test('slack sends the code block just after its item, and the list resumes', () => {
    expect(baselineFor(render(steps, 'slack')).body).toBe('1. Run:\n\n```sh\nnpm i\n\n\nnpm test\n```\n\n2. Then start it\n');
  });

  test.each(keeping)('%s reads the fence spellings the writer and agents use', (destination) => {
    const sent = (body: string) => baselineFor(render(body, destination)).body;
    // On the marker line, as the writer spells an item that is only code: the item is kept whole.
    expect(sent('- ```\n  a\n\n  b\n  ```\n')).toBe('- \n  ```\n  a\n\n  b\n  ```\n');
    // Four spaces under `- `, which CommonMark allows and agents write.
    expect(sent('- Run:\n    ```sh\n    npm i\n    ```\n- Next\n')).toBe('- Run:\n  ```sh\n  npm i\n  ```\n- Next\n');
    // A line with text after the backticks does not close a fence, so its text is not dropped.
    // Its lines are text here, and they are sent escaped: to GitHub the bare ```
    // would open a fence that runs to the end of the item.
    expect(sent('- x\n  ```\n  a\n  ```trailing\n')).toContain('\\`\\`\\`trailing');
  });

  test('indented text after the fence joins the item too', () => {
    // The container rule: the item owns every line indented under it, so `  tail` is a paragraph
    // inside the item, not one after the list.
    const content = (render('- x\n  ```\n  a\n  ```\n  tail\n', 'jira').converted as AdfDocument).content;
    expect(content).toHaveLength(1);
    expect(content[0].content![0].content!.map((n) => n.type)).toEqual(['paragraph', 'codeBlock', 'paragraph']);
  });
});

describe('code holding a ``` line keeps its fence', () => {
  // A writer that always fences with three backticks lets markdown about markdown -- a ```` fence
  // around a ``` one -- be closed by its own content and sent as two empty code blocks around text.
  const code = '```js\nx()\n```\n\n\nmore';
  const bodies = ['Use this:\n\n````md\n' + code + '\n````\n', '- x\n  ````md\n  ```js\n  x()\n  ```\n\n\n  more\n  ````\n'];
  const destinations = Object.keys(profiles) as DestinationName[];

  test.each(destinations)('%s sends the code exactly as written', (destination) => {
    // Slack moves the listed one out of its item, and keeps the fence it needs.
    const moved = '- x\n\n````md\n' + code + '\n````\n';
    for (const body of bodies) {
      const expected = profiles[destination].listItemBlocks === 'lists' && body.startsWith('- ') ? moved : body;
      expect(baselineFor(render(body, destination)).body).toBe(expected);
    }
    // A run that cannot close the fence -- mid-line, or indented four spaces -- needs no longer one.
    for (const body of ['```\necho ```\n```\n', '```\n    ```\n```\n', '`````\n````\n`````\n']) {
      expect(baselineFor(render(body, destination)).body).toBe(body);
    }
  });

  test('a ``` line the reviewer types into a code block gets a longer fence', () => {
    const doc: AdfDocument = { version: 1, type: 'doc', content: [
      { type: 'codeBlock', content: [{ type: 'text', text: '```\n   ```\nx' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'codeBlock', content: [{ type: 'text', text: '  ```' }] }] }] },
    ] };
    const written = convertAdfToMarkdown(doc);
    expect(written).toBe('````\n```\n   ```\nx\n````\n\n- ````\n    ```\n  ````');
    for (const destination of destinations) {
      // Slack's one note is that the listed code block moves out of its item.
      const expected: string[] = profiles[destination].listItemBlocks === 'lists' ? ['slack/list-item-block-moved-out'] : [];
      expect(render(written, destination).warnings.map((w) => w.code as string)).toEqual(expected);
    }
  });

  test('an image inside a ```` block is code to the scanners too', () => {
    const body = '````md\n```md\n![a](https://e.test/a.png)\n```\n````\n';
    expect(baselineFor(render(body, 'slack')).body).toBe(body);
    // GitHub's image scan is deliberately not code-aware (an accepted `info`, see its `scan`).
    // Unclosed too: the ```` runs to the end, as the converter reads it, and does not close early.
    for (const b of [body, '````\n```\n![a](https://e.test/a.png)\n']) {
      for (const destination of ['slack', 'jira'] as const) expect(render(b, destination).warnings).toEqual([]);
    }
  });

  test('jira receives one code block holding the inner fence', () => {
    const adf = render(bodies[0], 'jira').converted as AdfDocument;
    expect(adf.content[1]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'md' },
      content: [{ type: 'text', text: code }],
    });
  });
});

describe('a ~~~ fence is a code block', () => {
  // A tilde fence is CommonMark, and code on GitHub; a reader that knew only backtick fences would
  // send it as paragraphs with its blank lines collapsed. The writer spells it back with backticks.
  const destinations = Object.keys(profiles) as DestinationName[];

  test.each(destinations)('%s sends the code, respelled with backticks', (destination) => {
    const sent = (body: string) => baselineFor(render(body, destination)).body;
    expect(sent('~~~python\na\n\n\n\nb\n~~~\n')).toBe('```python\na\n\n\n\nb\n```\n');
    // Under a list item too, where a ``` line inside needs the longer fence -- and for Slack the
    // block moves out of the item, keeping it.
    expect(sent('1. Run:\n   ~~~\n   ```\n   x\n   ~~~\n2. Then\n')).toBe(
      profiles[destination].listItemBlocks === 'lists'
        ? '1. Run:\n\n````\n```\nx\n````\n\n2. Then\n'
        : '1. Run:\n   ````\n   ```\n   x\n   ````\n2. Then\n'
    );
    // A fence interrupts a paragraph, as a backtick one does.
    expect(sent('See:\n~~~\nx\n~~~\n')).toBe('See:\n\n```\nx\n```\n');
    // Strike is not a fence, and a tilde line that is not one does not break its paragraph.
    expect(sent('~~strike~~ and ~~~ mid\n')).toBe('~~strike~~ and ~~~ mid\n');
    // Sent escaped: a tilde fence's info string may hold tildes, so to GFM that line
    // opens a fence and `line three` is code, where the preview shows one paragraph.
    expect(sent('Line one\n~~~b~~~ c\nline three\n')).toBe('Line one\n\\~\\~\\~b~~~ c\nline three\n');
    // A language after a space, for either fence: read as prose, its closer would swallow the rest.
    for (const fence of ['~~~', '```']) {
      expect(sent(`${fence} python\ncode\n${fence}\n\nMore **bold**\n`)).toBe('```python\ncode\n```\n\nMore **bold**\n');
    }
  });

  test('an image inside a ~~~~ block holding a ~~~ line is code to the scanners', () => {
    const body = '~~~~\n~~~\n![a](https://e.test/a.png)\n~~~~\n';
    expect(baselineFor(render(body, 'slack')).body).toBe('```\n~~~\n![a](https://e.test/a.png)\n```\n');
    for (const destination of ['slack', 'jira'] as const) expect(render(body, destination).warnings).toEqual([]);
  });

  test('tildes that are not a fence line are prose to the scanners, as to the converter', () => {
    for (const body of ['Look ~~~ ![a](https://e.test/a.png) ~~~ here\n', '~~~b~~~ c\n\n![a](https://e.test/a.png)\n']) {
      expect(render(body, 'slack').warnings.map((w) => w.code)).toContain('slack/image-becomes-link');
    }
  });

  test('jira receives a code block', () => {
    expect((render('~~~python\na\n\n\n\nb\n~~~\n', 'jira').converted as AdfDocument).content).toEqual([
      { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'a\n\n\n\nb' }] },
    ]);
  });
});

/**
 * The converter does not invent a strike or a second link.
 *
 * The `~~` rule has a flanking check: without it `a ~~ b ~~ c` would be sent as `a  ~~b~~  c` and
 * struck, where GitHub leaves it as text. And no autolink fires inside a link's label, where it
 * would give Jira two link marks with two hrefs on one node. Whether each row strikes is GitHub's
 * answer (`POST /markdown`).
 */
describe('the converter does not invent a strike or a second link', () => {
  const STRIKES: [body: string, sent: string, strikes: boolean][] = [
    ['a ~~b~~ c', 'a ~~b~~ c', true],
    ['a~~b~~c', 'a~~b~~c', true],
    ['see ~~(old)~~ new', 'see ~~(old)~~ new', true],
    ['a ~~ b ~~ c', 'a ~~ b ~~ c', false],
    ['a ~~b ~~ c', 'a ~~b ~~ c', false],
    ['a ~~ b~~ c', 'a ~~ b~~ c', false],
    ['x https://x.com/a~~ and ~~b', 'x [https://x.com/a](https://x.com/a)~~ and ~~b', false],
    // A run of three is not a pair (GitHub strikes neither).
    ['a ~~~b~~~ c', 'a ~~~b~~~ c', false],
    ['a ~~b~~~ c', 'a ~~b~~~ c', false],
    // An escaped closer closes nothing; the writer re-escapes, and GitHub renders both as text.
    ['~~a\\~~ b~~', '\\~\\~a\\~\\~ b\\~\\~', false],
  ];
  for (const [body, sent, strikes] of STRIKES) {
    test(`${JSON.stringify(body)} ${strikes ? 'strikes' : 'stays text'}`, () => {
      for (const dest of Object.keys(profiles) as DestinationName[]) {
        const { doc, body: shown } = baselineFor(render(body, dest));
        expect(shown, dest).toBe(sent);
        // The preview too: bytes can survive the round trip while the editor draws a strike.
        expect(marks(doc).has('strike'), `${dest} preview`).toBe(strikes);
      }
      expect(marks(render(body, 'jira').converted).has('strike')).toBe(strikes);
    });
  }

  test('no autolink inside a link label: one link mark per node, with the label href', () => {
    for (const [body, href] of [
      ['[docs at https://x.com](https://y.com)', 'https://y.com'],
      ['[https://x.com](https://x.com)', 'https://x.com'],
      ['[see <https://x.com>](https://y.com)', 'https://y.com'],
    ] as const) {
      const hrefs = new Set<unknown>();
      walk(render(body, 'jira').converted as AdfDocument, (n) => {
        const links = (n.marks ?? []).filter((m) => m.type === 'link');
        expect(links.length, body).toBeLessThanOrEqual(1);
        for (const m of links) hrefs.add(m.attrs?.href);
      });
      expect(hrefs, body).toEqual(new Set([href]));
    }
  });
});

/**
 * A mark the reviewer applies that markdown cannot carry back.
 *
 * Mid-word against punctuation: a strike on `(b)` in `a(b)c` is written `a~~(b)~~c`, and an opener
 * with a letter before it and punctuation after does not flank, so it comes back as text. `lostMarks`
 * counts, per mark type, the non-whitespace characters it covers before and after the round trip.
 *
 * Measured: nothing across `shippedBodies()` under any option set, and on a
 * seeded offline fuzz of reviewer-built paragraphs (random runs, random marks) every report is a
 * real loss wherever the text survived well enough to compare character by character. Not in the
 * suite, as with the idempotence sweep above.
 */
describe('a mark markdown cannot carry is reported', () => {
  type Run = [string, ...string[]];
  const para = (...runs: Run[]) => ({
    type: 'paragraph',
    content: runs.map(([text, ...ms]) => ({
      type: 'text',
      text,
      ...(ms.length ? { marks: ms.map((type) => (type === 'link' ? { type, attrs: { href: 'https://e.test/' } } : { type })) } : {}),
    })),
  });
  const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks }) as unknown as PmNode;
  const lost = (d: PmNode) => lostMarks(d, toEditorDoc(fromEditorDoc(d)));

  test('a strike or an italic on `(b)` inside `a(b)c` is lost, named, and located', () => {
    const struck = doc(para(['a'], ['(b)', 'strike'], ['c']));
    expect(fromEditorDoc(struck)).toBe('a~~(b)~~c');
    expect(lost(struck)).toEqual({ types: ['strike'], editorPath: [0] });
    expect(lost(doc(para(['x'])))).toBeUndefined();
    expect(lost(doc(para(['x']), para(['a'], ['(b)', 'italic'], ['c'])))).toEqual({ types: ['italic'], editorPath: [1] });
  });

  test('the same marks on whole words survive, and report nothing', () => {
    expect(lost(doc(para(['a '], ['(b)', 'strike'], [' c'])))).toBeUndefined();
    expect(lost(doc(para(['a '], ['b', 'bold', 'italic'], [' '], ['c', 'code'])))).toBeUndefined();
  });

  test('whitespace the writer moves out of a mark is not a loss', () => {
    // A bold `a ` goes out as `**a** `, because `** a**` is not emphasis. A bold space is invisible.
    expect(fromEditorDoc(doc(para(['a ', 'bold'], ['b'])))).toBe('**a** b');
    expect(lost(doc(para(['a ', 'bold'], ['b'])))).toBeUndefined();
  });

  test('a mark that GROWS is not a loss: a typed bare URL comes back as a link', () => {
    // `before` already holds a link, so this separates "dropped" from "changed".
    expect(lost(doc(para(['see '], ['docs', 'link'], [' and https://example.com now'])))).toBeUndefined();
  });

  test('a loss in one block is not cancelled by a gain in another', () => {
    // The first block loses its bold (`e**.**g` does not flank). The second leaks a `*` into its
    // bold (`**the *end***`, which the converter reads as bold `the *end`), so over the whole
    // document bold covers seven characters before and seven after, and the loss would net away.
    // That spelling is read here rather than written: the writer spells this block
    // `__the *end*__` (next test), which loses nothing.
    const d = doc(para(['e'], ['.', 'bold'], ['g']), para(['see '], ['the ', 'bold'], ['end', 'bold', 'italic'], [' now']));
    expect(lostMarks(d, toEditorDoc('e**.**g\n\nsee **the *end*** now\n'))).toEqual({ types: ['bold', 'italic'], editorPath: [0] });
  });

  test('a bold that ends on an italic is written with underscores, and comes back whole', () => {
    // `**the *end***` is a run of three against a run of two, which this converter cannot split.
    // Underscores keep the runs from touching.
    const d = doc(para(['see '], ['the ', 'bold'], ['end', 'bold', 'italic'], [' now']));
    expect(fromEditorDoc(d)).toBe('see __the *end*__ now');
    expect(lost(d)).toBeUndefined();
  });

  test('every document this repo ships reports NOTHING, under every destination\'s options', () => {
    for (const [label, body] of shippedBodies()) {
      for (const [dest, profile] of Object.entries(profiles)) {
        const options = editorOptionsFor(profile);
        const d = toEditorDoc(body, options);
        expect(lostMarks(d, toEditorDoc(fromEditorDoc(d, options), options)), `${label} ${dest}`).toBeUndefined();
      }
    }
  });
});

/**
 * The round trip ends the way its input does (`matchTrailingNewline`), so an unedited draft writes
 * no `after` to the review log. Matched, not imposed: the second test is the mirror.
 */
describe('the round trip ends the way its input ends', () => {
  const ORDINARY: [string, string][] = [
    ['plain prose', 'Hey, I looked into this and it is fine.\n'],
    ['a list', '- one\n- two\n- three\n'],
    ['a heading and prose', '## Summary\n\nAll good.\n'],
    ['a checklist', '- [ ] one\n- [x] two\n'],
    ['a quote', '> quoted\n'],
    ['a fenced block', '```js\nconst a = 1;\n```\n'],
  ];

  test.each(ORDINARY)('%s is byte-identical through the editor, on every destination', (_l, body) => {
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      // Identical means `cli/src/review.ts` writes no `after`.
      expect(baselineFor(render(body, dest)).body, dest).toBe(body);
    }
  });

  test.each(ORDINARY)('%s WITHOUT a trailing newline is byte-identical too', (_l, body) => {
    // Always appending would give each of these an `after`.
      const bare = body.replace(/\n+$/, '');
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      expect(baselineFor(render(bare, dest)).body, dest).toBe(bare);
    }
  });

  test('an emptied draft stays empty rather than gaining a line', () => {
    // `''` has no last line to end, and `render` blocks it either way.
    expect(baselineFor(render('', 'jira')).body).toBe('');
    expect(render('', 'jira').blocked).toBe(true);
    expect(render('\n', 'jira').blocked).toBe(true);
  });

  test('and a draft the round trip really does change still reports it', () => {
    // The negative control: matching the newline does not hide a real difference.
    const media = '- [ ] ![i](https://e.test/a.png)\n- [ ] a normal item\n';
    expect(baselineFor(render(media, 'jira')).body).not.toBe(media);
    // And it still ends the way the input did, so the only delta is the structural one.
    expect(baselineFor(render(media, 'jira')).body.endsWith('\n')).toBe(true);
  });
});

describe('matchTrailingNewline', () => {
  test('appends only when the model has one', () => {
    expect(matchTrailingNewline('a', 'b\n')).toBe('a\n');
    expect(matchTrailingNewline('a', 'b')).toBe('a');
    expect(matchTrailingNewline('a\n', 'b\n')).toBe('a\n');
  });

  test('and STRIPS when the model has none, so the match is exact both ways', () => {
    expect(matchTrailingNewline('a\n', 'b')).toBe('a');
    expect(matchTrailingNewline('a\n\n\n', 'b')).toBe('a');
  });

  test('never collapses several into one when the model has one', () => {
    // A body whose own last line is blank keeps it: the rule is about the END, not about how many.
    expect(matchTrailingNewline('a\n\n', 'b\n')).toBe('a\n\n');
  });

  test('an empty string is left alone in either direction', () => {
    expect(matchTrailingNewline('', 'b\n')).toBe('');
    expect(matchTrailingNewline('', 'b')).toBe('');
  });

  test('is linear on a newline run that is not at the end', () => {
    // `/\n+$/` takes 1.1 s on this shape at 50k, 4x per doubling.
    const body = 'a' + '\n'.repeat(200 * 1024) + 'b\n';
    const started = performance.now();
    const stripped = matchTrailingNewline(body, 'b');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(stripped).toBe(body.slice(0, -1));
  });
});
