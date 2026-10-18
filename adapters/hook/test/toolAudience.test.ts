/**
 * The tool map and the audience rule must agree about which Jira tools exist.
 *
 * `DEFAULT_TOOL_MAP` and the matchers in `core/src/profiles/jira.ts` cannot be generated from one
 * another (`core` must not import from `adapters/`), so the link is a test. A Jira tool added to the
 * map without evidence gets `kind: 'unknown'` naming itself, and this file says so when it is added.
 *
 * Why the audience is not a `ToolRoute` field, and why an internal-note tool is recognised by name
 * only on a configured route: `audience.md`. The last describe sweeps the inferred case. No
 * internal-note tool is a default entry; why is in `toolMap.ts`, "What is knowingly out".
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_TOOL_MAP, mergeToolMap, resolveRoute, toolHalfOf } from '../src/toolMap';
import { codePolicy, decide } from '../src/decide';
import { jiraAudience, jiraToolProbed } from '../../../core/src/profiles/jira';
import { toolAudienceProbed } from '../../../core/src/index';
import type { DenialCode } from '../../../cli/src/types';

/** A service-desk payload, so the only remaining way to get `unknown` is the tool being unprobed. */
const CLOUD = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const FACTS = { sites: { [CLOUD]: { projects: { SUPPORT: 'service_desk' as const } } } };
const CONTEXT = { cloudId: CLOUD, issueIdOrKey: 'SUPPORT-123' };

const jiraTools = Object.entries(DEFAULT_TOOL_MAP)
  .filter(([, route]) => route.destination === 'jira')
  .map(([tool]) => tool);

describe('every gated Jira tool is one the audience rule has evidence about', () => {
  test('the map actually routes some tools to jira, or this suite proves nothing', () => {
    expect(jiraTools.length).toBeGreaterThan(0);
  });

  test.each(jiraTools)('%s', (tool) => {
    const audience = jiraAudience(CONTEXT, { ...FACTS, toolName: tool });
    // `public` (a request comment on a declared service desk) or no audience (a worklog, probed),
    // never the "no evidence" branch. No default claims `internal`: that takes a `tools.json` entry.
    const known = audience === undefined || audience.kind === 'public';
    expect(
      known,
      `${tool} is routed to jira but core/src/profiles/jira.ts has no evidence about it, so its ` +
        'reviews report an unknown audience. Probe what that tool posts, then name it in ' +
        '`core/src/profiles/jira.ts` beside the matcher whose evidence it shares -- a tool that ' +
        'writes a request\'s own summary and description belongs in `WRITES_REQUEST_FIELDS`, ' +
        'which carries its own placement rule. Do not guess, and do not reuse another ' +
        "tool's probes for it."
    ).toBe(true);
  });

  /*
   * `--doctor` asks the same question and must get the same answer.
   *
   * `jiraToolProbed` is what `adapters/hook/src/doctor.ts` asks over the merged map, which this
   * suite cannot cover: a `tools.json` Jira tool never reaches `DEFAULT_TOOL_MAP`. Swept together,
   * including the two branches `jiraAudience` returns from before its fallthrough asks (a worklog
   * and an internal note).
   */
  test.each([
    ...jiraTools,
    'mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue',
    'mcp__x__addWorklogToJiraIssue',
    'mcp__x__jira_add_internal_note',
    'mcp__x__editJiraIssue',
    'mcp__x__createJiraIssue',
    'somethingElseEntirely',
  ])('jiraToolProbed agrees with the banner for %s', (tool) => {
    const audience = jiraAudience(CONTEXT, { ...FACTS, toolName: tool });
    const bannerKnows = audience === undefined || audience.kind !== 'unknown';
    expect(jiraToolProbed(tool)).toBe(bannerKnows);
    /*
     * Through the dispatcher too, which is the form `--doctor` calls. Without `audienceProbed:
     * jiraToolProbed` on the profile literal, the dispatcher's `?? true` default reports every Jira
     * tool as probed, hiding the finding.
     */
    expect(toolAudienceProbed('jira', tool)).toBe(bannerKnows);
  });

  test('a destination with no audience question is not reported as unprobed', () => {
    // Slack's three audiences are indistinguishable in the payload and Linear has no visibility
    // field, so neither declares `audienceFor`; the other default would put every Slack and Linear
    // tool in a permanent `--doctor` finding.
    expect(toolAudienceProbed('slack', 'mcp__x__slack_send_message')).toBe(true);
    expect(toolAudienceProbed('linear', 'mcp__x__save_comment')).toBe(true);
  });

  test('and a tool the PROFILE has no evidence about is still refused it', () => {
    /*
     * The control: if this passed as `public` too, the test above would be vacuous.
     *
     * `transitionJiraIssue` is a real Rovo tool nothing here has measured; a made-up name would not
     * prove the evidence list decides it. If it is ever probed and named, move the control to
     * another unprobed tool.
     */
    const audience = jiraAudience(CONTEXT, {
      ...FACTS,
      toolName: 'mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue',
    });
    expect(audience?.kind).toBe('unknown');
  });
});

/**
 * No inferred route may claim `internal`, the one answer that tells a reviewer a customer will not
 * read something.
 *
 * Every Jira tool's half under a server nobody mapped, resolved by the real `resolveRoute`, so if
 * inference stopped reporting itself the claim would come back. Swept over the defaults merged
 * (real `mergeToolMap`) with a `tools.json` internal-note entry: no default claims `internal`, so
 * without it the sweep could not see the claim.
 */
describe('a tool nobody mapped never borrows the internal-note claim', () => {
  const INTERNAL_NOTE_TOOL = 'mcp__jsm__jira_add_internal_note';
  const merged = mergeToolMap(DEFAULT_TOOL_MAP, { [INTERNAL_NOTE_TOOL]: 'jira' }, 'tools.json');

  test.each([...jiraTools, INTERNAL_NOTE_TOOL])('%s, under another server', (tool) => {
    const stranger = `mcp__someone_elses_jira__${toolHalfOf(tool)}`;
    const resolved = resolveRoute(stranger, merged);
    expect(resolved?.inferred).toBe(true);
    const audience = jiraAudience(CONTEXT, {
      ...FACTS,
      toolName: stranger,
      routeInferred: resolved?.inferred,
    });
    expect(audience?.kind).not.toBe('internal');
  });

  test('and the operator-declared entry DOES claim it, which is why the sweep is not vacuous', () => {
    const resolved = resolveRoute(INTERNAL_NOTE_TOOL, merged);
    expect(resolved?.inferred).toBe(false);
    expect(resolved?.route.schemaOwner).toBe('operator');
    const audience = jiraAudience(CONTEXT, {
      ...FACTS,
      toolName: INTERNAL_NOTE_TOOL,
      routeInferred: resolved?.inferred,
    });
    expect(audience?.kind).toBe('internal');
  });

  test('and no default claims it: an internal-note tool is routed only by a tools.json entry', () => {
    expect(
      jiraTools.some((tool) => jiraAudience(CONTEXT, { ...FACTS, toolName: tool })?.kind === 'internal')
    ).toBe(false);
    expect(resolveRoute(INTERNAL_NOTE_TOOL, DEFAULT_TOOL_MAP)).toBeNull();
  });
});

/**
 * Every denial code reaches a decision, and only the two documented ones can allow.
 *
 * The union makes a typo a compile error; this iterates it so a new code cannot inherit whatever
 * the last `if` in the chain does.
 */
describe('the adapter is exhaustive over denial codes', () => {
  /**
   * One review whose CLI leg denied with the given code, on an operator-typed route: there
   * `body/missing-field`'s fail-open does not apply, so nothing may allow except the `bodyOptional`
   * variant.
   */
  const decideWith = (code: DenialCode, route: { bodyOptional?: boolean }) =>
    decide(
      JSON.stringify({
        tool_name: 'mcp__operator_typed__someJiraTool',
        tool_input: { cloudId: 'c', issueIdOrKey: 'SUPPORT-1' },
      }),
      {
        declined: [],
        toolMap: {
          mcp__operator_typed__someJiraTool: { destination: 'jira', schemaOwner: 'operator', ...route },
        },
        review: async () => ({
          exitCode: 1,
          denial: {
            outcome: 'unavailable',
            code,
            destination: 'jira',
            reason: 'the gate could not run',
            guidance: 'do not resend',
          },
        }),
      }
    );

  const CODES = [
    'body/missing-field',
    'body/unrecognised',
    'body/wrong-type',
    'body/preformatted',
    'body/patch-unreadable',
    'body/blocked-after-approval',
    'body/nested-prose',
    'context/unaddressable',
    'review/crashed',
    'surface/unavailable',
    'surface/stale',
  ] as const satisfies readonly DenialCode[];

  /**
   * The list above is the union, checked by the compiler.
   *
   * `satisfies` refuses a code the union lacks. The other direction: a new `DenialCode` forces a
   * `CODE_POLICY` entry in `decide.ts` but would leave this array behind, unchecked. `Exclude` is
   * empty when the array is complete, so the annotation is `true`; a missing code becomes its name
   * and this stops compiling.
   */
  type UncheckedCode = Exclude<DenialCode, (typeof CODES)[number]>;
  const EVERY_CODE_IS_CHECKED: UncheckedCode extends never ? true : UncheckedCode = true;

  test('every denial code has a policy, and the list cannot fall behind the union', () => {
    expect(EVERY_CODE_IS_CHECKED).toBe(true);
    for (const code of CODES) expect(codePolicy(code)).toBeString();
    expect(new Set(CODES).size).toBe(CODES.length);
  });

  /*
   * Every code, against the whole outcome union. `CODE_POLICY` cannot enforce the outcome guard (one
   * early return in `decide`), whose absence on the `bodyOptional` branch would turn a reviewer's
   * rejection into an unreviewed send. For every code, a refusal denies.
   */
  const decideOutcome = (code: DenialCode, outcome: 'rejected' | 'timeout') =>
    decide(
      JSON.stringify({
        tool_name: 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue',
        tool_input: { cloudId: 'c', issueIdOrKey: 'SUPPORT-1', commentBody: 'hi' },
      }),
      {
        toolMap: DEFAULT_TOOL_MAP,
        declined: [],
        review: async () => ({
          exitCode: 1,
          denial: {
            outcome,
            code,
            destination: 'jira',
            reason: 'a human said no',
            guidance: 'do not resend',
          },
        }),
      }
    );

  test.each([...CODES])('%s DENIES on a rejection and on a timeout, whatever it is', async (code) => {
    for (const outcome of ['rejected', 'timeout'] as const) {
      const d = await decideOutcome(code, outcome);
      expect(d.permissionDecision).toBe('deny');
      // The reason is the human's, carried whole, not a payload diagnosis.
      expect(d.reason).toContain('a human said no');
    }
  });

  test.each([...CODES])('%s on an ordinary route never allows', async (code) => {
    const decision = await decideWith(code, {});
    // `body/missing-field` allows only on a default-mapped route; this one comes from tools.json.
    expect(decision.permissionDecision).not.toBe('allow');
  });

  test.each([...CODES])('%s on a bodyOptional route only allows if it is body/unrecognised', async (code) => {
    const decision = await decideWith(code, { bodyOptional: true });
    const allowed = decision.permissionDecision === 'allow';
    expect(allowed).toBe(code === 'body/unrecognised');
  });
});
