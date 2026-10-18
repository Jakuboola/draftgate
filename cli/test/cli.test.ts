/**
 * Argument parsing and the CLI entry point. Stdout carries the approved payload and nothing else;
 * every human-facing byte goes to stderr, or piping `draftgate review` breaks.
 */

import { afterAll, describe, expect, test, afterEach } from 'bun:test';
import {
  writeFileSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, ArgError, COMMAND_HELP, HELP, SURFACES } from '../src/args';
import { ROUTE_FLAG_NAMES } from '../src/routeFacts';
import { DEFAULT_TIMEOUT_MS } from '../src/review';
import { profiles } from '../../core/src/index';
import { main } from '../src/main';
import { isRuntimeFile } from '../src/pluginTree';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-cli-test-'));
// Removed after the run, like every suite's scratch directory: `test/tempDirs.test.ts` is the guard.
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The audit log is on by default and these tests call `main()` in-process, so without this every
// run would append to the real ~/.draftgate/audit.jsonl.
process.env.DRAFTGATE_AUDIT_LOG = join(dir, 'audit.jsonl');
const payload = (obj: unknown): string => {
  const p = join(dir, `p${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

const JIRA = { cloudId: 'c1', issueIdOrKey: 'SUPPORT-1', commentBody: 'Hi **there**.' };

/** Run main() with stdout/stderr captured. */
async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  // The stub must invoke the write callback: one that ignores it hangs the await on stdout's write
  // and never exercises the async pipe path, so a truncated payload would pass here.
  const capture = (sink: string[]) => (chunk: any, enc?: any, cb?: any) => {
    sink.push(String(chunk));
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') done();
    return true;
  };
  (process.stdout as any).write = capture(out);
  (process.stderr as any).write = capture(err);
  try {
    const code = await main(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    (process.stdout as any).write = so;
    (process.stderr as any).write = se;
  }
}

describe('parseArgs', () => {
  test('parses a full review invocation', () => {
    const a = parseArgs(['review', '--dest', 'jira', '--in', 'p.json', '--timeout', '30',
                         '--surface', 'auto-approve', '--tool', 'someTool', '--json']);
    expect(a).toEqual({
      command: 'review', destination: 'jira', input: 'p.json', timeoutMs: 30_000,
      surface: 'auto-approve', toolName: 'someTool', json: true, noAudit: false,
      sinceLast: false, mark: false, includeScratch: false,
    });
  });

  test('short flags work', () => {
    const a = parseArgs(['review', '-d', 'slack', '--in', '-']);
    expect(a.destination).toBe('slack');
    expect(a.input).toBe('-');
  });

  test('help and version need no other arguments', () => {
    for (const flag of ['--help', '-h', 'help']) expect(parseArgs([flag]).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs([]).command).toBe('help');
  });

  const bad: [string, string[]][] = [
    ['unknown destination',   ['review', '--dest', 'teams', '--in', 'p']],
    ['missing --dest',        ['review', '--in', 'p']],
    ['missing --in',          ['review', '--dest', 'jira']],
    ['zero timeout',          ['review', '--dest', 'jira', '--in', 'p', '--timeout', '0']],
    ['non-numeric timeout',   ['review', '--dest', 'jira', '--in', 'p', '--timeout', 'soon']],
    ['bad surface',           ['review', '--dest', 'jira', '--in', 'p', '--surface', 'nope']],
    ['unknown option',        ['review', '--dest', 'jira', '--in', 'p', '--wat']],
    ['unknown command',       ['frobnicate']],
    ['flag with no value',    ['review', '--dest']],
  ];
  for (const [label, argv] of bad) {
    test(`rejects: ${label}`, () => {
      expect(() => parseArgs(argv)).toThrow(ArgError);
    });
  }

  /*
   * The route flags' reader. `adapters/hook/test/hook.test.ts` sweeps the round trip from
   * `ROUTE_FLAGS`; this is the half it cannot reach, a value the writer never emits: unusable as a
   * field path, or outside a choice's set. Refused, not ignored: falling back to the profile's field
   * would review a different field than the caller named.
   */
  describe('route flags', () => {
    const review = (...extra: string[]) =>
      parseArgs(['review', '--dest', 'jira', '--in', 'p', ...extra]);

    test('a repeated list flag accumulates, and a path flag takes a dotted path', () => {
      const a = review(
        '--body-field', 'fields.description',
        '--context-field', 'cloudId', '--context-field', 'fields.status',
        '--prose-field', 'fields.summary',
        '--body-format', 'plain'
      );
      expect(a.bodyField).toBe('fields.description');
      expect(a.contextFields).toEqual(['cloudId', 'fields.status']);
      expect(a.proseFields).toEqual(['fields.summary']);
      expect(a.bodyFormat).toBe('plain');
    });

    test('an empty or unusable field name is refused, naming the flag', () => {
      // `parseBodyPath` refuses `''` but not `'  '`, which is why the trim check is its own.
      expect(() => review('--body-field', '  ')).toThrow(/--body-field needs a field name/);
      expect(() => review('--body-field', 'a..b')).toThrow(/--body-field needs a field name\./);
      expect(() => review('--context-field', '')).toThrow(/--context-field needs a field name/);
      expect(() => review('--prose-field', 'a..b')).toThrow(ArgError);
      // The grammar is `tools.json`'s own, so a prototype key is refused here too.
      expect(() => review('--body-field', '__proto__.x')).toThrow(ArgError);
    });

    test('a choice outside its set is refused rather than read as the default', () => {
      expect(() => review('--body-format', 'html')).toThrow(
        /--body-format must be "markdown" or "plain", got "html"/
      );
      expect(() => review('--body-format', 'html')).toThrow(ArgError);
    });

    test('they belong to review, so digest refuses them', () => {
      expect(() => parseArgs(['digest', '--body-field', 'x']))
        .toThrow(/not valid for draftgate digest/);
      expect(() => parseArgs(['digest', '--body-format', 'plain']))
        .toThrow(/not valid for draftgate digest/);
    });
  });

  test('the unknown-destination message lists what is valid', () => {
    // `toThrow` with a matcher, not a try/catch: that passes with zero assertions once `parseArgs`
    // stops throwing.
    expect(() => parseArgs(['review', '--dest', 'teams', '--in', 'p'])).toThrow(
      /jira, slack, linear, github/
    );
    expect(() => parseArgs(['review', '--dest', 'teams', '--in', 'p'])).toThrow(ArgError);
  });
});

/**
 * The last hop: `main()`'s own spread of the route facts into `runReview`. `hook.test.ts` stops at
 * `parseArgs`, so replacing `...claimedRouteFacts(args)` with `{}` fails nothing else, and a dropped
 * `--prose-field` sends the title unseen under a human approval (`staleSurfaceDenial` cannot see a
 * field missing from the plan). Each fact is asserted where its consequence shows. The payload has
 * no `commentBody`, so a dropped `--body-field` fails the review outright.
 */
describe('the route facts reach the review itself', () => {
  const AUDIT = join(dir, 'route-facts.jsonl');
  const WIDE = {
    cloudId: 'c1', issueIdOrKey: 'SUPPORT-1',
    note: 'Hello **world**.', headline: 'A title', extra: 'x',
  };

  test('all four arrive, each asserted where it shows', async () => {
    const r = await run([
      'review', '--dest', 'jira', '--in', payload(WIDE), '--surface', 'auto-approve',
      '--audit', AUDIT,
      '--body-field', 'note',
      '--prose-field', 'headline',
      '--context-field', '*',
      '--body-format', 'plain',
    ]);
    expect(r.code, r.stderr).toBe(0);
    const sent = JSON.parse(r.stdout);

    // `--body-field`: the review read `note`. Without it `extractBody` looks for `commentBody`,
    // which this payload does not have, and the run fails rather than sending.
    expect(sent.note).toBeDefined();
    // `--body-format plain`: verbatim and not stamped -- `contentFormat: "adf"` on a plain string
    // tells Jira to parse it as ADF.
    expect(sent.note).toBe('Hello **world**.');
    expect(sent).not.toHaveProperty('contentFormat');

    const logged = readFileSync(AUDIT, 'utf8').trim().split('\n');
    const context = JSON.parse(logged[logged.length - 1]!).context as Record<string, unknown>;
    // `--context-field '*'`: `extra` is in no destination profile, so only the route puts it there.
    expect(context).toHaveProperty('extra');
    // `--prose-field`: the wildcard excludes what is editable. Dropping the flag leaves `headline` in
    // the context and out of the prose the reviewer is shown.
    expect(context).not.toHaveProperty('headline');
    expect(context).not.toHaveProperty('note');
  });
});

describe('stdout discipline', () => {
  test('an approval puts ONLY the payload on stdout', async () => {
    const r = await run(['review', '--dest', 'jira', '--in', payload(JIRA), '--surface', 'auto-approve']);
    expect(r.code).toBe(0);
    // Parses cleanly, so nothing else was mixed in.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.issueIdOrKey).toBe('SUPPORT-1');
    expect(r.stderr).toContain('approved');
    expect(r.stdout).not.toContain('approved');
  });

  test('help writes to stderr and leaves stdout empty', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('draftgate doctor');
  });

  test('every failure leaves stdout empty', async () => {
    for (const argv of [
      ['review', '--dest', 'teams', '--in', 'x'],
      ['review', '--dest', 'jira', '--in', '/does/not/exist.json'],
      ['review', '--dest', 'jira', '--in', payload({ wrong: 'field' }), '--surface', 'auto-approve'],
      ['review', '--dest', 'jira', '--in', payload(JIRA), '--surface', 'auto-reject'],
    ]) {
      const r = await run(argv);
      expect(r.code).toBeGreaterThan(0);
      expect(r.stdout).toBe('');
    }
  });

  test('--out writes the file and keeps stdout empty', async () => {
    const dest = join(dir, 'approved.json');
    const r = await run(['review', '--dest', 'jira', '--in', payload(JIRA),
                         '--surface', 'auto-approve', '--out', dest]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(JSON.parse(readFileSync(dest, 'utf8')).contentFormat).toBe('adf');
  });
});

describe('payload validation', () => {
  test('malformed JSON is reported, not thrown', async () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{nope');
    const r = await run(['review', '--dest', 'jira', '--in', p]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('could not read payload');
  });

  test('a JSON array is rejected with a clear message', async () => {
    const r = await run(['review', '--dest', 'jira', '--in', payload(['a'])]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('must be a JSON object');
  });

  test('a wrong body field names the expected one and the keys present', async () => {
    const r = await run(['review', '--dest', 'jira', '--in', payload({ cloudId: 'c', body: 'x' })]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('commentBody');
    expect(r.stderr).toContain('cloudId, body');
  });
});

describe('exit codes and denial output', () => {
  test('rejection exits 1 with reason and guidance on stderr', async () => {
    const r = await run(['review', '--dest', 'jira', '--in', payload(JIRA), '--surface', 'auto-reject']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('rejected');
    expect(r.stderr).toContain('Do not resend');
  });

  test('--json makes the denial machine-readable', async () => {
    const r = await run(['review', '--dest', 'jira', '--in', payload(JIRA),
                         '--surface', 'auto-reject', '--json']);
    const d = JSON.parse(r.stderr.slice(r.stderr.indexOf('{')));
    expect(d.outcome).toBe('rejected');
    expect(d.destination).toBe('jira');
    expect(d.guidance).toBeTruthy();
  });

  test('a draft the destination would reject never reaches stdout', async () => {
    const r = await run(['review', '--dest', 'jira',
                         '--in', payload({ ...JIRA, commentBody: '> ## quoted heading\n' }),
                         '--surface', 'auto-approve']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('jira/blockquote-child-rejected');
  });
});

/*
 * At mode 0644, anything that resolves `package.json`'s bin (`bun link`, `npm link`, a PATH shim)
 * gets a file the shell refuses to execute, despite its shebang.
 */
describe('the declared bin is actually runnable', () => {
  const ROOT = join(import.meta.dir, '..', '..');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };

  test('package.json names a bin, and that file is executable', () => {
    const rel = pkg.bin?.draftgate;
    expect(rel, 'package.json should declare a draftgate bin').toBeDefined();
    const target = join(ROOT, rel!);
    expect(existsSync(target)).toBe(true);
    // The owner-execute bit is the one that decides whether a shim can run it.
    expect(statSync(target).mode & 0o100).toBe(0o100);
  });

  test('and it starts with a shebang, or the mode buys nothing', () => {
    const target = join(ROOT, pkg.bin!.draftgate!);
    expect(readFileSync(target, 'utf8').startsWith('#!')).toBe(true);
  });

  test('review --help says who runs it, because almost nobody types it', () => {
    expect(COMMAND_HELP.review).toContain('Normally you do not type this');
    expect(COMMAND_HELP.review).toContain('a caller supplies');
    // The by-hand examples name payloads the repo ships. Only a checkout has them (the plugin tree
    // ships no docs), so each is run the checkout's way.
    for (const example of [
      'docs/examples/jira-payload.json',
      'docs/examples/slack-payload.json',
      'docs/examples/github-payload.json',
    ]) {
      expect(existsSync(join(ROOT, example)), example).toBe(true);
      expect(isRuntimeFile(example), example).toBe(false);
      expect(COMMAND_HELP.review).toMatch(new RegExp(`bun cli/src/main\\.ts review --dest \\w+ +--in ${RegExp.escape(example)}\\n`));
    }
  });

  test('every interpolated list in the help actually rendered', () => {
    // `${'${SURFACES.join(' | ')}'}` parses as a bitwise OR of two strings and renders as `0`
    // (`--surface <kind>  0`), and typecheck is happy. So the guard is on the values, not the syntax.
    for (const surface of SURFACES) expect(COMMAND_HELP.review, `surface ${surface}`).toContain(surface);
    for (const dest of Object.keys(profiles)) expect(COMMAND_HELP.review, `destination ${dest}`).toContain(dest);
    expect(COMMAND_HELP.review).not.toContain('<kind>  0');
    for (const { displayName } of Object.values(profiles)) expect(HELP, displayName).toContain(displayName);
  });

  test('no help text cites a section number, because the document it would cite is private', () => {
    for (const text of [HELP, ...Object.values(COMMAND_HELP)]) expect(text).not.toContain('§');
  });

  test('every command HELP lists is actually accepted by the parser', () => {
    // Listing `draftgate version` while the parser accepts only `--version` makes the bare word throw
    // `Unknown command "version"`.
    expect(parseArgs(['help']).command).toBe('help');
    expect(parseArgs(['version']).command).toBe('version');
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['-v']).command).toBe('version');
    expect(parseArgs(['digest']).command).toBe('digest');
    expect(parseArgs(['uninstall']).command).toBe('uninstall');
    expect(parseArgs(['register']).command).toBe('register');
    expect(parseArgs(['doctor']).command).toBe('doctor');
    expect(parseArgs(['propose-tools', 'mcp__a__b']).command).toBe('propose-tools');
    // Bare `review` refuses naming --dest, which is not the same as not being a command.
    expect(parseArgs(['review', '--dest', 'jira', '--in', 'p.json']).command).toBe('review');
    expect(() => parseArgs(['review'])).toThrow(/--dest is required/);
  });

  test('register and doctor refuse an option rather than run without it', () => {
    // They run the hook's `--register` and `--doctor` as they are, so a flag would be dropped on the
    // way, and `draftgate doctor --strict` exiting 0 reads as a pass it never was.
    expect(() => parseArgs(['register', '--json'])).toThrow('draftgate register takes no options');
    expect(() => parseArgs(['doctor', '--json'])).toThrow('draftgate doctor takes only --setup');
    for (const command of ['register', 'doctor'] as const) {
      expect(parseArgs([command, '--help'])).toMatchObject({ command: 'help', helpFor: command });
    }
    // `--setup` is doctor's one option, alone: beside another it is refused, and register has none.
    expect(parseArgs(['doctor', '--setup'])).toMatchObject({ command: 'doctor', setup: true });
    expect(parseArgs(['doctor']).setup).toBeUndefined();
    // The refusal names the argument that is wrong, never `--setup` beside it.
    expect(() => parseArgs(['doctor', '--setup', '--json'])).toThrow('draftgate doctor takes only --setup; got "--json".');
    expect(() => parseArgs(['doctor', '--json', '--setup'])).toThrow('got "--json".');
    expect(() => parseArgs(['doctor', '--setup', '--setup'])).toThrow('got "--setup".');
    expect(() => parseArgs(['register', '--setup'])).toThrow('draftgate register takes no options');
  });

  test('propose-tools hands its arguments to the hook as they are, in their order', () => {
    // The hook's `--propose-tools` owns the grammar, so the CLI reads none of it.
    const argv = ['mcp__a__slack_send_message', '--decline', 'save_issue', '--write', 'mcp__b__x'];
    expect(parseArgs(['propose-tools', ...argv])).toMatchObject({ command: 'propose-tools', proposeArgs: argv });
    expect(parseArgs(['propose-tools']).proposeArgs).toEqual([]);
    expect(parseArgs(['propose-tools', '--help'])).toMatchObject({ command: 'help', helpFor: 'propose-tools' });
  });

  test('uninstall takes --delete <path> and nothing else', () => {
    // `--delete` is the person's yes, so it carries the path they were asked about; anything else
    // refuses rather than reading as a yes or a no.
    expect(parseArgs(['uninstall', '--delete', '/home/me/.draftgate'])).toMatchObject({
      command: 'uninstall', deleteDir: '/home/me/.draftgate',
    });
    expect(parseArgs(['uninstall']).deleteDir).toBeUndefined();
    expect(parseArgs(['uninstall', '--help'])).toMatchObject({ command: 'help', helpFor: 'uninstall' });
    expect(parseArgs(['uninstall', '-h'])).toMatchObject({ command: 'help', helpFor: 'uninstall' });
    expect(() => parseArgs(['uninstall', '--json'])).toThrow('draftgate uninstall takes only --delete <path>; got "--json".');
    expect(() => parseArgs(['uninstall', '--delete'])).toThrow('--delete needs the path');
    expect(() => parseArgs(['uninstall', '--delete', ' '])).toThrow('--delete needs the path');
    expect(() => parseArgs(['uninstall', '--delete', '/a', '/b'])).toThrow('got "/b" too.');
  });

  test('an unknown command points at the command LIST, not at one command\'s flags', () => {
    expect(() => parseArgs(['sned'])).toThrow(/Try: draftgate --help/);
  });

  test('HELP lists exactly the commands a user runs, on one screen', () => {
    // The hook runs `review` and `/draftgate:setup` runs `register` and `propose-tools`, so those
    // stay out.
    const listed = [...HELP.matchAll(/^ {2}draftgate (\S+) /gm)].map((m) => m[1]);
    expect(listed).toEqual(['doctor', 'digest', 'uninstall', 'version', 'help']);
    expect(HELP).not.toMatch(/draftgate (review|register|propose-tools)\b/);
    // A terminal's 24 lines.
    expect(HELP.trimEnd().split('\n').length).toBeLessThanOrEqual(24);
  });

  test('every command the parser accepts answers --help with its own text, from a real process', async () => {
    // A real process also sees a help text that fails at module load. `COMMAND_HELP` is a Record over
    // every command but `help`, so the compiler holds it complete.
    const runs = Object.keys(COMMAND_HELP).flatMap((command) => ['--help', '-h'].map(async (flag) => {
      const p = Bun.spawn([process.execPath, 'cli/src/main.ts', command, flag], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { argv: `${command} ${flag}`, command, status, stdout, stderr };
    }));
    for (const r of await Promise.all(runs)) {
      expect(r.status, r.argv).toBe(0);
      expect(r.stdout, r.argv).toBe('');
      expect(r.stderr.startsWith(`draftgate ${r.command}`), r.argv).toBe(true);
    }
    // After other arguments too.
    expect(parseArgs(['review', '--dest', 'jira', '--help'])).toMatchObject({ command: 'help', helpFor: 'review' });
    expect(parseArgs(['digest', '--mark', '-h'])).toMatchObject({ command: 'help', helpFor: 'digest' });
    expect(parseArgs(['doctor', '--setup', '--help'])).toMatchObject({ command: 'help', helpFor: 'doctor' });
    expect(parseArgs(['uninstall', '--delete', '/d', '-h'])).toMatchObject({ command: 'help', helpFor: 'uninstall' });
    expect(parseArgs(['propose-tools', 'mcp__a__b', '--help'])).toMatchObject({ command: 'help', helpFor: 'propose-tools' });
    expect(parseArgs(['version', '--help'])).toMatchObject({ command: 'help', helpFor: 'version' });
    expect(parseArgs(['--version', '-h'])).toMatchObject({ command: 'help', helpFor: 'version' });
    expect(parseArgs(['review', '--bogus', '--help'])).toMatchObject({ command: 'help', helpFor: 'review' });
    expect(parseArgs(['help']).helpFor).toBeUndefined();
  });

  test('review --help names every route flag the parser accepts', () => {
    // `--help` hand-lists the route flags; a fifth in `ROUTE_FLAGS` would be accepted everywhere and
    // documented nowhere. Only the prose's coverage is checked.
    for (const flag of ROUTE_FLAG_NAMES) expect(COMMAND_HELP.review, flag).toContain(flag);
  });

  test('review --help states the REAL default timeout, because it is interpolated', () => {
    expect(COMMAND_HELP.review).toContain(`default: ${DEFAULT_TIMEOUT_MS / 1000}`);
  });
});

