/**
 * Which GitHub repositories are public -- the one destination fact draftgate cannot derive for
 * GitHub -- plus `rememberGithubRepo`, the answer the reviewer gave when the window asked.
 *
 * A comment on a public repository is a message to the internet; on a private one, to a team. The
 * payload carries only names, and a name becomes a visibility only through an authenticated API
 * call, which draftgate never makes: it holds no destination credentials. So the operator declares
 * it, and an undeclared repository is a loud `unknown` banner. What a visibility means is in
 * `core/src/profiles/github.ts`; this file holds the I/O.
 *
 * Shared with `jiraProjects.ts`: nothing throws, a bad row is dropped and named in `problem` while
 * the rest stay; every row is signed (`sources`: `github` from the API, `reviewer` from a click,
 * unmarked counts as authoritative); `present` is separate from having rows, so `--doctor` can tell
 * an absent file from `{"repos":{}}`.
 *
 * The keying differs: `owner/repo` is globally unique, so there is no outer level like Jira's cloud
 * id. It is lowercased, because GitHub names are case-insensitive and case-preserving
 * (`Owner/Repo` and `owner/repo` are one repository).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftgateHome, ensurePrivateDir, writePrivateFile } from './audit';
import { isPlainObject } from './json';
import { configMergeBase, namedSample, readConfigText } from './configFiles';
import {
  githubRepoKeyOf,
  isGitHubRepoVisibility,
  type GitHubRepo,
  type GitHubRepoSource,
  type GitHubRepoVisibility,
} from '../../core/src/index';

export const GITHUB_REPOS_BASENAME = 'github-repos.json';

/** The file's top level. `repos` is the only key this module writes; others are carried through. */
export type GithubReposRoot = Record<string, unknown> & { repos: Record<string, unknown> };

/** What the parser can say: it is handed text and a name for it, and knows nothing about a disk. */
export interface ParsedGithubRepos {
  /** `owner/repo` (lowercased) to what is known about it. Empty when nothing is usable. */
  repos: Record<string, GitHubRepo>;
  /**
   * What a file that exists could not give, for one line on stderr. Absent when the file is absent;
   * specific when something was dropped, so the message says what still works.
   */
  problem?: string;
}

/** What the reader can say: the parse, plus the two facts only a filesystem has. */
export interface GithubRepos extends ParsedGithubRepos {
  path: string;
  present: boolean;
}

export function githubReposPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(draftgateHome(env), GITHUB_REPOS_BASENAME);
}

/**
 * The key grammar and the vocabulary predicate, re-exported from `core/src/profiles/github.ts`, which
 * also owns the lookup side (`githubRepoKey`). A local copy of the visibility list would silently drop
 * every row carrying a visibility core adds, with no failing test.
 */
export { githubRepoKeyOf, isGitHubRepoVisibility };

/**
 * Parse the file, keeping every usable row. Partial credit: one mistyped visibility costs only that
 * row, counted and named in `problem` (capped by `namedSample`).
 */
export function parseGithubRepos(text: string, source: string): ParsedGithubRepos {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { repos: {}, problem: `${source}: is not valid JSON (${(e as Error).message})` };
  }
  if (!isPlainObject(parsed)) {
    return { repos: {}, problem: `${source}: expected a JSON object with a "repos" key` };
  }
  const rows = parsed.repos;
  if (rows === undefined) {
    return { repos: {}, problem: `${source}: has no "repos" key, so it classifies nothing` };
  }
  if (!isPlainObject(rows)) {
    return { repos: {}, problem: `${source}: "repos" is not an object` };
  }
  const sources = isPlainObject(parsed.sources) ? parsed.sources : {};

  const repos: Record<string, GitHubRepo> = {};
  const dropped: string[] = [];
  for (const [spelling, value] of Object.entries(rows)) {
    const key = githubRepoKeyOf(spelling);
    if (key === null) {
      dropped.push(`"${spelling}" is not an owner/repo pair`);
      continue;
    }
    if (!isGitHubRepoVisibility(value)) {
      dropped.push(`"${spelling}" is ${JSON.stringify(value)}, not public, private or internal`);
      continue;
    }
    const mark = sources[spelling] ?? sources[key];
    repos[key] = {
      visibility: value,
      ...(mark === 'github' || mark === 'reviewer' ? { source: mark as GitHubRepoSource } : {}),
    };
  }

  if (dropped.length === 0) return { repos };
  return {
    repos,
    problem:
      `${source}: ${dropped.length} row${dropped.length === 1 ? '' : 's'} dropped ` +
      `(${namedSample(dropped)}). The rest are still in use.`,
  };
}

export function loadGithubRepos(env: NodeJS.ProcessEnv = process.env): GithubRepos {
  const path = githubReposPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { repos: {}, path, present: false };
    // Present but unreadable: `false` would tell the operator the file does not exist.
    return {
      repos: {},
      path,
      present: true,
      problem: `${path}: could not be read (${err.code ?? err.message})`,
    };
  }
  return { ...parseGithubRepos(text, path), path, present: true };
}

/** How much of that file is usable, for `--doctor`'s report. */
export function githubReposSummary(loaded: ParsedGithubRepos): {
  repos: number;
  public: number;
} {
  const rows = Object.values(loaded.repos);
  return { repos: rows.length, public: rows.filter((r) => r.visibility === 'public').length };
}

/**
 * What a measurement would be written as, for the tool's `--print` (the sibling of
 * `jiraSiteFileText`). Composed through the real writer, so it shows `{"repos": {…}, "sources": {…}}`,
 * not the measured `{"owner/repo": "public"}`.
 */
export function githubReposFileText(measured: Record<string, GitHubRepoVisibility>): string {
  let root: Record<string, unknown> = {};
  for (const [spelling, visibility] of Object.entries(measured)) {
    const key = githubRepoKeyOf(spelling);
    if (key === null || !isGitHubRepoVisibility(visibility)) continue;
    const merged = withGithubRepo(root, { key, visibility, source: 'github' });
    if ('root' in merged) root = merged.root;
  }
  return githubReposText(root as GithubReposRoot);
}

/** The file's bytes: pretty-printed JSON with a trailing newline, as every writer here emits it. */
export function githubReposText(root: GithubReposRoot): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Add or replace one repository's visibility, under the signing rule.
 *
 * `github` outranks everything; `reviewer` may only replace another `reviewer` row. An unmarked row
 * counts as authoritative and is kept, so a hand-written file survives a reviewer's wrong click.
 */
export function withGithubRepo(
  root: Record<string, unknown>,
  fact: { key: string; visibility: GitHubRepoVisibility; source: GitHubRepoSource }
): { root: GithubReposRoot } | { kept: string; source: GitHubRepoSource | 'unmarked' } {
  const repos = { ...(isPlainObject(root.repos) ? root.repos : {}) };
  const sources = { ...(isPlainObject(root.sources) ? root.sources : {}) };

  /*
   * The spelling already in the file wins, so a row written `Owner/Repo` is updated in place rather
   * than joined by a lowercase twin nothing reads.
   *
   * Two indexes, because `repos` and `sources` are keyed independently and a hand-edit can make them
   * disagree about case. `parseGithubRepos` reads `sources[spelling] ?? sources[key]`; reading only
   * `sources[spelling]` here would make the reader see `reviewer` and the writer see `unmarked`,
   * refusing a reviewer who corrects their own click. `withJiraProject` has `sourceSpelling` too.
   */
  const spellingIn = (record: Record<string, unknown>): string | undefined =>
    Object.keys(record).find((k) => githubRepoKeyOf(k) === fact.key);
  const spelling = spellingIn(repos) ?? fact.key;
  const sourceSpelling = spellingIn(sources) ?? spelling;

  const held = repos[spelling];
  if (held !== undefined) {
    const mark = sources[sourceSpelling];
    const heldSource = mark === 'github' || mark === 'reviewer' ? mark : 'unmarked';
    const mayReplace = fact.source === 'github' || heldSource === 'reviewer';
    if (!mayReplace) return { kept: String(held), source: heldSource };
  }

  repos[spelling] = fact.visibility;
  sources[sourceSpelling] = fact.source;
  return { root: { ...root, repos, sources } };
}

/** Read the file and hand the text to the shared refusal rule, `configMergeBase`. */
function githubReposBase(
  env: NodeJS.ProcessEnv
): { base: Record<string, unknown>; path: string } | { error: Error } {
  const path = githubReposPath(env);
  const text = readConfigText(path);
  if (text instanceof Error) return { error: text };
  const base = configMergeBase(text, path, 'repos');
  return base instanceof Error ? { error: base } : { base, path };
}

export interface RememberRepoOutcome {
  /** Absent when the answer was written. */
  error?: Error;
  /** Present when an existing, higher-ranked declaration was left in place. */
  kept?: { visibility: string; source: GitHubRepoSource | 'unmarked' };
}

/**
 * Remember what the reviewer said about one repository. Called from `main.ts` on approval and
 * rejection alike, as `rememberJiraProject` is: "that is public, and do not send this" must not be
 * asked again.
 */
export function rememberGithubRepo(
  fact: { key: string; visibility: GitHubRepoVisibility },
  env: NodeJS.ProcessEnv = process.env
): RememberRepoOutcome {
  const key = githubRepoKeyOf(fact.key);
  if (key === null) {
    return {
      error: new Error(
        `"${fact.key}" is not an owner/repo pair, so there is nothing to remember it under.`
      ),
    };
  }
  const opened = githubReposBase(env);
  if ('error' in opened) return { error: opened.error };

  const merged = withGithubRepo(opened.base, { key, visibility: fact.visibility, source: 'reviewer' });
  if ('kept' in merged) return { kept: { visibility: merged.kept, source: merged.source } };

  ensurePrivateDir(draftgateHome(env), env);
  // Write-then-rename: a torn write would lose every other repository.
  const failed = writePrivateFile(opened.path, githubReposText(merged.root));
  return failed ? { error: failed } : {};
}

export type GithubReposOutcome =
  | { error: Error; path: string }
  | { written: number; kept: string[]; path: string };

/**
 * Merge a whole measured set -- what `tools/github-repos/` read off the GitHub API. Shares
 * `withGithubRepo` with the reviewer's writer (the sibling of `rememberJiraSite`). `github` rows
 * outrank everything, so this corrects a reviewer's guess and reports what it kept.
 */
export function rememberGithubRepos(
  measured: Record<string, GitHubRepoVisibility>,
  env: NodeJS.ProcessEnv = process.env
): GithubReposOutcome {
  const opened = githubReposBase(env);
  if ('error' in opened) return { error: opened.error, path: githubReposPath(env) };

  let root: Record<string, unknown> = opened.base;
  const kept: string[] = [];
  let written = 0;
  for (const [spelling, visibility] of Object.entries(measured)) {
    const key = githubRepoKeyOf(spelling);
    if (key === null || !isGitHubRepoVisibility(visibility)) {
      kept.push(`${spelling} (not a usable row)`);
      continue;
    }
    const merged = withGithubRepo(root, { key, visibility, source: 'github' });
    if ('kept' in merged) {
      kept.push(key);
      continue;
    }
    root = merged.root;
    written += 1;
  }

  // Nothing merged, nothing written. This also makes the `as GithubReposRoot` cast below safe:
  // `withGithubRepo` puts `repos` there, so it exists exactly when `written > 0`.
  if (written === 0) return { written, kept, path: opened.path };

  ensurePrivateDir(draftgateHome(env), env);
  const failed = writePrivateFile(opened.path, githubReposText(root as GithubReposRoot));
  return failed
    ? { error: failed, path: opened.path }
    : { written, kept, path: opened.path };
}

/** What a write did, in one or two lines a human reads, for `tools/github-repos/`. */
export function describeGithubReposWrite(outcome: GithubReposOutcome): string {
  if ('error' in outcome) return `draftgate: ${outcome.error.message}`;
  const { written, kept, path } = outcome;
  const lines = [`draftgate: wrote ${written} repositor${written === 1 ? 'y' : 'ies'} to ${path}`];
  if (kept.length > 0) {
    lines.push(
      `draftgate: kept ${kept.length} existing row${kept.length === 1 ? '' : 's'} ` +
        `(${kept.slice(0, 5).join(', ')}${kept.length > 5 ? ', ...' : ''})`
    );
  }
  return lines.join('\n');
}
