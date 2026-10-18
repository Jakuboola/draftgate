/**
 * A `|` inside a table cell. The writer spells it `\|`; a reader that ignored `\|` would turn a
 * reviewer's `ls | wc` in a Jira cell into three cells under two headers, which Jira accepts
 * (probed: 201, stored ragged).
 *
 * The rule is cmark-gfm's (GitHub's): a row splits on every pipe no backslash precedes, inside a
 * code span too, and that backslash is dropped first, so `` `\|` `` is the code `|`. Where micromark
 * differs (`\\|`, which it splits), GitHub does not, and the writer depends on GitHub's reading.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { baselineFor, editorOptionsFor, markdownFor, toEditorDoc } from '../src/editor';
import { profiles, type DestinationName } from '../src/profiles';
import type { AdfDocument, AdfNode } from '../src/adf/types';
import type { PmNode } from '../src/prosemirror';

const DESTINATIONS = Object.keys(profiles) as DestinationName[];

type Doc = { content?: (AdfNode | PmNode)[] };

/** `read` of every cell of every row of the first table, in an ADF or editor document. */
function cells<T>(doc: Doc, read: (cell: AdfNode | PmNode) => T): T[][] {
  const table = doc.content?.find((n) => n.type === 'table');
  return (table?.content ?? []).map((row) => (row.content ?? []).map(read));
}

const textOf = (n: AdfNode | PmNode): string => (n.text ?? '') + (n.content ?? []).map(textOf).join('');
const hasCode = (n: AdfNode | PmNode): boolean => !!n.marks?.some((m) => m.type === 'code') || (n.content ?? []).some(hasCode);

const cellTexts = (doc: Doc) => cells(doc, textOf);
const codeCells = (doc: Doc) => cells(doc, hasCode);

/** A two-column table with one body row, which every edit starts from. */
const BODY = '| cmd | note |\n| --- | --- |\n| ls | list |\n';

/** The editor document for `body`, as the window loads it for `destination`. */
function loaded(body: string, destination: DestinationName): PmNode {
  return toEditorDoc(body, editorOptionsFor(render(body, destination)));
}

/** Replace the text of the first body cell, the gesture a reviewer makes by typing in it. */
function typeIntoFirstBodyCell(doc: PmNode, text: string, marks?: PmNode['marks']): PmNode {
  const copy: PmNode = structuredClone(doc);
  const table = copy.content!.find((n) => n.type === 'table')!;
  const cell = table.content![1]!.content![0]!;
  cell.content = [{ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] }];
  return copy;
}

describe('the edited path: a pipe the reviewer types into a cell', () => {
  /** What the window does on a keystroke (`useReview.onChange`): the body, then its render. */
  function edit(destination: DestinationName, text: string) {
    const doc = typeIntoFirstBodyCell(loaded(BODY, destination), text);
    const sent = markdownFor(render(BODY, destination), doc);
    return { sent, result: render(sent, destination, doc) };
  }

  for (const destination of DESTINATIONS) {
    test(`${destination}: the row stays two cells in the body that is sent`, () => {
      const { sent, result } = edit(destination, 'ls | wc');
      expect(sent).toContain('ls \\| wc');
      expect(cellTexts(loaded(sent, destination))).toEqual([['cmd', 'note'], ['ls | wc', 'list']]);
      expect(result.warnings.map((w) => w.code)).toEqual([]);
      expect(result.blocked).toBe(false);
    });
  }

  test('jira: the ADF that is sent has two cells under two headers', () => {
    const { result } = edit('jira', 'ls | wc');
    expect(cellTexts(result.converted as AdfDocument)).toEqual([['cmd', 'note'], ['ls | wc', 'list']]);
  });
});

describe('the unedited path: an agent writes the pipe escaped', () => {
  const CASES: [string, string, string[][], boolean[][]][] = [
    [
      'outside a code span',
      '| cmd | note |\n| --- | --- |\n| ls \\| wc | pipes |\n',
      [['cmd', 'note'], ['ls | wc', 'pipes']],
      [[false, false], [false, false]],
    ],
    [
      'inside a code span',
      '| cmd | note |\n| --- | --- |\n| `ls \\| wc` | pipes |\n',
      [['cmd', 'note'], ['ls | wc', 'pipes']],
      [[false, false], [true, false]],
    ],
    [
      'in a header cell',
      '| a \\| b | c |\n| --- | --- |\n| x | y |\n',
      [['a | b', 'c'], ['x', 'y']],
      [[false, false], [false, false]],
    ],
  ];

  for (const destination of DESTINATIONS) {
    for (const [name, body, cells, code] of CASES) {
      test(`${destination}: ${name} is one cell, shown and sent`, () => {
        const result = render(body, destination);
        const { doc, body: sent } = baselineFor(result);
        expect(cellTexts(doc)).toEqual(cells);
        expect(codeCells(doc)).toEqual(code);
        // The body sent reads back as the table shown, and is a fixed point.
        expect(cellTexts(loaded(sent, destination))).toEqual(cells);
        expect(baselineFor(render(sent, destination)).body).toBe(sent);
      });
    }
  }

  test('jira: the converted ADF keeps two columns', () => {
    for (const [, body, cells] of CASES) {
      expect(cellTexts(render(body, 'jira').converted as AdfDocument)).toEqual(cells);
    }
  });
});

describe('what still splits, and what does not, as GitHub reads it', () => {
  test('a bare pipe inside a code span splits the cell -- a code span does not protect it', () => {
    const doc = render('| a | b |\n| --- | --- |\n| `x|y` | z |\n', 'jira').converted as AdfDocument;
    expect(cellTexts(doc)[1]!.slice(0, 2)).toEqual(['`x', 'y`']);
  });

  test('a pipe after two backslashes does not split, unlike micromark', () => {
    // cmark-gfm: one backslash is dropped before the pipe, and `\|` is then an escaped pipe.
    const doc = render('| a | b |\n| --- | --- |\n| x \\\\| y | z |\n', 'jira').converted as AdfDocument;
    expect(cellTexts(doc)[1]).toEqual(['x | y', 'z']);
  });

  test('a backslash before an escaped pipe keeps both halves', () => {
    const doc = render('| a | b |\n| --- | --- |\n| x \\\\\\| y | z |\n', 'jira').converted as AdfDocument;
    expect(cellTexts(doc)[1]).toEqual(['x \\| y', 'z']);
  });
});

/**
 * The writer against the reader, over every short cell text built from the characters that matter:
 * the body sent reads back as the same cells. A gained cell is invisible to `lostInMarkdown`, which
 * counts lost nodes.
 */
describe('a cell the reviewer fills reads back as itself', () => {
  const ALPHABET = ['a', '\\', '|', '`', ' '];
  const texts: string[] = [];
  const grow = (prefix: string, left: number): void => {
    if (prefix.trim() && prefix === prefix.trim()) texts.push(prefix);
    if (left) for (const c of ALPHABET) grow(prefix + c, left - 1);
  };
  grow('', 4);

  for (const destination of DESTINATIONS) {
    test(`${destination}: ${texts.length} texts, as text and as code`, () => {
      const start = render(BODY, destination);
      const base = toEditorDoc(BODY, editorOptionsFor(start));
      const failures: string[] = [];
      for (const text of texts) {
        for (const code of [false, true]) {
          const doc = typeIntoFirstBodyCell(base, text, code ? [{ type: 'code' }] : undefined);
          const sent = markdownFor(start, doc);
          const row = cellTexts(loaded(sent, destination))[1];
          if (row?.length !== 2 || row[0] !== text) failures.push(`${JSON.stringify(text)}${code ? ' (code)' : ''} -> ${JSON.stringify(row)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
