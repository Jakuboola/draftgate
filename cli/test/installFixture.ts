/**
 * Users of their own to put a release-shaped copy in front of (`releaseClone.ts`'s `releaseCopy`):
 * what the uninstall suite runs the real CLI against, as a checkout install left a user's machine.
 *
 * Not a test file: `bun test` runs `*.test.ts`, and this is imported by them.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_INFIX, planRegistration } from '../../adapters/hook/src/register';
import { classifyEntry } from '../../adapters/hook/src/registration';
import { checkoutBlock } from '../../adapters/hook/test/checkoutEntry';
import { DEFAULT_TOOL_MAP } from '../../adapters/hook/src/toolMap';

/**
 * A user of their own, under `root`: a home with `~/.local/bin` on PATH, Claude Code's config,
 * draftgate's, and a project to run from. Nothing writable outside the scratch home is on PATH, so
 * a link cannot land anywhere real.
 */
export function scratchUser(root: string, opts: { pathDirs?: (home: string) => string[] } = {}) {
  const home = join(root, 'home');
  const bin = join(home, '.local', 'bin');
  const project = join(root, 'project');
  mkdirSync(bin, { recursive: true });
  mkdirSync(project, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DRAFTGATE_HOME: join(home, '.draftgate'),
    DRAFTGATE_AUDIT_LOG: join(home, '.draftgate', 'audit.jsonl'),
    PATH: [...(opts.pathDirs?.(home) ?? [bin]), '/usr/bin', '/bin'].join(':'),
  };
  delete env.CLAUDE_PROJECT_DIR;
  const settings = join(home, '.claude', 'settings.json');
  /** `bun --no-install <cli> <args...>`, so a package import fails here instead of being fetched. */
  const cli = (entry: string, args: string[], o: { cwd?: string; input?: string; extraPath?: string[] } = {}) => {
    const r = spawnSync(process.execPath, ['--no-install', entry, ...args], {
      cwd: o.cwd ?? project,
      env: { ...env, PATH: [...(o.extraPath ?? []), env.PATH].join(':') },
      encoding: 'utf8',
      input: o.input ?? '',
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    home,
    bin,
    project,
    env,
    settings,
    cli,
    /** A checkout's settings entry for the checkout whose hook is `hook`. */
    expectedBlock: (hook: string) => checkoutBlock(DEFAULT_TOOL_MAP, { hook }),
    backups: () =>
      existsSync(join(home, '.claude'))
        ? readdirSync(join(home, '.claude')).filter((f) => f.includes(BACKUP_INFIX))
        : [],
  };
}

/**
 * What a checkout install at `app` left in `settingsText`: its entry in `hooks.PreToolUse`, placed
 * by `register`'s own planner, and the backup that write made. Answers the new text and the backup.
 */
export function withCheckoutEntry(settingsText: string, hook: string, target: string): { text: string; backup: string } {
  const plan = planRegistration(
    settingsText,
    checkoutBlock(DEFAULT_TOOL_MAP, { hook }),
    (command) => classifyEntry(command, { hookPath: hook, realpath: () => null, probe: () => 'draftgate' }),
    target
  );
  if (plan.kind !== 'changed') throw new Error(`expected the entry to be added, got ${plan.kind}`);
  return { text: plan.text, backup: `${target}${BACKUP_INFIX}2026-10-01T00-00-00.000Z` };
}

/** The summary row for a step, as `uninstall` prints it. */
export const row = (text: string, step: number) => text.split('\n').find((l) => l.startsWith(`  ${step}  `))!;
