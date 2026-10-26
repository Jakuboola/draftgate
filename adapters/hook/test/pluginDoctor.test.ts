/**
 * `doctor`, `uninstall` and `version` on a plugin install: the real commands, through the plugin's
 * own `bin/draftgate`, under a scratch HOME and `CLAUDE_CONFIG_DIR`. The root is a copy of the
 * runtime, as a version folder in Claude Code's cache is, so a checkout's registration launches
 * another file than the plugin's hook. Claude Code's record is written in the shapes `claude plugin
 * install` leaves (`claudePlugin.ts`); the window is a stamped stand-in `bundleState` accepts.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_ID } from '../../../cli/src/claudePlugin';
import { HOOK_IN_REPO, PLUGIN_LINK_BASENAME } from '../../../cli/src/hookModes';
import { hashFile, inputKey, stampOf, surfaceLayout } from '../../../cli/src/surfaces/bundleStamp';
import { OLD_ENTRY, PLUGIN_HOOK_TIMEOUT_S } from '../src/main';
import { checkoutBlock } from './checkoutEntry';
import { PLUGIN_LAUNCHER_IN_ROOT, PLUGIN_ROOT_REF, extraToolsBlock } from '../src/pluginHooks';
import { DEFAULT_TOOL_MAP } from '../src/toolMap';

const REPO = join(import.meta.dir, '../../..');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'draftgate-plugindoctor-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOTE_TOOL = 'mcp__notes__post_internal_note';
const SESSION = ['mcp__claude_ai_Slack__slack_send_message', NOTE_TOOL];
const withNote = { ...DEFAULT_TOOL_MAP, [NOTE_TOOL]: DEFAULT_TOOL_MAP['mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue']! };

/** A plugin version folder: `plugin/`'s files and a copy of the runtime, with a window when asked. */
function pluginRoot(name: string, window = true): string {
  const root = join(dir, name);
  cpSync(join(REPO, 'plugin'), root, { recursive: true });
  for (const part of ['cli/src', 'core/src', 'adapters/hook/src', 'surface/contract.json', 'package.json']) {
    cpSync(join(REPO, part), join(root, part), { recursive: true });
  }
  if (window) {
    const layout = surfaceLayout(root);
    mkdirSync(layout.distDir, { recursive: true });
    writeFileSync(layout.builtRenderer, '<!doctype html>');
    const source = join(root, 'surface', 'contract.json');
    const inputs = { [inputKey(root, source)]: hashFile(source)! };
    writeFileSync(layout.stampFile, JSON.stringify({ version: 1, stamp: stampOf(inputs), inputs }));
  }
  return root;
}

/** A machine: scratch HOME, Claude Code's config, draftgate's home, and a project to run in. */
function machine(name: string, root = pluginRoot(`${name}-root`)) {
  const home = join(dir, name);
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: dir,
    PATH: `${join(process.execPath, '..')}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DRAFTGATE_HOME: join(home, '.draftgate'),
    DRAFTGATE_AUDIT_LOG: '',
  };
  const settings = join(env.CLAUDE_CONFIG_DIR!, 'settings.json');
  const readSettings = () => (existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {});
  const writeSettings = (value: unknown) => {
    mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
    writeFileSync(settings, JSON.stringify(value, null, 2));
  };
  const plugins = join(env.CLAUDE_CONFIG_DIR!, 'plugins');
  return {
    root, env, settings, project, readSettings, writeSettings,
    /** draftgate's plugin link, which the entry for the operator's own tools runs through. */
    link: join(env.DRAFTGATE_HOME!, PLUGIN_LINK_BASENAME),
    /** Claude Code's record of an install, and `enabledPlugins` in the user's settings. */
    install(installs: { id?: string; installPath?: string; enabled?: boolean }[] = [{}]) {
      mkdirSync(plugins, { recursive: true });
      const record: Record<string, unknown[]> = {};
      const enabled: Record<string, boolean> = {};
      for (const i of installs) {
        const id = i.id ?? PLUGIN_ID;
        (record[id] ??= []).push({ scope: 'user', installPath: i.installPath ?? root, version: '0.1.0' });
        enabled[id] = i.enabled ?? true;
      }
      writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: record }));
      writeSettings({ ...readSettings(), enabledPlugins: enabled });
    },
    recordText(text: string) {
      mkdirSync(plugins, { recursive: true });
      writeFileSync(join(plugins, 'installed_plugins.json'), text);
    },
    tools(map: Record<string, unknown>) {
      mkdirSync(env.DRAFTGATE_HOME!, { recursive: true });
      writeFileSync(join(env.DRAFTGATE_HOME!, 'tools.json'), JSON.stringify(map));
    },
    draftgate: (...argv: string[]) =>
      spawnSync(join(root, PLUGIN_LAUNCHER_IN_ROOT), argv, { encoding: 'utf8', env, cwd: project, timeout: 60_000 }),
  };
}

/** A machine with the plugin installed and enabled, and a tool of its own in tools.json. */
function withTool(name: string) {
  const m = machine(name);
  m.install();
  m.tools({ [NOTE_TOOL]: 'jira' });
  return m;
}

/** What the plugin's doctor must never tell anyone: both are the checkout route's commands. */
function noCheckoutAdvice(text: string): void {
  expect(text).not.toContain('`draftgate register`');
  expect(text).not.toContain('`draftgate setup`');
  expect(text).not.toContain('`draftgate update`');
}

describe('doctor, from the plugin: is it installed and enabled', () => {
  test('installed and enabled, with its window: the plugin is named and nothing is wrong', () => {
    const m = machine('enabled');
    m.install();
    const r = m.draftgate('doctor');
    expect(r.stdout).toContain(`  PLUGIN ${PLUGIN_ID} 0.1.0, user scope, enabled in ${m.settings}\n    runs from ${m.root}\n`);
    expect(r.stdout).toContain('    the window is built from this source.');
    expect(r.stdout).toContain('No problems found.');
    expect(r.status).toBe(0);
    noCheckoutAdvice(r.stdout);
  });

  test('not installed: its hooks.json is a file nobody loads, and that is a problem', () => {
    const m = machine('absent');
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PROBLEM: Claude Code has no draftgate plugin installed for sessions here');
    expect(r.stdout).toContain('plugin not installed');
  });

  test('installed and switched off: nothing is reviewed, and it says how to turn it on', () => {
    const m = machine('off');
    m.install([{ enabled: false }]);
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`enabled in no settings file`.replace('enabled in no settings file', `switched off in ${m.settings}`));
    expect(r.stdout).toContain(`Turn it on: \`/plugin enable ${PLUGIN_ID}\`.`);
  });

  test('a project that switches it off wins over the user settings, as Claude Code reads them', () => {
    const m = machine('project-off');
    m.install();
    mkdirSync(join(m.project, '.claude'));
    writeFileSync(join(m.project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }));
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`switched off in ${join(m.project, '.claude', 'settings.json')}`);
  });

  test('a record it cannot read is a problem, never "not installed"', () => {
    const m = machine('unreadable');
    m.recordText('{');
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("PROBLEM: Claude Code's record of its plugins");
    expect(r.stdout).not.toContain('no draftgate plugin installed');
    // An entry beside the plugin is still named: it does not depend on the record.
    m.writeSettings({ hooks: { PreToolUse: [checkoutBlock(DEFAULT_TOOL_MAP)] } });
    expect(m.draftgate('doctor').stdout).toContain('PROBLEM: the settings also register draftgate from another install');
  });

  test('two draftgate plugins enabled: both hooks fire, and each is named with its uninstall', () => {
    const m = machine('two');
    m.install([{}, { id: 'draftgate@dev', installPath: join(dir, 'elsewhere') }]);
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PROBLEM: 2 draftgate plugins are enabled here');
    expect(r.stdout).toContain('`/plugin uninstall draftgate@dev`');
  });

  test('another version folder is the installed one: said, not failed', () => {
    const m = machine('older');
    m.install([{ installPath: join(dir, 'newer-version') }]);
    const r = m.draftgate('doctor');
    expect(r.stdout).toContain(`NOTE: this report reads the plugin at ${m.root}, which is not the folder above.`);
    expect(r.stdout).toContain('No problems found.');
  });

  test("a directory marketplace's plugin runs in place: its cache copy is not what Claude Code runs", () => {
    const market = join(dir, 'dir-market');
    const root = pluginRoot('dir-market/plugin');
    mkdirSync(join(market, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(market, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'draftgate', plugins: [{ name: 'draftgate', source: './plugin' }] })
    );
    const cache = pluginRoot('dir-market-cache');
    const inPlace = machine('in-place', root);
    inPlace.install([{ installPath: cache }]);
    writeFileSync(
      join(inPlace.env.CLAUDE_CONFIG_DIR!, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ draftgate: { source: { source: 'directory', path: market }, installLocation: market } })
    );
    const r = inPlace.draftgate('doctor');
    expect(r.stdout).toContain(`    runs from ${root}\n`);
    expect(r.stdout).not.toContain('NOTE: this report reads the plugin at');
    const fromCache = spawnSync(join(cache, PLUGIN_LAUNCHER_IN_ROOT), ['doctor'], { encoding: 'utf8', env: inPlace.env, cwd: inPlace.project });
    expect(fromCache.stdout).toContain(`NOTE: this report reads the plugin at ${cache}, which is not the folder above.`);
  });

  test('a copy with no window: every review would ask, and the fix is the plugin, not an update', () => {
    const m = machine('nowindow', pluginRoot('nowindow-root', false));
    m.install();
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PROBLEM: no review can show its window, so every gated send asks instead.');
    expect(r.stdout).toContain('This copy of the draftgate plugin has no review window. Install the plugin again (`/plugin`)');
    noCheckoutAdvice(r.stdout);
  });
});

describe('doctor, from the plugin: what it advises', () => {
  test('a tool the plugin cannot match is named with setup, never register', () => {
    const m = machine('uncovered');
    m.install();
    m.tools({ [NOTE_TOOL]: 'jira', declined: ['save_customer_need'] });
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`      ${NOTE_TOOL}\n    Run \`/draftgate:setup\`: it adds one settings entry`);
    // The plugin's matcher still starts the hook for a declined tool, and nothing can narrow it.
    expect(r.stdout).toContain("still starts for every call: the plugin's matcher is the same on every machine:");
    // Not a registration from before tool-half matching: a half the plugin's matcher cannot have.
    expect(r.stdout).not.toContain('predates tool-half matching');
    noCheckoutAdvice(r.stdout);
  });

  test("a checkout's registration left beside the plugin is a duplicate, and setup replaces it", () => {
    const m = machine('leftover');
    m.install();
    // What the checkout route's `register` wrote: its own hook, from the checkout.
    m.writeSettings({ ...m.readSettings(), hooks: { PreToolUse: [checkoutBlock(DEFAULT_TOOL_MAP)] } });
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PROBLEM: the settings also register draftgate from another install');
    expect(r.stdout).toContain(`${m.settings} launches ${join(REPO, HOOK_IN_REPO)}`);
    expect(r.stdout).toContain('`/draftgate:setup` takes it out of your user settings.');
    noCheckoutAdvice(r.stdout);

    // What setup runs: --write names it in the words the skill asks on, and register takes it out.
    const write = m.draftgate('propose-tools', ...SESSION, '--review-all', '--write');
    expect(write.stdout).toContain(`${OLD_ENTRY}, which runs:\n  ${join(REPO, HOOK_IN_REPO)}\n`);
    const skill = readFileSync(join(REPO, 'plugin', 'skills', 'setup', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain(OLD_ENTRY);
    expect(m.draftgate('register').status).toBe(0);
    expect(m.readSettings().hooks).toBeUndefined();
    expect(m.readSettings().enabledPlugins).toEqual({ [PLUGIN_ID]: true });
    expect(m.draftgate('doctor').status).toBe(0);
    expect(m.draftgate('propose-tools', ...SESSION, '--review-all', '--write').stdout).not.toContain(OLD_ENTRY);
  });

  test("beside the entry for your own tools, only the other install's is an old entry", () => {
    const m = withTool('leftover-and-own');
    expect(m.draftgate('register').status).toBe(0);
    const settings = m.readSettings();
    settings.hooks.PreToolUse.push(checkoutBlock(DEFAULT_TOOL_MAP));
    m.writeSettings(settings);
    const write = m.draftgate('propose-tools', ...SESSION, '--review-all', '--write');
    expect(write.stdout).toContain(`${OLD_ENTRY}, which runs:\n  ${join(REPO, HOOK_IN_REPO)}\n\``);
    expect(write.stdout).not.toContain(`  ${join(m.root, HOOK_IN_REPO)}\n`);
  });

  test('an old entry is named beside tools to add, and so is this version\'s own once nothing needs it', () => {
    const m = withTool('old-and-offered');
    m.writeSettings({ ...m.readSettings(), hooks: { PreToolUse: [checkoutBlock(DEFAULT_TOOL_MAP)] } });
    const both = m.draftgate('propose-tools', ...SESSION, '--review-all', '--write').stdout;
    expect(both).toContain("draftgate can't watch these by default:");
    expect(both).toContain(`${OLD_ENTRY}, which runs:\n  ${join(REPO, HOOK_IN_REPO)}\n`);
    expect(m.draftgate('register').status).toBe(0);

    // The tool declined: the entry written for it covers nothing anyone wants, and register drops it.
    const declined = m.draftgate('propose-tools', ...SESSION, '--review', 'slack_send_message', '--decline', 'post_internal_note', '--write').stdout;
    expect(declined).toContain(`${OLD_ENTRY}, which runs:\n  ${join(m.link, HOOK_IN_REPO)}\n`);
    expect(m.draftgate('register').stdout).toContain('is not needed and was removed');
    expect(lstatSync(m.link, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('the entry for your own tools, its link at another version, is named, and setup points it here', () => {
    const m = withTool('stale');
    const old = pluginRoot('stale-old-version');
    const fromOld = spawnSync(join(old, PLUGIN_LAUNCHER_IN_ROOT), ['register'], { encoding: 'utf8', env: m.env, cwd: m.project });
    expect(fromOld.status).toBe(0);
    expect(readlinkSync(m.link)).toBe(old);
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      `NOTE: the entry for your own tools in ${m.settings} runs the plugin through ${m.link},\n` +
        `    which points at ${old}, not this plugin version.\n    \`/draftgate:setup\` points it at this one`
    );
    expect(r.stdout).toContain(`      ${NOTE_TOOL}\n    Run \`/draftgate:setup\``);
    // Setup offers the tool again, and register points the link at this version.
    expect(m.draftgate('propose-tools', ...SESSION, '--review-all', '--write').stdout).toContain("can't watch these by default");
    expect(m.draftgate('register').status).toBe(0);
    expect(readlinkSync(m.link)).toBe(m.root);
    expect(m.draftgate('doctor').stdout).toContain('No problems found.');
  });

  test('with the link gone, doctor says so, and register makes it again without touching the settings', () => {
    const m = withTool('link-gone');
    expect(m.draftgate('register').status).toBe(0);
    rmSync(m.link);
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`runs the plugin through ${m.link},\n    which is missing, so every send through those tools asks.`);
    const settings = readFileSync(m.settings, 'utf8');
    const again = m.draftgate('register').stdout;
    expect(again).toContain('Nothing changed.');
    expect(again).toContain(`Pointed ${m.link} at ${m.root}, which the entry runs the plugin through.`);
    expect(readFileSync(m.settings, 'utf8')).toBe(settings);
    expect(readlinkSync(m.link)).toBe(m.root);
    expect(m.draftgate('doctor').stdout).toContain('No problems found.');
  });

  test('a path where the link goes that is not a link is refused, and nothing is written', () => {
    const m = withTool('link-taken');
    mkdirSync(m.link, { recursive: true });
    const before = readFileSync(m.settings, 'utf8');
    const r = m.draftgate('register');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`could not point ${m.link} at ${m.root} (${m.link} is there and is not a link)`);
    expect(readFileSync(m.settings, 'utf8')).toBe(before);
  });

  test('beside an entry, a path there that is not a link is named as such, not as missing', () => {
    const m = withTool('link-taken-doctor');
    expect(m.draftgate('register').status).toBe(0);
    rmSync(m.link);
    mkdirSync(m.link);
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`runs the plugin through ${m.link},\n    which is not a link: something else is there`);
    expect(r.stdout).toContain('    Move it away, then run `/draftgate:setup`.');
    expect(r.stdout).not.toContain('which is missing');
  });

  test('a write that fails puts the link back as it was', () => {
    const m = withTool('link-undo');
    // The settings directory read-only: register reads the file and plans, then cannot write it.
    chmodSync(m.env.CLAUDE_CONFIG_DIR!, 0o555);
    try {
      const r = m.draftgate('register');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('It was not changed.');
    } finally {
      chmodSync(m.env.CLAUDE_CONFIG_DIR!, 0o755);
    }
    expect(lstatSync(m.link, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('with DRAFTGATE_HOME relative, the entry still names the link by its absolute path', () => {
    const m = withTool('link-relative');
    const r = spawnSync(join(m.root, PLUGIN_LAUNCHER_IN_ROOT), ['register'], {
      encoding: 'utf8', env: { ...m.env, DRAFTGATE_HOME: '.draftgate' }, cwd: join(m.env.DRAFTGATE_HOME!, '..'),
    });
    expect(r.status).toBe(0);
    expect(m.readSettings().hooks.PreToolUse).toEqual([extraToolsBlock(withNote, m.link, PLUGIN_HOOK_TIMEOUT_S)!]);
  });
});

/**
 * `doctor --setup`, setup's last step, run as the skill runs it after each answer setup takes: the
 * text it prints is the whole closing, so it is asserted whole.
 */
describe('doctor --setup: what setup ends with', () => {
  const DEFAULT_COUNT = Object.keys(DEFAULT_TOOL_MAP).length;
  /** The closing, with the one line that differs per answer. */
  const closing = (reviewed: string) =>
    [
      'draftgate is set up.',
      '',
      'When Claude sends to Jira, Slack, Linear or GitHub, a window shows the message',
      'as it will appear there. Edit it, then approve or reject. Nothing goes out until you do.',
      '',
      reviewed,
      "Every review is logged with the message's full text.",
      '',
      'Ask Claude to run:',
      '  draftgate digest   what you changed in reviews, to teach your agent your style',
      '  draftgate doctor   check the gate is working',
      '  draftgate help     the command list',
      '',
      'Setup saw only the connectors loaded in this session. A project\'s own MCP servers (its',
      '.mcp.json) load only when Claude Code starts in that folder: run /draftgate:setup there for',
      'those, and again after adding a connector.',
      '',
    ].join('\n');
  /** A machine whose reviews write the log, as a user's do: the harness turns it off by default. */
  const logging = (m: ReturnType<typeof machine>) => {
    m.env.DRAFTGATE_AUDIT_LOG = join(m.env.HOME!, 'audit.jsonl');
    return m;
  };

  test("setup's answers reach the closing: a declined group, a decline of nothing, a tool of your own", () => {
    // The wording of each line is `setupClosing.test.ts`'s; this is the wiring from the files setup
    // writes. A decline that routes nothing is no choice, so the closing does not name it.
    const m = logging(withTool('closing-answers'));
    const session = ['mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue', ...SESSION];
    const answer = ['--review', 'post_internal_note', 'slack_send_message', '--decline', 'addWorklogToJiraIssue', '--write'];
    expect(m.draftgate('propose-tools', ...session, ...answer).status).toBe(0);
    const tools = JSON.parse(readFileSync(join(m.env.DRAFTGATE_HOME!, 'tools.json'), 'utf8'));
    m.tools({ ...tools, declined: [...tools.declined, 'slack_send_mesage'] });
    expect(m.draftgate('register').status).toBe(0);
    const r = m.draftgate('doctor', '--setup');
    expect(r.status).toBe(0);
    // "Also reviewed" adds to the count, so the count leaves it out.
    expect(r.stdout).toBe(
      closing(
        `Reviewed: ${DEFAULT_COUNT - 1} send tools. Not reviewed: Jira work log notes (you declined them).\n` +
          `Also reviewed: ${NOTE_TOOL} (your own tool).`
      )
    );
  });

  test('an entry for your own tools that does not follow the plugin: a problem, so no closing', () => {
    // As step 4's "Leave it" keeps it: covered now, gone after the next update. Plain doctor notes it.
    const m = logging(withTool('closing-folder'));
    m.writeSettings({ ...m.readSettings(), hooks: { PreToolUse: [extraToolsBlock(withNote, m.root, PLUGIN_HOOK_TIMEOUT_S)!] } });
    expect(m.draftgate('doctor').status).toBe(0);
    const r = m.draftgate('doctor', '--setup');
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('draftgate is set up.');
    expect(r.stdout).toContain(`  PROBLEM: the entry for your own tools in ${m.settings} names one plugin version's folder,`);
    expect(r.stdout).toContain('1 problem(s): the entry for your own tools does not follow the plugin.');
  });

  test('a problem: no closing, the report that names it, and exit 1', () => {
    // The tool of its own left unreviewed: doctor names it, and setup must not say it is set up.
    const m = logging(withTool('closing-problem'));
    const r = m.draftgate('doctor', '--setup');
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('draftgate is set up.');
    expect(r.stdout).toBe(m.draftgate('doctor').stdout);
    expect(r.stdout).toContain(`PROBLEM: these tools are in the map but no registered matcher covers them.`);
  });

  test('reviews that write no log are not said to be logged', () => {
    const m = machine('closing-nolog');
    m.install();
    const r = m.draftgate('doctor', '--setup');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('\nReviews are not logged: DRAFTGATE_AUDIT_LOG is set to empty.\n');
    expect(r.stdout).not.toContain('Every review is logged');
  });
});

describe('an entry for your own tools that names a version folder', () => {
  /** The entry as `register` wrote it naming `root` itself, with this machine's tool in tools.json. */
  const named = (name: string, root: (m: ReturnType<typeof machine>) => string) => {
    const m = withTool(name);
    m.writeSettings({ ...m.readSettings(), hooks: { PreToolUse: [extraToolsBlock(withNote, root(m), PLUGIN_HOOK_TIMEOUT_S)!] } });
    return m;
  };

  test('is draftgate\'s and reviews, is noted as not following, and setup makes it follow', () => {
    const m = named('folder-here', (x) => x.root);
    const r = m.draftgate('doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `NOTE: the entry for your own tools in ${m.settings} names one plugin version's folder,\n` +
        `    ${m.root}, so it does not follow draftgate's updates.\n    \`/draftgate:setup\` points it at this one`
    );
    // Covered, so nothing is offered; named as an entry register replaces, so setup asks.
    const write = m.draftgate('propose-tools', ...SESSION, '--review-all', '--write').stdout;
    expect(write).not.toContain("can't watch");
    expect(write).toContain(`${OLD_ENTRY}, which runs:\n  ${join(m.root, HOOK_IN_REPO)}\n`);
    const reg = m.draftgate('register');
    expect(reg.status).toBe(0);
    expect(reg.stdout).toContain(`  was       ${join(m.root, HOOK_IN_REPO)}`);
    expect(m.readSettings().hooks.PreToolUse).toEqual([extraToolsBlock(withNote, m.link, PLUGIN_HOOK_TIMEOUT_S)!]);
    expect(readlinkSync(m.link)).toBe(m.root);
    const after = m.draftgate('doctor').stdout;
    expect(after).toContain('No problems found.');
    expect(after).not.toContain('NOTE: the entry for your own tools');
    expect(m.draftgate('propose-tools', ...SESSION, '--review-all', '--write').stdout).not.toContain(OLD_ENTRY);
  });

  test('naming a version Claude Code removed, it is noted as gone and its tools as uncovered', () => {
    const m = named('folder-gone', () => join(dir, 'a-removed-version'));
    const r = m.draftgate('doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`    ${join(dir, 'a-removed-version')}, which is gone, so it does not follow draftgate's updates.`);
    expect(r.stdout).toContain(`      ${NOTE_TOOL}\n    Run \`/draftgate:setup\``);
  });
});

describe('the entry for your own tools follows a plugin update', () => {
  test('a new session points it at the new version, which reviews, with the old folder removed', () => {
    const m = withTool('follow');
    expect(m.draftgate('register').status).toBe(0);
    const [block] = m.readSettings().hooks.PreToolUse;

    // The update: a new version folder, Claude Code's record moved to it, and a session started.
    const next = pluginRoot('follow-next');
    m.install([{ installPath: next }]);
    const session = JSON.parse(readFileSync(join(next, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
    const started = spawnSync('/bin/sh', ['-c', session.split(PLUGIN_ROOT_REF).join(next)], { encoding: 'utf8', env: m.env });
    expect([started.status, started.stdout]).toEqual([0, '']);
    expect(readlinkSync(m.link)).toBe(next);
    // The settings entry is untouched: nobody ran setup.
    expect(m.readSettings().hooks.PreToolUse).toEqual([block]);

    // Claude Code removes the old version's folder.
    rmSync(m.root, { recursive: true });

    // The entry, run as Claude Code runs a settings hook: the new version's real hook answers, and
    // reads the new version's registration through the link.
    const r = spawnSync('/bin/sh', ['-c', block.hooks[0].command], {
      input: JSON.stringify({ tool_name: 'mcp__notes__unknown', cwd: m.project }),
      env: m.env,
      encoding: 'utf8',
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.stdout).not.toContain('NOT registered');
    expect(r.stdout).not.toContain('cannot be found');

    const doctor = spawnSync(join(next, PLUGIN_LAUNCHER_IN_ROOT), ['doctor'], { encoding: 'utf8', env: m.env, cwd: m.project });
    expect(doctor.stdout).toContain('No problems found.');
    expect(doctor.status).toBe(0);
  });
});

describe('doctor, from a checkout, beside an enabled plugin', () => {
  test('both fire for the same tools, so it is a problem, and setup is the way out', () => {
    const m = machine('checkout-side');
    m.install();
    m.writeSettings({ ...m.readSettings(), hooks: { PreToolUse: [checkoutBlock(DEFAULT_TOOL_MAP)] } });
    const r = spawnSync(process.execPath, [join(REPO, HOOK_IN_REPO), '--doctor'], { encoding: 'utf8', env: m.env, cwd: m.project });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`PROBLEM: the draftgate plugin is enabled here too (${PLUGIN_ID})`);
    expect(r.stdout).toContain('Run `/draftgate:setup` in Claude Code');
  });

  test('a plugin installed and switched off here is not one', () => {
    const m = machine('checkout-side-off');
    m.install([{ enabled: false }]);
    m.writeSettings({ ...m.readSettings(), hooks: { PreToolUse: [checkoutBlock(DEFAULT_TOOL_MAP)] } });
    const r = spawnSync(process.execPath, [join(REPO, HOOK_IN_REPO), '--doctor'], { encoding: 'utf8', env: m.env, cwd: m.project });
    expect(r.stdout).not.toContain('the draftgate plugin is enabled here too');
  });
});

describe('uninstall and version, from the plugin', () => {
  test('the entry for your own tools goes; the plugin is named, still reviewing, with its uninstall', () => {
    const m = withTool('uninstall');
    expect(m.draftgate('register').status).toBe(0);
    expect(m.readSettings().hooks.PreToolUse).toHaveLength(1);
    expect(readlinkSync(m.link)).toBe(m.root);
    const r = m.draftgate('uninstall');
    expect(r.status).toBe(0);
    expect(m.readSettings().hooks).toBeUndefined();
    expect(lstatSync(m.link, { throwIfNoEntry: false })).toBeUndefined();
    expect(r.stdout).toContain(`Removed ${m.link}, `);
    expect(m.readSettings().enabledPlugins).toEqual({ [PLUGIN_ID]: true });
    expect(r.stdout).toContain('1/3  Review hook');
    expect(r.stdout).toContain(`  ${PLUGIN_ID} 0.1.0, user scope, enabled in ${m.settings}`);
    expect(r.stdout).toContain(`Run \`/plugin uninstall ${PLUGIN_ID}\` in Claude Code.`);
    expect(r.stdout).toContain('The draftgate plugin is still installed and enabled here, so draftgate still reviews');
    expect(r.stdout).not.toContain('draftgate no longer reviews anything');
    expect(r.stdout).not.toContain('draftgate on PATH');
    // Nobody could be asked, so draftgate's directory stays.
    expect(existsSync(m.env.DRAFTGATE_HOME!)).toBe(true);
  });

  test('once Claude Code has no install, it says draftgate no longer reviews', () => {
    const m = machine('uninstall-gone');
    const r = m.draftgate('uninstall');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Claude Code has no draftgate plugin installed.');
    expect(r.stdout).toContain("draftgate no longer reviews anything: its hook is out of Claude Code's settings.");
  });

  test("version is the plugin manifest's, with no git to ask", () => {
    const m = machine('version');
    const manifest = JSON.parse(readFileSync(join(REPO, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    const r = m.draftgate('version');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(`v${manifest.version}\n`);
  });
});
