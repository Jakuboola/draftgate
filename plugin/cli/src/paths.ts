/**
 * Which place a path names, for comparing two of them, shared by `cliLink.ts` and `uninstall.ts`.
 *
 * Two spellings of one place are the ordinary case: `$TMPDIR` is under `/var -> /private/var`, a
 * home can be on a symlinked volume, and a checkout's own path comes from bun already resolved.
 * Compared as spellings, `draftgate uninstall` says the checkout it is about to delete will survive.
 * A path that does not exist (a dangling link's target, a directory just deleted) is the real path
 * of its deepest existing ancestor with the rest appended, so it compares the same after deletion.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

/** Is `path` inside `dir`, and not `dir` itself? Both compared as the places they name. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(canonical(dir), canonical(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
