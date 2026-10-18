/**
 * Which Jira projects are service desks, per site.
 *
 * The one fact `core` cannot supply and draftgate cannot look up. A JSM comment posted through the
 * gated tool is a public reply to the customer: the tool exposes no `sd.public.comment` property,
 * and probed, its absence means PUBLIC (`core/src/audience.ts`). Whether an issue key belongs to such
 * a project is a property of the site. `core` is pure and draftgate holds no Jira credentials, so
 * the operator answers here:
 *
 *     ~/.draftgate/jira-projects.json
 *     {
 *       "sites": {
 *         "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d": {
 *           "host": "acme-dev.atlassian.net",
 *           "projects": { "SUPPORT": "service_desk", "KAN": "software" }
 *         }
 *       }
 *     }
 *
 * `tools/jira-projects/` generates it from `/rest/api/3/project/search` with the operator's own
 * token: not a dependency, not shipped, run once per site.
 *
 * Keyed by site because a project key is unique only within one. The payload always carries
 * `cloudId` (required by the Rovo tools' schema, optional but checked by `jira_add_internal_note`,
 * and in the profile's `contextFields` either way), so the ambiguity is avoidable.
 *
 * Nothing here throws and no config problem blocks a review: no file, no entry and a broken file all
 * read as `unknown`, a loud banner. A file that is present and broken also sets `problem`, which the
 * CLI prints once on stderr.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftgateHome, ensurePrivateDir, writePrivateFile } from './audit';
import { isPlainObject } from './json';
import { configMergeBase, namedSample, readConfigText } from './configFiles';
import {
  isProjectType,
  jiraProjectKeyOf,
  jiraSiteKey,
  jiraSiteKeyFor,
  jiraSiteKeysFor,
  type JiraProjectSource,
  type JiraProjectType,
  type JiraSite,
} from '../../core/src/index';

export const JIRA_PROJECTS_BASENAME = 'jira-projects.json';

/**
 * The file's shape as a writer leaves it: `sites` is the one key both writers construct, so
 * `withJiraSite`'s caller need not re-check it. Other top-level keys are preserved and stay
 * `unknown`.
 */
export type JiraProjectsRoot = Record<string, unknown> & { sites: Record<string, unknown> };

/** What the parser can say: it is handed text and a name for it, and knows nothing about a disk. */
export interface ParsedJiraProjects {
  /** Cloud id to that site's classification. Empty when there is nothing usable to say. */
  sites: Record<string, JiraSite>;
  /**
   * What a file that exists could not give, for one line on stderr. Absent when the file is absent
   * (an install with no JSM projects needs none); specific when something was dropped, so the
   * message says what still works.
   */
  problem?: string;
}

/**
 * What the reader can say: the parse, plus the two facts only a filesystem has. `present` is not
 * derivable from the rest: an absent file and a present `{"sites":{}}` both parse to no sites and no
 * problem.
 */
export interface JiraProjects extends ParsedJiraProjects {
  path: string;
  present: boolean;
}

/**
 * How much of that file is usable, for `--doctor`. Not `Object.keys(sites).length`: partial credit
 * leaves a site whose every project was rejected as an empty entry, which must not count as "1
 * classified site".
 */
export function jiraProjectsSummary(loaded: ParsedJiraProjects): {
  sites: number;
  projects: number;
  serviceDesks: number;
} {
  let sites = 0;
  let projects = 0;
  let serviceDesks = 0;
  for (const site of Object.values(loaded.sites)) {
    const types = Object.values(site.projects);
    if (types.length === 0) continue;
    sites++;
    projects += types.length;
    for (const type of types) if (type === 'service_desk') serviceDesks++;
  }
  return { sites, projects, serviceDesks };
}

/**
 * The file's own spelling of each project key, indexed by the normalised one, for both writers'
 * "is this project already here, in any casing". A map, because a `.find` per row in
 * `withJiraSite`'s loop is quadratic. An existing spelling is reused, not rewritten to the canonical
 * one.
 */
function spellingIndex(record: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  // First wins: two spellings of one key are the reader's to report.
  for (const k of Object.keys(record)) {
    const norm = jiraProjectKeyOf(k);
    if (!out.has(norm)) out.set(norm, k);
  }
  return out;
}

/**
 * The vocabulary predicate, re-exported from core rather than re-implemented, so the writer checks
 * a row with the reader's predicate. `tools/jira-projects/from-mcp.mjs` uses it to validate its
 * agent-transcribed input before writing.
 */
export { isProjectType };

export function jiraProjectsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(draftgateHome(env), JIRA_PROJECTS_BASENAME);
}

/**
 * A site spelling reduced to a plain hostname, or `null` when it is not one.
 *
 * `jiraSiteKey` strips the scheme and trailing slashes and nothing else (it also keys by cloud id, a
 * UUID), so these survive it:
 *
 *   acme.atlassian.net@evil.test   -> https://acme.atlassian.net@evil.test/rest/...
 *   evil.test/acme.atlassian.net   -> https://evil.test/acme.atlassian.net/rest/...
 *
 * `tools/jira-projects/generate.mjs` builds a URL from this and sends the operator's API token to
 * it: `@` makes the part before it userinfo, so the request goes to `evil.test` carrying
 * `Authorization: Basic` in full. (A redirect could not; fetch drops `Authorization` cross-origin.)
 * `from-mcp.mjs` writes `host` to the config, where a non-hostname is a row `jiraSiteKeysFor` never
 * matches.
 *
 * A round trip through the `URL` parser `fetch` uses, required to come back unchanged, not a
 * hostname regex: `a@b`, `a/b`, `a:8443`, `a?x` and `a#y` all fail one comparison. No
 * `*.atlassian.net` allow-list, since Atlassian Cloud supports custom domains. A dot is required,
 * so `localhost` gets no token. Not in core, where `URL` is not a global.
 */
export function jiraSiteHostname(spelling: string): string | null {
  const host = jiraSiteKey(spelling);
  if (host === '' || !host.includes('.')) return null;
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/`);
  } catch {
    return null;
  }
  return parsed.hostname === host ? host : null;
}

/**
 * Parse the file's text. Pure, so every degradation below is testable without a filesystem.
 * Partial credit: one bad entry costs that entry, so one typo does not turn every declared service
 * desk into `unknown`.
 */
export function parseJiraProjects(text: string, source: string): ParsedJiraProjects {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { sites: {}, problem: `${source}: not valid JSON (${(e as Error).message})` };
  }

  if (!isPlainObject(parsed)) {
    return {
      sites: {},
      problem:
        `${source}: expected an object like {"sites": {"<cloudId>": {"projects": ` +
        `{"SUPPORT": "service_desk"}}}}, and found ` +
        `${Array.isArray(parsed) ? 'an array' : typeof parsed}.`,
    };
  }

  const { sites } = parsed;
  if (sites === undefined) {
    return { sites: {}, problem: `${source}: has no "sites" key, so it declares nothing.` };
  }
  if (!isPlainObject(sites)) {
    return {
      sites: {},
      problem: `${source}: "sites" must be an object keyed by cloud id.`,
    };
  }

  const out: Record<string, JiraSite> = {};
  const rejected: string[] = [];
  let kept = 0;
  for (const [cloudId, raw] of Object.entries(sites)) {
    if (!isPlainObject(raw)) {
      rejected.push(`${cloudId}: not an object`);
      continue;
    }
    const { host, projects, sources } = raw;
    if (!isPlainObject(projects)) {
      rejected.push(`${cloudId}: no "projects" object`);
      continue;
    }
    /*
     * Keyed the way the reader looks it up. `jiraSiteFor` normalises what it compares, so a raw
     * `"https://acme.atlassian.net/"` key would be unreachable by every payload spelling, with no
     * `problem`. Normalising also merges two spellings of one site, so the conflict check below says
     * "declared twice". A key that normalises to nothing is rejected: `jiraSiteFor` refuses an empty
     * `want`, so it could never be reached.
     */
    const id = jiraSiteKey(cloudId);
    if (id === '') {
      rejected.push(`${JSON.stringify(cloudId)}: names no site`);
      continue;
    }
    // Reused rather than rebuilt, so a second spelling adds to the first instead of shadowing it.
    const site: JiraSite = out[id] ?? { projects: {} };
    out[id] = site;
    // First declaration wins: `host` is how the other spelling is found, and swapping it would move
    // the site away from payloads that resolve by it.
    if (site.host === undefined && typeof host === 'string' && host.trim() !== '') {
      site.host = host.trim();
    }
    // Where each classification came from; an unmarked entry counts as authoritative. A bad source
    // is dropped silently: it is a bad label on a good classification.
    if (isPlainObject(sources)) {
      for (const [key, value] of Object.entries(sources)) {
        if (value === 'jira' || value === 'reviewer') {
          (site.sources ??= {})[jiraProjectKeyOf(key)] = value;
        }
      }
    }
    for (const [key, value] of Object.entries(projects)) {
      // Uppercased, as `jiraProjectKey` does on the way out: Jira issue keys are case-insensitive
      // (probed).
      const normalised = jiraProjectKeyOf(key);
      if (!isProjectType(value)) {
        rejected.push(`${cloudId}/${key}: ${JSON.stringify(value)}`);
        continue;
      }
      const existing = site.projects[normalised];
      if (existing !== undefined && existing !== value) {
        // Two spellings of one key disagree; keeping the last would let line order decide.
        rejected.push(`${cloudId}/${normalised}: declared twice, as ${existing} and ${value}`);
        continue;
      }
      site.projects[normalised] = value;
      kept++;
    }
  }

  if (rejected.length === 0) return { sites: out };
  return {
    sites: out,
    problem:
      `${source}: kept ${kept} project(s); ignored ${rejected.length} entr` +
      `${rejected.length === 1 ? 'y' : 'ies'} -- ${namedSample(rejected)}`,
  };
}

/**
 * Read the file, if there is one. A missing file is the ordinary state and no problem; any other
 * read failure (a directory in its place, a permissions error) is reported.
 */
export function loadJiraProjects(env: NodeJS.ProcessEnv = process.env): JiraProjects {
  const path = jiraProjectsPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { sites: {}, path, present: false };
    return {
      sites: {},
      path,
      // Present but unreadable: `false` would tell the operator the file does not exist.
      present: true,
      problem: `${path}: could not be read (${err.code ?? err.message})`,
    };
  }
  return { ...parseJiraProjects(text, path), path, present: true };
}

/**
 * The file's own structure, ready to merge one site into -- or an Error saying why not. Both writers
 * merge into the raw text's structure, so unknown top-level keys survive; `configMergeBase` holds
 * the refusal rule.
 */
export function jiraProjectsMergeBase(
  text: string,
  source: string
): Record<string, unknown> | Error {
  return configMergeBase(text, source, 'sites');
}

/**
 * One site's entry, with a project added. Takes the base from `jiraProjectsMergeBase` and returns
 * the whole root to write, or `kept` when an entry that outranks the fact is already declared.
 */
export function withJiraProject(
  root: Record<string, unknown>,
  fact: { cloudId: string; key: string; type: JiraProjectType; source: JiraProjectSource }
): { root: Record<string, unknown> } | { kept: string; source: JiraProjectSource | 'unmarked' } {
  const sites = { ...(isPlainObject(root.sites) ? root.sites : {}) };
  /*
   * The site row found the way the reader finds it (`jiraSiteKeyFor`: normalised key or declared
   * `host`). With a file keyed by UUID and a payload spelling `cloudId` as the site URL (the tool's
   * schema accepts both), an exact lookup would file the answer in a second, shadowed row and the
   * reviewer would be asked every time.
   */
  const site = jiraSiteKeyFor(fact.cloudId, sites) ?? jiraSiteKey(fact.cloudId);
  const existing = isPlainObject(sites[site]) ? sites[site] : {};
  const projects = isPlainObject(existing.projects) ? { ...existing.projects } : {};
  const sources = isPlainObject(existing.sources) ? { ...existing.sources } : {};
  // The reader normalises keys, so the writer looks up the same way; otherwise a hand-written
  // lower-case entry gets an upper-case twin and the reader picks whichever came second.
  const key = jiraProjectKeyOf(fact.key);
  const spelling = spellingIndex(projects).get(key) ?? key;
  const sourceSpelling = spellingIndex(sources).get(key) ?? spelling;

  // The signing rule (`JiraProjectSource`): `jira` outranks everything, `reviewer` replaces only
  // `reviewer`, and an unmarked (hand-written) entry counts as authoritative.
  const held = projects[spelling];
  if (held !== undefined) {
    const mark = sources[sourceSpelling];
    const heldSource = mark === 'jira' || mark === 'reviewer' ? mark : 'unmarked';
    const mayReplace = fact.source === 'jira' || heldSource === 'reviewer';
    if (!mayReplace) return { kept: String(held), source: heldSource };
  }

  projects[spelling] = fact.type;
  sources[sourceSpelling] = fact.source;
  // `...existing` is what preserves a `host` the generator recorded.
  return {
    root: { ...root, sites: { ...sites, [site]: { ...existing, projects, sources } } },
  };
}

/**
 * A whole site's measurement, merged in -- the generator's half of the same rule. Here, not in the
 * instruments, because they read argv and the network at import and cannot be tested.
 *
 * A measurement replaces what it measured, not what it did not see. `/rest/api/3/project/search`
 * excludes archived projects by default and returns only what the token can browse, so a reviewer's
 * classification of an archived `LEGACY` would vanish on the next run. A project the measurement
 * does not mention is carried forward with its source, and its name returned; one it does mention is
 * replaced, mark and all, which makes this the correction path for a mistaken click.
 */
export function withJiraSite(
  root: Record<string, unknown>,
  measured: { cloudId: string; host: string; projects: Record<string, JiraProjectType> }
): { root: JiraProjectsRoot; carried: string[]; replaced: boolean } {
  const sites = { ...(isPlainObject(root.sites) ? root.sites : {}) };
  /*
   * Every row that names this site, merged under the cloud id. This tool knows the real cloud id
   * (from `/_edge/tenant_info`); `withJiraProject` may have filed a reviewer's answer under the
   * host, and keying by cloud id alone would leave that row beside it. Collecting also repairs a file
   * that already holds duplicates. Insertion order decides a project two rows disagree about, as
   * `jiraSiteFor` would.
   */
  const key = jiraSiteKey(measured.cloudId);
  // Both spellings, through the reader's own matcher.
  const mine = jiraSiteKeysFor([measured.cloudId, measured.host], sites);
  const replaced = mine.length > 0;
  const existing: Record<string, unknown> = {};
  const held: Record<string, unknown> = {};
  const heldSources: Record<string, unknown> = {};
  for (const id of mine) {
    const site = isPlainObject(sites[id]) ? sites[id] : {};
    // `projects` and `sources` are merged per key below; everything else is a site-level field
    // neither writer knows about, and the first row that declares one keeps it.
    for (const [k, v] of Object.entries(site)) {
      if (k !== 'projects' && k !== 'sources' && !(k in existing)) existing[k] = v;
    }
    if (isPlainObject(site.projects)) {
      for (const [k, v] of Object.entries(site.projects)) if (!(k in held)) held[k] = v;
    }
    if (isPlainObject(site.sources)) {
      for (const [k, v] of Object.entries(site.sources)) if (!(k in heldSources)) heldSources[k] = v;
    }
    delete sites[id];
  }

  const measuredKeys = new Set(Object.keys(measured.projects).map(jiraProjectKeyOf));
  // Built once: `sources` may spell a key differently from `projects`, and a per-row rebuild is
  // quadratic.
  const markSpelling = spellingIndex(heldSources);
  const carried: string[] = [];
  const projects: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const [spelling, value] of Object.entries(held)) {
    const key = jiraProjectKeyOf(spelling);
    if (measuredKeys.has(key)) continue;
    projects[spelling] = value;
    const mark = markSpelling.get(key);
    if (mark !== undefined) sources[mark] = heldSources[mark];
    carried.push(key);
  }
  for (const [k, v] of Object.entries(measured.projects)) {
    projects[k] = v;
    // Measured by `project/search`; the stamp lets a later click be refused.
    sources[k] = 'jira';
  }

  return {
    // `...existing` preserves unknown site-level keys; `host` is the one this run resolved.
    root: {
      ...root,
      sites: { ...sites, [key]: { ...existing, host: measured.host, projects, sources } },
    },
    carried,
    replaced,
  };
}

/**
 * The file as a base to merge into, or the reason it must not be touched. Both writers' four steps:
 * resolve the path, refuse a cloud id that names no site (a `sites[""]` row no reader reaches),
 * read, and refuse a base that cannot be merged into.
 */
function jiraProjectsBase(
  cloudId: string,
  env: NodeJS.ProcessEnv
): { path: string; base: Record<string, unknown> } | { path: string; error: Error } {
  const path = jiraProjectsPath(env);
  if (jiraSiteKey(cloudId) === '') {
    return { path, error: new Error(`${cloudId.trim() === '' ? 'an empty cloudId' : cloudId} names no site`) };
  }
  const text = readConfigText(path);
  if (text instanceof Error) return { path, error: text };
  const base = jiraProjectsMergeBase(text, path);
  return base instanceof Error ? { path, error: base } : { path, base };
}

/**
 * The file's text for a root, and the one place its on-disk format is spelled. Both instruments'
 * `--print` and the write call it, so the preview is what a first run writes.
 */
export function jiraProjectsText(root: JiraProjectsRoot): string {
  return JSON.stringify(root, null, 2) + '\n';
}

/** What `--print` would write for a first run: the measurement against an empty base. */
export function jiraSiteFileText(measured: JiraSiteMeasurement): string {
  return jiraProjectsText(withJiraSite({}, measured).root);
}

/** One site as a measurement names it. Spelled once; three functions and both instruments take it. */
export interface JiraSiteMeasurement {
  cloudId: string;
  host: string;
  projects: Record<string, JiraProjectType>;
}

/**
 * A whole site's measurement, written to the file -- the read-merge-write half of `withJiraSite`,
 * for `tools/jira-projects/generate.mjs` and `from-mcp.mjs`. `env` is threaded so a test can use a
 * temporary home.
 */
export function rememberJiraSite(
  measured: JiraSiteMeasurement,
  env: NodeJS.ProcessEnv = process.env
): JiraSiteOutcome {
  // `path` on both arms: the instruments print it, and `writePrivateFile`'s raw error names its
  // temporary path instead.
  const opened = jiraProjectsBase(measured.cloudId, env);
  if ('error' in opened) return opened;

  const merged = withJiraSite(opened.base, measured);
  // 0700/0600 like everything under draftgate's home; both helpers tighten an existing mode too.
  ensurePrivateDir(draftgateHome(env), env);
  const failed = writePrivateFile(opened.path, jiraProjectsText(merged.root));
  if (failed) return { error: failed, path: opened.path };
  return {
    carried: merged.carried,
    replaced: merged.replaced,
    // Rows the file now holds, including any a reader would reject; `jiraProjectsSummary` counts
    // classified sites.
    siteRows: Object.keys(merged.root.sites).length,
    path: opened.path,
  };
}

/**
 * Everything an instrument tells the operator about a site write, as lines, so it is testable (the
 * instruments read argv, stdin or the network at import). The two instruments' reports differ by
 * one word, `notCovered`: `generate.mjs` ran a search, `from-mcp.mjs` was handed a read.
 */
export function describeJiraSiteWrite(
  measured: JiraSiteMeasurement,
  outcome: JiraSiteOutcome | null,
  notCovered: 'search' | 'read'
): string[] {
  const lines: string[] = [];
  if (outcome !== null && 'error' in outcome) {
    lines.push(`${outcome.error.message}.`);
    lines.push(`Nothing was written to ${outcome.path}. Fix or move it, then run this again.`);
  } else if (outcome !== null) {
    lines.push(
      `${outcome.replaced ? 'updated' : 'added'} ${measured.host} (${measured.cloudId}) in ` +
        `${outcome.path}; the file now holds ${outcome.siteRows} site(s)`
    );
    // A project the measurement does not mention was not measured (see `withJiraSite`).
    if (outcome.carried.length > 0) {
      lines.push(
        `kept ${outcome.carried.length} existing classification(s) this ${notCovered} did not ` +
          `cover: ${outcome.carried.join(', ')}`
      );
    }
  }

  const desks = Object.entries(measured.projects).filter(([, t]) => t === 'service_desk');
  lines.push(
    `${Object.keys(measured.projects).length} project(s) on ${measured.host}; ` +
      `${desks.length} service desk(s): ${desks.map(([k]) => k).join(', ') || '(none)'}`
  );
  lines.push(
    'Comments draftgate reviews on those projects are PUBLIC replies to the customer, and the ' +
      'Atlassian MCP cannot post an internal note. The review window will say so.'
  );
  return lines;
}

/**
 * What a site write reports. A union, unlike `RememberOutcome`, so the success arm's three fields are
 * non-optional for the instruments that read them.
 */
export type JiraSiteOutcome =
  | { error: Error; path: string }
  | { carried: string[]; replaced: boolean; siteRows: number; path: string };

export interface RememberOutcome {
  /** Absent when the answer was written. */
  error?: Error;
  /** Present when an existing, higher-ranked declaration was left in place. */
  kept?: { type: string; source: JiraProjectSource | 'unmarked' };
}

/**
 * Remember one project's type, because the reviewer just told us in the window.
 *
 * Merges into the file's own text, not into `loadJiraProjects`'s result: that degrades to
 * `{sites: {}}` on invalid JSON (one trailing comma would leave a one-project file and report
 * success), and re-serialising the parse would delete the entries it rejected. Stamped `reviewer`,
 * so a later click can correct it (`withJiraProject`). Never throws, like `appendAudit`: nothing kept
 * for draftgate's convenience may change a decision a human made.
 */
export function rememberJiraProject(
  fact: { cloudId: string; key: string; type: JiraProjectType },
  env: NodeJS.ProcessEnv = process.env
): RememberOutcome {
  // The shared skeleton; its cloud-id refusal is worded for both writers.
  const opened = jiraProjectsBase(fact.cloudId, env);
  if ('error' in opened) return { error: opened.error };
  const path = opened.path;

  const merged = withJiraProject(opened.base, { ...fact, source: 'reviewer' });
  if ('kept' in merged) return { kept: { type: merged.kept, source: merged.source } };

  ensurePrivateDir(draftgateHome(env), env);
  // Write-then-rename: a torn write would lose every other site.
  const failed = writePrivateFile(path, jiraProjectsText(merged.root as JiraProjectsRoot));
  return failed ? { error: failed } : {};
}
