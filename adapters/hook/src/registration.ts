/**
 * What Claude Code is registered to do with draftgate, read back from its own settings.
 *
 * A registration (the plugin's `hooks/hooks.json`, or a settings entry) is a second copy of the map
 * and deadline, and each way it drifts is silent: a tool missing from the matcher goes out ungated
 * and unlogged; a `timeout` shorter than the review deadline hits Claude Code's fail-open
 * (`reviewTimeout.ts`); a `deny` rule outranks `PreToolUse`; two entries for one tool both fire.
 *
 * The runtime tells the hook nothing about its registration. Verified against Claude Code 2.1.268:
 * the `PreToolUse` payload is `["hook_event_name","session_id","transcript_path","cwd",
 * "scratchpad_dir","prompt_id","permission_mode","agent_id","agent_type","served_call",
 * "caller_session_id","effort"]` plus `tool_name`, `tool_input`, `tool_use_id`; the env is
 * `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`,
 * `CLAUDE_PROJECT_DIR` (plus `AI_AGENT`/`CLAUDE_EFFORT`/`TRACEPARENT` conditionally). No hook id,
 * matcher, timeout or source file, so this module reads the files, and the plugin's own
 * `hooks/hooks.json` when the hook runs from a plugin root (`pluginRootOf`).
 *
 * ## Two measured facts
 *
 * Duplicate registrations both fire, concurrently, and a denial wins. MEASURED with two matching
 * entries (a project `settings.json` and a `settings.local.json`) against a real `claude -p`: both
 * commands ran 0.27s apart, both sleeping 3s; the `deny` decided and the `allow` was discarded. For
 * draftgate that is two review windows for one send, and the one the reviewer ignores can veto the
 * one they used. This is the home of that fact (`firesTwiceOf`).
 *
 * Settings are hot-reloaded: the binary watches them (`settingsChangeDetector`, which emits
 * `ConfigChange`). A `ConfigChange` hook can block a reload, leaving the session on older settings
 * than the file; that is the one way the clamp can be wrong, toward a longer review.
 *
 * Pure except for `inspectRegistration`, which takes its reader as an argument.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { isPlainObject } from '../../../cli/src/json';
import { REGEX_META, declinedHalfOf, matcherCovers, resolveRoute, toolHalvesOf, type ToolMap } from './toolMap';
import { HOOK_IN_CHECKOUT, readCommand } from './hookCommand';
import type { SettingsScope } from './hookSwitches';
import { isPluginFailClosed } from './pluginHooks';

/**
 * The `PreToolUse` event default, in ms, when an entry sets no `timeout`. Verified in 2.1.260 and
 * 2.1.268: `DEFAULT_TIMEOUT=600000`, resolved as in `timeoutMsOf`. Shorter than the CLI's default
 * review deadline, so such an entry needs the clamp (`reviewTimeout.ts`).
 */
export const EVENT_DEFAULT_TIMEOUT_MS = 600_000;

/** One `hooks.PreToolUse[].hooks[]` entry that names this adapter. */
export interface RegisteredHook {
  /** The settings file it came from, or the plugin's `hooks/hooks.json`. */
  source: string;
  /** The `matcher` of the block it sits in. */
  matcher: string;
  /** Seconds, as written. `undefined` means the entry omitted it and the event default applies. */
  timeout?: number;
  /**
   * Set when the entry launches the same file in another checkout of this repository: its root, and
   * whether it is a worktree (the registration breaks when it is removed). Counted as ours.
   */
  checkout?: { root: string; worktree: boolean };
  /**
   * Whether the command is the fail-closed wrapper (`hookCommand.ts`), which answers `ask` when the
   * hook cannot start. False for a bare `'<bun>' '<hook>'` entry: that one still gates, and lets the
   * tool run unreviewed if the hook cannot start.
   */
  failClosed: boolean;
  /**
   * The root a plugin wrapper entry in a settings file names: draftgate's plugin link for the
   * extra-tools entry `register` writes from the plugin, or a version folder, which `--doctor`
   * notes because it does not follow an update.
   */
  pluginRoot?: string;
}

/**
 * What one entry gives the reviewer, in ms: the runtime's own resolution, verified in 2.1.268,
 * `hook.timeout !== undefined && hook.timeout > 0 ? hook.timeout * 1000 : defaultTimeoutMs(event)`.
 */
export function timeoutMsOf(hook: Pick<RegisteredHook, 'timeout'>): number {
  return hook.timeout !== undefined && hook.timeout > 0
    ? hook.timeout * 1000
    : EVENT_DEFAULT_TIMEOUT_MS;
}

/** A settings file, parsed for the three things that decide whether the gate works. */
export interface ParsedSettings {
  path: string;
  /** Every `PreToolUse` command entry, with its block's matcher. */
  hooks: { matcher: string; command: string; timeout?: number }[];
  /** `permissions.deny` and the top-level `denyTools`, concatenated. Both outrank `PreToolUse`. */
  deny: string[];
  /** Set when the file exists and could not be read as settings. Never thrown. */
  problem?: string;
}

/**
 * Parse one settings file's text. Partial credit, like `parseScratchList`: a file that is JSON but
 * shaped wrong yields whatever it did hold plus a `problem`.
 */
export function parseSettings(text: string, path: string): ParsedSettings {
  const empty: ParsedSettings = { path, hooks: [], deny: [] };
  const object = settingsObject(text, path);
  if ('problem' in object) return { ...empty, problem: object.problem };
  const parsed = object.settings;

  const deny: string[] = [];
  // Both lists: one file can hold `permissions.deny` and a top-level `denyTools`, and either blocks
  // the hook. Read first, so a typo in `hooks.PreToolUse` cannot hide a deny that shadows a tool.
  const permissions = isPlainObject(parsed.permissions) ? parsed.permissions : undefined;
  for (const list of [permissions?.deny, parsed.denyTools]) {
    for (const rule of Array.isArray(list) ? list : []) {
      if (typeof rule === 'string' && rule !== '') deny.push(rule);
    }
  }

  const hooks: ParsedSettings['hooks'] = [];
  const blocks = isPlainObject(parsed.hooks) ? parsed.hooks.PreToolUse : undefined;
  if (blocks !== undefined && !Array.isArray(blocks)) {
    return { ...empty, deny, problem: `${path} has a hooks.PreToolUse that is not an array` };
  }
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!isPlainObject(block)) continue;
    const matcher = typeof block.matcher === 'string' ? block.matcher : '';
    for (const hook of hookEntriesOf(block)) {
      const command = commandOf(hook);
      if (command === null) continue;
      const timeout = isPlainObject(hook) && typeof hook.timeout === 'number' && Number.isFinite(hook.timeout)
        ? hook.timeout
        : undefined;
      hooks.push({ matcher, command, ...(timeout !== undefined && { timeout }) });
    }
  }

  return { path, hooks, deny };
}

/** A `PreToolUse` block's hook entries, or none when it is not a block with a `hooks` list. */
export function hookEntriesOf(block: unknown): unknown[] {
  return isPlainObject(block) && Array.isArray(block.hooks) ? block.hooks : [];
}

/**
 * A hook entry's `command`, or null when it is not a command hook. Shared by `parseSettings`
 * (`--doctor`) and `planRegistration` (`register`). Claude Code also has script, callback, function,
 * http, mcp_tool, agent and prompt hooks; draftgate writes only `type: "command"`.
 */
export function commandOf(entry: unknown): string | null {
  return isPlainObject(entry) && entry.type === 'command' && typeof entry.command === 'string'
    ? entry.command
    : null;
}

/**
 * A settings file's text as the object it has to be, or why it is not one. The hook switches
 * (`main.ts`'s `hooksHere`) read these files through it too.
 */
export function settingsObject(
  text: string,
  path: string
): { settings: Record<string, unknown> } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { problem: `${path} is not valid JSON (${why})` };
  }
  return isPlainObject(parsed) ? { settings: parsed } : { problem: `${path} is not a JSON object` };
}

/**
 * Does this command launch this adapter? `realpath` may return null: a settings file can name a path
 * that no longer exists.
 */
export function commandNamesHook(
  command: string,
  hookPath: string,
  realpath: (p: string) => string | null
): boolean {
  // `searchable`, not `command`: the fail-closed wrapper names the hook again in its messages,
  // which must not count (`readCommand`).
  const { launched, searchable } = readCommand(command);
  if (searchable.includes(hookPath) || launched.includes(hookPath)) return true;
  const realHook = realpath(hookPath) ?? hookPath;
  if (realHook !== hookPath && searchable.includes(realHook)) return true;
  return launched.some((t) => realpath(t) === realHook);
}

/**
 * What a hook path in somebody's settings turned out to be, for `classifyEntry`. The filesystem
 * half is `probeHook` in `main.ts`.
 *
 *  - `draftgate`: it sits in a checkout whose `package.json` is named draftgate;
 *  - `foreign`: it exists, and its checkout is something else;
 *  - `unverifiable`: it is gone or cannot be read, as for a checkout that moved.
 */
export type HookProbe = 'draftgate' | 'foreign' | 'unverifiable';

/** What `classifyEntry` needs to know. The filesystem half is `main.ts`'s. */
export interface EntryContext {
  hookPath: string;
  realpath: (p: string) => string | null;
  probe: (hookPath: string) => HookProbe;
}

/**
 * What a registered command is to `draftgate register`, with the hook it launches when it is
 * draftgate's (the wrapper's `$2`, or the word that matched). `mentions` is a command
 * `commandNamesHook` counts as this hook while `classifyEntry` does not (`sh -c "bun <hook>"`, the
 * hook inside one quoted word): `register` refuses it and says where it is, so every entry
 * `--doctor` calls this hook is one `register` replaces or refuses.
 */
export type EntryClass = { kind: 'draftgate'; hook: string } | { kind: 'mentions' } | { kind: 'other' };

/**
 * Is this command any draftgate hook entry: this checkout's, a worktree's, or another clone's?
 * Wider than `inspectRegistration`'s `ours` (which hook runs, as far as this checkout can vouch),
 * because this is what `register` replaces: another clone's entry left alone would fire too.
 *
 * Stricter than `commandNamesHook`, because a writer deletes on it: a word of the command must be
 * this hook (or a `realpath` spelling of it), so a hook that only mentions it
 * (`logger .../main.ts.bak`) is `mentions`. An entry is draftgate's when it is:
 *
 *  - a launch of this hook, as a word of the command;
 *  - the fail-closed wrapper, in any version, whatever its `$2` names (`$0` is `FAIL_CLOSED_NAME`);
 *  - a launch of `<checkout>/adapters/hook/src/main.ts` in a checkout whose `package.json` is named
 *    draftgate (a path suffix alone would claim another project laid out the same way);
 *  - such a path that is gone or unreadable, in exactly `<interpreter> <hook>`, draftgate's bare
 *    entry (`--doctor` notes it; `register` writes only the wrapper). Nothing can be verified about
 *    a missing path, so the claim is held to that one shape.
 */
export function classifyEntry(command: string, opts: EntryContext): EntryClass {
  const { launched, wrapped } = readCommand(command);
  if (wrapped) return { kind: 'draftgate', hook: launched.at(-1)! };
  const self = opts.realpath(opts.hookPath) ?? opts.hookPath;
  const hook = launched.find((token, i) => {
    if (!isAbsolute(token)) return false;
    if (token === opts.hookPath || opts.realpath(token) === self) return true;
    if (!token.endsWith(`/${HOOK_IN_CHECKOUT}`)) return false;
    const probe = opts.probe(token);
    return probe === 'draftgate' || (probe === 'unverifiable' && launched.length === 2 && i === 1);
  });
  if (hook !== undefined) return { kind: 'draftgate', hook };
  return commandNamesHook(command, opts.hookPath, opts.realpath) ? { kind: 'mentions' } : { kind: 'other' };
}

/**
 * Which git checkout a file sits in: the checkout's root, the repository's common git directory
 * (shared by every worktree of one repository), and the file's path inside the checkout.
 */
export interface Checkout {
  root: string;
  commonDir: string;
  relative: string;
  /** A linked worktree (`.git` is a file) rather than the main checkout. */
  worktree: boolean;
}

/**
 * Does this command launch the same file as `own` (this hook's checkout) in a different checkout of
 * the same repository? Returns that checkout, or null. `checkoutOf` is injected (`main.ts`); only an
 * absolute token ending in this hook's path-within-checkout is looked up. `root !==` cannot fail from
 * `inspectRegistration` and keeps the function right on its own.
 */
export function siblingCheckout(
  command: string,
  own: Checkout,
  checkoutOf: (path: string) => Checkout | null
): Checkout | null {
  for (const token of readCommand(command).launched) {
    if (!isAbsolute(token) || !token.endsWith(own.relative)) continue;
    const other = checkoutOf(token);
    if (
      other !== null &&
      other.commonDir === own.commonDir &&
      other.relative === own.relative &&
      other.root !== own.root
    ) {
      return other;
    }
  }
  return null;
}

/**
 * Split an alternation on the `|` separators that are not inside a group. A naive `split('|')`
 * would tear `matcherFor`'s `mcp__...__(?:a|b|c)` branch apart and read the matcher as opaque.
 */
export function splitAlternation(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let escaped = false;
  for (const ch of body) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { current += ch; escaped = true; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === '|' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** What a generated matcher claims: literal tool names, and the tool halves it infers from. */
export interface MatcherClaims {
  names: string[];
  halves: string[];
}

/**
 * What an anchored alternation covers, or null when the pattern is not one this can read.
 * `matcherFor` emits two kinds of alternative, an escaped literal name and one
 * `mcp__<server>__(?:half|half)` branch; a hand-written pattern generally does not decompose, and
 * `RegistrationReport.opaqueMatchers` names it.
 *
 * The server class is read as `.*?`, not `SERVER_CHARS`: a matcher another draftgate version
 * generated may spell the class differently, and reading it as opaque would hide its drift
 * (`halvesNotInferred`). `REGEX_META` is shared with the writer.
 */
export function matcherClaims(matcher: string): MatcherClaims | null {
  const m = /^\^\(\?:(.*)\)\$$/.exec(matcher);
  if (!m) return null;
  const names: string[] = [];
  const halves: string[] = [];
  /** Unescape one alternative, or null when it is not a plain literal. One spelling for both kinds. */
  const literalOf = (raw: string): string | null => {
    const literal = raw.replace(/\\(.)/g, '$1');
    return literal === '' || REGEX_META.test(literal) ? null : literal;
  };
  for (const raw of splitAlternation(m[1]!)) {
    const inferBranch = /^mcp__\(\?:.*?\)__\(\?:(.*)\)$/.exec(raw);
    if (inferBranch) {
      for (const half of splitAlternation(inferBranch[1]!)) {
        const literal = literalOf(half);
        if (literal === null) return null;
        halves.push(literal);
      }
      continue;
    }
    const literal = literalOf(raw);
    if (literal === null) return null;
    names.push(literal);
  }
  return { names, halves };
}

/**
 * A deny rule that shadows a gated tool. Claude Code's permission rules are `Tool` or
 * `Tool(specifier)`, so an exact name and a `name(...)` prefix count; its matching beyond that is
 * undocumented, and guessing would report a gated tool as blocked.
 */
export function denyShadows(rule: string, toolName: string): boolean {
  return rule === toolName || rule.startsWith(`${toolName}(`);
}

/**
 * The entries that fire for a tool another entry fires for too (`RegistrationReport.firesTwice`):
 * the same matcher, one of `gated` that both cover, or a tool half both infer from. A matcher this
 * cannot read (`matcherClaims`) is assumed to overlap every other: "no duplicate" is the claim that
 * would hide a second window.
 */
export function firesTwiceOf(ours: readonly RegisteredHook[], gated: readonly string[]): RegisteredHook[] {
  const overlap = (a: string, b: string): boolean => {
    if (a === b || gated.some((n) => matcherCovers(a, n) && matcherCovers(b, n))) return true;
    const [ca, cb] = [matcherClaims(a), matcherClaims(b)];
    return ca === null || cb === null || ca.halves.some((h) => cb.halves.includes(h));
  };
  return ours.filter((a) => ours.some((b) => b !== a && overlap(a.matcher, b.matcher)));
}

/**
 * Whether the only entries firing twice are the plugin's own and the user settings' (the extra-tools
 * entry `register` writes): then `register`, which rewrites only that file, narrows it and the
 * second window goes. A duplicate anywhere else is not its to mend. Paths compared resolved.
 */
export function firesBesidePlugin(
  firesTwice: readonly RegisteredHook[],
  pluginHooksPath: string,
  userSettings: string
): boolean {
  const [plugin, user] = [resolve(pluginHooksPath), resolve(userSettings)];
  const sources = firesTwice.map((h) => resolve(h.source));
  return sources.includes(plugin) && sources.includes(user) && sources.every((s) => s === plugin || s === user);
}

export interface RegistrationReport {
  /** Files looked at, in the order read. `problem` is set for one that exists and did not parse. */
  scanned: { path: string; present: boolean; problem?: string }[];
  /** Every registered entry that launches this adapter. */
  ours: RegisteredHook[];
  /**
   * The entries of `ours` that fire for a tool another of them fires for too (`firesTwiceOf`). The
   * plugin's hook and the extra-tools entry `register` writes beside it fire for different tools.
   */
  firesTwice: RegisteredHook[];
  /**
   * Every other command entry, where it was found: from the same read as `ours`, so `--doctor` can
   * ask which of them is another draftgate install without reading the files again.
   */
  others: { source: string; command: string }[];
  /** Gated tools no registered matcher covers: the send goes out ungated and unlogged. */
  unregistered: string[];
  /** Names a matcher covers that the merged map does not know: those arrive and are DENIED. */
  unmapped: string[];
  /**
   * Declined tool halves a registered matcher still covers, by name or by half. Not `unmapped`:
   * they arrive and get no decision, as the operator asked, but the hook still starts for each one
   * because the registration predates the decline.
   */
  declinedStillMatched: string[];
  /** Matchers that are not an anchored alternation, so `unmapped` could not be computed from them. */
  opaqueMatchers: string[];
  /**
   * Tool halves the map routes that no registered matcher infers from. A matcher of exact names
   * leaves `unregistered` empty yet misses the same connector under a server name nobody mapped,
   * which coverage cannot see.
   */
  halvesNotInferred: string[];
  /** Gated tools blocked upstream of the hook, which never reach a review. */
  shadowed: { tool: string; rule: string; source: string }[];
  /** The shortest deadline any registration that could be ours allows, in ms. */
  registeredTimeoutMs?: number;
}

/**
 * Which files can carry a hook registration, in the order Claude Code reads them: managed settings,
 * the user's (`CLAUDE_CONFIG_DIR` honoured, as Claude Code does), then the project's two, from the
 * payload's `cwd` (or `CLAUDE_PROJECT_DIR`) so they are the project this review runs in.
 */
export function settingsPaths(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  homedir: () => string,
  platform: NodeJS.Platform
): string[] {
  return settingsSources(env, cwd, homedir, platform).map((s) => s.path);
}

/**
 * The same files, each with its scope, for `hookSwitches.ts`: a switch means something different in
 * managed settings than in a user's.
 */
export function settingsSources(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  homedir: () => string,
  platform: NodeJS.Platform
): { path: string; scope: SettingsScope }[] {
  const sources: { path: string; scope: SettingsScope }[] = [];
  /*
   * Each file once, by Claude Code's rule. Read off the 2.1.287 binary: its merged-settings builder
   * (`crr`) keeps a Set of files read, keyed by `path.resolve` (`he`, imported `resolve as he` from
   * "path"), and skips a source already in it (`if(!c.has(b)||A)`, `A` being only a flag file with
   * inline content); hooks come from that merge (`getHooksConfigFromSnapshot` -> `er().hooks` ->
   * `crr`). So in the home directory, where the project's `.claude/settings.json` is the user's, it
   * fires once, and listing it twice would make `--doctor` report "registered 2 times". Lexical, as
   * there: one file through a symlink is two loads in Claude Code too.
   */
  const add = (path: string, scope: SettingsScope) => {
    if (!sources.some((s) => resolve(s.path) === resolve(path))) sources.push({ path, scope });
  };
  if (platform === 'darwin') {
    add('/Library/Application Support/ClaudeCode/managed-settings.json', 'managed');
  } else if (platform === 'win32') {
    if (env.PROGRAMDATA) add(join(env.PROGRAMDATA, 'ClaudeCode', 'managed-settings.json'), 'managed');
  } else {
    add('/etc/claude-code/managed-settings.json', 'managed');
  }
  add(userSettingsPath(env, homedir), 'user');
  const project = env.CLAUDE_PROJECT_DIR || cwd;
  if (project) {
    add(join(project, '.claude', 'settings.json'), 'project');
    add(join(project, '.claude', 'settings.local.json'), 'local');
  }
  return sources;
}

/** The user settings file: the one `draftgate register` writes, and the second `settingsPaths` reads. */
export function userSettingsPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

/**
 * What a settings file turned out to be. `unreadable` is not `absent`: an `EACCES`/`EPERM` on a
 * `-rw-------` `~/.claude/settings.json` (macOS TCC) read as absent would report no problem.
 */
export type SettingsRead =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; why: string };

export interface InspectOptions {
  /** Reads one settings file. Never throws; an error is a `SettingsRead`, not an exception. */
  read: (path: string) => SettingsRead;
  realpath: (p: string) => string | null;
  /** Where a file sits in git, for recognising a sibling checkout. Omitted means never. */
  checkoutOf?: (path: string) => Checkout | null;
  /** Tool halves the operator declined. Required, so no caller silently reads a decline as a gap. */
  declined: readonly string[];
  paths: string[];
  hookPath: string;
  toolMap: ToolMap;
  /**
   * The `hooks/hooks.json` of the plugin this hook runs from, if any (`pluginRootOf`). Read first;
   * every command entry in it is this hook's, since the file ships beside it.
   */
  pluginHooksPath?: string;
}

/**
 * Read the registration back and compare it with what draftgate thinks it gated. Nothing throws: an
 * unreadable file is a `problem` on its `scanned` row, and `ours: []` is reported, not silent.
 */
export function inspectRegistration(opts: InspectOptions): RegistrationReport {
  const scanned: RegistrationReport['scanned'] = [];
  const ours: RegisteredHook[] = [];
  const others: RegistrationReport['others'] = [];
  const deny: { rule: string; source: string }[] = [];
  // Once per inspection, not per entry: this runs on every review and the answer cannot change.
  const own = opts.checkoutOf?.(opts.hookPath) ?? null;

  /** One file, parsed, with its `scanned` row recorded; null when there is nothing in it to read. */
  const load = (path: string): ParsedSettings | null => {
    const read = opts.read(path);
    if (read.kind === 'absent') {
      scanned.push({ path, present: false });
      return null;
    }
    if (read.kind === 'unreadable') {
      // The registration may be in there, so this must not pass as a healthy scan.
      scanned.push({ path, present: true, problem: `${path} could not be read (${read.why})` });
      return null;
    }
    const parsed = parseSettings(read.text, path);
    scanned.push({ path, present: true, ...(parsed.problem && { problem: parsed.problem }) });
    return parsed;
  };

  const plugin = opts.pluginHooksPath === undefined ? null : load(opts.pluginHooksPath);
  if (plugin !== null) {
    for (const hook of plugin.hooks) {
      ours.push({
        source: plugin.path,
        matcher: hook.matcher,
        failClosed: isPluginFailClosed(hook.command),
        ...(hook.timeout !== undefined && { timeout: hook.timeout }),
      });
    }
  }

  for (const path of opts.paths) {
    const parsed = load(path);
    if (parsed === null) continue;
    for (const hook of parsed.hooks) {
      let sibling: Checkout | null = null;
      if (!commandNamesHook(hook.command, opts.hookPath, opts.realpath)) {
        sibling = own && siblingCheckout(hook.command, own, opts.checkoutOf!);
        if (sibling === null) {
          others.push({ source: path, command: hook.command });
          continue;
        }
      }
      const { failClosed, pluginRoot } = readCommand(hook.command);
      ours.push({
        source: path,
        matcher: hook.matcher,
        failClosed,
        ...(hook.timeout !== undefined && { timeout: hook.timeout }),
        ...(sibling !== null && { checkout: { root: sibling.root, worktree: sibling.worktree } }),
        ...(pluginRoot !== undefined && { pluginRoot }),
      });
    }
    for (const rule of parsed.deny) deny.push({ rule, source: path });
  }

  const matchers = ours.map((h) => h.matcher);
  const gated = Object.keys(opts.toolMap);
  const unregistered = gated.filter((name) => !matchers.some((m) => matcherCovers(m, name)));

  // One pass, so "unreadable" means one thing for every report below.
  const unmapped: string[] = [];
  const declinedStillMatched = new Set<string>();
  const opaqueMatchers: string[] = [];
  const inferable = new Set<string>();
  let readAnyMatcher = false;
  for (const matcher of matchers) {
    const claims = matcherClaims(matcher);
    if (claims === null) {
      if (!opaqueMatchers.includes(matcher)) opaqueMatchers.push(matcher);
      continue;
    }
    readAnyMatcher = true;
    for (const name of claims.names) {
      // `resolveRoute`, not `name in map`: a literal whose half the map knows is routable, inferred.
      if (resolveRoute(name, opts.toolMap) !== null) continue;
      const half = declinedHalfOf(name, opts.declined);
      if (half !== null) declinedStillMatched.add(half);
      else if (!unmapped.includes(name)) unmapped.push(name);
    }
    for (const half of claims.halves) {
      inferable.add(half);
      if (opts.declined.includes(half)) declinedStillMatched.add(half);
    }
  }

  // What the registration infers, against what the map could; opaque matchers contribute nothing.
  const halvesNotInferred = readAnyMatcher
    ? toolHalvesOf(opts.toolMap).filter((h) => !inferable.has(h))
    : [];

  const shadowed: RegistrationReport['shadowed'] = [];
  for (const name of gated) {
    for (const { rule, source } of deny) {
      if (denyShadows(rule, name)) shadowed.push({ tool: name, rule, source });
    }
  }

  const registeredTimeoutMs = ours.length ? Math.min(...ours.map(timeoutMsOf)) : undefined;

  return {
    scanned,
    ours,
    firesTwice: firesTwiceOf(ours, gated),
    others,
    unregistered,
    unmapped,
    declinedStillMatched: [...declinedStillMatched].sort(),
    opaqueMatchers,
    halvesNotInferred,
    shadowed,
    ...(registeredTimeoutMs !== undefined && { registeredTimeoutMs }),
  };
}
