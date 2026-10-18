/**
 * Where each destination's target classifications live, as a table rather than as branches.
 *
 * A classification is the one destination fact draftgate cannot derive and does not ask the
 * network for: which Jira projects are service desks, and which GitHub repositories are public.
 * Both come from an operator file, both can be answered in the review window, and both decide the
 * audience banner. `review.ts` forwards the answer and stays destination-blind; this table knows
 * which file it belongs in.
 *
 * The keying, parser and writer stay in each destination's module, because the keys differ: Jira by
 * cloud id (a project key is unique only within a site), GitHub by `owner/repo` lowercased.
 *
 * Each store still checks the bare `answer` string. On the production path (`main.ts`) the check
 * cannot fire, since the answer already names its destination (`ownAnswerFor`, audience.md); it
 * stays as the last layer before a persisted write, and the only one that tells the operator.
 * `tools/jira-projects/from-mcp.mjs` imports `rememberJiraSite` directly and never reaches it.
 *
 * `remember` returns its line rather than printing it, so `main.ts` holds the one stderr write and
 * each branch is testable without a stream. Every branch says something: silence would be "a click
 * that changes the banner and then quietly does nothing".
 */

import {
  githubRepoKey,
  isKnownDestination,
  type AudienceFacts,
  type DestinationName,
} from '../../core/src/index';
import { jiraTargetProjectKey, profiles } from '../../core/src/index';
import {
  githubReposPath,
  githubReposSummary,
  isGitHubRepoVisibility,
  loadGithubRepos,
  rememberGithubRepo,
  type GithubRepos,
} from './githubRepos';
import {
  isProjectType,
  jiraProjectsPath,
  jiraProjectsSummary,
  loadJiraProjects,
  rememberJiraProject,
  type JiraProjects,
} from './jiraProjects';
import { fileURLToPath } from 'node:url';
import { REMEDY } from '../../core/src/remedies';
import { shQuote } from './text';
import { GITHUB_REPOS_IN_REPO, JIRA_PROJECTS_IN_REPO } from './hookModes';

/** Each classifier's command, by absolute path: the reader of a message naming one is rarely in the checkout. */
const inRepo = (path: string) => shQuote(fileURLToPath(new URL(`../../${path}`, import.meta.url)));
export const JIRA_REFRESH = REMEDY.jiraProjects(inRepo(JIRA_PROJECTS_IN_REPO));
export const GITHUB_REFRESH = REMEDY.githubRepos(inRepo(GITHUB_REPOS_IN_REPO));

/** What a destination's classification file yields, in the shape every consumer reads. */
export interface LoadedClassifications {
  /** The slice of `AudienceFacts` this file supplies. Empty when the file is absent. */
  facts: Partial<AudienceFacts>;
  /** What a file that exists could not give, for one line on stderr. */
  problem?: string;
  /** How many targets carry a usable classification. Zero is a working install, not a fault. */
  classified: number;
  /**
   * The numbers a report prints, in this destination's own vocabulary -- Jira's sites, projects and
   * service desks; GitHub's repositories and how many are public.
   *
   * Numbers, not sentences: audience prose belongs in `AUDIENCE_SECTIONS`, where the doctor's drift
   * sweeps see it. Keyed by name because `AudienceSection.counted` reads the keys its own store
   * writes; `cli/test/classificationStores.test.ts` pins each store's key set.
   */
  counts: Readonly<Record<string, number>>;
  present: boolean;
  path: string;
}

export interface ClassificationStore {
  /** Read it. Never throws and never degrades to silence. */
  load(env?: NodeJS.ProcessEnv): LoadedClassifications;
  /**
   * File the reviewer's answer, and say what happened. A write failure is reported and never
   * withdraws the decision.
   *
   * Returns the line to print, or `''` when the answer matches a declaration already on file.
   */
  remember(context: Record<string, unknown>, answer: string, env?: NodeJS.ProcessEnv): string;
}

/**
 * What `remember` says once a target has been named and a writer has answered: the sentences both
 * stores share. Each store keeps its own resolver and writer. `''` when the answer matches what is
 * already on file.
 */
function describeWrite(said: {
  key: string;
  answer: string;
  /** The value already on file, when an outranking declaration was kept. */
  kept?: string;
  /** Whether that declaration came from the destination itself rather than an earlier click. */
  fromVendor: boolean;
  /** What the destination is called in that sentence: 'Jira', 'GitHub'. */
  vendor: string;
  /** The command that re-reads the destination's own answer. */
  refresh: string;
  path: string;
  error?: Error;
}): string {
  const { key, answer, kept, fromVendor, vendor, refresh, path, error } = said;
  if (error) return `could not remember that ${key} is ${answer}: ${error.message}`;
  if (kept === undefined) return `remembered that ${key} is ${answer} (${path})`;
  if (kept === answer) return '';
  // The answer contradicts a declaration that outranks it, and the record wins.
  return (
    `you answered that ${key} is ${answer}, but it is already declared as ${kept}` +
    `${fromVendor ? ` from ${vendor} itself` : ''}. Keeping that. Re-run ${refresh} if the ` +
    'declaration is the wrong one.'
  );
}

const jiraStore: ClassificationStore = {
  load(env) {
    const loaded: JiraProjects = loadJiraProjects(env);
    // Sites, not projects: `jiraProjectsSummary` counts a site only if something in it is usable.
    const { sites, projects, serviceDesks } = jiraProjectsSummary(loaded);
    return {
      facts: { sites: loaded.sites },
      ...(loaded.problem !== undefined && { problem: loaded.problem }),
      classified: sites,
      counts: { sites, projects, serviceDesks },
      present: loaded.present,
      path: loaded.path,
    };
  },
  remember(context, answer, env = process.env) {
    if (!isProjectType(answer)) {
      return `ignored the answer "${answer}" -- it is not a Jira project type.`;
    }
    // Only the key is checked here; `rememberJiraProject` normalises and refuses the site. The key
    // comes from `jiraTargetProjectKey`, the resolver `jiraAudience` asks with (see its doc).
    const key = jiraTargetProjectKey(context);
    if (key === undefined) {
      return (
        'could not remember the answer -- the payload names no project, only an issue id, so ' +
        `there is nothing to file it under. Run ${JIRA_REFRESH} to declare it instead.`
      );
    }
    const cloudId = typeof context.cloudId === 'string' ? context.cloudId : '';
    const { error, kept } = rememberJiraProject({ cloudId, key, type: answer }, env);
    return describeWrite({
      key,
      answer,
      ...(kept !== undefined && { kept: kept.type }),
      fromVendor: kept?.source === 'jira',
      vendor: profiles.jira.displayName,
      refresh: JIRA_REFRESH,
      path: jiraProjectsPath(env),
      ...(error !== undefined && { error }),
    });
  },
};

const githubStore: ClassificationStore = {
  load(env) {
    const loaded: GithubRepos = loadGithubRepos(env);
    const { repos, public: pub } = githubReposSummary(loaded);
    return {
      facts: { repos: loaded.repos },
      ...(loaded.problem !== undefined && { problem: loaded.problem }),
      classified: repos,
      counts: { repos, public: pub },
      present: loaded.present,
      path: loaded.path,
    };
  },
  remember(context, answer, env = process.env) {
    if (!isGitHubRepoVisibility(answer)) {
      return `ignored the answer "${answer}" -- it is not a GitHub repository visibility.`;
    }
    const key = githubRepoKey(context);
    if (key === undefined) {
      return (
        'could not remember the answer -- the payload names no owner/repo pair, so there is ' +
        'nothing to file it under.'
      );
    }
    const { error, kept } = rememberGithubRepo({ key, visibility: answer }, env);
    return describeWrite({
      key,
      answer,
      ...(kept !== undefined && { kept: kept.visibility }),
      fromVendor: kept?.source === 'github',
      vendor: profiles.github.displayName,
      refresh: GITHUB_REFRESH,
      path: githubReposPath(env),
      ...(error !== undefined && { error }),
    });
  },
};

/**
 * The table. Partial: Slack and Linear have one audience each and no question to ask.
 * `main.ts` calls `classificationStore(destination)?.remember(...)`; `--doctor` enumerates it.
 */
export const CLASSIFICATION_STORES: Partial<Record<DestinationName, ClassificationStore>> = {
  jira: jiraStore,
  github: githubStore,
};

/** The store for a destination, or `undefined` where the question does not arise. */
export function classificationStore(destination: string): ClassificationStore | undefined {
  return isKnownDestination(destination) ? CLASSIFICATION_STORES[destination] : undefined;
}

/**
 * What one destination's classification file yields, reduced to what a report says about it:
 * `LoadedClassifications` minus the audience facts. `adapters/hook/src/doctor.ts` imports it.
 */
export type ClassificationState = Omit<LoadedClassifications, 'facts'>;

/**
 * Every destination's classification file, read and reduced to what a report prints. The one place
 * that does this I/O for a diagnostic.
 *
 * Absent and unreadable both produce a row (a broken file carries its `problem`): a destination
 * missing from a diagnostic is indistinguishable from one that is fine.
 */
export function classificationStates(
  env: NodeJS.ProcessEnv = process.env
): Partial<Record<DestinationName, ClassificationState>> {
  const out: Partial<Record<DestinationName, ClassificationState>> = {};
  for (const [name, store] of Object.entries(CLASSIFICATION_STORES) as [
    DestinationName,
    ClassificationStore,
  ][]) {
    const { facts: _facts, ...state } = store.load(env);
    out[name] = state;
  }
  return out;
}
