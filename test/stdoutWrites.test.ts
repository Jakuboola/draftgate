/**
 * Every stdout write in the CLI and the hook adapter is drained.
 *
 * Both entry points end in `process.exit`, so a bare `process.stdout.write` into a pipe is cut off
 * at whatever the pipe held: for the hook, a large approval arrives truncated and Claude Code runs
 * the agent's original input. Outside `cli/src/stdout.ts`, a bare write in these trees fails here.
 *
 * Source text, because the failure only shows through a slow reader on a real pipe, which
 * `hook.test.ts` exercises for the one path big enough to matter; this covers the paths that are
 * small today.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TREES = ['cli/src', 'adapters/hook/src'];
const HOME = 'cli/src/stdout.ts';

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) out.push(relative(ROOT, p));
  }
  return out;
}

/** Lines that CALL `process.stdout.write`, ignoring comments (these files quote it at length). */
function bareWrites(path: string): string[] {
  return readFileSync(join(ROOT, path), 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.replace(/\/\/.*$/, ''), n: i + 1 }))
    .filter(({ line }) => !/^\s*\*/.test(line) && /process\.stdout\.write\s*\(/.test(line))
    .map(({ n }) => `${path}:${n}`);
}

describe('stdout is written through writeStdout', () => {
  const FILES = TREES.flatMap((t) => files(join(ROOT, t)));

  test('the scan sees the trees it is meant to be scanning', () => {
    expect(FILES).toContain('cli/src/main.ts');
    expect(FILES).toContain('adapters/hook/src/main.ts');
    // And the one place a bare write belongs is visible to it, so the exemption is not vacuous.
    expect(bareWrites(HOME)).toHaveLength(1);
  });

  test('and nothing else calls process.stdout.write', () => {
    expect(FILES.filter((f) => f !== HOME).flatMap(bareWrites)).toEqual([]);
  });
});
