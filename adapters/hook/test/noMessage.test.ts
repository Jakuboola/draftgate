/**
 * An alias of a `bodyOptional` default asks on a call with no message, because a proposal never
 * carries the flag (`ROUTE_FACTS`). Each layer below says so: the merge records it, `--write` and
 * `--doctor` name it, setup asks, and `--allow-no-message` writes the flag on the person's yes, to
 * those entries and no other.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorReport } from '../src/doctor';
import { reviewDeadline } from '../src/reviewTimeout';
import { DEFAULT_TOOL_MAP, mergeToolConfig, type ToolConfig } from '../src/toolMap';
import { REMEDY } from '../../../core/src/remedies';
import { NO_MESSAGE } from '../src/main';

const HOOK_SELF = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/** An alias of `mcp__claude_ai_Linear__save_issue`, which is `bodyOptional`. */
const ALIAS = 'mcp__linear-server__save_issue';
/** Its default, for the shadow case. */
const DEFAULT_SAVE_ISSUE = 'mcp__claude_ai_Linear__save_issue';
/** An alias of `save_diff_comment`, whose default is not `bodyOptional`. */
const DIFF_COMMENT = 'mcp__linear-server__save_diff_comment';
/** The entry `--propose-tools` writes for the alias: every proposed fact, no `bodyOptional`. */
const PROPOSED = { destination: 'linear', bodyField: 'description', proseFields: ['title'], contextFields: ['id', '*'] };

const merged = (file: Record<string, unknown>) => mergeToolConfig(DEFAULT_TOOL_MAP, file, 'tools.json');

describe('mergeToolConfig: which entries ask where the default allows', () => {
  test('the default is bodyOptional, so the test below means something', () => {
    expect(DEFAULT_TOOL_MAP[DEFAULT_SAVE_ISSUE]?.bodyOptional).toBe(true);
    expect(DEFAULT_TOOL_MAP['mcp__claude_ai_Linear__save_diff_comment']?.bodyOptional).toBeUndefined();
  });

  test('a proposed alias and a short-form one are named', () => {
    expect(merged({ [ALIAS]: PROPOSED }).asksOnNoMessage).toEqual([ALIAS]);
    expect(merged({ [ALIAS]: 'linear' }).asksOnNoMessage).toEqual([ALIAS]);
  });

  test('one that says bodyOptional either way is not', () => {
    expect(merged({ [ALIAS]: { ...PROPOSED, bodyOptional: true } }).asksOnNoMessage).toEqual([]);
    expect(merged({ [ALIAS]: { ...PROPOSED, bodyOptional: false } }).asksOnNoMessage).toEqual([]);
  });

  test('a shadow, a declined alias, another destination, a required body and an own tool are not', () => {
    const cfg = merged({
      [DEFAULT_SAVE_ISSUE]: PROPOSED,
      [DIFF_COMMENT]: 'linear',
      'mcp__other__save_issue': 'jira',
      mcp__notes__add_note: 'linear',
    });
    expect(cfg.asksOnNoMessage).toEqual([]);
    expect(cfg.shadows.map((s) => s.name)).toEqual([DEFAULT_SAVE_ISSUE]);
    expect(merged({ declined: ['save_issue'], [ALIAS]: PROPOSED }).asksOnNoMessage).toEqual([]);
  });
});

/** `--doctor`'s text for a config, with a healthy registration around it. */
function doctorText(cfg: ToolConfig): { text: string; ok: boolean } {
  const matcher = '^(?:x)$';
  return doctorReport({
    report: {
      scanned: [], ours: [{ source: '/user.json', matcher, timeout: 1260, failClosed: true }], firesTwice: [],
      unregistered: [], unmapped: [], declinedStillMatched: [], opaqueMatchers: [], halvesNotInferred: [],
      others: [], shadowed: [], registeredTimeoutMs: 1_260_000,
    },
    deadline: reviewDeadline(1_200_000, 1_260_000),
    toolMap: cfg.map,
    asksOnNoMessage: cfg.asksOnNoMessage,
    expectedMatchers: [matcher],
    configPath: '/home/.draftgate/config.json',
    configPresent: false,
  });
}

describe('--doctor names them as a note, never a problem', () => {
  test('named, with setup and the command', () => {
    const { text, ok } = doctorText(merged({ [ALIAS]: PROPOSED }));
    expect(ok).toBe(true);
    expect(text).toContain('NOTE: these tools.json entries ask you even when a call carries no message');
    expect(text).toContain(`${REMEDY.pluginSetup} asks whether to let those through, or run ${REMEDY.allowNoMessage}`);
    expect(text).toContain(`with their names:\n      ${ALIAS}\n`);
  });

  test('none, no note', () => {
    const { text } = doctorText(merged({ [ALIAS]: { ...PROPOSED, bodyOptional: true } }));
    expect(text).not.toContain('carries no message');
  });
});

describe('through the real entry point', () => {
  /** A scratch draftgate home holding `tools`, and the hook run against it. */
  const machine = (tools: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), 'draftgate-no-message-'));
    const home = join(root, 'dg');
    mkdirSync(home);
    const toolsFile = join(home, 'tools.json');
    writeFileSync(toolsFile, JSON.stringify(tools));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: join(root, 'cc'),
      DRAFTGATE_HOME: home,
      DRAFTGATE_AUDIT_LOG: join(root, 'audit.log'),
    };
    // Not a Claude Code session: no kept names from this one's.
    delete env.CLAUDE_CODE_SESSION_ID;
    const hook = (args: string[], input?: string) =>
      spawnSync('bun', [HOOK_SELF, ...args], { env, encoding: 'utf8', input, timeout: 60_000 });
    return {
      hook,
      read: () => JSON.parse(readFileSync(toolsFile, 'utf8')),
      /** The decision a labels-only `save_issue` through `name` gets: a call with no message. */
      labelsOnly: (name: string) =>
        JSON.parse(
          hook([], JSON.stringify({ tool_name: name, tool_input: { id: 'X-1', addLabels: ['Support'] }, cwd: root })).stdout
        ).hookSpecificOutput.permissionDecision,
      done: () => rmSync(root, { recursive: true, force: true }),
    };
  };

  test('the alias asks; --write names it; --allow-no-message gives back the allow and nothing else', () => {
    const m = machine({ [ALIAS]: PROPOSED, [DIFF_COMMENT]: 'linear' });
    try {
      expect(m.labelsOnly(ALIAS)).toBe('ask');

      const written = m.hook(['--propose-tools', ALIAS, DIFF_COMMENT, '--review-all', '--write']);
      expect(written.status).toBe(0);
      expect(written.stdout).toContain(`${NO_MESSAGE}:\n  ${ALIAS}\n\n${REMEDY.allowNoMessage} with their names`);
      expect(m.hook(['--doctor']).stdout).toContain(`with their names:\n      ${ALIAS}\n`);

      const r = m.hook(['--propose-tools', '--allow-no-message', ALIAS]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`now goes through unreviewed for:\n  ${ALIAS}\n`);
      // The flag added, every other fact and entry as it was.
      expect(m.read()).toEqual({ [ALIAS]: { ...PROPOSED, bodyOptional: true }, [DIFF_COMMENT]: 'linear' });
      expect(m.labelsOnly(ALIAS)).toBe('allow');

      expect(m.hook(['--doctor']).stdout).not.toContain('carries no message');
      const again = m.hook(['--propose-tools', ALIAS, DIFF_COMMENT, '--review-all', '--write']);
      expect(again.status).toBe(0);
      expect(again.stdout).not.toContain(NO_MESSAGE);
    } finally {
      m.done();
    }
  });

  test('a short-form entry becomes the long form with the flag', () => {
    const m = machine({ [ALIAS]: 'linear' });
    try {
      expect(m.hook(['--propose-tools', '--allow-no-message', ALIAS]).status).toBe(0);
      expect(m.read()).toEqual({ [ALIAS]: { destination: 'linear', bodyOptional: true } });
    } finally {
      m.done();
    }
  });

  test('refuses a shadow, a required-body alias, one already allowed, no names and company, and writes nothing', () => {
    const tools = {
      [ALIAS]: PROPOSED,
      [DEFAULT_SAVE_ISSUE]: PROPOSED,
      [DIFF_COMMENT]: 'linear',
      'mcp__other-linear__save_issue': { destination: 'linear', bodyOptional: true },
    };
    const m = machine(tools);
    try {
      for (const name of [DEFAULT_SAVE_ISSUE, DIFF_COMMENT, 'mcp__other-linear__save_issue', 'mcp__nobody__save_issue']) {
        const r = m.hook(['--propose-tools', '--allow-no-message', ALIAS, name]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`"${name}" is not a tools.json entry that asks on a call with no message`);
      }
      const none = m.hook(['--propose-tools', '--allow-no-message']);
      expect(none.status).toBe(1);
      expect(none.stderr).toContain('--allow-no-message needs the tools.json entries to change');
      const mixed = m.hook(['--propose-tools', '--allow-no-message', ALIAS, '--write']);
      expect(mixed.status).toBe(1);
      expect(mixed.stderr).toContain('--allow-no-message takes nothing else');
      expect(m.read()).toEqual(tools);
    } finally {
      m.done();
    }
  });

  test('the skill asks on the words --write prints', () => {
    const skill = readFileSync(fileURLToPath(new URL('../../../plugin/skills/setup/SKILL.md', import.meta.url)), 'utf8');
    expect(skill.replace(/\s+/g, ' ')).toContain(`"${NO_MESSAGE}"`);
  });
});
