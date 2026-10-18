/**
 * Slack profile tests, anchored on the rendered client: `slack_read_channel` flattens Block Kit to
 * text, and the client renders markdown almost losslessly. The `does NOT warn` tests keep the
 * read-back's false losses out.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { slackProfile, slackElidesLabel } from '../src/profiles/slack';
import { baselineFor, fromEditorDoc, markdownFor } from '../src/editor';
import type { PmNode } from '../src/prosemirror';
import { expectGolden, tortureFixture } from './golden';

describe('slack profile contract', () => {
  test('preview-only, because there is no blocks parameter to substitute into', () => {
    expect(slackProfile.mode).toBe('preview-only');
    expect(slackProfile.bodyField).toBe('message');
    expect(slackProfile.extraToolInput).toEqual({});
    expect(slackProfile.contextFields).toContain('channel_id');
    expect(slackProfile.contextFields).toContain('thread_ts');
  });

  test('conversion is a pass-through -- Slack renders the markdown itself', () => {
    const src = tortureFixture();
    const r = render(src, 'slack');
    expect(r.converted).toBe(src);
  });
});

describe('what Slack actually renders (VERIFIED in the client)', () => {
  // Each read off a screenshot of the rendered message; a read-back API reports each as damaged.
  const r = render(tortureFixture(), 'slack');
  const codes = r.warnings.map((w) => w.code);

  test('nothing blocks -- Slack delivers what was written', () => {
    expect(r.blocked).toBe(false);
    expect(r.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  const falseAlarms: [string, string][] = [
    ['headings render as real headings', 'slack/heading-flattened'],
    ['GFM tables render as real tables', 'slack/table-deleted'],
    ['a table-only message is not empty', 'slack/message-emptied'],
    ['task items render as real checkboxes', 'slack/task-state-inverted'],
    ['unchecked items keep their box', 'slack/task-state-lost'],
    ['ordered lists number 1, 2, 3 correctly', 'slack/ordered-list-renumbered'],
    ['code fences keep their language and highlight', 'slack/code-language-lost'],
    ['horizontal rules render as visible dividers', 'slack/rule-dropped'],
  ];
  for (const [why, code] of falseAlarms) {
    test(`does NOT warn ${code} -- ${why}`, () => {
      expect(codes).not.toContain(code);
    });
  }
});

describe('the two genuine losses', () => {
  test('a markdown image becomes a link, and Slack does not unfurl it', () => {
    const r = render('See ![diagram](https://example.com/d.png) here.\n', 'slack');
    const img = r.warnings.filter((w) => w.code === 'slack/image-becomes-link');
    expect(img).toHaveLength(1);
    expect(img[0]!.severity).toBe('warning');
    expect(img[0]!.message).toContain('https://example.com/d.png');
    // Verified with a real reachable image URL: no picture, no thumbnail, no card.
    expect(img[0]!.message).toContain('with no picture or preview');
    expect(r.blocked).toBe(false);
  });

  test('an image inside a code fence is not treated as an image', () => {
    const r = render('```\n![not real](https://example.com/x.png)\n```\n', 'slack');
    expect(r.warnings.map((w) => w.code)).not.toContain('slack/image-becomes-link');
  });

  test('a bare URL with five or more path segments is shortened, and warned about', () => {
    // Five segments. One point cannot place the threshold (`> 2` fits too); the next test
    // measures either side.
    const url = 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png';
    expect(slackElidesLabel(url)).toBe(true);
    const r = render(`See ${url} please.\n`, 'slack');
    const el = r.warnings.filter((w) => w.code === 'slack/url-label-elided');
    expect(el).toHaveLength(1);
    expect(el[0]!.severity).toBe('info');
  });

  test('and the threshold is FIVE segments, measured either side of it', () => {
    // PROBED in a live DM, two ladders: in the first every deeper path is also longer, so the
    // second separates segment count from length. Three and four segments render in full.
    for (const full of [
      'https://example.org',
      'https://example.org/docs',
      'https://example.org/docs/components',
      'https://example.org/docs/components/extractors',
      // 87 characters and four segments, the longest measured, not shortened: it counts segments.
      'https://example.org/documentation/configuration/extractors/snowflake-database-connector',
    ]) {
      expect(slackElidesLabel(full), `${full} should render in full`).toBe(false);
      expect(render(`See ${full} ok\n`, 'slack').warnings.map((w) => w.code)).not.toContain(
        'slack/url-label-elided'
      );
    }
    for (const cut of [
      // 29 characters and five segments: the shortest thing measured, and shortened.
      'https://example.org/a/b/c/d/e',
      'https://example.org/docs/components/extractors/database/snowflake',
      'https://example.org/a/b/c/d/e/f',
    ]) {
      expect(slackElidesLabel(cut), `${cut} should be shortened`).toBe(true);
    }
  });

  test('and it counts PATH segments -- not every slash in the URL', () => {
    // `split('/')` over the whole URL would count `example.org/search?q=a/b/c/d/e` (one path
    // segment) as five and warn about a shortening that does not happen.
    for (const notElided of [
      'https://example.org/search?q=a/b/c/d/e',
      'https://example.org/docs?a=1/2/3/4/5',
      'https://example.org/a#x/y/z/w/v',
      // Empty segments are not seen and `//` was not probed, so the count drops them.
      'https://example.org/a//b//c',
    ]) {
      expect(slackElidesLabel(notElided), `${notElided} has fewer than five path segments`).toBe(
        false
      );
      expect(render(`See ${notElided} ok\n`, 'slack').warnings.map((w) => w.code)).not.toContain(
        'slack/url-label-elided'
      );
    }
    // And a query string does not suppress one: five path segments still warn.
    expect(slackElidesLabel('https://example.org/a/b/c/d/e?q=1')).toBe(true);
  });

  test('and it does not claim to know WHAT the shortened label says', () => {
    // How many leading segments survive depends on rendered width: `example.org/a/b/.../e` kept
    // two, `example.org/docs/.../snowflake` one, in the same run. The message must not predict it.
    const r = render('See https://example.org/a/b/c/d/e ok\n', 'slack');
    const el = r.warnings.find((w) => w.code === 'slack/url-label-elided')!;
    expect(el.message).toContain('five or more path segments');
    // The full URL is quoted; a predicted shortened form (an ellipsis) must not be.
    expect(el.message).toContain('https://example.org/a/b/c/d/e');
    expect(el.message).not.toContain('\u2026');
    expect(el.message).not.toMatch(/\/\.\.\.\//);
  });

  test('a URL inside a markdown link is not treated as a bare URL', () => {
    const r = render('[label](https://a.example.com/one/two/three/four.png)\n', 'slack');
    expect(r.warnings.map((w) => w.code)).not.toContain('slack/url-label-elided');
  });
});

describe('heading levels collapse to THREE styles (VERIFIED)', () => {
  /*
   * Two sizes, three renderings, read off the live DOM (all six levels in one message):
   *
   *     `#`              p-header_block--level_1 flat_scale   18px / 900
   *     `##`             p-header_block--level_2 flat_scale   15px / 900
   *     `###`..`######`  p-header_block--level_3 flat_scale   15px / 700
   *
   * So the collapse is h3..h6, not h2..h6. A screenshot of sizes cannot see the weight split.
   */
  test('using h2 and h3 together is NOT a collapse -- they render at different weights', () => {
    const r = render('## Section\n\n### Subsection\n', 'slack');
    expect(r.warnings.map((x) => x.code)).not.toContain('slack/heading-level-collapsed');
  });

  test('using h3 and h4 together IS reported -- both are level_3', () => {
    const r = render('### Section\n\n#### Subsection\n', 'slack');
    const w = r.warnings.filter((x) => x.code === 'slack/heading-level-collapsed');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('info');
    expect(w[0]!.message).toContain('h3, h4');
    expect(r.blocked).toBe(false);
  });

  test('a single collapsing level is NOT a loss -- nothing to collapse against', () => {
    const r = render('### Only one level\n\nbody\n', 'slack');
    expect(r.warnings.map((x) => x.code)).not.toContain('slack/heading-level-collapsed');
  });

  test('h1 alongside h2 is fine -- those two really are distinct', () => {
    const r = render('# Title\n\n## Section\n', 'slack');
    expect(r.warnings.map((x) => x.code)).not.toContain('slack/heading-level-collapsed');
  });

  test('h1 and h2 and h3 together is fine -- all three render distinctly', () => {
    // Three levels, three renderings, no loss.
    const r = render('# Title\n\n## Section\n\n### Sub\n', 'slack');
    expect(r.warnings.map((x) => x.code)).not.toContain('slack/heading-level-collapsed');
  });

  test('all six levels reports the FOUR that collapse, not five', () => {
    const md = '# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f\n';
    const w = render(md, 'slack').warnings.find((x) => x.code === 'slack/heading-level-collapsed');
    expect(w!.message).toContain('h3, h4, h5, h6');
    expect(w!.message).not.toContain('h2, h3');
    // And it says what the three styles are.
    expect(w!.message).toContain("'###' to '######' are bold");
  });

  test('a heading-like line inside a code fence is ignored', () => {
    const r = render('```\n## not a heading\n### also not\n```\n', 'slack');
    expect(r.warnings.map((x) => x.code)).not.toContain('slack/heading-level-collapsed');
  });
});

describe('horizontal rules render (VERIFIED)', () => {
  test('all three markdown forms produce a divider, so none is a loss', () => {
    // Verified with labelled markers either side of each form.
    for (const rule of ['---', '***', '___']) {
      const r = render(`above\n\n${rule}\n\nbelow\n`, 'slack');
      expect(r.warnings.map((w) => w.code)).not.toContain('slack/rule-dropped');
      expect(r.converted).toContain(rule);
      expect(r.blocked).toBe(false);
    }
  });
});

describe('golden', () => {
  test('fixture output and warnings', () => {
    const r = render(tortureFixture(), 'slack');
    expectGolden('torture-fixture.slack.json', {
      converted: r.converted,
      warnings: r.warnings,
      blocked: r.blocked,
    });
  });
});

describe('slack/url-swallows-next-line -- measured, five probes to the self-DM', () => {
  const codes = (md: string) => render(md, 'slack').warnings.map((w) => w.code);
  const fires = (md: string) => codes(md).filter((c) => c === 'slack/url-swallows-next-line').length;
  const warningFor = (md: string) =>
    render(md, 'slack').warnings.find((w) => w.code === 'slack/url-swallows-next-line')!;

  test('THE BUG: a bare URL ending a line swallows the next line', () => {
    // Observed twice (PROBE 1 A8/A9, PROBE 5 E2/E3): "See https://example.org\nNext sentence here."
    // renders as one line with the link labelled "example.org_Next".
    expect(fires('See https://example.org\nNext sentence here.')).toBe(1);
  });

  test('it is a warning, not an error: Slack still delivers every word', () => {
    const w = warningFor('See https://example.org\nNext.');
    expect(w.severity).toBe('warning');
    // `error` is for content the destination rejects or loses; Slack does neither.
    expect(render('See https://example.org\nNext.', 'slack').blocked).toBe(false);
  });

  test('the message names both verified fixes', () => {
    const w = warningFor('See https://example.org\nNext.');
    expect(w.message).toContain('[text](https://example.org)');
    expect(w.message).toContain('blank line');
  });

  // Each probed and rendered correctly, so each must stay silent.
  const safe: [string, string][] = [
    ['a blank line after the URL (D5 -> D6)', 'See https://example.org\n\nNext sentence here.'],
    ['the URL is the last line', 'See https://example.org'],
    ['the URL is mid-line', 'See https://example.org for details.\nNext line.'],
    ['a labelled link ends the line (A7)', 'See [docs](https://example.org)\nNext line.'],
    ['an image ends the line (E4 -> E5)', 'Pic ![a](https://x.com/a.png)\nNext line.'],
    ['the URL is inside a fenced block', '```\nhttps://example.org\nnext\n```'],
    // The scan shares `maskCode` with every other Slack check; a fence toggle of its own would
    // miss inline code spans.
    ['the URL is inside an INLINE code span', 'Run `curl https://example.org`\nThen wait.'],
    ['a ~~~ fence, not just a ``` one', '~~~\nhttps://example.org\nnext\n~~~'],
  ];
  for (const [name, md] of safe) {
    test(`silent when ${name}`, () => expect(fires(md)).toBe(0));
  }

  test('every offender is reported, not just the first', () => {
    expect(fires('a https://one.com\nb\nc https://two.com\nd')).toBe(2);
  });

  test('masking preserves offsets, so a link earlier on the line is not mistaken for the end', () => {
    // Deleting links instead of masking them would pull the tail onto the line's end.
    expect(fires('See [docs](https://example.org) and read it.\nNext line.')).toBe(0);
  });

  test('CRLF input is checked too, rather than silently disabling the whole scan', () => {
    // Splitting on a bare '\n' leaves a '\r' on every line, which the end-of-line anchor never
    // matches, so the check would find nothing on a CRLF document.
    expect(fires('See https://example.org\r\nNext sentence here.')).toBe(1);
    // And the safe cases stay safe: the blank line still stops it when the blank line is '\r\n'.
    expect(fires('See https://example.org\r\n\r\nNext sentence here.')).toBe(0);
  });

  test('a full stop after the URL is not reported as part of the URL', () => {
    // The greedy capture takes the full stop. Whether Slack swallows here is not probed, so the
    // warning fires; it must name the right address.
    const w = warningFor('See https://example.org.\nNext sentence.');
    expect(w).toBeDefined();
    expect(w.message).toContain('onto the link https://example.org and');
    expect(w.message).toContain('[text](https://example.org)');
    expect(w.message).not.toContain('example.org.');
  });

  test('punctuation that is genuinely part of a path survives', () => {
    // Only trailing sentence punctuation is stripped.
    const w = warningFor('See https://example.org/a.b/c\nNext.');
    expect(w.message).toContain('onto the link https://example.org/a.b/c and');
  });

  test('the elided-label warning names the URL without its full stop too', () => {
    const el = render('Read https://example.org/a/b/c/d/e. Then stop.\n', 'slack').warnings
      .filter((w) => w.code === 'slack/url-label-elided');
    expect(el).toHaveLength(1);
    expect(el[0]!.message).toContain('link text for https://example.org/a/b/c/d/e,');
    // It judges the trimmed URL: `.../d/!` is four segments.
    expect(codes('Read https://example.org/a/b/c/d/! Then stop.\n')).not.toContain('slack/url-label-elided');
  });

  test('the offered repair spells its link the way the writer does', () => {
    // A URL ending in `\` spelled by hand as `[${url}](${url})` escapes the label's bracket; it uses
    // the writer's `writeLabel`/`writeDestination`.
    const w = warningFor('See https://x.com/a\\\nNext line.');
    expect(w.fixes?.[0]?.body).toBe('See [https://x.com/a\\\\](https://x.com/a\\\\)\nNext line.');
  });

  test('a `)` still ends the candidate, so a Wikipedia link ending a line does not fire', () => {
    // Admitting balanced parentheses would fire on a shape nobody has measured.
    expect(fires('See https://en.wikipedia.org/wiki/Foo_(bar)\nNext.')).toBe(0);
  });
});

describe('a single newline is a LINE BREAK in Slack, and core already models it', () => {
  test('core keeps the newline through the round trip', () => {
    // Measured (PROBE 4 D7): LINE-ONE and LINE-TWO rendered on two lines, where strict markdown
    // would join them.
    expect(render('LINE-ONE\nLINE-TWO', 'slack').converted).toBe('LINE-ONE\nLINE-TWO');
  });
});

describe('a warning that NAMES a fix carries one -- and every fix it names', () => {
  // A warning that tells the reviewer to "write [text](url)" offers that repair in one click, as a
  // blocked draft's does.
  const swallow = (md: string) =>
    render(md, 'slack').warnings.find((w) => w.code === 'slack/url-swallows-next-line')!;

  test('BOTH repairs the message names are offered, not just one', () => {
    // Different results: an explicit link shows the full URL, a blank line keeps Slack's elided
    // `example.org`.
    expect(swallow('See https://example.org\nNext sentence.').fixes).toEqual([
      {
        label: 'Write it as an explicit link',
        body: 'See [https://example.org](https://example.org)\nNext sentence.',
      },
      { label: 'Add a blank line after it', body: 'See https://example.org\n\nNext sentence.' },
    ]);
  });

  test('EVERY offered repair actually clears the warning', () => {
    const w = swallow('See https://example.org\nNext sentence.');
    for (const f of w.fixes!) {
      const after = render(f.body, 'slack').warnings.map((x) => x.code);
      expect(after).not.toContain('slack/url-swallows-next-line');
    }
  });

  test('trailing punctuation stays OUTSIDE the link', () => {
    // The repair must not put the full stop into the href.
    expect(swallow('See https://example.org.\nNext.').fixes![0]!.body).toBe(
      'See [https://example.org](https://example.org).\nNext.'
    );
  });

  test('each occurrence repairs only ITSELF, so fixing one leaves the other', () => {
    const md = 'a https://one.com\nb\nc https://two.com\nd';
    const links = render(md, 'slack')
      .warnings.filter((w) => w.code === 'slack/url-swallows-next-line')
      .map((w) => w.fixes![0]!.body);
    expect(links).toHaveLength(2);
    expect(links[0]).toBe('a [https://one.com](https://one.com)\nb\nc https://two.com\nd');
    expect(links[1]).toBe('a https://one.com\nb\nc [https://two.com](https://two.com)\nd');
  });

  test('a CRLF draft keeps its line endings, in BOTH repairs', () => {
    // Each splices the original string, and the blank-line repair copies that line's own ending.
    const w = swallow('See https://example.org\r\nNext.');
    expect(w.fixes![0]!.body).toBe('See [https://example.org](https://example.org)\r\nNext.');
    expect(w.fixes![1]!.body).toBe('See https://example.org\r\n\r\nNext.');
  });

  test('a warning whose fix draftgate CANNOT perform gets none', () => {
    // `slack/image-becomes-link` names an upload, which draftgate cannot do: it holds no credentials.
    const w = render('Pic ![a](https://x.com/a.png) here.', 'slack').warnings.find(
      (x) => x.code === 'slack/image-becomes-link'
    )!;
    expect(w.message).toContain('Upload the file');
    expect(w.fixes).toBeUndefined();
  });
});

/**
 * A plain bullet in a checklist run arrives as an unchecked to-do. PROBED, four cases in one message
 * to the self-DM: Slack types the list, not the item (`data-stringify-type=check-list` on the `<ul>`),
 * so every `li` in it gets a checkbox.
 *
 * | case | draft | Slack renders |
 * |---|---|---|
 * | A | `- [ ] task` / `- bullet` | two checkboxes |
 * | B | `- bullet` / `- [ ] task` | two checkboxes -- ORDER does not matter |
 * | C | `- bullet` / blank / `- [ ] task` | two checkboxes -- a blank line does NOT separate them |
 * | D | `1. one` / `1. [ ] task` | `1.` keeps its number, the task splits off |
 *
 * C: the obvious repair, a blank line, does not work. D: an ordered item breaks a bullet run, so
 * the message advises a numbered list.
 */
describe('a plain bullet in a checklist run becomes a to-do (VERIFIED)', () => {
  const codes = (md: string) => render(md, 'slack').warnings.map((w) => w.code);
  const found = (md: string) =>
    render(md, 'slack').warnings.find((w) => w.code === 'slack/list-item-becomes-task');

  test('case A: a bullet AFTER the task is reported', () => {
    const w = found('- [ ] task\n- bullet\n');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    expect(w!.message).toContain('"bullet"');
    // A warning: the send succeeds and every word arrives.
    expect(render('- [ ] task\n- bullet\n', 'slack').blocked).toBe(false);
  });

  test('case B: a bullet BEFORE the task is reported too -- order does not matter', () => {
    expect(found('- bullet\n- [ ] task\n')).toBeDefined();
  });

  test('case C: a blank line does NOT separate the runs', () => {
    // Measured: Slack merged `- C1 bullet` / blank / `- [ ] C2 task` into one check-list.
    const w = found('- bullet\n\n- [ ] task\n');
    expect(w).toBeDefined();
    expect(w!.message).toContain('even across a blank line');
  });

  test('case D: an ORDERED run is untouched', () => {
    // Measured: `1. D1` kept its number and the task split off as its own checkbox.
    expect(codes('1. one\n1. [ ] task\n')).not.toContain('slack/list-item-becomes-task');
    // The advice, so the numbered form of case A must be clean.
    expect(codes('- [ ] task\n1. one\n')).not.toContain('slack/list-item-becomes-task');
  });

  test('a checklist with no plain items is clean, and so is a bullet list with no tasks', () => {
    expect(codes('- [ ] a\n- [x] b\n')).not.toContain('slack/list-item-becomes-task');
    expect(codes('- a\n- b\n')).not.toContain('slack/list-item-becomes-task');
  });

  test('a paragraph between the two lists separates them', () => {
    // What does separate a run; the probe's four cases were each introduced by prose.
    expect(codes('- bullet\n\nSome prose.\n\n- [ ] task\n')).not.toContain(
      'slack/list-item-becomes-task'
    );
  });

  test('SIBLINGS at a nested indent are reported; a bullet nested UNDER a task is not', () => {
    // `data-stringify-type` is on the `<ul>`, so siblings at any indent are one list. A bullet
    // under a task item is a child list, and nothing measured says Slack types it from its parent.
    expect(found('- [ ] a\n  - [ ] d\n  - e\n')).toBeDefined();
    expect(codes('- [ ] a\n  - b\n')).not.toContain('slack/list-item-becomes-task');
  });

  test('a checklist inside a code fence is ignored', () => {
    expect(codes('```\n- [ ] task\n- bullet\n```\n')).not.toContain('slack/list-item-becomes-task');
  });

  test('the count and the quoting are capped, because the strip has one line', () => {
    const w = found('- [ ] t\n- one\n- two\n- three\n');
    expect(w!.message).toContain('3 plain bullets');
    // Two named plus an ellipsis.
    expect(w!.message).toContain('"one", "two", ...');
    expect(w!.message).not.toContain('"three"');
  });

  test('a long item is clipped rather than printed whole', () => {
    const w = found(`- [ ] t\n- ${'x'.repeat(80)}\n`);
    expect(w!.message).toContain('…');
    expect(w!.message).not.toContain('x'.repeat(80));
  });

  test('the other two destinations say nothing -- this is Slack typing a list', () => {
    for (const dest of ['jira', 'linear'] as const) {
      expect(
        render('- [ ] task\n- bullet\n', dest).warnings.map((w) => w.code),
        dest
      ).not.toContain('slack/list-item-becomes-task');
    }
  });
});

/**
 * A line starting `\>` is a quote on Slack. PROBED: of the line-start escapes the writer sends,
 * Slack honours all but this one (`\> not a quote` draws the quote bar, the `>` gone). No surviving
 * spelling was probed, so the profile names the line and offers no repair.
 */
describe('an escaped `>` at a line start is a quote on Slack (VERIFIED)', () => {
  const codes = (body: string) => render(body, 'slack').warnings.map((w) => w.code);

  test('the probed line warns, naming it, as sent', () => {
    const body = 'Result:\n\\> not a quote\n';
    const r = render(body, 'slack');
    // The body the window sends is the one judged, and it keeps the escape.
    expect(baselineFor(r).body).toBe(body);
    const w = r.warnings.find((x) => x.code === 'slack/escaped-quote-marker');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toContain('"> not a quote"');
  });

  test('a line the reviewer TYPED as text starting with `>` warns too, because the writer escapes it', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '> quoted by hand' }] }],
    } as unknown as PmNode;
    const sent = fromEditorDoc(doc);
    expect(sent).toBe('\\> quoted by hand');
    expect(codes(sent)).toContain('slack/escaped-quote-marker');
  });

  test('...and nothing that was not probed, nor a real quote, nor code', () => {
    for (const body of [
      '> a real quote\n',
      '```\n\\> in code\n```\n',
      '\\\\> a literal backslash first\n',
      '- \\> behind a list marker\n',
      'see a \\> b\n',
    ]) {
      expect(codes(body), JSON.stringify(body)).not.toContain('slack/escaped-quote-marker');
    }
  });

  test('it reads the body SENT: a list item paragraph moved out lands at column 0', () => {
    // `movedOut` sends a list item's paragraph after the item, indent gone: the draft's `  \\>` is
    // the sent `\\>`.
    const body = '- a\n\n  \\> b\n';
    expect(render(body, 'slack').converted as string).toContain('\n\\> b');
    expect(codes(body)).toContain('slack/escaped-quote-marker');
  });

  test('several lines are counted and the first two named', () => {
    const w = render('\\> one\n\\> two\n\\> three\n', 'slack').warnings.find((x) => x.code === 'slack/escaped-quote-marker');
    expect(w?.message).toStartWith('3 lines start');
    expect(w?.message).toContain('"> one", "> two", ...');
  });
});

/**
 * Slack's own link, `<url|label>`: drawn as the link Slack shows, sent as the bytes the agent wrote.
 * PROBED in the client: a label with spaces, one holding `*` and `_` (shown as characters) and one
 * that is another address all render as a link reading exactly the label. Asserted on the body the
 * window sends (`baselineFor`, `markdownFor`), which for Slack is the payload.
 */
describe("Slack's `<url|label>` is a link, and goes out in Slack's own form", () => {
  const PROBED = [
    'Update: <https://e.test/issue/ABC-1/some-slug|ABC-1> is done\n',
    'a <https://example.com/a|two words label> b\n',
    'a <https://example.com/b|*bold* _it_ label> b\n',
    'a <https://example.com/d|https://other.example.org/login> b\n',
  ];

  /** The first paragraph's inline nodes, as the editor holds them. */
  const inline = (doc: PmNode) => doc.content![0]!.content!;
  const linkOf = (node: PmNode) => node.marks?.find((m) => m.type === 'link');

  test('drawn as a link reading the label, its characters as written, pointing at the URL', () => {
    const cases: [string, string, string][] = [
      [PROBED[0]!, 'ABC-1', 'https://e.test/issue/ABC-1/some-slug'],
      [PROBED[1]!, 'two words label', 'https://example.com/a'],
      [PROBED[2]!, '*bold* _it_ label', 'https://example.com/b'],
      [PROBED[3]!, 'https://other.example.org/login', 'https://example.com/d'],
    ];
    for (const [body, label, href] of cases) {
      const linked = inline(baselineFor(render(body, 'slack')).doc).filter((n) => linkOf(n));
      expect(linked.map((n) => n.text), body).toEqual([label]);
      // Only the link: no emphasis is parsed inside a label, because Slack formats none.
      expect(linked[0]!.marks, body).toEqual([{ type: 'link', attrs: { href, angle: 'labelled' } }]);
    }
  });

  test('an unedited approval sends the bytes the agent wrote, `<url>` and outer emphasis included', () => {
    for (const body of [
      ...PROBED,
      'a <https://example.com/c> b\n',
      '**see <https://e.test/a|the docs> now**, then ~~<https://e.test/b|old>~~\n',
      '*x <https://e.test/a|a* b> c*\n',
      '<https://e.test/a|same>, <https://e.test/a|same>\n',
      '<https://e.test/a|https://e.test/a>\n',
      // The writer verifies escapes by reading the block back, which must read the link as Slack's
      // converter does, or it drops every escape in the block.
      '\\*URGENT\\* see <https://e.test/a|x>\n',
      'run \\`rm -rf\\` see <https://e.test/a|x>\n',
    ]) {
      const r = render(body, 'slack');
      expect(baselineFor(r).body, body).toBe(body);
      expect(r.converted, body).toBe(body);
    }
  });

  test('the look-alike label is the one the host check points at', () => {
    expect(render(PROBED[3]!, 'slack').warnings.map((w) => w.code)).toEqual(['link/text-host-mismatch']);
    expect(render(PROBED[0]!, 'slack').warnings).toEqual([]);
  });

  /** The document after `edit` changes the first paragraph's linked node, and the body it sends. */
  function editedDoc(body: string, edit: (node: PmNode) => void): { doc: PmNode; body: string } {
    const r = render(body, 'slack');
    const { doc } = baselineFor(r);
    edit(inline(doc).find((n) => linkOf(n))!);
    return { doc, body: markdownFor(r, doc) };
  }
  const edited = (body: string, edit: (node: PmNode) => void) => editedDoc(body, edit).body;

  test('an edited label goes out as `<url|newlabel>`, as written', () => {
    expect(edited(PROBED[0]!, (n) => (n.text = 'ABC-1 *done*'))).toBe(
      'Update: <https://e.test/issue/ABC-1/some-slug|ABC-1 *done*> is done\n'
    );
    // A bare `<url>` given a label becomes a labelled one.
    expect(edited('a <https://example.com/c> b\n', (n) => (n.text = 'the page'))).toBe(
      'a <https://example.com/c|the page> b\n'
    );
  });

  test('a new address keeps the form, because the dialog merges into the mark', () => {
    // `setLink({ href })` keeps the mark's other attributes (TipTap's `setMark`), so this is the
    // document the link dialog leaves.
    expect(edited(PROBED[0]!, (n) => (linkOf(n)!.attrs!.href = 'https://e.test/ABC-2'))).toBe(
      'Update: <https://e.test/ABC-2|ABC-1> is done\n'
    );
  });

  test('a label or address the form cannot hold goes out as a markdown link, every character kept', () => {
    // A `>` would end the label early; `mailto:` is not read in this form.
    const cases: [(n: PmNode) => void, string][] = [
      [(n) => (n.text = 'a > b'), 'Update: [a > b](https://e.test/issue/ABC-1/some-slug) is done\n'],
      [(n) => (n.text = 'a | b'), 'Update: [a | b](https://e.test/issue/ABC-1/some-slug) is done\n'],
      [(n) => (linkOf(n)!.attrs!.href = 'mailto:a@e.test'), 'Update: [ABC-1](mailto:a@e.test) is done\n'],
    ];
    for (const [edit, sent] of cases) {
      const { doc, body } = editedDoc(PROBED[0]!, edit);
      expect(body).toBe(sent);
      // The edited document reads back with every character and the link.
      expect(render(body, 'slack', doc).warnings).toEqual([]);
    }
  });

  test('emphasis on PART of a label has no spelling inside it: one link goes out, and the loss is reported', () => {
    const r = render(PROBED[1]!, 'slack');
    const { doc } = baselineFor(r);
    const para = doc.content![0]!;
    const [before, link, after] = para.content!;
    const href = linkOf(link!)!;
    para.content = [
      before!,
      { type: 'text', text: 'two ', marks: [href] },
      { type: 'text', text: 'words', marks: [{ type: 'bold' }, href] },
      { type: 'text', text: ' label', marks: [href] },
      after!,
    ];
    const body = markdownFor(r, doc);
    expect(body).toBe(PROBED[1]!);
    expect(render(body, 'slack', doc).warnings.map((w) => w.code)).toContain('body/mark-lost');
  });

  test('a code mark over the whole label is not written around the link, which would send its characters', () => {
    // `` `<url|label>` `` is a code span: Slack would show the brackets and the address as text.
    const { doc, body } = editedDoc(PROBED[1]!, (n) => n.marks!.unshift({ type: 'code' }));
    expect(body).toBe(PROBED[1]!);
    expect(render(body, 'slack', doc).warnings.map((w) => w.code)).toContain('body/mark-lost');
  });

  test('shapes nobody probed stay text: a second `|`, a blank label, a label over a line', () => {
    for (const body of [
      'a <https://e.test/a|x|y> b\n',
      'a <https://e.test/a| > b\n',
      'a <https://e.test/a|one\ntwo> b\n',
      '[see <https://e.test/a|x>](https://e.test/b)\n',
    ]) {
      const r = render(body, 'slack');
      const { doc, body: shown } = baselineFor(r);
      expect(shown, body).toBe(body);
      const angled = JSON.stringify(doc).includes('"angle"');
      expect(angled, body).toBe(false);
    }
  });

  test('only where the profile says so: elsewhere the span is the text it was written as', () => {
    for (const dest of ['jira', 'linear', 'github'] as const) {
      const doc = baselineFor(render(PROBED[0]!, dest)).doc;
      expect(JSON.stringify(doc), dest).not.toContain('"link"');
    }
  });
});
