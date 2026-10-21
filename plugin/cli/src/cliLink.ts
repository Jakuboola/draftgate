/**
 * A `draftgate` link on PATH to a checkout's `cli/src/main.ts`, found and taken out by
 * `draftgate uninstall`. Nothing here makes one: the plugin needs no link, since Claude Code puts the
 * plugin's `bin/` on the Bash tool's PATH.
 */

import { lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonical } from './paths';

export const LINK_NAME = 'draftgate';

/**
 * The two directories a checkout's link is in first, which `unlinkCli` looks in even when PATH
 * does not list them.
 */
const preferredBinDirs = (home: string) => [join(home, '.local', 'bin'), join(home, 'bin')] as const;

/**
 * Where a link points, as the place it names (`canonical`): its target may be relative to the
 * directory holding the link, and may not exist -- a moved checkout's link dangles.
 */
const linkTarget = (link: string) => canonical(resolve(dirname(link), readlinkSync(link)));

export interface UnlinkResult {
  /** The links taken out. */
  removed: string[];
  /** Every other `draftgate` found where a link could be, and what it is: left as it was. */
  left: { path: string; is: string }[];
  /** Links that should have gone and could not be removed, with why. */
  failed: { path: string; why: string }[];
}

/**
 * Take out the `draftgate` links whose target `ours` claims: every directory on PATH, plus
 * `preferredBinDirs`. Nothing records where the link is, and the PATH it was chosen from may not be
 * this one.
 *
 * Only a symlink `ours` claims is removed: a regular file, or a link to another checkout, is
 * somebody else's `draftgate`, and is named in `left` so the caller can say what still answers to
 * `draftgate`. A dangling link is judged by where it points.
 */
export function unlinkCli(
  ours: (target: string) => boolean,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {}
): UnlinkResult {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const dirs = [...(env.PATH ?? '').split(':'), ...preferredBinDirs(home)];
  const result: UnlinkResult = { removed: [], left: [], failed: [] };
  const seen = new Set<string>();
  for (const raw of dirs) {
    const dir = raw.trim();
    if (dir === '' || seen.has(dir)) continue;
    seen.add(dir);
    const path = join(dir, LINK_NAME);
    let stat;
    try {
      stat = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (stat === undefined) continue;
    if (!stat.isSymbolicLink()) {
      result.left.push({ path, is: 'a regular file, not a link' });
      continue;
    }
    const target = linkTarget(path);
    if (!ours(target)) {
      result.left.push({ path, is: `a link to ${target}` });
      continue;
    }
    try {
      unlinkSync(path);
      result.removed.push(path);
    } catch (e) {
      result.failed.push({ path, why: (e as Error).message });
    }
  }
  return result;
}

/** Is `target` this checkout's CLI? By the place it names, as a link's target is read. */
export function isThisCli(entry: string): (target: string) => boolean {
  const cli = canonical(entry);
  return (target) => target === cli;
}
