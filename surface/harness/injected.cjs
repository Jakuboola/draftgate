/**
 * Every script the harness runs in the renderer, as functions: `wkSession.ts`'s `expressionFor`
 * injects `fn.toString()`, so a backtick in a body is a character, not the end of a template (why:
 * `injectedScripts.test.ts`). Only the harness's driver requires this file.
 *
 * Each export is a self-contained function of JSON-serialisable arguments: its source runs in the
 * renderer, where nothing from this module's scope exists. A module-scope `const` referenced from a
 * function type-checks and throws `ReferenceError` there; `injectedScripts.test.ts` refuses any body
 * naming another top-level declaration. Every function's closing `}` stays at column zero.
 */

/** Has the window finished rendering enough to measure? Polled (`until`), never slept for. */
function isRendered() {
  /*
   * The body surface: `.ProseMirror` for markdown, `textarea.dg-plain-body` for plain, a patch's
   * edits, and a prose field for a review with no body. `.dg-compose` or `.dg-edits` decides,
   * rendered for a block field or a patch only: one `querySelector` over all of them would match the
   * prose input, committed with the footer, before TipTap mounts `.ProseMirror` in an effect, and the
   * census would read `prosemirror: 0` at times. A patch is ready once every preview has mounted.
   */
  const compose = document.querySelector('.dg-compose');
  const edits = document.querySelector('.dg-edits');
  if (edits) {
    for (const preview of edits.querySelectorAll('.dg-edit-preview')) {
      if (!preview.querySelector('.ProseMirror')) return false;
    }
  }
  const body = compose
    ? compose.querySelector('.ProseMirror, textarea.dg-plain-body')
    : edits
      ? edits.querySelector('textarea.dg-edit-text')
      : document.querySelector('input.dg-prose-field');
  if (!body) return false;
  const root = document.documentElement;
  if (!root.dataset.destination) return false;
  /*
   * And the frame after each root attribute, which `App.tsx`'s `setRootData` marks on the root as
   * `--dg-restyle-<name>`: until it has run, WebKit leaves what it styled before the first
   * `data-destination` on the shell's defaults. Read sooner, `jira-dark`'s compose frame is the
   * shell's #E1E3E6 about once in four runs (measured). One marker per attribute found, so a new
   * one needs no edit here.
   */
  for (const name of Object.keys(root.dataset)) {
    if (!root.style.getPropertyValue('--dg-restyle-' + name)) return false;
  }
  // Something must have been laid out, and the stylesheet must be in force.
  if (!getComputedStyle(body).fontSize) return false;
  return document.querySelectorAll('.dg-footer .dg-btn').length > 0;
}

/** The probe's whole measurement: what rendered, what it computes to, and three preconditions. `spec` is `probe.ts`'s (`specFor`). */
async function takeCensus(spec) {
  const q = (s) => document.querySelectorAll(s).length;
  const counts = {};
  for (const [key, sel] of Object.entries(spec.nodes)) counts[key] = q(sel);

  const styles = {};
  for (const [sel, props] of Object.entries(spec.styles)) {
    // A key may name a pseudo-element: everything after `::` goes to getComputedStyle's second
    // argument, so e.g. the code-fence language label (a ::before, 400 12px/16px) can be read.
    const at = sel.indexOf('::');
    const target = at === -1 ? sel : sel.slice(0, at);
    const pseudo = at === -1 ? null : sel.slice(at);
    const el = document.querySelector(target);
    if (!el) { styles[sel] = null; continue; }
    const cs = getComputedStyle(el, pseudo);
    styles[sel] = Object.fromEntries(props.map((prop) => [prop, cs[prop]]));
  }

  // Does the destination's typeface render? getComputedStyle returns only the declared list, so
  // this measures string width against an absent family. document.fonts.load() first: measureText
  // does not fetch a webfont, and document.fonts.check() can answer true for a face falling back.
  const fontProbe = async () => {
    const want = spec.fontFamily;
    if (!want) return null;
    // And the italic: one nothing has asked for yet reads as its swap fallback.
    await Promise.allSettled(['400', 'italic 400'].map((f) => document.fonts.load(f + ' 32px "' + want + '"')));
    try { await document.fonts.ready; } catch {}
    const c = document.createElement('canvas').getContext('2d');
    const at = (f) => { c.font = '32px ' + f; return c.measureText('Deploy postmortem MMMWWWiiil').width; };
    const fallback = at('"__draftgate_absent_family__"');
    const actual = at('"' + want + '"');
    return { family: want, resolved: actual !== fallback, width: actual, fallbackWidth: fallback };
  };

  // Was a selection still live when the census ran? The bubble menu needs one, so probe.ts asserts
  // it first. `collapsed` decides, not focus: measured, bubble=1 passes with document.hasFocus()
  // false. hasFocus is reported for report.json.
  const selectionProbe = () => {
    const live = window.getSelection();
    return { hasFocus: document.hasFocus(), collapsed: live === null || live.isCollapsed };
  };

  // `stylesOnly`, for the forced-hover loop: skips the selection read, the font probe and the
  // `innerText` layout flush, once per selector.
  if (spec.stylesOnly) {
    return { destination: null, counts, styles, selection: { hasFocus: false, collapsed: true },
      font: null, diagnostics: {} };
  }

  return {
    destination: document.documentElement.dataset.destination ?? null,
    counts,
    styles,
    selection: selectionProbe(),
    font: await fontProbe(),
    // What each drawn link READS and where it GOES, and the addresses the target bubble shows.
    links: [...document.querySelectorAll('.ProseMirror a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
    })),
    linkTargets: [...document.querySelectorAll('.dg-linktarget-url')].map((u) => u.textContent),
    // Human diagnostics, not assertions: handy in report.json when a scenario fails.
    diagnostics: {
      bodyChars: (document.querySelector('.ProseMirror')?.innerText ?? '').length,
      warnings: q('.dg-warn'),
    },
  };
}

/** The deferred-image control and the real `<img>`, if either is there. */
function renderedImage() {
  // Not the separator prosemirror-view appends after an inline leaf (see probe.ts's NODE_SELECTORS):
  // that one has no src and would answer this question with scaffolding.
  const im = document.querySelector('.ProseMirror img:not(.ProseMirror-separator)');
  const defer = document.querySelector('.ProseMirror .dg-img-defer:not(.dg-img-loaded)');
  return {
    // A remote image the reviewer has not asked for. Its text is reported, not a boolean: the URL
    // must show in full, since an elided host lets a lookalike domain through.
    deferred: defer
      ? {
          url: defer.querySelector('.dg-img-url')?.textContent ?? null,
          hasButton: !!defer.querySelector('.dg-img-load'),
        }
      : null,
    // A real <img>: null until someone clicks, which proves no request at render time.
    loaded: im
      ? { src: String(im.src).slice(0, 60), complete: im.complete, naturalWidth: im.naturalWidth }
      : null,
  };
}

/** Does each of these URLs actually load in the renderer? */
async function loadImages(sources) {
  const load = (src) => new Promise((resolve) => {
    const im = new Image();
    let timer;
    const done = (loaded) => {
      clearTimeout(timer);
      resolve({ loaded, naturalWidth: im.naturalWidth });
    };
    im.onload = () => done(true);
    im.onerror = () => done(false);
    // Only reachable if the request never answers at all; onload/onerror cover both real
    // outcomes. Clearing it also releases the decoded bitmap the closure would otherwise hold.
    timer = setTimeout(() => done(false), 1000);
    im.src = src;
  });

  const names = Object.keys(sources);
  const results = await Promise.all(names.map((n) => load(sources[n])));
  return Object.fromEntries(names.map((n, i) => [n, results[i]]));
}

/**
 * Select a run of text the way a person dragging across it would: the press focuses the draft, and
 * the selection comes after. Returns the run's box, or `null` when no text node holds it. In that
 * order: in a focused page a range added inside the editor focuses it from `addRange`, TipTap
 * answers with a transaction, and ProseMirror writes its old caret back over the range.
 *
 * `preventScroll` focuses without scrolling; `collapsed` leaves a caret before the run and skips
 * the wait for the selection toolbar, which never opens over a caret.
 */
async function selectText(needle, opts) {
  const { preventScroll = false, collapsed = false } = opts || {};
  const pm = document.querySelector('.ProseMirror');
  if (!(pm instanceof HTMLElement)) return null;
  const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const at = node.textContent.indexOf(needle);
    if (at === -1) continue;
    pm.focus({ preventScroll });
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const box = range.getBoundingClientRect();
    if (collapsed) range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!collapsed) await new Promise((r) => setTimeout(r, 350));
    return { top: box.top, bottom: box.bottom };
  }
  return null;
}

/** Click an allow-listed toggle and wait for what it is supposed to reveal. */
async function openControl(toggle, reveals) {
  const el = document.querySelector(toggle);
  if (!el) return { ok: false, detail: 'no element matched the toggle selector ' + toggle };
  el.click();
  // The dynamic import resolves off the main thread; poll rather than guess a delay. Checked before
  // the first wait, since most controls reveal on the click itself.
  let revealed = !!document.querySelector(reveals);
  for (let i = 0; i < 100 && !revealed; i++) {
    await new Promise((r) => setTimeout(r, 50));
    revealed = !!document.querySelector(reveals);
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return revealed
    ? { ok: true }
    : { ok: false, detail: 'clicked, but nothing matching ' + reveals + ' appeared in 5s' };
}

/** Click one selector, reporting whether anything matched. */
function clickSelector(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.click();
  return true;
}

/** Is anything matching this selector in the document? */
function isPresent(selector) {
  return !!document.querySelector(selector);
}

/**
 * The painted size of the first element matching a selector, and the text it covers. When
 * `body/structure-lost`'s "Show me" resolves to a `<hardBreak>`, `Decoration.node` puts the class on
 * a `<br>`, which has no box: present, and invisible. happy-dom lays nothing out. The text says
 * whether the right thing was outlined.
 */
function paintedBox(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return {
    width: Math.round(box.width),
    height: Math.round(box.height),
    text: (el.textContent ?? '').slice(0, 80),
    tag: el.tagName.toLowerCase(),
  };
}

/**
 * Does any pair of context rows overlap, and does the strip stay within its cap? With a wildcard
 * `contextFields`, eight pairs on one clipped line drew `issueIdOrKey` over `fields.labels` and cut
 * `fields.priority` mid-word with every count right. A declared `flex-wrap` cannot say that.
 */
function contextLayout() {
  const strip = document.querySelector('.dg-context');
  if (!strip) return null;
  const rows = [...strip.querySelectorAll(':scope > div')].map((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  });
  let overlaps = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      // Two boxes overlap only if they intersect on BOTH axes; wrapped rows share x and must not
      // share y, and items on one row share y and must not share x.
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps++;
    }
  }
  const box = strip.getBoundingClientRect();
  // How wide each value renders, and how wide it wants to be. A flex value with
  // `min-width: 0` shrinks rather than overflowing, so an unreadable strip has narrow boxes, not
  // colliding ones.
  const values = [...strip.querySelectorAll(':scope > div > dd')].map((el) => ({
    shown: Math.round(el.getBoundingClientRect().width),
    wanted: el.scrollWidth,
  }));
  return {
    pairs: rows.length,
    values,
    overlaps,
    height: Math.round(box.height),
    /*
     * Every pair inside the strip, on both axes: on a one-line strip with `overflow: hidden` the
     * overflow runs off the right edge. Measured: a vertical-only check passes against the CSS that
     * produces the collision.
     */
    clipped: rows.filter(
      (r) =>
        r.bottom > box.bottom + 1 ||
        r.top < box.top - 1 ||
        r.right > box.right + 1 ||
        r.left < box.left - 1
    ).length,
  };
}

/**
 * Resolve after the frame holding the rendered draft has been committed. Two
 * `requestAnimationFrame`s: the first runs before the next paint, so a screenshot from it is blank.
 */
function afterTwoFrames() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
}

/**
 * Ask the renderer to fetch its own url: the positive control for `connect-src 'none'`, whose
 * refusal reaches the harness's log channel as the engine's `securitypolicyviolation` entry naming
 * `connect-src` (`harness.m`). Its own url, so with the policy absent nothing leaves the machine.
 */
async function probeConnectSrc() {
  // Reported, so the harness drops this refusal by its exact url and keeps any real violation.
  const url = location.href;
  try {
    await fetch(url);
  } catch {
    // Expected: `draftgate://` has no fetch support, so the rejection says nothing. The engine's
    // refusal is what is asserted (`Report.cspRefusal`).
  }
  return { url };
}

/** Put the caret in the editor, so inserted text lands there. */
function focusEditor() {
  const pm = document.querySelector('.ProseMirror');
  if (!(pm instanceof HTMLElement)) return false;
  pm.focus();
  return true;
}

/**
 * Focus the first prose field (the title beside the body) and put the caret at its end, so inserted
 * text appends. `setSelectionRange`, not a click, which lands wherever the pixel is.
 */
function focusProseField() {
  const input = document.querySelector('input.dg-prose-field');
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return document.activeElement === input;
}

/**
 * Focus one patch edit's textarea (`PatchEdits.tsx`), by its position, and put the caret at its end,
 * so typed text is appended to what the agent wrote.
 */
function focusEditText(index) {
  const area = document.querySelectorAll('textarea.dg-edit-text')[index];
  if (!(area instanceof HTMLTextAreaElement)) return false;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  return document.activeElement === area;
}

/** What the first prose field currently holds, for asserting what the reviewer sees. */
function proseFieldValue() {
  const input = document.querySelector('input.dg-prose-field');
  return input instanceof HTMLInputElement ? input.value : null;
}

/** Focus the first prose field and select all of it, so one Backspace empties it as a reviewer would. */
function selectProseField() {
  const input = document.querySelector('input.dg-prose-field');
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  input.select();
  return document.activeElement === input && input.selectionEnd - input.selectionStart === input.value.length;
}

/**
 * What the first prose field shows: its value, and the placeholder standing in when there is none.
 * One read, so it cannot straddle a keystroke.
 */
function proseFieldShows() {
  const input = document.querySelector('input.dg-prose-field');
  if (!(input instanceof HTMLInputElement)) return null;
  return { value: input.value, placeholder: input.placeholder };
}

/**
 * Put the caret at the end of the draft's last text (`repair-then-type`'s Enter after a repair). The
 * last text, named: a collapsed range after the editor's last child is an element boundary, which
 * WebKit resolves to the start of its first line (measured).
 *
 * True only once the editor agrees, so a caller asks until it does: a `focus()` arms a 20ms timer
 * that writes ProseMirror's own selection back over the DOM's if it has not read it yet
 * (`handlers.focus`). The editor is the one TipTap puts on its DOM (`dom.editor`).
 */
function caretToEnd() {
  const pm = document.querySelector('.ProseMirror');
  if (!(pm instanceof HTMLElement)) return false;
  const editor = pm.editor;
  if (editor) {
    let end = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.content.size > 0) end = pos + 1 + node.content.size;
    });
    const sel = editor.state.selection;
    if (sel.empty && sel.from === end && document.activeElement === pm) return true;
  }
  if (document.activeElement !== pm) pm.focus();
  // Text the reviewer can type into: not a line-number gutter or any other non-editable widget.
  const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) =>
      t.parentElement && t.parentElement.closest('[contenteditable="false"]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let last = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) last = t;
  const range = document.createRange();
  if (last) {
    range.setStart(last, last.textContent.length);
    range.collapse(true);
  } else {
    range.selectNodeContents(pm);
    range.collapse(false);
  }
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return false;
}

/**
 * The caret in the empty paragraph TipTap keeps after a draft that ends in a list, where a click
 * below the draft puts it: `show-me`'s Shift+Enter there makes a paragraph that begins with a hard
 * break, which markdown cannot spell. WebKit does not resolve a boundary after the last child into it.
 *
 * `TrailingNode` appends it on the first transaction; until then this puts the caret at the end of
 * the last paragraph, which is that transaction. True only once the editor agrees, like `caretToEnd`.
 */
function caretToTrailingParagraph() {
  const pm = document.querySelector('.ProseMirror');
  if (!(pm instanceof HTMLElement)) return false;
  const editor = pm.editor;
  if (editor) {
    const { doc, selection } = editor.state;
    const $at = selection.$from;
    const inTrailing =
      selection.empty &&
      doc.childCount > 1 &&
      $at.depth === 1 &&
      $at.index(0) === doc.childCount - 1 &&
      $at.parent.type.name === 'paragraph' &&
      $at.parent.content.size === 0;
    if (inTrailing && document.activeElement === pm) return true;
  }
  if (document.activeElement !== pm) pm.focus();
  const last = pm.lastElementChild;
  const exists = last instanceof HTMLParagraphElement && last.textContent === '' && last.previousElementSibling !== null;
  const paragraphs = pm.querySelectorAll('p');
  const target = exists ? last : paragraphs[paragraphs.length - 1];
  if (!target) return false;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return false;
}

/**
 * Close the window the way a reviewer who decides not to send does: `window.close()` reaches the
 * host's `webViewDidClose:`, the app exits 0 with no decision, and `readDecision` reads a rejection.
 * `surface:host` measures it.
 */
function closeWindow() {
  // Deferred one tick so the evaluate that asked for it can be acknowledged first.
  setTimeout(() => window.close(), 0);
  return true;
}

/**
 * What holds the keyboard: `null` for the page itself, or the tag of the focused control.
 * Nothing may be focused on open (`host.ts`).
 */
function focusedControl() {
  const active = document.activeElement;
  if (active === null || active === document.body) return null;
  return { tag: active.tagName };
}

/** The theme the renderer settled on, as the root element reports it. */
function readTheme() {
  return document.documentElement.dataset.theme ?? null;
}

/**
 * Where a code block's text starts, against how wide its widest line number is. Jira's reader
 * (`@atlaskit/code`) sizes the number column `calc(<digits>ch + 16px)` and puts the code 8px after
 * it: the widest number plus 24px, 31.36px with one digit and 38.69px with two, measured on live
 * blocks. Checked as that relation, so it holds for any fallback monospace face. Linear's column is
 * two digits of the code's face wide, hence `ch`; `border` is where a fixed column is measured from.
 */
function codeLayout() {
  const pre = document.querySelector('.ProseMirror pre');
  const code = pre && pre.querySelector('code');
  const numbers = pre ? [...pre.querySelectorAll('.dg-linenos span')] : [];
  if (!pre || !code || numbers.length === 0) return null;
  // The number's own ink width, from a Range over its text: the span is a block, as wide as the column.
  const inkWidth = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().width;
  };
  const widest = Math.max(...numbers.map(inkWidth));
  const preBox = pre.getBoundingClientRect();
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let textLeft = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const r = document.createRange();
    r.selectNodeContents(t);
    textLeft = r.getClientRects()[0].left - preBox.left;
    break;
  }
  // The last number beside the last line, as ink rows (a stretched flex item's box is as tall as the
  // code). A wrapped line adds a row with no number, and every later number drifts down.
  const top = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const rects = r.getClientRects();
    return rects.length ? rects[rects.length - 1].top : null;
  };
  const lastNumberTop = top(numbers[numbers.length - 1]);
  const lastLineTop = top(code);
  // The number column's box against the panel's padding box (inside any border, above a scrollbar),
  // so a full-height column reads 0 under any scrollbar setting. The bottom subtracts
  // `offsetHeight - clientHeight` instead of adding `clientHeight`, which rounds: 18.375px lines put
  // that edge a quarter pixel off, half the tolerance.
  const column = numbers[0].parentElement.getBoundingClientRect();
  const inner = {
    top: preBox.top + pre.clientTop,
    left: preBox.left + pre.clientLeft,
    bottom: preBox.bottom - (pre.offsetHeight - pre.clientHeight - pre.clientTop),
  };
  // Computed, not `clientLeft`, which rounds a hairline to a whole pixel.
  const border = parseFloat(getComputedStyle(pre).borderLeftWidth);
  // `1ch` in the code's own font, measured over a hundred zeros: a Range over one character rounds
  // to whole pixels (8.00px where it is 7.22). Last, so the span costs no second layout above.
  const cs = getComputedStyle(code);
  const zeros = document.createElement('span');
  zeros.style.cssText = 'position: absolute; visibility: hidden; white-space: pre';
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle']) zeros.style[p] = cs[p];
  zeros.textContent = '0'.repeat(100);
  document.body.append(zeros);
  const ch = zeros.getBoundingClientRect().width / 100;
  zeros.remove();
  return {
    lines: numbers.length,
    widest,
    textLeft,
    ch,
    border,
    lastNumberTop: lastNumberTop === null ? null : lastNumberTop - preBox.top,
    lastLineTop: lastLineTop === null ? null : lastLineTop - preBox.top,
    column: { top: column.top - inner.top, bottom: inner.bottom - column.bottom, left: column.left - inner.left },
  };
}

/**
 * Every table's width, its first row's cell widths and its own border, against the editor's content
 * box, in real layout. Every table: a width rule can be wrong for some column counts only.
 */
function tableLayout() {
  const pm = document.querySelector('.ProseMirror');
  if (!pm) return { content: 0, dpr: window.devicePixelRatio, tables: [] };
  // The editor's content box from its own fractional box, not `clientWidth`, which rounds.
  const cs = getComputedStyle(pm);
  const content =
    pm.getBoundingClientRect().width -
    ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((n, p) => n + parseFloat(cs[p]), 0);
  const tables = [...pm.querySelectorAll('table')].map((table) => {
    const row = table.querySelector('tr');
    return {
      width: table.getBoundingClientRect().width,
      columns: row ? [...row.children].map((c) => c.getBoundingClientRect().width) : [],
      border: parseFloat(getComputedStyle(table).borderLeftWidth),
    };
  });
  return { content, dpr: window.devicePixelRatio, tables };
}

/**
 * How far each table's wrapper scrolls sideways, and how much wider than its box the draft is. The
 * distance a wrapper moves, since `overflow: visible` reports the same `scrollWidth` and never moves;
 * `overhang` tells a table that fits from a wrapper that will not scroll. Put back where it was.
 */
function tableOverflow() {
  const body = document.querySelector('.dg-body');
  return {
    body: body ? body.scrollWidth - body.clientWidth : null,
    wrappers: [...document.querySelectorAll('.ProseMirror .tableWrapper')].map((w) => {
      const before = w.scrollLeft;
      w.scrollLeft = w.scrollWidth;
      const moved = w.scrollLeft;
      w.scrollLeft = before;
      return { moved, overhang: w.scrollWidth - w.clientWidth };
    }),
  };
}

/**
 * Each patch edit's textarea: how far its text reaches past its box (0 when every line shows) and
 * how many lines it holds, so a check can tell a grown box from an empty one.
 */
function editTextFit() {
  return [...document.querySelectorAll('textarea.dg-edit-text')].map((a) => ({
    hidden: a.scrollHeight - a.clientHeight,
    lines: a.value.split('\n').length,
    height: a.clientHeight,
  }));
}

/**
 * For each `[upper, lower]` pair, the first `upper` match's bottom to the first `lower` match's
 * top, in real layout, or `null` when either matches nothing.
 */
function gapsBetween(pairs) {
  return pairs.map(([upper, lower]) => {
    const a = document.querySelector(upper);
    const b = document.querySelector(lower);
    return a && b ? b.getBoundingClientRect().top - a.getBoundingClientRect().bottom : null;
  });
}

/**
 * Where the first task item's checkbox sits against its text, in real layout: every sheet centres it
 * on the first line with a margin from its own line height, so the relation is checked, not a margin.
 */
function taskLayout() {
  const li = document.querySelector('.ProseMirror ul[data-type="taskList"] > li');
  const box = li && li.querySelector(':scope > label > input[type="checkbox"]');
  const text = li && li.querySelector(':scope > div > p');
  if (!li || !box || !text) return null;
  const top = text.getBoundingClientRect().top;
  const b = box.getBoundingClientRect();
  return {
    lineHeight: parseFloat(getComputedStyle(text).lineHeight),
    boxCentre: b.top + b.height / 2 - top,
    rowHeight: li.getBoundingClientRect().height,
    textHeight: text.getBoundingClientRect().height,
  };
}

/*
 * The full toolbar over a scrolled draft, in small steps: the checks need real input between them,
 * which only the driver can send. Selecting is `selectText`'s.
 */

/**
 * Scroll the draft's pane so the line holding `needle` sits under the middle of the full toolbar, or
 * to the pane's foot when there is no needle. Returns whether that line is now under the toolbar,
 * the precondition of the caret checks.
 */
async function scrollPane(needle) {
  const body = document.querySelector('.dg-body');
  if (!body) return false;
  if (needle === undefined) {
    body.scrollTop = body.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return false;
  }
  const bar = document.querySelector('.dg-toolbar');
  const pm = document.querySelector('.ProseMirror');
  if (!bar || !pm) return false;
  const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const at = node.textContent.indexOf(needle);
    if (at === -1) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const b = bar.getBoundingClientRect();
    body.scrollTop += range.getBoundingClientRect().top - (b.top + b.height / 2);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const line = range.getBoundingClientRect();
    const now = bar.getBoundingClientRect();
    return line.top > now.top && line.top < now.bottom;
  }
  return false;
}

/**
 * Where the full toolbar is against its pane, and what is drawn on top of it. `covered` hit-tests
 * every 8px across its middle row and its last pixel row above the border, so a narrow positioned
 * box (Slack's 35px line numbers) cannot fall between two points. The background is returned, since
 * a transparent toolbar shows the draft through.
 */
function toolbarInView() {
  const body = document.querySelector('.dg-body');
  const bar = document.querySelector('.dg-toolbar');
  if (!body || !bar) return null;
  const p = body.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const rows = [b.top + b.height / 2, b.bottom - 2];
  let samples = 0;
  let covered = 0;
  for (const y of rows) {
    for (let x = b.left + 2; x < b.right - 1; x += 8) {
      const hit = document.elementFromPoint(x, y);
      samples++;
      if (!hit || !bar.contains(hit)) covered++;
    }
  }
  return {
    scrollTop: body.scrollTop,
    pane: { top: p.top, bottom: p.bottom },
    bar: { top: b.top, bottom: b.bottom },
    background: getComputedStyle(bar).backgroundColor,
    samples,
    covered,
  };
}

/**
 * What is selected, the elements between the selection's start and the draft's root (`strong`
 * among them once Bold has applied), and where the pane is scrolled to.
 */
function selectionMarks() {
  const sel = window.getSelection();
  const within = [];
  let n = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  for (; n && !(n instanceof Element && n.classList.contains('ProseMirror')); n = n.parentNode) {
    if (n instanceof Element) within.push(n.tagName.toLowerCase());
  }
  const body = document.querySelector('.dg-body');
  return { selected: sel.toString(), within, scrollTop: body ? body.scrollTop : null };
}

/**
 * The caret's line against the full toolbar's foot and the pane's, two frames after the gesture
 * that moved it: whether it is where the reviewer can see it. `null` when there is no collapsed
 * caret to measure.
 */
async function caretInView() {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const body = document.querySelector('.dg-body');
  const bar = document.querySelector('.dg-toolbar');
  const sel = window.getSelection();
  if (!body || !bar || !sel.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const r = range.getClientRects()[0] || range.getBoundingClientRect();
  return {
    top: r.top,
    bottom: r.bottom,
    barBottom: bar.getBoundingClientRect().bottom,
    paneBottom: body.getBoundingClientRect().bottom,
  };
}

/**
 * The first element matching `selector`: its box, and whether it is the topmost thing at its own
 * centre, which is what "it opens over the draft" means in pixels.
 */
function topmostAt(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { top: r.top, bottom: r.bottom, onTop: !!hit && el.contains(hit) };
}

/**
 * Where the first `upper` and the first `lower` overlap, and whether `upper` is topmost at the middle
 * of the overlap. `null` when either is missing or they do not overlap, which a caller asserting a
 * stacking order must treat as a failure.
 */
function stackedAt(upper, lower) {
  const u = document.querySelector(upper);
  const l = document.querySelector(lower);
  if (!u || !l) return null;
  const a = u.getBoundingClientRect();
  const b = l.getBoundingClientRect();
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right - left < 1 || bottom - top < 1) return null;
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  return { top, bottom, upperOnTop: !!hit && u.contains(hit) };
}

/*
 * The WebKit host's own checks. `host.ts` attacks the window from inside the page with a decision
 * path armed, and judges each by the decision file staying absent and the window staying up.
 */

/** The page bridge (`draftgate.m`'s `BRIDGE_SCRIPT`) as the page sees it: present, frozen, not
 * replaceable, two functions. */
function hostBridgeShape() {
  const before = window.draftgate;
  try {
    window.draftgate = { decide() {} };
  } catch (e) {
    // a strict-mode assignment to a non-writable property; the read below is what counts
  }
  const d = window.draftgate;
  return {
    present: typeof d === 'object' && d !== null,
    frozen: Object.isFrozen(d),
    replaced: d !== before,
    keys: d ? Object.keys(d).sort() : [],
  };
}

/** What the bridge hands the main frame: the request's destination and how many fields it shows. */
async function hostBridgeRequest() {
  const r = await window.draftgate.request();
  return r ? { destination: r.destination, fields: Array.isArray(r.fields) ? r.fields.length : null } : null;
}

/**
 * An `about:blank` subframe (which `frame-src 'none'` does not refuse) asking the raw handler for the
 * draft (`request`), or submitting an approval through it (`decide`). Two calls, so a leak fails its
 * own check before an approval ends the window. Only the host's frame check stands in the way.
 */
async function hostSubframeAttack(step) {
  const f = document.createElement('iframe');
  document.body.append(f);
  const w = f.contentWindow;
  const h = w && w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.draftgate;
  const out = { created: !!w, wrapperInFrame: typeof (w && w.draftgate), handlerInFrame: typeof h, request: 'no handler' };
  if (h && step === 'request') {
    const reply = await h.postMessage({ kind: 'request' });
    out.request = reply === null || reply === undefined ? 'refused' : 'LEAKED ' + String(reply).slice(0, 40);
  }
  if (h && step === 'decide') {
    await h.postMessage({ kind: 'decide', json: JSON.stringify({ action: 'approve', edited: false, fields: {}, fixes: [] }) });
  }
  f.remove();
  return out;
}

/** Try to leave the review, one way per call. What the page says afterwards is `hostWhere`'s. */
function hostTryToLeave(how) {
  if (how === 'https') location.href = 'https://example.com/';
  if (how === 'self') location.href = 'draftgate://review/index.html?again';
  if (how === 'open') return String(window.open('https://example.com/', '_blank'));
  if (how === 'blank' || how === 'download') {
    const a = document.createElement('a');
    a.href = how === 'blank' ? 'https://example.com/' : 'data:text/plain,x';
    if (how === 'blank') a.target = '_blank';
    else a.download = 'x.txt';
    a.textContent = 'x';
    document.body.append(a);
    a.click();
    a.remove();
  }
  if (how === 'form') {
    const f = document.createElement('form');
    f.action = 'https://example.com/';
    f.method = 'post';
    document.body.append(f);
    f.submit();
  }
  return 'tried';
}

/** Still the review document? */
function hostWhere() {
  return { href: location.href, shell: !!document.querySelector('.dg-shell') };
}

/** Reads the page must not be able to make: its own scheme, and anywhere else. */
async function hostReads() {
  const attempt = async (url) => {
    try {
      const r = await fetch(url);
      return 'READ ' + r.status;
    } catch (e) {
      return 'refused';
    }
  };
  const xhr = () =>
    new Promise((resolve) => {
      try {
        const x = new XMLHttpRequest();
        x.open('GET', 'draftgate://review/index.html');
        x.onload = () => resolve('READ ' + x.status);
        x.onerror = () => resolve('refused');
        x.send();
      } catch (e) {
        resolve('refused');
      }
    });
  return { scheme: await attempt('draftgate://review/index.html'), https: await attempt('https://example.com/'), xhr: await xhr() };
}

/** What the page's script policy lets run: `eval`, an inline script, a worker. */
async function hostScriptPolicy() {
  let evaluated = 'refused';
  try {
    evaluated = String(new Function('return 1')());
  } catch (e) {
    // refused by script-src
  }
  window.__dgInline = 'no';
  const s = document.createElement('script');
  s.textContent = 'window.__dgInline = "RAN"';
  document.body.append(s);
  s.remove();
  const worker = await new Promise((resolve) => {
    try {
      const w = new Worker('data:text/javascript,postMessage(42)');
      w.onmessage = () => resolve('RAN');
      w.onerror = () => resolve('refused');
      setTimeout(() => resolve('refused'), 1000);
    } catch (e) {
      resolve('refused');
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  return { evaluated, inline: window.__dgInline, worker };
}

/**
 * A page script imitating the CSP engine, both ways it could, which must not pass for it: it posts
 * `text` -- a real refusal's, re-pointed -- on the harness's console channel claiming
 * `trusted: true`, and it dispatches its own `securitypolicyviolation` for `dispatchedUrl`, which
 * the harness's isolated listener hears too. Says which channels it could reach, and whether the
 * event could be built at all.
 */
function hostForgeRefusal(text, dispatchedUrl) {
  const h = window.webkit && window.webkit.messageHandlers;
  const reach = { console: !!(h && h.dgharness), security: !!(h && h.dgsecurity), dispatched: false };
  if (reach.console) h.dgharness.postMessage({ source: 'security', level: 'error', trusted: true, text });
  try {
    document.dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', {
      blockedURI: dispatchedUrl, documentURI: location.href, violatedDirective: 'connect-src',
      effectiveDirective: 'connect-src', originalPolicy: "connect-src 'none'", disposition: 'enforce',
      statusCode: 0,
    }));
    reach.dispatched = true;
  } catch (e) {
    // reported as not dispatched, which the check then says
  }
  return reach;
}

/** The page retitling itself, which must not reach the window's title bar. */
function hostSetTitle(title) {
  document.title = title;
  return document.title;
}

/** What the page is allowed to ask the machine for. The three asks run at once. */
async function hostPermissions() {
  const notification = typeof Notification === 'undefined'
    ? Promise.resolve('no API')
    : Promise.race([Notification.requestPermission(), new Promise((r) => setTimeout(() => r('no answer'), 2000))]);
  const media = !navigator.mediaDevices
    ? Promise.resolve('no API')
    : navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'GRANTED', () => 'denied');
  const geolocation = new Promise((resolve) => {
    if (!navigator.geolocation) return resolve('no API');
    navigator.geolocation.getCurrentPosition(() => resolve('GRANTED'), () => resolve('denied'), { timeout: 1500 });
    setTimeout(() => resolve('no answer'), 2000);
  });
  const [n, m, g] = await Promise.all([notification, media, geolocation]);
  return { notification: n, media: m, geolocation: g };
}

/**
 * Watch the page's `contextmenu` events from here on, or read what was seen: how many arrived, and
 * how many were already cancelled at the document. The host's listener is on the window's capture
 * phase, so it has run by then.
 */
function hostContextMenus(read) {
  if (!read) {
    window.__dgMenus = { seen: 0, cancelled: 0 };
    document.addEventListener('contextmenu', (e) => {
      window.__dgMenus.seen += 1;
      if (e.defaultPrevented) window.__dgMenus.cancelled += 1;
    });
  }
  return window.__dgMenus;
}

/** The centre of the first element matching a selector, in the page's coordinates. */
function hostCentre(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) };
}

/**
 * Which face draws the first element matching `selector`, by width: its text in its computed font
 * against Menlo alone and `ui-monospace` alone. WebKit has no public "which font drew this"; a width
 * match tells two named faces apart, never a file. The two references must differ.
 */
function hostCodeFace(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const text = (el.textContent || '').trim() || 'iiiiWWWW0123';
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (family) => {
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + family;
    return ctx.measureText(text).width;
  };
  return { family: cs.fontFamily, text: text.slice(0, 40), own: width(cs.fontFamily), menlo: width('Menlo'), uiMonospace: width('ui-monospace') };
}

/**
 * `CSS.forcePseudoState(['hover'])` for the WebKit host, by rewriting the cascade: every `:hover`
 * rule gets a twin right after it saying `[data-dg-force-hover]` (same specificity, same order), and
 * the element gets the attribute. A synthesised mouse move does not reach an inactive app's page, and
 * activating it would take the Mac's focus. `on` false clears it.
 */
function wkForceHover(selector, on) {
  const ATTR = 'data-dg-force-hover';
  if (!window.__dgHoverTwins) {
    window.__dgHoverTwins = true;
    const walk = (list, owner) => {
      for (let i = 0; i < list.length; i++) {
        const rule = list[i];
        if (rule instanceof CSSStyleRule) {
          if (rule.selectorText.includes(':hover')) {
            owner.insertRule(rule.selectorText.replace(/:hover/g, '[' + ATTR + ']') + ' { ' + rule.style.cssText + ' }', i + 1);
            i++;
          }
        } else if (rule.cssRules) {
          walk(rule.cssRules, rule);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, sheet);
  }
  document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
  if (!on) return true;
  const el = document.querySelector(selector);
  if (!el) return false;
  el.setAttribute(ATTR, '');
  return true;
}

/**
 * `CSS.getPlatformFontsForNode` for the WebKit host: the node's text in its computed font against
 * each loaded web face alone. A face whose width matches over two different fallbacks (so an unloaded
 * face cannot match by falling back) drew it; none matching is a platform face. It names a family,
 * never an instance.
 */
async function wkFacesByWidth(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const text = (el.textContent || '').trim() || 'x';
  try {
    await document.fonts.load(cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily, text);
    await document.fonts.ready;
  } catch (e) {
    // a face that cannot load is what the width match then reports
  }
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (family) => {
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + family;
    return ctx.measureText(text).width;
  };
  const own = width(cs.fontFamily);
  const families = new Set();
  document.fonts.forEach((f) => {
    if (f.status === 'loaded') families.add(f.family.replace(/^["']|["']$/g, ''));
  });
  const hits = [];
  for (const family of families) {
    const quoted = '"' + family + '"';
    if (Math.abs(width(quoted + ', monospace') - own) < 0.01 && Math.abs(width(quoted + ', serif') - own) < 0.01) {
      hits.push({ familyName: family, isCustomFont: true, glyphCount: text.length });
    }
  }
  if (hits.length === 0) {
    const first = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    hits.push({ familyName: first, isCustomFont: false, glyphCount: text.length });
  }
  return hits;
}

/**
 * Is the italic under `selector` the family's own italic? WebKit names no instance, so the evidence
 * is the advances: a synthetic slant keeps the upright's widths. Reported with whether a loaded
 * italic of that family covers the element's weight: CSS matching prefers style over weight, so with
 * Lato's 400 italic gone the `em` draws in the 700 italic, whose advances differ too
 * (`.claude/rules/styles.md`).
 */
async function wkItalicAdvances(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const text = (el.textContent || '').trim() || 'italic';
  const family = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
  try {
    await document.fonts.load('italic ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily, text);
    await document.fonts.ready;
  } catch (e) {
    // what did not load is reported below
  }
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (style) => {
    ctx.font = style + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return ctx.measureText(text).width;
  };
  const weight = Number(cs.fontWeight) || 400;
  // A face's `weight` is one value or a variable face's range, in numbers or keywords.
  const covers = (declared) => {
    const [lo, hi] = String(declared)
      .split(/\s+/)
      .map((w) => (w === 'normal' ? 400 : w === 'bold' ? 700 : Number(w)));
    return weight >= lo && weight <= (hi ?? lo);
  };
  let italicFaceLoaded = false;
  document.fonts.forEach((f) => {
    if (f.status !== 'loaded' || f.style !== 'italic') return;
    if (f.family.replace(/^["']|["']$/g, '') === family && covers(f.weight)) italicFaceLoaded = true;
  });
  return { family, style: cs.fontStyle, italic: width('italic'), upright: width('normal'), italicFaceLoaded };
}

/** Could the page be seen? WebKit stops drawing a `hidden` one (see `host.ts`'s preflight). */
function hostVisibility() {
  return document.visibilityState;
}

/**
 * Every key the window's own `localStorage` holds, or null when it cannot be read. Every key, so the
 * check needs no copy of `themePref.ts`'s name to go stale.
 */
function hostStorage() {
  try {
    return Object.keys(localStorage);
  } catch (e) {
    return null;
  }
}

/** The draft's text as the editor holds it. */
function hostEditorText() {
  const pm = document.querySelector('.ProseMirror');
  return pm ? pm.textContent : null;
}

/**
 * Has the page drawn the controls a keyboard can reach (the toolbar's text-style select for markdown,
 * the textarea for plain, a patch's edit boxes, the footer), on screen or not? `isRendered` waits
 * for a frame, which a window not ordered in never draws.
 */
function hostControlsDrawn() {
  const compose = document.querySelector('.dg-compose');
  const surface = !compose
    ? document.querySelector('textarea.dg-edit-text')
    : compose.querySelector('.ProseMirror')
      ? document.querySelector('.dg-toolbar .dg-tb-select')
      : compose.querySelector('textarea.dg-plain-body');
  return surface !== null && document.querySelectorAll('.dg-footer .dg-btn').length > 0;
}

/**
 * Everything stray typing could have changed, read off the page: the draft's text, each line
 * field, each edit box of a patch, the text-style select, and the "edited" badge.
 */
function hostDraftState() {
  const pm = document.querySelector('.dg-compose .ProseMirror');
  const plain = document.querySelector('textarea.dg-plain-body');
  const select = document.querySelector('.dg-tb-select');
  return {
    draft: pm ? pm.textContent : plain ? plain.value : null,
    lines: [...document.querySelectorAll('input.dg-prose-field')].map((i) => i.value),
    edits: [...document.querySelectorAll('textarea.dg-edit-text')].map((t) => t.value),
    textStyle: select ? select.value : null,
    edited: document.querySelector('.dg-edited') !== null,
  };
}

/** Is the focus on the `index`th element `selector` matches? */
function hostFocusedIs(selector, index) {
  const el = document.querySelectorAll(selector)[index];
  return el !== undefined && document.activeElement === el;
}

/**
 * How many times the window's `focus` event has fired since `arm`, called once per window. The `⌘↵`
 * grace restarts on it (`shortcutGrace.ts`), so `host.ts` counts it before pressing inside the grace.
 */
function hostWindowFocusEvents(arm) {
  if (arm) {
    window.__dgFocusEvents = 0;
    window.addEventListener('focus', () => window.__dgFocusEvents++);
  }
  return window.__dgFocusEvents;
}

/**
 * The bundled Lato against Slack's own files, in this engine: `fonts:lato` (`lato.ts`).
 *
 * `fonts` holds base64 font files: Slack's served upright and italic, loaded as `M-Slack`, and the
 * bundled upright alone as `M-UprightOnly`, whose italic can only be a synthetic slant. `Lato` is
 * the window's own `@font-face`. What it compares, bundled against Slack's:
 *
 * - each character of a working set alone, at every size (its advance);
 * - the sentences at every size, kerned and with kerning off;
 * - every two-character pair of a smaller set, at `at` px;
 * - where `paragraph` wraps in boxes `widths` px wide, upright at every size and italic at `at`;
 * - the sentences at `at` px italic: the slanted upright, the bundled italic and Slack's.
 *
 * Widths are a Range's, so they carry layout's fractions, and each batch is laid out once and then
 * read. It ends by drawing `paragraph` in each file, kerning off, in the boxes `ink` names, for the
 * caller's screenshot.
 */
async function latoAdvances(fonts, sizes, widths, at, sentences, paragraph) {
  const bytes = (b64) => {
    const s = atob(b64);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a.buffer;
  };
  const faces = [
    new FontFace('M-Slack', bytes(fonts.slackUpright), { style: 'normal', weight: '400' }),
    new FontFace('M-Slack', bytes(fonts.slackItalic), { style: 'italic', weight: '400' }),
    new FontFace('M-UprightOnly', bytes(fonts.ownUpright), { style: 'normal', weight: '400' }),
  ];
  for (const f of faces) {
    await f.load();
    document.fonts.add(f);
  }
  // The window's own faces, or every number below measures whatever stood in for them.
  for (const spec of ['400 15px Lato', 'italic 400 15px Lato']) {
    const loaded = await document.fonts.load(spec);
    if (loaded.length === 0 || loaded.some((f) => f.status !== 'loaded')) {
      throw new Error('the bundled face for "' + spec + '" did not load');
    }
  }

  // The width of every run in `runs` ({ text, family, size, style, kerning }), from one layout.
  // Each on a line of its own: a run starting mid-line snaps to a different layout fraction.
  const measure = (runs) => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;font-weight:400;white-space:pre';
    const lines = runs.map((r) => {
      const line = document.createElement('div');
      line.style.cssText = 'font-family:' + r.family + ';font-size:' + r.size + 'px;font-style:' +
        (r.style || 'normal') + ';font-kerning:' + (r.kerning || 'normal');
      line.textContent = r.text;
      box.appendChild(line);
      return line;
    });
    document.body.appendChild(box);
    const range = document.createRange();
    const out = lines.map((line) => {
      range.selectNodeContents(line);
      return range.getBoundingClientRect().width;
    });
    box.remove();
    return out;
  };
  // Bundled minus Slack's, for every text: one batch for both families.
  const deltas = (texts, size, style, kerning) => {
    const w = measure(texts.flatMap((text) => [
      { text, family: 'Lato', size, style, kerning },
      { text, family: 'M-Slack', size, style, kerning },
    ]));
    return texts.map((_, i) => w[2 * i] - w[2 * i + 1]);
  };
  // The text offset each line of `paragraph` starts at, wrapped `px` wide: a line starts where a
  // character's box drops below the one before.
  const lineStarts = (family, size, px, style) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:' + px + 'px;font-weight:400;font-family:' +
      family + ';font-size:' + size + 'px;font-style:' + style;
    d.textContent = paragraph;
    document.body.appendChild(d);
    const r = document.createRange();
    const starts = [];
    let top = null;
    for (let i = 0; i < paragraph.length; i++) {
      r.setStart(d.firstChild, i);
      r.setEnd(d.firstChild, i + 1);
      const rect = r.getClientRects()[0];
      if (rect && (top === null || rect.top > top + 2)) {
        starts.push(i);
        top = rect.top;
      }
    }
    d.remove();
    return starts.join();
  };
  // The box widths at which each family wraps `paragraph` at other words than Slack's file, Slack's
  // own wrap read once per width.
  const wrapsDiffering = (families, size, style) => {
    const out = families.map(() => []);
    for (const px of widths) {
      const slack = lineStarts('M-Slack', size, px, style);
      families.forEach((family, i) => {
        if (lineStarts(family, size, px, style) !== slack) out[i].push(px);
      });
    }
    return out;
  };

  const chars = [];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(String.fromCharCode(c));
  for (const c of 'áčďéěíňóřšťúůýžäöüßłąęśźżćńÁČŘŠŽ€–—“”‘’…•') chars.push(c);

  const bySize = sizes.map((size) => {
    const glyphs = deltas(chars, size);
    const biggest = (kerning) => Math.max(...deltas(sentences, size, 'normal', kerning).map(Math.abs));
    return {
      size,
      glyphsDiffering: chars.filter((_, i) => glyphs[i] !== 0).join(''),
      sentenceDeltaKerned: biggest('normal'),
      sentenceDeltaUnkerned: biggest('none'),
      wrapsDiffering: wrapsDiffering(['Lato'], size, 'normal')[0],
    };
  });

  const set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,;:!?\'"-()/ '.split('');
  const pairTexts = set.flatMap((a) => set.map((b) => a + b));
  const pairDeltas = deltas(pairTexts, at);
  const pairs = pairTexts.map((pair, i) => ({ pair, delta: pairDeltas[i] })).filter((p) => p.delta !== 0);

  const italicWidths = measure(sentences.flatMap((text) => [
    { text, family: 'M-UprightOnly', size: at, style: 'italic' },
    { text, family: 'Lato', size: at, style: 'italic' },
    { text, family: 'M-Slack', size: at, style: 'italic' },
  ]));
  const italic = sentences.map((_, i) => ({
    synthetic: italicWidths[3 * i],
    real: italicWidths[3 * i + 1],
    slack: italicWidths[3 * i + 2],
  }));
  const [real, synthetic] = wrapsDiffering(['Lato', 'M-UprightOnly'], at, 'italic');

  // The paragraph in each file, kerning off, stacked on white for the caller's screenshot.
  const ink = { left: 20, width: 960, height: 380, tops: [20, 420] };
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff';
  ['Lato', 'M-Slack'].forEach((family, i) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:' + ink.left + 'px;top:' + ink.tops[i] + 'px;width:' +
      ink.width + 'px;height:' + ink.height + 'px;overflow:hidden;color:#000;font-weight:400;font-family:' +
      family + ';font-size:' + at + 'px;line-height:22px;font-kerning:none';
    d.textContent = paragraph + ' ' + paragraph;
    sheet.appendChild(d);
  });
  document.body.appendChild(sheet);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  return {
    glyphsTested: chars.length,
    bySize,
    pairsTested: pairTexts.length,
    pairs,
    italic,
    italicWrapsDiffering: { real, synthetic },
    ink,
  };
}

module.exports = {
  isRendered,
  takeCensus,
  renderedImage,
  loadImages,
  selectText,
  openControl,
  clickSelector,
  isPresent,
  afterTwoFrames,
  readTheme,
  probeConnectSrc,
  focusEditor,
  contextLayout,
  focusProseField,
  focusEditText,
  editTextFit,
  proseFieldValue,
  selectProseField,
  proseFieldShows,
  caretToEnd,
  caretToTrailingParagraph,
  closeWindow,
  paintedBox,
  codeLayout,
  tableLayout,
  tableOverflow,
  gapsBetween,
  taskLayout,
  scrollPane,
  toolbarInView,
  selectionMarks,
  caretInView,
  topmostAt,
  stackedAt,
  focusedControl,
  hostBridgeShape,
  hostBridgeRequest,
  hostSubframeAttack,
  hostTryToLeave,
  hostWhere,
  hostReads,
  hostScriptPolicy,
  hostPermissions,
  hostSetTitle,
  hostForgeRefusal,
  hostContextMenus,
  hostCentre,
  hostCodeFace,
  hostStorage,
  hostVisibility,
  hostEditorText,
  hostControlsDrawn,
  hostDraftState,
  hostFocusedIs,
  hostWindowFocusEvents,
  latoAdvances,
  wkForceHover,
  wkFacesByWidth,
  wkItalicAdvances,
};
