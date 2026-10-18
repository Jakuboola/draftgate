/**
 * Reading the registration back.
 *
 * Every case here is a way the event never arrives while every test of what draftgate does with it
 * passes. The two measured facts -- duplicate entries fire concurrently, and deny rules outrank
 * `PreToolUse` -- are asserted as behaviour.
 */

import { describe, expect, test } from 'bun:test';
import {
  EVENT_DEFAULT_TIMEOUT_MS,
  commandNamesHook,
  denyShadows,
  inspectRegistration,
  matcherClaims,
  splitAlternation,
  parseSettings,
  timeoutMsOf,
  settingsPaths,
  settingsSources,
  siblingCheckout,
  type Checkout,
  type SettingsRead,
} from '../src/registration';
import { DEFAULT_TOOL_MAP, matcherCovers, matcherFor, toolHalvesOf } from '../src/toolMap';
import type { ToolMap } from '../src/toolMap';
import { checkoutOf } from '../src/main';
import { commandTokens, shQuote } from '../src/hookCommand';
import { checkoutSettings, failClosedCommand } from './checkoutEntry';
import { reviewDeadline } from '../src/reviewTimeout';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMEOUT_MS } from '../../../cli/src/review';
import { fileURLToPath } from 'node:url';

/** The path a checkout's entry for this hook names, so the round-trip test recognises it. */
const HOOK_SELF = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const HOOK = '/repo/adapters/hook/src/main.ts';
const noRealpath = () => null;

/** A settings file registering this hook for `matcher`, as a checkout's entry does. */
function settingsText(opts: { matcher: string; timeout?: number; command?: string }): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: opts.matcher,
          hooks: [
            {
              type: 'command',
              command: opts.command ?? `'/opt/homebrew/bin/bun' '${HOOK}'`,
              ...(opts.timeout !== undefined && { timeout: opts.timeout }),
            },
          ],
        },
      ],
    },
  });
}

describe('parseSettings', () => {
  test('reads command entries, their matcher, and both deny lists', () => {
    const text = JSON.stringify({
      permissions: { deny: ['mcp__x__send'], allow: ['Bash'] },
      denyTools: ['mcp__y__post'],
      hooks: {
        PreToolUse: [
          { matcher: '^A$', hooks: [{ type: 'command', command: 'a', timeout: 42 }] },
          { matcher: '^B$', hooks: [{ type: 'command', command: 'b' }] },
        ],
      },
    });
    const parsed = parseSettings(text, 'settings.json');
    expect(parsed.problem).toBeUndefined();
    expect(parsed.hooks).toEqual([
      { matcher: '^A$', command: 'a', timeout: 42 },
      { matcher: '^B$', command: 'b' },
    ]);
    // Both lists, concatenated: a `deny` in `permissions.deny` or a top-level `denyTools` blocks the
    // hook.
    expect(parsed.deny).toEqual(['mcp__x__send', 'mcp__y__post']);
  });

  test('skips hook entries that are not commands', () => {
    // Claude Code also has script, callback, function, http, mcp_tool, agent and prompt hooks;
    // draftgate emits only a command, so an entry of another type is not ours however it reads.
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '^A$',
            hooks: [
              { type: 'prompt', prompt: `run ${HOOK}` },
              { type: 'command', command: HOOK },
            ],
          },
        ],
      },
    });
    expect(parseSettings(text, 's').hooks).toEqual([{ matcher: '^A$', command: HOOK }]);
  });

  test('a malformed hooks.PreToolUse does not discard that file\'s deny lists', () => {
    // An early return must not drop them: one typo turning the array into an object would make
    // `--doctor` report zero shadowed tools for a file that is blocking them.
    const parsed = parseSettings(
      JSON.stringify({ permissions: { deny: ['mcp__a__send'] }, hooks: { PreToolUse: {} } }),
      'p'
    );
    expect(parsed.problem).toContain('not an array');
    expect(parsed.deny).toEqual(['mcp__a__send']);
  });

  test('a file that is not JSON, or not an object, yields a problem and no findings', () => {
    expect(parseSettings('{oops', 'p').problem).toContain('not valid JSON');
    expect(parseSettings('[]', 'p').problem).toContain('not a JSON object');
    expect(parseSettings('{oops', 'p').hooks).toEqual([]);
  });

  test('an unrelated key being wrong does not cost the whole file', () => {
    // A hand-edited settings file with a malformed `permissions` still has a readable registration.
    const parsed = parseSettings(
      JSON.stringify({ permissions: [], hooks: { PreToolUse: [{ matcher: '^A$', hooks: [{ type: 'command', command: 'a' }] }] } }),
      'p'
    );
    expect(parsed.problem).toBeUndefined();
    expect(parsed.hooks).toHaveLength(1);
    expect(parsed.deny).toEqual([]);
  });
});

describe('commandNamesHook', () => {
  test('in the fail-closed shape, only what it LAUNCHES counts, not what its messages name', () => {
    // The wrapper names the hook inside its three `ask` messages. An entry whose `$2` runs some
    // other file must not be ours on the strength of that text, or its timeout feeds the clamp.
    const ours = failClosedCommand({ interpreter: '/opt/bun', hook: HOOK });
    expect(commandNamesHook(ours, HOOK, noRealpath)).toBe(true);
    const words = commandTokens(ours);
    words[5] = '/elsewhere/main.ts';
    const other = words.map(shQuote).join(' ');
    expect(other).toContain(HOOK);
    expect(commandNamesHook(other, HOOK, noRealpath)).toBe(false);
  });

  test('matches a bare registration of the hook', () => {
    expect(commandNamesHook(`'bun' '${HOOK}'`, HOOK, noRealpath)).toBe(true);
  });

  test('matches a different spelling of the same file, through realpath', () => {
    // The pasted path and `import.meta.url` can differ without either being wrong: a symlinked
    // home, /tmp against /private/tmp, a repo reached through a worktree link. A substring test
    // alone would report "not registered" on a working install.
    const real = '/private/repo/adapters/hook/src/main.ts';
    const realpath = (p: string) => (p === HOOK || p === '/tmp/link/main.ts' ? real : null);
    expect(commandNamesHook(`'bun' '/tmp/link/main.ts'`, HOOK, realpath)).toBe(true);
  });

  test('does not match another hook that happens to be registered', () => {
    expect(commandNamesHook(`'bun' '/repo/other/hook.ts'`, HOOK, noRealpath)).toBe(false);
  });
});

/**
 * `--doctor` from a git worktree: the registration names the main checkout's copy of the hook, which
 * is the one that runs, so the report is about that one, not three problems on a working install.
 */
describe('siblingCheckout', () => {
  const REL = 'adapters/hook/src/main.ts';
  const WORKTREE = `/wt/${REL}`;
  const MAIN = `/repo/${REL}`;
  const at = (root: string, relative = REL, worktree = false, commonDir = '/repo/.git'): Checkout =>
    ({ root, commonDir, relative, worktree });
  const CHECKOUTS: Record<string, Checkout> = {
    [WORKTREE]: at('/wt', REL, true),
    [MAIN]: at('/repo'),
    [`/clone/${REL}`]: at('/clone', REL, false, '/clone/.git'),
    '/repo/other/main.ts': at('/repo', 'other/main.ts'),
    // Ends with the hook's own relative path, so it passes the cheap filter; only the checkout's
    // answer about where it sits can tell it apart.
    [`/repo/vendor/${REL}`]: at('/repo', `vendor/${REL}`),
  };
  const lookup = (p: string) => CHECKOUTS[p] ?? null;
  const fromWorktree = CHECKOUTS[WORKTREE]!;

  /** One settings file, inspected as the hook at `hookPath` would inspect it. */
  function inspectAt(text: string, hookPath = WORKTREE) {
    return inspectRegistration({
      declined: [],
      read: (p) => (p === '/user.json' ? { kind: 'text', text } : { kind: 'absent' }),
      realpath: noRealpath,
      checkoutOf: lookup,
      paths: ['/user.json'],
      hookPath,
      toolMap: DEFAULT_TOOL_MAP,
    });
  }

  test('the same file in another checkout of the same repository is recognised', () => {
    expect(siblingCheckout(`'bun' '${MAIN}'`, fromWorktree, lookup)?.root).toBe('/repo');
  });

  test('a separate CLONE is not a sibling, whatever its path inside looks like', () => {
    // Same relative path, different repository: a different install, and its registration says
    // nothing about this one.
    expect(siblingCheckout(`'bun' '/clone/${REL}'`, fromWorktree, lookup)).toBeNull();
  });

  test('another file in the same repository is not this hook', () => {
    expect(siblingCheckout(`'bun' '/repo/other/main.ts'`, fromWorktree, lookup)).toBeNull();
    expect(siblingCheckout(`'bun' '/repo/vendor/${REL}'`, fromWorktree, lookup)).toBeNull();
  });

  test('outside any checkout there is no sibling to find', () => {
    const text = settingsText({ matcher: 'x', command: `'bun' '${MAIN}'` });
    expect(inspectAt(text, '/npm/main.ts').ours).toEqual([]);
  });

  test('a sibling checkout is recognised in the fail-closed shape too', () => {
    // The wrapper puts the hook in `$2` and names it again inside three JSON messages. Only the
    // argument is a token `siblingCheckout` can resolve; the messages must not confuse it.
    const matcher = matcherFor(DEFAULT_TOOL_MAP);
    const command = failClosedCommand({ interpreter: '/opt/homebrew/bin/bun', hook: MAIN });
    expect(inspectAt(settingsText({ matcher, timeout: 1260, command })).ours).toEqual([
      {
        source: '/user.json',
        matcher,
        timeout: 1260,
        checkout: { root: '/repo', worktree: false },
        failClosed: true,
      },
    ]);
  });

  test('inspectRegistration counts it as ours, marked with the checkout that runs', () => {
    const matcher = matcherFor(DEFAULT_TOOL_MAP);
    const report = inspectAt(settingsText({ matcher, timeout: 1260, command: `'bun' '${MAIN}'` }));
    expect(report.ours).toEqual([
      {
        source: '/user.json',
        matcher,
        timeout: 1260,
        checkout: { root: '/repo', worktree: false },
        failClosed: false,
      },
    ]);
    // What would follow from `ours: []` as two more problems: coverage and the cap.
    expect(report.unregistered).toEqual([]);
    expect(report.registeredTimeoutMs).toBe(1_260_000);
  });

  test('seen from the MAIN checkout, a registration for a worktree says so', () => {
    // The direction that is easy to get backwards: this registration dies with the worktree.
    const text = settingsText({ matcher: 'x', command: `'bun' '${WORKTREE}'` });
    expect(inspectAt(text, MAIN).ours[0]?.checkout).toEqual({ root: '/wt', worktree: true });
  });

  test('registered for BOTH checkouts is two entries, which is the duplicate it really is', () => {
    const entry = (command: string, timeout: number) =>
      ({ matcher: 'x', hooks: [{ type: 'command', command, timeout }] });
    const report = inspectAt(JSON.stringify({
      hooks: { PreToolUse: [entry(`'bun' '${MAIN}'`, 1260), entry(`'bun' '${WORKTREE}'`, 660)] },
    }));
    expect(report.ours.map((h) => h.checkout?.root)).toEqual(['/repo', undefined]);
    // Two windows fire, so the shorter deadline is still the one that must be outlived.
    expect(report.registeredTimeoutMs).toBe(660_000);
  });
});

describe('checkoutOf, against a real worktree', () => {
  // The fake above proves the comparison; this proves the read of git's own file layout.
  test('a main checkout and its worktree share a common dir and differ in root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'draftgate-checkout-'));
    try {
      const main = join(dir, 'main');
      mkdirSync(join(main, 'adapters/hook/src'), { recursive: true });
      writeFileSync(join(main, 'adapters/hook/src/main.ts'), '');
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' });
      git('init', '-q');
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
      git('worktree', 'add', '-q', join(dir, 'wt'));

      const a = checkoutOf(join(main, 'adapters/hook/src/main.ts'));
      const b = checkoutOf(join(dir, 'wt', 'adapters/hook/src/main.ts'));
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(b!.commonDir).toBe(a!.commonDir);
      expect(b!.root).not.toBe(a!.root);
      expect(b!.relative).toBe('adapters/hook/src/main.ts');
      expect([a!.worktree, b!.worktree]).toEqual([false, true]);
      expect(siblingCheckout(`'bun' '${join(main, 'adapters/hook/src/main.ts')}'`, b!, checkoutOf)
        ?.root).toBe(a!.root);
      expect(checkoutOf(join(tmpdir(), 'no-such-file.ts'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('matcherClaims', () => {
  test('decomposes the generated matcher into its literals AND its inferred halves', () => {
    const claims = matcherClaims(matcherFor(DEFAULT_TOOL_MAP));
    expect(claims!.names).toEqual(Object.keys(DEFAULT_TOOL_MAP).sort());
    expect(claims!.halves).toEqual(toolHalvesOf(DEFAULT_TOOL_MAP));
  });

  test('the half branch is not torn apart by the separator inside it', () => {
    /*
     * The reason `splitAlternation` exists: a flat `split('|')` shatters the trailing
     * `mcp__<server>__(?:a|b|c)` branch into fragments that look malformed, so the matcher would
     * degrade to "opaque" and the drift check would stop running.
     */
    expect(splitAlternation('a|b(c|d)|e')).toEqual(['a', 'b(c|d)', 'e']);
    expect(splitAlternation('a\\|b|c')).toEqual(['a\\|b', 'c']);
  });

  test('returns null for a pattern that is not an anchored alternation', () => {
    // Not a failure: "some regex" is not guessed at; the report says `opaqueMatchers`.
    expect(matcherClaims('mcp__.*')).toBeNull();
    expect(matcherClaims('^(?:a|b.*)$')).toBeNull();
    expect(matcherClaims('^(?:)$')).toBeNull();
  });
});

describe('matcherCovers', () => {
  test('the anchors are what keep slack_send_message off slack_send_message_draft', () => {
    const matcher = matcherFor({ mcp__s__slack_send_message: { destination: 'slack' } } as unknown as ToolMap);
    expect(matcherCovers(matcher, 'mcp__s__slack_send_message')).toBe(true);
    expect(matcherCovers(matcher, 'mcp__s__slack_send_message_draft')).toBe(false);
  });

  test('a pattern that will not compile fires for nothing', () => {
    expect(matcherCovers('^(?:[a$', 'anything')).toBe(false);
  });
});

describe('denyShadows', () => {
  test('an exact name and a specifier form both shadow; a prefix does not', () => {
    expect(denyShadows('mcp__a__send', 'mcp__a__send')).toBe(true);
    expect(denyShadows('mcp__a__send(x)', 'mcp__a__send')).toBe(true);
    // Reporting a gated tool as blocked when it is not sends the operator to edit an unrelated deny
    // list.
    expect(denyShadows('mcp__a__send_draft', 'mcp__a__send')).toBe(false);
  });
});

describe('settingsPaths', () => {
  test('honours CLAUDE_CONFIG_DIR, because Claude Code does', () => {
    const paths = settingsPaths({ CLAUDE_CONFIG_DIR: '/cfg' }, '/proj', () => '/home', 'darwin');
    expect(paths).toContain('/cfg/settings.json');
    expect(paths).not.toContain('/home/.claude/settings.json');
  });

  test('reads the project pair from the payload cwd, and managed settings first', () => {
    const paths = settingsPaths({}, '/proj', () => '/home', 'darwin');
    expect(paths[0]).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(paths).toEqual([
      '/Library/Application Support/ClaudeCode/managed-settings.json',
      '/home/.claude/settings.json',
      '/proj/.claude/settings.json',
      '/proj/.claude/settings.local.json',
    ]);
  });

  test('in the home directory the project file IS the user file, and is listed once, as the user\'s', () => {
    /*
     * Claude Code 2.1.287 loads it once: its merged-settings builder skips a source whose
     * `path.resolve`d file it already read, and hooks come from that merge. Listed twice, one
     * registration would count as two, and `--doctor` would report "registered 2 times" from `~`.
     */
    expect(settingsSources({}, '/home', () => '/home', 'darwin')).toEqual([
      { path: '/Library/Application Support/ClaudeCode/managed-settings.json', scope: 'managed' },
      { path: '/home/.claude/settings.json', scope: 'user' },
      { path: '/home/.claude/settings.local.json', scope: 'local' },
    ]);
    // By the RESOLVED path, as Claude Code compares: a trailing slash or a `..` is the same file.
    expect(settingsPaths({}, '/home/', () => '/home', 'linux')).toHaveLength(3);
    expect(settingsPaths({ CLAUDE_CONFIG_DIR: '/x/../home/.claude' }, '/home', () => '/elsewhere', 'linux')).toHaveLength(3);
    // A config dir somewhere else is a different file, read as its own.
    expect(settingsPaths({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home', () => '/home', 'linux')).toEqual([
      '/etc/claude-code/managed-settings.json',
      '/cfg/settings.json',
      '/home/.claude/settings.json',
      '/home/.claude/settings.local.json',
    ]);
  });

  test('with no cwd and no CLAUDE_PROJECT_DIR, the project pair is simply not named', () => {
    const paths = settingsPaths({}, undefined, () => '/home', 'linux');
    expect(paths).toEqual(['/etc/claude-code/managed-settings.json', '/home/.claude/settings.json']);
  });
});

describe('inspectRegistration', () => {
  const MAP = {
    mcp__a__send: { destination: 'slack' },
    mcp__b__comment: { destination: 'jira' },
  } as unknown as ToolMap;

  /** Absent unless the fixture names it; `unreadable` gets its own case below. */
  function reader(files: Record<string, string>) {
    return (p: string): SettingsRead =>
      p in files ? { kind: 'text', text: files[p]! } : { kind: 'absent' };
  }

  function inspect(files: Record<string, string>, toolMap: ToolMap = MAP) {
    return inspectRegistration({
      declined: [],
      read: reader(files),
      realpath: noRealpath,
      paths: ['/managed.json', '/user.json', '/proj.json'],
      hookPath: HOOK,
      toolMap,
    });
  }

  test('a healthy install has one entry, full coverage and nothing to report', () => {
    const report = inspect({ '/user.json': settingsText({ matcher: matcherFor(MAP), timeout: 1260 }) });
    expect(report.ours).toHaveLength(1);
    expect(timeoutMsOf(report.ours[0]!)).toBe(1_260_000);
    expect(report.registeredTimeoutMs).toBe(1_260_000);
    expect(report.unregistered).toEqual([]);
    expect(report.unmapped).toEqual([]);
  });

  test('a tool added to the map and never re-pasted is reported as unregistered', () => {
    // The silent one: the hook is never invoked, so no window and no audit row; the send happens.
    // Only this comparison sees it, on the next review of some other tool.
    const stale = matcherFor({ mcp__a__send: { destination: 'slack' } } as unknown as ToolMap);
    const report = inspect({ '/user.json': settingsText({ matcher: stale, timeout: 1260 }) });
    expect(report.unregistered).toEqual(['mcp__b__comment']);
  });

  test('a name in the matcher that the map lost is reported as unmapped', () => {
    const wide = matcherFor({
      ...MAP,
      mcp__c__gone: { destination: 'linear' },
    } as unknown as ToolMap);
    const report = inspect({ '/user.json': settingsText({ matcher: wide, timeout: 1260 }) });
    // Those arrive here and are denied (exception 3): the operator sees a refused send and no reason
    // to look at their own config.
    expect(report.unmapped).toEqual(['mcp__c__gone']);
  });

  test('an opaque matcher is named rather than decomposed, and coverage is still checked', () => {
    const report = inspect({ '/user.json': settingsText({ matcher: '^mcp__a__.*$', timeout: 1260 }) });
    expect(report.opaqueMatchers).toEqual(['^mcp__a__.*$']);
    expect(report.unmapped).toEqual([]);
    expect(report.unregistered).toEqual(['mcp__b__comment']);
  });

  test('two registrations are both found, and the SHORTEST timeout is the ceiling', () => {
    // Measured: both entries fire, concurrently, and a deny from either decides the call, so the
    // clamp reads the smallest registered deadline.
    const report = inspect({
      '/user.json': settingsText({ matcher: matcherFor(MAP), timeout: 1260 }),
      '/proj.json': settingsText({ matcher: matcherFor(MAP), timeout: 660 }),
    });
    expect(report.ours).toHaveLength(2);
    expect(report.registeredTimeoutMs).toBe(660_000);
  });

  test('an entry with no timeout falls to the event default, not to no limit', () => {
    const report = inspect({ '/user.json': settingsText({ matcher: matcherFor(MAP) }) });
    expect(report.ours[0]!.timeout).toBeUndefined();
    expect(timeoutMsOf(report.ours[0]!)).toBe(EVENT_DEFAULT_TIMEOUT_MS);
  });

  test('timeout: 0 means the event default, exactly as the runtime reads it', () => {
    // `hook.timeout !== undefined && hook.timeout > 0 ? hook.timeout * 1000 : default`, verified in
    // 2.1.268. Reading 0 as zero would compute a negative deadline out of a registration that in
    // fact allows ten minutes.
    const report = inspect({ '/user.json': settingsText({ matcher: matcherFor(MAP), timeout: 0 }) });
    expect(timeoutMsOf(report.ours[0]!)).toBe(EVENT_DEFAULT_TIMEOUT_MS);
  });

  test('a deny rule in any scanned file shadows the gate', () => {
    const report = inspect({
      '/user.json': settingsText({ matcher: matcherFor(MAP), timeout: 1260 }),
      '/proj.json': JSON.stringify({ permissions: { deny: ['mcp__b__comment'] } }),
    });
    expect(report.shadowed).toEqual([
      { tool: 'mcp__b__comment', rule: 'mcp__b__comment', source: '/proj.json' },
    ]);
  });

  test('no registration anywhere is reported as such, not as a healthy read', () => {
    const report = inspect({});
    expect(report.ours).toEqual([]);
    expect(report.registeredTimeoutMs).toBeUndefined();
    expect(report.unregistered).toEqual(Object.keys(MAP));
    expect(report.scanned.every((s) => !s.present)).toBe(true);
  });

  test('a settings file that EXISTS and cannot be read is not reported as absent', () => {
    /*
     * `~/.claude/settings.json` is `-rw-------`, and a macOS TCC denial turns reads into EPERM.
     * Collapsed into "absent", `--doctor` would print the file as missing and count no problems.
     */
    const report = inspectRegistration({
      declined: [],
      read: (p) => (p === '/user.json' ? { kind: 'unreadable', why: 'EPERM' } : { kind: 'absent' }),
      realpath: noRealpath,
      paths: ['/user.json'],
      hookPath: HOOK,
      toolMap: MAP,
    });
    const row = report.scanned.find((s) => s.path === '/user.json')!;
    expect(row.present).toBe(true);
    expect(row.problem).toContain('EPERM');
  });

  test('an unreadable settings file is a finding, never an exception', () => {
    const report = inspect({ '/user.json': '{ broken' });
    expect(report.scanned.find((s) => s.path === '/user.json')?.problem).toContain('not valid JSON');
    // and the registration is not invented out of a file that did not parse
    expect(report.ours).toEqual([]);
  });

  test("a checkout's real settings entry parses back to a clean install", () => {
    /*
     * Writer (`checkoutSettings`) into reader (`parseSettings`): the fixtures above build the JSON by
     * hand, so a change in the emitted shape fails only here.
     */
    const report = inspectRegistration({
      declined: [],
      read: () => ({
        kind: 'text',
        text: checkoutSettings(DEFAULT_TOOL_MAP, { hook: HOOK_SELF }),
      }),
      realpath: (p) => p,
      paths: ['/user.json'],
      hookPath: HOOK_SELF,
      toolMap: DEFAULT_TOOL_MAP,
    });
    expect(report.ours).toHaveLength(1);
    expect(timeoutMsOf(report.ours[0]!)).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    expect(report.unregistered).toEqual([]);
    expect(report.unmapped).toEqual([]);
    // What it prints is the fail-closed wrapper, and it reads back as that.
    expect(report.ours[0]!.failClosed).toBe(true);
    // The wrapper costs the deadline nothing: the clamp reads the same `timeout` a bare entry gives.
    expect(reviewDeadline(DEFAULT_TIMEOUT_MS, report.registeredTimeoutMs)).toEqual({
      ms: DEFAULT_TIMEOUT_MS,
      wantedMs: DEFAULT_TIMEOUT_MS,
      basis: { kind: 'asked' },
    });
  });

  test('the bare shape is still OURS, and does not fail closed', () => {
    // A registration stays the bare `'<bun>' '<hook>'` until re-registered; losing sight of it would
    // cap its reviews at the event default and report "not registered" on a working gate.
    const matcher = matcherFor(DEFAULT_TOOL_MAP);
    const bare = settingsText({ matcher, timeout: 1260 });
    const wrapped = settingsText({
      matcher,
      timeout: 1260,
      command: failClosedCommand({ interpreter: '/opt/homebrew/bin/bun', hook: HOOK }),
    });
    const at = (text: string) => inspect({ '/user.json': text }, DEFAULT_TOOL_MAP);
    expect(at(bare).ours).toEqual([{ source: '/user.json', matcher, timeout: 1260, failClosed: false }]);
    expect(at(wrapped).ours).toEqual([{ source: '/user.json', matcher, timeout: 1260, failClosed: true }]);
    // Same registration in every other respect, deadline included.
    expect(at(wrapped).registeredTimeoutMs).toBe(at(bare).registeredTimeoutMs);
  });
});
