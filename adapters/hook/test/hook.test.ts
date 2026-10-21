/**
 * The hook adapter, in two layers. `decide` takes the review as an injected function, so every
 * branch, the broken-gate ones included, is reachable with no subprocess and no window. The
 * subprocess path gets a real subprocess (`--surface auto-approve` / `auto-reject`), since a stubbed
 * pipe can hide a payload truncation.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decide, denialReason, CONTEXT_MAX_CHARS, CONTEXT_MAX_LINES, REASON_MAX_CHARS, REASON_MAX_LINES,
  type CliResult, type HookReviewRequest,
} from '../src/decide';
import { encodeDecisionFile } from '../../../cli/src/decisionFile';
import type { AuditRecord } from '../../../cli/src/audit';
import type { Denial } from '../../../cli/src/types';
import { BODY_FAILURES } from '../../../cli/src/payload';
import { renderHookOutput, type HookDecision } from '../src/hookOutput';
import {
  DEFAULT_TOOL_MAP,
  FAIL_OPEN,
  ROUTE_FACTS,
  routeFactsFor,
  type ToolRoute,
  matcherFor,
  mergeToolMap,
  resolveRoute,
  ToolMapError,
  type ToolMap,
} from '../src/toolMap';
import {
  PLUGIN_HOOK_TIMEOUT_S, cliArgs, cliResultFrom, loadToolMap, surfaceKind, withNotes,
} from '../src/main';
import { extraToolsBlock, pluginHooksFile } from '../src/pluginHooks';
import { checkoutSettings } from './checkoutEntry';
import { assembledRoot } from './pluginRoot';
import { HOOK_IN_CHECKOUT } from '../src/hookCommand';
import { parseSettings } from '../src/registration';
import { isPlainObject } from '../../../cli/src/json';
import { DEFAULT_TIMEOUT_MS } from '../../../cli/src/review';
import { PLUGIN_REVIEW_CEILING_MS } from '../src/reviewTimeout';
import { ROUTE_FLAGS, claimedRouteFacts, type RouteFacts } from '../../../cli/src/routeFacts';
import { parseArgs } from '../../../cli/src/args';
import { profiles, type DestinationName } from '../../../core/src/index';
import { REMEDY } from '../../../core/src/remedies';
import { headCommit, installedRelease, readReleaseState } from '../../../cli/src/releaseCheck';
import { LONG_AGO, checkFinished, seedNewerRelease, until } from '../../../cli/test/releaseFixture';

const REPO = join(import.meta.dir, '..', '..', '..');
const HOOK = join(REPO, 'adapters', 'hook', 'src', 'main.ts');
const dir = mkdtempSync(join(tmpdir(), 'draftgate-hook-test-'));

/*
 * This directory holds the nonce files that let this suite ask for `--surface auto-approve`; left in
 * $TMPDIR, one could make the real hook answer `allow`. `afterAll` does not run on a kill: the gate
 * refuses a nonce file older than a run can be.
 */
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const JIRA_TOOL = 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue';
const SLACK_TOOL = 'mcp__claude_ai_Slack__slack_send_message';
/** A local server's internal-note tool: never a default, so routed only by a `tools.json` entry. */
const INTERNAL_NOTE_TOOL = 'mcp__jsm__jira_add_internal_note';

const jiraInput = () => ({
  cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  issueIdOrKey: 'SUPPORT-123',
  commentBody: 'Hello **world**.',
});

const hookPayload = (tool_name: string, tool_input: unknown) =>
  JSON.stringify({ session_id: 's1', cwd: REPO, tool_name, tool_input });

/**
 * A `decide` harness whose review answers however the test says. Typed with `HookReviewRequest`,
 * not a structural copy, so a route fact added later is visible on `calls`.
 */
function withReview(result: CliResult | ((...a: unknown[]) => CliResult)) {
  const calls: HookReviewRequest[] = [];
  return {
    calls,
    opts: {
      toolMap: DEFAULT_TOOL_MAP,
      declined: [],
      async review(req: HookReviewRequest) {
        calls.push({ ...req });
        return typeof result === 'function'
          ? result(req.destination, req.toolName, req.toolInput)
          : result;
      },
    } as Parameters<typeof decide>[1],
  };
}

/**
 * What each reader gets of an `ask`, read off the rendered hook output (`hookOutput.ts`, "Who reads
 * each field", measured on Claude Code 2.1.289).
 *
 * - `prompt`: `permissionDecisionReason` cut the way Claude Code cuts it (`REASON_MAX_LINES`, then
 *   `REASON_MAX_CHARS`, read off the binary in `decide.ts`).
 * - `afterApproval`: the `systemMessage` line drawn under the tool call once it is approved.
 * - `agent`: `additionalContext`, the only field that reaches the agent, once approved.
 */
function askReaders(d: HookDecision) {
  const out = JSON.parse(renderHookOutput(d));
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  const reason: string = out.hookSpecificOutput.permissionDecisionReason;
  const drawn = reason
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(0, REASON_MAX_LINES)
    .join('\n')
    .slice(0, REASON_MAX_CHARS);
  return {
    prompt: drawn.split('\n'),
    afterApproval: out.systemMessage as string | undefined,
    agent: out.hookSpecificOutput.additionalContext as string | undefined,
  };
}

// ---------------------------------------------------------------------------

describe('the tool map is the source of truth and the matcher is derived from it', () => {
  test('every destination is covered, and nothing is mapped to a destination that is not one', () => {
    // Derived from `profiles` in both directions: a hand-written list would pass a new profile with
    // no map entry at all.
    const destinations = new Set(Object.values(DEFAULT_TOOL_MAP).map((r) => r.destination));
    expect([...destinations].sort()).toEqual(
      (Object.keys(profiles) as DestinationName[]).sort()
    );
  });

  test('an internal-note tool is gated only once tools.json names it', () => {
    expect(new RegExp(matcherFor(DEFAULT_TOOL_MAP)).test(INTERNAL_NOTE_TOOL)).toBe(false);
    const merged = mergeToolMap(DEFAULT_TOOL_MAP, { [INTERNAL_NOTE_TOOL]: 'jira' }, 'tools.json');
    expect(new RegExp(matcherFor(merged)).test(INTERNAL_NOTE_TOOL)).toBe(true);
  });

  test('slack_schedule_message is gated, and its send-time is shown to the reviewer', () => {
    // Same server, `message` field and channel as a send; only when it arrives differs, so `post_at`
    // has to be visible.
    expect(DEFAULT_TOOL_MAP['mcp__claude_ai_Slack__slack_schedule_message']).toEqual({ destination: 'slack', contextFields: ['*'], schemaOwner: 'connector' });
    expect(new RegExp(matcherFor(DEFAULT_TOOL_MAP)).test('mcp__claude_ai_Slack__slack_schedule_message')).toBe(true);
    expect(profiles.slack.contextFields).toContain('post_at');
    // The same body field, verified against the live schema.
    expect(profiles.slack.bodyField).toBe('message');
  });

  test('and the draft tool is NOT gated, which is the distinction between the two', () => {
    // A draft is an affordance, not a send; a scheduled message is a send that arrives later.
    expect(DEFAULT_TOOL_MAP['mcp__claude_ai_Slack__slack_send_message_draft']).toBeUndefined();
  });

  test('the matcher is ANCHORED, or slack_send_message_draft is gated too', () => {
    const re = new RegExp(matcherFor(DEFAULT_TOOL_MAP));
    expect(re.test(SLACK_TOOL)).toBe(true);
    // A prefix of a different tool, an affordance rather than a send.
    expect(re.test(`${SLACK_TOOL}_draft`)).toBe(false);
    expect(re.test(`prefix_${SLACK_TOOL}`)).toBe(false);
  });

  test('the matcher covers every mapped tool and nothing else', () => {
    const re = new RegExp(matcherFor(DEFAULT_TOOL_MAP));
    for (const tool of Object.keys(DEFAULT_TOOL_MAP)) expect(re.test(tool)).toBe(true);
    for (const tool of [
      'mcp__claude_ai_Atlassian_Rovo__getJiraIssue',
      'mcp__claude_ai_Slack__slack_add_reaction',
      'mcp__claude_ai_Linear__list_comments',
      'Bash',
      'Write',
    ]) {
      expect(re.test(tool)).toBe(false);
    }
  });

  test('the printed matcher is stable across calls, whatever order the map is in', () => {
    // Not `matcherFor({ ...map })`: a spread preserves insertion order, so removing `matcherFor`'s
    // `.sort()` could not fail.
    const reversed = Object.fromEntries(Object.entries(DEFAULT_TOOL_MAP).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(DEFAULT_TOOL_MAP));
    expect(matcherFor(reversed)).toBe(matcherFor(DEFAULT_TOOL_MAP));

    // And a shuffle, so the test does not depend on reversal being the only reordering that breaks.
    const shuffled = Object.fromEntries(
      Object.entries(DEFAULT_TOOL_MAP).sort(([a], [b]) => (a > b ? -1 : a < b ? 1 : 0))
    );
    expect(matcherFor(shuffled)).toBe(matcherFor(DEFAULT_TOOL_MAP));
  });

  /**
   * `timeout` must be present, because the harness's own timeout is fail-open (Claude Code 2.1.260
   * binary: an aborted hook is `outcome: "cancelled"` and the call runs with the original input,
   * drawing nothing). The event default is 600000ms and the review deadline twenty minutes, so an
   * omitted `timeout` gives up at ten. Asserted on the emitted JSON of both registrations.
   */
  test('the registration never omits timeout, whatever the tool map', () => {
    const extra = { mcp__notes__post_internal_note: { destination: 'jira', schemaOwner: 'operator' } } as ToolMap;
    const entries = [
      JSON.parse(pluginHooksFile(PLUGIN_HOOK_TIMEOUT_S)).hooks.PreToolUse[0].hooks[0],
      extraToolsBlock({ ...DEFAULT_TOOL_MAP, ...extra }, '/plugin/root', PLUGIN_HOOK_TIMEOUT_S)!.hooks[0],
    ];
    for (const entry of entries) {
      expect(entry).toHaveProperty('timeout');
      expect(typeof entry.timeout).toBe('number');
      // And it must still beat the review deadline.
      expect(entry.timeout * 1000).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    }
  });
});

describe('tool map overrides', () => {
  test('a renamed connector can be added without restating the others', () => {
    const merged = mergeToolMap(DEFAULT_TOOL_MAP, { mcp__atlassian__addCommentToJiraIssue: 'jira' }, 'x');
    // An alias is the operator's claim (nobody probed its schema, so `body/missing-field` asks), but
    // it inherits the default's disclosure by tool half; an exact-name lookup would leave it no `*`.
    expect(merged.mcp__atlassian__addCommentToJiraIssue).toEqual({
      destination: 'jira', contextFields: ['*'], schemaOwner: 'operator',
    });
    const worklog = mergeToolMap(
      DEFAULT_TOOL_MAP,
      { mcp__atlassian__addWorklogToJiraIssue: { destination: 'jira', bodyOptional: true } },
      'x'
    );
    expect(worklog.mcp__atlassian__addWorklogToJiraIssue!.contextFields).toEqual(
      DEFAULT_TOOL_MAP.mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue!.contextFields
    );
    expect(Object.keys(merged)).toHaveLength(Object.keys(DEFAULT_TOOL_MAP).length + 1);
  });

  test('null removes an entry', () => {
    const merged = mergeToolMap(DEFAULT_TOOL_MAP, { [SLACK_TOOL]: null }, 'x');
    expect(SLACK_TOOL in merged).toBe(false);
    expect(new RegExp(matcherFor(merged)).test(SLACK_TOOL)).toBe(false);
  });

  test('the shorthand and the long form both work, and mean the same thing', () => {
    // `"tool": "jira"` stays valid: `tools.json` is hand-written.
    const short = mergeToolMap(DEFAULT_TOOL_MAP, { a: 'jira' }, 'x');
    const long = mergeToolMap(DEFAULT_TOOL_MAP, { a: { destination: 'jira' } }, 'x');
    expect(short.a).toEqual({ destination: 'jira', schemaOwner: 'operator' });
    expect(long.a).toEqual(short.a);
  });

  test('an operator entry that RESTATES a default keeps the default\'s schema ownership', () => {
    // `schemaOwner` is stamped at merge time: stamped at parse, a restated default would become the
    // operator's and stop failing open on `body/missing-field`.
    const restated = mergeToolMap(DEFAULT_TOOL_MAP, { [JIRA_TOOL]: 'jira' }, 'x');
    expect(restated[JIRA_TOOL]).toEqual(DEFAULT_TOOL_MAP[JIRA_TOOL]);
    expect(restated[JIRA_TOOL]!.schemaOwner).toBe('connector');
    // Only a faithful restatement: a different destination keeps the default's disclosure (a fact
    // about the payload) and is the operator's claim, and so is a changed flag.
    const changed = mergeToolMap(DEFAULT_TOOL_MAP, { [JIRA_TOOL]: 'slack' }, 'x');
    expect(changed[JIRA_TOOL]).toEqual({ destination: 'slack', contextFields: ['*'], schemaOwner: 'operator' });
    const flagged = mergeToolMap(DEFAULT_TOOL_MAP, { [JIRA_TOOL]: { destination: 'jira', bodyOptional: true } }, 'x');
    expect(flagged[JIRA_TOOL]!.schemaOwner).toBe('operator');
  });

  test('bodyOptional survives the merge, and only when it is literally true', () => {
    expect(mergeToolMap({}, { a: { destination: 'jira', bodyOptional: true } }, 'x').a)
      .toEqual({ destination: 'jira', bodyOptional: true, schemaOwner: 'operator' });
    expect(mergeToolMap({}, { a: { destination: 'jira', bodyOptional: false } }, 'x').a)
      .toEqual({ destination: 'jira', schemaOwner: 'operator' });
    expect(mergeToolMap({}, { a: { destination: 'jira' } }, 'x').a).toEqual({ destination: 'jira', schemaOwner: 'operator' });
  });

  test('a non-boolean bodyOptional is refused, not coerced', () => {
    // `"bodyOptional": "false"` is truthy, and reading it as true would let message-less calls through.
    for (const bad of ['false', 'true', 1, 0, null, {}]) {
      expect(
        () => mergeToolMap({}, { a: { destination: 'jira', bodyOptional: bad } }, 'x'),
        JSON.stringify(bad)
      ).toThrow(ToolMapError);
    }
  });

  test('a long form with no destination is rejected', () => {
    expect(() => mergeToolMap({}, { a: { bodyOptional: true } }, 'x')).toThrow(ToolMapError);
    expect(() => mergeToolMap({}, { a: { destination: 'teams' } }, 'x')).toThrow(ToolMapError);
    expect(() => mergeToolMap({}, { a: [] }, 'x')).toThrow(ToolMapError);
    expect(() => mergeToolMap({}, { a: 42 }, 'x')).toThrow(ToolMapError);
  });

  test('an unknown destination is rejected rather than silently ignored', () => {
    expect(() => mergeToolMap(DEFAULT_TOOL_MAP, { someTool: 'teams' }, 'x')).toThrow(ToolMapError);
    expect(() => mergeToolMap(DEFAULT_TOOL_MAP, [], 'x')).toThrow(ToolMapError);
  });

  test('loadToolMap reads tools.json out of DRAFTGATE_HOME', () => {
    const home = mkdtempSync(join(dir, 'home-'));
    writeFileSync(join(home, 'tools.json'), JSON.stringify({ mcp__x__send: 'linear' }));
    const map = loadToolMap({ DRAFTGATE_HOME: home } as NodeJS.ProcessEnv);
    expect(map.mcp__x__send).toEqual({ destination: 'linear', schemaOwner: 'operator' });
    expect(map[JIRA_TOOL]).toEqual({ destination: 'jira', contextFields: ['*'], schemaOwner: 'connector' });
  });

  test('a corrupt tools.json is an error, not a silently empty map', () => {
    const home = mkdtempSync(join(dir, 'home-'));
    writeFileSync(join(home, 'tools.json'), '{ not json');
    expect(() => loadToolMap({ DRAFTGATE_HOME: home } as NodeJS.ProcessEnv)).toThrow(ToolMapError);
  });
});

describe('the output envelope Claude Code 2.1.258 accepts', () => {
  test('an approval carries hookEventName, allow, and the COMPLETE updatedInput', () => {
    const out = JSON.parse(
      renderHookOutput({
        permissionDecision: 'allow',
        reason: 'ok',
        updatedInput: { a: 1, b: 2 },
        additionalContext: 'for the agent',
      })
    );
    // Without hookEventName the whole output is rejected ("hookSpecificOutput is missing required
    // field \"hookEventName\"").
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput).toEqual({ a: 1, b: 2 });
    expect(out.hookSpecificOutput.additionalContext).toBe('for the agent');
  });

  test('a denial carries NO updatedInput', () => {
    const out = JSON.parse(renderHookOutput({ permissionDecision: 'deny', reason: 'no' }));
    expect('updatedInput' in out.hookSpecificOutput).toBe(false);
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('no');
  });

  test('the top-level decision field, deprecated for PreToolUse, is never emitted', () => {
    for (const d of ['allow', 'deny', 'ask'] as const) {
      const out = JSON.parse(
        renderHookOutput(
          d === 'allow'
            ? { permissionDecision: d, reason: 'r', updatedInput: {}, additionalContext: 'a' }
            : d === 'ask'
              ? { permissionDecision: d, reason: 'r', additionalContext: 'a' }
              : { permissionDecision: d, reason: 'r' }
        )
      );
      expect('decision' in out).toBe(false);
    }
  });
});

describe('decide: the policy', () => {
  test('an approval allows and passes the CLI payload through untouched', async () => {
    const approved = { ...jiraInput(), commentBody: '{"type":"doc"}', contentFormat: 'adf' };
    const h = withReview({ exitCode: 0, updatedInput: approved });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('allow');
    // The adapter must not re-derive or re-serialise anything: whatever the CLI approved is what
    // goes out, `contentFormat` and all.
    expect(d.permissionDecision === 'allow' && d.updatedInput).toEqual(approved);
    expect(h.calls[0]).toMatchObject({ destination: 'jira', toolName: JIRA_TOOL });
  });

  for (const [name, exitCode, denial] of [
    ['a rejection', 1, { outcome: 'rejected', destination: 'jira', reason: 'Tone is wrong.', guidance: 'Ask the user.' }],
    ['a timeout', 2, { outcome: 'timeout', destination: 'jira', reason: 'No decision within 600s.', guidance: 'Do not resend.' }],
  ] as const) {
    test(`${name} denies, carrying BOTH the reason and the guidance`, async () => {
      const h = withReview({ exitCode, denial });
      const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
      expect(d.permissionDecision).toBe('deny');
      // Guidance is the half that stops a retry loop.
      expect(d.reason).toContain(denial.reason);
      expect(d.reason).toContain(denial.guidance);
    });
  }

  test('THE DECISION: unavailable degrades to ask, never to allow and never to deny', async () => {
    const h = withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable',
        destination: 'jira',
        reason: 'The review window has not been built.',
        guidance: 'This is a problem with the review tool.',
      },
    });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
    const { prompt } = askReaders(d);
    // The markdown sentence is a fact about the profile (`convert-and-replace`): see the Slack case.
    expect(prompt[0]).toBe(
      'draftgate: not reviewed -- it could not open its review window. Approving sends it as ' +
        "written, in markdown rather than Jira's own format."
    );
    // The row adds no remedy of its own: whatever advice there is came in the CLI's reason.
    expect(prompt[1]).toBe('The review window has not been built.');
    expect(prompt.join('\n')).not.toContain('build:surface');
    // Nothing is pre-approved on this path.
    expect('updatedInput' in d).toBe(false);
  });

  test('a preview-only destination is NOT told it lost a conversion', async () => {
    // Slack is `preview-only`: there is no conversion to lose.
    const h = withReview({
      exitCode: 1,
      denial: { outcome: 'unavailable', destination: 'slack', reason: 'no window', guidance: 'g' },
    });
    const d = await decide(hookPayload(SLACK_TOOL, { channel_id: 'C1', message: 'hi' }), h.opts);
    expect(d.permissionDecision).toBe('ask');
    expect(askReaders(d).prompt[0]).toEndWith('Approving sends it as written.');
    expect(d.reason).not.toContain('markdown');
    expect(d.reason).not.toContain('Jira');
  });

  test('an unmapped tool denies, because the matcher is generated from the map', async () => {
    const h = withReview({ exitCode: 0, updatedInput: {} });
    const d = await decide(hookPayload('mcp__somewhere__send_thing', { body: 'hi' }), h.opts);
    expect(d.permissionDecision).toBe('deny');
    expect(h.calls).toHaveLength(0);
    // Setup rewrites the extra-tools entry's matcher; `draftgate register` is what it runs, after asking.
    expect(d.systemMessage).toContain('Run `/draftgate:setup`.');
    expect(d.reason).toContain('run `/draftgate:setup` again');
    expect(d.reason).not.toContain('draftgate register');
  });

  test('a missing body field fails OPEN with a loud warning (schema drift)', async () => {
    // The CLI detects it (`body/missing-field`); the policy is here.
    const input = { cloudId: 'c', issueIdOrKey: 'K-1', comment: 'hi' };
    const h = withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable',
        code: 'body/missing-field',
        destination: 'jira',
        reason: 'Payload for "jira" has no "commentBody" field. Present keys: cloudId, issueIdOrKey, comment.',
        guidance: 'This is a problem with the payload.',
      },
    });
    const d = await decide(hookPayload(JIRA_TOOL, input), h.opts);
    expect(d.permissionDecision).toBe('allow');
    expect(d.systemMessage).toContain('schema seems to have changed');
    expect(d.systemMessage).toContain('commentBody');
    // Fail-open means the original input, complete: `updatedInput` replaces wholesale.
    expect(d.permissionDecision === 'allow' && d.updatedInput).toEqual(input);
  });

  test('but NOT for a tool whose schema the operator wrote', async () => {
    // If an operator route took the schema-drift fail-open, `{issueIdOrKey, cloudId, note}` would
    // give no `commentBody`, `plausibleProseField` would find `note`, and an internal note would go
    // out unreviewed.
    const toolMap = mergeToolMap(DEFAULT_TOOL_MAP, { [INTERNAL_NOTE_TOOL]: 'jira' }, 'tools.json');
    const input = { cloudId: 'c', issueIdOrKey: 'SUPPORT-1', note: 'customer is on enterprise' };
    const h = withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable',
        code: 'body/missing-field',
        destination: 'jira',
        reason: 'Payload for "jira" has no "commentBody" field, but "note" looks like it holds the message.',
        guidance: 'This is a problem with the payload.',
      },
    });
    const d = await decide(hookPayload(INTERNAL_NOTE_TOOL, input), { ...h.opts, toolMap });
    expect(h.calls[0]!.toolName).toBe(INTERNAL_NOTE_TOOL);
    expect(d.permissionDecision).toBe('ask');
    // Diagnosed as a payload problem, not a window that would not start.
    expect(d.reason).toContain('tools.json');
    expect(d.reason).not.toContain('build:surface');
  });

  test('and the schema owner is the only difference -- the same payload on the comment tool still allows', async () => {
    // The control: without it, `body/missing-field` could stop allowing everywhere and both pass.
    const input = { cloudId: 'c', issueIdOrKey: 'SUPPORT-1', note: 'customer is on enterprise' };
    const h = withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable',
        code: 'body/missing-field',
        destination: 'jira',
        reason: 'Payload for "jira" has no "commentBody" field, but "note" looks like it holds the message.',
        guidance: 'This is a problem with the payload.',
      },
    });
    const d = await decide(hookPayload(JIRA_TOOL, input), h.opts);
    expect(d.permissionDecision).toBe('allow');
  });

  test('an operator cannot claim schema ownership, and would gain nothing by it', async () => {
    // `parseRoute` stamps `operator`, so ownership is a merge fact, whatever `tools.json` says.
    for (const claim of [
      { schemaOwner: 'connector' }, { schemaOwner: 'connector-open' }, { schemaOwner: 'inferred' },
      { ownSchema: true },
    ]) {
      const map = mergeToolMap({}, { mcp__op__thing: { destination: 'jira', ...claim } }, 'tools.json');
      expect(map.mcp__op__thing, JSON.stringify(claim)).toEqual({ destination: 'jira', schemaOwner: 'operator' });
    }
  });

  test('an operator bodyField is an operator CLAIM, and never buys the fail-open', async () => {
    // A body field typed into `tools.json` is an unprobed claim about another schema: the route
    // stays `operator` and keeps asking on a missing body, never inheriting the fail-open.
    const map = mergeToolMap(
      {},
      { mcp__op__save_issue: { destination: 'linear', bodyField: 'description' } },
      'tools.json'
    );
    expect(map.mcp__op__save_issue).toEqual({
      destination: 'linear', bodyField: 'description', schemaOwner: 'operator',
    });
    expect(FAIL_OPEN[map.mcp__op__save_issue!.schemaOwner].schemaDrift).toBe(false);
  });

  test('a CHANGED bodyField is not a restatement, so it cannot keep a default ownership', () => {
    // `sameRoute` compares the route's own keys minus `schemaOwner`; asserted here on `bodyField`.
    const base = { mcp__x__save_comment: { destination: 'linear' as const, schemaOwner: 'connector' as const } };
    const restated = mergeToolMap(base, { mcp__x__save_comment: 'linear' }, 'tools.json');
    expect(restated.mcp__x__save_comment!.schemaOwner).toBe('connector');

    const changed = mergeToolMap(
      base,
      { mcp__x__save_comment: { destination: 'linear', bodyField: 'description' } },
      'tools.json'
    );
    expect(changed.mcp__x__save_comment!.schemaOwner).toBe('operator');
  });

  test('a bodyField PATH is validated at config time, where the message can name the file', () => {
    // `parseRoute` calls the same `parseBodyPath` the payload layer reads with, so an accepted route
    // is one `extractBody` can address.
    const ok = mergeToolMap(
      {},
      { mcp__op__editJiraIssue: { destination: 'jira', bodyField: 'fields.description' } },
      'tools.json'
    );
    expect(ok.mcp__op__editJiraIssue!.bodyField).toBe('fields.description');

    for (const bad of ['__proto__', 'fields.__proto__', 'a..b', 'a.']) {
      expect(
        () => mergeToolMap({}, { mcp__op__t: { destination: 'jira', bodyField: bad } }, 'tools.json'),
        bad
      ).toThrow(ToolMapError);
    }
  });

  test('contextFields is a NON-EMPTY list, because empty could not be honoured', () => {
    // One `--context-field` per name, so `[]` passes no flags and the profile's list would stand.
    const ok = mergeToolMap(
      {},
      { mcp__op__save_status_update: { destination: 'linear', contextFields: ['project', 'health'] } },
      'tools.json'
    );
    expect(ok.mcp__op__save_status_update!.contextFields).toEqual(['project', 'health']);

    for (const bad of [[], '', ['ok', ''], ['ok', 7], {}]) {
      expect(
        () => mergeToolMap({}, { mcp__op__t: { destination: 'linear', contextFields: bad } }, 'tools.json'),
        JSON.stringify(bad)
      ).toThrow(ToolMapError);
    }
  });

  test('ROUTE_FACTS answers for every route fact, and both propagation sites read it', () => {
    /*
     * A `bodyField` that `resolveRoute` inherits and `proposedToolsJson` drops makes `--propose-tools`
     * write a route that shows the reviewer nothing. TypeScript enforces the key set; this pins that a
     * fact marked `inferred` or `proposed` reaches that route. No `review` column: see `ROUTE_FACTS`.
     */
    const rich: ToolRoute = {
      destination: 'jira',
      bodyOptional: true,
      bodyField: 'fields.description',
      contextFields: ['cloudId'],
      proseFields: ['fields.summary'],
      bodyFormat: 'plain',
      schemaOwner: 'connector',
    };
    for (const [field, travels] of Object.entries(ROUTE_FACTS)) {
      expect(routeFactsFor(rich, 'inferred'), field).toEqual(
        expect.objectContaining(travels.inferred ? { [field]: rich[field as keyof ToolRoute] } : {})
      );
      expect(Object.hasOwn(routeFactsFor(rich, 'inferred'), field), `inferred:${field}`)
        .toBe(travels.inferred);
      expect(Object.hasOwn(routeFactsFor(rich, 'proposed'), field), `proposed:${field}`)
        .toBe(travels.proposed);
    }
    /*
     * The table's own answers, by literal: the loop above proves only that the function reads the
     * table. Flipping `proseFields` to `{ inferred: false }` passes it, and a title goes out unseen.
     * Every payload fact travels both ways; the fail-open travels neither.
     */
    for (const field of Object.keys(ROUTE_FLAGS)) {
      expect(ROUTE_FACTS[field as keyof typeof ROUTE_FACTS], field)
        .toEqual({ inferred: true, proposed: true });
    }
    expect(ROUTE_FACTS.bodyOptional).toEqual({ inferred: false, proposed: false });
  });

  test('every route fact an operator writes survives parseRoute', () => {
    // The hop the sweep below does not start from: a `parseRoute` that rebuilt its fields by hand
    // would drop a new `RouteFacts` field from every `tools.json`. Derived from `ROUTE_FLAGS`.
    const written: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(ROUTE_FLAGS)) {
      if (spec.kind === 'path') written[field] = `where.${field}`;
      else if (spec.kind === 'path-list') written[field] = [`${field}.one`, `${field}.two`];
      else written[field] = spec.values.find((v) => v !== spec.unchanged);
    }
    const merged = mergeToolMap({}, { mcp__op__t: { destination: 'linear', ...written } }, 'tools.json');
    expect(claimedRouteFacts(merged.mcp__op__t!)).toEqual(written as RouteFacts);
  });

  test('a restated default is not a claim, in tools.json as on the wire', () => {
    // `bodyFormat: "markdown"` says nothing; kept, `sameRoute` would read a restatement as a change.
    // `claimedRouteFacts` is the one spelling of that rule for `parseRoute` and `routeFlagArgs`.
    for (const [field, spec] of Object.entries(ROUTE_FLAGS)) {
      if (spec.kind !== 'choice') continue;
      const merged = mergeToolMap(
        {},
        { mcp__op__t: { destination: 'linear', [field]: spec.unchanged } },
        'tools.json'
      );
      expect(merged.mcp__op__t, field).toEqual({ destination: 'linear', schemaOwner: 'operator' });
    }
  });

  test('every route fact survives the whole way to the parsed CLI arguments', async () => {
    /*
     * A route fact reaches a review through the tool map, `decide`'s request, `cliArgs`' argv and
     * `parseArgs`. Every field is optional, so a dropped hop is a type error nowhere, and a title
     * goes out unseen under a human approval (`staleSurfaceDenial` cannot see it). The values are
     * derived from `ROUTE_FLAGS` (whose keys are `keyof RouteFacts`), each carrying its own field's
     * name, so two crossed flags fail here.
     */
    const facts: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(ROUTE_FLAGS)) {
      if (spec.kind === 'path') facts[field] = `where.${field}`;
      else if (spec.kind === 'path-list') facts[field] = [`${field}.one`, `${field}.two`];
      else {
        // A `choice` at its `unchanged` value passes no flag, so it would assert nothing.
        const travels = spec.values.find((v) => v !== spec.unchanged);
        expect(travels, `${field} has no value that is not the default`).toBeDefined();
        facts[field] = travels;
      }
    }
    const route = { destination: 'linear', schemaOwner: 'connector', ...facts } as ToolRoute;

    // Hop one: the map, through the policy, onto the review request.
    let seen: HookReviewRequest | undefined;
    await decide(hookPayload('mcp__x__save_release', { body: 'hi' }), {
      toolMap: { mcp__x__save_release: route },
      declined: [],
      async review(req: HookReviewRequest) {
        seen = req;
        return { exitCode: 2 } as CliResult;
      },
    } as Parameters<typeof decide>[1]);
    expect(seen, 'the review never ran').toBeDefined();
    expect(claimedRouteFacts(seen!)).toEqual(facts as RouteFacts);

    // Hop two: the request, through the flags, back out of the parser. `slice(1)` drops the
    // interpreter path `cliArgs` leads with; `parseArgs` reads the command first.
    const argv = cliArgs({
      ...seen!, deadlineMs: 60_000, inPath: 'p.json', decisionPath: 'd.json', surface: 'webkit',
    });
    expect(claimedRouteFacts(parseArgs(argv.slice(1)))).toEqual(facts as RouteFacts);
  });

  test('a choice at its default passes no flag, and comes back absent rather than wrong', () => {
    // Absent and "the default, stated" are the same claim downstream; emitting the flag always would
    // change every existing route's argv.
    for (const [field, spec] of Object.entries(ROUTE_FLAGS)) {
      if (spec.kind !== 'choice') continue;
      const argv = cliArgs({
        deadlineMs: 60_000, destination: 'linear', toolName: 't', inPath: 'p.json',
        decisionPath: 'd.json', surface: 'webkit', [field]: spec.unchanged,
      } as Parameters<typeof cliArgs>[0]);
      expect(argv, field).not.toContain(spec.flag);
      expect(parseArgs(argv.slice(1))[field as keyof RouteFacts], field).toBeUndefined();
    }
  });

  test('sameRoute compares LISTS by value, or every restatement reads as a change', () => {
    // Compared with `!==` (identity for an array), two equal `contextFields` would read as a change.
    const base: ToolMap = {
      mcp__x__save_status_update: {
        destination: 'linear', contextFields: ['project', 'health'], schemaOwner: 'connector',
      },
    };
    const restated = mergeToolMap(
      base,
      { mcp__x__save_status_update: { destination: 'linear', contextFields: ['project', 'health'] } },
      'tools.json'
    );
    expect(restated.mcp__x__save_status_update!.schemaOwner).toBe('connector');

    // Order is significant: it decides what the reviewer reads and in what sequence.
    const reordered = mergeToolMap(
      base,
      { mcp__x__save_status_update: { destination: 'linear', contextFields: ['health', 'project'] } },
      'tools.json'
    );
    expect(reordered.mcp__x__save_status_update!.schemaOwner).toBe('operator');
  });

  test('a wildcard is legal in contextFields and refused in the two that address ONE field', () => {
    // `*` names a set: right for disclosure, while a body or a title is one field to read and write.
    const ok = mergeToolMap(
      {},
      { mcp__op__editJiraIssue: { destination: 'jira', bodyField: 'fields.description', contextFields: ['fields.*'] } },
      'tools.json'
    );
    expect(ok.mcp__op__editJiraIssue!.contextFields).toEqual(['fields.*']);

    for (const route of [
      { destination: 'jira', bodyField: 'fields.*' },
      { destination: 'jira', bodyField: 'b', proseFields: ['fields.*'] },
    ]) {
      expect(() => mergeToolMap({}, { mcp__op__t: route }, 'tools.json'), JSON.stringify(route))
        .toThrow(/names a SET/);
    }
  });

  test('a malformed proseFields is a ToolMapError, not a raw TypeError', () => {
    // The wildcard check reads `proseFields`, and reading it before `isFieldNameList` has run makes
    // a malformed one throw a TypeError -- losing the message that names the file to go and fix,
    // which is the whole job of this function.
    for (const bad of ['oops', 42, { a: 1 }, ['ok', 7]]) {
      expect(
        () => mergeToolMap({}, { mcp__op__t: { destination: 'jira', proseFields: bad } }, 'tools.json'),
        JSON.stringify(bad)
      ).toThrow(ToolMapError);
    }
  });

  test('a bodyField that is not a field name is refused, not coerced', () => {
    // `""` would reach `extractBody` and be reported missing as `""`, a field that cannot exist.
    for (const bad of ['', '   ', 42, null, ['description']]) {
      expect(
        () => mergeToolMap({}, { mcp__op__t: { destination: 'linear', bodyField: bad } }, 'tools.json'),
        JSON.stringify(bad)
      ).toThrow(/bodyField/);
    }
  });

  test('the route\'s bodyField reaches the review, and nothing invents one', async () => {
    // It cannot fail loudly: with the field dropped the review reads the profile's `body`, misses it
    // and denies, so the tool looks gated and reviews nothing.
    const h = withReview({ exitCode: 0, updatedInput: { description: 'ok' } });
    const map: ToolMap = {
      mcp__claude_ai_Linear__save_issue: {
        destination: 'linear', bodyField: 'description', schemaOwner: 'operator',
      },
      mcp__claude_ai_Linear__save_comment: { destination: 'linear', schemaOwner: 'connector' },
    };
    await decide(
      hookPayload('mcp__claude_ai_Linear__save_issue', { id: 'HELP-42', description: 'hi there' }),
      { ...h.opts, toolMap: map }
    );
    expect(h.calls[0]!.bodyField).toBe('description');

    // A route that overrides nothing passes nothing, so the profile's field stands.
    await decide(
      hookPayload('mcp__claude_ai_Linear__save_comment', { issueId: 'HELP-42', body: 'hi there' }),
      { ...h.opts, toolMap: map }
    );
    expect(h.calls[1]!.bodyField).toBeUndefined();
  });

  test('body/missing-field is the ONLY unavailable that allows', async () => {
    // `body/missing-field` is checked before `unavailable`; every other unavailable asks.
    const h = withReview({
      exitCode: 1,
      denial: { outcome: 'unavailable', destination: 'jira', reason: 'no window', guidance: 'g' },
    });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
  });

  for (const [name, raw] of [
    ['unparseable stdin', 'not json at all'],
    ['an empty payload', ''],
    ['a JSON array', '[]'],
    ['no tool_name', '{"tool_input":{}}'],
  ] as const) {
    test(`${name} asks rather than allowing or denying`, async () => {
      const h = withReview({ exitCode: 0, updatedInput: {} });
      const d = await decide(raw, h.opts);
      expect(d.permissionDecision).toBe('ask');
      expect(h.calls).toHaveLength(0);
    });
  }

  test('a CLI failure with no parseable denial asks -- it is not a human decision', async () => {
    const h = withReview({ exitCode: 1, failure: 'bun: command not found' });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
    expect(d.reason).toContain('bun: command not found');
  });

  test('an approval whose payload was lost asks -- it must not fall back to the original', async () => {
    const h = withReview({ exitCode: 0, failure: 'the CLI approved but wrote no payload' });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    // The original is unconverted markdown, a different document from the one approved.
    expect(d.permissionDecision).toBe('ask');
    expect('updatedInput' in d).toBe(false);
  });

  for (const [name, toolInput] of [
    ['missing', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'commentBody'],
  ] as const) {
    test(`a tool_input that is ${name} asks rather than allowing`, async () => {
      const h = withReview({ exitCode: 0, updatedInput: {} });
      const payload: Record<string, unknown> = { tool_name: JIRA_TOOL };
      if (toolInput !== undefined) payload.tool_input = toolInput;
      const d = await decide(JSON.stringify(payload), h.opts);
      // Coerced to `{}`, it would fall through to the fail-open branch and allow a call the gate
      // never read.
      expect(d.permissionDecision).toBe('ask');
      expect(h.calls).toHaveLength(0);
    });
  }

  test('an approval whose payload was lost warns that the fallback discards the EDIT', async () => {
    const h = withReview({ exitCode: 0, failure: 'the CLI approved but wrote no payload' });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
    // "Yes" here sends the original, throwing the approved edit away, so it is the first line.
    const { prompt } = askReaders(d);
    expect(prompt[0]).toContain('ORIGINAL text, discarding any edit, in markdown');
    expect(prompt[1]).toBe('the CLI approved but wrote no payload.');
    // And the agent is told.
    expect(askReaders(d).agent).toContain('the ORIGINAL text went ahead');
  });
});

describe('the surface override cannot be left switched on', () => {
  // `DRAFTGATE_HOOK_SURFACE=auto-approve` left in a shell profile would self-approve every send.
  // `surfaceKind`'s own branches, and one refused nonce, so honouring a nonce that is merely present
  // fails here. Which nonces are live is `nonceIsLive`'s table in `cli/test/harnessNonce.test.ts`.
  const noncePath = join(dir, 'nonce-guard');
  const liveNonce = randomUUID();
  writeFileSync(noncePath, liveNonce);

  const kind = (env: Record<string, string>) =>
    surfaceKind({ DRAFTGATE_HOOK_SURFACE: 'auto-approve', ...env } as NodeJS.ProcessEnv);

  test('the default is always the real review window', () => {
    expect(surfaceKind({} as NodeJS.ProcessEnv)).toBe('webkit');
  });

  test('a bare override with no nonce is refused', () => {
    expect(kind({})).toBe('webkit');
  });

  test('a nonce that does not match the file is refused', () => {
    expect(
      kind({
        DRAFTGATE_HOOK_SURFACE_NONCE: randomUUID(),
        DRAFTGATE_HOOK_SURFACE_NONCE_FILE: noncePath,
      })
    ).toBe('webkit');
  });

  test('only a live, matching nonce is honoured', () => {
    expect(
      kind({
        DRAFTGATE_HOOK_SURFACE_NONCE: liveNonce,
        DRAFTGATE_HOOK_SURFACE_NONCE_FILE: noncePath,
      })
    ).toBe('auto-approve');
  });
});

describe('withNotes: what leads the message, and what trails it', () => {
  test('leading notes go before the decision\'s own message, trailing ones after it', () => {
    // `systemMessage` is trimmed from the end, so position is priority.
    const decision = { permissionDecision: 'deny', reason: 'r', systemMessage: 'DECISION' } as const;
    expect(withNotes(decision, ['LEAD', null], [undefined, 'TRAIL']).systemMessage).toBe('LEAD\nDECISION\nTRAIL');
    expect(withNotes(decision, [], ['TRAIL']).systemMessage).toBe('DECISION\nTRAIL');
  });

  test("on an ask the notes go into the prompt's reason, under its headline", () => {
    // On an `ask`, `systemMessage` is drawn only after an approval.
    const decision = {
      permissionDecision: 'ask', reason: 'HEADLINE\nDETAIL', systemMessage: 'HEADLINE', additionalContext: 'A',
    } as const;
    const d = withNotes(decision, ['LEAD', null], [undefined, 'TRAIL']);
    expect(d.reason).toBe('HEADLINE\nLEAD\nDETAIL\nTRAIL');
    expect(d.systemMessage).toBe('HEADLINE');
    expect(withNotes(decision, [null], [null])).toBe(decision);
    // A no-decision stays empty stdout, trailing note or not.
    const none = { permissionDecision: 'none' } as const;
    expect(withNotes(none as never, ['LEAD'], ['TRAIL'])).toBe(none);
  });
});

// ---------------------------------------------------------------------------
// The real subprocess, no window: `auto-approve` / `auto-reject` stand in for the human.
// ---------------------------------------------------------------------------

describe('end to end through a REAL CLI subprocess', () => {
  const auditLog = join(dir, 'audit.jsonl');

  // The surface override is an approval path, so it is nonce-gated, written per run.
  const noncePath = join(dir, 'surface-nonce');
  const nonce = randomUUID();
  writeFileSync(noncePath, nonce);

  /*
   * A settings tree and a config home of this suite's own: `main()` reads both on every review, so
   * otherwise a registration on the developer's machine clamps the deadline. `CLAUDE_CONFIG_DIR` is
   * honoured by Claude Code itself, so an empty one is a faithful "no registration".
   */
  const configHome = mkdtempSync(join(tmpdir(), 'draftgate-hook-claude-'));
  const draftgateHome = mkdtempSync(join(tmpdir(), 'draftgate-hook-home-'));
  afterAll(() => {
    rmSync(configHome, { recursive: true, force: true });
    rmSync(draftgateHome, { recursive: true, force: true });
  });

  /**
   * The command a checkout's settings entry runs, as Claude Code reads it back out of
   * `settings.json`: the hook inside the fail-closed wrapper (`hookCommand.ts`).
   */
  const REGISTERED = parseSettings(
    checkoutSettings(DEFAULT_TOOL_MAP),
    'settings.json'
  ).hooks[0]!.command;

  /**
   * Run the hook binary with a payload on stdin, with the surface swapped for a stub.
   *
   * `slowReader` puts a kernel pipe whose reader starts a second late between the hook and this
   * process; `exec`, so the process `spawnSync` kills and whose status it reads is the hook's.
   * `registered` runs `REGISTERED` under `/bin/sh -c`, as Claude Code does (measured on 2.1.286).
   * `fileLimitKb` sets `ulimit -f`, so a write past it fails with EFBIG: the one way to make the
   * real hook stop halfway through writing its decision.
   */
  function runHook(
    payload: string,
    surface: 'auto-approve' | 'auto-reject',
    env: Record<string, string> = {},
    {
      slowReader = false,
      registered = false,
      fileLimitKb,
    }: { slowReader?: boolean; registered?: boolean; fileLimitKb?: number } = {}
  ) {
    const script =
      (fileLimitKb === undefined ? '' : `ulimit -f ${fileLimitKb}; `) +
      (registered ? 'exec /bin/sh -c "$0"' : 'exec "$0" "$1"') +
      (slowReader ? ' > >(sleep 1; exec cat)' : '');
    const args = registered ? [REGISTERED] : [process.execPath, HOOK];
    return spawnSync('/bin/bash', ['-c', script, ...args], {
      input: payload,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      cwd: REPO,
      // A nonce gate that stopped matching falls back to `webkit`, and an unbounded run would block
      // for the review deadline (540s with no registration). 30s fails the test, and only that: the
      // SIGKILL reaches the hook alone, so a window it opened lives on. The nonce gate keeps a
      // window off the screen, not this timeout.
      timeout: 30_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        DRAFTGATE_AUDIT_LOG: auditLog,
        DRAFTGATE_HOOK_SURFACE: surface,
        DRAFTGATE_HOOK_SURFACE_NONCE: nonce,
        DRAFTGATE_HOOK_SURFACE_NONCE_FILE: noncePath,
        DRAFTGATE_HOME: draftgateHome,
        CLAUDE_CONFIG_DIR: configHome,
        ...env,
      },
    });
  }

  /** The audit row the last review wrote, and the decision a run printed. */
  const lastAudit = () => JSON.parse(readFileSync(auditLog, 'utf8').trimEnd().split('\n').at(-1)!);
  const decisionOf = (r: ReturnType<typeof runHook>) => JSON.parse(r.stdout).hookSpecificOutput;

  test('with no registration in reach, the real main() says so on the decision it returns', () => {
    // The deadline and the registration note are computed in `main()`, which no unit test reaches.
    // Nothing is found, so the note says it could not be located, never "send unreviewed".
    const r = runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.systemMessage).toContain('could not find its own hook registration');
    expect(out.systemMessage).not.toContain('send unreviewed');
    // The agent is told, through the real CLI's decision file, that no person read it.
    expect(out.hookSpecificOutput.additionalContext).toBe(
      'draftgate: this Jira message was approved by draftgate\'s "auto-approve" surface, not by a person; nobody read it.'
    );
  });

  test('and with one in reach, it says nothing about the registration at all', () => {
    // The control: a settings file naming this hook, so the note is not simply always attached.
    const settings = join(configHome, 'settings.json');
    writeFileSync(
      settings,
      checkoutSettings(loadToolMap())
    );
    try {
      const out = JSON.parse(runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve').stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(out.systemMessage ?? '').not.toContain('registration');
    } finally {
      rmSync(settings, { force: true });
    }
  });

  test('run from the plugin, a deadline over its ceiling is held to it, and the note says to ask for less', () => {
    // A plugin root whose hook is this file and a config asking for twice the ceiling; the note is
    // `main()`'s to compose.
    const home = mkdtempSync(join(dir, 'plugin-home-'));
    const root = assembledRoot(join(home, 'plugin'));
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify({ version: 1, reviewSeconds: (2 * PLUGIN_REVIEW_CEILING_MS) / 1000 }));
    const r = runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve', {
      CLAUDE_PLUGIN_ROOT: root,
      DRAFTGATE_HOME: home,
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.systemMessage).toContain(`The plugin's timeout is fixed: ask for at most ${PLUGIN_REVIEW_CEILING_MS / 1000}s in ${config}.`);
    expect(out.systemMessage).not.toContain('Install the plugin');
  });

  /*
   * The release notice, seeded with a check that saw this checkout's HEAD behind a newer release,
   * dated long ago so a check would be due: the same run shows a stub surface starts none.
   */
  const releaseHome = (config?: string) => {
    const home = mkdtempSync(join(dir, 'release-'));
    const line = seedNewerRelease(home, REPO);
    if (config !== undefined) writeFileSync(join(home, 'config.json'), config);
    return { home, line };
  };

  test('a newer release on file puts its one line LAST on the decision', () => {
    const { home, line } = releaseHome();
    const out = JSON.parse(runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve', { DRAFTGATE_HOME: home }).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    const lines = (out.systemMessage as string).split('\n');
    // Last, after the decision's own message: the trim cuts from the end.
    expect(lines.at(-1)).toBe(line);
    expect(lines[0]).toContain('could not find its own hook registration');
    // A stub surface is nobody's review, so no check followed it, due as one was.
    expect(readReleaseState({ DRAFTGATE_HOME: home })?.attemptedAt).toBe(LONG_AGO);
  });

  test('...and with the check off in config.json, no line', () => {
    const { home } = releaseHome('{"version":1,"releaseCheck":false}');
    const out = JSON.parse(runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve', { DRAFTGATE_HOME: home }).stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.systemMessage ?? '').not.toContain('is out');
  });

  test('after a review on the REAL surface, the hook starts the release check', async () => {
    // A payload with no body is denied before any surface is asked, so `webkit` is named and never
    // opened. `GIT_ALLOW_PROTOCOL` keeps the check's git off the real origin.
    const home = mkdtempSync(join(dir, 'release-start-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DRAFTGATE_HOME: home,
      DRAFTGATE_AUDIT_LOG: join(home, 'audit.jsonl'),
      CLAUDE_CONFIG_DIR: configHome,
      GIT_ALLOW_PROTOCOL: 'file',
    };
    for (const k of ['DRAFTGATE_HOOK_SURFACE', 'DRAFTGATE_HOOK_SURFACE_NONCE', 'DRAFTGATE_HOOK_SURFACE_NONCE_FILE']) delete env[k];
    const { commentBody: _, ...noBody } = jiraInput();
    const r = spawnSync(process.execPath, [HOOK], {
      input: hookPayload(JIRA_TOOL, noBody),
      encoding: 'utf8',
      cwd: REPO,
      timeout: 30_000,
      killSignal: 'SIGKILL',
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');

    const state = await until(() => checkFinished({ DRAFTGATE_HOME: home }), 20_000, 'the check');
    expect(state.result!.head).toBe(headCommit(REPO)!);
    const local = installedRelease(REPO);
    expect(state.result!.have).toBe('have' in local ? local.have : null);
  }, 60_000);

  test('an approved Jira send comes back as allow with contentFormat: adf', () => {
    const r = runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    const updated = out.hookSpecificOutput.updatedInput;
    // ADF as a JSON string, plus the extra key without which Jira renders the JSON as text.
    expect(updated.contentFormat).toBe('adf');
    expect(JSON.parse(updated.commentBody).type).toBe('doc');
    // Complete, not a patch.
    expect(updated.cloudId).toBe(jiraInput().cloudId);
    expect(updated.issueIdOrKey).toBe('SUPPORT-123');
  });

  test('stdout carries ONLY the decision JSON', () => {
    const r = runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve');
    // The CLI's stdout (the payload) or stderr leaking here makes the hook output unparseable.
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  test('a rejection comes back as deny with the guidance attached', () => {
    const r = runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-reject');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('auto-reject');
    expect('updatedInput' in out.hookSpecificOutput).toBe(false);
  });

  test('a payload well past the 128 KB pipe buffer survives the round trip', () => {
    // A truncation a stubbed `process.stdout.write` cannot see. GitHub, since its 262,144 bytes is
    // the only probed body limit above the 128 KB buffer.
    const body = 'x '.repeat(120_000);
    const big = { owner: 'Jakuboola', repo: 'draftgate', issue_number: 1, body };
    const r = runHook(hookPayload('mcp__claude_ai_Github_MCP__add_issue_comment', big), 'auto-approve');
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.body).toBe(body);
    expect(r.stdout.length).toBeGreaterThan(200_000);
  });

  test('a decision well past the pipe buffer reaches a SLOW reader whole', () => {
    /*
     * The test above cannot see this: `spawnSync` drains the child as it writes, so a write the
     * child never waited for still lands (`cli/src/stdout.ts`). So the hook writes into a kernel
     * pipe whose reader starts a second late (`slowReader`). Not `spawn` with a paused stream: bun's
     * child-process reader drains the pipe whether or not anybody listens, so that harness cannot
     * fail. A hook that exits before its write drains delivers exactly 65,536 bytes here.
     *
     * A list: Jira refuses a comment past 32,767 on its own count, which treats a list marker as
     * nothing, so this stays sendable while its stringified ADF runs past a megabyte.
     */
    const body = Array.from({ length: 12_000 }, () => '- **a**').join('\n');
    const r = runHook(
      hookPayload(JIRA_TOOL, { ...jiraInput(), commentBody: body }),
      'auto-approve',
      {},
      { slowReader: true }
    );
    expect(r.status).toBe(0);
    // Big enough to be the case this test exists for.
    expect(r.stdout.length).toBeGreaterThan(1_000_000);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(JSON.parse(out.hookSpecificOutput.updatedInput.commentBody).type).toBe('doc');
  });

  // Through the command a checkout's settings entry runs: properties the wrapper must not change,
  // with the real hook rather than `hookCommand.test.ts`'s fake one.
  test('through the registered command, an approval is the same decision, byte for byte', () => {
    const payload = hookPayload(JIRA_TOOL, jiraInput());
    const bare = runHook(payload, 'auto-approve');
    const registered = runHook(payload, 'auto-approve', {}, { registered: true });
    expect(registered.status).toBe(0);
    expect(registered.stdout).toBe(bare.stdout);
    expect(JSON.parse(registered.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('...and the megabyte decision still reaches a SLOW reader whole', () => {
    // The wrapper puts `cat` between the hook and Claude Code, so this is `cat`'s write; the hook's
    // own write is to a file.
    const body = Array.from({ length: 12_000 }, () => '- **a**').join('\n');
    const r = runHook(
      hookPayload(JIRA_TOOL, { ...jiraInput(), commentBody: body }),
      'auto-approve',
      {},
      { slowReader: true, registered: true }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(1_000_000);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(JSON.parse(out.hookSpecificOutput.updatedInput.commentBody).type).toBe('doc');
  });

  test("...and a declined tool's EMPTY stdout stays empty", () => {
    // Empty is the documented "normal permission flow"; a stray newline is a malformed decision.
    const home = mkdtempSync(join(dir, 'declined-home-'));
    writeFileSync(join(home, 'tools.json'), JSON.stringify({ declined: ['slack_send_message'] }));
    const r = runHook(
      hookPayload('mcp__claude_ai_Slack__slack_send_message', { channel_id: 'C1', message: 'hi' }),
      'auto-approve',
      { DRAFTGATE_HOME: home },
      { registered: true }
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('a hook stopped halfway through its decision answers ask, and ONLY ask', () => {
    /*
     * The real hook, made to fail mid-write: `ulimit -f` caps the wrapper's temp file, and a denial
     * naming a 400 KB tool name is ~800 KB of decision, written by the hook alone (an unmapped tool
     * spawns no CLI, whose files the limit would hit first). The write stops with EFBIG.
     *
     * Two layers have to hold. The hook's crash path must exit non-zero rather than append an `ask`
     * to the half it wrote and exit 0, or the wrapper replays both and Claude Code, reading no
     * decision, runs the tool. And the wrapper must drop the half and print its own `ask`.
     */
    const tool = `mcp__nobody__${'x'.repeat(400_000)}`;
    const r = runHook(hookPayload(tool, {}), 'auto-approve', {}, { registered: true, fileLimitKb: 100 });
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]!);
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.systemMessage).toContain('stopped without answering');
    // And it was the write that failed, not something before it.
    expect(r.stderr).toContain('EFBIG');
  });

  test('the moved-checkout fix names the hook\'s path inside a checkout, and it is this file\'s', () => {
    expect(HOOK.endsWith(`/${HOOK_IN_CHECKOUT}`)).toBe(true);
  });

  test('every review writes one audit line, approvals and denials alike', () => {
    const before = existsSync(auditLog) ? readFileSync(auditLog, 'utf8').trimEnd().split('\n').length : 0;
    runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-approve');
    runHook(hookPayload(JIRA_TOOL, jiraInput()), 'auto-reject');
    const lines = readFileSync(auditLog, 'utf8').trimEnd().split('\n');
    expect(lines.length - before).toBe(2);
    const entries = lines.slice(-2).map((l) => JSON.parse(l));
    expect(entries.map((e) => e.outcome)).toEqual(['approved', 'rejected']);
    for (const e of entries) {
      expect(e.destination).toBe('jira');
      expect(e.toolName).toBe(JIRA_TOOL);
      // Routing, so a log line says where it was going.
      expect(e.context.issueIdOrKey).toBe('SUPPORT-123');
      expect(e.before).toBe(jiraInput().commentBody);
      expect(typeof e.ts).toBe('string');
    }
    // `after` is omitted on a denial (nothing was sent) and on an unedited approval (it would equal
    // `before`); `edited` tells the two apart.
    expect(entries[0]!.edited).toBe(false);
    expect('after' in entries[0]!).toBe(false);
    expect('after' in entries[1]!).toBe(false);
    expect(entries[1]!.reason).toContain('auto-reject');
  });

  /*
   * An internal-note tool is routed only by a `tools.json` entry: declared there it is a configured
   * route, shown as internal; the same half under a server nobody mapped is inferred, and its name
   * asserts nothing. Read off the audit row. A service desk, so `unknown` can only come from the
   * route.
   */
  describe('an internal-note tool is internal only where tools.json declares it', () => {
    const home = mkdtempSync(join(dir, 'internal-note-'));
    writeFileSync(join(home, 'tools.json'), JSON.stringify({ [INTERNAL_NOTE_TOOL]: 'jira' }));
    writeFileSync(
      join(home, 'jira-projects.json'),
      JSON.stringify({ sites: { [jiraInput().cloudId]: { projects: { SUPPORT: 'service_desk' } } } })
    );
    const reviewed = (tool: string) => {
      const r = runHook(hookPayload(tool, jiraInput()), 'auto-approve', { DRAFTGATE_HOME: home });
      expect(decisionOf(r).permissionDecision).toBe('allow');
      const row = lastAudit();
      expect(row.toolName).toBe(tool);
      return row;
    };

    test('declared by the operator: reviewed, and shown as an internal note', () => {
      expect(reviewed(INTERNAL_NOTE_TOOL).audience).toBe('internal');
    });

    test('the same tool half under a server nobody mapped is inferred, and is not', () => {
      expect(reviewed('mcp__someone_elses_jira__jira_add_internal_note').audience).toBe('unknown');
    });
  });

  // Through the real hook and CLI: the decision, and the audit row's `context`, the same
  // `extractContext` value the window's strip draws.
  describe('what gets SENT is SHOWN', () => {
    const ISSUE_WRITE = 'mcp__claude_ai_Github_MCP__issue_write';
    const SLACK_SEND = 'mcp__claude_ai_Slack__slack_send_message';
    const WORKLOG_TOOL = 'mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue';

    test('text only in issue_fields is ASKED about, never allowed as a call with no message', () => {
      // Read as a call with no message, this would be `allow` and the reject surface would never run.
      const r = runHook(
        hookPayload(ISSUE_WRITE, {
          method: 'update', owner: 'Jakuboola', repo: 'draftgate', issue_number: 9,
          issue_fields: [{ field_name: 'Customer note', value: 'We have decided to drop support for your account.' }],
        }),
        'auto-reject'
      );
      const d = decisionOf(r);
      expect(d.permissionDecision).toBe('ask');
      // The first spaced leaf, here the field name: a non-empty `issue_fields` with a spaced field
      // name asks even to clear it, accepted since an ask costs a click.
      expect(d.permissionDecisionReason).toContain('"issue_fields.0.');
      // Its own row, not the generic one that says to rebuild the window.
      expect(d.permissionDecisionReason).toStartWith(
        'draftgate: not reviewed -- the review window cannot show everything in this GitHub call.'
      );
      const row = lastAudit();
      expect(row.code).toBe('body/nested-prose');
      // The row keeps the text, verbatim, through the default route's `*`.
      expect(row.context.issue_fields[0].value).toContain('drop support');
    });

    test('beside a title, issue_fields and every assignment are on screen and sent unchanged', () => {
      const input = {
        method: 'create', owner: 'Jakuboola', repo: 'draftgate', title: 'Export fails',
        assignees: ['octocat'], milestone: 3, type: 'Bug',
        issue_fields: [{ field_name: 'Customer note', value: 'Text nobody used to see.' }],
      };
      const d = decisionOf(runHook(hookPayload(ISSUE_WRITE, input), 'auto-approve'));
      expect(d.permissionDecision).toBe('allow');
      expect(d.updatedInput).toEqual(input);
      const { context } = lastAudit();
      expect(context.assignees).toEqual(['octocat']);
      expect(context.milestone).toBe(3);
      expect(context.type).toBe('Bug');
      expect(context.issue_fields).toEqual(input.issue_fields);
      // The editable title is an input, not a read-only copy beside it.
      expect('title' in context).toBe(false);
    });

    test('a label with spaces is routing, so a label-only update keeps the bodyOptional allow', () => {
      // `labels` is named, so the nested scan does not fire on it.
      const d = decisionOf(
        runHook(
          hookPayload(ISSUE_WRITE, {
            method: 'update', owner: 'o', repo: 'r', issue_number: 1, state: 'closed',
            labels: ['good first issue'],
          }),
          'auto-reject'
        )
      );
      expect(d.permissionDecision).toBe('allow');
      expect(lastAudit().code).toBe('body/unrecognised');
    });

    test('a comment-less worklog restricted to a role is still a call with no message', () => {
      const d = decisionOf(
        runHook(
          hookPayload(WORKLOG_TOOL, {
            cloudId: 'c', issueIdOrKey: 'SUPPORT-123', timeSpent: '2h',
            visibility: { type: 'role', value: 'Service Desk Team' },
          }),
          'auto-reject'
        )
      );
      expect(d.permissionDecision).toBe('allow');
    });

    // Without the route's named fields, `plausibleProseField` reads `"2h 30m"` as a renamed body:
    // the schema-drift alarm here, and an ask on every such worklog for an operator alias.
    test.each([
      ['a multi-unit timeSpent', { timeSpent: '2h 30m' }],
      ['a day-and-hours timeSpent', { timeSpent: '1d 4h' }],
      ['a start time written with a space', { timeSpent: '2h', started: '2026-03-09 09:00' }],
    ])('%s is a worklog with no message, not schema drift', (_, fields) => {
      const r = runHook(
        hookPayload(WORKLOG_TOOL, { cloudId: 'c', issueIdOrKey: 'SUPPORT-123', ...fields }),
        'auto-reject'
      );
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
      // A systemMessage may still carry this suite's no-registration note; never the drift alarm.
      expect(out.systemMessage ?? '').not.toContain('schema seems to have changed');
      expect(lastAudit().code).toBe('body/unrecognised');
    });

    test('a worklog whose comment moved to an undeclared field is still drift', () => {
      // Only the named fields are accounted for.
      const r = runHook(
        hookPayload(WORKLOG_TOOL, {
          cloudId: 'c', issueIdOrKey: 'SUPPORT-123', timeSpent: '2h 30m',
          comment: 'Fixed the export on empty tables',
        }),
        'auto-reject'
      );
      expect(lastAudit().code).toBe('body/missing-field');
      // At the decision, not only in the log.
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(out.systemMessage).toContain('schema seems to have changed');
    });

    test('an operator alias with bodyOptional allows a multi-unit worklog instead of asking', () => {
      // The alias inherits the named fields by tool half; it has no drift hatch.
      const home = mkdtempSync(join(dir, 'alias-'));
      const alias = 'mcp__atlassian__addWorklogToJiraIssue';
      writeFileSync(
        join(home, 'tools.json'),
        JSON.stringify({ [alias]: { destination: 'jira', bodyOptional: true } })
      );
      const r = runHook(
        hookPayload(alias, { cloudId: 'c', issueIdOrKey: 'SUPPORT-123', timeSpent: '1d 4h' }),
        'auto-reject',
        { DRAFTGATE_HOME: home }
      );
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
      expect(lastAudit().code).toBe('body/unrecognised');
    });

    test('reply_broadcast sits beside thread_ts, and every extra key is shown', () => {
      runHook(
        hookPayload(SLACK_SEND, {
          // `reply_broadcast` last, so only the profile can put it beside thread_ts.
          channel_id: 'C0GENERAL', thread_ts: '1726000000.000100',
          unfurl_app_links: true, message: 'Replying in the thread.',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'HIDDEN' } }], text: 'HIDDEN too',
          reply_broadcast: true,
        }),
        'auto-approve'
      );
      const { context } = lastAudit();
      expect(Object.keys(context)).toEqual([
        'channel_id', 'thread_ts', 'reply_broadcast', 'unfurl_app_links', 'blocks', 'text',
      ]);
      expect(context.blocks[0].text.text).toBe('HIDDEN');
    });

    test.each([
      ['a dotted key', '{"a.b": 1}'],
      ['an empty key', '{"": 1}'],
      ['__proto__', '{"__proto__": {"x": 1}}'],
    ])('%s cannot be shown, so the call is asked about rather than half-reviewed', (_, extra) => {
      // Raw JSON, because an object literal cannot carry an OWN `__proto__` key.
      const input = `{"channel_id": "C1", "message": "hi there", "extra": 0, ${extra.slice(1, -1)}}`;
      const r = runHook(`{"tool_name": "${SLACK_SEND}", "tool_input": ${input}}`, 'auto-approve');
      expect(decisionOf(r).permissionDecision).toBe('ask');
      const row = lastAudit();
      expect(row.code).toBe('context/unaddressable');
      // The named routing still reaches the row.
      expect(row.context.channel_id).toBe('C1');
    });

    test('a more specific payload diagnosis outranks an unaddressable key', () => {
      const r = runHook(
        hookPayload('mcp__claude_ai_Linear__save_comment', {
          id: 'c1', patch: [{ op: 'replace', text: 'new words here' }], 'a.b': 1,
        }),
        'auto-approve'
      );
      expect(decisionOf(r).permissionDecision).toBe('ask');
      expect(lastAudit().code).toBe('body/patch-unreadable');
    });

    test('a patch the window can show is reviewed and sent whole, not asked about', () => {
      const patch = [
        { op: 'replace', old_string: 'Tuesday', new_string: 'Thursday' },
        { op: 'append', text: '\n\nSee the thread.' },
      ];
      const r = runHook(
        hookPayload('mcp__claude_ai_Linear__save_issue', { id: 'HELP-42', patch }),
        'auto-approve'
      );
      const d = decisionOf(r);
      expect(d.permissionDecision).toBe('allow');
      // Complete, and the patch exactly as the surface approved it.
      expect(d.updatedInput).toEqual({ id: 'HELP-42', patch });
      const row = lastAudit();
      expect(row.outcome).toBe('approved');
      expect(row.code).toBeUndefined();
      expect(row.patch.map((e: { field: string }) => e.field)).toEqual(['patch.0.new_string', 'patch.1.text']);
    });

    test('junk nested past any schema is not a way back to the bodyOptional allow', () => {
      // A recursive scan would overflow (`payload.ts`'s is iterative and depth-capped), and a
      // RangeError read as `unrecognised` would let `bodyOptional` allow the text beside it.
      let junk: unknown = 'x';
      for (let i = 0; i < 30_000; i++) junk = [junk];
      const r = runHook(
        hookPayload(ISSUE_WRITE, {
          method: 'update', owner: 'o', repo: 'r', issue_number: 1, a_junk: junk,
          issue_fields: [{ field_name: 'Notes', value: 'secret agent text here' }],
        }),
        'auto-approve'
      );
      expect(decisionOf(r).permissionDecision).toBe('ask');
      expect(lastAudit().code).toBe('body/nested-prose');
    });
  });

  /*
   * `auto-reject` separates the three answers: a review ran (`deny`, row `rejected`), nothing to
   * review (`allow`), or the gate asked. On a `connector` route any spaced string in an undeclared
   * field triggers the schema-drift fail-open, so the payloads put a space in every routing value.
   */
  describe('the issue tools in the default map', () => {
    const CREATE = 'mcp__claude_ai_Atlassian_Rovo__createJiraIssue';
    const EDIT = 'mcp__claude_ai_Atlassian_Rovo__editJiraIssue';
    const SAVE_ISSUE = 'mcp__claude_ai_Linear__save_issue';
    const STATUS = 'mcp__claude_ai_Linear__save_status_update';
    const DIFF = 'mcp__claude_ai_Linear__save_diff_comment';
    const NEED = 'mcp__claude_ai_Linear__save_customer_need';
    const answer = (tool: string, input: Record<string, unknown>) => {
      const r = runHook(hookPayload(tool, input), 'auto-reject');
      return {
        decision: decisionOf(r).permissionDecision as string,
        row: lastAudit(),
      };
    };
    const reviewed = (tool: string, input: Record<string, unknown>) => {
      const { decision, row } = answer(tool, input);
      expect(decision).toBe('deny');
      expect(row.outcome).toBe('rejected');
      return row;
    };
    const passedWithNothingToReview = (tool: string, input: Record<string, unknown>) => {
      const { decision, row } = answer(tool, input);
      expect(decision).toBe('allow');
      expect(row.code).toBe('body/unrecognised');
    };

    test('each is gated under any server name, not only the one the map spells', () => {
      const re = new RegExp(matcherFor(DEFAULT_TOOL_MAP));
      for (const half of [
        'createJiraIssue', 'editJiraIssue', 'save_issue', 'save_status_update', 'save_diff_comment',
        'save_customer_need',
      ]) {
        expect(re.test(`mcp__some-other-server__${half}`), half).toBe(true);
      }
    });

    test('createJiraIssue: a create is reviewed, and a spaced issue type is not schema drift', () => {
      reviewed(CREATE, {
        cloudId: 'c', projectKey: 'SUPPORT', issueTypeName: 'Service Request',
        summary: 'Export fails on empty tables', description: 'It fails when the table is empty.',
      });
      // No description: the title is the review, and `additional_fields` is shown beside it.
      const row = reviewed(CREATE, {
        cloudId: 'c', projectKey: 'SUPPORT', issueTypeName: 'Service Request',
        summary: 'Export fails on empty tables',
        additional_fields: { customfield_10050: 'Customer impact is high' },
      });
      expect(row.context.additional_fields.customfield_10050).toBe('Customer impact is high');
    });

    test('editJiraIssue: prose is reviewed, and the edit is sent with every other field intact', () => {
      const input = {
        cloudId: 'c', issueIdOrKey: 'SUPPORT-1',
        fields: {
          summary: 'Export fails on empty tables', description: 'It fails when the table is empty.',
          labels: ['triage'], components: [{ name: 'Backend API' }],
        },
      };
      reviewed(EDIT, input);
      const r = runHook(hookPayload(EDIT, input), 'auto-approve');
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      expect(out.permissionDecision).toBe('allow');
      expect(out.updatedInput.contentFormat).toBe('adf');
      expect(out.updatedInput.fields.summary).toBe(input.fields.summary);
      expect(out.updatedInput.fields.labels).toEqual(['triage']);
      expect(out.updatedInput.fields.components).toEqual([{ name: 'Backend API' }]);
      expect(out.updatedInput.issueIdOrKey).toBe('SUPPORT-1');
    });

    test('editJiraIssue: an edit carrying no prose goes through without a prompt', () => {
      passedWithNothingToReview(EDIT, {
        cloudId: 'c', issueIdOrKey: 'SUPPORT-1',
        fields: { labels: ['triage'], priority: { name: 'High' }, components: [{ name: 'Backend API' }] },
      });
    });

    test('editJiraIssue: text in an unnamed field ASKS, and never takes the drift hatch', () => {
      // `fields` takes any field name, so this is not a renamed body; as a plain `connector` route it
      // would allow, sending the summary beside it unread.
      const { decision, row } = answer(EDIT, {
        cloudId: 'c', issueIdOrKey: 'SUPPORT-1',
        fields: { summary: 'Export fails on empty tables', environment: 'macOS 14, Chrome 120' },
      });
      expect(decision).toBe('ask');
      expect(row.code).toBe('body/missing-field');
    });

    test('save_issue: a new title is reviewed beside a spaced state, and a state change alone goes through', () => {
      reviewed(SAVE_ISSUE, { id: 'LIN-1', title: 'Export fails on empty tables', state: 'In Progress' });
      passedWithNothingToReview(SAVE_ISSUE, {
        id: 'LIN-1', state: 'In Progress', assignee: 'Jane Doe', project: 'Data Platform',
      });
    });

    test('save_status_update: a body is reviewed, and a health change alone goes through', () => {
      reviewed(STATUS, { type: 'project', project: 'Data Platform', health: 'atRisk', body: 'The export slipped a week.' });
      passedWithNothingToReview(STATUS, { type: 'project', project: 'Data Platform', id: 'su-1', health: 'offTrack' });
    });

    test('save_diff_comment: a comment is reviewed, and its anchor text is not mistaken for one', () => {
      reviewed(DIFF, { urlOrId: 'r-1', body: 'This can divide by zero.', anchorContent: 'const avg = total / rows.length' });
      // `body` is required by the schema, so no `bodyOptional`: a call without one asks.
      expect(answer(DIFF, { urlOrId: 'r-1', anchorContent: 'const avg = total / rows.length' }).decision).toBe('ask');
    });

    test('save_customer_need: a need is reviewed, and a priority change alone goes through', () => {
      reviewed(NEED, { customer: 'Acme Corp', body: 'They need SSO before renewing.' });
      passedWithNothingToReview(NEED, { id: 'n-1', customer: 'Acme Corp', priority: 1 });
    });
  });
});

/**
 * What the adapter makes of a CLI that produced no decision: the branch a broken install takes (an
 * import error in a module the CLI loads, an unwritable `--decision` path, an OOM kill). Read as
 * "allow the original input", it would be an ungated send labelled as a human approval. These pin
 * `cliResultFrom`, the translation; the spawn is covered by the real-subprocess tests.
 */
describe('a CLI that wrote no decision is nobody\'s decision', () => {
  test('no file at all is a failure, not an approval and not a denial', () => {
    const r = cliResultFrom(1, '', null);
    expect('failure' in r).toBe(true);
    expect('updatedInput' in r).toBe(false);
    expect('denial' in r).toBe(false);
  });

  test('and the failure carries the CLI\'s last words, or says what happened', () => {
    expect(cliResultFrom(1, 'error: cannot find module x\n', null)).toMatchObject({
      failure: expect.stringContaining('cannot find module x'),
    });
    expect(cliResultFrom(3, '', null)).toMatchObject({
      failure: 'the CLI exited 3 without writing a decision',
    });
  });

  test('an unparseable file is the same answer', () => {
    for (const text of ['', '{ not json', '{}', '{"outcome":"whatever"}', 'null']) {
      const r = cliResultFrom(0, '', text);
      expect('failure' in r, `${text} should not be readable as a decision`).toBe(true);
    }
  });

  test('which decide() turns into ASK -- never allow, never deny', async () => {
    // The failure produced by the real translation rather than injected.
    const h = withReview(cliResultFrom(1, 'the install is broken\n', null));
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
    expect(d.reason).toContain('the install is broken');
    // And it does not carry the original input as an approved payload.
    expect('updatedInput' in d).toBe(false);
  });

  test('a readable approval still comes through, so this is not just a refusal', () => {
    const approved = JSON.stringify({
      version: 1,
      outcome: 'approved',
      edited: false,
      destination: 'jira',
      updatedInput: { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: '{}', contentFormat: 'adf' },
    });
    const r = cliResultFrom(0, '', approved);
    expect('updatedInput' in r && r.updatedInput?.contentFormat).toBe('adf');
  });

  test('an approval with no payload never becomes an allow', () => {
    // Pins the answer, not the layer: `parseDecisionFile` refuses it first (it requires
    // `updatedInput` on an approval), leaving `cliResultFrom`'s "approved but recorded no payload"
    // as defence in depth. The reviewer approved a conversion, so the original is no substitute.
    const noPayload = JSON.stringify({ version: 1, outcome: 'approved', destination: 'jira' });
    const r = cliResultFrom(0, '', noPayload);
    expect('failure' in r).toBe(true);
    expect('updatedInput' in r).toBe(false);
  });

  test('a readable denial is passed through with its code', () => {
    // `edited` is required: the CLI always writes it, and a file without it is one the adapter
    // cannot vouch for (see `cli/test/decisionFile.test.ts`).
    const denied = JSON.stringify({
      version: 1,
      outcome: 'rejected',
      edited: false,
      destination: 'jira',
      denial: { outcome: 'rejected', destination: 'jira', reason: 'no', guidance: 'g' },
    });
    const r = cliResultFrom(1, '', denied);
    expect('denial' in r && r.denial?.outcome).toBe('rejected');
  });

  test('and this function cannot see the tool input, which is the other half of the guard', () => {
    // With no `toolInput` in scope, the failure branch cannot become `updatedInput: toolInput`.
    // Asserted on the source, because the property is the absence of a parameter.
    const source = readFileSync(join(REPO, 'adapters', 'hook', 'src', 'main.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function cliResultFrom'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).not.toContain('toolInput');
  });
});

/**
 * Every body-failure code reaches a row written for it: a new `BodyFailure` in `payload.ts` with no
 * row would fall through to the generic "could not open its review window". Keyed off
 * `BODY_FAILURES`, so a new failure fails here rather than in a review.
 */
describe('every body-failure code has a policy row of its own', () => {
  const WINDOW_WORDING = 'could not open its review window';

  for (const [failure, spec] of Object.entries(BODY_FAILURES)) {
    test(`${failure} (${spec.code}) is not diagnosed as a broken window`, async () => {
      const h = withReview({
        exitCode: 1,
        denial: {
          outcome: 'unavailable',
          code: spec.code,
          destination: 'jira',
          reason: `a body failure of shape ${failure}`,
          guidance: 'g',
        },
      });
      const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
      expect(d.reason, `${spec.code} fell through to the generic unavailable row`).not.toContain(
        WINDOW_WORDING
      );
      expect(d.systemMessage ?? '').not.toContain('build:surface');
    });
  }

  test('and the generic row IS still reachable, so the check above is not vacuous', async () => {
    const h = withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable',
        destination: 'jira',
        reason: 'The review window failed to start.',
        guidance: 'g',
      },
    });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.reason).toContain(WINDOW_WORDING);
  });
});

/**
 * The generic `unavailable` row's advice is the CLI's, never its own: the CLI puts the remedy that
 * fits into `denial.reason` (`cli/test/windowSurface.test.ts`), and this row passes it through,
 * picking only the headline from the code.
 */
describe('the fallback row passes the cause through', () => {
  const unavailable = (code: Denial['code'], reason: string) =>
    withReview({
      exitCode: 1,
      denial: { outcome: 'unavailable', ...(code ? { code } : {}), destination: 'jira', reason, guidance: 'g' },
    });

  test("a crashed window is not told to rebuild, and is not described as one that didn't start", async () => {
    const h = unavailable('surface/unavailable', 'The review window exited with code 1. Last output: boom');
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
    expect(d.reason).toContain('exited with code 1');
    expect(d.reason).not.toContain('build:surface');
  });

  test('a stale window keeps the rebuild the CLI named', async () => {
    const h = unavailable('surface/stale', `The built window is probably stale: run ${REMEDY.rebuildWindow}.`);
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.reason).toContain(REMEDY.rebuildWindow);
    expect(d.reason).toContain('older than itself');
    // Exactly once: the row does not add a second copy of the advice.
    expect(d.reason!.split(REMEDY.rebuildWindow).length).toBe(2);
  });

  test('draftgate failing before any window is not a window that would not open', async () => {
    const h = unavailable('review/crashed', 'draftgate failed while preparing this jira review: x');
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.reason).not.toContain('review window');
    expect(d.reason).toContain('internal error before it could show a review');
    expect(d.reason).not.toContain('build:surface');
    // A reason that ends without a full stop still reads as a sentence.
    expect(askReaders(d).prompt[1]).toBe('draftgate failed while preparing this jira review: x.');
  });
});

/**
 * Every `ask`, as each of its readers gets it (see `askReaders`). For every row: the first drawn
 * line says what was not reviewed and what approving does, nothing for the agent is drawn, the
 * after-approval line does not repeat the reason, and the agent is told what already happened,
 * never the CLI's guidance.
 */
describe('what an ask shows, and to whom', () => {
  const GUIDANCE = 'AGENT-GUIDANCE: send it differently next time.';
  const denialRow = (code: Denial['code'], reason: string): CliResult => ({
    exitCode: 1,
    denial: { outcome: 'unavailable', ...(code ? { code } : {}), destination: 'jira', reason, guidance: GUIDANCE },
  });
  const operatorMap = mergeToolMap(DEFAULT_TOOL_MAP, { [INTERNAL_NOTE_TOOL]: 'jira' }, 'tools.json');
  const ROWS: [string, Denial['code'], string?][] = [
    ['preformatted', 'body/preformatted'],
    ['a patch', 'body/patch-unreadable'],
    ['nested prose', 'body/nested-prose'],
    ['an unaddressable key', 'context/unaddressable'],
    ['a wrong-typed body', 'body/wrong-type'],
    ['an unrecognised payload', 'body/unrecognised'],
    ['a missing field on an operator route', 'body/missing-field', INTERNAL_NOTE_TOOL],
    ['a window that would not start', 'surface/unavailable'],
    ['a stale window', 'surface/stale'],
    ['a crash before any window', 'review/crashed'],
    ['an unavailable denial with no code', undefined],
  ];

  for (const [label, code, tool] of ROWS) {
    const run = async (reason: string) => {
      const h = withReview(denialRow(code, reason));
      const toolName = tool ?? JIRA_TOOL;
      return askReaders(await decide(hookPayload(toolName, jiraInput()), { ...h.opts, toolMap: operatorMap }));
    };

    test(`${label}: one line for the person, the agent's text in the agent's field`, async () => {
      const reason = 'CLI-REASON naming the payload. Present keys: cloudId, issueIdOrKey, commentBody.';
      const { prompt, afterApproval, agent } = await run(reason);
      expect(prompt[0]).toStartWith('draftgate: not reviewed -- ');
      expect(prompt[0]).toContain(' Approving sends it as written');
      // At most one more line, and never the agent's instructions.
      expect(prompt.length).toBeLessThanOrEqual(2);
      expect(prompt.join('\n')).not.toContain('AGENT-GUIDANCE');
      // Drawn after an approval, under the tool call: the headline, not the reason again.
      expect(prompt[0]).toStartWith(afterApproval!);
      expect(afterApproval).not.toContain('CLI-REASON');
      // Read only after an approval, so it says the call went ahead and must not be resent.
      expect(agent).toStartWith('draftgate did not review this tool call: ');
      expect(agent).toContain('It went ahead without that review, so do not send it again');
      expect(agent).not.toContain('AGENT-GUIDANCE');
      expect(agent).not.toContain('CLI-REASON');
    });

    test(`${label}: the first line survives Claude Code's trim, whatever the reason holds`, async () => {
      const short = await run('short.');
      const long = await run(Array.from({ length: 60 }, (_, i) => `line ${i} `.repeat(20)).join('\n'));
      expect(long.prompt[0]).toBe(short.prompt[0]);
    });
  }

  test('a call the gate could not read: one line for the person, what happened for the agent', async () => {
    const h = withReview({ exitCode: 1, failure: 'the CLI wrote no decision' });
    const { prompt, afterApproval, agent } = askReaders(await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts));
    expect(prompt).toEqual([
      "draftgate: not reviewed -- it could not run the review. Approving sends it as written, in " +
        "markdown rather than Jira's own format.",
      'the CLI wrote no decision.',
    ]);
    expect(afterApproval).toBe('draftgate: not reviewed -- it could not run the review.');
    expect(agent).toBe(
      'draftgate did not review this tool call: it could not run the review. It went ahead without ' +
        'that review, so do not send it again to have it reviewed.'
    );
  });

  test('only a patch and a converted body tell the agent how a LATER call gets reviewed', async () => {
    const agentFor = async (code: Denial['code']) =>
      askReaders(await decide(hookPayload(JIRA_TOOL, jiraInput()), withReview(denialRow(code, 'r')).opts)).agent;
    expect(await agentFor('body/patch-unreadable')).toEndWith(
      'To have a later edit reviewed, send the full new text of the field instead of a patch.'
    );
    expect(await agentFor('body/preformatted')).toEndWith(
      'To have a later message reviewed, send its body as markdown.'
    );
    expect(await agentFor('surface/unavailable')).toEndWith('do not send it again to have it reviewed.');
  });

  test('input that is not JSON: one line, and the error under it', async () => {
    const h = withReview({ exitCode: 0, updatedInput: {} });
    const { prompt } = askReaders(await decide('{not json', h.opts));
    expect(prompt[0]).toBe('draftgate: not reviewed -- it could not read the hook input. Approving sends it as written.');
    expect(prompt[1]).toContain('JSON');
  });
});

/**
 * The schema-drift fail-open, narrowed to schema drift. Allowing on any unreadable body would let a
 * one-word `tools.json` mistake (`{"mcp__claude_ai_Slack__slack_send_message":"jira"}`) or
 * `commentBody: 123` through unreviewed. Two narrowings: the CLI tells drift from a wrong-typed field
 * and an unrecognised payload (`cli/test/review.test.ts`), and the adapter requires a default route.
 */
describe('the fail-open is for schema drift, and nothing else', () => {
  const jiraDrift: Denial = {
    outcome: 'unavailable',
    code: 'body/missing-field',
    destination: 'jira',
    reason: 'Payload for "jira" has no "commentBody" field, but "comment" looks like it holds it.',
    guidance: 'g',
  };

  test('drift on a DEFAULT-mapped tool still fails open, loudly', () => {
    const h = withReview({ exitCode: 1, denial: jiraDrift });
    return decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts).then((d) => {
      expect(d.permissionDecision).toBe('allow');
      expect('updatedInput' in d && d.updatedInput).toEqual(jiraInput());
      expect(d.systemMessage).toContain('schema seems to have changed');
    });
  });

  for (const [label, code] of [
    ['a present but wrong-typed body', 'body/wrong-type'],
    ['a payload with nothing prose-like in it', 'body/unrecognised'],
    ['a body already in the destination format', 'body/preformatted'],
  ] as const) {
    test(`${label} ASKS instead`, async () => {
      const h = withReview({
        exitCode: 1,
        denial: { ...jiraDrift, code, reason: `the body was unreadable (${code})` },
      });
      const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
      expect(d.permissionDecision).toBe('ask');
      // And it must not carry the agent's original bytes as an approved payload.
      expect('updatedInput' in d).toBe(false);
    });
  }

  test('the preformatted ask does not diagnose the install or the tool map', async () => {
    // Nothing is missing or misrouted and the window is fine; and `inMarkdown` would say the
    // fallback goes "in markdown" when the payload is already converted.
    const h = withReview({
      exitCode: 1,
      denial: {
        ...jiraDrift,
        code: 'body/preformatted',
        reason: 'Payload for "jira" sets "contentFormat", so its "commentBody" is already in jira.',
      },
    });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
    expect(d.reason).toBe(
      "draftgate: not reviewed -- this Jira body is already in Jira's own format, not markdown. " +
        'Approving sends it as written.'
    );
  });

  test('the patch ask blames neither the tool map nor the window, and names what it could not show', async () => {
    // `body/unrecognised`'s row says to check `tools.json` and the body field: a wrong diagnosis for
    // a patch, whose map is fine and whose text is in Linear. A patch the window can show never
    // reaches here; this one carries an operation it cannot.
    const h = withReview({
      exitCode: 1,
      denial: {
        ...jiraDrift,
        code: 'body/patch-unreadable',
        reason:
          'Payload for "linear" carries "patch" rather than a whole "description": a list of ' +
          'edits applied to content that already lives in linear, which draftgate cannot read. It ' +
          'could not show the edits themselves either: edit 1 has op "rewrite", which draftgate ' +
          'cannot show. Present keys: id, patch.',
        guidance: 'send the full new text of the field instead of a patch.',
      },
    });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('ask');
    // Never a send: nobody saw this.
    expect('updatedInput' in d).toBe(false);
    // The person reads the headline and why, and none of the three wrong diagnoses.
    const { prompt, agent } = askReaders(d);
    expect(prompt[0]).toBe(
      'draftgate: not reviewed -- a Jira patch whose edits draftgate cannot show. Approving sends it as written.'
    );
    expect(prompt.slice(1).join('\n')).toContain('edit 1 has op "rewrite"');
    expect(prompt.join('\n')).not.toContain('tools.json');
    expect(prompt.join('\n')).not.toContain('window');
    // The agent is told what it can do instead, in the field that reaches it.
    expect(agent).toContain('send the full new text of the field');
  });

  /**
   * A tool whose body field is optional, called without one: `{cloudId, issueIdOrKey, timeSpent:
   * "2h"}` carries no prose, so the CLI reports `body/unrecognised`, and without the flag every
   * comment-less worklog would ask.
   */
  describe('a tool whose body is optional', () => {
    const WORKLOG = 'mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue';
    const unrecognised: Denial = {
      ...jiraDrift,
      code: 'body/unrecognised',
      reason: 'Payload for "jira" has no "commentBody" field and nothing else looks like a message.',
    };
    const worklog = { cloudId: 'c', issueIdOrKey: 'SUPPORT-123', timeSpent: '2h' };

    test('is gated at all, and the matcher covers it', () => {
      expect(DEFAULT_TOOL_MAP[WORKLOG]).toEqual({
        destination: 'jira', bodyOptional: true, contextFields: ['timeSpent', 'started', 'visibility', '*'], schemaOwner: 'connector',
      });
      expect(new RegExp(matcherFor(DEFAULT_TOOL_MAP)).test(WORKLOG)).toBe(true);
    });

    test('a call with NO message is allowed, not prompted', async () => {
      const h = withReview({ exitCode: 1, denial: unrecognised });
      const d = await decide(hookPayload(WORKLOG, worklog), h.opts);
      expect(d.permissionDecision).toBe('allow');
      expect('updatedInput' in d && d.updatedInput).toEqual(worklog);
      // Not announced; the CLI has already written the audit row.
      expect(d.systemMessage).toBeUndefined();
    });

    test('the SAME payload on a tool without the flag still asks', async () => {
      // The flag is the whole difference.
      const h = withReview({ exitCode: 1, denial: unrecognised });
      const d = await decide(hookPayload(JIRA_TOOL, worklog), h.opts);
      expect(d.permissionDecision).toBe('ask');
      expect('updatedInput' in d).toBe(false);
    });

    for (const [label, code] of [
      ['a body that is present but wrong-typed', 'body/wrong-type'],
      ['a body already in the destination format', 'body/preformatted'],
    ] as const) {
      test(`${label} still asks, flag or no flag`, async () => {
        // Only `body/unrecognised` means "no message here"; these mean one draftgate cannot read.
        const h = withReview({ exitCode: 1, denial: { ...unrecognised, code } });
        const d = await decide(hookPayload(WORKLOG, worklog), h.opts);
        expect(d.permissionDecision).toBe('ask');
      });
    }

    test('and a worklog that DOES carry a comment is reviewed like any other', async () => {
      // There is a `commentBody`, so the CLI reviews it and returns a converted payload.
      const input = { ...worklog, commentBody: 'Spent the morning on the **queue** backlog.' };
      const h = withReview({ exitCode: 0, updatedInput: { ...input, contentFormat: 'adf' } });
      const d = await decide(hookPayload(WORKLOG, input), h.opts);
      expect(d.permissionDecision).toBe('allow');
      expect('updatedInput' in d && (d.updatedInput as Record<string, unknown>).contentFormat)
        .toBe('adf');
    });
  });

  test('a MIS-mapped tool asks, even for drift, because a typo is not drift', async () => {
    // The Slack tool routed to the jira profile by a one-word override.
    const h = {
      calls: [] as unknown[],
      opts: {
        toolMap: { ...DEFAULT_TOOL_MAP, [SLACK_TOOL]: { destination: 'jira', schemaOwner: 'operator' } } as ToolMap,
        declined: [],
        async review() {
          return { exitCode: 1, denial: jiraDrift };
        },
      },
    };
    const d = await decide(
      hookPayload(SLACK_TOOL, { channel_id: 'C1', message: 'agent prose nobody reviewed' }),
      h.opts
    );
    expect(d.permissionDecision).toBe('ask');
    expect('updatedInput' in d).toBe(false);
  });

  test('and a tool the default map does not know asks too, however it was mapped', async () => {
    const tool = 'mcp__some_other_server__addCommentToJiraIssue';
    const h = {
      calls: [] as unknown[],
      opts: {
        toolMap: { ...DEFAULT_TOOL_MAP, [tool]: { destination: 'jira', schemaOwner: 'operator' } } as ToolMap,
        declined: [],
        async review() {
          return { exitCode: 1, denial: jiraDrift };
        },
      },
    };
    const d = await decide(hookPayload(tool, jiraInput()), h.opts);
    // The one place the narrowing costs something: drift on a renamed connector asks.
    expect(d.permissionDecision).toBe('ask');
  });
});

/**
 * An approval says who approved it; said for every surface alike, `--surface auto-approve` would
 * record that a person vouched for something nobody read.
 */
describe('an approval names the surface that made it', () => {
  const approve = (surface?: string, human?: boolean): CliResult => ({
    exitCode: 0,
    updatedInput: { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: '{}', contentFormat: 'adf' },
    ...(surface ? { surface } : {}),
    ...(human === undefined ? {} : { human }),
  });

  test('a real window is a human, and says so', async () => {
    const h = withReview(approve('webkit', true));
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('allow');
    expect(d.reason).toBe('draftgate: a person reviewed this Jira message and approved it as written.');
  });

  test('the FACT decides, not the name: a surface this adapter has never heard of can be human', async () => {
    // `ReviewSurface.human` is the surface's own statement and rides the decision file; the name is
    // only wording.
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), withReview(approve('mcp', true)).opts);
    expect(d.reason).toContain('a person reviewed');
    // And no name means human on its own: `human: false` under `electron` is believed.
    const machine = await decide(hookPayload(JIRA_TOOL, jiraInput()), withReview(approve('electron', false)).opts);
    expect(machine.reason).toContain('not by a person');
  });

  test('auto-approve is NOT, and the reason says so plainly', async () => {
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), withReview(approve('auto-approve', false)).opts);
    expect(d.permissionDecision).toBe('allow');
    expect(d.reason).not.toContain('a person reviewed');
    expect(d.reason).toContain('not by a person');
    expect(d.reason).toContain('auto-approve');
  });

  test('and an unidentified surface gets the neutral wording, never the human one', async () => {
    // A CLI too old to report a surface: absence must not read as "a person".
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), withReview(approve()).opts);
    expect(d.reason).not.toContain('a person reviewed');
    expect(d.reason).toContain('did not identify itself');
  });
});

/**
 * What the agent reads of an `allow`: `additionalContext`, after the tool result (`hookOutput.ts`).
 * Read off the rendered hook output, the bytes Claude Code parses, never off the decision object.
 */
describe('every allow tells the agent what draftgate did', () => {
  const APPROVED = { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: '{}', contentFormat: 'adf' };
  const agentReads = (d: HookDecision): unknown => {
    const out = JSON.parse(renderHookOutput(d));
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    return out.hookSpecificOutput.additionalContext;
  };
  const approvedBy = async (result: Partial<CliResult>) =>
    agentReads(await decide(hookPayload(JIRA_TOOL, jiraInput()), withReview({
      exitCode: 0, updatedInput: APPROVED, ...result,
    }).opts));
  const EDITED_HEAD =
    'draftgate: a person reviewed this Jira message and edited it before approving it, so the tool ' +
    'received their version, not your draft. What they changed (everything else is as you wrote it):';

  test('a person approved it unedited', async () => {
    expect(await approvedBy({ surface: 'webkit', human: true, edited: false })).toBe(
      'draftgate: a person reviewed this Jira message and approved it as written.'
    );
  });

  test('a person edited the body: the agent reads the body the tool received', async () => {
    expect(await approvedBy({
      surface: 'webkit', human: true, edited: true, sentBody: 'Fixed in **4.2**.\n\n- one\n- two',
    })).toBe(`${EDITED_HEAD}\nThe body, in markdown:\n\nFixed in **4.2**.\n\n- one\n- two`);
  });

  test('a person edited only a line: the line, and no body', async () => {
    expect(await approvedBy({
      surface: 'webkit', human: true, edited: true,
      sentLines: [{ field: 'title', value: 'Export fails on empty tables' }],
    })).toBe(`${EDITED_HEAD}\ntitle: Export fails on empty tables`);
  });

  test('a person edited a line and the body: both, lines first', async () => {
    expect(await approvedBy({
      surface: 'webkit', human: true, edited: true, sentBody: 'New body.',
      sentLines: [{ field: 'title', value: 'New title' }, { field: 'labels.0', value: 'bug' }],
    })).toBe(`${EDITED_HEAD}\ntitle: New title\nlabels.0: bug\nThe body, in markdown:\n\nNew body.`);
  });

  test('an edit with nothing to show says it was edited, never "as written"', async () => {
    // `edited` with no `sentBody` or `sentLines`: a file that does not carry them, or an edit restored
    // byte for byte. Either way "as written" could hide a real edit.
    expect(await approvedBy({ surface: 'webkit', human: true, edited: true })).toBe(
      'draftgate: a person reviewed this Jira message and edited it before approving it; draftgate ' +
      'cannot show you what changed.'
    );
  });

  test('CRLF is measured as Claude Code measures it: split into lines, never over the cap', async () => {
    // 167 lines of 45 characters: under 8000 joined with `\n`, over it with `\r\n`.
    const body = Array(167).fill('z'.repeat(45)).join('\r\n');
    const read = (await approvedBy({ surface: 'webkit', human: true, edited: true, sentBody: body })) as string;
    expect(read).toBe(`${EDITED_HEAD}\nThe body, in markdown:\n\n${body.replace(/\r\n/g, '\n')}`);
    expect(read.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });

  test('a cut at the line cap still fits the character cap, mark included', async () => {
    // The first 200 lines come to 7998 characters, so only the line cap cuts; the mark must still
    // fit inside 8000.
    const label = `${EDITED_HEAD}\nThe body, in markdown, cut to fit here (only its start):\n\n`;
    const kept = CONTEXT_MAX_LINES - label.split('\n').length + 1;
    const per = Math.floor((CONTEXT_MAX_CHARS - 2 - label.length - (kept - 1)) / kept);
    const first = 'v'.repeat(CONTEXT_MAX_CHARS - 2 - label.length - (kept - 1) - per * (kept - 1));
    const body = [first, ...Array(300).fill('w'.repeat(per))].join('\n');
    expect((label + body).split('\n').slice(0, CONTEXT_MAX_LINES).join('\n').length).toBe(CONTEXT_MAX_CHARS - 2);
    const read = (await approvedBy({ surface: 'webkit', human: true, edited: true, sentBody: body })) as string;
    expect(read.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(read.split('\n').length).toBeLessThanOrEqual(CONTEXT_MAX_LINES);
    expect(read).toEndWith(' [...]');
  });

  test('a cut never splits a character in two', async () => {
    // Both parities, so one of them puts the cut between the two halves of an emoji.
    for (const lead of ['', 'a']) {
      const read = (await approvedBy({
        surface: 'webkit', human: true, edited: true, sentBody: lead + '\u{1F600}'.repeat(5000),
      })) as string;
      expect(read).toEndWith(' [...]');
      expect(read).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  test('a body over the cap is cut to what Claude Code keeps, and says so', async () => {
    for (const body of ['x'.repeat(CONTEXT_MAX_CHARS * 2), Array(CONTEXT_MAX_LINES * 2).fill('line').join('\n')]) {
      const read = (await approvedBy({ surface: 'webkit', human: true, edited: true, sentBody: body })) as string;
      expect(read.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
      expect(read.split('\n').length).toBeLessThanOrEqual(CONTEXT_MAX_LINES);
      expect(read).toStartWith(`${EDITED_HEAD}\nThe body, in markdown, cut to fit here (only its start):\n\n`);
      expect(read).toEndWith(' [...]');
    }
    // The control: at the cap exactly, nothing is cut and no cut is claimed.
    const label = `${EDITED_HEAD}\nThe body, in markdown:\n\n`;
    const fits = 'y'.repeat(CONTEXT_MAX_CHARS - label.length);
    expect(await approvedBy({ surface: 'webkit', human: true, edited: true, sentBody: fits })).toBe(label + fits);
  });

  test('a machine surface never reads as a person, edited or not', async () => {
    const machine = 'draftgate: this Jira message was approved by draftgate\'s "auto-approve" surface, not by a person; nobody read it.';
    expect(await approvedBy({ surface: 'auto-approve', human: false, edited: false })).toBe(machine);
    expect(await approvedBy({ surface: 'auto-approve', human: false, edited: true, sentBody: 'x' })).toBe(machine);
    // A CLI too old to say: not a person either.
    expect(await approvedBy({ edited: true, sentBody: 'x' })).toBe(
      'draftgate: this Jira message was approved by a draftgate surface that did not identify itself, not by a person; nobody read it.'
    );
  });

  test('schema drift: not reviewed, and no invitation to resend', async () => {
    const d = await decide(hookPayload(JIRA_TOOL, { cloudId: 'c', issueIdOrKey: 'K-1', comment: 'hi' }), withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable', code: 'body/missing-field', destination: 'jira',
        reason: 'Payload for "jira" has no "commentBody" field.', guidance: 'g',
      },
    }).opts);
    expect(agentReads(d)).toBe(
      "draftgate did not review this tool call: the Jira tool's schema seems to have changed. It went " +
      'ahead without that review, so do not send it again to have it reviewed.'
    );
  });

  test('an optional body left out: not reviewed, nothing to review', async () => {
    const WORKLOG = 'mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue';
    const d = await decide(hookPayload(WORKLOG, { cloudId: 'c', issueIdOrKey: 'K-1', timeSpent: '2h' }), withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable', code: 'body/unrecognised', destination: 'jira',
        reason: 'Payload for "jira" has no "commentBody" field.', guidance: 'g',
      },
    }).opts);
    expect(agentReads(d)).toBe(
      `draftgate did not review this tool call: "${WORKLOG}" takes an optional message and this call ` +
      'carries none, so there was nothing to review. It went ahead without that review, so do not ' +
      'send it again to have it reviewed.'
    );
  });

  test('the CLI\'s decision file to the agent: an edit the window reported reaches additionalContext', async () => {
    // Producer to consumer: the CLI's encoder, the adapter's reader, the policy, the rendered output.
    const file = encodeDecisionFile({
      exitCode: 0, human: true, edited: true, updatedInput: APPROVED,
      sent: { body: 'their text', lines: [{ field: 'title', value: 'b' }] },
      audit: { destination: 'jira', context: {}, outcome: 'approved', edited: true, warnings: [] } as AuditRecord,
    }, 'webkit');
    const result = cliResultFrom(0, '', JSON.stringify(file));
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), withReview(result).opts);
    expect(agentReads(d)).toBe(`${EDITED_HEAD}\ntitle: b\nThe body, in markdown:\n\ntheir text`);
  });
});

// ---------------------------------------------------------------------------
// The policy's edges.
// ---------------------------------------------------------------------------

describe('a tool named after an Object.prototype member is unmapped', () => {
  /*
   * A bare `toolMap[toolName]` finds these on a plain object: `tool_name: "toString"` would reach
   * `review()` with `destination: undefined`, crash in `inMarkdown` and be turned into `ask` by the
   * last-resort handler. A tool the map does not know is a `deny`.
   */
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    test(`"${name}" is denied, not asked, and no review is attempted`, async () => {
      let reviewed = false;
      const d = await decide(hookPayload(name, { a: 1 }), {
        toolMap: DEFAULT_TOOL_MAP,
        declined: [],
        review: async () => {
          reviewed = true;
          return { exitCode: 0, updatedInput: {} };
        },
      });
      expect(d.permissionDecision).toBe('deny');
      expect(reviewed).toBe(false);
    });
  }
});

describe('the fail-open needs the outcome as well as the code', () => {
  // Keyed on the code alone, `body/missing-field` with `outcome: 'rejected'` would turn a human's
  // refusal into a send. No CLI path produces that pair, so it is pinned rather than trusted.
  const withCode = (outcome: 'unavailable' | 'rejected' | 'timeout') =>
    withReview({
      exitCode: 1,
      denial: {
        outcome,
        destination: 'jira',
        code: 'body/missing-field',
        reason: 'no commentBody',
        guidance: 'g',
      },
    });

  test('unavailable + body/missing-field still fails open, as schema drift requires', async () => {
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), withCode('unavailable').opts);
    expect(d.permissionDecision).toBe('allow');
  });

  for (const outcome of ['rejected', 'timeout'] as const) {
    test(`${outcome} + body/missing-field does NOT`, async () => {
      const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), withCode(outcome).opts);
      expect(d.permissionDecision).not.toBe('allow');
      expect(d.permissionDecision).toBe('deny');
    });
  }

  // The same for the other `allow`, `body/unrecognised` on a `bodyOptional` route: a code says
  // what the payload looked like, never whether a human objected.
  const bodyOptionalWith = (outcome: 'unavailable' | 'rejected' | 'timeout') =>
    decide(
      hookPayload('mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue', {
        cloudId: 'c',
        issueIdOrKey: 'K-1',
        timeSpent: '2h',
      }),
      withReview({
        exitCode: 1,
        denial: {
          outcome,
          destination: 'jira',
          code: 'body/unrecognised',
          reason: 'no body',
          guidance: 'g',
        },
      }).opts
    );

  test('a bodyOptional route allows only when the gate could not RUN', async () => {
    expect((await bodyOptionalWith('unavailable')).permissionDecision).toBe('allow');
    for (const outcome of ['rejected', 'timeout'] as const) {
      const d = await bodyOptionalWith(outcome);
      expect(d.permissionDecision).toBe('deny');
    }
  });

  test('and body/preformatted asks only then too', async () => {
    // Same rule, smaller cost: without it a refusal would become `ask`.
    const withPre = (outcome: 'unavailable' | 'rejected') =>
      decide(
        hookPayload(JIRA_TOOL, jiraInput()),
        withReview({
          exitCode: 1,
          denial: { outcome, destination: 'jira', code: 'body/preformatted', reason: 'adf', guidance: 'g' },
        }).opts
      );
    expect((await withPre('unavailable')).permissionDecision).toBe('ask');
    expect((await withPre('rejected')).permissionDecision).toBe('deny');
  });
});

describe('a denial reason survives Claude Code\'s trim with its guidance', () => {
  // Claude Code 2.1.261 binary: the reason is cut to the first 20 lines, then 2000 characters, so
  // what is appended last (the anti-retry guidance) is what disappears.
  const GUIDANCE =
    'Do not resend this message. Do not try a different tool. Ask the user what to change.';

  test('a long reason is cut and the guidance is still there in full', async () => {
    const reason = Array.from({ length: 200 }, (_, i) => `line ${i} of a very long rejection`).join('\n');
    const h = withReview({
      exitCode: 1,
      denial: { outcome: 'rejected', destination: 'jira', reason, guidance: GUIDANCE },
    });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.permissionDecision).toBe('deny');
    const shown = d.reason ?? '';

    // What the harness would keep, applied here: first 20 lines, then 2000 chars.
    const kept = shown.split('\n').slice(0, REASON_MAX_LINES).join('\n').slice(0, REASON_MAX_CHARS);
    expect(kept).toContain(GUIDANCE);
    // ...and the whole string is already within the cap.
    expect(shown.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
    expect(shown.split('\n').length).toBeLessThanOrEqual(REASON_MAX_LINES);
    // The reason is still represented, and visibly cut.
    expect(shown).toContain('line 0 of a very long rejection');
    expect(shown).toContain('[...]');
  });

  test('a short reason is not touched', async () => {
    const h = withReview({
      exitCode: 1,
      denial: { outcome: 'rejected', destination: 'jira', reason: 'Wrong channel.', guidance: GUIDANCE },
    });
    const d = await decide(hookPayload(JIRA_TOOL, jiraInput()), h.opts);
    expect(d.reason).toBe(`Wrong channel.\n\n${GUIDANCE}`);
  });

  test('denialReason keeps the guidance whatever the reason is', () => {
    expect(denialReason(undefined, 'G')).toBe('G');
    expect(denialReason('R', undefined)).toBe('R');
    expect(denialReason('x'.repeat(5000), 'G').endsWith('\n\nG')).toBe(true);
    expect(denialReason('x'.repeat(5000), 'G').length).toBeLessThanOrEqual(REASON_MAX_CHARS);
  });
});

/**
 * `--doctor` applies the log's retention too, or somebody who stopped reviewing keeps every message
 * in plaintext forever. It never changes the exit code for it.
 */
describe('--doctor prunes the message log', () => {
  test('an entry past the retention is gone after --doctor, and a recent one stays', () => {
    const home = mkdtempSync(join(dir, 'doctor-prune-'));
    const log = join(home, 'audit.jsonl');
    const old = JSON.stringify({ ts: '2025-01-01T00:00:00.000Z', destination: 'jira', outcome: 'approved', before: 'OLD' });
    const recent = JSON.stringify({ ts: new Date().toISOString(), destination: 'jira', outcome: 'approved', before: 'NEW' });
    writeFileSync(log, `${old}\n${recent}\n`);
    const r = spawnSync(process.execPath, [HOOK, '--doctor'], {
      encoding: 'utf8',
      cwd: home,
      timeout: 30_000,
      env: { ...process.env, DRAFTGATE_HOME: home, DRAFTGATE_AUDIT_LOG: log, CLAUDE_CONFIG_DIR: home },
    });
    expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
    const left = readFileSync(log, 'utf8');
    expect(left).not.toContain('OLD');
    expect(left).toContain('NEW');
  });
});

describe('--doctor reports the release check', () => {
  test('the same line a review prints, and never as a problem', () => {
    const home = mkdtempSync(join(dir, 'doctor-release-'));
    const run = () =>
      spawnSync(process.execPath, [HOOK, '--doctor'], {
        encoding: 'utf8',
        cwd: home,
        timeout: 30_000,
        env: { ...process.env, DRAFTGATE_HOME: home, DRAFTGATE_AUDIT_LOG: join(home, 'audit.jsonl'), CLAUDE_CONFIG_DIR: home },
      });
    const before = run();
    expect(before.stdout).toContain('  Releases\n    not checked yet.');

    const line = seedNewerRelease(home, REPO);
    const after = run();
    expect(after.stdout).toContain(`    NOTE: ${line}\n`);
    // The exit code is whatever the rest of the report decides: an update is not a finding.
    expect(after.status).toBe(before.status);
    expect(after.stdout.split('\n').at(-2)).toBe(before.stdout.split('\n').at(-2));
  });
});

/**
 * `PreToolUse`'s `session_id` reaches the review, so the audit log can tell a retry from a second
 * message; without it the digest counts rounds.
 */
describe('the agent session reaches the review', () => {
  test('it is forwarded when the payload carries one', () => {
    const { calls, opts } = withReview({ exitCode: 0, updatedInput: { text: 'x' } });
    return decide(
      JSON.stringify({
        session_id: 'sess-abc',
        tool_name: 'mcp__claude_ai_Slack__slack_send_message',
        tool_input: { channel_id: 'C1', message: 'hi' },
      }),
      opts
    ).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.sessionId).toBe('sess-abc');
    });
  });

  test('and a payload with NO session still reviews, with none forwarded', () => {
    // Absent stays absent all the way down, never `''` or `undefined`-as-value.
    const { calls, opts } = withReview({ exitCode: 0, updatedInput: { text: 'x' } });
    return decide(
      JSON.stringify({
        tool_name: 'mcp__claude_ai_Slack__slack_send_message',
        tool_input: { channel_id: 'C1', message: 'hi' },
      }),
      opts
    ).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.sessionId).toBeUndefined();
    });
  });
});

describe('the review deadline reaches the CLI', () => {
  const base = {
    destination: 'jira' as const,
    toolName: 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue',
    inPath: '/tmp/in.json',
    decisionPath: '/tmp/out.json',
    surface: 'webkit',
  };

  test('--timeout is always passed, in seconds', () => {
    // Omitted, the CLI falls back to DEFAULT_TIMEOUT_MS, the number the clamp overrides: with a
    // 660-second registration a 20-minute review outlives a harness that gives up at 11, and the
    // fail-open sends the original input. Nothing downstream can catch it.
    const args = cliArgs({ ...base, deadlineMs: 600_000 });
    const at = args.indexOf('--timeout');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('600');
  });

  test('a fractional deadline is still a number the CLI parser accepts', () => {
    // A very short registration can give a fractional deadline; `--timeout` rounds to ms itself.
    const args = cliArgs({ ...base, deadlineMs: 27_500 });
    expect(args[args.indexOf('--timeout') + 1]).toBe('27.5');
    expect(Number(args[args.indexOf('--timeout') + 1])).toBeGreaterThan(0);
  });

  test('the session flag stays spread, so an absent session passes nothing', () => {
    expect(cliArgs({ ...base, deadlineMs: 1_000 })).not.toContain('--session');
    expect(cliArgs({ ...base, deadlineMs: 1_000, sessionId: 's1' })).toContain('--session');
  });

  test('--body-field is passed when the route overrides, and absent when it does not', () => {
    // With none passed the CLI keeps the profile's field; without it a `save_issue` review reads
    // `body`, misses, and shows nothing.
    expect(cliArgs({ ...base, deadlineMs: 1_000 })).not.toContain('--body-field');
    const args = cliArgs({ ...base, deadlineMs: 1_000, bodyField: 'description' });
    expect(args[args.indexOf('--body-field') + 1]).toBe('description');
  });

  test('--context-field is repeated once per field, never delimited', () => {
    // One flag per name lets a field name contain anything, with no escape rule.
    expect(cliArgs({ ...base, deadlineMs: 1_000 })).not.toContain('--context-field');
    const args = cliArgs({ ...base, deadlineMs: 1_000, contextFields: ['project', 'health'] });
    const at = args.flatMap((a, i) => (a === '--context-field' ? [args[i + 1]] : []));
    expect(at).toEqual(['project', 'health']);
  });
});

describe('a bodyField on an INFERRED route', () => {
  const map: ToolMap = {
    mcp__claude_ai_Linear__save_issue: {
      destination: 'linear', bodyField: 'description', schemaOwner: 'operator',
    },
  };

  test('travels with the destination, because the tool half IS the tool', () => {
    // The body field is a fact about the tool's own schema. Copied, it can only produce `ask` or
    // `deny` (an inferred route has both fail-opens `false`); not copied, the route misses and asks
    // with no draft shown.
    const r = resolveRoute('mcp__other__save_issue', map);
    expect(r?.inferred).toBe(true);
    expect(r?.route.bodyField).toBe('description');
    expect(r?.route.schemaOwner).toBe('inferred');
    expect(FAIL_OPEN[r!.route.schemaOwner]).toEqual({ schemaDrift: false, bodyOptional: false });
  });

  test('bodyOptional still does NOT travel with it', () => {
    // `bodyOptional` becomes `allow`: copied, an unconfigured server's worklog tool would send
    // unreviewed.
    const withFlag: ToolMap = {
      mcp__a__addWorklogToJiraIssue: {
        destination: 'jira', bodyOptional: true, bodyField: 'commentBody', schemaOwner: 'connector',
      },
    };
    const r = resolveRoute('mcp__b__addWorklogToJiraIssue', withFlag);
    expect(r?.route.bodyField).toBe('commentBody');
    expect(r?.route.bodyOptional).toBeUndefined();
  });
});

/**
 * A tool nobody configured, whose name says what it is: a project-scoped MCP server in a folder
 * nobody ran setup in would otherwise send with no window, no log row and no error. A wrong
 * inference is still reviewed by a human; no inference is sent with nobody looking.
 */
describe('a tool the map does not name, whose tool half it does', () => {
  const UNCONFIGURED = 'mcp__some_other_server__slack_send_message';

  test('it is REVIEWED, routed by the half it shares', () => {
    const { calls, opts } = withReview({ exitCode: 0, updatedInput: { text: 'x' } });
    return decide(
      JSON.stringify({ tool_name: UNCONFIGURED, tool_input: { channel_id: 'C1', message: 'hi' } }),
      opts
    ).then((d) => {
      expect(d.permissionDecision).toBe('allow');
      expect(calls[0]!.destination).toBe('slack');
      // The review is told the name it matched, not a bare true: the reviewer judges the guess.
      expect(calls[0]!.inferredFrom).toBe('mcp__claude_ai_Slack__slack_send_message');
    });
  });

  test('a configured tool is not reported as inferred', () => {
    const { calls, opts } = withReview({ exitCode: 0, updatedInput: { text: 'x' } });
    return decide(
      JSON.stringify({
        tool_name: 'mcp__claude_ai_Slack__slack_send_message',
        tool_input: { channel_id: 'C1', message: 'hi' },
      }),
      opts
    ).then(() => expect(calls[0]!.inferredFrom).toBeUndefined());
  });

  test('and it can NEVER take the schema-drift fail-open, whatever the payload does', () => {
    // The fail-open is for a connector draftgate has probed; nobody has probed or named this one.
    // Without this, inference would widen the fail-open to every server name.
    const { opts } = withReview({
      exitCode: 1,
      denial: {
        outcome: 'unavailable',
        code: 'body/missing-field',
        destination: 'slack',
        reason: 'Payload for "slack" has no "message" field.',
        guidance: 'This is a problem with the payload.',
      },
    });
    return decide(
      JSON.stringify({ tool_name: UNCONFIGURED, tool_input: { channel_id: 'C1' } }),
      opts
    ).then((d) => {
      expect(d.permissionDecision).toBe('ask');
      expect(d.permissionDecision).not.toBe('allow');
    });
  });

  test('a tool half nothing routes is still DENIED, so exception 3 survives', () => {
    // Reaching this means the registration named something the map cannot route: a configuration
    // error, not an `ask`.
    const { opts } = withReview({ exitCode: 0, updatedInput: { text: 'x' } });
    return decide(
      JSON.stringify({ tool_name: 'mcp__x__post_a_thing', tool_input: { message: 'hi' } }),
      opts
    ).then((d) => expect(d.permissionDecision).toBe('deny'));
  });
});


describe('a print mode refuses a tool map it cannot read, rather than printing a decision', () => {
  // The tool map loads before the mode is dispatched; answered as a review would be, `draftgate
  // propose-tools` would hand setup an `ask` decision as its report, with exit 0. These pin the
  // print-mode branch of that catch.
  const runPrint = (toolsJson: string | null) => {
    const home = mkdtempSync(join(dir, 'print-'));
    if (toolsJson !== null) writeFileSync(join(home, 'tools.json'), toolsJson);
    return spawnSync(process.execPath, [HOOK, '--propose-tools', 'mcp__claude_ai_Slack__slack_send_message'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, DRAFTGATE_HOME: home },
    });
  };

  test('with an empty tools.json it exits 1 and prints nothing on stdout', () => {
    const r = runPrint('');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('refusing to run with a tool map it could not read');
  });

  test('with a corrupt tools.json it exits 1 too', () => {
    const r = runPrint('{ not json');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  test('it still works when the tool map is fine, and what it prints is no decision', () => {
    // The control: the refusal is not a wall of its own.
    const r = runPrint(null);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      // The report is not JSON, so it cannot be a decision.
    }
    expect(isPlainObject(parsed) && 'hookSpecificOutput' in parsed).toBe(false);
  });
});
