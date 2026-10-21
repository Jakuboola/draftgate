/**
 * Write `~/.draftgate/jira-projects.json` from a Jira site's own project list. Ships in the plugin
 * tree (`CLASSIFIERS_IN_REPO`); a review never runs it, the user does.
 *
 *     bun tools/jira-projects/generate.mjs acme.atlassian.net
 *     bun tools/jira-projects/generate.mjs acme.atlassian.net --print   # stdout, write nothing
 *
 * Run it once per site. The file is keyed by cloud id (what a tool payload carries) and each run
 * merges its site in, so a second site does not discard the first.
 *
 * Why draftgate does not fetch this itself: whether a project is a service desk decides if a JSM
 * comment is a public reply to a customer, and finding out takes an authenticated call. `core` is
 * pure and draftgate holds no destination credentials, so the fact lives in a file written by the
 * person who has the token.
 *
 * Credentials: `JIRA_EMAIL` and `JIRA_TOKEN`, from the environment or from `~/.claude/settings.json`
 * under `env`. The site is a required argument and is never taken from `JIRA_URL`, which may name
 * another site: a classification of the wrong site looks right and is wrong about which projects
 * face customers.
 *
 * Only `GET /rest/api/3/project/search` is called.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Shared with the review path. `rememberJiraSite` is the whole read-merge-write, including tightening
// the mode of an existing file and directory (`mode` applies at creation only).
import {
  describeJiraSiteWrite,
  jiraSiteFileText,
  jiraSiteHostname,
  rememberJiraSite,
} from '../../cli/src/jiraProjects.ts';

const PAGE = 50;

const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const site = args.find((a) => !a.startsWith('--'));

if (!site) {
  console.error('usage: bun tools/jira-projects/generate.mjs <site> [--print]');
  console.error('  site   e.g. acme.atlassian.net -- REQUIRED, never guessed from JIRA_URL');
  process.exit(2);
}

const creds = readCredentials();
/*
 * Shared reduction and hostname check. A local `jiraSiteKey` copy drifts: without its `i` flag the
 * scheme of `Https://acme.atlassian.net` survives and `ACME.atlassian.net` is stored mixed-case, and
 * `host` is what every later read matches on. The hostname check guards the token:
 * `acme.atlassian.net@evil.test` reads as the real site and sends the Authorization header to
 * `evil.test` (`cli/src/jiraProjects.ts`).
 */
const host = jiraSiteHostname(site);
if (host === null) {
  console.error(
    `"${site}" is not a plain hostname.\n` +
      'A site is a bare host like acme.atlassian.net -- no "@", no port, no path, no query. This ' +
      "refuses rather than guesses because the request carries your Jira API token in an " +
      'Authorization header, and an "@" in the argument sends it to whatever follows it.'
  );
  process.exit(2);
}
const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

// The site's cloud id, which a tool payload carries and the config is keyed by. `/_edge/tenant_info`
// is unauthenticated.
const cloudId = await tenantId(host);

const projects = {};
let startAt = 0;
for (;;) {
  const url =
    `https://${host}/rest/api/3/project/search?maxResults=${PAGE}&startAt=${startAt}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    console.error(`${url} -> ${res.status} ${res.statusText}`);
    console.error(await res.text().catch(() => ''));
    process.exit(1);
  }
  const page = await res.json();
  const values = page.values ?? [];
  for (const p of values) {
    // Verbatim from Atlassian. `cli/src/jiraProjects.ts` rejects a value it does not recognise and
    // names it, so a new project type shows up as a rejected entry.
    projects[p.key] = p.projectTypeKey;
  }
  if (page.isLast || values.length === 0) break;
  // Advance by what the server returned: a site that caps `maxResults` below the request would
  // otherwise skip rows, and a dropped service desk gets a review with no banner.
  startAt += values.length;
}

// Rows are signed `jira`, so a later run corrects a reviewer's click and a click never overwrites
// them (`JiraProjectSource`). The writer merges by cloud id and keeps other sites and unknown keys.
const measured = { cloudId, host, projects };
if (printOnly) process.stdout.write(jiraSiteFileText(measured));
const outcome = printOnly ? null : rememberJiraSite(measured);
for (const line of describeJiraSiteWrite(measured, outcome, 'search')) console.error(line);
if (outcome !== null && 'error' in outcome) process.exit(1);

/** The site's cloud id, which is what a tool payload names the site by. */
async function tenantId(hostname) {
  const res = await fetch(`https://${hostname}/_edge/tenant_info`);
  if (!res.ok) {
    console.error(`https://${hostname}/_edge/tenant_info -> ${res.status} ${res.statusText}`);
    console.error('Without a cloud id this config cannot be keyed the way a payload is read.');
    process.exit(1);
  }
  const { cloudId: id } = await res.json();
  if (typeof id !== 'string' || id === '') {
    console.error(`${hostname}: tenant_info returned no cloudId`);
    process.exit(1);
  }
  return id;
}

/**
 * `~/.claude/settings.json` `env`, with the environment winning. Missing credentials exit rather
 * than send an anonymous request: an unauthenticated `project/search` can return only the public
 * projects, and the file would omit the private service desks.
 */
function readCredentials() {
  let fromSettings = {};
  try {
    fromSettings = JSON.parse(
      readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')
    ).env ?? {};
  } catch {
    // No settings file, or not readable. The environment may still have both.
  }
  const email = process.env.JIRA_EMAIL || fromSettings.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN || fromSettings.JIRA_TOKEN;
  if (!email || !token) {
    console.error(
      'JIRA_EMAIL and JIRA_TOKEN are needed, from the environment or ~/.claude/settings.json "env".'
    );
    process.exit(2);
  }
  return { email, token };
}
