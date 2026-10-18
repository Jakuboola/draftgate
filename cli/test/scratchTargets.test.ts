/**
 * The scratch-target filter: what the digest holds apart, and what it refuses to. Not
 * `scratch.test.ts` (the payload's temp directory). Mostly degradation: an exclusion that silently
 * does nothing, or too much, changes the digest's headline numbers with no visible cause.
 */
import { describe, expect, test } from 'bun:test';
import {
  isScratch,
  parseScratchList,
  SCRATCH_VERSION,
  type ScratchTarget,
} from '../src/scratchTargets';
import { buildDigest, formatDigest, parseAuditLog, type AuditEntry } from '../src/digest';
import { profiles, type TargetIdentity } from '../../core/src/index';

const SRC = '/tmp/scratch.json';
const parse = (v: unknown) => parseScratchList(JSON.stringify(v), SRC);
const ok = (targets: unknown[]) => parse({ version: SCRATCH_VERSION, targets });

describe('parseScratchList', () => {
  test('reads a well-formed file', () => {
    const r = ok([
      { destination: 'slack', context: { channel_id: 'U07' }, why: 'self-DM' },
      { destination: 'jira', context: { cloudId: 'c1', issueIdOrKey: 'SUPPORT-1' } },
    ]);
    expect(r.problem).toBeUndefined();
    expect(r.present).toBe(true);
    expect(r.targets).toEqual([
      { destination: 'slack', context: { channel_id: 'U07' }, why: 'self-DM' },
      { destination: 'jira', context: { cloudId: 'c1', issueIdOrKey: 'SUPPORT-1' } },
    ]);
  });

  test('a jira target with no cloudId is REFUSED and named', () => {
    // `SUPPORT-123` can be a scratch issue on a dev site and a customer ticket on production, so a
    // target keyed on the issue key alone would move a real approval out of the headline counts.
    const r = ok([{ destination: 'jira', context: { issueIdOrKey: 'SUPPORT-123' } }]);
    expect(r.targets).toEqual([]);
    expect(r.problem).toContain('no "cloudId"');
    expect(r.problem).toContain('production');
  });

  test('every profile that requires fields has them enforced, derived from the profiles', () => {
    // `requiredFields` comes from `DestinationProfile.targetIdentity`, so a fifth destination that
    // needs a qualifier is enforced the day it declares one.
    for (const [name, profile] of Object.entries(profiles)) {
      // Annotated because `profiles` keeps each literal's narrow type, so the union of four
      // `targetIdentity` shapes has no common `ambiguity`.
      const { requiredFields, ambiguity }: TargetIdentity = profile.targetIdentity;
      if (requiredFields.length === 0) continue;
      expect(ambiguity, `${name} requires fields but explains nothing`).toBeTruthy();
      for (const field of requiredFields) {
        // Everything required except this one: supplying neither `owner` nor `repo` passes as long
        // as some check exists, which proves nothing about either field.
        const context = Object.fromEntries(
          requiredFields.filter((f) => f !== field).map((f) => [f, 'x'])
        );
        const r = ok([{ destination: name, context: { ...context, other: 'y' } }]);
        expect(r.targets, `${name} accepted a target with no "${field}"`).toEqual([]);
        expect(r.problem).toContain(`"${field}"`);
        expect(r.problem).toContain(ambiguity!);
      }
    }
  });

  test('a target naming a destination this build does not know is REFUSED', () => {
    // An audit row's destination comes from the same closed set, so it could never match.
    const r = ok([{ destination: 'jria', context: { cloudId: 'c1' } }]);
    expect(r.targets).toEqual([]);
    expect(r.problem).toContain('"jria"');
    expect(r.problem).toContain('could never match');
  });

  test('...and the same rule does not apply to the other two destinations', () => {
    // Neither Slack nor Linear has two instances of one identifier in this installation, and
    // requiring a field they do not carry would refuse every honest declaration.
    const r = ok([
      { destination: 'slack', context: { channel_id: 'U07' } },
      { destination: 'linear', context: { issueId: 'HELP-42' } },
    ]);
    expect(r.problem).toBeUndefined();
    expect(r.targets).toHaveLength(2);
  });

  test('an empty context is refused, because it would match everything', () => {
    const r = ok([{ destination: 'slack', context: {} }]);
    expect(r.targets).toEqual([]);
    expect(r.problem).toContain('would match every slack review');
  });

  test('a non-string context value is refused rather than left to never match', () => {
    // It would compare unequal to the log's own string forever, and say nothing.
    const r = ok([{ destination: 'slack', context: { channel_id: 12345 } }]);
    expect(r.targets).toEqual([]);
    expect(r.problem).toContain('is not a string');
  });

  test('a context key named like an internal flag is just a key', () => {
    // The parser keeps no sentinel inside the object it validates.
    const r = ok([{ destination: 'slack', context: { __invalid: 'x' } }]);
    expect(r.problem).toBeUndefined();
    expect(r.targets).toEqual([{ destination: 'slack', context: { __invalid: 'x' } }]);
  });

  test('one bad target costs that target, not the file', () => {
    const r = ok([
      { destination: 'slack', context: { channel_id: 'U07' } },
      { destination: 'jira', context: { issueIdOrKey: 'X-1' } },
      { destination: 'linear', context: { issueId: 'HELP-42' } },
    ]);
    expect(r.targets.map((t) => t.destination)).toEqual(['slack', 'linear']);
    expect(r.problem).toContain('targets[1]');
  });

  test('every whole-file degradation is named and yields no targets', () => {
    for (const [label, text] of [
      ['not JSON', '{oh no'],
      ['not an object', '[]'],
      ['wrong version', JSON.stringify({ version: 99, targets: [] })],
      ['no targets array', JSON.stringify({ version: SCRATCH_VERSION })],
    ] as const) {
      const r = parseScratchList(text, SRC);
      expect(r.targets, label).toEqual([]);
      expect(r.present, label).toBe(true);
      expect(r.problem, label).toContain(SRC);
    }
  });

  test('a file that declares nothing is not a problem', () => {
    const r = ok([]);
    expect(r.problem).toBeUndefined();
    expect(r.targets).toEqual([]);
  });
});

describe('isScratch', () => {
  const targets: ScratchTarget[] = [
    { destination: 'slack', context: { channel_id: 'U07' } },
    { destination: 'jira', context: { cloudId: 'dev', issueIdOrKey: 'SUPPORT-123' } },
  ];

  test('matches on a subset of the context, so a thread in a scratch channel matches', () => {
    expect(isScratch(targets, 'slack', { channel_id: 'U07', thread_ts: '1.2' })).toBe(true);
  });

  test('EVERY declared field must match', () => {
    // The production trap, as an assertion: the same issue key on the other site is not scratch.
    expect(isScratch(targets, 'jira', { cloudId: 'dev', issueIdOrKey: 'SUPPORT-123' })).toBe(true);
    expect(isScratch(targets, 'jira', { cloudId: 'prod', issueIdOrKey: 'SUPPORT-123' })).toBe(false);
  });

  test('the destination must match too', () => {
    expect(isScratch(targets, 'linear', { channel_id: 'U07' })).toBe(false);
  });

  test('no targets, no missing context, nothing matches and nothing throws', () => {
    expect(isScratch([], 'slack', { channel_id: 'U07' })).toBe(false);
    expect(isScratch(targets, 'slack', undefined)).toBe(false);
    expect(isScratch(targets, 'slack', {})).toBe(false);
  });

  /*
   * GitHub's two halves are matched case-insensitively, and nothing else is (`githubRepoKey`). A
   * target declared `Jakuboola/draftgate` would otherwise miss a payload spelled
   * `jakuboola/draftgate`, and that review would land in the real digest numbers.
   */
  const gh: ScratchTarget[] = [
    { destination: 'github', context: { owner: 'Jakuboola', repo: 'draftgate' } },
  ];

  test('a repository matches whichever way either side spelled it', () => {
    expect(isScratch(gh, 'github', { owner: 'jakuboola', repo: 'DRAFTGATE' })).toBe(true);
    expect(isScratch(gh, 'github', { owner: 'Jakuboola', repo: 'draftgate' })).toBe(true);
  });

  test('and a DIFFERENT repository still does not', () => {
    // Erring this way counts real reviews as scratch.
    expect(isScratch(gh, 'github', { owner: 'jakuboola', repo: 'other' })).toBe(false);
    expect(isScratch(gh, 'github', { owner: 'someone-else', repo: 'draftgate' })).toBe(false);
  });

  test('the loosening is GitHub-only: Slack and Jira ids stay case-SENSITIVE', () => {
    // `C1` and `c1` are different Slack channels and `SUPPORT-1` is not `support-1`.
    expect(isScratch(targets, 'slack', { channel_id: 'u07' })).toBe(false);
    expect(isScratch(targets, 'jira', { cloudId: 'DEV', issueIdOrKey: 'SUPPORT-123' })).toBe(false);
  });

  test('a non-string value cannot match a declared name', () => {
    expect(isScratch(gh, 'github', { owner: 42, repo: 'draftgate' })).toBe(false);
  });
});

describe('the digest holds scratch reviews apart without hiding them', () => {
  const entry = (over: Partial<AuditEntry>): AuditEntry =>
    ({
      ts: '2026-09-10T00:00:00.000Z',
      destination: 'slack',
      context: {},
      outcome: 'approved',
      edited: false,
      before: 'b',
      warnings: [],
      fixes: [],
      ...over,
    }) as AuditEntry;

  const log = (entries: AuditEntry[]) =>
    parseAuditLog(entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const REAL = { channel_id: 'CREAL' };
  const SCRATCH = { channel_id: 'U07' };
  const targets: ScratchTarget[] = [{ destination: 'slack', context: { channel_id: 'U07' } }];

  test('the headline counts only the real ones, and the scratch ones are still reported', () => {
    const d = buildDigest(
      log([
        entry({ context: REAL }),
        entry({ context: SCRATCH }),
        entry({ context: SCRATCH, outcome: 'rejected' }),
      ]),
      { limit: 10, scratch: targets }
    );
    expect(d.totals.reviews).toBe(1);
    expect(d.scratch.applied).toBe(true);
    if (!d.scratch.applied) throw new Error('unreachable');
    expect(d.scratch.reviews).toBe(2);
    expect(d.scratch.destinations[0]?.rejected).toBe(1);
    // Nothing is lost: every review is in exactly one of the two buckets.
    expect(d.totals.reviews + d.scratch.reviews).toBe(3);
  });

  test('the printed line does not claim the scratch rows are BOTH counted and not counted', () => {
    // "N of these went to a scratch target ... not counted above" says the rows are part of the
    // headline and are not, so a reader subtracts twice. Asserted on the wording: the arithmetic is
    // right either way.
    const text = formatDigest(
      buildDigest(log([entry({ context: REAL }), entry({ context: SCRATCH })]), {
        limit: 10,
        scratch: targets,
      }),
      '/tmp/audit.jsonl'
    );
    expect(text).toContain('1 review(s)');
    expect(text).toContain('1 other review(s) went to a scratch target');
    expect(text).not.toContain('of these went to a scratch target');
  });

  test('the span still covers the whole window, filtered or not', () => {
    // A reader comparing the span with a clock must not see it shrink because a filter applied.
    const d = buildDigest(
      log([
        entry({ ts: '2026-09-01T00:00:00.000Z', context: SCRATCH }),
        entry({ ts: '2026-09-05T00:00:00.000Z', context: REAL }),
      ]),
      { limit: 10, scratch: targets }
    );
    expect(d.firstTs).toBe('2026-09-01T00:00:00.000Z');
    expect(d.lastTs).toBe('2026-09-05T00:00:00.000Z');
  });

  test('warnings, repairs and edits come only from the real bucket', () => {
    const d = buildDigest(
      log([
        entry({ context: SCRATCH, warnings: ['slack/url-label-elided'], edited: true, after: 'x' }),
        entry({ context: REAL, warnings: ['body/empty'] }),
      ]),
      { limit: 10, scratch: targets }
    );
    expect(d.warnings.map((w) => w.code)).toEqual(['body/empty']);
    expect(d.edits).toEqual([]);
    expect(d.editsTotal).toBe(0);
  });

  test('a filter that matches nothing still reports itself, because that is the mis-declared case', () => {
    const d = buildDigest(log([entry({ context: REAL })]), { limit: 10, scratch: targets });
    expect(d.scratch).toEqual({ applied: true, reviews: 0, destinations: [], targets: 1 });
  });

  test('the two ways of NOT filtering are told apart, because they read differently', () => {
    // "Nothing declared" tells the reader the mechanism exists; "you asked for one bucket" must not.
    const entries = log([entry({ context: REAL }), entry({ context: SCRATCH })]);
    expect(buildDigest(entries, { limit: 10 }).scratch).toEqual({
      applied: false,
      why: 'none-declared',
    });
    expect(buildDigest(entries, { limit: 10, scratch: [] }).scratch).toEqual({
      applied: false,
      why: 'none-declared',
    });
    const asked = buildDigest(entries, { limit: 10, scratch: targets, includeScratch: true });
    expect(asked.scratch).toEqual({ applied: false, why: 'requested' });
    // ...and asking means the scratch review really is counted in the headline.
    expect(asked.totals.reviews).toBe(2);
  });
});

/**
 * The log counts review events. Eight reviews can be four messages (reject-then-approve,
 * timeout-then-approve, reject-reject-approve, one clean approval), so "4 approved of 8" reads as a
 * 50% approval rate for messages that all went out. Nothing in the log carries a message identity:
 * `reviews` is the upper bound and conversations the lower.
 */
describe('conversations bracket the number of messages', () => {
  const entry = (over: Partial<AuditEntry>): AuditEntry =>
    ({
      ts: '2026-09-10T00:00:00.000Z',
      destination: 'slack',
      context: {},
      outcome: 'approved',
      edited: false,
      before: 'b',
      warnings: [],
      fixes: [],
      ...over,
    }) as AuditEntry;
  const log = (entries: AuditEntry[]) =>
    parseAuditLog(entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const digest = (entries: AuditEntry[]) => buildDigest(log(entries), { limit: 0 });

  test('a retried draft is many reviews and ONE conversation', () => {
    // The common retry: rejected, then the same draft approved after an edit.
    const d = digest([
      entry({ context: { channel_id: 'C1' }, outcome: 'rejected' }),
      entry({ context: { channel_id: 'C1' }, outcome: 'approved', edited: true, after: 'x' }),
    ]);
    expect(d.totals.reviews).toBe(2);
    expect(d.totals.conversations).toBe(1);
  });

  test('a thread is its own conversation, and the same thread is not two', () => {
    const d = digest([
      entry({ context: { channel_id: 'C1' } }),
      entry({ context: { channel_id: 'C1', thread_ts: '1.1' } }),
      entry({ context: { channel_id: 'C1', thread_ts: '1.1' } }),
    ]);
    expect(d.totals.reviews).toBe(3);
    expect(d.totals.conversations).toBe(2);
  });

  test('property ORDER does not make one conversation into two', () => {
    // The key sorts its entries, because a payload's property order is not a routing fact.
    const d = digest([
      entry({ context: { channel_id: 'C1', thread_ts: '1.1' } }),
      entry({ context: { thread_ts: '1.1', channel_id: 'C1' } }),
    ]);
    expect(d.totals.conversations).toBe(1);
  });

  test('a non-string routing value is still its own conversation', () => {
    // `issueIdOrKey: 10000` is allowed by the Jira tools' own schema, and a reader that only
    // handled strings would collapse every numeric id into one bucket.
    const d = digest([
      entry({ destination: 'jira', context: { cloudId: 'c', issueIdOrKey: 10_000 } }),
      entry({ destination: 'jira', context: { cloudId: 'c', issueIdOrKey: 10_001 } }),
    ]);
    expect(d.totals.conversations).toBe(2);
  });

  test('an empty context is ONE conversation, not zero', () => {
    // A zero would read as "no reviews".
    const d = digest([entry({ context: {} }), entry({ context: {} })]);
    expect(d.totals.reviews).toBe(2);
    expect(d.totals.conversations).toBe(1);
  });

  test('conversations sum across destinations, because a routing belongs to one', () => {
    const d = digest([
      entry({ destination: 'slack', context: { channel_id: 'C1' } }),
      entry({ destination: 'linear', context: { issueId: 'HELP-1' } }),
      entry({ destination: 'linear', context: { issueId: 'HELP-2' } }),
    ]);
    expect(d.totals.conversations).toBe(3);
    expect(d.destinations.find((x) => x.destination === 'linear')?.conversations).toBe(2);
  });

  test('the SESSION narrows a routing, which is what makes the bound tighter', () => {
    // Why `AuditRecord.session` exists: two sessions writing to one channel are two conversations,
    // on a fact the runtime supplied rather than a time window.
    const d = digest([
      entry({ context: { channel_id: 'C1' }, session: 's1' }),
      entry({ context: { channel_id: 'C1' }, session: 's1', outcome: 'rejected' }),
      entry({ context: { channel_id: 'C1' }, session: 's2' }),
    ]);
    expect(d.totals.reviews).toBe(3);
    // s1 retried once, s2 sent once: two conversations, not one and not three.
    expect(d.totals.conversations).toBe(2);
  });

  test('a row with NO session groups by routing alone', () => {
    // Direct CLI runs carry no session. Nothing may turn a missing session into a shared one.
    const d = digest([
      entry({ context: { channel_id: 'C1' } }),
      entry({ context: { channel_id: 'C1' } }),
    ]);
    expect(d.totals.conversations).toBe(1);
  });

  test('...and a sessionless row is not lumped in with a session that happens to be empty', () => {
    // `''` is "no session", one looser group rather than a special case.
    const d = digest([
      entry({ context: { channel_id: 'C1' } }),
      entry({ context: { channel_id: 'C1' }, session: 's1' }),
    ]);
    expect(d.totals.conversations).toBe(2);
  });

  test('a routing field called `session` cannot collide with the session itself', () => {
    // The session is a prefix, not a merged property, so a routing field cannot forge or shadow it.
    const d = digest([
      entry({ context: { session: 's1' } }),
      entry({ context: {}, session: 's1' }),
    ]);
    expect(d.totals.conversations).toBe(2);
  });

  test('the header says both numbers only when they DIFFER', () => {
    const retried = formatDigest(
      digest([
        entry({ context: { channel_id: 'C1' }, outcome: 'rejected' }),
        entry({ context: { channel_id: 'C1' } }),
      ]),
      '/tmp/audit.jsonl'
    );
    expect(retried).toContain('2 review(s) across 1 conversation(s)');
    expect(retried).toContain('ROUNDS, not messages');

    // Nothing retried: a second identical figure is noise, and the legend has nothing to explain.
    const clean = formatDigest(
      digest([entry({ context: { channel_id: 'C1' } }), entry({ context: { channel_id: 'C2' } })]),
      '/tmp/audit.jsonl'
    );
    expect(clean).toContain('2 review(s)  ');
    expect(clean).not.toContain('conversation(s)');
    expect(clean).not.toContain('ROUNDS, not messages');
  });
});
