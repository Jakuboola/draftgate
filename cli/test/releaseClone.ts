/**
 * What the tests that stand up a release need: this checkout's files as a release clone has them,
 * and git for the repositories they build. Not a test file: imported by them.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashFile, sha256, stampOf, surfaceLayout } from '../src/surfaces/bundleStamp';

const ROOT = join(import.meta.dir, '..', '..');

/**
 * Every tracked file (plus new ones not yet committed, so the suite tests the working tree), no
 * `node_modules`, no build output -- and a shipped window, which a release commits and this suite
 * cannot build. The window is two files whose stamp records inputs this copy has, the shape
 * `bundleState` checks with no toolchain: a package input it must skip, and `bun.lock`, which pins
 * the packages and must be there. Answers the copy's real path.
 */
export function releaseCopy(app: string): string {
  const listed = spawnSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    if (!existsSync(join(ROOT, rel))) continue;
    mkdirSync(dirname(join(app, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(app, rel));
  }
  const window = surfaceLayout(app);
  mkdirSync(window.distDir, { recursive: true });
  writeFileSync(window.builtRenderer, '<!doctype html><title>draftgate</title>\n');
  const inputs: Record<string, string> = {
    'bun.lock': hashFile(join(app, 'bun.lock'))!,
    'surface/src/App.tsx': hashFile(join(app, 'surface', 'src', 'App.tsx'))!,
    'node_modules/react/index.js': sha256('not in a release clone'),
  };
  writeFileSync(window.stampFile, JSON.stringify({ version: 1, stamp: stampOf(inputs), inputs }));
  // As bun names its own files: `$TMPDIR` is under a symlink on macOS (/var -> /private/var).
  return realpathSync(app);
}

/**
 * git for a test's fixture repositories, under no config of this machine's: no system file (Apple's
 * keychain helper), a global file of its own in `home`, and an identity, so a person's
 * `commit.gpgsign` or credential helper never reaches a fixture commit. `env` is also what a test
 * hands code under test that runs git itself.
 */
export function fixtureGit(home: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.test',
  };
  const git = (cwd: string, ...args: string[]): string => {
    const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  return { env, git };
}
