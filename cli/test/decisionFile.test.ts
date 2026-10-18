/**
 * The decision file's encoder and decoder, held together by one table.
 *
 * `surface/harness/decisionFields.test.ts` does this for the renderer-to-CLI hop; this is the
 * CLI-to-hook hop. Everything the encoder writes, the decoder reads back equal, and a file the
 * decoder cannot vouch for field by field is `null`, which the adapter turns into `ask`.
 */
import { describe, expect, test } from 'bun:test';
import {
  DECISION_FILE_VERSION,
  encodeDecisionFile,
  parseDecisionFile,
  type DecisionFile,
} from '../src/decisionFile';
import type { Denial, ReviewOutcome } from '../src/types';
import type { AuditRecord } from '../src/audit';

const AUDIT: AuditRecord = {
  destination: 'jira', context: {}, outcome: 'approved', edited: false, before: 'x', warnings: [],
} as AuditRecord;

const DENIAL: Denial = {
  outcome: 'unavailable',
  code: 'body/missing-field',
  destination: 'jira',
  reason: 'no commentBody',
  guidance: 'ask the user',
};

const OUTCOMES: { what: string; outcome: ReviewOutcome; surface?: string }[] = [
  {
    what: 'an approval from a human, edited, with a payload',
    outcome: {
      exitCode: 0, human: true, edited: true,
      updatedInput: { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: '{}', contentFormat: 'adf' },
      audit: AUDIT,
    },
    surface: 'webkit',
  },
  {
    what: 'an approval a human edited, body and a line',
    outcome: {
      exitCode: 0, human: true, edited: true,
      updatedInput: { title: 'New title', body: 'their text' },
      sent: { body: 'their text', lines: [{ field: 'title', value: 'New title' }] },
      audit: { ...AUDIT, edited: true },
    },
    surface: 'webkit',
  },
  {
    what: 'an approval from a machine, unedited',
    outcome: { exitCode: 0, human: false, edited: false, updatedInput: { message: 'hi' }, audit: AUDIT },
    surface: 'auto-approve',
  },
  {
    what: 'a denial with a code',
    outcome: { exitCode: 1, human: false, edited: false, denial: DENIAL, audit: AUDIT },
    surface: 'auto-approve',
  },
  {
    what: 'a human rejection with no code',
    outcome: {
      exitCode: 1, human: true, edited: true,
      denial: { outcome: 'rejected', destination: 'slack', reason: 'wrong channel', guidance: 'fix it' },
      audit: AUDIT,
    },
    surface: 'terminal',
  },
  {
    what: 'a timeout, and no surface name at all',
    outcome: {
      exitCode: 2, human: true, edited: false,
      denial: { outcome: 'timeout', destination: 'linear', reason: 'nobody answered', guidance: 'do not resend' },
      audit: AUDIT,
    },
  },
];

describe('what the encoder writes, the decoder reads back equal', () => {
  for (const { what, outcome, surface } of OUTCOMES) {
    test(what, () => {
      const file = encodeDecisionFile(outcome, surface);
      const back = parseDecisionFile(JSON.stringify(file));
      expect(back).toEqual(file);
      // The three facts the adapter keys on, named, so a future field cannot hide behind `toEqual`
      // of two objects that both forgot it.
      expect(back!.outcome).toBe(outcome.denial?.outcome ?? 'approved');
      expect(back!.human).toBe(outcome.human);
      expect(back!.edited).toBe(outcome.edited);
      expect(back!.surface).toBe(surface);
    });
  }

  test('the encoder always writes `human`, so only a file from an older CLI can lack it', () => {
    for (const { outcome, surface } of OUTCOMES) {
      expect('human' in encodeDecisionFile(outcome, surface)).toBe(true);
    }
  });

  test('every key the encoder can emit is a key the decoder keeps', () => {
    // Union over the table, so a field added to `encodeDecisionFile` alone shows up here as a key
    // the parse dropped.
    const emitted = new Set<string>();
    for (const { outcome, surface } of OUTCOMES) {
      for (const k of Object.keys(encodeDecisionFile(outcome, surface))) emitted.add(k);
    }
    expect([...emitted].sort()).toEqual([
      'denial', 'edited', 'human', 'outcome', 'sentBody', 'sentLines', 'surface', 'updatedInput', 'version',
    ]);
    for (const { outcome, surface } of OUTCOMES) {
      const file = encodeDecisionFile(outcome, surface);
      const back = parseDecisionFile(JSON.stringify(file))!;
      for (const k of Object.keys(file)) expect(k in back, `${k} was dropped by the parse`).toBe(true);
    }
  });
});

describe('what an edit sent, for the agent', () => {
  test("the review's `sent` is what the file carries, new values only", () => {
    const file = encodeDecisionFile({
      exitCode: 0, human: true, edited: true, updatedInput: { a: 1 },
      sent: { body: 'their text', lines: [{ field: 'title', value: 'New' }] }, audit: AUDIT,
    });
    expect(file.sentBody).toBe('their text');
    expect(file.sentLines).toEqual([{ field: 'title', value: 'New' }]);
  });

  test('a title-only edit carries the line and no body, even when the audit row has an `after`', () => {
    // `AuditRecord.after` is set whenever the sent body differs, reformatting included; only the
    // review's `sent` says the person changed it.
    const file = encodeDecisionFile({
      exitCode: 0, human: true, edited: true, updatedInput: { a: 1 },
      sent: { lines: [{ field: 'title', value: 'New' }] }, audit: { ...AUDIT, after: 'reformatted' },
    });
    expect('sentBody' in file).toBe(false);
    expect(file.sentLines).toEqual([{ field: 'title', value: 'New' }]);
  });

  test('no edit, no lines: neither key', () => {
    const file = encodeDecisionFile({
      exitCode: 0, human: true, edited: true, updatedInput: { a: 1 }, sent: { lines: [] }, audit: AUDIT,
    });
    expect('sentBody' in file).toBe(false);
    expect('sentLines' in file).toBe(false);
  });
});

describe('a file the decoder cannot vouch for is null, field by field', () => {
  const approved: DecisionFile = {
    version: DECISION_FILE_VERSION, outcome: 'approved', edited: false, human: true, updatedInput: { a: 1 },
  };
  const denied: DecisionFile = {
    version: DECISION_FILE_VERSION, outcome: 'unavailable', edited: false, human: false, denial: DENIAL,
  };
  const without = (o: object, k: string) => { const c: Record<string, unknown> = { ...o }; delete c[k]; return c; };

  test('the good shapes parse', () => {
    expect(parseDecisionFile(JSON.stringify(approved))).toEqual(approved);
    expect(parseDecisionFile(JSON.stringify(denied))).toEqual(denied);
  });

  test('version, outcome, edited: required and typed', () => {
    expect(parseDecisionFile(JSON.stringify({ ...approved, version: 2 }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify(without(approved, 'version')))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...approved, outcome: 'whatever' }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...approved, outcome: 7 }))).toBeNull();
    // A missing or non-boolean `edited` is unreadable.
    expect(parseDecisionFile(JSON.stringify(without(approved, 'edited')))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...approved, edited: 'yes' }))).toBeNull();
  });

  test('human and surface: optional, but typed when present', () => {
    // Absent (a CLI that does not write it) must read, as unknown.
    const old = parseDecisionFile(JSON.stringify(without(approved, 'human')));
    expect(old).not.toBeNull();
    expect(old!.human).toBeUndefined();
    expect(parseDecisionFile(JSON.stringify({ ...approved, human: 'yes' }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...approved, surface: 3 }))).toBeNull();
  });

  test('sentBody and sentLines: optional, but typed when present', () => {
    const edited = { ...approved, edited: true, sentBody: 'b', sentLines: [{ field: 'title', value: 'v' }] };
    expect(parseDecisionFile(JSON.stringify(edited))).toEqual(edited);
    expect(parseDecisionFile(JSON.stringify({ ...edited, sentBody: 3 }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...edited, sentLines: 'title' }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...edited, sentLines: [{ field: 'title' }] }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...edited, sentLines: [{ field: 1, value: 'v' }] }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...edited, sentLines: [null] }))).toBeNull();
  });

  test('an approval needs a payload object', () => {
    expect(parseDecisionFile(JSON.stringify(without(approved, 'updatedInput')))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...approved, updatedInput: [] }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...approved, updatedInput: 'x' }))).toBeNull();
  });

  test('a denial is checked field by field, not for presence', () => {
    expect(parseDecisionFile(JSON.stringify(without(denied, 'denial')))).toBeNull();
    for (const k of ['outcome', 'destination', 'reason', 'guidance']) {
      const d = { ...denied, denial: without(DENIAL, k) };
      expect(parseDecisionFile(JSON.stringify(d)), `denial missing ${k}`).toBeNull();
    }
    expect(parseDecisionFile(JSON.stringify({ ...denied, denial: { ...DENIAL, reason: 5 } }))).toBeNull();
    expect(parseDecisionFile(JSON.stringify({ ...denied, denial: { ...DENIAL, code: 5 } }))).toBeNull();
    // `code` is optional: a human rejection has none.
    expect(parseDecisionFile(JSON.stringify({ ...denied, denial: without(DENIAL, 'code') }))).not.toBeNull();
  });

  test("the denial's outcome must be the file's outcome", () => {
    // The adapter's fail-open row reads the file's, its wording the denial's. `cli/test/audit.test.ts`
    // pins that the writer keeps them equal.
    const d = { ...denied, denial: { ...DENIAL, outcome: 'rejected' } };
    expect(parseDecisionFile(JSON.stringify(d))).toBeNull();
  });

  test('unknown keys are dropped, not refused', () => {
    // A slightly newer CLI may write a field this adapter does not know; it should see what it does.
    const back = parseDecisionFile(JSON.stringify({ ...approved, future: 'thing' }));
    expect(back).toEqual(approved);
  });
});
