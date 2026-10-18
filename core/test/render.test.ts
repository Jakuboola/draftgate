/**
 * `render()` against golden files: core and the converters, no UI.
 *
 * Not validated against `@atlaskit/adf-utils`: it pulls in `@atlaskit/feature-gate-js-client`,
 * fails to initialise offline, and false-positives on a bare inline `code` mark. Jira acceptance
 * comes from live probes, cited where each rule is tested.
 */

import { describe, expect, test } from 'bun:test';
import {
  render, UnknownDestinationError, resolveTheme, themeChoices, isBlankBody, type RenderResult,
} from '../src/render';
import { baselineFor, editorDocFor, fromEditorDoc } from '../src/editor';
import type { AdfDocument } from '../src/adf/types';
import type { PmNode } from '../src/prosemirror';
import {
  SUGGESTED_FIX_CODE, SUGGESTED_FIX_LABEL, sortWarnings, type Warning,
} from '../src/warnings';
import { convertAdfToMarkdown } from '../src/adf';
import { inspect } from '../src/profiles/jira';
import { isKnownDestination, profiles, type DestinationName } from '../src/profiles/index';
import { expectGolden, fixture, tortureFixture } from './golden';

const DESTINATIONS = Object.keys(profiles) as DestinationName[];

/** The warning codes one render reports. */
const codesOf = (md: string, d: DestinationName = 'jira') => render(md, d).warnings.map((w) => w.code);

describe('render(md, "jira") -- torture fixture', () => {
  const result = render(tortureFixture(), 'jira');

  test('converted ADF matches golden', () => {
    expectGolden('torture-fixture.jira.adf.json', result.converted);
  });

  test('warnings match golden', () => {
    expectGolden('torture-fixture.jira.warnings.json', result.warnings);
  });

  test('declares convert-and-replace and the contentFormat the adapter must set', () => {
    expect(result.mode).toBe('convert-and-replace');
    expect(result.extraToolInput).toEqual({ contentFormat: 'adf' });
  });

  test('is not blocked -- the fixture produces accepted ADF', () => {
    expect(result.blocked).toBe(false);
    expect(result.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  test('covers every block node type the fixture exists to exercise', () => {
    const types = new Set<string>();
    (function walk(n: any) {
      if (!n || typeof n !== 'object') return;
      if (n.type) types.add(n.type);
      for (const c of n.content ?? []) walk(c);
    })(result.converted);

    for (const t of [
      'heading',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
      'taskList',
      'taskItem',
      'blockquote',
      'codeBlock',
      'rule',
    ]) {
      expect(types).toContain(t);
    }
  });

  test('emits `blockquote` lowercase, the ADF node name, never `blockQuote`', () => {
    const json = JSON.stringify(result.converted);
    expect(json).toContain('"blockquote"');
    expect(json).not.toContain('blockQuote');
  });

  test('preserves task-list state', () => {
    const states = JSON.stringify(result.converted).match(/"state":"(\w+)"/g) ?? [];
    expect(states).toEqual(['"state":"TODO"', '"state":"DONE"']);
  });

  test('injects no zero-width spaces', () => {
    expect(JSON.stringify(result.converted)).not.toContain('​');
  });
});

describe('round-trip: ADF back to markdown', () => {
  test('markdown -> ADF -> markdown is stable apart from known, listed losses', () => {
    const src = tortureFixture();
    const back = convertAdfToMarkdown(render(src, 'jira').converted as any);
    expectGolden('torture-fixture.roundtrip.md.json', { markdown: back });

    // Usable, not identical. The known divergences, each verified by hand:
    //   1. a blank line appears before a nested list
    //   2. a bare URL becomes an explicit [url](url) link
    //   3. an inline image becomes its own block (ADF's mediaSingle is a top-level sibling)
    expect(back).toContain('| 09:12 | Alert fired | Jakub |'); // table survives
    expect(back).toContain('- [x] Checked task'); // task state survives
    expect(back).toContain('```python'); // code fence + language survive
    expect(back).toContain('> Blockquote with **bold** inside.'); // marks inside quote survive

    // The image URL survives the round trip.
    expect(back).toContain('https://example.com/a.png');
    expect(back).not.toContain('[Image: image]');
    expect(back).not.toContain('could not be resolved');
  });
});

describe('acceptance checks -- structurally valid ADF that Jira rejects', () => {
  test('blockquote holding a heading and a table produces blocking errors', () => {
    const r = render(fixture('blockquote-hostile.md'), 'jira');
    expectGolden('blockquote-hostile.jira.warnings.json', r.warnings);

    const codes = r.warnings.filter((w) => w.severity === 'error').map((w) => w.code);
    expect(codes).toContain('jira/blockquote-child-rejected');
    expect(r.blocked).toBe(true);
  });

  test('the offending node types are named, so the surface can point at them', () => {
    const r = render(fixture('blockquote-hostile.md'), 'jira');
    const rejected = r.warnings
      .filter((w) => w.code === 'jira/blockquote-child-rejected')
      .map((w) => w.nodeType);
    // A paragraph inside a blockquote is allowed and must not be flagged.
    expect(rejected).not.toContain('paragraph');
  });

  test('warnings carry a path into the converted tree', () => {
    const r = render(fixture('blockquote-hostile.md'), 'jira');
    for (const w of r.warnings.filter((x) => x.severity === 'error')) {
      expect(w.path).toMatch(/^doc\.content\[\d+\]/);
    }
  });
});

describe('external images (VERIFIED against live Jira)', () => {
  // Probed on a scratch issue in a JSM service_desk project: mediaSingle > media{type:"external",
  // url, alt} is accepted (201), stored verbatim, and rendered as <img src="<url>" alt="<alt>">
  // (expand=renderedFields). So embedding beats degrading.

  test('an external image becomes real external media, not literal text', () => {
    const r = render(fixture('images.md'), 'jira');
    expectGolden('images.jira.warnings.json', r.warnings);

    const json = JSON.stringify(r.converted);
    expect(json).toContain('"mediaSingle"');
    expect(json).toContain('https://example.com/d.png');
    // Not degraded to placeholder text.
    expect(json).not.toContain('[Image: diagram]');
    expect(r.blocked).toBe(false);
  });

  test('every external media node is reported as info', () => {
    const r = render(fixture('images.md'), 'jira');
    const embedded = r.warnings.filter((w) => w.code === 'jira/external-image-embedded');
    // Two: the https image and the jira-attachment: one. Collected from the converted document, so
    // it reports what Jira will fetch.
    expect(embedded).toHaveLength(2);
    expect(embedded.every((w) => w.severity === 'info')).toBe(true);
    expect(embedded.map((w) => w.message).join(' ')).toContain('https://example.com/d.png');
  });

  test('an already-uploaded jira-attachment: URL is not double-prefixed', () => {
    const r = render(fixture('images.md'), 'jira');
    expect(JSON.stringify(r.converted)).not.toContain('jira-attachment:jira-attachment:');
  });

  test('an image inside a fenced code block is left completely alone', () => {
    const r = render(fixture('images.md'), 'jira');
    const json = JSON.stringify(r.converted);
    // Still present as code text, never converted to media, never reported.
    expect(json).toContain('https://example.com/x.png');
    expect(r.warnings.map((w) => w.message).join(' ')).not.toContain('x.png');
    // Two media nodes: the https d.png and the jira-attachment: one. Not the fenced x.png.
    const media = json.match(/"mediaSingle"/g) ?? [];
    expect(media).toHaveLength(2);
  });
});

/**
 * The image Jira cannot fetch. `markdownToAdf` degrades a relative or `data:` image to the text
 * `[Image: alt]` and drops the URL. An image with a word in front of it lands mid-node, so a
 * detector anchored to the start of a text node (`/^\[Image(: |\])/`) misses it.
 */
describe('an image degraded to text is reported wherever it sits', () => {
  const codes = (md: string) =>
    render(md, 'jira').warnings.filter((w) => w.code === 'jira/image-degraded-to-text');

  test('at the START of a paragraph', () => {
    expect(codes('![diagram](./local.png)')).toHaveLength(1);
  });

  test('MID-sentence', () => {
    const w = codes('See ![diagram](./local.png) for details.');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warning');
  });

  test('at the END of a sentence, and after another mark', () => {
    expect(codes('trailing ![](./noalt.png)')).toHaveLength(1);
    expect(codes('**bold** then ![x](./a.png)')).toHaveLength(1);
  });

  test('a `data:` image mid-sentence too -- Jira cannot fetch that either', () => {
    expect(codes('See ![diagram](data:image/png;base64,AAAA) for details.')).toHaveLength(1);
  });

  test('ONE per lost image, not one per paragraph', () => {
    // Both are lost; one warning would under-report.
    const w = codes('two ![a](./a.png) and ![b](./b.png) here');
    expect(w).toHaveLength(2);
  });

  test('and it names the LOST URL, which is the actionable half', () => {
    // The detector is a difference (source images minus embedded media), not a scan for the
    // placeholder, so it can name the file the advice ("upload it as an attachment") needs.
    const w = codes('See ![diagram](./local.png) for details.');
    expect(w[0]!.message).toContain('./local.png');
    // Not the sentence around it.
    expect(w[0]!.message).not.toContain('for details');
  });

  test('a placeholder the REVIEWER typed is not reported at all', () => {
    // A scan of the converted text would warn twice on the second draft: once for the image, once
    // for the reviewer's own words.
    expect(codes('I removed [Image: the diagram] from the doc.')).toHaveLength(0);
    const both = codes('note [Image: old] and ![d](./x.png)');
    expect(both).toHaveLength(1);
    expect(both[0]!.message).toContain('./x.png');
  });

  test('and an image inside a code span is content, not a request to embed', () => {
    expect(codes('literal `![d](./x.png)` here')).toHaveLength(0);
  });

  test('prose that merely LOOKS like a placeholder is not an image', () => {
    // `handleImage` is the only producer of the placeholder, and every syntax reaching it has `![`;
    // an HTML <img> tag and a reference image pass through as literal text.
    expect(codes('text with a literal [Image: not really] in it')).toHaveLength(0);
    expect(codes('<img src="./a.png" alt="html">')).toHaveLength(0);
    expect(codes('![ref][r]\n\n[r]: ./local.png')).toHaveLength(0);
  });

  test('an http(s) image is embedded as media and is NOT a degradation', () => {
    const md = 'A real ![x](https://example.com/a.png) stays media';
    expect(codes(md)).toHaveLength(0);
    expect(codesOf(md)).toContain('jira/external-image-embedded');
  });
});

describe('empty localId is NOT a warning (VERIFIED)', () => {
  // Probed: accepted (201) and read back as "" on a scratch issue.
  test('a task list produces no warning at all', () => {
    const r = render(fixture('tasks.md'), 'jira');
    expect(r.warnings).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(JSON.stringify(r.converted)).toContain('"localId":""');
  });
});

describe('blockquote children from ordinary markdown (VERIFIED both ways)', () => {
  // Each case was posted to a scratch issue as ADF. The four marked as errors return 400
  // INVALID_INPUT, which loses the whole comment and names no node; the codeBlock case returns 201.
  const cases: [string, string, string | null][] = [
    ['rule',      '> before\n>\n> ---\n>\n> after\n',            'rule'],
    ['taskList',  '> - [ ] task in a quote\n',                      'taskList'],
    ['heading',   '> ## Heading\n',                                 'heading'],
    ['table',     '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n',    'table'],
    ['codeBlock', '> ```python\n> x = 1\n> ```\n',                  null],
  ];

  for (const [label, md, rejectedType] of cases) {
    test(`> ${label} -> ${rejectedType ? '400, flagged' : '201, allowed'}`, () => {
      const r = render(md, 'jira');
      const errs = r.warnings.filter((w) => w.severity === 'error');

      if (rejectedType === null) {
        expect(errs).toEqual([]);
        expect(r.blocked).toBe(false);
        return;
      }

      expect(r.blocked).toBe(true);
      expect(errs.map((w) => w.code)).toContain('jira/blockquote-child-rejected');
      expect(errs.map((w) => w.nodeType)).toContain(rejectedType);
    });
  }
});

describe('core is pure', () => {
  test('render is deterministic -- same input, byte-identical output', () => {
    // Module-level state (a counter, a cache, a sort in place on a shared array) changes a second
    // render in one process; `purity.test.ts` scans for the clock and randomness, not for that.
    const a = JSON.stringify(render(tortureFixture(), 'jira'));
    const b = JSON.stringify(render(tortureFixture(), 'jira'));
    expect(a).toBe(b);
  });

  test('unknown destination throws and names what is available', () => {
    expect(() => render('hi', 'teams')).toThrow(UnknownDestinationError);
    // Names the registered destinations so a typo is self-diagnosing.
    for (const known of DESTINATIONS) {
      expect(() => render('hi', 'teams')).toThrow(new RegExp(known));
    }
  });

  test('empty body still yields a valid ADF doc', () => {
    const r = render('', 'jira');
    expect(r.converted).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    });
  });
});

/**
 * A reviewer's edit that would not survive the trip out. Destination-agnostic, like `body/empty`:
 * markdown is the interchange for every destination. An `error`, so it sets `blocked`, which
 * disables Approve.
 */
describe('an edit markdown cannot carry blocks the send', () => {
  const p = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  /** Reachable by ordinary editing: a table cell is `block+`. */
  const quotedCell = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableHeader', content: [p('x'), { type: 'blockquote', content: [p('quoted')] }] }],
          },
        ],
      },
    ],
  } as unknown as PmNode;

  for (const destination of DESTINATIONS) {
    test(`${destination}: blocked, as an error, with the code`, () => {
      const r = render(fromEditorDoc(quotedCell), destination, quotedCell);
      const lost = r.warnings.filter((w) => w.code === 'body/structure-lost');
      expect(lost).toHaveLength(1);
      expect(lost[0]!.severity).toBe('error');
      expect(r.blocked).toBe(true);
    });
  }

  test('the message names the shape, not just that something went', () => {
    const r = render(fromEditorDoc(quotedCell), 'slack', quotedCell);
    const message = r.warnings.find((w) => w.code === 'body/structure-lost')!.message;
    expect(message).toContain('<blockquote>');
    expect(message).toContain('<tableHeader>');
    // And what to do: the reviewer is stuck until they act.
    expect(message).toContain('Undo');
  });

  test('WITHOUT the document nothing fires, because nothing is being converted', () => {
    // E.g. the CLI's re-render of an approved body, which holds the markdown and not the document.
    const r = render(fromEditorDoc(quotedCell), 'slack');
    expect(r.warnings.map((w) => w.code)).not.toContain('body/structure-lost');
    expect(r.blocked).toBe(false);
  });

  test('and a document that DID come from markdown never fires', () => {
    // Otherwise it would block ordinary editing.
    for (const body of ['# H\n\nHello.\n', tortureFixture()]) {
      for (const d of DESTINATIONS) {
        const doc = editorDocFor(render(body, d));
        const r = render(fromEditorDoc(doc), d, doc);
        expect(r.warnings.map((w) => w.code), `${d}`).not.toContain('body/structure-lost');
      }
    }
  });
});

describe('empty bodies', () => {
  // `render()`'s own rule, not a profile's, and it blocks, which disables Approve. A denial in
  // `runReview` alone would come after the reviewer clicked a live Approve and the window closed.
  test('every destination blocks a blank body', () => {
    for (const d of DESTINATIONS) {
      for (const body of ['', '   ', '\n\n\n', ' \t \n ']) {
        expect(render(body, d).blocked).toBe(true);
        expect(codesOf(body, d)).toContain('body/empty');
      }
    }
  });

  /**
   * A body of zero-width characters is blank. They are format characters, not White_Space, so
   * `'\u200b'.trim()` is `'\u200b'` (U+FEFF alone is trimmed). PROBED on a scratch issue: Jira
   * accepts such a comment (201) and stores it verbatim, so the recipient gets a blank comment.
   */
  test('and a body of nothing but zero-width characters is blank too', () => {
    const invisible = [
      '\u200b',          // ZERO WIDTH SPACE
      '\u200c',          // ZERO WIDTH NON-JOINER
      '\u200d',          // ZERO WIDTH JOINER
      '\u2060',          // WORD JOINER
      '\ufeff',          // ZERO WIDTH NO-BREAK SPACE (the BOM)
      '\u200b\u200d\ufeff',
      ' \u200b \n\t',   // mixed with real whitespace
    ];
    for (const d of DESTINATIONS) {
      for (const body of invisible) {
        expect(render(body, d).blocked, `${d}: ${JSON.stringify(body)}`).toBe(true);
        expect(codesOf(body, d)).toContain('body/empty');
      }
    }
  });

  test('but a zero-width character INSIDE real text changes nothing', () => {
    // Stripped for the emptiness test only: U+200D joins an emoji family into one glyph.
    for (const body of ['a\u200bb', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}', 'hi\ufeff']) {
      const r = render(body, 'jira');
      expect(r.blocked, JSON.stringify(body)).toBe(false);
      expect(r.canonical).toBe(body);
    }
  });

  test('ordinary text never trips it', () => {
    for (const d of DESTINATIONS) {
      expect(codesOf('Hello.', d)).not.toContain('body/empty');
      expect(render('Hello.', d).blocked).toBe(false);
    }
  });

  // Probed on a scratch issue: a `doc` holding one empty `paragraph` (what render('') produces)
  // returns 400 {"errors":{"comment":"Comment body can not be empty!"}}, as does a `doc` with no
  // content; a one-word control returns 201. `jira/empty-body` covers the other case: source that is
  // not blank but converts to nothing visible. It is guarded on the source so the two never both fire.
  test('jira/empty-body does not double up with body/empty', () => {
    expect(codesOf('', 'jira')).not.toContain('jira/empty-body');
    expect(codesOf('', 'jira').filter((c) => c.endsWith('empty')).length).toBe(1);
  });

  /**
   * `jira/empty-body` blocks; as a `warning` it would not disable Approve. Probed on a scratch
   * issue, one comment per shape: `doc > [paragraph []]` and `doc > []` are 400s, while an empty
   * blockquote, codeBlock, table, bulletList and taskList are all 201. So `> ` posts and shows the
   * reader nothing: the block rests on that, not on a 400.
   */
  test('every shape that renders to nothing is BLOCKED, not merely warned about', () => {
    for (const body of ['> ', '> \n', '```\n```\n', '- \n', '|  |\n| --- |\n|  |\n']) {
      const r = render(body, 'jira');
      const empty = r.warnings.find((w) => w.code === 'jira/empty-body');
      expect(empty, `no jira/empty-body for ${JSON.stringify(body)}`).toBeDefined();
      expect(empty!.severity, JSON.stringify(body)).toBe('error');
      expect(r.blocked, JSON.stringify(body)).toBe(true);
    }
  });

  test('and it does not claim Jira rejects them, because Jira accepts most of them', () => {
    const message = render('> ', 'jira').warnings.find((w) => w.code === 'jira/empty-body')!.message;
    expect(message).toContain('posts a blank comment');
    expect(message).toContain('nothing a reader would see');
  });

  test('an atom alone is NOT empty -- an uncaptioned image is a real comment', () => {
    for (const body of ['![shot](https://example.com/a.png)', '---']) {
      const r = render(body, 'jira');
      expect(r.warnings.map((w) => w.code)).not.toContain('jira/empty-body');
      expect(r.blocked).toBe(false);
    }
  });
});

describe('suggestedFix comes from the profile', () => {
  const BLOCKED = 'Intro.\n\n> ## Heading in a blockquote\n\nOutro.\n';

  test('the repair ends the way the body it repairs ends, in BOTH directions', () => {
    /*
     * `suggestFix` returns `null` when its output equals its input, so it must match the body's
     * trailing newline (`matchTrailingNewline`) as `markdownFor` does. Otherwise every blocked Jira
     * draft offers a repair whose only effect is a trailing newline, drawn by `FixDiff` as a changed
     * line.
     */
    expect(render(BLOCKED, 'jira').suggestedFix!.body.endsWith('\n')).toBe(true);
    const bare = BLOCKED.replace(/\n+$/, '');
    expect(render(bare, 'jira').suggestedFix!.body.endsWith('\n')).toBe(false);
  });

  test('and a draft the sanitiser cannot improve still offers NOTHING', () => {
    // Apply the repair, then ask again: if the trailing newlines disagreed this would never be null.
    const repaired = render(BLOCKED, 'jira').suggestedFix!.body;
    const second = render(repaired, 'jira');
    expect(second.blocked).toBe(false);
    expect(second.suggestedFix).toBeUndefined();
  });

  test('a blocked jira draft carries a repair that changes something', () => {
    const r = render(BLOCKED, 'jira');
    expect(r.blocked).toBe(true);
    expect(typeof r.suggestedFix?.body).toBe('string');
    expect(r.suggestedFix!.body).not.toBe(r.canonical);
    // The sanitiser degrades structure and never drops a word.
    expect(r.suggestedFix!.body).toContain('Heading in a blockquote');
    expect(r.suggestedFix!.body).toContain('Intro.');
    expect(r.suggestedFix!.body).toContain('Outro.');
    // And the repair is itself sendable.
    expect(render(r.suggestedFix!.body, 'jira').blocked).toBe(false);
  });

  test('and the repair NAMES itself, so the window does not have to', () => {
    // As `Warning.fixes` does; the audit log groups accepted repairs by this code.
    const fix = render(BLOCKED, 'jira').suggestedFix!;
    expect(fix.code).toBe(SUGGESTED_FIX_CODE);
    expect(fix.label).toBe(SUGGESTED_FIX_LABEL);
    // Never reworded: the log is keyed on it.
    expect(fix.code).toBe('render/suggested-fix');
  });

  test('a mention in the repaired region still pings, and its block keeps its escapes', () => {
    /*
     * A mention in the repair comes back as `[@Label](mention:ID)`; as `@Jane` Jira would get text
     * that notifies nobody. The literal `\*lit\*` stays literal rather than going out italic.
     */
    const md = '> ## Heading\n>\n> - item [@Jane](mention:abc123) and \\*lit\\*\n';
    const fix = render(md, 'jira').suggestedFix!.body;
    expect(fix).toBe('> **Heading**\n> \n> - item [@Jane](mention:abc123) and \\*lit\\*\n');
    const mentions = JSON.stringify(render(fix, 'jira').converted).match(/"type":"mention","attrs":\{[^}]*\}/g);
    expect(mentions).toEqual(['"type":"mention","attrs":{"id":"abc123","text":"@Jane"}']);
  });

  test('nothing is offered when nothing is wrong', () => {
    expect(render('Hello.', 'jira').suggestedFix).toBeUndefined();
  });

  test('a destination with no repair to offer simply offers none', () => {
    // Only Jira has a `suggestFix`; asking the others is not an error.
    const none = ['github', 'linear', 'slack'] as const;
    expect(DESTINATIONS.filter((d) => !('suggestFix' in profiles[d])).sort()).toEqual([...none]);
    for (const d of none) expect(render('', d).suggestedFix, d).toBeUndefined();
  });
});

/*
 * Block content indented under a list item belongs to the item (CommonMark, GitHub). Linear and
 * GitHub keep it there; Jira (a table in a list item is a 400) and Slack (flattens an item to text)
 * get it just after the item, with a disclosure. Every word survives and the numbering continues
 * (`order: 2`).
 */
describe('block content indented under a list item (moved out for Jira and Slack, warned)', () => {
  const md =
    'Steps:\n\n1. First step\n\n   | when | what |\n   | --- | --- |\n   | 09:12 | fired |\n\n2. Second step\n';

  test('jira receives a real table, just after its item', () => {
    const content = (render(md, 'jira').converted as AdfDocument).content;
    expect(content.map((n) => n.type)).toEqual(['paragraph', 'orderedList', 'table', 'orderedList']);
  });

  test('every word survives, and the round trip is stable', () => {
    const r = render(md, 'jira');
    for (const word of ['Steps:', 'First step', '09:12', 'fired', 'Second step']) {
      expect(JSON.stringify(r.converted)).toContain(word);
    }
    const once = convertAdfToMarkdown(r.converted as any);
    expect(convertAdfToMarkdown(render(once, 'jira').converted as any)).toBe(once);
  });

  test('the interrupted list CONTINUES its numbering rather than restarting', () => {
    const lists = (render(md, 'jira').converted as { content: { type: string; attrs?: { order?: number } }[] })
      .content.filter((n) => n.type === 'orderedList');
    expect(lists).toHaveLength(2);
    expect(lists[1]!.attrs?.order).toBe(2);
  });

  test('jira says so, and does not block', () => {
    const r = render(md, 'jira');
    expect(r.warnings.map((w) => w.code)).toEqual(['jira/list-item-block-moved-out']);
    expect(r.blocked).toBe(false);
  });

  test('slack sends it just after its item too, and says so', () => {
    const r = render(md, 'slack');
    expect(r.warnings.map((w) => w.code)).toEqual(['slack/list-item-block-moved-out']);
    expect(r.blocked).toBe(false);
    expect(baselineFor(r).body).toBe(
      'Steps:\n\n1. First step\n\n| when | what |\n| --- | --- |\n| 09:12 | fired |\n\n2. Second step\n'
    );
  });

  test.each(['linear', 'github'] as const)('%s sends the table inside the item', (destination) => {
    const r = render(md, destination);
    expect(r.warnings).toEqual([]);
    // As written: the table in the item, and the blank line before `2.` ending that list.
    expect(baselineFor(r).body).toBe(md);
  });
});

describe('resolveTheme -- the reviewer\'s preference, intersected with what is measured', () => {
  test('a destination with both themes follows the system', () => {
    expect(resolveTheme(['light', 'dark'], 'dark')).toBe('dark');
    expect(resolveTheme(['light', 'dark'], 'light')).toBe('light');
  });

  test('a LIGHT-ONLY destination stays light on a dark system', () => {
    // A dark palette nobody measured would be invented colour.
    expect(resolveTheme(['light'], 'dark')).toBe('light');
  });

  test('an explicit request beats the system preference', () => {
    expect(resolveTheme(['light', 'dark'], 'light', 'dark')).toBe('dark');
    expect(resolveTheme(['light', 'dark'], 'dark', 'light')).toBe('light');
  });

  test("but an explicit request cannot conjure a theme the profile has no source for", () => {
    expect(resolveTheme(['light'], 'light', 'dark')).toBe('light');
  });

  test("'system' defers, and an unknown system preference falls back to light", () => {
    expect(resolveTheme(['light', 'dark'], 'dark', 'system')).toBe('dark');
    expect(resolveTheme(['light', 'dark'], undefined)).toBe('light');
  });

  test('themeChoices offers system plus what the destination declares', () => {
    // The offer rule, beside the clamp: both read the same profile field.
    expect(themeChoices(['light', 'dark'])).toEqual(['system', 'light', 'dark']);
  });

  test('a destination with ONE measured palette gets no choices at all', () => {
    // Nothing to switch between, so no control. Unreachable while every profile declares both.
    expect(themeChoices(['light'])).toEqual([]);
    expect(themeChoices(['dark'])).toEqual([]);
  });
});

describe('one body, every destination, each verified live', () => {
  // Table: Jira 201, Slack renders a real table, Linear and GitHub verbatim. Heading in a quote: a
  // real 400 on Jira only. Image: Jira embeds external media (a real <img> in `renderedFields`),
  // Slack draws a link with no unfurl, Linear an inline image node, GitHub through its image proxy.
  const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const QUOTED_HEADING = '> ## Heading in a quote\n';
  const IMAGE = '![diagram](https://example.com/d.png)\n';
  const ROWS = {
    jira: { headingInQuoteBlocked: true, image: ['jira/external-image-embedded'], imageSent: 'media' },
    slack: { headingInQuoteBlocked: false, image: ['slack/image-becomes-link'], imageSent: 'verbatim' },
    linear: { headingInQuoteBlocked: false, image: [], imageSent: 'verbatim' },
    github: { headingInQuoteBlocked: false, image: ['github/image-proxied'], imageSent: 'verbatim' },
  } as const satisfies Record<DestinationName, unknown>;

  test.each(DESTINATIONS)('%s', (d) => {
    const row = ROWS[d];
    expect(render(TABLE, d).blocked).toBe(false);
    expect(render(QUOTED_HEADING, d).blocked).toBe(row.headingInQuoteBlocked);
    const image = render(IMAGE, d);
    expect(image.warnings.map((w) => w.code)).toEqual([...row.image]);
    if (row.imageSent === 'media') expect(JSON.stringify(image.converted)).toContain('mediaSingle');
    else expect(image.converted).toBe(IMAGE);
  });

});

describe('what each destination offers, from its profile', () => {
  /*
   * The window renders these verbatim (no `destination === ...`), so this table is where each claim
   * can be wrong.
   *  - previewFidelity: Jira and GitHub are measured off the rendered surface; Linear's palettes are
   *    the marketing site's CSS, not the issue editor's, so `indicative` although it declares both
   *    themes. The two fields are independent claims.
   *  - themes: Jira from `@atlaskit/tokens`; Linear its own stylesheets; Slack its client tokens
   *    (`rollup-style-plastic.*.min.css`; a custom sidebar theme defines no colour tokens); GitHub
   *    serves `data-light-theme` and `data-dark-theme`.
   *  - headingLevels: only levels a reader can tell apart. Slack draws `#` 18px/900, `##` 15px/900,
   *    `###`-`######` 15px/700 (live DOM), so three. GitHub measured 28 / 21 / 17.5 / 14 / 12.25 /
   *    11.9 px, so six.
   *  - marks: no underline, which markdown cannot carry although Jira and Linear render it.
   *  - blocks: Slack too, measured off a live render; its read-back API suggests it destroys tables.
   *  - inserts: emoji only. No image control (draftgate holds no credentials and cannot upload) and
   *    no mention (needs a user directory; the converter flattens a mention node to `@Label`).
   */
  const MARKS = ['bold', 'italic', 'strike', 'code', 'link'];
  const BLOCKS = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'rule'];
  const ROWS = {
    jira: { previewFidelity: 'probe-derived', headingLevels: [1, 2, 3, 4, 5, 6] },
    slack: { previewFidelity: 'indicative', headingLevels: [1, 2, 3] },
    linear: { previewFidelity: 'indicative', headingLevels: [1, 2, 3, 4, 5, 6] },
    github: { previewFidelity: 'probe-derived', headingLevels: [1, 2, 3, 4, 5, 6] },
  } as const satisfies Record<DestinationName, unknown>;

  test.each(DESTINATIONS)('%s', (d) => {
    const row = ROWS[d];
    const r = render('x', d);
    expect<unknown>({
      previewFidelity: r.previewFidelity,
      themes: [...r.themes],
      toolbar: { ...r.toolbar },
    }).toEqual({
      previewFidelity: row.previewFidelity,
      themes: ['light', 'dark'],
      toolbar: { headingLevels: [...row.headingLevels], marks: MARKS, blocks: BLOCKS, inserts: ['emoji'] },
    });
  });
});

describe('link/unsafe-href -- the AGENT\'s links, not just the reviewer\'s', () => {
  // `surface/src/href.ts` allowlists what the reviewer types; the agent's bytes are checked here,
  // or a `javascript:` link goes out verbatim looking like any other. The auto-approve surface
  // never loads `href.ts`.

  test('a javascript: link is reported, on every destination', () => {
    for (const d of DESTINATIONS) {
      expect(codesOf('See [click here](javascript:alert(1)) now.', d)).toContain('link/unsafe-href');
    }
  });

  test('data: and file: too, and an IMAGE target counts', () => {
    expect(codesOf('![x](data:text/html;base64,AAAA)')).toContain('link/unsafe-href');
    expect(codesOf('[x](file:///etc/passwd)')).toContain('link/unsafe-href');
  });

  /**
   * The angle-bracket destination form: the converter parses `[x](<javascript:alert(1)>)` to
   * `href: javascript:alert(1)`, which a check reading only the bare form misses.
   */
  test('the same link in angle brackets is reported too', () => {
    for (const md of [
      '[x](<javascript:alert(1)>)',
      '[x](  <javascript:alert(1)>  )',
      '![i](<javascript:alert(1)>)',
      '[x](<data:text/html,x>)',
      '[x](<vbscript:1>)',
    ]) {
      expect(codesOf(md), md).toContain('link/unsafe-href');
    }
  });

  test('and the bracket form of an ORDINARY link stays silent', () => {
    // The control: a check firing on every angle-bracketed link would be noise.
    for (const md of ['[ok](<https://example.com>)', 'Hi [@J](<mention:557058:abc>)']) {
      expect(codesOf(md), md).not.toContain('link/unsafe-href');
    }
  });

  test('it warns rather than blocks, because no destination has been PROBED for this', () => {
    const r = render('See [click](javascript:alert(1)).', 'jira');
    expect(r.warnings.find((w) => w.code === 'link/unsafe-href')!.severity).toBe('warning');
    expect(r.blocked).toBe(false);
  });

  test('ordinary links stay silent', () => {
    for (const md of [
      'See [docs](https://example.org).',
      'Mail [us](mailto:support@example.org).',
      'A picture ![x](https://example.com/a.png).',
      'A bare URL https://example.org here.',
    ]) {
      expect(codesOf(md)).not.toContain('link/unsafe-href');
    }
  });

  test('the schemes the PIPELINE generates are not reported as the agent\'s', () => {
    // `mention:` is the mention encoding; `jira-attachment:` the Jira profile's uploaded asset.
    expect(codesOf('Hi [@Jakub](mention:557058:abc).')).not.toContain('link/unsafe-href');
    expect(
      codesOf('![shot](jira-attachment:https://site.atlassian.net/rest/api/3/attachment/content/1)')
    ).not.toContain('link/unsafe-href');
  });

  test('one warning per distinct scheme, not per occurrence', () => {
    const md = '[a](javascript:1) [b](javascript:2) [c](vbscript:3)';
    expect(codesOf(md).filter((c) => c === 'link/unsafe-href')).toHaveLength(2);
  });
});

/**
 * Every repair draftgate offers must produce a document the editor can hold. The trap:
 * `slack/url-swallows-next-line`'s fix writes `[https://example.org](https://example.org)`, and an
 * autolinker that also sees the URL in the label gives the text node two `link` marks, which
 * ProseMirror forbids. With `enableContentCheck: true` the window degrades to reject-only; without
 * it the draft is replaced by an empty one. Probed: Jira accepts the duplicate (201) and normalises
 * it on read-back, so this is a ProseMirror rule. Walks every repair every profile offers.
 */
describe('every offered repair loads in the editor', () => {
  const drafts = [
    'See https://example.org\nNext sentence here.\n',
    'See [https://example.org](https://example.org)\nNext sentence.\n',
    '> ## Heading in a quote\n',
    '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n',
    '- [ ] task ![i](https://example.com/a.png)\n',
    // Blocked drafts a naive repair leaves blocked.
    '- [ ]',
    '- [ ]\n- [ ]',
    '> - [ ] a task\n> - [x] done',
    '> - [ ] a task\n> - [x] done\n>\n> # tail',
    '> - [ ] ',
    '>\n> - [ ] a\n>\n> ---',
    '> > nested\n',
    tortureFixture(),
  ];

  /** The whole matrix, rendered once for the four sweeps below. */
  const RENDERED = drafts.flatMap((body) =>
    DESTINATIONS.map((d) => ({ body, d, r: render(body, d) }))
  );
  /** The repairs one render offers, of both kinds, each labelled by what offered it. */
  const repairsOf = (r: RenderResult) => [
    ...(r.suggestedFix ? [{ label: 'suggestedFix', body: r.suggestedFix.body }] : []),
    ...r.warnings.flatMap((w) => (w.fixes ?? []).map((f) => ({ label: w.code, body: f.body }))),
  ];

  test('there are repairs to check, so this cannot pass vacuously', () => {
    const offered = RENDERED.flatMap(({ r }) => repairsOf(r));
    expect(offered.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * A suggested fix appears only on a blocked draft and must make it sendable (`suggestFix`'s
   * docstring). The shapes a repair can get wrong, each reproduced:
   *
   *   `- [ ]`                       repairable to the empty string; blocked on `body/empty`
   *   `- [ ]\n- [ ]`                the same
   *   `> - [ ] a\n>\n> # tail`       heading repaired, task list not: still blocked
   *   `> - [ ] `                    repairable to `">"`; blocked on `jira/empty-body`
   */
  test('a SUGGESTED fix always unblocks the draft it is offered for', () => {
    for (const { body, d, r } of RENDERED) {
      if (!r.suggestedFix) continue;
      expect(r.blocked, `${d}: a fix was offered for an unblocked draft`).toBe(true);
      const after = render(r.suggestedFix.body, d);
      expect(
        after.warnings.filter((w) => w.severity === 'error').map((w) => w.code),
        `${d} ${JSON.stringify(body)} -> ${JSON.stringify(r.suggestedFix.body)}`
      ).toEqual([]);
      expect(after.blocked, `${d} ${JSON.stringify(body)}`).toBe(false);
    }
  });

  test('and it never repairs a draft into an empty one', () => {
    // `- [ ]` repaired to "" is blocked again, on `body/empty`.
    for (const { body, d, r } of RENDERED) {
      if (!r.suggestedFix) continue;
      expect(isBlankBody(r.suggestedFix.body), `${d} ${JSON.stringify(body)}`).toBe(false);
    }
  });

  test('every repair CHANGES the draft it repairs', () => {
    // Both kinds. A per-warning fix remedies one warning, usually not an error, so it is held to
    // changing the draft, not to unblocking it.
    for (const { body, d, r } of RENDERED) {
      for (const repair of repairsOf(r)) {
        expect(repair.body, `${d} ${repair.label} ${JSON.stringify(body)}`).not.toBe(r.canonical);
      }
    }
  });

  test('the still-blocked drafts really do reach this sweep blocked, not merely unfixed', () => {
    // Vacuity control for the sweeps above.
    const stillBlocked = drafts.filter((b) => render(b, 'jira').blocked);
    expect(stillBlocked.length).toBeGreaterThanOrEqual(7);
  });

  test('and each one round-trips through the editor mapping unchanged in kind', () => {
    for (const { d, r } of RENDERED) {
        for (const repair of repairsOf(r)) {
          const doc = editorDocFor(r, repair.body);
          // No node may carry two marks of the same type (see the describe's docblock).
          const offenders: string[] = [];
          (function walkPm(n: PmNode) {
            const types = (n.marks ?? []).map((m) => m.type);
            if (new Set(types).size !== types.length) offenders.push(`${d}/${repair.label}: ${types.join(',')}`);
            for (const c of n.content ?? []) walkPm(c);
          })(doc);
          expect(offenders, `${d} ${repair.label}`).toEqual([]);
        }
    }
  });
});

/*
 * `sortWarnings`: the order the reviewer reads and the audit log records, so the identity must fail
 * here. Ties break by code point; `localeCompare` would depend on the machine's locale.
 */
describe('sortWarnings', () => {
  const w = (severity: 'error' | 'warning' | 'info', path?: string): Warning =>
    // Fabricated codes: this tests ordering, hence the cast.
    ({ code: `x/${severity}${path ?? ''}` as Warning['code'], severity, message: 'm', ...(path ? { path } : {}) });

  test('errors come before warnings, warnings before info', () => {
    const sorted = sortWarnings([w('info'), w('error'), w('warning')]);
    expect(sorted.map((x) => x.severity)).toEqual(['error', 'warning', 'info']);
  });

  test('within one severity it orders by path, and the identity does not', () => {
    const sorted = sortWarnings([w('error', 'b'), w('error', 'a'), w('error', 'c')]);
    expect(sorted.map((x) => x.path)).toEqual(['a', 'b', 'c']);
  });

  test('a missing path sorts before any path, not after', () => {
    const sorted = sortWarnings([w('error', 'a'), w('error')]);
    expect(sorted.map((x) => x.path)).toEqual([undefined, 'a']);
  });

  test('the input array is not mutated', () => {
    const input = [w('info'), w('error')];
    sortWarnings(input);
    expect(input.map((x) => x.severity)).toEqual(['info', 'error']);
  });

  test('the order is CODE POINTS, so it cannot move with the runtime locale', () => {
    // The pair that separates the two: in en-US collation "a" sorts before "B"; by code point
    // "B" (0x42) sorts before "a" (0x61). A locale-sensitive comparison answers the first.
    expect(sortWarnings([w('error', 'a'), w('error', 'B')]).map((x) => x.path)).toEqual(['B', 'a']);
    // And the same for a decorated letter, which collates next to its base letter and is far away
    // by code point.
    expect(sortWarnings([w('error', 'z'), w('error', 'ä')]).map((x) => x.path))
      .toEqual(['z', 'ä']);
  });

  test('render() returns its warnings through it', () => {
    // The order observed through `render()`, which an identity sorter fails.
    const r = render('> # heading in a quote\n\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n', 'jira');
    const severities = r.warnings.map((x) => x.severity);
    expect(severities.length).toBeGreaterThan(1);
    expect([...severities].sort((a, b) =>
      ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]
    )).toEqual(severities);
  });
});

/*
 * The six nesting `RULES` in `core/src/profiles/jira.ts`, the checker half of `adfSchema.ts`. Each is
 * an `error` on a probe: every pair below was POSTed to the JSM comment endpoint on a scratch issue,
 * status in the case name. Through the real `inspect` on hand-built ADF, since most fire on shapes
 * the converter never emits from markdown.
 */
describe('the Jira nesting rules, each against its own probe', () => {
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const doc = (...content: unknown[]) =>
    ({ version: 1, type: 'doc', content } as unknown as Parameters<typeof inspect>[0]);
  const heading = { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] };
  const table = {
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('c')] }] }],
  };
  const panelOf = (child: unknown) =>
    ({ type: 'panel', attrs: { panelType: 'info' }, content: [child] });
  const expand = { type: 'expand', attrs: { title: 'E' }, content: [p('inside')] };
  const listOf = (child: unknown) =>
    ({ type: 'bulletList', content: [{ type: 'listItem', content: [p('item'), child] }] });
  const cellWith = (child: unknown) => ({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('c'), child] }] }],
  });

  /** Every warning code `inspect` reports for a document. */
  const codes = (d: ReturnType<typeof doc>) => inspect(d, 'x', d).map((w) => w.code);

  const CASES: [string, Warning['code'], ReturnType<typeof doc>][] = [
    ['listItem > heading  (probed 400)', 'jira/list-item-block-child', doc(listOf(heading))],
    ['listItem > table    (probed 400)', 'jira/list-item-block-child', doc(listOf(table))],
    ['listItem > panel    (probed 400)', 'jira/list-item-block-child', doc(listOf(panelOf(p('x'))))],
    ['listItem > expand   (probed 400)', 'jira/list-item-block-child', doc(listOf(expand))],
    ['panel > table       (probed 400)', 'jira/panel-child-rejected', doc(panelOf(table))],
    ['panel > expand      (probed 400)', 'jira/panel-child-rejected', doc(panelOf(expand))],
    ['panel > blockquote  (probed 400)', 'jira/panel-child-rejected',
      doc(panelOf({ type: 'blockquote', content: [p('q')] }))],
    ['panel > panel       (probed 400)', 'jira/panel-child-rejected', doc(panelOf(panelOf(p('x'))))],
    ['tableCell > table   (probed 400)', 'jira/table-cell-forbidden-child', doc(cellWith(table))],
    ['taskList > bulletList (probed 400)', 'jira/task-list-child-rejected', doc({
      type: 'taskList', attrs: { localId: 'l' },
      content: [
        { type: 'taskItem', attrs: { localId: 't', state: 'TODO' }, content: [{ type: 'text', text: 'a' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('b')] }] },
      ],
    })],
    ['taskList > orderedList (probed 400)', 'jira/task-list-child-rejected', doc({
      type: 'taskList', attrs: { localId: 'l' },
      content: [
        { type: 'orderedList', content: [{ type: 'listItem', content: [p('b')] }] },
        { type: 'taskItem', attrs: { localId: 't', state: 'TODO' }, content: [{ type: 'text', text: 'a' }] },
      ],
    })],
    ['tableCell > expand  (probed 400)', 'jira/table-cell-forbidden-child', doc(cellWith(expand))],
    ['heading > mediaSingle (probed 400)', 'jira/block-child-in-inline-container',
      doc({
        type: 'heading',
        attrs: { level: 2 },
        content: [
          { type: 'text', text: 'h' },
          {
            type: 'mediaSingle',
            attrs: { layout: 'center' },
            content: [{ type: 'media', attrs: { type: 'external', url: 'https://x/a.png' } }],
          },
        ],
      })],
    ['blockquote > heading (probed 400)', 'jira/blockquote-child-rejected',
      doc({ type: 'blockquote', content: [heading] })],
  ];

  for (const [name, code, d] of CASES) {
    test(`${name} -> ${code}`, () => {
      expect(codes(d)).toContain(code);
      // ...as an `error`, which sets `blocked`.
      expect(inspect(d, 'x', d).find((w) => w.code === code)!.severity).toBe('error');
    });
  }

  test('the two probed CONTROLS are clean', () => {
    // `doc > paragraph` and `tableCell > nestedExpand`, both 201 in the same probe run.
    expect(codes(doc(p('control')))).toEqual([]);
    expect(
      codes(doc(cellWith({ type: 'nestedExpand', attrs: { title: 'E' }, content: [p('inside')] })))
    ).toEqual([]);
    // `taskList > [taskItem, taskList]` and `listItem > taskList`, both probed 201.
    const ti = { type: 'taskItem', attrs: { localId: 't', state: 'TODO' }, content: [{ type: 'text', text: 'a' }] };
    const tl = { type: 'taskList', attrs: { localId: 'l' }, content: [ti] };
    expect(codes(doc({ type: 'taskList', attrs: { localId: 'o' }, content: [ti, tl] }))).toEqual([]);
    expect(codes(doc(listOf(tl)))).toEqual([]);
  });

  test('every rule in the table is covered by a case above', () => {
    // A new rule must be named by a case.
    const covered = new Set(CASES.map(([, code]) => code));
    expect([...covered].sort()).toEqual([
      'jira/block-child-in-inline-container',
      'jira/blockquote-child-rejected',
      'jira/list-item-block-child',
      'jira/panel-child-rejected',
      'jira/table-cell-forbidden-child',
      'jira/task-list-child-rejected',
    ]);
  });
});

describe('isKnownDestination rejects Object.prototype members', () => {
  test('every real name is known', () => {
    for (const name of DESTINATIONS) expect(isKnownDestination(name)).toBe(true);
  });

  test('and a prototype member is not, which `in` would have accepted', () => {
    // With `in`, `--dest toString` would pass, narrow to DestinationName and index `profiles` to a
    // Function, which crashes the first caller.
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(name in profiles, `${name} really is reachable through the prototype`).toBe(true);
      expect(isKnownDestination(name)).toBe(false);
    }
  });

  test('nor is an ordinary unknown name', () => {
    expect(isKnownDestination('teams')).toBe(false);
    expect(isKnownDestination('')).toBe(false);
  });
});
