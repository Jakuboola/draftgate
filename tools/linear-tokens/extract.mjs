/**
 * Extract Linear's own token values for the variables `linear.css` uses.
 *
 * Dev instrument: not a dependency, not in the plugin tree. It needs no `npm install`: it fetches
 * Linear's public stylesheets and parses them. `tokens.json` beside it is the committed evidence, so
 * the guard in `surface/harness/tokens.test.ts` works in a fresh clone with no network.
 *
 * Run: `bun run tokens:linear`.
 *
 * ## The marketing sheet: colour, with a caveat
 *
 * `static.linear.app/web/_next/static/css/*` is the CSS for linear.app, the marketing site: a
 * Next.js build whose theme blocks sit beside `--color-bg-marketing`, `--header-bg`,
 * `--homepage-outer-padding` and `--page-max-width`. It is Linear's own design system, but the
 * site's, not the issue editor's. A third party's reading of it (such as `shadcn.io/design/linear`)
 * adds a hop; going direct removes the third party, not the marketing site.
 *
 * It is still worth using for colour, checkably: three of the four body colours of that third-party
 * reading are byte-identical to this source (`--color-text-primary` #282a30,
 * `--color-text-tertiary` #6f6e77, `--color-bg-tint` #f4f4f5). `previewFidelity` stays `indicative`,
 * and the sheet says so.
 *
 * ## The client sheet: geometry and type, no colour
 *
 * `https://linear.app/login` links `static.linear.app/client/assets/style-<hash>.css` with
 * `id=app-stylesheet`. It is unauthenticated, ~511 KB and the issue editor's own CSS (real
 * `.editor h1` rules), so it supplies geometry and typography. The heading weight is the value of a
 * rule read by name: see `heading` below.
 *
 * It answers no colour, for two facts the run checks:
 *
 *   - it declares no `[data-theme]` block, so it cannot supply a light/dark pair;
 *   - every colour token in it is registered as `initial` (`--color-text-primary: initial`), because
 *     Linear uses StyleX and the ThemeProvider fills the values in at runtime. Reading `initial` as
 *     a value would be the same error as reading editor-core's stubbed providers as Jira's
 *     measurements.
 *
 * ## The editor's colours are not here
 *
 * There is a genuine editor token block (`--editor-*`) and its geometry is real (see EDITOR below),
 * but its two colour entries indirect through obfuscated runtime slots:
 *
 *   --editor-text-color: var(--sx-3zwjav)
 *   --editor-surface-background: var(--sx-1ubxoo9)
 *
 * and every `--sx-*` is declared empty in the shipped CSS (`--sx-3zwjav: ;`). Reading them returns
 * nothing, and nothing is not a value.
 */

import { writeFileSync } from 'node:fs';
import { cssRules, selectorItems, servedFace, smoothingOf } from '../../surface/harness/vendorCss.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const HOME = 'https://linear.app/';

/**
 * The colour tokens `linear.css` needs, and what each is FOR.
 *
 * Deliberately a short list. Linear's theme blocks carry ~46 tokens and most of them are site
 * chrome -- headers, panels, overlays, marketing backgrounds -- with no counterpart in a preview of
 * a comment. Pulling them all in would make the sheet look derived while most of it went unused.
 */
const WANTED = [
  // Body pane.
  '--color-text-primary', //    the comment text
  '--color-text-tertiary', //   blockquote text, and anything quiet
  '--color-border-primary', //  rules, table cells, the blockquote bar
  '--color-bg-tint', //         inline code and header cells
  '--color-bg-primary', //      the pane itself
  '--color-link-primary', //    links in the body
  // Chrome: draftgate's OWN controls in Linear's idiom. Brand, not a render measurement.
  '--color-brand-bg', //        the primary button. #7070ff light, #5e6ad2 dark -- see below.
  '--color-brand-text', //      text on it
  '--color-accent-hover', //    the primary button's hover
  '--color-bg-secondary', //    the neutral button's hover
];

/**
 * The editor's own tokens, the only ones whose name pins the property they drive:
 * `--editor-block-menu-offset`, `--editor-todolist-checkbox-width`, `--editor-bullet-disc-offset`,
 * `--editor-last-invisible-paragraph-spacing`. Linear ships the editor component's token block on
 * the marketing site although the pages do not render it.
 *
 * They are declared but never consumed in this CSS (the rules that read them live in the app
 * bundle), so the values are Linear's and which property each drives is an inference from its name.
 * Only the ones where that inference is forced are wired into the sheet: line-height, list-inset,
 * todolist-checkbox-width, letter-spacing, block-radius.
 *
 * `--editor-block-spacing: 1rem` is not wired. It plainly means space between blocks, but which
 * margins, on which elements, and where its `-large` (1.375x) and `-small` (0.375x) variants apply
 * is a guess, and a plausible token family gets values wrong in a way that survives, because its
 * neighbours come out right. Everything found is written to `tokens.json`, so the unwired ones are
 * on record. (`linear.css` spaces its blocks from the client sheet's own rules below, at the value
 * a live comment shows.)
 */
const EDITOR_WIRED = [
  '--editor-line-height',
  '--editor-list-inset',
  '--editor-todolist-checkbox-width',
  '--editor-letter-spacing',
  '--editor-block-radius',
];

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

/** The declarations inside the FIRST block whose selector matches, as a plain object. */
function declarations(css, selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const start = m.index + m[0].length;
  const body = css.slice(start, css.indexOf('}', start));
  const out = {};
  for (const d of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) out[d[1]] = d[2].trim();
  return out;
}

const home = await get(HOME);
// Content-hashed filenames, so they cannot be pinned -- discover them from the page every run.
const urls = [...new Set([...home.matchAll(/https:\/\/static\.linear\.app[^"']*?\.css/g)].map((m) => m[0]))];
if (!urls.length) {
  console.error('extract: no static.linear.app stylesheet linked from the homepage. Markup changed.');
  process.exit(1);
}

const sheets = await Promise.all(urls.map(get));

/** The one sheet carrying the theme blocks. Located by content, never by filename. */
const themed = sheets.find((css) => /\[data-theme=["']?dark["']?\]\s*\{/.test(css));
if (!themed) {
  console.error(`extract: no [data-theme=dark] block in any of the ${urls.length} stylesheets.`);
  process.exit(1);
}

const light = declarations(themed, /\[data-theme=["']?light["']?\]\s*\{/g);
const dark = declarations(themed, /\[data-theme=["']?dark["']?\]\s*\{/g);

const missing = WANTED.filter((v) => !light?.[v] || !dark?.[v]);
if (missing.length) {
  console.error(`extract: no value in both themes for ${missing.join(', ')} -- Linear's tokens moved.`);
  process.exit(1);
}

/** Every `--editor-*` Linear declares, wired or not, so the unused ones stay on record. */
const editor = {};
for (const css of sheets) {
  for (const d of css.matchAll(/(--editor-[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
    editor[d[1]] ??= d[2].trim();
  }
}

const unwired = EDITOR_WIRED.filter((v) => editor[v] === undefined);
if (unwired.length) {
  console.error(`extract: editor token(s) missing: ${unwired.join(', ')}.`);
  process.exit(1);
}

/*
 * The CLIENT stylesheet: the editor's real geometry, and NOT its colour. See the header.
 *
 * Located by the `id=app-stylesheet` link on the login page, which needs no session. The file is
 * content-hashed, so it is discovered every run like the marketing sheets.
 */
const LOGIN = 'https://linear.app/login';
const login = await get(LOGIN);
const clientUrl = /id=app-stylesheet[^>]*?href=(https:\/\/static\.linear\.app\/client\/assets\/[^\s">]+\.css)/.exec(login)?.[1];
if (!clientUrl) {
  console.error(`extract: no id=app-stylesheet link on ${LOGIN}. Markup changed.`);
  process.exit(1);
}
const client = await get(clientUrl);
/* Every rule of the client sheet, parsed ONCE -- see `surface/harness/vendorCss.ts`. */
const clientRules = cssRules(client, clientUrl);

/** Declarations from EVERY block whose selector matches exactly, merged. Order: first wins. */
function tokensIn(selectorRe, prefixRe) {
  const out = {};
  for (const r of clientRules) {
    if (!selectorRe.test(r.selector)) continue;
    for (const [k, v] of Object.entries(r.declarations)) if (prefixRe.test(k)) out[k] ??= v;
  }
  return out;
}

// `.editor` itself carries the per-level heading tokens; `:root` carries the editor defaults and
// the weight scale. Anything on a `.sx-*` class is a StyleX per-component override the app assigns
// in JavaScript, so it is NOT collected: which one an issue COMMENT gets is not answerable here.
const clientEditor = tokensIn(/^\.editor$/, /^--editor-/);
const clientRoot = tokensIn(/^:root(,|$)/, /^--(editor|font-weight|font-size)-/);

/*
 * The code block's own rules: `.editor pre`, its `code` and its line numbers, each the
 * FIRST rule with exactly that selector. First and not merged, because the same selectors recur in
 * `@media print` and `@media (hover:none)` with other values, and `cssRules` finds a nested rule by
 * its selector alone.
 */
const firstRule = (selector) => clientRules.find((r) => r.selector === selector)?.declarations;
const codeBlock = {
  pre: firstRule('.editor pre'),
  code: firstRule('.editor pre code'),
  lineNumber: firstRule('.editor pre .cb-line-number'),
};
const lostCode = Object.entries(codeBlock).filter(([, d]) => !d).map(([k]) => k);
if (lostCode.length) {
  console.error(`extract: the client sheet no longer has the code block's ${lostCode.join(', ')} rule.`);
  process.exit(1);
}

/*
 * Block spacing: every margin rule on the editor's shared root, verbatim but for the
 * CSS-module hash, which scopes each item of a selector list (`._sharedEditorRoot_<hash> h1`) and
 * changes with every build. That is the headings' own margins, the reset that zeroes every other
 * block, and the adjacency rules that space them; `linear.css` takes the ones a live comment
 * shows, and `tokens.test.ts` ties them together. A `span` is left out: the autocomplete chip's
 * negative margin is on the same root and is no block's. And the `.editor` rules that set a
 * heading's margin inside a container (a quote, a cell, a callout), which live outside that root.
 */
const EDITOR_ROOT = /\._sharedEditorRoot_[\w-]+ ?/g;
const setsMargin = (r) => Object.keys(r.declarations).some((k) => /^margin(-top|-bottom)?$/.test(k));
const onRoot = (r) => /^\._sharedEditorRoot_[\w-]+[ >](?!span\b)/.test(r.selector);
const headingInContainer = (r) => r.selector.startsWith('.editor ') && r.selector.includes('.heading-node');
const blockSpacing = clientRules
  .filter((r) => setsMargin(r) && (onRoot(r) || headingInContainer(r)))
  .map((r) => ({ selector: r.selector.replace(EDITOR_ROOT, ''), declarations: r.declarations }));
const lostSpacing = ['h1', 'h2', 'h3', 'h4,h5,h6', 'p,dl,ol,ul,pre,blockquote'].filter(
  (s) => !blockSpacing.some((r) => r.selector === s)
);
if (lostSpacing.length) {
  console.error(`extract: the client sheet no longer has the editor root's ${lostSpacing.join(' / ')} margin rule.`);
  process.exit(1);
}

/*
 * The heading's own typography: `.editor .heading-node`, the class every heading level carries in a
 * comment, verbatim. It sets the weight and outranks the bare
 * `h1,h2,h3,h4,h5,h6 { font-weight: var(--font-weight-medium) }`, which looks like the answer
 * because `.editor hN` sets none. Found by the declaration, as `smoothingOf` finds smoothing: the
 * same selector recurs with `position: relative` alone.
 *
 * It must also be the only editor rule weighting a heading, or the run stops: a rule styling the
 * heading itself (last compound `.heading-node` or `hN`, `:has()` and `:not()` arguments aside) from
 * inside `.editor` or the shared root. `.editor h5.heading-node { font-weight: 500 }` would outrank
 * this one at one level while the record kept saying 600 for all six, and two copies would leave the
 * winner to an `@media` this parser cannot see.
 */
const inEditor = (item) => /^(\.editor|\._sharedEditorRoot_[\w-]+)[\s>]/.test(item);
const stylesHeading = (item) =>
  /(^|[^\w-])h[1-6](?![\w-])|\.heading-node(?![\w-])/.test(
    item.replace(/:(has|not)\([^()]*\)/g, '').split(/\s*[\s>+~]\s*(?![^()]*\))/).pop()
  );
const headingWeights = clientRules.filter(
  (r) =>
    'font-weight' in r.declarations &&
    selectorItems(r.selector).some((i) => inEditor(i.trim()) && stylesHeading(i.trim()))
);
if (headingWeights.length !== 1 || headingWeights[0].selector !== '.editor .heading-node') {
  console.error(
    `extract: the editor rules weighting a heading are ${headingWeights.map((r) => r.selector).join(' | ') || 'none'}, ` +
      "not `.editor .heading-node` alone. Do NOT keep linear.css's heading weight as sourced."
  );
  process.exit(1);
}
const heading = headingWeights[0].declarations;

const NEEDED = ['--editor-h1-font-size', '--editor-h1-line-height', '--editor-h3-font-size'];
const gone = NEEDED.filter((v) => clientEditor[v] === undefined);
if (gone.length) {
  console.error(`extract: the client sheet no longer declares ${gone.join(', ')} on .editor.`);
  process.exit(1);
}

/*
 * The claim the header rests on, asserted rather than trusted: this sheet supplies no colour.
 *
 * If Linear ever stops registering these as `initial`, that is a real change in what is
 * measurable and it should stop the run rather than quietly leave the note above wrong.
 */
/*
 * A value that is actually a COLOUR, not merely one that is not `initial`.
 *
 * Not `!== 'initial'`, which fires on `--color-bg-quinary: 0` -- a StyleX build artifact, and not
 * a colour by any reading. A guard that cries wolf on the compiler's own output gets deleted, so it
 * asks the narrower question: does this token now carry something a browser would paint?
 */
const isColour = (v) => /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i.test(v);
const colourish = Object.entries(tokensIn(/^:root(,|$)/, /^--color-/)).filter(([, v]) =>
  isColour(v)
);
if (colourish.length) {
  console.error(
    'extract: the client sheet now gives real values for ' +
      `${colourish.map(([k, v]) => `${k}: ${v}`).join(', ')} -- it used to register every colour as ` +
      '`initial` and fill them in JS. Re-read the header: the light/dark source may have changed.'
  );
  process.exit(1);
}
const clientThemes = [...client.matchAll(/\[data-theme=["']?(\w+)["']?\]/g)].map((m) => m[1]);

/**
 * How Linear RASTERISES its text -- the client sheet's `body` rule, which no token above carries.
 *
 * `body { -webkit-font-smoothing: antialiased; ... }`. Without it Chromium on macOS dilates every
 * stem: at 1x on the dark palette the same paragraph paints about a third more ink. Slack's pane
 * has the same property, read by the same `smoothingOf`, into the same shape.
 */
const smoothing = smoothingOf(clientRules);
if (!smoothing) {
  console.error(
    'extract: no `body` rule in the client sheet declares -webkit-font-smoothing -- Linear changed ' +
      "how it rasterises text. Do NOT keep linear.css's value as sourced."
  );
  process.exit(1);
}

/**
 * The FONT FILE the editor is drawn in, as Linear serves it -- family, version and variation axes
 * read off its own tables by `surface/harness/fontFile.ts`, the same reader `tokens.test.ts` points
 * at the file this window bundles.
 *
 * Linear serves a VARIABLE Inter: a static one pinned at one optical size draws headings 1-4% wider
 * than Linear's (opsz follows the font size there) and cannot reach the body's 450. The file's own
 * licence field says OFL, which is what lets the window bundle the real thing.
 */
/*
 * And its ITALIC twin, `InterVariable-Italic.woff2`: with no italic face bundled,
 * Chromium slants the upright glyphs, which are not Inter's italic letterforms.
 */
const [face, italicFace] = await Promise.all(
  ['normal', 'italic'].map((style) =>
    servedFace(clientRules, { family: 'Inter Variable', style }).catch((e) => {
      console.error(`extract: Linear's ${style} Inter Variable face: ${e.message}`);
      process.exit(1);
    })
  )
);

const pick = (values) => Object.fromEntries(WANTED.map((v) => [v, values[v]]));
writeFileSync(
  join(HERE, 'tokens.json'),
  JSON.stringify(
    {
      source: HOME,
      retrieved: new Date().toISOString().slice(0, 10),
      light: pick(light),
      dark: pick(dark),
      editor,
      /*
       * The editor's own CSS. Geometry and typography only -- `themes: []` is the recorded fact
       * that it declares no `[data-theme]` block, which is half of why colour still comes from the
       * marketing source above.
       */
      client: {
        source: clientUrl,
        themes: [...new Set(clientThemes)],
        editor: clientEditor,
        root: clientRoot,
        /* `.editor pre`, `.editor pre code` and `.editor pre .cb-line-number`, verbatim. */
        codeBlock,
        /* Every block margin on the editor's shared root, its hash taken out of the selector. */
        blockSpacing,
        /* `.editor .heading-node`, the rule that weights every heading level, verbatim. */
        heading,
        /* The `body` rule verbatim, and every other rule that sets smoothing. */
        ...smoothing,
        /* The editor's face as served: `src`, then the file's own family, version, axes, glyphs. */
        face,
        /* The same, for the italic face. */
        italicFace,
      },
    },
    null,
    1
  ) + '\n'
);

const block = (values) => WANTED.map((v) => `  ${v}: ${values[v]};`).join('\n');

console.log('/* GENERATED by tools/linear-tokens/extract.mjs from linear.app\'s own CSS. Do not hand-edit. */');
console.log(`[data-destination="linear"] {\n${block(light)}\n}`);
console.log(`[data-destination="linear"][data-theme="dark"] {\n${block(dark)}\n}`);
console.log('\n/* Editor tokens wired into the sheet (values Linear\'s, property inferred from the name): */');
for (const v of EDITOR_WIRED) console.log(`  ${v}: ${editor[v]};`);

console.log(`\n/* From the CLIENT stylesheet (${clientUrl}) -- the editor's own, consumed by real`);
console.log(" * `.editor hN` rules, so the property is MEASURED rather than inferred. No colour: this");
console.log(` * sheet declares ${clientThemes.length} [data-theme] blocks and registers every --color-* as \`initial\`. */`);
for (const [k, v] of Object.entries(clientEditor)) console.log(`  ${k}: ${v};`);
for (const [k, v] of Object.entries(clientRoot)) console.log(`  ${k}: ${v};   /* :root */`);
for (const [k, v] of Object.entries(heading)) console.log(`  ${k}: ${v};   /* .editor .heading-node */`);
