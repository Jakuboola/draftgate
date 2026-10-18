/**
 * A font FILE's own facts -- family, version, variation axes, glyph count, italic -- read off its
 * tables.
 *
 * Why this exists: a window can bundle the right family NAME and the wrong FONT. Slack serves
 * Lato 2.015 and `@fontsource/lato` is Lato 1.104; Linear serves Inter as a variable font with
 * `wght` and `opsz` axes and `@fontsource/inter` is a static instance pinned at one optical size.
 * `getComputedStyle` says "Lato" either way and the probe's width check passes either way, so the
 * only witness is the file itself -- and the vendor's file, which the extractors fetch and read
 * with this same function, so the two sides of the comparison are one reading.
 *
 * WOFF2 only, and it THROWS on anything else: every file on both sides is woff2 -- `fontAssets.test.ts`
 * holds the bundle to it, and `vendorCss.ts` picks the vendor's woff2 `src` -- so a reader for other
 * containers would be code nothing exercises. Only UNTRANSFORMED tables are looked at (`name`,
 * `fvar`, `maxp`, `head`, `OS/2`), so WOFF2's glyf/loca transform never needs undoing, only skipping by its length.
 */

import { brotliDecompressSync } from 'node:zlib';

export interface FontFacts {
  /** The typographic family (name ID 16), else the legacy family (name ID 1). */
  family: string;
  /** Name ID 5, verbatim -- e.g. Lato's, which begins `Version 2.015;`. */
  version: string;
  /** Every `fvar` axis as `tag min..max`; `[]` for a static font. */
  axes: string[];
  glyphs: number;
  /**
   * Whether the file IS an italic, as against a face merely declared `font-style: italic` in CSS.
   * An italic `@font-face` pointing at the upright file matches on family, version, axes and glyph
   * count alike; this is what tells them apart. Both style bits, `head.macStyle` and
   * `OS/2.fsSelection`, and `null` when they disagree -- which one a platform honours differs, so
   * neither answer is the file's. Not a throw: an extractor reads colour and geometry in the same
   * run, and one odd vendor file should fail the italic comparison, not the whole regeneration.
   */
  italic: boolean | null;
}

/** WOFF2's known-table index (spec table 2). Index 63 means "tag follows". */
const WOFF2_TAGS = (
  'cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx ' +
  'kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix ' +
  'acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak ' +
  'Zapf Silf Glat Gloc Feat Sill'
)
  .match(/.{4}\s?/g)!
  .map((t) => t.slice(0, 4));

function woff2Tables(b: Buffer): Map<string, Buffer> {
  const numTables = b.readUInt16BE(12);
  const compressedSize = b.readUInt32BE(20);
  let at = 48;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = b[at++]!;
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('woff2: a UIntBase128 ran past five bytes');
  };
  const entries: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = b[at++]!;
    const index = flags & 0x3f;
    let tag: string;
    if (index === 63) {
      tag = b.toString('latin1', at, at + 4);
      at += 4;
    } else {
      tag = WOFF2_TAGS[index]!;
    }
    const version = flags >> 6;
    const orig = base128();
    // glyf/loca are transformed at version 0; every other table is transformed at non-zero.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    entries.push({ tag, length: transformed ? base128() : orig });
  }
  if (b.toString('latin1', 4, 8) === 'ttcf') throw new Error('woff2: font collections are not read');
  // The tables sit back to back in one brotli stream, in directory order, unpadded.
  const data = brotliDecompressSync(b.subarray(at, at + compressedSize));
  const out = new Map<string, Buffer>();
  let offset = 0;
  for (const { tag, length } of entries) {
    out.set(tag, data.subarray(offset, offset + length));
    offset += length;
  }
  return out;
}

/** Name IDs, preferring Windows US English (UTF-16BE) over Mac Roman. */
function names(name: Buffer): Map<number, string> {
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const out = new Map<number, string>();
  const rank = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = name.readUInt16BE(r);
    const language = name.readUInt16BE(r + 4);
    const id = name.readUInt16BE(r + 6);
    const raw = name.subarray(strings + name.readUInt16BE(r + 10), strings + name.readUInt16BE(r + 10) + name.readUInt16BE(r + 8));
    const score = platform === 3 && language === 0x409 ? 3 : platform === 3 || platform === 0 ? 2 : 1;
    if ((rank.get(id) ?? 0) >= score) continue;
    rank.set(id, score);
    out.set(id, score >= 2 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1'));
  }
  return out;
}

function axes(fvar: Buffer | undefined): string[] {
  if (!fvar) return [];
  const first = fvar.readUInt16BE(4);
  const size = fvar.readUInt16BE(10);
  const fixed = (at: number) => Math.round((fvar.readInt32BE(at) / 65536) * 1000) / 1000;
  return Array.from({ length: fvar.readUInt16BE(8) }, (_, i) => {
    const at = first + i * size;
    return `${fvar.toString('latin1', at, at + 4)} ${fixed(at + 4)}..${fixed(at + 12)}`;
  });
}

export function fontFacts(bytes: Uint8Array): FontFacts {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = b.toString('latin1', 0, 4);
  if (signature !== 'wOF2') throw new Error(`font: not WOFF2 (signature ${JSON.stringify(signature)})`);
  const tables = woff2Tables(b);
  const name = tables.get('name');
  const maxp = tables.get('maxp');
  const head = tables.get('head');
  const os2 = tables.get('OS/2');
  if (!name || !maxp || !head || !os2) throw new Error('font: no name/maxp/head/OS/2 table');
  const macItalic = (head.readUInt16BE(44) & 0b10) !== 0;
  const selectionItalic = (os2.readUInt16BE(62) & 0b1) !== 0;
  const n = names(name);
  return {
    family: n.get(16) ?? n.get(1) ?? '',
    version: n.get(5) ?? '',
    axes: axes(tables.get('fvar')),
    glyphs: maxp.readUInt16BE(4),
    italic: macItalic === selectionItalic ? macItalic : null,
  };
}
