/**
 * A list item holds every block indented to its content column, as CommonMark and GitHub read it.
 * A reader ending the item at the first non-item line splits the list, and SQL in bullets is common
 * (5 of 43 in one support agent's internal notes).
 *
 * Jira, PROBED (`LIST_ITEM_FORBIDDEN` in `adfSchema.ts`): paragraphs, code and lists 201; a heading,
 * quote, rule or table 400, so those move out after their item (`jira/list-item-block-moved-out`),
 * as does anything but a nested checklist under a checklist item. Slack flattens every block but a
 * nested list (probed), so the same move (`slack/list-item-block-moved-out`). Linear and GitHub keep
 * everything in place.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { baselineFor, editorOptionsFor, fromEditorDoc, lostInMarkdown, toEditorDoc } from '../src/editor';
import { maskCode } from '../src/markdown';
import { profiles, type DestinationName } from '../src/profiles';
import type { AdfDocument, AdfNode } from '../src/adf/types';
import type { PmNode } from '../src/prosemirror';

const DESTINATIONS = Object.keys(profiles) as DestinationName[];
/** The destinations whose items keep every block: `listItemBlocks: 'all'`. */
const KEEPING = DESTINATIONS.filter((d) => profiles[d].listItemBlocks === 'all');

/** A tree -- ADF or the editor's -- as nested `type[child,child]` strings, text nodes left out. */
function shape(n: { type: string; content?: readonly { type: string }[] }): string {
  const kids = (n.content ?? []).filter((c) => c.type !== 'text');
  return kids.length ? `${n.type}[${kids.map(shape).join(',')}]` : n.type;
}

/** The converted Jira tree, one string per top-level block. */
const jiraShape = (body: string): string[] => ((render(body, 'jira').converted as AdfDocument).content ?? []).map(shape);

const codes = (body: string, destination: DestinationName = 'jira') =>
  render(body, destination).warnings.map((w) => w.code);

/** What an approval sends, for one destination. */
const sent = (body: string, destination: DestinationName) => baselineFor(render(body, destination)).body;

/**
 * The editor holds what markdown will carry back: the body shown, loaded again, is itself, and the
 * document it came from loses nothing on the way out -- the pair `body/structure-lost` is built on.
 */
function expectFixedPoint(body: string, destination: DestinationName): void {
  const shown = sent(body, destination);
  expect(sent(shown, destination), `${destination}: ${JSON.stringify(body)}`).toBe(shown);
  const options = editorOptionsFor(render(shown, destination));
  const doc = toEditorDoc(shown, options);
  expect(lostInMarkdown(doc, toEditorDoc(fromEditorDoc(doc, options), options))).toEqual([]);
}

describe('four multi-block shapes stay in their item', () => {
  const SHAPES: [string, string, string[]][] = [
    [
      'text after a code block',
      '- step\n  ```sql\n  select 1\n  ```\n  then check X\n- next\n',
      ['bulletList[listItem[paragraph,codeBlock,paragraph],listItem[paragraph]]'],
    ],
    [
      'a second code block',
      '- step\n  ```sql\n  select 1\n  ```\n  then\n  ```sql\n  select 2\n  ```\n- next\n',
      ['bulletList[listItem[paragraph,codeBlock,paragraph,codeBlock],listItem[paragraph]]'],
    ],
    [
      'a paragraph after a blank line',
      '1. first\n\n   more about first\n2. second\n',
      ['orderedList[listItem[paragraph,paragraph],listItem[paragraph]]'],
    ],
    [
      // The one Jira cannot hold: 400, so it moves out, and the list resumes at 2.
      'a quote',
      '1. first\n   > quoted\n2. second\n',
      ['orderedList[listItem[paragraph]]', 'blockquote[paragraph]', 'orderedList[listItem[paragraph]]'],
    ],
  ];

  test.each(SHAPES)('jira: %s', (_, body, shape) => {
    expect(jiraShape(body)).toEqual(shape);
  });

  test.each(SHAPES)('linear and github send %s as written', (_, body) => {
    for (const destination of KEEPING) expect(sent(body, destination)).toBe(body);
  });

  test.each(SHAPES)('every destination: %s is a fixed point', (_, body) => {
    for (const destination of DESTINATIONS) expectFixedPoint(body, destination);
  });

  test('the quote is the only one Jira has to be told about', () => {
    expect(SHAPES.map(([, body]) => codes(body))).toEqual([[], [], [], ['jira/list-item-block-moved-out']]);
  });

  test('a moved-out block keeps the numbering going', () => {
    const lists = (render('1. first\n   > quoted\n2. second\n3. third\n', 'jira').converted as AdfDocument).content
      .filter((n) => n.type === 'orderedList');
    expect(lists.map((l) => l.attrs?.order)).toEqual([undefined, 2]);
    expect(lists[1].content).toHaveLength(2);
  });
});

describe('jira: what an item cannot hold moves out, and is never blocked', () => {
  test.each([
    ['a heading', '- a\n  ## H\n- b\n', 'heading'],
    ['a quote', '- a\n  > q\n- b\n', 'blockquote[paragraph]'],
    ['a rule', '- a\n\n  ---\n- b\n', 'rule'],
    ['a table', '- a\n\n  | x | y |\n  | --- | --- |\n  | 1 | 2 |\n- b\n', 'table[tableRow[tableHeader[paragraph],tableHeader[paragraph]],tableRow[tableCell[paragraph],tableCell[paragraph]]]'],
  ])('%s under a bullet goes just after its item, and the list resumes', (_, body, moved) => {
    expect(jiraShape(body)).toEqual(['bulletList[listItem[paragraph]]', moved, 'bulletList[listItem[paragraph]]']);
    const r = render(body, 'jira');
    expect(r.warnings.map((w) => w.code)).toEqual(['jira/list-item-block-moved-out']);
    expect(r.warnings[0].severity).toBe('warning');
    expect(r.blocked).toBe(false);
  });

  test('any block under a checklist item moves out, and a line break stays in', () => {
    // A checklist item is inline-only in ADF. A hard break is inline, and `taskItem > [text,
    // hardBreak, text]` is probed 201, so continuation TEXT stays; a paragraph after a blank line
    // or a code block does not.
    expect(jiraShape('- [ ] a\n  b\n- [ ] c\n')).toEqual(['taskList[taskItem[hardBreak],taskItem]']);
    expect(codes('- [ ] a\n  b\n- [ ] c\n')).toEqual([]);
    expect(jiraShape('- [ ] a\n\n  more\n  ```\n  x\n  ```\n- [x] c\n')).toEqual([
      'taskList[taskItem]',
      'paragraph',
      'codeBlock',
      'taskList[taskItem]',
    ]);
    expect(codes('- [ ] a\n\n  more\n  ```\n  x\n  ```\n- [x] c\n')).toEqual(['jira/list-item-block-moved-out']);
  });

  test('a nested list under a checklist item keeps its own code, and a block its own', () => {
    // The two disclosures are about different losses, so a draft with both says both.
    expect(codes('- [ ] a\n  - b\n- [ ] c\n  > q\n')).toEqual([
      'jira/task-item-nested-list-unnested',
      'jira/list-item-block-moved-out',
    ]);
  });

  test('from a nested item it moves out of every list, and what follows it goes too, in order', () => {
    // The quote cannot sit in `b` or in `a`, so it reaches the top level; `c` was written after it
    // under `a`, so it follows it there rather than being put back before it.
    const body = '- a\n  - b\n    > q\n  - c\n- d\n';
    expect(jiraShape(body)).toEqual([
      'bulletList[listItem[paragraph,bulletList[listItem[paragraph]]]]',
      'blockquote[paragraph]',
      'bulletList[listItem[paragraph]]',
      'bulletList[listItem[paragraph]]',
    ]);
    // Every word, in the order written.
    expect([...JSON.stringify(render(body, 'jira').converted).matchAll(/"text":"\w"/g)].map((m) => m[0])).toEqual(
      ['a', 'b', 'q', 'c', 'd'].map((t) => `"text":"${t}"`)
    );
  });

  test('the count is one per block as written, not one per list it left', () => {
    const count = (body: string) => render(body, 'jira').warnings.find((w) => w.code === 'jira/list-item-block-moved-out')?.message;
    expect(count('- a\n  - b\n    > q\n')).toMatch(/^A block inside/);
    expect(count('- a\n  > q\n  ## H\n')).toMatch(/^2 blocks inside/);
  });

  test('inside a quote, a block the quote cannot hold either moves past the quote too', () => {
    // Moved out of the item, `> q` would land in the outer quote: `blockquote > blockquote`, a probed
    // JSM 400, and a draft that is never blocked would be.
    for (const body of ['> - a\n>   > q\n', '> 1. step\n>    | a | b |\n>    | --- | --- |\n']) {
      const r = render(body, 'jira');
      expect(r.warnings.map((w) => w.code), body).toEqual(['jira/list-item-block-moved-out']);
      expect(r.blocked).toBe(false);
      expectFixedPoint(body, 'jira');
    }
    // Written straight into the quote, a heading is a blocking error.
    expect(render('> # H\n', 'jira').blocked).toBe(true);
  });

  test('inside an expand, an expand moved out of an item moves past the outer one too', () => {
    // ADF spells an expand inside an expand `nestedExpand`; the converter never writes one.
    const body = '+++ Title\n- a\n\n  +++ inner\n  body\n  +++\n+++\n';
    expect(jiraShape(body)).toEqual(['expand[bulletList[listItem[paragraph]]]', 'expand[paragraph]']);
  });

  test('an orphaned checklist joins the one that resumed beside it', () => {
    // Two checklists side by side in an item are one checklist in markdown, so leaving them apart
    // would make the first edit lose one and block.
    const body = '- a\n  - [ ] b\n    ```\n    x\n    ```\n    - [ ] c\n  - [ ] d\n';
    expect(jiraShape(body)).toEqual(['bulletList[listItem[paragraph,taskList[taskItem],codeBlock,taskList[taskItem,taskItem]]]']);
    expectFixedPoint(body, 'jira');
  });

  test('never an empty list, whatever moves', () => {
    const empty = (n: AdfNode): boolean =>
      (['bulletList', 'orderedList', 'taskList'].includes(n.type) && !(n.content ?? []).length) ||
      (n.content ?? []).some(empty);
    for (const body of ['- a\n  > q\n', '- [ ] a\n\n  b\n', '1. a\n   ## H\n   > q\n   ---\n', '- a\n  - b\n    > q\n']) {
      expect((render(body, 'jira').converted as AdfDocument).content.some(empty), body).toBe(false);
    }
  });

  test.each([
    '- a\n  > q\n- b\n',
    '- [ ] a\n\n  more\n  ```\n  x\n  ```\n- [x] c\n',
    '- a\n  - b\n    > q\n  - c\n- d\n',
    '1. a\n   ## H\n2. b\n3. c\n',
  ])('the moved-out draft is a fixed point: %j', (body) => {
    expectFixedPoint(body, 'jira');
    // And the load silences the warning (`silencedByRoundTrip`).
    expect(codes(sent(body, 'jira'))).not.toContain('jira/list-item-block-moved-out');
  });
});

describe('slack: only a nested list stays in an item', () => {
  // Probe 1's draft, sent unedited to a Slack self-DM (ts 1790240182.921259): every
  // block inside an item was flattened into the item's text. The code spans and escapes below it
  // rendered correctly.
  const PROBE_1 = [
    'draftgate probe: list items, code spans, escapes. Scratch message, ignore.',
    '',
    '1. A step with code and text after it:',
    '   ```sql',
    '   SELECT id, name',
    '   FROM users',
    '   WHERE active = 1;',
    '   ```',
    '   Then check the row count matches.',
    '2. A step with two code blocks:',
    '   ```sh',
    '   bun test',
    '   ```',
    '   and then:',
    '   ```sh',
    '   bun run typecheck',
    '   ```',
    '   Both should pass.',
    '',
    '- A bullet with a paragraph after a blank line.',
    '',
    '  This paragraph belongs to the bullet above.',
    '- A bullet holding a quote:',
    '  > quoted inside the bullet',
    '',
    'Code spans: the `` `backtick` `` character, and ``a`b`` inline.',
    '',
    'Escapes: he said \\"ship it\\", \\@todo stays text, and \\#12 is not a link.',
    '',
  ].join('\n');
  const TAIL = [
    'Code spans: the `` `backtick` `` character, and ``a`b`` inline.',
    '',
    'Escapes: he said "ship it", @todo stays text, and #12 is not a link.',
    '',
  ];

  test("probe 1's draft goes out in probe 2's spelling", () => {
    // Probe 2 (ts 1790240511.232529) is this shape: each block at the top level right after its
    // item, a blank line either side, and the list resumed as `2.`. Slack rendered all of it.
    expect(sent(PROBE_1, 'slack')).toBe(
      [
        'draftgate probe: list items, code spans, escapes. Scratch message, ignore.',
        '',
        '1. A step with code and text after it:',
        '',
        '```sql',
        'SELECT id, name',
        'FROM users',
        'WHERE active = 1;',
        '```',
        '',
        'Then check the row count matches.',
        '',
        '2. A step with two code blocks:',
        '',
        '```sh',
        'bun test',
        '```',
        '',
        'and then:',
        '',
        '```sh',
        'bun run typecheck',
        '```',
        '',
        'Both should pass.',
        '',
        '- A bullet with a paragraph after a blank line.',
        '',
        'This paragraph belongs to the bullet above.',
        '',
        '- A bullet holding a quote:',
        '',
        '> quoted inside the bullet',
        '',
        ...TAIL,
      ].join('\n')
    );
    const r = render(PROBE_1, 'slack');
    expect(r.warnings.map((w) => w.code)).toEqual(['slack/list-item-block-moved-out']);
    expect(r.warnings[0].message).toMatch(/^8 blocks inside list items/);
    expect(r.warnings[0].severity).toBe('warning');
    expect(r.blocked).toBe(false);
    expectFixedPoint(PROBE_1, 'slack');
    // Loading applies the move, so the body shown no longer warns: `silencedByRoundTrip`.
    expect(codes(sent(PROBE_1, 'slack'), 'slack')).toEqual([]);
  });

  test('linear and github send the same draft with every block still in its item', () => {
    // Linear, probed with the same draft on a scratch issue: every block stays inside its item.
    const kept = [
      'draftgate probe: list items, code spans, escapes. Scratch message, ignore.',
      '',
      ...PROBE_1.split('\n').slice(2, 18),
      '',
      '- A bullet with a paragraph after a blank line.',
      '',
      '  This paragraph belongs to the bullet above.',
      '- A bullet holding a quote:',
      '  > quoted inside the bullet',
      '',
      ...TAIL,
    ].join('\n');
    for (const destination of KEEPING) {
      expect(sent(PROBE_1, destination), destination).toBe(kept);
      expect(codes(PROBE_1, destination)).toEqual([]);
    }
  });

  test.each([
    ['a code block', '- a\n  ```\n  x\n  ```\n- b\n', '- a\n\n```\nx\n```\n\n- b\n'],
    ['a second paragraph', '- a\n\n  more\n- b\n', '- a\n\nmore\n\n- b\n'],
    ['a quote', '- a\n  > q\n- b\n', '- a\n\n> q\n\n- b\n'],
    // Neither probed; Jira's 400s, and the conservative side of an unprobed shape is to move it.
    ['a heading', '- a\n  ## H\n- b\n', '- a\n\n## H\n\n- b\n'],
    ['a table', '- a\n\n  | x | y |\n  | --- | --- |\n- b\n', '- a\n\n| x | y |\n| --- | --- |\n\n- b\n'],
    ['a code block under a checklist item', '- [ ] a\n  ```\n  x\n  ```\n- [x] b\n', '- [ ] a\n\n```\nx\n```\n\n- [x] b\n'],
  ])('%s moves out, disclosed, and the list resumes', (_, body, out) => {
    expect(sent(body, 'slack')).toBe(out);
    const r = render(body, 'slack');
    expect(r.warnings.map((w) => w.code)).toEqual(['slack/list-item-block-moved-out']);
    expect(r.blocked).toBe(false);
    expectFixedPoint(body, 'slack');
  });

  test('every markdown destination that moves a block sends it moved, not only Slack', () => {
    // The move happens at load and in `convert`, whose `converted` is what `wireBody` sends for a
    // `preview-only` destination; a profile with only the first would preview a move it does not send.
    const body = '- a\n  ```\n  x\n  ```\n- b\n';
    const moving = DESTINATIONS.filter((d) => profiles[d].mode === 'preview-only' && profiles[d].listItemBlocks !== 'all');
    expect(moving).toContain('slack');
    for (const destination of moving) expect(render(body, destination).converted, destination).toBe(sent(body, destination));
    // And a list-free body skips the conversion without changing the answer.
    expect(render('plain\n', 'slack').converted).toBe('plain\n');
    expect(codes('> - a\n>   ```\n>   x\n>   ```\n', 'slack')).toEqual(['slack/list-item-block-moved-out']);
  });

  test('the numbering continues, which probe 2 shows Slack honours', () => {
    expect(sent('1. a\n   ```\n   x\n   ```\n2. b\n3. c\n', 'slack')).toBe('1. a\n\n```\nx\n```\n\n2. b\n3. c\n');
  });

  test('a nested list stays inside its item, under a checklist item too', () => {
    for (const body of ['- a\n  - b\n  1. c\n- d\n', '1. a\n   - [ ] b\n2. c\n', '- [ ] a\n  - b\n- [ ] c\n']) {
      expect(sent(body, 'slack')).toBe(body);
      expect(codes(body, 'slack')).toEqual([]);
      expectFixedPoint(body, 'slack');
    }
  });

  test('from a nested item a block reaches the top level, and what follows it goes too, in order', () => {
    const body = '- a\n  - b\n    ```\n    x\n    ```\n  - c\n- d\n';
    // `c` was written after the code, under `a`, so it follows it out rather than going back before it.
    expect(sent(body, 'slack')).toBe('- a\n  - b\n\n```\nx\n```\n\n- c\n\n- d\n');
    expect(render(body, 'slack').warnings[0].message).toMatch(/^2 blocks inside/);
    expectFixedPoint(body, 'slack');
  });

  test('a checklist orphaned behind a moved block is counted with it', () => {
    const r = render('- [ ] a\n  ```\n  x\n  ```\n  - [ ] b\n', 'slack');
    expect(r.warnings.map((w) => w.message.slice(0, 8))).toEqual(['2 blocks']);
  });

  test("inside a quote, a moved block stays in the quote: Jira's splitting rule is not Slack's", () => {
    const body = '> - a\n>   ```\n>   x\n>   ```\n';
    expect(sent(body, 'slack')).toBe('> - a\n> \n> ```\n> x\n> ```\n');
    expectFixedPoint(body, 'slack');
  });
});

describe('linear and github keep every block inside the item', () => {
  test.each([
    '- a\n  ## H\n- b\n',
    '- a\n  > q\n- b\n',
    '- a\n\n  | x | y |\n  | --- | --- |\n- b\n',
    '- [ ] a\n  > q\n\n  more\n- [x] b\n',
    '- [ ] a\n  ```\n  x\n  ```\n',
  ])('%j', (body) => {
    for (const destination of KEEPING) {
      expect(sent(body, destination)).toBe(body);
      expect(codes(body, destination)).toEqual([]);
      expectFixedPoint(body, destination);
    }
  });
});

describe('the edges of what an item owns', () => {
  test('a line under the item is its first paragraph continuing, as a hard break', () => {
    // Read as a paragraph after the list, a reviewer's Shift+Enter in a list item would be a
    // `hardBreak` markdown cannot carry.
    expect(jiraShape('- a\n  b\n')).toEqual(['bulletList[listItem[paragraph[hardBreak]]]']);
    for (const destination of DESTINATIONS) expectFixedPoint('- a\n  b\n- [ ] c\n  d\n', destination);
  });

  test('a blank line followed by a line short of the content column still ends the list', () => {
    expect(jiraShape('- a\n\nb\n')).toEqual(['bulletList[listItem[paragraph]]', 'paragraph']);
    // The column is past all the spaces after the marker, up to four (CommonMark example 276), so
    // `-    foo` owns a line at its column and not one two spaces in.
    expect(jiraShape('-    foo\n\n  bar\n')).toEqual(['bulletList[listItem[paragraph]]', 'paragraph']);
    expect(jiraShape('-    foo\n\n     bar\n')).toEqual(['bulletList[listItem[paragraph,paragraph]]']);
    expect(jiraShape('- a\n\n- b\n')).toEqual(['bulletList[listItem[paragraph]]', 'bulletList[listItem[paragraph]]']);
  });

  test('a fence on the marker line that never closes is the item\'s text, and nesting it is linear', () => {
    expect(jiraShape('- ```\n  not code\n')).toEqual(['bulletList[listItem[paragraph[hardBreak]]]']);
    // Parsing it both ways and throwing one away, at every depth, is exponential.
    const deep = Array.from({ length: 200 }, (_, i) => '  '.repeat(i) + '- ```').join('\n');
    const started = performance.now();
    render(deep, 'jira');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('an unclosed fence in an item stays literal text, which the code-region scan mirrors', () => {
    const r = render('- a\n  ```\n  not code\n', 'jira');
    expect(JSON.stringify(r.converted)).not.toContain('codeBlock');
    expect(JSON.stringify(r.converted)).toContain('not code');
  });

  test('many unclosed fences in one item stay linear', () => {
    // Searching to the end of the item for each one's closer, which it cannot have, is quadratic:
    // 3,000 of them take 1.7 s, on the keystroke path.
    const body = '- a\n' + '  ```\n  x\n'.repeat(12_000);
    const started = performance.now();
    render(body, 'jira');
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test('an expand indented in an item closes on its indented closer', () => {
    const body = '1. a\n    +++ t\n    body\n    +++\n2. b\n';
    expect(jiraShape(body)).toEqual(['orderedList[listItem[paragraph]]', 'expand[paragraph]', 'orderedList[listItem[paragraph]]']);
    expect(JSON.stringify(render(body, 'jira').converted)).not.toContain('+++');
  });

  test('a block may start up to three spaces past the content column', () => {
    expect(jiraShape('- a\n     ```\n     x\n     ```\n')).toEqual(['bulletList[listItem[paragraph,codeBlock]]']);
    expect(jiraShape('- a\n   # Head\n   > q\n')).toEqual(['bulletList[listItem[paragraph]]', 'heading', 'blockquote[paragraph]']);
    // Four or more is text, not a heading: indented code, which this converter does not read.
    expect(jiraShape('- a\n      # not a heading\n')).toEqual(['bulletList[listItem[paragraph[hardBreak]]]']);
    for (const destination of DESTINATIONS) {
      expectFixedPoint('- a\n   # Head\n', destination);
      expectFixedPoint('- a\n      # not a heading\n', destination);
    }
  });

  test('nested runs a blank line apart are one list, whatever they are numbered', () => {
    // The writer cannot spell two numbered lists one after the other at one indent, so the reader
    // must not build them: `lostInMarkdown` would block the first edit.
    expect(jiraShape('- a\n  1. x\n\n  5. y\n')).toEqual(['bulletList[listItem[paragraph,orderedList[listItem[paragraph],listItem[paragraph]]]]']);
    for (const destination of DESTINATIONS) expectFixedPoint('- a\n  1. x\n\n  5. y\n', destination);
  });

  test('two quotes a blank line apart stay two', () => {
    // Written adjacent, they would be one quote -- a fixed point, and not what was written.
    for (const destination of KEEPING) {
      expect(sent('- a\n  > one\n\n  > two\n', destination)).toBe('- a\n  > one\n\n  > two\n');
    }
  });

  test('deep nesting is linear, and past a thousand levels it is refused, quickly', () => {
    // A line ten deep is read by ten items; re-reading its indent each time is quadratic (10,000
    // nested items hang `render()`), so it is read once (`LineShape`). Past `MAX_LIST_DEPTH` the
    // reader throws the stack overflow's own error, which the review turns into `review/crashed`.
    const chain = (n: number) => Array.from({ length: n }, (_, i) => '  '.repeat(i) + '- x').join('\n');
    let started = performance.now();
    render(chain(900), 'jira');
    expect(performance.now() - started).toBeLessThan(2_000);
    started = performance.now();
    expect(() => render(chain(10_000), 'jira')).toThrow('Maximum call stack size exceeded');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('the code-region scan reads an item\'s fences as the converter does', () => {
  test('a closed fence indented at the top level is code to both, and an unclosed one prose to both', () => {
    const closed = '  ```\n  ![i](https://e.test/a.png)\n  ```\n';
    expect(jiraShape(closed)).toEqual(['codeBlock']);
    expect(maskCode(closed)).not.toContain('![i]');
    const open = '  ```\n  ![i](https://e.test/a.png)\n';
    expect(JSON.stringify(render(open, 'jira').converted)).not.toContain('codeBlock');
    expect(maskCode(open)).toContain('![i]');
  });

  test('an indented tilde fence is code to both', () => {
    const body = '- a\n  ~~~\n  ![i](https://e.test/a.png)\n  ~~~\n';
    expect(jiraShape(body)).toEqual(['bulletList[listItem[paragraph,codeBlock]]']);
    expect(maskCode(body)).not.toContain('![i]');
    // So nothing warns about an image that is code. (Slack does move the code block out.)
    expect(codes(body, 'slack')).toEqual(['slack/list-item-block-moved-out']);
  });
});

describe('the editor spells multi-block items back', () => {
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const task = (...content: unknown[]) =>
    ({ type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content }] }] }) as unknown as PmNode;
  const bullet = (...content: unknown[]) =>
    ({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content }] }] }) as unknown as PmNode;
  const code = { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] };

  test.each([
    ['a checklist item with two paragraphs', task(p('one'), p('two')), '- [ ] one\n\n  two'],
    ['a checklist item with code', task(p('one'), code), '- [ ] one\n  ```\n  x\n  ```'],
    ['a bullet with code and text after it', bullet(p('one'), code, p('two')), '- one\n  ```\n  x\n  ```\n  two'],
    ['a bullet with a rule', bullet(p('one'), { type: 'horizontalRule' }), '- one\n\n  ---'],
  ])('%s', (_, doc, markdown) => {
    // The leading paragraph of a checklist item is its text; gluing every paragraph after it on
    // would send `- [ ] onetwo` for the first of these.
    expect(fromEditorDoc(doc)).toBe(markdown);
    const options = { listItemBlocks: 'all' as const };
    expect(lostInMarkdown(doc, toEditorDoc(markdown, options))).toEqual([]);
  });

  test('a checklist item whose text is empty keeps an empty first paragraph, so the schema holds', () => {
    // Without it the block under the item would become its text, and a code block first is invalid
    // under TipTap's `paragraph block*`.
    const doc = toEditorDoc('- [ ]\n  ```\n  x\n  ```\n', { listItemBlocks: 'all' as const }) as unknown as {
      content: { content: { content: { type: string }[] }[] }[];
    };
    expect(doc.content[0].content[0].content.map((n) => n.type)).toEqual(['paragraph', 'codeBlock']);
  });
});

describe('an item written `-   ` or `1.  ` is the same item', () => {
  /**
   * The same draft with each top-level marker padded to column four (remark's "tab" indent, pandoc's
   * output), owned lines moved to match; CommonMark reads both alike. Kept in the item's text, the
   * spaces would put later blocks short of the writer's `- ` column: the preview would hold a code
   * block the send drops out of the item, and Jira would get literal fences.
   */
  function widened(body: string): string {
    let col = 0;
    return body
      .split('\n')
      .map((line) => {
        const item = line.match(/^(-|\d+\.) (.*)$/);
        if (item) {
          col = item[1].length + 1;
          return item[1].padEnd(4) + item[2];
        }
        const spaces = line.match(/^ */)![0].length;
        return col > 0 && line.trim() !== '' && spaces >= col ? ' '.repeat(4 - col) + line : line;
      })
      .join('\n');
  }

  /** The editor's document: what the reviewer sees. */
  const shown = (body: string, destination: DestinationName) =>
    shape(toEditorDoc(body, editorOptionsFor(render(body, destination))) as unknown as { type: string });

  // Every multi-block shape above, plus three more drafts of the kind that arrive widened.
  const DRAFTS = [
    '- step\n  ```sql\n  select 1\n  ```\n  then check X\n- next\n',
    '- step\n  ```sql\n  select 1\n  ```\n  then\n  ```sql\n  select 2\n  ```\n- next\n',
    '1. first\n\n   more about first\n2. second\n',
    '1. first\n   > quoted\n2. second\n',
    '- a\n  ## H\n- b\n',
    '- a\n  > q\n- b\n',
    '- a\n\n  ---\n- b\n',
    '- a\n\n  | x | y |\n  | --- | --- |\n  | 1 | 2 |\n- b\n',
    '- [ ] a\n  b\n- [ ] c\n',
    '- [ ] a\n\n  more\n  ```\n  x\n  ```\n- [x] c\n',
    '- a\n  - b\n    > q\n  - c\n- d\n',
    '1. a\n   ## H\n2. b\n3. c\n',
    '- ```sh\n  make\n  ```\n',
    '- Run:\n\n  ```sh\n  make test\n  ```\n',
    '1. First step\n\n   More detail on it.\n2. Second step\n',
  ];

  test('the widening is the remark and pandoc spelling', () => {
    expect(widened(DRAFTS[13])).toBe('-   Run:\n\n    ```sh\n    make test\n    ```\n');
    expect(widened(DRAFTS[2])).toBe('1.  first\n\n    more about first\n2.  second\n');
  });

  test.each(DRAFTS)('every destination previews, warns and sends %j the same either way', (body) => {
    const wide = widened(body);
    expect(wide).not.toBe(body);
    for (const destination of DESTINATIONS) {
      const label = `${destination}: ${JSON.stringify(wide)}`;
      expect(shown(wide, destination), label).toBe(shown(body, destination));
      expect(codes(wide, destination), label).toEqual(codes(body, destination));
      expect(sent(wide, destination), label).toBe(sent(body, destination));
      // What goes out, loaded again, is what the reviewer was shown.
      expect(shown(sent(wide, destination), destination), label).toBe(shown(wide, destination));
      expectFixedPoint(wide, destination);
    }
    expect(jiraShape(sent(wide, 'jira'))).toEqual(jiraShape(wide));
  });

  test('jira gets the code block, not literal fences', () => {
    const tree = JSON.stringify(render(sent('-   Run:\n\n    ```sh\n    make test\n    ```\n', 'jira'), 'jira').converted);
    expect(tree).toContain('codeBlock');
    expect(tree).not.toContain('```');
  });

  test('the absorbed spaces are not the text, and a checkbox after them is a checkbox', () => {
    // Kept, the spaces would open the first paragraph as `"  Run:"`, and Jira would receive them.
    expect(JSON.stringify(render('-   Run:\n', 'jira').converted)).toContain('"text":"Run:"');
    expect(jiraShape('-   [ ] a\n-   [x] b\n')).toEqual(['taskList[taskItem,taskItem]']);
    expect(jiraShape('1.  [ ] a\n')).toEqual(['taskList[taskItem]']);
  });

  test.each([
    '-   a\n\n  b\n',
    '-   a\n  b\n',
    '-   a\n\n  ```\n  x\n  ```\n',
    '-   a\n\n  > q\n',
    '-   a\n\n   ## H\n',
    '-   a\n\n  | x | y |\n  | --- | --- |\n',
    '1.  a\n\n   b\n',
    '-   a\n\n  +++ t\n  x\n  +++\n',
  ])('a block short of the wide column stays after the list when the marker narrows: %j', (body) => {
    // The column is four as written and two as sent, so a block two or three spaces in would move
    // into the item on the next read. A top-level block may start up to three spaces in and is
    // written at column zero.
    for (const destination of DESTINATIONS) {
      const label = `${destination}: ${JSON.stringify(body)}`;
      expect(shown(body, destination), label).toMatch(/^doc\[(bullet|ordered)List\[listItem\[paragraph\]\],/);
      expect(shown(sent(body, destination), destination), label).toBe(shown(body, destination));
      expectFixedPoint(body, destination);
    }
  });

  test('five or more spaces are still one absorbed and the rest the text, as spec example 276 has it', () => {
    // Indented code in CommonMark; this converter does not read indented code, so it stays text.
    expect(JSON.stringify(render('-     code\n', 'jira').converted)).toContain('"text":"    code"');
  });
});
