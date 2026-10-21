/**
 * The warning registry (`WARNING_CODES`) against what `render()` does. Per code:
 *  - `reach`: a `markdown` code has a minimal body below that produces it; an `adf` code is produced
 *    by no shipped fixture and no body below; an `editor` code is reached in `editor.test.ts`.
 *  - `carries`: no emitted warning sets an optional field its row does not list.
 *  - `silencedByRoundTrip`: derived and compared in `surface/silencedWarnings.test.ts`.
 * Every emit site's code is a key (by type), and every key is named by some emit site.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, proseWarnings } from '../src/render';
import { patchWarnings } from '../src/patch';
import { profiles } from '../src/profiles';
import { fromEditorDoc, toEditorDoc } from '../src/editor';
import { WARNING_CODES, type Carried, type Warning, type WarningCode } from '../src/warnings';
import { shippedBodies } from './golden';

const CODES = Object.keys(WARNING_CODES) as WarningCode[];
/*
 * Every optional `Warning` field, as a `Record<Carried, true>` so a new member of `Carried` is a
 * compile error here; an array missing one would quietly narrow the `carries` sweep.
 */
const OPTIONAL = Object.keys({
  path: true,
  nodeType: true,
  unverified: true,
  editorPath: true,
  fixes: true,
  field: true,
} satisfies Record<Carried, true>) as readonly Carried[];

/** The smallest body per markdown-reachable code, and the destination it is reachable on. */
const REACHES: Partial<Record<WarningCode, [string, string]>> = {
  'body/empty': ['jira', ''],
  'link/unsafe-href': ['linear', '[x](javascript:alert(1))\n'],
  'link/text-host-mismatch': ['github', '[https://a.test/x](https://b.test/x)\n'],
  'jira/blockquote-child-rejected': ['jira', '> # h\n'],
  'jira/task-item-media-only': ['jira', '- [ ] ![i](https://e.test/a.png)\n- [ ] b\n'],
  'jira/task-item-nested-list-unnested': ['jira', '- [ ] a\n  - b\n'],
  'jira/list-item-block-moved-out': ['jira', '- a\n  > quoted\n'],
  'jira/code-span-emphasis-lost': ['jira', 'a **`x` and words** b\n'],
  // Markup with nothing a reader would see. Not `''`: that is `body/empty`, which fires first.
  'jira/empty-body': ['jira', '```\n```\n'],
  'jira/image-degraded-to-text': ['jira', '![i](img/a.png)\n'],
  'jira/external-image-embedded': ['jira', '![i](https://e.test/a.png)\n'],
  'slack/image-becomes-link': ['slack', '![i](https://e.test/a.png)\n'],
  // `### / ####`, not `## / ###`: `##` renders at its own weight and collapses against nothing.
  'slack/heading-level-collapsed': ['slack', '### a\n\n#### b\n'],
  // One task item makes the whole bullet run a checklist, so `b` arrives as an unchecked to-do.
  'slack/list-item-becomes-task': ['slack', '- [ ] a\n- b\n'],
  'slack/escaped-quote-marker': ['slack', 'Result:\n\\> not a quote\n'],
  'slack/url-swallows-next-line': ['slack', 'see https://a.test/x\nnext\n'],
  'slack/url-label-elided': ['slack', 'https://a.test/a/b/c/d/e\n'],
  'slack/list-item-block-moved-out': ['slack', '- a\n  ```\n  x\n  ```\n'],
  // GitHub's five. `html-rendered` and `html-stripped` get separate bodies: one renders the element,
  // the other deletes it and keeps the text, and one body producing both would not say which tag did which.
  'github/alert-becomes-callout': ['github', '> [!NOTE]\n> careful\n'],
  'github/html-rendered': ['github', 'a <kbd>K</kbd> b\n'],
  'github/html-stripped': ['github', 'a <u>underlined</u> b\n'],
  'github/image-proxied': ['github', '![x](https://e.test/a.png)\n'],
  'github/html-comment-hidden': ['github', 'a <!-- x --> b\n'],
  // The length refusals, each one past its destination's probed limit.
  'jira/body-too-long': ['jira', 'x'.repeat(32_768)],
  'jira/body-near-limit': ['jira', 'x'.repeat(30_000)],
  'slack/body-too-long': ['slack', 'x'.repeat(12_001)],
  'linear/body-too-long': ['linear', 'x'.repeat(100_001)],
  'github/body-too-long': ['github', 'x'.repeat(262_145)],
};

/** Every warning `render()` emits for every shipped body on every destination, plus `REACHES`. */
function everyWarning(): [string, Warning][] {
  const out: [string, Warning][] = [];
  const bodies: [string, string][] = [
    ...shippedBodies(),
    ...Object.entries(REACHES).map(([code, [, body]]): [string, string] => [`reaches/${code}`, body]),
  ];
  for (const dest of Object.keys(profiles)) {
    for (const [label, body] of bodies) {
      for (const w of render(body, dest).warnings) out.push([`${dest} ${label}`, w]);
    }
  }
  return out;
}

describe('the registry is closed both ways', () => {
  test('every key is spelled by an emit site somewhere in core/src', () => {
    // Every emit site's code is a key by type; a key nobody emits the type cannot see, so read the source.
    const root = join(import.meta.dir, '..', 'src');
    const files: string[] = [];
    (function walk(dir: string) {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) {
          if (f.name !== 'adf') walk(join(dir, f.name));
        } else if (f.name.endsWith('.ts') && f.name !== 'warnings.ts') files.push(join(dir, f.name));
      }
    })(root);
    const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const code of CODES) {
      expect(source.includes(`'${code}'`), `${code} is a registry row nothing emits`).toBe(true);
    }
  });

  test('every emitted code is a key (a runtime check on what the type already says)', () => {
    for (const [where, w] of everyWarning()) {
      expect(CODES, `${where}: ${w.code}`).toContain(w.code);
    }
  });
});

describe('reach', () => {
  test('every code declares one', () => {
    for (const code of CODES) expect(['markdown', 'editor', 'adf', 'prose', 'patch']).toContain(WARNING_CODES[code].reach);
  });

  test('every `markdown` code has a minimal body here, and it produces the code', () => {
    for (const code of CODES) {
      if (WARNING_CODES[code].reach !== 'markdown') continue;
      const entry = REACHES[code];
      expect(entry, `${code} is declared markdown-reachable but has no body in REACHES`).toBeDefined();
      const [dest, body] = entry!;
      expect(render(body, dest).warnings.map((w) => w.code), `${code} <- ${dest} ${JSON.stringify(body)}`).toContain(code);
    }
  });

  test('an `adf` code is produced by NO markdown input this repo has', () => {
    /*
     * Five Jira nesting rules markdown cannot reach (`jira/block-child-in-inline-container` only
     * because `hoistMedia` moves the media first). Each is a probed 400, exercised on hand-built ADF
     * in `render.test.ts`. The day markdown reaches one, its row must say `markdown` and gain a body.
     */
    const seen = new Set(everyWarning().map(([, w]) => w.code));
    const adfOnly = CODES.filter((c) => WARNING_CODES[c].reach === 'adf').sort();
    expect(adfOnly).toEqual([
      'jira/block-child-in-inline-container',
      'jira/list-item-block-child',
      'jira/panel-child-rejected',
      'jira/table-cell-forbidden-child',
      // `taskList > bulletList`: the converter un-nests it and discloses that as
      // `jira/task-item-nested-list-unnested`, so the rule itself is defence behind the fixer.
      'jira/task-list-child-rejected',
    ]);
    for (const code of adfOnly) expect(seen.has(code), `${code} was reached from markdown`).toBe(false);
  });

  // A `prose` code comes from a field that is not the body. Both directions: markdown never produces
  // it, and `proseWarnings` does; the first half alone passes on a code nothing emits.
  test('a `prose` code is unreachable from markdown, and IS produced by proseWarnings', () => {
    const seen = new Set(everyWarning().map(([, w]) => w.code));
    const proseOnly = CODES.filter((c) => WARNING_CODES[c].reach === 'prose');
    expect(proseOnly).toEqual(['prose/empty', 'prose/too-long', 'prose/line-break', 'prose/control-character']);
    for (const code of proseOnly) expect(seen.has(code), `${code} was reached from markdown`).toBe(false);

    const out = proseWarnings([{ field: 'fields.summary', value: '' }], 'jira');
    expect(out.map((w) => w.code)).toEqual(['prose/empty']);
    // It names the field (`carries: ['field']`): a route may have several.
    expect(out[0]!.field).toBe('fields.summary');
    expect(out[0]!.severity).toBe('error');

    const long = proseWarnings([{ field: 'title', value: 'x'.repeat(513) }], 'linear', 'mcp__l__save_issue');
    expect(long.map((w) => [w.code, w.field])).toEqual([['prose/too-long', 'title']]);

    const unseen = proseWarnings([{ field: 'title', value: 'one\ntwo\u202E' }], 'github');
    expect(unseen.map((w) => [w.code, w.field])).toEqual([
      ['prose/line-break', 'title'],
      ['prose/control-character', 'title'],
    ]);
  });

  // A `patch` code comes from an edit's text, never from a body or a line; both directions, as above.
  test('a `patch` code is unreachable from markdown, and IS produced by patchWarnings', () => {
    const seen = new Set(everyWarning().map(([, w]) => w.code));
    const patchOnly = CODES.filter((c) => WARNING_CODES[c].reach === 'patch');
    expect(patchOnly).toEqual(['patch/empty-text']);
    for (const code of patchOnly) expect(seen.has(code), `${code} was reached from markdown`).toBe(false);
    const edit = { index: 2, label: 'Insert after', empty: 'refused' as const };
    const out = patchWarnings([{ field: 'patch.2.text', edit, value: '' }]);
    expect(out.map((w) => [w.code, w.field, w.severity])).toEqual([['patch/empty-text', 'patch.2.text', 'error']]);
    expect(proseWarnings([{ field: 'patch.2.text', value: '' }], 'linear').map((w) => w.code)).not.toContain(
      'patch/empty-text'
    );
  });

  // Jira answers 400 to `"   "` as to `""` (probed), so a rule keyed on `=== ''` would pass it; the
  // window's placeholder cannot draw that case either.
  test('whitespace and zero-width are empty here, exactly as they are in a body', () => {
    const codes = (v: string) => proseWarnings([{ field: 'f', value: v }], 'jira').map((w) => w.code);
    for (const blank of ['', '   ', '\n', '\u200b', '\ufeff']) {
      expect(codes(blank), `${JSON.stringify(blank)} should read as empty`).toEqual(['prose/empty']);
    }
    for (const real of ['x', ' x ', '0']) {
      expect(codes(real), `${JSON.stringify(real)} should NOT`).toEqual([]);
    }
  });

  // An absent field ("leave it alone") is not an empty one ("blank it"); `extractProse` omits a field
  // the payload does not carry.
  test('an empty LIST warns about nothing', () => {
    expect(proseWarnings([], 'jira')).toEqual([]);
  });

  test('an `editor` code is not produced by markdown alone, and is produced with a document', () => {
    const seen = new Set(everyWarning().map(([, w]) => w.code));
    const editorOnly = CODES.filter((c) => WARNING_CODES[c].reach === 'editor');
    expect(editorOnly).toEqual(['body/structure-lost', 'body/mark-lost', 'body/text-changed']);
    for (const code of editorOnly) expect(seen.has(code)).toBe(false);
    // The one gesture: a blockquote inside a task item, which markdown has no spelling for.
    const doc = toEditorDoc('- [ ] x\n', {}) as any;
    doc.content[0].content[0].content.push({
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
    });
    const codes = render('- [ ] x\n', 'linear', doc).warnings.map((w) => w.code);
    expect(codes).toContain('body/structure-lost');
    // `body/text-changed`: a linked text holding a `]` goes into the label bare, ends it early and
    // reads back as characters. If the writer learns to escape it, pick another gap. Asked with the
    // document marked unbuilt too, as the load path calls it.
    const linked = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see ]x', marks: [{ type: 'link', attrs: { href: 'https://e.test' } }] }] }],
    } as any;
    const sent = fromEditorDoc(linked);
    for (const built of [true, false]) {
      expect(render(sent, 'github', linked, built).warnings.map((w) => w.code)).toContain('body/text-changed');
    }
  });

  // A strike on `(b)` in `a(b)c` is written `a~~(b)~~c`, which does not flank, so every destination
  // reads the tildes as text. Asserted on `render()` with a real document, as the window reads it.
  test('a mark markdown cannot carry is a non-blocking warning, on every destination', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: '(b)', marks: [{ type: 'strike' }] },
            { type: 'text', text: 'c' },
          ],
        },
      ],
    } as any;
    for (const dest of Object.keys(profiles)) {
      const r = render('a~~(b)~~c\n', dest, doc);
      const lost = r.warnings.filter((w) => w.code === 'body/mark-lost');
      expect(lost.map((w) => w.severity), dest).toEqual(['warning']);
      expect(lost[0]!.message, dest).toContain('strikethrough');
      expect(lost[0]!.editorPath, dest).toEqual([0]);
      expect(r.blocked, dest).toBe(false);
      // The same document with the strike on whole words survives, so it reports nothing.
      const whole = toEditorDoc('a ~~(b)~~ c\n', {}) as any;
      const codes = render('a ~~(b)~~ c\n', dest, whole).warnings.map((w) => w.code);
      expect(codes, dest).not.toContain('body/mark-lost');
    }
  });
});

describe('carries', () => {
  test('no emitted warning sets an optional field its row does not list', () => {
    for (const [where, w] of everyWarning()) {
      const allowed = new Set<string>(WARNING_CODES[w.code].carries);
      for (const field of OPTIONAL) {
        if ((w as unknown as Record<string, unknown>)[field] !== undefined) {
          expect(allowed.has(field), `${where}: ${w.code} carries \`${field}\`, which its row does not list`).toBe(true);
        }
      }
    }
  });

  test('the single-purpose fields belong to exactly the codes listed here', () => {
    // Literals, apart from the registry: moving a field onto another code changes this test too.
    const carrying = (f: Carried) => CODES.filter((c) => (WARNING_CODES[c].carries as readonly string[]).includes(f));
    expect(carrying('editorPath')).toEqual(['body/structure-lost', 'body/mark-lost', 'body/text-changed']);
    expect(carrying('field')).toEqual([
      'prose/empty', 'prose/too-long', 'prose/line-break', 'prose/control-character',
      'patch/empty-text',
    ]);
    expect(carrying('fixes')).toEqual(['slack/url-swallows-next-line']);
    // `path`/`nodeType` are Jira's tree walk and nothing else: they index ADF, not the editor.
    for (const code of carrying('path')) expect(WARNING_CODES[code].owner).toBe('jira');
    expect(carrying('path')).toEqual(carrying('nodeType'));
    // Declared and set by nothing. If a code starts setting it, the sweep above fails until its row says so.
    expect(carrying('unverified')).toEqual([]);
  });

  test('a field name is only ever on a prose- or patch-reach code', () => {
    // `field` is a tool-input path and `path` a path into converted ADF; a body code carrying `field`
    // would be using one for the other's job.
    for (const code of CODES) {
      if ((WARNING_CODES[code].carries as readonly string[]).includes('field')) {
        expect(['prose', 'patch']).toContain(WARNING_CODES[code].reach);
      }
    }
  });

  test('an editorPath is only ever on an editor-reach code', () => {
    for (const code of CODES) {
      if ((WARNING_CODES[code].carries as readonly string[]).includes('editorPath')) {
        expect(WARNING_CODES[code].reach).toBe('editor');
      }
    }
  });
});
