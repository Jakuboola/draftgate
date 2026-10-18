/**
 * `_` and `__` read the way CommonMark reads them. Slack, Linear and GitHub store the markdown and
 * draw `_x_` italic, and Jira is drawn from this converter's ADF, so all four agree; an unbackticked
 * `__init__` is a bold "init", as on GitHub.
 *
 * Asserted on the marks the reviewer sees, the body an approval sends (read by the spec checker's
 * micromark) and Jira's ADF. Shapes beyond the ten probed lines rely on micromark + GFM, which
 * agreed with all three readers on every one of those ten.
 */

import { describe, expect, test } from 'bun:test';
import { convertMarkdownToAdf } from '../src/adf/markdownToAdf';
import type { AdfNode } from '../src/adf/types';
import { baselineFor, editorOptionsFor, fromEditorDoc, toEditorDoc } from '../src/editor';
import { pmMarkName, type PmNode } from '../src/prosemirror';
import { profiles, type DestinationName } from '../src/profiles';
import { render } from '../src/render';
import { underscoreFuzzBodies } from './spec/measure';
import { compare } from './spec/normalise';

const DESTINATIONS = Object.keys(profiles) as DestinationName[];

/** What an unedited approval sends: the body the reviewer is shown. */
const sent = (body: string, destination: DestinationName): string => baselineFor(render(body, destination)).body;

/**
 * A paragraph's inline runs as `text` or `text[marks]`, marks sorted: the probe table's shape. In
 * the editor's spelling (`pmMarkName`), so one table serves the ADF and the editor document.
 */
function runs(nodes: readonly { text?: string; marks?: readonly { type: string }[] }[] = []): string[] {
  return nodes.map((n) => {
    const marks = (n.marks ?? []).map((m) => pmMarkName(m.type)).sort();
    return marks.length ? `${n.text}[${marks.join('+')}]` : `${n.text}`;
  });
}

const firstParagraph = (markdown: string): string[] => runs(convertMarkdownToAdf(markdown).content[0]?.content);

/** Every character a reader sees, whitespace removed -- `lostText`'s comparison, spelled apart. */
const textOf = (n: PmNode | AdfNode): string => ((n.text ?? '') + (n.content ?? []).map(textOf).join('')).replace(/\s/g, '');

/**
 * The ten lines sent to every destination: Slack and Linear through gated sends approved unedited,
 * read off screenshots of the rendered message; GitHub through its own renderer, `POST /markdown`,
 * in both modes. All three drew exactly this, which is CommonMark's reading.
 */
const PROBED: readonly (readonly [string, readonly string[]])[] = [
  ['_single_ underscores', ['single[italic]', ' underscores']],
  ['__double__ underscores', ['double[bold]', ' underscores']],
  ['snake_case_name stays text', ['snake_case_name stays text']],
  ['call __init__ first', ['call ', 'init[bold]', ' first']],
  ['foo_bar_ and _baz_qux', ['foo_bar_ and _baz_qux']],
  ['___triple___', ['triple[bold+italic]']],
  ['*star* for comparison', ['star[italic]', ' for comparison']],
  ['(_paren_) and "_quoted_"', ['(', 'paren[italic]', ') and "', 'quoted[italic]', '"']],
  ['_multi word span_ here', ['multi word span[italic]', ' here']],
  ['un_der_score inside, and _trailing_.', ['un_der_score inside, and ', 'trailing[italic]', '.']],
];

describe('the ten probed lines read as Slack, Linear and GitHub drew them', () => {
  test.each(PROBED)('%s', (line, expected) => {
    expect(firstParagraph(`${line}\n`)).toEqual([...expected]);
  });

  const body = PROBED.map(([line]) => line).join('\n\n') + '\n';

  test.each(DESTINATIONS)('%s: shown with those marks, and sent so CommonMark reads the same', (destination) => {
    const { doc, body: shown } = baselineFor(render(body, destination));
    expect(doc.content!.map((p) => runs(p.content))).toEqual(PROBED.map(([, expected]) => [...expected]));
    expect(compare(shown).kind).toBe('agree');
  });

  test("Jira's payload carries the marks, and keeps the underscores that are text", () => {
    const adf = render(sent(body, 'jira'), 'jira').converted as { content: AdfNode[] };
    expect(adf.content.map((p) => runs(p.content))).toEqual(PROBED.map(([, expected]) => [...expected]));
  });
});

describe('agrees with CommonMark beyond the ten', () => {
  // micromark + GFM's reading, which is the spec checker's; none of these was sent anywhere.
  const SHAPES = [
    // Nesting and mixing with `*`. A closer pairs only with its own character, and an opener of the
    // other character between the two is content: `*a _b* c_` is an italic `a _b` and a stray `_`.
    '_a __b__ c_', '__a _b_ c__', '_a *b* c_', '*a _b_ c*', '**a _b_ c**', '__a *b* c__',
    '*a _b* c_', '_a *b_ c*', '_a **b_ c**', '~~_struck italic_~~', '_~~italic struck~~_', '___a___ and ___b___',
    // Flanking. Inside a word an underscore neither opens nor closes; beside punctuation it can.
    '_"quoted"_', '"_x_"', '_x_,', 'a._b_', '5_000_000', 'x_1_y', '_x_y', 'x_y_', '__x__y', 'x__y__',
    '_ x _', '_ x_', '_x _', '__ x __', 'my_var_ and _other_', 'ends with _italic_.',
    // The rule of 3 and the whole run, as the asterisk scan reads them.
    '_a__b_', '__a_b__', '_b__.b_', '__a___', '_a___',
    // Escapes and code spans.
    '\\_x\\_', '_x\\_', '\\__x__', '_x\\__', '`_x_` and _y_', '_a `_` b_', '_a `b_` c_',
    // A link, an autolink and a bare URL bind tighter than emphasis, and an underscore is ordinary
    // in a URL. Without `wholeSpans` each of these breaks the link, the star ones included. Spec
    // examples 474-477 and 481 hold the same shapes under the ratchet.
    '_see https://e.test/a_.b now_', '*foo [bar*](/url)', '*a<https://foo.bar/?q=*>',
    '_see [docs](https://e.test/my_page_.html) now_', '_a [b](https://e.test/c_) d',
    '![x_](https://e.test/a_.png) _y_', '_x ![a_](https://e.test/p_.png) y_', '_https://e.test/a_b_',
    'see https://e.test/__init__.py now', 'see https://e.test/a_b_ now', '[_a_](https://e.test)',
    // Autolinks of any scheme, Slack's `<url|label>` among them, and inline HTML: text to this
    // converter, one unit to every reader, so a delimiter inside neither closes nor opens.
    '_see <https://e.test/a_|docs> now_', '<https://e.test/_a|b> c_',
    '_x <img src="a_.png"> y_', '<a href="_x"> y_', '_x </a_> y_',
    // Block containers read their inline content the same way.
    '# _heading_ __bold__', '- _item_ and __more__', '> _quoted_ text', '| _a_ | __b__ |\n| - | - |\n| _c_ | d |',
  ];

  test.each(SHAPES)('%s', (shape) => {
    expect(compare(`${shape}\n`)).toEqual({ kind: 'agree' });
  });
});

describe('a span a reader LINKS and this converter does not is one unit too', () => {
  // micromark links these and this converter does not (rows in the baseline's Autolinks section).
  // No emphasis may pair across or inside one, or the writer puts a star into the address.
  test.each([
    ['_see www.e.test/my_page_.html now_\n', ['see www.e.test/my_page_.html now[italic]'], 'www.e.test/my_page_.html'],
    ['see www.e.test/_a b_\n', ['see www.e.test/_a b_'], 'www.e.test/_a'],
    ['_contact john_@x.com today_\n', ['contact john_@x.com today[italic]'], 'john_@x.com'],
    ['_mail me@x.com_\n', ['mail me@x.com[italic]'], 'me@x.com'],
    ['_x_@y.com\n', ['_x_@y.com'], '_x_@y.com'],
    ['_x <ftp://e.test/a_.b> y_\n', ['x <ftp://e.test/a_.b> y[italic]'], '<ftp://e.test/a_.b>'],
    ['_x <a_.b@e.test> y_\n', ['x <a_.b@e.test> y[italic]'], '<a_.b@e.test>'],
  ])('%j', (body, expected, address) => {
    expect(firstParagraph(body)).toEqual(expected);
    for (const destination of DESTINATIONS) {
      const shown = sent(body, destination);
      expect(firstParagraph(shown)).toEqual(expected);
      expect(shown.replace(/\\(?=_)/g, '')).toContain(address);
    }
  });
});

describe('where the spec splits a run this converter cannot, every underscore is KEPT', () => {
  // The `***` limit, in underscores: scan-per-opener never splits one run across two closers or
  // reads a run past three, and CommonMark does both. These are spec examples
  // 408, 426, 454, 456, 457, 465, 468, in the Emphasis row of `core/test/spec/baseline.ts`. The
  // asymmetry holds: a delimiter is kept, never eaten.
  const KEPT = ['__foo_ bar_', '____foo__ bar__', '__foo_', '___foo__', '____foo_', '____foo____', '_____foo_____'];

  test.each(KEPT)('%s', (shape) => {
    expect(compare(`${shape}\n`).kind).toBe('differ');
    const text = convertMarkdownToAdf(`${shape}\n`).content[0]!.content!.map((n) => n.text ?? '').join('');
    expect(text).toBe(shape);
  });
});

describe('a literal underscore is sent as text', () => {
  const para = (text: string): PmNode => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

  // A reviewer's literal `_x_`: written bare it reads back italic.
  test.each(['_x_ literal', '__init__', 'snake_case and _x_', 'a _b_ c and *d*', '___t___', 'Set _foo to 1'])(
    '%s',
    (text) => {
      const written = fromEditorDoc(para(text));
      expect(runs(toEditorDoc(written).content![0]!.content)).toEqual([text]);
      expect(compare(`${written}\n`)).toEqual({ kind: 'agree' });
    }
  );

  test('an underscore that needs no escape goes out as written', () => {
    for (const destination of DESTINATIONS) {
      expect(sent('snake_case_name, foo_bar_ and 5_000_000\n', destination)).toBe('snake_case_name, foo_bar_ and 5_000_000\n');
    }
  });

  test("an agent's escaped underscores keep their escapes", () => {
    for (const destination of DESTINATIONS) {
      expect(sent('a \\_b\\_ c\n', destination)).toBe('a \\_b\\_ c\n');
    }
  });

  // This converter reads a paragraph a line at a time and every markdown reader pairs across the
  // break, so the writer's re-read joins the lines too. The star and the backtick need the same.
  test.each([
    ['Set \\_foo to 1\nand type_ to 2\n', 'Set \\_foo to 1\nand type\\_ to 2\n'],
    ['Set \\*foo to 1\nand bar* to 2\n', 'Set \\*foo to 1\nand bar\\* to 2\n'],
  ])('a pair across a line break is escaped: %j', (body, expected) => {
    for (const destination of DESTINATIONS) {
      const shown = sent(body, destination);
      expect(shown).toBe(expected);
      expect(compare(shown)).toEqual({ kind: 'agree' });
    }
  });
});

describe('the writer keeps star runs from touching', () => {
  // `***init**.py*` is a run of three against a run of one, which this converter cannot split, so it
  // would read back as asterisks -- `body/text-changed` on a draft nobody touched, and literal
  // stars in Jira's payload. Underscores keep the runs apart; marks on one node keep `***x***`.
  test.each([
    ['fix *__init__.py* x\n', 'fix _**init**.py_ x\n'],
    ['_**Note:** this matters_\n', '_**Note:** this matters_\n'],
    ['**_Note:_ this matters**\n', '__*Note:* this matters__\n'],
    ['*a **b***\n', '_a **b**_\n'],
    ['_fix **__init__.py** now_\n', '*fix **init.py** now*\n'],
    ['***both***\n', '***both***\n'],
    ['*a **b** c*\n', '*a **b** c*\n'],
  ])('%j', (body, expected) => {
    for (const destination of DESTINATIONS) {
      const { doc, body: shown } = baselineFor(render(body, destination));
      expect(shown).toBe(expected);
      expect(render(shown, destination, doc, false).warnings.map((w) => w.code)).toEqual([]);
      if (destination !== 'jira') expect(compare(shown)).toEqual({ kind: 'agree' });
    }
  });
});

test('beside a letter the stars stay, because underscores there would pair with nothing', () => {
  // A reviewer's italic over part of a word. `pre_**init**.py_post` is literal underscores to every
  // reader; `pre***init**.py*post` is the italic to GitHub, though not to this converter.
  const doc: PmNode = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'pre' },
          { type: 'text', text: 'init', marks: [{ type: 'italic' }, { type: 'bold' }] },
          { type: 'text', text: '.py', marks: [{ type: 'italic' }] },
          { type: 'text', text: 'post' },
        ],
      },
    ],
  };
  expect(fromEditorDoc(doc)).toBe('pre***init**.py*post');
});

// A reviewer's literal `*x*` beside a span a reader keeps verbatim. Escaping inside the span -- a
// backslash in a URL is a different URL -- breaks the block's read-back, so the repair falls back
// to plain and the stars go out italic. Only what is outside a span is escaped.
test.each([
  'see https://e.test/my_page_.html and *x*',
  'see <https://e.test/my_page_|docs> and *x*',
  'mail a_b_@x.com and *x*',
  'see www.e.test/a_.b and *x*',
  '<img src="a_.png"> and *x*',
])('a literal star beside a verbatim span is escaped, and the span is not: %s', (text) => {
  const written = fromEditorDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  expect(written).toBe(text.replace('*x*', '\\*x\\*'));
  expect(textOf(toEditorDoc(written))).toBe(textOf({ type: 'doc', content: [{ type: 'text', text }] }));
});

test("a literal underscore inside an emphasis the writer spelled with underscores is escaped", () => {
  // The writer's own `_` (stars would touch) gives a literal `x_` something to close: written bare,
  // `_**init**.py x_ y_` ends the italic at `x`. The cheap gate must send that block to the read-back,
  // which an underscore after a letter only does through the gate's second half.
  const doc: PmNode = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'init', marks: [{ type: 'italic' }, { type: 'bold' }] },
          { type: 'text', text: '.py x_ y', marks: [{ type: 'italic' }] },
        ],
      },
    ],
  };
  const written = fromEditorDoc(doc);
  expect(written).toBe('_**init**.py x\\_ y_');
  expect(runs(toEditorDoc(written).content![0]!.content)).toEqual(['init[bold+italic]', '.py x_ y[italic]']);
});

describe('over the underscore fuzz family', () => {
  // The very bodies `UNDERSCORE_FUZZ_BASELINE` was measured on.
  const bodies = underscoreFuzzBodies();

  test.each(DESTINATIONS)('%s: the text on screen is the text sent, and the load warns of no loss', (destination) => {
    const problems = bodies.flatMap((body) => {
      const r = render(body, destination);
      const { doc, body: shown } = baselineFor(r);
      const lost = render(shown, destination, doc, false).warnings.filter((w) => /lost|changed/.test(w.code));
      const back = toEditorDoc(shown, editorOptionsFor(r));
      return textOf(doc) === textOf(back) && lost.length === 0 ? [] : [JSON.stringify(body)];
    });
    expect(problems).toEqual([]);
  });

  // Where the agent's own body reads the spec's way, the body sent must too. Where it does not, the
  // difference is one already in `UNDERSCORE_FUZZ_BASELINE`, carried through unchanged.
  test('a body CommonMark reads as the converter does is sent so it still does', () => {
    const parted = DESTINATIONS.filter((d) => d !== 'jira').flatMap((destination) =>
      bodies
        .filter((body) => compare(body).kind === 'agree')
        .map((body) => sent(body, destination))
        .filter((shown) => compare(shown).kind === 'differ')
    );
    expect(parted).toEqual([]);
  });
});
