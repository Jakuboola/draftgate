/**
 * `draftgate uninstall`: take draftgate off this machine, in steps, each saying how it went
 * (installer.md, "The commands"):
 *
 *  1. the review hook's entries in Claude Code's settings, through the hook's own `--unregister`:
 *     `register`'s planner and write with nothing to add, so the two cannot disagree about which
 *     entries are draftgate's. From the plugin that is the entry setup wrote for the tools the
 *     plugin's own hook cannot match;
 *  2. the plugin: only Claude Code takes one out, so this names what Claude Code has installed and
 *     the command that removes it (`claudePlugin.ts`);
 *  3. from a checkout, a `draftgate` link on PATH that runs this checkout (`unlinkCli`). A plugin's
 *     `draftgate` is on the Bash tool's PATH by Claude Code's doing;
 *  4. draftgate's directory, after asking.
 *
 * Step 1 failing stops it: a hook still registered is draftgate still reviewing, and deleting the
 * checkout it runs from would turn every gated send into a permission prompt about a missing hook.
 *
 * With no terminal (an agent's session) nothing is deleted: the report says what the directory
 * holds, tells the agent to ask, and names `uninstall --delete <the directory>` for a yes. The flag
 * takes the path this run resolved, not a bare `--yes`, which an agent adds by habit; any other path
 * stops the uninstall before anything is done.
 *
 * Never deleted, and each named as left behind: a contributor's checkout, a log `DRAFTGATE_AUDIT_LOG`
 * moved, and `register`'s backups of Claude Code's settings (tokens included). The directory is kept
 * when it holds something draftgate did not write, or is the home directory or above it: a
 * `DRAFTGATE_HOME` set wrong is one `rm -rf` from a person's files. The release check's state is in
 * the directory, so it goes or stays with it.
 */

import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { REMEDY } from '../../core/src/remedies';
import { AUDIT_BASENAME, auditPath, draftgateHome } from './audit';
import {
  PLUGIN_ID, enabledWhere, pluginManifest, recordUnreadable, type PluginHere, type PluginRecord,
} from './claudePlugin';
import { WATERMARK_BASENAME } from './digest';
import { GITHUB_REPOS_BASENAME } from './githubRepos';
import {
  CLI_ENTRY, PLUGIN_LINK_BASENAME, SETUP_NAMES_BASENAME, checkoutKind, hookModeOutput, runHookMode,
} from './hookModes';
import { isThisCli, unlinkCli, type UnlinkResult } from './cliLink';
import { JIRA_PROJECTS_BASENAME } from './jiraProjects';
import { isPlainObject } from './json';
import { canonical, isInside } from './paths';
import { CHECKOUT, RELEASE_STATE_BASENAME } from './releaseCheck';
import { REVIEW_CONFIG_BASENAME } from './reviewConfig';
import { SCRATCH_BASENAME } from './scratchTargets';
import { OK, failed, stepReport } from './steps';
import { writeStdout } from './stdout';
import { shQuote } from './text';
import { THEME_BASENAME } from './themePreference';

/**
 * Every file draftgate writes in its directory, and what it is, in the words the question uses.
 * `tools.json` and `window.json` are literals (their names live in the adapter and in the
 * window's spawn); `cli/test/uninstall.test.ts` holds this list to every file the runtime writes
 * there. A name that starts with one of these is a copy of it (a backup, a write's temp file, a
 * lock) and is draftgate's too.
 */
export const DRAFTGATE_FILES: Readonly<Record<string, string>> = {
  [AUDIT_BASENAME]: 'the review log, which keeps the full text of every message reviewed',
  'tools.json': 'your tool map: which tools draftgate reviews',
  [SETUP_NAMES_BASENAME]: 'the tool names setup kept for its answer',
  [REVIEW_CONFIG_BASENAME]: 'your review settings',
  [JIRA_PROJECTS_BASENAME]: 'which Jira projects are service desks',
  [GITHUB_REPOS_BASENAME]: 'which GitHub repositories are public',
  [SCRATCH_BASENAME]: 'your scratch targets',
  [WATERMARK_BASENAME]: "digest's bookmark",
  [RELEASE_STATE_BASENAME]: "the daily release check's last answer",
  [THEME_BASENAME]: "the review window's theme",
  'window.json': "the review window's size and zoom",
  [PLUGIN_LINK_BASENAME]: 'the link to the plugin version that reviews the tools you added',
};

/**
 * What macOS writes into any directory somebody opens in Finder. Neither draftgate's nor the
 * person's: counted as foreign, one look at the directory would stop every later uninstall from
 * deleting it.
 */
const FINDER_FILE = '.DS_Store';

/**
 * A draftgate checkout inside the directory, the one entry that is not a file of the above:
 * draftgate's only when its `package.json` says so (`checkoutKind`); one that cannot be read is kept.
 */
const APP_DIR = 'app';

/** What `uninstall` reads and runs. Each is the real thing by default, and replaced in tests. */
export interface UninstallContext {
  /** This checkout's CLI, which every command the report names is spelled with. */
  cli: string;
  /** The checkout it is in. */
  root: string;
  /** draftgate's directory, as this environment resolves it. */
  dir: string;
  /** The user's home directory. */
  home: string;
  /** The review log, as this environment resolves it, or null when it is turned off. */
  auditLog: string | null;
  /** `--delete`'s path: the caller says the person was asked, and about this directory. */
  confirmed: string | null;
  /** Ask the person a yes-or-no question, or null when nobody can be asked (no terminal). */
  ask: ((question: string) => Promise<boolean>) | null;
  /** Whether this command runs from a plugin root rather than a checkout. */
  plugin: boolean;
  /** What Claude Code has installed of the draftgate plugin, and whether it is enabled here. */
  plugins: () => PluginRecord;
  /** The hook's `--unregister`: its exit status. */
  unregister: () => number;
  unlink: (ours: (target: string) => boolean) => UnlinkResult;
  remove: (dir: string) => void;
  print: (text: string) => Promise<void>;
}

/**
 * The draftgate installs Claude Code has recorded, each with whether the settings read here switch
 * it on: the hook's `--plugin-record`, the reading `--doctor` reports, so the two cannot disagree.
 * Every install is listed, another project's included: each one reviews in the sessions it applies to.
 */
function pluginsSeen(): PluginRecord {
  const out = hookModeOutput('--plugin-record');
  try {
    const record: unknown = out === null ? null : JSON.parse(out);
    if (isPlainObject(record) && record.kind === 'read' && Array.isArray(record.installs)) {
      return { kind: 'read', installs: record.installs as PluginHere[] };
    }
    if (isPlainObject(record) && record.kind === 'unreadable') return record as PluginRecord;
  } catch {
    // Not JSON: the same as no answer.
  }
  return { kind: 'unreadable', path: 'the hook\'s --plugin-record', why: 'it gave no answer' };
}

export function uninstallContext(confirmed: string | null): UninstallContext {
  return {
    cli: CLI_ENTRY,
    root: CHECKOUT,
    dir: resolve(draftgateHome()),
    home: homedir(),
    auditLog: auditPath(undefined, false),
    confirmed: confirmed === null ? null : resolve(confirmed),
    ask: process.stdin.isTTY ? askOnTerminal : null,
    plugin: pluginManifest(CHECKOUT) !== null,
    plugins: pluginsSeen,
    unregister: () => runHookMode('--unregister'),
    unlink: unlinkCli,
    remove: (dir) => rmSync(dir, { recursive: true }),
    print: writeStdout,
  };
}

/** One line from the terminal: `y` or `yes` is a yes, and anything else, an empty line included, is a no. */
async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
      // A closed stdin (Ctrl-D) is no answer, which is a no.
      rl.once('close', () => resolve(''));
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

/** Run the uninstall. Answers with the exit status: 0 when every step did what it says. */
export async function uninstall(ctx: UninstallContext): Promise<number> {
  // A plugin has no `draftgate` link of its own: Claude Code puts its `bin/` on the PATH.
  const steps = ['review hook', 'draftgate plugin', ...(ctx.plugin ? [] : ['draftgate on PATH']), "draftgate's files"];
  const { verdicts, out, header, detail, child, finish } = stepReport(steps, ctx.print);
  const step = (name: string) => steps.indexOf(name) + 1;
  const command = (c: string) => REMEDY.cli(shQuote(ctx.cli), c);

  await out([`draftgate uninstall: ${ctx.root}`, '']);

  // A `--delete` naming anything but this directory was said about something else: nothing is done.
  if (ctx.confirmed !== null && canonical(ctx.confirmed) !== canonical(ctx.dir)) {
    await out([
      `--delete names ${ctx.confirmed}, but draftgate's directory here is ${ctx.dir}.`,
      'Nothing was done. Ask again about the directory this prints, and pass that path.',
      '',
    ]);
    return 1;
  }

  // --- 1. The review hook's settings entries --------------------------------------------------
  const hookTitle = "Review hook in Claude Code's settings, removed by register's own writer";
  if (!(await child(1, hookTitle, ctx.unregister, 'nothing was written'))) {
    return finish([
      'Nothing else was removed: draftgate is registered as it was, and reviews as before.',
      `Fix what step 1 says, then run ${command('uninstall')} again.`,
    ]);
  }

  // --- 2. The plugin ---------------------------------------------------------------------------
  const plugins = ctx.plugins();
  const plugin = pluginStep(plugins);
  verdicts[step('draftgate plugin') - 1] = { label: plugin.label };
  await out([header(step('draftgate plugin'), 'draftgate plugin'), ...detail(plugin.lines), '']);

  // --- 3. The link, from a checkout ------------------------------------------------------------
  if (!ctx.plugin) {
    const linked = ctx.unlink(isThisCli(ctx.cli));
    verdicts[step('draftgate on PATH') - 1] = linked.failed.length > 0 ? failed('a link could not be removed (above)') : OK;
    await out([header(step('draftgate on PATH'), 'draftgate on PATH'), ...detail(linkLines(linked)), '']);
  }

  // --- Last: draftgate's directory -------------------------------------------------------------
  const last = step("draftgate's files");
  const files = await removeDir(ctx, command);
  // Failed when a yes was given and the directory is still there, whichever refusal kept it (an
  // agent reads the exit status), or when a link into it was left behind. Kept without a yes is the
  // answer, said and not failed.
  const notDone = (files.yes && exists(ctx.dir)) || files.linkFailed;
  verdicts[last - 1] = notDone ? failed(files.label) : files.label === 'ok' ? OK : { label: files.label };
  await out([header(last, `draftgate's files: ${ctx.dir}`), ...detail(files.lines), '']);

  // `isInside` compares places, a deleted one included, so these hold after the last step deleted it.
  const closing = [plugin.closing];
  if (!ctx.plugin && !isInside(ctx.dir, ctx.root)) {
    closing.push(`This checkout, ${ctx.root}, is not inside ${ctx.dir}, so it is still there. It is yours to delete.`);
  }
  if (ctx.auditLog !== null && !isInside(ctx.dir, ctx.auditLog) && exists(ctx.auditLog)) {
    closing.push(
      `The review log is ${ctx.auditLog}, outside ${ctx.dir}, so it was not deleted. It keeps the full ` +
        'text of every message reviewed; delete it when you no longer want it.'
    );
  }
  return finish(closing);
}

/**
 * Step 2: what Claude Code has installed of the plugin, and the closing line that follows from it.
 * Not a failure either way: the plugin is Claude Code's to remove, and this step names how. But
 * "draftgate no longer reviews anything" is said only when Claude Code records no install at all.
 */
function pluginStep(seen: PluginRecord): { label: string; lines: string[]; closing: string } {
  if (seen.kind === 'unreadable') {
    return {
      label: 'unknown: Claude Code\'s record could not be read',
      lines: [
        `${recordUnreadable(seen)}, so whether the draftgate plugin is installed is not known.`,
        `${REMEDY.pluginManager} lists it.`,
      ],
      closing:
        "draftgate's entries are out of Claude Code's settings. If the draftgate plugin is installed " +
        `(step 2 could not tell), it still reviews until it is uninstalled: ${REMEDY.pluginUninstall(PLUGIN_ID)}.`,
    };
  }
  if (seen.installs.length === 0) {
    return {
      label: 'not installed',
      lines: ['Claude Code has no draftgate plugin installed.'],
      closing: "draftgate no longer reviews anything: its hook is out of Claude Code's settings.",
    };
  }
  const ids = [...new Set(seen.installs.map((i) => i.id))];
  const enabledHere = seen.installs.some((i) => i.enabled?.enabled === true);
  return {
    label: `installed: ${REMEDY.pluginUninstall(ids[0]!)} removes it`,
    lines: [
      'Claude Code has the draftgate plugin installed, and while it is enabled its own hook reviews',
      'every send draftgate knows. Only Claude Code takes a plugin out:',
      ...seen.installs.map((i) => `  ${i.id} ${i.version}, ${installWhere(i)}`),
      ...ids.map((id) => `Run ${REMEDY.pluginUninstall(id)} in Claude Code.`),
    ],
    closing: enabledHere
      ? "The draftgate plugin is still installed and enabled here, so draftgate still reviews: run " +
        `${REMEDY.pluginUninstall(ids[0]!)} to stop it (step 2).`
      : "The draftgate plugin is still installed, and reviews wherever it is enabled: run " +
        `${REMEDY.pluginUninstall(ids[0]!)} to remove it (step 2).`,
  };
}

/** An install's scope, and whether the settings here switch it on. */
function installWhere(i: PluginHere): string {
  if (i.enabled === null) return `${i.scope} scope, for another project (${i.projectPath})`;
  return `${i.scope} scope${i.projectPath === undefined ? '' : `, for ${i.projectPath}`}, ${enabledWhere(i.enabled)}`;
}

function linkLines(linked: UnlinkResult): string[] {
  return [
    ...(linked.removed.length === 0 && linked.failed.length === 0 ? ['No `draftgate` link runs this checkout.'] : []),
    ...linked.removed.map((p) => `Removed ${p}.`),
    ...linked.failed.map((f) => `Could not remove ${f.path}: ${f.why}`),
    ...linked.left.map((l) => `Left ${l.path}: it is ${l.is}, which is not this install's.`),
  ];
}

const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * The last step: what the directory holds, whether it may go, the question, and the deletion. Says
 * whether a yes was given and whether a link into it was left, and leaves the verdict to `uninstall`.
 */
async function removeDir(
  ctx: UninstallContext,
  command: (c: string) => string
): Promise<{ label: string; lines: string[]; yes: boolean; linkFailed?: true }> {
  let yes = ctx.confirmed !== null;
  const kept = (label: string, lines: string[]) => ({ label, lines, yes });
  const stat = lstatSync(ctx.dir, { throwIfNoEntry: false });
  if (stat === undefined) return kept('nothing there', ['There is no such directory, so there is nothing to delete.']);
  if (stat.isSymbolicLink()) {
    return kept('kept: a symlink', [
      `${ctx.dir} is a symlink, and deleting it would delete the link and leave everything it points at.`,
      'Nothing was deleted: delete what it points at yourself, if you mean to.',
    ]);
  }
  if (!stat.isDirectory()) return kept('kept: not a directory', [`${ctx.dir} is not a directory. Nothing was deleted.`]);
  if (canonical(ctx.dir) === canonical(ctx.home) || isInside(ctx.dir, ctx.home)) {
    return kept("kept: not draftgate's", [
      `${ctx.dir} is your home directory or above it -- DRAFTGATE_HOME is set to it -- so it is not`,
      "draftgate's to delete. Nothing was deleted.",
    ]);
  }

  const held = contents(ctx);
  if (held.foreign.length > 0) {
    return kept('kept: holds files draftgate did not write', [
      ...held.described,
      `It also holds ${held.foreign.length === 1 ? 'something' : 'things'} draftgate did not write: ` +
        held.foreign.slice(0, 5).join(', ') + (held.foreign.length > 5 ? `, and ${held.foreign.length - 5} more` : '') + '.',
      'So nothing was deleted: move those out first, or delete the directory yourself.',
    ]);
  }

  const question = [
    `Delete ${ctx.dir} and everything in it? It holds:`,
    ...held.described.map((d) => `  ${d}`),
    'This cannot be undone.',
  ];
  if (!yes) {
    if (ctx.ask === null) {
      return kept('kept: nobody could be asked', [
        'Not deleted: nobody could be asked from here (there is no terminal). It is the person\'s data,',
        'so ask them first, showing them this:',
        '',
        ...question.map((l) => `  ${l}`),
        '',
        `If they say yes, run ${command(`uninstall --delete ${shQuote(ctx.dir)}`)}`,
      ]);
    }
    yes = await ctx.ask([...question, 'Delete it? [y/N] '].join('\n'));
    if (!yes) return kept('kept, as you answered', ['Not deleted, as you answered. Everything in it is as it was.']);
  }

  try {
    ctx.remove(ctx.dir);
  } catch (e) {
    return kept('not all of it was deleted', [
      `Deleting it stopped part way: ${(e as Error).message}. What is left is still in ${ctx.dir}.`,
    ]);
  }
  // A link into the directory just deleted runs nothing now: one the link step left because it ran
  // another install, which was in there. `isInside` compares places, so a deleted one still matches.
  const dangling = ctx.unlink((target) => isInside(ctx.dir, target));
  return {
    label: 'ok',
    lines: [
      `Deleted ${ctx.dir}.`,
      ...dangling.removed.map((p) => `Removed ${p}, which pointed into it.`),
      ...dangling.failed.map((f) => `Could not remove ${f.path}, which pointed into it: ${f.why}`),
    ],
    yes,
    ...(dangling.failed.length > 0 ? { linkFailed: true as const } : {}),
  };
}

/** The directory's entries, in the question's words, and the ones that are not draftgate's. */
function contents(ctx: UninstallContext): { described: string[]; foreign: string[] } {
  const described: string[] = [];
  const foreign: string[] = [];
  const copies: string[] = [];
  const known = Object.keys(DRAFTGATE_FILES);
  const root = canonical(ctx.root);
  const log = ctx.auditLog === null ? null : canonical(ctx.auditLog);
  for (const name of readdirSync(ctx.dir).sort()) {
    const path = join(ctx.dir, name);
    if (name === APP_DIR && checkoutKind(path) === 'draftgate') {
      described.push(
        `${APP_DIR}/: the draftgate checkout itself${canonical(path) === root ? ', which this command is running from' : ''}`
      );
    } else if (name === AUDIT_BASENAME || canonical(path) === log) {
      described.push(`${name}: ${DRAFTGATE_FILES[AUDIT_BASENAME]}${reviews(path)}`);
    } else if (DRAFTGATE_FILES[name] !== undefined) {
      described.push(`${name}: ${DRAFTGATE_FILES[name]}`);
    } else if (known.some((k) => name.startsWith(`${k}.`))) {
      copies.push(name);
    } else if (name === FINDER_FILE) {
      described.push(`${name}: Finder's own record of how it showed the folder`);
    } else {
      foreign.push(name);
    }
  }
  if (copies.length > 0) {
    described.push(`${copies.length} cop${copies.length === 1 ? 'y' : 'ies'} of those (backups, temporary files): ${copies.join(', ')}`);
  }
  if (described.length === 0) described.push('nothing: it is empty');
  return { described, foreign };
}

/** `(N reviews)`, counted by line, or nothing when it cannot be read. */
function reviews(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    const n = text.split('\n').filter((l) => l.trim() !== '').length;
    return ` (${n} review${n === 1 ? '' : 's'})`;
  } catch {
    return '';
  }
}
