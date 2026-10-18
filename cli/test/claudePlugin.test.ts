/**
 * Claude Code's record of the draftgate plugin, read off files shaped as Claude Code 2.1.296 wrote
 * them under a scratch `CLAUDE_CONFIG_DIR` (see `claudePlugin.ts`), and the plugin's own manifest.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKETPLACE_MANIFEST,
  PLUGIN_ID,
  PLUGIN_MANIFEST_IN_ROOT,
  enabledIn,
  parseInstalledPlugins,
  pluginManifest,
  pluginsHere,
  pluginsRoot,
  readInstalledPlugins,
  type SettingsDoc,
} from '../src/claudePlugin';
import { REMEDY } from '../../core/src/remedies';
import { MIN_MACOS } from '../src/reviewHost';

const SCRATCH = mkdtempSync(join(tmpdir(), 'draftgate-claude-plugin-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const REPO = join(import.meta.dir, '..', '..');

const CACHE = '/cfg/plugins/cache/draftgate/draftgate/0.3.0';
/** `installed_plugins.json` as an install for the user and one for a project leave it. */
const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'draftgate@draftgate': [
      { scope: 'user', installPath: CACHE, version: '0.3.0', installedAt: 'x', lastUpdated: 'x' },
      { scope: 'project', installPath: CACHE, version: '0.3.0', projectPath: '/proj' },
    ],
    'other@draftgate': [{ scope: 'user', installPath: '/elsewhere', version: '1.0.0' }],
  },
});

const doc = (scope: SettingsDoc['scope'], enabledPlugins?: unknown): SettingsDoc => ({
  path: `/${scope}.json`,
  scope,
  settings: enabledPlugins === undefined ? {} : { enabledPlugins },
});

describe('the published id', () => {
  const market = JSON.parse(readFileSync(join(REPO, MARKETPLACE_MANIFEST), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(REPO, 'plugin', PLUGIN_MANIFEST_IN_ROOT), 'utf8'));

  test("is the marketplace's name for its draftgate plugin, and the remedies name it", () => {
    expect(PLUGIN_ID).toBe(`${plugin.name}@${market.name}`);
    expect(market.plugins.map((p: { name: string }) => p.name)).toContain(plugin.name);
    expect(REMEDY.pluginUninstall(PLUGIN_ID)).toBe(`\`/plugin uninstall ${PLUGIN_ID}\``);
    expect(REMEDY.pluginUpdate(PLUGIN_ID)).toBe(
      `\`claude plugin marketplace update ${market.name} && claude plugin update ${PLUGIN_ID}\``
    );
  });

  test("a checkout's root is not a plugin root; the plugin's own folder is", () => {
    expect(pluginManifest(REPO)).toBeNull();
    expect(pluginManifest(join(REPO, 'plugin'))).toMatchObject({ repository: 'https://github.com/Jakuboola/draftgate' });
  });

  // Claude Code has no platform field for a plugin: what `/plugin` shows before installing is the
  // description, so the floor is said there.
  test("the descriptions shown before installing name the review window's macOS floor", () => {
    const floor = `macOS ${MIN_MACOS.replace(/\.0$/, '')} or newer.`;
    expect(plugin.description).toEndWith(floor);
    expect(market.plugins.find((p: { name: string }) => p.name === plugin.name).description).toEndWith(floor);
  });
});

describe('installed_plugins.json', () => {
  test('every draftgate install, from any marketplace, and nothing else', () => {
    const read = parseInstalledPlugins(INSTALLED, '/p.json');
    expect(read).toEqual({
      kind: 'read',
      path: '/p.json',
      installs: [
        { id: 'draftgate@draftgate', scope: 'user', installPath: CACHE, version: '0.3.0' },
        { id: 'draftgate@draftgate', scope: 'project', installPath: CACHE, version: '0.3.0', projectPath: '/proj' },
      ],
    });
  });

  test('a file this does not read as that shape is unreadable, never "not installed"', () => {
    for (const text of [
      'nope',
      '{"version": 3, "plugins": {}}',
      '{"version": 2, "plugins": {"draftgate@x": {}}}',
      '{"version": 2, "plugins": {"draftgate@x": [{"scope": "user"}]}}',
    ]) {
      expect(parseInstalledPlugins(text, '/p.json').kind, text).toBe('unreadable');
    }
    expect(parseInstalledPlugins('{"version": 2, "plugins": {}}', '/p.json')).toEqual({ kind: 'read', path: '/p.json', installs: [] });
  });

  test('the plugins root: CLAUDE_CODE_PLUGIN_CACHE_DIR, else the config directory', () => {
    const home = () => '/home';
    expect(pluginsRoot({}, home)).toBe('/home/.claude/plugins');
    expect(pluginsRoot({ CLAUDE_CONFIG_DIR: '/cfg' }, home)).toBe('/cfg/plugins');
    expect(pluginsRoot({ CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_PLUGIN_CACHE_DIR: '/pc' }, home)).toBe('/pc');
  });

  test('read off disk: absent, unreadable, and a directory marketplace that runs in place', () => {
    const cfg = join(SCRATCH, 'cfg');
    const env = { CLAUDE_CONFIG_DIR: cfg };
    expect(readInstalledPlugins(env, () => '/nowhere').kind).toBe('absent');
    const plugins = join(cfg, 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'installed_plugins.json'), '{');
    expect(readInstalledPlugins(env, () => '/nowhere').kind).toBe('unreadable');

    const market = join(SCRATCH, 'mkt');
    mkdirSync(join(market, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(market, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'draftgate', plugins: [{ name: 'draftgate', source: './plugin' }] })
    );
    writeFileSync(join(plugins, 'installed_plugins.json'), INSTALLED);
    writeFileSync(
      join(plugins, 'known_marketplaces.json'),
      JSON.stringify({ draftgate: { source: { source: 'directory', path: market }, installLocation: market } })
    );
    const read = readInstalledPlugins(env, () => '/nowhere');
    expect(read.kind === 'read' && read.installs.map((i) => i.inPlace)).toEqual([join(market, 'plugin'), join(market, 'plugin')]);

    // A git marketplace's plugin runs from its cache copy.
    writeFileSync(
      join(plugins, 'known_marketplaces.json'),
      JSON.stringify({ draftgate: { source: { source: 'github', repo: 'o/r' }, installLocation: market } })
    );
    const git = readInstalledPlugins(env, () => '/nowhere');
    expect(git.kind === 'read' && git.installs.map((i) => i.inPlace)).toEqual([undefined, undefined]);
  });
});

describe('enabledPlugins, by the precedence measured', () => {
  test('the highest-precedence file that mentions the id decides; managed over them all', () => {
    const on = { [PLUGIN_ID]: true };
    const off = { [PLUGIN_ID]: false };
    expect(enabledIn(PLUGIN_ID, [doc('user', on)])).toEqual({ enabled: true, by: { path: '/user.json', scope: 'user' } });
    // Measured: a project `false` turns a user `true` off, and a local `true` turns it back on.
    expect(enabledIn(PLUGIN_ID, [doc('user', on), doc('project', off)]).enabled).toBe(false);
    expect(enabledIn(PLUGIN_ID, [doc('local', on), doc('user', on), doc('project', off)]).enabled).toBe(true);
    // Order of the list does not matter, and a file that does not mention it decides nothing.
    expect(enabledIn(PLUGIN_ID, [doc('project', off), doc('local', {}), doc('user', on)]).enabled).toBe(false);
    expect(enabledIn(PLUGIN_ID, [doc('local', on), doc('managed', off)])).toEqual({
      enabled: false,
      by: { path: '/managed.json', scope: 'managed' },
    });
    expect(enabledIn(PLUGIN_ID, [doc('managed', off), { ...doc('managed', on), path: '/m2.json' }]).enabled).toBe(false);
  });

  test('only true enables: an absent key, no file, and a string are all off', () => {
    expect(enabledIn(PLUGIN_ID, [])).toEqual({ enabled: false, by: null });
    expect(enabledIn(PLUGIN_ID, [doc('user', {})])).toEqual({ enabled: false, by: null });
    expect(enabledIn(PLUGIN_ID, [doc('user', { [PLUGIN_ID]: 'yes' })]).enabled).toBe(false);
    expect(enabledIn(PLUGIN_ID, [doc('user', 'not a map')]).by).toBeNull();
  });

  test("an install applies here when it is the user's, or this project's", () => {
    const read = parseInstalledPlugins(INSTALLED, '/p.json');
    if (read.kind !== 'read') throw new Error('unreadable');
    const docs = [doc('user', { [PLUGIN_ID]: true })];
    const applies = (dir: string | undefined) => pluginsHere(read.installs, docs, dir).map((p) => p.enabled !== null);
    expect(applies('/proj')).toEqual([true, true]);
    expect(applies('/other')).toEqual([true, false]);
    expect(applies(undefined)).toEqual([true, false]);
    expect(pluginsHere(read.installs, docs, '/proj')[0]!.enabled!.enabled).toBe(true);
  });
});
