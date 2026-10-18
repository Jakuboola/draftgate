/**
 * A plugin root laid out as a release lays one out: `plugin/`'s files, with this checkout's runtime
 * linked in beside them, so its hook is this very file and `pluginRootOf` counts it.
 *
 * Not a test file: `bun test` runs `*.test.ts`, and this is imported by them.
 */

import { cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');

/** Assemble one at `root`, which must not exist yet. Answers `root`. */
export function assembledRoot(root: string): string {
  cpSync(join(REPO, 'plugin'), root, { recursive: true });
  for (const part of ['core', 'cli', 'adapters', 'surface', 'package.json']) {
    symlinkSync(join(REPO, part), join(root, part));
  }
  return root;
}
