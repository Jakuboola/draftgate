/**
 * The audience rule: who receives a Jira message. Every expectation traces to a live probe on a
 * scratch issue; each letter is described where first used (B on `POSTS_INTERNAL_NOTE` in
 * `core/src/profiles/jira.ts`, G and J below, K and L further down). The three easiest to get
 * backwards:
 *
 *   - a worklog has no audience (probe J: posting one with a comment left both the platform and the
 *     portal comment lists unchanged, and it carries no `jsdPublic`)
 *   - an edit reports `unchanged`, never `public` (probe G: an edit preserves the existing flag,
 *     which draftgate cannot read)
 *   - a missing fact is `unknown`, a loud banner, never silence
 */

import { describe, expect, test } from 'bun:test';
import {
  JIRA_PROJECT_TYPES,
  jiraAudience,
  jiraProjectKey,
  jiraTargetProjectKey,
  jiraProfile,
  jiraSiteFor,
  jiraSiteKey,
  jiraSiteKeysFor,
  type JiraAudienceAnswer,
  type JiraProjectType,
  type JiraSite,
} from '../src/profiles/jira';
import { audienceFor, destinationLabelFor, profiles } from '../src/profiles';
import { GITHUB_REPO_VISIBILITIES, githubAudience } from '../src/profiles/github';
import { slackProfile } from '../src/profiles/slack';
import { linearProfile } from '../src/profiles/linear';

const DEV = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PROD = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
const COMMENT_TOOL = 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue';
const WORKLOG_TOOL = 'mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue';
const EDIT_TOOL = 'mcp__claude_ai_Atlassian_Rovo__editJiraIssue';
const CREATE_TOOL = 'mcp__claude_ai_Atlassian_Rovo__createJiraIssue';

const issue = (key: string, cloudId = DEV) => ({ cloudId, issueIdOrKey: key });

/**
 * The dev site as `tools/jira-projects/` writes it, plus the comment tool every audience fact was
 * probed against: an unnamed caller takes the `unknown` branch. Tests that mean another tool spread
 * over this.
 */
const sites = (projects: Record<string, JiraSite['projects'][string]>, cloudId = DEV) => ({
  sites: { [cloudId]: { host: 'acme-dev.atlassian.net', projects } },
  toolName: COMMENT_TOOL,
});

const SERVICE_DESK = sites({ SUPPORT: 'service_desk' });

/** A configured service desk with the caller unnamed: the mirror of `NO_CONFIG`. */
const SERVICE_DESK_NO_TOOL = { sites: SERVICE_DESK.sites };

/** No operator config, but the caller named: only the project fact is missing. */
const NO_CONFIG = { toolName: COMMENT_TOOL };

/**
 * A Jira answer shaped the way the window builds one: the destination beside the value. Tests where
 * the destination is the subject drive `audienceFor` instead, further down.
 */
const JIRA = (value: JiraProjectType): JiraAudienceAnswer['classified'] => ({
  destination: 'jira',
  value,
});

describe('jiraProjectKey', () => {
  test('takes the project half of an issue key', () => {
    expect(jiraProjectKey('SUPPORT-123')).toBe('SUPPORT');
  });

  test('UPPERCASES, because Jira issue keys are case-insensitive', () => {
    // Probed: an issue key returns 200 in upper, lower and mixed case. Otherwise a lower-case key
    // misses the config entry and reports `unknown` on a declared project.
    expect(jiraProjectKey('support-123')).toBe('SUPPORT');
    expect(jiraProjectKey('Support-123')).toBe('SUPPORT');
  });

  test('a numeric issue ID carries no project, and that is a real unknown', () => {
    // `issueIdOrKey` accepts "PROJ-123 or 10000" per the tool's own schema.
    expect(jiraProjectKey('25664')).toBeUndefined();
  });

  test('nothing is invented from a non-string or a malformed reference', () => {
    expect(jiraProjectKey(undefined)).toBeUndefined();
    expect(jiraProjectKey(12345)).toBeUndefined();
    expect(jiraProjectKey('SUPPORT')).toBeUndefined();
    expect(jiraProjectKey('SUPPORT-')).toBeUndefined();
    expect(jiraProjectKey('-15646')).toBeUndefined();
    expect(jiraProjectKey('9SUPPORT-1')).toBeUndefined();
  });

  test('surrounding whitespace does not defeat the lookup', () => {
    expect(jiraProjectKey('  SUPPORT-123 ')).toBe('SUPPORT');
  });
});

describe('jiraTargetProjectKey', () => {
  /*
   * The one spelling the reader and the writer (`rememberProject` in `cli/src/main.ts`) share. A
   * writer parsing `issueIdOrKey` alone would have the window ask "Is NEWSD a service desk?" about a
   * create and then file nothing.
   */
  test('an issue reference', () => {
    expect(jiraTargetProjectKey({ issueIdOrKey: 'SUPPORT-123' })).toBe('SUPPORT');
  });

  test('a CREATE payload names its project outright', () => {
    expect(jiraTargetProjectKey({ projectKey: 'support' })).toBe('SUPPORT');
  });

  test('the issue reference WINS, because it names an existing issue in an existing project', () => {
    // Not a shape any tool sends; pins the precedence of the `??`.
    expect(jiraTargetProjectKey({ issueIdOrKey: 'SUPPORT-1', projectKey: 'OTHER' })).toBe('SUPPORT');
  });

  test('a numeric issue id with no projectKey is still a real unknown', () => {
    expect(jiraTargetProjectKey({ issueIdOrKey: '25664' })).toBeUndefined();
  });

  test('and nothing is invented from a projectKey that is not key-shaped', () => {
    for (const projectKey of ['', '  ', 'SUP-1', '1SUP', 'a b', 42, null, undefined]) {
      expect(jiraTargetProjectKey({ projectKey })).toBeUndefined();
    }
  });
});

describe('jiraSiteFor', () => {
  const all = sites({ SUPPORT: 'service_desk' }).sites;

  test('matches on cloud id', () => {
    expect(jiraSiteFor(DEV, all)?.projects.SUPPORT).toBe('service_desk');
  });

  test('and on the hostname, because the tool accepts a site URL as `cloudId`', () => {
    // The schema says "Cloud ID (UUID or site URL)", so both spellings are legitimate input.
    expect(jiraSiteFor('acme-dev.atlassian.net', all)).toBeDefined();
    expect(jiraSiteFor('https://acme-dev.atlassian.net/', all)).toBeDefined();
    expect(jiraSiteFor('ACME-DEV.ATLASSIAN.NET', all)).toBeDefined();
  });

  test('a different site is not a match', () => {
    expect(jiraSiteFor(PROD, all)).toBeUndefined();
    expect(jiraSiteFor('acme-prod.atlassian.net', all)).toBeUndefined();
  });

  test('nothing is matched from an absent, blank or non-string cloudId', () => {
    expect(jiraSiteFor(undefined, all)).toBeUndefined();
    expect(jiraSiteFor('', all)).toBeUndefined();
    expect(jiraSiteFor('   ', all)).toBeUndefined();
    expect(jiraSiteFor(42, all)).toBeUndefined();
    expect(jiraSiteFor(DEV, undefined)).toBeUndefined();
  });
});

describe('jiraAudience', () => {
  test('a service desk is PUBLIC, and says the tool cannot do otherwise', () => {
    const a = jiraAudience(issue('SUPPORT-123'), { ...SERVICE_DESK, toolName: COMMENT_TOOL });
    expect(a?.kind).toBe('public');
    expect(a?.label).toBe('Reply to customer');
    expect(a?.detail).toContain('cannot post an internal note');
  });

  test('a software or business project has NO audience question, so no banner', () => {
    expect(jiraAudience(issue('KAN-1'), sites({ KAN: 'software' }))).toBeUndefined();
    expect(jiraAudience(issue('BIZ-1'), sites({ BIZ: 'business' }))).toBeUndefined();
  });

  test('no fact is UNKNOWN, loudly, and names the project it could not place', () => {
    const a = jiraAudience(issue('SUPPORT-123'), NO_CONFIG);
    expect(a?.kind).toBe('unknown');
    expect(a?.detail).toContain('SUPPORT');
    expect(a?.detail).toContain('customer');
  });

  test('unknown survives an unparseable issue reference without inventing a key', () => {
    const a = jiraAudience({ cloudId: DEV, issueIdOrKey: '25664' }, SERVICE_DESK);
    expect(a?.kind).toBe('unknown');
    expect(a?.detail).toContain('this project');
    expect(a?.detail).not.toContain('undefined');
  });

  /** One project key can exist on a dev site and on production, so the config is site-keyed. */
  test('a key declared for one site does not answer for another', () => {
    const a = jiraAudience(issue('SUPPORT-123', PROD), SERVICE_DESK);
    expect(a?.kind).toBe('unknown');
  });

  test('and the right site still answers when both are configured', () => {
    const both = {
      ...NO_CONFIG,
      sites: {
        ...SERVICE_DESK.sites,
        [PROD]: { host: 'acme-prod.atlassian.net', projects: { SUPPORT: 'software' as const } },
      },
    };
    expect(jiraAudience(issue('SUPPORT-1', DEV), both)?.kind).toBe('public');
    expect(jiraAudience(issue('SUPPORT-1', PROD), both)).toBeUndefined();
  });

  test('an EDIT is `unchanged`, never `public` -- probe G', () => {
    const a = jiraAudience({ ...issue('SUPPORT-123'), commentId: '10001' }, SERVICE_DESK);
    expect(a?.kind).toBe('unchanged');
    expect(a?.detail).toContain('cannot read');
  });

  test('an edit with no project fact is still `unchanged`, not `unknown`', () => {
    // Probe G settles what an edit does whatever the project type; the unknown is the comment's
    // current visibility, which the detail line says.
    const a = jiraAudience({ ...issue('SUPPORT-123'), commentId: '10001' }, NO_CONFIG);
    expect(a?.kind).toBe('unchanged');
  });

  test('a software project stays silent even when editing', () => {
    const a = jiraAudience({ ...issue('KAN-1'), commentId: '1' }, sites({ KAN: 'software' }));
    expect(a).toBeUndefined();
  });

  test('an empty or blank commentId is not an edit', () => {
    // `extractContext` copies whatever the payload held; a blank id read as an edit would report
    // `unchanged` on a new public comment.
    for (const commentId of ['', '   ']) {
      const a = jiraAudience({ ...issue('SUPPORT-123'), commentId }, SERVICE_DESK);
      expect(a?.kind).toBe('public');
    }
  });

  test('only the PUBLIC case names an audience it cannot reach', () => {
    // The struck-through `Add internal note` is the other tab in JSM's composer; on `unknown` or an
    // edit there is no alternative to name.
    expect(jiraAudience(issue('SUPPORT-123'), SERVICE_DESK)?.unavailable).toBe(
      'Add internal note'
    );
    expect(jiraAudience(issue('SUPPORT-123'), NO_CONFIG)?.unavailable).toBeUndefined();
    expect(
      jiraAudience({ ...issue('SUPPORT-123'), commentId: '1' }, {})?.unavailable
    ).toBeUndefined();
  });
});

/**
 * The tool half. `addWorklogToJiraIssue` takes `commentBody` and `issueIdOrKey` like the comment
 * tool, so a rule reading the payload alone would say "Reply to customer". PROBED (J): a worklog
 * with a comment left the platform and portal comment lists both at 25, and has no `jsdPublic`.
 */
describe('which TOOL is posting', () => {
  test('a worklog has no audience at all -- probe J', () => {
    expect(
      jiraAudience(issue('SUPPORT-123'), { ...SERVICE_DESK, toolName: WORKLOG_TOOL })
    ).toBeUndefined();
  });

  test('even on a service desk, and even carrying a comment', () => {
    expect(
      jiraAudience(
        { ...issue('SUPPORT-123'), commentId: '1' },
        { ...SERVICE_DESK, toolName: WORKLOG_TOOL }
      )
    ).toBeUndefined();
  });

  test('the match is on the TOOL half, so a renamed connector keeps working', () => {
    // The `mcp__<server>__` prefix is one installation's name; the tool half is stable (`toolMap.ts`).
    for (const tool of ['mcp__atlassian__addWorklogToJiraIssue', 'addWorklogToJiraIssue']) {
      expect(jiraAudience(issue('SUPPORT-123'), { ...SERVICE_DESK, toolName: tool })).toBeUndefined();
    }
    for (const tool of ['mcp__atlassian__addCommentToJiraIssue', 'addCommentToJiraIssue']) {
      expect(jiraAudience(issue('SUPPORT-123'), { ...SERVICE_DESK, toolName: tool })?.kind).toBe(
        'public'
      );
    }
  });

  test('a tool nobody probed reports unknown and NAMES itself', () => {
    // A real Rovo tool nothing has probed, so the evidence list (not a made-up name) decides it.
    const a = jiraAudience(issue('SUPPORT-123'), {
      ...SERVICE_DESK,
      toolName: 'mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue',
    });
    expect(a?.kind).toBe('unknown');
    expect(a?.detail).toContain('transitionJiraIssue');
  });

  /*
   * The two field writers, PROBED: K, an edit of a service-desk request through `editJiraIssue`,
   * and L, a create through `createJiraIssue`. Both are service-desk conditional.
   */
  test('editing a service-desk request is PUBLIC -- probe K', () => {
    const a = jiraAudience(issue('SUPPORT-123'), { ...SERVICE_DESK, toolName: EDIT_TOOL });
    expect(a?.kind).toBe('public');
    // Worded apart from a comment: a summary is the request's name everywhere the customer looks.
    expect(a?.label).toBe('The customer reads this');
    expect(a?.detail).toContain('portal');
  });

  test('creating one is public too, and states NEITHER timing -- probe L', () => {
    const a = jiraAudience({ cloudId: DEV, projectKey: 'SUPPORT' }, { ...SERVICE_DESK, toolName: CREATE_TOOL });
    expect(a?.kind).toBe('public');
    /*
     * Probed twice. With the tool's own parameters the issue is a 404 in the portal until a request
     * type is set; with `additional_fields: {"customfield_10010": ...}` it is a portal request on
     * arrival. The custom field id is per-site and draftgate holds no credentials, so the banner
     * names neither timing.
     */
    expect(a?.detail).toBe('This writes the title and body of a service-desk request.');
  });

  test('a CREATE payload names its project outright, so it can be classified and asked about', () => {
    // A create carries no issue reference, only `projectKey`.
    const unclassified = jiraAudience({ cloudId: DEV, projectKey: 'nosuch' }, { toolName: CREATE_TOOL });
    expect(unclassified?.kind).toBe('unknown');
    expect(unclassified?.ask?.question).toContain('NOSUCH');
  });

  test('neither writer claims a customer on a project that is not a service desk', () => {
    for (const toolName of [EDIT_TOOL, CREATE_TOOL]) {
      expect(jiraAudience(issue('KAN-1'), { ...sites({ KAN: 'software' }), toolName })).toBeUndefined();
    }
  });

  test('no tool name at all is UNKNOWN, not the strongest claim available', () => {
    /*
     * `jira_add_internal_note` posts through the same `commentBody` field, so the body field does not
     * decide the audience. An unnamed caller (`review --dest jira --in payload.json`, no `--tool`)
     * must not inherit `addCommentToJiraIssue`'s probed claims.
     */
    const a = jiraAudience(issue('SUPPORT-123'), SERVICE_DESK_NO_TOOL);
    expect(a?.kind).toBe('unknown');
    // And it says which fact is missing.
    expect(a?.detail).toContain('not told which tool');
    expect(a?.detail).not.toContain('undefined');
  });

  test('a near-miss name is not treated as the comment tool', () => {
    // Anchored, as `matcherFor` is: a prefix or suffix of a known name is a different tool.
    const a = jiraAudience(issue('SUPPORT-123'), {
      ...SERVICE_DESK,
      toolName: 'addCommentToJiraIssueDraft',
    });
    expect(a?.kind).toBe('unknown');
  });
});

/**
 * Which profiles have an audience at all (Jira here, GitHub in `github.test.ts`), and why Slack and
 * Linear do not.
 *
 * Slack has several audiences and the payload does not say which: a public channel, a private
 * channel and a group DM all have `C`-prefixed ids, so draftgate cannot derive the audience offline.
 * Linear's `save_comment` schema has no visibility field, so there is no audience choice to report.
 */
describe('which profiles have an audience at all', () => {
  test('jira does', () => {
    expect('audienceFor' in jiraProfile).toBe(true);
  });

  test('slack does NOT -- its audiences are real but not derivable from the payload', () => {
    expect('audienceFor' in slackProfile).toBe(false);
  });

  test('linear does NOT -- its comment tool has no visibility field to report', () => {
    expect('audienceFor' in linearProfile).toBe(false);
  });
});

/**
 * "Ask once and remember": the question is offered only when there is something answerable, and an
 * answer changes the audience immediately, not from the next review.
 */
describe('the audience question', () => {
  test('an unknown audience names the project to ask about', () => {
    const a = jiraAudience(issue('SUPPORT-123'), NO_CONFIG);
    expect(a?.kind).toBe('unknown');
    // `ask` carries the name; no second field repeats it.
    expect(a?.ask?.question).toContain('SUPPORT');
  });

  test('and asks nothing when there is no project in the reference', () => {
    // A numeric issue id carries no project to name.
    const a = jiraAudience({ cloudId: DEV, issueIdOrKey: '25664' }, NO_CONFIG);
    expect(a?.kind).toBe('unknown');
    expect(a?.ask).toBeUndefined();
  });

  test('a KNOWN audience asks nothing -- there is nothing missing', () => {
    expect(jiraAudience(issue('SUPPORT-123'), SERVICE_DESK)?.ask).toBeUndefined();
    expect(jiraAudience({ ...issue('SUPPORT-123'), commentId: '1' }, {})?.ask).toBeUndefined();
  });

  test("the reviewer's answer outranks the config lookup", () => {
    const a = jiraAudience(issue('SUPPORT-123'), { ...NO_CONFIG, classified: JIRA('service_desk') });
    expect(a?.kind).toBe('public');
    expect(a?.label).toBe('Reply to customer');
    expect(a?.ask).toBeUndefined();
  });

  test('and "internal only" removes the banner entirely', () => {
    expect(jiraAudience(issue('SUPPORT-123'), { ...NO_CONFIG, classified: JIRA('software') })).toBeUndefined();
  });

  test('an answer needs no cloudId and no project key, which is why the window can give one', () => {
    // `AudienceFacts.classified` lets `App.tsx`'s recompute pass an answer, not a map keyed by
    // cloud id and project key.
    const a = jiraAudience({ issueIdOrKey: 'ANYTHING-1' }, { ...NO_CONFIG, classified: JIRA('service_desk') });
    expect(a?.kind).toBe('public');
  });

  test('a worklog still has no audience, whatever the reviewer says', () => {
    // The tool half wins first (probe J); a classification is about the project.
    expect(
      jiraAudience(issue('SUPPORT-123'), { classified: JIRA('service_desk'), toolName: WORKLOG_TOOL })
    ).toBeUndefined();
  });
});

/**
 * The question's words are the profile's, not literals in JSX. The site key is normalised alike on
 * both sides (`jiraSiteKey` below): a raw `cloudId` stored by `rememberJiraProject` would never be
 * read back, and "ask once" becomes "ask every time".
 */
describe('what the profile supplies for the question', () => {
  test('the question text and both option labels come from here, not from JSX', () => {
    const ask = jiraAudience(issue('SUPPORT-123'), NO_CONFIG)?.ask;
    expect(ask?.question).toContain('SUPPORT');
    expect(ask?.options.map((o) => o.value)).toEqual(['service_desk', 'software']);
    for (const option of ask!.options) expect(option.label.length).toBeGreaterThan(4);
  });

  test('and nothing is offered when there is no project to ask about', () => {
    expect(jiraAudience({ cloudId: DEV, issueIdOrKey: '25664' }, NO_CONFIG)?.ask).toBeUndefined();
    expect(jiraAudience(issue('SUPPORT-123'), SERVICE_DESK)?.ask).toBeUndefined();
  });

  test('every offered value is one the wire will accept', () => {
    // The options come back as `classifyProject`, validated against this vocabulary.
    const ask = jiraAudience(issue('SUPPORT-123'), NO_CONFIG)?.ask;
    for (const option of ask!.options) {
      expect(JIRA_PROJECT_TYPES as readonly string[]).toContain(option.value);
    }
  });
});

describe('destinationLabelFor -- WHERE it is going, in words', () => {
  // An opaque `cloudId` reads the same for a scratch issue and a customer ticket, and one issue key
  // can exist on both sites.
  test('the site is named from the operator config, with the issue as the payload spelled it', () => {
    expect(destinationLabelFor('jira', issue('SUPPORT-123'), SERVICE_DESK)).toBe(
      'acme-dev.atlassian.net / SUPPORT-123'
    );
  });

  test('resolved by HOST too, so either cloudId spelling names the same place', () => {
    const facts = { sites: { [DEV]: { host: 'acme-dev.atlassian.net', projects: {} } } };
    for (const spelling of [DEV, 'acme-dev.atlassian.net', 'https://acme-dev.atlassian.net/']) {
      expect(destinationLabelFor('jira', { cloudId: spelling, issueIdOrKey: 'KAN-1' }, facts)).toBe(
        'acme-dev.atlassian.net / KAN-1'
      );
    }
  });

  test('a site with no issue reference is still worth naming', () => {
    expect(destinationLabelFor('jira', { cloudId: DEV }, SERVICE_DESK)).toBe(
      'acme-dev.atlassian.net'
    );
    // A numeric id is not a key, but it is what the payload says.
    expect(destinationLabelFor('jira', { cloudId: DEV, issueIdOrKey: '25664' }, SERVICE_DESK)).toBe(
      'acme-dev.atlassian.net / 25664'
    );
  });

  test('and it NEVER guesses: an unconfigured site composes nothing at all', () => {
    // An opaque destination makes a reviewer look; a confident wrong one makes them approve.
    expect(destinationLabelFor('jira', issue('SUPPORT-1', 'unknown-cloud'), SERVICE_DESK)).toBeUndefined();
    expect(destinationLabelFor('jira', issue('SUPPORT-1'), {})).toBeUndefined();
    // Configured with no host (a hand-written file): nothing to name it with.
    const noHost = { sites: { [DEV]: { projects: { SUPPORT: 'service_desk' as const } } } };
    expect(destinationLabelFor('jira', issue('SUPPORT-1'), noHost)).toBeUndefined();
  });

  test('Slack and Linear say nothing, because nothing local can resolve their ids', () => {
    // Resolving `channel_id: C0789KLMN` needs a network call draftgate does not make.
    expect(destinationLabelFor('slack', { channel_id: 'C0789KLMN' }, {})).toBeUndefined();
    expect(destinationLabelFor('linear', { issueId: 'HELP-42' }, {})).toBeUndefined();
  });
});

describe('jiraSiteKeysFor -- one rule for three callers', () => {
  test('a HOST is normalised on both sides, exactly like the key', () => {
    /*
     * With `host` normalised only by `trim().toLowerCase()`, a host declared as
     * `https://acme.atlassian.net` matches no payload spelling: a configured service desk reports
     * `unknown`, and the reviewer's answer lands in a second, shadowed row.
     */
    for (const host of [
      'https://acme.atlassian.net',
      'acme.atlassian.net/',
      'ACME.atlassian.net',
      '  acme.atlassian.net  ',
    ]) {
      const sites = { 'uuid-1': { host, projects: { SUP: 'service_desk' as const } } };
      expect(jiraSiteFor('acme.atlassian.net', sites)?.projects.SUP).toBe('service_desk');
      expect(jiraSiteFor('https://acme.atlassian.net/', sites)?.projects.SUP).toBe('service_desk');
    }
  });

  test('several spellings, and EVERY row that names one of them', () => {
    // For `withJiraSite`, which knows both cloud id and host and merges duplicate rows. Insertion
    // order is kept.
    const sites = {
      'acme.atlassian.net': { projects: {} },
      'uuid-1': { host: 'acme.atlassian.net', projects: {} },
      other: { host: 'elsewhere.atlassian.net', projects: {} },
    };
    expect(jiraSiteKeysFor(['uuid-1', 'acme.atlassian.net'], sites)).toEqual([
      'acme.atlassian.net',
      'uuid-1',
    ]);
    expect(jiraSiteKeysFor(['uuid-1'], sites)).toEqual(['uuid-1']);
  });

  test('a spelling that names nothing, and a host that is not a string', () => {
    const sites = { 'uuid-1': { host: 42, projects: {} }, 'uuid-2': { projects: {} } };
    expect(jiraSiteKeysFor(['  ', undefined, 7], sites)).toEqual([]);
    expect(jiraSiteKeysFor(['acme.atlassian.net'], sites)).toEqual([]);
    expect(jiraSiteKeysFor(['uuid-1'], undefined)).toEqual([]);
  });
});

describe('jiraSiteKey', () => {
  test('a UUID is unchanged, so files the generator wrote still match', () => {
    expect(jiraSiteKey(DEV)).toBe(DEV);
  });

  test('a site URL reduces to its host, in either spelling', () => {
    for (const spelling of [
      'https://acme.atlassian.net',
      'https://acme.atlassian.net/',
      'https://acme.atlassian.net//',
      'http://acme.atlassian.net',
      'ACME.atlassian.net',
      '  acme.atlassian.net  ',
      // The scheme match is case-insensitive because the lowercase comes last; without the flag
      // this keeps its scheme and becomes a duplicate site row via `withJiraProject`.
      'Https://acme.atlassian.net',
      'HTTPS://ACME.atlassian.net/',
    ]) {
      expect(jiraSiteKey(spelling)).toBe('acme.atlassian.net');
    }
  });

  test('and it is the SAME reduction the lookup uses', () => {
    // Written raw, a URL-spelled site is stored where `jiraSiteFor` never looks.
    const sites = { [jiraSiteKey('https://acme.atlassian.net/')]: { projects: { SUP: 'service_desk' as const } } };
    expect(jiraSiteFor('https://acme.atlassian.net', sites)?.projects.SUP).toBe('service_desk');
    expect(jiraSiteFor('acme.atlassian.net', sites)?.projects.SUP).toBe('service_desk');
  });

  test('is linear on a slash run that is not at the end, reached through `jiraSiteFor`', () => {
    // `/\/+$/` takes 1.1 s on this shape at 50k, 4x per doubling, on the agent's `cloudId`.
    const cloudId = 'a' + '/'.repeat(200 * 1024) + 'b/';
    const sites = { [DEV]: { projects: {} } };
    const started = performance.now();
    expect(jiraSiteFor(cloudId, sites)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(jiraSiteKey(cloudId)).toBe(cloudId.slice(0, -1));
  });
});

/**
 * The internal-note tool, named in core rather than declared in config (why:
 * `adapters/hook/test/toolAudience.test.ts`). The claim sits beside its probe (B: the
 * `sd.public.comment` property returns `jsdPublic: false`).
 */
describe('a tool that posts an internal note', () => {
  const INTERNAL_TOOL = 'mcp__jsm__jira_add_internal_note';

  test('is reported as internal, and says the reporter never sees it', () => {
    const a = jiraAudience(issue('SUPPORT-123'), { toolName: INTERNAL_TOOL });
    expect(a?.kind).toBe('internal');
    expect(a?.label).toBe('Internal note');
    expect(a?.detail).toContain('never sees');
  });

  test('and names the audience it cannot reach, symmetrically with the public case', () => {
    // Mirrors the struck-through line on a public banner.
    expect(jiraAudience(issue('SUPPORT-123'), { toolName: INTERNAL_TOOL })?.unavailable).toBe(
      'Reply to customer'
    );
  });

  test('the match is on the TOOL half, so a CONFIGURED route under any server name counts', () => {
    // A configured `tools.json` entry maps that exact name, under whatever `.mcp.json` key.
    for (const tool of ['jira_add_internal_note', 'mcp__anything__jira_add_internal_note']) {
      expect(jiraAudience(issue('SUPPORT-123'), { toolName: tool })?.kind).toBe('internal');
    }
  });

  /*
   * An inferred route is one no map entry names: its tool half matches an entry under another server,
   * so a third party chose the name. The internal claim rests on the operator naming their own tool,
   * so an inferred route gets `unknown`, naming the tool.
   */
  const STRANGER = 'mcp__some_vendor_jira__jira_add_internal_note';
  const inferred = (facts: Parameters<typeof jiraAudience>[1] = {}) =>
    jiraAudience(issue('SUPPORT-123'), { ...facts, toolName: STRANGER, routeInferred: true });

  test('an INFERRED route with this tool half is `unknown` on a service desk, naming the tool', () => {
    const a = inferred(sites({ SUPPORT: 'service_desk' }));
    expect(a?.kind).toBe('unknown');
    expect(a?.detail).toContain(STRANGER);
    expect(a?.detail).not.toContain('never sees');
    // The project is known; the open question is the tool.
    expect(a?.ask).toBeUndefined();
  });

  test('and on an UNCLASSIFIED project it is the unprobed-tool banner, like any tool nobody measured', () => {
    const a = inferred();
    expect(a?.kind).toBe('unknown');
    expect(a?.detail).toContain(STRANGER);
    // No question, as for every unprobed tool.
    expect(a?.ask).toBeUndefined();
    // And an answer of "service desk" says nothing about the tool either.
    expect(inferred({ classified: { destination: 'jira', value: 'service_desk' } })?.kind).toBe(
      'unknown'
    );
  });

  test('and in a SOFTWARE project it is silent, like every other tool there', () => {
    // No customer exists to see anything, whatever the tool does.
    expect(inferred(sites({ SUPPORT: 'software' }))).toBeUndefined();
    expect(inferred({ classified: { destination: 'jira', value: 'software' } })).toBeUndefined();
  });

  test('and through the DISPATCHER, which is what the CLI and the window call', () => {
    const at = (facts: { routeInferred?: boolean }) =>
      audienceFor('jira', issue('SUPPORT-123'), { toolName: STRANGER, ...facts })?.kind;
    expect(at({ routeInferred: true })).toBe('unknown');
    expect(at({})).toBe('internal');
  });

  test('and it is ANCHORED -- a near-miss name gets no evidence', () => {
    const a = jiraAudience(issue('SUPPORT-123'), {
      toolName: 'mcp__jsm__jira_add_internal_note_draft',
    });
    expect(a?.kind).toBe('unknown');
  });

  test('it does not depend on the project, because the tool sets the flag unconditionally', () => {
    // Checked before the project type: after it, a software project would get no banner.
    for (const type of ['software', 'service_desk', 'business'] as const) {
      const a = jiraAudience(issue('SUPPORT-123'), {
        toolName: INTERNAL_TOOL,
        sites: { [DEV]: { projects: { SUPPORT: type } } },
      });
      expect(a?.kind, `project type ${type}`).toBe('internal');
    }
  });

  test('and it asks nothing -- there is nothing missing to classify', () => {
    expect(jiraAudience(issue('SUPPORT-123'), { toolName: INTERNAL_TOOL })?.ask).toBeUndefined();
  });

  test('a worklog still wins, because that claim is about a different endpoint', () => {
    expect(
      jiraAudience(issue('SUPPORT-123'), { toolName: WORKLOG_TOOL })
    ).toBeUndefined();
  });
});

/**
 * An answer belongs to one destination, enforced by `audienceFor`. The trap: a GitHub value falls
 * through `jiraAudience`'s `!== 'service_desk'` test and suppresses the banner on what may be a
 * service desk. Driven through the dispatcher with shapes a wire can produce, since a type is no
 * runtime guarantee.
 */
describe('an answer that names its destination', () => {
  const JIRA_CTX = { cloudId: 'c', issueIdOrKey: 'SUPPORT-1' };
  const GH_CTX = { owner: 'o', repo: 'r' };
  const JIRA_TOOL = { toolName: 'mcp__x__addCommentToJiraIssue' };
  const GH_TOOL = { toolName: 'mcp__x__add_issue_comment' };

  test('is APPLIED when it is about the destination under review', () => {
    // Positive control: a dispatcher that drops every answer passes the refusals below.
    const jira = audienceFor('jira', JIRA_CTX, {
      ...JIRA_TOOL,
      classified: { destination: 'jira', value: 'service_desk' },
    });
    expect(jira?.kind).toBe('public');

    const github = audienceFor('github', GH_CTX, {
      ...GH_TOOL,
      classified: { destination: 'github', value: 'public' },
    });
    expect(github?.kind).toBe('public');
  });

  test('and DROPPED when it is about another destination -- THE COLLISION, simulated', () => {
    /*
     * The value is one this profile accepts, so only the destination can refuse it. (A value from the
     * other vocabulary would be refused by the vocabulary check and prove nothing.)
     *
     * Mutation-checked: delete `answer.destination === destination` from `withOwnAnswer` and this
     * test fails while every other one in the repo stays green.
     */
    const jira = audienceFor('jira', JIRA_CTX, {
      ...JIRA_TOOL,
      classified: { destination: 'github', value: 'service_desk' },
    });
    expect(jira?.kind).toBe('unknown');
    expect(jira?.ask).toBeDefined();

    const github = audienceFor('github', GH_CTX, {
      ...GH_TOOL,
      classified: { destination: 'jira', value: 'public' },
    });
    expect(github?.kind).toBe('unknown');
  });

  test('a value spelled for the RIGHT destination but in no vocabulary is dropped too', () => {
    // The destination check alone lets this through; it is what a renderer whose options drifted
    // from its profile produces.
    const drifted = audienceFor('jira', JIRA_CTX, {
      ...JIRA_TOOL,
      classified: { destination: 'jira', value: 'public' },
    });
    expect(drifted?.kind).toBe('unknown');

    const nonsense = audienceFor('jira', JIRA_CTX, {
      ...JIRA_TOOL,
      classified: { destination: 'jira', value: '' },
    });
    expect(nonsense?.kind).toBe('unknown');
  });
});

/**
 * `DestinationProfile.reviewerAnswers`, the vocabulary `ownAnswerFor` checks, equals what each
 * profile's `ask` offers, in both directions. This test is the only thing holding the two together.
 */
describe('every destination offers exactly what it will accept', () => {
  test('Jira: the binary its question puts, and not its CONFIG vocabulary', () => {
    const ask = jiraAudience(issue('SUPPORT-123'), NO_CONFIG)?.ask;
    expect(ask?.options.map((o) => o.value).sort()).toEqual(
      [...profiles.jira.reviewerAnswers].sort()
    );
    /*
     * And not Atlassian's four (`JIRA_PROJECT_TYPES`, the config vocabulary): that would let
     * `parseWireDecision` accept `business` and `product_discovery`. A strict subset.
     */
    expect(profiles.jira.reviewerAnswers.length).toBeLessThan(JIRA_PROJECT_TYPES.length);
    for (const value of profiles.jira.reviewerAnswers) {
      expect(JIRA_PROJECT_TYPES as readonly string[]).toContain(value);
    }
  });

  test('GitHub: all three, which for this destination is also its config vocabulary', () => {
    const ask = githubAudience({ owner: 'o', repo: 'r' })?.ask;
    expect(ask?.options.map((o) => o.value).sort()).toEqual(
      [...profiles.github.reviewerAnswers].sort()
    );
    expect([...profiles.github.reviewerAnswers].sort()).toEqual(
      [...GITHUB_REPO_VISIBILITIES].sort()
    );
  });

  test('and the two with no question to ask declare an EMPTY list, not nothing', () => {
    // Declared empty rather than left out, like `deltaFields` (see "which profiles have an audience
    // at all").
    expect(profiles.slack.reviewerAnswers).toEqual([]);
    expect(profiles.linear.reviewerAnswers).toEqual([]);
  });
});
