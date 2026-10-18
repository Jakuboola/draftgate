/**
 * What the window will write as a decision (`surface/rendererBridge.cjs`), executed with the
 * contract's own numbers: a source-text check is satisfied by `Number(64); // was
 * CONTRACT.maxAppliedFixes`. The frame guard is the host's, measured by `surface:host`.
 */

import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SURFACE } from './shared';
import contract from '../contract.json';

const bridge = createRequire(import.meta.url)(join(SURFACE, 'rendererBridge.cjs')) as {
  sanitiseFixes(raw: unknown, maxFixes: number, maxFieldLength: number): unknown;
  sanitiseClassification(
    raw: unknown,
    maxFieldLength: number
  ): { destination: string; value: string } | undefined;
};

describe('the fix caps are the contract\'s, and they bite', () => {
  const { maxAppliedFixes, maxFixFieldLength } = contract;
  const fix = (n: number) => ({ code: `c${n}`, label: `l${n}` });
  const clean = (raw: unknown) => bridge.sanitiseFixes(raw, maxAppliedFixes, maxFixFieldLength);

  test('a list at the cap survives whole', () => {
    const at = Array.from({ length: maxAppliedFixes }, (_, i) => fix(i));
    expect(clean(at)).toHaveLength(maxAppliedFixes);
  });

  test('one over is truncated TO the cap, not rejected', () => {
    const over = Array.from({ length: maxAppliedFixes + 5 }, (_, i) => fix(i));
    expect(clean(over)).toHaveLength(maxAppliedFixes);
  });

  test('a field one character over the length cap is dropped', () => {
    const long = 'x'.repeat(maxFixFieldLength + 1);
    expect(clean([{ code: long, label: 'ok' }])).toBeUndefined();
    expect(clean([{ code: 'ok', label: long }])).toBeUndefined();
    // Exactly at the cap is fine.
    expect(clean([{ code: 'x'.repeat(maxFixFieldLength), label: 'ok' }])).toHaveLength(1);
  });

  test('the three states are distinct, which is the whole contract', () => {
    // Absent: "this window cannot report repairs"; `[]`: "none were accepted". Collapsed, every edit
    // on a non-reporting surface would read as a human rewrite.
    expect(clean(undefined)).toBeUndefined();
    expect(clean('nonsense')).toBeUndefined();
    expect(clean([])).toEqual([]);
    expect(clean([fix(1)])).toEqual([{ code: 'c1', label: 'l1' }]);
  });

  test('a non-empty list that yields nothing valid is UNKNOWN, not "none accepted"', () => {
    // The rule `parseAppliedFixes` states, and could never reach if this end wrote `[]`.
    expect(clean([{ code: 1, label: 2 }])).toBeUndefined();
    expect(clean([null, 'x', []])).toBeUndefined();
  });

  test('extra keys are dropped rather than carried', () => {
    expect(clean([{ code: 'c', label: 'l', extra: 'nope' }])).toEqual([{ code: 'c', label: 'l' }]);
  });
});

/**
 * The target classification: shape only. `sanitiseDecision` is never told the destination, so the
 * vocabulary check is `parseWireDecision`'s, against the profile the answer names
 * (`cli/test/windowSurface.test.ts`). The value is persisted, so a bad one misclassifies a target
 * for every later review.
 */
describe('the target classification this process will let through', () => {
  const clean = (raw: unknown) => bridge.sanitiseClassification(raw, contract.maxFixFieldLength);

  test('a destination and a value, both non-empty strings', () => {
    expect(clean({ destination: 'jira', value: 'service_desk' })).toEqual({
      destination: 'jira',
      value: 'service_desk',
    });
    // Neither half is interpreted here: an unknown destination and value pass, and are refused one
    // layer on. A membership test added here would fail.
    expect(clean({ destination: 'confluence', value: 'whatever' })).toEqual({
      destination: 'confluence',
      value: 'whatever',
    });
  });

  test('and nothing else is', () => {
    // A bare string names no destination.
    for (const bad of [
      'service_desk',
      { destination: 'jira' },
      { value: 'service_desk' },
      { destination: '', value: 'service_desk' },
      { destination: 'jira', value: '' },
      { destination: 42, value: 'service_desk' },
      { destination: 'jira', value: ['software'] },
      '',
      42,
      null,
      undefined,
      {},
      ['software'],
    ]) {
      expect(clean(bad), `${JSON.stringify(bad)} was let through`).toBeUndefined();
    }
  });

  test('an over-cap half is refused, not truncated', () => {
    // The caller supplies the cap, so a different one bites: the function carries none of its own.
    const long = 'x'.repeat(contract.maxFixFieldLength + 1);
    expect(clean({ destination: 'jira', value: long })).toBeUndefined();
    expect(clean({ destination: long, value: 'service_desk' })).toBeUndefined();
    expect(
      bridge.sanitiseClassification({ destination: 'jira', value: 'service_desk' }, 4)
    ).toBeUndefined();
  });

  test('an invented key does not travel with it', () => {
    // Rebuilt from its two fields, not forwarded.
    expect(clean({ destination: 'jira', value: 'software', about: 'SUPPORT-1' })).toEqual({
      destination: 'jira',
      value: 'software',
    });
  });
});
