/**
 * The window surface's process and file handling (`cli/src/surfaces/window.ts`), through a real
 * child, the real `spawn`, and the real request and decision files: `fakeSurfaceApp.ts` stands in for
 * the window, nothing for the boundary. The cheap layer, the only one in `bun test` (see
 * `surface/harness/e2e.ts`'s header for the three).
 *
 * The claim: no path through this surface approves a message a human did not approve. A closed
 * window, a crash, a stale build, corrupt output, a timeout or a missing binary comes out as a
 * rejection, a timeout or `unavailable`.
 */

import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profiles, render, toEditorDoc } from '../../core/src/index';
import { toWireRequest, windowSurface } from '../src/surfaces/window';
import { REMEDY } from '../../core/src/remedies';
import {
  PROTOCOL_VERSION,
  parseWireDecision,
  MAX_APPLIED_FIXES,
  type WireRequest,
} from '../src/surfaces/windowProtocol';
import { until } from './releaseFixture';
import type { Decision, ReviewRequest } from '../src/types';
import type { ThemeStore } from '../src/themePreference';

const FAKE_APP = join(import.meta.dir, 'fixtures', 'fakeSurfaceApp.ts');

/**
 * The timeout tests' clock. The child writes `<marker>.ready` once its handlers are installed, and
 * its marker `MARKER_MS` later if it is still alive, which is past the deadline. Each kill test asserts the ready file, so its
 * child was up before the deadline's kill (a SIGTERM before the handler would kill even the child
 * that ignores it). The marker must be due before the check `CHECK_AFTER_MS` after the surface
 * resolves, or "the child is killed" passes with no kill at all; the positive control holds it to
 * that.
 */
const DEADLINE_MS = 500;
const MARKER_MS = 700;
const CHECK_AFTER_MS = 800;
process.env.DRAFTGATE_TEST_MARKER_MS = String(MARKER_MS);

/**
 * The reason off a decision, or a useful failure: a cast would assert on `undefined` for the wrong
 * variant and say nothing about what went wrong.
 */
function reasonOf(decision: Decision): string {
  if (!('reason' in decision) || typeof decision.reason !== 'string') {
    throw new Error(`expected a decision carrying a reason, got ${JSON.stringify(decision)}`);
  }
  return decision.reason;
}

/**
 * A surface wired to the fake app instead of the host. `bundle: null` skips the stale-build check,
 * tested in `surfaceBundle.test.ts`.
 */
function surfaceIn(mode: string, theme: ThemeStore = memoryThemes().store) {
  process.env.DRAFTGATE_TEST_MODE = mode;
  // Bun's own binary: a real executable, reached through the real spawn.
  return windowSurface(async () => ({ bin: process.execPath }), {
    appDir: FAKE_APP,
    bundle: null,
    // Never the reviewer's own file: a fake decision carrying a theme would otherwise be kept there.
    theme,
  });
}

/** A theme store in memory, and what was kept in it. */
function memoryThemes(read: ReturnType<ThemeStore['read']> = {}) {
  const kept: string[] = [];
  const store: ThemeStore = {
    read: () => read,
    keep: (t) => {
      kept.push(t);
      return null;
    },
  };
  return { store, kept };
}

const CANONICAL = 'See https://example.com for **details**.';

function requestFor(
  destination: 'jira' | 'slack' | 'linear' = 'jira',
  timeoutMs = 15_000,
  body = CANONICAL
): ReviewRequest {
  const rendered = render(body, destination);
  return {
    toolName: 'addCommentToJiraIssue',
    context: { cloudId: '0a1b2c3d', issueIdOrKey: 'SUPPORT-123' },
    // The route's plan with its values, which for a comment tool is one markdown field. Its value
    // is `rendered.canonical` because `render()` echoes its input -- see `ReviewFieldValue`.
    fields: [{ field: profiles[destination].bodyField, kind: 'markdown', value: rendered.canonical }],
    render: rendered,
    preview: (b) => render(b, destination),
    doc: (b) => toEditorDoc(b),
    timeoutMs,
  };
}

describe('decisions the window reports', () => {
  test('an unedited approval carries NO body', async () => {
    const decision = await surfaceIn('approve-unedited').review(requestFor());
    expect(decision).toEqual({ action: 'approve' });
    // `runReview` treats a present body as an edit and re-serialises it, and the bare URL in
    // CANONICAL would come back as [url](url). An unchanged approval sends the agent's exact bytes.
    expect('body' in decision).toBe(false);
  });

  test('an edited approval carries the edited body', async () => {
    const decision = await surfaceIn('approve-edited').review(requestFor());
    expect(decision).toEqual({
      action: 'approve',
      fields: { commentBody: 'Edited by the reviewer.' },
    });
  });

  test('a rejection carries the reason the reviewer typed', async () => {
    const decision = await surfaceIn('reject').review(requestFor());
    expect(decision).toEqual({ action: 'reject', reason: 'wrong ticket' });
  });

  test('a rejection with no reason is still a rejection', async () => {
    const decision = await surfaceIn('reject-no-reason').review(requestFor());
    expect(decision).toEqual({ action: 'reject', reason: undefined });
  });
});

describe('what the window is handed', () => {
  test('the request carries canonical markdown, context, tool and timeout', async () => {
    const decision = await surfaceIn('echo-request').review(requestFor('jira', 12_345));
    expect(decision.action).toBe('reject');
    const wire = JSON.parse(reasonOf(decision)) as WireRequest;

    expect(wire.protocol).toBe(PROTOCOL_VERSION);
    expect(wire.destination).toBe('jira');
    expect(wire.toolName).toBe('addCommentToJiraIssue');
    expect(wire.context).toEqual({ cloudId: '0a1b2c3d', issueIdOrKey: 'SUPPORT-123' });
    expect(wire.timeoutMs).toBe(12_345);

    // The agent's markdown, byte for byte, as the plan's block field with its `kind`; the window
    // runs `core` itself for everything else.
    expect(wire.fields).toEqual([
      { field: 'commentBody', kind: 'markdown', value: CANONICAL },
    ]);
  });

  test('the request is data only: no functions survive serialisation', async () => {
    const decision = await surfaceIn('echo-request').review(requestFor('slack'));
    const wire = JSON.parse(reasonOf(decision));
    // `preview` and `doc` are bound functions on ReviewRequest and cannot cross a process boundary.
    expect(Object.keys(wire).sort()).toEqual(
      ['context', 'destination', 'fields', 'protocol', 'timeoutMs', 'toolName'].sort()
    );
  });
});

/*
 * The reviewer's theme between reviews: the WebKit host's storage does not survive a relaunch, so
 * the surface reads the remembered one into the request and keeps a new one from the decision,
 * beside `window.json`, which `runReview` never sees.
 */
describe('the theme the reviewer chose', () => {
  test('an approval keeps it, and so does a rejection', async () => {
    const approving = memoryThemes();
    await surfaceIn('approve-choosing-dark', approving.store).review(requestFor());
    expect(approving.kept).toEqual(['dark']);
    const rejecting = memoryThemes();
    await surfaceIn('reject-choosing-light', rejecting.store).review(requestFor());
    expect(rejecting.kept).toEqual(['light']);
  });

  test('nothing is kept when nothing was chosen, nobody was there, or it is the one remembered', async () => {
    const none = memoryThemes();
    await surfaceIn('approve-unedited', none.store).review(requestFor());
    await surfaceIn('close-without-decision', none.store).review(requestFor());
    expect(none.kept).toEqual([]);
    const same = memoryThemes({ theme: 'dark' });
    await surfaceIn('approve-choosing-dark', same.store).review(requestFor());
    expect(same.kept).toEqual([]);
  });

  test('the remembered one reaches the window, and absent stays absent', async () => {
    const wireOf = async (store: ThemeStore) =>
      JSON.parse(reasonOf(await surfaceIn('echo-request', store).review(requestFor()))) as WireRequest;
    expect((await wireOf(memoryThemes({ theme: 'dark' }).store)).rememberedTheme).toBe('dark');
    expect('rememberedTheme' in (await wireOf(memoryThemes().store))).toBe(false);
    // A broken file is no theme, and the review goes ahead: the problem is only said.
    expect('rememberedTheme' in (await wireOf(memoryThemes({ problem: 'x is not valid JSON' }).store))).toBe(false);
  });
});

describe('failing closed', () => {
  // Closing the window is a decision, so it alone maps to `reject`. Everything else here is the
  // tool being broken, which must not reach the agent as editorial feedback ("revise and try once").
  test('closing the window without deciding is a rejection', async () => {
    const decision = await surfaceIn('close-without-decision').review(requestFor());
    expect(decision.action).toBe('reject');
    expect(reasonOf(decision)).toContain('closed without a decision');
  });

  test('a crashed window is UNAVAILABLE, and quotes what it said', async () => {
    const decision = await surfaceIn('crash').review(requestFor());
    expect(decision.action).toBe('unavailable');
    const reason = reasonOf(decision);
    expect(reason).toContain('exited with code 3');
    // The stderr tail is read from a pipe that drains asynchronously, hence 'close' not 'exit'.
    expect(reason).toContain('something went badly wrong');
    // A crash is not a stale build, so it is not told to rebuild.
    expect(reason).not.toContain('build:surface');
  });

  test('a decision from a stale build is refused, not guessed at', async () => {
    const decision = await surfaceIn('bad-protocol').review(requestFor());
    expect(decision.action).toBe('unavailable');
    const reason = reasonOf(decision);
    expect(reason).toContain(`protocol ${PROTOCOL_VERSION}`);
    expect(reason).toContain('build:surface');
  });

  test('unparseable output is unavailable', async () => {
    const decision = await surfaceIn('garbage').review(requestFor());
    expect(decision.action).toBe('unavailable');
  });

  test('an approval with a non-string body is refused outright', async () => {
    // Not downgraded to an unedited approval: "send the original" would send text nobody chose.
    const decision = await surfaceIn('malformed-approve').review(requestFor());
    expect(decision.action).toBe('unavailable');
  });

  test('a binary that cannot be had is unavailable, with its own reason, and nothing is spawned', async () => {
    let spawned = false;
    const surface = windowSurface(async () => ({ refusal: `the host could not be built. Run ${REMEDY.doctor}.` }), {
      appDir: FAKE_APP,
      bundle: null,
      theme: { read: () => ((spawned = true), {}), keep: () => null },
    });
    const decision = await surface.review(requestFor());
    expect(decision.action).toBe('unavailable');
    expect(reasonOf(decision)).toContain(REMEDY.doctor);
    // The theme is read only when a window is about to open, so nothing got that far.
    expect(spawned).toBe(false);
  });
});

describe('timeout', () => {
  /**
   * Run a mode that outlives the deadline, and prove the child is gone afterwards. The marker
   * separates "killed" from "abandoned and still up"; the surface deletes its own temp directory,
   * so it lives somewhere the test owns.
   */
  async function expectKilled(mode: string) {
    const scratch = mkdtempSync(join(tmpdir(), 'draftgate-timeout-test-'));
    const marker = join(scratch, 'survived');
    process.env.DRAFTGATE_TEST_MARKER = marker;
    try {
      const started = Date.now();
      const decision = await surfaceIn(mode).review(requestFor('jira', DEADLINE_MS));
      const elapsed = Date.now() - started;

      expect(decision).toEqual({ action: 'timeout' });
      expect(elapsed).toBeLessThan(DEADLINE_MS + CHECK_AFTER_MS);
      expect(existsSync(`${marker}.ready`), 'the child was not up before the deadline').toBe(true);

      await new Promise((r) => setTimeout(r, CHECK_AFTER_MS));
      expect(
        existsSync(marker),
        'the child was still alive after the surface resolved: it wrote its survival marker, so ' +
          'the review was denied while the window stayed on the reviewer\'s screen'
      ).toBe(false);
    } finally {
      delete process.env.DRAFTGATE_TEST_MARKER;
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  test('a window left open times out AND the child is actually killed', async () => {
    // The surface owns the timer because it owns the child: `runReview`'s race can abandon the
    // promise but not reach the process.
    await expectKilled('hang');
  }, 15_000);

  test('a window that IGNORES SIGTERM is killed anyway, and at once', async () => {
    // The kill is complete before the surface resolves: `main.ts` exits the moment an outcome
    // exists, so anything deferred never happens. Hence SIGKILL with no ladder.
    await expectKilled('hang-ignoring-sigterm');
  }, 20_000);

  /**
   * The positive control for the two tests above, which assert a file does not exist: a marker
   * written too late, a broken fixture write or a dropped env var makes them pass measuring nothing.
   * This runs the same fixture with nobody killing it and requires the marker within the wait those
   * tests give it after their child is ready.
   */
  test('a child nobody kills DOES write the marker, inside the window the tests wait', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'draftgate-timeout-control-'));
    const marker = join(scratch, 'survived');
    const child = spawn(process.execPath, [FAKE_APP], {
      env: {
        ...process.env,
        DRAFTGATE_TEST_MODE: 'hang-ignoring-sigterm',
        DRAFTGATE_TEST_MARKER: marker,
        // The fake writes a decision file and needs somewhere to put it; nothing reads it here.
        DRAFTGATE_REQUEST: join(scratch, 'request.json'),
        DRAFTGATE_DECISION: join(scratch, 'decision.json'),
      },
      stdio: 'ignore',
    });
    try {
      await until(() => existsSync(`${marker}.ready`) || undefined, 10_000, 'the child to be ready');
      await until(
        () => existsSync(marker) || undefined,
        CHECK_AFTER_MS,
        'the marker before the tests above look (without it both timeout tests assert nothing)'
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 15_000);

});

describe('parseWireDecision', () => {
  test('accepts the two legal shapes', () => {
    expect(parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve' })).toEqual({
      protocol: PROTOCOL_VERSION,
      action: 'approve',
    });
    expect(parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', fields: { commentBody: 'x' } })).toEqual({
      protocol: PROTOCOL_VERSION,
      action: 'approve',
      fields: { commentBody: 'x' },
    });
    expect(parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'reject', reason: 'no' })).toEqual({
      protocol: PROTOCOL_VERSION,
      action: 'reject',
      reason: 'no',
    });
  });

  test('null is preserved as absent, not as a body', () => {
    // JSON has no `undefined`; null read as a body would send "null" as the message.
    expect(parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', fields: null })).toEqual({
      protocol: PROTOCOL_VERSION,
      action: 'approve',
    });
  });

  /**
   * The classification the reviewer offered, checked rather than trusted: the renderer displays
   * agent-authored content. A misshapen one is dropped, never a reason to refuse the decision (see
   * `parseAppliedFixes`). It names a destination and a value, never a target: the CLI applies it to
   * the cloud id and key it parsed from the payload.
   */
  describe('the target classification it reports', () => {
    const parsed = (extra: Record<string, unknown>) =>
      parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', ...extra });
    const said = (destination: string, value: string) => ({ classifyProject: { destination, value } });

    test("a value from the named destination's own vocabulary is kept", () => {
      expect(parsed(said('jira', 'service_desk'))?.classifyProject).toEqual({
        destination: 'jira',
        value: 'service_desk',
      });
      expect(parsed(said('github', 'internal'))?.classifyProject).toEqual({
        destination: 'github',
        value: 'internal',
      });
    });

    test('and it rides a REJECTION too', () => {
      const d = parseWireDecision({
        protocol: PROTOCOL_VERSION,
        action: 'reject',
        reason: 'no',
        ...said('jira', 'service_desk'),
      });
      expect(d).toEqual({
        protocol: PROTOCOL_VERSION,
        action: 'reject',
        reason: 'no',
        classifyProject: { destination: 'jira', value: 'service_desk' },
      });
    });

    /**
     * Every shape the wire must refuse, each row with its reason, and one pair of assertions for all:
     * dropped, and the approval still standing.
     */
    const REFUSED: { what: string; classifyProject: unknown }[] = [
      // Why the destination is on the wire: each is checked against the vocabulary of the profile
      // it names, where one merged list would accept both.
      { what: "a GitHub visibility claiming to be Jira's", classifyProject: said('jira', 'public') },
      {
        what: "a Jira project type claiming to be GitHub's",
        classifyProject: said('github', 'service_desk'),
      },
      // Jira's config vocabulary (`jira:projects` writes `business`), which a reviewer is never
      // offered. Fails if `reviewerAnswers` is widened to `JIRA_PROJECT_TYPES`.
      { what: 'a config-only Jira project type', classifyProject: said('jira', 'business') },
      // `isKnownDestination`, not `in`: `toString` and `constructor` are `in` a plain object.
      ...['confluence', 'toString', 'constructor', '__proto__', ''].map((destination) => ({
        what: `the destination "${destination}", which this build has no profile for`,
        classifyProject: said(destination, 'service_desk'),
      })),
      // The bare string is what a renderer before protocol 3 sends. Atlassian's values are
      // lower-case, so `SERVICE_DESK` would be a value the config reader rejects.
      ...[
        'service_desk',
        { destination: 'jira', value: 'SERVICE_DESK' },
        { destination: 'jira', value: '' },
        { destination: 'jira' },
        { value: 'service_desk' },
        { destination: 'jira', value: ['software'] },
        { destination: ['jira'], value: 'software' },
        true,
        42,
        null,
        {},
        ['software'],
      ].map((classifyProject) => ({
        what: `the malformed answer ${JSON.stringify(classifyProject) ?? 'undefined'}`,
        classifyProject,
      })),
    ];

    test.each(REFUSED)('$what is dropped, and the decision still stands', ({ classifyProject }) => {
      const d = parsed({ classifyProject });
      expect(d, 'a malformed classification withdrew the approval').not.toBeNull();
      expect('classifyProject' in d!, 'it was let through').toBe(false);
    });

    test('an extra key on the answer does not travel with it', () => {
      // The answer is rebuilt from its two fields rather than forwarded.
      const d = parsed({
        classifyProject: { destination: 'jira', value: 'software', about: 'SUPPORT-1' },
      });
      expect(d?.classifyProject).toEqual({ destination: 'jira', value: 'software' });
    });

    test('absent leaves the key OFF, so nothing is remembered', () => {
      const d = parsed({});
      expect('classifyProject' in d!).toBe(false);
    });
  });

  describe('the accepted repairs it reports, for the audit log', () => {
    test('an approval carries them through, empty array included', () => {
      // `[]` says "I can report repairs and none were accepted": an edit is then a rewrite.
      expect(parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', fixes: [] })).toEqual({
        protocol: PROTOCOL_VERSION,
        action: 'approve',
        fixes: [],
      });
      expect(
        parseWireDecision({
          protocol: PROTOCOL_VERSION,
          action: 'approve',
          fields: { commentBody: 'x' },
          fixes: [{ code: 'slack/url-swallows-next-line', label: 'Write an explicit link' }],
        })
      ).toEqual({
        protocol: PROTOCOL_VERSION,
        action: 'approve',
        fields: { commentBody: 'x' },
        fixes: [{ code: 'slack/url-swallows-next-line', label: 'Write an explicit link' }],
      });
    });

    test('a window that reports nothing leaves the key OFF, which means unknown', () => {
      // A build that does not report repairs: absent must not become `[]`.
      const d = parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', fields: { commentBody: 'x' } })!;
      expect('fixes' in d).toBe(false);
    });

    test('a malformed `fixes` NEVER withdraws the approval', () => {
      // `fixes` is audit metadata: a human's approval is not withdrawn over it. `body` and
      // `protocol` refuse because they are the decision.
      for (const bad of ['nope', 42, {}, null]) {
        const d = parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', fields: { commentBody: 'x' }, fixes: bad });
        expect(d).not.toBeNull();
        expect(d!.action).toBe('approve');
        expect('fixes' in d!).toBe(false);
      }
    });

    test('a bad entry is dropped, and the rest survive', () => {
      const d = parseWireDecision({
        protocol: PROTOCOL_VERSION,
        action: 'approve',
        fixes: [
          { code: 'a/b', label: 'keep' },
          { code: 'a/b' }, // no label
          { label: 'no code' },
          { code: '', label: 'empty code' },
          { code: 'x'.repeat(201), label: 'too long' },
          'not an object',
          null,
          { code: 'c/d', label: 'keep too', extra: 'ignored' },
        ],
      });
      expect(d).toEqual({
        protocol: PROTOCOL_VERSION,
        action: 'approve',
        fixes: [
          { code: 'a/b', label: 'keep' },
          { code: 'c/d', label: 'keep too' },
        ],
      });
    });

    test('an array that yields NOTHING valid is unknown, not "none accepted"', () => {
      // `[]` is a positive claim, so a drifted fix shape would log every clicked repair as a hand
      // rewrite. Degradation belongs on the unknown side; a mixed array keeps its valid entries.
      const d = parseWireDecision({
        protocol: PROTOCOL_VERSION,
        action: 'approve',
        fields: { commentBody: 'x' },
        fixes: [{ id: 'a/b', title: 'drifted' }, { id: 'c/d', title: 'also drifted' }],
      })!;
      expect(d).not.toBeNull();
      expect('fixes' in d).toBe(false);
    });

    test('the array is capped, so the renderer cannot write an unbounded log line', () => {
      const many = Array.from({ length: 200 }, (_, i) => ({ code: `c/${i}`, label: 'x' }));
      const d = parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', fixes: many })!;
      expect(d.action === 'approve' && d.fixes!.length).toBe(MAX_APPLIED_FIXES);
    });

    test('a rejection has no repairs, however hard it insists', () => {
      expect(
        parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'reject', reason: 'no', fixes: [{ code: 'a/b', label: 'x' }] })
      ).toEqual({ protocol: PROTOCOL_VERSION, action: 'reject', reason: 'no' });
    });
  });

  test('rejects everything else', () => {
    for (const bad of [
      null,
      undefined,
      'approve',
      42,
      [],
      {},
      { action: 'approve' }, // no protocol
      { protocol: 0, action: 'approve' },
      { protocol: PROTOCOL_VERSION, action: 'send' },
      // A malformed entry refuses the whole decision: dropping it would send the agent's text under
      // the reviewer's approval.
      { protocol: PROTOCOL_VERSION, action: 'approve', fields: { commentBody: 7 } },
      { protocol: PROTOCOL_VERSION, action: 'approve', fields: { '': 'x' } },
      { protocol: PROTOCOL_VERSION, action: 'reject', reason: {} },
    ]) {
      expect(parseWireDecision(bad)).toBeNull();
    }
  });

  /*
   * A `fields` that is not an object reads as "did not report", not as a refusal: a misshapen
   * container is the unknown side, caught by `staleSurfaceDenial` in `cli/src/review.ts`.
   */
  test('and a misshapen `fields` reads as "did not report" rather than refusing', () => {
    for (const fields of [7, 'x', [], null]) {
      const read = parseWireDecision({ protocol: PROTOCOL_VERSION, action: 'approve', fields });
      expect(read).toEqual({ protocol: PROTOCOL_VERSION, action: 'approve' });
    }
  });
});

/**
 * Every optional field the CLI computes has to cross onto the wire. `toWireRequest` is a hand-built
 * literal in a blind spot: `runReview`'s tests assert the `ReviewRequest`, and `window.test.tsx` and
 * `probe.ts` build a `WireRequest` by hand, so deleting the `destinationLabel` spread is caught only
 * here. Required fields need no table: omitting one stops the file compiling.
 */
describe('toWireRequest carries every optional field', () => {
  const base = () => {
    const rendered = render('hi\n', 'jira');
    return {
      context: { cloudId: 'c1', issueIdOrKey: 'SUPPORT-1' },
      fields: [{ field: 'commentBody', kind: 'markdown' as const, value: rendered.canonical }],
      render: rendered,
      preview: (body: string) => render(body, 'jira'),
      doc: (body: string) => toEditorDoc(body),
      timeoutMs: 600_000,
    };
  };

  const OPTIONAL = [
    { field: 'toolName', value: 'mcp__x__addCommentToJiraIssue' },
    { field: 'destinationLabel', value: 'acme-dev.atlassian.net / SUPPORT-1' },
    {
      field: 'audience',
      value: { kind: 'public' as const, label: 'Reply to customer', detail: 'seen in the portal' },
    },
    // The routing was a guess from the tool name; without it the review looks certain when it is
    // not. Its name and shape change on the way over: `inferredFrom` (a bare name) on the request,
    // `routeInferred` (an object) on the wire.
    {
      field: 'inferredFrom',
      wireField: 'routeInferred',
      value: 'mcp__claude_ai_Slack__slack_send_message',
      wireValue: { matchedEntry: 'mcp__claude_ai_Slack__slack_send_message' },
    },
  ];

  test.each(OPTIONAL)('$field crosses', (row) => {
    const { field, value } = row;
    const wire = toWireRequest({ ...base(), [field]: value } as never);
    const wireField = ('wireField' in row ? row.wireField : field) as keyof typeof wire;
    const expected = 'wireValue' in row ? row.wireValue : value;
    expect(wire[wireField]).toEqual(expected as never);
  });

  // `fields` is required on both sides, so not in the table; this pins that it crosses unprojected:
  // every entry, in order, `kind` included.
  test('every field crosses, in order, with its kind', () => {
    const fields = [
      { field: 'fields.summary', kind: 'line' as const, value: 'Export fails on empty tables' },
      { field: 'fields.description', kind: 'markdown' as const, value: 'hi\n' },
    ];
    expect(toWireRequest({ ...base(), fields } as never).fields).toEqual(fields);
  });

  test('and an absent one stays ABSENT rather than becoming a null', () => {
    // A stale renderer must tell "not supplied" from "supplied as nothing". Asserted on the
    // serialised form `window.ts` writes: in memory `toolName` is present-as-undefined.
    const wire = JSON.parse(JSON.stringify(toWireRequest(base() as never)));
    for (const { field } of OPTIONAL) expect(field in wire).toBe(false);
  });
});
