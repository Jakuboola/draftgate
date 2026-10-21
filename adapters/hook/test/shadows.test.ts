/**
 * A `tools.json` entry named like a default entry replaces it whole, so a fact the default has and
 * the entry lacks (`bodyOptional`, say) is lost without a word. Each layer below says so: the merge
 * records it, `--doctor` names it, `--write` drops one that changes nothing, and `--drop` takes out
 * one that differs only when asked.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorReport } from '../src/doctor';
import { answeredToolsJson, describeReconciliation, reconcileTools } from '../src/reconcile';
import { reviewDeadline } from '../src/reviewTimeout';
import { DEFAULT_TOOL_MAP, mergeToolConfig, routeDifferences, type ToolConfig } from '../src/toolMap';
import { REMEDY } from '../../../core/src/remedies';
import { OVERRIDES } from '../src/main';

const HOOK_SELF = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const SAVE_ISSUE = 'mcp__claude_ai_Linear__save_issue';
const SLACK = 'mcp__claude_ai_Slack__slack_send_message';
const COMMENT = 'mcp__claude_ai_Linear__save_comment';
const ALIAS = 'mcp__linear__save_issue';

/** A hand-written entry with every fact the default has but `bodyOptional`. */
const HAND_WRITTEN = {
  destination: 'linear',
  bodyField: 'description',
  proseFields: ['title'],
  contextFields: ['*'],
};
/** Says nothing the default does not: the short form, which takes the default's disclosure. */
const RESTATED = 'slack';
/** Differs on purpose: one more routing field, read before the rest. */
const NARROWED = { destination: 'linear', contextFields: ['issueId'] };

const merged = (file: Record<string, unknown>) => mergeToolConfig(DEFAULT_TOOL_MAP, file, 'tools.json');

describe('mergeToolConfig: what a same-name entry hides', () => {
  test('the missing bodyOptional is the one difference, and the route loses it', () => {
    const cfg = merged({ [SAVE_ISSUE]: HAND_WRITTEN });
    expect(cfg.shadows).toEqual([
      { name: SAVE_ISSUE, differences: ['lacks bodyOptional: true, so a call with no message asks instead of going through'] },
    ]);
    expect(cfg.map[SAVE_ISSUE]?.bodyOptional).toBeUndefined();
    expect(cfg.map[SAVE_ISSUE]?.schemaOwner).toBe('operator');
  });

  test('an entry that restates the default has no difference, and keeps the default route', () => {
    const cfg = merged({ [SLACK]: RESTATED });
    expect(cfg.shadows).toEqual([{ name: SLACK, differences: [] }]);
    expect(cfg.map[SLACK]).toBe(DEFAULT_TOOL_MAP[SLACK]!);
  });

  test('a dormant entry is named as dormant, not as an override of a tool nobody reviews', () => {
    const cfg = merged({ declined: ['save_issue'], [SAVE_ISSUE]: HAND_WRITTEN });
    expect(cfg.dormant).toEqual([SAVE_ISSUE]);
    expect(cfg.shadows).toEqual([]);
  });

  test('an alias, a tool of its own and a null are not shadows', () => {
    const cfg = merged({ [ALIAS]: 'linear', mcp__notes__add_note: 'jira', [COMMENT]: null });
    expect(cfg.shadows).toEqual([]);
  });

  test('each kind of difference is said in words', () => {
    const base = DEFAULT_TOOL_MAP[SAVE_ISSUE]!;
    expect(routeDifferences(base, { ...base, bodyField: 'body' })).toEqual(['bodyField: "body", not "description"']);
    expect(routeDifferences(base, { ...base, bodyFormat: 'plain' })).toEqual(['adds bodyFormat: "plain"']);
    expect(routeDifferences(base, { ...base, contextFields: [...base.contextFields!].reverse() })).toEqual([
      'contextFields in another order',
    ]);
    expect(routeDifferences(base, { ...base, proseFields: ['title', 'title'] })).toEqual(['proseFields repeats a field']);
    expect(routeDifferences(base, { ...base, proseFields: ['summary'] })).toEqual([
      'proseFields adds "summary", lacks "title"',
    ]);
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
    shadows: cfg.shadows,
    expectedMatchers: [matcher],
    configPath: '/home/.draftgate/config.json',
    configPresent: false,
  });
}

describe('--doctor names every shadowing entry', () => {
  test('the missing bodyOptional is named, as an override and not a problem', () => {
    const { text, ok } = doctorText(merged({ [SAVE_ISSUE]: HAND_WRITTEN }));
    expect(ok).toBe(true);
    expect(text).toContain("NOTE: these tools.json entries override draftgate's own entry for the same tool.");
    expect(text).toContain(`${SAVE_ISSUE}: lacks bodyOptional: true, so a call with no message asks`);
    expect(text).toContain(`to use\n    draftgate's instead, run ${REMEDY.dropToolEntries} with the name:`);
    expect(text).not.toContain('say just what');
  });

  test('a restating entry is named as one, with setup and --drop to take it out', () => {
    const { text, ok } = doctorText(merged({ [SLACK]: RESTATED }));
    expect(ok).toBe(true);
    expect(text).toContain("NOTE: these tools.json entries say just what draftgate's own entry for the tool says.");
    expect(text).toContain(`${REMEDY.pluginSetup} drops them, or ${REMEDY.dropToolEntries} with their names:\n      ${SLACK}\n`);
    expect(text).not.toContain('override');
  });

  test('a deliberate difference is said to override, with what it does, and nothing is a problem', () => {
    const { text, ok } = doctorText(merged({ [COMMENT]: NARROWED, [SLACK]: RESTATED }));
    expect(ok).toBe(true);
    expect(text).toContain(`      ${COMMENT}: contextFields adds "issueId"\n`);
    expect(text).toContain(`      ${SLACK}\n`);
  });

  test('no same-name entry, no note', () => {
    const { text } = doctorText(merged({ [ALIAS]: 'linear' }));
    expect(text).not.toContain('tools.json entries');
  });
});

describe("the answer's file", () => {
  test('drops a restating entry, keeps an overriding one, and the report says so', () => {
    const existing = { [SLACK]: RESTATED, [SAVE_ISSUE]: HAND_WRITTEN };
    const cfg = merged(existing);
    const r = reconcileTools([SLACK, SAVE_ISSUE], cfg.map, cfg);
    const text = describeReconciliation(r, Object.keys(cfg.map).length, existing, 't.json', []);
    expect(text).toContain("(0 declined), 1 entry(ies) that restate draftgate's own dropped, and the proposals added.");
    const file = answeredToolsJson(r, existing, []);
    expect(JSON.parse(file)).toEqual({ [SAVE_ISSUE]: HAND_WRITTEN });
    // The file the report prints is the one `--write` writes.
    expect(text).toContain(file.split('\n').map((l) => `    ${l}`).join('\n'));
  });
});

describe('through the real entry point', () => {
  /** A scratch draftgate home holding `tools`, and `--propose-tools` run against it. */
  const machine = (tools: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), 'draftgate-shadows-'));
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
      toolsFile,
      read: () => JSON.parse(readFileSync(toolsFile, 'utf8')),
      /** The decision a state-only `save_issue` gets: a call with no message. */
      stateOnly: () =>
        JSON.parse(hook([], JSON.stringify({ tool_name: SAVE_ISSUE, tool_input: { id: 'X-1', state: 'Done' }, cwd: root })).stdout)
          .hookSpecificOutput.permissionDecision,
      done: () => rmSync(root, { recursive: true, force: true }),
    };
  };

  test('--write drops a restating entry unasked and names an overriding one, which it keeps', () => {
    const m = machine({ [SLACK]: RESTATED, [SAVE_ISSUE]: HAND_WRITTEN });
    try {
      const r = m.hook(['--propose-tools', SLACK, SAVE_ISSUE, '--decline', '--write']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Dropped from tools.json, since each said just what draftgate's own entry says:\n  ${SLACK}\n`);
      expect(r.stdout).toContain(
        `${OVERRIDES}:\n  ${SAVE_ISSUE}: lacks bodyOptional: true`
      );
      expect(m.read()).toEqual({ [SAVE_ISSUE]: HAND_WRITTEN });
    } finally {
      m.done();
    }
  });

  test('the skill asks on the words --write prints', () => {
    const skill = readFileSync(fileURLToPath(new URL('../../../plugin/skills/setup/SKILL.md', import.meta.url)), 'utf8');
    expect(skill.replace(/\s+/g, ' ')).toContain(`"${OVERRIDES}"`);
  });

  test('--write with nothing shadowing says nothing about it', () => {
    const m = machine({ [ALIAS]: 'linear' });
    try {
      const r = m.hook(['--propose-tools', SLACK, '--decline', '--write']);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('Dropped');
      expect(r.stdout).not.toContain('overrides');
      expect(m.read()).toEqual({ [ALIAS]: 'linear' });
    } finally {
      m.done();
    }
  });

  test('the hand-written entry asks on a call with no message; --drop gives back the allow', () => {
    const m = machine({ [SAVE_ISSUE]: HAND_WRITTEN, [ALIAS]: 'linear' });
    try {
      expect(m.stateOnly()).toBe('ask');
      const doctor = m.hook(['--doctor']);
      expect(doctor.stdout).toContain(`${SAVE_ISSUE}: lacks bodyOptional: true`);

      const r = m.hook(['--propose-tools', '--drop', SAVE_ISSUE]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`so draftgate's own entry applies to:\n  ${SAVE_ISSUE}\n`);
      expect(m.read()).toEqual({ [ALIAS]: 'linear' });
      expect(m.stateOnly()).toBe('allow');
      expect(m.hook(['--doctor']).stdout).not.toContain('tools.json entries');
    } finally {
      m.done();
    }
  });

  test('--drop refuses an alias, a tool of its own and an empty list, and writes nothing', () => {
    const tools = { [SAVE_ISSUE]: HAND_WRITTEN, [ALIAS]: 'linear', mcp__notes__add_note: 'jira' };
    const m = machine(tools);
    try {
      for (const name of [ALIAS, 'mcp__notes__add_note']) {
        const r = m.hook(['--propose-tools', '--drop', SAVE_ISSUE, name]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`"${name}" is not a tools.json entry for one of draftgate's own tools, so nothing was dropped`);
      }
      const none = m.hook(['--propose-tools', '--drop']);
      expect(none.status).toBe(1);
      expect(none.stderr).toContain('--drop needs the tools.json entries to drop');
      const mixed = m.hook(['--propose-tools', '--drop', SAVE_ISSUE, '--write']);
      expect(mixed.status).toBe(1);
      expect(mixed.stderr).toContain('--drop takes nothing else');
      expect(m.read()).toEqual(tools);
    } finally {
      m.done();
    }
  });
});
