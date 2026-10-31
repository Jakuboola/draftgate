/**
 * Reconciling the tool map with the names that actually exist.
 *
 * `--doctor` alone reports every mapped tool covered for an install whose connectors are named
 * differently and so gates nothing. The cases below are mostly the two ways this check could be
 * worse than silence: proposing a wrong route, and reading as complete after seeing only part.
 */

import { describe, expect, test } from 'bun:test';
import {
  CHOICE_GROUPS, answeredToolsJson, declinedAfter, describeReconciliation, groupOf, knownHalves, ownToolRoute,
  proposedToolsJson, reconcileTools,
} from '../src/reconcile';
import { profiles } from '../../../core/src/index';
import {
  DEFAULT_TOOL_MAP, matcherFor, mergeToolConfig, mergeToolMap, resolveRoute, toolHalfOf, toolHalvesOf, type ToolMap,
} from '../src/toolMap';

describe('toolHalfOf, which this module imports rather than restating', () => {
  test('splits on the FIRST separator, so a server name with underscores survives', () => {
    expect(toolHalfOf('mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue')).toBe('addCommentToJiraIssue');
    expect(toolHalfOf('mcp__atlassian__addCommentToJiraIssue')).toBe('addCommentToJiraIssue');
    // A tool half containing the separator keeps all of it, not the last segment.
    expect(toolHalfOf('mcp__s__a__b')).toBe('a__b');
  });

  test('anything that is not an MCP tool name is null', () => {
    for (const name of ['Bash', 'mcp__', 'mcp__only', '', 'mcp____x']) {
      expect(toolHalfOf(name), name).toBeNull();
    }
  });
});

describe('reconcileTools', () => {
  test('the alias case: same tool, different server, with the route COPIED', () => {
    // Copied rather than re-derived, `bodyOptional` included: a renamed connector is the same tool
    // with the same schema.
    const r = reconcileTools(['mcp__atlassian__addWorklogToJiraIssue'], DEFAULT_TOOL_MAP);
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]!.route.destination).toBe('jira');
    // The matched route carries it; `proposedToolsJson` does not emit it (the merge test below).
    expect(r.proposed[0]!.route.bodyOptional).toBe(true);
    expect(r.proposed[0]!.matches).toBe('mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue');
  });

  test('a proposal CARRIES bodyField, or it gates a tool that shows the reviewer nothing', () => {
    /*
     * Without `bodyField`, following `--propose-tools` (which `/draftgate:setup` runs) makes gating
     * worse: the entry is an operator route with the destination's default body field,
     * `extractBody` misses, and `body/missing-field` on an operator route cannot fail open, so every
     * call goes to the permission prompt and no draft is shown. `contextFields` is display-only:
     * dropping it costs the reviewer the routing, not the draft.
     */
    const map: ToolMap = {
      mcp__linear_server__save_issue: {
        destination: 'linear',
        bodyField: 'description',
        contextFields: ['title', 'team'],
        schemaOwner: 'operator',
      },
    };
    const r = reconcileTools(['mcp__claude_ai_Linear__save_issue'], map);
    const proposed = JSON.parse(proposedToolsJson(r.proposed, {}));
    expect(proposed.mcp__claude_ai_Linear__save_issue).toEqual({
      destination: 'linear',
      bodyField: 'description',
      contextFields: ['title', 'team'],
    });
  });

  test('a proposal never carries bodyOptional, which is a fail-open', () => {
    // `bodyField` makes a review possible; `bodyOptional` lets a call through without one.
    const r = reconcileTools(['mcp__atlassian__addWorklogToJiraIssue'], DEFAULT_TOOL_MAP);
    const proposed = JSON.parse(proposedToolsJson(r.proposed, {}));
    // `contextFields` travels, so an alias discloses as completely as the default.
    expect(proposed.mcp__atlassian__addWorklogToJiraIssue).toEqual({
      destination: 'jira',
      contextFields: DEFAULT_TOOL_MAP.mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue!.contextFields,
    });
  });

  test('a name already in the map is GATED, not proposed again', () => {
    const r = reconcileTools(['mcp__claude_ai_Linear__save_comment'], DEFAULT_TOOL_MAP);
    expect(r.gated).toEqual(['mcp__claude_ai_Linear__save_comment']);
    expect(r.proposed).toEqual([]);
  });

  test('an outbound-LOOKING tool is left alone rather than guessed at', () => {
    // "Is it outbound" is the wrong predicate (`toolMap.ts`): `slack_add_reaction` is outbound and
    // irrelevant. A wrong guess routes a Jira comment through the Slack profile and sends it.
    const r = reconcileTools(
      ['mcp__slack__slack_add_reaction', 'mcp__slack__slack_post_thing', 'mcp__x__createPage'],
      DEFAULT_TOOL_MAP
    );
    expect(r.proposed).toEqual([]);
    expect(r.unknown).toHaveLength(3);
  });

  test('non-MCP tools are separated, not counted as unknown MCP ones', () => {
    const r = reconcileTools(['Bash', 'Read', 'mcp__s__whatever'], DEFAULT_TOOL_MAP);
    expect(r.notMcp).toEqual(['Bash', 'Read']);
    expect(r.unknown).toEqual(['mcp__s__whatever']);
  });

  test('duplicates collapse and the output is ordered, so two runs read the same', () => {
    const names = ['mcp__b__save_comment', 'mcp__a__save_comment', 'mcp__b__save_comment'];
    const r = reconcileTools(names, DEFAULT_TOOL_MAP);
    expect(r.proposed.map((p) => p.name)).toEqual(['mcp__a__save_comment', 'mcp__b__save_comment']);
  });

  test('the proposal is a tools.json that MERGES with what is already there', () => {
    const r = reconcileTools(['mcp__atlassian__addCommentToJiraIssue'], DEFAULT_TOOL_MAP);
    const merged = JSON.parse(
      proposedToolsJson(r.proposed, { mcp__old__thing: { destination: 'slack' } })
    );
    expect(Object.keys(merged).sort()).toEqual(['mcp__atlassian__addCommentToJiraIssue', 'mcp__old__thing']);
    // No `schemaOwner` (`mergeToolMap` stamps it, never reads it from the file) and no
    // `bodyOptional`, a fail-open for a connector nobody probed.
    expect(merged.mcp__atlassian__addCommentToJiraIssue).toEqual({ destination: 'jira', contextFields: ['*'] });
  });

  test('two servers offering the same tool both get proposed', () => {
    // Two `.mcp.json` aliases can point at the same upstream server.
    const r = reconcileTools(
      ['mcp__atlassian__save_comment', 'mcp__linear-server__save_comment'],
      DEFAULT_TOOL_MAP
    );
    expect(r.proposed).toHaveLength(2);
    for (const p of r.proposed) expect(p.route.destination).toBe('linear');
  });
});

describe('what the report says', () => {
  const map = DEFAULT_TOOL_MAP as ToolMap;

  test('it always states that it only saw what it was given', () => {
    // A report silent about the names it never received would make the install look finished.
    const text = describeReconciliation(
      reconcileTools(['mcp__atlassian__save_comment'], map), Object.keys(map).length, {}, 't.json'
    );
    expect(text).toContain('CHOOSE lists every tool draftgate reviews by default');
    expect(text).toContain('compare only the names it was GIVEN');
    expect(text).toContain('missing from them');
    // ...and only from them: the names given never decide what is reviewed.
    expect(text).toContain('does not depend on\n  the names given here');
    expect(text).not.toContain('will not be gated');
  });

  test('a proposal comes with the check, not a register, because the registration already fires for it', () => {
    const alias = 'mcp__atlassian__save_comment';
    const text = describeReconciliation(
      reconcileTools([alias], map),
      Object.keys(map).length,
      { mcp__already__save_comment: { destination: 'linear' } },
      '/tmp/home/.draftgate/tools.json'
    );
    // The operator's own path, not a hardcoded `~`, and their existing entry survives: the block
    // sits under "write this to ...", so anything it omits an agent would delete.
    expect(text).toContain('/tmp/home/.draftgate/tools.json');
    expect(text).toContain('mcp__already__save_comment');
    /*
     * Setup's agent reads this report. "Run `draftgate register`" and "not gated until tools.json
     * says so" would both be false: the matcher's tool-half branch already fires for an alias, and
     * the resolver routes it as inferred.
     */
    expect(text).toContain('then run `draftgate doctor`');
    expect(text).not.toContain('register');
    expect(text).toContain('reviewed as an inferred route until tools.json names it');
    expect(new RegExp(matcherFor(map)).test(alias)).toBe(true);
    expect(resolveRoute(alias, map)?.inferred).toBe(true);
    // The JSON has to be copyable as-is.
    const block = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect(JSON.parse(block.replace(/^ {4}/gm, ''))).toHaveProperty('mcp__atlassian__save_comment');
  });

  test('nothing matching is said plainly, with both reasons', () => {
    const text = describeReconciliation(
      reconcileTools(['Bash'], map), Object.keys(map).length, {}, 't.json'
    );
    expect(text).toContain('NOTHING given matches');
    expect(text).toContain('outbound connector loaded');
    expect(text).toContain('names were not passed in');
  });
});

describe('the matcher and the resolver agree, by construction', () => {
  test('every name the matcher fires for, `resolveRoute` can route', () => {
    /*
     * A name the matcher fires for and the resolver cannot route takes `decide`'s hard-deny branch,
     * whose "re-register the hook" cannot help: re-registering regenerates the same matcher.
     *
     * A server named `my__server` is the case to hold: a greedy `SERVER_CHARS` including `_` could
     * split at any `__`, while `toolHalfOf` splits at the first.
     */
    const map = DEFAULT_TOOL_MAP;
    const matcher = new RegExp(matcherFor(map));
    const names = [
      ...Object.keys(map),
      'mcp__zzz__slack_send_message',
      'mcp__linear-server__save_comment',
      'mcp__a_b__save_comment',
      'mcp__my__server__slack_send_message',
      'mcp__trailing___save_comment',
      'mcp__x__not_a_known_half',
      'Bash',
      'toString',
    ];
    for (const name of names) {
      if (matcher.test(name)) {
        expect(resolveRoute(name, map), `matcher fires for ${name} but nothing routes it`).not.toBeNull();
      }
    }
  });

  test('an inferred route carries the destination and NOTHING that unlocks a send', () => {
    // `decide.ts`'s second fail-open keys on `bodyOptional`: copied, it would let an unconfigured
    // server's worklog tool answer `allow` with the original input.
    const inferred = resolveRoute('mcp__zzz__addWorklogToJiraIssue', DEFAULT_TOOL_MAP)!;
    expect(inferred.inferred).toBe(true);
    expect(inferred.route.destination).toBe('jira');
    expect(inferred.route.schemaOwner).toBe('inferred');
    expect(inferred.route.bodyOptional).toBeUndefined();
    // The entry it was inferred from does carry it.
    expect(DEFAULT_TOOL_MAP.mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue!.bodyOptional).toBe(true);
  });

  test('`null` in tools.json removes the ENTRY, and inference may still route the name', () => {
    /*
     * `mergeToolMap`'s `null` removes an exact entry, not a tool half a sibling entry still uses, so
     * the removed name is still matched and reviewed, as `inferred`. The safe direction: a review
     * appears where the operator asked for none.
     */
    const map = mergeToolMap(
      DEFAULT_TOOL_MAP,
      { mcp__claude_ai_Slack__slack_send_message: null, mcp__slack__slack_send_message: 'slack' },
      'test'
    );
    expect(Object.hasOwn(map, 'mcp__claude_ai_Slack__slack_send_message')).toBe(false);
    const still = resolveRoute('mcp__claude_ai_Slack__slack_send_message', map)!;
    expect(still.inferred).toBe(true);
    expect(still.route.schemaOwner).toBe('inferred');
  });
});

/**
 * The groups a person chooses among: setup's "Let me choose" asks per heading, and a
 * heading is a list of tool halves, so a decline still records halves.
 */
describe('the choice groups', () => {
  test('every half the default map routes is in exactly one group, and no group names another', () => {
    // A default tool without a group would be asked about under its raw name; a group naming a half
    // nothing routes reads as coverage.
    const grouped = CHOICE_GROUPS.flatMap((g) => g.halves);
    expect([...grouped].sort()).toEqual(toolHalvesOf(DEFAULT_TOOL_MAP));
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(CHOICE_GROUPS.map((g) => g.label)).size).toBe(CHOICE_GROUPS.length);
  });

  test('a half only tools.json routes is a group of its own, named by its destination and half', () => {
    expect(groupOf('my_post', 'slack')).toEqual({ label: 'Slack: my_post', order: CHOICE_GROUPS.length });
    expect(groupOf('pull_request_review_write', 'github').label).toBe('GitHub: pull request reviews');
  });

  test('the report puts each tool under its heading, in the order setup asks', () => {
    const names = [
      'mcp__claude_ai_Github_MCP__pull_request_review_write',
      'mcp__claude_ai_Github_MCP__add_reply_to_pull_request_comment',
      'mcp__claude_ai_Slack__slack_send_message',
      'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue',
      'mcp__x__slack_send_message',
    ];
    const r = reconcileTools(names, DEFAULT_TOOL_MAP);
    // Every heading, in `CHOICE_GROUPS`' order, each tool half under its own.
    expect(r.halves.map((h) => h.group)).toEqual(
      CHOICE_GROUPS.flatMap((g) => g.halves.map(() => g.label))
    );
    const halves = CHOICE_GROUPS.flatMap((g) => g.halves).length;
    const text = describeReconciliation(r, 1, {}, '/t.json');
    expect(text).toContain(`CHOOSE which to review -- ${halves} tool(s) in ${CHOICE_GROUPS.length} group(s), x = reviewed:`);
    // The heading, then its tools indented under it; one no given name carries says so.
    expect(text).toContain(
      '    GitHub: pull request reviews\n' +
        '      [x] add_comment_to_pending_review      not loaded here\n' +
        '      [x] add_reply_to_pull_request_comment  1 connector here\n' +
        '      [x] pull_request_review_write          1 connector here\n'
    );
    expect(text).toContain('      [x] slack_send_message                 2 connectors here');
    expect(text).toContain('every tool above, under one of the two');
  });

  test('with no names at all, every heading is still asked about', () => {
    // A decline is by tool half under every server, so a connector this session never loaded is
    // the person's to choose too. The names add only the "same tool, different server" section.
    const r = reconcileTools([], DEFAULT_TOOL_MAP);
    expect([...new Set(r.halves.map((h) => h.group))]).toEqual(CHOICE_GROUPS.map((g) => g.label));
    expect(r.halves.map((h) => h.half).sort()).toEqual(toolHalvesOf(DEFAULT_TOOL_MAP));
    expect(r.halves.every((h) => h.connectors === 0 && !h.declined)).toBe(true);
    expect(r.proposed).toEqual([]);
    const text = describeReconciliation(r, 1, {}, '/t.json');
    for (const g of CHOICE_GROUPS) expect(text).toContain(`\n    ${g.label}\n`);
    expect(text).not.toContain('SAME TOOL');
    // A declined heading is shown unticked, and `--review-all` re-enables it.
    const { map, declined, declinedRoutes } = mergeToolConfig(DEFAULT_TOOL_MAP, { declined: ['save_issue'] }, 't');
    const d = reconcileTools([], map, { declined, declinedRoutes, shadows: [] });
    expect(d.halves.find((h) => h.half === 'save_issue')).toMatchObject({ destination: 'linear', declined: true });
    expect(declinedAfter(d, declined, [], d.halves.map((h) => h.half))).toEqual({ declined: [] });
  });
});

describe('knownHalves: the names setup passes', () => {
  // An operator file with a tool of their own and two declines: a default half, and a half only the
  // file routes, which the merged map no longer holds.
  const file = {
    mcp__notes__post_internal_note: 'jira',
    mcp__notes__post_customer_reply: 'jira',
    declined: ['save_customer_need', 'post_customer_reply'],
  };
  const tools = mergeToolConfig(DEFAULT_TOOL_MAP, file, 'tools.json');
  const known = knownHalves(tools);
  const session = [
    ...Object.keys(DEFAULT_TOOL_MAP),
    'mcp__notes__post_internal_note',
    'mcp__notes__post_customer_reply',
    'mcp__slack__slack_send_message',
    'mcp__linear__save_customer_need',
    // A tool half holding the separator: ends in a known half without being it.
    'mcp__s__a__slack_send_message',
    'mcp__slack__slack_add_reaction',
    'mcp__docs__create',
    'Bash',
  ];
  const kept = session.filter((n) => known.some((h) => n.endsWith(`__${h}`)));

  test('the map\'s halves and the declined ones that still route, nothing else', () => {
    expect(known).toContain('post_internal_note');
    expect(known).toContain('save_customer_need');
    expect(known).toContain('post_customer_reply');
    expect(known).not.toContain('slack_add_reaction');
    expect(known).toEqual([...known].sort());
    expect(kept).toContain('mcp__s__a__slack_send_message');
    expect(kept).not.toContain('mcp__slack__slack_add_reaction');
    expect(kept).not.toContain('Bash');
  });

  test('the names it leaves out change no choice, no proposal and no written file', () => {
    const all = reconcileTools(session, tools.map, tools);
    const few = reconcileTools(kept, tools.map, tools);
    for (const key of ['gated', 'proposed', 'declined', 'proposedIfEnabled', 'halves'] as const) {
      expect(few[key], key).toEqual(all[key]);
    }
    // The declined half only the file routes is offered back, so a re-enable stays possible.
    expect(few.halves.map((h) => h.half)).toContain('post_customer_reply');
    for (const chosen of [[], ['slack_send_message'], ['post_internal_note', 'save_customer_need']]) {
      // The whole answer: every half shown, reviewed unless declined.
      const reviewed = all.halves.map((h) => h.half).filter((h) => !chosen.includes(h));
      const a = declinedAfter(all, tools.declined, chosen, reviewed);
      const f = declinedAfter(few, tools.declined, chosen, reviewed);
      expect(f).toEqual(a);
      if ('error' in a || 'error' in f) throw new Error('a shown half was refused');
      expect(answeredToolsJson(few, file, f.declined)).toBe(answeredToolsJson(all, file, a.declined));
    }
  });
});

describe('ownToolRoute: which tools --add takes', () => {
  const OWN = 'mcp__jsm__jira_add_internal_note';
  const tools = mergeToolConfig(DEFAULT_TOOL_MAP, { declined: ['post_note'] }, 'tools.json');

  test('a tool of a server the person set up, to a destination draftgate has', () => {
    expect(ownToolRoute(OWN, 'jira', 'commentBody', tools, {})).toEqual({ destination: 'jira' });
  });

  test.each([
    ['mcp__claude_ai_Jsm__jira_add_internal_note', 'jira', 'commentBody', {}, 'a claude.ai connector'],
    ['mcp__plugin_kit_jsm__jira_add_internal_note', 'jira', 'commentBody', {}, "a plugin's server"],
    ['mcp__jsm__addCommentToJiraIssue', 'jira', 'commentBody', {}, 'a tool draftgate routes already'],
    // A decline no route uses still declines the half: an entry for it would be dormant at once.
    ['mcp__notes__post_note', 'slack', 'text', {}, 'ends in post_note, which tools.json declines'],
    ['jira_add_internal_note', 'jira', 'commentBody', {}, 'is not an MCP tool name'],
    [OWN, 'jira', 'commentBody', { [OWN]: 'jira' }, 'has a tools.json entry already'],
    [OWN, 'email', 'commentBody', {}, `"email" is not a destination. Name one of: ${Object.keys(profiles).join(', ')}.`],
    [OWN, 'jira', ' ', {}, 'the field the message is in is empty'],
  ] as [string, string, string, Record<string, unknown>, string][])('refuses %s as %s', (name, destination, field, existing, says) => {
    const route = ownToolRoute(name, destination, field, tools, existing);
    expect(route).toEqual({ error: expect.stringContaining(says) });
  });
});
