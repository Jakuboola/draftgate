/**
 * `install.sh`, run end to end and asserted at its boundaries: the Claude Code commands it runs and
 * in what order, what it leaves on disk, and its exit code and output.
 *
 * With the real HOME it would install into the operator's own Claude Code, so every run's
 * environment is built from nothing, never `process.env`: a scratch HOME and TMPDIR, and a PATH this
 * file controls, where `claude` is a fake that records each command, bun is this suite's or missing,
 * and `curl` answers bun's installer URL with a fake. No run reaches the network. The script goes to
 * the shell on stdin, as `curl | sh` does.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMEDY } from '../../core/src/remedies';
import { BUN_PLACES, FIND_BUN } from '../../adapters/hook/src/hookCommand';
import { MIN_MACOS } from '../src/reviewHost';
import { githubRepo } from '../src/release';
import { MARKETPLACE_NAME, PLUGIN_ID, PLUGIN_NAME } from '../src/claudePlugin';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'install.sh');
const TEXT = readFileSync(SCRIPT, 'utf8');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'draftgate-install-sh-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const exe = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
const dir = (name: string) => {
  const d = join(scratch, name);
  mkdirSync(d, { recursive: true });
  return d;
};

/** bun alone: the one running this suite. */
const BUN_BIN = dir('bunbin');
symlinkSync(process.execPath, join(BUN_BIN, 'bun'));

/**
 * Claude Code, as install.sh meets it. `--version` answers as 2.1.296 does; every `plugin` command
 * is recorded, one line each, with whether its stdin is a terminal, and answers FAKE_CLAUDE_FAIL's
 * exit status when it names that subcommand (`add`, `install`, `update`).
 */
const CLAUDE_BIN = dir('claudebin');
exe(join(CLAUDE_BIN, 'claude'), `#!/bin/sh
if [ "$1" = --version ]; then echo "2.1.296 (Claude Code)"; exit 0; fi
echo "$*" >> "$FAKE_CLAUDE_LOG"
case "$*" in
  "plugin marketplace add "*) what=add ;;
  "plugin install "*) what=install ;;
  "plugin update "*) what=update ;;
  *) what=other ;;
esac
echo "claude did $what"
if [ "$what" = "\${FAKE_CLAUDE_FAIL:-}" ]; then echo "claude: $what went wrong" >&2; exit 1; fi
exit 0
`);

/** A directory holding one fake command. */
function fake(name: string, body: string): string {
  const d = dir(`fake-${name}-${Math.random().toString(36).slice(2, 8)}`);
  exe(join(d, name), `#!/bin/sh\n${body}\n`);
  return d;
}

const SYSTEM = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const COMMANDS = ['plugin marketplace add Jakuboola/draftgate', 'plugin install draftgate@draftgate', 'plugin update draftgate@draftgate'];

let users = 0;
/** A user of their own: a home with nothing in it but `~/.local/bin`. */
function user() {
  const root = dir(`user${users++}`);
  const home = join(root, 'home');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(localBin, { recursive: true });
  mkdirSync(join(root, 'tmp'));
  const log = join(root, 'claude.log');
  const base: Record<string, string> = { HOME: home, TMPDIR: join(root, 'tmp'), FAKE_CLAUDE_LOG: log };
  return {
    home, localBin, log,
    /** The plugin commands Claude Code was given, in order. */
    ran: () => (existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : []),
    /** Everything under the home, so a test can say what the script left there. */
    tree: () => (readdirSync(home, { recursive: true }) as string[]).sort(),
    /** The script, fed to `opts.shell` on stdin as `curl | sh` does. */
    run(opts: RunOptions = {}) {
      const env = { ...base, PATH: [...(opts.path ?? [CLAUDE_BIN, BUN_BIN]), ...SYSTEM].join(':'), ...opts.env };
      const r = spawnSync(opts.shell ?? '/bin/sh', [], {
        cwd: home, env, encoding: 'utf8', input: opts.script ?? TEXT, timeout: 60_000,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}
interface RunOptions {
  path?: string[];
  env?: Record<string, string>;
  shell?: string;
  script?: string;
}

const STEPS = [1, 2, 3, 4].map((n) => `==> Step ${n} of 4: `);
const inOrder = (text: string, marks: string[]) => {
  const at = marks.map((m) => text.indexOf(m));
  return at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1]!));
};
const SETUP_LINE = 'Now, in Claude Code, run /draftgate:setup to choose which of your tools it reviews.';

// --- The install -------------------------------------------------------------------------------

describe('install.sh', () => {
  test("installs the plugin through Claude Code's own commands, in order, and ends with setup", () => {
    const u = user();
    const r = u.run();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(inOrder(r.out, [...STEPS, 'claude did add', 'claude did install', 'claude did update', SETUP_LINE])).toBe(true);
    expect(u.ran()).toEqual(COMMANDS);
    expect(r.out).toContain(`Claude Code 2.1.296, at ${join(CLAUDE_BIN, 'claude')}.`);
    expect(r.out).toContain(`bun ${Bun.version}, at ${join(BUN_BIN, 'bun')}.`);
    expect(r.out).toContain('In a session that was already open, run /reload-plugins first.');
    // It writes nothing of its own: Claude Code's commands are what change Claude Code.
    expect(u.tree()).toEqual(['.local', '.local/bin']);
  });

  test('run again, it runs the same three commands, each of which leaves what is done as it is', () => {
    // `marketplace add` and `install` of what is there exit 0 and change nothing, and `update` is
    // what moves the plugin to a newer release (measured, Claude Code 2.1.296).
    const u = user();
    expect(u.run().code).toBe(0);
    expect(u.run().code).toBe(0);
    expect(u.ran()).toEqual([...COMMANDS, ...COMMANDS]);
  });

  test('the same under dash, so nothing in it is bash', () => {
    const u = user();
    const r = u.run({ shell: '/bin/dash' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(u.ran()).toEqual(COMMANDS);
  });

  for (const [what, done, said] of [
    ['add', 1, "Claude Code could not add draftgate's marketplace, Jakuboola/draftgate (its reason is above)."],
    ['install', 2, 'Claude Code could not install draftgate@draftgate (its reason is above).'],
    ['update', 3, 'draftgate is installed, but Claude Code could not check it is the newest release (its reason is above). Run this again to retry.'],
  ] as const) {
    test(`a ${what} Claude Code refuses stops it there, saying so, and runs nothing after it`, () => {
      const u = user();
      const r = u.run({ env: { FAKE_CLAUDE_FAIL: what } });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`claude: ${what} went wrong`);
      expect(r.err).toContain(said);
      expect(u.ran()).toEqual(COMMANDS.slice(0, done));
      expect(r.out).not.toContain('/draftgate:setup');
    });
  }
});

// --- Claude Code ---------------------------------------------------------------------------------

describe("install.sh and Claude Code's place", () => {
  test("a claude in ~/.local/bin, where Claude Code's own installer puts it and PATH does not look, is found", () => {
    // A new macOS account's PATH has no ~/.local/bin (macOS 26.0, Claude Code 2.1.292).
    const u = user();
    symlinkSync(join(CLAUDE_BIN, 'claude'), join(u.localBin, 'claude'));
    const r = u.run({ path: [BUN_BIN] });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Claude Code 2.1.296, at ${join(u.localBin, 'claude')}.`);
    expect(u.ran()).toEqual(COMMANDS);
  });

  test('with no claude at all it stops at step 2, before bun, saying where it looked', () => {
    const u = user();
    const curl = fake('curl', 'echo "curl ran" >> "$FAKE_CLAUDE_LOG.curl"; exit 1');
    const r = u.run({ path: [curl] });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Claude Code (\`claude\`) is not on this shell's PATH or at ${join(u.localBin, 'claude')}.`);
    expect(r.out).not.toContain('==> Step 3 of 4');
    expect(existsSync(`${u.log}.curl`)).toBe(false);
  });
});

// --- bun -----------------------------------------------------------------------------------------

/**
 * The script with every fixed place the plugin looks for bun (`BUN_PLACES`) moved to a path that
 * does not exist, so "no bun" can be built on a Mac that has one there. That the script spells
 * those places is "it looks for bun where the plugin's hook and command do".
 */
const NO_SYSTEM_BUN = BUN_PLACES.filter((p) => p.sh.startsWith('/')).reduce(
  (text, p) => text.replaceAll(p.sh, join(scratch, 'nowhere', 'bun')),
  TEXT
);

describe('install.sh with no bun', () => {
  const u = user();
  /** `curl`, for bun's installer URL only: a fake installer that puts bun where BUN_INSTALL says. */
  const curl = fake('curl', `echo "curl $*" >> "$FAKE_CLAUDE_LOG.curl"
case "$*" in *https://bun.sh/install*) ;; *) exit 22 ;; esac
[ -n "\${FAIL_DOWNLOAD:-}" ] && exit 6
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
cat > "$out" <<'EOS'
echo "the fake bun installer ran"
mkdir -p "\${BUN_INSTALL:-$HOME/.bun}/bin"
ln -sf "$REAL_BUN" "\${BUN_INSTALL:-$HOME/.bun}/bin/bun"
EOS`);
  // BUN_INSTALL points elsewhere: the plugin does not look there, so the install must not go there.
  const noBun = { script: NO_SYSTEM_BUN, path: [curl, CLAUDE_BIN], env: { REAL_BUN: process.execPath, BUN_INSTALL: join(u.home, 'elsewhere') } };
  const bun = join(u.home, '.bun', 'bin', 'bun');

  test('a failed download stops it, before the plugin', () => {
    const r = u.run({ ...noBun, env: { ...noBun.env, FAIL_DOWNLOAD: '1' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not download bun's installer from https://bun.sh/install");
    expect(u.ran()).toEqual([]);
  });

  test("installs it with bun's own installer into ~/.bun, where the plugin looks, saying so first", () => {
    const r = u.run(noBun);
    expect(r.code).toBe(0);
    expect(inOrder(r.out, [
      "bun is not installed where the plugin looks, so this installs it now with bun's own installer (https://bun.sh/install), into ~/.bun.",
      'the fake bun installer ran',
      // bun's installer tells a zsh user to edit ~/.zshrc; the plugin looks in ~/.bun/bin anyway.
      'draftgate does not need that: it looks there.',
      `bun ${Bun.version}, at ${bun}.`,
      '==> Step 4 of 4',
    ])).toBe(true);
    expect(existsSync(join(u.home, 'elsewhere'))).toBe(false);
    expect(u.ran()).toEqual(COMMANDS);
  });

  test('a second run finds the bun the first one installed, and installs nothing', () => {
    const r = u.run(noBun);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('bun is not installed');
    expect(r.out).not.toContain('does not need that');
    expect(r.out).toContain(`bun ${Bun.version}, at ${bun}.`);
    // One download attempt that failed, one that ran: none since.
    expect(readFileSync(`${u.log}.curl`, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

// --- What stops it before it changes anything --------------------------------------------------

describe('install.sh stops before it changes anything', () => {
  const fakeGit = () => fake('git', 'echo "git $*" >> "$FAKE_CLAUDE_LOG.git"\nexit 1');

  test('with no Command Line Tools: before any git or Claude Code command, saying how to get them', () => {
    const u = user();
    const r = u.run({ path: [fake('xcode-select', 'exit 2'), fakeGit(), CLAUDE_BIN, BUN_BIN] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Run `xcode-select --install`, then run this again.');
    // What works where Apple's server does not offer them to this macOS (stock macOS 26.0 is one).
    expect(r.err).toContain('If it says the software is not available, update macOS first, or download the tools from https://developer.apple.com/download/all/');
    expect(existsSync(`${u.log}.git`)).toBe(false);
    expect(u.ran()).toEqual([]);
  });

  test('below the macOS floor: before bun or the plugin', () => {
    const u = user();
    const r = u.run({ path: [fake('sw_vers', 'echo 15.6'), CLAUDE_BIN] });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the review window needs macOS ${MIN_MACOS} or newer, and this Mac runs macOS 15.6.`);
    expect(r.out).not.toContain('==> Step 2 of 4');
    expect(u.ran()).toEqual([]);
  });

  test('on anything but macOS', () => {
    const u = user();
    const r = u.run({ path: [fake('uname', 'echo Linux'), CLAUDE_BIN, BUN_BIN] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('draftgate runs on macOS only, and this is Linux.');
    expect(u.ran()).toEqual([]);
  });

  test('a download cut short runs nothing at all', () => {
    // Everything is one function, called on the last line: until that line arrives, nothing runs.
    for (const cut of [Math.floor(TEXT.length / 2), TEXT.lastIndexOf('main "$@"')]) {
      const u = user();
      const r = u.run({ script: TEXT.slice(0, cut) });
      expect(r.out, `cut at ${cut}`).toBe('');
      expect(u.ran()).toEqual([]);
    }
  });
});

// --- The facts it restates ---------------------------------------------------------------------

describe('the facts install.sh restates, held to their sources', () => {
  const value = (name: string) => TEXT.match(new RegExp(`^${name}=(\\S+)$`, 'm'))?.[1];

  test("its macOS floor is the review window's", () => {
    expect(value('MIN_MACOS')).toBe(MIN_MACOS);
  });

  test("it looks for bun where the plugin's hook and command do, in their order", () => {
    expect(TEXT).toContain(`  ${FIND_BUN}\n`);
  });

  test('the marketplace and plugin it installs are the ones this repository publishes', () => {
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    // The id every message names, and the manifests Claude Code installs by.
    expect([PLUGIN_NAME, MARKETPLACE_NAME]).toEqual([plugin.name, marketplace.name]);
    expect(value('PLUGIN')).toBe(PLUGIN_ID);
    // `marketplace add` takes `owner/repo` and retries over HTTPS; the plugin's own source is a URL.
    expect(value('MARKETPLACE')).toBe(githubRepo(marketplace.plugins[0].source.url)!);
    expect(value('MARKETPLACE')).toBe(githubRepo(plugin.repository)!);
    expect(COMMANDS).toEqual([
      `plugin marketplace add ${value('MARKETPLACE')}`, `plugin install ${PLUGIN_ID}`, `plugin update ${PLUGIN_ID}`,
    ]);
  });

  test("bun's installer is the one every message names", () => {
    expect(REMEDY.installBun).toContain(`curl -fsSL ${value('BUN_INSTALLER')} | bash`);
  });

  test('the command every message names to install draftgate is this script, from stable', () => {
    const line = TEXT.split('\n').find((l) => l.includes('curl -fsSL'))!.replace(/^#\s+/, '');
    expect(REMEDY.install as string).toBe(`\`${line}\``);
    expect(line).toContain('/stable/install.sh');
  });

  test('a Mac with no Command Line Tools is told the remedy every other message names', () => {
    expect(TEXT).toContain(`Run ${REMEDY.installCommandLineTools.replaceAll('`', '\\`')}, then run this again.`);
  });
});
