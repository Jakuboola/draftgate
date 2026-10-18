/**
 * Emphasis that spans a code span, and the destination fact that decides its fate.
 *
 * For Jira the marks are stripped: `code`+`strong` is a probed 400 that loses the whole comment
 * (`CODE_MARK_COMBINES_WITH`). The editor pipeline is markdown -> ADF -> ProseMirror for every
 * destination, so that ADF rule can reach Slack, Linear and GitHub, which store the markdown: there
 * `**`code` and words**` would go out as `` `code` **and words** `` with `warnings: []`.
 *
 * Asserted on the body an approval sends (`baselineFor`); TipTap's `Code` mark (`excludes: '_'`)
 * is the third layer, in `surface/schema.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { baselineFor } from '../src/editor';
import { render } from '../src/render';
import { profiles, type DestinationName } from '../src/profiles/index';

/** What an unedited approval would send: the body the reviewer is shown. */
const sent = (body: string, destination: DestinationName) =>
  baselineFor({ ...profiles[destination], canonical: body }).body;

/**
 * `[label, body, jiraStrips]`. In the first six the emphasis extends past the span, so the writer's
 * grouping lifts it out; in the rest nothing neighbours the span and `applyMarks` writes the mark
 * around the backticks itself. Only those reach `a **`c`** b`, which a lift-only writer sends as
 * `a `c` b`. `jiraStrips` is false for the two rows with a link and no emphasis over the span: they
 * must round-trip for Jira with no warning.
 */
const SHAPES: [string, string, boolean][] = [
  ['bold opening on a code span', '**`code` and words**\n', true],
  ['bold closing on a code span', '**words and `code`**\n', true],
  ['a code span in the middle of bold', '**a `c` b**\n', true],
  ['italic over a code span', '*`code` italic*\n', true],
  ['strikethrough over a code span', '~~`code` struck~~\n', true],
  ['bold inside a link, over a code span', '[**`c` x**](https://e.test)\n', true],
  // Emphasis covering EXACTLY the span, with prose on both sides, one side, and neither.
  ['bold on the span alone, mid-sentence', 'a **`c`** b\n', true],
  ['bold on the span alone, opening the line', '**`c`** at start\n', true],
  ['bold on the span alone, closing the line', 'ends with **`c`**\n', true],
  ['bold on the span alone, whole body', '**`c`**\n', true],
  ['italic on the span alone', 'x *`c`* y\n', true],
  ['strikethrough on the span alone', 'x ~~`c`~~ y\n', true],
  ['two spans, each emphasised alone', 'a **`c`** b *`d`* e\n', true],
  // A link with prose around it: the run does not start at the marked node, so a grouping
  // anchored on the first node writes TWO links.
  ['a link with prose on both sides', 'lead [**a** b](https://e.test) tail\n', false],
  ['a linked code span with prose on both sides', 'x [**`c` y**](https://e.test) z\n', true],
  ['a plain linked code span, mid-sentence', 'see [`cfg`](https://e.test) here\n', false],
];

describe('a destination that receives the MARKDOWN keeps emphasis over a code span', () => {
  // Derived from the profiles, so a destination added or changed is covered.
  const carriers = (Object.keys(profiles) as DestinationName[]).filter(
    (d) => profiles[d].codeSpanMarks === 'any'
  );

  test('and there are three of them, so this cannot pass vacuously', () => {
    expect(carriers.sort()).toEqual(['github', 'linear', 'slack']);
  });

  for (const destination of carriers) {
    for (const [label, body] of SHAPES) {
      test(`${destination}: ${label} is sent byte for byte`, () => {
        expect(sent(body, destination)).toBe(body);
      });
    }
  }

  test('and no warning is raised, because nothing was altered', () => {
    for (const destination of carriers) {
      for (const [, body] of SHAPES) {
        expect(render(body, destination).warnings).toEqual([]);
      }
    }
  });
});

describe('Jira strips the marks it cannot send, and says so', () => {
  test('the emphasis leaves the code span and stays on the words', () => {
    expect(sent('**`code` and words**\n', 'jira')).toBe('`code` **and words**\n');
    expect(sent('*`code` italic*\n', 'jira')).toBe('`code` *italic*\n');
  });

  // Each text node carries its own copy of the `link` mark; the run-grouping in `adfToMarkdown`
  // keeps them one link rather than two adjacent ones.
  test('and a link around it stays ONE link', () => {
    expect(sent('[**`c` x**](https://e.test)\n', 'jira')).toBe('[`c` **x**](https://e.test)\n');
    // With prose around it: the run does not begin at the linked node, so a grouping anchored on
    // the first node would answer `no marks` and split the link in two.
    expect(sent('lead [**a** b](https://e.test) tail\n', 'jira')).toBe(
      'lead [**a** b](https://e.test) tail\n'
    );
    expect(sent('x [**`c` y**](https://e.test) z\n', 'jira')).toBe(
      'x [`c` **y**](https://e.test) z\n'
    );
  });

  test('every shape that loses something raises `jira/code-span-emphasis-lost`, at `warning`', () => {
    for (const [label, body, strips] of SHAPES) {
      const found = render(body, 'jira').warnings.filter(
        (w) => w.code === 'jira/code-span-emphasis-lost'
      );
      if (!strips) {
        // A link on a code span is legal ADF (probed 201): nothing dropped, nothing said.
        expect(found.length, `${label} warned about a shape Jira accepts`).toBe(0);
        expect(sent(body, 'jira'), `${label} was altered for Jira`).toBe(body);
        continue;
      }
      expect(found.length, `${label} raised no warning`).toBe(1);
      expect(found[0].severity).toBe('warning');
    }
  });

  test('the emphasis leaves a span it covers EXACTLY, and the words keep none', () => {
    // Nothing is left to carry the mark, so Jira gets a bare span -- and is told.
    expect(sent('a **`c`** b\n', 'jira')).toBe('a `c` b\n');
    expect(render('a **`c`** b\n', 'jira').warnings.map((w) => w.code)).toContain(
      'jira/code-span-emphasis-lost'
    );
  });

  test('and it does NOT fire for a code span carrying only a link, which ADF allows', () => {
    // Probed 201 alongside the four refusals.
    for (const body of ['[`x`](https://e.test)\n', 'plain `code` here\n', '**just words**\n']) {
      expect(render(body, 'jira').warnings.map((w) => w.code)).not.toContain(
        'jira/code-span-emphasis-lost'
      );
      expect(sent(body, 'jira')).toBe(body);
    }
  });

  test('the count is the number of spans, not the number of marks', () => {
    const one = render('a **`x` b** c\n', 'jira').warnings.find(
      (w) => w.code === 'jira/code-span-emphasis-lost'
    )!;
    expect(one.message).toContain('a code span');
    const two = render('**`x` a** and *`y` b*\n', 'jira').warnings.find(
      (w) => w.code === 'jira/code-span-emphasis-lost'
    )!;
    expect(two.message).toContain('2 code spans');
  });
});
