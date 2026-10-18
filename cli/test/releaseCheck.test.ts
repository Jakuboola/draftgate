/**
 * The daily release check, against real git: local bare repositories laid out the way a release is,
 * and two remotes served from this process -- one that accepts and never answers, one that asks for
 * credentials.
 *
 * Every git here runs with no config of the machine's (`GIT_ENV`), so nothing reaches the keychain.
 *
 * The boundary tests run the spawner in a subprocess with piped stdio, as the hook runs the CLI, and
 * judge it by when its pipes close and by the file the detached check writes.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKOUT,
  CHECK_INTERVAL_MS,
  checkDue,
  headCommit,
  installIdentity,
  installedRelease,
  isNewerRelease,
  isReleaseTag,
  newestRelease,
  parseLsRemote,
  parseReleaseState,
  originUrl,
  anonymousEnv,
  readReleaseState,
  releaseNotice,
  releaseStatePath,
  releaseStatus,
  startReleaseCheck,
  type ReleaseState,
} from '../src/releaseCheck';
import { fixtureGit } from './releaseClone';
import { checkFinished, until } from './releaseFixture';
import { REMEDY } from '../../core/src/remedies';

const SCRATCH = mkdtempSync(join(tmpdir(), 'draftgate-release-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const MODULE = join(import.meta.dir, '..', 'src', 'releaseCheck.ts');
/**
 * No config of this machine's: no system file (Apple's git ships `credential.helper=osxkeychain`),
 * a global file of our own.
 */
const { env: GIT_ENV, git } = fixtureGit(join(SCRATCH, 'git-home'));

let n = 0;
/** A fresh directory under the scratch root. */
function dir(name: string): string {
  const d = join(SCRATCH, `${name}-${++n}`);
  mkdirSync(d);
  return d;
}

/**
 * An origin laid out as a release's is: releases are tags on `main`, and `stable` gets a commit of
 * its own per release that merges the tag and adds the built window, so stable's tip descends from
 * the tag and is never the tagged commit.
 */
function makeOrigin() {
  const root = dir('origin');
  const bare = join(root, 'bare.git');
  const dev = join(root, 'dev');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, dev);
  const commit = (message: string) => git(dev, 'commit', '-q', '--allow-empty', '-m', message);
  const release = (tag: string) => {
    git(dev, 'checkout', '-q', 'stable');
    git(dev, 'merge', '-q', '--no-ff', '--no-commit', tag);
    writeFileSync(join(dev, 'built-window.txt'), tag);
    git(dev, 'add', 'built-window.txt');
    git(dev, 'commit', '-q', '-m', `release ${tag}`);
    git(dev, 'checkout', '-q', 'main');
    git(dev, 'push', '-q', 'origin', 'main', 'stable', '--tags');
  };
  commit('one');
  git(dev, 'tag', 'v0.1.0');
  git(dev, 'branch', 'stable');
  release('v0.1.0');
  return {
    bare,
    dev,
    commit,
    release,
    /** An annotated tag, the kind `ls-remote` lists twice. */
    tagAnnotated: (tag: string) => git(dev, 'tag', '-a', tag, '-m', tag),
    tagLight: (tag: string) => git(dev, 'tag', tag),
  };
}

/** An origin no test changes, for the ones that only need a user's clone of it. */
let shared: ReturnType<typeof makeOrigin> | undefined;
const sharedOrigin = () => (shared ??= makeOrigin());

/** A user's install: a clone of `stable`, as the install line makes one. */
function userClone(bare: string): string {
  const user = join(dir('user'), 'app');
  git(SCRATCH, 'clone', '-q', '-b', 'stable', bare, user);
  return user;
}

/** A draftgate home of its own, and the env a check runs with. */
function homeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...GIT_ENV, DRAFTGATE_HOME: dir('home'), ...extra };
}

/**
 * Run the spawner the way a hook runs: in a process of its own, every stdio a pipe, then
 * `process.exit`. Resolves when the pipes close, which is what a caller waits on.
 */
const SPAWNER = join(SCRATCH, 'spawner.ts');
writeFileSync(
  SPAWNER,
  `import { startReleaseCheck } from ${JSON.stringify(MODULE)};\n` +
    `const [checkout, timeout, now] = process.argv.slice(2);\n` +
    `const config = { releaseCheck: true };\n` +
    `process.stdout.write(startReleaseCheck({ config, checkout, timeoutMs: Number(timeout), ...(now ? { now: new Date(now) } : {}) }));\n` +
    `process.exit(0);\n`
);
function runSpawner(
  checkout: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  now?: Date
): Promise<{ out: string; closedAt: number }> {
  return new Promise((done) => {
    // From inside the checkout, as a hook runs inside somebody's project: a git the check runs in
    // the caller's directory would read that repository's config.
    const child = spawn(process.execPath, [SPAWNER, checkout, String(timeoutMs), now?.toISOString() ?? ''], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: checkout,
      env,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', () => {});
    child.on('close', () => done({ out, closedAt: Date.now() }));
  });
}

/** The end-to-end tests' budget: real git and a real child, on a machine up to ten lanes share. */
const E2E_MS = 60_000;

/** The state once the check its claim started has finished. */
const finished = (env: NodeJS.ProcessEnv) => () => checkFinished(env);

describe('release tags', () => {
  test('a release is exactly vX.Y.Z', () => {
    for (const ok of ['v0.1.0', 'v1.22.333', 'v0.0.0']) expect(isReleaseTag(ok), ok).toBe(true);
    for (const bad of ['0.1.0', 'v1.2', 'v1.2.3-rc1', 'v01.2.3', 'v1.2.3.4', 'v1.2.3\n', 'V1.2.3', '']) {
      expect(isReleaseTag(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test('ordering is numeric, per part, at any size', () => {
    expect(isNewerRelease('v0.10.0', 'v0.9.0')).toBe(true);
    expect(isNewerRelease('v1.0.0', 'v0.99.99')).toBe(true);
    expect(isNewerRelease('v0.2.1', 'v0.2.0')).toBe(true);
    expect(isNewerRelease('v0.2.0', 'v0.2.0')).toBe(false);
    expect(isNewerRelease('v0.9.0', 'v0.10.0')).toBe(false);
    // Two versions `Number` would call equal.
    expect(isNewerRelease('v12345678901234567891.0.0', 'v12345678901234567890.0.0')).toBe(true);
    expect(isNewerRelease('v1.0.0', 'not-a-release')).toBe(false);
    expect(newestRelease(['v0.9.0', 'v0.10.0-rc1', 'v0.10.0', 'latest', 'v0.2.0'])).toBe('v0.10.0');
    expect(newestRelease(['main', 'v1.0.0-rc1'])).toBeNull();
  });
});

describe('parseLsRemote, on git\'s own output', () => {
  test('stable, a light tag, an annotated one listed twice, and a release candidate', () => {
    const o = makeOrigin();
    o.tagAnnotated('v0.2.0');
    o.tagLight('v0.10.0-rc1');
    git(o.dev, 'push', '-q', 'origin', '--tags');
    const listing = git(o.dev, 'ls-remote', 'origin', 'refs/heads/stable', 'refs/tags/v*');
    expect(listing).toContain('refs/tags/v0.2.0^{}');
    expect(parseLsRemote(listing)).toEqual({
      latest: 'v0.2.0',
      stable: git(o.bare, 'rev-parse', 'refs/heads/stable'),
    });
  });

  test('no stable, no tags, and a listing cut mid-line', () => {
    expect(parseLsRemote('')).toEqual({ latest: null, stable: null });
    const cut = `${'a'.repeat(40)}\trefs/tags/v0.1.0\n${'b'.repeat(40)}\trefs/tags/v0.`;
    expect(parseLsRemote(cut)).toEqual({ latest: 'v0.1.0', stable: null });
  });
});

describe('headCommit reads what `git rev-parse HEAD` says, off git\'s files', () => {
  test('a fresh clone (a loose branch), after packing, and detached', () => {
    const user = userClone(sharedOrigin().bare);
    expect(headCommit(user)).toBe(git(user, 'rev-parse', 'HEAD'));
    git(user, 'pack-refs', '--all');
    expect(existsSync(join(user, '.git', 'refs', 'heads', 'stable'))).toBe(false);
    expect(headCommit(user)).toBe(git(user, 'rev-parse', 'HEAD'));
    git(user, 'checkout', '-q', '--detach', 'HEAD~1');
    expect(headCommit(user)).toBe(git(user, 'rev-parse', 'HEAD'));
  });

  test('a linked worktree, whose HEAD and branches live in two directories', () => {
    const o = makeOrigin();
    const tree = join(dir('worktree'), 'tree');
    git(o.dev, 'worktree', 'add', '-q', '-b', 'side', tree, 'v0.1.0');
    git(tree, 'commit', '-q', '--allow-empty', '-m', 'on side');
    expect(headCommit(tree)).toBe(git(tree, 'rev-parse', 'HEAD'));
    expect(headCommit(tree)).not.toBe(headCommit(o.dev));
  });

  test('nothing it cannot read: no checkout, an unborn branch', () => {
    expect(headCommit(dir('plain'))).toBeNull();
    const empty = dir('empty');
    git(empty, 'init', '-q');
    expect(headCommit(empty)).toBeNull();
  });
});

describe('installedRelease: the newest release REACHABLE from HEAD', () => {
  test("stable's tip is not a tagged commit, and still reads as the release it carries", () => {
    const o = makeOrigin();
    const user = userClone(o.bare);
    expect(git(user, 'tag', '--points-at', 'HEAD')).toBe('');
    expect(installedRelease(user, GIT_ENV)).toEqual({ have: 'v0.1.0' });
  });

  test('a newer tag elsewhere, and a release candidate, are not what you have', () => {
    const o = makeOrigin();
    o.commit('two');
    o.tagLight('v0.2.0');
    o.tagLight('v0.3.0-rc1');
    git(o.dev, 'push', '-q', 'origin', 'main', '--tags');
    const user = userClone(o.bare);
    git(user, 'fetch', '-q', '--tags');
    expect(git(user, 'tag', '--list', 'v0.2.0')).toBe('v0.2.0');
    expect(installedRelease(user, GIT_ENV)).toEqual({ have: 'v0.1.0' });
  });

  test('no release tag at all is no version', () => {
    const repo = dir('untagged');
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(installedRelease(repo, GIT_ENV)).toEqual({ have: null });
  });

  test('a git that cannot answer is a failure, never "no version"', () => {
    // Not a repository is the reproducible stand-in for another user's checkout without
    // `safe.directory`: git exits 128 either way, and "unreleased" would be a claim nobody checked.
    expect(installedRelease(dir('nothing'), GIT_ENV)).toEqual({ failed: 'git exited 128' });
  });
});

describe('originUrl and anonymousEnv: what the request is allowed to carry', () => {
  test("origin's URL, raw, with any user and password taken out", () => {
    const repo = dir('urls');
    git(repo, 'init', '-q');
    expect(originUrl(repo, GIT_ENV)).toBeNull();
    git(repo, 'remote', 'add', 'origin', 'https://someone:ghp_token@github.com/Jakuboola/draftgate.git');
    expect(originUrl(repo, GIT_ENV)).toBe('https://github.com/Jakuboola/draftgate.git');
    // A rewrite in somebody's config is configuration, which the check does not use.
    git(repo, 'config', 'url.git@github.com:.insteadOf', 'https://github.com/');
    expect(originUrl(repo, GIT_ENV)).toBe('https://github.com/Jakuboola/draftgate.git');
  });

  test('built from nothing: PATH, the proxies and GIT_ALLOW_PROTOCOL, and no config at all', () => {
    const env = anonymousEnv({
      PATH: '/p',
      HOME: '/Users/someone',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_ASKPASS: '/Applications/IDE/askpass',
      SSH_AUTH_SOCK: '/tmp/agent',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer x',
    });
    expect(env).toEqual({
      PATH: '/p',
      HOME: '/var/empty',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      GIT_ALLOW_PROTOCOL: 'file',
    });
  });
});

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const AT = '2026-10-02T10:00:00.000Z';
const LATER = '2026-10-02T10:00:01.000Z';
function stateOf(result: Partial<NonNullable<ReleaseState['result']>> = {}): ReleaseState {
  return {
    attemptedAt: AT,
    result: {
      attemptedAt: AT,
      finishedAt: LATER,
      head: HEAD,
      have: 'v0.2.0',
      remote: { latest: 'v0.3.0', stable: OTHER },
      ...result,
    },
  };
}

describe('releaseNotice: the one line, and every way it could be false', () => {
  test('the line', () => {
    expect(releaseNotice(stateOf(), HEAD)).toBe(
      `draftgate v0.3.0 is out (you have v0.2.0), run ${REMEDY.installPlugin}.`
    );
  });

  test('silent for every state in which it might not be true', () => {
    const cases: [string, ReleaseState | null, string | null][] = [
      ['no file', null, HEAD],
      ['no finished check', { attemptedAt: AT }, HEAD],
      ['HEAD unreadable now', stateOf(), null],
      ['HEAD moved since the check', stateOf(), OTHER],
      ['HEAD unreadable then', stateOf({ head: undefined }), HEAD],
      ['no release here', stateOf({ have: null, remote: undefined }), HEAD],
      ['origin did not answer', stateOf({ remote: { failed: 'no answer within 10s' } }), HEAD],
      ['origin has no release', stateOf({ remote: { latest: null, stable: OTHER } }), HEAD],
      ['origin has the same one', stateOf({ remote: { latest: 'v0.2.0', stable: OTHER } }), HEAD],
      ['origin has an older one', stateOf({ remote: { latest: 'v0.1.0', stable: OTHER } }), HEAD],
      // The tag is out and `stable` has not moved: a pull would change nothing.
      ['stable IS this HEAD', stateOf({ remote: { latest: 'v0.3.0', stable: HEAD } }), HEAD],
    ];
    for (const [why, state, head] of cases) expect(releaseNotice(state, head), why).toBeNull();
  });
});

describe('releaseStatus: what --doctor is told', () => {
  const ON = { releaseCheck: true };
  const SOON = new Date(Date.parse(AT) + 5_000);
  const status = (state: ReleaseState | null, head: string | null = HEAD) =>
    releaseStatus(state, head, ON, SOON);

  test('one kind per state, and the notice wherever a review would print it', () => {
    const next = new Date(Date.parse(AT) + CHECK_INTERVAL_MS).toISOString();
    expect(releaseStatus(stateOf(), HEAD, { releaseCheck: false })).toEqual({ kind: 'off' });
    expect(releaseStatus(stateOf(), HEAD, { releaseCheck: false, releaseCheckOffBecause: 'c.json: bad' })).toEqual({
      kind: 'off', because: 'c.json: bad',
    });
    expect(status(null)).toEqual({ kind: 'unchecked' });
    expect(status({ attemptedAt: AT })).toEqual({ kind: 'running', attemptedAt: AT });
    expect(status(stateOf({ head: undefined, have: null, remote: undefined })).kind).toBe('no-head');
    expect(status(stateOf({ have: null, local: 'git exited 128', remote: undefined }))).toEqual({
      kind: 'git-failed', why: 'git exited 128', checkedAt: LATER, nextAt: next,
    });
    expect(status(stateOf({ have: null, remote: undefined })).kind).toBe('unreleased');
    expect(status(stateOf(), OTHER)).toEqual({ kind: 'moved', checkedAt: LATER, nextAt: next });
    expect(status(stateOf({ remote: { failed: 'git exited 128' } }))).toEqual({
      kind: 'failed', why: 'git exited 128', checkedAt: LATER, nextAt: next,
    });
    expect(status(stateOf({ remote: { latest: 'v0.2.0', stable: OTHER } }))).toEqual({
      kind: 'current', have: 'v0.2.0', checkedAt: LATER,
    });
    expect(status(stateOf())).toEqual({
      kind: 'newer', line: releaseNotice(stateOf(), HEAD)!,
    });
    // A new check running over an old result that says "newer": still newer, as a review prints it.
    const runningOverNewer = { ...stateOf(), attemptedAt: '2026-10-03T10:00:00.000Z' };
    expect(releaseStatus(runningOverNewer, HEAD, ON, new Date('2026-10-03T10:00:05.000Z')).kind).toBe('newer');
    expect(releaseNotice(runningOverNewer, HEAD)).not.toBeNull();
  });

  test('a claim nothing answered is running for as long as a check can take, and dead after', () => {
    const at = Date.parse(AT);
    expect(releaseStatus({ attemptedAt: AT }, HEAD, ON, new Date(at + 30_000)).kind).toBe('running');
    expect(releaseStatus({ attemptedAt: AT }, HEAD, ON, new Date(at + 10 * 60_000))).toEqual({
      kind: 'unfinished',
      attemptedAt: AT,
      nextAt: new Date(at + CHECK_INTERVAL_MS).toISOString(),
    });
  });
});

describe('checkDue: at most once a day, counted from the last ATTEMPT', () => {
  test('due with no file, after a day, and after a clock that moved back', () => {
    const at = new Date(AT);
    expect(checkDue(null, at)).toBe(true);
    expect(checkDue({ attemptedAt: AT }, at)).toBe(false);
    expect(checkDue({ attemptedAt: AT }, new Date(at.getTime() + CHECK_INTERVAL_MS - 1))).toBe(false);
    expect(checkDue({ attemptedAt: AT }, new Date(at.getTime() + CHECK_INTERVAL_MS))).toBe(true);
    expect(checkDue({ attemptedAt: AT }, new Date(at.getTime() - 1000))).toBe(true);
  });
});

describe('parseReleaseState: nothing untrusted reaches a message', () => {
  const file = (o: object) => JSON.stringify({ version: 1, ...o });

  test('what the writer writes reads back', () => {
    expect(parseReleaseState(file(stateOf()))).toEqual(stateOf());
    expect(parseReleaseState(file({ attemptedAt: AT }))).toEqual({ attemptedAt: AT });
  });

  test('a tag that is not a release, or a commit that is not one, drops the result and keeps the claim', () => {
    for (const result of [
      { ...stateOf().result, remote: { failed: 'see https://evil.test for the fix' } },
      { ...stateOf().result, have: null, local: 'anything at all', remote: undefined },
      { ...stateOf().result, finishedAt: '2026-10-02T12:00:00+02:00' },
      { ...stateOf().result, remote: { latest: 'v9.9.9; see https://evil.test', stable: OTHER } },
      { ...stateOf().result, have: 'v0.2.0\nPROBLEM: forged' },
      { ...stateOf().result, head: 'HEAD' },
      // A release here and nothing asked: not something the check writes.
      { ...stateOf().result, remote: undefined },
    ]) {
      expect(parseReleaseState(file({ attemptedAt: AT, result }))).toEqual({ attemptedAt: AT });
    }
  });

  test('a file this build cannot read is no file', () => {
    for (const text of [
      '', '{', '[]',
      JSON.stringify({ version: 2, attemptedAt: AT }),
      file({ attemptedAt: 'yesterday' }),
      // An offset is not an instant this module writes, and would print as the wrong time.
      file({ attemptedAt: '2026-10-02T12:00:00+02:00' }),
    ]) {
      expect(parseReleaseState(text)).toBeNull();
    }
  });
});

describe('the check, end to end, against a local bare origin', () => {
  test('a user behind a release: the next review has its line, and loses it on update', async () => {
    const o = makeOrigin();
    const user = userClone(o.bare);
    o.commit('two');
    o.tagAnnotated('v0.2.0');
    o.release('v0.2.0');
    const env = homeEnv();

    const startedAt = Date.now();
    expect((await runSpawner(user, 10_000, env)).out).toBe('started');
    const state = await until(finished(env), 15_000, 'the check to finish');
    expect(state.result).toMatchObject({
      head: git(user, 'rev-parse', 'HEAD'),
      have: 'v0.1.0',
      remote: { latest: 'v0.2.0', stable: git(o.bare, 'rev-parse', 'refs/heads/stable') },
    });
    expect(Date.parse(state.attemptedAt)).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(releaseNotice(readReleaseState(env), headCommit(user))).toBe(
      `draftgate v0.2.0 is out (you have v0.1.0), run ${REMEDY.installPlugin}.`
    );

    // A pull of `stable` is a fast-forward. The line goes at once (HEAD moved), and the next
    // check finds nothing newer.
    git(user, 'pull', '-q', '--ff-only');
    expect(releaseNotice(readReleaseState(env), headCommit(user))).toBeNull();
    const tomorrow = new Date(Date.now() + CHECK_INTERVAL_MS);
    expect((await runSpawner(user, 10_000, env, tomorrow)).out).toBe('started');
    const after = await until(
      () => { const s = finished(env)(); return s?.attemptedAt === tomorrow.toISOString() ? s : undefined; },
      15_000,
      'the second check'
    );
    expect(after.result!.attemptedAt).toBe(tomorrow.toISOString());
    expect(after.result).toMatchObject({ have: 'v0.2.0', remote: { latest: 'v0.2.0' } });
    expect(releaseStatus(after, headCommit(user), { releaseCheck: true })).toMatchObject({ kind: 'current', have: 'v0.2.0' });
  }, E2E_MS);

  test('not due: a second review the same day starts nothing', async () => {
    const user = userClone(sharedOrigin().bare);
    const env = homeEnv();
    expect((await runSpawner(user, 10_000, env)).out).toBe('started');
    const first = await until(finished(env), 15_000, 'the first check');
    expect((await runSpawner(user, 10_000, env)).out).toBe('not-due');
    expect(readReleaseState(env)).toEqual(first);
    // Private, like everything under the draftgate home.
    expect(statSync(releaseStatePath(env)).mode & 0o777).toBe(0o600);
  }, E2E_MS);

  test('a claim it cannot record starts nothing, rather than a check after every review', () => {
    const home = join(dir('blocked'), 'home');
    writeFileSync(home, 'a file where the directory should be');
    const env = { ...GIT_ENV, DRAFTGATE_HOME: home };
    expect(startReleaseCheck({ config: { releaseCheck: true }, checkout: dir('x'), env })).toBe('unrecorded');
  });

  test('off is answered by the starter itself, before anything is read or written', () => {
    const env = homeEnv();
    expect(startReleaseCheck({ config: { releaseCheck: false }, checkout: dir('x'), env })).toBe('off');
    expect(existsSync(env.DRAFTGATE_HOME! + '/release-check.json')).toBe(false);
  });

  /** A remote that accepts every connection and never says a word. */
  function hungRemote() {
    let accepted = 0;
    const open = new Set<unknown>();
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(s) { accepted++; open.add(s); },
        close(s) { open.delete(s); },
        data() {},
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}/draftgate.git`,
      accepted: () => accepted,
      open: () => open.size,
      stop: () => server.stop(true),
    };
  }

  test('a remote that never answers delays nobody, and leaves nothing connected', async () => {
    const remote = hungRemote();
    try {
      const user = userClone(sharedOrigin().bare);
      git(user, 'remote', 'set-url', 'origin', remote.url);
      const env = homeEnv();
      const timeoutMs = 1000;

      const { out, closedAt } = await runSpawner(user, timeoutMs, env);
      expect(out).toBe('started');
      // Still hanging on the remote when the caller was long done.
      await until(() => (remote.accepted() > 0 ? true : undefined), 10_000, 'git to connect');
      expect(readReleaseState(env)?.result).toBeUndefined();

      const state = await until(finished(env), timeoutMs + 10_000, 'the deadline');
      expect(state.result!.remote).toEqual({ failed: 'no answer within 1s' });
      expect(Date.parse(state.result!.finishedAt) - closedAt).toBeGreaterThan(timeoutMs / 2);
      // The whole process group went: `git` alone dying leaves `git-remote-http` holding the socket.
      await until(() => (remote.open() === 0 ? true : undefined), 5000, 'every connection to close');
      expect(releaseNotice(state, headCommit(user))).toBeNull();
    } finally {
      remote.stop();
    }
  }, E2E_MS);

  test('a checkout with no release asks nothing at all', async () => {
    const remote = hungRemote();
    try {
      const repo = dir('untagged-app');
      git(repo, 'init', '-q', '-b', 'stable');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'unreleased');
      git(repo, 'remote', 'add', 'origin', remote.url);
      const env = homeEnv();
      expect((await runSpawner(repo, 3000, env)).out).toBe('started');
      const state = await until(finished(env), 10_000, 'the check');
      expect(state.result).toEqual({
        attemptedAt: state.attemptedAt,
        finishedAt: state.result!.finishedAt,
        head: headCommit(repo)!,
        have: null,
      });
      expect(remote.accepted()).toBe(0);
      expect(releaseStatus(state, headCommit(repo), { releaseCheck: true }).kind).toBe('unreleased');
    } finally {
      remote.stop();
    }
  }, E2E_MS);

  test('anonymous: nothing of anybody\'s configuration reaches the remote, and no prompt runs', async () => {
    /*
     * Each softer setup leaks, measured: `GIT_TERMINAL_PROMPT=0` alone still runs the helper and
     * `core.askPass`; `-c credential.helper=` still sends `http.extraHeader`. So every way git or
     * curl could add a credential is set up here -- helpers (plain and URL-scoped), askpass (config
     * and the env an IDE's terminal sets), extra headers (global, URL-scoped, and in the checkout's
     * own config), a `~/.netrc`, and a user and token in origin's URL -- against a remote that
     * answers 401 and records what each request carried. None of it may arrive, and nothing may
     * run.
     */
    const calls = join(dir('calls'), 'calls.log');
    const recorder = join(SCRATCH, 'recorder.sh');
    writeFileSync(recorder, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(calls)}\ncat > /dev/null\n`);
    chmodSync(recorder, 0o755);
    const carried: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        carried.push(req.headers.get('authorization') ?? '');
        return new Response('no', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' } });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const home = dir('cred-home');
      writeFileSync(
        join(home, '.gitconfig'),
        `[credential]\n\thelper = ${recorder}\n[credential "${base}"]\n\thelper = ${recorder}\n` +
          `[core]\n\taskPass = ${recorder}\n` +
          `[http]\n\textraHeader = Authorization: Bearer GLOBAL\n` +
          `[http "${base}"]\n\textraHeader = Authorization: Bearer SCOPED\n`
      );
      writeFileSync(join(home, '.netrc'), 'machine 127.0.0.1 login netrc password netrc\n');
      const user = userClone(sharedOrigin().bare);
      git(user, 'remote', 'set-url', 'origin', `http://someone:token@127.0.0.1:${server.port}/draftgate.git`);
      git(user, 'config', 'http.extraHeader', 'Authorization: Bearer LOCAL');
      const env = homeEnv({
        HOME: home,
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
        GIT_ASKPASS: recorder,
        SSH_ASKPASS: recorder,
      });

      expect((await runSpawner(user, 10_000, env)).out).toBe('started');
      const state = await until(finished(env), 15_000, 'the check');
      expect(state.result!.remote).toEqual({ failed: 'git exited 128' });
      expect(Date.parse(state.result!.finishedAt) - Date.parse(state.attemptedAt)).toBeLessThan(5000);
      expect(carried.length).toBeGreaterThan(0);
      expect(carried.filter((h) => h !== '')).toEqual([]);
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');
    } finally {
      server.stop(true);
    }
  }, E2E_MS);

  test('an ssh origin is refused before ssh runs: the agent would authenticate with no prompt', async () => {
    const bin = dir('fake-bin');
    const ran = join(bin, 'ssh-ran');
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ran)}\nexit 255\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    for (const url of ['ssh://git@127.0.0.1:1/draftgate.git', 'git@127.0.0.1:draftgate.git']) {
      const user = userClone(sharedOrigin().bare);
      git(user, 'remote', 'set-url', 'origin', url);
      const env = homeEnv({ PATH: `${bin}:${process.env.PATH}` });
      expect((await runSpawner(user, 10_000, env)).out).toBe('started');
      const state = await until(finished(env), 15_000, 'the check');
      expect(state.result!.remote, url).toEqual({ failed: 'git exited 128' });
      expect(existsSync(ran), url).toBe(false);
    }
  }, E2E_MS);

  test('a claim already being made claims nothing, and a dead holder\'s lock is taken over', async () => {
    /*
     * The lock is what makes read-then-write atomic for two hooks that start in the same
     * millisecond. Held by somebody else, nothing is claimed and nothing starts; left behind by a
     * holder that died (it is held for a millisecond), it is taken over.
     */
    const user = userClone(sharedOrigin().bare);
    const env = homeEnv();
    const lock = `${releaseStatePath(env)}.lock`;
    mkdirSync(env.DRAFTGATE_HOME!, { recursive: true });
    writeFileSync(lock, '');
    expect(startReleaseCheck({ config: { releaseCheck: true }, checkout: user, env })).toBe('not-due');
    expect(readReleaseState(env)).toBeNull();
    const longAgo = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, longAgo, longAgo);
    expect((await runSpawner(user, 10_000, env)).out).toBe('started');
    await until(finished(env), 15_000, 'the check');
  }, E2E_MS);

  test('six reviews at once -- duplicate registrations fire together -- start ONE check', async () => {
    // The observable property under real start-up timing. bun's start staggers these by more than
    // the claim's millisecond, so this alone cannot prove the lock: the test above does.
    const user = userClone(sharedOrigin().bare);
    const env = homeEnv();
    const outs = await Promise.all(Array.from({ length: 6 }, () => runSpawner(user, 10_000, env)));
    expect(outs.map((o) => o.out).sort()).toEqual(['not-due', 'not-due', 'not-due', 'not-due', 'not-due', 'started']);
    await until(finished(env), 15_000, 'the check');
    // The child writes its answer under the same lock and removes it just after, so wait for that.
    await until(() => (existsSync(`${releaseStatePath(env)}.lock`) ? undefined : true), 5000, 'the lock to go');
  }, E2E_MS);

});

describe('`draftgate version` is the same reading', () => {
  test('the newest release reachable from HEAD, or unreleased -- never a literal', () => {
    const repo = join(import.meta.dir, '..', '..');
    const run = spawnSync(process.execPath, [join(repo, 'cli', 'src', 'main.ts'), 'version'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const local = installedRelease(CHECKOUT);
    expect('have' in local, 'this checkout\'s tags can be listed').toBe(true);
    const have = 'have' in local ? local.have : null;
    expect(run.stderr).toBe(
      `${have ?? `unreleased (no vX.Y.Z tag reachable from ${headCommit(CHECKOUT)!.slice(0, 7)})`}\n`
    );
    expect(CHECKOUT).toBe(repo);
  });
});

describe('a plugin: its manifest says which release it is, and its repository is asked', () => {
  /** A plugin root as a version folder is: a manifest, and no `.git`. */
  function pluginRoot(version: string, repository?: string): string {
    const root = dir('plugin');
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'draftgate', version, ...(repository !== undefined && { repository }) })
    );
    return root;
  }

  test('installIdentity: the version as a release tag; a version that is not a release is nothing', () => {
    expect(installIdentity(pluginRoot('0.2.0'))).toBe('v0.2.0');
    expect(installIdentity(pluginRoot('0.2.0-rc1'))).toBeNull();
    // A checkout has no manifest at its root, and is judged by HEAD.
    const user = userClone(sharedOrigin().bare);
    expect(installIdentity(user)).toBe(headCommit(user));
    // Another plugin's manifest is not draftgate's.
    const other = pluginRoot('0.2.0');
    writeFileSync(join(other, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'other', version: '0.2.0' }));
    expect(installIdentity(other)).toBeNull();
  });

  test('behind a release: the line names the plugin update, and goes once the plugin moves', async () => {
    const o = makeOrigin();
    o.commit('two');
    o.tagAnnotated('v0.2.0');
    o.release('v0.2.0');
    const root = pluginRoot('0.1.0', o.bare);
    const env = homeEnv();
    expect((await runSpawner(root, 10_000, env)).out).toBe('started');
    const state = await until(finished(env), 15_000, 'the check to finish');
    expect(state.result).toMatchObject({ head: 'v0.1.0', have: 'v0.1.0', remote: { latest: 'v0.2.0' } });
    expect(releaseNotice(readReleaseState(env), installIdentity(root))).toBe(
      'draftgate v0.2.0 is out (you have v0.1.0), update the plugin: ' +
        '`claude plugin marketplace update draftgate && claude plugin update draftgate@draftgate`, ' +
        'then `/reload-plugins`.'
    );
    expect(releaseStatus(readReleaseState(env), installIdentity(root), { releaseCheck: true }).kind).toBe('newer');
    // An update is a new version folder with a newer manifest: the line goes at once.
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'draftgate', version: '0.2.0' }));
    expect(releaseNotice(readReleaseState(env), installIdentity(root))).toBeNull();
    expect(releaseStatus(readReleaseState(env), installIdentity(root), { releaseCheck: true }).kind).toBe('moved');
  }, E2E_MS);

  test('a manifest with no repository names nowhere to ask, and the check says nothing', async () => {
    const root = pluginRoot('0.1.0');
    const env = homeEnv();
    expect((await runSpawner(root, 3000, env)).out).toBe('started');
    const state = await until(finished(env), 10_000, 'the check');
    expect(state.result).toMatchObject({ head: 'v0.1.0', have: 'v0.1.0', remote: { failed: 'origin has no URL' } });
    expect(releaseNotice(state, installIdentity(root))).toBeNull();
  }, E2E_MS);

  test('a result naming a release tag reads back; a check of a non-release version asks nothing', async () => {
    expect(parseReleaseState(JSON.stringify({ version: 1, ...stateOf({ head: 'v0.2.0' }) }))?.result?.head).toBe('v0.2.0');
    const root = pluginRoot('0.1.0-dev', 'https://example.invalid/draftgate');
    const env = homeEnv();
    expect((await runSpawner(root, 3000, env)).out).toBe('started');
    const state = await until(finished(env), 10_000, 'the check');
    expect(state.result!.head).toBeUndefined();
    expect(state.result!.remote).toBeUndefined();
    expect(releaseStatus(state, installIdentity(root), { releaseCheck: true }).kind).toBe('no-head');
  }, E2E_MS);

  test('`draftgate version` from a plugin root reads the manifest, which has no git to ask', () => {
    const root = pluginRoot('0.4.1');
    for (const part of ['cli/src', 'core/src', 'adapters/hook/src']) {
      cpSync(join(CHECKOUT, part), join(root, part), { recursive: true });
    }
    mkdirSync(join(root, 'surface'));
    cpSync(join(CHECKOUT, 'surface', 'contract.json'), join(root, 'surface', 'contract.json'));
    const version = () => spawnSync(process.execPath, [join(root, 'cli', 'src', 'main.ts'), 'version'], { encoding: 'utf8' });
    expect(version()).toMatchObject({ status: 0, stderr: 'v0.4.1\n' });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'draftgate', version: '0.4.1-rc1' }));
    expect(version()).toMatchObject({
      status: 0,
      stderr: "unreleased (the plugin's version, 0.4.1-rc1, is not a release)\n",
    });
  });
});
