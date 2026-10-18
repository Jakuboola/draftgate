/**
 * Rasterise an SVG at every iconset size, with its alpha. Run by `tools/icon/build.ts` under
 * Electron's own binary, never by hand.
 *
 * Not Quick Look (`qlmanage -t`): it draws onto an opaque white ground, which puts a white square
 * behind the shape and casts the drop shadow onto white. A canvas keeps real transparency:
 * the SVG is decoded as an image and drawn at each size directly, so a 16px icon is drawn at 16px
 * rather than shrunk from 1024.
 *
 * Usage: Electron render.cjs <svg> <out-dir> '<json [[name, size], ...]>'
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// An uncaught main-process error pops a modal dialog on the user's screen and hangs the run.
const fail = (e) => {
  process.stderr.write(`icon render failed: ${(e && e.stack) || e}\n`);
  app.exit(1);
};
process.on('uncaughtException', fail);

const [svgPath, outDir, sizesJson] = process.argv.slice(2);

app.dock?.hide();
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false });
    await win.loadURL('about:blank');
    const src = 'data:image/svg+xml;base64,' + fs.readFileSync(svgPath).toString('base64');
    for (const [name, size] of JSON.parse(sizesJson)) {
      const px = Number(size);
      const png = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(src)};
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = ${px};
        canvas.height = ${px};
        canvas.getContext('2d').drawImage(img, 0, 0, ${px}, ${px});
        return canvas.toDataURL('image/png');
      })()`);
      fs.writeFileSync(path.join(outDir, name), Buffer.from(png.split(',')[1], 'base64'));
    }
    app.exit(0);
  })
  .catch(fail);
