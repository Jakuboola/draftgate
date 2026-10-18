/**
 * The fail-closed registration command, run the way Claude Code runs it (measured on 2.1.286:
 * `/bin/sh -c <command>`, as a process-group leader, payload on stdin), rather than asserted on the
 * script's text. The hook is a fake shell script, so a test can make it write any bytes, exit any
 * way, or not exist. The real hook through the real wrapper is `hook.test.ts`'s end-to-end section.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandNamesHook } from '../src/registration';
import {
  FAIL_CLOSED_NAME,
  FAIL_CLOSED_SCRIPT,
  commandTokens,
  isFailClosed,
  shQuote,
} from '../src/hookCommand';
import { until } from '../../../cli/test/releaseFixture';
import { failClosedCommand, fallbackDecisions, type HookLaunch } from './checkoutEntry';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-hookcmd-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Where the wrapper's `mktemp` puts its buffer. Checked empty after every test. */
const TMP = join(dir, 'tmp');
mkdirSync(TMP);
afterEach(() => {
  expect(readdirSync(TMP), 'the wrapper left its temp file behind').toEqual([]);
});

/**
 * A fake hook: copies stdin to `DG_STDIN_COPY`, replays `DG_FIXTURE` on stdout, then exits the way
 * `DG_EXIT` says -- a number, or `kill` for death by SIGKILL, or `sleep` to touch `DG_SLEEPING` and
 * hang until signalled.
 */
const FAKE_HOOK = `
cat > "$DG_STDIN_COPY"
cat "$DG_FIXTURE"
case "$DG_EXIT" in
  kill) kill -9 $$ ;;
  sleep) : > "$DG_SLEEPING"; exec sleep 30 ;;
  *) exit "\${DG_EXIT:-0}" ;;
esac
`;

function fakeHook(where: string): HookLaunch {
  mkdirSync(where, { recursive: true });
  const hook = join(where, 'main.ts');
  writeFileSync(hook, FAKE_HOOK);
  return { interpreter: '/bin/sh', hook };
}

let n = 0;
/** Run a registration command exactly as Claude Code does, with the fake hook's knobs set. */
function run(
  command: string,
  opts: {
    stdin?: Uint8Array | string;
    fixture?: Uint8Array | string;
    exit?: string;
    tmp?: string;
    path?: string;
    shell?: string[];
  } = {}
) {
  const id = n++;
  const fixture = join(dir, `fixture-${id}`);
  const stdinCopy = join(dir, `stdin-${id}`);
  writeFileSync(fixture, opts.fixture ?? '');
  const [shell, ...flags] = opts.shell ?? ['/bin/sh'];
  const r = spawnSync(shell!, [...flags, '-c', command], {
    input: opts.stdin ?? '',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      TMPDIR: opts.tmp ?? TMP,
      ...(opts.path !== undefined && { PATH: opts.path }),
      DG_FIXTURE: fixture,
      DG_STDIN_COPY: stdinCopy,
      DG_EXIT: opts.exit ?? '0',
    },
  });
  return {
    status: r.status,
    stdout: r.stdout as Buffer,
    stderr: String(r.stderr),
    stdinSeen: existsSync(stdinCopy) ? readFileSync(stdinCopy) : null,
  };
}

/** The one line the wrapper prints for a cause, as it must reach Claude Code. */
const printed = (json: string) => Buffer.from(json + '\n');

const launch = fakeHook(join(dir, 'plain'));
const command = failClosedCommand(launch);
const asks = fallbackDecisions(launch);

describe('a hook that exits 0 passes through untouched', () => {
  test('its stdout, byte for byte, whatever it ends with', () => {
    // `$(...)` would strip every trailing newline; after the ordinary decision, the shapes a capture
    // gets wrong.
    const fixtures = [
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
      'no trailing newline',
      'three trailing newlines\n\n\n',
      Uint8Array.from({ length: 256 }, (_, i) => i),
    ];
    for (const fixture of fixtures) {
      const r = run(command, { fixture });
      expect(r.status).toBe(0);
      expect(r.stdout.equals(Buffer.from(fixture))).toBe(true);
    }
  });

  test("a declined tool's EMPTY stdout stays empty", () => {
    // Empty stdout on exit 0 is the documented "normal permission flow"; a newline would make it a
    // decision.
    const r = run(command, { fixture: '' });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(0);
  });

  test('a megabyte of output comes through whole', () => {
    // The decision `hook.test.ts` sends through a slow reader; here it proves the buffer is a file.
    const fixture = Buffer.alloc(1_500_000, 'x');
    const r = run(command, { fixture });
    expect(r.stdout.equals(fixture)).toBe(true);
  });
});

describe('stdin reaches the hook untouched', () => {
  test('byte for byte, trailing newlines, binary and a megabyte included', () => {
    const inputs = [
      '{"tool_name":"mcp__x__y","tool_input":{}}',
      'ends in two newlines\n\n',
      Uint8Array.from({ length: 256 }, (_, i) => 255 - i),
      Buffer.alloc(1_200_000, 'y'),
    ];
    for (const stdin of inputs) {
      const r = run(command, { stdin });
      expect(r.stdinSeen?.equals(Buffer.from(stdin))).toBe(true);
    }
  });
});

describe('a hook that does NOT exit 0 answers ask, and only ask', () => {
  test('half a decision and exit 1: the half is dropped', () => {
    // Streamed straight through, Claude Code would read
    // `{"hookSpecificOutput":{"hookEvent...{"hookSpecificOutput":...}`: no decision, so it runs the tool.
    const half = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDec';
    const r = run(command, { fixture: half, exit: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout.equals(printed(asks.noDecision))).toBe(true);
    expect(JSON.parse(String(r.stdout)).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  test('half a decision and death by SIGKILL: the same', () => {
    const r = run(command, { fixture: '{"hookSpecificOutput":', exit: 'kill' });
    expect(r.status).toBe(0);
    expect(r.stdout.equals(printed(asks.noDecision))).toBe(true);
  });

  test('every non-zero status, 2 included', () => {
    // Exit 2 is Claude Code's own "block", which the hook never uses: it has not said what a human
    // decided, so it asks.
    for (const exit of ['1', '2', '126', '127', '255']) {
      const r = run(command, { exit });
      expect(r.status, `exit ${exit}`).toBe(0);
      expect(r.stdout.equals(printed(asks.noDecision)), `exit ${exit}`).toBe(true);
    }
  });

  test('the checkout moved: the hook file is gone, and the answer says so and names it', () => {
    const moved = fakeHook(join(dir, 'moved-away'));
    const cmd = failClosedCommand(moved);
    rmSync(moved.hook);
    const r = run(cmd);
    expect(r.status).toBe(0);
    expect(r.stdout.equals(printed(fallbackDecisions(moved).hookGone))).toBe(true);
    const out = JSON.parse(String(r.stdout));
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    // The prompt draws the reason: the cause on its first line, the fix on the next.
    const [cause, fix] = out.hookSpecificOutput.permissionDecisionReason.split('\n');
    expect(cause).toContain(moved.hook);
    // The CLI by full path: `draftgate` on PATH is a link into the checkout that moved.
    expect(fix).toContain("`bun '<checkout>/cli/src/main.ts' install`");
  });

  test('the interpreter is gone: the answer says so and names it', () => {
    const gone = { ...launch, interpreter: join(dir, 'no-such-bun') };
    const r = run(failClosedCommand(gone));
    expect(r.status).toBe(0);
    expect(r.stdout.equals(printed(fallbackDecisions(gone).interpreterGone))).toBe(true);
    expect(JSON.parse(String(r.stdout)).systemMessage).toContain(gone.interpreter);
    // `sh`'s own complaint goes to stderr, under the wrapper's name rather than a bare `sh:`.
    expect(r.stderr).toContain(FAIL_CLOSED_NAME);
  });

  test('no temp file can be made: it asks without running the hook', () => {
    // Nothing to buffer into, so nothing may be streamed either (half a decision before the ask).
    // `mktemp` off PATH reaches this branch, since `/tmp` is the fallback and always writable.
    const r = run(command, { path: '' });
    expect(r.status).toBe(0);
    expect(r.stdout.equals(printed(asks.noDecision))).toBe(true);
    expect(r.stdinSeen).toBeNull();
  });

  test('each answer is a complete PreToolUse ask on one line', () => {
    for (const json of Object.values(asks)) {
      expect(json).not.toContain('\n');
      const out = JSON.parse(json);
      expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' });
      expect(out.hookSpecificOutput.permissionDecisionReason).toStartWith('draftgate: not reviewed -- its hook');
    }
  });
});

describe('the fallback names the CLI next to the hook', () => {
  const reasonOf = (json: string) => JSON.parse(json).hookSpecificOutput.permissionDecisionReason as string;

  test('a hook inside a checkout: register and doctor by that checkout\'s CLI', () => {
    const asks = fallbackDecisions({ interpreter: '/gone/bun', hook: "/a b/it's/adapters/hook/src/main.ts" });
    expect(reasonOf(asks.interpreterGone)).toContain("`bun '/a b/it'\\''s/cli/src/main.ts' register`");
    expect(reasonOf(asks.noDecision)).toContain("`bun '/a b/it'\\''s/cli/src/main.ts' doctor`");
  });

  test('a hook at any other path names no CLI it cannot know', () => {
    const asks = fallbackDecisions({ interpreter: '/gone/bun', hook: '/elsewhere/hook.ts' });
    expect(reasonOf(asks.interpreterGone)).toContain("`bun '<checkout>/cli/src/main.ts' register`");
  });
});

describe('the buffer falls back to /tmp', () => {
  test('a TMPDIR that is gone still reviews, and leaves nothing in /tmp', () => {
    // A sandbox's per-session TMPDIR, removed under a running session, is the realistic case.
    const leftovers = () => readdirSync('/tmp').filter((f) => f.startsWith('draftgate-hook.')).length;
    const before = leftovers();
    const r = run(command, { tmp: join(dir, 'no-such-tmp'), fixture: 'ran' });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toBe('ran');
    expect(leftovers()).toBe(before);
  });
});

describe('the buffer has no name while the hook runs, so nothing is left behind', () => {
  test('and the hook does not inherit its descriptors', () => {
    // A hook that held fd 3 or 4 would pass them to the CLI and the window it spawns, keeping an
    // approved message open in processes that outlive the decision.
    const where = join(dir, 'fd-check');
    mkdirSync(where);
    const hook = join(where, 'main.ts');
    writeFileSync(hook, 'for f in 3 4; do if (: <&$f) 2>/dev/null; then printf "fd%s " $f; fi; done\n');
    const r = run(failClosedCommand({ interpreter: '/bin/sh', hook }));
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toBe('');
  });

  /*
   * Claude Code spawns the hook detached and, on its own timeout, kills the whole group (measured:
   * a grandchild `sleep` dies with it). The buffer can hold an approved message, so it is unlinked
   * before the hook starts: SIGKILL, which no trap can see, leaves nothing either.
   */
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    test(`${signal} to the process group, mid-hook`, async () => {
      const fixture = join(dir, `fixture-${signal}`);
      const sleeping = join(dir, `sleeping-${signal}`);
      writeFileSync(fixture, 'partial');
      const child = spawn('/bin/sh', ['-c', command], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env, TMPDIR: TMP, DG_FIXTURE: fixture, DG_STDIN_COPY: join(dir, `stdin-${signal}`),
          DG_SLEEPING: sleeping, DG_EXIT: 'sleep',
        },
      });
      child.stdin!.end('{}');
      let stdout = '';
      child.stdout!.on('data', (c) => { stdout += c; });
      // Signalled once the hook has written its output and forks nothing more: a process the hook
      // is still starting can outlive the group kill and hold stdout open.
      await until(() => existsSync(sleeping) || undefined, 10_000, 'the hook to start');
      expect(readdirSync(TMP), 'the buffer still has a name while the hook runs').toEqual([]);
      const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('close', (_code, sig) => resolve(sig)));
      // The wrapper, then the group. Measured on macOS under load: a group kill alone can be
      // preempted between members, so the hook dies and the wrapper answers for it before the kill
      // reaches the wrapper (10 in 100 kills at 7 concurrent runs; 0 in 300 with the wrapper
      // signalled first).
      process.kill(child.pid!, signal);
      process.kill(-child.pid!, signal);
      expect(await exited).toBe(signal);
      // And nothing printed: Claude Code has stopped listening, and its own timeout decided this
      // call (fail-open, as `main.ts` records). `afterEach` checks `TMP` again.
      expect(stdout).toBe('');
    }, 20_000);
  }
});

describe('quoting: a path survives the shell', () => {
  // Every character here means something to sh, and two to JSON. The paths are `$1`/`$2`, so the
  // script never sees them as text.
  const NASTY = `it's a "dir" $HOME \`x\` back\\slash *;&|`;
  const nasty = fakeHook(join(dir, NASTY, 'adapters', 'hook', 'src'));
  // The interpreter under the same directory, so both positional parameters are exercised.
  const interpreter = join(dir, NASTY, 'bin-sh');
  symlinkSync('/bin/sh', interpreter);
  const weird = { ...nasty, interpreter };
  const pasted = failClosedCommand(weird);

  // The settings schema says the default shell "uses your $SHELL (bash/zsh/sh)", while 2.1.286
  // measures as using /bin/sh. The command must mean the same thing under all three.
  // `zsh -f`, so the test does not source whoever-runs-it's own `~/.zshenv`.
  const shells = [['/bin/sh'], ['/bin/bash'], ['/bin/zsh', '-f']].filter(([s]) => existsSync(s!));

  test('the hook it names is the hook that runs, under sh, bash and zsh', () => {
    expect(shells).toContainEqual(['/bin/sh']);
    for (const shell of shells) {
      const r = run(pasted, { shell, fixture: 'ran', stdin: 'in' });
      expect(r.status, shell[0]).toBe(0);
      expect(String(r.stdout), shell[0]).toBe('ran');
      expect(String(r.stdinSeen), shell[0]).toBe('in');
    }
  });

  test('and the answer for a missing one names the path exactly', () => {
    const gone = { ...weird, hook: join(dir, NASTY, 'gone', 'main.ts') };
    const cmd = failClosedCommand(gone);
    for (const shell of shells) {
      const r = run(cmd, { shell });
      expect(r.status, shell[0]).toBe(0);
      const out = JSON.parse(String(r.stdout));
      expect(out.systemMessage, shell[0]).toContain(gone.hook);
    }
  });

  test('commandTokens reads the launch back out of it', () => {
    const t = commandTokens(pasted);
    expect(t.slice(0, 6)).toEqual(['/bin/sh', '-c', FAIL_CLOSED_SCRIPT, FAIL_CLOSED_NAME, interpreter, nasty.hook]);
  });
});

describe('isFailClosed', () => {
  test('recognises what failClosedCommand writes', () => {
    expect(isFailClosed(command)).toBe(true);
  });

  test('the bare launch does NOT fail closed', () => {
    expect(isFailClosed(`${shQuote(launch.interpreter)} ${shQuote(launch.hook)}`)).toBe(false);
  });

  test('nor does a wrapper missing an answer, or with one that is not an ask', () => {
    // A dropped argument prints an empty line for that cause, which Claude Code reads as no decision.
    const t = commandTokens(command);
    const rebuilt = (words: string[]) => words.map(shQuote).join(' ');
    expect(isFailClosed(rebuilt(t))).toBe(true);
    expect(isFailClosed(rebuilt(t.slice(0, 8)))).toBe(false);
    const allow = asks.noDecision.replace('"ask"', '"allow"');
    expect(isFailClosed(rebuilt([...t.slice(0, 8), allow]))).toBe(false);
    expect(isFailClosed(rebuilt([...t.slice(0, 8), 'not json']))).toBe(false);
  });

  test('nor does an edited script', () => {
    const t = commandTokens(command);
    t[2] = t[2]!.replace('exit 0', 'exit 1');
    expect(isFailClosed(t.map(shQuote).join(' '))).toBe(false);
  });

  test('the script holds no single quote, so a settings file shows it as written', () => {
    expect(FAIL_CLOSED_SCRIPT).not.toContain("'");
    expect(shQuote(FAIL_CLOSED_SCRIPT)).toBe(`'${FAIL_CLOSED_SCRIPT}'`);
  });
});

describe('commandTokens', () => {
  const HOOK = '/repo/adapters/hook/src/main.ts';
  const noRealpath = () => null;

  test('undoes the single-quoting a registration writes', () => {
    expect(commandTokens(`'/opt/homebrew/bin/bun' '${HOOK}'`)).toEqual(['/opt/homebrew/bin/bun', HOOK]);
  });

  test('keeps a path that contains a space in one token', () => {
    // Unquoted, `~/Documents/claude Code/...` splits into extra arguments and the hook never launches.
    expect(commandTokens(`'bun' '/Users/x/claude Code/main.ts'`)).toEqual([
      'bun',
      '/Users/x/claude Code/main.ts',
    ]);
  });

  test('an empty quoted argument is still an argument', () => {
    expect(commandTokens(`bun '' x`)).toEqual(['bun', '', 'x']);
  });

  test('it round-trips the REAL shQuote, over paths that need quoting', () => {
    // Against `shQuote` itself, not a transcription of what it emits: writer and reader live in two
    // files and can drift.
    for (const path of [
      '/repo/adapters/hook/src/main.ts',
      '/Users/x/claude Code/draftgate/main.ts',
      "/Users/x/o'brien/draftgate/main.ts",
      '/repo/a"b/main.ts',
      '/repo/back\\slash/main.ts',
    ]) {
      expect(commandTokens(`${shQuote('/opt/bun')} ${shQuote(path)}`), path).toEqual([
        '/opt/bun',
        path,
      ]);
      // And the entry is recognised as ours.
      expect(commandNamesHook(`${shQuote('/opt/bun')} ${shQuote(path)}`, path, noRealpath), path)
        .toBe(true);
    }
  });

  test('it undoes the escape shQuote writes for an apostrophe', () => {
    // `shQuote` spells `/a'b/hook.ts` as `'/a'\''b/hook.ts'`. A tokenizer that treats the backslash
    // as ordinary produces `/a\b/hook.ts` and `commandNamesHook` misses: the capped deadline and a
    // "could not find its own registration" line on every review.
    expect(commandTokens(`'bun' '/a'\\''b/hook.ts'`)).toEqual(['bun', "/a'b/hook.ts"]);
  });
});
