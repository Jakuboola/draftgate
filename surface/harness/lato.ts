/**
 * `bun run fonts:lato`: the bundled Lato against the files Slack serves, measured in the window's
 * own engine. The numbers `surface/src/styles/fonts.css` cites come from here.
 *
 * Slack's upright and italic are fetched from the URLs `tokens:slack` recorded (`face` and
 * `italicFace` in `tools/slack-tokens/tokens.json`), so this needs network, and the version each
 * file declares is printed with the numbers. Both are loaded into a harness window -- off every
 * screen, like the probe's -- beside the window's own `Lato`; what `injected.cjs`'s `latoAdvances`
 * compares there is in its header. Then its two kerning-off paragraphs are compared pixel by pixel.
 * It prints what it measured and judges nothing.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUEST_ENV } from '../../cli/src/surfaces/windowProtocol';
import { HOST_LAYOUT, buildHost } from '../../cli/src/reviewHost';
import { fontFacts } from './fontFile';
import { SCENARIOS, requestFor } from './probe';
import { ROOT, INJECTED, SURFACE, bundledFaces, waitUntilRendered, type LatoAdvances } from './shared';
import { fetchedFontBytes } from './vendorCss';
import { WKSession, launchHost, type LaunchedHost } from './wkSession';

const SIZES = [13, 15, 18, 30];
/** The box widths a paragraph is wrapped at. */
const WIDTHS = [480, 560, 640, 720];
/** The size of Slack's message text, where the pairs, the italics and the pixels are compared. */
const AT = 15;
const SENTENCES = [
  'Deploy finished for the staging cluster; the migration ran in 42 seconds and nothing was rolled back.',
  'Can you check whether the export job still fails after the token rotation? It looked fine on my side.',
  'Quick heads-up: Řehoř and Łucja are out Friday, so the review moves to Monday 10:00 (CET).',
];
const PARAGRAPH =
  SENTENCES.join(' ') +
  ' The quick brown fox jumps over the lazy dog, then WAVY jugglers quiz fifty-seven boxes of ABC 0123456789' +
  ' (and {braces} [brackets] <angles> "quotes" & ampersands).';

async function main() {
  const tokens = (await Bun.file(join(ROOT, 'tools', 'slack-tokens', 'tokens.json')).json()) as {
    face: { src: string };
    italicFace: { src: string };
  };
  const own = bundledFaces().find((f) => f.family === 'Lato' && f.style === 'normal' && f.min === 400);
  if (!own?.file) throw new Error('fonts.css declares no upright 400 Lato with a file');
  const [slackUpright, slackItalic] = await Promise.all([fetchedFontBytes(tokens.face.src), fetchedFontBytes(tokens.italicFace.src)]);
  const base64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const fonts = { slackUpright: base64(slackUpright), slackItalic: base64(slackItalic), ownUpright: base64(readFileSync(own.file)) };
  console.log(`Slack's upright: ${fontFacts(slackUpright).version}`);
  console.log(`bundled upright: ${fontFacts(readFileSync(own.file)).version}`);

  const dir = mkdtempSync(join(tmpdir(), 'draftgate-lato-'));
  let win: LaunchedHost | undefined;
  try {
    const bin = (await buildHost(HOST_LAYOUT)).harness.bin;
    const requestPath = join(dir, 'request.json');
    writeFileSync(requestPath, JSON.stringify(requestFor('lato', SCENARIOS.slack!)));
    const channel = WKSession.channel(join(dir, 'control'));
    win = launchHost(bin, { [REQUEST_ENV]: requestPath, ...channel.env }, { timeoutMs: 120_000, surface: SURFACE });
    // A window that dies says so, with its stderr, rather than as the attach's 20 s timeout.
    const { exited, stderr } = win;
    const died = exited.then((h): never => {
      throw new Error(`the window exited (code ${h.code}, signal ${h.signal})\n${stderr().trim()}`);
    });
    died.catch(() => {});
    const session = await Promise.race([WKSession.attach(channel.dir), died]);
    try {
      await waitUntilRendered(session, 'before the Lato measurement');
      await session.setViewport();
      const m = await Promise.race([
        session.evaluate<LatoAdvances>(INJECTED.latoAdvances, fonts, SIZES, WIDTHS, AT, SENTENCES, PARAGRAPH),
        died,
      ]);
      report(m, inkOf(await session.screenshot(), m.ink, dir));
    } finally {
      session.close();
    }
  } finally {
    win?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(m: LatoAdvances, ink: ReturnType<typeof inkOf>): void {
  const px = (n: number) => `${n.toFixed(2)}px`;
  const boxes = (differing: number[]) =>
    `${differing.length ? differing.map((w) => `${w}px`).join(', ') : 'none'} of ${WIDTHS.join('/')}px`;
  for (const s of m.bySize) {
    console.log(
      `${s.size}px: ${m.glyphsTested - s.glyphsDiffering.length}/${m.glyphsTested} characters advance identically` +
        `${s.glyphsDiffering ? ` (differ: ${s.glyphsDiffering})` : ''}; sentences differ by up to ` +
        `${px(s.sentenceDeltaKerned)} kerned, ${px(s.sentenceDeltaUnkerned)} unkerned; ` +
        `wraps at a different word at ${boxes(s.wrapsDiffering)}`
    );
  }
  const pairs = [...m.pairs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  console.log(
    `${AT}px pairs: ${pairs.length}/${m.pairsTested} differ` +
      (pairs.length ? `, by up to ${px(Math.abs(pairs[0]!.delta))}: ${pairs.map((p) => `${p.pair}:${p.delta.toFixed(2)}`).join(' ')}` : '')
  );
  for (const i of m.italic) {
    console.log(
      `${AT}px italic: slanted upright ${px(i.synthetic)}, real italic ${px(i.real)} ` +
        `(${(((i.synthetic - i.real) / i.real) * 100).toFixed(1)}% wider); Slack's italic ${px(i.slack)}`
    );
  }
  console.log(
    `${AT}px italic wraps at a different word than Slack's: real italic at ${boxes(m.italicWrapsDiffering.real)}, ` +
      `slanted upright at ${boxes(m.italicWrapsDiffering.synthetic)}`
  );
  console.log(
    `${AT}px, kerning off, one paragraph in each file: ${ink.differing} of ${ink.pixels} pixels differ` +
      ` (ink ${ink.own} against ${ink.slack})`
  );
}

/**
 * The two paragraphs' pixels, compared: the screenshot through `sips` into an uncompressed BMP, the
 * one format read here in a few lines. Ink is the sum of each pixel's darkness, 0-255 a channel.
 */
function inkOf(png: Buffer, at: LatoAdvances['ink'], dir: string) {
  writeFileSync(join(dir, 'ink.png'), png);
  execFileSync('sips', ['-s', 'format', 'bmp', join(dir, 'ink.png'), '--out', join(dir, 'ink.bmp')], { stdio: 'ignore' });
  const bmp = readFileSync(join(dir, 'ink.bmp'));
  const offset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const rawHeight = bmp.readInt32LE(22);
  const bytes = bmp.readUInt16LE(28) / 8;
  const height = Math.abs(rawHeight);
  const stride = Math.ceil((width * bytes) / 4) * 4;
  // The screenshot is the view at 1x, so CSS px are pixels; a BMP stores its rows bottom-up.
  const darkness = (x: number, y: number) => {
    const i = offset + (rawHeight > 0 ? height - 1 - y : y) * stride + x * bytes;
    return 255 * 3 - bmp[i]! - bmp[i + 1]! - bmp[i + 2]!;
  };
  let own = 0, slack = 0, differing = 0;
  const [ownTop, slackTop] = at.tops;
  for (let dy = 0; dy < at.height; dy++) {
    for (let x = at.left; x < at.left + at.width; x++) {
      const a = darkness(x, ownTop + dy);
      const b = darkness(x, slackTop + dy);
      own += a;
      slack += b;
      if (a !== b) differing++;
    }
  }
  return { own, slack, differing, pixels: at.width * at.height };
}

if (import.meta.main) await main();
