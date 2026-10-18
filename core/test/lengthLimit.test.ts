/**
 * Destination length limits, pinned to the probe rows at both ends of each bracket: the longest
 * accepted body must not block, the shortest refused one must. For Jira, whose count is a lower
 * bound, the first half matters most.
 */

import { describe, expect, test } from 'bun:test';
import { render, proseWarnings } from '../src/index';
import { lengthWarnings, codePointLength, utf8Length } from '../src/lengthLimit';
import { profiles } from '../src/profiles';
import type { WarningCode } from '../src/warnings';
import { jiraLengthLowerBound } from '../src/profiles/jira';
import type { AdfDocument } from '../src/adf/types';

const codes = (body: string, destination: string) => render(body, destination).warnings.map((w) => w.code);
const blocked = (body: string, destination: string) => render(body, destination).blocked;

describe('the two counts', () => {
  test('code points count a surrogate pair once; UTF-8 counts it as four bytes', () => {
    expect(codePointLength('a😀b')).toBe(3);
    expect(utf8Length('a😀b')).toBe(6);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    // A lone surrogate is what `TextEncoder` writes as U+FFFD, three bytes.
    expect(utf8Length('\ud800')).toBe(3);
    expect(codePointLength('\ud800x')).toBe(2);
  });
});

describe('GitHub: 262,144 UTF-8 BYTES, probed both ways', () => {
  test('262,144 ASCII is accepted, 262,145 is refused', () => {
    expect(blocked('x'.repeat(262_144), 'github')).toBe(false);
    expect(codes('x'.repeat(262_145), 'github')).toContain('github/body-too-long');
    expect(blocked('x'.repeat(262_145), 'github')).toBe(true);
  });

  test('the unit is BYTES: 131,073 x é (262,146 bytes) is refused though it is half as many characters', () => {
    expect(blocked('é'.repeat(131_073), 'github')).toBe(true);
    expect(blocked('é'.repeat(131_072), 'github')).toBe(false);
  });
});

describe('Linear: 100,000 characters', () => {
  test('100,000 is accepted, 100,001 is refused', () => {
    expect(blocked('x'.repeat(100_000), 'linear')).toBe(false);
    expect(codes('x'.repeat(100_001), 'linear')).toEqual(['linear/body-too-long']);
  });
});

describe('Slack: 12,000 characters for the whole message', () => {
  test('the probe rows: 11,542 accepted, 12,037 refused', () => {
    expect(blocked('x'.repeat(11_542), 'slack')).toBe(false);
    expect(blocked('x'.repeat(12_000), 'slack')).toBe(false);
    expect(codes('x'.repeat(12_037), 'slack')).toContain('slack/body-too-long');
  });

  test('a 5,027-character paragraph is not a problem: it arrived whole', () => {
    expect(codes('x'.repeat(5_027), 'slack')).not.toContain('slack/body-too-long');
  });
});

describe('Jira: a lower bound on its own count, never blocking what it accepted', () => {
  const para = (n: number, c = 'x') => c.repeat(n);
  const doc = (...content: AdfDocument['content']): AdfDocument => ({ version: 1, type: 'doc', content });
  const p = (text: string, href?: string) => ({
    type: 'paragraph',
    content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) }],
  });

  // Every ACCEPTED row: none may block.
  test.each([
    ['one paragraph of 32,767', para(32_767)],
    ['two paragraphs, 16,383 + 16,382', `${para(16_383)}\n\n${para(16_382, 'y')}\n`],
    ['32 paragraphs x 1,000', Array.from({ length: 32 }, () => para(1_000)).join('\n\n')],
    ['a link, text 16,000 + href 16,760', `[${para(16_000)}](https://e.test/${para(16_760 - 15, 'h')})`],
  ])('accepted by Jira, so NOT blocked: %s', (_name, body) => {
    const r = render(body, 'jira');
    expect(r.warnings.map((w) => w.code)).not.toContain('jira/body-too-long');
    expect(r.blocked).toBe(false);
  });

  // Every REFUSED row: each must block.
  test.each([
    ['two paragraphs, 16,383 + 16,383', `${para(16_383)}\n\n${para(16_383, 'y')}\n`],
    ['a link, text 20,000 + href 14,015', `[${para(20_000)}](https://e.test/${para(14_015 - 15, 'h')})`],
  ])('refused by Jira (400), so blocked: %s', (_name, body) => {
    expect(codes(body, 'jira')).toContain('jira/body-too-long');
    expect(blocked(body, 'jira')).toBe(true);
  });

  test('a comment of bare URLs is NOT near the limit because the editor spells them `[u](u)`', () => {
    // Measured: 250 lines like this are 16,640 characters, and loading the draft writes 33,530 --
    // which an estimate from the markdown would call "close to the limit". Wiki markup writes such
    // a link as the bare URL, and the estimate reads the ADF.
    const urls = Array.from({ length: 400 }, (_, i) => `- https://ci.example.com/job/${i}/console/x`).join('\n');
    expect(codes(urls, 'jira')).toEqual([]);
    expect(codes(urls.replace(/- (\S+)/g, '- [$1]($1)'), 'jira')).toEqual([]);
  });

  test('a draft blocked ONLY for length is offered no repair, since none shortens it', () => {
    expect(render(`${para(16_383)}\n\n${para(16_383, 'y')}\n`, 'jira').suggestedFix).toBeUndefined();
  });

  test('the count on the probed shapes is exactly the probe arithmetic', () => {
    expect(jiraLengthLowerBound(doc(p(para(16_383)), p(para(16_382))))).toBe(32_767);
    expect(jiraLengthLowerBound(doc(p(para(16_383)), p(para(16_383))))).toBe(32_768);
    // The `[`, `|`, `]` are NOT counted: the accepted link row leaves room for up to seven.
    expect(jiraLengthLowerBound(doc(p('abc', 'https://e.test')))).toBe(3 + 14);
  });

  test('a link split across text nodes counts its href ONCE, and an autolink counts it not at all', () => {
    const href = 'https://e.test/x';
    const split = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a', marks: [{ type: 'strong' }, { type: 'link', attrs: { href } }] },
        { type: 'text', text: ' b', marks: [{ type: 'link', attrs: { href } }] },
      ],
    });
    expect(jiraLengthLowerBound(split)).toBe(3 + href.length);
    // Wiki markup writes a link whose text is its href as the bare URL; counting both would block a
    // bare 20,000-character URL wrongly.
    expect(jiraLengthLowerBound(doc(p(href, href)))).toBe(href.length);
    const bare = `https://e.test/${para(20_000)}`;
    expect(blocked(bare, 'jira')).toBe(false);
  });

  test('near the limit is a WARNING, which does not block', () => {
    const r = render(para(30_000), 'jira');
    expect(r.warnings.map((w) => [w.code, w.severity])).toEqual([['jira/body-near-limit', 'warning']]);
    expect(r.blocked).toBe(false);
    // Markdown the lower bound undercounts (list markers count zero there) still warns.
    const list = Array.from({ length: 8_000 }, () => '- abc').join('\n');
    expect(codes(list, 'jira')).toEqual(['jira/body-near-limit']);
    expect(codes(para(1_000), 'jira')).toEqual([]);
  });
});

/*
 * `bodyLimit` is a declaration each profile's `convert()` applies by hand, so this asks the
 * consumer: at the declared refusal, every profile's render blocks on its own length code.
 */
describe('every declared body limit is ENFORCED by that profile', () => {
  for (const [name, profile] of Object.entries(profiles)) {
    test(name, () => {
      const { accepted, refused } = profile.bodyLimit;
      const own = `${name}/body-too-long` as WarningCode;
      expect(codes('x'.repeat(accepted), name)).not.toContain(own);
      expect(codes('x'.repeat(refused), name)).toContain(own);
    });
  }
});

describe('a body bracket that is not exact is a warning inside it, like a title', () => {
  test('within, unknown, over', () => {
    const limit = { accepted: 10, refused: 20, unit: 'characters' } as const;
    const at = (n: number) =>
      lengthWarnings({ code: 'slack/body-too-long', subject: 'x', value: 'x'.repeat(n), limit, refuses: 'X refuses one' })
        .map((w) => w.severity);
    expect(at(10)).toEqual([]);
    expect(at(11)).toEqual(['warning']);
    expect(at(19)).toEqual(['warning']);
    expect(at(20)).toEqual(['error']);
  });
});

describe('titles: `proseWarnings` reads the profile, keyed by field path AND the probed tool', () => {
  const TOOLS = {
    linear: 'mcp__claude_ai_Linear__save_issue',
    github: 'mcp__claude_ai_Github_MCP__issue_write',
    jira: 'mcp__x__editJiraIssue',
    slack: 'mcp__claude_ai_Slack__slack_send_message',
  };
  const title = (
    value: string,
    destination: 'linear' | 'github' | 'jira' | 'slack',
    field = 'title',
    tool: string | undefined = TOOLS[destination]
  ) => proseWarnings([{ field, value }], destination, tool).map((w) => [w.code, w.severity]);

  test('Linear: 512 is accepted, 513 is refused', () => {
    expect(title('x'.repeat(512), 'linear')).toEqual([]);
    expect(title('x'.repeat(513), 'linear')).toEqual([['prose/too-long', 'error']]);
  });

  test('GitHub: accepted at 1,024, refused at 4,096, and the gap between is only a warning', () => {
    expect(title('x'.repeat(1_024), 'github')).toEqual([]);
    expect(title('x'.repeat(1_025), 'github')).toEqual([['prose/too-long', 'warning']]);
    expect(title('x'.repeat(4_095), 'github')).toEqual([['prose/too-long', 'warning']]);
    expect(title('x'.repeat(4_096), 'github')).toEqual([['prose/too-long', 'error']]);
  });

  test('a field nobody probed gets no limit: a Jira summary, or a GitHub field that is not `title`', () => {
    expect(title('x'.repeat(10_000), 'jira', 'fields.summary')).toEqual([]);
    expect(title('x'.repeat(10_000), 'github', 'name')).toEqual([]);
    // `Object.hasOwn`, so a field named after an `Object.prototype` member is not a limit either.
    expect(title('x'.repeat(10_000), 'github', 'toString')).toEqual([]);
  });

  test('a tool the limit was NOT probed on gets no claim: a PR title, a Linear document, no tool at all', () => {
    expect(title('x'.repeat(10_000), 'github', 'title', 'mcp__claude_ai_Github_MCP__create_pull_request')).toEqual([]);
    expect(title('x'.repeat(10_000), 'linear', 'title', 'mcp__claude_ai_Linear__save_document')).toEqual([]);
    expect(proseWarnings([{ field: 'title', value: 'x'.repeat(10_000) }], 'linear')).toEqual([]);
    // Any server prefix: the tool HALF is what was probed.
    expect(title('x'.repeat(513), 'linear', 'title', 'mcp__linear__save_issue')).toEqual([['prose/too-long', 'error']]);
  });

  test('an empty title is still `prose/empty`, and only that', () => {
    expect(title('', 'linear')).toEqual([['prose/empty', 'error']]);
  });
});
