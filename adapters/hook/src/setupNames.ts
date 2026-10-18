/**
 * The tool names setup's first `--propose-tools <names>` run keeps for the `--write` that records
 * the answer, so the agent types them once: it types every name it passes, and a session can hold
 * hundreds.
 *
 * Kept for one Claude Code session. A `--write` from another session, or from a terminal, never
 * records an answer about names it was not shown.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { draftgateHome, writePrivateFile } from '../../../cli/src/audit';
import { SETUP_NAMES_BASENAME } from '../../../cli/src/hookModes';
import { isPlainObject } from '../../../cli/src/json';

/** The variable Claude Code sets for every command its Bash tool runs, naming the session. */
export const SESSION_VAR = 'CLAUDE_CODE_SESSION_ID';

const keptPath = () => join(draftgateHome(), SETUP_NAMES_BASENAME);

/**
 * Keep `names` for this session's `--write`. Nothing outside a Claude Code session, which no
 * `--write` could read back. An error when it could not be written.
 */
export function keepSetupNames(names: string[]): Error | null {
  const session = process.env[SESSION_VAR];
  if (!session) return null;
  return writePrivateFile(keptPath(), JSON.stringify({ session, names }) + '\n');
}

/** The names this session kept, or null: none kept, another session's, or a file it cannot read. */
export function keptSetupNames(): string[] | null {
  const session = process.env[SESSION_VAR];
  if (!session) return null;
  try {
    const kept: unknown = JSON.parse(readFileSync(keptPath(), 'utf8'));
    if (!isPlainObject(kept) || kept.session !== session || !Array.isArray(kept.names)) return null;
    // None is an answer too: a session with no send tool still records one.
    return kept.names.filter((n): n is string => typeof n === 'string');
  } catch {
    return null;
  }
}

/**
 * Remove the kept names once their answer is written: that setup run is over. A file that stays is
 * still its session's only, so failing to remove it is not worth failing the write that succeeded.
 */
export function forgetSetupNames(): void {
  try {
    rmSync(keptPath(), { force: true });
  } catch {}
}
