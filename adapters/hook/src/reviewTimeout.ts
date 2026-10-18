/**
 * The ceiling on a review deadline: what the registration that has to outlive it can afford.
 *
 * The want is `cli/src/reviewConfig.ts` (`reviewSeconds`, the operator's). The deadline also exists
 * as the registration's `timeout`, and if draftgate's is the longer, Claude Code aborts the hook,
 * which is fail-open: the agent's original input goes ahead and nothing is drawn (`main.ts`,
 * `hookTimeoutSecondsFor`). In `auto` mode what catches it is the soft block "External System
 * Writes", which a send the user asked for clears. So `registration.ts` reads the registered timeout
 * back and this module takes the smaller; a forgotten re-register costs a shorter review, shown by
 * the countdown and named by the timeout denial, and `DEFAULT_TIMEOUT_MS` can change safely.
 *
 * ## When no registration can be found
 *
 * `ours: []` happens on working installs. Verified in 2.1.268: hooks from a plugin, and
 * `claude --settings <file>`, are paths `settingsPaths` does not enumerate; an unreadable
 * `~/.claude/settings.json` (macOS TCC on a `-rw-------` file) is another. Claude Code gave such an
 * entry at most the event default (600s), so the deadline is that less its grace. Not
 * `DEFAULT_TIMEOUT_MS`: at 1200s it outlasts a registration printed for a ten-minute deadline (660s).
 */

import { REMEDY } from '../../../core/src/remedies';
import { oneLine } from '../../../cli/src/text';
import { EVENT_DEFAULT_TIMEOUT_MS } from './registration';

/**
 * The longest review a plugin install can give. Its `hooks/hooks.json` is the same file on every
 * machine, so its `timeout` is this plus the grace and a longer `reviewSeconds` is clamped to it.
 * Generous, because draftgate's own timer always fires first.
 */
export const PLUGIN_REVIEW_CEILING_MS = 60 * 60 * 1000;

/**
 * The margin between the review deadline and the registration that has to outlive it.
 *
 * 60s is what `hookTimeoutSecondsFor` adds, so a registration written for a deadline yields back
 * exactly that deadline. The fraction is for a registration under ten minutes: `timeout: 30` would
 * otherwise compute a negative deadline.
 */
export const GRACE_MS = 60_000;
export const GRACE_FRACTION = 0.1;

export function graceFor(registeredMs: number): number {
  return Math.min(GRACE_MS, Math.round(registeredMs * GRACE_FRACTION));
}

/**
 * The most a review may get when no registration could be found: the event default (the longest an
 * unseen registration is known to allow, not `DEFAULT_TIMEOUT_MS`) less its grace. Through
 * `graceFor`, so a change to `GRACE_FRACTION` cannot leave this ceiling too long.
 */
export const UNREGISTERED_CEILING_MS = EVENT_DEFAULT_TIMEOUT_MS - graceFor(EVENT_DEFAULT_TIMEOUT_MS);

/** One ms value as whole seconds, for the two places that report a deadline to a human. */
export const asSeconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** Why the deadline ended up where it did. Every branch is reportable; none is silent. */
export type DeadlineBasis =
  /** The registration allows what was asked for. */
  | { kind: 'asked' }
  /** The registration is shorter than what was asked for, so it decided. */
  | { kind: 'clamped'; registeredMs: number }
  /** No registration could be found, so the event default is the most that can be assumed. */
  | { kind: 'unregistered' };

export interface Deadline {
  ms: number;
  basis: DeadlineBasis;
  /** What was asked for, kept so a report can say what was given up. */
  wantedMs: number;
}

/**
 * The review deadline: the smallest of what was asked for and what the registration can outlive.
 * `registeredMs` undefined is not "no ceiling": it gets `UNREGISTERED_CEILING_MS`.
 */
export function reviewDeadline(wantedMs: number, registeredMs: number | undefined): Deadline {
  if (registeredMs === undefined) {
    // `basis` is what was known, not what the arithmetic produced: derived from `ms < wantedMs`, a
    // default install would report `asked` and print nothing.
    return { ms: Math.min(wantedMs, UNREGISTERED_CEILING_MS), wantedMs, basis: { kind: 'unregistered' } };
  }
  const ceiling = registeredMs - graceFor(registeredMs);
  if (ceiling >= wantedMs) return { ms: wantedMs, wantedMs, basis: { kind: 'asked' } };
  return { ms: Math.max(1, ceiling), wantedMs, basis: { kind: 'clamped', registeredMs } };
}

/** Where a review runs from, which decides what lengthens a clamped deadline. */
export interface DeadlineFrom {
  plugin: boolean;
  /** The review config, where `reviewSeconds` is asked for. */
  configPath: string;
}

/**
 * What to do about a clamped deadline, for the per-review note and `--doctor`. The clamp takes the
 * shortest registration and the plugin's grants exactly the ceiling, so from the plugin a shorter
 * clamp is another draftgate entry (`/draftgate:setup` replaces it) and one at the ceiling is the
 * plugin's fixed timeout. A checkout registers nothing, so from one the fix is the plugin.
 */
export function clampRemedy(grantedMs: number, from: DeadlineFrom): string {
  if (!from.plugin) return `Install the plugin: ${REMEDY.installPlugin}.`;
  if (grantedMs < PLUGIN_REVIEW_CEILING_MS) {
    return `Another draftgate entry in Claude Code's settings has a shorter timeout: ${REMEDY.pluginSetup} replaces it.`;
  }
  return `The plugin's timeout is fixed: ask for at most ${asSeconds(grantedMs)} in ${oneLine(from.configPath)}.`;
}

/** One line for the human at the keyboard, or null when there is nothing to say. */
export function deadlineNote(deadline: Deadline, from: DeadlineFrom): string | null {
  const shown = asSeconds(deadline.ms);
  const asked = asSeconds(deadline.wantedMs);
  switch (deadline.basis.kind) {
    case 'asked':
      return null;
    case 'clamped':
      return (
        `draftgate: this review gets ${shown}, not the ${asked} configured -- the registered hook ` +
        `timeout is ${Math.round(deadline.basis.registeredMs / 1000)}s and must outlive it. ` +
        clampRemedy(deadline.ms, from)
      );
    case 'unregistered':
      // Only when it cost something; `registrationNote` already says no registration was found.
      if (deadline.ms >= deadline.wantedMs) return null;
      return (
        `draftgate: this review gets ${shown}, not the ${asked} configured -- no registration for ` +
        'this hook could be found, so the deadline cannot be extended past the event default. ' +
        `Run ${REMEDY.doctor}.`
      );
  }
}
