/**
 * The editor app's harness. Loads the built page, waits for the editor to settle, then writes hard
 * evidence to ruler-result/ and quits:
 *
 *   screenshot.png   - webContents.capturePage(), which needs no OS screen-recording permission
 *   dom.html         - the rendered DOM, so rendering can be asserted on rather than eyeballed
 *   console.log      - every console message and page error, including provider failures
 *
 * Set RULER_INTERACTIVE=1 to keep the window open and poke at it by hand instead.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, 'ruler-result');
fs.mkdirSync(OUT, { recursive: true });
const logLines = [];
const log = (s) => { logLines.push(s); console.log(s); };

app.whenReady().then(async () => {
  const t0 = Date.now();
  const win = new BrowserWindow({
    width: 1200, height: 950, frame: false, alwaysOnTop: true, show: true,
    webPreferences: { contextIsolation: true, offscreen: false },
  });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    log(`[console:${level}] ${message}  (${String(sourceId).split('/').pop()}:${line})`);
  });

  // Electron's console-message gives us the browser's already-stringified text, so an object
  // logged from the page arrives as the useless "[object Object]". Patch console in the page to
  // serialise objects and Errors before they reach us, or real failures stay invisible.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (() => {
        const ser = (a) => {
          if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
          if (a && typeof a === 'object') {
            try { return JSON.stringify(a, Object.getOwnPropertyNames(a)).slice(0, 1200); }
            catch { return Object.prototype.toString.call(a); }
          }
          return String(a);
        };
        for (const m of ['error', 'warn', 'log']) {
          const orig = console[m].bind(console);
          console[m] = (...args) => orig(args.map(ser).join(' '));
        }
      })();
    `).catch(() => {});
  });
  win.webContents.on('render-process-gone', (_e, d) => log(`[RENDER GONE] ${JSON.stringify(d)}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`[FAIL LOAD] ${code} ${desc}`));
  win.webContents.on('preload-error', (_e, f, err) => log(`[PRELOAD ERROR] ${f} ${err}`));

  await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  log(`[timing] loadFile resolved at ${Date.now() - t0}ms`);

  if (process.env.RULER_INTERACTIVE === '1') {
    // A frameless window has no close button, so give a human several reliable ways out.
    win.webContents.on('before-input-event', (_e, i) => {
      const quit = i.key === 'Escape' || ((i.meta || i.control) && /^[wq]$/i.test(i.key));
      if (quit) app.quit();
    });
    // Escape is also swallowed by some editor states, so keep a menu accelerator as a backstop.
    const { Menu } = require('electron');
    Menu.setApplicationMenu(Menu.buildFromTemplate([{
      label: 'jira-ruler',
      submenu: [{ role: 'quit' }, { role: 'reload' }, { role: 'toggleDevTools' }],
    }]));
    win.webContents.executeJavaScript(`
      const hint = document.createElement('div');
      hint.textContent = 'jira-ruler editor  \u2022  Esc / Cmd-W / Cmd-Q to quit  \u2022  Cmd-Alt-I for devtools';
      hint.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#0b5cd5;' +
        'color:#fff;font:12px ui-monospace,monospace;padding:6px 12px;text-align:center';
      document.body.appendChild(hint);
      document.body.style.paddingTop = '30px';
    `);
    log('[interactive] window open. Esc / Cmd-W / Cmd-Q quits.');
    return;
  }

  // Give the lazily-loaded editor chunk time to mount.
  await new Promise((r) => setTimeout(r, 12000));
  log(`[timing] settled at ${Date.now() - t0}ms`);

  const probe = await win.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const diag = document.querySelector('pre');
    return {
      diagnostics: diag ? diag.textContent : '(no diagnostics element)',
      counts: {
        'ProseMirror root'   : q('.ProseMirror'),
        'table'              : q('table'),
        'blockquote'         : q('blockquote'),
        'h1'                 : q('h1'),
        'h2'                 : q('h2'),
        'pre/code block'     : q('pre'),
        'hr (rule)'          : q('hr'),
        'img'                : q('img'),
        'task checkbox'      : q('input[type=checkbox]'),
        'ordered list'       : q('ol'),
        'bullet list'        : q('ul'),
        'editor toolbar'     : q('[data-testid*="toolbar"], .akEditor [role="toolbar"]'),
      },
      bodyChars: document.body.innerHTML.length,
      textSample: (document.querySelector('.ProseMirror')?.innerText || document.body.innerText || '').slice(0, 400),
    };
  })()`);

  fs.writeFileSync(path.join(OUT, 'dom.html'),
    await win.webContents.executeJavaScript('document.documentElement.outerHTML'));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'screenshot.png'), img.toPNG());

  log('\n=== NODE COUNTS IN RENDERED DOM ===');
  for (const [k, v] of Object.entries(probe.counts)) {
    log(`  ${k.padEnd(20)} ${v}${v === 0 ? '   <-- ABSENT' : ''}`);
  }
  log(`\nbody html chars: ${probe.bodyChars}`);
  log('\n=== IN-PAGE DIAGNOSTICS ===\n' + probe.diagnostics);
  log('\n=== TEXT SAMPLE ===\n' + probe.textSample);

  fs.writeFileSync(path.join(OUT, 'console.log'), logLines.join('\n') + '\n');
  app.quit();
});
app.on('window-all-closed', () => app.quit());
