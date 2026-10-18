/**
 * The committed icon, `surface/icon/draftgate.icns`: built from the SVGs beside it
 * (`draftgate.svg`, and `draftgate-small.svg` for 16 and 32 px), and transparent where the shape
 * is not. The review host copies it into both bundles (`cli/src/reviewHost.ts`), so it is a host
 * input; `bun run icon:build` is what makes it.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { sha256 } from '../src/surfaces/bundleStamp';

const ROOT = join(import.meta.dir, '..', '..');
const ICON_DIR = join(ROOT, 'surface', 'icon');
const ICNS = join(ICON_DIR, 'draftgate.icns');

/** The PNG an `.icns` holds under `type`, or null. The container is `type(4) length(4) data`, repeated after an 8-byte header. */
function icnsPng(icns: Buffer, type: string): Buffer | null {
  for (let at = 8; at + 8 <= icns.length; ) {
    const len = icns.readUInt32BE(at + 4);
    // A chunk is at least its own 8-byte header; anything shorter is a broken file, not a loop.
    if (len < 8) return null;
    if (icns.toString('latin1', at, at + 4) === type) return icns.subarray(at + 8, at + len);
    at += len;
  }
  return null;
}

/**
 * The pixels of a PNG, unfiltered: `rgba(x, y)` reads one. Only the format `iconutil` writes here,
 * 8-bit RGBA without interlacing; any other format throws rather than reading garbage.
 */
function decode(png: Buffer): (x: number, y: number) => number[] {
  let at = 8;
  const idat: Buffer[] = [];
  let width = 0;
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      const [depth, colourType, interlace] = [data[8], data[9], data[12]];
      if (depth !== 8 || colourType !== 6 || interlace !== 0) {
        throw new Error(`not 8-bit RGBA without interlacing: depth ${depth}, colour type ${colourType}, interlace ${interlace}`);
      }
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rows = raw.length / (stride + 1);
  const out = Buffer.alloc(rows * stride);
  for (let y = 0; y < rows; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? out[y * stride + i - 4]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= 4 ? out[(y - 1) * stride + i - 4]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + predictor) & 0xff;
    }
  }
  return (x, y) => [...out.subarray(y * stride + x * 4, y * stride + x * 4 + 4)];
}

describe('the committed icon', () => {
  const icns = readFileSync(ICNS);

  test('was built from the SVGs beside it', () => {
    // `bun run icon:build` writes each SVG's hash here. An edited SVG with a stale .icns fails, and
    // so does an SVG the build does not render.
    const svgs = readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg'));
    const built = JSON.parse(readFileSync(`${ICNS}.json`, 'utf8'));
    expect(built, 'an SVG changed: run `bun run icon:build`').toEqual(
      Object.fromEntries(svgs.map((f) => [f, sha256(readFileSync(join(ICON_DIR, f)))]))
    );
  });

  // draftgate-small.svg redraws only what sits on the body: the body itself, its gradients and its
  // shadow are draftgate.svg's, so an edit to one copy alone fails here.
  test("draftgate-small.svg's body is draftgate.svg's", () => {
    const shared = (f: string) => {
      const svg = readFileSync(join(ICON_DIR, f), 'utf8');
      return [
        /<linearGradient id="body".*?<\/linearGradient>/,
        /<linearGradient id="sign".*?<\/linearGradient>/,
        /<filter id="shadow".*?<\/filter>/,
        /<path d="[^"]*" fill="url\(#body\)" filter="url\(#shadow\)"\/>/,
      ].map((re) => svg.match(re)?.[0] ?? `no ${re} in ${f}`);
    };
    expect(shared('draftgate-small.svg')).toEqual(shared('draftgate.svg'));
  });

  // macOS 26 and newer draws an .icns whose outline is too far from its own small, on a grey rounded
  // square. Measured through NSWorkspace on macOS 26.0 and 27: an 824 rounded rectangle on Apple's
  // grid passes from radius 100 to 240, and superellipses of n 3.5 to 5 do not.
  test("draftgate.svg's body is a rounded rectangle macOS draws as it is", () => {
    const svg = readFileSync(join(ICON_DIR, 'draftgate.svg'), 'utf8');
    const d = svg.match(/<path d="([^"]*)" fill="url\(#body\)"/)?.[1] ?? '';
    const radius = Number(/ A(\S+) /.exec(d)?.[1]);
    const [r, a, b] = [radius, 100 + radius, 924 - radius].map((n) => +n.toFixed(3));
    expect(d, 'the body is not a rounded rectangle on the 824 grid').toBe(
      `M${a} 100 H${b} A${r} ${r} 0 0 1 924 ${a} V${b} A${r} ${r} 0 0 1 ${b} 924 ` +
        `H${a} A${r} ${r} 0 0 1 100 ${b} V${a} A${r} ${r} 0 0 1 ${a} 100 Z`
    );
    expect(radius).toBeGreaterThanOrEqual(100);
    expect(radius).toBeLessThanOrEqual(240);
    // The sheen is drawn on the same outline, or it shows past the body's corners.
    expect(svg.match(/<path d="([^"]*)" fill="url\(#sheen\)"/)?.[1]).toBe(d);
  });

  // ...and the .icns is drawn from it: where the corner arc meets the edge, (285, 101) and (101, 285)
  // on the 1024 canvas, a superellipse is transparent and this rectangle is opaque.
  test('its 1024px slot (ic10) fills the rounded corners', () => {
    const png = icnsPng(icns, 'ic10');
    expect(png, 'ic10 is missing from draftgate.icns').not.toBeNull();
    const rgba = decode(png!);
    for (const [x, y] of [[285, 101], [101, 285]] as const) {
      expect(rgba(x, y)[3], `alpha at ${x},${y}`).toBe(255);
    }
  });

  // The full drawing's pause bars blur into one block at 16 px, so 16 and 32 px come from
  // draftgate-small.svg. A point left of the bars separates the two drawings: it is inside the small
  // drawing's left bar (dark), and on the full drawing's yellow bubble (its bar starts further right).
  // The point is x 384, y 448 on the 1024 canvas. 16pt@2x (`ic11`) is 32 px; 32pt@2x (`ic12`) is 64.
  for (const [type, size, drawing, dark] of [
    ['ic11', 32, 'draftgate-small.svg', true],
    ['ic12', 64, 'draftgate.svg', false],
  ] as const) {
    test(`draws its ${size}px slot (${type}) from ${drawing}`, () => {
      const png = icnsPng(icns, type);
      expect(png, `${type} is missing from draftgate.icns`).not.toBeNull();
      const [r, g, b] = decode(png!)((384 * size) / 1024, (448 * size) / 1024);
      const isDark = r! < 64 && g! < 64 && b! < 64;
      expect(isDark, `pixel is ${[r, g, b].join(',')}`).toBe(dark);
    });
  }

  // A renderer that draws onto opaque white puts a white square behind the shape in the Dock.
  // The corner is outside the shape at every size, so it must be transparent.
  // The PNG sizes `iconutil` writes: 16pt@2x, 128pt and 512pt@2x. It stores 16pt and 32pt at 1x as
  // ARGB (`ic04`, `ic05`), not PNG.
  for (const [type, size] of [['ic11', 32], ['ic07', 128], ['ic10', 1024]] as const) {
    test(`is transparent outside the shape at ${size}px (${type})`, () => {
      const png = icnsPng(icns, type);
      expect(png, `${type} is missing from draftgate.icns`).not.toBeNull();
      const rgba = decode(png!)(0, 0);
      expect(rgba[3], `top-left pixel is ${rgba.join(',')}`).toBe(0);
    });
  }
});

