/**
 * A tool the operator chose not to gate.
 *
 * A decline is recorded, so it never looks like the accidental gap it resembles: `null` removes an
 * entry and a stale paste misses one, and `--doctor` reads both as "not covered". Each layer below
 * treats a `declined` list as a third thing.
 */

import { describe, expect, test } from 'bun:test';
import { decide } from '../src/decide';
import { renderHookOutput } from '../src/hookOutput';
import { inspectRegistration } from '../src/registration';
import { checkoutSettings } from './checkoutEntry';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_SELF = fileURLToPath(new URL('../src/main.ts', import.meta.url));
import {
  CHOICE_GROUPS, UNANSWERED, declinedAfter, describeReconciliation, proposalsFor, proposedToolsJson, reconcileTools,
} from '../src/reconcile';
import {
  DEFAULT_TOOL_MAP,
  ToolMapError,
  matcherFor,
  mergeToolConfig,
  resolveRoute,
  toolHalfOf,
} from '../src/toolMap';

const SLACK = 'mcp__claude_ai_Slack__slack_send_message';
const SLACK_ALIAS = 'mcp__slack__slack_send_message';
const JIRA = 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue';
const LINEAR = 'mcp__claude_ai_Linear__save_comment';

/** Every heading's tool halves but `named`: the rest of a whole answer. */
const othersThan = (...named: string[]) => CHOICE_GROUPS.flatMap((g) => g.halves).filter((h) => !named.includes(h));

const declining = (...halves: string[]) =>
  mergeToolConfig(DEFAULT_TOOL_MAP, { declined: halves }, 'tools.json');

describe('mergeToolConfig: a decline removes every entry using the half', () => {
  test('default entries AND operator aliases for the half are gone; others stay', () => {
    const { map, declined, declinedRoutes } = mergeToolConfig(
      DEFAULT_TOOL_MAP,
      { declined: ['slack_send_message'], [JIRA.replace('claude_ai_Atlassian_Rovo', 'atlassian')]: 'jira' },
      'tools.json'
    );
    expect(declined).toEqual(['slack_send_message']);
    expect(Object.keys(map).some((n) => toolHalfOf(n) === 'slack_send_message')).toBe(false);
    expect(map[JIRA]).toBeDefined();
    // Kept, so a checklist can still say where the declined tool goes and offer to re-enable it.
    expect(declinedRoutes[SLACK]?.destination).toBe('slack');
  });

  test('so the matcher omits it from BOTH branches, and nothing infers it back', () => {
    const { map } = declining('slack_send_message');
    const matcher = new RegExp(matcherFor(map));
    expect(matcher.test(SLACK)).toBe(false);
    // The inferred-half branch: a server nobody has named offering the same tool.
    expect(matcher.test('mcp__brand_new__slack_send_message')).toBe(false);
    expect(resolveRoute('mcp__brand_new__slack_send_message', map)).toBeNull();
    // A sibling Slack tool is a different half, and a different decision.
    expect(matcher.test('mcp__claude_ai_Slack__slack_schedule_message')).toBe(true);
  });

  test('an entry for a declined half is kept DORMANT: validated, not routed, and named', () => {
    // Refusing it would force setup to delete the operator's aliases on decline, and a re-enable
    // could then not restore a custom `bodyField`. The decline wins; the entry waits.
    const alias = { destination: 'slack', bodyField: 'text' };
    const cfg = mergeToolConfig(DEFAULT_TOOL_MAP, { declined: ['slack_send_message'], [SLACK_ALIAS]: alias }, 'x');
    expect(cfg.map[SLACK_ALIAS]).toBeUndefined();
    expect(cfg.dormant).toEqual([SLACK_ALIAS]);
    // Still VALIDATED: a dormant entry that could never load is not waiting, it is broken.
    expect(() =>
      mergeToolConfig(DEFAULT_TOOL_MAP, { declined: ['slack_send_message'], [SLACK_ALIAS]: 'nowhere' }, 'x')
    ).toThrow(ToolMapError);
    // And re-enabling is just removing the half: the entry is back exactly as written.
    expect(mergeToolConfig(DEFAULT_TOOL_MAP, { [SLACK_ALIAS]: alias }, 'x').map[SLACK_ALIAS]?.bodyField).toBe('text');
  });

  test('a full tool name is refused with the half it probably meant', () => {
    expect(() => declining(SLACK)).toThrow(/"slack_send_message"/);
    expect(() => declining(SLACK)).toThrow(ToolMapError);
  });

  test('a half that itself contains __ can be declined, and the file still loads', () => {
    const map = { ...DEFAULT_TOOL_MAP, mcp__srv__foo__bar: { destination: 'slack', schemaOwner: 'operator' } } as typeof DEFAULT_TOOL_MAP;
    expect(toolHalfOf('mcp__srv__foo__bar')).toBe('foo__bar');
    const cfg = mergeToolConfig(map, { declined: ['foo__bar'] }, 'x');
    expect(cfg.map['mcp__srv__foo__bar']).toBeUndefined();
  });

  test('anything but a list of non-empty strings is refused', () => {
    for (const bad of ['slack_send_message', [''], [1], {}, null]) {
      expect(() => mergeToolConfig(DEFAULT_TOOL_MAP, { declined: bad }, 'x'), JSON.stringify(bad))
        .toThrow(ToolMapError);
    }
  });

  test('a decline of nothing routed is kept, and named as such', () => {
    const { declined, declinedUnrouted } = declining('slack_send_mesage');
    expect(declined).toEqual(['slack_send_mesage']);
    expect(declinedUnrouted).toEqual(['slack_send_mesage']);
    expect(declining('slack_send_message').declinedUnrouted).toEqual([]);
  });

  test('no declined key changes nothing', () => {
    const { map, declined } = mergeToolConfig(DEFAULT_TOOL_MAP, {}, 'x');
    expect(map).toEqual(DEFAULT_TOOL_MAP);
    expect(declined).toEqual([]);
  });
});

describe('decide: a declined tool on a stale matcher gets NO decision', () => {
  const opts = (declined: string[]) => {
    const { map } = declining(...declined);
    return {
      toolMap: map,
      declined,
      review: async () => {
        throw new Error('a declined tool must never reach a review');
      },
    } as Parameters<typeof decide>[1];
  };
  const payload = (tool_name: string, tool_input: unknown = { channel_id: 'C1', message: 'hi' }) =>
    JSON.stringify({ tool_name, tool_input });

  test('no decision, rendered as EMPTY stdout -- the documented "normal permission flow"', async () => {
    // Not `allow`: that skips Claude Code's own prompt, guarding a declined tool less than a
    // re-paste does.
    const d = await decide(payload(SLACK_ALIAS), opts(['slack_send_message']));
    expect(d.permissionDecision).toBe('none');
    expect(renderHookOutput(d)).toBe('');
  });

  test('the same unmapped tool NOT declined is still denied', async () => {
    // The distinguishing pair: one unmapped name, differing only in whether its half is declined.
    // (A declined sibling is no use: `slack_send_message` would still be inferred and reviewed.)
    const unmapped = 'mcp__somewhere__post_a_thing';
    expect((await decide(payload(unmapped), opts(['post_a_thing']))).permissionDecision).toBe('none');
    expect((await decide(payload(unmapped), opts(['slack_schedule_message']))).permissionDecision)
      .toBe('deny');
  });

  test('draftgate never ALLOWS a declined tool, whatever the input', async () => {
    const d = await decide(payload(SLACK_ALIAS, 'not an object'), opts(['slack_send_message']));
    expect(d.permissionDecision).toBe('none');
  });
});

describe('inspectRegistration: a stale matcher for a declined tool is not "unmapped"', () => {
  test('it lands in declinedStillMatched, and unmapped keeps its meaning', () => {
    const { map, declined } = declining('slack_send_message');
    // A checkout's registration, written before the decline.
    const settings = checkoutSettings(DEFAULT_TOOL_MAP);
    const report = inspectRegistration({
      read: (p) => (p === '/user.json' ? { kind: 'text', text: settings } : { kind: 'absent' }),
      realpath: () => null,
      declined,
      paths: ['/user.json'],
      hookPath: HOOK_SELF,
      toolMap: map,
    });
    expect(report.declinedStillMatched).toEqual(['slack_send_message']);
    expect(report.unmapped).toEqual([]);
    expect(report.unregistered).toEqual([]);
  });
});

describe('reconcile: the checklist and the answer', () => {
  const NAMES = [SLACK, SLACK_ALIAS, JIRA, 'mcp__claude_ai_Slack__slack_read_channel'];

  test('one row per tool HALF, with how many connectors offer it', () => {
    const r = reconcileTools(NAMES, DEFAULT_TOOL_MAP);
    const slack = r.halves.find((h) => h.half === 'slack_send_message');
    expect(slack).toEqual({
      half: 'slack_send_message', destination: 'slack', group: 'Slack: messages, sent now or scheduled',
      connectors: 2, declined: false,
    });
    expect(r.halves.map((h) => h.half)).not.toContain('slack_read_channel');
  });

  test('a declined half is shown unticked, never proposed', () => {
    const { map, declined, declinedRoutes } = declining('slack_send_message');
    const r = reconcileTools(NAMES, map, { declined, declinedRoutes, shadows: [] });
    expect(r.declined).toEqual([SLACK_ALIAS, SLACK].sort());
    expect(r.proposed.map((p) => p.name)).not.toContain(SLACK_ALIAS);
    expect(r.halves.find((h) => h.half === 'slack_send_message')?.declined).toBe(true);
    expect(describeReconciliation(r, 1, {}, '/t.json')).toContain('[ ] slack_send_message');
  });

  test('every heading is shown, a connector this session lacks included, and the answer is WHOLE', () => {
    // `retired_tool` is a decline no heading shows: no route uses it, so the answer leaves it.
    const { map, declined, declinedRoutes } = declining('slack_send_message', 'save_comment', 'retired_tool');
    // This session has no Linear connector, so `save_comment` reaches the checklist through its heading.
    const r = reconcileTools([SLACK, JIRA], map, { declined, declinedRoutes, shadows: [] });
    const linear = r.halves.find((h) => h.half === 'save_comment');
    expect(linear).toEqual({ half: 'save_comment', destination: 'linear', group: 'Linear: comments', connectors: 0, declined: true });
    expect(declinedAfter(r, declined, [], othersThan())).toEqual({ declined: ['retired_tool'] });
    expect(declinedAfter(r, declined, ['addCommentToJiraIssue', 'save_comment'], othersThan('addCommentToJiraIssue', 'save_comment'))).toEqual({
      declined: ['addCommentToJiraIssue', 'retired_tool', 'save_comment'],
    });
  });

  test('a name that is not on the checklist is refused, after either flag', () => {
    const r = reconcileTools(NAMES, DEFAULT_TOOL_MAP);
    expect(declinedAfter(r, [], ['slack_send_mesage'], ['addCommentToJiraIssue'])).toHaveProperty('error');
    expect(declinedAfter(r, [], ['addCommentToJiraIssue'], ['slack_send_mesage'])).toHaveProperty('error');
  });

  test('an answer that leaves a shown tool unanswered declines nothing, re-enables nothing', () => {
    // Slack declined earlier; this run shows Jira, Slack and Linear, and only Jira's answer came back.
    const { map, declined, declinedRoutes } = declining('slack_send_message');
    const r = reconcileTools([JIRA, SLACK, LINEAR], map, { declined, declinedRoutes, shadows: [] });
    for (const [chosen, reviewed] of [
      [['addCommentToJiraIssue'], []],
      [[], ['addCommentToJiraIssue']],
      [['addCommentToJiraIssue'], ['save_comment']],
    ] as [string[], string[]][]) {
      const after = declinedAfter(r, declined, chosen, reviewed);
      expect(after, `${chosen} / ${reviewed}`).toHaveProperty('error');
      if (!('error' in after)) continue;
      // It names what is open, under the heading setup asks about it by.
      expect(after.error).toContain('  Slack: messages, sent now or scheduled: slack_schedule_message slack_send_message\n');
      expect(after.error).toContain(
        reviewed.includes('save_comment') ? '  Linear: comments: save_diff_comment\n' : '  Linear: comments: save_comment save_diff_comment\n'
      );
    }
    // Nothing named: no answer reached it, so Slack's earlier decline stands.
    expect(declinedAfter(r, declined, [], [])).toHaveProperty('error');
    // Answered whole, it is taken.
    expect(declinedAfter(r, declined, ['addCommentToJiraIssue'], othersThan('addCommentToJiraIssue'))).toEqual({
      declined: ['addCommentToJiraIssue'],
    });
    expect(declinedAfter(r, declined, [], othersThan())).toEqual({ declined: [] });
  });

  test('setup asks which to review, one question per call, and asks again on the words the refusal uses', () => {
    const skill = readFileSync(fileURLToPath(new URL('../../../plugin/skills/setup/SKILL.md', import.meta.url)), 'utf8')
      .replace(/\s+/g, ' ');
    expect(skill).toContain('"Which of these should draftgate review?"');
    expect(skill).toContain('never two questions in one call');
    expect(skill).not.toMatch(/NOT review/);
    expect(skill).toContain(`"${UNANSWERED}"`);
    expect(skill).toContain('draftgate propose-tools --review <short name> ... --decline <short name> ... --write');
  });

  test('a tool after both flags is refused', () => {
    const r = reconcileTools([JIRA, SLACK], DEFAULT_TOOL_MAP);
    const after = declinedAfter(r, [], ['slack_send_message'], ['slack_send_message', 'addCommentToJiraIssue']);
    expect(after).toEqual({ error: expect.stringContaining('after both --decline and --review') });
  });

  test('the printed file KEEPS the aliases a decline covers, and loads', () => {
    const existing = { [SLACK_ALIAS]: { destination: 'slack', bodyField: 'text' } };
    const written = JSON.parse(proposedToolsJson([], existing, ['slack_send_message']));
    expect(written).toEqual({ ...existing, declined: ['slack_send_message'] });
    // The real test of the output: does the file it tells somebody to write actually load?
    expect(mergeToolConfig(DEFAULT_TOOL_MAP, written, 'x').dormant).toEqual([SLACK_ALIAS]);
    // And an empty answer removes the key rather than writing `"declined": []`.
    expect(JSON.parse(proposedToolsJson([], { declined: ['x'] }, []))).toEqual({});
  });

  test('re-enabling proposes a declined name that has no entry of its own', () => {
    // `--propose-tools` proposes `SLACK_ALIAS` before the decline; re-enabling must too, or the tool
    // comes back merely inferred.
    const { map, declined, declinedRoutes } = declining('slack_send_message');
    const r = reconcileTools([SLACK, SLACK_ALIAS], map, { declined, declinedRoutes, shadows: [] });
    expect(proposalsFor(r, []).map((p) => p.name)).toEqual([SLACK_ALIAS]);
    expect(proposalsFor(r, ['slack_send_message'])).toEqual([]);
  });

  test('the report lists exactly the proposals the printed file holds', () => {
    // A just-declined tool listed as a proposal would have an agent write a file contradicting the
    // decline.
    const r = reconcileTools([SLACK_ALIAS, JIRA], DEFAULT_TOOL_MAP);
    const text = describeReconciliation(r, 1, {}, '/t.json', ['slack_send_message']);
    expect(text).not.toContain(`${SLACK_ALIAS}  ->`);
    expect(text).toContain('"declined"');
  });

  test('declined names are counted in the header', () => {
    const { map, declined, declinedRoutes } = declining('slack_send_message');
    const r = reconcileTools([SLACK, SLACK_ALIAS, JIRA], map, { declined, declinedRoutes, shadows: [] });
    expect(describeReconciliation(r, 1, {}, '/t.json')).toContain('reconciled 3 tool name(s)');
  });
});

describe('--propose-tools --decline, through the real entry point', () => {
  // The argv parse lives in `main`, so only a subprocess reaches it.
  test('an answer is honoured whichever flag comes first', () => {
    const home = mkdtempSync(join(tmpdir(), 'draftgate-declined-'));
    try {
      writeFileSync(join(home, 'tools.json'), '{}');
      const run = (...args: string[]) =>
        spawnSync('bun', [HOOK_SELF, ...args], { env: { ...process.env, DRAFTGATE_HOME: home }, encoding: 'utf8' });
      const reviewing = othersThan('slack_send_message');
      for (const args of [
        ['--propose-tools', SLACK, JIRA, '--decline', 'slack_send_message', '--review', ...reviewing],
        ['--review', ...reviewing, '--decline', 'slack_send_message', '--propose-tools', SLACK, JIRA],
      ]) {
        const out = run(...args);
        expect(out.status, args.join(' ')).toBe(0);
        expect(out.stdout, args.join(' ')).toContain('"slack_send_message"');
        expect(out.stdout, args.join(' ')).toContain('applied (1 declined)');
      }
      // `--decline=x` is not a spelling this parses, so it is refused rather than dropped.
      const eq = run('--propose-tools', SLACK, '--decline=slack_send_message');
      expect(eq.status).toBe(1);
      expect(eq.stderr).toContain('does not take --decline=slack_send_message');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('setup with the Linear and GitHub answers lost writes nothing, and names what is open', () => {
    // Four connectors' tools; the person was asked about each, and only Jira's and Slack's answers
    // reached the command.
    const home = mkdtempSync(join(tmpdir(), 'draftgate-declined-'));
    try {
      const file = join(home, 'tools.json');
      writeFileSync(file, '{}');
      const run = (...args: string[]) =>
        spawnSync('bun', [HOOK_SELF, ...args], { env: { ...process.env, DRAFTGATE_HOME: home }, encoding: 'utf8' });
      const names = [JIRA, SLACK, LINEAR, 'mcp__claude_ai_Github_MCP__add_issue_comment'];
      // The other shapes of a partial answer are `declinedAfter`'s, above; these two cross `main`'s
      // parse.
      for (const answer of [
        ['--review', 'addCommentToJiraIssue', '--decline', 'slack_send_message'],
        // Every answer lost: nothing after the flag.
        ['--decline'],
      ]) {
        const r = run('--propose-tools', ...names, ...answer, '--write');
        expect(r.status, answer.join(' ')).toBe(1);
        expect(r.stdout).toBe('');
        expect(r.stderr).toContain('the answer leaves these unanswered, so it was not taken:\n');
        expect(r.stderr).toContain('  Linear: comments: save_comment save_diff_comment\n');
        expect(r.stderr).toContain('  GitHub: issues and issue comments: add_issue_comment issue_write update_issue_comment\n');
        expect(readFileSync(file, 'utf8')).toBe('{}');
      }
      const both = run('--propose-tools', ...names, '--review-all', '--decline', 'slack_send_message', '--write');
      expect(both.status).toBe(1);
      expect(both.stderr).toContain('--review-all is the whole answer');
      expect(readFileSync(file, 'utf8')).toBe('{}');
      // The whole answer is written.
      const whole = run(
        '--propose-tools', ...names, '--review', ...othersThan('slack_send_message', 'add_issue_comment'),
        '--decline', 'slack_send_message', 'add_issue_comment', '--write'
      );
      expect(whole.status).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ declined: ['add_issue_comment', 'slack_send_message'] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
