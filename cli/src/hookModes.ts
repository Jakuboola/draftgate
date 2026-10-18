/**
 * `draftgate register`, `draftgate doctor` and `draftgate propose-tools`: the hook adapter's
 * `--register`, `--doctor` and `--propose-tools`, run as a subprocess. Running the hook's own code
 * gives `draftgate doctor` (which `/draftgate:setup` calls with `--setup`) the same output and exit
 * code as `--doctor`. A subprocess, not an import: `adapters/` imports `cli/`, never the reverse, and
 * all three read the hook's tool map, review config and registration, which live in the adapter.
 *
 * stdio is inherited, so nothing is buffered or re-encoded here, and a reader that quits early
 * (`draftgate doctor | head`) is the child's to handle. Same interpreter (`process.execPath`), same
 * environment, same working directory, which `--doctor` reads the project's settings from.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject } from './json';

/**
 * The hook adapter's path inside a checkout: `draftgate doctor` runs it, the plugin's files launch
 * it, and the adapter re-exports it as `HOOK_IN_CHECKOUT`, which `register` recognises another
 * checkout's entry by. Here because `cli/` cannot import the adapter.
 */
export const HOOK_IN_REPO = 'adapters/hook/src/main.ts';

/** The CLI's path inside a checkout: what `bin/draftgate` and the hook's fallback name by full path. */
export const CLI_IN_REPO = 'cli/src/main.ts';

/** The two classifiers' paths inside a checkout, which messages name. */
export const JIRA_PROJECTS_IN_REPO = 'tools/jira-projects/generate.mjs';
export const GITHUB_REPOS_IN_REPO = 'tools/github-repos/generate.mjs';
/** The connector-driven half of `tools/jira-projects/`, which needs no Jira credentials. */
export const JIRA_FROM_MCP_IN_REPO = 'tools/jira-projects/from-mcp.mjs';
/** Every classifier a message names by its path, which an install must therefore hold. */
export const CLASSIFIERS_IN_REPO = [JIRA_PROJECTS_IN_REPO, JIRA_FROM_MCP_IN_REPO, GITHUB_REPOS_IN_REPO];

/**
 * The link in draftgate's directory that follows the plugin: the plugin's `SessionStart` hook points
 * it at the root Claude Code runs, and the settings entry for the operator's own tools runs the hook
 * through it. The adapter writes and reads it; `uninstall` names it among draftgate's files.
 */
export const PLUGIN_LINK_BASENAME = 'plugin';

/**
 * Where the adapter's `--propose-tools <names>` keeps its names for the `--write` that records the
 * answer, so setup types them once: an agent types every name it passes. `uninstall` names it among
 * draftgate's files.
 */
export const SETUP_NAMES_BASENAME = 'setup-names.json';

/** The CLI in this checkout: what a `draftgate` link points at, and `package.json`'s `bin`. */
export const CLI_ENTRY = fileURLToPath(new URL(`../../${CLI_IN_REPO}`, import.meta.url));

/** The hook adapter in this checkout or plugin root. */
export const HOOK_ENTRY = fileURLToPath(new URL(`../../${HOOK_IN_REPO}`, import.meta.url));

/**
 * Run one of the hook's print modes under this bun, stdio inherited, and answer with its exit
 * status. `--unregister` is `draftgate uninstall`'s first step. `--propose-tools` takes its
 * arguments after it, and `--doctor` takes `--setup`.
 */
export function runHookMode(
  flag: '--register' | '--unregister' | '--doctor' | '--propose-tools',
  ...args: string[]
): number {
  const run = spawnSync(process.execPath, [HOOK_ENTRY, flag, ...args], { stdio: 'inherit' });
  if (run.error) {
    process.stderr.write(`draftgate: could not run ${HOOK_ENTRY} ${[flag, ...args].join(' ')}: ${run.error.message}\n`);
    return 1;
  }
  // Killed by a signal: no verdict was given, which is never a pass.
  return run.status ?? 1;
}

/**
 * A print mode whose stdout is data for the caller: `--plugin-record`'s JSON. Null when the hook
 * could not be run or did not exit 0; its stderr is inherited, so it says why.
 */
export function hookModeOutput(flag: '--plugin-record'): string | null {
  const run = spawnSync(process.execPath, [HOOK_ENTRY, flag], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  return run.error || run.status !== 0 ? null : run.stdout;
}

/**
 * Is the directory `root` a draftgate checkout, by its `package.json`'s name? For the hook's
 * `probeHook` (whose entries `register` replaces) and `draftgate uninstall` (whose `app/` it may
 * delete). Three answers, because the two read "cannot tell" in opposite directions: `register`
 * counts it as draftgate's, so a moved checkout is replaced rather than joined by a second entry,
 * and `uninstall` keeps it. No `package.json`, or one naming something else or not JSON, is somebody
 * else's project; one that exists and cannot be read (a TCC denial) is `unverifiable`.
 */
export function checkoutKind(root: string): 'draftgate' | 'foreign' | 'unverifiable' {
  let text: string;
  try {
    text = readFileSync(join(root, 'package.json'), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'foreign' : 'unverifiable';
  }
  try {
    const pkg: unknown = JSON.parse(text);
    return isPlainObject(pkg) && pkg.name === 'draftgate' ? 'draftgate' : 'foreign';
  } catch {
    return 'foreign';
  }
}
