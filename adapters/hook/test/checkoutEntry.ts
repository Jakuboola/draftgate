/**
 * A checkout install's settings entry: the fail-closed wrapper (`FAIL_CLOSED_SCRIPT`) launching a
 * checkout's hook under an absolute bun, with the merged map's matcher and the three `ask`s baked
 * in. draftgate writes none (it installs as a plugin), but a user's settings can hold one, and
 * `registration.ts`, `--doctor`, `register` and `uninstall` read it, so the tests build it here
 * word for word.
 *
 * Not a test file: `bun test` runs `*.test.ts`, and this is imported by them.
 */

import {
  FAIL_CLOSED_NAME, FAIL_CLOSED_SCRIPT, LAUNCHER, checkoutRootOf, hookBlock, shQuote, wrapperAsk,
} from '../src/hookCommand';
import { CLI_IN_REPO, HOOK_ENTRY } from '../../../cli/src/hookModes';
import { REMEDY } from '../../../core/src/remedies';
import type { HookBlock } from '../src/register';
import { matcherFor, type ToolMap } from '../src/toolMap';
import { hookTimeoutSecondsFor } from '../src/main';
import { DEFAULT_TIMEOUT_MS } from '../../../cli/src/review';

/** What the entry runs, as data: the interpreter and the hook, both absolute paths. */
export interface HookLaunch {
  interpreter: string;
  hook: string;
}

/**
 * The three `ask` decisions the wrapper can print, one per cause, each naming the fix
 * (`wrapperAsk`) with the CLI by full path: when the checkout is gone, `draftgate` on PATH, a link
 * into it, is gone with it.
 */
export function fallbackDecisions(launch: HookLaunch): {
  hookGone: string;
  interpreterGone: string;
  noDecision: string;
} {
  const cli = `${checkoutRootOf(launch.hook) ?? '<checkout>/'}${CLI_IN_REPO}`;
  return {
    hookGone: wrapperAsk(
      `its hook cannot be found or read at ${launch.hook}`,
      'If the checkout has moved, run ' +
        `${REMEDY.cli(shQuote(`<checkout>/${CLI_IN_REPO}`), 'install')} from where it is now. ` +
        'If it is still there, this process may not be allowed to read it.'
    ),
    interpreterGone: wrapperAsk(
      `its hook runs under ${launch.interpreter}, which is not there any more`,
      `Install bun again, then run ${REMEDY.cli(shQuote(cli), 'register')}.`
    ),
    noDecision: wrapperAsk(
      `its hook (${launch.hook}) stopped without answering`,
      `To see why, run ${REMEDY.cli(shQuote(cli), 'doctor')} in a terminal.`
    ),
  };
}

/** The entry's `command`: the bare launch, inside the fail-closed wrapper. */
export function failClosedCommand(launch: HookLaunch): string {
  const asks = fallbackDecisions(launch);
  return [
    ...LAUNCHER,
    shQuote(FAIL_CLOSED_SCRIPT),
    FAIL_CLOSED_NAME,
    shQuote(launch.interpreter),
    shQuote(launch.hook),
    shQuote(asks.hookGone),
    shQuote(asks.interpreterGone),
    shQuote(asks.noDecision),
  ].join(' ');
}

/** Where the entry's hook is, and the `timeout` it carries: by default the one for the default deadline. */
export interface CheckoutEntryOptions {
  hook?: string;
  timeoutS?: number;
}

/** The entry for `map`, launching `hook` (this checkout's by default) under this bun. */
export function checkoutBlock(
  map: ToolMap,
  { hook = HOOK_ENTRY, timeoutS = hookTimeoutSecondsFor(DEFAULT_TIMEOUT_MS) }: CheckoutEntryOptions = {}
): HookBlock {
  return hookBlock(matcherFor(map), failClosedCommand({ interpreter: process.execPath, hook }), timeoutS);
}

/** A settings file holding that entry and nothing else, as JSON text. */
export function checkoutSettings(map: ToolMap, opts: CheckoutEntryOptions = {}): string {
  return JSON.stringify({ hooks: { PreToolUse: [checkoutBlock(map, opts)] } }, null, 2);
}
