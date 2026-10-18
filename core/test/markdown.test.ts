/**
 * The link scanners, and why they are hand-written walks rather than regexes.
 *
 * `/!?\[[^\]]*\]\(…\)/` is quadratic in unclosed `[`: each `[` lets `[^\]]*` run to the end, then
 * backtracks looking for a `]` that is not there. Measured on 100 KB of `[` with that regex:
 *
 *     render(body, 'linear')   1.7 s      -- `unsafeHrefs` alone
 *     render(body, 'slack')    3.4 s      -- plus `maskLinks`, run twice per segment
 *     render(body, 'jira')     6.5 s
 *
 * a clean quadratic (10/25/50/100 KB -> 81/413/1626/6531 ms), while the same 100 KB of ordinary
 * prose cost 1.8 ms and 97 KB of link-heavy prose 52 ms. The window re-renders per keystroke.
 *
 * Guarded here: that the scanner is fast, and that it finds exactly what the regex finds.
 */

import { describe, expect, test } from 'bun:test';
import {
  markdownLinkSpans, markdownImages, replaceLinkSpans, linkLabelStart, maskCode,
} from '../src/markdown';
import { convertMarkdownToAdf } from '../src/adf/index';
import { walk } from '../src/adfSchema';
import type { AdfDocument } from '../src/adf/types';
import { render } from '../src/render';
import { baselineFor, editorDocFor } from '../src/editor';
import { profiles } from '../src/index';
import type { DestinationName } from '../src/index';

/**
 * The pattern `markdownLinkSpans` replaces, kept as the oracle it must agree with. It reads only
 * the plain destination form; the angle-bracket form has its own block below.
 */
const OLD_MD_LINK_OR_IMAGE_RE = /!?\[[^\]]*\]\([^)\s]+\)/g;
/** Ditto for `markdownImages`. */
const OLD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

describe('markdownLinkSpans finds exactly what the oracle regex finds', () => {
  const corpus = [
    '',
    'no links here at all',
    '[a](https://x)',
    '![a](https://x)',
    'before [a](https://x) after',
    'two [a](https://x) and ![b](https://y) here',
    // The label may hold anything but `]`, so the regex starts at the first `[` of the window.
    '[a[b](https://x)',
    '[[[[a](https://x)',
    'a]](https://x)',
    '[a]](https://x)',
    '[](https://x)',
    // No destination, a space in the destination, an unclosed paren: all non-matches.
    '[a]()',
    '[a](https://x y)',
    '[a](https://x',
    '[a] (https://x)',
    // Adjacent and back-to-back.
    '[a](https://x)[b](https://y)',
    '![a](https://x)![b](https://y)',
    // Nothing but brackets: the shape that is quadratic for the regex.
    '['.repeat(64),
    '['.repeat(64) + '](https://x)',
    ']'.repeat(64),
    // Newlines, because the slack profile relies on offsets and line structure surviving.
    'line one [a](https://x)\nline two ![b](https://y)\n',
    'trailing bracket [\n[a](https://x)\n',
  ];

  test('the same substrings, in the same order', () => {
    for (const text of corpus) {
      OLD_MD_LINK_OR_IMAGE_RE.lastIndex = 0;
      const expected = [...text.matchAll(OLD_MD_LINK_OR_IMAGE_RE)].map((m) => [
        m.index!,
        m.index! + m[0].length,
      ]);
      expect(markdownLinkSpans(text), JSON.stringify(text)).toEqual(expected as [number, number][]);
    }
  });

  test('and replacing them produces byte-identical output to the oracle\'s .replace()', () => {
    // Both of the slack profile's uses: masking (length preserved, for its end-of-line scan) and
    // deletion.
    for (const text of corpus) {
      for (const f of [(m: string) => '·'.repeat(m.length), () => '']) {
        OLD_MD_LINK_OR_IMAGE_RE.lastIndex = 0;
        expect(replaceLinkSpans(text, f), JSON.stringify(text)).toBe(
          text.replace(OLD_MD_LINK_OR_IMAGE_RE, f as (m: string) => string)
        );
      }
    }
  });

  test('masking keeps the length, so offsets after a link do not move', () => {
    for (const text of corpus) {
      expect(replaceLinkSpans(text, (m) => '·'.repeat(m.length)).length, JSON.stringify(text)).toBe(
        text.length
      );
    }
  });

  test('the corpus really does contain links, so agreement is not vacuous', () => {
    const total = corpus.reduce((n, t) => n + markdownLinkSpans(t).length, 0);
    expect(total).toBeGreaterThanOrEqual(12);
  });

  test('linkLabelStart takes the LEFTMOST [ in the window, and stops at a ]', () => {
    expect(linkLabelStart('[a[b]', 4)).toBe(0);
    expect(linkLabelStart('x]y[b]', 5)).toBe(3);
    expect(linkLabelStart('no bracket]', 10)).toBe(-1);
  });
});

describe('markdownImages finds exactly what the oracle IMAGE_RE finds', () => {
  const corpus = [
    '',
    '![a](https://x)',
    '[a](https://x)',
    'text ![a](https://x) more ![b](https://y) end',
    '![](https://x)',
    '![a[b](https://x)',
    '![a](https://x y)',
    '![a](https://x',
    '!['.repeat(32),
    '['.repeat(32),
    '![a](https://x)![b](https://y)',
    'line\n![a](https://x)\nline',
    './rel.png and ![r](./rel.png)',
  ];

  test('the same alts and urls, in the same order', () => {
    for (const text of corpus) {
      OLD_IMAGE_RE.lastIndex = 0;
      const expected = [...text.matchAll(OLD_IMAGE_RE)].map((m) => ({
        alt: m[1] ?? '',
        url: m[2]!,
      }));
      expect(markdownImages(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  test('the corpus really does contain images, so agreement is not vacuous', () => {
    expect(corpus.reduce((n, t) => n + markdownImages(t).length, 0)).toBeGreaterThanOrEqual(7);
  });
});

describe('render() is not quadratic in unclosed [', () => {
  // 200 KB. A quadratic scan costs ~6.8 s here for linear and ~13.6 s for slack; the linear one is
  // well under a millisecond. The budget sits an order of magnitude below the first and three above
  // the second.
  const BUDGET_MS = 500;
  const body = '['.repeat(200 * 1024);

  /*
   * Both pathological openers: a `[`-only body never reaches the image scan (`!\[` fails at the
   * first character). `![` does, and a regex image scan is quadratic there: 29/152/598/2403 ms at
   * 10/25/50/100 KB.
   */
  const bodies: [string, string][] = [
    ['"["', body],
    ['"!["', '!['.repeat(100 * 1024)],
    ['"](" with no label', ']('.repeat(100 * 1024)],
  ];

  for (const destination of ['slack', 'linear'] as const) {
    for (const [label, text] of bodies) {
      test(`${destination}: 200 KB of ${label} renders in under ${BUDGET_MS} ms`, () => {
        const started = performance.now();
        render(text, destination);
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      });
    }
  }

  test('a draft with NO image is not quadratic either -- the gate is loop-invariant', () => {
    // Jira's degraded-image check reads the whole body (`markdownImages(maskCode(markdown))` in
    // `profiles/jira.ts`), so it runs once, above the walk. Inside the walk, a draft with no image
    // costs 22.8 / 42.4 / 142.7 / 543.5 ms at 2k/4k/8k/16k paragraphs; above it 7.8 / 6.5 / 14.2 /
    // 22.5 ms. A ratio: quadratic is ~4x for 2x the input, linear ~2x.
    const paragraph = 'Some ordinary paragraph of prose here.\n\n';
    const time = (n: number) => {
      const body = paragraph.repeat(n);
      const started = performance.now();
      render(body, 'jira');
      return performance.now() - started;
    };
    time(2_000); // warm
    const small = Math.max(time(4_000), 1);
    const large = time(8_000);
    expect(large / small).toBeLessThan(3);
  });

  test('the jira placeholder scan is linear too, even with the image gate satisfied', () => {
    // A draft full of `[Image: ` (the converter's text for an image it cannot embed) with one real
    // image. Grepping the converted text with `\[Image: [^\]]*\]` is quadratic: 22/90/352 ms at
    // 32/64/128 KB, ~40% on top of the Jira render. `jira/image-degraded-to-text` diffs source
    // images against converted media instead (`profiles/jira.ts`). Timed against the same payload
    // with no real image, so this is the check's own cost.
    const payload = '[Image: '.repeat(16_000);
    const withScan = () => {
      const s = performance.now();
      render(`![](./a.png) ${payload}`, 'jira');
      return performance.now() - s;
    };
    const withoutScan = () => {
      const s = performance.now();
      render(payload, 'jira');
      return performance.now() - s;
    };
    // The placeholder regex costs +40%.
    expect(withScan()).toBeLessThan(withoutScan() * 1.25 + 100);
  });

  /*
   * `markdownLinkSpans` scanning from every `](` to the first `)` or whitespace runs to the end of
   * the string on input holding neither: 6k openers 178 ms, 12k 703 ms, 25k 3043 ms, 50k 12169 ms.
   * A tail searched from a later `](` is a suffix of this one, so a scan that reaches the end stops.
   */
  test.each(['jira', 'slack', 'linear'] as const)(
    '%s: a link opener repeated 100k times is linear in markdownLinkSpans too',
    (destination) => {
      const started = performance.now();
      render('[a]('.repeat(100 * 1024), destination);
      // Quadratic here would be minutes at this size; it is single-digit milliseconds.
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  );

  test('and the scanner still finds what it should', () => {
    // The early return must not swallow a real link. A destination terminated by a SPACE fails
    // only its own candidate -- a later one can still match, and does.
    expect(markdownLinkSpans('see [a](http://x) and ![b](http://y) ok')).toHaveLength(2);
    expect(markdownLinkSpans('[a](has space) then [b](http://y)')).toEqual([[20, 33]]);
  });

  test('a destination may hold one level of balanced parentheses and escapes, as the converter reads it', () => {
    const md = 'see [a](https://w/Foo_(bar)) and ![i](https://w/a_(b).png) end';
    expect(markdownLinkSpans(md)).toEqual([[4, 28], [33, 58]]);
    // Deeper or unclosed is not a destination at all -- which is also what GitHub makes of it.
    expect(markdownLinkSpans('[a](x((b)))')).toEqual([]);
    expect(markdownLinkSpans('[a](x(b)')).toEqual([]);
    // A backslash escape is part of the destination, so `\)` does not close it.
    expect(markdownLinkSpans('[w](Foo_\\(bar\\)) x')).toEqual([[0, 16]]);
    // ...and an image span splits back into the whole URL, for every scan that reads images.
    expect(markdownImages('![i](https://w/a_(b).png)')).toEqual([{ alt: 'i', url: 'https://w/a_(b).png' }]);
  });

  // The converter's bracket patterns, guarded by `bracketCursor` (`markdownToAdf.ts`, which holds the
  // unguarded timings). A quadratic detector: at 400 KB unguarded needs ~77 s, guarded 0.12 s.
  test('jira is linear on brackets too -- 400 KB of `[` cannot take 77 seconds', () => {
    const started = performance.now();
    render('['.repeat(400 * 1024), 'jira');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(5_000);
  });

  /*
   * Shapes that pass the `](` half of the guard and need the paren cursor. Without it `[`*100k +
   * `](` takes 4.94 s and `[a](` repeated 25k times 1.41 s.
   */
  test.each([
    ['a bracket that closes into an unclosed paren', '['.repeat(100 * 1024) + ']('],
    ['a link opener repeated with no closing paren', '[a]('.repeat(25 * 1024)],
    ['and one closing paren at the very end', '[a]('.repeat(25 * 1024) + ')'],
    // A scan to the first `)` is quadratic here, before a SPACE.
    ['a link opener repeated before a space', '[a]('.repeat(25 * 1024) + ' '],
    ['the same with a closing paren after the space', '[a]('.repeat(25 * 1024) + ' )'],
    // Every `[` tried against one failing destination: decided once per `]`, not once per `[`.
    ['a bracket run before a destination that fails', '['.repeat(100 * 1024) + '](x y)'],
    ['the same with an angle destination that fails', '['.repeat(100 * 1024) + '](<x y)'],
  ])('%s is linear', (_label, body) => {
    const started = performance.now();
    render(body, 'jira');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

/**
 * The angle-bracket destination, the one form that may hold a space. A plain-only scan finds
 * nothing in `![a](<https://e.test/a b.png>)` while the converter emits media, so
 * `slack/image-becomes-link` would stay silent. `surface/schema.test.ts` pins the window half.
 */
describe('an angle-bracketed destination', () => {
  test('is found whether or not it holds a space', () => {
    // Without a space the plain form's `[^)\s]+` accepts `<...>` too (hence `normaliseImageUrl` in
    // `profiles/jira.ts`); the space needs the angle form.
    expect(markdownLinkSpans('a ![alt](<https://e.test/y.png>) b')).toEqual([[2, 32]]);
    expect(markdownLinkSpans('a ![alt](<https://e.test/a b.png>) b')).toEqual([[2, 34]]);
    expect(markdownLinkSpans('a [alt](<https://e.test/a b.png>) b')).toEqual([[2, 33]]);
  });

  test('and its parts come out with the delimiters kept, as every caller expects', () => {
    expect(markdownImages('a ![alt](<https://e.test/a b.png>) b')).toEqual([
      { alt: 'alt', url: '<https://e.test/a b.png>' },
    ]);
  });

  test('so an image on a destination that draws none is sent as the link it will draw', () => {
    // Nothing that reaches Slack's editor is still an image.
    const sent = (body: string) => baselineFor(render(body, 'slack')).body;
    expect(sent('a ![alt](<https://e.test/a b.png>) b\n')).toBe(
      'a [alt](<https://e.test/a b.png>) b\n'
    );
    // Alt-less: the destination keeps its delimiters, the label never gets them.
    expect(sent('a ![](<https://e.test/a b.png>) b\n')).toBe(
      'a [https://e.test/a b.png](<https://e.test/a b.png>) b\n'
    );
  });

  test('what CommonMark forbids inside one ends the candidate rather than matching', () => {
    // A newline and a nested `<` are illegal in `<...>` and bound the scan (`markdownLinkSpans`).
    expect(markdownLinkSpans('[a](<https://e.test/x\ny>)')).toEqual([]);
    expect(markdownLinkSpans('[a](<https://e.test/<x>)')).toEqual([]);
    // Unterminated: no `>` before the end of the text.
    expect(markdownLinkSpans('[a](<https://e.test/x')).toEqual([]);
  });

  test('an unterminated one does NOT swallow the links after it', () => {
    // The plain branch's early return (a tail that is a suffix of every later one) does not hold
    // here: a run with no `>` can still hold a good `](y)`.
    expect(markdownLinkSpans('[a](<no close here [b](http://y) ok')).toEqual([[19, 32]]);
  });

  test('and it is linear: 100k unterminated angle openers, bounded by the next `<`', () => {
    // Linear through the terminators: `<` and a newline end a candidate, so the scans sum to O(n).
    // `![a](<` repeated stops after three characters each.
    const started = performance.now();
    expect(markdownLinkSpans('![a](<'.repeat(100 * 1024))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  /*
   * One grammar for both readers (`linkDestination.ts`): a `<` inside `<...>` ends the candidate for
   * the converter and this scan alike. Asserted on Slack's editor document and every sent body.
   */
  test.each([
    ['a `<` inside, with a space', '![x](<https://w.test/a<b c.png>) ok\n'],
    // Without a space it could pass for a PLAIN destination, but that form may not start with `<`.
    ['a `<` inside, no space', '![x](<https://w.test/a<b.png>) ok\n'],
    ['an empty one', '[x](<>) ok\n'],
  ])('%s is not a destination for either reader', (_label, body) => {
    const slackDoc = editorDocFor(render(body, 'slack'));
    expect(JSON.stringify(slackDoc)).not.toContain('"image"');
    for (const d of Object.keys(profiles) as DestinationName[]) {
      // Not a link, so nothing rewrites it: the reviewer is shown, and sends, what arrived.
      expect(baselineFor(render(body, d)).body, d).toBe(body);
    }
    expect(markdownLinkSpans(body)).toEqual([]);
  });

  test('an ESCAPED `<` inside is one, for both readers, and Slack gets the link', () => {
    const body = '![x](<https://w.test/a\\<b c.png>) ok\n';
    expect(markdownImages(body)).toEqual([{ alt: 'x', url: '<https://w.test/a\\<b c.png>' }]);
    expect(JSON.stringify(render(body, 'jira').converted)).toContain('"url":"https://w.test/a<b c.png"');
    const slack = render(body, 'slack');
    expect(JSON.stringify(editorDocFor(slack))).not.toContain('"image"');
    expect(slack.warnings.map((w) => w.code)).toContain('slack/image-becomes-link');
  });

  test('and escapes do not make the angle scan quadratic', () => {
    const started = performance.now();
    // Jira, so the converter's side of the grammar is timed as well as the scan.
    render('![a](<\\<'.repeat(50 * 1024), 'jira');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('and so is a single opener followed by 400 KB with no terminator in it', () => {
    // One candidate whose scan runs to the end: O(n) once, not per opener.
    const started = performance.now();
    expect(markdownLinkSpans('[a](<' + 'x'.repeat(400 * 1024))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('a code span inside an image', () => {
  /*
   * A code span inside an image does not split it. The converter emits the link itself
   * (`imagesAsLinks`), so no scan decides where code starts. Slack's editor gets no `image` and sends
   * the link; every other destination sends the image as written. The last three are inputs a
   * piece-at-a-time scan gets wrong.
   */
  test.each([
    [
      'in the alt',
      'See ![the `config.yml` diff](https://w.test/a.png)\n',
      '![the `config.yml` diff](https://w.test/a.png)',
    ],
    ['in the URL', '![x](https://w.test/`a`.png) ok\n', '![x](https://w.test/`a`.png)'],
    [
      'opened in the alt, closed after it',
      '![a `b](https://w.test/a.png) c` d\n',
      '![a `b](https://w.test/a.png)',
    ],
    [
      'opened in the URL, closed after it',
      '![x](https://w.test/`a.png) and run `make`\n',
      '![x](https://w.test/`a.png)',
    ],
    [
      'after a line starting with a fence that is not one',
      '``` ![x](https://w.test/a.png)\n',
      '![x](https://w.test/a.png)',
    ],
  ])('%s does not put an image into Slack\'s editor', (_label, body, image) => {
    const slack = render(body, 'slack');
    expect(JSON.stringify(editorDocFor(slack))).not.toContain('"image"');
    for (const d of Object.keys(profiles) as DestinationName[]) {
      const sent = baselineFor(render(body, d)).body;
      expect(sent, d).toContain(d === 'slack' ? image.slice(1) : image);
      if (d === 'slack') expect(sent).not.toContain('![');
    }
  });
});

/**
 * The scanner and the converter must agree about what an image is: a differential tripwire.
 * `markdownImages` is a linear per-keystroke scan, the converter a full parse, so they cannot share
 * code. A form only the converter reads (a `<...>` destination with a space) costs a silent
 * `slack/image-becomes-link`. The corpus is destination forms, so a new syntax the converter learns
 * shows here, where `surface/schema.test.ts`'s drafts and the oracle corpus above cannot see it.
 */
describe('what the scanner calls an image is what the converter calls media', () => {
  const FORMS: [string, string][] = [
    ['plain', 'a ![alt](https://e.test/y.png) b'],
    ['no alt', 'a ![](https://e.test/y.png) b'],
    ['angle brackets', 'a ![alt](<https://e.test/y.png>) b'],
    // The form a plain-destination scan misses: a space needs angle brackets.
    ['angle brackets with a space', 'a ![alt](<https://e.test/a b.png>) b'],
    ['angle brackets, no alt, with a space', 'a ![](<https://e.test/a b.png>) b'],
    ['relative', 'a ![alt](/local/y.png) b'],
    ['data uri', 'a ![alt](data:image/png;base64,iVBORw0KGgo=) b'],
    ['an attachment reference', 'a ![alt](jira-attachment:/rest/x/y.png) b'],
    ['in a heading', '# Title ![alt](https://e.test/y.png)'],
    ['in a task item', '- [ ] ![alt](https://e.test/y.png)'],
    ['in a table cell', '| a |\n| --- |\n| ![alt](https://e.test/1.png) |'],
    ['in a quote', '> quoted ![alt](https://e.test/1.png)'],
    ['two of them', '![a](https://e.test/1.png) and ![b](<https://e.test/2 3.png>)'],
    // A `<` inside `<...>` must be escaped, and an escaped `<` or `>` is part of the URL.
    ['angle brackets holding an escaped `<`', 'a ![alt](<https://e.test/a\\<b c.png>) b'],
    ['angle brackets holding an escaped `>`', 'a ![alt](<https://e.test/a\\>b c.png>) b'],
    ['angle brackets holding a `<` (not media)', 'a ![alt](<https://e.test/a<b c.png>) b'],
    ['a failed angle form, no space (not media)', 'a ![alt](<https://e.test/a<b.png>) b'],
    // A code span INSIDE an image does not hide it.
    ['a code span in the alt', 'See ![the `config.yml` diff](https://w.test/a.png)'],
    ['a code span in the URL', '![x](https://w.test/`a`.png) ok'],
    // Not images: a title form and a reference form produce no media.
    ['a title form (not media)', 'a ![alt](https://e.test/y.png "t") b'],
    ['a reference form (not media)', 'a ![alt][ref] b\n\n[ref]: https://e.test/y.png'],
    ['an escaped bang (not an image)', 'a \\![alt](https://e.test/y.png) b'],
    // An even run: a literal backslash, then a real image.
    ['a literal backslash before an image', 'a \\\\![alt](https://e.test/y.png) b'],
    ['a plain link (not an image)', 'a [alt](https://e.test/y.png) b'],
    ['inside a code span (not an image)', 'a `![alt](https://e.test/y.png)` b'],
  ];

  /** How many media nodes the converter emits, walking whatever it produced. */
  const mediaCount = (body: string): number => {
    const adf = convertMarkdownToAdf(body, { inlineMedia: true }) as AdfDocument;
    let n = 0;
    walk(adf as never, (node: { type?: string }) => {
      if (node.type === 'media') n++;
    });
    return n;
  };

  /**
   * One-way: the scanner sees every image the converter does. Over-reporting is the safe direction
   * (two forms, pinned below); under-reporting is a silent `slack/image-becomes-link`.
   */
  test.each(FORMS)('%s: the scanner sees every image the converter does', (_label, body) => {
    // `maskCode` first, as `profiles/jira.ts` and `profiles/slack.ts` do.
    expect(markdownImages(maskCode(body)).length).toBeGreaterThanOrEqual(mediaCount(body));
  });

  /**
   * The consequence, asserted directly: no `image` node reaches an editor that registers none
   * (`EditorBoundary`, reject-only). `surface/schema.test.ts` asserts Slack's schema has no `image`.
   */
  test.each(FORMS)('%s: and no image reaches a rendersMedia:false editor', (_label, body) => {
    expect(JSON.stringify(editorDocFor(render(body, 'slack')))).not.toContain('"type":"image"');
  });

  /**
   * Exactly which forms over-report, so a new one is noticed. Both are URLs the converter will not
   * fetch, reported as degraded (`jira/image-degraded-to-text`). `escaped bang` is not one:
   * `\![alt](url)` is a link, and the writer escapes every `!` before a link, so a scan ignoring the
   * escape would warn on every such Jira draft.
   */
  test('and the over-reporting forms are exactly the two known ones', () => {
    const over = FORMS.filter(
      ([, body]) => markdownImages(maskCode(body)).length > mediaCount(body)
    ).map(([label]) => label);
    expect(over).toEqual(['relative', 'data uri']);
  });

  test('and the corpus is not vacuous -- some of these really are images', () => {
    // Otherwise a scan finding nothing and a converter emitting nothing agree at zero.
    const withMedia = FORMS.filter(([, body]) => mediaCount(body) > 0);
    expect(withMedia.length).toBeGreaterThan(8);
    const withoutMedia = FORMS.filter(([, body]) => mediaCount(body) === 0);
    expect(withoutMedia.length).toBeGreaterThan(3);
  });
});
