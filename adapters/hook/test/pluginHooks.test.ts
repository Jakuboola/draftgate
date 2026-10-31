/**
 * The plugin's own files: the committed `plugin/hooks/hooks.json` and `plugin/bin/draftgate`, run
 * the way Claude Code runs them: `${CLAUDE_PLUGIN_ROOT}` substituted as plain text, then `/bin/sh -c`
 * with the payload on stdin. The hook is a fake shell script and bun is `/bin/sh`, as in
 * `hookCommand.test.ts` (which covers the shared buffering), except where a test says otherwise; this
 * file covers the root and finding bun. A root is assembled as a release lays one out, with the
 * runtime linked beside `plugin/`'s files.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_HOOKS_IN_ROOT,
  PLUGIN_LAUNCHER_IN_ROOT,
  PLUGIN_ROOT_REF,
  PLUGIN_SESSION_TIMEOUT_S,
  extraToolsBlock,
  isPluginFailClosed,
  pluginFallbackDecisions,
  pluginRootOf,
  uncoveredByPlugin,
} from '../src/pluginHooks';
import { OLD_ENTRY, PLUGIN_HOOK_TIMEOUT_S } from '../src/main';
import { CHOICE_HALVES, NOT_OWN_SERVERS, OTHER_TOOLS_GUIDE, OTHER_TOOL_FORMAT } from '../src/reconcile';
import { COMMAND_HELP } from '../../../cli/src/args';
import { profiles } from '../../../core/src/index';
import { SESSION_VAR } from '../src/setupNames';
import { PLUGIN_REVIEW_CEILING_MS } from '../src/reviewTimeout';
import { checkoutBlock } from './checkoutEntry';
import { assembledRoot as assemble } from './pluginRoot';
import { BUN_PLACES, FIND_BUN, PLUGIN_FAIL_CLOSED_SCRIPT, commandTokens, readCommand, shQuote } from '../src/hookCommand';
import { firesBesidePlugin, inspectRegistration, type SettingsRead } from '../src/registration';
import { reviewDeadline } from '../src/reviewTimeout';
import { DEFAULT_TOOL_MAP, matcherFor, mergeToolConfig, toolHalvesOf, type ToolMap } from '../src/toolMap';
import { HOOK_IN_REPO, PLUGIN_LINK_BASENAME, SETUP_NAMES_BASENAME } from '../../../cli/src/hookModes';
import { PLUGIN_ID } from '../../../cli/src/claudePlugin';
import { REMEDY } from '../../../core/src/remedies';

const REPO = join(import.meta.dir, '../../..');
const PLUGIN = join(REPO, 'plugin');
const HOOK_SELF = join(REPO, HOOK_IN_REPO);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'draftgate-pluginhooks-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const shipped = readFileSync(join(PLUGIN, PLUGIN_HOOKS_IN_ROOT), 'utf8');
const entry = JSON.parse(shipped).hooks.PreToolUse[0];
const command: string = entry.hooks[0].command;
const sessionHooks = JSON.parse(shipped).hooks.SessionStart;
const asks = pluginFallbackDecisions();

/** A plugin root holding a fake hook that prints `out` and exits `code`. */
function fakeRoot(name: string, hook: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, HOOK_IN_REPO, '..'), { recursive: true });
  writeFileSync(join(root, HOOK_IN_REPO), hook);
  return root;
}
const shHook = (out: string, code: number) => `cat >/dev/null\nprintf '%s' '${out}'\nexit ${code}\n`;

/** A directory holding `bun`, which is `/bin/sh`: a fake hook is a shell script. */
const fakeBunDir = join(dir, 'bunbin');
mkdirSync(fakeBunDir);
symlinkSync('/bin/sh', join(fakeBunDir, 'bun'));
const FAKE_PATH = `${fakeBunDir}:/usr/bin:/bin`;

/** A home with no bun in it, for the runs that must not find one there. */
const NO_HOME = join(dir, 'nohome');
mkdirSync(NO_HOME);

/** Run `cmd` as Claude Code runs a plugin hook: the root substituted as text, then `sh -c`. */
function run(root: string, env: Record<string, string>, cmd = command) {
  return spawnSync('/bin/sh', ['-c', cmd.split(PLUGIN_ROOT_REF).join(root)], {
    input: '{"tool_name":"x"}',
    env: { HOME: NO_HOME, TMPDIR: dir, ...env },
    encoding: 'utf8',
  });
}

/** The fixed places `FIND_BUN` tries after PATH and `~/.bun/bin` that hold a bun on this machine. */
const systemBun = BUN_PLACES.map((p) => p.sh).filter((p) => p.startsWith('/')).find((p) => existsSync(p));

/** The command again from its words, with `script` in place of the shipped one if given. */
function rebuild(t: readonly string[], script = t[2]!): string {
  return [t[0], t[1], shQuote(script), t[3], `"${PLUGIN_ROOT_REF}"`, ...t.slice(5).map(shQuote)].join(' ');
}

const realpathOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

describe('the committed plugin files', () => {
  test('are what the generator flags print, whatever this machine\'s tools.json says', () => {
    // A tools.json that cannot even be read: the files ship to everyone, so nothing of it may reach
    // them, and the generators must not need it.
    const home = join(dir, 'generator-home');
    mkdirSync(home);
    writeFileSync(join(home, 'tools.json'), '{ not json');
    for (const [flag, file] of [
      ['--print-plugin-hooks', PLUGIN_HOOKS_IN_ROOT],
      ['--print-plugin-launcher', PLUGIN_LAUNCHER_IN_ROOT],
    ] as const) {
      const r = spawnSync(process.execPath, [HOOK_SELF, flag], {
        encoding: 'utf8',
        env: { ...process.env, DRAFTGATE_HOME: home },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(readFileSync(join(PLUGIN, file), 'utf8'));
    }
  });

  test('bin/draftgate is executable', () => {
    expect(statSync(join(PLUGIN, PLUGIN_LAUNCHER_IN_ROOT)).mode & 0o111).toBe(0o111);
  });

  test('plugin.json names the plugin and a release version', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
    expect(manifest.name).toBe('draftgate');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the shipped registration', () => {
  test('covers every default tool, and an alias of a known half under any server', () => {
    const matches = (name: string) => new RegExp(entry.matcher).test(name);
    for (const name of Object.keys(DEFAULT_TOOL_MAP)) expect(matches(name)).toBe(true);
    expect(matches('mcp__my_slack__slack_send_message')).toBe(true);
    // Not every MCP tool: an ordinary call never starts the hook, and a longer name is another tool.
    expect(matches('mcp__my_slack__slack_send_message_draft')).toBe(false);
    expect(matches('mcp__my_slack__slack_read_channel')).toBe(false);
  });

  test('a status message ending in no ellipsis, since the spinner adds its own', () => {
    for (const statusMessage of [entry.hooks[0].statusMessage, extraToolsBlock(withNote, '/root', 9)!.hooks[0].statusMessage]) {
      expect(statusMessage).not.toMatch(/(\.|…)$/);
    }
  });

  test('leaves the root for Claude Code to fill in, once, as one quoted word', () => {
    expect(command.split(PLUGIN_ROOT_REF)).toHaveLength(2);
    expect(command).toContain(`"${PLUGIN_ROOT_REF}"`);
  });

  test('is recognised as the fail-closed plugin wrapper', () => {
    expect(isPluginFailClosed(command)).toBe(true);
  });

  test('a wrapper missing an answer, with one that is not an ask, or with another script is not', () => {
    const t = commandTokens(command);
    expect(isPluginFailClosed(rebuild(t))).toBe(true);
    expect(isPluginFailClosed(rebuild(t.slice(0, 7)))).toBe(false);
    expect(isPluginFailClosed(rebuild([...t.slice(0, 7), '{"hookSpecificOutput":{}}']))).toBe(false);
    expect(isPluginFailClosed(rebuild(t, `${t[2]}; true`))).toBe(false);
    expect(isPluginFailClosed(command.replace(`"${PLUGIN_ROOT_REF}"`, '/some/root'))).toBe(false);
  });
});

describe('the plugin wrapper, run as Claude Code runs it', () => {
  test('replays the hook\'s output byte for byte on exit 0, from a root holding a space', () => {
    const r = run(fakeRoot('root with space', shHook('{"decision":1}', 0)), { PATH: FAKE_PATH });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{"decision":1}');
  });

  test('tells the hook its root, whether or not Claude Code exports CLAUDE_PLUGIN_ROOT', () => {
    const root = fakeRoot('told root', 'cat >/dev/null\nprintf %s "$DRAFTGATE_PLUGIN_ROOT"\n');
    // ...which `pluginRootOf` accepts (below), so the hook finds its own registration.
    expect(run(root, { PATH: FAKE_PATH }).stdout).toBe(root);
  });

  test('replays an EMPTY output as empty (a declined tool)', () => {
    expect(run(fakeRoot('empty', shHook('', 0)), { PATH: FAKE_PATH }).stdout).toBe('');
  });

  test('asks when the root is gone', () => {
    const r = run(join(dir, 'gone'), { PATH: FAKE_PATH });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${asks.hookGone}\n`);
  });

  test('asks when the root is there and its hook is not', () => {
    const root = join(dir, 'hookless');
    mkdirSync(root);
    expect(run(root, { PATH: FAKE_PATH }).stdout).toBe(`${asks.hookGone}\n`);
  });

  test('asks, and drops the partial output, when the hook exits non-zero', () => {
    const r = run(fakeRoot('dies', shHook('{"half', 1)), { PATH: FAKE_PATH });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${asks.noDecision}\n`);
  });

  test('finds bun in ~/.bun/bin when PATH has none, ahead of any other place', () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.bun/bin'), { recursive: true });
    symlinkSync('/bin/sh', join(home, '.bun/bin/bun'));
    // A shell script: only the fake bun in ~/.bun/bin can run it and answer this.
    const r = run(fakeRoot('homebun', shHook('{"decision":2}', 0)), { PATH: '/usr/bin:/bin', HOME: home });
    expect(r.stdout).toBe('{"decision":2}');
  });

  test('takes PATH\'s bun first', () => {
    const home = join(dir, 'home-path-first');
    mkdirSync(join(home, '.bun/bin'), { recursive: true });
    writeFileSync(join(home, '.bun/bin/bun'), '#!/bin/sh\nprintf wrong\n', { mode: 0o755 });
    const r = run(fakeRoot('pathbun', shHook('{"decision":3}', 0)), { PATH: FAKE_PATH, HOME: home });
    expect(r.stdout).toBe('{"decision":3}');
  });

  test('a directory named bun is not a bun: the search goes on past it', () => {
    const home = join(dir, 'home-bun-dir');
    mkdirSync(join(home, '.bun/bin/bun'), { recursive: true });
    // JavaScript, so a system bun further down the list can answer it. Taking the directory would
    // fail to launch it and answer "no decision" instead.
    const root = fakeRoot('bundir', 'process.stdout.write(\'{"decision":4}\');\n');
    const r = run(root, { PATH: '/usr/bin:/bin', HOME: home });
    expect(r.stdout).toBe(systemBun === undefined ? `${asks.bunGone}\n` : '{"decision":4}');
  });

  test.skipIf(systemBun === undefined)('finds a system bun when PATH and ~/.bun/bin have none', () => {
    // JavaScript, not a shell script: only a real bun answers this.
    const root = fakeRoot('systembun', 'process.stdout.write(\'{"decision":5}\');\n');
    expect(run(root, { PATH: '/usr/bin:/bin' }).stdout).toBe('{"decision":5}');
  });

  test('what happens once no bun is found: the shipped script with the search finding none', () => {
    // On every machine: the search replaced by its empty result, the rest of the script as shipped.
    const t = commandTokens(command);
    expect(t[2]!.split(FIND_BUN)).toHaveLength(2);
    const noSearch = rebuild(t, t[2]!.replace(FIND_BUN, 'b='));
    const r = run(fakeRoot('searchless', shHook('{"decision":1}', 0)), { PATH: FAKE_PATH }, noSearch);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${asks.bunGone}\n`);
  });

  test('each answer is a complete PreToolUse ask on one line, naming no path', () => {
    for (const ask of Object.values(asks)) {
      expect(ask).not.toContain('\n');
      expect(JSON.parse(ask).hookSpecificOutput.permissionDecision).toBe('ask');
      expect(ask).not.toContain(REPO);
    }
    expect(PLUGIN_FAIL_CLOSED_SCRIPT).not.toContain("'");
  });
});

/** A plugin root laid out as a release lays one out, in this file's scratch directory. */
const assembledRoot = (name: string) => assemble(join(dir, name));

/** An environment with nothing of this machine's draftgate or Claude Code in it. */
function scratchEnv(name: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = join(dir, name);
  mkdirSync(home);
  return {
    HOME: home,
    TMPDIR: dir,
    PATH: `${join(process.execPath, '..')}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DRAFTGATE_HOME: join(home, '.draftgate'),
    DRAFTGATE_AUDIT_LOG: '',
    ...extra,
  };
}

/**
 * Claude Code's record of `root` as the installed, enabled plugin, shaped as `claude plugin install`
 * leaves it (`claudePlugin.ts`): an entry in `installed_plugins.json` and `enabledPlugins` in the
 * user's settings.
 */
function recordInstall(env: Record<string, string>, root: string, enabled = true): void {
  const plugins = join(env.CLAUDE_CONFIG_DIR!, 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: root, version: '0.1.0' }] } })
  );
  const settings = join(env.CLAUDE_CONFIG_DIR!, 'settings.json');
  const before = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
  writeFileSync(settings, JSON.stringify({ ...before, enabledPlugins: { [PLUGIN_ID]: enabled } }, null, 2));
}

describe('the SessionStart hook, run as Claude Code runs it', () => {
  /** A draftgate directory, with the plugin link pointing at `target` when given. */
  const home = (name: string, target?: string) => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    if (target !== undefined) symlinkSync(target, join(d, PLUGIN_LINK_BASENAME));
    return d;
  };
  const session = (root: string, env: Record<string, string>) =>
    run(root, { PATH: '/usr/bin:/bin', ...env }, sessionHooks[0].hooks[0].command);
  const link = (d: string) => join(d, PLUGIN_LINK_BASENAME);

  test('is one command for a new or resumed session, at a short timeout', () => {
    expect(sessionHooks).toHaveLength(1);
    expect(sessionHooks[0].matcher).toBe('startup|resume');
    expect(sessionHooks[0].hooks).toEqual([{ type: 'command', command: sessionHooks[0].hooks[0].command, timeout: PLUGIN_SESSION_TIMEOUT_S }]);
    expect(sessionHooks[0].hooks[0].command.split(PLUGIN_ROOT_REF)).toHaveLength(2);
  });

  test('points the link at the root this session runs, silently', () => {
    const oldRoot = fakeRoot('session-old', '');
    const newRoot = fakeRoot('session new', '');
    const d = home('session-home', oldRoot);
    const r = session(newRoot, { DRAFTGATE_HOME: d });
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(readlinkSync(link(d))).toBe(newRoot);
    // Renamed over the link, not moved into the directory it pointed at, and nothing left beside it.
    expect(readdirSync(oldRoot)).toEqual(['adapters']);
    expect(readdirSync(d)).toEqual([PLUGIN_LINK_BASENAME]);
  });

  test('finds draftgate\'s directory under HOME when DRAFTGATE_HOME is not set', () => {
    const newRoot = fakeRoot('session-home-default-root', '');
    const h = join(dir, 'session-default');
    const d = home(join('session-default', '.draftgate'), '/nowhere');
    expect(session(newRoot, { HOME: h }).status).toBe(0);
    expect(readlinkSync(link(d))).toBe(newRoot);
  });

  test('makes no link and no directory when there is none: only register makes it', () => {
    const root = fakeRoot('session-none-root', '');
    const d = join(dir, 'session-none');
    const r = session(root, { DRAFTGATE_HOME: d });
    expect([r.status, r.stdout]).toEqual([0, '']);
    expect(existsSync(d)).toBe(false);
    // A draftgate directory with no link in it gets none either.
    const there = home('session-none-there');
    expect(session(root, { DRAFTGATE_HOME: there }).status).toBe(0);
    expect(readdirSync(there)).toEqual([]);
  });

  test('leaves the link alone for a root with no hook, or a path there that is not a link', () => {
    const oldRoot = fakeRoot('session-keep-old', '');
    const d = home('session-keep', oldRoot);
    for (const root of [join(dir, 'session-empty-root'), '']) {
      const r = session(root, { DRAFTGATE_HOME: d });
      expect([r.status, r.stdout]).toEqual([0, '']);
      expect(readlinkSync(link(d))).toBe(oldRoot);
    }
    const notLink = home('session-dir');
    mkdirSync(link(notLink));
    expect(session(fakeRoot('session-dir-root', ''), { DRAFTGATE_HOME: notLink }).status).toBe(0);
    expect(lstatSync(link(notLink)).isDirectory()).toBe(true);
  });

  test('exits 0 and prints nothing when it cannot write the link', () => {
    const oldRoot = fakeRoot('session-ro-old', '');
    const d = home('session-ro', oldRoot);
    chmodSync(d, 0o555);
    try {
      const r = session(fakeRoot('session-ro-new', ''), { DRAFTGATE_HOME: d });
      expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
      expect(readlinkSync(link(d))).toBe(oldRoot);
    } finally {
      chmodSync(d, 0o755);
    }
  });
});

describe('the real hook, through the plugin wrapper', () => {
  test('a tool the map does not know is denied', () => {
    const root = assembledRoot('real-root');
    const r = run(root, scratchEnv('realhome', { CLAUDE_PLUGIN_ROOT: root }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('pluginRootOf', () => {
  const realpath = realpathOrNull;
  const root = assembledRoot('rootof');

  test('CLAUDE_PLUGIN_ROOT, in a hook, when its hook is this one', () => {
    expect(pluginRootOf({ CLAUDE_PLUGIN_ROOT: root }, HOOK_SELF, realpath)).toBe(root);
  });

  test('DRAFTGATE_PLUGIN_ROOT, from bin/draftgate, the same way', () => {
    expect(pluginRootOf({ DRAFTGATE_PLUGIN_ROOT: root }, HOOK_SELF, realpath)).toBe(root);
  });

  test('a root whose hook is another file is not this hook\'s', () => {
    const other = fakeRoot('other-plugin', shHook('', 0));
    expect(pluginRootOf({ CLAUDE_PLUGIN_ROOT: other }, HOOK_SELF, realpath)).toBeNull();
    expect(pluginRootOf({ CLAUDE_PLUGIN_ROOT: join(dir, 'nowhere') }, HOOK_SELF, realpath)).toBeNull();
    // And the other variable still counts when the first names somewhere else.
    expect(pluginRootOf({ CLAUDE_PLUGIN_ROOT: other, DRAFTGATE_PLUGIN_ROOT: root }, HOOK_SELF, realpath)).toBe(root);
  });

  test('neither set, or set empty, is no plugin', () => {
    expect(pluginRootOf({}, HOOK_SELF, realpath)).toBeNull();
    expect(pluginRootOf({ CLAUDE_PLUGIN_ROOT: '' }, HOOK_SELF, realpath)).toBeNull();
  });
});

describe('the plugin registration, read back', () => {
  const PLUGIN_HOOKS = '/plugin/hooks/hooks.json';
  const inspect = (files: Record<string, string>, toolMap: ToolMap = DEFAULT_TOOL_MAP) =>
    inspectRegistration({
      read: (p): SettingsRead => (p in files ? { kind: 'text', text: files[p]! } : { kind: 'absent' }),
      realpath: () => null,
      declined: [],
      paths: ['/home/.claude/settings.json'],
      hookPath: '/plugin/adapters/hook/src/main.ts',
      toolMap,
      pluginHooksPath: PLUGIN_HOOKS,
    });

  test('the shipped file is this hook\'s registration, fail-closed, with its ceiling', () => {
    const report = inspect({ [PLUGIN_HOOKS]: shipped });
    expect(report.ours).toEqual([
      { source: PLUGIN_HOOKS, matcher: entry.matcher, failClosed: true, timeout: entry.hooks[0].timeout },
    ]);
    expect(report.unregistered).toEqual([]);
    expect(report.scanned[0]).toEqual({ path: PLUGIN_HOOKS, present: true });
  });

  test('the deadline clamp reads the ceiling: a review under it is granted, one over it is held to it', () => {
    const registered = inspect({ [PLUGIN_HOOKS]: shipped }).registeredTimeoutMs;
    expect(registered).toBe(PLUGIN_HOOK_TIMEOUT_S * 1000);
    expect(reviewDeadline(900_000, registered)).toEqual({ ms: 900_000, wantedMs: 900_000, basis: { kind: 'asked' } });
    expect(reviewDeadline(2 * PLUGIN_REVIEW_CEILING_MS, registered).ms).toBe(PLUGIN_REVIEW_CEILING_MS);
  });

  test('without it, nothing is registered and the clamp assumes the event default', () => {
    const report = inspect({});
    expect(report.ours).toEqual([]);
    expect(report.registeredTimeoutMs).toBeUndefined();
    expect(report.scanned[0]).toEqual({ path: PLUGIN_HOOKS, present: false });
  });

  test('a tools.json tool with a new half is one the shipped matcher does not cover', () => {
    const map: ToolMap = {
      ...DEFAULT_TOOL_MAP,
      mcp__notes__post_internal_note: { ...DEFAULT_TOOL_MAP['mcp__claude_ai_Slack__slack_send_message']! },
    };
    expect(inspect({ [PLUGIN_HOOKS]: shipped }, map).unregistered).toEqual(['mcp__notes__post_internal_note']);
  });
});

describe('draftgate doctor, through bin/draftgate', () => {
  const doctor = (launch: string[], env: Record<string, string>, cwd = dir) =>
    spawnSync(launch[0]!, [...launch.slice(1), 'doctor'], { encoding: 'utf8', env, cwd, timeout: 60_000 });

  test('reads the plugin\'s registration back, with its timeout', () => {
    const root = assembledRoot('doctor-root');
    const r = doctor([join(root, PLUGIN_LAUNCHER_IN_ROOT)], scratchEnv('doctorhome'));
    expect(r.stdout).toContain(`REGISTERED in ${join(root, PLUGIN_HOOKS_IN_ROOT)}`);
    expect(r.stdout).toContain(`timeout ${PLUGIN_HOOK_TIMEOUT_S}s`);
    expect(r.stdout).not.toContain('REGISTERED: not found');
  });

  test('run by a relative path with CDPATH set, it still finds its root', () => {
    const root = assembledRoot('doctor-cdpath');
    // A `cd` that goes through CDPATH prints the directory, which would land in `root`.
    const r = doctor([PLUGIN_LAUNCHER_IN_ROOT], scratchEnv('cdpathhome', { CDPATH: root }), root);
    expect(r.stdout).toContain(`REGISTERED in ${join(root, PLUGIN_HOOKS_IN_ROOT)}`);
  });

  test('the same CLI run without the launcher reads no plugin, so the launcher is what tells it', () => {
    const root = assembledRoot('doctor-bare');
    const r = doctor([process.execPath, join(root, 'cli/src/main.ts')], scratchEnv('barehome'));
    expect(r.stdout).toContain('REGISTERED: not found');
  });

  test('without bun it says how to install it and exits 1', () => {
    const root = assembledRoot('launcher-nobun');
    // The launcher's own search, with no bun anywhere it looks: run where no system bun exists, or
    // with the search replaced by its empty result, as above.
    const launcher = readFileSync(join(root, PLUGIN_LAUNCHER_IN_ROOT), 'utf8');
    expect(launcher.split(FIND_BUN)).toHaveLength(2);
    writeFileSync(join(root, PLUGIN_LAUNCHER_IN_ROOT), launcher.replace(FIND_BUN, 'b='));
    const r = doctor([join(root, PLUGIN_LAUNCHER_IN_ROOT)], { HOME: NO_HOME, PATH: '/usr/bin:/bin' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('curl -fsSL https://bun.sh/install | bash');
  });
});

/*
 * The settings entry `register` writes from the plugin, for the tools the plugin's fixed matcher
 * cannot match: a `tools.json` tool with a tool half the default map does not have.
 */
const NOTE_TOOL = 'mcp__notes__post_internal_note';
const withNote: ToolMap = {
  ...DEFAULT_TOOL_MAP,
  [NOTE_TOOL]: { ...DEFAULT_TOOL_MAP['mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue']! },
};
const covers = (matcher: string, name: string) => new RegExp(matcher).test(name);
/** A checkout's settings entry command, launching the hook of a checkout at `root`. */
const checkoutCommandAt = (root: string) => checkoutBlock(DEFAULT_TOOL_MAP, { hook: join(root, HOOK_IN_REPO), timeoutS: 9 }).hooks[0].command;
/** Every tool name the plugin's own hook fires for that a test below can name. */
const pluginNames = [...Object.keys(DEFAULT_TOOL_MAP), 'mcp__my_slack__slack_send_message', 'mcp__x__save_issue'];

describe('the extra-tools entry', () => {
  test('is not needed when the plugin covers every tool, an alias of a known half included', () => {
    expect(extraToolsBlock(DEFAULT_TOOL_MAP, '/root', 9)).toBeNull();
    const alias = { ...DEFAULT_TOOL_MAP, mcp__my_slack__slack_send_message: DEFAULT_TOOL_MAP['mcp__claude_ai_Slack__slack_send_message']! };
    expect(uncoveredByPlugin(alias)).toEqual({});
    expect(extraToolsBlock(alias, '/root', 9)).toBeNull();
  });

  test('matches the new tool, and its half under any server, and nothing the plugin matches', () => {
    expect(Object.keys(uncoveredByPlugin(withNote))).toEqual([NOTE_TOOL]);
    const block = extraToolsBlock(withNote, '/root', PLUGIN_HOOK_TIMEOUT_S)!;
    expect(covers(block.matcher, NOTE_TOOL)).toBe(true);
    expect(covers(block.matcher, 'mcp__other__post_internal_note')).toBe(true);
    // Both entries firing for one tool would be two review windows for one send.
    for (const name of pluginNames) {
      expect(covers(entry.matcher, name)).toBe(true);
      expect(covers(block.matcher, name), name).toBe(false);
    }
    expect(block.hooks[0].timeout).toBe(PLUGIN_HOOK_TIMEOUT_S);
  });

  test('never infers a half the plugin infers, even for a name the plugin\'s server class rejects', () => {
    // A server name with a character the plugin's matcher does not take: the exact name is the
    // plugin's to miss and this entry's to cover, but its half is Slack's own.
    const odd = 'mcp__odd!server__slack_send_message';
    const map = { ...DEFAULT_TOOL_MAP, [odd]: DEFAULT_TOOL_MAP['mcp__claude_ai_Slack__slack_send_message']! };
    const block = extraToolsBlock(map, '/root', 9)!;
    expect(covers(block.matcher, odd)).toBe(true);
    for (const name of pluginNames) expect(covers(block.matcher, name), name).toBe(false);
  });

  test('runs the plugin\'s own wrapper with the root written in, read back as fail-closed', () => {
    const root = join(dir, "a root's place");
    const block = extraToolsBlock(withNote, root, 9)!;
    const { command: written } = block.hooks[0];
    const t = commandTokens(written);
    expect(t[2]).toBe(PLUGIN_FAIL_CLOSED_SCRIPT);
    expect(t[4]).toBe(root);
    expect(readCommand(written)).toMatchObject({ wrapped: true, failClosed: true, launched: [join(root, HOOK_IN_REPO)] });
    // Not the plugin's own command: that one leaves the root to Claude Code.
    expect(isPluginFailClosed(written)).toBe(false);
    // Dropping an answer is not fail-closed.
    expect(readCommand(t.slice(0, 7).map(shQuote).join(' ')).failClosed).toBe(false);
  });

  test('a settings wrapper missing an answer is still read as the settings wrapper', () => {
    // As long as the plugin's, but its script says which it is: it still launches its own hook.
    const settingsCommand = commandTokens(checkoutCommandAt(join(dir, 'checkout')));
    const short = readCommand(settingsCommand.slice(0, 8).map(shQuote).join(' '));
    expect(short.launched).toEqual(settingsCommand.slice(4, 6));
    expect(short.failClosed).toBe(false);
  });
});

describe('the extra-tools entry, read back beside the plugin\'s', () => {
  const root = assembledRoot('readback');
  const hookPath = join(root, HOOK_IN_REPO);
  const pluginHooksPath = join(root, PLUGIN_HOOKS_IN_ROOT);
  const settingsPath = '/home/.claude/settings.json';
  const settings = (...blocks: unknown[]) => JSON.stringify({ hooks: { PreToolUse: blocks } });
  const inspect = (settingsText: string) =>
    inspectRegistration({
      read: (p): SettingsRead =>
        p === pluginHooksPath ? { kind: 'text', text: shipped } : p === settingsPath ? { kind: 'text', text: settingsText } : { kind: 'absent' },
      realpath: realpathOrNull,
      declined: [],
      paths: [settingsPath],
      hookPath,
      toolMap: withNote,
      pluginHooksPath,
    });

  test('the two cover every tool, fail closed, and do not count as a duplicate', () => {
    const report = inspect(settings(extraToolsBlock(withNote, root, PLUGIN_HOOK_TIMEOUT_S)));
    expect(report.ours.map((h) => [h.source, h.failClosed])).toEqual([[pluginHooksPath, true], [settingsPath, true]]);
    expect(report.unregistered).toEqual([]);
    expect(report.halvesNotInferred).toEqual([]);
    expect(report.firesTwice).toEqual([]);
  });

  test('without it, the new tool is the one the plugin leaves uncovered', () => {
    expect(inspect(settings()).unregistered).toEqual([NOTE_TOOL]);
  });

  test('an overlap on a tool half alone, or a matcher it cannot read, counts as firing twice', () => {
    const extra = extraToolsBlock(withNote, root, PLUGIN_HOOK_TIMEOUT_S)!;
    // Infers Slack's half like the plugin, and names no tool in the map.
    const halfOnly = { ...extra, matcher: '^(?:mcp__(?:[A-Za-z0-9.-]+)__(?:slack_send_message))$' };
    const opaque = { ...extra, matcher: 'mcp__.*__post_.*' };
    for (const block of [halfOnly, opaque]) {
      expect(inspect(settings(block)).firesTwice.map((h) => h.source)).toEqual([pluginHooksPath, settingsPath]);
    }
  });

  test('only a duplicate of the plugin\'s and the user settings\' entries is register\'s to narrow', () => {
    const at = (source: string) => ({ source, matcher: 'm', failClosed: true });
    const [plugin, user, project] = [at(pluginHooksPath), at(settingsPath), at('/project/.claude/settings.json')];
    expect(firesBesidePlugin([plugin, user], root, settingsPath)).toBe(true);
    // The same file, spelled unresolved.
    expect(firesBesidePlugin([plugin, at('/home/.claude/../.claude/settings.json')], root, settingsPath)).toBe(true);
    for (const twice of [[user, project], [plugin, project], [plugin, user, project], [], [user]]) {
      expect(firesBesidePlugin(twice, root, settingsPath), twice.map((h) => h.source).join(' ')).toBe(false);
    }
    // From a checkout there is no plugin entry for it to sit beside.
    expect(firesBesidePlugin([plugin, user], null, settingsPath)).toBe(false);
  });

  test('an entry beside the plugin that covers the plugin\'s tools too fires twice', () => {
    const wide = { ...extraToolsBlock(withNote, root, PLUGIN_HOOK_TIMEOUT_S)!, matcher: matcherFor(withNote) };
    const report = inspect(settings(wide));
    expect(report.firesTwice.map((h) => h.source)).toEqual([pluginHooksPath, settingsPath]);
  });
});

describe('the extra-tools entry, run as Claude Code runs a settings hook', () => {
  const root = assembledRoot('extra-run');
  const block = extraToolsBlock(withNote, root, PLUGIN_HOOK_TIMEOUT_S)!;
  /** A machine whose settings hold the entry and whose tools.json holds the new tool. */
  const machine = (name: string, cmd: string) => {
    const env = scratchEnv(name);
    mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
    mkdirSync(env.DRAFTGATE_HOME!, { recursive: true });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ ...block, hooks: [{ ...block.hooks[0], command: cmd }] }] } }));
    writeFileSync(join(env.DRAFTGATE_HOME!, 'tools.json'), JSON.stringify({ [NOTE_TOOL]: 'jira' }));
    // A settings command is run as written: no root to substitute.
    return spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify({ tool_name: 'mcp__notes__unknown', cwd: dir }), env, encoding: 'utf8' });
  };

  test('the real hook answers, and reads the plugin\'s registration beside this one', () => {
    const r = machine('extra-run-home', block.hooks[0].command);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.stdout).not.toContain('NOT registered');
    expect(r.stdout).not.toContain('could not find its own hook registration');
  });

  test('...because the wrapper tells it the root: without that, it sees only this entry', () => {
    // The control: the same command with the export taken out of the shipped script.
    const cmd = block.hooks[0].command;
    expect(cmd.split('export DRAFTGATE_PLUGIN_ROOT="$1"; ')).toHaveLength(2);
    const r = machine('extra-run-blind', cmd.replace('export DRAFTGATE_PLUGIN_ROOT="$1"; ', ''));
    expect(r.stdout).toContain('NOT registered');
  });

  test('with the link gone, or leading to a removed version, it asks, and says to run setup again', () => {
    const runEntry = (cmd: string) =>
      spawnSync('/bin/sh', ['-c', cmd], { input: '{}', env: { HOME: NO_HOME, PATH: FAKE_PATH, TMPDIR: dir }, encoding: 'utf8' }).stdout;
    const r = { stdout: runEntry(extraToolsBlock(withNote, join(dir, 'no-link-here'), 9)!.hooks[0].command) };
    expect(r.stdout).toBe(`${pluginFallbackDecisions('settings').hookGone}\n`);
    expect(r.stdout).toContain('/draftgate:setup');
    // A link left pointing at a version Claude Code removed: the same ask.
    const dangling = join(dir, 'dangling-link');
    symlinkSync(join(dir, 'a-version-removed'), dangling);
    expect(runEntry(extraToolsBlock(withNote, dangling, 9)!.hooks[0].command)).toBe(`${pluginFallbackDecisions('settings').hookGone}\n`);
  });
});

describe('setup\'s commands, through bin/draftgate', () => {
  /** A machine with the plugin root, and `tools.json` holding `tools` when given. */
  const machine = (name: string, tools?: Record<string, unknown>) => {
    const root = assembledRoot(`${name}-root`);
    const env = scratchEnv(name);
    recordInstall(env, root);
    if (tools) {
      mkdirSync(env.DRAFTGATE_HOME!, { recursive: true });
      writeFileSync(join(env.DRAFTGATE_HOME!, 'tools.json'), JSON.stringify(tools));
    }
    const settings = join(env.CLAUDE_CONFIG_DIR!, 'settings.json');
    /** `draftgate` as a Claude Code session's Bash tool runs it, or, with `session` null, a terminal. */
    const inSession = (session: string | null) => (...argv: string[]) =>
      spawnSync(join(root, PLUGIN_LAUNCHER_IN_ROOT), argv, {
        encoding: 'utf8', env: session === null ? env : { ...env, [SESSION_VAR]: session }, cwd: dir, timeout: 60_000,
      });
    const draftgate = inSession(null);
    return {
      root, settings, draftgate, inSession, home: env.DRAFTGATE_HOME!,
      keptFile: join(env.DRAFTGATE_HOME!, SETUP_NAMES_BASENAME),
      toolsFile: join(env.DRAFTGATE_HOME!, 'tools.json'),
      hooks: () => (existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')).hooks : undefined),
    };
  };
  const SESSION = ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Linear__save_customer_need', NOTE_TOOL];
  /**
   * A whole answer declining `declined`: the checklist holds every heading's tools whatever the
   * names, plus `own`, the halves only `tools.json` routes that a given name carries.
   */
  const declining = (declined: string[], own: string[] = []) => [
    '--review', ...[...CHOICE_HALVES, ...own].filter((h) => !declined.includes(h)),
    '--decline', ...declined,
  ];

  test('--write records the answer, and names nothing to add when the plugin covers every tool', () => {
    const m = machine('write-plain');
    const r = m.draftgate('propose-tools', ...SESSION, ...declining(['save_customer_need']), '--write');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`wrote ${m.toolsFile} (1 tool(s) declined)`);
    expect(JSON.parse(readFileSync(m.toolsFile, 'utf8')).declined).toEqual(['save_customer_need']);
    expect(statSync(m.toolsFile).mode & 0o777).toBe(0o600);
    expect(r.stdout).not.toContain("can't watch");
  });

  test('--write without an answer writes nothing', () => {
    const m = machine('write-noanswer');
    const r = m.draftgate('propose-tools', ...SESSION, '--write');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--write needs the answer to write');
    expect(existsSync(m.toolsFile)).toBe(false);
  });

  test('a tool of the operator\'s own: named, registered, checked, and taken out again', () => {
    const m = machine('extra', { [NOTE_TOOL]: 'jira' });
    const write = m.draftgate('propose-tools', ...SESSION, '--review-all', '--write');
    expect(write.status).toBe(0);
    expect(write.stdout).toContain(`draftgate can't watch these by default:\n  ${NOTE_TOOL}\n`);

    const reg = m.draftgate('register');
    expect(reg.status).toBe(0);
    const blocks = m.hooks().PreToolUse;
    expect(blocks).toHaveLength(1);
    const link = join(m.home, PLUGIN_LINK_BASENAME);
    expect(blocks[0]).toEqual(extraToolsBlock(withNote, link, PLUGIN_HOOK_TIMEOUT_S)!);
    expect(readlinkSync(link)).toBe(m.root);
    expect(reg.stdout).toContain(`  through   ${link} -> ${m.root}\n`);
    expect(reg.stdout).toContain(`              ${NOTE_TOOL}`);

    const doctor = m.draftgate('doctor');
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('No problems found.');
    expect(doctor.stdout).not.toContain('registered 2 times');
    expect(doctor.stdout).not.toContain('no registered matcher is byte-identical');

    // Asked again, setup has nothing to ask: the entry covers the tool already.
    expect(m.draftgate('propose-tools', ...SESSION, '--review-all', '--write').stdout).not.toContain("can't watch");
    expect(m.draftgate('register').stdout).toContain('Nothing changed.');

    // The tool gone from tools.json: the entry would only deny it, so register takes it out.
    writeFileSync(m.toolsFile, '{}');
    const out = m.draftgate('register');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('is not needed and was removed');
    expect(out.stdout).toContain(`Removed ${link}, `);
    expect(m.hooks()).toBeUndefined();
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('an added tool draftgate comes to know: its entry fires twice until setup narrows it', () => {
    // A tool added with --add whose half the default map routes too, under an entry whose matcher
    // still names it: the plugin infers the half now, so each send through it opens two windows.
    const ADDED = 'mcp__github__update_issue_comment';
    const m = machine('known-later', {
      [NOTE_TOOL]: 'jira',
      [ADDED]: { destination: 'github', bodyField: 'body', contextFields: ['*'] },
    });
    expect(m.draftgate('register').status).toBe(0);
    const narrow = m.hooks().PreToolUse;
    expect(narrow[0].matcher).not.toContain('update_issue_comment');
    const wide = { ...narrow[0], matcher: matcherFor({ [NOTE_TOOL]: withNote[NOTE_TOOL]!, [ADDED]: withNote[NOTE_TOOL]! }) };
    const json = JSON.parse(readFileSync(m.settings, 'utf8'));
    json.hooks.PreToolUse = [wide];
    writeFileSync(m.settings, JSON.stringify(json, null, 2) + '\n');

    const doctor = m.draftgate('doctor');
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain('registered 2 times');
    // From the plugin, whose own entry nobody can take out, the way out is setup.
    expect(doctor.stdout).toContain('one you used. Run `/draftgate:setup` in Claude Code: it\n');
    expect(doctor.stdout).not.toContain('Remove all but one');
    // Setup's answer names the entry for replacing, and register writes the narrow one back.
    const write = m.inSession('session-a')('propose-tools', ...SESSION, '--review-all', '--write');
    expect(write.stdout).toContain(OLD_ENTRY);
    expect(m.draftgate('register').status).toBe(0);
    expect(m.hooks().PreToolUse).toEqual(narrow);
    const after = m.draftgate('doctor');
    expect(after.status).toBe(0);
    expect(after.stdout).not.toContain('registered 2 times');
  });

  test('an entry and a plugin file whose statusMessage differs from this one\'s are still draftgate\'s', () => {
    // Recognised by command and matcher; the spinner's wording is not part of either.
    const m = machine('older-text', { [NOTE_TOOL]: 'jira' });
    expect(m.draftgate('register').status).toBe(0);
    const [block] = m.hooks().PreToolUse;
    const pluginFile = join(m.root, PLUGIN_HOOKS_IN_ROOT);
    for (const file of [m.settings, pluginFile]) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      json.hooks.PreToolUse = json.hooks.PreToolUse.map((b: any) => ({
        ...b,
        hooks: b.hooks.map((h: any) => ({ ...h, statusMessage: `${h.statusMessage}...` })),
      }));
      writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
      // The premise: neither file holds this release's text any more.
      expect(readFileSync(file, 'utf8')).not.toContain(`"${block.hooks[0].statusMessage}"`);
    }

    const doctor = m.draftgate('doctor');
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('No problems found.');
    expect(doctor.stdout).not.toContain('no registered matcher is byte-identical');
    // Register replaces the one entry in place, so the new text is all that changes.
    const reg = m.draftgate('register');
    expect(reg.status).toBe(0);
    expect(m.hooks().PreToolUse).toEqual([block]);
  });

  test('--add takes a tool of a server you set up, and setup reviews it from there', () => {
    const m = machine('add-own');
    const OWN = 'mcp__jsm__jira_add_internal_note';
    // Each refusal is `ownToolRoute`'s (`reconcile.test.ts`); through the launcher, one of them, and
    // the count.
    for (const [args, says] of [
      [['mcp__claude_ai_Jsm__jira_add_internal_note', 'jira', 'commentBody'], 'a claude.ai connector'],
      [[OWN, 'jira'], '--add takes three things'],
    ] as [string[], string][]) {
      const r = m.draftgate('propose-tools', '--add', ...args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toContain(says);
      expect(existsSync(m.toolsFile)).toBe(false);
    }
    expect(m.draftgate('propose-tools', '--add', OWN, 'jira', 'commentBody', '--write').stderr).toContain('--add takes nothing else');

    const added = m.draftgate('propose-tools', '--add', OWN, 'jira', 'commentBody');
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(`added ${OWN} to ${m.toolsFile}, reviewed as Jira, its message read from commentBody.`);
    const file = JSON.parse(readFileSync(m.toolsFile, 'utf8'));
    expect(file).toEqual({ [OWN]: { destination: 'jira', bodyField: 'commentBody', contextFields: ['*'] } });
    // The route reviews read: the operator's, so a call without that field asks, never allows.
    const route = mergeToolConfig(DEFAULT_TOOL_MAP, file, m.toolsFile).map[OWN];
    expect(route).toMatchObject({ destination: 'jira', bodyField: 'commentBody', schemaOwner: 'operator' });

    // Setup's answer then offers it to register, and the closing names it.
    const write = m.inSession('session-a')('propose-tools', ...SESSION, '--review-all', '--write');
    expect(write.stdout).toContain(`draftgate can't watch these by default:\n  ${OWN}\n`);
    expect(m.draftgate('register').status).toBe(0);
    expect(m.draftgate('doctor', '--setup').stdout).toContain(`Also reviewed: ${OWN} (a tool you added).`);
  });

  test("setup offers only the servers --add takes, never calls their tools the person's own, and shows the caveat as printed", () => {
    const skill = readFileSync(join(REPO, 'plugin', 'skills', 'setup', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    for (const { prefix } of NOT_OWN_SERVERS) expect(skill).toContain(`\`${prefix}\``);
    expect(skill).toContain('"Do you want draftgate to review other tools that look like they send messages?"');
    // Setup cannot tell a vendor's server from the person's: the words it gives never say whose.
    expect(skill).not.toMatch(/your own|of my own|my own tools/);
    // The destinations it offers are the ones --add takes.
    const names = Object.values(profiles).map((p) => `"${p.displayName}"`);
    expect(skill).toContain(`options in this order: ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`);
    // The caveat is a command's output, shown as printed: the skill holds no copy to paraphrase.
    expect(skill).toContain('draftgate propose-tools --format and show me what it printed, exactly, in a code block');
    expect(skill).not.toContain(OTHER_TOOLS_GUIDE);
    expect(skill).not.toContain('contentFormat');
  });

  test('what a tool added with --add is handed, as --format prints it, the one copy', () => {
    const m = machine('propose-format');
    const r = m.draftgate('propose-tools', '--format');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(OTHER_TOOL_FORMAT);
    // Held to the profiles: each extra field one sets on approve, and markdown for the rest, by name.
    const said = r.stdout.replace(/\s+/g, ' ');
    for (const p of Object.values(profiles)) {
      for (const [key, value] of Object.entries(p.extraToolInput)) expect(said).toContain(`${key} "${value}"`);
    }
    // One copy: --add's help points here rather than saying it again.
    const help = COMMAND_HELP['propose-tools'].replace(/\s+/g, ' ');
    expect(help).toContain('which --format prints');
    expect(help).not.toContain('contentFormat');
    const plain = Object.values(profiles).filter((p) => Object.keys(p.extraToolInput).length === 0);
    expect(said).toContain(`for ${plain.slice(0, -1).map((p) => p.displayName).join(', ')} and ${plain.at(-1)!.displayName} markdown`);
    // The link is to a guide this repository has.
    const guide = said.match(/https:\/\/github\.com\/Jakuboola\/draftgate\/blob\/main\/(\S+)/);
    expect(guide?.[1]).toBe('docs/gating-your-own-sends.md');
    expect(existsSync(join(REPO, guide![1]!))).toBe(true);
    // It runs alone, like --known: beside an answer one of the two would be dropped.
    const both = m.draftgate('propose-tools', '--format', '--known');
    expect(both.status).toBe(1);
    expect(both.stderr).toContain('--format takes nothing else');
  });

  test('propose-tools runs no other mode handed to it', () => {
    const m = machine('propose-other', { [NOTE_TOOL]: 'jira' });
    expect(m.draftgate('register').status).toBe(0);
    const before = readFileSync(m.settings, 'utf8');
    for (const flag of ['--unregister', '--register', '--doctor']) {
      const r = m.draftgate('propose-tools', ...SESSION, flag, '--review-all', '--write');
      expect(r.status, flag).toBe(1);
      expect(r.stderr).toContain(`does not take ${flag}`);
    }
    expect(readFileSync(m.settings, 'utf8')).toBe(before);
    expect(existsSync(m.toolsFile) && readFileSync(m.toolsFile, 'utf8')).toBe(JSON.stringify({ [NOTE_TOOL]: 'jira' }));
  });

  test('--write offers only the tools register would cover, whatever else is uncovered', () => {
    const m = machine('write-broken-plugin', { [NOTE_TOOL]: 'jira' });
    // The plugin's own file unreadable: every default tool reads as uncovered too, and register
    // cannot help with those.
    rmSync(join(m.root, PLUGIN_HOOKS_IN_ROOT));
    const r = m.draftgate('propose-tools', ...SESSION, '--review-all', '--write');
    expect(r.stdout).toContain(`draftgate can't watch these by default:\n  ${NOTE_TOOL}\n\``);
  });

  test('--write keeps a symlinked tools.json a symlink, and writes where it points', () => {
    const m = machine('write-link');
    const real = join(dir, 'dotfiles-tools.json');
    writeFileSync(real, '{}');
    mkdirSync(join(m.toolsFile, '..'), { recursive: true });
    symlinkSync(real, m.toolsFile);
    const answer = [...declining(['save_customer_need']), '--write'];
    expect(m.draftgate('propose-tools', ...SESSION, ...answer).status).toBe(0);
    expect(lstatSync(m.toolsFile).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).declined).toEqual(['save_customer_need']);
  });

  test('--known lists the halves a name must end in, the operator\'s own included, and takes nothing else', () => {
    const m = machine('known', { [NOTE_TOOL]: 'jira' });
    const r = m.draftgate('propose-tools', '--known');
    expect(r.status).toBe(0);
    const halves = r.stdout.trimEnd().split('\n');
    expect(halves).toContain('slack_send_message');
    expect(halves).toContain('post_internal_note');
    expect(halves).toEqual(toolHalvesOf(withNote));
    for (const extra of [[...SESSION], ['--decline'], ['--review-all'], ['--write']]) {
      const refused = m.draftgate('propose-tools', '--known', ...extra);
      expect(refused.status, extra.join(' ')).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('--known takes nothing else');
    }
  });

  test('setup types the names once: --write with none records the answer about the ones this session kept', () => {
    // Two machines with the same tools.json: one given the names twice, as setup did, one once.
    const twice = machine('kept-twice', { [NOTE_TOOL]: 'jira' });
    const once = machine('kept-once', { [NOTE_TOOL]: 'jira' });
    // Aliases first and last: each is an entry in the file written, so every kept name counts.
    const names = ['mcp__dummy__slack_send_message', ...SESSION, 'mcp__other__save_issue'];
    const run = once.inSession('session-a');
    const shown = run('propose-tools', ...names);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toBe(twice.draftgate('propose-tools', ...names).stdout.replaceAll(twice.home, once.home));
    expect(statSync(once.keptFile).mode & 0o777).toBe(0o600);

    const answer = [...declining(['save_customer_need'], ['post_internal_note']), '--write'];
    const written = run('propose-tools', ...answer);
    expect(written.status).toBe(0);
    expect(written.stdout).toBe(twice.draftgate('propose-tools', ...names, ...answer).stdout.replaceAll(twice.home, once.home));
    expect(readFileSync(once.toolsFile, 'utf8')).toBe(readFileSync(twice.toolsFile, 'utf8'));
    const file = JSON.parse(readFileSync(once.toolsFile, 'utf8'));
    expect(file.declined).toEqual(['save_customer_need']);
    expect(Object.keys(file)).toEqual(expect.arrayContaining([names[0], names.at(-1)]));
    // The answer ends the run: a second --write has nothing to record an answer about.
    expect(existsSync(once.keptFile)).toBe(false);
    expect(run('propose-tools', ...answer).status).toBe(1);
  });

  test('--write with no names refuses another session\'s names, a terminal, a run that kept none, and no names', () => {
    const m = machine('kept-elsewhere');
    // A terminal keeps nothing: no session could read it back.
    expect(m.draftgate('propose-tools', ...SESSION).status).toBe(0);
    expect(existsSync(m.keptFile)).toBe(false);
    // `session-c` kept none.
    for (const run of [m.inSession('session-c'), m.draftgate]) {
      expect(run('propose-tools', '--review-all', '--write').stderr).toContain('--write has no tool names');
    }
    expect(m.inSession('session-a')('propose-tools', ...SESSION).status).toBe(0);
    for (const run of [m.inSession('session-b'), m.draftgate]) {
      const r = run('propose-tools', '--review-all', '--write');
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('--write has no tool names to record an answer about');
    }
    expect(existsSync(m.toolsFile)).toBe(false);
    // From a terminal, no names at all is a mistake, and says what it needs.
    const bare = m.draftgate('propose-tools');
    expect(bare.status).toBe(1);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).toContain(`${REMEDY.proposeTools} needs the tool names to compare`);
    expect(bare.stderr).not.toContain('--propose-tools');
  });

  test('a run with no names shows the kept ones and never replaces them', () => {
    const m = machine('kept-preview');
    const run = m.inSession('session-a');
    const names = ['mcp__dummy__slack_send_message', ...SESSION];
    expect(run('propose-tools', ...names).status).toBe(0);
    const kept = readFileSync(m.keptFile, 'utf8');
    for (const preview of [[], ['--review-all'], declining(['slack_send_message'])]) {
      const r = run('propose-tools', ...preview);
      expect(r.status, preview.join(' ')).toBe(0);
      expect(r.stdout).toStartWith(`draftgate: reconciled ${names.length} tool name(s)`);
      expect(readFileSync(m.keptFile, 'utf8')).toBe(kept);
    }
    expect(run('propose-tools', '--review-all', '--write').status).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(m.toolsFile, 'utf8')))).toEqual(['mcp__dummy__slack_send_message']);
  });

  test('another session\'s --write leaves this session\'s names kept', () => {
    const m = machine('kept-two');
    expect(m.inSession('session-a')('propose-tools', ...SESSION).status).toBe(0);
    expect(m.inSession('session-b')('propose-tools', ...SESSION, '--review-all', '--write').status).toBe(0);
    expect(m.inSession('session-a')('propose-tools', '--review-all', '--write').status).toBe(0);
    expect(existsSync(m.keptFile)).toBe(false);
  });

  test('a session with no send tool passes no names, and still records an answer', () => {
    const m = machine('kept-empty', { [NOTE_TOOL]: 'jira' });
    const run = m.inSession('session-a');
    const shown = run('propose-tools');
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain('NOTHING given matches');
    const written = run('propose-tools', '--review-all', '--write');
    expect(written.status).toBe(0);
    expect(written.stdout).toContain(`draftgate can't watch these by default:\n  ${NOTE_TOOL}\n`);
  });

  test('without the plugin\'s entry for it, doctor names the uncovered tool', () => {
    const m = machine('extra-unregistered', { [NOTE_TOOL]: 'jira' });
    const doctor = m.draftgate('doctor');
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain(`no registered matcher covers them`);
    expect(doctor.stdout).toContain(NOTE_TOOL);
  });
});
