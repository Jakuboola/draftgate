/**
 * What a line field holds that its `<input>` cannot show, per destination, as probed: Jira refuses
 * an LF in a `summary` (PUT, 400, nothing written), GitHub stores LF and CR verbatim in an issue
 * title, Linear stores an LF as a space and a CR verbatim.
 *
 * Every special character here is written as an escape, never literally: a literal bidi control in
 * source reverses how the rest of the line displays.
 */
import { describe, expect, test } from 'bun:test';
import { proseWarnings } from '../src/render';
import { hideLineBreaks, showLineBreaks } from '../src/lineCharacters';

type Dest = Parameters<typeof proseWarnings>[1];

/** The tool each destination's line-break fact was probed on. */
const PROBED_TOOL: Record<Dest, string> = {
  jira: 'mcp__atlassian__editJiraIssue',
  github: 'mcp__claude_ai_Github_MCP__issue_write',
  linear: 'mcp__claude_ai_Linear__save_issue',
  slack: 'mcp__claude_ai_Slack__slack_send_message',
};

const one = (field: string, value: string, destination: Dest, tool: string | undefined = PROBED_TOOL[destination]) =>
  proseWarnings([{ field, value }], destination, tool).map((w) => [w.code, w.severity]);

describe('a line break in a line field', () => {
  test('is an ERROR on a Jira summary, on the edit tool the probe used', () => {
    expect(one('fields.summary', 'a\nb', 'jira')).toEqual([['prose/line-break', 'error']]);
  });

  test('...and only a warning for any field, tool or break nobody probed', () => {
    expect(one('fields.customfield_10001', 'a\nb', 'jira')).toEqual([['prose/line-break', 'warning']]);
    expect(one('fields.notsummary', 'a\nb', 'jira')).toEqual([['prose/line-break', 'warning']]);
    // Keyed by the exact PATH, like `lineLimits`: `summary` is `createJiraIssue`'s spelling, and
    // that call is not probed.
    expect(one('summary', 'a\nb', 'jira')).toEqual([['prose/line-break', 'warning']]);
    expect(one('fields.summary', 'a\rb', 'jira')).toEqual([['prose/line-break', 'warning']]);
    // The probe was a PUT; creating an issue is a different call.
    expect(one('fields.summary', 'a\nb', 'jira', 'mcp__atlassian__createJiraIssue')).toEqual([
      ['prose/line-break', 'warning'],
    ]);
    // An unnamed tool gets no claim either.
    const unnamed = proseWarnings([{ field: 'fields.summary', value: 'a\nb' }], 'jira');
    expect(unnamed.map((w) => [w.code, w.severity])).toEqual([['prose/line-break', 'warning']]);
  });

  test('is a warning where the destination accepts it, and the message says what it does', () => {
    const at = (d: Dest, tool = PROBED_TOOL[d]) => proseWarnings([{ field: 'title', value: 'a\nb' }], d, tool);
    expect(at('github').map((w) => w.severity)).toEqual(['warning']);
    expect(at('github')[0]!.message).toContain('two lines');
    expect(at('linear')[0]!.message).toContain('as a space');
    expect(at('slack')[0]!.message).toContain('not been measured');
    // A pull-request title is not probed, so it makes no claim about what GitHub does.
    expect(at('github', 'mcp__claude_ai_Github_MCP__create_pull_request')[0]!.message).toContain(
      'not been measured'
    );
  });

  test('names the field, and reads for the agent as well as the reviewer: no box, no picture', () => {
    const [w] = proseWarnings([{ field: 'fields.summary', value: 'a\nb' }], 'jira', PROBED_TOOL.jira);
    expect(w!.field).toBe('fields.summary');
    expect(w!.message).toContain('one line');
    expect(w!.message).not.toContain('\u240A');
    expect(w!.message).not.toContain('box');
  });

  test('a CR and an LF are two findings, since a destination can treat them differently', () => {
    expect(one('title', 'a\r\nb', 'linear').map(([c]) => c)).toEqual([
      'prose/line-break',
      'prose/line-break',
    ]);
  });

  test('an empty field is still only `prose/empty`', () => {
    expect(one('fields.summary', '\n', 'jira')).toEqual([['prose/empty', 'error']]);
  });
});

describe('a control character in a line field', () => {
  test.each([
    ['U+202E (right-to-left override)', '\u202E'],
    ['U+2066 (isolate)', '\u2066'],
    ['U+200F (RLM)', '\u200F'],
    ['U+061C (ALM)', '\u061C'],
    ['U+0007 (BEL)', '\u0007'],
    ['U+007F (DEL)', '\u007F'],
    ['U+0085 (C1 NEL)', '\u0085'],
    ['U+2028 (line separator)', '\u2028'],
    ['U+2029 (paragraph separator)', '\u2029'],
    ['U+200B (zero-width space)', '\u200B'],
    ['U+FEFF (BOM)', '\uFEFF'],
  ])('%s is a warning on every destination', (_name, c) => {
    for (const d of ['jira', 'github', 'linear', 'slack'] as const) {
      expect(one('title', `a${c}b`, d)).toEqual([['prose/control-character', 'warning']]);
    }
  });

  test('it names the code point, since the character itself draws nothing', () => {
    const [w] = proseWarnings([{ field: 'title', value: 'abc\u202Edef' }], 'github');
    expect(w!.message).toContain('U+202E');
  });

  test('a TAB is not flagged: the input draws it, and Jira and GitHub store it verbatim', () => {
    expect(one('title', 'a\tb', 'github')).toEqual([]);
  });

  test('an ordinary title -- accents, emoji, and a ZWJ family emoji -- is not flagged at all', () => {
    // U+200D joins the family emoji; flagging it would warn on ordinary text.
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(one('title', `Export fails é \u{1F600} ${family}`, 'github')).toEqual([]);
  });
});

describe('the window draws a break as a picture, and gets the break back', () => {
  test('the round trip is exact, so an untouched field sends the agent\'s value', () => {
    for (const v of ['a\nb', 'a\r\nb', '\r', 'no breaks', '']) {
      expect(hideLineBreaks(showLineBreaks(v, v), v)).toBe(v);
    }
  });

  test('the shown value has no break an `<input>` could strip, and keeps its length', () => {
    const v = 'Fix crash\nSecond line\r';
    const shown = showLineBreaks(v, v);
    expect(shown).not.toMatch(/[\r\n]/);
    expect(shown).toBe('Fix crash\u240ASecond line\u240D');
    expect(shown.length).toBe(v.length);
  });

  test('a picture the AGENT wrote is never turned into a break by an edit', () => {
    // Mapping back would make the reviewer's first keystroke send a real LF nobody wrote.
    const agent = 'Legend: \u240A = newline';
    expect(showLineBreaks(agent, agent)).toBe(agent);
    expect(hideLineBreaks(`${agent} (edited)`, agent)).toBe(`${agent} (edited)`);
  });
});
