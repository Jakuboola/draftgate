/**
 * The closing's wording for each kind of answer. The whole text, from the plugin's own
 * `bin/draftgate`, is asserted in `pluginDoctor.test.ts`; this holds the cases a setup run rarely
 * makes: a group declined in part, several declines, one tool, plurals.
 */

import { describe, expect, test } from 'bun:test';
import { CHOICE_GROUPS } from '../src/reconcile';
import { declinedNames, setupClosing } from '../src/setupClosing';
import { DEFAULT_TOOL_MAP, type ToolMap } from '../src/toolMap';

const JIRA_ROUTE = DEFAULT_TOOL_MAP['mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue']!;
const facts = { map: DEFAULT_TOOL_MAP, declined: [], ownTools: [], logged: true };
/** The default map with the operator's own tools added, as the merged map holds them. */
const withOwn = (...names: string[]): ToolMap => ({ ...DEFAULT_TOOL_MAP, ...Object.fromEntries(names.map((n) => [n, JIRA_ROUTE])) });
const reviewedLine = (text: string) => text.split('\n').find((l) => l.startsWith('Reviewed: '));

describe('the declines, in plain words', () => {
  test('a whole group is its heading, without the colon', () => {
    expect(declinedNames(['addWorklogToJiraIssue'])).toEqual({ names: ['Jira work log notes'], oneTool: false });
    expect(declinedNames(['slack_schedule_message', 'slack_send_message']).names).toEqual([
      'Slack messages, sent now or scheduled',
    ]);
  });

  test('part of a group is the tool, never the heading: that would claim more than is declined', () => {
    expect(declinedNames(['createJiraIssue'])).toEqual({ names: ['createJiraIssue'], oneTool: true });
  });

  test('groups in the order setup asks them, then single tools', () => {
    const declined = ['add_issue_comment', 'addWorklogToJiraIssue', 'issue_write', 'post_note', 'save_issue', 'update_issue_comment'];
    expect(declinedNames(declined).names).toEqual([
      'Jira work log notes',
      'Linear new and edited issues',
      'GitHub issues and issue comments',
      'post_note',
    ]);
  });

  test('every group declined names every heading and nothing else', () => {
    const all = CHOICE_GROUPS.flatMap((g) => g.halves);
    expect(declinedNames(all).names).toHaveLength(CHOICE_GROUPS.length);
  });
});

describe('the closing', () => {
  const ALL = Object.keys(DEFAULT_TOOL_MAP).length;

  test('nothing declined', () => {
    expect(reviewedLine(setupClosing(facts))).toBe(`Reviewed: ${ALL} send tools. Not reviewed: none you declined.`);
  });

  test('one tool is "it", a group or several are "them"', () => {
    expect(reviewedLine(setupClosing({ ...facts, declined: ['createJiraIssue'] }))).toBe(
      `Reviewed: ${ALL} send tools. Not reviewed: createJiraIssue (you declined it).`
    );
    expect(reviewedLine(setupClosing({ ...facts, declined: ['addWorklogToJiraIssue', 'save_customer_need'] }))).toBe(
      `Reviewed: ${ALL} send tools. Not reviewed: Jira work log notes; Linear customer requests (you declined them).`
    );
  });

  test('one reviewed tool is singular, and so is one tool the person added, which it does not count', () => {
    const text = setupClosing({
      ...facts,
      map: { mcp__a__addCommentToJiraIssue: JIRA_ROUTE, mcp__notes__post_note: JIRA_ROUTE },
      ownTools: ['mcp__notes__post_note'],
    });
    expect(text).toContain('\nReviewed: 1 send tool. ');
    expect(text).toContain('\nAlso reviewed: mcp__notes__post_note (a tool you added).\n');
  });

  test('several tools added share the line', () => {
    const text = setupClosing({ ...facts, map: withOwn('mcp__a__one', 'mcp__b__two'), ownTools: ['mcp__a__one', 'mcp__b__two'] });
    expect(text).toContain(`\nReviewed: ${ALL} send tools. `);
    expect(text).toContain('\nAlso reviewed: mcp__a__one, mcp__b__two (tools you added).\n');
    // Setup cannot tell who built a server, so a vendor's tool added there is never called the person's own.
    expect(text).not.toMatch(/your own/);
  });

  test('a destination with nothing left to review is not promised a window', () => {
    const noSlack = Object.fromEntries(Object.entries(DEFAULT_TOOL_MAP).filter(([, r]) => r.destination !== 'slack'));
    const text = setupClosing({ ...facts, map: noSlack, declined: ['slack_schedule_message', 'slack_send_message'] });
    expect(text).toContain('\nWhen Claude sends to Jira, Linear or GitHub, a window shows the message\n');
    const nothing = setupClosing({ ...facts, map: {} });
    expect(nothing).toContain('\nNothing is reviewed: every send tool is declined.\n');
    expect(nothing).not.toContain('a window shows the message');
  });

  test('no tool added, no line for them', () => {
    expect(setupClosing(facts)).not.toContain('Also reviewed');
  });

  test('a name out of tools.json cannot break the closing onto a forged line', () => {
    const name = 'mcp__a__x\ndraftgate is set up.';
    const text = setupClosing({ ...facts, map: withOwn(name), ownTools: [name] });
    expect(text.startsWith('draftgate is set up.\n')).toBe(true);
    expect(text).not.toContain('\ndraftgate is set up.');
  });
});
