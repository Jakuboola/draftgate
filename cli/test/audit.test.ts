/**
 * The audit log: not world-readable, `--audit ""` is an error rather than "the default path",
 * `DRAFTGATE_HOME` relocates it along with `tools.json`, and a review that throws still leaves a
 * line.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, ArgError } from '../src/args';
import {
  appendAudit, auditPath, auditLine, auditSilencedByEnv, draftgateHome, ensurePrivateDir,
  writePrivateFile, type AuditRecord,
} from '../src/audit';
import { DECISION_FILE_VERSION, parseDecisionFile } from '../src/decisionFile';
import { lastLines } from '../src/text';
import { parseAuditLog } from '../src/digest';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-audit-test-'));
// Each run's directory holds draft bodies; `test/tempDirs.test.ts` is the guard.
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const REPO = join(import.meta.dir, '..', '..');

/** A payload file. */
const payload = (obj: unknown): string => {
  const p = join(dir, `p${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

/** The real CLI, in a real subprocess. Bounded so a hang fails instead of stalling the suite. */
const runCli = (args: string[]) =>
  spawnSync(process.execPath, ['cli/src/main.ts', 'review', ...args],
    { cwd: REPO, encoding: 'utf8', timeout: 30_000 });

const lastEntry = (log: string) =>
  JSON.parse(readFileSync(log, 'utf8').trimEnd().split('\n').pop()!);

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  destination: 'jira',
  toolName: 'someTool',
  context: { issueIdOrKey: 'SUPPORT-1' },
  outcome: 'approved',
  edited: false,
  before: 'hello',
  warnings: [],
  ...over,
});

describe('the log holds plaintext message bodies, so it must not be world-readable', () => {
  test('the directory is 0700 and the file 0600', () => {
    const home = join(dir, `perm-${Math.random().toString(36).slice(2)}`);
    const path = join(home, 'audit.jsonl');
    expect(appendAudit(path, record())).toBeNull();
    // The log is on by default; 0755/0644 would leave every draft readable by any local user.
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /*
   * `mode` on `writeFileSync` applies at creation only, and a crash between write and rename leaves
   * the temp file behind (see `writePrivateFile`). Without the chmod, a stale one at 0644 would be
   * renamed over the real file.
   */
  test('writePrivateFile is 0600 even over a stale 0644 temp file', () => {
    const home = join(dir, `wpf-${Math.random().toString(36).slice(2)}`);
    const target = join(home, 'marks.json');
    mkdirSync(home, { recursive: true });
    // A stale temp file at the umask's mode, under the name this process writes (pids are reused).
    const stale = `${target}.${process.pid}.tmp`;
    writeFileSync(stale, 'stale');
    chmodSync(stale, 0o644);

    expect(writePrivateFile(target, '{"version":1}')).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('{"version":1}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  // `mkdirSync`'s `mode` is creation-only too, so an existing 0755 `~/.draftgate` would stay 0755.
  test('an existing draftgate home created 0755 is narrowed to 0700', () => {
    const home = join(dir, `home-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true, mode: 0o755 });
    chmodSync(home, 0o755);
    expect(statSync(home).mode & 0o777).toBe(0o755);

    // Through the real append path, with this as draftgate's home: the only directory narrowed.
    const prev = process.env.DRAFTGATE_HOME;
    process.env.DRAFTGATE_HOME = home;
    try {
      expect(appendAudit(join(home, 'audit.jsonl'), record())).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.DRAFTGATE_HOME;
      else process.env.DRAFTGATE_HOME = prev;
    }
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test('but a directory the operator pointed --audit at is left exactly as it is', () => {
    // `--audit` / DRAFTGATE_AUDIT_LOG can name a team share; only draftgate's own home is narrowed.
    const elsewhere = join(dir, `shared-${Math.random().toString(36).slice(2)}`);
    mkdirSync(elsewhere, { recursive: true, mode: 0o755 });
    chmodSync(elsewhere, 0o755);
    expect(appendAudit(join(elsewhere, 'audit.jsonl'), record())).toBeNull();
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
  });

  test('and a home the operator made TIGHTER than 0700 is not widened back', () => {
    const home = join(dir, `tight-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o500);
    ensurePrivateDir(home, { DRAFTGATE_HOME: home } as NodeJS.ProcessEnv);
    expect(statSync(home).mode & 0o777).toBe(0o500);
  });
});

/*
 * The audit log above is not the only plaintext copy of a draft this CLI puts on disk; the others
 * are 0600 too, not the umask default:
 *
 *   --decision   the whole approved payload, plus the denial when there is one
 *   --out        the approved payload
 */
describe('every other plaintext copy of a draft is 0600', () => {
  test('--out and --decision are 0600', () => {
    const home = mkdtempSync(join(dir, 'outmode-'));
    const p = payload({ cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 'hello' });
    const out = join(home, 'payload.json');
    const decision = join(home, 'decision.json');
    const r = runCli([
      '--dest', 'jira', '--in', p, '--surface', 'auto-approve', '--no-audit',
      '--out', out, '--decision', decision,
    ]);
    expect(r.status).toBe(0);
    // Both carry the body: a mode assertion on an empty file would prove nothing.
    expect(readFileSync(out, 'utf8')).toContain('hello');
    expect(readFileSync(decision, 'utf8')).toContain('hello');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(decision).mode & 0o777).toBe(0o600);
  }, 40_000);

  test('and they are narrowed even when the path already exists at 0644', () => {
    // `mode` on writeFileSync applies at creation only.
    const home = mkdtempSync(join(dir, 'outmode2-'));
    const p = payload({ cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 'hello' });
    const out = join(home, 'payload.json');
    const decision = join(home, 'decision.json');
    for (const f of [out, decision]) {
      writeFileSync(f, 'stale');
      chmodSync(f, 0o644);
    }
    const r = runCli([
      '--dest', 'jira', '--in', p, '--surface', 'auto-approve', '--no-audit',
      '--out', out, '--decision', decision,
    ]);
    expect(r.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(decision).mode & 0o777).toBe(0o600);
  }, 40_000);


  test('an absent `fixes` stays absent through serialisation', () => {
    // JSON drops `undefined`, which the three-state rule relies on.
    const line = JSON.parse(auditLine(record()));
    expect('fixes' in line).toBe(false);
    const withFixes = JSON.parse(auditLine(record({ fixes: [] })));
    expect(withFixes.fixes).toEqual([]);
  });
});

describe('resolving where the log goes', () => {
  test('DRAFTGATE_HOME relocates the log, not just tools.json', () => {
    const home = join(dir, 'relocated');
    // A path hard-coded to ~/.draftgate would keep writing bodies to the real home.
    expect(auditPath(undefined, false, { DRAFTGATE_HOME: home } as NodeJS.ProcessEnv))
      .toBe(join(home, 'audit.jsonl'));
    expect(draftgateHome({ DRAFTGATE_HOME: home } as NodeJS.ProcessEnv)).toBe(home);
  });

  test('an explicit flag wins over the environment', () => {
    const p = auditPath('/tmp/x.jsonl', false, { DRAFTGATE_AUDIT_LOG: '/tmp/y.jsonl' } as NodeJS.ProcessEnv);
    expect(p).toBe('/tmp/x.jsonl');
  });

  test('--no-audit wins over both', () => {
    expect(auditPath('/tmp/x.jsonl', true, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  test('an empty DRAFTGATE_AUDIT_LOG means off', () => {
    // The one way to suppress the log where no flag can be passed: a hook config.
    expect(auditPath(undefined, false, { DRAFTGATE_AUDIT_LOG: '' } as NodeJS.ProcessEnv)).toBeNull();
    expect(auditPath(undefined, false, { DRAFTGATE_AUDIT_LOG: '  ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  test('--audit "" is an ERROR, not the default path', () => {
    // `--audit "$LOG"` with LOG unset would otherwise write every draft to ~/.draftgate, silently.
    expect(() => parseArgs(['review', '--dest', 'jira', '--in', 'p', '--audit', ''])).toThrow(ArgError);
  });
});

describe('the line shape', () => {
  test('one line per entry, with a UTC timestamp first', () => {
    const line = auditLine(record(), new Date('2026-09-02T10:16:55.401Z'));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line).ts).toBe('2026-09-02T10:16:55.401Z');
  });

  test('a body containing a newline stays on one line', () => {
    // JSONL is read line by line; an escaped body is what keeps that true.
    const line = auditLine(record({ before: 'a\nb\nc' }));
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line).before).toBe('a\nb\nc');
  });

  test('`after` is absent when nothing was sent', () => {
    const parsed = JSON.parse(auditLine(record({ outcome: 'rejected', after: undefined })));
    expect('after' in parsed).toBe(false);
  });

  test('`after` is carried only when it differs from `before`', () => {
    // An unedited approval, the common case, omits it rather than storing the body twice.
    const edited = JSON.parse(auditLine(record({ edited: true, after: 'hello, edited' })));
    expect(edited.after).toBe('hello, edited');
    expect(edited.before).toBe('hello');
  });
});

describe('a logging failure never changes a decision', () => {
  test('an unwritable path returns the error instead of throwing', () => {
    const err = appendAudit('/nope/nowhere/deeper/audit.jsonl', record());
    expect(err).toBeInstanceOf(Error);
  });

  test('an approval still exits 0 when the log cannot be written', () => {
    const p = payload({ issueId: 'HELP-42', body: 'hello' });
    const r = runCli(['--dest', 'linear', '--in', p,
                      '--surface', 'auto-approve', '--audit', '/nope/nowhere/audit.jsonl']);
    // A full disk does not withdraw an approval a human gave.
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).body).toBe('hello');
    expect(r.stderr).toContain('could not write the audit log');
  }, 40_000);
});

describe('a gate that BROKE is logged too -- that is what the log is for', () => {
  test('a payload with no body field still leaves a line', () => {
    const log = join(dir, 'threw.jsonl');
    // Schema drift: `commentBody` renamed. The review throws before it has a body.
    const p = payload({ cloudId: 'c', issueIdOrKey: 'K-1', comment: 'hi' });
    const r = runCli(['--dest', 'jira', '--in', p, '--surface', 'auto-approve', '--audit', log]);
    expect(r.status).toBe(1);
    expect(existsSync(log)).toBe(true);
    const entry = lastEntry(log);
    expect(entry.outcome).toBe('unavailable');
    expect(entry.destination).toBe('jira');
    expect(entry.reason).toContain('commentBody');
    // Empty: reading the body is what failed.
    expect(entry.before).toBe('');
  }, 40_000);

  test('a rejection is logged with its reason and no `after`', () => {
    const log = join(dir, 'rejected.jsonl');
    const p = payload({ issueId: 'HELP-42', body: 'hello' });
    const r = runCli(['--dest', 'linear', '--in', p, '--surface', 'auto-reject', '--audit', log]);
    expect(r.status).toBe(1);
    const entry = lastEntry(log);
    expect(entry.outcome).toBe('rejected');
    expect(entry.before).toBe('hello');
    expect('after' in entry).toBe(false);
  }, 40_000);
});

describe('--decision: the machine-readable outcome, for adapters', () => {
  // Both halves go through one file, so an adapter never scrapes stderr.
  test('an approval records the complete updatedInput', () => {
    const out = join(dir, 'd-approve.json');
    const p = payload({ cloudId: 'c1', issueIdOrKey: 'SUPPORT-1', commentBody: 'Hi **there**.' });
    const r = runCli(['--dest', 'jira', '--in', p, '--surface', 'auto-approve',
                      '--no-audit', '--decision', out]);
    expect(r.status).toBe(0);
    const d = JSON.parse(readFileSync(out, 'utf8'));
    expect(d.version).toBe(DECISION_FILE_VERSION);
    expect(d.outcome).toBe('approved');
    expect(d.edited).toBe(false);
    expect(d.updatedInput.contentFormat).toBe('adf');
    expect(d.updatedInput.cloudId).toBe('c1');
    expect(parseDecisionFile(readFileSync(out, 'utf8'))).not.toBeNull();
  }, 40_000);

  for (const [name, surface, outcome] of [
    ['a rejection', 'auto-reject', 'rejected'],
  ] as const) {
    test(`${name} records the structured denial, and no payload`, () => {
      const out = join(dir, `d-${outcome}.json`);
      const p = payload({ issueId: 'HELP-42', body: 'hello' });
      const r = runCli(['--dest', 'linear', '--in', p, '--surface', surface,
                        '--no-audit', '--decision', out]);
      expect(r.status).toBe(1);
      const d = JSON.parse(readFileSync(out, 'utf8'));
      expect(d.outcome).toBe(outcome);
      expect('updatedInput' in d).toBe(false);
      // A denial's guidance is the half that stops a retry loop.
      expect(d.denial.guidance).toBeTruthy();
    }, 40_000);
  }

  /**
   * The three unreadable-body codes, through a real CLI subprocess. The hook keys the schema-drift
   * fail-open on `body/missing-field` alone, so one code for all three would let `commentBody: 123`
   * and a misrouted tool both become an `allow`.
   */
  for (const [label, input, code] of [
    // Absent field, and `comment` holds prose: schema drift, the fail-open's case.
    ['drift', { cloudId: 'c', issueIdOrKey: 'K-1', comment: 'hi there reviewer' }, 'body/missing-field'],
    // Present and not a string.
    ['wrong type', { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 123 }, 'body/wrong-type'],
    // A Slack payload read by the Jira profile: identifiers only.
    ['unrecognised', { channel_id: 'C1', thread_ts: '1788287522.311099' }, 'body/unrecognised'],
  ] as [string, Record<string, unknown>, string][]) {
    test(`an unreadable body (${label}) is a denial coded ${code}`, () => {
      const out = join(dir, `d-nobody-${label.replace(' ', '-')}.json`);
      const p = payload(input);
      const r = runCli(['--dest', 'jira', '--in', p, '--surface', 'auto-approve',
                        '--no-audit', '--decision', out]);
      expect(r.status).toBe(1);
      const d = JSON.parse(readFileSync(out, 'utf8'));
      expect(d.denial.code).toBe(code);
      expect(d.denial.outcome).toBe('unavailable');
    }, 40_000);
  }

  /**
   * The top-level `outcome`, which the adapter branches on (the tests above read `d.denial.*`).
   * `outcome: "approved"` with a `denial` and no `updatedInput` is a shape `parseDecisionFile`
   * refuses, so the adapter would answer `ask` and the denial's `code` would never reach its policy.
   * The outcome must equal the denial's, and the file must read back.
   */
  for (const [label, dest, surface, input, outcome] of [
    ['a rejection', 'linear', 'auto-reject', { issueId: 'HELP-42', body: 'hello' }, 'rejected'],
    ['schema drift', 'jira', 'auto-approve',
      { cloudId: 'c', issueIdOrKey: 'K-1', comment: 'hi there reviewer' }, 'unavailable'],
    ['a wrong-typed body', 'jira', 'auto-approve',
      { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 123 }, 'unavailable'],
    ['an unrecognised payload', 'jira', 'auto-approve',
      { channel_id: 'C1', thread_ts: '1788287522.311099' }, 'unavailable'],
    ['a body already in the destination format', 'jira', 'auto-approve',
      { cloudId: 'c', issueIdOrKey: 'K-1', contentFormat: 'adf', commentBody: '{"type":"doc"}' },
      'unavailable'],
    ['an emptied draft', 'jira', 'auto-approve',
      { cloudId: 'c', issueIdOrKey: 'K-1', commentBody: '   ' }, 'rejected'],
  ] as [string, string, string, Record<string, unknown>, 'rejected' | 'unavailable'][]) {
    test(`${label}: the top-level outcome is "${outcome}", and the file reads back`, () => {
      const out = join(dir, `d-top-${label.replace(/\s/g, '-')}.json`);
      const r = runCli(['--dest', dest, '--in', payload(input), '--surface', surface,
                        '--no-audit', '--decision', out]);
      expect(r.status).not.toBe(0);
      const text = readFileSync(out, 'utf8');
      const d = JSON.parse(text);
      expect(d.outcome).toBe(outcome);
      // The denial's outcome, not merely "not approved".
      expect(d.outcome).toBe(d.denial.outcome);
      expect('updatedInput' in d).toBe(false);
      // What the adapter does with it: `approved` plus no payload parses to null.
      const parsed = parseDecisionFile(text);
      expect(parsed).not.toBeNull();
      expect(parsed!.outcome).toBe(outcome);
      expect(parsed!.denial?.outcome).toBe(outcome);
    }, 40_000);
  }

  test('an unknown version is unreadable rather than guessed at', () => {
    // Guessing across a version bump lets a stale build misread a decision, as on the wire.
    expect(parseDecisionFile(JSON.stringify({ version: 99, outcome: 'approved', updatedInput: {} }))).toBeNull();
    expect(parseDecisionFile('not json')).toBeNull();
    expect(parseDecisionFile('[]')).toBeNull();
    // An approval with no payload is not an approval this file can express.
    expect(parseDecisionFile(JSON.stringify({ version: DECISION_FILE_VERSION, outcome: 'approved' }))).toBeNull();
  });
});

/**
 * `--audit ""` is rejected; `DRAFTGATE_AUDIT_LOG=` disables the log, so it says so on stderr:
 * `export DRAFTGATE_AUDIT_LOG="$SOMETHING_UNSET"` would otherwise turn the log off unnoticed.
 */
describe('an empty DRAFTGATE_AUDIT_LOG', () => {
  test('and is distinguishable from every other reason it is off', () => {
    expect(auditSilencedByEnv({ DRAFTGATE_AUDIT_LOG: '' })).toBe(true);
    expect(auditSilencedByEnv({ DRAFTGATE_AUDIT_LOG: ' \t ' })).toBe(true);
    // Not set at all: the default path, and nothing to say.
    expect(auditSilencedByEnv({})).toBe(false);
    // Set to a real path: on.
    expect(auditSilencedByEnv({ DRAFTGATE_AUDIT_LOG: '/tmp/x.jsonl' })).toBe(false);
  });

  test('the CLI says so on stderr, and stays quiet when the reviewer asked', () => {
    const home = mkdtempSync(join(dir, 'emptyenv-'));
    const p = payload({ cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 'hello' });
    const run = (env: Record<string, string>, extra: string[] = []) =>
      spawnSync(process.execPath,
        ['cli/src/main.ts', 'review', '--dest', 'jira', '--in', p, '--surface', 'auto-approve', ...extra],
        { cwd: REPO, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, DRAFTGATE_HOME: home, ...env } });

    const silenced = run({ DRAFTGATE_AUDIT_LOG: '' });
    expect(silenced.status).toBe(0);
    expect(silenced.stderr).toContain('set but EMPTY');
    expect(silenced.stderr).toContain('--no-audit');

    // Explicit is not accidental: `--no-audit` must not nag.
    const explicit = run({}, ['--no-audit']);
    expect(explicit.stderr).not.toContain('EMPTY');

    // And a normal run says nothing about the log at all.
    const normal = run({});
    expect(normal.stderr).not.toContain('EMPTY');
  }, 40_000);
});

/**
 * Every audit row names the surface that decided it, so an `auto-approve` line is not counted as
 * one a human read.
 */
describe('the audit row names the surface', () => {
  const home = mkdtempSync(join(dir, 'surface-'));
  const p = payload({ cloudId: 'c', issueIdOrKey: 'K-1', commentBody: 'hello' });

  test('an auto-approve review is recorded as one', () => {
    const log = join(home, 'auto.jsonl');
    const r = runCli(['--dest', 'jira', '--in', p, '--surface', 'auto-approve', '--audit', log]);
    expect(r.status).toBe(0);
    const entry = lastEntry(log);
    expect(entry.outcome).toBe('approved');
    expect(entry.surface).toBe('auto-approve');
  }, 40_000);

  test('and a denial records it too, so the failures can be attributed as well', () => {
    const log = join(home, 'reject.jsonl');
    const r = runCli(['--dest', 'jira', '--in', p, '--surface', 'auto-reject', '--audit', log]);
    expect(r.status).toBe(1);
    expect(lastEntry(log).surface).toBe('auto-reject');
  }, 40_000);

  test('the decision file carries it as well, which is where the adapter reads it', () => {
    const out = join(home, 'd.json');
    runCli(['--dest', 'jira', '--in', p, '--surface', 'auto-approve', '--no-audit', '--decision', out]);
    expect(JSON.parse(readFileSync(out, 'utf8')).surface).toBe('auto-approve');
  }, 40_000);
});

/*
 * `lastLines` is what a human is shown when draftgate itself breaks ("Last output", and the hook's
 * reason). A crashed bun process ends with its stack and version banner, so a plain tail of three
 * shows frames and hides the message.
 */
describe('lastLines shows the error, not the stack frames under it', () => {
  // Captured verbatim from a real `bun /tmp/dg-crash2.ts`.
  const REAL_CRASH = [
    "1 | function c() { throw new Error('the actual error message'); }",
    '                             ^',
    'error: the actual error message',
    '      at c (/private/tmp/dg-crash2.ts:1:26)',
    '      at b (/private/tmp/dg-crash2.ts:2:16)',
    '      at a (/private/tmp/dg-crash2.ts:3:16)',
    '      at /private/tmp/dg-crash2.ts:4:1',
    '',
    'Bun v1.4.0 (macOS arm64)',
  ].join('\n');

  test('the message survives a stack trace and a version banner', () => {
    const shown = lastLines(REAL_CRASH);
    expect(shown).toContain('error: the actual error message');
    // The exact string a plain three-line tail produces.
    expect(shown).not.toBe('      at /private/tmp/dg-crash2.ts:4:1 |  | Bun v1.4.0 (macOS arm64)');
    expect(shown).not.toContain(' at /private/tmp/dg-crash2.ts:4:1');
  });

  test('a module-resolution failure survives too', () => {
    const shown = lastLines(
      "error: Cannot find module '/tmp/nope.ts' from '/private/tmp/x.ts'\n\nBun v1.4.0 (macOS arm64)"
    );
    expect(shown).toBe(
      "error: Cannot find module '/tmp/nope.ts' from '/private/tmp/x.ts' | Bun v1.4.0 (macOS arm64)"
    );
  });

  test('ordinary output is still the last n lines, indentation included', () => {
    // Only `at `-prefixed frames are noise; anything else indented is real output.
    expect(lastLines('a\nb\nc\nd')).toBe('b | c | d');
    // Not first: `trim()` would strip the leading spaces off the first line and the filter
    // would never see them.
    expect(lastLines('head\n  indented detail\nlast')).toBe('head |   indented detail | last');
    expect(lastLines('', 3)).toBe('');
  });
});

/*
 * Two Claude Code sessions each fire their own hook, so `appendAudit`'s single write per line is
 * probed: a smaller version of the 40-process run recorded in `audit.ts`.
 */
describe('concurrent appends do not tear each other', () => {
  test('eight processes writing 64 KB lines produce whole lines', async () => {
    const home = mkdtempSync(join(dir, 'conc-'));
    const log = join(home, 'audit.jsonl');
    const PROCS = 8;
    const EACH = 8;
    const runs = Array.from({ length: PROCS }, (_, i) =>
      Bun.spawn([
        process.execPath, '-e',
        `import { appendAudit } from ${JSON.stringify(join(REPO, 'cli', 'src', 'audit.ts'))};\n` +
          `const rec = { destination: 'jira', context: {}, outcome: 'approved', edited: false,\n` +
          `  before: 'A'.repeat(65536) + '-${i}', warnings: [] };\n` +
          `for (let k = 0; k < ${EACH}; k++) {\n` +
          `  const e = appendAudit(${JSON.stringify(log)}, rec);\n` +
          `  if (e) { console.error(e); process.exit(1); }\n` +
          `}`,
      ]).exited
    );
    expect(await Promise.all(runs)).toEqual(Array(PROCS).fill(0));

    const text = readFileSync(log, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(PROCS * EACH);
    // Every line whole: a torn one does not parse, and a glued pair parses as one object with the
    // next record's text inside it -- the torn-write loss below, one layer up.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  }, 60_000);
});

/*
 * A killed or out-of-disk write leaves half a line with no newline. An append landing against it
 * would make one malformed line, losing the intact record with the fragment.
 */
describe('a torn write costs one record, not two', () => {
  test('the next append starts a new line, and is readable', () => {
    const home = mkdtempSync(join(dir, 'torn-'));
    const log = join(home, 'audit.jsonl');
    // Exactly what a killed process leaves: a fragment, no trailing newline.
    writeFileSync(log, '{"ts":"2026-09-05T10:00:00.000Z","destination":"jira","cont');

    expect(appendAudit(log, record({ before: 'the record after the tear' }))).toBeNull();

    const { entries, malformed } = parseAuditLog(readFileSync(log, 'utf8'));
    expect(malformed).toBe(1);
    expect(entries.length).toBe(1);
    expect(entries[0]!.before).toBe('the record after the tear');
  });

  test('and an intact log gains no blank line', () => {
    // The control: the heal must not fire when nothing is torn.
    const home = mkdtempSync(join(dir, 'intact-'));
    const log = join(home, 'audit.jsonl');
    for (let i = 0; i < 3; i++) expect(appendAudit(log, record())).toBeNull();
    const text = readFileSync(log, 'utf8');
    expect(text.split('\n').filter((l) => l === '').length).toBe(1); // just the trailing one
    expect(parseAuditLog(text).entries.length).toBe(3);
    expect(parseAuditLog(text).malformed).toBe(0);
  });
});
