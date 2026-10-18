/**
 * Read GitHub's own numbers off GitHub's own rendering surface.
 *
 * Dev instrument: not a dependency, not in the plugin tree, in the shape of `tools/jira-ruler`. It
 * builds the vendor's real rendering surface as a throwaway artifact so `getComputedStyle` can be
 * asked what a comment looks like. `measured-github.json` beside it is the unedited output.
 * `surface/harness/tokens.test.ts` holds `surface/src/styles/github.css` to it; `surface/harness/probe.ts`
 * does not read it, because a shared source would make the probe assert that the CSS says what the
 * CSS says.
 *
 * Run: `bun run measure:github` (needs network; no install, no credentials).
 *
 * ## Why a ruler and not a `*-tokens` fetch like Slack's and Linear's
 *
 * For this destination the stylesheet cannot answer the question. A comment body carries both
 * classes (`class="comment-body markdown-body js-comment-body ..."`) and both are styled:
 *
 *     primer-<hash>.css   .markdown-body { font-size: 16px; line-height: 1.5 }
 *     global-<hash>.css   .comment-body  { font-size: var(--text-body-size-medium); ... }
 *
 * Two single-class selectors, equal specificity, in two bundles, with `--text-body-size-
 * medium` defined in neither. Link order and `@layer` decide which wins, and reading that off
 * minified CSS by hand is the trap of trusting a rule found by name (Slack's composer rule
 * `p-rich_text_header` looks like a message's and is not). So this asks Chromium.
 *
 * ## How the surface is assembled
 *
 * Three fetches, no guesses:
 *
 *  1. A public GitHub page per surface (`SURFACES`), for the current asset hashes and the exact
 *     `<html>` attributes GitHub serves (`data-color-mode`, `data-light-theme`, `data-dark-theme`,
 *     `data-a11y-link-underlines`). Hard-coding either would measure a build nobody is served.
 *  2. `POST /markdown` with `mode=gfm`, GitHub's own renderer, so the HTML measured is what GitHub
 *     produces for `fixture.md`, element for element and class for class.
 *  3. GitHub's real stylesheets, linked from the assembled page by their remote URLs.
 *
 * The one thing assembled locally is the wrapper: the `<html>` attributes from (1), `<body
 * class="logged-out">`, and a `<div class="comment-body markdown-body">` around (2). The
 * cross-check exists to falsify that wrapper.
 *
 * ## The cross-check
 *
 * `live` in the output is the same measurement taken off the real page of the surface: its own
 * comment body, in the real DOM, with the real ancestor chain. `local` is the assembled surface.
 * Every key they share must agree, and `agrees` records whether they did; a wrong wrapper would make
 * them diverge. The two observations have different DOMs, ancestors and origins and share only the
 * stylesheets, so this is not the instrument reading itself.
 *
 * ## What it cannot measure (a blank is not a zero)
 *
 *  - Syntax-highlight token colours are in the `.pl-*` classes and are measurable, but only for the
 *    languages the fixture contains; the sheet takes none of them (see `github.css`).
 *  - `live` covers only what an arbitrary public page holds: on the comment surface prose, links and
 *    inline code, and on the README surface the structure (headings, lists, code, quotes, images).
 *    A key neither shows is `untested` in `agrees`.
 */

const { app, BrowserWindow } = require('electron');
const { writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * The two surfaces GitHub renders markdown on, both measured. A comment body carries `comment-body
 * markdown-body`; a README carries `markdown-body entry-content`. `.comment-body` sets a font-size
 * and `.markdown-body` a different one, so a comment renders at 14px and a README at 16px off the
 * same heading rules.
 *
 * draftgate gates comments, issue bodies and PR descriptions, all `comment-body`, so `comment` is
 * the surface whose numbers reach `surface/src/styles/github.css`. `readme` is here for the
 * cross-check: a signed-out issue page renders its rich content through React and leaves only short
 * prose in `.markdown-body`, so the comment surface can falsify the size cascade and nothing else,
 * while a README puts headings, lists, code, quotes and images in the real DOM. Between them every
 * rule the sheet takes is checked against a live GitHub page.
 *
 * Public and signed-out, so anyone can reproduce the run. Both pages are overridable
 * (`GITHUB_RULER_ISSUE`, `GITHUB_RULER_README`), because a URL is the one thing here that can rot.
 */
const SURFACES = {
  comment: {
    page: process.env.GITHUB_RULER_ISSUE ?? 'https://github.com/nodejs/node/issues/1',
    className: 'comment-body markdown-body js-comment-body soft-wrap user-select-contain d-block',
  },
  readme: {
    page: process.env.GITHUB_RULER_README ?? 'https://github.com/primer/css',
    className: 'markdown-body entry-content container-lg',
  },
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 draftgate-ruler';

/** Properties worth reading off a text-bearing node. */
const TEXT = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'];
const BOX = ['margin-top', 'margin-bottom', 'padding', 'background-color'];

/**
 * What to measure, as `key: [selector, properties]`.
 *
 * A selector that matches nothing yields `null` rather than an empty object, so a fixture that
 * stops producing an element is visible as a hole instead of passing as a measurement. That is the
 * same rule `tools/slack-tokens` states about emitting blanks.
 */
const TARGETS = {
  body: ['', [...TEXT, 'background-color']],
  paragraph: ['p', [...TEXT, 'margin-top', 'margin-bottom']],
  h1: ['h1', [...TEXT, ...BOX, 'border-bottom', 'padding-bottom']],
  h2: ['h2', [...TEXT, ...BOX, 'border-bottom', 'padding-bottom']],
  h3: ['h3', [...TEXT, ...BOX]],
  h4: ['h4', [...TEXT, ...BOX]],
  h5: ['h5', [...TEXT, ...BOX]],
  h6: ['h6', [...TEXT, ...BOX]],
  link: ['p a[href]', ['color', 'text-decoration-line']],
  strong: ['strong', ['font-weight']],
  del: ['del', ['text-decoration-line', 'color']],
  inlineCode: [
    'p code',
    ['font-family', 'font-size', 'color', 'background-color', 'padding', 'border-radius'],
  ],
  codeBlock: [
    'pre',
    ['font-family', 'font-size', 'line-height', 'color', 'background-color', 'padding', 'border-radius', 'margin-bottom'],
  ],
  codeBlockWrapper: ['.highlight', ['background-color', 'border-radius', 'margin-bottom']],
  blockquote: [
    'blockquote',
    ['color', 'border-left', 'padding-left', 'margin-top', 'margin-bottom'],
  ],
  bulletList: ['ul:not(.contains-task-list)', ['padding-left', 'margin-top', 'margin-bottom']],
  orderedList: ['ol', ['padding-left', 'margin-top', 'margin-bottom']],
  listItem: ['ul:not(.contains-task-list) > li', ['margin-top']],
  nestedList: ['li > ul', ['margin-top', 'margin-bottom', 'padding-left']],
  taskList: ['ul.contains-task-list', ['padding-left', 'list-style-type']],
  taskItem: ['li.task-list-item', ['list-style-type', 'margin-top']],
  taskCheckbox: [
    'input.task-list-item-checkbox',
    ['width', 'height', 'margin', 'vertical-align'],
  ],
  table: ['table', ['border-collapse', 'border-spacing', 'display', 'width', 'max-width', 'font-variant-numeric']],
  th: ['th', [...TEXT, 'border', 'padding', 'background-color', 'text-align']],
  td: ['td', [...TEXT, 'border', 'padding', 'background-color', 'text-align']],
  trOdd: ['tbody tr:nth-child(2n+1)', ['background-color', 'border-top']],
  trEven: ['tbody tr:nth-child(2n)', ['background-color', 'border-top']],
  hr: ['hr', ['height', 'background-color', 'border', 'margin-top', 'margin-bottom', 'padding']],
  image: ['img', ['max-width', 'box-sizing', 'background-color']],
  alert: [
    '.markdown-alert',
    ['border-left', 'padding', 'margin-bottom', 'color', 'background-color'],
  ],
  alertTitle: ['.markdown-alert-title', ['color', 'font-weight', 'font-size', 'margin-bottom']],
};

/**
 * The same read, run against whatever root it is given: the richest comment body on the page (the
 * one matching the most targets), not the first. On the assembled surface there is only one. On the
 * live page the later comments arrive from JavaScript rather than the served HTML, so the first is
 * routinely the thinnest, and the richest raises the cross-check from "prose agrees" to as many
 * structures as that discussion holds. `rootMatches` records what the winner held, so a bare root
 * shows as `untested` everywhere instead of passing as agreement.
 */
const READ = (selectorsJson, rootSelector) => `(() => {
  const TARGETS = ${selectorsJson};
  const ROOT = ${JSON.stringify(rootSelector)};
  const bodies = [...document.querySelectorAll(ROOT)];
  const score = (el) => Object.values(TARGETS).filter(([s]) => s !== '' && el.querySelector(s)).length;
  const root = bodies.sort((a, b) => score(b) - score(a))[0];
  if (!root) return { error: 'no .markdown-body on this page' };
  // Marked so \`facesOf\` asks about the SAME element, from outside the page.
  document.querySelectorAll('[data-ruler-root]').forEach((el) => el.removeAttribute('data-ruler-root'));
  root.setAttribute('data-ruler-root', '');
  const out = { rootMatches: score(root), rootBodies: bodies.length };
  for (const [key, [selector, props]] of Object.entries(TARGETS)) {
    const el = selector === '' ? root : root.querySelector(selector);
    if (!el) { out[key] = null; continue; }
    const cs = getComputedStyle(el);
    const o = {};
    for (const p of props) o[p] = cs.getPropertyValue(p);
    out[key] = o;
  }
  return out;
})()`;

/**
 * The face Chromium actually rasterised, per element, which `getComputedStyle` cannot say.
 *
 * `font-family` computes to the declared list, and GitHub's begins `"Mona Sans VF"`, but no
 * stylesheet on the page has an `@font-face` for that family and Chromium draws every comment in the
 * system face, signed in or not. Reading the first entry as the face would bundle Mona Sans for
 * nothing. (`surface/src/main.tsx` notes the same trap in our own window.)
 *
 * `CSS.getPlatformFontsForNode` over the page's own DevTools protocol is the rasteriser's answer.
 * `isCustomFont` is the field that matters, a web font against a platform one: a platform face's
 * name is the OS's (`.SF NS` on macOS) and would make the evidence machine-shaped.
 */
const FACES = { paragraph: 'p', h1: 'h1', inlineCode: 'p code', codeBlock: 'pre' };

async function facesOf(win) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) {
    dbg.attach('1.3');
    // Once per window: an enabled domain survives navigation, and only the document is new.
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');
  }
  // `depth: 1` -- `querySelector` needs only the root's id, and `-1` copies the whole live page.
  const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 1 });
  const entries = await Promise.all(
    Object.entries(FACES).map(async ([key, selector]) => {
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: `[data-ruler-root] ${selector}`,
      });
      if (!nodeId) return [key, null];
      const { fonts } = await dbg.sendCommand('CSS.getPlatformFontsForNode', { nodeId });
      // Three of the fields, the names `surface/harness/wkSession.ts`'s `PlatformFont` reports too,
      // so a family split across rows (bold and regular of one face) is legible as that rather than
      // as a repeat. Not `postScriptName`, which tells a real italic from a slant: GitHub draws in
      // platform faces, whose italics are real.
      return [key, fonts.map(({ familyName, isCustomFont, glyphCount }) => ({ familyName, isCustomFont, glyphCount }))];
    })
  );
  return Object.fromEntries(entries);
}

async function render(markdown) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
  // `gh`'s token when there is one -- `POST /markdown` is available unauthenticated but rate
  // limited, and only an authenticated call expands `#123` against a `context`. The fixture needs
  // neither, so a missing `gh` is a warning and not a failure.
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    console.warn('note: no `gh auth token`; rendering unauthenticated');
  }
  const res = await fetch('https://api.github.com/markdown', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: markdown, mode: 'gfm' }),
  });
  if (!res.ok) throw new Error(`POST /markdown answered ${res.status}`);
  return res.text();
}


/**
 * The asset URLs and root attributes GitHub is serving RIGHT NOW.
 *
 * Read off the issue page rather than written down: the bundles are content-hashed and the theme
 * attributes are a product decision, so a hard-coded copy of either measures a build nobody is
 * served. `data-a11y-link-underlines` is carried for the same reason it is measured at all --
 * whether GitHub underlines a link in prose is a rule that differs between destinations and is
 * easy to get wrong.
 */
async function serveFacts(page) {
  const res = await fetch(page, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    throw new Error(
      `${page} answered ${res.status}. It must be PUBLIC and readable signed-out; ` +
        'set GITHUB_RULER_ISSUE / GITHUB_RULER_README to pages that are.'
    );
  }
  const html = await res.text();
  const sheets = [
    ...new Set(
      [...html.matchAll(/href="(https:\/\/github\.githubassets\.com\/assets\/[^"]+\.css)"/g)].map(
        (m) => m[1]
      )
    ),
  ];
  if (sheets.length === 0) throw new Error(`no stylesheets found on ${page}`);
  const attrs = /<html\b([\s\S]*?)>/.exec(html)?.[1] ?? '';
  const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
  return {
    sheets,
    lightTheme: attr('data-light-theme') ?? 'light',
    darkTheme: attr('data-dark-theme') ?? 'dark',
    linkUnderlines: attr('data-a11y-link-underlines') ?? 'true',
  };
}

/** The theme attributes, one spelling, used on both the assembled page and the live one. */
function themeAttrs(facts, mode) {
  return mode === 'dark'
    ? { 'data-color-mode': 'dark', 'data-dark-theme': facts.darkTheme }
    : { 'data-color-mode': 'light', 'data-light-theme': facts.lightTheme };
}

function pageHtml(facts, mode, className, rendered) {
  const theme = Object.entries(themeAttrs(facts, mode))
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const links = facts.sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n');
  // `logged-out` is the body class GitHub serves an anonymous reader, kept because a body class can
  // carry rules. The wrapper's own class list is copied verbatim off the served page it mirrors.
  return `<!doctype html>
<html lang="en" ${theme} data-a11y-link-underlines="${facts.linkUnderlines}">
<head><meta charset="utf-8">${links}</head>
<body class="logged-out env-production page-responsive" style="word-wrap: break-word;">
<div class="${className}">
${rendered}
</div>
</body></html>`;
}

/** `.a.b.c` for a class attribute -- the root selector the read narrows to. */
function rootSelector(className) {
  return `.${className.trim().split(/\s+/).join('.')}`;
}

async function settle(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Disagreements that are expected, each named by the rule that produces it. Not a suppression list:
 * two permanent differences in the output every run would become the noise a real one hides in.
 * Anything else still reads as `DIFFER`.
 *
 *  - `paragraph.margin-bottom`: `.markdown-body>:last-child{margin-bottom:0!important}`. The live
 *    comment holds one paragraph, which is therefore also the last child; the fixture's is followed
 *    by twenty more blocks. The rule is real and `github.css` carries it.
 *  - `codeBlockWrapper.background-color`: GitHub paints the code block twice over, and which half
 *    carries the colour depends on the pipeline. In a comment, `global.css` sets
 *    `.comment-body .highlight{background-color:#0000}` and the `pre` inside carries
 *    `--bgColor-muted`; in a README the wrapper carries it too. `codeBlock`, the `pre`, which is
 *    what the sheet takes, agrees in both. The wrapper is GitHub's syntax-highlight container and
 *    draftgate renders no such element.
 */
const KNOWN = {
  comment: { paragraph: ['margin-bottom'] },
  readme: { codeBlockWrapper: ['background-color'] },
};

/**
 * Agreement between the assembled surface and the live one, per key.
 *
 * A key the LIVE page has no element for is `untested`, never `agree`: a hole that reads as a pass
 * (`img: 1` against an image that served nothing) would here be the difference between "GitHub
 * draws it this way" and "nothing looked".
 */
function compare(local, live, known = {}) {
  const out = {};
  for (const key of Object.keys(TARGETS)) {
    const l = local[key];
    const r = live[key];
    if (!l || !r) {
      out[key] = 'untested';
      continue;
    }
    const differ = Object.keys(l).filter((p) => l[p] !== r[p]);
    const expected = known[key] ?? [];
    const unexpected = differ.filter((p) => !expected.includes(p));
    if (differ.length === 0) out[key] = 'agree';
    else if (unexpected.length === 0) out[key] = { expected: differ, local: l, live: r };
    else out[key] = { differ: unexpected, local: l, live: r };
  }
  return out;
}

app.whenReady().then(async () => {
  const rendered = await render(readFileSync(join(__dirname, 'fixture.md'), 'utf8'));
  const win = new BrowserWindow({
    width: 1000,
    height: 1600,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  const surfaces = {};
  for (const [name, surface] of Object.entries(SURFACES)) {
    const facts = await serveFacts(surface.page);
    const read = READ(JSON.stringify(TARGETS), rootSelector(surface.className));

    const local = {};
    const faces = {};
    for (const mode of ['light', 'dark']) {
      const file = join(__dirname, `page-${name}-${mode}.html`);
      writeFileSync(file, pageHtml(facts, mode, surface.className, rendered));
      await win.loadFile(file);
      // The sheets are remote; `did-finish-load` fires before late ones apply. One settle, then read.
      await settle(2500);
      local[mode] = await win.webContents.executeJavaScript(read);
      faces[mode] = await facesOf(win);
    }

    // The independent observation: the real page, its own DOM, its own ancestors, its own origin.
    //
    // The theme is STAMPED rather than left to the machine. GitHub serves `data-color-mode="auto"`,
    // so an unstamped read reports whatever the operator's OS is set to -- dark against a local
    // surface built light, and every colour "differs". A cross-check that reads a system preference
    // as a disagreement about GitHub is noise, and noise in this position is how a real
    // disagreement gets waved through.
    await win.loadURL(surface.page, { userAgent: UA });
    await settle(6000);
    await win.webContents.executeJavaScript(
      `(() => { const r = document.documentElement;
         const a = ${JSON.stringify(themeAttrs(facts, 'light'))};
         for (const [k, v] of Object.entries(a)) r.setAttribute(k, v); })()`
    );
    const live = await win.webContents.executeJavaScript(read);
    faces.live = await facesOf(win);

    surfaces[name] = {
      page: surface.page,
      facts,
      local,
      live,
      agrees: compare(local.light, live, KNOWN[name]),
      faces,
    };
  }

  writeFileSync(
    join(__dirname, 'measured-github.json'),
    `${JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), surfaces }, null, 1)}\n`
  );
  for (const [name, s] of Object.entries(surfaces)) {
    const verdicts = Object.values(s.agrees);
    console.log(
      `${name}: ${verdicts.filter((v) => v === 'agree').length} agree, ` +
        `${verdicts.filter((v) => v === 'untested').length} untested, ` +
        `${verdicts.filter((v) => v.expected).length} differ as expected, ` +
        `${verdicts.filter((v) => v.differ).length} DIFFER ` +
        `(live root matched ${s.live.rootMatches} of ${Object.keys(TARGETS).length - 1})`
    );
    const face = (f) => (f ? f.map((x) => `${x.familyName}${x.isCustomFont ? ' (web font)' : ''}`).join(' + ') : 'none');
    console.log(`  prose rasterised as: light ${face(s.faces.light.paragraph)}, live ${face(s.faces.live.paragraph)}`);
  }
  app.quit();
});

app.on('window-all-closed', () => app.quit());
