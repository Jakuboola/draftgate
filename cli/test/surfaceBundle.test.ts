/**
 * A window bundle older than its source is rebuilt before the review, or refused.
 *
 * Real subprocesses throughout: the real `buildSurface.ts` running the real Vite over a fixture
 * checkout (a temp directory shaped like this repo, `node_modules` linked to ours), reached from
 * the real `windowSurface` through the real spawn, with `fakeSurfaceApp.ts` as the window. One test
 * builds the real window into a temp directory: the only way to ask what the real build reads.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profiles, render, toEditorDoc } from '../../core/src/index';
import {
  bundleState,
  hasToolchain,
  readStamp,
  sha256,
  stampOf,
  surfaceLayout,
  type SurfaceLayout,
} from '../src/surfaces/bundleStamp';
import { escapeRegex } from '../../core/src/adf/index';
import { NOTICES_FILE, packageDirOf } from '../src/surfaces/thirdPartyNotices';
import { windowSurface, type BundleOptions } from '../src/surfaces/window';
import type { Decision, ReviewRequest } from '../src/types';
import { REMEDY } from '../../core/src/remedies';

const REPO = join(import.meta.dir, '..', '..');
const BUILD = join(REPO, 'cli', 'src', 'buildSurface.ts');
const FAKE_APP = join(import.meta.dir, 'fixtures', 'fakeSurfaceApp.ts');

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `draftgate-bundle-${tag}-`));
  made.push(dir);
  return dir;
};

/**
 * A checkout with a toolchain: a Vite config, a two-module page, a lockfile, a `docs/NOTICE`, and
 * `node_modules` linked to this repo's so `vite` resolves. Every build appends a line to
 * `builds.log`, which is how the tests count builds rather than infer them. `buildStart` is a hook
 * for the variant that must fail or hang; `unlicensed` makes the page import a package that ships
 * no licence text.
 */
function devCheckout(
  opts: {
    buildStart?: string;
    generateBundle?: string;
    importMissing?: boolean;
    noNotice?: boolean;
    unlicensed?: boolean;
  } = {}
): SurfaceLayout {
  const root = tempDir('dev');
  const surface = join(root, 'surface');
  mkdirSync(surface);
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'bun.lock'), '{ "lockfileVersion": 1 }\n');
  if (!opts.noNotice) {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'NOTICE'), 'fixture notice\n');
  }
  writeFileSync(join(surface, 'tsconfig.json'), '{ "compilerOptions": { "target": "ESNext" } }\n');
  writeFileSync(
    join(surface, 'vite.config.mts'),
    `import { appendFileSync } from 'node:fs';
export default {
  root: import.meta.dirname,
  logLevel: 'silent',
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [{
    name: 'count',
    async buildStart() {
      appendFileSync(import.meta.dirname + '/../builds.log', 'build\\n');
      ${opts.buildStart ?? ''}
    },
    generateBundle() {
      ${opts.generateBundle ?? ''}
    },
  }],
};
`
  );
  writeFileSync(
    join(surface, 'index.html'),
    '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n'
  );
  const imports = [
    `import { v } from './${opts.importMissing ? 'nowhere' : 'dep'}.js';`,
    ...(opts.unlicensed ? ["import { u } from 'unlicensed';"] : []),
  ];
  writeFileSync(join(surface, 'main.js'), `${imports.join('\n')}\nconsole.log(v);\n`);
  writeFileSync(join(surface, 'dep.js'), "export const v = 'one';\n");
  if (opts.unlicensed) {
    // Found before the linked `node_modules`, being nearer the importer.
    const pkg = join(surface, 'node_modules', 'unlicensed');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{ "name": "unlicensed", "version": "1.0.0", "main": "index.js" }\n');
    writeFileSync(join(pkg, 'index.js'), "export const u = 'u';\nconsole.log(u);\n");
  }
  return surfaceLayout(root);
}

const builds = (layout: SurfaceLayout) => {
  try {
    return readFileSync(join(layout.root, 'builds.log'), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

function build(layout: SurfaceLayout, ...flags: string[]) {
  return spawnSync(process.execPath, [BUILD, '--root', layout.root, ...flags], { encoding: 'utf8' });
}

function requestFor(timeoutMs = 20_000): ReviewRequest {
  const rendered = render('Hello.', 'slack');
  return {
    toolName: 'slack_send_message',
    context: { channel_id: 'C1' },
    fields: [{ field: profiles.slack.bodyField, kind: 'markdown', value: rendered.canonical }],
    render: rendered,
    preview: (b) => render(b, 'slack'),
    doc: (b) => toEditorDoc(b),
    timeoutMs,
  };
}

function surfaceOver(layout: SurfaceLayout, extra: Partial<BundleOptions> = {}, mode = 'approve-unedited') {
  process.env.DRAFTGATE_TEST_MODE = mode;
  process.env.DRAFTGATE_TEST_DIST = layout.distDir;
  const lines: string[] = [];
  const surface = windowSurface(async () => ({ bin: process.execPath }), {
    appDir: FAKE_APP,
    bundle: { layout, log: (l: string) => lines.push(l), ...extra },
    // Never the reviewer's own theme file.
    theme: { read: () => ({}), keep: () => null },
  });
  return { surface, lines };
}

/** The check a dev checkout makes: one that can rebuild its own window. */
const DEV = true;

/** A `buildStart` that blocks for real: rolldown cancels a hook whose promise merely never settles. */
const blockFor = (ms: number) =>
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;

/** The built script's text: the fixture page has one chunk. */
function builtJs(layout: SurfaceLayout): string {
  const assets = join(layout.distDir, 'assets');
  const js = readdirSync(assets).find((f) => f.endsWith('.js'))!;
  return readFileSync(join(assets, js), 'utf8');
}

const reasonOf = (d: Decision) => ('reason' in d && typeof d.reason === 'string' ? d.reason : '');

describe('the stamp', () => {
  test('is one value over the whole set, independent of order, moved by any hash or any rename', () => {
    const base = { 'a.ts': '1', 'b.ts': '2' };
    expect(stampOf({ 'b.ts': '2', 'a.ts': '1' })).toBe(stampOf(base));
    expect(stampOf({ 'a.ts': '1', 'b.ts': '3' })).not.toBe(stampOf(base));
    expect(stampOf({ 'a.ts': '1', 'c.ts': '2' })).not.toBe(stampOf(base));
    expect(stampOf({ 'a.ts': '1' })).not.toBe(stampOf(base));
  });

  test('a build records what it read, and changing ANY first-party input makes it stale', () => {
    const layout = devCheckout();
    expect(build(layout).status).toBe(0);
    const stamp = readStamp(layout.stampFile)!;
    const keys = Object.keys(stamp.inputs);
    for (const k of [
      'surface/index.html',
      'surface/main.js',
      'surface/dep.js',
      'surface/vite.config.mts',
      'surface/tsconfig.json',
      'bun.lock',
      // Read by the notices, which open with it.
      'docs/NOTICE',
    ]) {
      expect(keys, k).toContain(k);
    }
    expect(keys).toContain(BUILD);
    // And every module the build script imports: a change to one is a stale bundle.
    for (const module of ['surfaces/thirdPartyNotices.ts', 'surfaces/bundleStamp.ts', 'json.ts']) {
      expect(keys).toContain(join(REPO, 'cli', 'src', module));
    }
    expect(bundleState(layout, DEV)).toEqual({ state: 'fresh' });

    // Every input the fixture owns, one at a time: an input read but not compared fails here.
    for (const key of keys.filter((k) => !k.startsWith('/') && !k.startsWith('node_modules'))) {
      const file = join(layout.root, key);
      const original = readFileSync(file);
      writeFileSync(file, Buffer.concat([original, Buffer.from('\n')]));
      const state = bundleState(layout, DEV);
      expect(state.state, key).toBe('stale');
      expect('why' in state ? state.why : '', key).toContain(key);
      writeFileSync(file, original);
    }
    expect(bundleState(layout, DEV)).toEqual({ state: 'fresh' });
  });

  test('a tsconfig\'s `extends` base is an input too', () => {
    const layout = devCheckout();
    const surface = join(layout.root, 'surface');
    writeFileSync(join(layout.root, 'tsconfig.base.json'), '{ "compilerOptions": { "strict": true } }\n');
    writeFileSync(join(surface, 'tsconfig.json'), '{\n  // JSONC\n  "extends": "../tsconfig.base.json"\n}\n');
    expect(build(layout).status).toBe(0);
    expect(Object.keys(readStamp(layout.stampFile)!.inputs)).toContain('tsconfig.base.json');
    writeFileSync(join(layout.root, 'tsconfig.base.json'), '{ "compilerOptions": { "strict": false } }\n');
    expect(bundleState(layout, DEV).state).toBe('stale');
  });

  test('an input that disappears is stale, and so is a bundle with no stamp', () => {
    const layout = devCheckout();
    expect(build(layout).status).toBe(0);
    rmSync(join(layout.root, 'surface', 'dep.js'));
    expect(bundleState(layout, DEV).state).toBe('stale');
    writeFileSync(join(layout.root, 'surface', 'dep.js'), "export const v = 'one';\n");
    rmSync(layout.stampFile);
    expect(bundleState(layout, DEV)).toEqual({
      state: 'stale',
      why: 'it carries no build stamp',
    });
  });

  test('`--if-stale` does nothing to a fresh bundle, and a plain build always builds', () => {
    const layout = devCheckout();
    expect(build(layout, '--if-stale').status).toBe(0);
    expect(build(layout, '--if-stale').status).toBe(0);
    expect(builds(layout)).toBe(1);
    expect(build(layout).status).toBe(0);
    expect(builds(layout)).toBe(2);
  });

  test.each([
    ['a bundled package that ships no licence text', { unlicensed: true }, 'unlicensed (surface/node_modules/unlicensed)'],
    ['a checkout with no docs/NOTICE', { noNotice: true }, 'has no docs/NOTICE'],
  ])('%s fails the build, says why, and leaves no stamp', (_name, opts, why) => {
    const layout = devCheckout(opts);
    const run = build(layout);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(why);
    expect(existsSync(layout.stampFile)).toBe(false);
  });

  test('a build that fails leaves no stamp behind, so it cannot read as fresh', () => {
    const layout = devCheckout();
    expect(build(layout).status).toBe(0);
    writeFileSync(join(layout.root, 'surface', 'main.js'), "import { v } from './nowhere.js';\n");
    const run = build(layout);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(existsSync(layout.stampFile)).toBe(false);
  });
});

/**
 * The derived input list, against the real window build: every category of input (the page, the
 * renderer's source, `core`, the wire contract, the config, the lockfile, the build script,
 * `node_modules`, the CSS and the fonts, which arrive as assets). Dropping any one source of the
 * list in `buildSurface.ts` (the `load` hook, the assets, the config, the lockfile, the script)
 * fails a line here. And every non-test file under `surface/src/` by name.
 */
let real: { out: string; keys: string[] } | undefined;
/** The real window, built once into a temp directory for every test that reads it. */
function realBuild(): { out: string; keys: string[] } {
  if (real) return real;
  const out = tempDir('real');
  const run = spawnSync(process.execPath, [BUILD, '--out-dir', out], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  real = { out, keys: Object.keys(readStamp(surfaceLayout(REPO, out).stampFile)!.inputs) };
  return real;
}

test('the real window build records every kind of input it reads', () => {
  const { keys } = realBuild();

  for (const k of [
    'surface/index.html',
    'surface/src/main.tsx',
    'surface/contract.json',
    'surface/vite.config.mts',
    'bun.lock',
    'cli/src/buildSurface.ts',
    'cli/src/surfaces/thirdPartyNotices.ts',
    'cli/src/json.ts',
    'core/src/render.ts',
    // Read by the transforms, reached by no module graph: found by the nearest-config walk.
    'tsconfig.json',
    'surface/tsconfig.json',
    'core/tsconfig.json',
  ]) {
    expect(keys, k).toContain(k);
  }
  expect(keys.some((k) => /^surface\/src\/.*\.css$/.test(k)), 'a stylesheet').toBe(true);
  expect(keys.some((k) => k.startsWith('node_modules/react-dom/')), 'a dependency').toBe(true);
  expect(keys.some((k) => /^node_modules\/.*\.woff2$/.test(k)), 'a font').toBe(true);
  // And no `.woff` was READ: this is the one test that builds, so it is where "the bundle is woff2
  // only" holds without a `surface/dist` lying around (see `surface/harness/fontAssets.test.ts`).
  expect(keys.filter((k) => k.endsWith('.woff'))).toEqual([]);

  const renderer = (dir: string): string[] =>
    readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? renderer(`${dir}/${e.name}`) : [`${dir}/${e.name}`]
    );
  for (const file of renderer('surface/src').filter((f) => !/\.test\.tsx?$/.test(f))) {
    expect(keys, file).toContain(file);
  }
}, 30_000);

/**
 * The notices the real build ships beside its bundle. The package list comes from the stamp, which
 * the test above holds to what the build read; what is asserted here is the file PRODUCED from it.
 */
test('the real window build credits every package it bundles, in the package\'s own words', () => {
  const { out, keys } = realBuild();
  const notices = readFileSync(join(out, NOTICES_FILE), 'utf8');
  // The repository's own attributions open it, verbatim.
  expect(notices).toContain(readFileSync(join(REPO, 'docs', 'NOTICE'), 'utf8').trim());

  const dirs = [...new Set(keys.map(packageDirOf).filter((d): d is string => d !== null))];
  // The run looked somewhere real: the bundle is React, TipTap, ProseMirror and the fonts.
  expect(dirs.length).toBeGreaterThan(40);
  for (const dir of dirs) {
    const { name, version } = JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8'));
    expect(notices, dir).toContain(`\n  ${name} ${version}, `);
  }
  // Named here rather than derived, so a package the derivation itself lost still fails. `vite`
  // and `rolldown` reach the bundle as VIRTUAL modules (the preload helper, the runtime), which
  // no input key names.
  for (const name of [
    'react', 'react-dom', 'scheduler', '@tiptap/core', '@tiptap/pm', 'prosemirror-view',
    'highlight.js', 'lowlight', 'lucide-react', 'lato-font', '@fontsource-variable/inter', 'vite',
    'rolldown',
  ]) {
    expect(notices, name).toMatch(new RegExp(`\\n  ${escapeRegex(name)} \\d`));
  }
  // Licences that each require their notice kept, read here from the package rather than the
  // producer: MIT (react-dom's banner is gone from the minified output), BSD-3-Clause and ISC.
  for (const file of ['react-dom/LICENSE', 'highlight.js/LICENSE', 'lucide-react/LICENSE']) {
    expect(notices, file).toContain(readFileSync(join(REPO, 'node_modules', file), 'utf8').trim());
    expect(keys, file).toContain(`node_modules/${file}`);
  }
  // lato-font ships no licence file; its README states both licences.
  expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1');
  expect(notices).toContain('Copyright (c) 2014 Slava Fomin II');
});

test('each font package\'s licence lies beside its fonts, and no code package\'s does', () => {
  const { out } = realBuild();
  const assets = readdirSync(join(out, 'assets'));
  const licences = assets.filter((f) => f.endsWith('.LICENSE.txt')).sort();
  expect(licences).toEqual([
    'fontsource-variable-inter.LICENSE.txt',
    'fontsource-variable-roboto-mono.LICENSE.txt',
    'lato-font.LICENSE.txt',
  ]);
  const inter = readFileSync(join(out, 'assets', 'fontsource-variable-inter.LICENSE.txt'), 'utf8');
  expect(inter).toContain(
    readFileSync(join(REPO, 'node_modules', '@fontsource-variable', 'inter', 'LICENSE'), 'utf8').trim()
  );
  expect(readFileSync(join(out, 'assets', 'lato-font.LICENSE.txt'), 'utf8')).toContain(
    'SIL OPEN FONT LICENSE Version 1.1'
  );
});

describe('before the window opens', () => {
  test('a stale bundle is rebuilt first, and says so once on the log line', async () => {
    const layout = devCheckout();
    const { surface, lines } = surfaceOver(layout, {}, 'approve-if-built');
    const decision = await surface.review(requestFor());
    expect(decision.action).toBe('approve');
    expect(builds(layout)).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('rebuilding');
    expect(bundleState(layout, DEV)).toEqual({ state: 'fresh' });
  }, 20_000);

  test('a fresh bundle is not rebuilt', async () => {
    const layout = devCheckout();
    expect(build(layout).status).toBe(0);
    const { surface, lines } = surfaceOver(layout);
    expect((await surface.review(requestFor())).action).toBe('approve');
    expect(builds(layout)).toBe(1);
    expect(lines).toEqual([]);
  }, 20_000);

  test('a source edited after the build is rebuilt, not reviewed on the old bundle', async () => {
    const layout = devCheckout();
    expect(build(layout).status).toBe(0);
    writeFileSync(join(layout.root, 'surface', 'dep.js'), "export const v = 'two';\n");
    const { surface, lines } = surfaceOver(layout, {}, 'approve-if-built');
    expect((await surface.review(requestFor())).action).toBe('approve');
    expect(builds(layout)).toBe(2);
    expect(lines[0]).toContain('surface/dep.js');
    expect(builtJs(layout)).toContain('two');
  }, 20_000);

  test('a failed rebuild is unavailable, naming `bun install`, and the old window never opens', async () => {
    const layout = devCheckout({ importMissing: true });
    // `approve-unedited`: had the window been spawned at all, this would be an approval.
    const { surface } = surfaceOver(layout);
    const decision = await surface.review(requestFor());
    expect(decision.action).toBe('unavailable');
    expect(reasonOf(decision)).toContain('bun install');
    expect(reasonOf(decision)).toContain('nowhere.js');
  }, 20_000);

  test('a rebuild that outruns the deadline is killed and unavailable, and the lock goes with it', async () => {
    const layout = devCheckout({ buildStart: blockFor(60_000) });
    const { surface } = surfaceOver(layout);
    const started = Date.now();
    const decision = await surface.review(requestFor(2_000));
    const elapsed = Date.now() - started;
    expect(decision.action).toBe('unavailable');
    expect(reasonOf(decision)).toContain('deadline');
    expect(elapsed).toBeLessThan(4_000);
    // The killed builder held the lock. A kernel lock dies with it; a pid file would still claim a
    // live builder, and the next build would wait on nobody.
    const next = spawnSync(process.execPath, [BUILD, '--root', layout.root], {
      encoding: 'utf8',
      timeout: 1_500,
      // SIGKILL: a thread parked in `Atomics.wait` sits out a SIGTERM for the whole minute.
      killSignal: 'SIGKILL',
    });
    // It hangs in `buildStart` again, so reaching the build (a second `builds.log` line) proves the
    // lock was free; the timeout is expected.
    expect(next.stderr).not.toContain('waiting for another build');
    expect(builds(layout)).toBe(2);
    expect(existsSync(layout.stampFile)).toBe(false);
  }, 20_000);

  test('a rebuild that leaves too little of the deadline is unavailable, not a human timeout', async () => {
    // The build finishes (~1.5s of a 3s deadline), so the window could be spawned -- and killed a
    // moment later, reporting `timeout`: "a person ignored this", about a window nobody saw.
    const layout = devCheckout({ buildStart: blockFor(1_500) });
    const { surface } = surfaceOver(layout);
    const decision = await surface.review(requestFor(3_000));
    expect(decision.action).toBe('unavailable');
    expect(reasonOf(decision)).toContain('too little of the review deadline');
    expect(bundleState(layout, DEV)).toEqual({ state: 'fresh' });
  }, 20_000);

  test('a source saved DURING the rebuild is built again, not refused', async () => {
    // After Vite has loaded `dep.js`, and on the first build only: the stamp records the version
    // that went into the bundle, the after-check sees the file changed, and one more build runs.
    const layout = devCheckout({
      generateBundle: `
        const { existsSync, writeFileSync } = require('node:fs');
        const flag = import.meta.dirname + '/../saved-once';
        if (!existsSync(flag)) {
          writeFileSync(flag, '');
          writeFileSync(import.meta.dirname + '/dep.js', "export const v = 'saved';\\n");
        }`,
    });
    const { surface } = surfaceOver(layout, {}, 'approve-if-built');
    expect((await surface.review(requestFor())).action).toBe('approve');
    expect(builds(layout)).toBe(2);
  }, 20_000);

  test('the environment cannot change the bundle behind the stamp: NODE_ENV is pinned', () => {
    const layout = devCheckout();
    writeFileSync(join(layout.root, 'surface', 'dep.js'), 'export const v = process.env.NODE_ENV;\n');
    const run = spawnSync(process.execPath, [BUILD, '--root', layout.root], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
    });
    expect(run.status, run.stderr).toBe(0);
    const out = builtJs(layout);
    expect(out).toContain('production');
    expect(out).not.toContain('development');
  });

  test('two concurrent reviews of a stale bundle build ONCE, and both open a whole window', async () => {
    const layout = devCheckout();
    const a = surfaceOver(layout, {}, 'approve-if-built');
    const b = surfaceOver(layout, {}, 'approve-if-built');
    const [da, db] = await Promise.all([a.surface.review(requestFor()), b.surface.review(requestFor())]);
    expect(da).toEqual({ action: 'approve' });
    expect(db).toEqual({ action: 'approve' });
    expect(builds(layout)).toBe(1);
  }, 30_000);
});

/**
 * An install with no toolchain: a release's tree, whose `surface/dist` and its stamp were committed
 * by the release, with no `node_modules` and, in the plugin tree, no `bun.lock`. It is checked
 * against the inputs it HAS -- the window's sources, and `bun.lock` where there is one -- and never
 * rebuilt. A mismatch is `unavailable`, never "used as is".
 */
describe('with no toolchain', () => {
  const SOURCE = 'surface/src/main.tsx';
  const PACKAGE = 'node_modules/vite/dist/node/index.js';

  /**
   * A release-shaped install. `source` and `lock` are what this checkout holds (`lock: null`, none,
   * as in the plugin tree); the stamp records what the release built from, which is the same unless
   * `built` says otherwise, plus a package this checkout does not have.
   */
  function releaseInstall(opts: {
    source?: string | null;
    lock?: string | null;
    built?: { source?: string; lock?: string };
    stamp?: 'none' | 'no-lock' | 'toolchain-only' | 'tampered' | 'outside';
  } = {}): SurfaceLayout {
    const layout = surfaceLayout(tempDir('release'));
    const source = opts.source === undefined ? 'export {};\n' : opts.source;
    const lock = opts.lock === undefined ? 'lockfile v1\n' : opts.lock;
    if (source !== null) {
      mkdirSync(join(layout.root, 'surface', 'src'), { recursive: true });
      writeFileSync(join(layout.root, SOURCE), source);
    }
    if (lock !== null) writeFileSync(join(layout.root, 'bun.lock'), lock);
    mkdirSync(layout.distDir, { recursive: true });
    writeFileSync(layout.builtRenderer, '<!doctype html>\n');
    const inputs: Record<string, string> = {
      ...(opts.stamp === 'toolchain-only' ? {} : { [SOURCE]: sha256(opts.built?.source ?? source ?? 'export {};\n') }),
      [PACKAGE]: sha256('a package this checkout does not have'),
      ...(opts.stamp === 'no-lock' ? {} : { 'bun.lock': sha256(opts.built?.lock ?? lock ?? 'lockfile v1\n') }),
      // An input the release builder found outside its checkout, which `inputKey` keeps absolute.
      ...(opts.stamp === 'outside' ? { '/Users/builder/shared/tsconfig.json': sha256('{}') } : {}),
    };
    if (opts.stamp !== 'none') {
      const stamp = opts.stamp === 'tampered' ? 'f'.repeat(64) : stampOf(inputs);
      writeFileSync(layout.stampFile, JSON.stringify({ version: 1, stamp, inputs }));
    }
    return layout;
  }

  /** Everything under the install's root, so "nothing was written" is a comparison, not a guess. */
  const tree = (root: string): string[] =>
    readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();

  test('the fixture really has no toolchain', () => {
    expect(hasToolchain(releaseInstall())).toBe(false);
  });

  test.each([
    ['exactly this checkout', {}],
    // The plugin tree: Claude Code would install every package a lockfile there names.
    ['this checkout, which has no lockfile', { lock: null }],
  ])('a window built from %s is used, and nothing is written or built', async (_name, opts) => {
    const layout = releaseInstall(opts);
    const before = tree(layout.root);
    const { surface, lines } = surfaceOver(layout);
    expect((await surface.review(requestFor())).action).toBe('approve');
    expect(lines).toEqual([]);
    expect(tree(layout.root)).toEqual(before);
  });

  test.each([
    ['a source that differs', { source: 'export const moved = 1;\n', built: { source: 'export {};\n' } }, SOURCE],
    ['a source that is missing', { source: null }, SOURCE],
    // The packages are pinned by the lockfile, so a lockfile that moved is packages that moved.
    ['a lockfile that differs', { lock: 'lockfile v2\n', built: { lock: 'lockfile v1\n' } }, 'bun.lock'],
    ['a stamp that records no lockfile this checkout has', { stamp: 'no-lock' as const }, 'records no bun.lock'],
    ['a stamp that records only the toolchain', { stamp: 'toolchain-only' as const }, 'records no source'],
    ['a stamp that does not add up', { stamp: 'tampered' as const }, 'does not add up'],
    ['no stamp at all', { stamp: 'none' as const }, 'carries no build stamp'],
    ['a stamp naming an input outside the checkout', { stamp: 'outside' as const }, 'is outside the checkout'],
  ])('%s is unavailable, says to install the plugin, names why, and builds nothing', async (_name, opts, why) => {
    const layout = releaseInstall(opts);
    const before = tree(layout.root);
    const { surface, lines } = surfaceOver(layout);
    const decision = await surface.review(requestFor());
    expect(decision.action).toBe('unavailable');
    expect(reasonOf(decision)).toContain(`this checkout cannot rebuild it. Run ${REMEDY.installPlugin}.`);
    expect(reasonOf(decision)).toContain(why);
    expect(reasonOf(decision)).not.toContain('build:surface');
    expect(lines).toEqual([]);
    // Nothing written -- not even the lock file, which only a build takes.
    expect(tree(layout.root)).toEqual(before);
  });

  test('no bundle at all is unavailable, and nothing is attempted', async () => {
    const layout = surfaceLayout(tempDir('empty'));
    const { surface } = surfaceOver(layout);
    const decision = await surface.review(requestFor());
    expect(decision.action).toBe('unavailable');
    expect(readdirSync(layout.root)).toEqual([]);
  });
});
