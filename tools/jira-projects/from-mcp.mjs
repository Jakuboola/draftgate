/**
 * Write `~/.draftgate/jira-projects.json` from what an agent read off a Jira connector. Ships in the
 * plugin tree (`CLASSIFIERS_IN_REPO`); a review never runs it.
 *
 * `generate.mjs` needs `JIRA_EMAIL` and `JIRA_TOKEN`; this needs neither. `getVisibleJiraProjects`
 * returns the same `projectTypeKey` through the connector's OAuth, and `--print` here is
 * byte-identical to `generate.mjs --print` for the same site (both call `jiraSiteFileText`).
 * `generate.mjs` stays for anyone with no connector.
 *
 *     bun tools/jira-projects/from-mcp.mjs <<'JSON'
 *     { "cloudId": "0a1b2c3d-...", "host": "acme.atlassian.net",
 *       "projects": { "KAN": "software", "SUPPORT": "service_desk" } }
 *     JSON
 *
 * `--print` writes the merged result to stdout and touches no file. One site per run, and a second
 * site never discards the first.
 *
 * What the caller has to get right:
 *
 *  1. `getVisibleJiraProjects` defaults `action` to `create`, the filter for projects you may create
 *     an issue in, which is not the set you can see. Pass `browse`. The default narrows in silence,
 *     and on a site where you are admin both answer the same, so a check there proves nothing.
 *  2. `maxResults` caps at 50 and the endpoint pages (`startAt` / `isLast` / `total`): a site with
 *     157 projects is four calls. A truncated read omits real service desks.
 *     `expandIssueTypes: false` cuts a few hundred lines to a few per project.
 *  3. An OAuth grant can see less than a token, and can see nothing: the connector can answer
 *     `Cloud id ... isn't explicitly granted by the user` for a site whose projects the token
 *     classifies. Under-reporting is safe, since an absent project falls through to the window's
 *     ask and is remembered, but a site that cannot be read here needs `generate.mjs`.
 *  4. A wrong row does not self-heal. `jiraAudience` shows no banner for a known non-service-desk
 *     type, and a reviewer's click can never overwrite a `jira`-signed row, so re-running is the only
 *     remedy. Jira Cloud does not convert project types, so "wrong" means the file was wrong.
 *
 * This file cannot check (1) or (2): a short list looks like a small site. It does check that every
 * value is a real Atlassian project type and refuses the whole run, writing nothing, if one is not.
 * The input was transcribed by a language model, and an invented type is evidence the pass is
 * unreliable, so a partial write signed `jira` would be a confident record built on it.
 */

import { readFileSync } from 'node:fs';
import { isPlainObject } from '../../cli/src/json.ts';
import {
  describeJiraSiteWrite,
  isProjectType,
  jiraSiteFileText,
  jiraSiteHostname,
  rememberJiraSite,
} from '../../cli/src/jiraProjects.ts';
import { JIRA_PROJECT_TYPES, jiraSiteKey, jiraTargetProjectKey } from '../../core/src/index.ts';

const USAGE =
  'usage: bun tools/jira-projects/from-mcp.mjs [--print] < site.json\n' +
  '  stdin  {"cloudId": "<uuid or site url>", "host": "acme.atlassian.net",\n' +
  '          "projects": {"KAN": "software", "SUPPORT": "service_desk"}}\n' +
  `  types  ${JIRA_PROJECT_TYPES.join(', ')}\n` +
  '  Read them with getVisibleJiraProjects and action "browse" -- the default is "create",\n' +
  '  which silently returns fewer projects -- and page until isLast.';

const printOnly = process.argv.slice(2).includes('--print');

// `readFileSync(0, ...)` needs no top-level await, so `fail()` stays an ordinary early exit.
const text = readFileSync(0, 'utf8');
if (text.trim() === '') fail('nothing on stdin.');

let parsed;
try {
  parsed = JSON.parse(text);
} catch (e) {
  fail(`stdin is not valid JSON (${e.message}).`);
}
if (!isPlainObject(parsed)) fail('stdin must be a JSON object describing ONE site.');

// Keyed by cloud id: a project key is unique only within a site, so two sites can both have a
// `SUPPORT`.
const { cloudId, host: rawHost, projects: rawProjects } = parsed;
if (typeof cloudId !== 'string' || jiraSiteKey(cloudId) === '') {
  fail('"cloudId" must name a site. getAccessibleAtlassianResources returns it as `id`.');
}
if (typeof rawHost !== 'string') fail('"host" is required, e.g. "acme.atlassian.net".');
// The check `generate.mjs` applies, for a weaker reason: no URL is built and no token is sent. But
// `host` is one of the two spellings a payload's `cloudId` is matched against, so a non-hostname is
// a row no review can reach.
const host = jiraSiteHostname(rawHost);
if (host === null) {
  fail(`"${rawHost}" is not a plain hostname -- no scheme, no "@", no port, no path.`);
}

if (!isPlainObject(rawProjects)) {
  fail('"projects" must be an object mapping each project KEY to its projectTypeKey.');
}
const entries = Object.entries(rawProjects);
if (entries.length === 0) {
  // An empty read is what a truncated or wrongly scoped call returns, and writing it would stamp
  // "measured, nothing here" over what the file knew about the site.
  fail('"projects" is empty. A site with no visible projects is not something to record.');
}

const projects = {};
const badKeys = [];
const badTypes = [];
for (const [key, type] of entries) {
  // The reader's own key grammar, not a second regex.
  const normalised = jiraTargetProjectKey({ projectKey: key });
  if (normalised === undefined) {
    badKeys.push(key);
    continue;
  }
  // The reader's own predicate: a writer and a reader that normalise differently drift apart.
  if (!isProjectType(type)) {
    badTypes.push(`${key}: ${JSON.stringify(type)}`);
    continue;
  }
  projects[normalised] = type;
}
if (badKeys.length > 0) console.error(`not project keys: ${badKeys.join(', ')}`);
if (badTypes.length > 0) {
  console.error(`not Atlassian project types: ${badTypes.join('; ')}`);
  console.error(
    `The vocabulary is ${JIRA_PROJECT_TYPES.join(', ')} -- projectTypeKey, verbatim, not a ` +
      'label from the UI. If Atlassian has added a type, it needs adding to JIRA_PROJECT_TYPES ' +
      'in core/src/profiles/jira.ts rather than mapping it to something here.'
  );
}
if (badKeys.length + badTypes.length > 0) {
  fail('Nothing was written: a value that is wrong makes the rest of the read untrustworthy too.');
}

// Shared report and `--print`, so this and `generate.mjs` cannot tell an operator two things about
// one merge. Rows are signed `jira`, not `reviewer`: they are Jira's own answer, so a later run can
// correct them and a click cannot overwrite them.
const measured = { cloudId, host, projects };
if (printOnly) process.stdout.write(jiraSiteFileText(measured));
const outcome = printOnly ? null : rememberJiraSite(measured);
for (const line of describeJiraSiteWrite(measured, outcome, 'read')) console.error(line);
// The generator reports what a token could reach; this reports what a connector grant could, a
// different set that fails differently.
console.error(
  'This is what the connector could SEE. A project it did not return is not classified as ' +
    'anything -- the review window asks about it once and remembers the answer.'
);
if (outcome !== null && 'error' in outcome) process.exit(1);

/** Refuse, with the usage, having written nothing. */
function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}
