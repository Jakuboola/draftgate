/**
 * Hooks can be switched off, and that must never be silent.
 *
 * Three layers, because the consequence is visible at the last one only: the resolver's rules
 * (pure), what `--doctor` says about them, and a real `--doctor` against settings files in a scratch
 * home. The rules are the 2.1.287 binary's, cited in `hookSwitches.ts`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hookSwitches,
  hooksReport,
  isDropIn,
  policySources,
  switchesStopping,
  type ScopedSettings,
  type SettingsScope,
} from '../src/hookSwitches';
import { settingsPaths, settingsSources } from '../src/registration';
import { hookTimeoutSecondsFor } from '../src/main';
import { DEFAULT_TOOL_MAP } from '../src/toolMap';
import { DEFAULT_TIMEOUT_MS } from '../../../cli/src/review';
import { checkoutSettings } from './checkoutEntry';

const doc = (scope: SettingsScope, settings: Record<string, unknown>, path = `/${scope}.json`): ScopedSettings => ({
  path,
  scope,
  settings,
});

describe('hookSwitches: the resolver, as 2.1.287 runs it', () => {
  test('nothing set, nothing off', () => {
    expect(hookSwitches([doc('managed', {}), doc('user', { model: 'x' })])).toEqual([]);
  });

  test('managed disableAllHooks leaves NOTHING running', () => {
    expect(hookSwitches([doc('managed', { disableAllHooks: true })])).toEqual([
      { key: 'disableAllHooks', path: '/managed.json', scope: 'managed', leaves: 'nothing' },
    ]);
  });

  test('managed allowManagedHooksOnly leaves managed hooks', () => {
    expect(hookSwitches([doc('managed', { allowManagedHooksOnly: true })])).toEqual([
      { key: 'allowManagedHooksOnly', path: '/managed.json', scope: 'managed', leaves: 'managed' },
    ]);
  });

  test('strictPluginOnlyCustomization locks hooks when true or when it lists them, and only then', () => {
    const on = (value: unknown) =>
      hookSwitches([doc('managed', { strictPluginOnlyCustomization: value })]).map((s) => s.key);
    expect(on(true)).toEqual(['strictPluginOnlyCustomization']);
    expect(on(['skills', 'hooks'])).toEqual(['strictPluginOnlyCustomization']);
    expect(on(['skills', 'agents'])).toEqual([]);
    expect(on('hooks')).toEqual([]);
    expect(on(false)).toEqual([]);
  });

  test('every comparison is `=== true`: a string switches nothing', () => {
    expect(
      hookSwitches([
        doc('managed', { disableAllHooks: 'true', allowManagedHooksOnly: 1 }),
        doc('user', { disableAllHooks: 'true' }),
      ])
    ).toEqual([]);
  });

  test('the managed-only switches mean nothing outside managed settings', () => {
    // Read as `getSettingsForSource("policySettings")?.allowManagedHooksOnly`: a user who sets it
    // has switched off nothing, and saying otherwise would send them to edit the wrong file.
    expect(
      hookSwitches([doc('user', { allowManagedHooksOnly: true, strictPluginOnlyCustomization: true })])
    ).toEqual([]);
  });

  test('a user disableAllHooks leaves managed hooks', () => {
    expect(hookSwitches([doc('user', { disableAllHooks: true })])).toEqual([
      { key: 'disableAllHooks', path: '/user.json', scope: 'user', leaves: 'managed' },
    ]);
  });

  test('check 4 is a MERGE: the last source to set the key decides, in the binary order', () => {
    const scopes = (docs: ScopedSettings[]) => hookSwitches(docs).map((s) => s.scope);
    // A later source's `false` undoes an earlier `true`...
    expect(scopes([doc('user', { disableAllHooks: true }), doc('local', { disableAllHooks: false })])).toEqual([]);
    // ...and a later `true` wins over an earlier `false`, whatever order the documents arrive in.
    expect(scopes([doc('project', { disableAllHooks: true }), doc('user', { disableAllHooks: false })])).toEqual([
      'project',
    ]);
    // Managed settings merge LAST, so a managed `false` undoes every other source.
    expect(scopes([doc('user', { disableAllHooks: true }), doc('managed', { disableAllHooks: false })])).toEqual([]);
    // A value that is not `true` still overwrites: the merge copies it, and the check asks `=== true`.
    expect(scopes([doc('user', { disableAllHooks: true }), doc('project', { disableAllHooks: 'no' })])).toEqual([]);
  });

  test("a managed true does not hide the user's: an administrator lifting theirs meets it next", () => {
    const found = hookSwitches([doc('managed', { disableAllHooks: true }), doc('user', { disableAllHooks: true })]);
    expect(found.map((s) => `${s.scope}:${s.leaves}`)).toEqual(['managed:nothing', 'user:managed']);
  });

  test('a managed false is trusted only when it is the ONE managed document', () => {
    const user = doc('user', { disableAllHooks: true });
    // Several tiers: the binary chooses between them, and this one's `false` may be the one dropped.
    const twoTiers = [
      doc('managed', { disableAllHooks: false }, '/managed-settings.json'),
      doc('managed', { channelsEnabled: true }, '/remote-settings.json'),
      user,
    ];
    expect(hookSwitches(twoTiers).map((s) => s.path)).toEqual(['/user.json']);
    // An MDM profile nobody could read is a tier too.
    expect(hookSwitches([doc('managed', { disableAllHooks: false }), user], 1).map((s) => s.path)).toEqual([
      '/user.json',
    ]);
    expect(hookSwitches([doc('managed', { disableAllHooks: false }), user], 0)).toEqual([]);
  });

  test("check 4 reports every true that would decide once the ones after it went, and no further", () => {
    const paths = (docs: ScopedSettings[]) => hookSwitches(docs).map((s) => s.path);
    expect(paths([doc('user', { disableAllHooks: true }), doc('local', { disableAllHooks: true })])).toEqual([
      '/user.json',
      '/local.json',
    ]);
    // A `false` in between ends the chain: removing the local `true` turns hooks on.
    expect(
      paths([
        doc('user', { disableAllHooks: true }),
        doc('project', { disableAllHooks: false }),
        doc('local', { disableAllHooks: true }),
      ])
    ).toEqual(['/local.json']);
  });

  test('every managed document counts: the switches are restrictive keys', () => {
    const found = hookSwitches([
      doc('managed', { allowManagedHooksOnly: false }, '/managed-settings.json'),
      doc('managed', { allowManagedHooksOnly: true }, '/remote-settings.json'),
    ]);
    expect(found.map((s) => s.path)).toEqual(['/remote-settings.json']);
  });

  test('ALL switches are reported, so removing one cannot reveal another', () => {
    const found = hookSwitches([
      doc('managed', { allowManagedHooksOnly: true, strictPluginOnlyCustomization: true }),
      doc('user', { disableAllHooks: true }),
    ]);
    expect(found.map((s) => s.key)).toEqual([
      'allowManagedHooksOnly',
      'strictPluginOnlyCustomization',
      'disableAllHooks',
    ]);
  });
});

describe('switchesStopping: the verdict is taken against where the registration is', () => {
  const all = hookSwitches([
    doc('managed', { allowManagedHooksOnly: true }),
    doc('user', { disableAllHooks: true }),
  ]);

  test('a registration in user settings is stopped by every switch', () => {
    expect(switchesStopping(all, ['user'])).toEqual(all);
  });

  test('no registration found is judged where one would be pasted, which is not managed', () => {
    expect(switchesStopping(all, [])).toEqual(all);
  });

  test('a managed registration survives every switch that leaves managed hooks', () => {
    expect(switchesStopping(all, ['managed'])).toEqual([]);
    // One managed copy is enough: it is the one that fires.
    expect(switchesStopping(all, ['user', 'managed'])).toEqual([]);
  });

  test('...and not managed disableAllHooks, which leaves nothing', () => {
    const off = hookSwitches([doc('managed', { disableAllHooks: true })]);
    expect(switchesStopping(off, ['managed'])).toEqual(off);
  });

  test("a plugin's hook runs past strictPluginOnlyCustomization, and not past the other two", () => {
    const strict = hookSwitches([doc('managed', { strictPluginOnlyCustomization: ['hooks'] })]);
    expect(strict).toHaveLength(1);
    expect(switchesStopping(strict, ['plugin'])).toEqual([]);
    // The extra-tools entry beside it is in the user's settings, and that one is stopped.
    expect(switchesStopping(strict, ['user'])).toEqual(strict);
    expect(switchesStopping(all, ['plugin'])).toEqual(all);
  });

  test('a plugin managed settings force on runs past allowManagedHooksOnly, and not past disableAllHooks', () => {
    const managedOnly = hookSwitches([doc('managed', { allowManagedHooksOnly: true })]);
    expect(switchesStopping(managedOnly, ['forced-plugin'])).toEqual([]);
    const userOff = hookSwitches([doc('user', { disableAllHooks: true })]);
    expect(switchesStopping(userOff, ['forced-plugin'])).toEqual(userOff);
  });

  test("a switch that spares the plugin's hook and stops its extra-tools entry is named, not spared silently", () => {
    const strict = hookSwitches([doc('managed', { strictPluginOnlyCustomization: true })]);
    const r = hooksReport([doc('managed', { strictPluginOnlyCustomization: true })], ['plugin', 'user']);
    expect(r.stopping).toEqual([]);
    expect(r.stoppingPart).toEqual(strict);
    // Alone, the plugin's hook loses nothing; and two settings entries cover the same tools.
    expect(hooksReport([doc('managed', { strictPluginOnlyCustomization: true })], ['plugin']).stoppingPart).toEqual([]);
    expect(hooksReport([doc('managed', { allowManagedHooksOnly: true })], ['user', 'managed']).stoppingPart).toEqual([]);
  });

  test('hooksReport splits the switches it found into stopping and spared', () => {
    const r = hooksReport([doc('managed', { allowManagedHooksOnly: true })], ['managed']);
    expect(r.stopping).toEqual([]);
    expect(r.spared.map((s) => s.key)).toEqual(['allowManagedHooksOnly']);
  });

  test('an unread profile reaches the trust rule through hooksReport', () => {
    const docs = [doc('managed', { disableAllHooks: false }), doc('user', { disableAllHooks: true })];
    expect(hooksReport(docs, ['user']).stopping).toEqual([]);
    const r = hooksReport(docs, ['user'], { unread: ['/Library/Managed Preferences/x.plist'] });
    expect(r.stopping.map((s) => s.path)).toEqual(['/user.json']);
  });
});

describe('where the switches are read from', () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg' } as NodeJS.ProcessEnv;
  const home = () => '/home/u';

  test('the registration files, one list: settingsPaths is settingsSources without the scopes', () => {
    const sources = settingsSources(env, '/proj', home, 'darwin');
    expect(sources.map((s) => s.path)).toEqual(settingsPaths(env, '/proj', home, 'darwin'));
    expect(sources.map((s) => s.scope)).toEqual(['managed', 'user', 'project', 'local']);
  });

  test('the managed tiers beyond managed-settings.json, at the paths the binary reads', () => {
    expect(policySources(settingsSources(env, '/proj', home, 'darwin'), 'darwin', 'u')).toEqual({
      remote: '/cfg/remote-settings.json',
      dropInDir: '/Library/Application Support/ClaudeCode/managed-settings.d',
      profiles: [
        '/Library/Managed Preferences/u/com.anthropic.claudecode.plist',
        '/Library/Managed Preferences/com.anthropic.claudecode.plist',
      ],
    });
  });

  test('no CLAUDE_CONFIG_DIR means ~/.claude, as for settings.json; no MDM profiles off macOS', () => {
    const p = policySources(settingsSources({}, undefined, home, 'linux'), 'linux', 'u');
    expect(p.remote).toBe('/home/u/.claude/remote-settings.json');
    expect(p.dropInDir).toBe('/etc/claude-code/managed-settings.d');
    expect(p.profiles).toEqual([]);
  });

  test('a user name the OS would not give drops only the per-user profile', () => {
    expect(policySources(settingsSources(env, undefined, home, 'darwin'), 'darwin', '').profiles).toEqual([
      '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    ]);
  });

  test('drop-ins: *.json, not hidden', () => {
    expect(['10-hooks.json', '.hidden.json', 'notes.txt', 'a.json.bak'].filter(isDropIn)).toEqual([
      '10-hooks.json',
    ]);
  });
});

/*
 * The boundary: a real `--doctor`, reading real files a test can own (the managed file is a system
 * path, so its rules are the pure cases above). Each run gets its own Claude config directory,
 * draftgate home, project and registration, so only the switch differs from the control.
 *
 * Skipped on a Mac whose own managed settings for Claude Code exist: the run reads them, so the
 * control could not be a control there.
 */
const MACHINE_MANAGED = [
  '/Library/Application Support/ClaudeCode',
  '/Library/Managed Preferences/com.anthropic.claudecode.plist',
].some((p) => existsSync(p));

describe.skipIf(MACHINE_MANAGED)('--doctor, run for real', () => {
  const HOOK = join(import.meta.dir, '..', 'src', 'main.ts');
  const dir = mkdtempSync(join(tmpdir(), 'draftgate-hookswitch-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The registration: a checkout's entry for this hook, the same for every home here.
  const registration: Record<string, unknown> = JSON.parse(
    checkoutSettings(DEFAULT_TOOL_MAP, { hook: HOOK })
  );

  const doctorIn = (files: { config?: Record<string, unknown>; remote?: unknown; project?: Record<string, unknown> }) => {
    const home = mkdtempSync(join(dir, 'home-'));
    const config = join(home, 'claude');
    const project = join(home, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    mkdirSync(config);
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      DRAFTGATE_HOME: join(home, 'dg'),
      DRAFTGATE_AUDIT_LOG: join(home, 'dg', 'audit.jsonl'),
      CLAUDE_PROJECT_DIR: '',
    };
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ ...registration, ...files.config }));
    if (files.remote !== undefined) writeFileSync(join(config, 'remote-settings.json'), JSON.stringify(files.remote));
    if (files.project) writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify(files.project));
    const r = spawnSync(process.execPath, [HOOK, '--doctor'], { encoding: 'utf8', cwd: project, env, timeout: 30_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, config };
  };

  test('the control: the same install with no switch says hooks are on', () => {
    const r = doctorIn({});
    // 0, so the 1s below are the switch's and nothing else's.
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Hooks are on in every settings file read.');
    expect(r.stdout).not.toContain('hooks turned off');
    // The remote tier is listed as looked for, so its absence is a reading, not an omission.
    expect(r.stdout).toContain(`${join(r.config, 'remote-settings.json')}  absent`);
  });

  test('disableAllHooks in the user settings: exit 1, the sentence, the file', () => {
    const r = doctorIn({ config: { disableAllHooks: true } });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('your Claude Code has hooks turned off, so draftgate cannot run');
    expect(r.stdout).toContain(`disableAllHooks: true in ${join(r.config, 'settings.json')}`);
    expect(r.stdout).toContain('hooks turned off.');
  });

  test("a project's settings.local.json setting it back to false turns them on again", () => {
    const r = doctorIn({ config: { disableAllHooks: true }, project: { disableAllHooks: false } });
    expect(r.stdout).not.toContain('hooks turned off');
    expect(r.stdout).toContain('Hooks are on in every settings file read.');
  });

  test("the organisation's server-delivered settings are managed settings, and are read", () => {
    const r = doctorIn({ remote: { allowManagedHooksOnly: true } });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain(`allowManagedHooksOnly: true in ${join(r.config, 'remote-settings.json')} (managed)`);
  });

  test('a remote-settings.json that is not settings is a problem, not a silence', () => {
    const r = doctorIn({ remote: ['not', 'an', 'object'] });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('remote-settings.json  UNREADABLE: ');
    expect(r.stdout).toContain('remote-settings.json is not a JSON object');
  });
});
