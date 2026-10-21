/**
 * The draftgate plugin, two ways: this install's own manifest, when it runs from a plugin root, and
 * what Claude Code has recorded about the plugin (which version folder it installed, for which
 * scope, and whether the settings switch it on). `doctor` and `uninstall` read these, not the
 * plugin's `hooks/hooks.json`, which is there whether or not Claude Code loads it.
 *
 * ## Claude Code's files, as measured (2.1.296, a scratch `CLAUDE_CONFIG_DIR`)
 *
 *  - The plugins root is `CLAUDE_CODE_PLUGIN_CACHE_DIR` when set, else `plugins/` in the config
 *    directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`). It holds `installed_plugins.json`,
 *    `known_marketplaces.json` and the version folders under `cache/`.
 *  - `installed_plugins.json` is `{"version": 2, "plugins": {"<name>@<marketplace>": [ ... ]}}`, one
 *    entry per install: `scope`, `installPath`, `version`, and `projectPath` for a `project` or
 *    `local` one. An uninstall removes the entry and leaves the key's absence.
 *  - `enabledPlugins` in the settings files decides whether an installed plugin loads. Per id, the
 *    highest-precedence file that mentions it decides, local over project over user (measured: a
 *    project `false` turned a user `true` off, a local `true` turned it back on), and a managed
 *    value overrides them all (the settings reference: "`true` force-enables and `false` blocks").
 *    Only `true` enables: an absent key and `"yes"` both list as disabled.
 *  - A plugin from a directory marketplace runs in place, from the marketplace's folder, while
 *    `installPath` names the cache copy also made (`claude plugin list --json` shows both, as
 *    `readFromFolder` and `installPath`). So the folder a running plugin is in is either one.
 *
 * The file formats are Claude Code's and undocumented beyond their field names, so a file that does
 * not read as these shapes is reported as unreadable, never as "not installed".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from './json';
import { canonical } from './paths';

/** The plugin's name, and the marketplace's, as `.claude-plugin/marketplace.json` publishes them. */
export const PLUGIN_NAME = 'draftgate';
export const MARKETPLACE_NAME = 'draftgate';
/** The id Claude Code knows the published plugin by: what `/plugin` and `claude plugin` take. */
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** Where a plugin root keeps its manifest. A draftgate checkout's root has none. */
export const PLUGIN_MANIFEST_IN_ROOT = '.claude-plugin/plugin.json';
/** Where a marketplace keeps its manifest, under the marketplace's root. */
export const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';

export interface PluginManifest {
  version: string;
  /** Where the plugin's source lives, as the manifest says; null when it says nothing usable. */
  repository: string | null;
}

/**
 * The manifest of the draftgate plugin rooted at `root`, or null when `root` is not one: no
 * manifest (a checkout), or a manifest that does not name draftgate with a version.
 */
export function pluginManifest(root: string): PluginManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, PLUGIN_MANIFEST_IN_ROOT), 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(raw) || raw.name !== PLUGIN_NAME || typeof raw.version !== 'string') return null;
  return {
    version: raw.version,
    repository: typeof raw.repository === 'string' && raw.repository !== '' ? raw.repository : null,
  };
}

/** Claude Code's plugins root, as measured above. */
export function pluginsRoot(env: NodeJS.ProcessEnv, homedir: () => string): string {
  if (env.CLAUDE_CODE_PLUGIN_CACHE_DIR) return env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins');
}

/** One install of a draftgate plugin, from any marketplace. */
export interface PluginInstall {
  /** `draftgate@<marketplace>`. */
  id: string;
  scope: string;
  installPath: string;
  version: string;
  /** The project a `project` or `local` install belongs to. */
  projectPath?: string;
  /** The folder it runs from instead of `installPath`, for a directory marketplace. */
  inPlace?: string;
}

export type InstallsRead =
  | { kind: 'read'; path: string; installs: PluginInstall[] }
  | { kind: 'absent'; path: string }
  | { kind: 'unreadable'; path: string; why: string };

/**
 * `installed_plugins.json`'s draftgate installs, from its text. An entry that does not read as one
 * makes the whole file unreadable: skipping it would report an install that is there as absent.
 */
export function parseInstalledPlugins(text: string, path: string): InstallsRead {
  const bad = (why: string): InstallsRead => ({ kind: 'unreadable', path, why });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad('not valid JSON');
  }
  if (!isPlainObject(raw) || raw.version !== 2 || !isPlainObject(raw.plugins)) {
    return bad('not the version 2 record this draftgate reads');
  }
  const installs: PluginInstall[] = [];
  for (const [id, entries] of Object.entries(raw.plugins)) {
    if (!id.startsWith(`${PLUGIN_NAME}@`)) continue;
    if (!Array.isArray(entries)) return bad(`${id} is not a list of installs`);
    for (const e of entries) {
      if (
        !isPlainObject(e) ||
        typeof e.scope !== 'string' ||
        typeof e.installPath !== 'string' ||
        typeof e.version !== 'string' ||
        (e.projectPath !== undefined && typeof e.projectPath !== 'string')
      ) {
        return bad(`an install of ${id} is not shaped as one`);
      }
      installs.push({
        id,
        scope: e.scope,
        installPath: e.installPath,
        version: e.version,
        ...(typeof e.projectPath === 'string' && { projectPath: e.projectPath }),
      });
    }
  }
  return { kind: 'read', path, installs };
}

/**
 * The draftgate installs Claude Code has recorded, each with the folder it runs in place from when
 * its marketplace is a directory.
 */
export function readInstalledPlugins(env: NodeJS.ProcessEnv, homedir: () => string): InstallsRead {
  const root = pluginsRoot(env, homedir);
  const path = join(root, 'installed_plugins.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'absent', path }
      : { kind: 'unreadable', path, why: code ?? (e as Error).message };
  }
  const read = parseInstalledPlugins(text, path);
  if (read.kind !== 'read') return read;
  const known = readJson(join(root, 'known_marketplaces.json'));
  return {
    ...read,
    installs: read.installs.map((i) => {
      const inPlace = directoryFolder(known, i.id);
      return inPlace === null ? i : { ...i, inPlace };
    }),
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The folder a directory marketplace's plugin runs from: the marketplace's folder joined with the
 * plugin's relative source in its `marketplace.json`. Null for any other marketplace, or one that
 * cannot be read: then the plugin runs from `installPath`.
 */
function directoryFolder(known: unknown, id: string): string | null {
  const marketplace = id.slice(id.indexOf('@') + 1);
  const entry = isPlainObject(known) ? known[marketplace] : undefined;
  if (!isPlainObject(entry) || !isPlainObject(entry.source) || entry.source.source !== 'directory') return null;
  if (typeof entry.installLocation !== 'string') return null;
  const manifest = readJson(join(entry.installLocation, MARKETPLACE_MANIFEST));
  const plugins = isPlainObject(manifest) && Array.isArray(manifest.plugins) ? manifest.plugins : [];
  const plugin = plugins.find((p) => isPlainObject(p) && p.name === PLUGIN_NAME);
  return isPlainObject(plugin) && typeof plugin.source === 'string'
    ? join(entry.installLocation, plugin.source)
    : null;
}

/**
 * Where a settings document sits, as the hook's `hookSwitches.ts` spells it (`adapters/` imports
 * `cli/`, never the reverse, so the type is checked against that one by assignment, in the hook).
 */
type SettingsScope = 'managed' | 'user' | 'project' | 'local';

/** One settings document, as the hook reads them, with where it sits. */
export interface SettingsDoc {
  path: string;
  scope: SettingsScope;
  settings: Readonly<Record<string, unknown>>;
}

/** Whether a plugin id loads, and which file decided it; `by` null when no file mentions it. */
export interface Enabled {
  enabled: boolean;
  by: { path: string; scope: SettingsScope } | null;
}

/** Lowest precedence first, as above. */
const PRECEDENCE: readonly SettingsScope[] = ['user', 'project', 'local', 'managed'];

/** `enabledPlugins[id]` across the settings documents, by the precedence measured above. */
export function enabledIn(id: string, docs: readonly SettingsDoc[]): Enabled {
  let decided: Enabled = { enabled: false, by: null };
  const ordered = [...docs].sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope));
  for (const doc of ordered) {
    const map = doc.settings.enabledPlugins;
    if (!isPlainObject(map) || !(id in map)) continue;
    // Among managed documents a `false` blocks whatever another says.
    if (decided.by?.scope === 'managed' && !decided.enabled) continue;
    decided = { enabled: map[id] === true, by: { path: doc.path, scope: doc.scope } };
  }
  return decided;
}

/**
 * An install, whether it loads in sessions here (null when it does not apply here at all), and
 * whether its folder is the plugin root asking (`thisRoot`).
 */
export interface PluginHere extends PluginInstall {
  enabled: Enabled | null;
  thisRoot: boolean;
}

/**
 * Every install, each with whether the settings read here switch it on, when it applies here: a
 * `user` or `managed` one everywhere, a `project` or `local` one in its own project. `root` is the
 * plugin root asking, or null from a checkout; a directory marketplace's plugin runs in place, so
 * its cache copy is not what runs.
 */
export function pluginsHere(
  installs: readonly PluginInstall[],
  docs: readonly SettingsDoc[],
  projectDir: string | undefined,
  root: string | null = null
): PluginHere[] {
  const project = projectDir === undefined ? undefined : canonical(projectDir);
  const self = root === null ? null : canonical(root);
  return installs.map((i) => ({
    ...i,
    enabled: i.projectPath === undefined || canonical(i.projectPath) === project ? enabledIn(i.id, docs) : null,
    thisRoot: canonical(i.inPlace ?? i.installPath) === self,
  }));
}

/** Claude Code's record of the plugin, read: what `--doctor` reports and `uninstall` is told. */
export type PluginRecord =
  | { kind: 'read'; installs: PluginHere[] }
  | { kind: 'unreadable'; path: string; why: string };

/** The record that could not be read, in the words both its readers use. */
export const recordUnreadable = (r: { path: string; why: string }) =>
  `Claude Code's record of its plugins, ${r.path}, could not be read (${r.why})`;

/** Where an install is switched on or off, in the words both its readers use. */
export function enabledWhere(enabled: Enabled): string {
  if (enabled.enabled) return `enabled in ${enabled.by!.path}`;
  return enabled.by ? `switched off in ${enabled.by.path}` : 'enabled in no settings file';
}
