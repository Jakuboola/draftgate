/**
 * `~/.draftgate/config.json`: the operator's own review deadline, how long the log keeps a review,
 * and whether the daily release check runs. The ceiling that bounds it under a hook is
 * `adapters/hook/test/reviewTimeout.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TIMEOUT_MS } from '../src/args';
import { DEFAULT_TIMEOUT_MS } from '../src/review';
import { DEFAULT_AUDIT_RETENTION_DAYS, loadReviewConfig, parseReviewConfig } from '../src/reviewConfig';

describe('parseReviewConfig', () => {
  test('reads reviewSeconds', () => {
    expect(parseReviewConfig('{"version":1,"reviewSeconds":1800}', 'c.json')).toEqual({
      wantedMs: 1_800_000,
      retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
      releaseCheck: true,
      present: true,
      path: 'c.json',
    });
  });

  test('a file that declares nothing is the default, and is not a problem', () => {
    expect(parseReviewConfig('{"version":1}', 'c.json')).toEqual({
      wantedMs: DEFAULT_TIMEOUT_MS,
      retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
      releaseCheck: true,
      present: true,
      path: 'c.json',
    });
  });

  test('every broken shape falls back to the default and SAYS why', () => {
    // An upper bound somebody chose deliberately: a file nobody can read must not raise it.
    for (const [text, expected] of [
      ['{oops', 'not valid JSON'],
      ['[]', 'not a JSON object'],
      ['{"version":2,"reviewSeconds":60}', 'declares version 2'],
      ['{"version":1,"reviewSeconds":"1800"}', 'must be a positive number'],
      ['{"version":1,"reviewSeconds":0}', 'must be a positive number'],
      ['{"version":1,"reviewSeconds":-5}', 'must be a positive number'],
    ] as const) {
      const parsed = parseReviewConfig(text, 'c.json');
      expect(parsed.wantedMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(parsed.present).toBe(true);
      expect(parsed.problem).toContain(expected);
    }
  });
});

describe('the bound --timeout already enforces applies here too', () => {
  test('a value that would overflow the timer is refused, not frozen into settings.json', () => {
    // `setTimeout` stores its delay in a 32-bit int and a larger value wraps: measured at
    // 2_500_000_000ms denying after 27ms. A registration derives its `timeout` from this number.
    const parsed = parseReviewConfig(`{"version":1,"reviewSeconds":2500000}`, 'c.json');
    expect(parsed.wantedMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(parsed.problem).toContain('overflow the timer');
    expect(2_500_000 * 1000).toBeGreaterThan(MAX_TIMEOUT_MS);
  });

  test('and the largest accepted value is still accepted', () => {
    const seconds = Math.floor(MAX_TIMEOUT_MS / 1000);
    const parsed = parseReviewConfig(`{"version":1,"reviewSeconds":${seconds}}`, 'c.json');
    expect(parsed.problem).toBeUndefined();
    expect(parsed.wantedMs).toBe(seconds * 1000);
  });
});

describe('a parsed config carries where it came from', () => {
  test('so a report never re-derives the path its own input already knows', () => {
    expect(parseReviewConfig('{"version":1}', '/somewhere/config.json').path)
      .toBe('/somewhere/config.json');
  });
});

describe('auditRetentionDays', () => {
  const parse = (json: string) => parseReviewConfig(json, 'c.json');

  test('reads a whole number of days, and 0 means keep everything', () => {
    expect(parse('{"version":1,"auditRetentionDays":14}').retentionDays).toBe(14);
    expect(parse('{"version":1,"auditRetentionDays":0}').retentionDays).toBe(0);
    expect(parse('{"version":1,"auditRetentionDays":0}').problem).toBeUndefined();
  });

  test('an absent field is the shipped default, and is not a problem', () => {
    expect(parse('{"version":1}').retentionDays).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(parse('{"version":1}').problem).toBeUndefined();
  });

  test('a value nobody can read falls back to the DEFAULT, never to "keep forever"', () => {
    // Falling back to 0 would turn a typo into unbounded retention of every message's plaintext.
    for (const bad of ['"60"', '-1', '1.5', 'null', 'true', '[]']) {
      const got = parse(`{"version":1,"auditRetentionDays":${bad}}`);
      expect(got.retentionDays, `${bad} should not change retention`).toBe(
        DEFAULT_AUDIT_RETENTION_DAYS
      );
      expect(got.problem, `${bad} should be reported`).toContain('auditRetentionDays');
    }
  });

  test('a broken deadline does not take a good retention down with it, or the other way round', () => {
    // Why the fields are parsed separately: one typo must not silently discard the other setting.
    const badDeadline = parse('{"version":1,"reviewSeconds":0,"auditRetentionDays":7}');
    expect(badDeadline.retentionDays).toBe(7);
    expect(badDeadline.wantedMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(badDeadline.problem).toContain('reviewSeconds');
    expect(badDeadline.problem).not.toContain('auditRetentionDays');

    const badRetention = parse('{"version":1,"reviewSeconds":300,"auditRetentionDays":-4}');
    expect(badRetention.wantedMs).toBe(300_000);
    expect(badRetention.retentionDays).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(badRetention.problem).toContain('auditRetentionDays');
    expect(badRetention.problem).not.toContain('reviewSeconds');
  });

  test('and a file with two mistakes says two things', () => {
    const both = parse('{"version":1,"reviewSeconds":"x","auditRetentionDays":"y"}');
    expect(both.problem).toContain('reviewSeconds');
    expect(both.problem).toContain('auditRetentionDays');
  });
});

describe('releaseCheck', () => {
  const parse = (json: string) => parseReviewConfig(json, 'c.json');

  test('on unless the file says false, and neither spelling is a problem', () => {
    expect(parse('{"version":1}').releaseCheck).toBe(true);
    expect(parse('{"version":1,"releaseCheck":true}').releaseCheck).toBe(true);
    expect(parse('{"version":1,"releaseCheck":false}').releaseCheck).toBe(false);
    expect(parse('{"version":1,"releaseCheck":false}').problem).toBeUndefined();
  });

  test('a value nobody can read turns it OFF, never back on, and says so', () => {
    // Whoever wrote the key was most likely turning the check off. `"true"` and `1` land off too:
    // one fallback, reported, beats a guess per value.
    for (const bad of ['"false"', '"no"', '0', '1', '"true"', 'null', '[]']) {
      const got = parse(`{"version":1,"releaseCheck":${bad}}`);
      expect(got.releaseCheck, `${bad} should leave the check off`).toBe(false);
      expect(got.problem, `${bad} should be reported`).toContain('"releaseCheck" must be true or false');
      expect(got.problem).toContain('stays off');
    }
  });

  test('a file that exists and cannot be read keeps the check OFF', () => {
    // It may be the very file that says `false`, with a typo three lines below it.
    for (const text of ['{"version":1,"releaseCheck":false,}', '[]', '{"version":2,"releaseCheck":false}']) {
      const got = parse(text);
      expect(got.releaseCheck, text).toBe(false);
      expect(got.wantedMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(got.retentionDays).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
      expect(got.problem).toBeDefined();
    }
  });

  test('it degrades independently of the other two knobs, in both directions', () => {
    const badRelease = parse('{"version":1,"reviewSeconds":300,"auditRetentionDays":7,"releaseCheck":"x"}');
    expect(badRelease.wantedMs).toBe(300_000);
    expect(badRelease.retentionDays).toBe(7);
    expect(badRelease.releaseCheck).toBe(false);
    expect(badRelease.problem).not.toContain('reviewSeconds');
    expect(badRelease.problem).not.toContain('auditRetentionDays');

    const badOthers = parse('{"version":1,"reviewSeconds":0,"auditRetentionDays":-1,"releaseCheck":false}');
    expect(badOthers.releaseCheck).toBe(false);
    expect(badOthers.problem).not.toContain('releaseCheck');
    const keptOn = parse('{"version":1,"reviewSeconds":0,"releaseCheck":true}');
    expect(keptOn.releaseCheck).toBe(true);
  });

  test('a file with three mistakes says three things', () => {
    const all = parse('{"version":1,"reviewSeconds":"x","auditRetentionDays":"y","releaseCheck":"z"}');
    for (const field of ['reviewSeconds', 'auditRetentionDays', 'releaseCheck']) {
      expect(all.problem).toContain(field);
    }
  });

  test('an off that is a fallback carries the problem that caused it, and an explicit false does not', () => {
    expect(parse('{"version":1,"releaseCheck":false}').releaseCheckOffBecause).toBeUndefined();
    expect(parse('{"version":1}').releaseCheckOffBecause).toBeUndefined();
    expect(parse('{"version":1,"releaseCheck":"no"}').releaseCheckOffBecause).toContain('"releaseCheck" must be true or false');
    // A bad deadline beside a good switch is not the switch's problem.
    expect(parse('{"version":1,"reviewSeconds":0,"releaseCheck":"no"}').releaseCheckOffBecause).not.toContain('reviewSeconds');
    expect(parse('{oops').releaseCheckOffBecause).toContain('is not valid JSON');
  });

  test('a file that is THERE and cannot be read turns it off too, and says why', () => {
    // A permission, a macOS privacy denial: it may be the very file that says false.
    const home = mkdtempSync(join(tmpdir(), 'draftgate-config-'));
    const path = join(home, 'config.json');
    try {
      writeFileSync(path, '{"version":1,"releaseCheck":false}');
      chmodSync(path, 0o000);
      const got = loadReviewConfig({ DRAFTGATE_HOME: home } as NodeJS.ProcessEnv);
      expect(got).toMatchObject({ releaseCheck: false, present: true });
      // `readConfigText`'s sentence, which every other operator file's loader writes.
      expect(got.problem).toBe(`${path}: could not be read (EACCES)`);
      expect(got.releaseCheckOffBecause).toBe(got.problem);
      expect(got.wantedMs).toBe(DEFAULT_TIMEOUT_MS);
    } finally {
      chmodSync(path, 0o600);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no file at all is the shipped default: on', () => {
    const home = mkdtempSync(join(tmpdir(), 'draftgate-config-'));
    try {
      expect(loadReviewConfig({ DRAFTGATE_HOME: home } as NodeJS.ProcessEnv)).toMatchObject({
        releaseCheck: true,
        present: false,
      });
      writeFileSync(join(home, 'config.json'), '{"version":1,"releaseCheck":false}');
      expect(loadReviewConfig({ DRAFTGATE_HOME: home } as NodeJS.ProcessEnv)).toMatchObject({
        releaseCheck: false,
        present: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
