/**
 * Measure editor-core's blockquote, lists, table cells and code block on the live render.
 *
 * `probe-styles.cjs` reads these too but records only a summary; this reads every value, so the
 * parts of `jira.css` resting on them are measured rather than trusted.
 *
 * Every element exists in the fixture (1 blockquote, 1 bulletList, 1 orderedList, 5 listItems,
 * 1 codeBlock, 2 inline codes, a 3x3 table, 1 rule, 2 links), so these are real rendered nodes, not
 * injected ones. `p` and `h2` are measured alongside as controls: their values are known, so if they
 * come back wrong the run is not trustworthy.
 *
 * editor-core renders a code block through a node view, so the DOM shape around it is reported too:
 * a `<pre>` that is not the element carrying the styling is not worth measuring.
 *
 * Run: `bun run measure:blocks` from the repo root (see measure.cjs for why not `bun` directly).
 */

const { run } = require('./measure.cjs');

const TEXT = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color'];
const BOX = [
  'margin-top', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-bottom', 'padding-left',
];
const BORDER = [
  'border-top-width', 'border-top-style', 'border-top-color',
  'border-left-width', 'border-left-style', 'border-left-color',
  'border-radius',
];
/** Cells share one property list. */
const CELL = [...TEXT, ...BOX, 'border-top-width', 'border-top-style', 'border-top-color', 'text-align', 'vertical-align'];
const MARGINS = ['margin-top', 'margin-bottom'];

run(`
  const TEXT = ${JSON.stringify(TEXT)};
  const BOX = ${JSON.stringify(BOX)};
  const BORDER = ${JSON.stringify(BORDER)};
  const CELL = ${JSON.stringify(CELL)};
  const MARGINS = ${JSON.stringify(MARGINS)};

  // The code block is a node view, not a <pre>: find whichever element carries the styling.
  const codeHost = pm.querySelector('pre')
    ?? pm.querySelector('[data-node-type=codeBlock]')
    ?? pm.querySelector('.code-block');
  const shape = (el) => el ? {
    tag: el.tagName.toLowerCase(),
    class: el.className || '(none)',
    parentTag: el.parentElement?.tagName.toLowerCase() ?? null,
    childTags: [...el.children].map((c) =>
      c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).split(' ')[0] : '')),
  } : null;

  const inlineCode = [...pm.querySelectorAll('code')]
    .find((c) => !c.closest('pre') && !c.closest('[data-node-type=codeBlock]'));

  return {
    controls: {
      p: pick('p', ['font-size', 'line-height', 'font-weight', ...MARGINS]),
      h2: pick('h2', ['font-size', 'line-height', 'font-weight', 'margin-top']),
    },
    blockquote: pick('blockquote', [...BOX, ...BORDER, 'color', 'font-size', 'line-height']),
    blockquoteP: pick('blockquote p', [...MARGINS, 'font-size', 'line-height']),
    // The first non-action ul in this fixture is the NESTED bullet list; the ol is top-level.
    ulNested: pick('ul:not([data-node-type=actionList])', BOX),
    olTopLevel: pick('ol', BOX),
    li: pick('li', [...BOX, 'font-size', 'line-height']),
    liP: pick('li p', [...MARGINS, 'font-size', 'line-height']),
    table: pick('table', ['border-collapse', ...MARGINS, 'width']),
    th: pick('th', CELL),
    td: pick('td', CELL),
    tdP: pick('td p', MARGINS),
    codeBlockShape: shape(codeHost),
    codeBlockHost: read(codeHost, [...TEXT, ...BOX, ...BORDER, 'background-image', 'overflow-x']),
    hr: pick('hr', ['border-top-width', 'border-top-style', 'border-top-color', 'height', 'background-color', ...MARGINS]),

    // Not evidence; kept to record that they were checked. This instrument stubs the link and media
    // providers, so the link reports the browser default (rgb(0,0,238), underlined) and the image
    // never renders. jira.css's link values come from editor-core's shipped CSS, not from here.
    //
    // The code text too: Atlassian's code styles are never applied to <code> here, so both readings
    // are the UA's monospace at the container's 14px/24px with no background, not the reader's
    // inline code (@atlaskit/renderer's 0.875em on a neutral chip; see jira.css).
    // codeBlockHost above is a real reading of the container, which is 14px/24px.
    // (No backticks in here: this whole block is a template literal, and one ends it.)
    stubbedNotMeasured: {
      link: pick('a', ['color', 'text-decoration-line']),
      img: pick('img', ['max-width', 'border-radius']),
      codeBlockInner: codeHost ? pick('code', [...TEXT, 'padding-left', 'padding-top'], codeHost) : null,
      inlineCode: read(inlineCode, [...TEXT, 'padding-left', 'padding-top', 'border-radius']),
    },
  };
`);
