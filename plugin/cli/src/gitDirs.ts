/**
 * Where a checkout's git directories are, read off its `.git` and never by running `git`: both
 * callers are on a review's path. The hook's `checkoutOf` asks which repository a registration's
 * file belongs to, and `releaseCheck.ts`'s `headCommit` which commit HEAD names.
 *
 * A main checkout's `.git` is a directory, and it is both answers. A linked worktree's is a file,
 * `gitdir: <path>`, naming the worktree's own git dir, whose `commondir` file names the shared one,
 * relative to it. HEAD lives in `gitDir`; branches, tags and the config in `commonDir`.
 *
 * Null for a `.git` file that names nothing. A `.git` that cannot be read throws: each caller turns
 * any failure into its own "cannot say".
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface GitDirs {
  gitDir: string;
  commonDir: string;
  /** A linked worktree, whose `.git` is a file. */
  worktree: boolean;
}

export function gitDirs(root: string): GitDirs | null {
  const dotGit = join(root, '.git');
  if (statSync(dotGit).isDirectory()) return { gitDir: dotGit, commonDir: dotGit, worktree: false };
  const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!named) return null;
  const gitDir = resolve(root, named[1]!);
  const common = join(gitDir, 'commondir');
  const commonDir = existsSync(common)
    ? resolve(gitDir, readFileSync(common, 'utf8').trim())
    : gitDir;
  return { gitDir, commonDir, worktree: true };
}
