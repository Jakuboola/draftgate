/**
 * `draftgate register` and `draftgate doctor`, asserted where their consequences
 * are: the settings file a run leaves behind, and the exit code and stdout it answers with. Every
 * run is the real CLI in a subprocess, under a scratch HOME, `CLAUDE_CONFIG_DIR` and
 * `DRAFTGATE_HOME`, so nothing here can reach the settings of the person running the suite.
 *
 * `register` writes only from the plugin, so it runs here from an assembled plugin root, through
 * `bin/draftgate`, with a `tools.json` tool the plugin's own hook cannot match: the one entry it
 * writes is `extraToolsBlock`'s, through the plugin link in that `DRAFTGATE_HOME`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_ENTRY, PLUGIN_LINK_BASENAME } from '../src/hookModes';
import { PLUGIN_HOOK_TIMEOUT_S, loadToolMap } from '../../adapters/hook/src/main';
import { PLUGIN_LAUNCHER_IN_ROOT, extraToolsBlock } from '../../adapters/hook/src/pluginHooks';
import { DEFAULT_TOOL_MAP } from '../../adapters/hook/src/toolMap';
import { checkoutBlock } from '../../adapters/hook/test/checkoutEntry';
import { assembledRoot } from '../../adapters/hook/test/pluginRoot';

const CLI = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'draftgate-register-cli-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A tool of the operator's own, on a server and with a half no default map entry has. */
const NOTE_TOOL = 'mcp__notes__post_internal_note';

let n = 0;
/**
 * A machine of its own: a home, Claude Code's config dir in it, draftgate's with `NOTE_TOOL` in its
 * `tools.json`, a project dir, and the plugin installed at a root of its own.
 */
function machine() {
  const root = join(dir, `m${n++}`);
  const home = join(root, 'home');
  const config = join(home, '.claude');
  const project = join(root, 'project');
  const draftgate = join(root, 'draftgate');
  mkdirSync(project, { recursive: true });
  mkdirSync(draftgate, { recursive: true });
  writeFileSync(join(draftgate, 'tools.json'), JSON.stringify({ [NOTE_TOOL]: 'jira' }));
  const plugin = assembledRoot(join(root, 'plugin'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    DRAFTGATE_HOME: draftgate,
    DRAFTGATE_AUDIT_LOG: join(draftgate, 'audit.jsonl'),
  };
  // The project settings `--doctor` and `register` read come from the working directory, unless
  // Claude Code says otherwise -- and a suite run inside a session would otherwise inherit it.
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.DRAFTGATE_PLUGIN_ROOT;
  const spawned = (file: string, argv: string[]) => {
    const r = spawnSync(file, argv, { cwd: project, env, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const run = (...argv: string[]) => spawned(process.execPath, argv);
  return {
    home,
    config,
    project,
    settings: join(config, 'settings.json'),
    /** `draftgate register`, as the plugin's own `bin/draftgate` runs it. */
    register: (...extra: string[]) => spawned(join(plugin, PLUGIN_LAUNCHER_IN_ROOT), ['register', ...extra]),
    /** The same command from this checkout. */
    registerHere: () => run(CLI, 'register'),
    doctor: () => run(CLI, 'doctor'),
    hookDoctor: () => run(HOOK_ENTRY, '--doctor'),
    /** The one block `register` writes from this plugin root, for this machine's map. */
    expectedBlock: (): any => extraToolsBlock(loadToolMap(env), join(draftgate, PLUGIN_LINK_BASENAME), PLUGIN_HOOK_TIMEOUT_S),
    /** A checkout's entry for this checkout's hook, for this machine's map. */
    checkoutEntry: () => checkoutBlock(loadToolMap(env)),
    backups: () => (existsSync(config) ? readdirSync(config).filter((f) => f.includes('draftgate-backup')) : []),
  };
}

const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
const read = (p: string) => readFileSync(p, 'utf8');

/** A settings file shaped like a real one: tokens, permissions, another event's hook, an old entry. */
function lived(oldCommand: string) {
  return {
    env: { JIRA_TOKEN: 'SECRET-TOKEN', OTHER: 'SECRET-OTHER' },
    permissions: { deny: ['mcp__x__y'] },
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash ~/start.sh', timeout: 10 }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/guard.sh SECRET-IN-HOOK' }] },
        { matcher: '^(?:old)$', hooks: [{ type: 'command', command: oldCommand, timeout: 660 }] },
      ],
    },
    statusLine: { type: 'command', command: 'echo hi' },
  };
}
/**
 * An older install's entry: the bare launch, with no fail-closed wrapper, naming a checkout that has
 * since moved.
 */
const MOVED = `'/opt/homebrew/bin/bun' '/Users/someone/old/draftgate/adapters/hook/src/main.ts'`;

describe('draftgate register', () => {
  test('with no settings file, writes one holding exactly the registration', () => {
    const m = machine();
    const r = m.register();
    expect(r.code).toBe(0);
    expect(JSON.parse(read(m.settings))).toEqual({ hooks: { PreToolUse: [m.expectedBlock()] } });
    // A new file is the user's only, like the token store it becomes.
    expect(statSync(m.settings).mode & 0o777).toBe(0o600);
    expect(m.backups()).toEqual([]);
    expect(r.stdout).toContain('backup    none');
  });

  test('replaces an entry naming ANOTHER checkout, keeps everything else, and keeps a backup', () => {
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    const before = json(lived(MOVED));
    writeFileSync(m.settings, before, { mode: 0o644 });

    const r = m.register();
    expect(r.code).toBe(0);
    const after = JSON.parse(read(m.settings));
    const expected = lived(MOVED);
    expected.hooks.PreToolUse[1] = m.expectedBlock();
    expect(after).toEqual(expected);
    // Exactly one draftgate entry: the moved one was replaced, not joined.
    const commands = after.hooks.PreToolUse.flatMap((b: { hooks: { command: string }[] }) =>
      b.hooks.map((h) => h.command));
    expect(commands.filter((c: string) => c.includes('adapters/hook/src/main.ts'))).toHaveLength(1);
    // Byte for byte: the file was in Claude Code's own layout, so nothing outside the entry moved.
    expect(read(m.settings)).toBe(json(expected));
    expect(statSync(m.settings).mode & 0o777).toBe(0o644);

    const [backup] = m.backups();
    expect(read(join(m.config, backup!))).toBe(before);
    expect(statSync(join(m.config, backup!)).mode & 0o777).toBe(0o600);
    expect(r.stdout).toContain(join(m.config, backup!));
    expect(r.stdout).toContain("Replaced draftgate's entry where it stood.");
    expect(r.stdout).toContain('was       /Users/someone/old/draftgate/adapters/hook/src/main.ts');
    expect(r.stdout).toContain(`              ${NOTE_TOOL}`);
    // The diff names what changed and nothing that was already there.
    expect(r.stdout).toContain('-            "command": ' + JSON.stringify(MOVED) + ',');
    expect(r.stdout).toContain('+            "command": ' + JSON.stringify(m.expectedBlock().hooks[0].command) + ',');
    expect(r.stdout + r.stderr).not.toContain('SECRET');
  });

  test('a second run changes nothing and makes no second backup', () => {
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    writeFileSync(m.settings, json(lived(MOVED)));
    expect(m.register().code).toBe(0);
    const once = read(m.settings);
    const r = m.register();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already registered');
    expect(read(m.settings)).toBe(once);
    expect(m.backups()).toHaveLength(1);
  });

  test('duplicates collapse into one entry', () => {
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    const entry = (command: string) => ({ matcher: 'x', hooks: [{ type: 'command', command }] });
    writeFileSync(m.settings, json({
      hooks: { PreToolUse: [entry(MOVED), entry(`bun '${HOOK_ENTRY}'`)] },
    }));
    const r = m.register();
    expect(r.code).toBe(0);
    expect(JSON.parse(read(m.settings)).hooks.PreToolUse).toEqual([m.expectedBlock()]);
    expect(r.stdout).toContain('opened 2 review windows');
  });

  test('refuses a file it cannot parse, and writes nothing', () => {
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    const broken = '{ "env": { "A": "1" }, \n';
    writeFileSync(m.settings, broken);
    const r = m.register();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${m.settings} exists but is not valid JSON`);
    expect(r.stdout).toBe('');
    expect(read(m.settings)).toBe(broken);
    expect(m.backups()).toEqual([]);
  });

  test('refuses to add a second registration beside one in another settings file', () => {
    // Measured with exactly this pair: a project file's entry and another's both fire.
    const m = machine();
    mkdirSync(join(m.project, '.claude'), { recursive: true });
    const projectFile = join(m.project, '.claude', 'settings.local.json');
    writeFileSync(projectFile, json({
      hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: MOVED }] }] },
    }));
    const r = m.register();
    expect(r.code).toBe(1);
    // `realpathSync`: the project path comes from the working directory, which macOS resolves.
    expect(r.stderr).toContain(`draftgate is also registered in ${realpathSync(projectFile)}`);
    expect(existsSync(m.settings)).toBe(false);
  });

  test('refuses, rather than warns, when another settings file cannot be read', () => {
    // `install` reads exit 0 as done, and that file may hold a draftgate entry Claude Code can read.
    const m = machine();
    mkdirSync(join(m.project, '.claude'), { recursive: true });
    const projectFile = join(m.project, '.claude', 'settings.json');
    writeFileSync(projectFile, '{}', { mode: 0o000 });
    const r = m.register();
    chmodSync(projectFile, 0o600);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`could not read ${realpathSync(projectFile)}`);
    expect(existsSync(m.settings)).toBe(false);
  });

  test('a symlink to NOTHING is refused, and stays the link it was', () => {
    // It reads as absent, and a rename over it would cut the link the user made.
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    const nowhere = join(m.home, 'dotfiles', 'claude-settings.json');
    symlinkSync(nowhere, m.settings);
    const r = m.register();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`is a symlink to ${nowhere}, which does not exist`);
    expect(readlinkSync(m.settings)).toBe(nowhere);
    expect(existsSync(nowhere)).toBe(false);
  });

  test('a settings file that is a symlink stays one, and the file it points at is updated', () => {
    // A dotfiles repository is the usual reason. Renaming over the link would replace it with a
    // copy, and the backup must not land inside that repository either.
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    const dotfiles = join(m.home, 'dotfiles');
    mkdirSync(dotfiles);
    const realFile = join(dotfiles, 'claude-settings.json');
    writeFileSync(realFile, json({ env: { A: '1' } }));
    symlinkSync(realFile, m.settings);

    expect(m.register().code).toBe(0);
    expect(lstatSync(m.settings).isSymbolicLink()).toBe(true);
    expect(readlinkSync(m.settings)).toBe(realFile);
    expect(JSON.parse(read(realFile))).toEqual({ env: { A: '1' }, hooks: { PreToolUse: [m.expectedBlock()] } });
    expect(m.backups()).toHaveLength(1);
    expect(readdirSync(dotfiles)).toEqual(['claude-settings.json']);
  });

  test('takes no options', () => {
    const m = machine();
    const r = m.register('--force');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('draftgate register takes no options');
    expect(existsSync(m.settings)).toBe(false);
  });

  test('from a checkout it registers nothing, writes nothing, and says how to install the plugin', () => {
    // A checkout is not an install: an entry written from here would be a second hook beside the
    // plugin's, two windows for every send.
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    const before = json(lived(MOVED));
    writeFileSync(m.settings, before);
    const r = m.registerHere();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('this is a checkout of draftgate, not the draftgate plugin, so it registers nothing');
    expect(r.stderr).toContain('install.sh | sh');
    expect(r.stderr).toContain('/draftgate:setup');
    expect(read(m.settings)).toBe(before);
    expect(m.backups()).toEqual([]);
  });
});

/**
 * Each `doctor` hashes every input of the checkout's built window (`bundleState`): about 250ms warm
 * where `surface/dist` exists and seconds with a cold cache, past bun's 5s default for a test that
 * runs four.
 */
const DOCTOR_TIMEOUT_MS = 30_000;

describe('draftgate doctor', () => {
  test('is the hook\'s --doctor: the same stdout and the same exit code, registered or not', () => {
    const m = machine();
    // Not registered: a problem, exit 1, from both.
    const before = [m.doctor(), m.hookDoctor()];
    expect(before.map((r) => r.code)).toEqual([1, 1]);
    expect(before[0]!.stdout).toBe(before[1]!.stdout);
    expect(before[0]!.stdout).toContain('REGISTERED: not found');

    // A checkout's own entry, as a checkout install left it.
    mkdirSync(m.config, { recursive: true });
    writeFileSync(m.settings, json({ hooks: { PreToolUse: [m.checkoutEntry()] } }));
    const after = [m.doctor(), m.hookDoctor()];
    expect(after[0]!.code).toBe(after[1]!.code);
    expect(after[0]!.stdout).toBe(after[1]!.stdout);
    expect(after[0]!.stdout).toContain(`REGISTERED in ${m.settings}`);
    // The default map and NOTE_TOOL.
    const mapped = Object.keys(DEFAULT_TOOL_MAP).length + 1;
    expect(after[0]!.stdout).toContain(`All ${mapped} mapped tools are covered by a registered matcher.`);
  }, DOCTOR_TIMEOUT_MS);

  /*
   * From a dev checkout, once the machine's reviews run from another install (`~/.draftgate/app`).
   * That clone is not `ours`, so "not found" and advice to paste would be wrong: a second entry,
   * two windows per send. It names the install that runs now, and how to ask it.
   */
  test('registered for ANOTHER install: names it and its own doctor, and claims nothing about this map', () => {
    const m = machine();
    const other = join(m.home, '.draftgate', 'app');
    const otherHook = join(other, 'adapters', 'hook', 'src', 'main.ts');
    mkdirSync(dirname(otherHook), { recursive: true });
    writeFileSync(otherHook, '');
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'draftgate' }));
    mkdirSync(m.config, { recursive: true });
    writeFileSync(m.settings, json(lived(`'/opt/homebrew/bin/bun' '${otherHook}'`)));

    const r = m.doctor();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('REGISTERED for another install, not this checkout:');
    expect(r.stdout).toContain(`${m.settings} launches ${otherHook}`);
    expect(r.stdout).toContain(`\`bun '${otherHook}' --doctor\``);
    // None of this checkout's claims, which would all be about a hook nothing launches.
    expect(r.stdout).not.toContain('not found');
    expect(r.stdout).not.toContain('no registered matcher covers them');
    expect(r.stdout).not.toContain('Review deadline');
    expect(r.stdout).toContain('Settings files read');
    expect(r.stdout).toContain('1 problem(s): registered for another install.');
    expect(r.stdout + r.stderr).not.toContain('SECRET');

    // Twice in the same file is two hooks that both fire, and is counted as two.
    const twice = lived(`'/opt/homebrew/bin/bun' '${otherHook}'`);
    twice.hooks.PreToolUse.push(twice.hooks.PreToolUse[1]!);
    writeFileSync(m.settings, json(twice));
    expect(m.doctor().stdout).toContain('registered 2 times');
  }, DOCTOR_TIMEOUT_MS);

  test('registered for an install that is GONE: says so, and that the bare entry sends unreviewed', () => {
    const m = machine();
    mkdirSync(m.config, { recursive: true });
    writeFileSync(m.settings, json(lived(MOVED)));
    const r = m.doctor();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('REGISTERED for an install that is not there any more:');
    expect(r.stdout).toContain(`${m.settings} launches /Users/someone/old/draftgate/adapters/hook/src/main.ts, which does not exist`);
    expect(r.stdout).toContain('The bare entry lets Claude Code run every gated tool UNREVIEWED.');
  }, DOCTOR_TIMEOUT_MS);
});
