/**
 * The plugin's own files: the fixed `hooks/hooks.json` and the `bin/draftgate` launcher Claude Code
 * puts on the Bash tool's PATH. Both are generated from here (`--print-plugin-hooks`,
 * `--print-plugin-launcher`) and committed under `plugin/`; `pluginHooks.test.ts` fails when a
 * committed file differs.
 *
 * The fail-closed wrapper, recast for a file that is the same on every machine:
 *
 *  - The matcher is the default map's (`pluginMatcher`), never the merged one. An alias of a known
 *    tool half under any server is matched by the inferred branch; a new half in `tools.json` is
 *    not, and `doctor` names such a tool.
 *  - The timeout is fixed, so it is a ceiling (`PLUGIN_REVIEW_CEILING_MS`), read back by
 *    `registration.ts` like any registration.
 *  - The root is `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes as plain text before `sh`
 *    reads it; double-quoted, so a root with a space stays one word.
 *  - bun is found, not named (`FIND_BUN`): a plugin cannot install bun, and a hook's PATH depends on
 *    how Claude Code was started.
 *  - The three `ask`s name no path.
 *
 * Buffering, replay on exit 0 and the three causes are `FAIL_CLOSED_SCRIPT`'s, run as written, so
 * `hookCommand.test.ts` covers both wrappers. The file's `SessionStart` hook keeps draftgate's plugin
 * link current (`PLUGIN_SESSION_SCRIPT`).
 *
 * No wrapper closes this: when the plugin's version folder is gone, Claude Code skips the hook
 * ("Plugin directory does not exist") and the tool runs.
 *
 * Pure: strings in, strings out.
 */

import { REMEDY } from '../../../core/src/remedies';
import { either } from '../../../cli/src/text';
import { CLI_IN_REPO, HOOK_IN_REPO, PLUGIN_LINK_BASENAME } from '../../../cli/src/hookModes';
import {
  BUN_PLACES,
  FAIL_CLOSED_NAME,
  FIND_BUN,
  LAUNCHER,
  PLUGIN_FAIL_CLOSED_SCRIPT,
  hookBlock,
  readCommand,
  shQuote,
  wrapperAsk,
} from './hookCommand';
import type { HookBlock } from './register';
import { DEFAULT_TOOL_MAP, matcherCovers, matcherFor, toolHalvesOf, type ToolMap } from './toolMap';

/** What Claude Code substitutes the plugin's root for. Kept literal in the command. */
export const PLUGIN_ROOT_REF = '${CLAUDE_PLUGIN_ROOT}';

/** The two generated files, where they sit inside the plugin root. */
export const PLUGIN_HOOKS_IN_ROOT = 'hooks/hooks.json';
export const PLUGIN_LAUNCHER_IN_ROOT = 'bin/draftgate';

/** The plugin's matcher: the DEFAULT map's, the same on every machine. */
export function pluginMatcher(): string {
  return matcherFor(DEFAULT_TOOL_MAP);
}

/** Where `FIND_BUN` looked, as a message names it. */
const BUN_SEARCHED = `on PATH, in ${either(BUN_PLACES.map((p) => p.shown))}`;

/**
 * The three `ask`s the plugin wrapper prints. Where the command is registered decides the fix for a
 * missing hook: the plugin's own file, installing again; the extra-tools entry (`extraToolsBlock`),
 * setup again, which points draftgate's plugin link at the installed version.
 */
export function pluginFallbackDecisions(
  registeredIn: 'plugin' | 'settings' = 'plugin'
): { hookGone: string; bunGone: string; noDecision: string } {
  return {
    hookGone:
      registeredIn === 'plugin'
        ? wrapperAsk(
            'its plugin files are incomplete: the hook is missing or cannot be read',
            `Install the draftgate plugin again (${REMEDY.pluginManager}), then run ${REMEDY.reloadPlugins}.`
          )
        : wrapperAsk(
            'the draftgate plugin this tool was set up with cannot be found',
            `Run ${REMEDY.pluginSetup} again: it points this tool at the version installed now.`
          ),
    bunGone: wrapperAsk(
      `it needs bun, and no bun was found (${BUN_SEARCHED})`,
      `Install bun in a terminal (${REMEDY.installBun}), then start a new session.`
    ),
    noDecision: wrapperAsk(
      'its hook stopped without answering',
      `To see why, ask Claude Code to run ${REMEDY.doctor}.`
    ),
  };
}

/**
 * A plugin wrapper command: the wrapper, the root as its one own argument, the three `ask`s. The
 * plugin's file passes `"${CLAUDE_PLUGIN_ROOT}"` for Claude Code to fill in; a settings entry
 * passes the root itself, quoted once.
 */
function pluginWrapperCommand(root: string, asks: ReturnType<typeof pluginFallbackDecisions>): string {
  return [
    ...LAUNCHER,
    shQuote(PLUGIN_FAIL_CLOSED_SCRIPT),
    FAIL_CLOSED_NAME,
    root,
    shQuote(asks.hookGone),
    shQuote(asks.bunGone),
    shQuote(asks.noDecision),
  ].join(' ');
}

/** The plugin hook's `command`. */
export function pluginHookCommand(): string {
  return pluginWrapperCommand(`"${PLUGIN_ROOT_REF}"`, pluginFallbackDecisions());
}

/** The `SessionStart` script's `$0`, what `sh` prefixes its own error messages with. */
const SESSION_NAME = 'draftgate-session';

/** Seconds Claude Code gives the `SessionStart` hook: a `readlink`, and at most one link made. */
export const PLUGIN_SESSION_TIMEOUT_S = 10;

/**
 * The plugin's `SessionStart` hook: point draftgate's plugin link (`PLUGIN_LINK_BASENAME`, in
 * `$DRAFTGATE_HOME` or `~/.draftgate`, as `draftgateHome` resolves it) at `$1`, this session's plugin
 * root. The extra-tools entry runs the hook through that link, so after an update it follows the new
 * version from the next session on.
 *
 *  - It only refreshes a link that is there: `register` makes and removes it with the entry, so a
 *    machine `uninstall` cleaned stays clean while the plugin is enabled.
 *  - Only to a root that holds the hook, so an empty root never replaces a working one.
 *  - The new link is renamed over the old (`mv -h`: rename(2), which does not follow the old link),
 *    so a review in another session finds the old root or the new one, never neither.
 *  - It prints nothing (a `SessionStart` hook's stdout is context for the model) and exits 0
 *    whatever happens. Plain `sh`, no bun. One line with no single quote.
 */
export const PLUGIN_SESSION_SCRIPT = [
  'exec >/dev/null 2>&1',
  `l="\${DRAFTGATE_HOME:-$HOME/.draftgate}/${PLUGIN_LINK_BASENAME}"`,
  `[ -L "$l" ] && [ -f "$1/${HOOK_IN_REPO}" ] || exit 0`,
  '[ "$(readlink "$l")" = "$1" ] && exit 0',
  't="$l.$$"',
  'rm -f "$t"',
  'ln -s "$1" "$t" && mv -fh "$t" "$l" || rm -f "$t"',
  'exit 0',
].join('; ');

/** The `SessionStart` hook's `command`, the root left for Claude Code to fill in. */
export function pluginSessionCommand(): string {
  return [...LAUNCHER, shQuote(PLUGIN_SESSION_SCRIPT), SESSION_NAME, `"${PLUGIN_ROOT_REF}"`].join(' ');
}

/**
 * `hooks/hooks.json`, whole: the review hook, and the `SessionStart` hook that keeps the plugin link
 * current. `timeoutS` is the ceiling a configured `reviewSeconds` can reach.
 */
export function pluginHooksFile(timeoutS: number): string {
  const block = hookBlock(pluginMatcher(), pluginHookCommand(), timeoutS);
  // A new session or a resumed one: `/clear` and compaction keep the process, and so the root.
  const session = {
    matcher: 'startup|resume',
    hooks: [{ type: 'command', command: pluginSessionCommand(), timeout: PLUGIN_SESSION_TIMEOUT_S }],
  };
  return JSON.stringify({ hooks: { PreToolUse: [block], SessionStart: [session] } }, null, 2) + '\n';
}

/**
 * Is this the plugin's own command, with an `ask` for every cause? The plugin wrapper as
 * `readCommand` reads it, with its root left for Claude Code to fill in.
 */
export function isPluginFailClosed(command: string): boolean {
  const read = readCommand(command);
  return read.failClosed && read.launched[0] === `${PLUGIN_ROOT_REF}/${HOOK_IN_REPO}`;
}

/**
 * The tools in `map` the plugin's own matcher does not fire for: `tools.json` entries whose tool
 * half the default map does not have.
 */
export function uncoveredByPlugin(map: ToolMap): ToolMap {
  const plugin = pluginMatcher();
  return Object.fromEntries(Object.entries(map).filter(([name]) => !matcherCovers(plugin, name)));
}

/**
 * The one settings entry `register` writes beside the plugin, or null when the plugin's hook covers
 * every tool in `map`. It matches only the tools the plugin does not (their names, and their new
 * halves under any server), so no tool fires both hooks (`firesTwiceOf`).
 *
 * The command is the plugin's wrapper with `link` as its root, since a settings entry gets no
 * `CLAUDE_PLUGIN_ROOT`: draftgate's plugin link, kept on the running version by
 * `PLUGIN_SESSION_SCRIPT` (a version folder stops working once Claude Code removes it after an
 * update). A dangling link leaves the wrapper no hook, and it asks. The timeout is the plugin's
 * ceiling, so this entry never shortens a review.
 */
export function extraToolsBlock(map: ToolMap, link: string, timeoutS: number): HookBlock | null {
  const extra = uncoveredByPlugin(map);
  if (Object.keys(extra).length === 0) return null;
  const known = new Set(toolHalvesOf(DEFAULT_TOOL_MAP));
  const matcher = matcherFor(extra, toolHalvesOf(extra).filter((h) => !known.has(h)));
  return hookBlock(matcher, pluginWrapperCommand(shQuote(link), pluginFallbackDecisions('settings')), timeoutS);
}

/**
 * `bin/draftgate`, whole: the `draftgate` an agent runs. It finds bun as the hook does and runs the
 * CLI with the root in `DRAFTGATE_PLUGIN_ROOT` (the Bash tool gets no `CLAUDE_PLUGIN_ROOT`, and
 * `doctor` reads the plugin's registration from it). Without bun it says how to install it and
 * exits 1.
 */
export function pluginLauncher(): string {
  const noBun =
    'draftgate: bun is not installed, and draftgate runs on it. In a terminal, run ' +
    `${REMEDY.installBun}, then start a new Claude Code session.`;
  return [
    '#!/bin/sh',
    '# draftgate, on the Bash tool\'s PATH while the plugin is enabled. Generated from',
    '# adapters/hook/src/pluginHooks.ts; it finds bun the way the plugin\'s hook does.',
    'root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1',
    FIND_BUN,
    'if [ -z "$b" ]; then',
    `  printf '%s\\n' ${shQuote(noBun)} >&2`,
    '  exit 1',
    'fi',
    `DRAFTGATE_PLUGIN_ROOT=$root exec "$b" "$root/${CLI_IN_REPO}" "$@"`,
    '',
  ].join('\n');
}

/**
 * The plugin root this process runs from, or null. Candidates: `CLAUDE_PLUGIN_ROOT` (set by Claude
 * Code for a plugin's hook) and `DRAFTGATE_PLUGIN_ROOT` (set by the plugin wrapper and
 * `bin/draftgate`). One counts only when its hook is `hookPath`: an inherited variable naming another
 * root would vouch for a timeout nothing enforces.
 */
export function pluginRootOf(
  env: NodeJS.ProcessEnv,
  hookPath: string,
  realpath: (p: string) => string | null
): string | null {
  const self = realpath(hookPath) ?? hookPath;
  for (const root of [env.CLAUDE_PLUGIN_ROOT, env.DRAFTGATE_PLUGIN_ROOT]) {
    if (root && realpath(`${root}/${HOOK_IN_REPO}`) === self) return root;
  }
  return null;
}
