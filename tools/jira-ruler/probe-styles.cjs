const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 950, show: false, webPreferences: { contextIsolation: true } });
  await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 9000));
  const out = await win.webContents.executeJavaScript(`(() => {
    const pick = (el, props) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of props) o[p] = cs.getPropertyValue(p);
      return o;
    };
    const pm = document.querySelector('.ProseMirror');
    const q = (s) => pm && pm.querySelector(s);
    const T = ['font-family','font-size','font-weight','line-height','color','background-color'];
    const B = ['border','border-left','border-radius','padding','margin'];
    return {
      paragraph:  pick(q('p'), T),
      h1:         pick(q('h1'), T),
      h2:         pick(q('h2'), T),
      inlineCode: pick(q('code'), [...T,'border-radius','padding']),
      preBlock:   pick(q('pre') || q('.code-block'), [...T,'border-radius','padding']),
      gutter:     pick(document.querySelector('.line-number-gutter'), ['width','background-color','color','font-size','padding']),
      table:      pick(q('table'), ['border-collapse','border']),
      th:         pick(q('th'), [...T, ...B]),
      td:         pick(q('td'), [...T, ...B]),
      blockquote: pick(q('blockquote'), ['border-left','padding-left','margin','color']),
      link:       pick(q('a'), ['color','text-decoration-line']),
      hr:         pick(q('hr'), ['border-top','border','height','background-color','margin']),
      checkbox:   pick(q('input[type=checkbox]'), ['width','height','accent-color']),
    };
  })()`);
  console.log(JSON.stringify(out, null, 1));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
