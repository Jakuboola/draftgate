/**
 * `bun run release`: the tag `plugin.json`'s version names, `stable` moved to a release commit
 * carrying the built window and the plugin tree, and the release notes, all or nothing on origin.
 *
 * Each test stands up a real repository with a bare origin, whose `build:surface`, `surface:probe`
 * and `surface:e2e` are small scripts `bun run` really runs. Asserted on origin's refs, a user's
 * clone of `stable` (its stamp check with no toolchain, the release it reads, the fast-forward), and
 * the local tags a refused run must not leave.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitIn, githubRepo, originHas, parseReleaseArgs, release, runScript, type ReleaseContext, type Run } from '../src/release';
import { installedRelease, lsRemoteRefs } from '../src/releaseCheck';
import { bundleState, surfaceLayout } from '../src/surfaces/bundleStamp';
import { fixtureGit } from './releaseClone';

const scratch = mkdtempSync(join(tmpdir(), 'draftgate-release-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const STAMP_MODULE = join(import.meta.dir, '..', 'src', 'surfaces', 'bundleStamp.ts');

/**
 * The window build: an index page and one asset named by the source's hash, so a release from
 * changed source drops the old asset. Stamped from `bun.lock`, the source, and a package input a
 * release clone does not have. `FIXTURE_UNSTABLE` makes it differ on every run; `FIXTURE_IGNORED`
 * makes it read a git-ignored file, which a release clone does not have either.
 */
const BUILD = `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hashFile, sha256, stampOf } from ${JSON.stringify(STAMP_MODULE)};
const app = readFileSync('surface/src/App.tsx', 'utf8');
rmSync('surface/dist', { recursive: true, force: true });
mkdirSync('surface/dist/assets', { recursive: true });
const noise = process.env.FIXTURE_UNSTABLE ? String(Math.random()) : '';
writeFileSync('surface/dist/index.html', '<!doctype html>' + app + noise);
writeFileSync('surface/dist/assets/app-' + sha256(app).slice(0, 8) + '.js', app);
const inputs = {
  'bun.lock': hashFile('bun.lock'),
  'surface/src/App.tsx': hashFile('surface/src/App.tsx'),
  'tsconfig.json': hashFile('tsconfig.json'),
  'node_modules/react/index.js': sha256('a package'),
  ...(process.env.FIXTURE_IGNORED ? { 'local.txt': hashFile('local.txt') } : {}),
};
writeFileSync('surface/dist/build-stamp.json', JSON.stringify({ version: 1, stamp: stampOf(inputs), inputs }));
`;

/** A verifier that fails when `FIXTURE_FAIL` names it, and makes the tag `FIXTURE_TAG` names. */
const VERIFY = `
if (process.env.FIXTURE_TAG) Bun.spawnSync(['git', 'tag', process.env.FIXTURE_TAG]);
process.exit(process.env.FIXTURE_FAIL === process.argv[2] ? 1 : 0);
`;

const PACKAGE = JSON.stringify({
  name: 'fixture',
  private: true,
  scripts: {
    'build:surface': 'bun build.ts',
    'surface:probe': 'bun build.ts && bun verify.ts surface:probe',
    'surface:e2e': 'bun build.ts && bun verify.ts surface:e2e',
  },
});

/** The plugin's manifest, at a version. */
const manifest = (version: string) => JSON.stringify({ name: 'draftgate', version }, null, 2) + '\n';

/** A checkout on `main` with a bare origin holding the same `main`, its plugin at version 0.1.0. */
function template(dir: string) {
  const { git } = fixtureGit(join(dir, 'home'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'init', '--quiet', '-b', 'main', work);
  mkdirSync(join(work, 'surface', 'src'), { recursive: true });
  writeFileSync(join(work, 'package.json'), PACKAGE);
  writeFileSync(join(work, 'build.ts'), BUILD);
  writeFileSync(join(work, 'verify.ts'), VERIFY);
  writeFileSync(join(work, 'bun.lock'), '{ "lockfileVersion": 2 }\n');
  writeFileSync(join(work, 'surface', 'src', 'App.tsx'), 'export const App = 1;\n');
  writeFileSync(join(work, 'tsconfig.json'), '{}\n');
  mkdirSync(join(work, 'cli', 'src'), { recursive: true });
  writeFileSync(join(work, 'cli', 'src', 'main.ts'), 'export {};\n');
  mkdirSync(join(work, 'cli', 'test'), { recursive: true });
  writeFileSync(join(work, 'cli', 'test', 'main.test.ts'), 'export {};\n');
  mkdirSync(join(work, 'plugin', '.claude-plugin'), { recursive: true });
  mkdirSync(join(work, 'plugin', 'bin'), { recursive: true });
  writeFileSync(join(work, 'plugin', '.claude-plugin', 'plugin.json'), manifest('0.1.0'));
  writeFileSync(join(work, 'plugin', 'bin', 'draftgate'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(work, '.gitignore'), 'surface/dist/\nnode_modules/\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'first');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '--quiet', 'origin', 'main');
}

/** Built once per file; each fixture is a copy, its remote pointed at its own origin. */
const TEMPLATE = mkdtempSync(join(scratch, 'template-'));
template(TEMPLATE);

function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(scratch, 'r-'));
  cpSync(TEMPLATE, dir, { recursive: true });
  const { env, git } = fixtureGit(join(dir, 'home'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(work, 'remote', 'set-url', 'origin', origin);

  const runEnv = { ...env, ...extraEnv };
  const scripts: string[] = [];
  const ghCalls: string[][] = [];
  const printed: string[] = [];
  let ghAnswer = (_args: string[]): Run => ({ ok: true, stdout: 'https://github.com/o/r/releases/tag/x\n', output: '' });
  const ctx: ReleaseContext = {
    root: work,
    env: runEnv,
    script: (name) => {
      scripts.push(name);
      return runScript(work, name, runEnv, 'ignore');
    },
    gh: (args) => {
      ghCalls.push(args);
      return ghAnswer(args);
    },
    print: async (text) => void printed.push(text),
  };
  /** origin's refs, as `ls-remote` lists them. */
  const originRefs = () => git(dir, 'ls-remote', origin).split('\n').filter(Boolean).sort();
  /** origin's refs, as the release reads them. */
  const remote = () => lsRemoteRefs(git(dir, 'ls-remote', origin));
  const run = async (...argv: string[]) => {
    printed.length = 0;
    return release(argv, ctx);
  };
  /** Commit `text` to `path` on main, and push it. */
  const commit = (path: string, text: string) => {
    writeFileSync(join(work, path), text);
    git(work, 'commit', '--quiet', '-am', `change ${path}`);
    git(work, 'push', '--quiet', 'origin', 'main');
  };
  /** Commit a change to the window's source on main, and push it. */
  const change = (text: string) => commit('surface/src/App.tsx', text);
  /** Commit the plugin's version on main, and push it, unless it is that already. */
  const bump = (version: string) => {
    const path = 'plugin/.claude-plugin/plugin.json';
    if (git(work, 'show', `HEAD:${path}`) !== manifest(version).trim()) commit(path, manifest(version));
  };
  /** A release at `version`, the version committed first. */
  const releaseAt = async (version: string, ...argv: string[]) => {
    bump(version);
    return run(...argv);
  };
  /** A user's clone of `stable`. */
  const userClone = (name = 'user') => {
    const at = join(dir, name);
    git(dir, 'clone', '--quiet', '-b', 'stable', origin, at);
    return at;
  };
  return {
    dir, env, git, origin, work, ctx, scripts, ghCalls, originRefs, remote, run, releaseAt, bump, commit, change, userClone,
    text: () => printed.join(''),
    setGh: (f: (args: string[]) => Run) => void (ghAnswer = f),
    localTags: () => git(work, 'tag', '--list').split('\n').filter(Boolean),
  };
}

const parents = (f: ReturnType<typeof fixture>, rev: string) =>
  f.git(f.work, 'rev-list', '--parents', '-n', '1', rev).split(' ').slice(1);

describe('a release', () => {
  test('the first: tags main, and creates stable as a release commit a user clone accepts', async () => {
    const f = fixture();
    const head = f.git(f.work, 'rev-parse', 'HEAD');
    expect(await f.releaseAt('0.1.0')).toBe(0);
    expect(f.scripts).toEqual(['build:surface', 'surface:probe', 'surface:e2e']);

    const { heads, tags } = f.remote();
    const stable = heads.get('stable')!;
    expect(tags.get('v0.1.0')).toBe(head);
    expect(heads.get('main')).toBe(head);
    // Annotated, and the same tag here as on origin.
    expect(f.git(f.work, 'cat-file', '-t', 'v0.1.0')).toBe('tag');
    expect(f.git(f.work, 'rev-parse', 'v0.1.0')).toBe(f.git(f.origin, 'rev-parse', 'refs/tags/v0.1.0'));
    // A commit of its own, made from the tag: never the tagged commit.
    expect(stable).not.toBe(head);
    expect(parents(f, stable)).toEqual([head]);

    const user = f.userClone();
    expect(f.git(user, 'ls-files', 'surface/dist').split('\n')).toContain('surface/dist/build-stamp.json');
    expect(bundleState(surfaceLayout(user), false)).toEqual({ state: 'fresh' });
    expect(installedRelease(user, f.env)).toEqual({ have: 'v0.1.0' });

    // The plugin tree: its own files, the runtime, the window's sources and the window, and no
    // lockfile, test or build script. What Claude Code copies into its cache is this directory.
    const plugin = f.git(user, 'ls-files', 'plugin').split('\n');
    const window = f.git(user, 'ls-files', 'surface/dist').split('\n').map((p) => `plugin/${p}`);
    expect(plugin).toEqual(
      [
        'plugin/.claude-plugin/plugin.json',
        'plugin/bin/draftgate',
        'plugin/cli/src/main.ts',
        'plugin/package.json',
        'plugin/surface/src/App.tsx',
        'plugin/tsconfig.json',
        ...window,
      ].sort()
    );
    expect(bundleState(surfaceLayout(join(user, 'plugin')), false)).toEqual({ state: 'fresh' });
    // The same blobs as the files it copies, executable bits included.
    const entry = (path: string) => f.git(user, 'ls-files', '--stage', path).split('\t')[0]!.split(' ').slice(0, 2).join(' ');
    expect(entry('plugin/cli/src/main.ts')).toBe(entry('cli/src/main.ts'));
    expect(entry('plugin/surface/dist/index.html')).toBe(entry('surface/dist/index.html'));
    expect(entry('plugin/bin/draftgate')).toStartWith('100755 ');
    // The checkout it was cut from is as it was: its index never held the window.
    expect(f.git(f.work, 'status', '--porcelain')).toBe('');
    expect(f.text()).toContain('origin is not on GitHub, so there are none.');
    expect(f.ghCalls).toEqual([]);
  });

  test('the second: stable fast-forwards, and carries only the new window', async () => {
    const f = fixture();
    expect(await f.releaseAt('0.1.0')).toBe(0);
    const user = f.userClone();
    const oldStable = f.git(user, 'rev-parse', 'HEAD');
    const oldAssets = readdirSync(join(user, 'surface', 'dist', 'assets'));

    f.change('export const App = 2;\n');
    f.bump('0.2.0');
    const head = f.git(f.work, 'rev-parse', 'HEAD');
    expect(await f.run()).toBe(0);

    // What a checkout of stable gets on a pull: fetch, then a fast-forward only.
    f.git(user, 'fetch', '--quiet', '--tags', '--force', 'origin', 'stable');
    f.git(user, 'merge', '--quiet', '--ff-only', 'FETCH_HEAD');
    const newStable = f.git(user, 'rev-parse', 'HEAD');
    expect(parents(f, newStable)).toEqual([oldStable, head]);
    const assets = readdirSync(join(user, 'surface', 'dist', 'assets'));
    expect(assets).toHaveLength(1);
    expect(assets).not.toEqual(oldAssets);
    expect(bundleState(surfaceLayout(user), false)).toEqual({ state: 'fresh' });
    expect(bundleState(surfaceLayout(join(user, 'plugin')), false)).toEqual({ state: 'fresh' });
    expect(readdirSync(join(user, 'plugin', 'surface', 'dist', 'assets'))).toEqual(assets);
    expect(installedRelease(user, f.env)).toEqual({ have: 'v0.2.0' });
    // The release commit's tree is the tag's plus the window and the plugin tree, and nothing else.
    const tree = (rev: string) =>
      f.git(user, 'ls-tree', '-r', '--name-only', rev).split('\n').filter((p) => !/^(surface\/dist|plugin)\//.test(p));
    expect(tree(newStable)).toEqual(tree(head).filter((p) => !p.startsWith('plugin/')));
  });
});

describe('refusals change nothing, here or on origin', () => {
  /** Run with `argv`, expecting a refusal at step 1 that ran no script and moved no ref. */
  async function refused(f: ReturnType<typeof fixture>, argv: string[], says: string) {
    const before = f.originRefs();
    const tags = f.localTags();
    expect(await f.run(...argv)).toBe(1);
    expect(f.text()).toContain(says);
    expect(f.text()).toContain('Nothing was tagged, committed or pushed.');
    expect(f.scripts).toEqual([]);
    expect(f.originRefs()).toEqual(before);
    expect(f.localTags()).toEqual(tags);
  }

  test('a command line that is not one, and a version given on it', async () => {
    const f = fixture();
    await refused(f, ['--draft'], 'usage: bun run release [--notes <file>]');
    await refused(f, ['--notes'], 'usage: bun run release [--notes <file>]');
    // The version is plugin.json's: one given here is a second copy, so it is refused, saying where.
    await refused(f, ['0.2.0'], "The version is plugin/.claude-plugin/plugin.json's: bump it there");
  });

  test('a plugin.json with no release version, or none at all', async () => {
    const f = fixture();
    f.bump('0.2.0-rc1');
    await refused(f, [], 'version "0.2.0-rc1" is not X.Y.Z');
    f.commit('plugin/.claude-plugin/plugin.json', '{ "name": "draftgate" }\n');
    await refused(f, [], 'plugin/.claude-plugin/plugin.json has no "version"');
    f.git(f.work, 'rm', '--quiet', 'plugin/.claude-plugin/plugin.json');
    f.git(f.work, 'commit', '--quiet', '-m', 'no manifest');
    f.git(f.work, 'push', '--quiet', 'origin', 'main');
    await refused(f, [], 'main has no plugin/.claude-plugin/plugin.json');
  });

  test('a branch other than main', async () => {
    const f = fixture();
    f.git(f.work, 'switch', '--quiet', '-c', 'feature');
    await refused(f, [], 'This checkout is on feature. A release is cut from main.');
  });

  test('a change to a tracked file, and an untracked file', async () => {
    const f = fixture();
    writeFileSync(join(f.work, 'surface', 'src', 'App.tsx'), 'export const App = 9;\n');
    await refused(f, [], 'The tree has 1 change git would not ship');
    f.git(f.work, 'checkout', '--', '.');
    writeFileSync(join(f.work, 'surface', 'src', 'Extra.tsx'), 'export {};\n');
    await refused(f, [], '?? surface/src/Extra.tsx');
  });

  test('a HEAD that is not origin main', async () => {
    const f = fixture();
    f.git(f.work, 'commit', '--quiet', '--allow-empty', '-m', 'unpushed');
    await refused(f, [], "origin's main is");
  });

  test('a version not bumped past the last release, and a tag that exists', async () => {
    const f = fixture();
    expect(await f.releaseAt('0.2.0')).toBe(0);
    // New code, the version left as it was: Claude Code would never offer it as an update.
    f.change('export const App = 2;\n');
    f.scripts.length = 0;
    await refused(f, [], "v0.2.0, plugin/.claude-plugin/plugin.json's version, is released already.");
    expect(f.text()).toContain("Bump the version in plugin/.claude-plugin/plugin.json, in a commit on main: it is the plugin's only update signal.");
    f.bump('0.1.9');
    await refused(f, [], "v0.1.9, plugin/.claude-plugin/plugin.json's version, is not newer than v0.2.0, the newest release.");
    f.git(f.work, 'tag', 'v0.3.0');
    f.bump('0.3.0');
    await refused(f, [], 'v0.3.0 exists already here, and not on origin');
    // A tag only this checkout has was never released, so it does not raise the bar.
    expect(await f.releaseAt('0.2.1')).toBe(0);
    expect(f.localTags()).toEqual(['v0.2.0', 'v0.2.1', 'v0.3.0']);
  });

  test('a stable that holds more than a release', async () => {
    const f = fixture();
    expect(await f.releaseAt('0.1.0')).toBe(0);
    const other = f.userClone('other');
    writeFileSync(join(other, 'stray.txt'), 'not a release\n');
    f.git(other, 'add', 'stray.txt');
    f.change('export const App = 2;\n');
    f.bump('0.2.0');

    // A commit on top of the release commit: its parent is no commit on main.
    f.git(other, 'commit', '--quiet', '-m', 'stray');
    f.git(other, 'push', '--quiet', 'origin', 'stable');
    f.scripts.length = 0;
    await refused(f, [], 'is not a release commit: its last parent');

    // The release commit itself, amended: made from a release, and adding more than a release adds.
    f.git(other, 'reset', '--quiet', '--soft', 'HEAD~1');
    f.git(other, 'commit', '--quiet', '--amend', '--no-edit');
    f.git(other, 'push', '--quiet', '--force', 'origin', 'stable');
    await refused(f, [], 'is not a release commit: it changes more than surface/dist and plugin/');
  });

  test('a stable whose plugin tree is not what an assembly makes', async () => {
    const f = fixture();
    expect(await f.releaseAt('0.1.0')).toBe(0);
    const other = f.userClone('other');
    const released = f.git(other, 'rev-parse', 'HEAD');
    /** stable, as the release made it plus one change under plugin/. */
    const stableWith = (change: () => void) => {
      f.git(other, 'reset', '--quiet', '--hard', released);
      change();
      f.git(other, 'add', '-A');
      f.git(other, 'commit', '--quiet', '--amend', '--no-edit');
      f.git(other, 'push', '--quiet', '--force', 'origin', 'stable');
    };
    f.bump('0.2.0');
    f.scripts.length = 0;
    const cases: [string, () => void][] = [
      // A copy that is not the bytes it mirrors.
      ['plugin/tsconfig.json', () => writeFileSync(join(other, 'plugin', 'tsconfig.json'), '{ "edited": true }\n')],
      // The same bytes as the root's, at the path it mirrors, and still no assembly's: every plugin
      // install would get the packages it names.
      ['plugin/bun.lock', () => writeFileSync(join(other, 'plugin', 'bun.lock'), readFileSync(join(other, 'bun.lock')))],
      ['plugin/extra.txt', () => writeFileSync(join(other, 'plugin', 'extra.txt'), 'only here\n')],
      ['plugin/cli/src/main.ts', () => rmSync(join(other, 'plugin', 'cli', 'src', 'main.ts'))],
    ];
    for (const [path, change] of cases) {
      stableWith(change);
      await refused(f, [], `its ${path} is not what an assembly of`);
    }
    stableWith(() => {});
    expect(await f.run()).toBe(0);
  });
});

describe('the first plugin release, over a stable from before the plugin', () => {
  /**
   * origin's `stable` as a release with no plugin leaves it: a release commit whose tree is a
   * plugin-less `main`'s plus its window, and nothing under `plugin/` (or `extra` there, when given).
   */
  function prePluginStable(extra?: string) {
    const f = fixture();
    f.git(f.work, 'rm', '-r', '--quiet', 'plugin');
    f.git(f.work, 'commit', '--quiet', '-m', 'before the plugin');
    const before = f.git(f.work, 'rev-parse', 'HEAD');
    expect(runScript(f.work, 'build:surface', f.env, 'ignore')).toBe(0);
    const index = { ...f.env, GIT_INDEX_FILE: join(f.dir, 'old-index') };
    const g = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: f.work, env: index });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.toString().trim();
    };
    g('read-tree', before);
    g('add', '--force', 'surface/dist');
    if (extra !== undefined) {
      mkdirSync(join(f.work, 'plugin'), { recursive: true });
      writeFileSync(join(f.work, extra), 'left here\n');
      g('add', '--force', extra);
      rmSync(join(f.work, 'plugin'), { recursive: true });
    }
    const commit = g('commit-tree', g('write-tree'), '-p', before, '-m', 'Release v0.1.0');
    f.git(f.work, 'push', '--quiet', 'origin', `${before}:refs/heads/main`, `${commit}:refs/heads/stable`);
    f.git(f.work, 'tag', '-a', '-m', 'v0.1.0', 'v0.1.0', before);
    f.git(f.work, 'push', '--quiet', 'origin', 'v0.1.0');
    f.git(f.work, 'revert', '--no-edit', '--quiet', 'HEAD');
    f.git(f.work, 'push', '--quiet', 'origin', 'main');
    return f;
  }

  test('is released over, its window replaced and the plugin tree added', async () => {
    const f = prePluginStable();
    expect(await f.releaseAt('0.2.0')).toBe(0);
    const user = f.userClone();
    expect(bundleState(surfaceLayout(join(user, 'plugin')), false)).toEqual({ state: 'fresh' });
  });

  test('refuses one holding anything under plugin/, since that release had nothing there', async () => {
    const f = prePluginStable('plugin/stray.txt');
    f.bump('0.2.0');
    const before = f.originRefs();
    expect(await f.run()).toBe(1);
    expect(f.text()).toContain('its plugin/stray.txt is not what an assembly of');
    expect(f.scripts).toEqual([]);
    expect(f.originRefs()).toEqual(before);
  });
});

describe('a failure after the checks still changes nothing on origin', () => {
  test('a verifier that fails', async () => {
    const f = fixture({ FIXTURE_FAIL: 'surface:e2e' });
    const before = f.originRefs();
    expect(await f.releaseAt('0.1.0')).toBe(1);
    expect(f.scripts).toEqual(['build:surface', 'surface:probe', 'surface:e2e']);
    expect(f.text()).toContain('FAILED: surface:e2e failed');
    expect(f.originRefs()).toEqual(before);
    expect(f.localTags()).toEqual([]);
  });

  test('a window that is not the one built: the build is not deterministic', async () => {
    const f = fixture({ FIXTURE_UNSTABLE: '1' });
    const before = f.originRefs();
    expect(await f.releaseAt('0.1.0')).toBe(1);
    expect(f.scripts).toEqual(['build:surface', 'surface:probe']);
    expect(f.text()).toContain('surface/dist is not what step 2 built after surface:probe: index.html differs.');
    expect(f.originRefs()).toEqual(before);
    expect(f.localTags()).toEqual([]);
  });

  test('a window a release clone would refuse: built from a file git does not ship', async () => {
    const f = fixture({ FIXTURE_IGNORED: '1' });
    writeFileSync(join(f.work, '.git', 'info', 'exclude'), 'local.txt\n');
    writeFileSync(join(f.work, 'local.txt'), 'only here\n');
    const before = f.originRefs();
    expect(await f.releaseAt('0.1.0')).toBe(1);
    expect(f.text()).toContain('The plugin tree cannot be assembled: the window was built from local.txt, which this tree does not hold.');
    expect(f.originRefs()).toEqual(before);
    expect(f.localTags()).toEqual([]);
  });

  test('a lockfile in the plugin tree: every user would get its packages installed', async () => {
    const f = fixture();
    writeFileSync(join(f.work, 'plugin', 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
    f.git(f.work, 'add', 'plugin/package-lock.json');
    f.git(f.work, 'commit', '--quiet', '-m', 'a lockfile');
    f.git(f.work, 'push', '--quiet', 'origin', 'main');
    const before = f.originRefs();
    expect(await f.run()).toBe(1);
    expect(f.text()).toContain('The plugin tree cannot be assembled: plugin/package-lock.json is a lockfile');
    // Refused once the window is built, before the verifiers spend their time on it.
    expect(f.scripts).toEqual(['build:surface']);
    expect(f.originRefs()).toEqual(before);
    expect(f.localTags()).toEqual([]);
  });

  test('a local tag somebody made meanwhile: the release goes out, and their tag is left alone', async () => {
    const f = fixture({ FIXTURE_TAG: 'v0.1.0' });
    expect(await f.releaseAt('0.1.0')).toBe(0);
    expect(f.text()).toContain('this checkout already had a v0.1.0 of its own, left as it is');
    // Theirs is a lightweight tag; origin's is the release's annotated one.
    expect(f.git(f.work, 'cat-file', '-t', 'v0.1.0')).toBe('commit');
    expect(f.remote().tags.has('v0.1.0')).toBe(true);
  });

  test('a push origin refuses for stable alone: the tag does not land either, nor exist here', async () => {
    const f = fixture();
    // An `update` hook judges each ref on its own, so only `--atomic` keeps the tag off origin too.
    const hook = join(f.origin, 'hooks', 'update');
    writeFileSync(hook, '#!/bin/sh\n[ "$1" = refs/heads/stable ] || exit 0\necho "refused by policy" >&2\nexit 1\n', { mode: 0o755 });
    const before = f.originRefs();
    expect(await f.releaseAt('0.1.0')).toBe(1);
    expect(f.text()).toContain('origin refused the push');
    expect(f.text()).toContain('| remote: refused by policy');
    expect(f.originRefs()).toEqual(before);
    expect(f.localTags()).toEqual([]);
    // And once origin takes it, the same command releases.
    rmSync(hook);
    expect(await f.releaseAt('0.1.0')).toBe(0);
  });
});

describe('after a failed push, what origin has decides', () => {
  test('both refs, neither, or anything else', async () => {
    const f = fixture();
    const git = gitIn(f.work, f.env);
    const head = f.git(f.work, 'rev-parse', 'HEAD');
    const plan = { tag: 'v0.1.0', head, oldStable: null };
    expect(originHas(plan, 'f'.repeat(40), git)).toBe('neither');
    expect(await f.releaseAt('0.1.0')).toBe(0);
    const stable = f.remote().heads.get('stable')!;
    expect(originHas(plan, stable, git)).toBe('both');
    // The tag landed and stable is not the commit this run pushed.
    expect(originHas(plan, 'f'.repeat(40), git)).toBe('unclear');
    expect(originHas({ ...plan, tag: 'v0.2.0', oldStable: stable }, stable, git)).toBe('neither');
    f.git(f.work, 'remote', 'set-url', 'origin', join(f.dir, 'nowhere.git'));
    expect(originHas(plan, stable, git)).toBe('unclear');
  });
});

describe('release notes, when origin is on GitHub', () => {
  /** origin's URL a GitHub one, which git rewrites to the bare repository for every fetch and push. */
  function onGithub(f: ReturnType<typeof fixture>) {
    f.git(f.work, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    f.git(f.work, 'config', `url.${f.origin}.insteadOf`, 'https://github.com/o/r.git');
  }

  test('gh is asked first, and the notes are made after the push', async () => {
    const f = fixture();
    onGithub(f);
    let pushedFirst = false;
    f.setGh((args) => {
      if (args[0] === 'release') pushedFirst = f.remote().tags.has('v0.1.0');
      return { ok: true, stdout: 'https://github.com/o/r/releases/tag/v0.1.0\n', output: '' };
    });
    expect(await f.releaseAt('0.1.0')).toBe(0);
    expect(f.ghCalls).toEqual([
      ['repo', 'view', 'o/r', '--json', 'nameWithOwner'],
      ['release', 'create', 'v0.1.0', '--repo', 'o/r', '--verify-tag', '--title', 'draftgate v0.1.0', '--generate-notes'],
    ]);
    expect(pushedFirst).toBe(true);
  });

  test('--notes names the file gh reads them from, a relative one read from the checkout', async () => {
    const f = fixture();
    onGithub(f);
    const notes = join(f.dir, 'notes.md');
    writeFileSync(notes, 'What changed.\n');
    expect(await f.releaseAt('0.1.0', '--notes', '../notes.md')).toBe(0);
    expect(f.ghCalls.at(-1)).toEqual(['release', 'create', 'v0.1.0', '--repo', 'o/r', '--verify-tag', '--title', 'draftgate v0.1.0', '--notes-file', notes]);
  });

  test('a gh that cannot reach the repository refuses before anything is built', async () => {
    const f = fixture();
    onGithub(f);
    f.setGh(() => ({ ok: false, stdout: '', output: 'HTTP 404: Not Found\n' }));
    const before = f.originRefs();
    expect(await f.releaseAt('0.1.0')).toBe(1);
    expect(f.text()).toContain('gh cannot reach it');
    expect(f.scripts).toEqual([]);
    expect(f.originRefs()).toEqual(before);
  });

  test('notes gh fails to create leave the release pushed, and say how to add them', async () => {
    const f = fixture();
    onGithub(f);
    f.setGh((args) => (args[0] === 'repo' ? { ok: true, stdout: '', output: '' } : { ok: false, stdout: '', output: 'HTTP 502\n' }));
    expect(await f.releaseAt('0.1.0')).toBe(1);
    expect(f.remote().heads.has('stable')).toBe(true);
    expect(f.text()).toContain('Only its notes are missing: gh release create v0.1.0 --repo o/r --verify-tag --title');
  });
});

describe('the parts', () => {
  test('githubRepo reads https and ssh origins, and nothing else', () => {
    expect(githubRepo('https://github.com/Jakuboola/draftgate')).toBe('Jakuboola/draftgate');
    expect(githubRepo('https://github.com/Jakuboola/draftgate.git')).toBe('Jakuboola/draftgate');
    expect(githubRepo('git@github.com:Jakuboola/draftgate.git')).toBe('Jakuboola/draftgate');
    expect(githubRepo('ssh://git@github.com/o/r.git')).toBe('o/r');
    expect(githubRepo('/tmp/origin.git')).toBeNull();
    expect(githubRepo('https://gitlab.com/o/r.git')).toBeNull();
    expect(githubRepo('https://github.com/o')).toBeNull();
  });

  test('parseReleaseArgs', () => {
    expect(parseReleaseArgs([])).toEqual({ notes: null });
    expect(parseReleaseArgs(['--notes', 'n.md'])).toEqual({ notes: 'n.md' });
    expect(parseReleaseArgs(['--notes'])).toHaveProperty('error');
    expect(parseReleaseArgs(['--notes', 'a', '--notes', 'b'])).toHaveProperty('error');
    const bumpThere = expect.arrayContaining([expect.stringContaining('bump it there')]);
    expect(parseReleaseArgs(['0.1.0'])).toEqual({ error: bumpThere });
    expect(parseReleaseArgs(['v1.10.0'])).toEqual({ error: bumpThere });
    expect(parseReleaseArgs(['nonsense'])).toEqual({ error: ['usage: bun run release [--notes <file>]'] });
  });
});

test('the fixture build is what a real release clone checks: no toolchain, a stamp it can re-hash', () => {
  // Guards the fixture: a stamp naming nothing this clone has would make every test above vacuous.
  const f = fixture();
  expect(runScript(f.work, 'build:surface', f.env, 'ignore')).toBe(0);
  expect(existsSync(join(f.work, 'surface', 'dist', 'index.html'))).toBe(true);
  expect(bundleState(surfaceLayout(f.work), false)).toEqual({ state: 'fresh' });
  writeFileSync(join(f.work, 'surface', 'src', 'App.tsx'), 'export const App = 3;\n');
  expect(bundleState(surfaceLayout(f.work), false).state).toBe('foreign');
});
