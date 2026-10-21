/**
 * The daily release check: does origin carry a newer draftgate release than this install? Asked at
 * most once a day, after a review has written its decision, by a process no review waits on. The
 * next review carries one line when the answer is yes; `--doctor` and `digest` print the same line.
 * What a release is and how a plugin's version is read: installer.md.
 *
 * - The version is read off git, never off a version file, so it cannot disagree with the code that
 *   runs. `package.json`'s `"version"` is not read; `draftgate version` prints this reading.
 * - Reachable from HEAD, not on it: `stable`'s tip descends from the tag and is never the tagged
 *   commit, so "a tag on HEAD" would read every user's checkout as unreleased.
 * - Strict `vX.Y.Z`: a `-rc1` is not a release, and a tag name the remote chooses cannot carry
 *   anything else into a message.
 * - No tag: the check stops before the network and says nothing.
 *
 * `startReleaseCheck` reads one small file and, when a check is due, writes a claim and spawns this
 * file detached: its own session, all three stdio on /dev/null, `unref`'d. Holding none of its
 * parent's pipes lets the caller see EOF at once however long the remote takes -- the hook waits for
 * the CLI's `close`, and Claude Code for the hook's. The child kills `git`'s whole process group at
 * its deadline (`runChild`'s `group`) and writes `release-check.json`. A review only reads that file,
 * plus HEAD's commit off git's own files (`headCommit`).
 *
 * ## What it sends: nothing about a message, and nothing of yours
 *
 * `git ls-remote <origin's URL> refs/heads/stable 'refs/tags/v*'`, run with NO git configuration
 * -- not the system's, not yours, not the checkout's -- an empty HOME, and origin's URL stripped of
 * any user and password. Do not soften it: every softer setup leaks something.
 *
 * - `GIT_TERMINAL_PROMPT=0` alone: on a 401, git runs the credential helper and then `core.askPass`
 *   twice, which on a desktop is a dialog.
 * - Resetting helpers with `-c credential.helper=` stops the helper, and `http.extraHeader` still
 *   goes out: `-c http.extraHeader=` does NOT clear a configured header, global or URL-scoped.
 *   `~/.netrc` is read by git's curl whenever HOME holds one.
 *
 * So the remote sees an anonymous request and nothing else: all it learns is that this machine ran
 * draftgate that day. ssh is refused outright (`protocol.ssh.allow=never`), because an ssh origin
 * authenticates through the agent with no prompt to stop. A private origin therefore answers
 * nothing, and an origin only your git config can reach (a proxy set in `~/.gitconfig`) fails; both
 * read as silence, never as a false notice. No call of draftgate's carries message content.
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMEDY } from '../../core/src/remedies';
import {
  draftgateHome, ensurePrivateDir, isInstant, MS_PER_DAY, PRIVATE_FILE_MODE, writePrivateFile,
} from './audit';
import { runChild } from './child';
import { gitDirs } from './gitDirs';
import { PLUGIN_ID, pluginManifest } from './claudePlugin';
import { isPlainObject } from './json';

export const RELEASE_STATE_BASENAME = 'release-check.json';
export const RELEASE_STATE_VERSION = 1;

/** "At most once a day": the time between two attempts, a failed or killed one included. */
export const CHECK_INTERVAL_MS = MS_PER_DAY;

/**
 * How long `ls-remote` may take before its process group is killed. The check is detached, so this
 * bounds what it costs the machine, never what it costs a review. A GitHub answer takes about a
 * second.
 */
const LS_REMOTE_TIMEOUT_MS = 10_000;

/** A local git read: no transport, so nothing to wait on but the disk. */
const LOCAL_GIT_TIMEOUT_MS = 5_000;

/**
 * How long after its claim a check that has written nothing is still running rather than dead: its
 * local reads plus the network deadline, with room for a slow start.
 */
const RUNNING_FOR_MS = LS_REMOTE_TIMEOUT_MS + 2 * LOCAL_GIT_TIMEOUT_MS + 60_000;

/** More than any `ls-remote` of release tags prints; what is past it is not parsed. */
const LS_REMOTE_CAP = 1_000_000;

/** This file, which the detached child runs. */
const SELF = fileURLToPath(import.meta.url);
const CHECK_FLAG = '--release-check';

/** The checkout this file belongs to, from `cli/src/`. */
export const CHECKOUT = resolve(dirname(SELF), '..', '..');

/** The branch a release install tracks, and the release step moves. */
export const RELEASE_BRANCH = 'stable';

// ---------------------------------------------------------------------------
// Release tags
// ---------------------------------------------------------------------------

/** No leading zeros, so two spellings of one number cannot both be releases. */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** A commit id, SHA-1 or SHA-256. */
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isReleaseTag(tag: string): boolean {
  return RELEASE_TAG.test(tag);
}

/**
 * Is release `a` newer than release `b`? False unless both are releases. Each number is compared as
 * a string, by length and then by character: exact at any size, where `Number` would call two
 * twenty-digit versions equal, and correct because the pattern forbids leading zeros.
 */
export function isNewerRelease(a: string, b: string): boolean {
  const pa = RELEASE_TAG.exec(a);
  const pb = RELEASE_TAG.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x !== y) return x.length !== y.length ? x.length > y.length : x > y;
  }
  return false;
}

/** A plugin version's release tag (`X.Y.Z` -> `vX.Y.Z`), or null when the version is not a release. */
export function versionTag(version: string): string | null {
  const tag = `v${version}`;
  return isReleaseTag(tag) ? tag : null;
}

/** The newest release among `tags`, or null when none of them is one. */
export function newestRelease(tags: Iterable<string>): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    if (isReleaseTag(tag) && (best === null || isNewerRelease(tag, best))) best = tag;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Why a git step failed, as one of a few fixed sentences
// ---------------------------------------------------------------------------

/**
 * Every reason this module records, and nothing git printed: a failing git names the remote's
 * URL, a URL can carry a token, and the reason is printed by `--doctor`. The reader holds a file's
 * reasons to these shapes (`isFailure`), so a tampered file cannot put prose in front of anyone.
 */
const FAILURE =
  /^(?:no answer within \d+s|git could not be started|git exited [\w-]+|origin has no URL)$/;

function isFailure(why: unknown): why is string {
  return typeof why === 'string' && FAILURE.test(why);
}

function exitedWhy(code: number | null, signal: NodeJS.Signals | null): string {
  return `git exited ${code ?? signal ?? 'unknown'}`;
}

// ---------------------------------------------------------------------------
// What origin said
// ---------------------------------------------------------------------------

interface RemoteReleases {
  /** The newest `vX.Y.Z` tag origin carries, or null for none. */
  latest: string | null;
  /** The commit origin's `stable` points at, or null when it has no `stable`. */
  stable: string | null;
}

/**
 * `ls-remote`'s output, read. An annotated tag is listed twice, the second time peeled (`^{}`), and
 * names the same release both times. Lines that are not `<commit>\t<ref>` are skipped: the listing
 * may be cut at `LS_REMOTE_CAP`, and a half line is not a ref.
 */
export function parseLsRemote(text: string): RemoteReleases {
  const { heads, tags } = lsRemoteRefs(text);
  return { latest: newestRelease(tags.keys()), stable: heads.get(RELEASE_BRANCH) ?? null };
}

/**
 * Every `<commit>\t<ref>` line of an `ls-remote` listing: branches by name, and tags by name with a
 * peeled line (`^{}`) naming the same tag, its commit the one it peels to.
 */
export function lsRemoteRefs(text: string): { heads: Map<string, string>; tags: Map<string, string> } {
  const heads = new Map<string, string>();
  const tags = new Map<string, string>();
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    const commit = line.slice(0, tab);
    const ref = line.slice(tab + 1);
    if (tab < 0 || !COMMIT.test(commit)) continue;
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), commit);
    else if (ref.startsWith('refs/tags/')) {
      const name = ref.slice('refs/tags/'.length);
      if (name.endsWith('^{}')) tags.set(name.slice(0, -3), commit);
      else if (!tags.has(name)) tags.set(name, commit);
    }
  }
  return { heads, tags };
}

// ---------------------------------------------------------------------------
// The state file
// ---------------------------------------------------------------------------

interface ReleaseResult {
  /** The claim this check answered (`ReleaseState.attemptedAt`), which is how a reader tells a
   *  result from the check after it: by identity, never by comparing two clocks. */
  attemptedAt: string;
  /** When the check finished. */
  finishedAt: string;
  /**
   * What the check judged (`installIdentity`): HEAD's commit for a checkout, the release tag of a
   * plugin's version. Absent when it could not be read.
   */
  head?: string;
  /** The newest release reachable from that HEAD, or null for a checkout that carries none. */
  have: string | null;
  /** Why the local read of the tags failed, when it did; `have` is null then and means nothing. */
  local?: string;
  /** What origin said. Absent when nothing was asked: no HEAD, or no release to compare it with. */
  remote?: RemoteReleases | { failed: string };
}

export interface ReleaseState {
  /**
   * When the last check started: the once-a-day clock. Written by the spawner before the child
   * exists, so a check that hangs, dies or is killed still counts, and a remote that never answers
   * costs one attempt a day.
   */
  attemptedAt: string;
  /** The last check that finished. Kept while a new one runs, so the notice does not blink. */
  result?: ReleaseResult;
}

export function releaseStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(draftgateHome(env), RELEASE_STATE_BASENAME);
}

/**
 * The file's text, read, or null for anything this build cannot trust. draftgate's own cache, so a
 * file it cannot read is replaced on the next check. Every string that can reach a message (tags,
 * commits, instants, reasons) is held to its pattern, so a tampered file cannot put text in front
 * of a reviewer. A broken `result` costs only the result: the claim's time is still honoured, so a
 * corrupt file does not cause a second network call the same day.
 */
export function parseReleaseState(text: string): ReleaseState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isPlainObject(raw) ||
    raw.version !== RELEASE_STATE_VERSION ||
    !utcInstant(raw.attemptedAt)
  ) {
    return null;
  }
  const result = parseResult(raw.result);
  return { attemptedAt: raw.attemptedAt, ...(result ? { result } : {}) };
}

/** An instant as this module writes one: `toISOString`'s, in UTC. An offset is not ours. */
function utcInstant(v: unknown): v is string {
  return isInstant(v) && v.endsWith('Z');
}

function parseResult(raw: unknown): ReleaseResult | null {
  if (!isPlainObject(raw) || !utcInstant(raw.attemptedAt) || !utcInstant(raw.finishedAt)) {
    return null;
  }
  const release = (v: unknown): v is string | null =>
    v === null || (typeof v === 'string' && isReleaseTag(v));
  const commit = (v: unknown): v is string => typeof v === 'string' && COMMIT.test(v);
  const identity = (v: unknown): v is string => commit(v) || (typeof v === 'string' && isReleaseTag(v));
  if (!release(raw.have) || (raw.head !== undefined && !identity(raw.head))) return null;
  if (raw.local !== undefined && (!isFailure(raw.local) || raw.have !== null)) return null;
  let remote: ReleaseResult['remote'];
  if (isPlainObject(raw.remote)) {
    const r = raw.remote;
    if (r.failed !== undefined) {
      if (!isFailure(r.failed)) return null;
      remote = { failed: r.failed };
    } else if (release(r.latest) && (r.stable === null || commit(r.stable))) {
      remote = { latest: r.latest, stable: r.stable };
    } else return null;
  } else if (raw.remote !== undefined) return null;
  // Origin is asked exactly when there is a HEAD and a release to compare (`runReleaseCheck`), so a
  // result that says otherwise was not written by this module.
  if ((remote !== undefined) !== (raw.head !== undefined && raw.have !== null)) return null;
  return {
    attemptedAt: raw.attemptedAt,
    finishedAt: raw.finishedAt,
    ...(raw.head !== undefined ? { head: raw.head } : {}),
    have: raw.have,
    ...(raw.local !== undefined ? { local: raw.local } : {}),
    ...(remote ? { remote } : {}),
  };
}

export function readReleaseState(env: NodeJS.ProcessEnv = process.env): ReleaseState | null {
  try {
    return parseReleaseState(readFileSync(releaseStatePath(env), 'utf8'));
  } catch {
    return null;
  }
}

function writeReleaseState(state: ReleaseState, env: NodeJS.ProcessEnv): Error | null {
  return writePrivateFile(
    releaseStatePath(env),
    JSON.stringify({ version: RELEASE_STATE_VERSION, ...state }, null, 2) + '\n'
  );
}

/**
 * Is a check due? No usable file, or a day since the last attempt. A claim dated in the future is a
 * clock that moved back, and waiting it out could take years, so it is due too.
 */
export function checkDue(state: ReleaseState | null, now: Date): boolean {
  if (state === null) return true;
  const at = Date.parse(state.attemptedAt);
  return !(at <= now.getTime()) || now.getTime() - at >= CHECK_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// HEAD, off git's own files
// ---------------------------------------------------------------------------

/**
 * The commit HEAD names, read off git's files because a review reads it and a review runs no `git`.
 * Null for anything it cannot read, which every caller reads as "say nothing". A review compares it
 * with the HEAD the check judged, so a moved HEAD (a `git pull` of `stable`) says nothing until the
 * next check.
 *
 * The dirs come from `gitDirs`, shared with the hook's `checkoutOf`. HEAD is in the git dir,
 * branches in the common one: loose under `refs/heads/`, else in `packed-refs` (a fresh clone
 * writes the branch loose and its tags packed; `git gc` packs both). A loose ref outranks a packed
 * one, so it is read first. A reftable repository or an unborn branch is null.
 */
export function headCommit(checkout: string): string | null {
  try {
    const dirs = gitDirs(checkout);
    if (dirs === null) return null;
    const head = readFileSync(join(dirs.gitDir, 'HEAD'), 'utf8').trim();
    if (COMMIT.test(head)) return head;
    const ref = /^ref: (refs\/heads\/\S+)$/.exec(head)?.[1];
    if (ref === undefined) return null;
    const loose = textIfPresent(join(dirs.commonDir, ref));
    if (loose !== null) return COMMIT.test(loose.trim()) ? loose.trim() : null;
    for (const line of (textIfPresent(join(dirs.commonDir, 'packed-refs')) ?? '').split('\n')) {
      const space = line.indexOf(' ');
      if (space > 0 && line.slice(space + 1) === ref && COMMIT.test(line.slice(0, space))) {
        return line.slice(0, space);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function textIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What the check judges an install by, and what a review compares the check's result with: for a
 * plugin root, its manifest's version as a release tag (null when that is not a `X.Y.Z` release);
 * for a checkout, HEAD's commit (`headCommit`). Reads files and runs nothing, like `headCommit`.
 */
export function installIdentity(root: string): string | null {
  const manifest = pluginManifest(root);
  return manifest === null ? headCommit(root) : versionTag(manifest.version);
}

/** A judged identity that is a release tag is a plugin's: a checkout's is a commit. */
const isPluginIdentity = (head: string) => isReleaseTag(head);

// ---------------------------------------------------------------------------
// The notice: the one line a review, `--doctor` and `digest` print
// ---------------------------------------------------------------------------

/**
 * The line, or null when there is nothing true to say. Pure. Each way the line could be false
 * silences it:
 *
 * - no finished check, or one that could not read HEAD or found no release here;
 * - HEAD has moved since that check (an update, a checkout of something else);
 * - origin was not asked, or did not answer;
 * - origin's newest release is not newer than this one;
 * - origin's `stable` is this HEAD, so a pull would change nothing whatever the tags say (between a
 *   release's tag being pushed and `stable` being moved to it).
 */
export function releaseNotice(state: ReleaseState | null, head: string | null): string | null {
  const result = state?.result;
  if (!result || head === null || result.head !== head || result.have === null) return null;
  const remote = result.remote;
  if (!remote || 'failed' in remote || remote.latest === null) return null;
  if (!isNewerRelease(remote.latest, result.have) || remote.stable === head) return null;
  // The repository asked is the manifest's, the published plugin's, which is `PLUGIN_ID`.
  const how = isPluginIdentity(head)
    ? `update the plugin: ${REMEDY.pluginUpdate(PLUGIN_ID)}, then ${REMEDY.reloadPlugins}`
    : `run ${REMEDY.installPlugin}`;
  return `draftgate ${remote.latest} is out (you have ${result.have}), ${how}.`;
}

/**
 * What `--doctor` says about the check, as facts. The sentences are `doctor.ts`'s; the one line all
 * three readers share is `releaseNotice`.
 */
export type ReleaseStatus =
  /** `because`: the problem that turned it off, when `config.json` does not simply say `false`. */
  | { kind: 'off'; because?: string }
  | { kind: 'unchecked' }
  | { kind: 'running'; attemptedAt: string }
  | { kind: 'unfinished'; attemptedAt: string; nextAt: string }
  | { kind: 'no-head'; checkedAt: string }
  | { kind: 'git-failed'; why: string; checkedAt: string; nextAt: string }
  | { kind: 'unreleased'; checkedAt: string }
  | { kind: 'moved'; checkedAt: string; nextAt: string }
  | { kind: 'failed'; why: string; checkedAt: string; nextAt: string }
  | { kind: 'newer'; line: string }
  | { kind: 'current'; have: string; checkedAt: string };

/** The operator's switch, as `reviewConfig.ts` reads it. */
export interface ReleaseSwitch {
  releaseCheck: boolean;
  releaseCheckOffBecause?: string;
}

export function releaseStatus(
  state: ReleaseState | null,
  head: string | null,
  config: ReleaseSwitch,
  now: Date = new Date()
): ReleaseStatus {
  if (!config.releaseCheck) {
    const because = config.releaseCheckOffBecause;
    return { kind: 'off', ...(because ? { because } : {}) };
  }
  if (state === null) return { kind: 'unchecked' };
  // The line first, so all three readers print it in the same states: a review prints it from the
  // last finished check while a new one runs, and so does this.
  const line = releaseNotice(state, head);
  if (line !== null) return { kind: 'newer', line };
  const nextAt = new Date(Date.parse(state.attemptedAt) + CHECK_INTERVAL_MS).toISOString();
  const result = state.result;
  // A claim the last result does not answer is a check still running -- or, once it is older than
  // a check can take, one that died, which holds the next one off until `nextAt` all the same.
  if (!result || result.attemptedAt !== state.attemptedAt) {
    return now.getTime() - Date.parse(state.attemptedAt) < RUNNING_FOR_MS
      ? { kind: 'running', attemptedAt: state.attemptedAt }
      : { kind: 'unfinished', attemptedAt: state.attemptedAt, nextAt };
  }
  const checkedAt = result.finishedAt;
  if (result.head === undefined) return { kind: 'no-head', checkedAt };
  if (result.local !== undefined) {
    return { kind: 'git-failed', why: result.local, checkedAt, nextAt };
  }
  if (result.have === null || !result.remote) return { kind: 'unreleased', checkedAt };
  if (result.head !== head) return { kind: 'moved', checkedAt, nextAt };
  if ('failed' in result.remote) {
    return { kind: 'failed', why: result.remote.failed, checkedAt, nextAt };
  }
  return { kind: 'current', have: result.have, checkedAt };
}

/**
 * The line for this checkout now, or null. Null whenever the check is off, here rather than at each
 * caller, so no reader can print what the operator turned off. What a review and `digest` ask.
 */
export function currentReleaseNotice(
  config: ReleaseSwitch,
  env: NodeJS.ProcessEnv = process.env,
  checkout: string = CHECKOUT
): string | null {
  return config.releaseCheck ? releaseNotice(readReleaseState(env), installIdentity(checkout)) : null;
}

/** `releaseStatus` for this checkout now: what `--doctor` asks. */
export function currentReleaseStatus(
  config: ReleaseSwitch,
  env: NodeJS.ProcessEnv = process.env,
  checkout: string = CHECKOUT
): ReleaseStatus {
  return releaseStatus(readReleaseState(env), installIdentity(checkout), config);
}

// ---------------------------------------------------------------------------
// The check itself: the detached child's work
// ---------------------------------------------------------------------------

/** A local git read, in the user's own environment: it touches no network. */
function localGit(checkout: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: LOCAL_GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

/**
 * The newest release reachable from HEAD, by `git tag --merged HEAD`: a tag, null for none, or why
 * git could not say. The last is not "none", or a checkout git refuses to read (another user's,
 * with no `safe.directory`) would report itself unreleased and never be told of a release. Runs
 * `git`, so it is for the detached check and `draftgate version`, never for a review.
 */
export function installedRelease(
  checkout: string,
  env: NodeJS.ProcessEnv = process.env
): { have: string | null } | { failed: string } {
  const run = localGit(checkout, ['tag', '--merged', 'HEAD', '--list', 'v*'], env);
  // A timeout is a git that ran and was killed; any other error is one that never started.
  if (run.error) {
    const timedOut = (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { failed: timedOut ? exitedWhy(null, 'SIGKILL') : 'git could not be started' };
  }
  if (run.status !== 0) return { failed: exitedWhy(run.status, run.signal) };
  return { have: newestRelease(run.stdout.split('\n')) };
}

/**
 * origin's URL as the checkout records it, with any user and password taken out of an http(s) one,
 * or null when there is none. Raw, not `git remote get-url`: a rewrite in the user's config is part
 * of the configuration the check does not use.
 */
export function originUrl(checkout: string, env: NodeJS.ProcessEnv): string | null {
  const run = localGit(checkout, ['config', '--get', 'remote.origin.url'], env);
  return withoutCredentials(run.status === 0 ? run.stdout.trim() : '');
}

/**
 * Where a release is asked about: a plugin's manifest `repository`, or a checkout's origin. Either
 * goes through the same anonymous `ls-remote`, which refuses ssh.
 */
function releaseSource(root: string, env: NodeJS.ProcessEnv): string | null {
  const manifest = pluginManifest(root);
  if (manifest === null) return originUrl(root, env);
  return manifest.repository === null ? null : withoutCredentials(manifest.repository);
}

/** A URL with any user and password taken out of an http(s) one; null for none. */
function withoutCredentials(raw: string): string | null {
  if (raw === '') return null;
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** The proxy variables curl reads, the one part of the user's environment the request keeps. */
const PROXY_VARS = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY',
  'no_proxy',
];

/**
 * The environment `ls-remote` runs in: built from nothing, never from the user's.
 *
 * No system or global git config (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`), so no credential
 * helper (Apple's git ships `osxkeychain` at the system level), no `http.extraHeader`, no askpass
 * and no URL rewrite. HOME is an empty directory, so curl finds no `~/.netrc`. Kept: PATH to find
 * git, the proxy variables, and `GIT_ALLOW_PROTOCOL`, which can only narrow what git may reach.
 */
export function anonymousEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const name of [...PROXY_VARS, 'GIT_ALLOW_PROTOCOL']) {
    if (env[name] !== undefined) kept[name] = env[name];
  }
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: '/var/empty',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...kept,
  };
}

/**
 * Ask origin, anonymously, under a deadline that kills `git`'s whole process group.
 *
 * Run from `/` (`-C /`), outside any repository, so not even the checkout's own config applies.
 */
async function askOrigin(
  checkout: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<RemoteReleases | { failed: string }> {
  const url = releaseSource(checkout, env);
  if (url === null) return { failed: 'origin has no URL' };
  const outcome = await runChild(
    'git',
    [
      '-C', '/',
      '-c', 'protocol.ssh.allow=never',
      'ls-remote', url, `refs/heads/${RELEASE_BRANCH}`, 'refs/tags/v*',
    ],
    {
      env: anonymousEnv(env),
      captureStdout: false,
      stdoutCap: LS_REMOTE_CAP,
      timeoutMs,
      group: true,
    }
  );
  if (outcome.kind === 'timeout') {
    return { failed: `no answer within ${Math.round(timeoutMs / 1000)}s` };
  }
  if (outcome.kind === 'error') return { failed: 'git could not be started' };
  if (outcome.code !== 0) return { failed: exitedWhy(outcome.code, outcome.signal) };
  return parseLsRemote(outcome.stdout ?? '');
}

/**
 * The detached child's whole job: read this install, ask origin if there is something to compare,
 * and record the answer. What it judges comes from `installIdentity`, the reader a review uses. It
 * writes only while the claim is still the one that started it, under the claim's lock, so a slower
 * check cannot overwrite a newer claim.
 */
async function runReleaseCheck(
  checkout: string,
  attemptedAt: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const head = installIdentity(checkout);
  // A plugin's identity is its release; only a checkout has tags to list.
  const local = head === null ? null : isPluginIdentity(head) ? { have: head } : installedRelease(checkout, env);
  const have = local !== null && 'have' in local ? local.have : null;
  const remote =
    head !== null && have !== null ? await askOrigin(checkout, timeoutMs, env) : undefined;
  withClaimLock(env, () => {
    if (readReleaseState(env)?.attemptedAt !== attemptedAt) return;
    writeReleaseState(
      {
        attemptedAt,
        result: {
          attemptedAt,
          finishedAt: new Date().toISOString(),
          ...(head !== null ? { head } : {}),
          have,
          ...(local !== null && 'failed' in local ? { local: local.failed } : {}),
          ...(remote ? { remote } : {}),
        },
      },
      env
    );
  });
}

// ---------------------------------------------------------------------------
// The claim, and starting it after a review
// ---------------------------------------------------------------------------

/** A lock older than this was left by a process that died holding it: held for a millisecond. */
const LOCK_STALE_MS = 60_000;

/**
 * Run `body` holding `release-check.lock`, an exclusive create, or not at all. It makes
 * read-then-write atomic: duplicate registrations fire two hooks at once, and two readers that both
 * find a check due would both claim one. Held for the read and the write, never across the spawn or
 * the network. A lock already there answers "not this time", not a wait; one older than
 * `LOCK_STALE_MS` is a dead holder's and is taken over.
 */
function withClaimLock<T>(env: NodeJS.ProcessEnv, body: () => T): T | 'locked' {
  const path = `${releaseStatePath(env)}.lock`;
  ensurePrivateDir(dirname(path), env);
  let fd: number;
  try {
    fd = openSync(path, 'wx', PRIVATE_FILE_MODE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Gone by the time it is looked at: its holder finished in between, and what it decided is
    // written. `abs`: a lock dated in the future is a clock that moved, not a live holder.
    const held = statSync(path, { throwIfNoEntry: false });
    if (held === undefined || Math.abs(Date.now() - held.mtimeMs) < LOCK_STALE_MS) return 'locked';
    rmSync(path, { force: true });
    try {
      fd = openSync(path, 'wx', PRIVATE_FILE_MODE);
    } catch {
      // Another process took the dead holder's lock first, and is claiming now.
      return 'locked';
    }
  }
  try {
    return body();
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
}

/**
 * Start the check if one is due. Returns at once: nothing here waits on the child, and nothing it
 * does can throw into the caller, whose decision is already written. Off is answered here, like
 * `currentReleaseNotice`.
 *
 * The other reviews of the day end at one unlocked read, which can only find a check not due; the
 * claim is re-checked under the lock. The claim is written before the spawn, and a claim that
 * cannot be written starts nothing: a check started without a record would start after every review.
 */
export function startReleaseCheck(opts: {
  config: ReleaseSwitch;
  checkout?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  timeoutMs?: number;
}): 'started' | 'off' | 'not-due' | 'unrecorded' | 'spawn-failed' {
  if (!opts.config.releaseCheck) return 'off';
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const attemptedAt = now.toISOString();
  let claimed: 'claimed' | 'not-due' | 'unrecorded' | 'locked';
  try {
    if (!checkDue(readReleaseState(env), now)) return 'not-due';
    claimed = withClaimLock(env, (): 'claimed' | 'not-due' | 'unrecorded' => {
      const state = readReleaseState(env);
      if (!checkDue(state, now)) return 'not-due';
      return writeReleaseState({ ...state, attemptedAt }, env) === null ? 'claimed' : 'unrecorded';
    });
  } catch {
    return 'unrecorded';
  }
  if (claimed !== 'claimed') return claimed === 'locked' ? 'not-due' : claimed;
  try {
    const child = spawn(
      process.execPath,
      [
        SELF,
        CHECK_FLAG,
        opts.checkout ?? CHECKOUT,
        attemptedAt,
        String(opts.timeoutMs ?? LS_REMOTE_TIMEOUT_MS),
      ],
      // `detached`: a session of its own, so it outlives the caller and no group kill aimed at the
      // caller (Claude Code's, on a hook timeout) reaches it. `ignore` on all three: the caller's
      // stdout is a decision and its stderr a pipe somebody waits on for EOF.
      { detached: true, stdio: 'ignore', env }
    );
    child.on('error', () => {});
    child.unref();
    return 'started';
  } catch {
    return 'spawn-failed';
  }
}

if (import.meta.main && process.argv[2] === CHECK_FLAG) {
  const [checkout, attemptedAt, timeout] = process.argv.slice(3);
  const timeoutMs = Number(timeout);
  if (checkout && attemptedAt && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    // Exit explicitly: nothing is waiting, and a handle left open must not keep it alive.
    runReleaseCheck(checkout, attemptedAt, timeoutMs).then(
      () => process.exit(0),
      () => process.exit(1)
    );
  } else {
    process.exit(2);
  }
}
