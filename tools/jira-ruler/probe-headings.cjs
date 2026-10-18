/**
 * Measure editor-core's h1..h6 on the live render.
 *
 * Companion to `probe-styles.cjs`, which covers h1-h3 only because the fixture stops at h2. h4-h6
 * are measured rather than derived from a token ladder: the obvious token family is the wrong one.
 *
 * The fixture cannot change without rebuilding `dist/`, but editor-core styles headings with plain
 * descendant selectors (`.cc-xxxx .ProseMirror h4 { font: var(--editor-font-ugc-token-heading-h4) }`),
 * so an element injected into the live `.ProseMirror` gets the cascade a real one would.
 *
 * Controls: the real h1 and h2 are measured alongside. Their font metrics (size, line-height,
 * weight) match the injected ones, which validates the injection for typography. Their margins do
 * not match and must not be read as agreement: the real h1 has `margin-top: 0` against the
 * injected 35px because editor-core zeroes the first block's top margin, so the difference is the
 * evidence for that rule. The injected headings are appended last, so each is `.ProseMirror`'s last
 * child while its `margin-bottom` is read.
 *
 * Run: `bun run measure:headings` from the repo root (not `bun` on this file: see measure.cjs).
 */

const { run } = require('./measure.cjs');

const PROPS = ['font-size', 'line-height', 'font-weight', 'margin-top', 'margin-bottom'];

run(`
  const props = ${JSON.stringify(PROPS)};

  // Controls: the real headings the fixture provides.
  const real = {};
  for (const tag of ['h1', 'h2', 'p']) real[tag] = pick(tag, props);

  // Append one of each level. Not first-child, so the leading-block margin reset does not apply.
  const injected = {};
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const el = document.createElement(tag);
    el.textContent = 'measure me';
    pm.appendChild(el);
    injected[tag] = read(el, props);
  }

  return { real, injected, baseFontSize: getComputedStyle(pm).fontSize };
`);
