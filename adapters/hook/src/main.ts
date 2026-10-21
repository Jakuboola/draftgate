#!/usr/bin/env bun
/**
 * The Claude Code `PreToolUse` hook adapter.
 *
 * Reads the hook payload on stdin, routes the outbound tools `toolMap.ts` names through
 * `draftgate review`, and writes a permission decision on stdout.
 *
 * The CLI runs as a subprocess: the review, its timeout, the window's lifecycle and SIGKILL, and the
 * audit log are process-scoped, and a stubbed `process.stdout.write` cannot show a 128 KB pipe
 * truncation. Its outcome, approval or denial, comes back in a `--decision` file
 * (`cli/src/decisionFile.ts`) and its stdout is not piped, so it cannot reach ours, which carries the
 * decision JSON through `writeStdout` (`cli/src/stdout.ts`).
 *
 * No timer here: the CLI owns the review deadline and `cli/src/surfaces/window.ts` the kill, and a
 * third timer would strand a window whose cleanup never ran. Claude Code's own per-hook timeout is
 * fail-open (`hookTimeoutSecondsFor`), so draftgate's must fire first.
 */

import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DestinationName } from '../../../core/src/index';
import {
  PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, applyRetention, auditPath, draftgateHome, ensurePrivateDir, writePrivateFile,
} from '../../../cli/src/audit';
// The liveness rule, shared with the WebKit host's harness gate.
import { nonceIsLive } from '../../../cli/src/harnessNonce';
import { isPlainObject } from '../../../cli/src/json';
import { gitDirs } from '../../../cli/src/gitDirs';
import { CLI_ENTRY, HOOK_IN_REPO, PLUGIN_LINK_BASENAME, checkoutKind } from '../../../cli/src/hookModes';
import { classificationStates } from '../../../cli/src/classificationStores';
import { scratchDir } from '../../../cli/src/scratch';
import { parseDecisionFile } from '../../../cli/src/decisionFile';
import { lastLines, oneLine } from '../../../cli/src/text';
import { REMEDY } from '../../../core/src/remedies';
import { readerHungUp, writeStdout } from '../../../cli/src/stdout';
import { clampReason, decide, unreadable, type CliResult, type HookReviewRequest } from './decide';
import { doctorReport, registrationNote, type AtLink, type OtherInstall, type PluginFacts } from './doctor';
import { pluginsHere, readInstalledPlugins, type PluginRecord } from '../../../cli/src/claudePlugin';
import { renderHookOutput, type HookDecision } from './hookOutput';
import { SESSION_VAR, forgetSetupNames, keepSetupNames, keptSetupNames } from './setupNames';
import {
  answeredToolsJson, declinedAfter, describeReconciliation, knownHalves, reconcileTools, type Reconciliation,
} from './reconcile';
import {
  inspectRegistration,
  classifyEntry,
  parseSettings,
  settingsPaths,
  settingsObject,
  settingsSources,
  userSettingsPath,
  type Checkout,
  type HookProbe,
  type RegistrationReport,
  type SettingsRead,
} from './registration';
import {
  hooksReport,
  isDropIn,
  policySources,
  type HooksReport,
  type ScopedSettings,
  type SettingsScope,
} from './hookSwitches';
import { loadReviewConfig } from '../../../cli/src/reviewConfig';
import {
  CHECKOUT,
  currentReleaseNotice,
  currentReleaseStatus,
  startReleaseCheck,
} from '../../../cli/src/releaseCheck';
import { routeFlagArgs, type RouteFacts } from '../../../cli/src/routeFacts';
import { GRACE_MS, PLUGIN_REVIEW_CEILING_MS, deadlineNote, reviewDeadline } from './reviewTimeout';
import { checkoutRootOf, readCommand } from './hookCommand';
import {
  PLUGIN_HOOKS_IN_ROOT, extraToolsBlock, pluginHooksFile, pluginLauncher, pluginMatcher, pluginRootOf,
  uncoveredByPlugin,
} from './pluginHooks';
import type { HookBlock, Registered } from './register';
import {
  CONFIG_BASENAME,
  DEFAULT_TOOL_MAP,
  matcherFor,
  mergeToolConfig,
  restates,
  shadowLine,
  ToolMapError,
  type ToolConfig,
  type ToolMap,
} from './toolMap';

/** This file, from `import.meta.url`: a registration is this hook's when its command launches this
 *  very file (`registration.ts`). */
const HOOK = fileURLToPath(import.meta.url);

/** Load the tool map, applying `~/.draftgate/tools.json` over the defaults if it exists. */
export function loadToolMap(env: NodeJS.ProcessEnv = process.env): ToolMap {
  return loadToolConfig(env).map;
}

/** The map and the operator's recorded declines, from the same one read. */
export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): ToolConfig {
  const path = join(draftgateHome(env), CONFIG_BASENAME);
  if (!existsSync(path)) return mergeToolConfig(DEFAULT_TOOL_MAP, {}, path);
  return toolConfigFrom(readFileSync(path, 'utf8'), path);
}

/**
 * The operator's `tools.json` as it is, under `draftgateHome`, or `{}` when there is none (a broken
 * file never gets here: `loadToolConfig` refused it first).
 */
function existingToolsJson(toolsPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(toolsPath, 'utf8'));
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // Absent.
  }
  return {};
}

/** A `tools.json`'s text as reviews load it, or the `ToolMapError` that refuses it. */
function toolConfigFrom(text: string, path: string): ToolConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ToolMapError(`${path}: not valid JSON (${(e as Error).message}).`);
  }
  return mergeToolConfig(DEFAULT_TOOL_MAP, parsed, path);
}

/**
 * Which `--surface` the CLI is told to use: `webkit`, draftgate's review window.
 *
 * The end-to-end test needs a surface that answers without a human, but `auto-approve` approves, and
 * a `DRAFTGATE_HOOK_SURFACE=auto-approve` left in a shell profile would self-approve every send. So
 * the override counts only with a live harness nonce (`nonceIsLive`, `cli/src/harnessNonce.ts`).
 * That defends against leftover configuration, not against someone who can write this environment.
 */
export function surfaceKind(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.DRAFTGATE_HOOK_SURFACE;
  if (!requested) return 'webkit';

  const verdict = nonceIsLive(
    env.DRAFTGATE_HOOK_SURFACE_NONCE,
    env.DRAFTGATE_HOOK_SURFACE_NONCE_FILE
  );
  if (verdict.live) return requested;

  process.stderr.write(
    `draftgate-hook: DRAFTGATE_HOOK_SURFACE=${requested} is set but no live nonce matches it ` +
      `(${verdict.why}); ignoring it and opening the real review window.\n`
  );
  return 'webkit';
}

/**
 * The CLI invocation, as data, so the flags can be asserted without a subprocess. `--timeout` above
 * all: a wiring mistake there falls back silently to the CLI's default, the number the clamp
 * exists to override.
 */
export function cliArgs(opts: RouteFacts & {
  deadlineMs: number;
  destination: DestinationName;
  toolName: string;
  inPath: string;
  decisionPath: string;
  surface: string;
  sessionId?: string;
  inferredFrom?: string;
}): string[] {
  return [
    CLI_ENTRY,
    'review',
    '--dest', opts.destination,
    '--tool', opts.toolName,
    '--in', opts.inPath,
    // The whole outcome, approval and denial alike (`decisionFile.ts`).
    '--decision', opts.decisionPath,
    '--surface', opts.surface,
    // Always stated: the CLI cannot know what the registration outlives (`reviewTimeout.ts`).
    '--timeout', String(opts.deadlineMs / 1000),
    // Groups a retried draft with its first try (`AuditRecord.session`). No flag when absent: the
    // parser rejects `--session ""`.
    ...(opts.sessionId ? ['--session', opts.sessionId] : []),
    // What an inferred route matched, so the reviewer can check the guess.
    ...(opts.inferredFrom ? ['--route-inferred-from', opts.inferredFrom] : []),
    // Through `ROUTE_FLAGS`, the table `cli/src/args.ts` parses them back with. Which facts travel
    // is `decide.ts`'s `claimedRouteFacts`.
    ...routeFlagArgs(opts),
  ];
}

/**
 * Run one review. The payload goes in and comes out through files, not pipes: an asynchronous pipe
 * can silently truncate a 300 KB payload at 131072 bytes.
 */
async function runCli(deadlineMs: number, req: HookReviewRequest): Promise<CliResult> {
  // `scratchDir`: both files hold the draft, and the `finally` does not run when an aborted hook
  // dies by signal. SIGKILL stays uncoverable (see that module).
  const scratch = scratchDir('draftgate-hook-');
  const inPath = join(scratch.dir, 'payload.json');
  const decisionPath = join(scratch.dir, 'decision.json');
  try {
    writeFileSync(inPath, JSON.stringify(req.toolInput));

    const { code, stderr } = await spawnCli(
      cliArgs({ ...req, deadlineMs, inPath, decisionPath, surface: surfaceKind() })
    );

    return cliResultFrom(code, stderr, readIfPresent(decisionPath));
  } finally {
    scratch.release();
  }
}

/**
 * Turn what the CLI left behind into a `CliResult`. Pure, and blind to the tool input, so it cannot
 * answer a broken install (an import failure, an unwritable `--decision` path, an OOM kill) with the
 * agent's original bytes.
 *
 *  - a readable approval with a payload -> the approval;
 *  - anything unreadable, absent or unparseable -> a `failure`, which `decide` turns into `ask`;
 *  - a readable denial -> the denial with its code, for `decide`'s policy.
 *
 * `adapters/hook/test/hook.test.ts` pins each.
 */
export function cliResultFrom(
  code: number,
  stderr: string,
  decisionText: string | null
): CliResult {
  const decision = decisionText === null ? null : parseDecisionFile(decisionText);
  if (decision === null) {
    // No decision file, or one this build cannot read: nobody's decision.
    return {
      exitCode: code,
      failure: lastLines(stderr) || `the CLI exited ${code} without writing a decision`,
    };
  }

  // The facts the file states beside the decision itself, carried as stated.
  const { surface, human, edited, sentBody, sentLines } = decision;
  const facts = { surface, human, edited, sentBody, sentLines };
  if (decision.outcome === 'approved') {
    return decision.updatedInput
      ? { exitCode: 0, updatedInput: decision.updatedInput, ...facts }
      : { exitCode: 0, failure: 'the CLI approved but recorded no payload' };
  }
  return { exitCode: code, denial: decision.denial, ...facts };
}

function spawnCli(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun) => {
    // `process.execPath`, not "bun": a hook's PATH may omit ~/.bun/bin, and the interpreter running
    // this file is present.
    const child = spawn(process.execPath, args, {
      // stdout ignored: `--decision` carries the outcome, and ours carries only the decision.
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    // Bounded: only the tail is needed.
    child.stderr!.on('data', (c: string) => { stderr = (stderr + c).slice(-16000); });
    child.on('error', (e) => resolveRun({ code: -1, stderr: `${stderr}\n${e.message}` }));
    // `close`, not `exit`: stderr is the crash text, truncated if read before it drains.
    child.on('close', (code) => resolveRun({ code: code ?? -1, stderr }));
  });
}

function readIfPresent(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** The `timeout` the plugin's `hooks/hooks.json` carries, derived from the ceiling. */
export const PLUGIN_HOOK_TIMEOUT_S = hookTimeoutSecondsFor(PLUGIN_REVIEW_CEILING_MS);

/**
 * The `timeout` to register, in seconds, for a review deadline: the inverse of `reviewDeadline`'s
 * clamp, so `registration.ts` reads the same deadline back. `GRACE_MS` is the one home of the margin.
 *
 * Claude Code's per-hook timeout is fail-open. Read out of the Claude Code 2.1.260 binary:
 *
 *   if(ts.aborted){ … yield{ message:cn({type:"hook_cancelled", …, timedOut:!f?.aborted,
 *                              timeoutMs:Rs}), outcome:"cancelled", hook:wn }; return }
 *
 * An aborted hook yields `outcome: "cancelled"` and no permission behaviour. The consumer then does:
 *
 *   if(e?.behavior!=="allow"&&e?.behavior!=="ask") return { decision: await d(n,r,o,f,_), input:r }
 *
 * -- the normal permission pipeline with the ORIGINAL input `r`, so under `bypassPermissions`, an
 * auto-accept mode or an allow rule the agent's markdown goes out unread. The renderer is
 *
 *   case"hook_cancelled":{ if(w.hookEvent!=="UserPromptSubmit"||!w.timedOut){ return null } … }
 *
 * so a timed-out PreToolUse hook draws nothing. draftgate's timeout must fire first: the window is
 * SIGKILLed and the CLI returns a `timeout` denial. The event default is 600000ms
 * (`DEFAULT_TIMEOUT=600000`, same binary, also in 2.1.268), so every registration carries a
 * `timeout`. A written value goes stale, so it is also read back (`reviewTimeout.ts`): the review
 * gets `min(configured, registered - grace)`.
 */
export function hookTimeoutSecondsFor(reviewMs: number): number {
  return Math.ceil(reviewMs / 1000) + GRACE_MS / 1000;
}

/** The argv forms that print something rather than answering a hook event. */
const isPrintModeFlags = [
  '--register',
  '--unregister',
  '--doctor',
  '--propose-tools',
  '--plugin-record',
  '--print-plugin-hooks',
  '--print-plugin-launcher',
] as const;

function isPrintMode(argv: string[]): boolean {
  return isPrintModeFlags.some((flag) => argv.includes(flag));
}

/**
 * Read the registration back: which settings files carry this hook, and what they allow. The
 * filesystem half of the pure `registration.ts`; an unreadable file is a finding, never a throw.
 * `cwd` is the hook payload's, the calling session's project, not this process's.
 */
export function inspectHere(
  tools: Pick<ToolConfig, 'map' | 'declined'>,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  root: string | null = pluginRootOf(env, HOOK, realpathOrNull)
): RegistrationReport {
  return inspectRegistration({
    toolMap: tools.map,
    declined: tools.declined,
    read: readSettingsFile,
    realpath: realpathOrNull,
    checkoutOf,
    paths: settingsPaths(env, cwd, homedir, process.platform),
    hookPath: HOOK,
    // The plugin's own `hooks/hooks.json`, when this hook runs from a plugin root.
    ...(root !== null && { pluginHooksPath: join(root, PLUGIN_HOOKS_IN_ROOT) }),
  });
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * `classifyEntry`'s question about a path that ends like this hook: is it in a draftgate
 * checkout? Read off the checkout's `package.json`, which every draftgate checkout has.
 *
 * A file that is not there, or an unreadable `package.json` (a TCC denial), is `unverifiable`, not
 * `foreign`: a moved checkout read as foreign would get a second entry beside it.
 */
export function probeHook(hookPath: string): HookProbe {
  const root = checkoutRootOf(hookPath);
  if (root === null || !existsSync(hookPath)) return 'unverifiable';
  return checkoutKind(root);
}

/**
 * Is this registered command a draftgate entry, and whose? `classifyEntry` against this hook and the
 * real filesystem, for `register`, `uninstall` and `--doctor` alike.
 */
const classifyHere = (command: string) =>
  classifyEntry(command, { hookPath: HOOK, realpath: realpathOrNull, probe: probeHook });

/**
 * What `--register` and `--unregister` each say in the sentences only they need: the command a
 * refusal names, and what a draftgate entry left in a file this does not edit would cost.
 */
const WRITERS = {
  register: {
    command: 'draftgate register',
    elsewhere: 'Two registrations both fire, so every send would open two review windows, and a ' +
      'denial in either one wins.',
    unreadable: 'an entry written here would be a second one, and every send would open two review windows.',
  },
  unregister: {
    command: 'draftgate uninstall',
    elsewhere: 'Removing the entry here would leave that one reviewing.',
    unreadable: 'it would go on reviewing after this.',
  },
} as const;

/** The backups `register` and `unregister` have made of `target`, beside it, oldest first. */
function backupsOf(target: string, infix: string): string[] {
  const prefix = `${basename(target)}${infix}`;
  try {
    return readdirSync(dirname(target))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(dirname(target), name));
  } catch {
    return [];
  }
}

/**
 * `--register` (`registered`) and `--unregister` (`null`): put the registered block, or nothing,
 * in the user's Claude Code settings in place of every draftgate entry there, as `register.ts`
 * plans it, and say what changed. The block is null too from a plugin whose own hook covers every
 * tool. Exit 0 when the file holds what was asked for, changed or not; 1 when nothing was written.
 */
async function rewriteUserSettings(registered: Registered | null): Promise<number> {
  // Loaded lazily: every gated tool call starts this file.
  const register = await import('./register');
  const block = registered?.block ?? null;
  const words = WRITERS[registered === null ? 'unregister' : 'register'];
  const target = userSettingsPath(process.env, homedir);
  const fail = (why: string) => {
    process.stderr.write(`${words.command}: ${why}\n`);
    return 1;
  };

  const read = readSettingsFile(target);
  if (read.kind === 'unreadable') {
    return fail(`${target} could not be read (${read.why}), so nothing was written to it.`);
  }
  const text = textOf(read);
  // A symlink to nothing reads as absent, and renaming over it would cut the link the user made.
  if (text === null && lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return fail(
      `${target} is a symlink to ${readlinkSync(target)}, which does not exist. Create that file or ` +
        'remove the link, then run this again. Nothing was written.'
    );
  }

  /*
   * A draftgate entry in any other file Claude Code reads hooks from is one this cannot remove:
   * registering beside it fires twice, uninstalling leaves it reviewing. So it refuses, naming the
   * file. A hook that only names draftgate's (`mentions`) is refused too.
   */
  const real = realpathOrNull(target) ?? target;
  const elsewhere: string[] = [];
  const unreadable: string[] = [];
  for (const path of settingsPaths(process.env, process.cwd(), homedir, process.platform)) {
    // The project files are the user file when this runs in the home directory.
    if (path === target || (realpathOrNull(path) ?? path) === real) continue;
    const other = readSettingsFile(path);
    if (other.kind === 'unreadable') unreadable.push(`${path} (${other.why})`);
    else if (
      other.kind === 'text' &&
      parseSettings(other.text, path).hooks.some((h) => classifyHere(h.command).kind !== 'other')
    ) {
      elsewhere.push(path);
    }
  }
  if (elsewhere.length > 0) {
    return fail(
      `draftgate is also registered in ${elsewhere.join(' and ')} (a hook there runs or names ` +
        `draftgate's), which this command does not edit. ${words.elsewhere}` +
        ` Remove it from there, then run this again. Nothing was written to ${target}.`
    );
  }
  // Refused, not warned about: setup and `uninstall` read exit 0 as done, and Claude Code may read
  // a file this process cannot.
  if (unreadable.length > 0) {
    return fail(
      `could not read ${unreadable.join(' or ')}. If it registers draftgate too, ${words.unreadable}` +
        ` Nothing was written to ${target}. Make it readable, or run this from another directory if ` +
        "it is a project's settings file."
    );
  }

  const planned = register.planRegistration(text, block, classifyHere, target);
  if (planned.kind === 'refused') return fail(planned.why);
  const said = (backup: string | null) =>
    registered === null
      ? register.unregisterReport(planned, {
          target, backup, backups: backupsOf(target, register.BACKUP_INFIX),
          moved: register.movedElsewhere(text, process.env),
        })
      : register.registerReport(planned, { target, backup, registered });
  if (planned.kind === 'unchanged') {
    await printStdout(said(null));
    return 0;
  }

  /*
   * Written beside the real file and renamed over it, so Claude Code (which hot-reloads it) never
   * reads half of it and a dotfiles symlink stays one. The file keeps its mode; a new one and the
   * backup are private (users keep tokens here). The backup goes beside the path as named.
   */
  const dest = text === null ? target : real;
  const tmp = join(dirname(dest), `.${basename(dest)}.draftgate-${process.pid}-${Date.now()}.tmp`);
  let backup: string | null = null;
  try {
    mkdirSync(dirname(dest), { recursive: true, mode: PRIVATE_DIR_MODE });
    const fileMode = text === null ? PRIVATE_FILE_MODE : statSync(dest).mode & 0o7777;
    writeFileSync(tmp, planned.text, { mode: fileMode, flag: 'wx' });
    chmodSync(tmp, fileMode);
    // Claude Code writes this file too. One that changed since it was read is not overwritten.
    const now = readSettingsFile(target);
    if (now.kind === 'unreadable') {
      return fail(`${target} could not be read again (${now.why}), so nothing was written to it.`);
    }
    if (textOf(now) !== text) {
      return fail(`${target} changed while this ran, so nothing was written to it. Run it again.`);
    }
    if (text !== null) {
      backup = `${target}${register.BACKUP_INFIX}${new Date().toISOString().replaceAll(':', '-')}`;
      writeFileSync(backup, text, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    }
    renameSync(tmp, dest);
  } catch (e) {
    return fail(`could not write ${target} (${(e as Error).message}). It was not changed.`);
  } finally {
    rmSync(tmp, { force: true });
  }
  await printStdout(said(backup));
  return 0;
}

/**
 * `--register` and `--unregister`, with the plugin link the entry runs through: pointed at the
 * plugin root before the entry is written, so no entry names a link that is not there yet, and
 * again when the entry is unchanged, which is how setup mends a removed link; put back as it was
 * when nothing was written; taken out once the file holds no entry that runs through it.
 */
async function registerWithLink(registered: Registered | null): Promise<number> {
  if (registered?.block) {
    const { link, root } = registered;
    const pointed = pointPluginLink(link, root);
    if ('error' in pointed) {
      process.stderr.write(`draftgate register: could not point ${link} at ${root} (${pointed.error}), so nothing was written.\n`);
      return 1;
    }
    const code = await rewriteUserSettings(registered);
    if (pointed.before === root) return code;
    if (code !== 0) {
      if (pointed.before === null) removePluginLink(link);
      else pointPluginLink(link, pointed.before);
      return code;
    }
    await printStdout(`Pointed ${link} at ${root}, which the entry runs the plugin through.\n`);
    return code;
  }
  const code = await rewriteUserSettings(registered);
  if (code === 0) {
    const removed = removePluginLink(pluginLinkHere());
    if (removed) await printStdout(removed);
  }
  return code;
}

/**
 * The draftgate entries in the files `--doctor` reads that launch another install's hook, as
 * `classifyEntry` recognises them, so the report can say which install runs. `ours`, the clamp and
 * every review ignore them. Every entry counts, two in one file included, since both fire.
 */
function otherInstalls(report: RegistrationReport): OtherInstall[] {
  return report.others.flatMap(({ source, command }) => {
    const entry = classifyHere(command);
    if (entry.kind !== 'draftgate') return [];
    const { failClosed, pluginRoot } = readCommand(command);
    return [{ source, hook: entry.hook, present: existsSync(entry.hook), failClosed, ...(pluginRoot !== undefined && { pluginRoot }) }];
  });
}

/**
 * The plugin, for `--doctor`: Claude Code's record of it, read against the settings documents the
 * hook switches are read from, and which install's folder is the root this hook runs from.
 */
function pluginFacts(root: string | null, read: SettingsDocs, env: NodeJS.ProcessEnv = process.env): PluginFacts {
  const facts = { root, record: pluginRecord(root, read, env), userSettings: userSettingsPath(env, homedir) };
  if (root === null) return facts;
  const path = pluginLinkHere(env);
  return { ...facts, link: { path, at: linkAt(path) } };
}

/**
 * Claude Code's record of the draftgate plugin, each install with whether it is enabled here and
 * whether its folder is `root`, read against the settings documents the hook switches come from.
 * `--doctor` reports it; `draftgate uninstall` gets it from `--plugin-record`.
 */
function pluginRecord(root: string | null, read: SettingsDocs, env: NodeJS.ProcessEnv): PluginRecord {
  const installed = readInstalledPlugins(env, homedir);
  if (installed.kind === 'unreadable') return installed;
  const installs = installed.kind === 'read' ? installed.installs : [];
  return { kind: 'read', installs: pluginsHere(installs, read.docs, env.CLAUDE_PROJECT_DIR || process.cwd(), root) };
}

/** A read's text, or null for a file that is not there. */
function textOf(read: SettingsRead): string | null {
  return read.kind === 'text' ? read.text : null;
}

/**
 * What a failed filesystem call means for a file that might hold a switch or a registration: ENOENT
 * is absent; anything else (EACCES, EPERM, EISDIR, a TCC denial on `~/.claude`) is unreadable, never
 * absent.
 */
function fsFailure(e: unknown): { kind: 'absent' } | { kind: 'unreadable'; why: string } {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
  return { kind: 'unreadable', why: code ?? (e as Error).message };
}

/** One settings file. Never throws: what went wrong is the `SettingsRead`. */
function readSettingsFile(path: string): SettingsRead {
  try {
    return { kind: 'text', text: readFileSync(path, 'utf8') };
  } catch (e) {
    return fsFailure(e);
  }
}

/**
 * One settings file as the object it has to be, or as the row the registration's scan would give
 * it -- so `--doctor` prints both kinds of file through one loop.
 */
function loadSettings(
  path: string
): { settings: Record<string, unknown> } | { row: RegistrationReport['scanned'][number] } {
  const read = readSettingsFile(path);
  if (read.kind === 'absent') return { row: { path, present: false } };
  if (read.kind === 'unreadable') {
    return { row: { path, present: true, problem: `${path} could not be read (${read.why})` } };
  }
  const object = settingsObject(read.text, path);
  return 'problem' in object ? { row: { path, present: true, problem: object.problem } } : object;
}

/**
 * Claude Code's settings documents: the filesystem half of `hookSwitches.ts`, and where `--doctor`
 * reads `enabledPlugins`. The files `inspectHere` reads (`settingsSources`) plus the managed tiers
 * (`policySources`); a registration file that cannot be parsed is skipped, as the registration's
 * scan reports it. Not on the review path: a running review proves hooks are on.
 */
export function settingsDocsHere(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): SettingsDocs {
  const sources = settingsSources(env, cwd, homedir, process.platform);
  const docs: ScopedSettings[] = [];
  const read = new Set<string>();
  for (const { path, scope } of sources) {
    // Each file once, also through a symlink: one file holds one value for a switch.
    const real = realpathOrNull(path) ?? path;
    if (read.has(real)) continue;
    read.add(real);
    const loaded = loadSettings(path);
    if ('settings' in loaded) docs.push({ path, scope, settings: loaded.settings });
  }

  const policy = policySources(sources, process.platform, userName());
  const policyFiles: HooksReport['policyFiles'] = [];
  const readPolicy = (path: string): void => {
    const loaded = loadSettings(path);
    if ('row' in loaded) {
      policyFiles.push(loaded.row);
    } else {
      policyFiles.push({ path, present: true });
      docs.push({ path, scope: 'managed', settings: loaded.settings });
    }
  };
  if (policy.remote !== undefined) readPolicy(policy.remote);
  if (policy.dropInDir !== undefined) {
    // The binary's rule for this folder: files and symlinks named `*.json`, not starting with `.`,
    // in sorted order. A folder that is not there is the ordinary case.
    try {
      const names = readdirSync(policy.dropInDir, { withFileTypes: true })
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && isDropIn(e.name))
        .map((e) => e.name)
        .sort();
      for (const name of names) readPolicy(join(policy.dropInDir, name));
    } catch (e) {
      const failed = fsFailure(e);
      policyFiles.push(
        failed.kind === 'absent'
          ? { path: policy.dropInDir, present: false }
          : { path: policy.dropInDir, present: true, problem: `${policy.dropInDir} could not be read (${failed.why})` }
      );
    }
  }
  // A profile is looked for, never read. `stat`, not `existsSync`, which says false for a folder
  // this process may not look into: that has to be reported too.
  const unread = policy.profiles.filter((path) => {
    try {
      statSync(path);
      return true;
    } catch (e) {
      return fsFailure(e).kind !== 'absent';
    }
  });
  return { sources, docs, policyFiles, unread };
}

/** Every settings document `hooksHere` reads, and what it could not read: one reading for both. */
export interface SettingsDocs {
  sources: { path: string; scope: SettingsScope }[];
  docs: ScopedSettings[];
  policyFiles: HooksReport['policyFiles'];
  unread: string[];
}

/**
 * Will Claude Code run this hook at all? The verdict, from `settingsDocsHere`'s reading.
 * `registered` is where the hook's own entries are; a path that is no settings file is the
 * plugin's `hooks/hooks.json`, and `pluginForced` says whether managed settings force the plugin
 * on, which exempts its hook from `allowManagedHooksOnly`.
 */
export function hooksHere(registered: readonly string[], read: SettingsDocs, pluginForced = false): HooksReport {
  const { sources, docs, policyFiles, unread } = read;
  const scopeOf = new Map(sources.map((s) => [s.path, s.scope] as const));
  const project = sources.find((s) => s.scope === 'project');
  return hooksReport(
    docs,
    registered.map((path) => scopeOf.get(path) ?? (pluginForced ? 'forced-plugin' : 'plugin')),
    {
      policyFiles,
      unread,
      ...(project !== undefined && { projectDir: dirname(dirname(project.path)) }),
    }
  );
}

/** The login name, for the per-user MDM profile; empty when the OS will not say. */
function userName(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/**
 * Which git checkout `file` sits in, read off git's own files: no `git` subprocess on the review
 * path. Walks up to the first `.git` (`gitDirs` resolves a worktree's). Anything unreadable, or no
 * `.git` (an npm install), is null: no sibling can be recognised.
 */
export function checkoutOf(file: string): Checkout | null {
  try {
    const real = realpathSync(file);
    for (let dir = dirname(real); ; dir = dirname(dir)) {
      if (statSync(join(dir, '.git'), { throwIfNoEntry: false }) === undefined) {
        if (dirname(dir) === dir) return null;
        continue;
      }
      const dirs = gitDirs(dir);
      return dirs === null
        ? null
        : {
            root: dir,
            commonDir: realpathSync(dirs.commonDir),
            relative: relative(dir, real),
            worktree: dirs.worktree,
          };
    }
  } catch {
    return null;
  }
}

/**
 * `cwd` out of the hook payload. A second parse (`decide` and the CLI parse it too), kept so the
 * "unparseable stdin -> ask" policy stays in `decide`. Measured: 3.7 us on a typical payload and
 * 26 us on a 300 KB one, against a 22 ms process start and a 41 ms spawn.
 */
function cwdFrom(stdin: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const cwd = (parsed as Record<string, unknown>).cwd;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    }
  } catch {
    // `decide` asks; here no project settings are named.
  }
  return undefined;
}

/**
 * Put the registration's own findings in front of the person, ahead of the decision's message:
 * Claude Code trims `systemMessage` from the end (`decide.ts`'s caps), and a gate that is not gating
 * outranks the review's own words. On an `ask` the person reads the reason instead
 * (`hookOutput.ts`), so there the notes go under its headline.
 */
export function withNotes(
  decision: HookDecision,
  notes: (string | null | undefined)[],
  /** Notes ranked below the decision's message, so the trim takes them first: the release notice. */
  trailing: (string | null | undefined)[] = []
): HookDecision {
  // One filter for `null` and `''`: a stray `null` would render as "null".
  const present = (n: string | null | undefined): n is string => !!n;
  const lead = notes.filter(present);
  const tail = trailing.filter(present);
  // No decision is empty stdout; a note would give it output. `--doctor` says it instead.
  if (lead.length + tail.length === 0 || decision.permissionDecision === 'none') return decision;
  if (decision.permissionDecision === 'ask') {
    const [headline, ...detail] = decision.reason.split('\n');
    return { ...decision, reason: clampReason([headline, ...lead, ...detail, ...tail].join('\n')) };
  }
  const rest = decision.systemMessage ? [decision.systemMessage] : [];
  return { ...decision, systemMessage: [...lead, ...rest, ...tail].join('\n') };
}

/**
 * A print mode's write: `--doctor | head` quitting early is an ordinary ending. Print modes only:
 * on a review an EPIPE is a decision that reached nobody, a failure.
 */
async function printStdout(text: string): Promise<void> {
  await writeStdout(text).catch((e) => {
    if (!readerHungUp(e)) throw e;
  });
}

/**
 * Write a review's one decision, crash path included, as the last thing its path does, and answer
 * with the exit status.
 *
 * A failed write exits 1 and writes nothing more. Under the fail-closed registration stdout is a
 * temp file (`hookCommand.ts`) where a write can stop halfway (EFBIG, ENOSPC); an `ask` appended to
 * that half with exit 0 would be replayed whole, read as no decision, and the tool would run. On
 * exit 1 the wrapper drops the half and answers `ask`.
 */
async function answer(decision: HookDecision): Promise<number> {
  return writeStdout(renderHookOutput(decision)).then(
    () => 0,
    (e) => {
      process.stderr.write(`draftgate-hook: the decision could not be written: ${(e as Error)?.message ?? e}\n`);
      return 1;
    }
  );
}

/**
 * What `--register` writes from the plugin: only the tools its own matcher cannot match
 * (`extraToolsBlock`). Null from a checkout, which registers nothing. Also the matchers `--doctor`
 * expects and the tools `--write` offers.
 */
function registrationHere(
  toolMap: ToolMap,
  root: string | null = pluginRootOf(process.env, HOOK, realpathOrNull)
): Registered | null {
  if (root === null) return null;
  const link = pluginLinkHere();
  return {
    block: extraToolsBlock(toolMap, link, PLUGIN_HOOK_TIMEOUT_S),
    tools: Object.keys(uncoveredByPlugin(toolMap)),
    link,
    // Resolved, so the link never points at itself when this runs through it.
    root: realpathOrNull(root) ?? root,
  };
}

/**
 * draftgate's plugin link (`PLUGIN_LINK_BASENAME`), where this environment's `draftgateHome` puts
 * it. Absolute: the entry names it, and a hook runs in whatever directory Claude Code starts it in.
 */
function pluginLinkHere(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(draftgateHome(env), PLUGIN_LINK_BASENAME);
}

/** What is at the plugin link's path (`AtLink`). */
function linkAt(path: string): AtLink {
  try {
    return { kind: 'link', target: readlinkSync(path) };
  } catch (e) {
    // EINVAL: there, and not a link. Anything else (ENOENT above all): nothing to run through.
    return (e as NodeJS.ErrnoException).code === 'EINVAL' ? { kind: 'notLink' } : { kind: 'none' };
  }
}

/**
 * Point the plugin link at `root`, as the plugin's `SessionStart` hook does: a new link beside it,
 * renamed over it, so a review starting meanwhile finds the old root or the new one, never neither.
 * Something there that is not a link is not draftgate's to replace. Says where it pointed before
 * (null: there was no link), so a caller can put it back.
 */
function pointPluginLink(link: string, root: string): { before: string | null } | { error: string } {
  const now = linkAt(link);
  if (now.kind === 'notLink') return { error: `${link} is there and is not a link` };
  const before = now.kind === 'link' ? now.target : null;
  if (before === root) return { before };
  const tmp = `${link}.${process.pid}`;
  try {
    ensurePrivateDir(dirname(link));
    rmSync(tmp, { force: true });
    symlinkSync(root, tmp);
    renameSync(tmp, link);
    return { before };
  } catch (e) {
    rmSync(tmp, { force: true });
    return { error: (e as Error).message };
  }
}

/**
 * Take the plugin link out once no entry runs through it, so the `SessionStart` hook, which only
 * refreshes a link that is there, stops making it current. What to say about it, or nothing.
 */
function removePluginLink(link: string): string {
  if (linkAt(link).kind !== 'link') return '';
  try {
    unlinkSync(link);
    return `Removed ${link}, the link the entry for your own tools ran the plugin through.\n`;
  } catch (e) {
    return `Could not remove ${link} (${(e as Error).message}). No entry runs through it now.\n`;
  }
}

/**
 * The matchers `--doctor` expects registered: from the plugin, the plugin's and its own entry's;
 * from a checkout, the one a checkout's settings entry carries for this map.
 */
function registeredMatchers(registered: Registered | null, toolMap: ToolMap): string[] {
  if (registered === null) return [matcherFor(toolMap)];
  return [pluginMatcher(), ...(registered.block === null ? [] : [registered.block.matcher])];
}

/**
 * `--register` run from a checkout, which is not an install: an entry from here would be a second
 * hook beside the plugin's.
 */
function checkoutRegisters(): number {
  process.stderr.write(
    'draftgate register: this is a checkout of draftgate, not the draftgate plugin, so it registers ' +
      `nothing and nothing was written. To put draftgate in place, run ${REMEDY.installPlugin}. To ` +
      `try this checkout's code, ${REMEDY.buildPlugin} assembles a plugin out of it.\n`
  );
  return 1;
}

/**
 * `--propose-tools ... --decline ... --write`: write the answer's `tools.json`, so the setup skill
 * needs only `draftgate`. The operator's file with the answer applied and the proposals added; a
 * symlink is written through. Checked by the merge reviews load it with before it is written. Then
 * it names the tools no registered matcher covers, which `draftgate register` would.
 */
async function writeToolsAnswer(o: {
  reconciliation: Reconciliation;
  answer: string[] | undefined;
  existing: Record<string, unknown>;
  toolsPath: string;
}): Promise<number> {
  if (o.answer === undefined) {
    process.stderr.write(
      'draftgate: --write needs --decline, the answer to write: the tools NOT to review, or ' +
        '--decline alone to review every one.\n'
    );
    return 1;
  }
  const written = writeToolsFile(answeredToolsJson(o.reconciliation, o.existing, o.answer), o.toolsPath, 'the answer');
  if (written === null) return 1;
  const lines = [`draftgate: wrote ${o.toolsPath} (${o.answer.length} tool(s) declined).`];
  const { restated } = o.reconciliation;
  if (restated.length > 0) {
    lines.push('', "Dropped from tools.json, since each said just what draftgate's own entry says:", ...restated.map((name) => `  ${oneLine(name)}`));
  }
  // Never dropped unasked: what differs may be on purpose. Setup asks, and `--drop` drops.
  const overrides = written.shadows.filter((s) => !restates(s));
  if (overrides.length > 0) {
    lines.push(
      '',
      `${OVERRIDES}:`,
      ...overrides.map((s) => `  ${oneLine(shadowLine(s))}`),
      '',
      `${REMEDY.dropToolEntries} with their names drops them, so draftgate's own entry applies.`
    );
  }
  const root = pluginRootOf(process.env, HOOK, realpathOrNull);
  const registered = registrationHere(written.map, root);
  const uncovered = inspectHere(written, process.cwd(), process.env, root).unregistered;
  const [heading, offered, remedy] =
    registered !== null
      ? [
          "draftgate can't watch these by default:",
          uncovered.filter((name) => registered.tools.includes(name)),
          `${REMEDY.register} adds one Claude Code settings entry that reviews exactly these.`,
        ]
      : [
          'No registered matcher covers these, so they send unreviewed:',
          uncovered,
          `Run ${REMEDY.installPlugin}.`,
        ];
  if (offered.length > 0) lines.push('', heading, ...offered.map((name) => `  ${oneLine(name)}`), remedy);
  // An entry `register` would rewrite: a checkout's, another plugin version's, or this one's when
  // nothing needs it. Named whether or not tools are offered; `--doctor` sends people here.
  if (registered !== null) {
    // The link entry is old only when there is none to write; a version folder's is old either way.
    const replaced = (await replacedByRegister(registered.block)).filter(
      (hook) => registered.block === null || hook !== join(registered.link, HOOK_IN_REPO)
    );
    if (replaced.length > 0) {
      lines.push(
        '',
        `${OLD_ENTRY}, which runs:`,
        ...replaced.map((hook) => `  ${oneLine(hook)}`),
        `${REMEDY.register} replaces it with what the plugin needs.`
      );
    }
  }
  await printStdout(lines.join('\n') + '\n');
  return 0;
}

/** The words `/draftgate:setup` asks about overriding entries on (`plugin/skills/setup/SKILL.md`). */
export const OVERRIDES = "tools.json overrides draftgate's own entry for these";

/**
 * Write `text` as `tools.json`, after checking that reviews can load it, through a symlink. The
 * config it makes, or null when nothing was written (and stderr says why). `what` names the change.
 */
function writeToolsFile(text: string, toolsPath: string, what: string): ToolConfig | null {
  let written: ToolConfig;
  try {
    written = toolConfigFrom(text + '\n', toolsPath);
  } catch (e) {
    process.stderr.write(`draftgate: ${what} would make a tools.json reviews cannot load, so nothing was written. ${(e as Error).message}\n`);
    return null;
  }
  const failed = writePrivateFile(realpathOrNull(toolsPath) ?? toolsPath, text + '\n');
  if (failed) {
    process.stderr.write(`draftgate: could not write ${toolsPath} (${failed.message}). It was not changed.\n`);
    return null;
  }
  return written;
}

/**
 * `--propose-tools --drop <name>...`: take out `tools.json` entries that replace a default entry of
 * the same name, so the default applies. Any other name is refused, and nothing is written: an
 * alias or a tool of the operator's own taken out would change what is reviewed.
 */
async function dropToolEntries(names: string[], toolsPath: string): Promise<number> {
  if (names.length === 0) {
    process.stderr.write(`draftgate: --drop needs the tools.json entries to drop, by their full names.\n`);
    return 1;
  }
  // One read, both for what may be dropped and for what is written back: a second read that failed
  // or saw another write would write back something else, `{}` at worst.
  let tools: ToolConfig;
  let existing: Record<string, unknown>;
  try {
    const text = readFileSync(toolsPath, 'utf8');
    tools = toolConfigFrom(text, toolsPath);
    existing = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(`draftgate: could not read ${toolsPath} (${(e as Error).message}), so nothing was dropped.\n`);
    return 1;
  }
  const shadowing = new Set(tools.shadows.map((s) => s.name));
  const stray = names.filter((name) => !shadowing.has(name));
  if (stray.length > 0) {
    process.stderr.write(
      `draftgate: ${stray.map((n) => `"${oneLine(n)}"`).join(', ')} is not a tools.json entry for one of ` +
        "draftgate's own tools, so nothing was dropped. --drop takes only those, since dropping any other " +
        'entry changes what is reviewed.\n'
    );
    return 1;
  }
  const dropped = new Set(names);
  const kept = Object.fromEntries(Object.entries(existing).filter(([name]) => !dropped.has(name)));
  if (writeToolsFile(JSON.stringify(kept, null, 2), toolsPath, 'dropping them') === null) return 1;
  await printStdout(
    [`draftgate: dropped from ${toolsPath}, so draftgate's own entry applies to:`, ...[...dropped].sort().map((n) => `  ${oneLine(n)}`)].join('\n') + '\n'
  );
  return 0;
}

/** The words `/draftgate:setup` asks about an old entry on (`plugin/skills/setup/SKILL.md`). */
export const OLD_ENTRY = "Claude Code's user settings hold a draftgate entry the plugin does not need";

/**
 * The hooks of the draftgate entries in the user settings that `--register` would replace with
 * `block`, or none: nothing would change, or it would refuse (and says why when it runs).
 */
async function replacedByRegister(block: HookBlock | null): Promise<string[]> {
  const target = userSettingsPath(process.env, homedir);
  const read = readSettingsFile(target);
  if (read.kind === 'unreadable') return [];
  const plan = (await import('./register')).planRegistration(textOf(read), block, classifyHere, target);
  return plan.kind === 'changed' ? [...new Set(plan.previous)] : [];
}

/**
 * The flags `--propose-tools` takes. Any other beside it is refused before any mode runs:
 * `draftgate propose-tools` passes its arguments as they are, and an `--unregister` among them would
 * otherwise run that mode.
 */
const PROPOSE_FLAGS = ['--propose-tools', '--decline', '--write', '--known', '--drop'];

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--propose-tools')) {
    const other = argv.find((arg) => arg.startsWith('--') && !PROPOSE_FLAGS.includes(arg));
    if (other !== undefined) {
      // Refused, not skipped: `--decline=x` skipped would drop the answer and exit 0.
      process.stderr.write(
        `draftgate: ${REMEDY.proposeTools} does not take ${other}. Pass tool names after it ` +
          'and tool halves after --decline, space-separated, --write to write the answer, --known ' +
          'alone to list the tool halves it knows, or --drop and the tools.json entries to drop.\n'
      );
      return 1;
    }
  }
  // `draftgate uninstall`'s first step, before the tool map: a broken `tools.json` must not keep
  // the hook registered.
  if (argv.includes('--unregister')) return registerWithLink(null);
  // Its second step: Claude Code's record of the plugin, as JSON. Independent of the tool map too.
  if (argv.includes('--plugin-record')) {
    const root = pluginRootOf(process.env, HOOK, realpathOrNull);
    await printStdout(JSON.stringify(pluginRecord(root, settingsDocsHere(process.cwd()), process.env)) + '\n');
    return 0;
  }
  // The plugin's two generated files, before the tool map: they ship to every machine, and
  // `tools.json` is this one's.
  if (argv.includes('--print-plugin-hooks')) {
    await printStdout(pluginHooksFile(PLUGIN_HOOK_TIMEOUT_S));
    return 0;
  }
  if (argv.includes('--print-plugin-launcher')) {
    await printStdout(pluginLauncher());
    return 0;
  }
  const printing = isPrintMode(argv);
  let tools: ToolConfig;
  try {
    tools = loadToolConfig();
  } catch (e) {
    process.stderr.write(`draftgate: ${(e as Error).message}\n`);
    if (printing) {
      // Exit 1 with nothing on stdout: an `ask` decision would read as the mode's output, and the
      // default map would print a matcher the operator's config disagrees with.
      process.stderr.write(
        'draftgate: refusing to run with a tool map it could not read. ' +
          'Fix or remove the file above and run this again.\n'
      );
      return 1;
    }
    return answer(unreadable('it could not load its tool map', (e as Error).message));
  }
  const toolMap = tools.map;

  // The operator's deadline; only the clamp against the registration lowers it.
  const config = loadReviewConfig();
  if (config.problem) process.stderr.write(`draftgate: ${config.problem}\n`);

  if (argv.includes('--register')) {
    const registered = registrationHere(toolMap);
    return registered === null ? checkoutRegisters() : registerWithLink(registered);
  }

  if (argv.includes('--propose-tools')) {
    // The names come from the caller, never a search: only an agent session's tool list has them.
    // `~/.claude.json` has no claude.ai-managed connectors.
    //
    // Each flag owns the bare arguments after it, in either order: tool names after
    // `--propose-tools`, tool halves after `--decline`, entries after `--drop`. `--write` owns none.
    let names: string[] = [];
    let chosen: string[] | undefined;
    let dropping: string[] | undefined;
    let into: string[] | undefined;
    let write = false;
    let known = false;
    for (const arg of argv) {
      if (arg === '--write') write = true;
      else if (arg === '--known') known = true;
      else if (arg === '--propose-tools') into = names;
      else if (arg === '--decline') into = chosen ??= [];
      else if (arg === '--drop') into = dropping ??= [];
      else into?.push(arg);
    }
    const toolsPath = join(draftgateHome(), CONFIG_BASENAME);
    // Alone, like `--known`: it needs no names, and beside an answer one of the two would be lost.
    if (dropping !== undefined) {
      if (names.length > 0 || chosen !== undefined || write || known) {
        process.stderr.write('draftgate: --drop takes nothing else: only the tools.json entries to drop.\n');
        return 1;
      }
      return dropToolEntries(dropping, toolsPath);
    }
    // The halves a name must end in to matter (`knownHalves`), one per line. Alone: beside names or
    // an answer it would drop them while exiting 0.
    if (known) {
      if (names.length > 0 || chosen !== undefined || write) {
        process.stderr.write('draftgate: --known takes nothing else: it lists the tool halves draftgate knows.\n');
        return 1;
      }
      await printStdout(knownHalves(tools).map((h) => `${oneLine(h)}\n`).join(''));
      return 0;
    }
    /*
     * With no names, the ones this session kept, so a run without names never replaces them. With
     * none kept, a session passing none has no send tool, and none is its list; a terminal has no
     * session, so there no names is a mistake.
     */
    const kept = keptSetupNames();
    if (names.length === 0) {
      if (kept !== null) {
        names = kept;
      } else if (write) {
        process.stderr.write(
          'draftgate: --write has no tool names to record an answer about. Pass them too, or ' +
            `run ${REMEDY.proposeTools} with the names first in this same Claude Code session, ` +
            'which keeps them for it.\n'
        );
        return 1;
      } else if (!process.env[SESSION_VAR]) {
        process.stderr.write(
          `draftgate: ${REMEDY.proposeTools} needs the tool names to compare, e.g.\n` +
            '  draftgate propose-tools mcp__atlassian__addCommentToJiraIssue mcp__slack__slack_send_message\n' +
            '--known lists the tool halves a name must end in to matter here.\n'
        );
        return 1;
      }
    }
    // The operator's current file: the report prints it with the proposals added, since only the
    // new entries would invite deleting the aliases already there.
    const existing = existingToolsJson(toolsPath);
    const reconciliation = reconcileTools(names, toolMap, tools);
    let answer: string[] | undefined;
    if (chosen !== undefined) {
      const after = declinedAfter(reconciliation, tools.declined, chosen);
      if ('error' in after) {
        process.stderr.write(`draftgate: ${after.error}\n`);
        return 1;
      }
      answer = after.declined;
    }
    if (write) {
      const code = await writeToolsAnswer({ reconciliation, answer, existing, toolsPath });
      // This session's setup run is over. Another session's names stay for its own --write.
      if (code === 0 && kept !== null) forgetSetupNames();
      return code;
    }
    // Names read from the file are kept already.
    const notKept = names === kept ? null : keepSetupNames(names);
    if (notKept) {
      process.stderr.write(`draftgate: could not keep these names for --write (${notKept.message}).\n`);
      return 1;
    }
    await printStdout(
      describeReconciliation(
        reconciliation,
        Object.keys(toolMap).length,
        existing,
        toolsPath,
        answer
      )
    );
    return 0;
  }

  if (argv.includes('--doctor')) {
    // Retention runs here too: `--doctor` may be the last thing that runs. Never part of `ok`.
    const logPath = auditPath(undefined, false);
    if (logPath) applyRetention(logPath, config.retentionDays);
    const root = pluginRootOf(process.env, HOOK, realpathOrNull);
    const report = inspectHere(tools, process.cwd(), process.env, root);
    const registered = registrationHere(toolMap, root);
    const setup = argv.includes('--setup');
    const settings = settingsDocsHere(process.cwd());
    const others = otherInstalls(report);
    const plugin = pluginFacts(root, settings);
    // A plugin managed settings force on runs past `allowManagedHooksOnly`, as a managed hook does.
    const forced =
      plugin.record.kind === 'read' &&
      plugin.record.installs.some((i) => i.thisRoot && i.enabled?.enabled === true && i.enabled.by?.scope === 'managed');
    // Loaded lazily, like `reviewHost` below: both bring `node:crypto` (about 3 ms) to every review.
    const stamp = await import('../../../cli/src/surfaces/bundleStamp');
    const bundle = stamp.bundleState(stamp.surfaceLayout(CHECKOUT));
    const { text, ok } = doctorReport({
      report,
      deadline: reviewDeadline(config.wantedMs, report.registeredTimeoutMs),
      toolMap,
      declined: tools.declined,
      declinedUnrouted: tools.declinedUnrouted,
      dormant: tools.dormant,
      shadows: tools.shadows,
      expectedMatchers: registeredMatchers(registered, toolMap),
      configPath: config.path,
      configPresent: config.present,
      ...(config.problem && { configProblem: config.problem }),
      classifications: classificationStates(),
      release: currentReleaseStatus(config),
      host: (await import('../../../cli/src/reviewHost')).hostFacts(),
      hooks: hooksHere(report.ours.map((h) => h.source), settings, forced),
      // Only when nothing launches this hook: then the report names what does, if anything.
      otherInstalls: others,
      plugin,
      window: {
        fresh: bundle.state === 'fresh',
        described: stamp.describeState(bundle),
        remedy: stamp.bundleRemedy(bundle, CHECKOUT),
      },
      setup,
    });
    // `--setup`: setup's closing, from the facts just checked, only when nothing is wrong.
    if (ok && setup) {
      const { setupClosing } = await import('./setupClosing');
      await printStdout(
        setupClosing({
          map: toolMap,
          // The declines that route something: a decline of nothing is no choice to report.
          declined: tools.declined.filter((half) => !tools.declinedUnrouted.includes(half)),
          ownTools: registered?.tools ?? [],
          logged: logPath !== null,
        })
      );
      return 0;
    }
    await printStdout(text);
    return ok ? 0 : 1;
  }

  const stdin = readStdin();
  // The registration is read on every review, since settings may have changed since they were
  // written: four `readFileSync`s of small JSON. An unreadable tree is no registration, which the
  // clamp caps shorter, never longer.
  const root = pluginRootOf(process.env, HOOK, realpathOrNull);
  const fromPlugin = root !== null;
  const report = inspectHere(tools, cwdFrom(stdin), process.env, root);
  const deadline = reviewDeadline(config.wantedMs, report.registeredTimeoutMs);

  // Whether a person's surface reviewed this call (`ReviewSurface.human`), for the release check.
  let byHuman = false;
  const decision = await decide(stdin, {
    toolMap,
    declined: tools.declined,
    review: async (req) => {
      const result = await runCli(deadline.ms, req);
      byHuman = result.human === true;
      return result;
    },
  });
  // Exit 0 whenever the decision was written (`answer`). The release notice trails, so the trim
  // takes it first.
  const code = await answer(
    withNotes(
      decision,
      [registrationNote(report, fromPlugin), deadlineNote(deadline, { plugin: fromPlugin, configPath: config.path })],
      [currentReleaseNotice(config)]
    )
  );
  // The daily release check, after the decision is written and only behind a person's surface, so
  // tests and verifiers start none. `startReleaseCheck` returns at once and cannot throw; its child
  // is detached and holds none of our pipes.
  if (code === 0 && byHuman) startReleaseCheck({ config });
  return code;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(async (e) => {
      // A crash asks, through `answer`, so a failed write exits 1.
      process.stderr.write(`draftgate-hook: unexpected failure: ${(e as Error)?.stack ?? e}\n`);
      // Not in a print mode, whose stdout is its output, not a decision.
      if (isPrintMode(process.argv.slice(2))) process.exit(1);
      process.exit(
        await answer(unreadable('the draftgate hook crashed', String((e as Error)?.message ?? e)))
      );
    });
}
