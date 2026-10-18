/**
 * The editor's schema against `core`'s vocabulary: `PM_KNOWN` (`core/src/prosemirror.ts`) is what
 * `toEditorDoc` believes the editor accepts, `editorExtensions` (`surface/src/Editor.tsx`) what it
 * registers. Nothing else ties them together.
 *
 * A name in `PM_KNOWN` with no extension makes ProseMirror throw, and `EditorBoundary` turns the
 * window reject-only for every draft holding that node. A registered mark `core` cannot serialise
 * lets the reviewer apply formatting `fromEditorDoc` drops, so the send goes out without it.
 *
 * `getSchema` touches no DOM (the one `document` use is inside `addNodeView`), so this runs in
 * `bun test`; the import is the check that stays true.
 */

import { describe, expect, test } from 'bun:test';
import { createDocument, getSchema } from '@tiptap/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PM_KNOWN } from '../core/src/prosemirror';
import { editorOptionsFor, fromEditorDoc, toEditorDoc, type PmNode } from '../core/src/editor';
import { CODE_EXCLUDES, editorExtensions } from './src/Editor';
import { profiles } from '../core/src/profiles';
import type { CodeSpanMarks } from '../core/src/index';

// The mention descriptors live on the profiles; Slack's and Linear's editors are built with them.
const SLACK_MENTIONS = profiles.slack.mentions;
const LINEAR_MENTIONS = profiles.linear.mentions;

/** Jira's schema: draws pictures, and `code` combines with `link` only. See `schemaFor`. */
const mediaSchema = getSchema(editorExtensions(true, undefined, 'link-only'));

/**
 * Slack's schema, built with the arguments the Slack window passes (its mention tokens included).
 * `editorExtensions(false)` registers no `image` node, the only thing keeping a picture out of a
 * Slack draft: neither `fromEditorDoc` nor `lostInMarkdown` has a fallback. Judged against the
 * media schema, a document that needs `image` would pass.
 */
const slackSchema = getSchema(editorExtensions(false, SLACK_MENTIONS, 'any'));
/**
 * A schema built the way one destination's editor is, from both facts that change it.
 * `codeSpanMarks` decides whether `code` excludes every other mark: `**`x` y**` loads under `'any'`
 * and is stripped by `'link-only'`. Not memoised: `editorExtensions` already is.
 */
const schemaFor = (rendersMedia: boolean, codeSpanMarks: CodeSpanMarks) =>
  rendersMedia && codeSpanMarks === 'link-only'
    ? mediaSchema
    : !rendersMedia && codeSpanMarks === 'any'
      ? slackSchema
      : getSchema(editorExtensions(rendersMedia, undefined, codeSpanMarks));
const nodes = new Set(Object.keys(mediaSchema.nodes));
const marks = new Set(Object.keys(mediaSchema.marks));

describe('the editor registers everything core will hand it', () => {
  test('every PM_KNOWN node type exists in the schema', () => {
    const missing = [...PM_KNOWN].filter((type) => !nodes.has(type));
    expect(
      missing,
      `core's toEditorDoc emits these and the editor has no extension for them, so ProseMirror ` +
        `will throw on any draft containing one and the window degrades to reject-only: ${missing.join(', ')}`
    ).toEqual([]);
  });

  test('and the set is not trivially small, so this cannot pass vacuously', () => {
    expect(PM_KNOWN.size).toBeGreaterThanOrEqual(19);
  });
});

describe('the marks core can serialise', () => {
  // `MARK_TO_PM` maps `strong -> bold` and `em -> italic`; `strike`, `code` and `link` keep their
  // names. These five plus `mention` (a node) are the whole inline vocabulary.
  test('bold, italic, strike, code and link are all registered', () => {
    for (const mark of ['bold', 'italic', 'strike', 'code', 'link']) {
      expect(marks.has(mark), `${mark} is not in the editor's schema`).toBe(true);
    }
  });

  test('underline is NOT registered, and that is the point', () => {
    // Markdown has no underline, so `fromEditorDoc` would drop it (see `Editor.tsx`'s header).
    // StarterKit ships the mark, so a dependency bump could bring it back.
    expect(marks.has('underline')).toBe(false);
  });
});

describe('the schema holds nothing core cannot round-trip', () => {
  test('every registered node is one core knows about', () => {
    // `text` is in `PM_KNOWN`, and the table kit adds nothing beyond what is listed.
    const unexpected = [...nodes].filter((type) => !PM_KNOWN.has(type));
    expect(
      unexpected,
      `the editor registers these and core's PM_KNOWN does not list them. Either core should be ` +
        `able to produce them, or the extension is dead weight: ${unexpected.join(', ')}`
    ).toEqual([]);
  });
});

/** Slack's own link syntax, labelled and bare, and one inside emphasis. */
const ANGLE_LINKS = 'see <https://e.test/a|ABC-1> and <https://e.test/b>, **<https://e.test/c|in *bold*>**\n';

describe("Slack's angle links keep their spelling through the editor", () => {
  /*
   * The link mark's `angle` attribute makes an approval send `<url|label>`. ProseMirror silently
   * drops an undeclared attribute, so a schema without it sends `[ABC-1](https://e.test/a)`.
   * Asserted on the body that comes back out.
   */
  test('loaded under the Slack schema and serialised, the body is the bytes the agent wrote', () => {
    const doc = toEditorDoc(ANGLE_LINKS, editorOptionsFor(profiles.slack));
    const loaded = createDocument(doc as never, slackSchema, {}, { errorOnInvalidContent: true });
    expect(fromEditorDoc(loaded.toJSON() as PmNode) + '\n').toBe(ANGLE_LINKS);
  });
});

/**
 * Every document `core` can hand the editor must be valid under its schema, not merely built from
 * registered names: TipTap's `taskItem` is `paragraph block*` where ADF's is inline-only, and a
 * block `image` makes `heading > [text, image]` invalid.
 *
 * Such a document still loads (`enableContentCheck` defaults to false) and throws later from
 * `DOMObserver.flush()`, which has no try/catch: a clicked checkbox shows ticked, logs `Uncaught
 * RangeError: Invalid content for node type taskItem`, and goes out unchecked with no `edited`
 * badge. `errorOnInvalidContent: true` asks ProseMirror up front.
 */
describe('every shipped draft loads under the schema, strictly', () => {
  const ROOT = join(import.meta.dir, '..');
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const field = (p: string, k: string) => String(JSON.parse(read(p))[k]);

  const bodies: Array<[string, string]> = [
    ['docs/torture-fixture.md', read('docs/torture-fixture.md')],
    ['core/test/fixtures/tasks.md', read('core/test/fixtures/tasks.md')],
    ['core/test/fixtures/images.md', read('core/test/fixtures/images.md')],
    ['core/test/fixtures/blockquote-hostile.md', read('core/test/fixtures/blockquote-hostile.md')],
    ['core/test/fixtures/list-item-hostile.md', read('core/test/fixtures/list-item-hostile.md')],
    ['docs/examples/jira-payload.json', field('docs/examples/jira-payload.json', 'commentBody')],
    ['docs/examples/slack-payload.json', field('docs/examples/slack-payload.json', 'message')],
    // Shapes invalid unless the converter maps them, each in the container that makes it so.
    ['a bare checklist', '- [ ] Unchecked\n- [x] Checked\n'],
    ['an image in a task item', '- [ ] look ![shot](https://example.com/b.png)\n- [ ] second\n'],
    ['an image-only task item', '- [ ] ![a](https://example.com/a.png)\n'],
    ['an image in a heading', '# Title ![img](https://example.com/a.png)\n'],
    ['an image mid-sentence', 'before ![img](https://example.com/a.png) after\n'],
    ['an image in a table cell', '| a |\n| --- |\n| ![i](https://example.com/1.png) |\n'],
    ['an image in a quote', '> quoted ![i](https://example.com/1.png)\n'],
    ['a nested list', '1. one\n   - two\n     - three\n'],
    // The three nested-checklist shapes, each a different mapping in `prosemirror.ts`.
    ['a checklist under a bullet', '- a\n  - [ ] b\n'],
    ['a checklist under a checklist', '- [ ] a\n  - [ ] b\n'],
    ['a bullet under a checklist', '- [ ] a\n  - b\n- [ ] c\n'],
    ['an expand, which degrades to a blockquote', 'Patch:\n\n+++ b/src/app.ts\n\nrest\n'],
    ['nothing at all', ''],
    // A link labelled with its own URL: an autolinker firing inside the label would give the text
    // two `link` marks, which ProseMirror forbids.
    ['a link labelled with its own url', 'See [https://example.org](https://example.org) now.\n'],
    ['the same, mid-paragraph', 'a [http://x.test](http://x.test) b [https://y.test](https://y.test)\n'],
    // Nested same-type emphasis: `b` carries em,em in the ADF, the duplicate the dedupe still removes.
    ['nested same-type emphasis', '*a *b* c*\n'],
    // An angle-bracketed image URL holding a space, easy for `markdownLinkSpans` to miss. If
    // `imagesToLinks` misses it, the image reaches Slack's schema (no `image`) and the window goes
    // reject-only with no warning. Fails only while Slack is judged against Slack's schema.
    ['an angle-bracketed image url with a space', 'a ![alt](<https://e.test/a b.png>) b\n'],
    ['the same with no alt text', 'a ![](<https://e.test/a b.png>) b\n'],
    // Emphasis across a code span: for Linear and GitHub `strong` stays on the span, which a `code`
    // mark with TipTap's `excludes: '_'` would drop on load.
    ['emphasis across a code span', 'a **`x` and words** b\n'],
    ['a linked code span inside emphasis', '[**`c` x**](https://e.test)\n'],
    // `listItemBlocks` keeps a nested list in the item for Slack, Linear and GitHub, building
    // `taskItem > bulletList`; Jira un-nests it first.
    ['a bullet list nested under a checklist item', '- [ ] a\n  - b\n  - c\n- [x] d\n'],
    ['a checklist nested under a checklist item', '- [ ] a\n  - [ ] b\n- [ ] c\n'],
    // Linear and GitHub keep every block inside the item, Slack and Jira move some out; a checklist
    // item with no text needs an empty first paragraph.
    [
      'blocks inside list and checklist items',
      '1. step\n   ```sql\n   select 1\n   ```\n   then\n   > q\n\n   | a | b |\n   | --- | --- |\n2. next\n' +
        '- [ ] a\n\n  more\n  ```\n  x\n  ```\n  ## H\n- [x]\n  > only a quote\n',
    ],
    // Must not become `taskItem > bulletList`, which `paragraph block*` refuses.
    ['a checklist item with no text over a nested list', '- [ ]\n  - b\n'],
    // Must not become `taskItem > []`; Slack's move-out produces the same shape.
    ['an empty checklist item', '- [ ]\n- [x] b\n'],
    ['a checklist item whose only block Slack moves out', '- [x]\n  ```\n  x\n  ```\n'],
    ['angle links, labelled and bare', ANGLE_LINKS],
  ];

  /*
   * One row per distinct editor input, derived from the profiles through `editorOptionsFor` (the one
   * place profile fields become pipeline flags), so a future schema-affecting fact is picked up
   * without a hand-kept list. Destinations with identical options build the same document against
   * the same schema, so they share a row; a profile that differs gets its own.
   */
  const classes = Map.groupBy(Object.entries(profiles), ([, profile]) => JSON.stringify(editorOptionsFor(profile)));

  test('the profiles fall into more than one editor input, and each key is the whole input', () => {
    expect(classes.size).toBeGreaterThan(1);
    // The key is the whole input only while every option survives JSON (no RegExp, no undefined).
    for (const [key, [[, profile]]] of classes) expect(JSON.parse(key)).toEqual(editorOptionsFor(profile));
  });

  for (const [label, body] of bodies) {
    for (const group of classes.values()) {
      const [[, profile]] = group;
      test(`${label}, as ${group.map(([name]) => name).join(' and ')} get it`, () => {
        const doc = toEditorDoc(body, editorOptionsFor(profile));
        // Against THIS input's schema: the media-bearing one accepts an `image` a Slack editor
        // refuses, and the combinable one a `code`+`bold` span a Jira editor refuses.
        const loaded = createDocument(
          doc as never,
          schemaFor(profile.rendersMedia, profile.codeSpanMarks),
          {},
          { errorOnInvalidContent: true }
        );
        // `check()` walks the loaded document rather than the JSON.
        loaded.check();
        expect(loaded.childCount).toBeGreaterThan(0);
      });
    }
  }

  test('and the strict flag really is what makes this fail', () => {
    // Vacuity control: `taskItem > text` loads under the default and throws on `check()`; strictly
    // it refuses up front.
    const invalid = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [{ type: 'taskItem', content: [{ type: 'text', text: 'x' }] }],
        },
      ],
    };
    expect(() =>
      createDocument(invalid as never, mediaSchema, {}, { errorOnInvalidContent: true })
    ).toThrow();
    const lax = createDocument(invalid as never, mediaSchema, {}, { errorOnInvalidContent: false });
    expect(() => lax.check()).toThrow(/taskItem/);
  });
});

/**
 * What `rendersMedia: false` removes. `editorExtensions(false)` filters on `DeferredImage.name`, and
 * nothing downstream backs it up (no image-to-link rewrite in `fromEditorDoc`, no `image` exemption
 * in `lostInMarkdown`): a filter that matched nothing would leave a dead Approve on
 * `body/structure-lost`. Both directions, so removing too much fails too.
 */
describe('the editor vocabulary follows the profile', () => {
  test('a destination that draws no picture registers no image node, and loses nothing else', () => {
    expect(Object.keys(mediaSchema.nodes)).toContain('image');
    expect(Object.keys(slackSchema.nodes)).not.toContain('image');
    const missing = Object.keys(mediaSchema.nodes).filter((n) => !(n in slackSchema.nodes));
    expect(missing).toEqual(['image']);
    // Marks are untouched: the destination fact is about media, not about formatting.
    expect(Object.keys(slackSchema.marks).sort()).toEqual(Object.keys(mediaSchema.marks).sort());
  });

  test('and the sets are memoised, so `useEditor` does not remount every render', () => {
    // `useEditor` remounts on an extensions identity change: a fresh array would remount per keystroke.
    expect(editorExtensions(false, undefined, 'any')).toBe(editorExtensions(false, undefined, 'any'));
    expect(editorExtensions(true, undefined, 'any')).toBe(editorExtensions(true, undefined, 'any'));
    // With the real mention descriptors too: the memo keys on their identity through a `WeakMap`.
    for (const mentions of [SLACK_MENTIONS, LINEAR_MENTIONS] as const) {
      expect(editorExtensions(false, mentions, 'any')).toBe(editorExtensions(false, mentions, 'any'));
      expect(editorExtensions(true, mentions, 'any')).toBe(editorExtensions(true, mentions, 'any'));
    }
    // The axes stay distinct: a memo that ignored `codeSpanMarks` would hand Jira Linear's schema.
    expect(editorExtensions(true, SLACK_MENTIONS, 'any')).not.toBe(
      editorExtensions(false, SLACK_MENTIONS, 'any')
    );
    expect(editorExtensions(true, SLACK_MENTIONS, 'any')).not.toBe(
      editorExtensions(true, SLACK_MENTIONS, 'link-only')
    );
  });

  test('and `codeSpanMarks` is what decides whether a code span can carry emphasis', () => {
    // TipTap's `Code` ships `excludes: '_'`, so without `CombinableCode` `strong` is dropped from a
    // code span at load. Asserted on both schemas.
    const combinable = getSchema(editorExtensions(true, undefined, 'any'));
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'code' }, { type: 'bold' }] }],
        },
      ],
    };
    // On the document, not `code.excluded` (the value handed to `.extend()`).
    const kept = createDocument(json as never, combinable, {}, { errorOnInvalidContent: true });
    expect(kept.firstChild!.firstChild!.marks.map((m) => m.type.name).sort()).toEqual([
      'bold',
      'code',
    ]);
    expect(() =>
      createDocument(json as never, mediaSchema, {}, { errorOnInvalidContent: true })
    ).toThrow();
  });

  test('and `link` is NOT excluded from a code span, in either schema', () => {
    // ADF's `code` combines with `link`, and `handleLink` emits it. Excluding `link` would make
    // `[`x`](url)` a document the window refuses ("the editor could not load this draft").
    const linked = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://e.test' } }],
            },
          ],
        },
      ],
    };
    for (const [name, schema] of [
      ['link-only (jira)', mediaSchema],
      ['any (linear, github)', getSchema(editorExtensions(true, undefined, 'any'))],
    ] as const) {
      const doc = createDocument(linked as never, schema, {}, { errorOnInvalidContent: true });
      expect(
        doc.firstChild!.firstChild!.marks.map((m) => m.type.name).sort(),
        `${name} dropped a mark from a linked code span`
      ).toEqual(['code', 'link']);
    }
  });

  test('and the excluded set is exactly the marks ADF refuses beside a code span', () => {
    // Pinned: widening `CODE_MARK_COMBINES_WITH` needs a fresh probe (`adfSchema.ts`).
    expect(CODE_EXCLUDES).toBe('bold italic strike');
  });

  test('the token path filters the image node exactly like the constant path does', () => {
    // With and without tokens, so a second path beside the memo cannot drop the filter.
    const viaConstant = Object.keys(getSchema(editorExtensions(false, undefined, 'any')).nodes).sort();
    const viaTokens = Object.keys(
      getSchema(editorExtensions(false, SLACK_MENTIONS, 'any')).nodes
    ).sort();
    expect(viaTokens).toEqual(viaConstant);
    expect(viaTokens).not.toContain('image');
  });
});
