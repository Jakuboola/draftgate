import { describe, expect, it } from 'bun:test';
import { convertMarkdownToAdf } from '../markdownToAdf';
import { AdfDocument, AdfNode } from '../types';

function getInline(doc: AdfDocument, blockIdx = 0): AdfNode[] {
  return doc.content[blockIdx]?.content || [];
}

/** A node as one line: `type{attrs}(children)`, text as `"text"[marks]`. Only the attrs a reader sees. */
function shape(n: AdfNode): string {
  if (n.type === 'text') {
    const marks = (n.marks ?? []).map((m) => (m.type === 'link' ? `link:${String(m.attrs?.href)}` : m.type)).sort();
    return JSON.stringify(n.text) + (marks.length ? `[${marks.join(',')}]` : '');
  }
  const attrs = ['level', 'language', 'state', 'title'].filter((k) => n.attrs?.[k] !== undefined).map((k) => `${k}=${String(n.attrs![k])}`);
  return n.type + (attrs.length ? `{${attrs.join(',')}}` : '') + (n.content ? `(${n.content.map(shape).join(' ')})` : '');
}

describe('convertMarkdownToAdf', () => {
  it('converts each basic block and mark', () => {
    // [markdown, the document's blocks as `shape` writes them]
    const ROWS: [string, string][] = [
      ['Hello world', 'paragraph("Hello world")'],
      ['First\n\nSecond', 'paragraph("First") paragraph("Second")'],
      ['line1\nline2', 'paragraph("line1" hardBreak "line2")'],
      ['', 'paragraph()'],
      ['# Title\n\n## Subtitle', 'heading{level=1}("Title") heading{level=2}("Subtitle")'],
      ['```typescript\nconst x = 1;\n```', 'codeBlock{language=typescript}("const x = 1;")'],
      ['```\nplain code\n```', 'codeBlock("plain code")'],
      ['```\n```', 'codeBlock()'],
      ['> quoted text', 'blockquote(paragraph("quoted text"))'],
      ['> line1\n>\n> line2', 'blockquote(paragraph("line1") paragraph("line2"))'],
      ['---', 'rule'],
      ['- one\n- two', 'bulletList(listItem(paragraph("one")) listItem(paragraph("two")))'],
      ['1. first\n2. second', 'orderedList(listItem(paragraph("first")) listItem(paragraph("second")))'],
      ['- [x] done\n- [ ] todo', 'taskList(taskItem{state=DONE}("done") taskItem{state=TODO}("todo"))'],
      [
        '| Name | Value |\n| --- | --- |\n| a | 1 |',
        'table(tableRow(tableHeader(paragraph("Name")) tableHeader(paragraph("Value"))) ' +
          'tableRow(tableCell(paragraph("a")) tableCell(paragraph("1"))))',
      ],
      ['**bold**', 'paragraph("bold"[strong])'],
      ['*italic*', 'paragraph("italic"[em])'],
      ['***both***', 'paragraph("both"[em,strong])'],
      ['~~deleted~~', 'paragraph("deleted"[strike])'],
      ['use `code` here', 'paragraph("use " "code"[code] " here")'],
      ['[click](https://example.com)', 'paragraph("click"[link:https://example.com])'],
      ['not \\*bold\\*', 'paragraph("not *bold*")'],
      ['+++Details\nexpanded content\n+++', 'expand{title=Details}(paragraph("expanded content"))'],
      ['+++\nsome body\n+++', 'expand{title=}(paragraph("some body"))'],
    ];
    for (const [md, expected] of ROWS) {
      const doc = convertMarkdownToAdf(md);
      expect([doc.version, doc.type], md).toEqual([1, 'doc']);
      expect(doc.content.map(shape).join(' '), md).toBe(expected);
    }
  });

  it('italicises a single character, and more than one word', () => {
    expect(getInline(convertMarkdownToAdf('*a*'))[0].text).toBe('a');
    expect(getInline(convertMarkdownToAdf('*a*'))[0].marks).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'em' })])
    );
    expect(getInline(convertMarkdownToAdf('*two words*'))[0].text).toBe('two words');
  });

  // CommonMark flanking, on the delimiter run: a run followed by whitespace does not open, one
  // preceded by whitespace does not close. Without the guards every case below loses its delimiters
  // and italicises or bolds the middle.
  const NOT_EMPHASIS = [
    'SELECT * FROM events WHERE name * 2',
    'use the wildcard *.csv and *.json',
    '2 * 3 * 4',
    // Leading delimiter, so the guard is exercised at index 0 too. Not `a * b`: with no second
    // asterisk to close on, it passes with or without the guard.
    '*.csv is the pattern, *.json too',
    // Runs of two and three, which one guard per rule does not close.
    'the pattern is ** and nothing else ** here',
    'a *** b *** c',
    'SELECT a ** 2 FROM t WHERE b ** 3',
    'glob ***/*.log matched nothing',
    // A run of four has no ADF meaning, and a closer shorter than its opener is not a closer.
    // CommonMark consumes the delimiters in both; this keeps them.
    '****a****',
    '**a*',
    '***a* b**',
    'chmod +x scripts/*.sh and rm *.tmp',
    '*opened but never closed *',
    // The second half of left-flanking: a run followed by punctuation opens only when preceded by
    // whitespace or punctuation. A whitespace-only check pairs these and deletes both stars; GitHub
    // keeps every one as text.
    'report*.csv and data*.json',
    'price 5*(a) and 3*(b)',
    'x**.y and z**.w',
  ];

  it.each(NOT_EMPHASIS)('passes a non-flanking asterisk run through verbatim: %s', (source) => {
    const inline = getInline(convertMarkdownToAdf(source));
    expect(inline.map((n) => n.text).join('')).toBe(source);
    const marks = inline.flatMap((n) => (n.marks || []).map((m) => m.type));
    expect(marks).not.toContain('em');
    expect(marks).not.toContain('strong');
  });

  // The guards must not cost real formatting. Every expectation matches GitHub's renderer, compared
  // as mark sets because ADF marks are flat where HTML nests. Single, double and triple runs are rows
  // of the table at the top.
  const IS_EMPHASIS: [string, string, string[]][] = [
    ['two runs stay two emphases', '*a* and *b*', ['em']],
    ['a strong nested in an em', 'nested *em with **strong** inside*', ['em', 'strong']],
    ['an em nested in a strong', 'nested **strong with *em* inside**', ['em', 'strong']],
    // Only `runLength` of the closing run is consumed, so the stray star stays.
    ['a longer closer leaves its star', '**a***', ['strong']],
    // Both `/`-preceded stars flank, so this is emphasis, in the spec too.
    ['a glob pair legitimately flanks', 'run on **/*.csv and **/*.json', ['em']],
  ];

  it.each(IS_EMPHASIS)('still reads emphasis as emphasis: %s', (_name, source, expected) => {
    const marks = getInline(convertMarkdownToAdf(source)).flatMap((n) =>
      (n.marks || []).map((m) => m.type)
    );
    for (const mark of expected) expect(marks).toContain(mark);
  });

  it('keeps bold when a lone star sits inside it', () => {
    // `**a*b**`: a scan that lets the inner `*` open consumes the first asterisk of the run that
    // could close, leaving `**a`, an italic `b` and one deleted delimiter.
    for (const source of ['**a*b**', '**use a*b here**']) {
      const marks = getInline(convertMarkdownToAdf(source)).flatMap((n) =>
        (n.marks || []).map((m) => m.type)
      );
      expect(marks).toContain('strong');
      expect(marks).not.toContain('em');
    }
  });

  // This and the next are CommonMark rules a whitespace-only check lacks; expectations are GitHub's
  // `POST /markdown` output.
  it('applies the rule of 3, so `*a**b*` keeps its middle run', () => {
    const inline = getInline(convertMarkdownToAdf('*a**b*'));
    expect(inline.map((n) => n.text).join('')).toBe('a**b');
    expect(inline.every((n) => (n.marks || []).some((m) => m.type === 'em'))).toBe(true);
  });

  it('reads the leftover of a longer closer as the same run, not a fresh opener', () => {
    // `**` closes the `*` with one star; the other, between `b` and `.`, cannot open. Parsed as a
    // fresh run it would see `*` before it, open, and eat two more.
    const inline = getInline(convertMarkdownToAdf('*b/ab**.b* q'));
    expect(inline.map((n) => n.text).join('')).toBe('b/ab*.b* q');
    const marked = inline.filter((n) => (n.marks || []).some((m) => m.type === 'em'));
    expect(marked.map((n) => n.text).join('')).toBe('b/ab');
  });

  it('does not close emphasis on an escaped asterisk', () => {
    // The scan reads raw text, so an escaped `\*` looks like a closer; closing there leaks the
    // backslash as content.
    const inline = getInline(convertMarkdownToAdf('*emphasis with \\* star*'));
    expect(inline.map((n) => n.text).join('')).toBe('emphasis with * star');
    expect(inline.flatMap((n) => (n.marks || []).map((m) => m.type))).toContain('em');
  });

  // The fixtures' order and size are the guard. Without the closable-run index the nesting skip
  // recurses into every run that can open, so the work doubles per glob: 20 globs 68ms, 24 1.07s,
  // 26 4.27s. A 30-pattern fixture passes with the index removed. A whole-string boolean instead of
  // the index is defeated by one closable asterisk: emphasis BEFORE the globs, 115 KB, 5112ms. At
  // ~98,000 characters all three orders take 3-5s without the index and under 20ms with it.
  //
  // The same for `_`, plus an underscore inside a word and a closer inside a link or URL, which
  // `closableRuns` leaves out. Measured with that skip removed: `_a` openers ending in
  // `[x_](https://e.test/y)` take 418ms at 9 KB, 1.5s at 18 KB, 5.9s at 36 KB; with it, 9ms.
  //
  // Then spans a reader takes whole and this converter keeps as text (a tag, an autolink, an
  // email), each bounded by its own construct: a quote never closed, an `@` after every possible
  // start, and dashes inside an address, which a `/[._-]+$/` trim takes 5.8s over at 100 KB.
  const repeated = (length: number, piece: (i: number) => string) => Array.from({ length }, (_, i) => piece(i)).join(' ');
  const globLine = repeated(12_000, (i) => `*.f${i}`);

  it.each([
    ['globs alone', globLine, '*.f0'],
    ['emphasis after the globs', `${globLine} and *real* here`, '*.f0'],
    ['emphasis before the globs', `*real* then ${globLine}`, '*.f0'],
    ['underscore globs', repeated(12_000, (i) => `_.f${i}`), '_.f0'],
    ['emphasis before the underscore globs', `_real_ then ${repeated(12_000, (i) => `_.f${i}`)}`, '_.f0'],
    ['snake_case words', repeated(10_000, (i) => `a_b_c_${i}`), 'a_b_c_0'],
    ['openers, then a closer inside a link', `${repeated(33_000, () => '_a')} [x_](https://e.test/y)`, '_a'],
    ['openers, then a closer inside a URL', `${repeated(33_000, () => '_a')} https://e.test/x_.y`, '_a'],
    ['an opener, then brackets that never close', `_x ${repeated(33_000, () => '[_')}`, '[_'],
    ['tags whose quotes never close', `_x ${repeated(20_000, () => '<a b="')}`, '<a b="'],
    ['autolinks holding a pipe', `_x ${repeated(8_000, (i) => `<https://e.test/${i}_|d_>`)}`, '_|d_>'],
    ['email starts, then one @ at the end', `_x ${repeated(50_000, () => 'a').replace(/ /g, ',')}@x.com`, 'a,a'],
    ['dashes inside an address', `_x a@x.c${'-'.repeat(100_000)}b`, '---'],
    ['www literals', `_x ${repeated(9_000, (i) => `www.e.test/${i}_.h`)}`, '_.h'],
  ])('converts a very long line without the scan blowing up: %s', (_name, source, kept) => {
    expect(source.length).toBeGreaterThan(90_000);
    const started = performance.now();
    const inline = getInline(convertMarkdownToAdf(source));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(inline.map((n) => n.text).join('')).toContain(kept);
  });

  it('leaves globs alone while still reading real emphasis on the same line', () => {
    // The closable-run index must not cost a legitimate emphasis sharing the line.
    const source = '*.csv and *.json and *real* here';
    const inline = getInline(convertMarkdownToAdf(source));
    expect(inline.flatMap((n) => (n.marks || []).map((m) => m.type))).toContain('em');
    expect(inline.map((n) => n.text).join('')).toBe('*.csv and *.json and real here');
  });

  // Where this differs from CommonMark it is by keeping a delimiter the spec consumes, never the
  // reverse. Counted in the parsed nodes: a round trip re-emits consumed delimiters (`****a****`
  // returns eight asterisks either way), so a round-trip version cannot fail.
  it('never consumes an asterisk that is not a delimiter', () => {
    for (const source of NOT_EMPHASIS) {
      const text = getInline(convertMarkdownToAdf(source))
        .map((n) => n.text || '')
        .join('');
      expect((text.match(/\*/g) || []).length).toBe((source.match(/\*/g) || []).length);
    }
  });

  it('strips incompatible marks from code spans (bold+code)', () => {
    const doc = convertMarkdownToAdf('tag **`ajda-2490.1`** ready');
    const inline = getInline(doc);
    const codeNode = inline.find((n) => n.text === 'ajda-2490.1');
    // ADF code mark can only combine with link -- strong must be stripped
    expect(codeNode?.marks).toEqual([{ type: 'code' }]);
  });

  it('preserves link mark on code spans inside links', () => {
    const doc = convertMarkdownToAdf('[`code`](https://example.com)');
    const inline = getInline(doc);
    const codeNode = inline.find((n) => n.text === 'code');
    expect(codeNode?.marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'link' }),
        expect.objectContaining({ type: 'code' }),
      ])
    );
  });

  it('converts jira-attachment image to mediaSingle', () => {
    const contentUrl = 'https://mysite.atlassian.net/rest/api/3/attachment/content/att-123';
    const doc = convertMarkdownToAdf(`![screenshot](jira-attachment:${contentUrl})`);
    // Hoisted out of the paragraph to the top level.
    expect(doc.content[0].type).toBe('mediaSingle');
    const media = doc.content[0].content![0];
    expect(media.type).toBe('media');
    expect(media.attrs?.type).toBe('external');
    expect(media.attrs?.url).toBe(contentUrl);
    expect(media.attrs?.alt).toBe('screenshot');
  });

  // An https image takes the media branch: PROBED, Jira accepts external media (201) and stores it
  // verbatim (not `expand=renderedFields`, which re-parses through a legacy path). Only URLs Jira
  // cannot fetch, relative and `data:`, degrade to `[Image: alt]` (the two tests below).
  it('converts an https image URL to external media', () => {
    const doc = convertMarkdownToAdf('![alt](https://example.com/img.png)');
    const media = doc.content[0]?.content?.[0];
    expect(doc.content[0]?.type).toBe('mediaSingle');
    expect(media?.attrs?.type).toBe('external');
    expect(media?.attrs?.url).toBe('https://example.com/img.png');
    expect(media?.attrs?.alt).toBe('alt');
  });

  it('degrades a relative image URL to text, which Jira cannot fetch', () => {
    const doc = convertMarkdownToAdf('![alt](images/rel.png)');
    expect(extractAllText(doc)).toContain('Image: alt');
  });

  it('degrades a data: image URL to text', () => {
    const doc = convertMarkdownToAdf('![alt](data:image/png;base64,AA)');
    expect(extractAllText(doc)).toContain('Image: alt');
  });

  it('links a bare Linear profile URL, as it does any bare URL', () => {
    const doc = convertMarkdownToAdf('Hey https://linear.app/example/profiles/jane check this');
    expect(getInline(doc)).toEqual([
      { type: 'text', text: 'Hey ' },
      {
        type: 'text',
        text: 'https://linear.app/example/profiles/jane',
        marks: [{ type: 'link', attrs: { href: 'https://linear.app/example/profiles/jane' } }],
      },
      { type: 'text', text: ' check this' },
    ]);
  });

  it('keeps a link to a Linear profile a link, label and href unchanged', () => {
    // Not `@Jane`: an `@` name on GitHub can ping an unrelated user, and the link is what the agent wrote.
    const doc = convertMarkdownToAdf('Hi [Jane](https://linear.app/example/profiles/jane)');
    expect(getInline(doc)).toEqual([
      { type: 'text', text: 'Hi ' },
      {
        type: 'text',
        text: 'Jane',
        marks: [{ type: 'link', attrs: { href: 'https://linear.app/example/profiles/jane' } }],
      },
    ]);
  });

  it('converts nested bullet list', () => {
    const doc = convertMarkdownToAdf('- parent\n  - child');
    const outerList = doc.content[0];
    expect(outerList.type).toBe('bulletList');
    const firstItem = outerList.content?.[0];
    expect(firstItem?.type).toBe('listItem');
    // First child is the paragraph with "parent" text
    expect(firstItem?.content?.[0].type).toBe('paragraph');
    expect(firstItem?.content?.[0].content?.[0].text).toBe('parent');
    // Second child is the nested bulletList
    const nestedList = firstItem?.content?.[1];
    expect(nestedList?.type).toBe('bulletList');
    expect(nestedList?.content?.[0].type).toBe('listItem');
    expect(nestedList?.content?.[0].content?.[0].content?.[0].text).toBe('child');
  });

  it('converts ordered child list under bullet parent', () => {
    const doc = convertMarkdownToAdf('- parent\n  1. child');
    const outerList = doc.content[0];
    expect(outerList.type).toBe('bulletList');
    const firstItem = outerList.content?.[0];
    // Nested list should be orderedList because child uses "1." syntax
    const nestedList = firstItem?.content?.[1];
    expect(nestedList?.type).toBe('orderedList');
    expect(nestedList?.content?.[0].content?.[0].content?.[0].text).toBe('child');
  });

  it('parses a list resuming at nesting depth after an interrupting paragraph', () => {
    // The resumed "  * second sub" must not become a nested list with no parent item: that drops
    // the item text and emits an empty bulletList, which Jira rejects with 400 INVALID_INPUT. The
    // continuation paragraph is the sub-item's own, as CommonMark reads it.
    const md = [
      '* guards:',
      '  * first sub',
      '',
      '    continuation para;',
      '  * second sub',
    ].join('\n');
    const doc = convertMarkdownToAdf(md);

    // No list node anywhere may be empty
    const assertNoEmptyLists = (node: AdfNode) => {
      if (node.type === 'bulletList' || node.type === 'orderedList') {
        expect(node.content?.length).toBeGreaterThan(0);
      }
      (node.content || []).forEach(assertNoEmptyLists);
    };
    doc.content.forEach(assertNoEmptyLists);

    expect(doc.content).toHaveLength(1);
    const nested = doc.content[0].content?.[0].content?.[1];
    expect(nested?.type).toBe('bulletList');
    const [first, second] = nested?.content ?? [];
    expect(first.content?.map((n) => n.content?.[0].text)).toEqual(['first sub', 'continuation para;']);
    expect(second.content?.[0].content?.[0].text).toBe('second sub');
  });

  it('keeps ordered list numbering across a continuation paragraph', () => {
    // One list: the paragraph is the item's own, so it numbers 1, 2, 3 with no attrs.order.
    const md = [
      '1. first step',
      '',
      '   continuation of first.',
      '2. second step',
      '3. third step',
    ].join('\n');
    const doc = convertMarkdownToAdf(md);
    const lists = doc.content.filter((n) => n.type === 'orderedList');
    expect(lists).toHaveLength(1);
    expect(lists[0].attrs).toBeUndefined();
    expect(lists[0].content).toHaveLength(3);
    expect(lists[0].content?.[0].content?.map((n) => n.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('parses a standalone indented list as same-level items', () => {
    const doc = convertMarkdownToAdf('  - alpha\n  - beta');
    const list = doc.content[0];
    expect(list.type).toBe('bulletList');
    expect(list.content).toHaveLength(2);
    expect(list.content?.[0].content?.[0].content?.[0].text).toBe('alpha');
    expect(list.content?.[1].content?.[0].content?.[0].text).toBe('beta');
  });

  // Nested tasks are not flattened. PROBED: `taskList > taskList` is 201, ADF's nested checklist,
  // a sibling after its item (`TASK_LIST_CHILDREN` in `adfSchema.ts`).
  it('nests a task list under its parent item as a sibling taskList', () => {
    const doc = convertMarkdownToAdf('- [x] parent\n  - [ ] nested');
    const taskList = doc.content[0];
    expect(taskList.type).toBe('taskList');
    const items = taskList.content || [];
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('taskItem');
    expect(items[0].attrs?.state).toBe('DONE');
    expect(items[1].type).toBe('taskList');
    expect(items[1].content?.[0].type).toBe('taskItem');
    expect(items[1].content?.[0].attrs?.state).toBe('TODO');
  });

  it('leaves @slug as plain text', () => {
    const doc = convertMarkdownToAdf('Hey @jane.smith check this');
    expect(getInline(doc)).toEqual([{ type: 'text', text: 'Hey @jane.smith check this' }]);
  });

  it('converts angle-bracket autolink', () => {
    const doc = convertMarkdownToAdf('<https://example.com>');
    const inline = getInline(doc);
    expect(inline[0].text).toBe('https://example.com');
    expect(inline[0].marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'link',
          attrs: { href: 'https://example.com' },
        }),
      ])
    );
  });

  it('converts bare URL to autolink', () => {
    const doc = convertMarkdownToAdf('visit https://example.com today');
    const inline = getInline(doc);
    const linkNode = inline.find((n) => n.text === 'https://example.com');
    expect(linkNode).toBeDefined();
    expect(linkNode?.marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'link',
          attrs: { href: 'https://example.com' },
        }),
      ])
    );
  });

  it('converts link with jira-attachment scheme to linked text', () => {
    const contentUrl = 'https://mysite.atlassian.net/rest/api/3/attachment/content/att-123';
    const doc = convertMarkdownToAdf(`[file.pdf](jira-attachment:${contentUrl})`);
    const inline = getInline(doc);
    expect(inline[0].text).toBe('file.pdf');
    expect(inline[0].marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'link',
          attrs: { href: contentUrl },
        }),
      ])
    );
  });

  // Angle brackets are stripped before `handleImage`, so this takes the media branch.
  it('converts an angle-bracket image URL to external media', () => {
    const doc = convertMarkdownToAdf('![alt](<https://example.com/img.png>)');
    expect(doc.content[0]?.type).toBe('mediaSingle');
    expect(doc.content[0]?.content?.[0]?.attrs?.url).toBe('https://example.com/img.png');
  });

  it('hoists mediaSingle out of paragraph with surrounding text', () => {
    const contentUrl = 'https://mysite.atlassian.net/rest/api/3/attachment/content/att-123';
    const doc = convertMarkdownToAdf(
      `text before ![img](jira-attachment:${contentUrl}) text after`
    );
    // Should produce: paragraph("text before ") + mediaSingle + paragraph(" text after")
    expect(doc.content.length).toBeGreaterThanOrEqual(3);
    const types = doc.content.map((n) => n.type);
    expect(types).toContain('paragraph');
    expect(types).toContain('mediaSingle');
    // First block is paragraph with "text before"
    const firstPara = doc.content[0];
    expect(firstPara.type).toBe('paragraph');
    expect(extractAllText(firstPara)).toContain('text before');
    // mediaSingle is in the middle
    const mediaIdx = types.indexOf('mediaSingle');
    expect(doc.content[mediaIdx].content?.[0].type).toBe('media');
    // Last block has "text after"
    const lastPara = doc.content[doc.content.length - 1];
    expect(lastPara.type).toBe('paragraph');
    expect(extractAllText(lastPara)).toContain('text after');
  });

  // `isBlockStart()` is looser than the per-block parsers; a line it flags but no branch consumes
  // must still advance the parser (`parseBlocks`' progress guarantee). Each case hangs without it.
  it.each([
    '# ', '## ', '### ', '#### ', '##### ', '###### ', // empty heading markers, every level
    '>foo', // spaceless blockquote
    '```js extra junk', // code fence with trailing junk
  ])('renders block-start lookalike %j as literal text (no hang)', (md) => {
    const doc = convertMarkdownToAdf(md);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('paragraph');
    expect(extractAllText(doc.content[0])).toBe(md);
  });

  it('handles an empty heading embedded inside surrounding content', () => {
    const doc = convertMarkdownToAdf('Before\n\n### \n\nAfter');
    expect(doc.content).toHaveLength(3);
    expect(extractAllText(doc.content[0])).toBe('Before');
    expect(extractAllText(doc.content[1])).toBe('### ');
    expect(extractAllText(doc.content[2])).toBe('After');
  });
});

function extractAllText(node: AdfNode | AdfDocument): string {
  let result = (node as AdfNode).text || '';
  for (const child of node.content || []) {
    result += extractAllText(child);
  }
  return result;
}
