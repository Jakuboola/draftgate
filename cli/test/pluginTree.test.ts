/**
 * The plugin tree (`pluginTree.ts`) and its local assembly (`pluginDev.ts`).
 *
 * The mapping is tested on path lists; the assembly on a real git checkout whose window is stamped
 * the way `bundleState` reads one, asserted on what it wrote: the files, their modes, the
 * marketplace beside them, and the copy's own stamp check with no toolchain. What `release` makes of
 * the same mapping is asserted on a `stable` clone in `release.test.ts`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assemblePlugin, parseOut } from '../src/pluginDev';
import { isRuntimeFile, localMarketplace, pluginTree, pluginVersion } from '../src/pluginTree';
import { bundleState, hashFile, sha256, stampOf, surfaceLayout, type BuildStamp } from '../src/surfaces/bundleStamp';
import { fixtureGit } from './releaseClone';

const ROOT = join(import.meta.dir, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'draftgate-plugin-tree-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const stampOver = (inputs: Record<string, string>): BuildStamp => ({ version: 1, stamp: stampOf(inputs), inputs });

describe('which files are the runtime', () => {
  test.each([
    ['cli/src/main.ts', true],
    ['cli/src/surfaces/window.ts', true],
    ['adapters/hook/src/main.ts', true],
    ['core/src/render.ts', true],
    ['surface/contract.json', true],
    ['surface/rendererBridge.cjs', true],
    ['surface/host/draftgate.m', true],
    ['surface/host/harness.m', true],
    ['surface/icon/draftgate.icns', true],
    ['package.json', true],
    ['LICENSE', true],
    ['cli/test/review.test.ts', false],
    ['adapters/hook/test/hook.test.ts', false],
    ['core/test/spec/baseline.ts', false],
    ['surface/harness/probe.ts', false],
    ['surface/window.test.tsx', false],
    ['surface/dist/index.html', false],
    ['bun.lock', false],
    ['tools/electron/run.ts', false],
    ['tools/jira-projects/generate.mjs', true],
    ['tools/jira-projects/from-mcp.mjs', true],
    ['tools/github-repos/generate.mjs', true],
    ['tools/jira-projects/README.md', false],
    ['docs/NOTICE', false],
    ['install.sh', false],
  ])('%s: %p', (path, runtime) => {
    expect(isRuntimeFile(path)).toBe(runtime);
  });
});

describe('the tree', () => {
  const FILES = [
    'plugin/.claude-plugin/plugin.json',
    'plugin/bin/draftgate',
    'cli/src/main.ts',
    'cli/test/main.test.ts',
    'docs/NOTICE',
    'bun.lock',
    'surface/dist/index.html',
    'surface/dist/build-stamp.json',
  ];
  const STAMP = stampOver({
    'docs/NOTICE': sha256('n'),
    'bun.lock': sha256('l'),
    'node_modules/react/index.js': sha256('r'),
  });

  test('the plugin files as they are, the rest under plugin/, the toolchain and tests left out', () => {
    expect(pluginTree(FILES, STAMP)).toEqual(
      new Map([
        ['plugin/.claude-plugin/plugin.json', 'plugin/.claude-plugin/plugin.json'],
        ['plugin/bin/draftgate', 'plugin/bin/draftgate'],
        ['plugin/cli/src/main.ts', 'cli/src/main.ts'],
        // Not runtime by its path: there because the window's stamp records it.
        ['plugin/docs/NOTICE', 'docs/NOTICE'],
        ['plugin/surface/dist/build-stamp.json', 'surface/dist/build-stamp.json'],
        ['plugin/surface/dist/index.html', 'surface/dist/index.html'],
      ])
    );
  });

  test.each([
    ['no plugin manifest', FILES.filter((f) => !f.endsWith('plugin.json')), STAMP, 'there is no plugin/.claude-plugin/plugin.json'],
    ['a window source the tree lacks', FILES.filter((f) => f !== 'docs/NOTICE'), STAMP, 'built from docs/NOTICE, which this tree does not hold'],
    ['a window source outside the checkout', FILES, stampOver({ '/elsewhere/tsconfig.json': sha256('t') }), 'built from /elsewhere/tsconfig.json'],
    ['no window', FILES.filter((f) => !f.startsWith('surface/dist/')), STAMP, 'there is no built window in surface/dist'],
    ['a plugin file where the runtime goes', [...FILES, 'plugin/cli/src/main.ts'], STAMP, 'plugin/cli/src/main.ts is one of the plugin'],
  ])('%s is refused', (_name, files, stamp, says) => {
    const tree = pluginTree(files, stamp);
    expect(tree).toEqual({ error: expect.stringContaining(says) });
  });
});

describe('the version', () => {
  test.each([
    ['{ "version": "0.2.0" }', { tag: 'v0.2.0' }],
    ['{ "version": "10.0.1" }', { tag: 'v10.0.1' }],
    ['{ "version": "0.2.0-rc1" }', { error: expect.stringContaining('"0.2.0-rc1" is not X.Y.Z') }],
    ['{ "version": "01.2.3" }', { error: expect.stringContaining('is not X.Y.Z') }],
    ['{ "version": 2 }', { error: expect.stringContaining('has no "version"') }],
    ['{}', { error: expect.stringContaining('has no "version"') }],
    ['null', { error: expect.stringContaining('has no "version"') }],
    ['{', { error: expect.stringContaining('is not JSON') }],
  ])('%s', (text, want) => {
    expect(pluginVersion(text)).toEqual(want);
  });
});

describe('the marketplace', () => {
  const REPO = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));

  test("the repository's fetches the plugin from stable's plugin/", () => {
    // A marketplace added with no ref clones the default branch, main, whose plugin/ holds only the
    // plugin's own files. This source is what puts every install on stable's assembled tree. Its URL
    // is the full HTTPS one: Claude Code clones an `owner/repo` or `git@github.com:` git-subdir source
    // over SSH with no HTTPS retry, so `install` fails for everyone whose SSH key GitHub does not know.
    expect(REPO.plugins).toEqual([
      expect.objectContaining({
        name: 'draftgate',
        source: { source: 'git-subdir', url: 'https://github.com/Jakuboola/draftgate.git', path: 'plugin', ref: 'stable' },
      }),
    ]);
  });

  test('a local one is the same with the source at ./plugin', () => {
    expect(localMarketplace(REPO)).toEqual({ ...REPO, plugins: [{ ...REPO.plugins[0], source: './plugin' }] });
    expect(() => localMarketplace({ name: 'x' })).toThrow('has no plugins list');
  });
});

describe('build:plugin', () => {
  /** A checkout with a plugin, a runtime file, a test, a lockfile and a window stamped from its source. */
  function checkout() {
    const dir = mkdtempSync(join(scratch, 'c-'));
    const { git } = fixtureGit(join(dir, 'home'));
    const root = join(dir, 'work');
    const write = (path: string, text: string, mode = 0o644) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text, { mode });
    };
    git(dir, 'init', '--quiet', '-b', 'main', root);
    write('.gitignore', 'surface/dist/\ndist/\n');
    write('.claude-plugin/marketplace.json', readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    write('plugin/.claude-plugin/plugin.json', '{ "name": "draftgate", "version": "0.2.0" }\n');
    write('plugin/bin/draftgate', '#!/bin/sh\n', 0o755);
    write('cli/src/main.ts', 'export {};\n');
    write('cli/test/main.test.ts', 'export {};\n');
    write('bun.lock', '{}\n');
    write('surface/src/App.tsx', 'export const App = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'first');
    // Not committed yet: a contributor's edit in progress is in the tree.
    write('cli/src/new.ts', 'export {};\n');
    const layout = surfaceLayout(root);
    const stampWindow = () => {
      write('surface/dist/index.html', '<!doctype html>\n');
      const inputs = {
        'surface/src/App.tsx': hashFile(join(root, 'surface/src/App.tsx'))!,
        'bun.lock': hashFile(join(root, 'bun.lock'))!,
      };
      writeFileSync(layout.stampFile, JSON.stringify({ version: 1, stamp: stampOf(inputs), inputs }));
    };
    stampWindow();
    return { root, out: join(root, 'dist', 'marketplace'), write, stampWindow };
  }

  const tree = (dir: string) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => statSync(join(dir, p)).isFile()).sort();

  test('writes the tree and a marketplace beside it, and the copy accepts its window', () => {
    const c = checkout();
    const lines = assemblePlugin(c.root, c.out);
    expect(tree(c.out)).toEqual([
      '.claude-plugin/marketplace.json',
      'plugin/.claude-plugin/plugin.json',
      'plugin/bin/draftgate',
      'plugin/cli/src/main.ts',
      'plugin/cli/src/new.ts',
      'plugin/surface/dist/build-stamp.json',
      'plugin/surface/dist/index.html',
      'plugin/surface/src/App.tsx',
    ]);
    expect(statSync(join(c.out, 'plugin', 'bin', 'draftgate')).mode & 0o777).toBe(0o755);
    expect(JSON.parse(readFileSync(join(c.out, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins[0].source).toBe('./plugin');
    expect(bundleState(surfaceLayout(join(c.out, 'plugin')), false)).toEqual({ state: 'fresh' });
    expect(lines.join('\n')).toContain(`claude --plugin-dir ${join(c.out, 'plugin')}`);
    expect(lines.join('\n')).toContain(`claude plugin marketplace add ${c.out}`);
  });

  test('a second run replaces the first, a file deleted since included', () => {
    const c = checkout();
    assemblePlugin(c.root, c.out);
    rmSync(join(c.root, 'cli', 'src', 'new.ts'));
    assemblePlugin(c.root, c.out);
    expect(existsSync(join(c.out, 'plugin', 'cli', 'src', 'new.ts'))).toBe(false);
  });

  test('a window not built from this checkout is refused, and nothing is written', () => {
    const c = checkout();
    c.write('surface/src/App.tsx', 'export const App = 2;\n');
    expect(() => assemblePlugin(c.root, c.out)).toThrow('surface/src/App.tsx changed since it was built');
    expect(existsSync(c.out)).toBe(false);
  });

  test('a directory holding anything else is refused, and left as it is', () => {
    const c = checkout();
    c.write('dist/marketplace/notes.txt', 'mine\n');
    expect(() => assemblePlugin(c.root, c.out)).toThrow('holds something other than a plugin tree');
    expect(tree(c.out)).toEqual(['notes.txt']);
  });

  test('a lockfile the plugin itself holds is refused, and nothing is written', () => {
    const c = checkout();
    c.write('plugin/bun.lock', '{}\n');
    expect(() => assemblePlugin(c.root, c.out)).toThrow('plugin/bun.lock is a lockfile');
    expect(existsSync(c.out)).toBe(false);
  });

  test('a run that fails after copying leaves the last tree as it was, and the next run replaces it', () => {
    const c = checkout();
    assemblePlugin(c.root, c.out);
    const before = tree(c.out);
    c.write('.claude-plugin/marketplace.json', '{ "name": "draftgate" }\n');
    expect(() => assemblePlugin(c.root, c.out)).toThrow('has no plugins list');
    expect(tree(c.out)).toEqual(before);
    expect(readdirSync(dirname(c.out))).toEqual(['marketplace']);
    c.write('.claude-plugin/marketplace.json', readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assemblePlugin(c.root, c.out);
    expect(tree(c.out)).toEqual(before);
  });

  test('--out', () => {
    expect(parseOut([], '/r')).toBe('/r/dist/marketplace');
    expect(parseOut(['--out', '/x/y'], '/r')).toBe('/x/y');
    expect(parseOut(['--out'], '/r')).toEqual({ error: expect.stringContaining('usage') });
    expect(parseOut(['/x'], '/r')).toEqual({ error: expect.stringContaining('usage') });
  });
});
