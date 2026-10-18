/**
 * Backslash escapes and code spans as CommonMark 0.31.2 reads them (2.4, 6.1), by the converter and
 * by the scanners that must agree with it, and written back as a fixed point. Asserted on the body
 * an approval sends, for all four destinations, and on Jira's ADF. GitHub's `POST /markdown` (gfm)
 * agrees with every expectation unless a test says otherwise.
 */

import { describe, expect, test } from 'bun:test';
import { convertMarkdownToAdf } from '../src/adf/index';
import { convertAdfToMarkdown } from '../src/adf/adfToMarkdown';
import type { AdfDocument, AdfNode } from '../src/adf/types';
import { backtickRuns, codeSpanAt, writeCodeSpan } from '../src/codeSpan';
import { baselineFor } from '../src/editor';
import { maskCode, segments } from '../src/markdown';
import { findMentionTokens } from '../src/mentionTokens';
import { profiles, type DestinationName } from '../src/profiles/index';
import { render } from '../src/render';

const DESTINATIONS = ['jira', 'github', 'slack', 'linear'] as const satisfies DestinationName[];

/** What an unedited approval would send: the body the reviewer is shown. */
const sent = (body: string, destination: DestinationName) =>
  baselineFor(render(body, destination)).body;

/** A paragraph's inline content as plain strings and `{ code }`, with any other marks spelled out. */
type Run = string | { code: string } | { [mark: string]: string };

function runsOf(nodes: AdfNode[] | undefined): Run[] {
  return (nodes ?? []).map((n) => {
    const marks = (n.marks ?? []).map((m) => m.type).sort();
    if (marks.length === 0) return n.text ?? `<${n.type}>`;
    return { [marks.join('+')]: n.text ?? `<${n.type}>` };
  });
}

/** The first paragraph's runs, as Jira's converter options read them. */
const jiraRuns = (body: string) =>
  runsOf(((render(body, 'jira').converted as AdfDocument).content[0] as AdfNode).content);

/** The same through the markdown destinations' options, where code may carry other marks. */
const previewRuns = (body: string) =>
  runsOf(
    (convertMarkdownToAdf(body, { combineCodeSpanMarks: true }).content[0] as AdfNode)
      .content
  );

describe('a code span is a backtick string closed by one of the same length (CommonMark 6.1)', () => {
  /*
   * The spec's "Code spans" examples that fit on one line, with commonmark.js 0.31.2's reading.
   * Five of the section's 22 read differently: the three multi-line spans (the converter reads a
   * newline as a hard break, a deliberate difference), `<a href="`">` (raw HTML stays text), and
   * example 342 below.
   */
  const SPEC: [number, string, Run[]][] = [
    [328, '`foo`', [{ code: 'foo' }]],
    [329, '`` foo ` bar ``', [{ code: 'foo ` bar' }]],
    [330, '` `` `', [{ code: '``' }]],
    [331, '`  ``  `', [{ code: ' `` ' }]],
    [332, '` a`', [{ code: ' a' }]],
    // Non-breaking spaces: "only spaces, and not unicode whitespace in general, are stripped".
    [333, '`\u00a0b\u00a0`', [{ code: '\u00a0b\u00a0' }]],
    [338, '`foo\\`bar`', [{ code: 'foo\\' }, 'bar`']],
    [339, '``foo`bar``', [{ code: 'foo`bar' }]],
    [340, '` foo `` bar `', [{ code: 'foo `` bar' }]],
    [341, '*foo`*`', ['*foo', { code: '*' }]],
    [343, '`<a href="`">`', [{ code: '<a href="' }, '">`']],
    [345, '`<https://foo.bar.`baz>`', [{ code: '<https://foo.bar.' }, 'baz>`']],
    [346, '<https://foo.bar.`baz>`', [{ link: 'https://foo.bar.`baz' }, '`']],
    [347, '```foo``', ['```foo``']],
    [348, '`foo', ['`foo']],
    [349, '`foo``bar``', ['`foo', { code: 'bar' }]],
  ];

  test.each(SPEC)('spec example %i: %s', (_n, body, runs) => {
    expect(previewRuns(body)).toEqual(runs);
  });

  test('the all-space span keeps its spaces (spec example 334)', () => {
    expect(previewRuns('` `')).toEqual([{ code: ' ' }]);
    expect(previewRuns('`  `')).toEqual([{ code: '  ' }]);
  });

  // A known difference a real draft could reach: code spans bind tighter than a link's brackets, so
  // the spec reads `[not a ` then code; the converter matches the link first. Pinned either way.
  test('spec example 342 reads the link first (a known difference)', () => {
    expect(previewRuns('[not a `link](/foo`)')).toEqual([{ link: 'not a `link' }]);
  });
});

describe('four shapes from real drafts', () => {
  test('a double-backtick span holding a backtick', () => {
    const body = 'run ``a`b`` now';
    expect(jiraRuns(body)).toEqual(['run ', { code: 'a`b' }, ' now']);
    for (const d of DESTINATIONS) expect(sent(body, d), d).toBe(body);
  });

  test('a single-backtick span holding a run of another length', () => {
    const body = "call `render('- ```\\n')` twice";
    expect(jiraRuns(body)).toEqual(['call ', { code: "render('- ```\\n')" }, ' twice']);
    for (const d of DESTINATIONS) expect(sent(body, d), d).toBe(body);
  });

  test('a star inside a code span does not close the emphasis around it', () => {
    const body = '*"see the (`cloud-acme-*`) buckets"*';
    // Jira's code mark combines with `link` and nothing else, probed, so the italic goes around it.
    expect(jiraRuns(body)).toEqual([
      { em: '"see the (' },
      { code: 'cloud-acme-*' },
      { em: ') buckets"' },
    ]);
    expect(previewRuns(body)).toEqual([
      { em: '"see the (' },
      { 'code+em': 'cloud-acme-*' },
      { em: ') buckets"' },
    ]);
    for (const d of ['github', 'slack', 'linear'] as const) expect(sent(body, d), d).toBe(body);
    // The asterisk index skips it too: nothing after the span can close this opener.
    expect(previewRuns('*a `b*` c')).toEqual(['*a ', { code: 'b*' }, ' c']);
    // And a literal run is skipped whole, so its backticks do not hide a real closer.
    expect(previewRuns('*a `` b* c')).toEqual([{ em: 'a `` b' }, ' c']);
  });

  test('code holding a backtick is written with a delimiter the reader gives back', () => {
    const doc: AdfDocument = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x ' },
            { type: 'text', text: 'a`b', marks: [{ type: 'code' }] },
            { type: 'text', text: ' y' },
          ],
        },
      ],
    };
    expect(convertAdfToMarkdown(doc)).toBe('x ``a`b`` y');
  });
});

describe('writeCodeSpan is a fixed point of the reader', () => {
  test.each([
    ['plain', 'a', '`a`'],
    ['a ``` inside needs no longer delimiter', '- ``` x', '`- ``` x`'],
    ['a single backtick inside', 'a`b', '``a`b``'],
    ['runs of one and two inside', 'a`b``c', '```a`b``c```'],
    ['starts with a backtick', '`a', '`` `a ``'],
    ['ends with a backtick', 'a`', '`` a` ``'],
    ['only a backtick', '`', '`` ` ``'],
    ['spaces at both ends, which the reader would strip', ' a ', '`  a  `'],
    ['all spaces, which it would not', '  ', '`  `'],
  ])('%s', (_label, code, written) => {
    expect(writeCodeSpan(code)).toBe(written);
    const span = codeSpanAt(written, 0, backtickRuns(written));
    expect(span).toEqual({ end: written.length, code });
  });

  test('on every short string over the alphabet that matters', () => {
    // Exhaustive to length 5 over backtick, space and a letter: 363 strings.
    const alphabet = ['`', ' ', 'a'];
    let strings = [''];
    const all: string[] = [];
    for (let n = 1; n <= 5; n++) {
      strings = strings.flatMap((s) => alphabet.map((c) => s + c));
      all.push(...strings);
    }
    for (const code of all) {
      const written = writeCodeSpan(code);
      expect(codeSpanAt(written, 0, backtickRuns(written)), JSON.stringify(code)).toEqual({
        end: written.length,
        code,
      });
    }
  });
});

describe('a backslash escapes ASCII punctuation (CommonMark 2.4)', () => {
  test('each ASCII punctuation character but `<` and `&` (below) is the character alone', () => {
    // Spec example 12 holds the same set in one paragraph; this names the character that fails.
    for (const c of '!"#$%\'()*+,-./:;=>?@[\\]^_`{|}~') expect(previewRuns(`a \\${c} b`), c).toEqual([`a ${c} b`]);
  });

  test('before anything else it is a literal backslash', () => {
    expect(previewRuns('C:\\Users \\a \\é')).toEqual(['C:\\Users \\a \\é']);
  });

  test('`\\"` inside an italic quote reaches Jira as `"`', () => {
    expect(jiraRuns('she said *\\"no\\"* twice')).toEqual(['she said ', { em: '"no"' }, ' twice']);
  });

  test('every destination sends something that reads the same, and GitHub agrees', () => {
    // GitHub renders `q "x" $5 % /` for the source and for what is sent.
    for (const d of DESTINATIONS) expect(sent('q \\"x\\" \\$5 \\% \\/', d), d).toBe('q "x" $5 % /');
  });

  // `<` and `&` keep their backslash (`isEscapable`): the converter reads raw HTML as text either
  // way, so a writer dropping it would send `<br>` and GitHub would draw the break, or hide the rest
  // of the line in a comment.
  test.each([
    'Use \\<br> for a break',
    'Hide \\<!-- x --> here',
    'Literal \\<details> tag',
    'price \\&amp; more',
  ])('%s keeps its backslash', (body) => {
    for (const d of DESTINATIONS) expect(sent(body, d), d).toBe(body);
  });

  // `\@` is text. The backslash does not survive the round trip, harmless on GitHub, which renders
  // `\@octocat` as a mention anyway (probed). Linear's reading of `\@` is unprobed.
  test('`\\@` is text, not a mention', () => {
    expect(jiraRuns('hi \\@todo and @todo')).toEqual(['hi @todo and @todo']);
  });

  test('an escaped backtick is text, and is written back escaped', () => {
    const body = 'a \\`b\\` c';
    expect(jiraRuns(body)).toEqual(['a `b` c']);
    // Written bare it would come back a code span.
    for (const d of DESTINATIONS) expect(sent(body, d), d).toBe(body);
    // An escape opens nothing: the run after it is what may open.
    expect(previewRuns('\\``a`')).toEqual(['`', { code: 'a' }]);
  });
});

describe('the scanners read code where the converter does', () => {
  /** The code regions `maskCode` finds, as the strings it blanked. */
  const masked = (md: string) => {
    const m = maskCode(md);
    const out: string[] = [];
    let start = -1;
    for (let i = 0; i <= md.length; i++) {
      const code = i < md.length && m[i] !== md[i];
      if (code && start === -1) start = i;
      if (!code && start !== -1) {
        out.push(md.slice(start, i));
        start = -1;
      }
    }
    return out;
  };

  test.each([
    ['a double-backtick span', 'x ``a`b`` y', ['``a`b``']],
    ['a ``` inside a single-backtick span', "x `render('- ```')` y\nnext line", ["`render('- ```')`"]],
    ['an unmatched run is literal, not an empty span', 'x `` y `z`', ['`z`']],
    ['an escaped backtick opens nothing', 'x \\`y` z', []],
    ['a span stays on its line', '`a\nb`', []],
  ])('%s', (_label, md, regions) => {
    expect(masked(md)).toEqual(regions);
    expect(segments(md).filter((s) => s.code).map((s) => s.text)).toEqual(regions);
  });

  test('so a mention inside a double-backtick span is not a ping', () => {
    const patterns = profiles.slack.mentions.tokens!.patterns;
    const body = 'see ``<@U0123ABCDEF> `x` `` and <@U123ABC>';
    expect(findMentionTokens(maskCode(body), patterns).map((t) => body.slice(t.start, t.end))).toEqual([
      '<@U123ABC>',
    ]);
  });
});

describe('the backtick index keeps both scans linear', () => {
  // A closer search that walked the rest of the line per unmatched run is quadratic here: 40k runs
  // across 200 KB is minutes. The budget is a quadratic detector, not a stopwatch.
  test.each([
    ['unmatched double runs', '`` a '.repeat(40 * 1024)],
    ['a star opener beside each span', '*a `*` '.repeat(28 * 1024)],
    ['escaped backticks', '\\`a '.repeat(50 * 1024)],
  ])('%s', (_label, body) => {
    for (const d of ['jira', 'slack'] as const) {
      const started = performance.now();
      render(body, d);
      expect(performance.now() - started, d).toBeLessThan(2_000);
    }
  });
});
