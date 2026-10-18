/**
 * Extract Slack's own design tokens for the variables `slack.css` uses.
 *
 * Dev instrument: not a dependency, not in the plugin tree. Like `tools/linear-tokens/` it needs no
 * install: it fetches Slack's public stylesheets and parses them. `tokens.json` beside it is the
 * committed evidence, so the guard in `surface/harness/tokens.test.ts` works in a fresh clone with
 * no network.
 *
 * Run: `bun run tokens:slack`.
 *
 * ## The client CSS is public, and sidebar themes do not reach the message body's tokens
 *
 * `app.slack.com/client` returns 200 unauthenticated and links eight `a.slack-edge.com`
 * stylesheets. `app.slack.com` and `slack.com/signin` serve only `marketing-style-*` and
 * `legacy-style-libs-*`; the `/client` path serves the real application shell.
 * `rollup-style-plastic.*.min.css` -- "plastic" is Slack's design system -- carries **417
 * `--dt_color-*` tokens with values**, under exactly two selectors:
 *
 *     :root, .sk-client-theme--light      417 tokens
 *     .sk-client-theme--dark              388 tokens
 *
 * **Sidebar themes do not touch them.** `.sk-client-theme--light-inverted-sidebar` exists as a
 * THIRD class, and every one of its occurrences across all eight stylesheets is a scoped rule for a
 * sidebar-hosted component (`.c-link`, `.p-rich_text_slug`, `.c-mrkdwn__code`) -- it defines
 * **zero** `--dt_color-*` tokens. So a custom sidebar changes the sidebar, and it defines no
 * message-body token.
 *
 * That makes the two token blocks the two draftgate mirrors, and NOT proof that the message pane has
 * only two looks: Slack has many light and dark themes, and one draws message text in #d1d2d3 where
 * `content-pry` dark is #f8f8f8. Other themes are not measured.
 *
 * ## Not the `--sk_*` trap
 *
 * `application.*.min.css` references `--sk_*` and `--dt_color-*` and defines neither: 225
 * `--dt_color-*` referenced, zero defined. Reading that file alone would return nothing and look
 * like a measurement, the same hazard as Linear's empty `--sx-*` slots. The values live in the
 * sibling rollup, and this script fails loudly rather than emitting blanks.
 *
 * ## Geometry
 *
 * Sizes, weights and spacings come from the same stylesheets as the colours. Slack's message
 * renderer states them outright in `modern.*.min.css`:
 *
 *     .p-rich_text_block               { font-size: 15px; line-height: 1.46668 }
 *     .p-rich_text_header              { margin: 1em 0 4px }
 *     .p-rich_text_header--level_1     { font-size: 18px; line-height: 1.33334; font-weight: 900 }
 *     .p-rich_text_header--level_2     { font-size: 15px; line-height: 1.46668; font-weight: 900 }
 *     .p-rich_text_header--level_3     { font-size: 15px; line-height: 1.46668; font-weight: 700 }
 *     .c-mrkdwn__quote, .c-mrkdwn__pre { margin-top: 4px; margin-bottom: 4px }
 *     .c-mrkdwn__quote                 { padding-left: 16px }
 *     .p-rich_text_list li             { margin-inline-start: 28px }
 *
 * `RULES` below collects that list into `tokens.json`, so `surface/harness/tokens.test.ts` holds the
 * sheet to it with no network, as with the palette. It also confirms the two-size heading structure
 * a live render shows: three levels exist, but level_2 and level_3 share a size and line-height and
 * differ only in weight. Which level mrkdwn's `##` reaches is not answered: that conversion is
 * server-side, and it is the difference between 900 and 700. The sheet keeps 700 and says so.
 *
 * ## Cross-validated
 *
 * `--sl-text` #1d1c1d is `content-pry`, `--sl-link` #1264a3 is `content-hgl-1`, the chrome accent
 * #007a5a is `content-hgl-2`, and `--sl-code-text` #e01e5a is `otl-imp`: each re-derivable, with a
 * dark column beside it.
 */

import { writeFileSync } from 'node:fs';
import { cssRules, fetchedFace, servedFace, smoothingOf } from '../../surface/harness/vendorCss.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The application shell, NOT `app.slack.com` or `/signin` -- those serve marketing. */
const CLIENT = 'https://app.slack.com/client';

/**
 * The tokens `slack.css` needs, and what each is FOR.
 *
 * Deliberately short. Slack defines 417; almost all are sidebar, modal, banner and state colours
 * with no counterpart in a preview of one message.
 */
const WANTED = [
  // Body pane. (Inline code TEXT is not here: Slack states it as a literal, per ATTESTED below.)
  '--dt_color-content-pry', //    the message text
  '--dt_color-content-ter', //    quiet text: blockquote, a checked task item
  '--dt_color-base-pry', //       the pane itself
  '--dt_color-base-sec', //       code block and inline-code ground
  '--dt_color-otl-ter', //        rules, table cells, the blockquote bar
  '--dt_color-content-hgl-1', //  links
  // Chrome: draftgate's OWN controls in Slack's idiom. Brand, not a render measurement.
  '--dt_color-content-hgl-2', //  Slack green -- the primary button
  '--dt_color-base-inv-hgl-2', // its pressed/solid counterpart
  '--dt_color-surf-pry-hover', // the neutral button's hover
  /*
   * The mention pill, from Slack's own `.p-rich_text_slug` / `.c-member_slug--*` rules.
   *
   * `surf-hgl-1` under `content-hgl-1` is the ORDINARY mention -- someone else. `surf-hgl-3` and
   * `content-hgl-3` are the `--mention` highlight, which Slack uses when the mention includes the
   * READER, and a channel-wide ping always includes the sender. So the two pairs are the two states
   * a reviewer can legitimately be shown; see `slack.css`'s mention rule.
   */
  '--dt_color-surf-hgl-1',
  '--dt_color-surf-hgl-3',
  '--dt_color-content-hgl-3',
  /*
   * The CODE BLOCK, from its own component rules (`codeBlock` below): the card's ground in dark
   * (`base-ter`; light takes `base-sec`, already above), its 1px border (`surf-pry`), the line
   * numbers (`content-sec`) and the language label, which is `rgb(var(--dt_color-plt-gray-50))` --
   * a palette TRIPLET, so the sheet wraps it in `rgb()` exactly as Slack does.
   */
  '--dt_color-base-ter',
  '--dt_color-surf-pry',
  '--dt_color-content-sec',
  '--dt_color-plt-gray-50',
];

/**
 * Tokens Slack defines ONCE, on `:root`, so both themes inherit them.
 *
 * `constants-white` is the text on a solid coloured button -- white on Slack green in either
 * theme, which is what makes it a constant rather than a themed pair. Kept separate because the
 * check below requires every WANTED token in BOTH blocks, and a constant is legitimately in one.
 * (Jira's `--ds-radius-small` sits the same way.)
 */
const CONSTANTS = ['--dt_color-constants-white'];

/**
 * Values Slack states as a literal in a rule rather than through a token.
 *
 * One: `.sk-client-theme--dark .c-mrkdwn__code` sets `color: #e8912d`, so Slack's inline code is
 * orange in dark, not `otl-imp` (`#d94c75` there, a pink). An unscoped theme rule attests it, so it
 * is Slack's, not a sidebar variant's.
 *
 * The matching light rule is not in the public CSS: the only other `.c-mrkdwn__code` colour is
 * scoped to `light-inverted-sidebar`, a sidebar variant that cannot be claimed for the message body.
 * So light keeps the `otl-imp` token and is recorded as unattested.
 */
const ATTESTED = {
  '--sl-code-text': {
    selector: '.sk-client-theme--dark .c-mrkdwn__code',
    property: 'color',
    // Light is not attested; fall back to the `otl-imp` token.
    lightFrom: '--dt_color-otl-imp',
  },
};

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

/** Declarations inside the first block whose selector matches. Non-global patterns: a `g` regex
 *  carries `lastIndex` between calls, which silently makes the second lookup start mid-file. */
const LIGHT_SEL = /:root,\s*\.sk-client-theme--light\s*\{/;
const DARK_SEL = /\.sk-client-theme--dark\s*\{/;

function declarations(css, selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const start = m.index + m[0].length;
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/(--dt_color-[a-z0-9-]+)\s*:\s*([^;}]+)/gi)].map((d) => [d[1], d[2].trim()])
  );
}

const shell = await get(CLIENT);
// Content-hashed filenames, so they cannot be pinned -- discover them from the shell every run.
const urls = [...new Set([...shell.matchAll(/https:\/\/[a-z0-9.-]*slack-edge\.com[^"']*?\.css/g)].map((m) => m[0]))];
if (!urls.length) {
  console.error('extract: no slack-edge stylesheet linked from the client shell. Markup changed.');
  process.exit(1);
}

const sheets = await Promise.all(urls.map(get));

/**
 * The sheet that DEFINES the tokens, located by content rather than by filename.
 *
 * "Defines" is the load-bearing word: `application.*.min.css` MATCHES the theme selectors and
 * defines nothing, so a selector-only test would pick the wrong file and emit blanks.
 */
const themed = sheets.find((css) => {
  const l = declarations(css, LIGHT_SEL);
  const d = declarations(css, DARK_SEL);
  return l && d && Object.keys(l).length > 0 && Object.keys(d).length > 0;
});
if (!themed) {
  console.error(
    `extract: none of the ${urls.length} stylesheets DEFINES the theme blocks.\n` +
      'Note `application.*.min.css` references --dt_color-* without defining any; the values live ' +
      'in the `rollup-style-plastic` sibling. Emitting blanks from the wrong file is the failure ' +
      'this check exists to prevent.'
  );
  process.exit(1);
}

const light = declarations(themed, LIGHT_SEL);
const dark = declarations(themed, DARK_SEL);

const missing = WANTED.filter((v) => !light?.[v] || !dark?.[v]);
if (missing.length) {
  console.error(`extract: no value in both themes for ${missing.join(', ')} -- Slack's tokens moved.`);
  process.exit(1);
}

/**
 * Evidence that a custom SIDEBAR theme cannot change the body palette.
 *
 * Recorded rather than asserted: the answer is a count anyone can re-derive.
 */
const sidebarTokenDefs = sheets.reduce(
  (n, css) =>
    n +
    [...css.matchAll(/\.sk-client-theme--light-inverted-sidebar[^{}]{0,300}\{([^}]*)\}/g)].reduce(
      (m, b) => m + [...b[1].matchAll(/--dt_color-[a-z0-9-]+\s*:/g)].length,
      0
    ),
  0
);

const missingConstants = CONSTANTS.filter((v) => !light?.[v]);
if (missingConstants.length) {
  console.error(`extract: no value for constant ${missingConstants.join(', ')}.`);
  process.exit(1);
}

/** Read a literal declaration straight out of a rule, by selector and property. */
function literal(css, selector, property) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'
  );
  const m = re.exec(css);
  if (!m) return null;
  const d = new RegExp(property + '\\s*:\\s*([^;}]+)').exec(m[1]);
  return d ? d[1].trim() : null;
}

const attested = {};
for (const [name, spec] of Object.entries(ATTESTED)) {
  const found = sheets.map((css) => literal(css, spec.selector, spec.property)).find(Boolean);
  if (!found) {
    console.error(`extract: ${spec.selector} no longer sets ${spec.property} -- Slack's rule moved.`);
    process.exit(1);
  }
  attested[name] = { light: light[spec.lightFrom], dark: found, ...spec };
}

/**
 * Message-pane GEOMETRY, by exact selector. See the header.
 *
 * Keyed by selector and collected verbatim, not interpreted: the declarations are what
 * `surface/src/styles/slack.css` is checked against, and a number this tool paraphrased would be a
 * second reading of the source rather than the source.
 */
const RULES = [
  '.p-rich_text_block',
  '.p-rich_text_header',
  /*
   * The composer's rules. Kept because they CORROBORATE the type scale -- they carry the same
   * sizes and line-heights as the header-block rules below -- but they are NOT what a mrkdwn
   * message renders through, and their weights are not a message's.
   */
  '.p-rich_text_header.p-rich_text_header--level_1',
  '.p-rich_text_header.p-rich_text_header--level_2',
  '.p-rich_text_header.p-rich_text_header--level_3',
  /*
   * The rules that ACTUALLY apply, verified against the live DOM: an agent's `#`/`##`/`######`
   * become `p-header_block__text` with `level_N` and `flat_scale`. `flat_scale` is the message
   * variant -- without it level_1 is 22px, which is a canvas or file unfurl.
   */
  '.p-header_block__text',
  '.p-header_block__text.p-header_block--flat_scale.p-header_block--level_2',
  '.p-header_block__text.p-header_block--flat_scale.p-header_block--level_3',
  '.c-mrkdwn__quote',
  '.p-rich_text_list li',
  /*
   * The code block's WRAPPER, which both shapes share: a fence without a language is
   * this box itself, and one with a language is the card inside its 8px padding. The margin is the
   * grouped rule the quote shares, matched by its exact selector list.
   */
  '.c-mrkdwn__pre',
  '.c-mrkdwn__quote,.c-mrkdwn__pre',
];

/**
 * Selectors whose rule is shared with another and so cannot be matched exactly.
 *
 * `flat_scale + level_1` is declared in the same block as bare `level_2`
 * (`.p-header_block__text.p-header_block--level_2, .p-header_block__text.p-header_block--flat_scale.p-header_block--level_1`),
 * so `ruleOf`'s exact-selector match cannot find it alone. Its values are read from the shared
 * block, and the DOM confirms them: 18px / 1.33334 / 900.
 */
const SHARED = {
  '.p-header_block__text.p-header_block--flat_scale.p-header_block--level_1':
    '.p-header_block__text.p-header_block--level_2,.p-header_block__text.p-header_block--flat_scale.p-header_block--level_1',
};

/**
 * Every rule in every client sheet, in sheet order, parsed ONCE by `surface/harness/vendorCss.ts`:
 * the exact-selector geometry, the smoothing scan and the served face all read it. Uncapped: a
 * parser that stops at some length of selector or body has a hole in a scan whose job is to find
 * EVERY rule that sets smoothing.
 */
const allRules = sheets.flatMap((css, i) => cssRules(css, urls[i]));

/** Every declaration in the FIRST rule whose selector matches exactly, as a plain object. */
const ruleOf = (selector) => allRules.find((r) => r.selector === selector)?.declarations ?? null;

const rules = {};
for (const selector of [...RULES, ...Object.keys(SHARED)]) {
  const lookFor = SHARED[selector] ?? selector;
  const found = ruleOf(lookFor);
  if (!found) {
    console.error(
      `extract: no rule for \`${selector}\` in any of the ${sheets.length} client stylesheets -- ` +
        "Slack's message renderer changed its class names. Do NOT take the sheet's current values " +
        'as confirmed; re-read the header.'
    );
    process.exit(1);
  }
  rules[selector] = found;
}

/**
 * How Slack rasterises its text, which no size, weight or colour above can say.
 *
 * `rollup-style-plastic`'s `body` rule sets `-webkit-font-smoothing: antialiased` for the whole
 * client and the message pane inherits it. Without it Chromium on macOS applies its default
 * smoothing, which dilates every stem: at 1x on Slack's dark palette the same Lato paragraph paints
 * ~30% more ink, and light text on a dark ground reads as a soft halo beside the real client.
 *
 * Found by the declaration, not the selector: three stylesheets hold an exact `body` rule and only
 * this one declares smoothing, so `ruleOf`'s first match would record the legacy adapter's bare
 * `font-family` rule as the source.
 */
const smoothing = smoothingOf(allRules);
if (!smoothing) {
  console.error(
    `extract: no \`body\` rule declares -webkit-font-smoothing in any of the ${sheets.length} client ` +
      "stylesheets -- Slack changed how it rasterises text. Do NOT keep slack.css's value as sourced."
  );
  process.exit(1);
}

/**
 * The font file a message is drawn in, as Slack serves it: the upright and italic 400 `Slack-Lato`
 * faces, read off their own tables by `surface/harness/fontFile.ts` (the reader `tokens.test.ts`
 * points at the files this window bundles).
 *
 * Slack serves Lato 2.015 and Google Fonts' build (`@fontsource/lato`) is Lato 1.104, a redrawn
 * family with different spacing, so lines break at different words. No name, weight or width check
 * tells them apart; the file's own version does. The italic is needed because Slack draws `_text_`
 * in Lato's own italic; with no italic face Chromium slants the upright glyphs and the run comes out
 * wider.
 */
const [face, italicFace] = await Promise.all(
  ['normal', 'italic'].map((style) =>
    servedFace(allRules, { family: 'Slack-Lato', style, weight: '400' }).catch((e) => {
      console.error(`extract: Slack's ${style} 400 Slack-Lato face: ${e.message}`);
      process.exit(1);
    })
  )
);

/**
 * The code block a fence with a language renders as (a card with a header holding the language name,
 * and a numbered code area), from the component's own rules.
 *
 * Its class names are CSS-module hashes (`.container__u_9wR`, `.header__k5RRm`, ...) that change with
 * Slack's builds, so they cannot be keys. The anchor is the one stable selector in the module,
 * `pre.slalabaster .line-number` (`slalabaster` is Slack's syntax theme), and the module's other
 * rules are found by their local name in the rules just around it. In a signed-in client's live DOM
 * a message's code block carries `c-mrkdwn__pre > container > header > language` and
 * `container > code > pre.slalabaster`.
 *
 * A fence without a language is not this component: it stays the older `.c-mrkdwn__pre` box, with
 * no header and no line numbers. Its colours come from no public stylesheet; see `slack.css`.
 */
const anchor = allRules.findIndex((r) => /^\.code__[\w-]+ pre\.slalabaster \.line-number$/.test(r.selector));
if (anchor < 0) {
  console.error('extract: no `.code__* pre.slalabaster .line-number` rule -- Slack rebuilt its code block.');
  process.exit(1);
}
// The anchor's OWN class ties `code`, `pre`, `line` and the dark override to the module exactly;
// the three it does not name are the nearest rule of their local name, searched OUTWARD from the
// anchor, so a same-named class in a neighbouring module loses to the module's own.
const code = allRules[anchor].selector.split(' ')[0];
const nearest = (re) => {
  for (let d = 1; d < 40; d++) {
    for (const at of [anchor - d, anchor + d]) if (allRules[at] && re.test(allRules[at].selector)) return allRules[at];
  }
  return null;
};
const container = nearest(/^\.container__[\w-]+$/);
const codeBlock = {
  container: container?.declarations ?? null,
  containerDark: container ? ruleOf(`.sk-client-theme--dark ${container.selector}`) : null,
  header: nearest(/^\.header__[\w-]+$/)?.declarations ?? null,
  language: nearest(/^\.language__[\w-]+$/)?.declarations ?? null,
  code: ruleOf(code),
  pre: ruleOf(`${code} pre.slalabaster`),
  line: ruleOf(`${code} pre.slalabaster .line`),
  lineNumber: allRules[anchor].declarations,
  lineNumberDark: ruleOf(`.sk-client-theme--dark ${code} pre.slalabaster .line-number`),
};
const missingParts = Object.entries(codeBlock).filter(([, v]) => !v).map(([k]) => k);
if (missingParts.length) {
  console.error(`extract: the code block module no longer has ${missingParts.join(', ')} beside its anchor.`);
  process.exit(1);
}

/**
 * The CODE face: `Slack-Roboto-Mono` heads Slack's `--font-family-monospace`, and NO public
 * stylesheet declares its `@font-face` -- the client loads it some other way. The URL is the file
 * a signed-in client loads (`performance.getEntriesByType('resource')`). Content-hashed, so this
 * fails loudly the day Slack rebuilds it; take the new URL the same way.
 */
const MONO_FACE_URL =
  process.env.SLACK_MONO_FACE_URL ?? 'https://a.slack-edge.com/bv1-13-br/RobotoMono-Regular-6ddf6fb.woff2';
const monoFace = await fetchedFace(MONO_FACE_URL).catch((e) => {
  console.error(
    `extract: Slack's code face: ${e.message}. Read the current URL off a signed-in client -- ` +
      "`performance.getEntriesByType('resource')`, the entry naming RobotoMono -- and run again with " +
      'SLACK_MONO_FACE_URL=<it>, then update the default here.'
  );
  process.exit(1);
});

const pick = (values) => Object.fromEntries(WANTED.map((v) => [v, values[v]]));
const constants = Object.fromEntries(CONSTANTS.map((v) => [v, light[v]]));
writeFileSync(
  join(HERE, 'tokens.json'),
  JSON.stringify(
    {
      source: CLIENT,
      retrieved: new Date().toISOString().slice(0, 10),
      note:
        'Slack defines its client tokens under `:root,.sk-client-theme--light` and ' +
        '`.sk-client-theme--dark`. A custom sidebar theme defines no colour tokens at all. Other ' +
        'Slack themes were not measured, and may tint the message pane beyond these two.',
      sidebarThemeColourTokens: sidebarTokenDefs,
      constants,
      attested,
      /*
       * The message renderer's own geometry, verbatim. `surface/harness/tokens.test.ts` holds
       * `slack.css` to these, which is what stops the sizes drifting to numbers nobody sourced.
       */
      rules,
      /*
       * The client-wide `body` rule, verbatim, and every other rule that sets smoothing
       * (`smoothingOverrides`: a video player and an avatar-menu icon, neither in a message).
       * Recorded so "the message pane inherits the body's value" is re-derivable;
       * `surface/harness/tokens.test.ts` fails if one ever resets it on an element.
       */
      ...smoothing,
      /* The message face as served: `src`, then the file's own family, version, axes, glyphs. */
      face,
      /* The same, for the italic 400 face. */
      italicFace,
      /* The code face, `Slack-Roboto-Mono`, from the URL a signed-in client loaded. */
      monoFace,
      /* The code block component's own rules, verbatim, by the local names of its classes. */
      codeBlock,
      light: pick(light),
      dark: pick(dark),
    },
    null,
    1
  ) + '\n'
);

const block = (values) => WANTED.map((v) => `  ${v}: ${values[v]};`).join('\n');
const constantBlock = CONSTANTS.map((v) => `  ${v}: ${light[v]};`).join('\n');
const attestedBlock = (theme) =>
  Object.entries(attested).map(([n, a]) => `  ${n}: ${a[theme]};`).join('\n');
console.log("/* GENERATED by tools/slack-tokens/extract.mjs from Slack's own client CSS. Do not hand-edit. */");
console.log(`[data-destination="slack"] {\n${block(light)}\n${constantBlock}\n${attestedBlock('light')}\n}`);
console.log(`[data-destination="slack"][data-theme="dark"] {\n${block(dark)}\n${attestedBlock('dark')}\n}`);
console.log(`\n/* sidebar-theme colour-token definitions found: ${sidebarTokenDefs} (expected 0) */`);
