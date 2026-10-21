/**
 * Review orchestration.
 *
 * The surface is stubbed, so this exercises the whole gate -- payload in, decision, payload out --
 * with no host and no window.
 */

import { describe, expect, test } from 'bun:test';
import {
  runReview, BLOCKED_AFTER_APPROVAL, DEFAULT_TIMEOUT_MS, TIMEOUT_BACKSTOP_MS,
} from '../src/review';
import { PLUGIN_HOOK_TIMEOUT_S } from '../../adapters/hook/src/main';
import { reviewDeadline } from '../../adapters/hook/src/reviewTimeout';
import {
  extractBody, extractContext, buildUpdatedInput, bodyFieldFor, parseBodyPath, BodyPathError,
  wireBody, MissingBodyFieldError,
} from '../src/payload';
import { profiles, render, renderPlain, type DestinationName } from '../../core/src/index';
import { SURFACE_STALE } from '../src/types';
import { REMEDY } from '../../core/src/remedies';
import type { Decision, ReviewRequest, ReviewSurface } from '../src/types';
import { ROUTE_FLAGS } from '../src/routeFacts';
import { autoApprove } from '../src/surfaces/autoApprove';
import { MAX_PROSE_LENGTH } from '../src/surfaces/windowProtocol';

/**
 * An approval that sends `body` for a destination's own body field. The decision is keyed by path,
 * so a test names which field it approves; a field the review never showed is dropped.
 */
const approves = (
  destination: DestinationName,
  body: string,
  extra: Omit<Extract<Decision, { action: 'approve' }>, 'action' | 'fields'> = {}
) => ({
  action: 'approve' as const,
  // `bodyFieldFor`, not `profiles[...].bodyField`: the repo's one answer to "which field is the body".
  fields: { [bodyFieldFor(destination)]: body },
  ...extra,
});

/** What every surface reports on an approval: the value of every field it was shown. */
const reportsShown = (r: ReviewRequest): Record<string, string> =>
  Object.fromEntries(r.fields.map((f) => [f.field, f.value]));

/**
 * The honest no-op approval: every field reported as shown, and no edit. An approval with no
 * `fields` is a stale renderer and is denied, so this is not an approval that says nothing.
 */
const approvesUnchanged = (r: ReviewRequest) =>
  ({ action: 'approve' as const, fields: reportsShown(r) });

/**
 * A surface that answers however the test says, and records what it was shown.
 *
 * An approval that reports nothing is denied whoever sent it, so the decision the test writes is
 * the whole input.
 */
function stub(decision: Decision | ((r: ReviewRequest) => Decision | Promise<Decision>)) {
  const seen: ReviewRequest[] = [];
  const surface: ReviewSurface = {
    human: true,
    async review(request) {
      seen.push(request);
      return typeof decision === 'function' ? decision(request) : decision;
    },
  };
  return { surface, seen };
}

/** A realistic Jira payload, field names taken from the live tool schema. */
const JIRA_INPUT = {
  cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  issueIdOrKey: 'SUPPORT-123',
  commentBody: 'Hello **world**.',
};

const SLACK_INPUT = {
  channel_id: 'C123',
  thread_ts: '1788287522.311099',
  message: 'Hello **world**.',
  unfurl_app_links: true,
};

describe('payload field handling', () => {
  test('reads the body from the field the profile names, not a guess', () => {
    // Not `body` for Jira or `text` for Slack, the obvious guesses: both are wrong.
    expect(extractBody('jira', JIRA_INPUT)).toBe('Hello **world**.');
    expect(extractBody('slack', SLACK_INPUT)).toBe('Hello **world**.');
    expect(extractBody('linear', { issueId: 'HELP-42', body: 'hi' })).toBe('hi');
  });

  /**
   * Three ways a body can be unreadable, and they mean different things.
   *
   * Only the first is the schema-drift case, and only that one may fail open in the hook. One
   * error for all three would let `commentBody: 123` and a misrouted tool both become unreviewed
   * sends: see `missingBodyDenial` in `cli/src/review.ts`.
   */
  const failureOf = (input: Record<string, unknown>) => {
    try {
      extractBody('jira', input);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingBodyFieldError);
      return e as MissingBodyFieldError;
    }
  };

  test('DRIFT: the field is gone and another one holds prose', () => {
    const e = failureOf({ cloudId: 'x', body: 'wrong field name, right message' });
    expect(e.failure).toBe('drift');
    expect(e.namedField).toBe('body');
    expect(e.message).toContain('commentBody');
    expect(e.message).toContain('cloudId, body');
    // No `doctor`: this string reaches the agent, and drift is fixed in the destination profile,
    // which `draftgate doctor` (hooks and registration) does not check.
    expect(e.message).not.toContain('doctor');
  });

  test('WRONG TYPE: the field is right there and is not a string', () => {
    for (const value of [123, { type: 'doc' }, null, ['hello'], true]) {
      const e = failureOf({ cloudId: 'c', issueIdOrKey: 'K-1', commentBody: value });
      expect(e.failure).toBe('wrong-type');
      // And the message does not contradict itself by claiming the field is missing while listing
      // it among the present keys.
      expect(e.message).toContain('is not a string');
      expect(e.message).not.toContain('has no "commentBody"');
    }
  });

  test('UNRECOGNISED: nothing in the payload looks like a message', () => {
    // The shape a misrouted tool produces: a Slack payload read by the Jira profile. Identifiers
    // only, so there is nothing that could plausibly be the prose.
    const e = failureOf({ channel_id: 'C1', thread_ts: '1788287522.311099' });
    expect(e.failure).toBe('unrecognised');
    expect(e.message).toContain('check the tool map');
  });

  test('PREFORMATTED: the body is a string, and the payload says it is not markdown', () => {
    // Reviewed as markdown, the reviewer sees raw JSON, and approving it puts that JSON into a text
    // node inside a new ADF document: a successful send of visible garbage.
    const adf = JSON.stringify({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Deploy finished' }] }],
    });
    const e = failureOf({
      cloudId: 'c',
      issueIdOrKey: 'SUPPORT-123',
      contentFormat: 'adf',
      commentBody: adf,
    });
    expect(e.failure).toBe('preformatted');
    expect(e.namedField).toBe('contentFormat');
    expect(e.message).toContain('already in jira');
    // Not a missing field and not a misroute: each of those sends the reader to a different file.
    expect(e.message).not.toContain('has no "commentBody"');
    expect(e.message).not.toContain('check the tool map');
  });

  test('the preformatted check reads the profile, not a second copy of the field name', () => {
    // The declaration is `extraToolInput`, the field draftgate sets to mean "this body is ADF".
    // Asserts the derivation, not a second hand-kept literal that could drift into Jira 400s.
    expect(profiles.jira.extraToolInput).toEqual({ contentFormat: 'adf' });
    for (const [field, value] of Object.entries(profiles.jira.extraToolInput)) {
      expect(failureOf({ [field]: value, commentBody: 'hello there' }).failure).toBe('preformatted');
    }
  });

  test("the connector's OTHER contentFormat values are markdown and are reviewed", () => {
    // `contentFormat: "markdown"` is legal and the default. Only the profile's own value means
    // "already converted"; refusing on the field's presence would prompt on every markdown comment.
    for (const value of ['markdown', 'wiki', undefined]) {
      const input: Record<string, unknown> = {
        cloudId: 'c',
        issueIdOrKey: 'SUPPORT-123',
        commentBody: 'Deploy finished, see the thread',
      };
      if (value !== undefined) input.contentFormat = value;
      expect(extractBody('jira', input)).toBe('Deploy finished, see the thread');
    }
  });

  test('an identifier is not prose, which is what keeps the drift case narrow', () => {
    // Whitespace is the discriminator. A UUID, a Jira key and a channel id must not read as a
    // message, or every misroute would look like schema drift and fail open.
    for (const value of ['0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'SUPPORT-123', 'C1', 'done']) {
      expect(failureOf({ someKey: value }).failure).toBe('unrecognised');
    }
    // ...and two words are.
    expect(failureOf({ someKey: 'two words' }).failure).toBe('drift');
  });

  test('context picks up routing fields and skips absent ones', () => {
    expect(extractContext('jira', JIRA_INPUT)).toEqual({
      cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      issueIdOrKey: 'SUPPORT-123',
    });
    expect(extractContext('slack', SLACK_INPUT)).toEqual({
      channel_id: 'C123',
      thread_ts: '1788287522.311099',
    });
  });

  test('a CREATE payload keeps the field its own audience rule reads', () => {
    /*
     * `jiraAudience` reads `projectKey`, the only place a create names its project, so the profile
     * must list it (the invariant is in `cli/src/payload.ts`). Asserted through the extraction with
     * no route override: were the key missing, a short-form route (`"...createJiraIssue": "jira"`)
     * would lose the classification and its `ask`. Every other create test hands `jiraAudience` a
     * context literal and cannot see this.
     */
    const context = extractContext('jira', {
      cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      projectKey: 'NEWSD',
      issueTypeName: 'Service Request',
      description: 'body',
    });
    expect(context.projectKey).toBe('NEWSD');

    const audience = profiles.jira.audienceFor(context, {
      toolName: 'mcp__claude_ai_Atlassian_Rovo__createJiraIssue',
    });
    // Unclassified, so the answer is the question, reachable only because the key survived.
    expect(audience?.ask?.question).toBe('Is NEWSD a service desk?');
  });
});

describe('what the surface is shown', () => {
  test('it gets the render, the warnings, the editor doc and read-only routing', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });

    const r = seen[0]!;
    // destination, mode and canonical all live on `render` -- the request carries no copies.
    expect(r.render.destination).toBe('jira');
    expect(r.render.mode).toBe('convert-and-replace');
    expect(r.render.canonical).toBe('Hello **world**.');
    expect(r.context.issueIdOrKey).toBe('SUPPORT-123');
    expect(r.render.warnings).toBeDefined();
    expect(r.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('the default timeout is twenty minutes, and the registration still has to outlive it', () => {
    // Claude Code's per-hook timeout is fail-open (`hookTimeoutSecondsFor`), so the plugin's
    // registered `timeout` must outlive any review it starts.
    expect(DEFAULT_TIMEOUT_MS).toBe(1_200_000);
    expect(
      PLUGIN_HOOK_TIMEOUT_S,
      'the timeout frozen in the shipped hooks.json: the ceiling plus the grace'
    ).toBe(3660);
    // The default review fits under the plugin's ceiling (registered less grace), not just under the
    // registered number.
    expect(reviewDeadline(DEFAULT_TIMEOUT_MS, PLUGIN_HOOK_TIMEOUT_S * 1000).basis.kind).toBe('asked');
  });

  /*
   * `request.fields` is what the window displays and `request.render` is what the CLI judged. Both
   * come from one `canonical`; a refactor that fed the window a re-serialisation would keep every
   * other test here green while showing a body other than the one `blocked` is about.
   */
  test('the block field the window will show IS the body the render describes', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });

    const r = seen[0]!;
    const block = r.fields.filter((f) => f.kind !== 'line');
    expect(block).toEqual([
      { field: 'commentBody', kind: 'markdown', value: r.render.canonical },
    ]);
  });

  test('a plain route marks its block field TEXT, and that is the whole signal', async () => {
    // The kind rides the field, not a separate flag beside the body, so a consumer that reads the
    // field cannot miss it.
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({
      destination: 'linear', toolInput: { id: 'REL-1', body: '**not bold**' },
      bodyFormat: 'plain', surface,
    });
    expect(seen[0]!.fields).toEqual([
      { field: 'body', kind: 'text', value: '**not bold**' },
    ]);
    expect(seen[0]!.render.format).toBe('plain');
  });

  test('preview() and doc() are bound, so a surface never imports core', async () => {
    // Functions, not snapshots: an editing surface re-renders through preview(), and doc() is built
    // on demand.
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    const r = seen[0]!;
    expect(typeof r.preview).toBe('function');
    expect(typeof r.doc).toBe('function');
    // preview() reflects the body it is given, not the original.
    expect(r.preview('> ## quoted heading\n').blocked).toBe(true);
    expect(r.preview('plain text').blocked).toBe(false);
    expect(r.doc('# H').type).toBe('doc');
  });
});

describe('approval', () => {
  /*
   * A surface that reports the body unchanged sends `canonical` byte for byte: nothing on this path
   * may re-serialise a bare URL into `[url](url)`.
   */
  test('a surface that reports the body unchanged gets `canonical`, byte for byte', async () => {
    const body = 'See https://example.com for details.';
    const { surface } = stub(approvesUnchanged);
    const out = await runReview({
      destination: 'linear',
      toolInput: { issueId: 'HELP-42', body },
      surface,
    });
    expect(out.exitCode).toBe(0);
    expect(out.edited).toBe(false);
    expect(out.updatedInput!.body).toBe(body);
    expect(out.updatedInput!.body).not.toContain('[https://example.com]');
    // Nothing was sent that differs from the original, so the log stores one body, not two.
    expect(out.audit.after).toBeUndefined();
  });

  /*
   * The body the reviewer read is what goes out, edited or not. An unedited approval does not fall
   * back to `canonical`: the window's round trip is what the reviewer was shown.
   */
  test('an approval that carries a body sends THAT body, even when nobody edited', async () => {
    // Exactly the window's shape: the round trip, plus `edited: false` saying no human touched it.
    // Sending `canonical` here would put the bare URL out unrepaired, unlike what the reviewer saw.
    const shown = 'See [https://example.com](https://example.com) for details.';
    const { surface } = stub(approves('linear', shown, { edited: false, silenced: [] }));
    const out = await runReview({
      destination: 'linear',
      toolInput: { issueId: 'HELP-42', body: 'See https://example.com for details.' },
      surface,
    });
    expect(out.exitCode).toBe(0);
    expect(out.updatedInput!.body).toBe(shown);
  });

  test('and `edited` stays FALSE for it, because no human changed anything', async () => {
    // Not inferred as `body !== canonical`: the digest's edit rate and "rewritten" bucket read
    // `edited`, and a normalisation booked as a hand edit would skew both.
    const { surface } = stub(
      approves('linear', 'See [https://example.com](https://example.com) for details.', {
        edited: false,
        silenced: [],
      })
    );
    const out = await runReview({
      destination: 'linear',
      toolInput: { issueId: 'HELP-42', body: 'See https://example.com for details.' },
      surface,
    });
    expect(out.edited).toBe(false);
    expect(out.audit.edited).toBe(false);
    // But `after` is written: it differs from `before`, and `after ?? before` is what went out.
    expect(out.audit.after).toBe('See [https://example.com](https://example.com) for details.');
  });

  test('a surface reporting `edited: true` is believed even when the body matches canonical', async () => {
    // The other direction, and it has to work too: an edit can re-serialise to exactly the agent's
    // bytes, and the reviewer still edited. Only the surface knows.
    const same = 'Hello **world**.';
    const { surface } = stub(approves('linear', same, { edited: true, silenced: [] }));
    const out = await runReview({
      destination: 'linear',
      toolInput: { issueId: 'HELP-42', body: same },
      surface,
    });
    expect(out.edited).toBe(true);
    expect(out.audit.edited).toBe(true);
    // Nothing differs, so there is nothing to store as `after`.
    expect(out.audit.after).toBeUndefined();
  });

  test('the silenced codes reach the log, and absence is preserved as absence', async () => {
    // Three-state, the `fixes` discipline: a list is what draftgate silenced, `[]` is a reporting
    // surface saying it silenced nothing, and absent is a surface that cannot report. `?? []`
    // anywhere here would turn "we do not know" into "draftgate changed nothing".
    const input = { issueIdOrKey: 'SUPPORT-1', cloudId: 'c', commentBody: '- [ ] ![i](https://e.test/a.png)\n' };
    const reported = stub(
      approves('jira', '![i](https://e.test/a.png)', {
        edited: false,
        silenced: ['jira/task-item-media-only'],
      })
    );
    const withCodes = await runReview({ destination: 'jira', toolInput: input, surface: reported.surface });
    expect(withCodes.audit.silenced).toEqual(['jira/task-item-media-only']);

    const none = stub(approves('jira', '![i](https://e.test/a.png)', { edited: false, silenced: [] }));
    expect((await runReview({ destination: 'jira', toolInput: input, surface: none.surface })).audit.silenced)
      .toEqual([]);

    const silent = stub(approvesUnchanged);
    expect((await runReview({ destination: 'jira', toolInput: input, surface: silent.surface })).audit.silenced)
      .toBeUndefined();
  });

  test('edited: the edit is sent and `edited` is true', async () => {
    const { surface } = stub(approves('linear', 'Hello *edited* world.'));
    const out = await runReview({
      destination: 'linear',
      toolInput: { issueId: 'HELP-42', body: 'Hello **world**.' },
      surface,
    });
    expect(out.exitCode).toBe(0);
    expect(out.edited).toBe(true);
    expect(out.updatedInput!.body).toBe('Hello *edited* world.');
  });

  test('an approval echoing the same text is not treated as an edit', async () => {
    const { surface } = stub(approves('linear', 'Hello **world**.'));
    const out = await runReview({ destination: 'linear', toolInput: { issueId: 'X', body: 'Hello **world**.' }, surface });
    expect(out.edited).toBe(false);
  });
});

describe('updatedInput is COMPLETE, never a patch', () => {
  // `updatedInput` is reported to replace tool input wholesale rather than shallow-merge. A partial
  // object would drop cloudId / issueIdOrKey / channel_id and the send would fail.
  test('every original field survives, for Jira', async () => {
    const { surface } = stub(approvesUnchanged);
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(out.updatedInput!.cloudId).toBe(JIRA_INPUT.cloudId);
    expect(out.updatedInput!.issueIdOrKey).toBe('SUPPORT-123');
  });

  test('every original field survives, including ones draftgate knows nothing about', async () => {
    const { surface } = stub(approvesUnchanged);
    const out = await runReview({ destination: 'slack', toolInput: SLACK_INPUT, surface });
    expect(out.updatedInput!.channel_id).toBe('C123');
    expect(out.updatedInput!.thread_ts).toBe('1788287522.311099');
    // Not a field draftgate models, and it must still be preserved.
    expect(out.updatedInput!.unfurl_app_links).toBe(true);
  });

  test('Slack gets a block the reviewer put back inside a list item moved out', async () => {
    // Loading moves it, but the editor can hold one there again, and Slack flattens it: the body
    // sent must be the moved-out one. An unedited body is already moved at load.
    const inside = '1. Run:\n   ```sh\n   npm i\n   ```\n2. Then\n';
    const { surface } = stub(approves('slack', inside, { edited: true }));
    const out = await runReview({ destination: 'slack', toolInput: SLACK_INPUT, surface });
    expect(out.updatedInput!.message).toBe('1. Run:\n\n```sh\nnpm i\n```\n\n2. Then\n');
    // And a body with nothing to move goes out byte for byte.
    const { surface: plain } = stub(approves('slack', 'see https://e.test now\n', { edited: true }));
    expect((await runReview({ destination: 'slack', toolInput: SLACK_INPUT, surface: plain })).updatedInput!.message)
      .toBe('see https://e.test now\n');
  });

  test('Jira gets contentFormat: adf, and the body is an ADF JSON string', async () => {
    // Verified live: commentBody is typed string; passing ADF as a JSON string alongside
    // contentFormat: "adf" returns 201. Omitting contentFormat makes Jira print the JSON verbatim.
    const { surface } = stub(approvesUnchanged);
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(out.updatedInput!.contentFormat).toBe('adf');
    const body = out.updatedInput!.commentBody as string;
    expect(typeof body).toBe('string');
    const adf = JSON.parse(body);
    expect(adf.type).toBe('doc');
    expect(adf.version).toBe(1);
    expect(JSON.stringify(adf)).toContain('"strong"');
  });

  test('preview-only destinations add no extra fields and keep markdown', async () => {
    for (const [destination, input, field] of [
      ['slack', SLACK_INPUT, 'message'],
      ['linear', { issueId: 'HELP-42', body: 'Hello **world**.' }, 'body'],
    ] as const) {
      const { surface } = stub(approvesUnchanged);
      const out = await runReview({ destination, toolInput: input, surface });
      expect(out.updatedInput!.contentFormat).toBeUndefined();
      expect(out.updatedInput![field]).toBe('Hello **world**.');
    }
  });
});

describe('rejection and timeout carry actionable guidance', () => {
  test('rejection: exit 1, reason preserved, explicit do-not-resend', async () => {
    const { surface } = stub({ action: 'reject', reason: 'Wrong channel, this is customer-facing.' });
    const out = await runReview({ destination: 'slack', toolInput: SLACK_INPUT, surface });
    expect(out.exitCode).toBe(1);
    expect(out.updatedInput).toBeUndefined();
    expect(out.denial!.outcome).toBe('rejected');
    expect(out.denial!.reason).toContain('Wrong channel');
    expect(out.denial!.guidance).toContain('Do not resend');
  });

  test('rejection with no reason still tells the agent what to do', async () => {
    const { surface } = stub({ action: 'reject' });
    const out = await runReview({ destination: 'slack', toolInput: SLACK_INPUT, surface });
    expect(out.denial!.reason).toContain('without giving a reason');
    expect(out.denial!.guidance).toContain('ask the user');
  });

  test('timeout: exit 2, and the guidance is NOT to retry', async () => {
    // A surface that never answers.
    const surface: ReviewSurface = { human: true, review: () => new Promise<Decision>(() => {}) };
    const out = await runReview({
      destination: 'slack', toolInput: SLACK_INPUT, surface, timeoutMs: 30,
    });
    expect(out.exitCode).toBe(2);
    expect(out.denial!.outcome).toBe('timeout');
    expect(out.denial!.guidance).toContain('Do not resend');
    expect(out.denial!.reason).toContain('denied');
  });

  test('a slow-but-answering surface is not timed out', async () => {
    const { surface } = stub(
      (request) => new Promise<Decision>((r) => setTimeout(() => r(approvesUnchanged(request)), 5))
    );
    const out = await runReview({
      destination: 'slack', toolInput: SLACK_INPUT, surface, timeoutMs: 500,
    });
    expect(out.exitCode).toBe(0);
  });
});

describe('an edit that the destination would reject is refused', () => {
  test('a blockquoted heading edited into a Jira draft blocks the send', async () => {
    // Verified live: Jira returns 400 INVALID_INPUT and loses the WHOLE comment. The surface should
    // stop this, but the orchestration refuses to emit a payload it knows will fail.
    const { surface } = stub(approves('jira', '> ## Heading in a quote\n'));
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(out.exitCode).toBe(1);
    expect(out.updatedInput).toBeUndefined();
    expect(out.denial!.reason).toContain('jira/blockquote-child-rejected');
    expect(out.denial!.guidance).toContain('nothing was posted');
  });

  test('the same edit is fine on Slack and Linear', async () => {
    for (const [destination, input] of [
      ['slack', SLACK_INPUT],
      ['linear', { issueId: 'HELP-42', body: 'x' }],
    ] as const) {
      const { surface } = stub(approves(destination, '> ## Heading in a quote\n'));
      const out = await runReview({ destination, toolInput: input, surface });
      expect(out.exitCode).toBe(0);
    }
  });

  test('an UNEDITED draft that is already blocked is also refused', async () => {
    const { surface } = stub(approvesUnchanged);
    const out = await runReview({
      destination: 'jira',
      toolInput: { ...JIRA_INPUT, commentBody: '> ## Heading in a quote\n' },
      surface,
    });
    expect(out.exitCode).toBe(1);
  });
});

describe('an emptied draft cannot be sent, whatever the destination', () => {
  // Jira's probe-backed `jira/empty-body` error blocks this in the surface; this backstop covers
  // every destination and surface, including those whose empty-body behaviour is unprobed.
  for (const [destination, input] of [
    ['jira', JIRA_INPUT],
    ['slack', SLACK_INPUT],
    ['linear', { issueId: 'HELP-42', body: 'original text' }],
  ] as const) {
    test(`${destination}: an edit to empty is denied and emits nothing`, async () => {
      const { surface } = stub(approves(destination, '   \n  '));
      const out = await runReview({ destination, toolInput: input, surface });
      expect(out.exitCode).toBe(1);
      expect(out.updatedInput).toBeUndefined();
      expect(out.denial!.reason).toContain('empty');
      // Guidance must not send the agent off to rewrite: deleting everything is a rejection.
      expect(out.denial!.guidance).toContain('Ask the user');
    });
  }

  test('an agent that sends an empty body in the first place is denied too', async () => {
    const { surface } = stub(approvesUnchanged);
    const out = await runReview({
      destination: 'jira',
      toolInput: { ...JIRA_INPUT, commentBody: '' },
      surface,
    });
    expect(out.exitCode).toBe(1);
    expect(out.updatedInput).toBeUndefined();
  });
});

describe('a broken surface is not a human rejection', () => {
  // Told to "revise and try once", an agent whose review window cannot open rewrites a perfectly
  // good message and hits the identical wall. The outcome has to say which kind of denial it is.
  test('unavailable carries its own outcome and do-not-rewrite guidance', async () => {
    const { surface } = stub({ action: 'unavailable', reason: 'The review window host is missing.' });
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });

    expect(out.exitCode).toBe(1);
    expect(out.denial!.outcome).toBe('unavailable');
    expect(out.denial!.reason).toContain('review window host');
    expect(out.denial!.guidance).toContain('NOT with the message');
    expect(out.denial!.guidance).toContain('Do not rewrite');
    // The hook's fail-open requires this value and `code: 'body/missing-field'` together; either
    // way it must differ from a reviewer saying no.
    expect(out.denial!.outcome).not.toBe('rejected');
  });

  test('a window that never opened says so in the log, and an approval says nothing', async () => {
    // `unavailableDenial` and `staleSurfaceDenial` carry a code, so the window not starting is
    // distinguishable in the digest from a row with no cause. The adapter decides the same either way.
    const { surface } = stub({ action: 'unavailable', reason: 'The review window host is missing.' });
    const broken = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(broken.audit.code).toBe('surface/unavailable');

    // And absent on an approval: `?? ''` on this path would give every approved review a cause.
    const ok = await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      surface: stub(approvesUnchanged).surface,
    });
    expect(ok.audit.outcome).toBe('approved');
    expect(ok.audit.code).toBeUndefined();
  });

  test('a surface that says WHICH kind of unavailable is believed', async () => {
    /*
     * `surfaces/window.ts` reaches `unavailableDenial` from several failures, one of them a decision
     * `parseWireDecision` refuses: a stale build a human already clicked in. Its repair is
     * `bun run build:surface`, not `bun run build:host` or `bun install`, so it is not filed as
     * `surface/unavailable`.
     */
    const { surface } = stub({
      action: 'unavailable',
      reason: 'The review window wrote a decision this version of draftgate does not understand.',
      cause: SURFACE_STALE,
    });
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(out.audit.code).toBe('surface/stale');
  });

  test('a human rejection still tells the agent it MAY revise', async () => {
    const { surface } = stub({ action: 'reject', reason: 'wrong tone' });
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(out.denial!.outcome).toBe('rejected');
    expect(out.denial!.guidance).toContain('revise');
  });
});

describe('the audit record carries what the digest needs', () => {
  /** A Jira draft whose external image trips a real warning, so this is not a synthetic code. */
  const WARNING_INPUT = {
    ...JIRA_INPUT,
    commentBody: 'Look: ![shot](https://example.com/a.png)',
  };

  test('the warning codes the REVIEWER saw are recorded, on an approval', async () => {
    const { surface } = stub(approvesUnchanged);
    const o = await runReview({ destination: 'jira', toolInput: WARNING_INPUT, surface });
    expect(o.audit.warnings.length).toBeGreaterThan(0);
    // Codes, not messages: `core/src/warnings.ts` promises the code is the stable identity.
    expect(o.audit.warnings.every((c) => c.includes('/'))).toBe(true);
  });

  test('and on every denial, including one where the gate broke', async () => {
    // "This warning is always rejected" and "the window would not open" are both questions about
    // reviews that did not end in a send.
    for (const decision of [
      { action: 'reject', reason: 'no' },
      { action: 'timeout' },
      { action: 'unavailable', reason: 'the window would not start' },
    ] as Decision[]) {
      const { surface } = stub(decision);
      const o = await runReview({
        destination: 'jira', toolInput: WARNING_INPUT, surface, timeoutMs: 50,
      });
      expect(o.denial).toBeDefined();
      expect(o.audit.warnings.length).toBeGreaterThan(0);
    }
  });

  test('a clean draft records an empty list, which is not the same as no field', async () => {
    const { surface } = stub(approvesUnchanged);
    const o = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(o.audit.warnings).toEqual([]);
  });

  test('a payload with no readable body records no warnings, because none were shown', async () => {
    // Nothing was rendered, so a reviewer saw nothing.
    const { surface } = stub(approvesUnchanged);
    const o = await runReview({
      destination: 'jira', toolInput: { cloudId: 'x', body: 'wrong field' }, surface,
    });
    expect(o.denial?.code).toBe('body/missing-field');
    expect(o.audit.warnings).toEqual([]);
  });

  test('accepted repairs pass through exactly as the surface reported them', async () => {
    const fixes = [{ code: 'slack/url-swallows-next-line', label: 'Write an explicit link' }];
    const { surface } = stub(approves('jira', 'edited by hand', { fixes }));
    const o = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(o.audit.fixes).toEqual(fixes);
    expect(o.audit.edited).toBe(true);
  });

  test('an empty list survives as an empty list -- that is what makes an edit a REWRITE', async () => {
    const { surface } = stub(approves('jira', 'edited by hand', { fixes: [] }));
    const o = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(o.audit.fixes).toEqual([]);
  });

  test('a surface that cannot report leaves the field OFF, and it is not defaulted', async () => {
    // `auto-approve` never sends `fixes`. `?? []` here would claim it saw no repair accepted,
    // turning every one of its edits into evidence of a rewrite.
    const { surface } = stub(approves('jira', 'edited elsewhere'));
    const o = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect('fixes' in o.audit).toBe(false);
  });

  test('a denial records no repairs at all', async () => {
    const { surface } = stub({ action: 'reject', reason: 'no' });
    const o = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect('fixes' in o.audit).toBe(false);
  });
});

/**
 * The one row in the audit log that describes a message nobody read. `body/missing-field` is the
 * only outcome that lets a send through unreviewed (the schema-drift fail-open), so its row must
 * say what the message was. `extractBody` already found the prose to call it drift.
 */
describe('the fail-open row names the message that went out', () => {
  const driftOutcome = () =>
    runReview({
      destination: 'jira',
      toolInput: { cloudId: 'c1', issueIdOrKey: 'SUPPORT-1', comment: 'the message that went out' },
      toolName: 'addCommentToJiraIssue',
      surface: stub(approvesUnchanged).surface,
    });

  test('before is the prose the drift detector found', async () => {
    const out = await driftOutcome();
    expect(out.denial?.code).toBe('body/missing-field');
    expect(out.audit.before).toBe('the message that went out');
  });

  test('and the routing context is there too, so the row can be audited', async () => {
    const out = await driftOutcome();
    expect(out.audit.context).toEqual({ cloudId: 'c1', issueIdOrKey: 'SUPPORT-1' });
  });

  test('the two shapes that ASK have no message to name, and name none', async () => {
    // A wrong-typed body is not a message and an unrecognised payload has no prose; neither is sent.
    for (const toolInput of [
      { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 123 },
      { channel_id: 'C1', thread_ts: '1788287522.311099' },
    ]) {
      const out = await runReview({
        destination: 'jira',
        toolInput,
        surface: stub(approvesUnchanged).surface,
      });
      expect(out.audit.before).toBe('');
    }
  });
});

/**
 * A Jira call that arrives already converted, through the whole gate: no `updatedInput`, the
 * surface never opened, and the audit log records the document.
 */

describe('a body that is already in the destination format', () => {
  const ADF = JSON.stringify({
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Deploy finished' }] }],
  });

  /** The whole gate over a payload that is already ADF. `seen` records what the surface was shown. */
  const preformatted = () => {
    const { surface, seen } = stub({ action: 'approve' as const });
    return {
      seen,
      outcome: runReview({
        destination: 'jira',
        toolInput: {
          cloudId: 'c1',
          issueIdOrKey: 'SUPPORT-123',
          contentFormat: 'adf',
          commentBody: ADF,
        },
        toolName: 'addCommentToJiraIssue',
        surface,
      }),
    };
  };

  test('is never sent, and never re-wrapped in a second ADF document', async () => {
    const out = await preformatted().outcome;
    expect(out.exitCode).toBe(1);
    expect(out.updatedInput).toBeUndefined();
    expect(out.denial?.code).toBe('body/preformatted');
    expect(out.denial?.outcome).toBe('unavailable');
  });

  test('the reviewer is not shown a wall of JSON, because no surface is opened', async () => {
    const r = preformatted();
    await r.outcome;
    expect(r.seen).toHaveLength(0);
  });

  test('the audit row names the document, so the log can see what was not reviewed', async () => {
    const out = await preformatted().outcome;
    expect(out.audit.outcome).toBe('unavailable');
    expect(out.audit.before).toBe(ADF);
    expect(out.audit.context).toEqual({
      cloudId: 'c1',
      issueIdOrKey: 'SUPPORT-123',
    });
  });

  test('the guidance does not send the agent to fix a profile that is not broken', async () => {
    const out = await preformatted().outcome;
    expect(out.denial?.guidance).not.toContain('destination profile');
    expect(out.denial?.guidance).toContain('markdown');
  });
});

/**
 * A Linear call that carries a delta instead of a body, through the whole gate. A patch draftgate can
 * show is reviewed edit by edit, and what is sent is the same patch with the reviewer's text in it;
 * one it cannot show asks, by its own code (which the adapter branches on), naming what it could not
 * show.
 */
describe('a payload that carries a patch rather than a body', () => {
  // The live `save_issue` schema's operations, one of each.
  const PATCH = [
    { op: 'replace', old_string: 'Tuesday', new_string: 'Thursday' },
    { op: 'replace', old_string: 'TODO', new_string: '', replace_all: true },
    { op: 'insert_before', anchor: '## Risks', text: '## Owner\n\nAda\n\n' },
    { op: 'insert_after', anchor: 'Rollout plan', text: ' (draft)' },
    { op: 'prepend', text: '> Superseded by the next issue.\n\n' },
    { op: 'append', text: '\n\nSee the thread for the rollout plan.' },
    { op: 'replace_range', from: '## Old notes', to: '## Risks', new_string: '' },
  ];
  const INPUT = { id: 'HELP-42', title: 'Rollout', patch: PATCH };
  // Each operation's text, in order: what the reviewer is shown and may edit.
  const TEXTS = [
    'Thursday', '', '## Owner\n\nAda\n\n', ' (draft)', '> Superseded by the next issue.\n\n',
    '\n\nSee the thread for the rollout plan.', '',
  ];

  /** The whole gate over `save_issue`-shaped input. `seen` records what the surface was shown. */
  const patched = (
    toolInput: Record<string, unknown> = INPUT,
    decision: Decision | ((r: ReviewRequest) => Decision) = approvesUnchanged
  ) => {
    const { surface, seen } = stub(decision);
    return {
      seen,
      outcome: runReview({
        destination: 'linear',
        toolInput,
        toolName: 'mcp__claude_ai_Linear__save_issue',
        bodyField: 'description',
        proseFields: ['title'],
        surface,
      }),
    };
  };

  /** Approve, with these edits' text replaced, by path; every other shown field as shown. */
  const editing = (changes: Record<string, string>) => (r: ReviewRequest): Decision => ({
    action: 'approve',
    fields: { ...reportsShown(r), ...changes },
  });

  test('opens the window with one edit field per operation, in order, at the path it is written to', async () => {
    const r = patched();
    await r.outcome;
    expect(r.seen).toHaveLength(1);
    const fields = r.seen[0]!.fields;
    // The title first (a line), then every edit; no body.
    expect(fields.map((f) => [f.field, f.kind])).toEqual([
      ['title', 'line'],
      ['patch.0.new_string', 'edit'],
      ['patch.1.new_string', 'edit'],
      ['patch.2.text', 'edit'],
      ['patch.3.text', 'edit'],
      ['patch.4.text', 'edit'],
      ['patch.5.text', 'edit'],
      ['patch.6.new_string', 'edit'],
    ]);
    // Each carries what it applies at, read-only, and its value is the agent's text.
    const edits = fields.filter((f) => f.kind === 'edit');
    expect(edits.map((f) => f.value)).toEqual(TEXTS);
    const range = edits[6]!;
    if (range.kind !== 'edit') throw new Error('unreachable');
    expect(range.edit.anchors.map((a) => [a.key, a.value])).toEqual([
      ['from', '## Old notes'],
      ['to', '## Risks'],
    ]);
    // What the window cannot see is said, from the profile.
    expect(range.edit.note).toContain('cannot see');
    const all = edits[1]!;
    if (all.kind !== 'edit') throw new Error('unreachable');
    expect(all.edit.flags).toEqual(['every occurrence']);
    // The raw list is not drawn again as routing.
    expect(r.seen[0]!.context).toEqual({ id: 'HELP-42' });
  });

  test('approved unchanged, the tool receives the agent\'s patch exactly', async () => {
    const out = await patched().outcome;
    expect(out.exitCode).toBe(0);
    expect(out.updatedInput).toEqual(INPUT);
    expect(out.edited).toBe(false);
    expect(out.sent).toBeUndefined();
  });

  test('an edited text reaches the tool\'s patch at its operation, and nothing else moves', async () => {
    const out = await patched(INPUT, editing({ 'patch.3.text': ' (final)', 'patch.0.new_string': 'Friday' })).outcome;
    expect(out.exitCode).toBe(0);
    const sent = out.updatedInput!.patch as Record<string, unknown>[];
    // Same operations, anchors and order; only the two texts differ.
    expect(sent).toEqual([
      { op: 'replace', old_string: 'Tuesday', new_string: 'Friday' },
      PATCH[1],
      PATCH[2],
      { op: 'insert_after', anchor: 'Rollout plan', text: ' (final)' },
      PATCH[4],
      PATCH[5],
      PATCH[6],
    ]);
    // The agent's input is not mutated in place.
    expect(PATCH[0]).toEqual({ op: 'replace', old_string: 'Tuesday', new_string: 'Thursday' });
    expect(out.updatedInput!.title).toBe('Rollout');
    expect(out.edited).toBe(true);
    // The agent is told what the person changed, by path.
    expect(out.sent?.lines).toEqual([
      { field: 'patch.0.new_string', value: 'Friday' },
      { field: 'patch.3.text', value: ' (final)' },
    ]);
  });

  test('a replacement emptied by the reviewer is a deletion, and is sent', async () => {
    const out = await patched(INPUT, editing({ 'patch.0.new_string': '' })).outcome;
    expect(out.exitCode).toBe(0);
    expect((out.updatedInput!.patch as Record<string, unknown>[])[0]).toEqual({
      op: 'replace', old_string: 'Tuesday', new_string: '',
    });
  });

  test('an insertion emptied by the reviewer is refused, since the tool refuses the whole call', async () => {
    const out = await patched(INPUT, editing({ 'patch.3.text': '' })).outcome;
    expect(out.exitCode).toBe(1);
    expect(out.updatedInput).toBeUndefined();
    expect(out.denial?.outcome).toBe('rejected');
    expect(out.denial?.reason).toContain('patch/empty-text');
    expect(out.denial?.reason).toContain('Edit 4');
  });

  test('a denial after an approval logs what the reviewer typed, not only what they were shown', async () => {
    // Edit 1 rewritten, edit 4 emptied: the backstop refuses, and the row says which edit did it.
    const out = await patched(INPUT, editing({ 'patch.0.new_string': 'Friday', 'patch.3.text': '' })).outcome;
    expect(out.exitCode).toBe(1);
    expect(out.audit.edited).toBe(true);
    expect(out.audit.patch![0]).toMatchObject({ before: 'Thursday', after: 'Friday' });
    expect(out.audit.patch![3]).toMatchObject({ before: ' (draft)', after: '' });
    expect('after' in out.audit.patch![1]!).toBe(false);
  });

  test('the log records every edit, as shown and as sent', async () => {
    const out = await patched(INPUT, editing({ 'patch.3.text': ' (final)' })).outcome;
    // No body, so no body halves.
    expect('before' in out.audit).toBe(false);
    expect('after' in out.audit).toBe(false);
    expect(out.audit.patch).toHaveLength(PATCH.length);
    expect(out.audit.patch![1]).toEqual({
      field: 'patch.1.new_string',
      op: 'replace',
      anchors: { old_string: 'TODO' },
      flags: ['every occurrence'],
      before: '',
    });
    expect(out.audit.patch![3]).toEqual({
      field: 'patch.3.text',
      op: 'insert_after',
      anchors: { anchor: 'Rollout plan' },
      before: ' (draft)',
      after: ' (final)',
    });
    expect(out.audit.edited).toBe(true);
  });

  test('a rejection sends nothing, and the log records the edits the reviewer read', async () => {
    const out = await patched(INPUT, { action: 'reject', reason: 'wrong issue' }).outcome;
    expect(out.exitCode).toBe(1);
    expect(out.updatedInput).toBeUndefined();
    expect(out.denial?.outcome).toBe('rejected');
    expect(out.audit.patch?.map((r) => r.before)).toEqual(TEXTS);
    expect(out.audit.patch?.some((r) => 'after' in r)).toBe(false);
  });

  /** A patch the window cannot show asks, and the reason names what it could not show. */
  const unreadable: [string, Record<string, unknown>, string][] = [
    ['an operation the grammar does not name', { id: 'HELP-42', patch: [{ op: 'rewrite', text: 'x' }] }, '"rewrite"'],
    [
      'a key an operation does not declare',
      { id: 'HELP-42', patch: [{ op: 'append', text: 'x', position: 3 }] },
      '"position"',
    ],
    ['a text that is not a string', { id: 'HELP-42', patch: [{ op: 'append', text: 7 }] }, '"text"'],
    ['an anchor with no text', { id: 'HELP-42', patch: [{ op: 'insert_after', anchor: '', text: 'x' }] }, '"anchor"'],
    ['a flag that is not a boolean', { id: 'HELP-42', patch: [{ ...PATCH[1], replace_all: 'yes' }] }, '"replace_all"'],
    ['an empty list', { id: 'HELP-42', patch: [] }, 'not a list of edits'],
    ['not a list', { id: 'HELP-42', patch: { op: 'append', text: 'x' } }, 'not a list of edits'],
    ['an entry that is not an object', { id: 'HELP-42', patch: ['append x'] }, 'edit 1 is not an object'],
    [
      'more operations than the tool accepts',
      { id: 'HELP-42', patch: Array.from({ length: 51 }, () => ({ op: 'append', text: 'x' })) },
      'more than the 50',
    ],
    /*
     * Both fields present, which the live schema permits: `patch` stands "in place of the full
     * content/description field", but the two are not marked mutually exclusive and which wins is
     * not probed.
     */
    ['a description beside it', { ...INPUT, description: 'The rollout is on Tuesday.' }, '"description"'],
  ];

  for (const [name, toolInput, named] of unreadable) {
    test(`${name}: asks, opens no window, and names it`, async () => {
      const r = patched(toolInput);
      const out = await r.outcome;
      expect(r.seen).toHaveLength(0);
      expect(out.updatedInput).toBeUndefined();
      expect(out.denial?.code).toBe('body/patch-unreadable');
      // Nobody objected to this message; the gate could not be applied to it.
      expect(out.denial?.outcome).toBe('unavailable');
      expect(out.denial?.reason).toContain('"patch"');
      expect(out.denial?.reason).toContain(named);
      // The two wrong diagnoses: each sends the reader to a file with nothing wrong in it.
      expect(out.denial?.reason).not.toContain('check the tool map');
      expect(out.denial?.guidance).not.toContain('destination profile');
      // And the one thing the agent can actually do instead.
      expect(out.denial?.guidance).toContain('full new text');
      // The row carries the cause, and quotes nothing: no concatenation of the ops is the message.
      expect(out.audit.code).toBe('body/patch-unreadable');
      expect(out.audit.before).toBe('');
      expect(out.audit.patch).toBeUndefined();
    });
  }

  /*
   * The mirror: the check is a profile field, not a test for the word `patch`. Jira's `deltaFields`
   * is `[]` (checked against the live `editJiraIssue` schema, which sets `fields` wholesale).
   */
  test('a `patch` key in a destination that declares none is not a delta', async () => {
    const out = await runReview({
      destination: 'jira',
      toolInput: { cloudId: 'c1', issueIdOrKey: 'SUPPORT-123', commentBody: 'Deploy finished.', patch: PATCH },
      toolName: 'addCommentToJiraIssue',
      surface: stub(approvesUnchanged).surface,
    });
    expect(out.exitCode).toBe(0);
    expect(out.denial).toBeUndefined();
  });
});

/** Deep enough to overflow the converter's recursion; the exact depth is not the point. */
const DEEP = Array.from({ length: 10_000 }, (_, i) => '  '.repeat(i) + '- x').join('\n');

/**
 * A review that throws is still a structured outcome, with an audit line and a `--decision` file.
 * Uncaught, a throw (here a 10,000-deep nested list overflowing the converter's recursion) would
 * end the CLI with a stack trace and no audit line: closed, but with no evidence.
 */
describe('a review that throws', () => {
  const crashing = async () =>
    runReview({
      destination: 'jira',
      toolInput: { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: DEEP },
      toolName: 'addCommentToJiraIssue',
      surface: {
        human: true,
        review: async () => {
          throw new Error('the surface must never be reached: render() throws first');
        },
      },
    });

  test('comes back as unavailable, with a code and guidance', async () => {
    const out = await crashing();
    expect(out.exitCode).toBe(1);
    expect(out.denial?.outcome).toBe('unavailable');
    expect(out.denial?.code).toBe('review/crashed');
    // The agent must be told not to retry, and told this is not about the message.
    expect(out.denial?.guidance).toContain('NOT a judgement about the message');
    expect(out.denial?.reason).toContain('Maximum call stack');
  });

  test('and carries an audit record', async () => {
    const out = await crashing();
    expect(out.audit.outcome).toBe('unavailable');
    expect(out.audit.destination).toBe('jira');
    // The routing context survives: the crash handler re-derives it rather than trusting order.
    expect(out.audit.context).toEqual({ cloudId: 'c', issueIdOrKey: 'K-1' });
  });

  test('with the draft TRUNCATED, because a crash must not answer itself with a bigger one', async () => {
    const out = await crashing();
    // Elsewhere `before` is written in full (a human reviewed it); here nobody did. Asserted as a
    // string first: `before` is optional, and a crashed review of a body that exists must quote it.
    expect(typeof out.audit.before).toBe('string');
    expect(out.audit.before!.length).toBeLessThan(5_000);
    expect(out.audit.before).toContain('truncated for the log');
    expect(out.audit.before).toContain(String(DEEP.length));
  });

  test('a body that does NOT crash is still logged in full', async () => {
    // The negative control: the cap belongs to the crash path alone.
    const body = 'x'.repeat(50_000);
    const out = await runReview({
      destination: 'jira',
      toolInput: { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: body },
      toolName: 'addCommentToJiraIssue',
      surface: stub(approvesUnchanged).surface,
    });
    expect(out.audit.before).toHaveLength(50_000);
    expect(out.audit.before).not.toContain('truncated');
  });
});

/*
 * `runReview` and the window surface both time the same review, and the surface's timer must fire
 * first: it owns the SIGKILL, and `main.ts` exits once an outcome exists, so a `runReview` win
 * would leave the window running. Registration order cannot order them (`windowSurface` awaits
 * the host build first); the backstop margin does.
 */
describe('the orchestration timer is a backstop, not a competitor', () => {
  /** A surface that owns a timer at exactly the review deadline, like the window one. */
  function timedSurface(deadlineMs: number) {
    const order: string[] = [];
    const surface: ReviewSurface = {
      human: true,
      review: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            order.push('surface');
            resolve({ action: 'timeout' });
          }, deadlineMs);
        }),
    };
    return { surface, order };
  }

  test('a surface that fires at the deadline settles it, even registering its timer LATE', async () => {
    // The hostile ordering: the surface registers its timer after runReview's, as any `await`
    // above `runWindow` would produce.
    const order: string[] = [];
    const surface: ReviewSurface = {
      human: true,
      async review() {
        await new Promise((r) => setTimeout(r, 5));
        return new Promise((resolve) => {
          setTimeout(() => {
            order.push('surface');
            resolve({ action: 'timeout' });
          }, 45);
        });
      },
    };
    const out = await runReview({
      destination: 'jira', toolInput: JIRA_INPUT, surface, timeoutMs: 50,
    });
    expect(out.exitCode).toBe(2);
    expect(out.denial!.outcome).toBe('timeout');
    // The surface's own timer is what produced it, not the backstop.
    expect(order).toEqual(['surface']);
  });

  test('and the backstop still fires for a surface that has no timer at all', async () => {
    // `auto-approve` and `auto-reject` have no timer of their own, so this is the only one they get.
    const surface: ReviewSurface = { human: true, review: () => new Promise(() => {}) };
    const started = Date.now();
    const out = await runReview({
      destination: 'jira', toolInput: JIRA_INPUT, surface, timeoutMs: 30,
    });
    expect(out.denial!.outcome).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  test('the margin is a real margin, and is not part of the reviewer\'s deadline', () => {
    expect(TIMEOUT_BACKSTOP_MS).toBeGreaterThan(0);
    // Small enough that nobody waits for it, large enough to beat a settle turn.
    expect(TIMEOUT_BACKSTOP_MS).toBeLessThanOrEqual(2000);
  });

  test('the surface is told the REVIEWER\'s deadline, not the backstop one', async () => {
    // The window counts this down on screen and `timeoutDenial` names it; adding the margin here
    // would make the countdown lie.
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface, timeoutMs: 12_345 });
    expect(seen[0]!.timeoutMs).toBe(12_345);
  });
});

/*
 * The window disables Approve on `blocked`, so from the window this backstop means the window and
 * this layer disagreed: most likely a `surface/dist` built against an older `core`, which
 * `PROTOCOL_VERSION` cannot see. `outcome` stays `rejected` so the hook denies; the code keeps a
 * machine backstop from being counted as a person saying no.
 */
describe('a surface that approves a blocked draft is named, not counted as a rejection', () => {
  const BLOCKED = '> # heading in a quote\n';

  test('the denial carries BLOCKED_AFTER_APPROVAL and points at the stale build', async () => {
    const { surface } = stub(approves('jira', BLOCKED));
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(out.exitCode).toBe(1);
    expect(out.denial!.outcome).toBe('rejected');
    expect(out.denial!.code).toBe(BLOCKED_AFTER_APPROVAL);
    expect(out.denial!.guidance).toContain('build:surface');
  });

  test('a real human rejection carries no code, so the two are distinguishable', async () => {
    const { surface } = stub({ action: 'reject', reason: 'wrong tone' });
    const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(out.denial!.outcome).toBe('rejected');
    expect(out.denial!.code).toBeUndefined();
  });
});

/**
 * The audience reaching the surface and the log. The rule is tested in `core/test/audience.test.ts`
 * and the banner in `surface/window.test.tsx`; this covers the wiring between them.
 */
describe('audience', () => {
  // Keyed by the cloud id `JIRA_INPUT` carries: a project key alone is not unique across sites.
  const SERVICE_DESK = {
    '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d': {
      host: 'acme-dev.atlassian.net',
      projects: { SUPPORT: 'service_desk' },
    },
  } as const;

  // Named in every case that expects a comment claim: an unnamed caller is `unknown`, because
  // every Jira audience fact in the profile was probed against this tool.
  const COMMENT_TOOL = 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue';

  test('a service-desk project reaches the surface as a public audience', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      toolName: COMMENT_TOOL,
      surface,
      audienceFacts: { sites: { ...SERVICE_DESK } },
    });
    expect(seen[0]?.audience?.kind).toBe('public');
    expect(seen[0]?.audience?.label).toBe('Reply to customer');
  });

  test('and WHERE it is going reaches the surface in words, not as a cloud id', async () => {
    /*
     * One issue key can exist on a dev site and on production, and a cloud id does not tell a
     * reviewer which. The CLI resolves it because the hostname lives in the operator's
     * `jira-projects.json` and the renderer has no filesystem.
     */
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      toolName: COMMENT_TOOL,
      surface,
      audienceFacts: { sites: { ...SERVICE_DESK } },
    });
    expect(seen[0]?.destinationLabel).toBe('acme-dev.atlassian.net / SUPPORT-123');
    // The raw fields survive beside it: a summary, never a replacement.
    expect(seen[0]?.context.cloudId).toBe('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
  });

  test('and composes NOTHING when the site is not in the operator config', async () => {
    // An opaque destination makes a reviewer look; a confident wrong one makes them approve.
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      toolName: COMMENT_TOOL,
      surface,
    });
    expect(seen[0]?.destinationLabel).toBeUndefined();
  });

  test('and the audit row records the audience the reviewer was SHOWN', async () => {
    const { surface } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      toolName: COMMENT_TOOL,
      surface,
      audienceFacts: { sites: { ...SERVICE_DESK } },
    });
    expect(outcome.audit.audience).toBe('public');
  });

  test('a DENIAL records it too -- "we nearly sent this to a customer" is evidence', async () => {
    const { surface } = stub({ action: 'reject', reason: 'not yet' });
    const outcome = await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      toolName: COMMENT_TOOL,
      surface,
      audienceFacts: { sites: { ...SERVICE_DESK } },
    });
    expect(outcome.audit.outcome).toBe('rejected');
    expect(outcome.audit.audience).toBe('public');
  });

  /*
   * Core's rule needs `routeInferred`, which only the CLI supplies (from the hook's `inferredFrom`,
   * via `audienceFactsFor`). Drop it and a server nobody mapped wears "the reporter never sees
   * this", with every core test green.
   */

  describe('the internal-note tool on an INFERRED route', () => {
    const INFERRED = 'mcp__some_vendor_jira__jira_add_internal_note';
    const run = (surface: ReviewSurface, inferred: boolean) =>
      runReview({
        destination: 'jira',
        toolInput: JIRA_INPUT,
        toolName: INFERRED,
        surface,
        audienceFacts: { sites: { ...SERVICE_DESK } },
        ...(inferred ? { inferredFrom: 'mcp__jsm__jira_add_internal_note' } : {}),
      });

    test('reaches the surface and the log as `unknown`, naming the tool', async () => {
      const { surface, seen } = stub(approvesUnchanged);
      const outcome = await run(surface, true);
      expect(seen[0]?.audience?.kind).toBe('unknown');
      expect(seen[0]?.audience?.detail).toContain(INFERRED);
      expect(outcome.audit.audience).toBe('unknown');
    });

    test('and the same name on a CONFIGURED route is still internal -- the control', async () => {
      const { surface, seen } = stub(approvesUnchanged);
      const outcome = await run(surface, false);
      expect(seen[0]?.audience?.kind).toBe('internal');
      expect(outcome.audit.audience).toBe('internal');
    });

    test('and a CRASHED review logs `unknown` too', async () => {
      const outcome = await runReview({
        destination: 'jira',
        toolInput: { ...JIRA_INPUT, commentBody: DEEP },
        toolName: INFERRED,
        inferredFrom: 'mcp__jsm__jira_add_internal_note',
        surface: {
          human: true,
          review: async () => {
            throw new Error('the surface must never be reached: render() throws first');
          },
        },
      });
      expect(outcome.denial?.code).toBe('review/crashed');
      expect(outcome.audit.audience).toBe('unknown');
    });
  });

  test('no config is `unknown`, never silence', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    const outcome = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
    expect(seen[0]?.audience?.kind).toBe('unknown');
    expect(outcome.audit.audience).toBe('unknown');
  });

  test('a software project has no audience, and writes no field', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'jira',
      toolInput: { ...JIRA_INPUT, issueIdOrKey: 'KAN-1' },
      surface,
      audienceFacts: {
        sites: { '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d': { projects: { KAN: 'software' } } },
      },
    });
    expect(seen[0]?.audience).toBeUndefined();
    // Absent, not 'unknown', which would report a configuration gap the operator already closed.
    expect('audience' in outcome.audit).toBe(false);
  });

  test('a WORKLOG on a service desk gets no banner and no audit field', async () => {
    // `addWorklogToJiraIssue` carries `commentBody` and `issueIdOrKey` like the comment tool, so
    // without the tool name this would claim "Reply to customer". Probed: a worklog comment reaches
    // neither comment list and has no `jsdPublic`.
    const { surface, seen } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      toolName: 'mcp__claude_ai_Atlassian_Rovo__addWorklogToJiraIssue',
      surface,
      audienceFacts: { sites: { ...SERVICE_DESK } },
    });
    expect(seen[0]?.audience).toBeUndefined();
    expect('audience' in outcome.audit).toBe(false);
  });

  test('and the comment tool on the same payload still says PUBLIC', async () => {
    // The control for the row above: the difference is the tool, not the payload.
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({
      destination: 'jira',
      toolInput: JIRA_INPUT,
      toolName: 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue',
      surface,
      audienceFacts: { sites: { ...SERVICE_DESK } },
    });
    expect(seen[0]?.audience?.kind).toBe('public');
  });

  test('Slack and Linear have no audience at all', async () => {
    for (const [destination, toolInput] of [
      ['slack', SLACK_INPUT],
      ['linear', { issueId: 'HELP-42', body: 'hi' }],
    ] as const) {
      const { surface, seen } = stub(approvesUnchanged);
      const outcome = await runReview({ destination, toolInput, surface });
      expect(seen[0]?.audience).toBeUndefined();
      expect(outcome.audit.audience).toBeUndefined();
    }
  });

  /**
   * The reviewer's answer is remembered on both outcomes, so "ask once" survives a rejection, and
   * on neither non-outcome: a timeout and an unavailable surface carry no answer.
   */
  describe('remembering what the reviewer said', () => {
    /**
     * A Jira answer, shaped the way the window builds one. The one case where the destination is
     * the subject writes it out.
     */
    const jira = (value: string) => ({ destination: 'jira' as const, value });

    /**
     * One review, with a `rememberProject` that records what it was handed. The handler is inline
     * so its parameters infer from `ReviewOptions`; a factory typed `type: string` would need
     * `as never` casts that hide a change to `rememberProject`'s signature.
     */
    const runWith = async (decision: Decision) => {
      // An approval naming no fields reports the shown ones, or the stale-renderer guard denies it.
      const { surface, seen: shown } = stub((r) =>
        decision.action === 'approve' && decision.fields === undefined
          ? { ...decision, fields: reportsShown(r) }
          : decision
      );
      const seen: { context: Record<string, unknown>; type: string }[] = [];
      const out = await runReview({
        destination: 'jira',
        toolInput: JIRA_INPUT,
        toolName: COMMENT_TOOL,
        surface,
        rememberProject: (context, type) => {
          seen.push({ context, type });
        },
      });
      return { out, seen, shown };
    };

    test('an approval carries it', async () => {
      const { seen } = await runWith({
        action: 'approve',
        classifyProject: jira('service_desk'),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.type).toBe('service_desk');
      // The context, not a key: `review.ts` stays destination-blind and `main.ts` parses.
      expect(seen[0]!.context.issueIdOrKey).toBe('SUPPORT-123');
    });

    test('and so does a REJECTION -- the project is what it is either way', async () => {
      const { out, seen } = await runWith({
        action: 'reject',
        reason: 'not yet',
        classifyProject: jira('software'),
      });
      expect(out.audit.outcome).toBe('rejected');
      expect(seen.map((s) => s.type)).toEqual(['software']);
    });

    test('a decision with no answer remembers nothing', async () => {
      expect((await runWith({ action: 'approve' })).seen).toEqual([]);
    });

    test('and a timeout remembers nothing, because nobody was there', async () => {
      expect((await runWith({ action: 'timeout' })).seen).toEqual([]);
    });

    /**
     * The audit row records what the reviewer decided under, not what the banner said on open. A
     * value fixed before `surface.review()` would log these reviews `unknown` and leave them out of
     * `customerVisible`.
     */
    test('an in-window classification is what the audit row records', async () => {
      // The CLI had no config: the banner opened `unknown` and became `public` when they answered.
      const { out } = await runWith({
        action: 'approve',
        classifyProject: jira('service_desk'),
      });
      expect(out.audit.audience).toBe('public');
    });

    test('and "internal only" leaves the row with no audience at all', async () => {
      const { out } = await runWith({
        action: 'approve',
        classifyProject: jira('software'),
      });
      // Not `unknown`: the same answer a configured software project gives.
      expect('audience' in out.audit).toBe(false);
    });

    test('a rejection records it too', async () => {
      const { out } = await runWith({
        action: 'reject',
        reason: 'no',
        classifyProject: jira('service_desk'),
      });
      expect(out.audit.audience).toBe('public');
    });

    /**
     * An answer about another destination is refused: `main.ts` picks the store from the review's
     * destination, so a GitHub answer would be filed against `jira-projects.json`. Both halves are
     * asserted (nothing remembered, and the approval still stands): a human's approval is not
     * withdrawn because a metadata field arrived wrong.
     */
    test("an answer about another destination is neither remembered nor applied", async () => {
      /*
       * The value is one Jira accepts, so only the destination says it is not ours; `public` would
       * be refused by the Jira store's own vocabulary and prove nothing.
       *
       * Mutation-proved: drop `said.destination === destination` and `seen` is
       * `[{ type: 'service_desk' }]`.
       */
      const { out, seen } = await runWith({
        action: 'approve',
        classifyProject: { destination: 'github', value: 'service_desk' },
      });
      expect(seen).toEqual([]);
      expect(out.exitCode).toBe(0);
      expect(out.audit.outcome).toBe('approved');
      // And the banner stays the one the reviewer opened under.
      expect(out.audit.audience).toBe('unknown');
    });

    test('the review still runs when no caller supplied a way to remember', async () => {
      // `rememberProject` is optional: `auto-approve` never asks, and a classification arriving
      // with no handler must not break the gate.
      const { surface } = stub((r) => ({
        action: 'approve' as const,
        fields: reportsShown(r),
        classifyProject: jira('service_desk'),
      }));
      const out = await runReview({ destination: 'jira', toolInput: JIRA_INPUT, surface });
      expect(out.exitCode).toBe(0);
    });
  });


  test('a body-less payload still says where it was going', async () => {
    // `body/missing-field` can end in an unreviewed send, so the audience matters most here.
    const { surface } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'jira',
      toolInput: {
        cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        issueIdOrKey: 'SUPPORT-123',
        bodyText: 'drifted',
      },
      toolName: COMMENT_TOOL,
      surface,
      audienceFacts: { sites: { ...SERVICE_DESK } },
    });
    expect(outcome.audit.outcome).not.toBe('approved');
    expect(outcome.audit.audience).toBe('public');
  });
});

/**
 * The per-tool body field. Read off the live connector schemas, it is not a destination fact:
 * Linear alone spells it `body` (`save_comment`, `save_status_update`, `save_diff_comment`),
 * `description` (`save_issue`, `save_project`, `save_initiative`) and `content` (`save_document`,
 * `save_release_note`).
 */
describe('a tool whose body field is not its destination default', () => {
  /** `save_issue`: Linear, but the prose is in `description`. */
  const SAVE_ISSUE = {
    id: 'HELP-42',
    title: 'Broken export',
    description: 'The nightly export **fails** on empty tables.',
  };

  test('the override is read, and the profile default stands without one', () => {
    expect(bodyFieldFor('linear')).toBe('body');
    expect(bodyFieldFor('linear', 'description')).toBe('description');
    expect(extractBody('linear', SAVE_ISSUE, 'description')).toBe(SAVE_ISSUE.description);
  });

  test('without the override the same payload is body/missing-field, and shows NO draft', () => {
    /*
     * `extractBody` misses `body` and `plausibleProseField` finds prose elsewhere, so this is
     * `drift`; an operator route cannot take that fail-open, so the adapter asks. The field it
     * names is `title`: the first string with whitespace in `Object.entries` order.
     */
    try {
      extractBody('linear', SAVE_ISSUE);
      throw new Error('expected a MissingBodyFieldError');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingBodyFieldError);
      const err = e as MissingBodyFieldError;
      expect(err.failure).toBe('drift');
      expect(err.namedField).toBe('title');
      expect(err.message).toContain('no "body" field');
    }
  });

  test('the field READ is the field WRITTEN', () => {
    /*
     * The mutation invisible from outside: `buildUpdatedInput` keeping `profile.bodyField` while
     * `extractBody` honours the override. The approved body lands in `body`, which `save_issue`
     * lacks, and the send succeeds with the agent's text and the edit dropped.
     */
    const updated = buildUpdatedInput(
      render('x\n', 'linear'), SAVE_ISSUE, 'edited by a human', 'description'
    );
    expect(updated.description).toBe('edited by a human');
    expect(updated).not.toHaveProperty('body');
    // The rest of the payload is intact: `updatedInput` replaces tool input wholesale.
    expect(updated.id).toBe('HELP-42');
    expect(updated.title).toBe('Broken export');
  });

  test('a whole review runs on the overridden field, end to end', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'linear',
      toolInput: SAVE_ISSUE,
      toolName: 'mcp__claude_ai_Linear__save_issue',
      surface,
      bodyField: 'description',
    });
    // Linear's `convert` is the identity, so the surface was shown the prose in `description`.
    expect(seen[0]!.render.converted).toBe(SAVE_ISSUE.description);
    expect(outcome.audit.before).toBe(SAVE_ISSUE.description);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.updatedInput!.description).toBe(SAVE_ISSUE.description);
    expect(outcome.updatedInput).not.toHaveProperty('body');
  });

  test('an edit lands in the overridden field', async () => {
    // The decision names the overridden field; the profile's `body` was never shown.
    const { surface } = stub({
      action: 'approve', fields: { description: 'Rewritten by the reviewer.' }, edited: true,
    });
    const outcome = await runReview({
      destination: 'linear',
      toolInput: SAVE_ISSUE,
      toolName: 'mcp__claude_ai_Linear__save_issue',
      surface,
      bodyField: 'description',
    });
    expect(outcome.updatedInput!.description).toBe('Rewritten by the reviewer.');
    expect(outcome.audit.edited).toBe(true);
  });
});

/**
 * A body field that is a path. `editJiraIssue`'s live schema has no `description` parameter: the
 * prose sits inside `fields`, a free-form object.
 */
describe('a nested body field', () => {
  /** `editJiraIssue`-shaped: prose one level down, beside fields nobody is reviewing. */
  const EDIT_ISSUE = {
    cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    issueIdOrKey: 'SUPPORT-123',
    fields: {
      summary: 'Broken export',
      labels: ['support'],
      description: 'The nightly export **fails** on empty tables.',
    },
  };

  test('a dotted field reads the nested value', () => {
    expect(extractBody('jira', EDIT_ISSUE, 'fields.description')).toBe(EDIT_ISSUE.fields.description);
  });

  test('without it the payload is NESTED prose, because the prose is inside an OBJECT', () => {
    // `plausibleProseField` reads only top-level strings, so this is not `drift`; nor
    // `unrecognised`, which a `bodyOptional` route allows. The nested scan names it, and every
    // route asks.
    try {
      extractBody('jira', EDIT_ISSUE);
      throw new Error('expected a MissingBodyFieldError');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingBodyFieldError);
      expect((e as MissingBodyFieldError).failure).toBe('nested');
      expect((e as MissingBodyFieldError).namedField).toBe('fields.summary');
    }
  });

  test('writing back keeps the body SIBLINGS, which is the whole risk', () => {
    // A rebuild that forgets `fields.summary` does not fail: it silently clears it.
    const updated = buildUpdatedInput(
      render('x\n', 'jira'), EDIT_ISSUE, 'reviewed text', 'fields.description'
    );
    const fields = updated.fields as Record<string, unknown>;
    expect(fields.description).toBe('reviewed text');
    expect(fields.summary).toBe('Broken export');
    expect(fields.labels).toEqual(['support']);
    expect(updated.issueIdOrKey).toBe('SUPPORT-123');
    // The caller's payload is untouched -- rebuilt, never mutated.
    expect(EDIT_ISSUE.fields.description).toBe('The nightly export **fails** on empty tables.');
  });

  test('a missing or non-object container is ABSENT, not wrongly typed', () => {
    // `fields: "oops"` has no `description` to be the wrong type.
    for (const input of [{ issueIdOrKey: 'X-1' }, { fields: 'oops' }, { fields: ['a'] }]) {
      try {
        extractBody('jira', input, 'fields.description');
        throw new Error('expected a MissingBodyFieldError');
      } catch (e) {
        expect(e, JSON.stringify(input)).toBeInstanceOf(MissingBodyFieldError);
        expect((e as MissingBodyFieldError).failure).not.toBe('wrong-type');
      }
    }
  });

  test('a nested body that is present but not a string is still wrong-type', () => {
    // The fail-open must not open just because the field moved down a level.
    try {
      extractBody('jira', { fields: { description: { type: 'doc' } } }, 'fields.description');
      throw new Error('expected a MissingBodyFieldError');
    } catch (e) {
      expect((e as MissingBodyFieldError).failure).toBe('wrong-type');
    }
  });

  test('a path that addresses machinery rather than a field is refused', () => {
    // `writeBodyPath` assigns into objects it builds, so `__proto__` would set a prototype rather
    // than fill in a field.
    for (const bad of ['__proto__', 'fields.__proto__', 'constructor.x', 'a..b', '.a', 'a.']) {
      expect(() => parseBodyPath(bad), bad).toThrow(BodyPathError);
    }
    // And an ordinary name is still one segment, so nothing that worked before changes.
    expect(parseBodyPath('commentBody')).toEqual(['commentBody']);
  });
});

/**
 * Which routing fields a review shows. `contextFields` is per destination and Linear's list is
 * `save_comment`-shaped, so other Linear write tools show almost nothing without a route override.
 */
describe('routing fields a tool spells differently', () => {
  const STATUS_UPDATE = {
    type: 'project',
    project: 'P-ENG-1',
    health: 'atRisk',
    body: 'Slipping a week.',
  };

  test('the profile default is save_comment-shaped, so a status update shows nothing without an override', () => {
    // `id` is the only key Linear's list and a status update share, and this payload has none.
    expect(extractContext('linear', STATUS_UPDATE)).toEqual({});
  });

  test('an override shows the routing the tool actually has', () => {
    expect(extractContext('linear', STATUS_UPDATE, { contextFields: ['project', 'initiative', 'type', 'health'] }))
      .toEqual({ type: 'project', project: 'P-ENG-1', health: 'atRisk' });
  });

  test('it ADDS to the profile list, and names no key the payload lacks', () => {
    // A named key the payload does not carry shows nothing, so a superset is harmless.
    const out = extractContext('linear', STATUS_UPDATE, { contextFields: ['project', 'issueId', 'parentId'] });
    expect(out).toEqual({ project: 'P-ENG-1' });
  });

  test('an override cannot drop a key the DESTINATION reads, or public becomes unknown', () => {
    /*
     * This record is the sole input to `audienceFor`, `destinationLabel` and `rememberJiraProject`,
     * and Jira's profile reads `cloudId` and `issueIdOrKey` from it. Replaced rather than unioned,
     * `contextFields: ["issueIdOrKey"]` would turn `audience: public` into `unknown`.
     */
    const JIRA_INPUT_FULL = {
      cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      issueIdOrKey: 'SUPPORT-123',
      commentBody: 'hi',
    };
    const out = extractContext('jira', JIRA_INPUT_FULL, { contextFields: ['issueIdOrKey'] });
    expect(out.cloudId).toBe('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    // Every key the profile names and the payload carries is still there.
    for (const key of ['cloudId', 'issueIdOrKey']) expect(out).toHaveProperty(key);
  });

  test('the union is deduped and profile-ordered, so a restated key appears once', () => {
    expect(Object.keys(extractContext('jira', {
      cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 'x',
    }, { contextFields: ['issueIdOrKey'] }))).toEqual(['cloudId', 'issueIdOrKey']);
  });

  test('a whole review carries the override to the surface', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    await runReview({
      destination: 'linear',
      toolInput: STATUS_UPDATE,
      toolName: 'mcp__claude_ai_Linear__save_status_update',
      surface,
      contextFields: ['project', 'type', 'health'],
    });
    expect(seen[0]!.context).toEqual({ project: 'P-ENG-1', type: 'project', health: 'atRisk' });
  });
});

/**
 * The path grammar is read by more than `extractBody`; a reader that indexes the literal key
 * resolves a dotted field to nothing. Each test here is one such reader.
 */
describe('a dotted field resolves the same way everywhere it is read', () => {
  const EDIT_ISSUE = {
    cloudId: 'c1',
    issueIdOrKey: 'SUPPORT-123',
    contentFormat: 'adf',
    fields: { summary: 'Broken export', description: 'The nightly export fails.' },
  };

  test('the audit log quotes a NESTED body on a preformatted denial', async () => {
    /*
     * `BODY_FAILURES.preformatted.logs === 'body'`, so the row promises the message; indexing
     * `toolInput[loggedField]` in `failedBodyText` would log `before: ''`. Reachable because the
     * agent set a top-level `contentFormat: "adf"`.
     */
    const { surface } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'jira',
      toolInput: EDIT_ISSUE,
      toolName: 'mcp__x__editJiraIssue',
      surface,
      bodyField: 'fields.description',
    });
    expect(outcome.denial?.code).toBe('body/preformatted');
    expect(outcome.audit.before).toBe('The nightly export fails.');
  });

  test('a context field may be nested too, or a title shown read-only shows nothing', () => {
    // `editJiraIssue`'s title is `fields.summary`; a key-only lookup would draw an empty strip.
    // The union keeps Jira's own `cloudId` / `issueIdOrKey` beside it.
    expect(extractContext('jira', EDIT_ISSUE, { contextFields: ['fields.summary', 'issueIdOrKey'] })).toEqual({
      cloudId: 'c1',
      issueIdOrKey: 'SUPPORT-123',
      'fields.summary': 'Broken export',
    });
  });

  test('an absent nested context field is omitted, not rendered as undefined', () => {
    const out = extractContext('jira', EDIT_ISSUE, { contextFields: ['fields.labels', 'nope.nope'] });
    expect(out).not.toHaveProperty('fields.labels');
    expect(out).not.toHaveProperty('nope.nope');
    // `commentId` is in Jira's profile list and absent from this payload -- same rule, no key.
    expect(out).not.toHaveProperty('commentId');
  });
});

/**
 * A prose field that would go out blank is refused by the CLI, not only by the window.
 * `render()` sees the body alone; `proseWarnings` is the second producer, which the window merges
 * into `blocked`. This backstop covers a surface that never asks core (`auto-approve`, a stale
 * bundle); the e2e cannot reach it, because the window refuses to approve first.
 *
 * PROBED against a scratch Jira issue:
 *   PUT /rest/api/3/issue/{key} {"fields":{"summary":""}}
 *     -> 400 {"summary":"You must specify a summary of the issue."}
 *   ... and `"   "` answers the same, writing nothing either time. So this is an `error`: the
 * whole call is lost, including the body the reviewer read.
 */
describe('a prose field that would be sent empty', () => {
  const WITH_TITLE = {
    cloudId: 'c1', issueIdOrKey: 'K-1',
    fields: { summary: 'the agent wrote this', description: 'body\n' },
  };
  const opts = {
    destination: 'jira' as const,
    toolInput: WITH_TITLE,
    toolName: 'mcp__x__editJiraIssue',
    bodyField: 'fields.description',
    proseFields: ['fields.summary'],
  };

  test('the REVIEWER emptying it is refused, and the field is named', async () => {
    // The reachable case: one select-all and a Backspace in the window.
    const { surface } = stub({
      action: 'approve',
      edited: true,
      fields: { 'fields.description': 'body\n', 'fields.summary': '' },
    });
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.outcome).toBe('rejected');
    // Named, because a route may carry several prose fields.
    expect(outcome.denial?.reason).toContain('fields.summary');
    // Nothing is sent, not the body either.
    expect(outcome.updatedInput).toBeUndefined();
  });

  test('the AGENT sending it empty is refused too, with no edit involved', async () => {
    /*
     * The agent's value arrives through the request, not the decision, so a backstop reading only
     * the reviewer's edits (`proseEdits`) would pass this; it reads `sending`.
     */
    const agentBlanked = {
      cloudId: 'c1', issueIdOrKey: 'K-1',
      fields: { summary: '', description: 'body\n' },
    };
    // Reporting what it was shown, as the window does on an untouched approval.
    const { surface } = stub({
      action: 'approve',
      edited: false,
      fields: { 'fields.description': 'body\n', 'fields.summary': '' },
    });
    const outcome = await runReview({ ...opts, toolInput: agentBlanked, surface });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.reason).toContain('fields.summary');
  });

  test('whitespace counts as empty, which is the case the placeholder cannot draw', async () => {
    // Jira answers 400 to `"   "` as to `""`, and an input holding spaces renders no placeholder.
    const { surface } = stub({
      action: 'approve',
      edited: true,
      fields: { 'fields.description': 'body\n', 'fields.summary': '   ' },
    });
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.reason).toContain('fields.summary');
  });

  test('a field left ALONE is not empty, however the route is shaped', async () => {
    // `extractProse` omits a field the payload does not carry, so "leave the title alone" never
    // reaches this check.
    const noTitle = { cloudId: 'c1', issueIdOrKey: 'K-1', fields: { description: 'body\n' } };
    const { surface } = stub({
      action: 'approve',
      edited: false,
      fields: { 'fields.description': 'body\n', 'fields.summary': 'the agent wrote this' },
    });
    const outcome = await runReview({ ...opts, toolInput: noTitle, surface });
    expect(outcome.exitCode).toBe(0);
  });

  test('an ordinary title still approves, so the guard is not just always on', async () => {
    // The mutation this catches: a backstop that refuses everything passes every test above.
    const { surface } = stub({
      action: 'approve',
      edited: true,
      fields: { 'fields.description': 'body\n', 'fields.summary': 'a real title' },
    });
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).toBe(0);
    const fields = outcome.updatedInput!.fields as Record<string, unknown>;
    expect(fields.summary).toBe('a real title');
  });
});

/**
 * Past a destination's probed length, the CLI refuses first: the body through `render()`'s
 * `blocked`, a title through `proseWarnings`, with `auto-approve` as the consumer that never asks
 * core. A title inside GitHub's unresolved bracket is only a warning and sends: the mutation that
 * denies every prose warning fails the last test.
 */
describe('a body or a title past its destination\'s limit', () => {
  const issue = (title: string, body = 'body\n') => ({
    owner: 'Jakuboola', repo: 'draftgate', method: 'create', title, body,
  });
  const opts = {
    destination: 'github' as const,
    toolName: 'mcp__claude_ai_Github_MCP__issue_write',
    proseFields: ['title'],
  };

  test('a body past the limit is refused and nothing is sent', async () => {
    const outcome = await runReview({
      ...opts, toolInput: issue('t', 'x'.repeat(262_145)), surface: autoApprove(),
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.reason).toContain('github/body-too-long');
    expect(outcome.updatedInput).toBeUndefined();
    // Not `BLOCKED_AFTER_APPROVAL`, which says the install is stale.
    expect(outcome.denial?.code).toBeUndefined();
    expect(outcome.denial?.guidance).toContain('Shorten it');
  });

  test('a title GitHub refuses is refused, named, and nothing is sent', async () => {
    const outcome = await runReview({ ...opts, toolInput: issue('x'.repeat(4_096)), surface: autoApprove() });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.reason).toContain('prose/too-long');
    expect(outcome.denial?.reason).toContain('title');
    expect(outcome.updatedInput).toBeUndefined();
  });

  test('a title inside the unresolved bracket is a warning, and SENDS', async () => {
    const title = 'x'.repeat(2_000);
    const outcome = await runReview({ ...opts, toolInput: issue(title), surface: autoApprove() });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.updatedInput!.title).toBe(title);
  });
});

/**
 * A line break in a title, through `auto-approve`. Jira was probed refusing an LF in a `summary`
 * (400, nothing written), so that send is refused; GitHub stores it, so that one is a warning and
 * sends with the break intact.
 */
describe('a line break in a title', () => {
  test('a Jira summary with one is refused, named, and nothing is sent', async () => {
    const outcome = await runReview({
      destination: 'jira',
      toolName: 'mcp__atlassian__editJiraIssue',
      bodyField: 'fields.description',
      proseFields: ['fields.summary'],
      toolInput: {
        cloudId: 'c1', issueIdOrKey: 'K-1',
        fields: { summary: 'Export fails\non empty tables', description: 'body\n' },
      },
      surface: autoApprove(),
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.reason).toContain('prose/line-break');
    expect(outcome.denial?.reason).toContain('fields.summary');
    expect(outcome.denial?.guidance).toContain('one line');
    expect(outcome.updatedInput).toBeUndefined();
  });

  test('a GitHub title with one SENDS, break and all', async () => {
    const title = 'Export fails\non empty tables';
    const outcome = await runReview({
      destination: 'github',
      toolName: 'mcp__claude_ai_Github_MCP__issue_write',
      proseFields: ['title'],
      toolInput: { owner: 'o', repo: 'r', method: 'create', title, body: 'body\n' },
      surface: autoApprove(),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.updatedInput!.title).toBe(title);
  });
});

/**
 * An approving surface must report the fields it was shown. The protocol version cannot cover
 * this: a git-ignored `surface/dist/` older than the CLI still answers while every version check
 * agrees, and a renderer that shows the body alone approves an unseen title.
 */
describe('an approval that reports none of the fields it was shown', () => {
  const WITH_TITLE = {
    cloudId: 'c1', issueIdOrKey: 'K-1',
    fields: { summary: 'the agent wrote this', description: 'body\n' },
  };
  const opts = {
    destination: 'jira' as const,
    toolInput: WITH_TITLE,
    toolName: 'mcp__x__editJiraIssue',
    bodyField: 'fields.description',
    proseFields: ['fields.summary'],
  };

  test('is UNAVAILABLE when it reports none of the fields it was shown', async () => {
    // A stale window: human, approves, and says nothing about what it drew. The decision alone
    // separates it from a working build; `human: true` buys it nothing.
    const { surface, seen } = stub({ action: 'approve', edited: false });
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.outcome).toBe('unavailable');
    expect(outcome.denial?.code).toBe(SURFACE_STALE);
    expect(outcome.denial?.reason).toContain('reports none of them');
    // The rebuild rides the reason, which the hook's fallback shows the user.
    expect(outcome.denial?.reason).toContain(REMEDY.rebuildWindow);
    // Nothing is sent: the adapter turns `unavailable` into a permission prompt.
    expect(outcome.updatedInput).toBeUndefined();
    // It was still shown the title.
    expect(seen[0]!.fields.filter((f) => f.kind === 'line')).toEqual([
      { field: 'fields.summary', kind: 'line', value: 'the agent wrote this' },
    ]);
  });

  test('and an EMPTY map is the same silence, because a full map is what "unchanged" looks like', async () => {
    /*
     * `{}` is not "changed none of them", as it would be for `fixes`: a surface reports every shown
     * field, so unchanged is a full map.
     *
     * Mutation-proved: drop the `Object.keys(...).length === 0` half and this approves, sending the
     * agent's body and title under a human's recorded approval.
     */
    const { surface } = stub({ action: 'approve', edited: true, fields: {} });
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.code).toBe(SURFACE_STALE);
    expect(outcome.updatedInput).toBeUndefined();
  });

  test('and `auto-approve` reports what it was shown, and sends', async () => {
    // Asserted on `updatedInput`, not on `autoApprove()` returning `fields`.
    const outcome = await runReview({ ...opts, surface: autoApprove() });
    expect(outcome.exitCode).toBe(0);
    const sent = outcome.updatedInput!.fields as Record<string, unknown>;
    expect(sent.summary).toBe('the agent wrote this');
    expect(sent.description).toContain('"text":"body"');
  });

  test('and an OVERRIDE substitutes one field, leaving the rest as the agent wrote them', async () => {
    const outcome = await runReview({
      ...opts,
      // A path nobody showed is dropped: the surface builds from `request.fields`.
      surface: autoApprove({ 'fields.summary': 'a human retitled it', 'fields.nope': 'ignored' }),
    });
    expect(outcome.exitCode).toBe(0);
    const sent = outcome.updatedInput!.fields as Record<string, unknown>;
    expect(sent.summary).toBe('a human retitled it');
    // Jira's body is converted, so the assertion is about its text.
    expect(sent.description).toContain('"text":"body"');
    expect(sent.nope).toBeUndefined();
  });

  test('but reporting the values UNCHANGED is a real answer, and approves', async () => {
    // A full unchanged map is the positive claim "changed none of them"; only absence is stale.
    const { surface } = stub({
      action: 'approve',
      edited: false,
      fields: { 'fields.description': 'body\n', 'fields.summary': 'the agent wrote this' },
    });
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).toBe(0);
    const fields = outcome.updatedInput!.fields as Record<string, unknown>;
    expect(fields.summary).toBe('the agent wrote this');
  });

  /*
   * The line cap applies to what the surface changed. An over-cap title the agent wrote comes back
   * unchanged; capped, it would be `surface/stale` on an approved review, telling the agent not to
   * rewrite the one thing that would fix it.
   */
  const LONG = 'x'.repeat(MAX_PROSE_LENGTH + 1);

  test("an over-cap title the AGENT wrote is sent, not refused as a stale window", async () => {
    const payload = {
      cloudId: 'c1', issueIdOrKey: 'K-1', fields: { summary: LONG, description: 'body\n' },
    };
    const { surface } = stub({
      action: 'approve',
      edited: false,
      fields: { 'fields.description': 'body\n', 'fields.summary': LONG },
    });
    const outcome = await runReview({ ...opts, toolInput: payload, surface });

    expect(outcome.exitCode).toBe(0);
    expect((outcome.updatedInput!.fields as Record<string, unknown>).summary).toBe(LONG);
  });

  test('but a CHANGED one over the cap is refused -- no reviewer can type past it', async () => {
    // `App.tsx` caps the input (pasting too), so a changed value over the cap is no human's.
    const { surface } = stub({
      action: 'approve',
      edited: true,
      fields: { 'fields.description': 'body\n', 'fields.summary': LONG },
    });
    const outcome = await runReview({ ...opts, surface });

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.code).toBe(SURFACE_STALE);
    expect(outcome.updatedInput).toBeUndefined();
  });

  /*
   * A field named off `Object.prototype` must fall back to the shown value, not read a function:
   * `reported[f.field] ?? f.value` on `toString` would crash inside `proseWarnings`. A partial
   * report, because `{}` is the stale case above; the key is missing from a map that has another.
   */
  test('a field named like an Object member falls back to what was shown', async () => {
    const { surface } = stub({
      action: 'approve',
      edited: false,
      fields: { commentBody: 'body\n' },
    });
    const outcome = await runReview({
      destination: 'jira',
      toolInput: { cloudId: 'c1', issueIdOrKey: 'K-1', commentBody: 'body\n', toString: 'a title' },
      proseFields: ['toString'],
      surface,
    });

    expect(outcome.exitCode).toBe(0);
    // `Object.hasOwn` and an index, because `updatedInput.toString` is typed as `Object`'s own.
    expect(Object.hasOwn(outcome.updatedInput!, 'toString')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(outcome.updatedInput!, 'toString')?.value).toBe('a title');
  });

  /*
   * The guard covers a review with no prose fields too: exempt, `finalBody` would fall back to the
   * agent's text and the reviewer's rewrite would go missing.
   */

  const COMMENT = {
    destination: 'jira' as const,
    toolInput: { cloudId: 'c1', issueIdOrKey: 'K-1', commentBody: 'body\n' },
    toolName: 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue',
  };

  test('and a body-only review is covered too, not exempt for having no prose', async () => {
    const { surface } = stub({ action: 'approve', edited: false });
    const outcome = await runReview({ ...COMMENT, surface });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.denial?.outcome).toBe('unavailable');
    expect(outcome.updatedInput).toBeUndefined();
  });

  test('...and approves as usual once it reports the body it was shown', async () => {
    const { surface } = stub(approves('jira', 'body\n', { edited: false }));
    const outcome = await runReview({ ...COMMENT, surface });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.updatedInput!.commentBody).toBeDefined();
  });
});

/**
 * A plain body reaches the payload unconverted. `core/test/renderPlain.test.ts` asserts the render
 * says `preview-only` and `extraToolInput: {}`; were `wireBody` and `buildUpdatedInput` to look the
 * profile up themselves, a `--body-format plain` Jira review would send JSON-stringified text
 * stamped `contentFormat: "adf"`. So these assert the payload.
 */
describe('a plain body in the payload', () => {
  const JIRA_PLAIN = { cloudId: 'c1', issueIdOrKey: 'K-1', fields: { description: '## x\n**y**\n' } };

  /** One approved `editJiraIssue` review of the same body, at whichever format is being asked about. */
  const sent = async (bodyFormat?: 'markdown' | 'plain') => {
    const { surface } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'jira',
      toolInput: JIRA_PLAIN,
      toolName: 'mcp__x__editJiraIssue',
      surface,
      bodyField: 'fields.description',
      ...(bodyFormat ? { bodyFormat } : {}),
    });
    return outcome.updatedInput!;
  };

  test('is sent VERBATIM, not JSON-stringified', async () => {
    const fields = (await sent('plain')).fields as Record<string, unknown>;
    expect(fields.description).toBe('## x\n**y**\n');
  });

  test('is NOT stamped contentFormat, or Jira parses a plain string as ADF', async () => {
    expect(await sent('plain')).not.toHaveProperty('contentFormat');
  });

  test('and a MARKDOWN Jira review still converts and still stamps it', async () => {
    // The other half: plain must not work by turning the conversion off for everyone.
    const updated = await sent();
    expect(updated.contentFormat).toBe('adf');
    const fields = updated.fields as Record<string, unknown>;
    expect(JSON.parse(fields.description as string).type).toBe('doc');
  });

  test("ROUTE_FLAGS' `unchanged` is the value an ABSENT flag actually means", async () => {
    /*
     * `routeFlagArgs` passes no flag at the `unchanged` value, so that value claims what the far
     * end (`review.ts` calling `render`, not `renderPlain`) assumes from silence. Changing it to
     * `'plain'` would leave every other test green while plain-text routes stopped sending the flag.
     * The flag's own tests derive their expectation from the value under test; this compares
     * silence against the table's claim, and the other value against both.
     */
    const payload = async (bodyFormat?: 'markdown' | 'plain') =>
      JSON.stringify(await sent(bodyFormat));
    const spec = ROUTE_FLAGS.bodyFormat;
    expect(spec.kind).toBe('choice');
    if (spec.kind !== 'choice') return;
    const other = spec.values.find((v) => v !== spec.unchanged);
    expect(other, 'the choice has only one value, so nothing can be asserted').toBeDefined();

    const absent = await payload(undefined);
    expect(absent).toBe(await payload(spec.unchanged));
    expect(absent).not.toBe(await payload(other!));
  });

  test('wireBody and buildUpdatedInput read the RENDER, not the destination', () => {
    // A plain render of a `convert-and-replace` destination must behave as preview-only.
    const plain = renderPlain('text\n', 'jira');
    expect(wireBody(plain, plain.converted)).toBe('text\n');
    expect(buildUpdatedInput(plain, { commentBody: 'old' }, 'text\n')).not.toHaveProperty(
      'contentFormat'
    );

    const md = render('text\n', 'jira');
    expect(typeof wireBody(md, md.converted)).toBe('string');
    expect(buildUpdatedInput(md, { commentBody: 'old' }, 'x').contentFormat).toBe('adf');
  });
});

/*
 * A call that carries prose and no body: `issue_write` with a `title` and `method: "create"`.
 * Read as a missing body, the title would make `plausibleProseField` answer, and `decide.ts` would
 * take the schema-drift fail-open with nobody having read the title.
 */
describe('a payload whose body is absent and whose prose is not', () => {
  const ISSUE = { owner: 'Jakuboola', repo: 'draftgate', method: 'create', title: 'Export fails on empty tables' };
  const opts = {
    destination: 'github' as const,
    toolInput: ISSUE,
    proseFields: ['title'],
  };
  /** The window's ordinary shape: every field it was shown, reported with the value it showed. */
  const UNCHANGED = {
    action: 'approve' as const,
    edited: false,
    fields: { title: 'Export fails on empty tables' },
  };

  test('is REVIEWED, and the review carries the prose and no draft', async () => {
    const { surface, seen } = stub(UNCHANGED);
    const outcome = await runReview({ ...opts, surface });

    expect(outcome.exitCode).toBe(0);
    // The list is what says there is no draft: lines, and no block entry at all.
    expect(seen[0]!.fields).toEqual([
      { field: 'title', kind: 'line', value: 'Export fails on empty tables' },
    ]);
    // `renderNoBody`, so nothing about a body can be wrong and Approve is not dead.
    expect(seen[0]!.render.format).toBe('absent');
    expect(seen[0]!.render.blocked).toBe(false);
    expect(seen[0]!.render.warnings).toEqual([]);
  });

  // `writeBodyPath` would create the body field the agent omitted, under a human's approval.
  test('and the payload goes out with no body field invented', async () => {
    const { surface } = stub(UNCHANGED);
    const outcome = await runReview({ ...opts, surface });

    expect(outcome.updatedInput).toEqual(ISSUE);
    expect('body' in outcome.updatedInput!).toBe(false);
  });

  test('an edited title reaches the payload, and still no body', async () => {
    const { surface } = stub({
      action: 'approve', edited: true, fields: { title: 'Nightly export fails on empty tables' },
    });
    const outcome = await runReview({ ...opts, surface });

    expect(outcome.updatedInput).toEqual({ ...ISSUE, title: 'Nightly export fails on empty tables' });
    expect(outcome.edited).toBe(true);
  });

  test('a blanked title still blocks, because that is a probed 400 one field over', async () => {
    const { surface } = stub({ action: 'approve', edited: true, fields: { title: '   ' } });
    const outcome = await runReview({ ...opts, surface });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.denial!.outcome).toBe('rejected');
    expect(outcome.denial!.reason).toContain('title');
  });

  // No `before`, not an empty one: `before: ''` on an approval reads as "a human approved an empty
  // message", which `body/empty` makes impossible.
  test('and the log records no body rather than an empty one', async () => {
    const { surface } = stub(UNCHANGED);
    const outcome = await runReview({ ...opts, surface });

    expect('before' in outcome.audit).toBe(false);
    expect('after' in outcome.audit).toBe(false);
  });

  /*
   * Structural rather than guarded: the CLI walks the fields it showed. Were another read,
   * `writeBodyPath` would create the field the agent omitted. Unreachable through the real window.
   */
  test('a surface reporting a field nobody showed it has that entry dropped', async () => {
    const { surface } = stub({
      action: 'approve',
      edited: false,
      fields: { title: 'Export fails on empty tables', body: 'invented\n' },
    });
    const outcome = await runReview({ ...opts, surface });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.updatedInput).toEqual(ISSUE);
    expect('body' in outcome.updatedInput!).toBe(false);
  });

  /*
   * Schema drift still wins: an undeclared prose field may be a renamed body, and reviewing the
   * title while it goes out unseen would record a human approval of a message nobody read.
   */
  test('but an UNDECLARED prose field still reads as drift, and is not reviewed', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    const outcome = await runReview({
      ...opts,
      toolInput: { ...ISSUE, description: 'The nightly export job fails on empty tables.' },
      surface,
    });

    expect(seen).toEqual([]);
    expect(outcome.denial!.code).toBe('body/missing-field');
  });

  /*
   * The crash path reads the body as the live one does: `crashOutcome` calling `extractBody`
   * without the line fields would take the drift branch and log `before: ''`. Reached by a surface
   * that throws, since `render()` is never called for a body-less review.
   */
  test('and a CRASH on one logs no body either, rather than an empty one', async () => {
    const outcome = await runReview({
      ...opts,
      surface: {
        human: true,
        review: async () => {
          throw new Error('the window fell over');
        },
      },
    });

    expect(outcome.denial!.code).toBe('review/crashed');
    expect('before' in outcome.audit).toBe(false);
  });

  /*
   * The drift ordering holds for a nested body too: a renamed `fields.description` puts the prose
   * inside `fields`, so the scan looks in the body's own container as well as the root.
   */
  test('a renamed NESTED body is still drift, not a title-only review', async () => {
    const { surface, seen } = stub(approvesUnchanged);
    const outcome = await runReview({
      destination: 'jira',
      toolInput: {
        cloudId: '0a1b2c3d',
        issueIdOrKey: 'SUPPORT-1',
        fields: { summary: 'Export fails', body: 'The nightly export job fails on empty tables.' },
      },
      bodyField: 'fields.description',
      proseFields: ['fields.summary'],
      surface,
    });

    expect(seen).toEqual([]);
    expect(outcome.denial!.code).toBe('body/missing-field');
    // And the row quotes it: `loggedField` goes through `valueAtPath`.
    expect(outcome.audit.before).toBe('The nightly export job fails on empty tables.');
  });

  test('and a payload with neither is still unrecognised', async () => {
    const { surface } = stub(approvesUnchanged);
    const outcome = await runReview({
      ...opts,
      toolInput: { owner: 'Jakuboola', repo: 'draftgate', method: 'update', state: 'closed' },
      surface,
    });

    expect(outcome.denial!.code).toBe('body/unrecognised');
  });
});

/**
 * The context wildcard. draftgate edits prose and discloses everything else; a hand-kept list
 * cannot cover a free-form container like `editJiraIssue.fields`.
 */
describe('a context wildcard', () => {
  const EDIT = {
    cloudId: 'c1',
    issueIdOrKey: 'SUPPORT-1',
    fields: {
      summary: 'Export fails',
      description: 'the body',
      status: 'Open',
      labels: ['p2'],
      assignee: 'u1',
    },
  };

  test('expands a container to every key the payload actually has', () => {
    const out = extractContext('jira', EDIT, { contextFields: ['fields.*'], editable: [] });
    expect(Object.keys(out).filter((k) => k.startsWith('fields.')).sort()).toEqual([
      'fields.assignee', 'fields.description', 'fields.labels', 'fields.status', 'fields.summary',
    ]);
  });

  test('and EXCLUDES what the reviewer can edit, so nothing is drawn twice', () => {
    // Written against the editable set, not "the body", so a title input is not also disclosed as
    // a read-only copy that goes stale once typed in.
    const out = extractContext('jira', EDIT, { contextFields: ['fields.*'], editable: ['fields.description', 'fields.summary'] });
    expect(out).not.toHaveProperty('fields.description');
    expect(out).not.toHaveProperty('fields.summary');
    expect(out['fields.assignee']).toBe('u1');
  });

  test('a field the agent invents is disclosed with no config change', () => {
    // A route naming status and labels would hide `fields.assignee` when the agent sets it.

    const out = extractContext('jira', { fields: { invented: 'next month' } }, { contextFields: ['fields.*'] });
    expect(out['fields.invented']).toBe('next month');
  });

  test('a bare * discloses the top level, minus the body', () => {
    const out = extractContext(
      'slack', { channel_id: 'C1', message: 'hi', unusual: 'x' },
      { contextFields: ['*'], editable: ['message'] }
    );
    expect(out).toEqual({ channel_id: 'C1', unusual: 'x' });
  });

  test('an explicit name beside a wildcard is read once, in its own position', () => {
    const out = extractContext('jira', EDIT, { contextFields: ['fields.status', 'fields.*'], editable: ['fields.description'] });
    expect(Object.keys(out).filter((k) => k === 'fields.status')).toHaveLength(1);
    // First occurrence wins, so the explicitly named field keeps the place the operator gave it.
    const keys = Object.keys(out).filter((k) => k.startsWith('fields.'));
    expect(keys[0]).toBe('fields.status');
  });

  test('a container the payload does not have discloses nothing, and does not throw', () => {
    expect(extractContext('jira', { cloudId: 'c1' }, { contextFields: ['fields.*'] })).toEqual({ cloudId: 'c1' });
    // A non-object where a container was expected is the same answer: nothing to enumerate.
    expect(extractContext('jira', { fields: 'oops' }, { contextFields: ['fields.*'] })).toEqual({});
  });
});

/**
 * `ReviewOutcome.sent`: what a person's edit sent in place of the draft, which the agent is shown.
 * The body only when the person changed it: a body the editor reformatted differs from `canonical`
 * too, and a changed title makes `edited` true on its own.
 */
describe('what an edit sent, for the agent', () => {
  const opts = {
    destination: 'jira' as const,
    toolInput: { cloudId: 'c1', issueIdOrKey: 'K-1', fields: { summary: 'Update', description: 'Hello world\n' } },
    toolName: 'mcp__x__editJiraIssue',
    bodyField: 'fields.description',
    proseFields: ['fields.summary'],
  };
  const approve = (extra: Record<string, unknown>, description = 'Hello world', summary = 'Update') =>
    stub({ action: 'approve', fields: { 'fields.description': description, 'fields.summary': summary }, ...extra });

  test('a title-only edit beside a reformatted body sends the title and no body', async () => {
    const { surface } = approve({ edited: true, bodyEdited: false }, 'Hello world', 'Export fails on empty tables');
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).toBe(0);
    // The control: the body sent does differ from the draft, by the stripped newline.
    expect(outcome.audit.after).toBe('Hello world');
    expect(outcome.sent).toEqual({ lines: [{ field: 'fields.summary', value: 'Export fails on empty tables' }] });
  });

  test('a body the person changed is sent with any line they changed', async () => {
    const { surface } = approve({ edited: true, bodyEdited: true }, 'Hello there', 'New title');
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.sent).toEqual({
      body: 'Hello there',
      lines: [{ field: 'fields.summary', value: 'New title' }],
    });
  });

  test('a surface that does not say falls back to comparing the body', async () => {
    const { surface } = approve({ edited: true }, 'Hello there');
    expect((await runReview({ ...opts, surface })).sent).toEqual({ body: 'Hello there', lines: [] });
  });

  test('an unedited approval sends nothing for the agent, whatever normalisation did', async () => {
    const { surface } = approve({ edited: false, bodyEdited: false });
    const outcome = await runReview({ ...opts, surface });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.sent).toBeUndefined();
  });
});
