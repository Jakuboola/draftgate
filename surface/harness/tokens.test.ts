/**
 * What the four destination sheets and `shell.css` declare, against the committed vendor evidence:
 * the token extractors' `tokens.json` (Jira, Linear, Slack), the GitHub ruler's
 * `measured-github.json`, and the vendors' font files. Each generator's output lives inline in its
 * sheet, so a hand-edit drifts from its input; checked against the committed JSON, not by
 * re-running the generator, because a fresh clone does not have the tools installed.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformFont } from './wkSession';
import { fontFacts, type FontFacts } from './fontFile';
import { bundledFaces, ROOT, STYLES, type BundledFace } from './shared';
import { selectorItems } from './vendorCss';

const CSS = readFileSync(join(STYLES, 'jira.css'), 'utf8');
const SHELL = readFileSync(join(STYLES, 'shell.css'), 'utf8');
const LINEAR = readFileSync(join(STYLES, 'linear.css'), 'utf8');
const SLACK = readFileSync(join(STYLES, 'slack.css'), 'utf8');
const GITHUB = readFileSync(join(STYLES, 'github.css'), 'utf8');

/** Every face the window bundles -- one reading, shared with `fontAssets.test.ts`. */
const BUNDLED_FACES = bundledFaces();

/**
 * The ruler's committed output -- GitHub's own computed values, plus its cross-check against a live
 * page. `tools/github-ruler/README.md` says what it covers and what it cannot.
 */
const RULER = JSON.parse(
  readFileSync(join(ROOT, 'tools', 'github-ruler', 'measured-github.json'), 'utf8')
) as {
  measuredAt: string;
  surfaces: Record<
    string,
    {
      page: string;
      local: Record<'light' | 'dark', Record<string, Record<string, string> | null>>;
      live: { rootMatches: number };
      agrees: Record<string, unknown>;
      // The faces Chromium rasterised (`CSS.getPlatformFontsForNode`), per element, in each theme and
      // on the live page. It names no instance either: the fields `PlatformFont` has.
      faces: Record<
        'light' | 'dark' | 'live',
        Record<string, PlatformFont[] | null>
      >;
    }
  >;
};

/**
 * Every declaration that applies to `selector`, from every rule listing it, or `null` if none does.
 *
 * Reads the selector list rather than anchoring on `{`, which would mean "the rule whose list ENDS
 * with this": in `.dg-warn-fix, .dg-warnlink { … }` adding a class after `.dg-warnlink` would move
 * the answer to another rule, and a "does NOT declare" guard (`.dg-warnbar` and height, below) would
 * then pass vacuously. Concatenated, because the sheets keep shared declarations and per-class
 * deltas in separate rules.
 */
function ruleBody(css: string, selector: string): string | null {
  // Exact, so `.dg-warnlink` never picks up `.dg-warnlink:hover`.
  const bodies = sheetRules(css)
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body);
  return bodies.length === 0 ? null : bodies.join(' ');
}

/**
 * Every innermost rule of a sheet, with its selector list split: the one walk `ruleBody` and every
 * whole-sheet guard below share. Comments first, because the sheets quote selectors and declaration
 * blocks in prose. `[^{}]` on both halves, so a rule inside an `@media` is found by its own selector.
 */
function sheetRules(css: string): Array<{ selectors: string[]; body: string }> {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
    selectors: selectorItems(rule[1]!).map((one) => one.trim()),
    body: rule[2]!.trim(),
  }));
}

const RAW_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\((?!var\()/i;

/** Every declaration in a sheet whose value holds a RAW colour, as `[property, value, selector]`. */
function rawColourDeclarations(css: string): Array<[string, string, string]> {
  return sheetRules(css).flatMap(({ selectors, body }) =>
    [...body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)]
      .filter((d) => RAW_COLOUR.test(d[2]!))
      .map((d): [string, string, string] => [d[1]!, d[2]!.trim(), selectors.join(', ')])
  );
}

/**
 * Every declaration in a sheet that holds a raw colour and is not a custom property: a raw colour
 * may only be a variable's value, so every rule names a variable. `rgb(var(...))` is not raw: it is
 * how a palette triplet is used, as the vendor's own rule writes it. By property, not by position.
 */
function rawColours(css: string): string[] {
  return rawColourDeclarations(css)
    .filter(([property]) => !property.startsWith('--'))
    .map(([property, value]) => `${property}: ${value}`);
}

/**
 * Every custom property in a sheet whose value is a raw colour, by name, once per declaration --
 * or, `scoped`, after the selector of the rule declaring it, so two copies in one scope differ from
 * one per theme.
 */
function rawColourVariables(css: string, scoped = false): string[] {
  return rawColourDeclarations(css)
    .filter(([property]) => property.startsWith('--'))
    .map(([property, , selector]) => (scoped ? `${selector} ${property}` : property));
}

/**
 * The value of the first `property` declared in a rule body (as `ruleBody` returns it), trimmed, or
 * `undefined`. The one reader for "what does this rule declare for X" in this file.
 */
function declared(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[;{])\\s*${property}\\s*:\\s*([^;}]+)`, 'i').exec(body)?.[1]?.trim();
}

/** The `z-index` a rule declares, or `null`. */
function zIndexIn(body: string): number | null {
  const value = declared(body, 'z-index');
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

interface Palette {
  light: Record<string, string>;
  dark: Record<string, string>;
}
const TOKENS = JSON.parse(
  readFileSync(join(ROOT, 'tools', 'atlassian-tokens', 'tokens.json'), 'utf8')
) as Palette;
const LINEAR_TOKENS = JSON.parse(
  readFileSync(join(ROOT, 'tools', 'linear-tokens', 'tokens.json'), 'utf8')
) as Palette & {
  source: string;
  editor: Record<string, string>;
  /*
   * The issue editor's own CSS: geometry and typography, no colour. `themes` records that it
   * declares no `[data-theme]` block, so the palettes come from the marketing site and
   * `previewFidelity` stays `indicative`.
   */
  client: {
    source: string;
    themes: string[];
    editor: Record<string, string>;
    root: Record<string, string>;
    /* The client sheet's `body` rule, and every other rule that sets smoothing. */
    bodyText: Record<string, string>;
    smoothingOverrides: { selector: string; value: string }[];
    /* The editor's face as Linear serves it, read by `fontFile.ts`. */
    face: FontFacts & { src: string };
    /* ...and its italic twin. */
    italicFace: FontFacts & { src: string };
    /* The code block's three rules, verbatim. */
    codeBlock: Record<'pre' | 'code' | 'lineNumber', Record<string, string>>;
    /* Every block margin on the editor's shared root, its hash out of the selector. */
    blockSpacing: { selector: string; declarations: Record<string, string> }[];
    /* `.editor .heading-node`, the rule that weights every heading level, verbatim. */
    heading: Record<string, string>;
  };
};
const SLACK_TOKENS = JSON.parse(
  readFileSync(join(ROOT, 'tools', 'slack-tokens', 'tokens.json'), 'utf8')
) as Palette & {
  source: string;
  sidebarThemeColourTokens: number;
  constants: Record<string, string>;
  attested: Record<string, { light: string; dark: string; selector: string; lightFrom: string }>;
  /* The message renderer's geometry, by exact selector, verbatim: every size `slack.css` declares. */
  rules: Record<string, Record<string, string>>;
  /* The `body` rule that sets `-webkit-font-smoothing`, verbatim, and every other rule that sets it. */
  bodyText: Record<string, string>;
  smoothingOverrides: { selector: string; value: string }[];
  /* The message face as Slack serves it, read by `fontFile.ts`. */
  face: FontFacts & { src: string };
  /* ...and its italic twin. */
  italicFace: FontFacts & { src: string };
  /* The code face, fetched from the URL a signed-in client loaded (no public sheet declares it). */
  monoFace: FontFacts & { src: string };
  /* The code block component's own rules, keyed by the local names of its hashed classes. */
  codeBlock: Record<
    'container' | 'containerDark' | 'header' | 'language' | 'code' | 'pre' | 'line' | 'lineNumber' | 'lineNumberDark',
    Record<string, string>
  >;
};

/** The custom-property declarations inside the block whose selector is exactly `selector`. */
function declarations(css: string, selector: string, prefix: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(new RegExp(`^\\s*(${prefix}[a-z0-9-]+)\\s*:\\s*([^;]+);`, 'gim'))) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/**
 * Every palette guard: the sheet's block equals the evidence, both ways, above a floor. The floor
 * catches a regenerate that produced `{}` (zero iterations pass); the reverse comparison catches a
 * line hand-added inside the generated block, which iterating the JSON cannot see.
 */
function expectPalette(
  css: string,
  selector: string,
  prefix: string,
  expected: Record<string, string>,
  minimum: number
): void {
  expect(
    Object.keys(expected).length,
    `${selector}: the committed token evidence is empty or tiny, so every value check below ` +
      'would pass without asserting anything'
  ).toBeGreaterThanOrEqual(minimum);

  const declared = declarations(css, selector, prefix);
  for (const [name, value] of Object.entries(expected)) expect(declared[name]).toBe(value);

  expect(
    Object.keys(declared).filter((k) => !(k in expected)).sort(),
    `${selector} declares ${prefix}* variables that the committed tokens.json does not -- the ` +
      'block is GENERATED and someone hand-edited it'
  ).toEqual([]);
  expect(
    Object.keys(expected).filter((k) => !(k in declared)).sort(),
    `${selector} is missing variables the committed tokens.json has`
  ).toEqual([]);
}

/**
 * State-pseudo rules, which no computed-style check can reach: the probe forces `:hover` through
 * `wkForceHover` and no `:disabled` or `:focus-visible` (`.claude/rules/styles.md`). Values are
 * hand-typed from measurement, never read back out of the sheet. Jira's `a:hover` was read off a
 * real posted comment in a logged-in browser, where the underline vanishes on hover.
 */
describe('rules no computed style can reach', () => {
  /** The declaration block for an exact selector, as one whitespace-collapsed string. */
  const ruleFor = (css: string, selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} is not in the sheet at all`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at) + 1).replace(/\s+/g, ' ');
  };

  test('each destination declares its own link-hover behaviour, and they differ', () => {
    // Jira removes the underline on hover; Slack and Linear add one.
    expect(ruleFor(CSS, '[data-destination="jira"] .ProseMirror a:hover'))
      .toContain('text-decoration: none');
    expect(ruleFor(SLACK, '[data-destination="slack"] .ProseMirror a:hover'))
      .toContain('text-decoration: underline');
    expect(ruleFor(LINEAR, '[data-destination="linear"] .ProseMirror a:hover'))
      .toContain('text-decoration: underline');
  });

  test('a disabled Approve button still LOOKS disabled', () => {
    // The probe's `jira-empty` scenario reads the computed style back; this pins the declaration.
    const rule = ruleFor(SHELL, '.dg-btn:disabled');
    expect(rule).toContain('opacity: .5');
    expect(rule).toContain('cursor: not-allowed');
    // The toolbar's disabled buttons are dimmer, a separate value.
    expect(ruleFor(SHELL, '.dg-tb-btn:disabled')).toContain('opacity: .35');
  });

  /**
   * Enumerated by `cursor: pointer`, the sheet's own declaration that a control is pointed at, so a
   * control a hand-list forgot is still seen. The presence of a `:hover` rule, not its values.
   */
  test('every interactive control in the shell has a hover state', () => {
    // Comments out first: a rule preceded by one would start its chunk inside the comment and drop
    // out of the set.
    const css = SHELL.replace(/\/\*[\s\S]*?\*\//g, '');
    /** Selectors whose block declares `cursor: pointer`, split off comma lists. */
    const pointable = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /cursor:\s*pointer/.test(body!))
      .flatMap(([, selector]) => selector!.split(','))
      .map((sel) => sel.trim())
      .filter((sel) => sel.startsWith('.dg-') && !sel.includes(':'));

    expect(pointable.length, 'nothing in the sheet declares cursor: pointer').toBeGreaterThanOrEqual(6);

    const missing = pointable.filter((sel) => !new RegExp(`\\${sel}(:[a-z-]+)*:hover`).test(SHELL));
    expect(
      missing,
      'these declare `cursor: pointer` -- the sheet saying a reviewer points at them -- and have no ' +
        `:hover rule, so they do not answer the cursor: ${missing.join(', ')}`
    ).toEqual([]);
  });

  // The audience banner's claims for kinds no probe scenario renders (the probe draws one at a time).
  test('an INTERNAL audience is green, and does not take the warning palette', () => {
    // Its producer is `POSTS_INTERNAL_NOTE`; amber here would cost the `public` banner its contrast.
    expect(ruleFor(SHELL, '.dg-audience-internal .dg-audience-label')).toContain('var(--dg-ok)');
  });

  test('a PUBLIC audience is painted differently from every other one', () => {
    // `unknown` and `unchanged` share the neutral ground; only a confirmed customer-visible send is amber.
    expect(ruleFor(SHELL, '.dg-audience')).toContain('background: var(--dg-info-bg)');
    expect(ruleFor(SHELL, '.dg-audience-public')).toContain('background: var(--dg-warn-bg)');
    // `.dg-inferred` (the destination was guessed from the tool name) is warning-coloured, not
    // error-coloured: an inferred route is not a fault, but it cannot be quiet.
    expect(ruleFor(SHELL, '.dg-inferred')).toContain('background: var(--dg-warn-bg)');
    expect(ruleFor(SHELL, '.dg-inferred')).toContain('color: var(--dg-warn)');
    expect(ruleFor(SHELL, '.dg-inferred')).not.toContain('--dg-error');
  });

  test('the audience question DOES look like a control, unlike its neighbour', () => {
    // `.dg-audience-off` names a choice this tool cannot make; `.dg-audience-answer` asks for one it
    // can remember. The probe reads the cursor back; these are the states it cannot reach.
    expect(ruleFor(SHELL, '.dg-audience .dg-audience-answer')).toContain('cursor: pointer');
    expect(ruleFor(SHELL, '.dg-audience .dg-audience-answer:hover')).toContain('background:');
    expect(ruleFor(SHELL, '.dg-audience .dg-audience-answer:focus-visible')).toContain('outline:');
  });

  test('the audience the tool cannot reach does not LOOK like a control', () => {
    // `surface/window.test.tsx` pins that it is a <span>; this, that it does not read as clickable.
    // Probed: `addCommentToJiraIssue` has no parameter for the audience.
    const rule = ruleFor(SHELL, '.dg-audience-off');
    expect(rule).toContain('text-decoration: line-through');
    expect(rule).toContain('cursor: default');
    expect(rule).not.toContain('cursor: pointer');
  });

  test('and keyboard focus is visible on the controls that take it', () => {
    expect(ruleFor(SHELL, '.dg-theme-toggle:focus-visible')).toContain('border-color:');
    expect(ruleFor(SHELL, '.dg-warn-fix:focus-visible')).toContain('outline:');
  });
});

/**
 * The Slack mention token, asserted by value: `--dt_color-surf-hgl-3` in place of `-1` would render
 * every ordinary mention as though it named the reader.
 */
describe('the Slack mention token is declared, and it is Slack-shaped', () => {
  const MTOK = '[data-destination="slack"] .ProseMirror .dg-mtok';
  const RULE = ruleBody(SLACK, MTOK);

  test('it is declared at all', () => {
    expect(RULE, 'no .dg-mtok rule in slack.css').not.toBeNull();
  });

  test("it is Slack's ORDINARY mention: --link, not the reader-included highlight", () => {
    const body = RULE!;
    expect(body).toContain('color: var(--dt_color-content-hgl-1)');
    expect(body).toContain('background-color: var(--dt_color-surf-hgl-1)');
    expect(body).toContain('border-radius: 3px');
    expect(body).toContain('padding: 1px 2px');
  });

  test('and NOT cursor, because this window makes it clickable nowhere', () => {
    // As for the Jira chip: `link.openOnClick` is false here.
    expect(RULE!).not.toMatch(/(^|;)\s*cursor\s*:/m);
  });

  test("a broadcast gets Slack's --mention highlight, in BOTH themes", () => {
    // A channel-wide ping includes the reader, and `--mention` is what Slack draws then. Light sets
    // a ground and lets the ink fall through, as Slack does; dark sets both, so dark is asserted
    // on its own.
    const light = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror .dg-mtok-broadcast');
    expect(light, 'no broadcast rule').not.toBeNull();
    expect(light!).toContain('background-color: var(--dt_color-surf-hgl-3)');

    const dark = ruleBody(
      SLACK,
      '[data-destination="slack"][data-theme="dark"] .ProseMirror .dg-mtok-broadcast'
    );
    expect(dark, 'no DARK broadcast rule -- the ink override is dark-only').not.toBeNull();
    expect(dark!).toContain('color: var(--dt_color-content-hgl-3)');
  });

  test('all three tokens it needs are in BOTH generated palettes', () => {
    // `var()` on an undefined custom property falls back silently: transparent ground, inherited ink.
    for (const selector of [
      '[data-destination="slack"]',
      '[data-destination="slack"][data-theme="dark"]',
    ]) {
      const palette = ruleBody(SLACK, selector)!;
      for (const tok of [
        '--dt_color-surf-hgl-1:',
        '--dt_color-surf-hgl-3:',
        '--dt_color-content-hgl-3:',
      ]) {
        expect(palette, `${selector} ${tok}`).toContain(tok);
      }
    }
  });

  test('jira.css deliberately carries no token rule', () => {
    // Jira has no token patterns: `[~accountid:x]` reaches it as literal characters, probed.
    // `core/test/mentionTokens.test.ts` pins the pattern side.
    expect(CSS, 'jira.css must not style a token it can never render').not.toContain('dg-mtok');
  });
});

/**
 * Linear's mention token is quieter than Slack's: Linear draws bold text, not a pill. `@slug` is
 * matched on shape alone, so an over-marked `@todo` should read as bold prose, not wear a chip.
 */
describe("Linear's mention token is its own typography, not Slack's pill", () => {
  const RULE = ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror .dg-mtok');

  test('it is declared at all', () => {
    expect(RULE, 'no .dg-mtok rule in linear.css').not.toBeNull();
  });

  test("it is weight 500 -- Linear's own `--font-weight-medium`, from Linear's editor CSS", () => {
    // `.editor a[data-mention-type=entityMention]` in `static.linear.app/client/assets/style-*.css`
    // sets `font-weight: var(--font-weight-medium)`, and that file defines it as 500.
    expect(RULE!).toContain('font-weight: 500');
  });

  test('and carries NO ground, radius or pointer', () => {
    // Linear sets none of these on a rendered mention.
    for (const prop of ['background', 'border-radius', 'cursor']) {
      expect(RULE!, `linear.css must not declare ${prop} on a mention`).not.toMatch(
        new RegExp(`(^|;)\\s*${prop}`, 'm')
      );
    }
  });
});

/**
 * A link Linear turns into a mention, drawn as one.
 *
 * Only Linear declares `mentions.links` (`core/test/mentionTokens.test.ts`), so only its sheet may
 * style what `mentionLinkDecorations` emits. The rendered effect is the probe's `linear-profile-links`.
 */
describe('a Linear profile link is drawn as a mention', () => {
  test('linear.css draws the `@` and hides the address in front of a bare URL\'s slug', () => {
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror .dg-mlink-at::before')).toContain(
      'content: "@"'
    );
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror .dg-mlink-hidden')).toContain(
      'display: none'
    );
  });

  test('no other sheet styles a mention link it can never render', () => {
    for (const [name, css] of [['jira', CSS], ['slack', SLACK], ['github', GITHUB]] as const) {
      expect(css, name).not.toContain('dg-mlink');
    }
  });
});

/** The chrome that says who a draft notifies. */
describe('the mention note cannot change the strip height', () => {
  test('the strip note may not wrap', () => {
    // `.dg-status` has a fixed height; a wrapped line would move the editor under the cursor.
    expect(ruleBody(SHELL, '.dg-mentions')!).toContain('white-space: nowrap');
  });

  test('the detail row is declared, and is NOT a warning row', () => {
    // A mention is not a defect, so it stays off the `.dg-warn` grid and never drives `blocked`.
    const detail = ruleBody(SHELL, '.dg-warn-mentions');
    expect(detail, 'no .dg-warn-mentions rule in shell.css').not.toBeNull();
    expect(detail!).toContain('display: block');
  });

  test('a broadcast is loud in the CHROME, where draftgate speaks in its own voice', () => {
    // Not Slack's colour: the body pill mirrors Slack, this row is draftgate's.
    expect(ruleBody(SHELL, '.dg-mentions[data-broadcast]')!).toContain('font-weight: 700');
  });
});

/**
 * The mention chip is declared, and Jira is still the only destination that can produce one. A
 * `mention` node reaches the editor only where the profile sets `mentions.chips` (it gates
 * `decodeMentions`), so the flag is read from the profiles: a destination that gains it fails here
 * instead of rendering an unstyled mention as ordinary prose.
 */
describe('the Jira mention chip is declared, and only Jira needs one', () => {
  const RULE = ruleBody(CSS, '[data-destination="jira"] .ProseMirror span[data-type="mention"]');

  test('it is declared at all', () => {
    expect(RULE, 'no mention rule in jira.css').not.toBeNull();
  });

  test('it draws a chip: ground, text and a pill radius', () => {
    const body = RULE!;
    // `@atlaskit/mention`'s default state, by value: `--ds-background-brand-bold` would render every
    // mention as self.
    expect(body).toContain('background: var(--ds-background-neutral)');
    expect(body).toContain('color: var(--ds-text-subtle)');
    expect(body).toContain('border-radius: 20px');
  });

  test('and NOT cursor: pointer, because this window makes it clickable nowhere', () => {
    // Dropped from the upstream declarations: nothing here is clickable (`Editor.tsx` sets
    // `link.openOnClick: false`).
    expect(RULE!).not.toMatch(/(^|;)\s*cursor\s*:/m);
  });

  test('its hover state is declared too', () => {
    const hover = ruleBody(CSS, '[data-destination="jira"] .ProseMirror span[data-type="mention"]:hover');
    expect(hover, 'no :hover rule for the mention chip').not.toBeNull();
    expect(hover!).toContain('background: var(--ds-background-neutral-hovered)');
  });

  test('both tokens it needs are in BOTH generated palettes', () => {
    // `var()` on an undefined custom property falls back silently; per theme, because a token in one
    // palette only breaks dark alone.
    for (const selector of [
      '[data-destination="jira"]',
      '[data-destination="jira"][data-theme="dark"]',
    ]) {
      const palette = ruleBody(CSS, selector)!;
      expect(palette, selector).toContain('--ds-text-subtle:');
      expect(palette, selector).toContain('--ds-background-neutral-hovered:');
    }
  });

  test('and the two non-colour tokens the chip needs are declared', () => {
    // `tokens:jira` emits colours only, so these are hand-authored.
    const hand = ruleBody(CSS, '[data-destination="jira"]')!;
    expect(hand).toContain('--ds-border-width:');
    expect(hand).toContain('--ds-font-weight-regular:');
  });

  test('Jira is STILL the only destination whose editor can hold a mention node', async () => {
    const { profiles } = await import('../../core/src/profiles');
    const structural = Object.entries(profiles)
      .filter(([, p]) => p.mentions.chips !== null)
      .map(([name]) => name);
    expect(
      structural,
      'a destination gained mention chips: its sheet needs a mention rule, or an unstyled ' +
        'mention will render as ordinary prose there'
    ).toEqual(['jira']);
  });

  test('so the other two sheets deliberately carry no mention rule', () => {
    // A rule for another destination takes that destination's values, not Jira's.
    for (const [name, sheet] of [['slack', SLACK], ['linear', LINEAR]] as const) {
      expect(sheet, name).not.toContain('data-type="mention"');
    }
  });
});

describe('the generated Jira palettes match the committed token evidence', () => {
  for (const [theme, selector] of [
    ['light', '[data-destination="jira"]'],
    ['dark', '[data-destination="jira"][data-theme="dark"]'],
  ] as const) {
    test(`${theme} is exactly tokens.json's ${theme} column`, () => {
      expectPalette(CSS, selector, '--ds-', TOKENS[theme], 12);
    });
  }

  test('both themes declare the SAME set of colour variables', () => {
    // A variable missing in dark inherits the light value.
    expect(Object.keys(TOKENS.dark).sort()).toEqual(Object.keys(TOKENS.light).sort());
  });

  test('every colour actually DIFFERS between the themes', () => {
    // An identical value means the generator resolved one token twice.
    const same = Object.keys(TOKENS.light).filter((k) => TOKENS.light[k] === TOKENS.dark[k]);
    expect(same).toEqual([]);
  });

  test('--ds-border stays TRANSLUCENT in both, which is the point', () => {
    // Table cells and the blockquote bar share it. A flattened copy (#dddee1, the value over white)
    // would draw a near-white line on dark. 8-digit hex, so an alpha channel, in both columns.
    expect(TOKENS.light['--ds-border']).toMatch(/^#[0-9A-Fa-f]{8}$/);
    expect(TOKENS.dark['--ds-border']).toMatch(/^#[0-9A-Fa-f]{8}$/);
    expect(CSS).not.toContain('--ds-border-translucent:');
  });

  test('the generated block says it is generated, and how to regenerate it', () => {
    expect(CSS).toContain('GENERATED');
    expect(CSS).toContain('bun run tokens:jira');
  });

  test('the one raw colour outside the generated palettes is the measured dark code panel', () => {
    // The palette checks read only the first block per selector, so the whole sheet is counted here:
    // every raw-colour variable is a generated token once per theme, or `--jira-code-panel`,
    // logged-in Jira's dark code panel, #333337, read off a capture. A token restated counts twice.
    expect(rawColours(CSS)).toEqual([]);
    expect(rawColourVariables(CSS).sort()).toEqual(
      [...Object.keys(TOKENS.light), ...Object.keys(TOKENS.dark), '--jira-code-panel'].sort()
    );
  });
});

/*
 * `shell.css` is draftgate's own chrome, hand-typed from Atlassian's accent tokens, so a
 * `tokens:jira` regenerate that moves `jira.css` must move these too. Only the declarations the
 * sheet says come from a token; the tinted warning grounds and `--ds-surface-sunken` have none.
 */
describe("shell.css's chrome palette is the Atlassian accent tokens it says it is", () => {
  const TRACEABLE: Record<string, string> = {
    '--dg-error': '--ds-text-accent-red',
    '--dg-warn': '--ds-text-accent-yellow',
    '--dg-info': '--ds-text-accent-blue',
    '--dg-ok': '--ds-text-accent-green',
    '--dg-ink-quiet': '--ds-text-subtlest',
  };
  /** Dark carries the four accents plus the three the light block spells out differently. */
  const TRACEABLE_DARK: Record<string, string> = {
    ...TRACEABLE,
    '--dg-ink': '--ds-text',
    '--dg-line': '--ds-border',
    '--dg-panel': '--ds-surface',
  };

  for (const [theme, selector, map] of [
    ['light', ':root', TRACEABLE],
    ['dark', ':root[data-theme="dark"]', TRACEABLE_DARK],
  ] as const) {
    test(`${theme} matches tokens.json's ${theme} column`, () => {
      const declared = declarations(SHELL, selector, '--dg-');
      for (const [dg, ds] of Object.entries(map)) {
        // Case-insensitive: the sheet writes lowercase hex, tokens.json carries Atlassian's upper.
        expect(declared[dg]?.toLowerCase()).toBe(TOKENS[theme][ds]!.toLowerCase());
      }
    });
  }
});

/*
 * `linear.css`'s palettes, generated by `bun run tokens:linear` into `tools/linear-tokens/tokens.json`.
 * The colour source is linear.app, the marketing site, not the issue editor, which is why
 * `linearProfile` is `previewFidelity: 'indicative'`.
 */
describe("linear.css's generated palettes match Linear's own CSS", () => {
  /** The sheet's RULES: past the generated block and the header, with comments removed. */
  const RULES = LINEAR.slice(LINEAR.indexOf('--ln-sans')).replace(/\/\*[\s\S]*?\*\//g, '');

  for (const theme of ['light', 'dark'] as const) {
    const selector =
      theme === 'light'
        ? '[data-destination="linear"]'
        : '[data-destination="linear"][data-theme="dark"]';

    test(`${theme} is exactly tokens.json's ${theme} column`, () => {
      expectPalette(LINEAR, selector, '--color-', LINEAR_TOKENS[theme], 8);
    });
  }

  test('the two themes declare the SAME set of variables', () => {
    // One missing in dark inherits the light value.
    expect(Object.keys(LINEAR_TOKENS.dark).sort()).toEqual(Object.keys(LINEAR_TOKENS.light).sort());
  });

  test('the brand colour genuinely DIFFERS between themes', () => {
    // #5e6ad2 is Linear's dark brand colour, the right hue in the wrong theme on a light button.
    expect(LINEAR_TOKENS.light['--color-brand-bg']).toBe('#7070ff');
    expect(LINEAR_TOKENS.dark['--color-brand-bg']).toBe('#5e6ad2');
  });

  test('links use the LINK token, not the brand one', () => {
    // Linear separates link, brand and chrome accent.
    expect(LINEAR).toContain('color: var(--color-link-primary)');
    // No raw colour in a rule, and no hand-authored `--ln-link` standing in for the token.
    expect(RULES).not.toContain('--ln-link');
    expect(rawColours(LINEAR)).toEqual([]);
  });

  test("the only raw colour outside the generated block is the measured label-faint, once per theme", () => {
    // `rawColours` exempts custom properties. One is allowed per theme: Linear's runtime
    // `--editor-label-faint`, which no generated token carries, read off a capture of each theme's
    // checklist box; the code block's numbers take it too.
    expect(rawColourVariables(RULES, true)).toEqual([
      '[data-destination="linear"] --ln-label-faint',
      '[data-destination="linear"][data-theme="dark"] --ln-label-faint',
    ]);
  });

  test("the editor's own COLOUR tokens are recorded as unresolvable, not as values", () => {
    // Both indirect through `--sx-*` slots the shipped CSS declares empty and the app fills in
    // JavaScript, so the evidence keeps the indirection rather than a value nobody measured.
    expect(LINEAR_TOKENS.editor['--editor-text-color']).toMatch(/^var\(--sx-/);
    expect(LINEAR_TOKENS.editor['--editor-surface-background']).toMatch(/^var\(--sx-/);
  });

  test('the wired editor geometry is Linear\'s own value, not a guess', () => {
    expect(LINEAR_TOKENS.editor['--editor-line-height']).toBe('1.6');
    expect(LINEAR_TOKENS.editor['--editor-list-inset']).toBe('1.5rem');
    expect(LINEAR_TOKENS.editor['--editor-block-radius']).toBe('6px');
    expect(LINEAR_TOKENS.editor['--editor-todolist-checkbox-width']).toBe('14px');
    expect(LINEAR).toContain('padding-left: 1.5rem');
    expect(LINEAR).toContain('letter-spacing: -.00666667em');
  });

  test('the provenance is stated in the sheet, because it is easy to overstate', () => {
    expect(LINEAR).toContain('MARKETING SITE');
    expect(LINEAR_TOKENS.source).toBe('https://linear.app/');
  });
});

/*
 * `slack.css`'s palettes, generated by `bun run tokens:slack`: `app.slack.com/client` serves the
 * application shell unauthenticated, and `rollup-style-plastic.*.min.css` defines 417
 * `--dt_color-*` tokens under exactly two selectors.
 */
describe("slack.css's generated palettes match Slack's own client CSS", () => {
  for (const theme of ['light', 'dark'] as const) {
    const selector =
      theme === 'light'
        ? '[data-destination="slack"]'
        : '[data-destination="slack"][data-theme="dark"]';

    test(`${theme} is exactly tokens.json's ${theme} column`, () => {
      // The light block also carries the theme-independent `constants`.
      const expected =
        theme === 'light' ? { ...SLACK_TOKENS[theme], ...SLACK_TOKENS.constants } : SLACK_TOKENS[theme];
      expectPalette(SLACK, selector, '--dt_color-', expected, 8);
    });
  }

  test('a custom SIDEBAR theme defines no colour tokens -- the probe, not the assumption', () => {
    // A sidebar theme does not change the message body: `.sk-client-theme--light-inverted-sidebar`
    // only scopes sidebar components and defines zero `--dt_color-*`.
    expect(SLACK_TOKENS.sidebarThemeColourTokens).toBe(0);
  });

  test("Slack's green MOVES between themes, which no hand-written hex can follow", () => {
    // #007a5a is Slack's light value; hard-coded, it would give a dark pane a too-dark button.
    expect(SLACK_TOKENS.light['--dt_color-content-hgl-2']).toBe('#007a5a');
    expect(SLACK_TOKENS.dark['--dt_color-content-hgl-2']).toBe('#3daa7c');
  });

  test('values transcribed by hand agree with the extraction, so it is trustworthy', () => {
    // Hand transcriptions, byte-identical to Slack's own tokens.
    expect(SLACK_TOKENS.light['--dt_color-content-pry']).toBe('#1d1c1d');
    expect(SLACK_TOKENS.light['--dt_color-content-hgl-1']).toBe('#1264a3');
  });

  test("inline code is ORANGE in dark, which no token would have told us", () => {
    // A literal, not a token: `.sk-client-theme--dark .c-mrkdwn__code { color: #e8912d }`.
    // `otl-imp`, the light value's token, is #d94c75 (pink) in dark. Unscoped, so the body's.
    expect(SLACK_TOKENS.attested['--sl-code-text'].dark).toBe('#e8912d');
    expect(SLACK_TOKENS.attested['--sl-code-text'].selector).toBe(
      '.sk-client-theme--dark .c-mrkdwn__code'
    );
  });

  test('the LIGHT inline-code colour is recorded as unattested, not invented', () => {
    // The only other `.c-mrkdwn__code` colour is scoped to `light-inverted-sidebar`, so light takes
    // `otl-imp`.
    expect(SLACK_TOKENS.attested['--sl-code-text'].lightFrom).toBe('--dt_color-otl-imp');
    expect(SLACK_TOKENS.attested['--sl-code-text'].light).toBe('#e01e5a');
  });

  test('no RULE carries a raw colour', () => {
    expect(rawColours(SLACK)).toEqual([]);
  });

  test('a CONSTANT is declared once, and both themes inherit it', () => {
    // The text on a solid coloured button, white in either theme; Slack declares it on `:root`.
    expect(SLACK_TOKENS.constants['--dt_color-constants-white']).toBe('#fff');
    const dark = declarations(SLACK, '[data-destination="slack"][data-theme="dark"]', '--dt_color-');
    expect(dark['--dt_color-constants-white']).toBeUndefined();
  });

  test('the provenance is stated, because "Slack" and "Slack default" are different claims', () => {
    expect(SLACK_TOKENS.source).toBe('https://app.slack.com/client');
  });
});

/**
 * GitHub draws a comment in a platform face, and `github.css` must bundle none for it. The ruler's
 * `faces` are the rasteriser's answer in both themes and on the live page: `"Mona Sans VF"` heads
 * GitHub's stack and nothing on the page loads it.
 */
describe('a GitHub comment is drawn in the system face, and the sheet bundles none', () => {
  test('the ruler saw a platform face on every surface it measured', () => {
    for (const [name, surface] of Object.entries(RULER.surfaces)) {
      for (const [mode, faces] of Object.entries(surface.faces)) {
        const prose = faces.paragraph;
        expect(prose?.length, `${name} ${mode}: no face recorded for the prose`).toBeGreaterThan(0);
        for (const [key, list] of Object.entries(faces)) {
          for (const face of list ?? []) {
            expect(face.isCustomFont, `${name} ${mode} ${key} drew in a WEB font, ${face.familyName}`)
              .toBe(false);
          }
        }
      }
    }
  });

  test('no family in --gh-sans is one the window bundles', () => {
    // Lowercased on both sides: CSS matches family names case-insensitively, so `lato` is `Lato`.
    const bundled = new Set(BUNDLED_FACES.map((f) => f.family.toLowerCase()));
    expect(bundled.size, 'found no bundled @font-face families -- the scan broke').toBeGreaterThan(0);
    const stack = /--gh-sans:\s*([^;]+);/.exec(ruleBody(GITHUB, '[data-destination="github"]') ?? '')?.[1];
    expect(stack, 'github.css declares no --gh-sans').toBeTruthy();
    const named = stack!.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase());
    expect(named.filter((f) => bundled.has(f))).toEqual([]);
  });

  test("tables use GitHub's equal-width digits", () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(RULER.surfaces.comment!.local[mode].table?.['font-variant-numeric']).toBe('tabular-nums');
    }
    expect(ruleBody(GITHUB, '[data-destination="github"] .ProseMirror table')).toContain(
      'font-variant-numeric: tabular-nums'
    );
  });
});

/*
 * `github.css` against the ruler's computed values, not declared tokens: `.markdown-body` says
 * `font-size: 16px` and a comment renders at 14px, because the element also carries `.comment-body`.
 * So the sheet's variables are resolved and colours compared numerically. `probe.ts` keeps its own
 * literals and still disagrees with the sheet (`.claude/rules/styles.md`).
 */
describe("github.css matches what the ruler measured off GitHub", () => {
  /** The sheet's own variables, per theme, resolved one level of `var()` deep. */
  function palette(theme: 'light' | 'dark'): Record<string, string> {
    const selector =
      theme === 'light'
        ? '[data-destination="github"]'
        : '[data-destination="github"][data-theme="dark"]';
    return declarations(GITHUB, selector, '--gh-');
  }

  /** `#rgb`, `#rrggbb` or `#rrggbbaa` as the numbers Chromium would compute. */
  function parseHex(hex: string): [number, number, number, number] {
    const h = hex.trim().replace(/^#/, '');
    const wide = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
    const n = (i: number) => parseInt(wide.slice(i * 2, i * 2 + 2), 16);
    return [n(0), n(1), n(2), wide.length === 8 ? n(3) / 255 : 1];
  }

  /** `rgb(r, g, b)` / `rgba(r, g, b, a)` as Chromium serialises it. */
  function parseComputed(value: string): [number, number, number, number] {
    const m = /rgba?\(([^)]+)\)/.exec(value);
    expect(m, `not a computed colour: ${value}`).not.toBeNull();
    const parts = m![1]!.split(',').map((p) => Number(p.trim()));
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }

  /**
   * The same colour, allowing for Chromium's alpha rounding: `#d1d9e0b3` computes as
   * `rgba(209, 217, 224, 0.7)` (179/255 = 0.70196, printed to two decimals).
   */
  function sameColour(hex: string, computed: string): boolean {
    const a = parseHex(hex);
    const b = parseComputed(computed);
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && Math.abs(a[3] - b[3]) < 0.01;
  }

  /**
   * Which sheet variable must equal which measured value, as `[measured key, property, variable]`.
   *
   * Every comment colour the ruler measures. Not here: the chrome's (`--gh-success-*`,
   * `--gh-on-emphasis`, `--gh-control-hover`, `--gh-overlay`) and the checkbox's
   * (`--gh-border-emphasis`, `--gh-accent-emphasis`), which the ruler's `POST /markdown` render does
   * not draw; it carries the native checkbox.
   */
  const COLOURS: Array<[string, string, string]> = [
    ['body', 'color', '--gh-fg'],
    ['h6', 'color', '--gh-fg-muted'],
    ['blockquote', 'color', '--gh-fg-muted'],
    ['link', 'color', '--gh-accent'],
    ['inlineCode', 'background-color', '--gh-neutral-muted'],
    ['codeBlock', 'background-color', '--gh-canvas-muted'],
    ['trOdd', 'background-color', '--gh-canvas'],
    ['trEven', 'background-color', '--gh-canvas-muted'],
    ['hr', 'background-color', '--gh-border'],
  ];

  for (const theme of ['light', 'dark'] as const) {
    for (const [key, property, variable] of COLOURS) {
      test(`${theme}: ${variable} is what GitHub computes for ${key} ${property}`, () => {
        const measured = (RULER.surfaces.comment.local[theme] as Record<string, Record<string, string>>)[key];
        expect(measured, `${key} was not measured`).toBeTruthy();
        const declared = palette(theme)[variable];
        expect(declared, `${variable} is not declared for ${theme}`).toBeDefined();
        expect(
          sameColour(declared!, measured![property]!),
          `${variable} is ${declared} but GitHub computes ${measured![property]} for ${key}`
        ).toBe(true);
      });
    }
  }

  test('the border colours are the ones inside the shorthands', () => {
    // Measured as whole shorthands, so checked here rather than in the table above.
    const light = palette('light');
    const th = RULER.surfaces.comment.local.light.th!['border']!;
    expect(sameColour(light['--gh-border']!, th)).toBe(true);
    const quote = RULER.surfaces.comment.local.light.blockquote!['border-left']!;
    expect(sameColour(light['--gh-border']!, quote)).toBe(true);
    const rule = RULER.surfaces.comment.local.light.h1!['border-bottom']!;
    expect(sameColour(light['--gh-border-muted']!, rule)).toBe(true);
  });

  test('the two themes declare the SAME set of variables', () => {
    expect(Object.keys(palette('dark')).sort()).toEqual(Object.keys(palette('light')).sort());
  });

  test('no RULE carries a raw colour -- every one comes from the palette blocks', () => {
    expect(rawColours(GITHUB)).toEqual([]);
  });

  /**
   * The heading ladder: the sheet's own declaration per selector against what GitHub was measured
   * computing. Per selector, because a substring search over the sheet cannot fail for the body
   * (`'14px'` also matches `h4` and `blockquote`), and `.ProseMirror { font: 400 14px/21px }` at
   * `16px` would ship every heading 14% too large. `em` resolves against the measured 14px body, so
   * a changed body size moves its `em` children with it, as GitHub's own sheet does.
   */
  const GEOMETRY: Array<[key: string, property: string, selector: string, declared: string]> = [
    ['body', 'font-size', '[data-destination="github"] .ProseMirror', 'font'],
    ['body', 'line-height', '[data-destination="github"] .ProseMirror', 'font'],
    ['h1', 'font-size', '[data-destination="github"] .ProseMirror h1', 'font-size'],
    ['h2', 'font-size', '[data-destination="github"] .ProseMirror h2', 'font-size'],
    ['h3', 'font-size', '[data-destination="github"] .ProseMirror h3', 'font-size'],
    ['h4', 'font-size', '[data-destination="github"] .ProseMirror h4', 'font-size'],
    ['h5', 'font-size', '[data-destination="github"] .ProseMirror h5', 'font-size'],
    ['h6', 'font-size', '[data-destination="github"] .ProseMirror h6', 'font-size'],
    ['codeBlock', 'font-size', '[data-destination="github"] .ProseMirror pre', 'font'],
    ['codeBlock', 'line-height', '[data-destination="github"] .ProseMirror pre', 'font'],
    ['inlineCode', 'font-size', '[data-destination="github"] .ProseMirror :not(pre) > code', 'font-size'],
    ['blockquote', 'padding-left', '[data-destination="github"] .ProseMirror blockquote', 'padding-left'],
    ['hr', 'height', '[data-destination="github"] .ProseMirror hr', 'height'],
  ];

  /** The body size every `em` in this sheet multiplies, taken from the measurement. */
  const BODY_PX = Number(
    (RULER.surfaces.comment.local.light.body as Record<string, string>)['font-size']!.replace('px', '')
  );

  /**
   * One declaration's value in px, or `null` when the rule does not carry it. Against `font` (the
   * body's and code block's shorthand), size and line height are split out of `400 14px/21px …`.
   */
  function declaredPx(body: string, declaredAs: string, property: string): number | null {
    const value = declared(body, declaredAs);
    if (value === undefined) return null;
    const raw =
      declaredAs !== 'font'
        ? value
        : property === 'font-size'
          ? /(\S+?)\//.exec(value)?.[1] ?? null
          : /\/(\S+)/.exec(value)?.[1] ?? null;
    if (raw === null) return null;
    if (raw.endsWith('px')) return Number(raw.slice(0, -2));
    if (raw.endsWith('em')) return Number(raw.slice(0, -2)) * BODY_PX;
    return null;
  }

  // Cell alignment, which GitHub leaves to the browser, so the sheet declares none. If GitHub ever
  // declares one, the measured value stops being the default and this fails.
  for (const [cell, browserDefault] of [['th', 'center'], ['td', 'start']] as const) {
    test(`${cell} text-align: the browser's own, as GitHub's sheet leaves it`, () => {
      const measured = (RULER.surfaces.comment!.local.light as Record<string, Record<string, string>>)[cell];
      expect(measured?.['text-align']).toBe(browserDefault);
      const rule = ruleBody(GITHUB, `[data-destination="github"] .ProseMirror ${cell}`);
      expect(rule, `no rule for ${cell}`).not.toBeNull();
      expect(declared(rule!, 'text-align')).toBeUndefined();
    });
  }

  for (const [key, property, selector, declared] of GEOMETRY) {
    test(`${key} ${property}: the sheet declares what GitHub was measured computing`, () => {
      const measured = (RULER.surfaces.comment.local.light as Record<string, Record<string, string>>)[key];
      expect(measured?.[property], `${key} ${property} was not measured`).toBeDefined();
      const rule = ruleBody(GITHUB, selector);
      expect(rule, `no rule for ${selector}`).not.toBeNull();
      const px = declaredPx(rule!, declared, property);
      expect(px, `${selector} declares no usable ${declared}`).not.toBeNull();
      expect(px, `${selector} { ${declared} } against GitHub's ${key} ${property}`).toBeCloseTo(
        Number(measured![property]!.replace('px', '')),
        3
      );
    });
  }

  /**
   * The ruler's own cross-check against a live github.com page, per key. It names its two expected
   * disagreements; any other `differ` in the committed file means the assembled surface drifted
   * from GitHub's. No network: it reads what the last run wrote.
   */
  test('the committed measurement had no unexplained disagreement with a live GitHub page', () => {
    for (const [surface, { agrees }] of Object.entries(RULER.surfaces)) {
      for (const [key, verdict] of Object.entries(agrees)) {
        expect(
          verdict !== null && typeof verdict === 'object' && 'differ' in verdict
            ? { surface, key, ...verdict }
            : 'ok',
          `${surface}.${key} disagreed with the live page`
        ).toBe('ok');
      }
    }
  });

  test('the cross-check actually covered something, rather than passing by exhaustion', () => {
    // Every key `untested` would pass the test above. The floors the ruler's README claims.
    expect(RULER.surfaces.comment.live.rootMatches).toBeGreaterThanOrEqual(2);
    expect(RULER.surfaces.readme.live.rootMatches).toBeGreaterThanOrEqual(8);
  });
});

/*
 * The editor must not jump because of a warning. The warning lives in the always-present
 * fixed-height strip; nothing in its row may be taller than the row's text (so the actions are
 * links, not buttons), and the unfurled list hangs off it absolutely. These check that the sheet has
 * not grown a height, a padding or a button box; the probe pins `.dg-status`'s and `.dg-header`'s
 * computed heights in every scenario that checks styles.
 */
describe('the verdict strip cannot change the editor\'s height', () => {
  /** `shell.css`'s block for a selector, failing by name when it is gone. */
  function body(selector: string): string {
    const found = ruleBody(SHELL, selector);
    expect(found, `no rule for ${selector} in shell.css`).not.toBeNull();
    return found!;
  }

  test('the row adds no height of its own', () => {
    // The row supplies the 16px left inset; no vertical padding.
    const rule = body('.dg-warnbar');
    expect(rule).not.toMatch(/(^|;)\s*(min-)?height\s*:/m);
    expect(rule).not.toMatch(/padding-(top|bottom)\s*:/);
  });

  test('and its message clips to one line rather than wrapping', () => {
    const rule = body('.dg-warnbar-msg');
    expect(rule).toMatch(/white-space\s*:\s*nowrap/);
    expect(rule).toMatch(/overflow\s*:\s*hidden/);
    // Allowed to shrink below its content, or it pushes its siblings out.
    expect(rule).toMatch(/(^|;)\s*min-width\s*:\s*0\s*(;|$)/m);
  });

  test('the warning actions are text, with no box to be taller than the row', () => {
    // A `.dg-btn` is 8px of padding and a border taller than the text beside it.
    const rule = body('.dg-warnlink');
    expect(rule).toMatch(/(^|;)\s*padding\s*:\s*0\s*(;|$)/m);
    expect(rule).toMatch(/(^|;)\s*border\s*:\s*none/m);
    expect(rule).not.toMatch(/(^|;)\s*(min-)?height\s*:/m);
  });

  test('the strip declares a fixed height, never a minimum', () => {
    const rule = body('.dg-status');
    expect(rule).toMatch(/(^|;)\s*height\s*:\s*33px/m);
    expect(rule).not.toMatch(/min-height/);
    // No padding, or the absolutely positioned overlay is inset by it.
    expect(rule).toMatch(/(^|;)\s*padding\s*:\s*0\s*(;|$)/m);
    expect(rule).toMatch(/(^|;)\s*position\s*:\s*relative/m);
  });

  test('the unfurled list is drawn over the draft, not by expanding the strip', () => {
    const rule = body('.dg-status .dg-warnings');
    expect(rule).toMatch(/(^|;)\s*position\s*:\s*absolute/m);
    expect(rule).toMatch(/(^|;)\s*top\s*:\s*100%/m);
    // Opaque: agent-authored content is underneath it.
    expect(rule).toMatch(/background\s*:\s*var\(--dg-panel\)/);
  });

  test('and stays below the two floating controls that must still win', () => {
    // The selection toolbar (20) and the emoji picker (30) can both be open over the draft.
    const z = zIndexIn(body('.dg-status .dg-warnings'));
    expect(z, 'the overlay declares no z-index, so stacking is source order').not.toBeNull();
    expect(z!).toBeLessThan(20);
  });

  test('and the footer buttons still cannot shrink or wrap', () => {
    // A competing element in that row would wrap "Approve & send (⌘↵)" onto a second line.
    expect(body('.dg-actions .dg-btn')).toMatch(/(^|;)\s*flex\s*:\s*none/m);
    expect(body('.dg-actions .dg-btn')).toMatch(/white-space\s*:\s*nowrap/);
  });
});

/*
 * Pointing at a node must not move the draft either: `.dg-lost-highlight` is an `outline`, which
 * takes no space, never a `border`, which reflows. `body/structure-lost` arises from an edit, so no
 * probe scenario builds it; `window.test.tsx` covers the wiring and `surface:e2e`'s `show-me` flow
 * reads the painted rect back out of WebKit.
 */
describe('the warning highlight cannot reflow the draft', () => {
  const RULE = ruleBody(SHELL, '.dg-lost-highlight');

  test('it is declared at all', () => {
    expect(RULE, 'no .dg-lost-highlight rule in shell.css').not.toBeNull();
  });

  test('and draws with an outline, never a border', () => {
    const body = RULE!;
    expect(body).toMatch(/(^|;)\s*outline\s*:/m);
    // `border-radius` is fine; only the shorthand and the width longhands take space.
    expect(body).not.toMatch(/(^|;)\s*border(-width|-top|-left|-right|-bottom)?\s*:/m);
  });
});

/*
 * The repair preview is above everything else that floats; without its own `z-index` the unfurled
 * warning list paints over the diff. No probe scenario opens both.
 */
describe('nothing is drawn over the repair preview', () => {
  function zIndexOf(selector: string): number {
    const rule = ruleBody(SHELL, selector);
    expect(rule, `no rule for ${selector}`).not.toBeNull();
    const z = zIndexIn(rule!);
    expect(z, `${selector} declares no z-index`).not.toBeNull();
    return z!;
  }

  test('the backdrop outranks every floating layer in the window', () => {
    const modal = zIndexOf('.dg-modal-backdrop');
    for (const below of ['.dg-status .dg-warnings', '.dg-bubble', '.dg-linktarget', '.dg-emoji']) {
      expect(zIndexOf(below), `${below} is drawn over the repair preview`).toBeLessThan(modal);
    }
  });

  test('the link-target bubble stacks under the formatting bubble, so a flip cannot hide the controls', () => {
    // Both float over a selection, and Floating UI may flip the target bubble up.
    expect(zIndexOf('.dg-linktarget')).toBeLessThan(zIndexOf('.dg-bubble'));
  });
});

/**
 * Every font weight the sheets ask for must be covered by a bundled `@font-face`, upright and italic.
 * A missing weight silently serves the nearest face (`font-weight: 500` against 400/600/700 draws
 * the 400), and a missing italic slants the upright glyphs (Chromium and WebKit alike).
 * `getComputedStyle` reports the specified weight, so the probe cannot see it. Read off the
 * `@font-face` blocks, not import filenames: a variable face covers a range (`100 900`).
 */
describe('every font weight the sheets ask for is a weight a bundled face covers', () => {
  const STYLES_DRAWN = ['normal', 'italic'] as const;
  type Face = Pick<BundledFace, 'family' | 'style' | 'min' | 'max'>;
  const coversIn = (faces: Face[], family: string, weight: number, style: string) =>
    faces.some((f) => f.family === family && f.style === style && f.min <= weight && weight <= f.max);
  const covers = (family: string, weight: number, style: string = 'normal') =>
    coversIn(BUNDLED_FACES, family, weight, style);

  /** Numeric weights a sheet requests, from `font-weight: N` and the `font:` shorthand, comments out. */
  function requested(css: string): Set<number> {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = new Set<number>();
    for (const m of clean.matchAll(/font-weight:\s*(\d{3})/g)) out.add(Number(m[1]));
    // `font: 450 15px/1.6 var(--ln-sans)` -- the shorthand's weight is the first number,
    // and it is only a weight when a size follows it.
    for (const m of clean.matchAll(/font:\s*(\d{3})\s+[\d.]/g)) out.add(Number(m[1]));
    return out;
  }

  const SHEETS: Array<[string, string, string]> = [
    ['linear.css', LINEAR, 'Inter Variable'],
    ['slack.css', SLACK, 'Lato'],
  ];

  for (const [label, css, family] of SHEETS) {
    test(`${label} asks only for ${family} weights a bundled face covers`, () => {
      expect(BUNDLED_FACES.some((f) => f.family === family), `no bundled @font-face for ${family}`).toBe(true);
      const want = requested(css);
      expect(want.size, `${label} names no numeric font weight`).toBeGreaterThan(0);
      const missing = [...want]
        .sort()
        .flatMap((w) => STYLES_DRAWN.filter((style) => !covers(family, w, style)).map((style) => `${w} ${style}`));
      expect(
        missing,
        `${label} asks for ${family} ${missing.join(', ')}, which no bundled face covers -- ` +
          'CSS will serve the nearest face, or slant the upright one, and nothing will say so.'
      ).toEqual([]);
    });
  }

  test('the style counts: an upright face does not cover an italic at its weight', () => {
    // A `covers()` that ignored the style would answer `true` for the first line.
    const upright: Face[] = [{ family: 'Lato', style: 'normal', min: 400, max: 400 }];
    expect(coversIn(upright, 'Lato', 400, 'italic')).toBe(false);
    expect(coversIn([...upright, { ...upright[0]!, style: 'italic' }], 'Lato', 400, 'italic')).toBe(true);
  });

  test('and Linear asks for 600, which is the weight its own headings use', () => {
    // A live comment's headings are 600, from `.editor .heading-node`, not the 500 of the bare
    // `h1..h6` rule. The mention asks for 500, and bold is 600 too; the loop above checks 600's italic.
    expect(requested(LINEAR).has(600)).toBe(true);
    expect(covers('Inter Variable', 600)).toBe(true);
  });

  test("...and the body prose is Linear's real 450, which only a variable face can draw", () => {
    // With static Inter a requested 450 resolves up to 500.
    expect(requested(LINEAR).has(450)).toBe(true);
    expect(covers('Inter Variable', 450)).toBe(true);
    expect(BUNDLED_FACES.find((f) => f.family === 'Inter Variable')).toMatchObject({ min: 100, max: 900 });
  });
});

/**
 * The file each vendor face points at is the vendor's own font, not merely its family name: a static
 * Inter at one optical size passes `getComputedStyle`, the probe's width check and the family name.
 * The extractors read the served file with `fontFile.ts`; this reads the bundled one with it.
 */
describe("the bundled faces are the vendors' own font files", () => {
  /** The file is the style it is declared as. `null` (the two style bits disagree) fails either way. */
  const isStyle = (facts: FontFacts, style: 'normal' | 'italic', who: string) =>
    expect(facts.italic, `${who} is not ${style === 'italic' ? 'an italic' : 'an upright'} font`).toBe(
      style === 'italic'
    );
  /** The version NUMBER -- `2.015` out of `Version 2.015; <release date>; ...`. */
  const number = (v: string) => /^Version ([\d.]+)/.exec(v)?.[1];

  for (const [style, served] of [
    ['normal', LINEAR_TOKENS.client.face],
    ['italic', LINEAR_TOKENS.client.italicFace],
  ] as const) test(`Linear's ${style} Inter is variable on the same axes, at the same version, as Linear's`, () => {
    expect(served.axes, 'Linear no longer serves opsz + wght').toEqual(['opsz 14..32', 'wght 100..900']);
    // Anchored, so two version strings that both fail to parse cannot agree by being `undefined`.
    expect(number(served.version), `unparseable version: ${served.version}`).toMatch(/^\d+\.\d+$/);
    // Every face of this style, latin and latin-ext.
    const files = BUNDLED_FACES.filter((f) => f.family === 'Inter Variable' && f.style === style);
    expect(files.length).toBeGreaterThan(0);
    for (const face of files) {
      const file = face.file!;
      const ours = fontFacts(readFileSync(file));
      expect(ours.axes, file).toEqual(served.axes);
      // The version number. The builds differ -- Linear's is rsms's release (`git-9221beed3`, 2937
      // glyphs), ours Google Fonts' subsets (`git-66647c0bb`) -- and measured in Chromium at
      // Linear's body (450, 15px) and every heading size at 500 (22/19/17/15px), the two draw the
      // same latin line to the hundredth of a pixel. The headings' 600 is not measured.
      expect(number(ours.version), file).toBe(number(served.version)!);
      isStyle(ours, style, file);
    }
    isStyle(served, style, `Linear's ${style} file`);
  });

  test("Slack's code face is Roboto Mono on Slack's axis", () => {
    const served = SLACK_TOKENS.monoFace;
    isStyle(served, 'normal', "Slack's code file");
    const faces = BUNDLED_FACES.filter((f) => f.family === 'Slack-Roboto-Mono');
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const ours = fontFacts(readFileSync(face.file!));
      isStyle(ours, 'normal', face.file!);
      expect(ours.family).toBe(served.family);
      expect(ours.axes).toEqual(served.axes);
      // 3.001 against Slack's 3.000, so the major version: measured in Chromium at 12px, the same
      // line is 374.469px in both and not one pixel differs.
      expect(number(ours.version)?.split('.')[0]).toBe(number(served.version)!.split('.')[0]!);
    }
  });

  for (const [style, served] of [
    ['normal', SLACK_TOKENS.face],
    ['italic', SLACK_TOKENS.italicFace],
  ] as const) test(`Slack's ${style} Lato is the same version, and the same glyph set, as Slack's`, () => {
    expect(number(served.version), 'Slack no longer serves Lato 2.015').toBe('2.015');
    // Every bundled Lato face of this style, not only the weight the extractor read.
    const faces = BUNDLED_FACES.filter((f) => f.family === 'Lato' && f.style === style);
    expect(faces.length).toBeGreaterThan(0);
    for (const { file, min } of faces) {
      const ours = fontFacts(readFileSync(file!));
      expect(ours.family, `Lato ${min} ${style}`).toBe(served.family);
      expect(number(ours.version), `Lato ${min} ${style} version`).toBe(number(served.version)!);
      // Whole, not subset: the reserved font name forbids a subset keeping the name "Lato".
      expect(ours.glyphs, `Lato ${min} ${style} glyphs`).toBe(served.glyphs);
      isStyle(ours, style, `Lato ${min} ${style}`);
    }
    isStyle(served, style, `Slack's ${style} file`);
  });
});

/**
 * `linear.css`'s heading geometry must match the editor's own tokens, byte for byte, not the
 * marketing site's. The source is `static.linear.app/client/assets/style-<hash>.css` (linked
 * `id=app-stylesheet` off the login page, no session), which declares `--editor-hN-font-size` /
 * `--editor-hN-line-height` on `.editor` and consumes them in `.editor hN`.
 */
describe("linear.css's headings match Linear's own editor tokens", () => {
  const CLIENT = LINEAR_TOKENS.client;

  test('the committed evidence is the CLIENT stylesheet, and it declares no theme', () => {
    // Why colour comes from the marketing sheet and `previewFidelity` stays `indicative`.
    expect(CLIENT?.source).toMatch(/^https:\/\/static\.linear\.app\/client\/assets\/.*\.css$/);
    expect(CLIENT.themes).toEqual([]);
  });

  /** A level's size and line-height, longhands on the sheet's own rule as Linear's `.editor hN`. */
  function fontOf(level: string): { size?: string; lineHeight?: string } {
    const rule = ruleBody(LINEAR, `[data-destination="linear"] .ProseMirror ${level}`);
    expect(rule, `no rule for ${level}`).not.toBeNull();
    return { size: declared(rule!, 'font-size'), lineHeight: declared(rule!, 'line-height') };
  }

  for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    test(`${level} is Linear's own font-size and line-height`, () => {
      const got = fontOf(level);
      expect(got.size, `${level} font-size`).toBe(CLIENT.editor[`--editor-${level}-font-size`]);
      expect(got.lineHeight, `${level} line-height`).toBe(
        CLIENT.editor[`--editor-${level}-line-height`]
      );
    });
  }

  test("every heading carries Linear's `.editor .heading-node`, in one rule as Linear has it", () => {
    // `.editor .heading-node` outranks the global `h1..h6 { font-weight: var(--font-weight-medium) }`
    // (500): every level carries `heading-node` (h1 and h2 of a live comment read in DevTools; h3
    // to h6 because the class keys on the node). The live h1 computes 600 and `"calt"`.
    expect(CLIENT.heading['font-weight']).toBe('var(--font-weight-semibold)');
    expect(CLIENT.root['--font-weight-semibold']).toBe('600');
    const shared = ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror :is(h1, h2, h3, h4, h5, h6)');
    expect(shared, 'no rule for every heading level').not.toBeNull();
    expect(declared(shared!, 'font-weight')).toBe(CLIENT.root['--font-weight-semibold']);
    expect(declared(shared!, 'font-feature-settings')).toBe(CLIENT.heading['font-feature-settings']);
    // No `font` shorthand on any heading: it resets `font-feature-settings`, and with one per level
    // `calt` computed `normal` (measured in the window).
    const shorthands = sheetRules(LINEAR)
      .filter((r) => declared(r.body, 'font') !== undefined && r.selectors.some((one) => /(^|[\s>+~(])h[1-6]\b/.test(one)))
      .map((r) => r.selectors.join(', '));
    expect(shorthands).toEqual([]);
  });

  test('the values are in rem, as Linear declares them, not converted to a ratio', () => {
    // The form as well as the value: 1.85rem is 29.6px, and a converted number cannot be checked
    // against the source.
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const got = fontOf(level);
      expect(got.size, `${level} size unit`).toMatch(/rem$/);
      expect(got.lineHeight, `${level} line-height unit`).toMatch(/rem$/);
    }
  });

  test('the list inset and block radius are confirmed by the editor', () => {
    // Two values the marketing sheet also has, held to the editor's.
    expect(CLIENT.root['--editor-list-inset']).toBe('1.5rem');
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror ul')).toContain(
      'padding-left: 1.5rem'
    );
    expect(CLIENT.root['--editor-block-radius']).toBe('6px');
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror pre')).toContain(
      'border-radius: 6px'
    );
  });

  test("the code block's geometry is Linear's own `.editor pre`", () => {
    // Ties the sheet to the committed rules, so a token pass that reads different ones fails here.
    // The size, the line height and the colours come from captures of a live comment, not these.
    const { pre, code, lineNumber } = CLIENT.codeBlock;
    const block = pre['--code-block-padding'];
    const side = pre['--code-block-side-padding'];
    expect(code.padding).toBe('var(--code-block-padding) var(--code-block-side-padding)');
    expect(lineNumber['padding-left']).toBe('var(--code-block-side-padding)');
    expect(lineNumber.width).toBe('calc(var(--code-block-line-digits) * 1ch)');
    expect(lineNumber['box-sizing']).toBe('content-box');
    expect(pre['white-space']).toBe('pre');
    const ours = ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror pre');
    expect(ours).toContain(`padding: ${block} ${side} ${block} 0`);
    // `--editor-hairline`, one device pixel: the table's `--ln-hairline`, which `tableLayout` measures.
    expect(ours).toContain('border: var(--ln-hairline) solid var(--color-border-primary)');
    const column = ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror .dg-linenos');
    expect(column).toContain(`min-width: ${pre['--code-block-line-digits']}ch`);
    expect(column).toContain(`padding: 0 ${lineNumber['padding-right']} 0 ${side}`);
    expect(column).toContain('box-sizing: content-box');
  });

  test("list spacing is the editor's block spacing, at the value a live comment measured", () => {
    // Taken from a live comment's measurement; this ties it to the committed token.
    expect(CLIENT.root['--editor-block-spacing']).toBe('1rem');
    expect(CLIENT.root['--editor-block-spacing-small']).toBe(
      'calc(.375 * var(--editor-block-spacing))'
    );
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror li + li')).toContain(
      'margin-top: .375rem'
    );
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror :is(ul, ol) + p')).toBe(
      'margin-top: 1rem;'
    );
  });

  // The rest of the block spacing, against the editor root's margin rules, in rem at `:root`'s
  // block spacing of 1rem (what a comment measures, above).
  const BLOCK_SPACING = CLIENT.blockSpacing;

  /** Linear's spacing value in rem: a `var()` of `:root`'s, a product in `calc()`, or a number. */
  function linearRem(value: string): number {
    const v = value.trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) return linearRem(CLIENT.root[ref[1]!]);
    const calc = /^calc\((.+)\)$/.exec(v);
    if (calc) return calc[1]!.split('*').reduce((product, factor) => product * linearRem(factor), 1);
    const n = /^([\d.]+)(rem)?$/.exec(v);
    if (n) return Number(n[1]);
    throw new Error(`not a block spacing: ${value}`);
  }

  /** The declarations of the one rule of Linear's whose selector list holds exactly `item`. */
  function linearRule(item: string): Record<string, string> {
    const rules = BLOCK_SPACING.filter((r) => selectorItems(r.selector).includes(item));
    expect(rules.length, `rules of Linear's with the selector ${item}`).toBe(1);
    return rules[0]!.declarations;
  }
  const linearMarginTop = (item: string) => linearRem(linearRule(item)['margin-top']!);

  /** A `margin` shorthand of this sheet's, top and bottom, in rem. */
  function ourMargins(selector: string): { top: number; bottom: number } {
    const margin = declared(ruleBody(LINEAR, selector) ?? '', 'margin');
    expect(margin, `no margin on ${selector}`).toBeDefined();
    const parts = margin!.split(/\s+/).map((p) => {
      const n = /^([\d.]+)(rem|px)?$/.exec(p);
      expect(n, `${selector}: ${p}`).not.toBeNull();
      return n![2] === 'px' ? Number(n![1]) / 16 : Number(n![1]);
    });
    return { top: parts[0]!, bottom: parts[2] ?? parts[0]! };
  }

  test("each heading's margins are Linear's own rule's, at a comment's block spacing", () => {
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const theirs = linearRule(level);
      const ours = ourMargins(`[data-destination="linear"] .ProseMirror ${level}`);
      expect(ours.top, `${level} margin-top`).toBe(linearRem(theirs['margin-top']!));
      expect(ours.bottom, `${level} margin-bottom`).toBe(linearRem(theirs['margin-bottom']!));
    }
    // A heading that opens the comment or a quote is flush, so its margin cannot collapse out of it.
    expect(linearMarginTop('.editor>.heading-node:first-child')).toBe(0);
    expect(linearMarginTop('.editor blockquote>.heading-node:first-child')).toBe(0);
    for (const parent of ['', 'blockquote ']) {
      const opening = `${parent}> :is(h1, h2, h3, h4, h5, h6):first-child`;
      expect(ruleBody(LINEAR, `[data-destination="linear"] .ProseMirror ${opening}`)).toBe('margin-top: 0;');
    }
  });

  test('a paragraph has no margin and a list none above, and two paragraphs are a block spacing apart', () => {
    expect(linearRule('p')).toEqual({ margin: '0' });
    expect(linearRule('ul')).toEqual({ margin: '0' });
    expect(ourMargins('[data-destination="linear"] .ProseMirror p')).toEqual({ top: 0, bottom: 0 });
    expect(ourMargins('[data-destination="linear"] .ProseMirror ul').top).toBe(0);
    expect(linearMarginTop(':is(.text-node,.collapsible-heading:not(:has(h3,h4)))+.text-node')).toBe(1);
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror p + p')).toBe('margin-top: 1rem;');
  });

  test("a quote is Linear's large block spacing from a list or a paragraph, either side", () => {
    const large = 22 / 16;
    // Above it, after a paragraph, a list or another block; below it, before a paragraph or a list.
    expect(
      linearMarginTop(
        ':is(.text-node,.list-node,.block-node,.inline-comment,.ProseMirror-gapcursor:not(:first-child),' +
          '.remote-cursor,.collapsible-heading:not(:has(h3,h4)),h1,h2)+:is(.block-node,.inline-comment,.tableContainer)'
      )
    ).toBe(large);
    expect(
      linearMarginTop(
        ':is(.block-node,.inline-comment,.ProseMirror-gapcursor:not(:first-child),.remote-cursor)+:is(.text-node,.list-node)'
      )
    ).toBe(large);
    expect(ourMargins('[data-destination="linear"] .ProseMirror blockquote')).toEqual({
      top: large,
      bottom: large,
    });
    // And `-small` when it opens the comment, as any block does.
    expect(
      linearMarginTop(
        '.editor>:is(.block-node:not(.collapsible-section,.diagram-source-node),.inline-comment,.tableContainer):first-child'
      )
    ).toBe(0.375);
    expect(ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror > blockquote:first-child')).toBe(
      'margin-top: .375rem;'
    );
  });

  test('and the body prose reads the editor root, weight included', () => {
    const root = ruleBody(LINEAR, '[data-destination="linear"] .ProseMirror');
    // 15px is `--editor-font-size: var(--font-size-regular)` = .9375rem; 1.6 is
    // `--editor-line-height`; the letter-spacing is byte-identical to `--editor-letter-spacing`.
    expect(CLIENT.root['--editor-line-height']).toBe('1.6');
    expect(CLIENT.root['--editor-letter-spacing']).toBe('-.00666667em');
    expect(root).toContain(`font: ${CLIENT.root['--font-weight-normal']} 15px/1.6`);
    expect(root).toContain('letter-spacing: -.00666667em');
    // Linear's real weight, 450 (`--editor-font-weight: var(--font-weight-normal)`); the bundled Inter is variable.
    expect(CLIENT.root['--editor-font-weight']).toBe('var(--font-weight-normal)');
    expect(CLIENT.root['--font-weight-normal']).toBe('450');
  });
});

/**
 * `slack.css`'s message-pane geometry must match Slack's own renderer, byte for byte: the sizes from
 * `modern.*.min.css`, the application shell's stylesheet (`.p-rich_text_block`, the header levels).
 * The two-size structure is confirmed two ways: a live render (`#` large, `##`..`######` identical),
 * and the stylesheet's level_2 and level_3 sharing a size and line-height.
 */
describe("slack.css's geometry matches Slack's own message renderer", () => {
  const RULES = SLACK_TOKENS.rules;
  // Verified against the live DOM: a mrkdwn message renders through `p-header_block` with
  // `flat_scale`, not the composer's `p-rich_text_header`, whose weights get h2 wrong, at 700.
  const HB = '.p-header_block__text.p-header_block--flat_scale.p-header_block--level_';
  const COMPOSER = '.p-rich_text_header.p-rich_text_header--level_';

  test('the committed evidence holds the renderer rules this sheet is built on', () => {
    for (const sel of ['.p-rich_text_block', `${HB}1`, `${HB}2`, `${HB}3`]) {
      expect(RULES[sel], `no committed rule for ${sel}`).toBeTruthy();
    }
  });

  /** The `font:` shorthand's weight, size and line-height from a `slack.css` rule. */
  function fontOf(selector: string): { weight: string; size: string; lineHeight: string } {
    const rule = ruleBody(SLACK, selector);
    expect(rule, `no rule for ${selector}`).not.toBeNull();
    const m = /font:\s*(\d{3})\s+(\d+px)\/([\d.]+)/.exec(rule!);
    expect(m, `${selector} has no \`font: <weight> <size>/<line-height>\` shorthand: ${rule}`).not.toBeNull();
    return { weight: m![1], size: m![2], lineHeight: m![3] };
  }

  test('the body pane is `.p-rich_text_block`', () => {
    const got = fontOf('[data-destination="slack"] .ProseMirror');
    expect(got.size).toBe(RULES['.p-rich_text_block']['font-size']);
    // 1.46668, not 1.46667: transcribed, not typed.
    expect(got.lineHeight).toBe(RULES['.p-rich_text_block']['line-height']);
  });

  test('the composer and the message renderer agree on the type SCALE', () => {
    // The two renderers share a scale; only the weight mapping differs.
    for (const n of [1, 2, 3]) {
      expect(RULES[`${HB}${n}`]['font-size'], `level_${n} size`).toBe(
        RULES[`${COMPOSER}${n}`]['font-size']
      );
      expect(RULES[`${HB}${n}`]['line-height'], `level_${n} line-height`).toBe(
        RULES[`${COMPOSER}${n}`]['line-height']
      );
    }
  });

  test('h1 is Slack\'s level_1: 18px, and BLACK rather than bold', () => {
    const level1 = RULES[`${HB}1`];
    const got = fontOf('[data-destination="slack"] .ProseMirror h1');
    expect(got.size, 'h1 font-size').toBe(level1['font-size']);
    expect(got.lineHeight, 'h1 line-height').toBe(level1['line-height']);
    // `var(--custom-font-weight-black,900)`: the property is a workspace font override this window
    // has no equivalent of, so the fallback is the value.
    expect(level1['font-weight']).toContain('900');
    expect(got.weight, 'h1 font-weight').toBe('900');
  });

  test('h2..h6 all share level_2/level_3\'s single size', () => {
    const l2 = RULES[`${HB}2`];
    const l3 = RULES[`${HB}3`];
    expect(l2['font-size'], 'the two-size structure').toBe(l3['font-size']);
    expect(l2['line-height'], 'the two-size structure').toBe(l3['line-height']);
    for (const level of ['h2', 'h3', 'h4', 'h5', 'h6']) {
      const got = fontOf(`[data-destination="slack"] .ProseMirror ${level}`);
      expect(got.size, `${level} font-size`).toBe(l2['font-size']);
      expect(got.lineHeight, `${level} line-height`).toBe(l2['line-height']);
    }
  });

  test('h2 is BLACK and h3..h6 are bold -- three renderings, not two', () => {
    // Live DOM: `##` renders `p-header_block--level_2 flat_scale` at 900; `###`, `####`, `#####`
    // and `######`, each confirmed in one message, render `level_3 flat_scale` at 700. Two sizes,
    // three renderings.
    expect(RULES[`${HB}2`]['font-weight']).toContain('900');
    expect(RULES[`${HB}3`]['font-weight']).toContain('700');
    expect(fontOf('[data-destination="slack"] .ProseMirror h2').weight).toBe('900');
    for (const level of ['h3', 'h4', 'h5', 'h6']) {
      expect(fontOf(`[data-destination="slack"] .ProseMirror ${level}`).weight).toBe('700');
    }
  });

  test('the message variant is `flat_scale`, and 22px is the one WITHOUT it', () => {
    // 22px is `level_1` for a canvas or file unfurl; a message carries `flat_scale`.
    expect(RULES[`${HB}1`]['font-size']).toBe('18px');
    expect(fontOf('[data-destination="slack"] .ProseMirror h1').size).toBe('18px');
  });

  test('heading margins are Slack\'s `1em 0 4px`, transcribed rather than resolved', () => {
    // `1em` is the heading's own size: 18px above an h1, 15px above an h2.
    const margin = RULES['.p-rich_text_header'].margin;
    expect(margin).toBe('1em 0 4px');
    for (const level of ['h1', 'h2']) {
      expect(
        ruleBody(SLACK, `[data-destination="slack"] .ProseMirror ${level}`),
        `${level} margin`
      ).toContain(`margin: ${margin}`);
    }
  });

  test('the quote inset and the list indent are Slack\'s own', () => {
    expect(RULES['.c-mrkdwn__quote']['padding-left']).toBe('16px');
    expect(ruleBody(SLACK, '[data-destination="slack"] .ProseMirror blockquote')).toContain(
      'padding-left: 16px'
    );
    // Slack indents the item by 28px; this window pads the list. Same text position.
    expect(RULES['.p-rich_text_list li']['margin-inline-start']).toBe('28px');
    expect(ruleBody(SLACK, '[data-destination="slack"] .ProseMirror ul')).toContain(
      'padding-left: 28px'
    );
  });

  /*
   * A fence with a language is Slack's code-block card, drawn on one `<pre>` where Slack nests a
   * wrapper and a card. Every number is derived from the component's rules (`codeBlock`).
   */
  describe("the code block card is Slack's own component", () => {
    const CB = SLACK_TOKENS.codeBlock;
    const WRAP = SLACK_TOKENS.rules['.c-mrkdwn__pre']!;
    const WRAP_MARGIN = SLACK_TOKENS.rules['.c-mrkdwn__quote,.c-mrkdwn__pre']!;
    const CARD = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror pre[data-language]')!;
    const PLAIN = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror pre:not([data-language])')!;
    const PRE_ANY = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror pre')!;
    const px = (v: string) => (v.trim() === '0' ? 0 : Number(/^([\d.]+)px$/.exec(v.trim())?.[1]));
    const box = (v: string) => {
      const [t, r = t, b = t, l = r] = v.trim().split(/\s+/).map(px);
      return { t: t!, r: r!, b: b!, l: l! };
    };
    const BORDER = 1; // the card's `var(--dt_color-surf-pry) 1px solid`, asserted below
    const PRE = 8; // `pre.slalabaster`'s side and bottom padding: measured on the live card, no rule states it
    /** A `--sl-*` variable's value in a theme's blocks. */
    const variable = (name: string, dark: boolean) =>
      declared(ruleBody(SLACK, dark ? '[data-destination="slack"][data-theme="dark"]' : '[data-destination="slack"]')!, name);

    test('both shapes sit in the wrapper Slack gives them', () => {
      // `.c-mrkdwn__pre { padding: 8px }`, and the 4px margin it shares with the quote.
      expect(declared(PRE_ANY, 'margin')).toBe(`${WRAP_MARGIN['margin-top']} 0`);
      expect(WRAP_MARGIN['margin-bottom']).toBe(WRAP_MARGIN['margin-top']);
      // The plain box IS the wrapper; the card sits in its padding (the transparent border below).
      expect(declared(PLAIN, 'padding')).toBe(WRAP.padding);
    });

    test("its border, ground and radius are the container rule's", () => {
      expect(CB.container.border).toBe('var(--dt_color-surf-pry) 1px solid');
      expect(declared(CARD, 'box-shadow')).toBe('inset 0 0 0 1px var(--dt_color-surf-pry)');
      // The ground is one variable the theme picks: the container's, and its dark override's.
      expect(declared(CARD, 'background')).toBe('var(--sl-code-card)');
      expect(variable('--sl-code-card', false)).toBe(CB.container['background-color']);
      expect(variable('--sl-code-card', true)).toBe(CB.containerDark['background-color']);
      // The visible radius is the outer one less the transparent border: 20/24 less 8/12.
      const [h, v] = declared(CARD, 'border-radius')!.split('/').map(px);
      const bw = box(declared(CARD, 'border-width')!);
      expect(h! - bw.l).toBe(px(CB.container['border-radius']!));
      expect(v! - bw.t).toBe(px(CB.container['border-radius']!));
      // That border is the wrapper's padding, plus the card's own vertical margin.
      expect(bw.l).toBe(px(WRAP.padding!));
      expect(bw.t).toBe(px(WRAP.padding!) + px(CB.container['margin-top']!));
    });

    test('the code sits where the header, the code area and the number column put it', () => {
      const pad = box(declared(CARD, 'padding')!);
      const header = box(CB.header.padding!);
      const code = box(CB.code.padding!);
      // Down: the border, then the header -- its padding around the 32px copy button, the one height
      // no rule states (measured: the header is 40px on the live card) -- then the pre's own top.
      expect(pad.t).toBe(BORDER + header.t + 32 + header.b + px(CB.pre['padding-top']!));
      // In: the border and the pre's padding; then the number column and its margin, in flow. The
      // probe's `codeLayout` measures the result: the code's first glyph 54px inside the card.
      expect(pad.l).toBe(BORDER + PRE);
      expect(pad.r).toBe(BORDER + code.r + PRE);
      expect(pad.b).toBe(BORDER + code.b + PRE);
      const font = fontOf('[data-destination="slack"] .ProseMirror pre');
      expect(font.size).toBe(CB.container['font-size']);
      expect(`${font.lineHeight}%`).toBe(CB.container['line-height']);
      // A long line scrolls: `.line { white-space: pre }`, not TipTap's `pre-wrap`.
      const lines = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror pre[data-language] code')!;
      expect(declared(lines, 'white-space')).toBe(CB.line['white-space']);
      expect(CB.code['overflow-x']).toBe('auto');
    });

    test("the line numbers are the line-number rule's, and only on the card", () => {
      const ln = CB.lineNumber;
      const ours = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror pre[data-language] .dg-linenos')!;
      for (const prop of ['width', 'padding-right', 'margin-right', 'text-align', 'color', 'position', 'left', 'z-index']) {
        expect(declared(ours, prop), prop).toBe(ln[prop]);
      }
      // Slack's two gradients -- the ground fading out under the numbers -- are one here, on the
      // card's ground variable. Each of Slack's must be ours with its token for that variable.
      const gradient = declared(ours, 'background')!;
      expect(ln.background!.replaceAll('var(--dt_color-base-sec)', 'var(--sl-code-card)')).toBe(gradient);
      expect(CB.lineNumberDark.background!.replaceAll('var(--dt_color-base-ter)', 'var(--sl-code-card)')).toBe(gradient);
      // A fence without a language has no numbers in Slack (measured), so every rule naming the
      // gutter must be the card's.
      for (const { selectors } of sheetRules(SLACK)) {
        for (const selector of selectors) {
          if (selector.includes('.dg-linenos')) expect(selector, 'numbers outside the card').toContain('pre[data-language]');
        }
      }
    });

    test('the "Show me" ring sits at the card\'s visible edge, not on its transparent band', () => {
      const ring = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror pre[data-language].dg-lost-highlight')!;
      expect(declared(ring, 'outline')).toBe('none');
      expect(declared(ring, 'box-shadow')).toMatch(/^inset /);
      // The tint is the shell's, and it must beat any destination's ground (Slack's plain box,
      // Jira's code panel): the longhand, so a destination's `background-clip` still applies.
      expect(declared(ruleBody(SHELL, '.dg-lost-highlight')!, 'background-color')).toMatch(/!important$/);
    });

    test("the language name is the header's type, in the language rule's colour", () => {
      const label = ruleBody(SLACK, '[data-destination="slack"] .ProseMirror pre[data-language]::before')!;
      const font = fontOf('[data-destination="slack"] .ProseMirror pre[data-language]::before');
      expect(font.size).toBe(CB.header['font-size']);
      expect(CB.header['font-weight']).toContain(font.weight);
      expect(declared(label, 'left')).toBe(`${BORDER + box(CB.header.padding!).l}px`);
      expect(declared(label, 'color')).toBe(CB.language.color);
    });
  });
});

/**
 * Slack and Linear smooth their text, and the window's pane for each must too. On a 1x display in
 * dark the default smoothing dilates every stem: ~30% more ink on a Slack paragraph, 34% on Linear's
 * (measured in Chromium). Both set it on `body`; both extractors record it through `smoothingOf`.
 * Jira and GitHub set it nowhere in a comment; the probe pins those at `auto`.
 */
describe('the panes are smoothed the way the vendors smooth theirs', () => {
  for (const [name, evidence, sheet] of [
    ['slack', SLACK_TOKENS, SLACK],
    ['linear', LINEAR_TOKENS.client, LINEAR],
  ] as const) {
    test(`${name}.css takes its vendor's \`body\` value, and nothing nearer resets it`, () => {
      const value = evidence.bodyText['-webkit-font-smoothing'];
      expect(value).toBe('antialiased');
      expect(ruleBody(sheet, `[data-destination="${name}"] .ProseMirror`)).toContain(
        `-webkit-font-smoothing: ${value}`
      );
      // CSS cannot say which elements the message sits in, so every other rule the extractor found
      // may only repeat the body's value or style a pseudo-element.
      for (const { selector, value: other } of evidence.smoothingOverrides) {
        const pseudoOnly = selector.split(',').every((one) => /::?(before|after)\b/.test(one));
        expect(other === value || pseudoOnly, `\`${selector}\` sets smoothing to ${other}`).toBe(true);
      }
    });
  }
});

/*
 * Code in Jira, Linear and GitHub drafts draws in Menlo. The vendors' stacks lead with
 * `ui-monospace`, which WebKit draws as SF Mono and Chromium ignores, drawing Menlo, which is what
 * Chrome readers see. Dropping it is the one deviation: GitHub's stack is otherwise the ruler's,
 * verbatim. Jira's ruler output is read by nothing (`.claude/rules/styles.md`) and Linear's stack has
 * no measurement, so those two are held to the deviation alone. Which face WebKit draws is
 * `surface:host`'s question, by width.
 */
describe('code draws in Menlo: ui-monospace is out of the three vendor stacks, and nothing else moved', () => {
  const families = (stack: string) => stack.split(',').map((f) => f.trim());
  const stackOf = (sheet: string, destination: string, variable: string) =>
    declared(ruleBody(sheet, `[data-destination="${destination}"]`) ?? '', variable) ?? '';
  const STACKS = [
    ['github', stackOf(GITHUB, 'github', '--gh-mono')],
    ['jira', stackOf(CSS, 'jira', '--ds-font-mono')],
    ['linear', stackOf(LINEAR, 'linear', '--ln-mono')],
  ] as const;

  test.each(STACKS)('%s names no ui-monospace, and Menlo before the generic family', (_name, stack) => {
    expect(stack, 'the stack was not found').not.toBe('');
    const list = families(stack);
    expect(list).not.toContain('ui-monospace');
    expect(list.indexOf('Menlo')).toBeGreaterThan(-1);
    expect(list.indexOf('Menlo')).toBeLessThan(list.indexOf('monospace'));
  });

  test("github's is the ruler's measured stack with exactly that one family taken out", () => {
    for (const key of ['codeBlock', 'inlineCode']) {
      const measured = families(RULER.surfaces.comment!.local.light[key]!['font-family']!);
      expect(measured[0], 'the measurement itself still leads with ui-monospace').toBe('ui-monospace');
      expect(families(STACKS[0][1])).toEqual(measured.filter((f) => f !== 'ui-monospace'));
    }
  });
});
