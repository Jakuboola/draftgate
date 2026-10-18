/**
 * Read Jira's body values off the READER's surface: `@atlaskit/renderer`, on live public issues.
 *
 * The rest of this directory measures `@atlaskit/editor-core`, the surface a comment's author types
 * into. A posted comment is drawn for its reader by the renderer, and where the two differ the
 * preview follows the reader. This asks the renderer for every value `jira.css` states about the body.
 *
 * Dev instrument, not a dependency and not in the plugin tree. It writes `measured-renderer.json`
 * beside it, read by nothing: `jira.css` and `surface/harness/probe.ts` state their values
 * independently, because a shared source would make the probe assert that the CSS says what the CSS
 * says.
 *
 * Run: `bun run measure:renderer` from the repo root. Needs network; no install, no credentials.
 *
 * ## Where it reads
 *
 * `hibernate.atlassian.net`, the Hibernate project's public Jira Cloud site, anonymously. No login
 * exists here and none may be added. Never point it at a site of your own, production or dev: an
 * anonymous read of somebody else's public tracker is the whole licence this tool has.
 *
 * `PAGES` is a list of issues that between them contain every block `jira.css` styles, in a
 * description and in a comment where one exists. Found by scanning the site's public ADF for node
 * types; a comment is reached with `focusedCommentId`, because an anonymous issue view loads only
 * the newest comments. The two containers are kept apart in the output (`description`, `comment`)
 * because the renderer takes a base size from its `appearance`, and a difference would be a finding.
 *
 * ## What it cannot measure (a blank is not a zero)
 *
 *  - Dark. An anonymous viewer gets no theme attribute and the site offers no toggle, so every
 *    colour here is the light palette. The dark column in `jira.css` is `@atlaskit/tokens`'s, and
 *    nothing here confirms or refutes it.
 *  - Heading levels no public issue in `PAGES` contains (h5, h6) as real elements. They are read
 *    injected into a real description (`injected`), which gets every rule a real one would; any other
 *    missing key is `null`, never a default.
 *  - What an element's value is for. The renderer sits inside Jira's own page CSS (AUI), and some
 *    values come from that, not the renderer's sheet: list spacing, the bottom margin of h4-h6. So
 *    for the values that differ from editor-core's, `rules` records which rule set each one, off
 *    CDP's `CSS.getMatchedStylesForNode`: the cascade in order, the winner last.
 *  - The logged-in comment editor, which is editor-core again.
 *
 * ## Why a GAP beside every margin
 *
 * The renderer wraps blocks the editor does not (a table sits in `.pm-table-container` and more, a
 * heading may sit in `.renderer-heading-wrapper`), so an element's own `margin-top` can be 0 while
 * the space above it is 24px, carried by a wrapper. `gapAbove` is the distance from the previous
 * block's bottom edge to this one's top edge, measured on the outermost wrapper whose parent is the
 * document: the number a reader sees, whatever element carries it.
 */

const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Bounded so a hung page cannot leave a window open: under 90s, the bound for any one Electron run.
// Every page runs at once, so the worst case is one page's budget (load + `RENDER_WAIT_MS` +
// `SETTLE_MS`), not the sum.
const DEADLINE_MS = 85_000;
const RENDER_WAIT_MS = 40_000;
const SETTLE_MS = 6000;
const SITE = 'https://hibernate.atlassian.net/browse/';

/** Issue, and optionally the comment to focus. Chosen for what they CONTAIN; see the header. */
const PAGES = [
  { key: 'HHH-16004' }, // the page the code sizes are read off
  { key: 'HHH-20899' }, // h2, blockquote, rule, ordered list, in a description
  { key: 'HHH-20846' }, // h1
  { key: 'HHH-20843' }, // h3
  { key: 'HHH-20209' }, // h4
  { key: 'HHH-20837' }, // table, in a description
  { key: 'HHH-20399' }, // task list
  { key: 'HHH-20508', comment: '144548' }, // table, in a comment
  { key: 'HHH-19943', comment: '128658' }, // rule, in a comment
  { key: 'HHH-20869', comment: '148025' }, // blockquote and mention, in a comment
  { key: 'HHH-20772', comment: '147834' }, // code block, in a comment
  { key: 'HHH-20925' }, // links, ordered list, inline code
];

/**
 * The values whose SOURCE is recorded, not only their computed value: every one where the reader
 * differs from editor-core, or that comes from Jira's page CSS rather than the renderer's.
 * Key -> properties.
 */
const RULES = {
  paragraph: ['line-height', 'margin-top'],
  h4: ['margin-top', 'margin-bottom'],
  ol: ['margin-top', 'margin-bottom'],
  ul: ['margin-top', 'margin-bottom'],
  li: ['margin-top'],
  liP: ['margin-top'],
  nestedList: ['margin-top'],
  hr: ['margin-top', 'border-top-left-radius'],
  table: ['margin-top'],
  th: ['background-color', 'border-right-color', 'border-top-color'],
  td: ['border-right-color', 'border-bottom-color'],
  codePanel: ['background-color', 'border-top-left-radius'],
  lineNumber: ['padding-left', 'padding-right', 'margin-right', 'min-width'],
};

/** Runs IN the page, via `toString()`: a real function, so no template literal wraps its body. */
function readPage(focusComment, ruleKeys) {
  const PROPS = [
    'font-family', 'font-size', 'line-height', 'font-weight', 'color', 'background-color',
    'margin-top', 'margin-bottom', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-left-width', 'border-left-color', 'border-top-color',
    'border-right-width', 'border-right-color', 'border-bottom-width', 'border-bottom-color',
    'border-top-left-radius', 'border-collapse', 'vertical-align', 'text-align',
    'text-decoration-line', 'display', 'height', 'width', '-webkit-font-smoothing',
    'list-style-type', 'white-space', 'text-transform',
  ];
  const style = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of PROPS) out[p] = cs.getPropertyValue(p);
    const r = el.getBoundingClientRect();
    out.rect = { w: +r.width.toFixed(3), h: +r.height.toFixed(3) };
    return out;
  };
  // The element's outermost ancestor that is a direct child of the document, and the gap above it.
  const gapAbove = (el, doc) => {
    let top = el;
    while (top.parentElement && top.parentElement !== doc) top = top.parentElement;
    if (top.parentElement !== doc) return null;
    const prev = top.previousElementSibling;
    if (!prev) return { first: true };
    return {
      px: +(top.getBoundingClientRect().top - prev.getBoundingClientRect().bottom).toFixed(3),
      after: prev.tagName.toLowerCase(),
      wrapper: top === el ? null : top.tagName.toLowerCase() + '.' + String(top.className).slice(0, 60),
    };
  };
  // Which element to read for each key. `pick` prefers an instance with a preceding sibling, so a
  // margin is not read off the first block, which the renderer zeroes.
  const TARGETS = {
    paragraph: (d) => d.querySelectorAll(':scope > p'),
    h1: (d) => d.querySelectorAll('h1'),
    h2: (d) => d.querySelectorAll('h2'),
    h3: (d) => d.querySelectorAll('h3'),
    h4: (d) => d.querySelectorAll('h4'),
    blockquote: (d) => d.querySelectorAll('blockquote'),
    blockquoteP: (d) => d.querySelectorAll('blockquote > p'),
    table: (d) => d.querySelectorAll('table'),
    th: (d) => d.querySelectorAll('th'),
    td: (d) => d.querySelectorAll('td'),
    thP: (d) => d.querySelectorAll('th p'),
    tdP: (d) => d.querySelectorAll('td p'),
    ol: (d) => d.querySelectorAll(':scope > ol, :scope > div > ol'),
    ul: (d) => d.querySelectorAll(':scope > ul, :scope > div > ul'),
    li: (d) => d.querySelectorAll('li'),
    liP: (d) => d.querySelectorAll('li > p'),
    nestedList: (d) => d.querySelectorAll('li > ul, li > ol'),
    codeBlock: (d) => d.querySelectorAll('.code-block'),
    inlineCode: (d) => [...d.querySelectorAll('.code')].filter((e) => !e.closest('.code-block')),
    hr: (d) => d.querySelectorAll('hr'),
    link: (d) => [...d.querySelectorAll('a[href]')].filter(
      (e) => !e.closest('[data-mention-id], [data-inline-card], .inlineCardView-content-wrap, .code-block')
    ),
    mention: (d) => d.querySelectorAll('[data-mention-id]'),
    taskList: (d) => d.querySelectorAll('[data-task-list-local-id]'),
  };
  const pick = (list) => {
    const all = [...list];
    return all.find((e) => e.previousElementSibling) || all[0] || null;
  };
  // A code block's GEOMETRY, because its gutter is floated spans inside each line and its language
  // label, if it drew one, would be an anonymous element: where the numbers and the text START,
  // relative to the block's own left edge, is the thing to compare, whatever carries it.
  const codeGeometry = (block) => {
    if (!block) return null;
    const left = block.getBoundingClientRect().left;
    const panel = block.querySelector('[data-ds--code--code-block]') || block;
    const code = block.querySelector('code');
    const numbers = [...block.querySelectorAll('.linenumber')];
    const firstRow = block.querySelector('[data-ds--code--row]');
    // The first run of TEXT in the first row that is not the number: a Range gives its real box.
    let textLeft = null;
    if (firstRow) {
      const walker = document.createTreeWalker(firstRow, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (t.parentElement.closest('.linenumber') || !t.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        textLeft = +(range.getBoundingClientRect().left - left).toFixed(3);
        break;
      }
    }
    const last = numbers[numbers.length - 1];
    const tokens = {};
    for (const el of block.querySelectorAll('.token')) {
      const k = String(el.className).trim();
      if (!(k in tokens) && Object.keys(tokens).length < 16) tokens[k] = getComputedStyle(el).color;
    }
    const langAttr = panel.getAttribute('data-code-lang');
    return {
      lines: numbers.length,
      lang: langAttr,
      // Any element in the block whose own text is the language: a label, if the renderer draws one.
      langLabel: langAttr
        ? [...block.querySelectorAll('*')].some((e) => !e.children.length && e.textContent.trim().toLowerCase() === langAttr.toLowerCase())
        : null,
      panel: style(panel),
      code: code ? style(code) : null,
      lastNumber: last ? { ...style(last), left: +(last.getBoundingClientRect().left - left).toFixed(3), content: getComputedStyle(last, '::after').content } : null,
      textLeft,
      tokens,
    };
  };
  // Where a task's checkbox and text sit, and the gap between two tasks: the renderer's task list
  // is divs, draftgate's is a `ul`, so only the geometry is comparable.
  const taskGeometry = (list, doc) => {
    if (!list) return null;
    const left = doc.getBoundingClientRect().left;
    const items = [...list.querySelectorAll(':scope > [data-task-local-id]')];
    const box = items[0] && items[0].querySelector('input[type="checkbox"], [role="checkbox"]');
    const text = items[0] && items[0].querySelector('span[contenteditable="false"] + div');
    return {
      items: items.length,
      checkboxLeft: box ? +(box.getBoundingClientRect().left - left).toFixed(3) : null,
      checkbox: box ? style(box) : null,
      textLeft: text ? +(text.getBoundingClientRect().left - left).toFixed(3) : null,
      itemGap: items[1] ? +(items[1].getBoundingClientRect().top - items[0].getBoundingClientRect().bottom).toFixed(3) : null,
    };
  };
  // Headings no public issue happens to contain are INJECTED into a real document, the way
  // `probe-headings.cjs` does it for editor-core, and labelled so: an injected element gets
  // every rule that matches it, which is what a real one of that tag would get. A paragraph before
  // each, so none is the first block.
  // A LIST's top margin depends on where it sits, and in a comment on the host's own list markup
  // around the document, so both positions are injected into each real document: first, and after
  // a paragraph. No public comment opens with a list (1,500 issues scanned), so the leading case
  // exists only this way. Classes as the renderer writes them (`ak-ol`).
  const injectLists = (doc) => {
    const make = () => {
      const ol = document.createElement('ol');
      ol.className = 'ak-ol';
      for (let i = 0; i < 2; i++) {
        const li = document.createElement('li');
        const p = document.createElement('p');
        p.textContent = 'x';
        li.append(p);
        ol.append(li);
      }
      return ol;
    };
    const lead = make();
    doc.prepend(lead);
    const leading = style(lead)['margin-top'];
    lead.remove();
    const p = document.createElement('p');
    p.textContent = 'x';
    const after = make();
    doc.append(p, after);
    const afterStyle = style(after);
    const afterParagraph = { 'margin-top': afterStyle['margin-top'], 'margin-bottom': afterStyle['margin-bottom'] };
    // A loose item: its SECOND paragraph, with a paragraph (not a nested list) directly above it,
    // which the real items read above cannot guarantee.
    const second = document.createElement('p');
    second.textContent = 'x';
    after.firstElementChild.append(second);
    const secondParagraph = style(second)['margin-top'];
    p.remove();
    after.remove();
    return { leading, afterParagraph, secondParagraph };
  };
  const injectHeadings = (doc) => {
    const out = {};
    for (const tag of ['h4', 'h5', 'h6']) {
      const p = document.createElement('p');
      p.textContent = 'x';
      const h = document.createElement(tag);
      h.textContent = 'x';
      const after = document.createElement('p');
      after.textContent = 'x';
      doc.append(p, h, after);
      out[tag] = { ...style(h), gapBelow: +(after.getBoundingClientRect().top - h.getBoundingClientRect().bottom).toFixed(3) };
      p.remove();
      h.remove();
      after.remove();
    }
    return out;
  };
  const contexts = {
    description: document.querySelector('[data-testid="issue.views.field.rich-text.description"]'),
    comment: focusComment
      ? document.querySelector('[data-testid="issue-comment-base.ui.comment.ak-comment.' + focusComment + '-body"]')
      : document.querySelector('[data-testid$="-body"][data-testid^="issue-comment-base.ui.comment.ak-comment."]'),
  };
  const result = {};
  for (const [name, root] of Object.entries(contexts)) {
    const doc = root && root.querySelector('.ak-renderer-document');
    if (!doc) {
      result[name] = null;
      continue;
    }
    const wrap = doc.parentElement;
    const read = {
      targets: {},
      base: {
        '--ak-renderer-base-font-size': getComputedStyle(wrap).getPropertyValue('--ak-renderer-base-font-size'),
        'font-size': getComputedStyle(wrap).fontSize,
        'line-height': getComputedStyle(wrap).lineHeight,
        '-webkit-font-smoothing': getComputedStyle(doc).getPropertyValue('-webkit-font-smoothing'),
      },
    };
    for (const [key, find] of Object.entries(TARGETS)) {
      const el = pick(find(doc));
      read.targets[key] = el ? { ...style(el), gapAbove: gapAbove(el, doc) } : null;
      // Tagged so the main process can ask CDP which rules styled THIS element -- only the keys
      // whose rules it reads, so no CDP round trip is spent learning that a node is skipped.
      if (el && ruleKeys.includes(key)) el.setAttribute('data-dg-rule', name + ':' + key);
    }
    const block = pick(TARGETS.codeBlock(doc));
    const panel = block && block.querySelector('[data-ds--code--code-block]');
    const number = block && block.querySelector('.linenumber');
    if (panel) panel.setAttribute('data-dg-rule', name + ':codePanel');
    if (number) number.setAttribute('data-dg-rule', name + ':lineNumber');
    const table = pick(TARGETS.table(doc));
    if (table) {
      // How the columns are laid out: the layout algorithm, any column widths the
      // renderer set, and every cell of the first row, so "equal columns" is a reading and not an
      // inference from one cell.
      const row = table.querySelector('tr');
      read.targets.table.layout = {
        'table-layout': getComputedStyle(table).tableLayout,
        cols: [...table.querySelectorAll('col')].map((c) => c.getAttribute('style')),
        colwidths: row ? [...row.children].map((c) => c.getAttribute('data-colwidth')) : [],
        cells: row ? [...row.children].map((c) => +c.getBoundingClientRect().width.toFixed(3)) : [],
        // How a cell breaks a word too long for its fixed width.
        cellWrap: (() => {
          const td = table.querySelector('td');
          if (!td) return null;
          const cs = getComputedStyle(td);
          return { 'overflow-wrap': cs.overflowWrap, 'word-break': cs.wordBreak };
        })(),
      };
      const after = getComputedStyle(table, '::after');
      read.targets.table.after = {
        content: after.content,
        'border-top-color': after.borderTopColor,
        'border-top-width': after.borderTopWidth,
        'border-top-left-radius': after.borderTopLeftRadius,
      };
    }
    // A comment's document sits inside the activity feed's own markup; a list ancestor there is
    // what gives a comment's lists different spacing from a description's (`rules` names the selector).
    read.base.hostListAncestor = !!wrap.closest('ul, ol');
    read.codeGeometry = [...TARGETS.codeBlock(doc)].slice(0, 3).map(codeGeometry);
    read.taskGeometry = taskGeometry(pick(TARGETS.taskList(doc)), doc);
    read.injected = { lists: injectLists(doc), ...(name === 'description' ? injectHeadings(doc) : {}) };
    result[name] = read;
  }
  return result;
}

/** Polls until the page has rendered at least one document, or gives up. */
async function waitForRenderer(win, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const n = await win.webContents
      .executeJavaScript('document.querySelectorAll(".ak-renderer-document").length')
      .catch(() => 0);
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * For every element `readPage` tagged, the rules that DECLARE each property in `RULES`, in cascade
 * order (CDP returns matched rules lowest-precedence first), the element's inline style last. Only
 * the declarations asked about are kept, so a rule is evidence for the value it names and nothing
 * else.
 */
async function matchedRules(win) {
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  try {
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-dg-rule]' });
    // Every node at once: CDP answers concurrent requests by id.
    const entries = await Promise.all(nodeIds.map(async (nodeId) => {
      const [{ attributes }, matched] = await Promise.all([
        dbg.sendCommand('DOM.getAttributes', { nodeId }),
        dbg.sendCommand('CSS.getMatchedStylesForNode', { nodeId }),
      ]);
      const tag = attributes[attributes.indexOf('data-dg-rule') + 1];
      const props = RULES[tag.split(':')[1]];
      // A longhand CDP expanded out of a shorthand (`margin: 10px 0 0`) is listed as well as the
      // authored one, so the same declaration can appear twice: kept once.
      const declared = (style) => {
        const seen = new Set();
        return style.cssProperties.filter((p) => {
          const key = p.name + p.value;
          if (!props.includes(p.name) || !p.value || p.disabled || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      const rules = [];
      for (const m of matched.matchedCSSRules || []) {
        const decl = declared(m.rule.style);
        if (decl.length) {
          rules.push({
            selector: m.rule.selectorList.text.replace(/\s+/g, ' ').slice(0, 240),
            origin: m.rule.origin,
            declares: decl.map((p) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`),
          });
        }
      }
      if (matched.inlineStyle) {
        const decl = declared(matched.inlineStyle);
        if (decl.length) rules.push({ selector: '(inline style)', declares: decl.map((p) => `${p.name}: ${p.value}`) });
      }
      return [tag, rules];
    }));
    return Object.fromEntries(entries);
  } finally {
    dbg.detach();
  }
}

async function measure(page) {
  const win = new BrowserWindow({
    width: 1400,
    height: 1600,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const url = SITE + page.key + (page.comment ? '?focusedCommentId=' + page.comment : '');
  try {
    // A focused-comment URL redirects mid-load, which rejects `loadURL` with ERR_FAILED/ERR_ABORTED
    // although the page goes on to render. Whether it rendered is `waitForRenderer`'s question.
    await win.loadURL(url).catch(() => {});
    const rendered = await waitForRenderer(win, RENDER_WAIT_MS);
    // Late stylesheets and the focused comment's fetch land after the first document appears.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const read = rendered
      ? await win.webContents.executeJavaScript('(' + readPage.toString() + ')(' + JSON.stringify(page.comment ?? null) + ',' + JSON.stringify(Object.keys(RULES)) + ')')
      : null;
    const rules = rendered ? await matchedRules(win) : null;
    return { url, rendered, read, rules };
  } catch (e) {
    // One page failing is recorded as that page's result, not a stalled run: a rejection here
    // would otherwise sit unhandled inside `whenReady` until the deadline discarded every page.
    return { url, error: String((e && e.message) || e) };
  } finally {
    win.destroy();
  }
}

/**
 * The INJECTED reads, once per context rather than once per page when every page agrees -- they
 * measure the site's CSS, not the page's content, so sixteen copies of one answer are noise. Each
 * page's copy is dropped only if it equals the first; a page that disagrees keeps its own, and says
 * so.
 */
function injectedOnce(results) {
  const out = {};
  for (const context of ['description', 'comment']) {
    const reads = Object.values(results).map((r) => r.read?.[context]).filter(Boolean);
    if (!reads.length) continue;
    const first = JSON.stringify(reads[0].injected);
    out[context] = { ...reads[0].injected, pages: reads.length };
    for (const read of reads) if (JSON.stringify(read.injected) === first) delete read.injected;
  }
  return out;
}

/**
 * JSON with one ELEMENT per line: an object whose values are plain, or are themselves one-line
 * objects (a style with its `rect`), is written on one line. Indented one property per line, twelve
 * pages of computed styles come to 10,000 lines and a re-run's diff is unreadable.
 */
function compact(value, pad = '') {
  const flat = (v) => v === null || typeof v !== 'object';
  const oneLine = (v) =>
    !Array.isArray(v) && Object.values(v).every((x) => flat(x) || (!Array.isArray(x) && Object.values(x).every(flat)));
  if (flat(value)) return JSON.stringify(value);
  if (oneLine(value)) return JSON.stringify(value).replace(/,"/g, ', "').replace(/":/g, '": ');
  const inner = pad + ' ';
  const items = Array.isArray(value)
    ? value.map((v) => inner + compact(v, inner))
    : Object.entries(value).map(([k, v]) => inner + JSON.stringify(k) + ': ' + compact(v, inner));
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return items.length ? open + '\n' + items.join(',\n') + '\n' + pad + close : open + close;
}

// Each page destroys its window when done, and by default Electron quits when the last one closes.
app.on('window-all-closed', () => {});

process.on('uncaughtException', (e) => {
  console.error('probe-renderer:', e && e.stack);
  app.exit(3);
});

app.whenReady().then(async () => {
  setTimeout(() => {
    console.error('probe-renderer: deadline passed, nothing written');
    app.exit(4);
  }, DEADLINE_MS).unref();

  const done = await Promise.all(PAGES.map((p) => measure(p)));
  const results = Object.fromEntries(PAGES.map((p, j) => [p.key + (p.comment ? '#' + p.comment : ''), done[j]]));

  writeFileSync(
    join(__dirname, 'measured-renderer.json'),
    `${compact({ measuredAt: new Date().toISOString().slice(0, 10), site: SITE, injected: injectedOnce(results), pages: results })}\n`
  );
  for (const [key, r] of Object.entries(results)) {
    const found = (ctx) => (ctx ? Object.keys(ctx.targets).filter((k) => ctx.targets[k]) : []);
    console.log(
      `${key}: ${r.error ? 'ERROR ' + r.error : r.rendered ? 'rendered' : 'NO RENDERER'}; description [${found(r.read?.description).join(' ')}]; ` +
        `comment [${found(r.read?.comment).join(' ')}]`
    );
  }
  app.quit();
});
