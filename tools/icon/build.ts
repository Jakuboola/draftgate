/**
 * `bun run icon:build`: render `surface/icon/draftgate.svg` into `surface/icon/draftgate.icns`, and
 * `draftgate-small.svg` into its 16 and 32 px slots, where the full drawing's pause bars blur into
 * one block. A dev tool: not a dependency, not in the plugin tree. macOS only. The SVGs are the
 * source and the `.icns` is committed, because only this script makes it and only somebody changing
 * the icon runs it.
 *
 * `render.cjs` draws every iconset size under Electron's own binary, onto a canvas, so each keeps
 * its transparency (Quick Look draws onto opaque white). `iconutil` packs the set.
 * `draftgate.icns.json` records each SVG's hash beside it, and `cli/test/icon.test.ts` fails when an
 * SVG no longer matches, so an edited SVG cannot ship with the old icon.
 *
 * `cli/src/reviewHost.ts` copies the `.icns` into both host bundles, and the `.icns` is one of the
 * host's inputs, so a new icon makes the next review build the host again.
 *
 * The Electron is the rulers', installed in `tools/electron/` on first use rather than by the root
 * install, and on no review's path. It is Electron because it reproduces the committed `.icns` byte
 * for byte, and the WebKit host's canvas does not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { scratchDir } from '../../cli/src/scratch';
import { sha256 } from '../../cli/src/surfaces/bundleStamp';
import { electronBinary, electronEnv } from '../electron/run';

const ROOT = join(import.meta.dir, '..', '..');
const DIR = join(ROOT, 'surface', 'icon');
// The `.icns` both host bundles carry.
const ICNS = join(DIR, 'draftgate.icns');
const SOURCE = `${ICNS}.json`;

/**
 * Apple's iconset: every point size at 1x and 2x, under the names `iconutil` requires. Derived
 * rather than typed out, so a name cannot be paired with the wrong size.
 */
const ICONSET: readonly (readonly [string, number])[] = [16, 32, 128, 256, 512].flatMap((pt) => [
  [`icon_${pt}x${pt}.png`, pt] as const,
  [`icon_${pt}x${pt}@2x.png`, pt * 2] as const,
]);

// The largest pixel size `draftgate-small.svg` draws.
const SMALL_MAX = 32;
// Each drawing and the iconset entries it renders.
const DRAWINGS = [
  [join(DIR, 'draftgate.svg'), ICONSET.filter(([, px]) => px > SMALL_MAX)],
  [join(DIR, 'draftgate-small.svg'), ICONSET.filter(([, px]) => px <= SMALL_MAX)],
] as const;

if (process.platform !== 'darwin') {
  console.error('icon:build needs macOS (iconutil).');
  process.exit(1);
}

// `scratchDir`, not a bare `mkdtemp`: a Ctrl-C during the render must still remove it.
const work = scratchDir('draftgate-icon-');
try {
  const set = join(work.dir, 'draftgate.iconset');
  mkdirSync(set);
  const hash = () => Object.fromEntries(DRAWINGS.map(([f]) => [basename(f), sha256(readFileSync(f))]));
  // Hashed before the render and checked after it, so an SVG saved mid-build cannot record a hash
  // the .icns was not drawn from.
  const hashes = hash();
  for (const [svg, sizes] of DRAWINGS) {
    execFileSync(
      electronBinary(),
      [join(import.meta.dir, 'render.cjs'), svg, set, JSON.stringify(sizes)],
      { stdio: 'inherit', timeout: 60_000, env: electronEnv() }
    );
  }
  for (const [name] of ICONSET) {
    if (!existsSync(join(set, name))) throw new Error(`the renderer produced no ${name}`);
  }
  if (JSON.stringify(hash()) !== JSON.stringify(hashes)) throw new Error('an SVG changed during the render: run it again');
  execFileSync('iconutil', ['-c', 'icns', set, '-o', ICNS], { stdio: 'inherit' });
  writeFileSync(SOURCE, JSON.stringify(hashes, null, 2) + '\n');
  console.log(`icon:build: wrote ${ICNS}`);
} finally {
  work.release();
}
