/**
 * Write `~/.draftgate/github-repos.json` from GitHub's own answer about an owner's repositories.
 * Ships in the plugin tree (`CLASSIFIERS_IN_REPO`); a review never runs it, the user does.
 *
 *     bun run github:repos acme
 *     bun run github:repos acme --print   # stdout, write nothing
 *
 * Run it once per owner. Each run merges, and its rows are signed `github`, which outranks a
 * reviewer's click, so a later run corrects a guess made in the window.
 *
 * Why draftgate does not fetch this itself: a comment on a public repository is a message to the
 * internet and on a private one a message to a team, and the payload carries only names. Turning a
 * name into a visibility takes an authenticated call, and draftgate holds no destination
 * credentials. So the fact lives in a file written by the person who has the token.
 *
 * Credentials are `gh`'s, via `gh api`: this script never reads, stores or prints one.
 *
 * Reads `visibility`, not `private`. `visibility` is `public` | `private` | `internal`, and on
 * Enterprise Cloud an `internal` repository reports `private: true`, so the boolean would file it as
 * private. `--paginate` is passed because an owner with more than thirty repositories otherwise
 * returns a first page that looks complete (the same hazard as `tools/jira-projects/from-mcp.mjs`).
 */

import { execFileSync } from 'node:child_process';
// The writer is shared with the review path, so a tool and a reviewer cannot disagree about the
// file format.
import {
  describeGithubReposWrite,
  githubReposFileText,
  githubReposPath,
  rememberGithubRepos,
} from '../../cli/src/githubRepos.ts';

const args = process.argv.slice(2);
const print = args.includes('--print');
const owner = args.find((a) => !a.startsWith('-'));

if (!owner) {
  process.stderr.write(
    'usage: bun run github:repos <owner> [--print]\n\n' +
      '  <owner>  a GitHub user or organisation, e.g. `acme`. Required, and never inferred:\n' +
      '           writing the wrong owner\'s repositories into the file would classify somebody\n' +
      '           else\'s names as yours.\n' +
      '  --print  show what would be written and write nothing.\n'
  );
  process.exit(2);
}

/** The account `gh` is authenticated as, or `null` if it will not say. */
function me() {
  try {
    return execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Every repository GitHub will show this token for `owner`, as `{ "owner/repo": visibility }`.
 *
 * `/users/{user}/repos` returns only public repositories, including for the authenticated account,
 * so a run against your own name would omit your private ones. `/user/repos` carries them, so it is
 * tried first when the owner is the authenticated account; `affiliation=owner` keeps it to
 * repositories they own rather than every one they can push to.
 */
function fetchRepos(name) {
  // An owner is a user or an organisation: `/orgs/{org}/repos` 404s for a user.
  const paths = [`orgs/${name}/repos`, `users/${name}/repos`];
  if (me()?.toLowerCase() === name.toLowerCase()) paths.unshift('user/repos?affiliation=owner');
  for (const path of paths) {
    let out;
    try {
      out = execFileSync(
        'gh',
        [
          'api',
          '--paginate',
          `${path}${path.includes('?') ? '&' : '?'}per_page=100`,
          '--jq',
          // `.visibility`, not `.private` (see the header).
          '.[] | [.full_name, .visibility] | @tsv',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      const stderr = String(e.stderr ?? '');
      // A 404 on the org path is the ordinary "this is a user" case.
      if (path.startsWith('orgs/') && stderr.includes('404')) continue;
      process.stderr.write(`draftgate: \`gh api ${path}\` failed.\n${stderr}`);
      process.exit(1);
    }
    const rows = {};
    for (const line of out.split('\n')) {
      const [full, visibility] = line.split('\t');
      if (full && visibility) rows[full] = visibility;
    }
    if (Object.keys(rows).length > 0) return rows;
  }
  return {};
}

const repos = fetchRepos(owner);
if (Object.keys(repos).length === 0) {
  process.stderr.write(
    `draftgate: GitHub returned no repositories for "${owner}". Check the spelling, and check ` +
      'that `gh auth status` reports an account that can see them -- a private repository is ' +
      'invisible rather than forbidden.\n'
  );
  process.exit(1);
}

if (print) {
  // What would be written, through the real writer: the measurement's shape (`{"owner/repo":
  // "public"}`) is not the file's (`{"repos": {...}, "sources": {...}}`). Drained before the exit, or
  // a large owner's file arrives cut off.
  await new Promise((resolve) => process.stdout.write(githubReposFileText(repos), resolve));
  process.stderr.write(
    `draftgate: ${Object.keys(repos).length} repositories read; nothing written ` +
      `(would have merged into ${githubReposPath()}).\n`
  );
  process.exit(0);
}

process.stderr.write(`${describeGithubReposWrite(rememberGithubRepos(repos))}\n`);
