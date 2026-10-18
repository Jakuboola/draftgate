/**
 * Shared Electron harness for the editor-core measuring probes.
 *
 * `probe-headings.cjs`, `probe-blocks.cjs`, `probe-linenos.cjs` and `probe-dark.cjs` differ only in
 * the expression they evaluate; the window options, the `loadFile`, the wait, the JSON print and the
 * quit live here once. `probe-styles.cjs` keeps its own harness: it is the script behind the
 * recorded h1-h3 numbers, and rewriting it would weaken that record.
 *
 * Prerequisite: `tools/jira-ruler/dist/` must exist. It is git-ignored, so a fresh clone lacks it;
 * building it means `npm install` here (about 1 GB of dependencies) and `npm run build`, so keep a
 * built copy. Without `dist/index.html` the probes report that and stop.
 *
 * Run with the Electron binary, not bun. Under bun, `require('electron')` is not Electron's API (at
 * best the npm package's binary path, and nothing in a checkout whose root has no `electron`), so
 * `bun probe-blocks.cjs` dies on its first line. Use `bun run measure:blocks` from the repo root, or
 * `bun ../electron/run.ts probe-blocks.cjs` from here: the launcher installs the rulers' Electron
 * first and pins the rulers' display.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, 'dist', 'index.html');

/**
 * The editor-core render is settled once these hold.
 *
 * It settles in roughly 350-450ms. A change-detection poll every 25ms for 12s sees exactly two
 * states, `null` and then the final values, so this polls for the final state rather than sleeping a
 * guess.
 *
 * It does not wait for `pre` or `img`: editor-core renders zero of each (the code block is a
 * `.code-block` node view and `mediaProvider` is stubbed here), so either condition would never
 * hold and the poll would burn its whole budget.
 */
const READY = `(() => {
  const pm = document.querySelector('.ProseMirror');
  if (!pm) return false;
  const h2 = pm.querySelector('h2');
  return !!pm.querySelector('table') && !!pm.querySelector('blockquote')
    && !!pm.querySelector('.code-block') && !!h2
    && getComputedStyle(h2).fontSize === '20px';
})()`;

/**
 * A computed-style reader, as source text.
 *
 * It has to be a string: it runs inside `executeJavaScript`, in the page, where nothing from this
 * module is in scope. Concatenated into the expression of every probe that runs through this
 * harness, so they all read styles the same way (`probe-styles.cjs` keeps its own `pick`).
 */
const PRELUDE = `
  const pm = document.querySelector('.ProseMirror');
  const read = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  };
  const pick = (sel, props, root) => read((root ?? pm).querySelector(sel), props);
`;

/**
 * Load the built editor-core, wait for it to settle, evaluate `expression`, print the result.
 *
 * `expression` is source text for an IIFE body; `PRELUDE` is already in scope, including `pm`.
 */
async function measure(expression) {
  if (!fs.existsSync(DIST)) {
    console.error(
      `measure: ${DIST} is missing.\n` +
        'It is git-ignored. Build it once with `npm install && npm run build` in tools/jira-ruler ' +
        '(about 1 GB of dependencies), and keep the built copy.'
    );
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 950,
    show: false,
    webPreferences: { contextIsolation: true },
  });
  await win.loadFile(DIST);

  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (await win.webContents.executeJavaScript(READY)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!ready) console.error('measure: the render never settled; results may be incomplete');

  // A throwing expression must report, not hang: a rejected `executeJavaScript` would skip
  // `app.quit()` and leave the probe on screen with only "Script failed to execute". The easy
  // trigger is `const read = ...` in a probe, which collides with PRELUDE's `read` (a SyntaxError in
  // the composed script).
  let out;
  try {
    out = await win.webContents.executeJavaScript(`(() => {
      ${PRELUDE}
      if (!pm) return { error: 'no .ProseMirror -- editor-core did not render' };
      ${expression}
    })()`);
  } catch (e) {
    console.error(
      `measure: the probe expression threw in the renderer: ${e && e.message}\n` +
        'A common cause is redeclaring a PRELUDE binding (`pm`, `read`, `pick`) with `const`, ' +
        'which is a SyntaxError in the composed script rather than a runtime error you can see.'
    );
    app.exit(1);
    return;
  }

  console.log(JSON.stringify(out, null, 1));
  app.quit();
}

/** Entry point for a probe file: `run(\`...expression...\`)` -- a STRING, not a function.
 *  Passing a function stringifies it into the IIFE body as an uncalled expression, so the probe
 *  prints `undefined` with no other complaint. */
function run(expression) {
  app.whenReady().then(() => measure(expression));
  app.on('window-all-closed', () => app.quit());
}

module.exports = { run };
