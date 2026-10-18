/**
 * Will Claude Code run draftgate's hook at all? Read off the settings that switch hooks off; when
 * one does, no window, log row or `ask` is reached and the tool goes through Claude Code's own
 * permission flow. `main.ts` does the reading and `doctor.ts` the saying.
 *
 * ## The resolver, read from the Claude Code 2.1.287 binary
 *
 * The function whose result Claude Code snapshots as a session's hooks (`initialHooksConfig`)
 * makes four checks, in this order, and returns at the first that holds:
 *
 *  1. managed `disableAllHooks: true` -- no hooks at all;
 *  2. managed `allowManagedHooksOnly: true`, or safe mode -- managed hooks only;
 *  3. managed `strictPluginOnlyCustomization`, `true` or a list naming `"hooks"` -- managed only;
 *  4. `disableAllHooks: true` in the merged settings -- managed hooks only.
 *
 * The same four as in 2.1.286. Every comparison is `=== true`, so `"true"` switches nothing. An
 * organisation that registers draftgate in managed settings and sets `allowManagedHooksOnly` has a
 * working gate, which only check 1 stops; so a switch says what it leaves running, and the verdict
 * is taken against where the registration is.
 *
 * Merged is user, project, local, flag, then managed settings, a later value replacing an earlier
 * one. So check 4 is the last source that sets the key: a `false` in a project's
 * `settings.local.json` undoes a `true` in `~/.claude/settings.json`, and a managed `false` undoes
 * both (trusted only when it is the one managed document, `hookSwitches`).
 *
 * ## "Managed" is not one file
 *
 * Claude Code composes its managed settings from: `remote-settings.json` in its config directory
 * (delivered by the organisation's server, cached there), MDM profiles under
 * `/Library/Managed Preferences/`, and `managed-settings.json` with every `managed-settings.d/*.json`
 * beside it (sorted, a name not starting with `.`). The tiers combine remote, then MDM, then the
 * file, by rules this does not reproduce; but all four switches are on the binary's list of
 * restrictive keys, where the most restrictive value binds, so any managed document that sets one
 * counts here (loud, never quiet, where a higher tier overrides a lower one).
 *
 * MDM profiles are binary plists Claude Code reads through `plutil`. Not parsed here: one that is
 * present is reported as unread, so "no switch found" means none was there.
 *
 * Safe mode (`--safe-mode`, `CLAUDE_CODE_SAFE_MODE`), bare mode (`--bare`, `CLAUDE_CODE_SIMPLE`)
 * and `--settings <file>` belong to one session, so no file can show them; the README says a send
 * from such a session is not reviewed.
 *
 * Pure: documents in, switches out.
 */

import { dirname, join } from 'node:path';
import type { RegistrationReport } from './registration';

/** Where a settings document sits. `managed` covers every managed tier read. */
export type SettingsScope = 'managed' | 'user' | 'project' | 'local';

export type HookSwitchKey = 'disableAllHooks' | 'allowManagedHooksOnly' | 'strictPluginOnlyCustomization';

/** One switch, set in one document, that keeps hooks from running. */
export interface HookSwitch {
  key: HookSwitchKey;
  path: string;
  scope: SettingsScope;
  /** What still runs: nothing, or only hooks registered in managed settings. */
  leaves: 'nothing' | 'managed';
}

/** One settings document, parsed, and where it sits. */
export interface ScopedSettings {
  path: string;
  scope: SettingsScope;
  settings: Readonly<Record<string, unknown>>;
}

/** The merge order of the sources below managed settings (the binary's, `flagSettings` unseen). */
const MERGE_ORDER: readonly SettingsScope[] = ['user', 'project', 'local'];

/**
 * Checks 1 to 3: the switches read from managed settings alone, in the resolver's order, and what
 * each leaves running. `strictPluginOnlyCustomization` locks hooks when `true` or a list naming them.
 */
const MANAGED_SWITCHES: readonly { key: HookSwitchKey; on: (v: unknown) => boolean; leaves: HookSwitch['leaves'] }[] = [
  { key: 'disableAllHooks', on: (v) => v === true, leaves: 'nothing' },
  { key: 'allowManagedHooksOnly', on: (v) => v === true, leaves: 'managed' },
  {
    key: 'strictPluginOnlyCustomization',
    on: (v) => v === true || (Array.isArray(v) && v.includes('hooks')),
    leaves: 'managed',
  },
];

/**
 * Every switch in these documents that keeps a hook from running, in the resolver's order. All of
 * them, unlike the resolver, so removing the first reported does not reveal a second; for check 4,
 * every `true` that would decide the merge once those after it went. `unreadManaged` counts managed
 * documents not read (MDM profiles), which decide whether a managed `false` can be trusted.
 */
export function hookSwitches(docs: readonly ScopedSettings[], unreadManaged = 0): HookSwitch[] {
  const managed = docs.filter((d) => d.scope === 'managed');
  const found: HookSwitch[] = [];
  const add = (doc: ScopedSettings, key: HookSwitchKey, leaves: HookSwitch['leaves']) =>
    found.push({ key, path: doc.path, scope: doc.scope, leaves });

  for (const { key, on, leaves } of MANAGED_SWITCHES) {
    for (const d of managed) if (on(d.settings[key])) add(d, key, leaves);
  }

  /*
   * Check 4. Managed settings merge last, so a managed value that is not `true` turns hooks on
   * whatever the user's file says, but only when it is the one managed document: between tiers a
   * lower `false` may be dropped. A managed `true` (check 1) does not end the chain: the user's
   * `true` below it is what an administrator lifting theirs would meet next.
   */
  const sole = managed.length === 1 && unreadManaged === 0 ? managed[0] : undefined;
  if (sole !== undefined && 'disableAllHooks' in sole.settings && sole.settings.disableAllHooks !== true) {
    return found;
  }
  const writers = docs
    .filter((d) => d.scope !== 'managed' && 'disableAllHooks' in d.settings)
    .sort((a, b) => MERGE_ORDER.indexOf(a.scope) - MERGE_ORDER.indexOf(b.scope));
  let first = writers.length;
  while (first > 0 && writers[first - 1]!.settings.disableAllHooks === true) first -= 1;
  for (const d of writers.slice(first)) add(d, 'disableAllHooks', 'managed');
  return found;
}

/**
 * The switches that stop a hook registered in these scopes; with none found, every switch does.
 * One registration in managed settings keeps the gate past every switch that leaves managed hooks.
 */
export function switchesStopping(
  switches: readonly HookSwitch[],
  registeredIn: readonly RegisteredIn[]
): HookSwitch[] {
  return switches.filter((s) => registeredIn.every((where) => stops(s, where)));
}

/**
 * Where a hook entry is registered: a settings scope, or a plugin's `hooks/hooks.json`;
 * `forced-plugin` when managed settings force that plugin on.
 */
export type RegisteredIn = SettingsScope | 'plugin' | 'forced-plugin';

/**
 * Does this switch stop an entry registered there? A managed one runs past every switch that
 * leaves managed hooks. A plugin's runs past `strictPluginOnlyCustomization`, which blocks hooks
 * "from user and project sources, so they can come only from plugins or managed settings", and not
 * past `allowManagedHooksOnly`, which blocks "user, project, local, and plugin hooks" (the settings
 * reference and the hooks page). `disableAllHooks` in a user's file stops a
 * plugin's hook too (measured: the gated call went through unreviewed).
 */
function stops(s: HookSwitch, where: RegisteredIn): boolean {
  if (where === 'managed') return s.leaves === 'nothing';
  if (where === 'plugin') return s.key !== 'strictPluginOnlyCustomization';
  // Exempt from `allowManagedHooksOnly` by name ("hooks from plugins force-enabled in managed
  // settings `enabledPlugins` are exempt"); nothing says it is from `disableAllHooks`.
  if (where === 'forced-plugin') return s.key === 'disableAllHooks';
  return true;
}

/**
 * The switches that stop some of the hook's entries while another keeps running: from the plugin,
 * the entry for the tools its own hook cannot match, in a settings file a switch reaches when it
 * spares plugins' hooks. Those tools then go unreviewed while the rest are reviewed. Only beside a
 * plugin: two entries in settings scopes match the same tools, so the one that runs covers them.
 */
export function switchesStoppingPart(
  switches: readonly HookSwitch[],
  registeredIn: readonly RegisteredIn[]
): HookSwitch[] {
  const plugin = registeredIn.some((w) => w === 'plugin' || w === 'forced-plugin');
  if (!plugin) return [];
  const settings = registeredIn.filter((w) => w !== 'plugin' && w !== 'forced-plugin');
  return switches.filter(
    (s) => !registeredIn.every((w) => stops(s, w)) && settings.some((w) => stops(s, w))
  );
}

/** A `managed-settings.d/` entry the binary reads: `*.json`, not starting with `.`. */
export const isDropIn = (name: string): boolean => name.endsWith('.json') && !name.startsWith('.');

/** The MDM preference domain Claude Code reads its profiles under (2.1.287). */
const MDM_DOMAIN = 'com.anthropic.claudecode';

/**
 * Where the managed tiers beyond `managed-settings.json` live, from the registration's source list
 * (so `CLAUDE_CONFIG_DIR` and the managed directory are spelled once). Paths read from the 2.1.287
 * binary:
 *
 *  - `remote`: `remote-settings.json` beside the user's `settings.json`, the server tier's cache;
 *  - `dropInDir`: `managed-settings.d/` beside `managed-settings.json`;
 *  - `profiles`: on macOS, `/Library/Managed Preferences/<user>/<domain>.plist` and the
 *    device-level `/Library/Managed Preferences/<domain>.plist`. Not read, only looked for.
 */
export function policySources(
  sources: readonly { path: string; scope: SettingsScope }[],
  platform: NodeJS.Platform,
  user: string
): { remote?: string; dropInDir?: string; profiles: string[] } {
  const managedFile = sources.find((s) => s.scope === 'managed')?.path;
  const userFile = sources.find((s) => s.scope === 'user')?.path;
  const profiles: string[] = [];
  if (platform === 'darwin') {
    if (user !== '') profiles.push(`/Library/Managed Preferences/${user}/${MDM_DOMAIN}.plist`);
    profiles.push(`/Library/Managed Preferences/${MDM_DOMAIN}.plist`);
  }
  return {
    ...(userFile !== undefined && { remote: join(dirname(userFile), 'remote-settings.json') }),
    ...(managedFile !== undefined && { dropInDir: join(dirname(managedFile), 'managed-settings.d') }),
    profiles,
  };
}

/** What `--doctor` is told: the reading and its limits. `cli/` gets it as `--doctor`'s exit code. */
export interface HooksReport {
  /** Switches that keep draftgate's hook from running as it is registered. Non-empty = no gate. */
  stopping: HookSwitch[];
  /** Switches that are set but leave this registration running (managed, or a plugin's). */
  spared: HookSwitch[];
  /** Where the hook's own entries are, which decides what a switch spares. */
  registeredIn: RegisteredIn[];
  /** Switches that stop the plugin's extra-tools entry while its own hook runs (`switchesStoppingPart`). */
  stoppingPart: HookSwitch[];
  /** Managed-settings sources read beyond the registration's own files, as its scan rows are. */
  policyFiles: RegistrationReport['scanned'];
  /** Managed-settings sources present on this machine that cannot be read here (MDM profiles). */
  unread: string[];
  /** The one project whose settings were read: a switch in any other project's is not seen. */
  projectDir?: string;
}

/** The verdict, from the parsed documents and where the registration was found. */
export function hooksReport(
  docs: readonly ScopedSettings[],
  registeredIn: readonly RegisteredIn[],
  extra: Partial<Pick<HooksReport, 'policyFiles' | 'unread' | 'projectDir'>> = {}
): HooksReport {
  const unread = extra.unread ?? [];
  const all = hookSwitches(docs, unread.length);
  const stopping = switchesStopping(all, registeredIn);
  return {
    stopping,
    spared: all.filter((s) => !stopping.includes(s)),
    registeredIn: [...registeredIn],
    stoppingPart: switchesStoppingPart(all, registeredIn),
    policyFiles: extra.policyFiles ?? [],
    unread,
    ...(extra.projectDir !== undefined && { projectDir: extra.projectDir }),
  };
}
