/**
 * A character at the start of a line is sent as the character, not as structure.
 *
 * Every approval sends `markdownFor(doc)`. A writer that does not escape a block marker sends the
 * agent's `\# of tickets merged: 3` as a heading, and an all-or-nothing inline repair then drops
 * every other escape in the message: literal `**URGENT**` goes out bold.
 *
 * Asserted on the body sent (the marker escaped, the inline repair decided per block) and on the
 * load warning (`body/text-changed`), through both readers: this converter (Jira, the preview) and
 * micromark + GFM (the markdown destinations), since a marker only one takes (`1)`, a setext
 * underline) is invisible to the other.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { baselineFor, editorOptionsFor, fromEditorDoc, toEditorDoc } from '../src/editor';
import { profiles, type DestinationName } from '../src/profiles';
import type { AdfDocument, AdfNode } from '../src/adf/types';
import type { PmNode } from '../src/prosemirror';
import { WARNING_CODES } from '../src/warnings';
import { shippedBodies } from './golden';
import { compare } from './spec/normalise';

const DESTINATIONS = Object.keys(profiles) as DestinationName[];

/** What the window sends for `body` at `destination`, untouched: the load's round trip. */
const sent = (body: string, destination: DestinationName): string => baselineFor(render(body, destination)).body;

/** The load's verdict, as the window asks it: the body shown, with the document on screen. */
const loadCodes = (body: string, destination: DestinationName): string[] => {
  const { doc, body: shown } = baselineFor(render(body, destination));
  return render(shown, destination, doc, false).warnings.map((w) => w.code);
};

/** Every character a reader sees, whitespace collapsed -- `lostText`'s comparison, spelled apart. */
const textOf = (node: PmNode): string =>
  (function walk(n: PmNode): string {
    const own = n.text ?? (n.type === 'hardBreak' ? ' ' : '');
    return own + (n.content ?? []).map(walk).join('') + (n.content ? ' ' : '');
  })(node)
    .replace(/\s+/g, ' ')
    .trim();

describe('a line-start marker the editor shows as text is SENT as text', () => {
  // Each line-start marker, with what it would become unescaped. Each body is what the agent
  // wrote; each sent body is the agent's own escape surviving.
  const cases: [string, string][] = [
    ['\\# of tickets merged: 3\n', 'a heading'],
    ['\\## Summary\n', 'a heading'],
    ['2020\\. was a year\n', 'an ordered list'],
    ['1\\) first, then\n', 'an ordered list, to CommonMark alone'],
    ['\\> not a quote\n', 'a quote'],
    ['\\- 50 EUR fee\n', 'a bullet, the minus gone'],
    ['\\+ 50 EUR fee\n', 'a bullet'],
    ['\\+++ x\n', 'a Jira expand'],
    ['\\---\n', 'a rule'],
    ['\\___\n', 'a rule'],
    ['above\n\\---\n', 'a rule, or a setext heading of `above`'],
    ['above\n\\===\n', 'a setext heading, to CommonMark alone'],
    ['above\n\\# not a heading\n', 'a heading interrupting the paragraph'],
    ['above\n\\- not an item\n', 'a list interrupting the paragraph'],
    ['\\| not a table\n', 'a table row'],
    // Each is a construct GFM reads and this converter does not.
    ['\\`\\`\\` not a fence\n\nafter\n', 'a fence swallowing the rest of the message'],
    ['\\~\\~\\~ a b\n\nafter\n', 'a tilde fence, likewise'],
    ['a | b\n\\--- | ---\n', 'a table, `a | b` its header'],
    ['\\[foo]: /docs\n\nsee [foo]\n', 'a link reference definition, deleted from the message'],
  ];
  for (const [body, would] of cases) {
    test(`${JSON.stringify(body)} -- not ${would}`, () => {
      for (const destination of DESTINATIONS) {
        expect(sent(body, destination), destination).toBe(body);
        expect(loadCodes(body, destination), destination).not.toContain('body/text-changed');
      }
    });
  }

  test("a heading's trailing `#` run is escaped, or every markdown reader drops it as a closing sequence", () => {
    for (const destination of DESTINATIONS) expect(sent('## Fix for C \\#\n', destination)).toBe('## Fix for C \\#\n');
  });

  test("a checklist item's second line is not a setext underline", () => {
    // The continuation lines are escaped too, so the second line opens nothing.
    for (const destination of DESTINATIONS) expect(sent('- [ ] Title\n  \\===\n', destination)).toBe('- [ ] Title\n  \\===\n');
  });

  test("a paragraph's leading whitespace is not sent, since four columns of it are a code block", () => {
    for (const destination of DESTINATIONS) {
      expect(sent('a\n\n    note: foo\n', destination)).toBe('a\n\nnote: foo\n');
      expect(sent('\t\\# x\n', destination)).toBe('\\# x\n');
    }
  });

  test('a bullet whose text starts `[ ]` is not sent as a checkbox', () => {
    for (const destination of DESTINATIONS) {
      expect(sent('- \\[ ] not a task\n', destination)).toBe('- \\[ ] not a task\n');
      expect(sent('- \\[x] not a task\n', destination)).toBe('- \\[x] not a task\n');
    }
  });

  test('...while a LINK first in an item is left alone, since a backslash would unlink it', () => {
    // `[x](` is `writeLink`'s. This converter reads `- [x](url)` as a checked task (GFM wants a space
    // after `]`); escaping it would lose the link for every reader.
    for (const destination of DESTINATIONS) expect(sent('- [y](https://e.test) z\n', destination)).toBe('- [y](https://e.test) z\n');
  });

  test("a checklist item's SECOND line is a paragraph line, and escaped like one", () => {
    const body = '- [ ] one\n  \\# two\n';
    for (const destination of DESTINATIONS) expect(sent(body, destination)).toBe(body);
  });
});

describe('the inline repair is decided per BLOCK, not for the whole message', () => {
  test('the escaped `**URGENT**` is not sent bold because another line holds a marker', () => {
    const body = 'The customer typed \\*\\*URGENT\\*\\* in the subject.\n\n\\# of tickets merged: 3\n';
    for (const destination of DESTINATIONS) expect(sent(body, destination)).toBe(body);
    // And what Jira receives: two paragraphs, no heading, no strong mark.
    const adf = render(sent(body, 'jira'), 'jira').converted as AdfDocument;
    expect(adf.content.map((n) => n.type)).toEqual(['paragraph', 'paragraph']);
    const marks = (n: AdfNode): string[] => [...(n.marks ?? []).map((m) => m.type), ...(n.content ?? []).flatMap(marks)];
    expect(adf.content.flatMap(marks)).toEqual([]);
  });

  test('a code span and a link the agent escaped survive beside a block the repair cannot help', () => {
    // The bare URL inside the literal brackets is linked, as any bare URL is: `[click](` stays text.
    const body = '\\# x\n\nrun \\`rm -rf /\\` never\n\nwrite \\[click](https://evil.test)\n';
    const out = '\\# x\n\nrun \\`rm -rf /\\` never\n\nwrite \\[click]([https://evil.test](https://evil.test))\n';
    for (const destination of DESTINATIONS) expect(sent(body, destination)).toBe(out);
  });
  test('one block the repair cannot fix leaves the others repaired', () => {
    // Pins: judged per document, one unrepairable block (a link text holding a `]`, written bare)
    // fails the repair and the literal `**URGENT**` beside it goes out bold. The link is
    // `body/text-changed`'s to report.
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'see ]x', marks: [{ type: 'link', attrs: { href: 'https://e.test' } }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'typed **URGENT** here' }] },
      ],
    } as unknown as PmNode;
    expect(fromEditorDoc(doc)).toBe('[see ]x](https://e.test)\n\ntyped \\*\\*URGENT\\*\\* here');
  });

  test('...and inside a LIST, where a verdict per top-level block would lose them', () => {
    // A verdict per top-level block would leave this list unrepaired: it is per textblock.
    const item = (content: unknown[]) => ({ type: 'listItem', content: [{ type: 'paragraph', content }] });
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            item([{ type: 'text', text: 'see ]x', marks: [{ type: 'link', attrs: { href: 'https://e.test' } }] }]),
            item([{ type: 'text', text: 'typed **URGENT** here' }]),
          ],
        },
      ],
    } as unknown as PmNode;
    expect(fromEditorDoc(doc)).toBe('- [see ]x](https://e.test)\n- typed \\*\\*URGENT\\*\\* here');
  });
});

/**
 * A `!` directly before a link is sent as text, not as an image marker.
 *
 * Unescaped, text ending in `!` beside a link goes out as an image of the link's URL. Probed: Linear
 * stores it verbatim and renders a broken image. Cases: an exclamation, a bolded link after it (the
 * writer hoists the bold inside), a bare URL.
 */
describe('a `!` before a link is sent as the character', () => {
  // Every registered code about an image, derived, so a new one is covered without anyone adding it.
  const IMAGE_CODES: string[] = Object.keys(WARNING_CODES).filter((code) => code.includes('image'));
  // The third entry is what a destination that keeps an angle link as written (`angleLinkLabels`)
  // sends: `!<` is no image marker, so nothing needs escaping there.
  const cases: [string, string, string?][] = [
    ['Yes\\![docs](https://e.test/d)\n', 'Yes\\![docs](https://e.test/d)\n'],
    ['Wow!**[docs](https://e.test/d)**\n', 'Wow\\![**docs**](https://e.test/d)\n'],
    [
      'Shipped!<https://e.test/release>\n',
      'Shipped\\![https://e.test/release](https://e.test/release)\n',
      'Shipped!<https://e.test/release>\n',
    ],
    // Inside a mark the link shares with the text before it: the join between a stretch's nodes.
    ['**Wow\\![docs](https://e.test/d) more**\n', '**Wow\\![docs](https://e.test/d) more**\n'],
  ];
  for (const [body, written, angle] of cases) {
    test(JSON.stringify(body), () => {
      for (const destination of DESTINATIONS) {
        const out = profiles[destination].angleLinkLabels ? (angle ?? written) : written;
        expect(sent(body, destination), destination).toBe(out);
        // And the escape is not doubled on the next pass.
        expect(sent(out, destination), destination).toBe(out);
        // No image warning at load: the sent body holds a link.
        expect(loadCodes(body, destination).filter((c) => IMAGE_CODES.includes(c)), destination).toEqual([]);
      }
      // What Jira receives: the `!` as text and a link, no media.
      const adf = JSON.stringify(render(sent(body, 'jira'), 'jira').converted);
      expect(adf).not.toContain('media');
      expect(adf).toContain('"type":"link"');
    });
  }

  test('the controls: a space, a bang ending the text, and a real image are left alone', () => {
    for (const destination of DESTINATIONS) {
      expect(sent('Wow! [docs](https://e.test/d)\n', destination)).toBe('Wow! [docs](https://e.test/d)\n');
      expect(sent('a!\n', destination)).toBe('a!\n');
    }
    // Only where the image survives as one: Slack writes it as a link and has no `!` to keep.
    for (const destination of DESTINATIONS.filter((d) => profiles[d].rendersMedia)) {
      const out = sent('see ![i](https://e.test/i.png) now\n', destination); // Jira moves it to its own block
      expect(out).toContain('![i](https://e.test/i.png)');
      expect(out).not.toContain('\\!');
    }
  });
});

describe('ordinary prose gains NO backslashes', () => {
  // Only a line that would open a block is escaped, not every `#`, `-`, `>` and digit.
  for (const body of [
    'C# and F# are both fine\n',
    '#hashtag at the start\n',
    'a - b - c\n',
    '-5 degrees\n',
    '1.5 hours, or 2020.10\n',
    'costs 5 > 3\n',
    '++ is an operator\n',
    '+1 from me\n',
    'about ~5 min\n',
    '== not a setext line alone\n',
    '- a real list\n- of two\n',
    '# A real heading\n\nand text\n',
  ]) {
    test(JSON.stringify(body), () => {
      for (const destination of DESTINATIONS) expect(sent(body, destination), destination).toBe(body);
    });
  }
});

/**
 * The property, over a seeded corpus of escaped markers mixed with inline escapes and real marks:
 * the text on screen is the text sent, as this converter reads it back, and micromark + GFM read the
 * sent body the way this converter does. A wider exploratory sweep (3,000 bodies, list prefixes too)
 * measured 1,722 text losses per destination against a writer that escapes no block marker, and 954
 * bodies GFM read differently; with the escapes, 0 and 1 -- two lists a blank line apart, which the
 * readers merge differently, a reader matter left out of this vocabulary. So is a single `~`, the
 * one inline construct only GFM reads.
 */
describe('escaped block markers, through both readers', () => {
  const ESCAPED = ['\\# ', '\\## ', '\\- ', '\\+ ', '\\* ', '2020\\. ', '1\\) ', '\\> ', '\\+++ ', '\\| ', '  \\# ', '\\[ ] '];
  const WHOLE = ['\\---', '\\***', '\\===', '\\--', '\\- - -', '\\___'];
  // Two `!`-before-a-link shapes, and a real image as their control.
  const INLINE = [
    '\\*\\*x\\*\\*', '\\`y\\`', '\\[l](https://e.test)', '**b**', '`c`', 'word', 'the', 'fix', 'it.',
    'Yes\\![d](https://e.test/d)', 'Wow!**[d](https://e.test/d)**', '![i](https://e.test/i.png)',
  ];

  function corpus(count: number, seed = 102): string[] {
    let s = seed;
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    return Array.from({ length: count }, () => {
      const lines: string[] = [];
      for (let l = 1 + Math.floor(next() * 4); l > 0; l--) {
        const words = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(INLINE)).join(' ');
        const r = next();
        lines.push((next() < 0.2 ? '> ' : '') + (r < 0.15 ? pick(WHOLE) : (r < 0.6 ? pick(ESCAPED) : '') + words));
        if (next() < 0.3) lines.push('');
      }
      return lines.join('\n') + '\n';
    });
  }

  const bodies = corpus(600);
  for (const destination of DESTINATIONS) {
    test(`${destination}: the text on screen is the text sent`, () => {
      const lost = bodies.filter((body) => {
        const r = render(body, destination);
        const { doc, body: shown } = baselineFor(r);
        return textOf(doc) !== textOf(toEditorDoc(shown, editorOptionsFor(r)));
      });
      expect(lost.map((b) => JSON.stringify(b))).toEqual([]);
    });
  }

  test('and every markdown reader reads the sent body as this converter does', () => {
    const differ = DESTINATIONS.filter((d) => d !== 'jira').flatMap((destination) =>
      bodies.map((body) => sent(body, destination)).filter((shown) => compare(shown).kind === 'differ')
    );
    expect(differ).toEqual([]);
  });
});

describe('the backstop, over every document the repo ships', () => {
  // No shipped fixture may carry the warning at load: one that does is a writer gap or a reader
  // divergence to record.
  for (const [name, body] of shippedBodies()) {
    test(name, () => {
      for (const destination of DESTINATIONS) expect(loadCodes(body, destination), destination).not.toContain('body/text-changed');
    });
  }
});
