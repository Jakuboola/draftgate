/**
 * The command a registration runs, and how `registration.ts` reads one back: the quoting
 * (`shQuote`), its inverse (`commandTokens`) and the fail-closed wrapper. draftgate writes the
 * plugin's wrapper (`pluginHooks.ts`); a checkout's entry (the wrapper below around a checkout's
 * hook) is only read, so `--doctor`, `register` and `uninstall` recognise one in a user's settings.
 *
 * ## A hook that cannot START is fail-open
 *
 * The bare launch is `'<bun>' '<checkout>/adapters/hook/src/main.ts'`, and in review mode that hook
 * always exits 0: every failure it can SEE, a crash included, answers `ask`. What it cannot answer
 * is a failure to start. Claude Code treats a hook's non-zero exit as a non-blocking error and runs
 * the tool (measured: exit 127 and exit 1 both let the tool run; only exit 2 blocks). So with a bare
 * launch, bun gone, the checkout moved, or a module that no longer loads means the message goes out
 * unreviewed, and nothing says so.
 *
 * So the command is a short POSIX `sh` script around the bare launch, inline in the registration (a
 * wrapper file would vanish with the checkout):
 *
 *     /bin/sh -c '<FAIL_CLOSED_SCRIPT>' draftgate-hook '<bun>' '<hook>' '<ask>' '<ask>' '<ask>'
 *
 * The script is a constant: the interpreter and the hook arrive as `$1` and `$2`, quoted once by
 * `shQuote`, so a path holding a space, a quote or a `$` is never spliced into shell text. The three
 * `ask`s are pre-rendered JSON, one per cause, so `sh` never escapes JSON. The script:
 *
 *  - buffers the hook's stdout in a temp file and `cat`s it only after an exit 0, byte for byte (a
 *    declined tool's empty output included). A hook that died mid-decision cannot put half a JSON
 *    object before the `ask`. Not `$(...)`, which strips trailing newlines and holds a megabyte
 *    decision in memory, and not a pipe, which is read before the exit status is known;
 *  - `cat` writes with blocking writes, so a slow reader gets the whole decision; the hook writes to
 *    a regular file, which does not truncate;
 *  - leaves stdin to the hook: nothing before it reads fd 0;
 *  - on a non-zero exit tells three causes apart with two file tests: the hook cannot be found or
 *    read (moved, deleted, or denied by macOS privacy settings, which a file test cannot tell from
 *    absence, so the message names both), the interpreter is gone, or the hook stopped unanswered;
 *  - buffers in `$TMPDIR`, else `/tmp`; when neither holds a file it asks without running the hook,
 *    under the third cause;
 *  - always exits 0 after printing, or Claude Code would ignore the `ask`;
 *  - unlinks the buffer before the hook runs (`FAIL_CLOSED_SCRIPT`), so an approved message is on disk
 *    only while open.
 *
 * `/bin/sh -c` explicitly: Claude Code runs commands under `/bin/sh -c` (measured on 2.1.286: `$0`
 * was `/bin/sh`, bash 3.2, with `$SHELL` zsh), but the settings schema says the default "uses your
 * $SHELL (bash/zsh/sh)". Named here, the outer shell only parses single-quoted words, read alike by
 * sh, bash and zsh. A `-c` string that is one simple command is exec'd, so it costs no process.
 *
 * Pure: strings in, strings out. The filesystem half is `HOOK` in `main.ts`.
 */

import { HOOK_IN_REPO } from '../../../cli/src/hookModes';
import { isPlainObject } from '../../../cli/src/json';
import { shQuote } from '../../../cli/src/text';
import { unreadable } from './decide';
import { renderHookOutput } from './hookOutput';
import type { HookBlock } from './register';

/**
 * Quote one argument for the shell that runs the hook command. `settings.json` carries the command
 * as one string, so an unquoted path with a space (`~/Documents/claude Code/...`) splits and the
 * hook never launches. Defined in `cli/src/text.ts`, which `cli/` uses and never imports from here.
 */
export { shQuote };

/**
 * Split a `settings.json` command string into arguments, undoing `shQuote`. A substring test is not
 * enough: the registered path and this file's `import.meta.url` can spell one file differently (a
 * symlinked home, `/tmp` against `/private/tmp`), and `realpath` needs a token to resolve.
 */
export function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  let escaped = false;
  for (const ch of command) {
    if (escaped) { current += ch; escaped = false; started = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    // `shQuote` writes an apostrophe as `'\''` -- close, escaped quote, reopen -- so a backslash
    // OUTSIDE quotes escapes the next character, exactly as the shell reads it. Without this the
    // round trip these two functions declare is broken for any path containing an apostrophe, and
    // the failure is the bad one: the registration reads as absent on a working install.
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The words that start the wrapper, as every version writes it and `readCommand` reads it. */
export const LAUNCHER = ['/bin/sh', '-c'] as const;

/**
 * The wrapper's `$0`. It is what `sh` prefixes its own error messages with, so a wrapper failure
 * says whose it is, and it is the word `readCommand` recognises the wrapper by.
 */
export const FAIL_CLOSED_NAME = 'draftgate-hook';

/**
 * The fail-closed wrapper, `$1` the interpreter, `$2` the hook, `$3`..`$5` the three `ask`s.
 *
 * The buffer is opened TWICE and unlinked before the hook runs: fd 3 for the hook to write, fd 4 for
 * `cat` to read back from the start. So no name for it exists while anything can be written to it,
 * and nothing is left behind however the wrapper dies, SIGKILL included -- with no trap to keep in
 * step with the signals. Neither descriptor reaches the hook (`3>&- 4<&-`), so its children cannot
 * hold the file open either. The redirections are on a `{ ... }` group rather than an `exec`: a
 * redirection that fails on `exec` makes POSIX `sh` EXIT, non-zero, which is the fail-open again;
 * on a group it is only a failed command, and the causes below still answer.
 *
 * One line, because it is read inside a JSON string in somebody's `settings.json`. No single quote
 * anywhere in it, so `shQuote` leaves it as written and a reader sees the script rather than `'\''`
 * escapes. `hookCommand.test.ts` runs it under sh, bash and zsh against a fake hook for every
 * behaviour listed in the header.
 */
export const FAIL_CLOSED_SCRIPT = [
  'o=$(mktemp "${TMPDIR:-/tmp}/draftgate-hook.XXXXXX" || mktemp /tmp/draftgate-hook.XXXXXX) || { printf "%s\\n" "$5"; exit 0; }',
  '{ rm -f "$o"; if "$1" "$2" >&3 3>&- 4<&-; then cat <&4 3>&- 4<&-; exit 0; fi; } 3>"$o" 4<"$o"',
  'if [ ! -f "$2" ]; then printf "%s\\n" "$3"; elif [ ! -x "$1" ]; then printf "%s\\n" "$4"; else printf "%s\\n" "$5"; fi',
  'exit 0',
].join('; ');

/**
 * Where bun is looked for when PATH has none, in order: where bun's own installer puts it, then
 * Homebrew's two prefixes. `sh` is the word the script tests, `shown` how a message names the place.
 */
export const BUN_PLACES = [
  { sh: '"$HOME/.bun/bin/bun"', shown: '~/.bun/bin' },
  { sh: '/opt/homebrew/bin/bun', shown: '/opt/homebrew/bin' },
  { sh: '/usr/local/bin/bun', shown: '/usr/local/bin' },
] as const;

/**
 * Sets `b` to the first bun that is an executable file: PATH's, then `BUN_PLACES`; empty when there
 * is none. Shared by the hook and the launcher.
 */
export const FIND_BUN =
  `b=; for c in "$(command -v bun 2>/dev/null)" ${BUN_PLACES.map((p) => p.sh).join(' ')}; ` +
  'do if [ -f "$c" ] && [ -x "$c" ]; then b=$c; break; fi; done';

/** The plugin wrapper's first statement: the hook, under the root it is given as `$1`. */
const PLUGIN_FINDS_HOOK = `h="$1/${HOOK_IN_REPO}"`;

/**
 * The plugin wrapper: `$1` the plugin root, `$2`..`$4` the three `ask`s (hook missing, no bun, no
 * decision). It finds the hook and bun, exports the root as `DRAFTGATE_PLUGIN_ROOT` (`pluginRootOf`,
 * whether or not Claude Code sets `CLAUDE_PLUGIN_ROOT` for the hook), then `set --` hands
 * `FAIL_CLOSED_SCRIPT` its five arguments. With no bun, `$1` is empty and `[ ! -x "$1" ]` names the
 * cause; with no hook, `[ ! -f "$2" ]` does. One line with no single quote, like that script.
 */
export const PLUGIN_FAIL_CLOSED_SCRIPT = [
  PLUGIN_FINDS_HOOK,
  FIND_BUN,
  'export DRAFTGATE_PLUGIN_ROOT="$1"',
  'set -- "$b" "$h" "$2" "$3" "$4"',
  FAIL_CLOSED_SCRIPT,
].join('; ');

/**
 * The hook's path inside its checkout, for the moved-checkout fix, which cannot name the new place,
 * and for recognising another checkout's entry (`classifyEntry`). Spelled once, in `cli/`.
 * `hook.test.ts` asserts the real hook's path ends with it.
 */
export const HOOK_IN_CHECKOUT = HOOK_IN_REPO;

/** The checkout a hook path sits in, with its trailing slash, or null for a path no checkout has. */
export function checkoutRootOf(hook: string): string | null {
  return hook.endsWith(`/${HOOK_IN_CHECKOUT}`) ? hook.slice(0, -HOOK_IN_CHECKOUT.length) : null;
}

/** A registered command, read back once, for the three questions `registration.ts` asks of it. */
export interface RegisteredCommand {
  /**
   * The words that say what it launches: the settings wrapper's `$1` and `$2`, the hook under the
   * plugin wrapper's root (bun is found at run time), or every word otherwise. The hook is last.
   */
  launched: string[];
  /**
   * The text a substring test may search for the hook's path: the whole command, or nothing for the
   * wrapper, whose three messages name the hook whatever its `$2` runs.
   */
  searchable: string;
  /**
   * Whether it is the wrapper at all, in any version: `LAUNCHER`, a script, then `FAIL_CLOSED_NAME`.
   * That `$0` is draftgate's own word, so `register` recognises an entry for a checkout that moved.
   */
  wrapped: boolean;
  /** Whether it is the current wrapper with an `ask` for every cause. See `isFailClosed`. */
  failClosed: boolean;
  /** The plugin root a plugin wrapper names: `${CLAUDE_PLUGIN_ROOT}` in the plugin's file. */
  pluginRoot?: string;
}

/**
 * Parse a registered command once. The wrapper is recognised by shape (`LAUNCHER`, then a script,
 * then `FAIL_CLOSED_NAME`), so an older or edited wrapper still reports what it launches; whether it
 * fails closed is the stricter question below.
 */
export function readCommand(command: string): RegisteredCommand {
  const t = commandTokens(command);
  const wrapped =
    t.length >= 6 && t[0] === LAUNCHER[0] && t[1] === LAUNCHER[1] && t[3] === FAIL_CLOSED_NAME;
  if (!wrapped) return { launched: t, searchable: command, wrapped: false, failClosed: false };
  // The plugin wrapper, told by its first statement; its one argument is the root. It is in a
  // settings file as the extra-tools entry (`extraToolsBlock`), and in the plugin's own file with
  // the root left as `${CLAUDE_PLUGIN_ROOT}`.
  if (t[2]!.startsWith(`${PLUGIN_FINDS_HOOK};`)) {
    return {
      launched: [`${t[4]!}/${HOOK_IN_REPO}`],
      searchable: '',
      wrapped: true,
      pluginRoot: t[4]!,
      failClosed: failsClosedAs(t, PLUGIN_FAIL_CLOSED_SCRIPT, 1),
    };
  }
  return {
    launched: [t[4]!, t[5]!],
    searchable: '',
    wrapped: true,
    // On the parsed words, not string equality with what the writer prints: the messages name
    // paths, and an entry from a sibling checkout is still fail-closed. Required: the current
    // script, and three arguments that each parse as an `ask` (a dropped one prints an empty line,
    // which Claude Code reads as no decision). Any other script is not, and `--doctor` says
    // `register`.
    failClosed: failsClosedAs(t, FAIL_CLOSED_SCRIPT, 2),
  };
}

/** Does this registered command fail CLOSED -- is it the wrapper, with an `ask` for every cause? */
export function isFailClosed(command: string): boolean {
  return readCommand(command).failClosed;
}

/**
 * One `ask` a wrapper prints for a cause it tells apart, through the hook's own `renderHookOutput`,
 * newline-free because the script adds it.
 */
export function wrapperAsk(cause: string, fix: string): string {
  return renderHookOutput(unreadable(cause, fix)).trimEnd();
}

/** How many causes a wrapper tells apart, each with its own `ask` as a trailing argument. */
const WRAPPER_ASKS = 3;

/**
 * Do these words make a wrapper running `script` that fails closed: the launcher, `script`,
 * `FAIL_CLOSED_NAME`, `fixed` arguments of its own, then an `ask` for every cause? For the settings
 * wrapper (`readCommand`) and the plugin's (`isPluginFailClosed`).
 */
export function failsClosedAs(t: readonly string[], script: string, fixed: number): boolean {
  return (
    t.length === 4 + fixed + WRAPPER_ASKS &&
    t[0] === LAUNCHER[0] &&
    t[1] === LAUNCHER[1] &&
    t[2] === script &&
    t[3] === FAIL_CLOSED_NAME &&
    t.slice(4 + fixed).every(isAskDecision)
  );
}

/**
 * A `PreToolUse` block with draftgate's one command entry: the settings registration's
 * (`extraToolsBlock`) and the plugin's (`pluginHooksFile`), so the entry's fields are written once.
 * The `statusMessage` ends in no ellipsis: Claude Code's spinner adds its own `…` after it (seen on
 * 2.1.302), so `...` here reads `review...…`.
 */
export function hookBlock(matcher: string, command: string, timeoutS: number): HookBlock {
  return {
    matcher,
    hooks: [{ type: 'command', command, timeout: timeoutS, statusMessage: 'Waiting for draftgate review' }],
  };
}

function isAskDecision(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.hookSpecificOutput)) return false;
    const out = parsed.hookSpecificOutput;
    return out.hookEventName === 'PreToolUse' && out.permissionDecision === 'ask';
  } catch {
    return false;
  }
}
