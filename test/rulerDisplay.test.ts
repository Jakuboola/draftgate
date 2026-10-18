/**
 * Every ruler runs on one pinned display, so a run on any Mac is comparable with any other.
 *
 * A box's geometry follows the display a run has: widths lose 15px to a legacy scroll bar, and
 * heights snap to 1/64px at a device scale of 1 and 1/128px at 2. So `tools/electron/run.ts`
 * appends `--force-device-scale-factor=1 -AppleShowScrollBars Always` to Electron's command line
 * for every script it runs, after the caller's own arguments, and nothing for an app directory (an
 * interactive app such as the jira-ruler's editor).
 *
 * Asserted is the command line Electron receives: each script's arguments go through a copy of the
 * real launcher whose installed "Electron" is a shell script printing its argv. The flags' effect
 * shows only by running a ruler on two displays. The flags are literals here, not imported.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const LAUNCHER = join(ROOT, 'tools', 'electron');
const PINNED_DISPLAY = ['--force-device-scale-factor=1', '-AppleShowScrollBars', 'Always'];

interface Invocation {
  pkg: string;
  name: string;
  /** The launcher's own arguments, as the script writes them. */
  args: string[];
}

/** Build output and screenshots: thousands of entries in a used checkout, and never a `package.json`. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'probe-result', 'ruler-result']);

/** Every `package.json` in the checkout, repo-relative: not one of them may start a ruler unpinned. */
function packageFiles(dir = ROOT, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) packageFiles(p, out);
    else if (e.name === 'package.json') out.push(relative(ROOT, p));
  }
  return out;
}

/** Each call to the launcher in each package's scripts. */
function invocations(): Invocation[] {
  const out: Invocation[] = [];
  for (const pkg of packageFiles()) {
    const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, pkg), 'utf8')).scripts ?? {};
    for (const [name, script] of Object.entries(scripts)) {
      for (const m of script.matchAll(/\bbun (\S*electron\/run\.ts)((?: [^\s&|;]+)*)/g)) {
        if (resolve(ROOT, dirname(pkg), m[1]!) !== join(LAUNCHER, 'run.ts')) throw new Error(`${pkg} ${name}: ${m[1]} is not the launcher`);
        out.push({ pkg, name, args: m[2]!.trim().split(' ').filter(Boolean) });
      }
    }
  }
  return out;
}

// Read before the scratch directory exists, so nothing that can throw at load can strand it.
const ALL = invocations();

const SCRATCH = mkdtempSync(join(tmpdir(), 'draftgate-ruler-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const FAKE_RUN = join(SCRATCH, 'run.ts');

/** The launcher, copied beside an "Electron" that prints each argument on a line of its own. */
beforeAll(() => {
  copyFileSync(join(LAUNCHER, 'run.ts'), FAKE_RUN);
  copyFileSync(join(LAUNCHER, 'package.json'), join(SCRATCH, 'package.json'));
  const pinned: string = JSON.parse(readFileSync(join(LAUNCHER, 'package.json'), 'utf8')).devDependencies.electron;
  const pkg = join(SCRATCH, 'node_modules', 'electron');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'electron', version: pinned }));
  writeFileSync(join(pkg, 'dist', 'version'), pinned);
  writeFileSync(join(pkg, 'path.txt'), 'argv');
  writeFileSync(join(pkg, 'dist', 'argv'), '#!/bin/sh\nfor a do printf \'%s\\n\' "$a"; done\n');
  chmodSync(join(pkg, 'dist', 'argv'), 0o755);
});

/**
 * The arguments the launcher started "Electron" with, given its own, from `cwd`. A launcher that
 * does not take the fake for an install would install one: the registry is a closed port, so that
 * fails at once on stderr rather than fetching Electron inside `bun test`.
 */
function launch(args: string[], cwd = ROOT): { status: number | null; argv: string[]; stderr: string } {
  const r = spawnSync(process.execPath, [FAKE_RUN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/', npm_config_registry: 'http://127.0.0.1:9/' },
  });
  return { status: r.status, argv: r.stdout.split('\n').slice(0, -1), stderr: r.stderr };
}

describe('the rulers run on a pinned display', () => {
  test('the scan sees every measure:* and the ruler app', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    const measures = Object.keys(root).filter((n) => n.startsWith('measure:'));
    expect(measures.length).toBeGreaterThanOrEqual(7);
    // A measure:* that starts Electron any other way would not be pinned, so each must be a call.
    expect(ALL.filter((c) => c.pkg === 'package.json' && c.name.startsWith('measure:')).map((c) => c.name).sort()).toEqual(
      measures.sort()
    );
    expect([...new Set(ALL.map((c) => c.pkg))]).toEqual(
      expect.arrayContaining(['package.json', 'tools/jira-ruler/package.json'])
    );
  });

  // What a call runs says which it is: a file is a ruler (a probe), a directory is an app, whose
  // window is for a human on the display they have.
  for (const c of ALL) {
    test(`${c.pkg} ${c.name}: a ruler gets the pinned display, last, and an app nothing`, () => {
      // Split on spaces, so a script that quotes or expands would be read here as `sh` does not.
      expect(c.args.filter((a) => /["'`$\\]/.test(a))).toEqual([]);
      // A committed script must not opt out.
      expect(c.args).not.toContain('--unpinned');
      const at = statSync(join(ROOT, dirname(c.pkg), c.args[0] ?? ''), { throwIfNoEntry: false });
      expect(at, `${c.args[0]} does not exist`).toBeDefined();
      const r = launch(c.args, join(ROOT, dirname(c.pkg)));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.argv).toEqual(at!.isDirectory() ? c.args : [...c.args, ...PINNED_DISPLAY]);
    });
  }

  const PROBE = 'tools/jira-ruler/probe-blocks.cjs';

  test('a display flag appended to a ruler cannot move it: the pinned ones come after', () => {
    const appended = ['--force-device-scale-factor=2', '-AppleShowScrollBars', 'WhenScrolling'];
    expect(launch([PROBE, ...appended]).argv).toEqual([PROBE, ...appended, ...PINNED_DISPLAY]);
  });

  test('--unpinned, first, runs on the display it is given', () => {
    expect(launch(['--unpinned', PROBE, '-AppleShowScrollBars', 'WhenScrolling']).argv).toEqual([
      PROBE,
      '-AppleShowScrollBars',
      'WhenScrolling',
    ]);
  });

  test('--unpinned anywhere else is an argument, and the run stays pinned', () => {
    expect(launch([PROBE, '--unpinned']).argv).toEqual([PROBE, '--unpinned', ...PINNED_DISPLAY]);
  });

  test('an app may take a `--`, since nothing is pinned after it', () => {
    expect(launch(['.', '--', 'x'], join(ROOT, 'tools', 'jira-ruler')).argv).toEqual(['.', '--', 'x']);
  });

  // Refused before anything starts. The `--` would otherwise have hidden the pinned scale from Chromium.
  for (const [what, args, says] of [
    ['nothing to run', [], 'nothing to run'],
    ['--unpinned with nothing to run', ['--unpinned'], 'nothing to run'],
    ['a `--` in a pinned run', [PROBE, '--', 'x'], 'a pinned run takes no `--`'],
  ] as const) {
    test(`${what} is refused, and starts nothing`, () => {
      const r = launch([...args]);
      expect(r.status).toBe(2);
      expect(r.argv).toEqual([]);
      expect(r.stderr).toContain(says);
      expect(r.stderr).toContain('usage: bun tools/electron/run.ts [--unpinned] <script|app dir>');
    });
  }
});
