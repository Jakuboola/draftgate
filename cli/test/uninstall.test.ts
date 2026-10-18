/**
 * `draftgate uninstall`: the review hook out of Claude Code's settings through `register`'s own
 * writer, the `draftgate` link to this checkout gone, then, after asking, draftgate's directory
 * deleted.
 *
 * Two halves. The first drives `uninstall()` with everything it touches faked, one branch per test.
 * The second runs the real CLI on a release-shaped copy installed as a checkout install leaves it,
 * in `~/.draftgate/app`, under a scratch HOME, `CLAUDE_CONFIG_DIR`, `DRAFTGATE_HOME` and PATH. One
 * run deletes the checkout it runs from, and one is answered through a real terminal.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUDIT_BASENAME } from '../src/audit';
import { WATERMARK_BASENAME } from '../src/digest';
import { GITHUB_REPOS_BASENAME } from '../src/githubRepos';
import { JIRA_PROJECTS_BASENAME } from '../src/jiraProjects';
import { RELEASE_STATE_BASENAME } from '../src/releaseCheck';
import { REVIEW_CONFIG_BASENAME } from '../src/reviewConfig';
import { SCRATCH_BASENAME } from '../src/scratchTargets';
import { THEME_BASENAME } from '../src/themePreference';
import { PLUGIN_ID, type PluginHere } from '../src/claudePlugin';
import { DRAFTGATE_FILES, uninstall, type UninstallContext } from '../src/uninstall';
import { PLUGIN_LINK_BASENAME, SETUP_NAMES_BASENAME } from '../src/hookModes';
import { CONFIG_BASENAME } from '../../adapters/hook/src/toolMap';
import { row, scratchUser, withCheckoutEntry } from './installFixture';
import { releaseCopy } from './releaseClone';

const ROOT = join(import.meta.dir, '..', '..');

const scratch = mkdtempSync(join(tmpdir(), 'draftgate-uninstall-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// --- Faked -----------------------------------------------------------------------------------

let n = 0;
/** A draftgate directory with a log and a tool map in it, and a context over it; `over` replaces any part. */
function fake(over: Partial<UninstallContext> = {}, files: Record<string, string> = { 'audit.jsonl': '{}\n{}\n', 'tools.json': '{}' }) {
  const base = join(scratch, `fake${n++}`);
  const dir = join(base, 'home', '.draftgate');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const printed: string[] = [];
  const ran: string[] = [];
  const asked: string[] = [];
  const ctx: UninstallContext = {
    cli: '/dev/checkout/cli/src/main.ts',
    root: '/dev/checkout',
    dir,
    home: join(base, 'home'),
    auditLog: join(dir, 'audit.jsonl'),
    confirmed: null,
    ask: null,
    plugin: false,
    plugins: () => ({ kind: 'read', installs: [] }),
    unregister: () => {
      ran.push('--unregister');
      return 0;
    },
    unlink: () => {
      ran.push('unlink');
      return { removed: [], left: [], failed: [] };
    },
    remove: (d) => {
      ran.push(`remove ${d}`);
      rmSync(d, { recursive: true });
    },
    print: async (text) => void printed.push(text),
    ...over,
  };
  return { ctx, dir, text: () => printed.join(''), ran, asked };
}
const yes = (m: { asked: string[] }) => async (q: string) => (m.asked.push(q), true);

describe('uninstall, step by step', () => {
  test('with no terminal it deletes nothing, shows what to ask, and names the exact command for a yes', async () => {
    const m = fake();
    expect(await uninstall(m.ctx)).toBe(0);
    expect(m.ran).toEqual(['--unregister', 'unlink']);
    expect(existsSync(m.dir)).toBe(true);
    const text = m.text();
    expect(text).toContain('Not deleted: nobody could be asked from here (there is no terminal).');
    expect(text).toContain(`Delete ${m.dir} and everything in it? It holds:`);
    expect(text).toContain('audit.jsonl: the review log, which keeps the full text of every message reviewed (2 reviews)');
    expect(text).toContain('tools.json: your tool map');
    expect(text).toContain(`If they say yes, run \`bun '/dev/checkout/cli/src/main.ts' uninstall --delete '${m.dir}'\``);
    expect(row(text, 4)).toEndWith('kept: nobody could be asked');
  });

  test('a terminal is asked, and only a yes deletes', async () => {
    const no = fake({});
    no.ctx.ask = async (q) => (no.asked.push(q), false);
    expect(await uninstall(no.ctx)).toBe(0);
    expect(existsSync(no.dir)).toBe(true);
    expect(no.asked[0]).toContain(`Delete ${no.dir} and everything in it?`);
    expect(no.asked[0]).toEndWith('Delete it? [y/N] ');
    expect(row(no.text(), 4)).toEndWith('kept, as you answered');

    const m = fake();
    m.ctx.ask = yes(m);
    expect(await uninstall(m.ctx)).toBe(0);
    expect(existsSync(m.dir)).toBe(false);
    expect(m.text()).toContain(`Deleted ${m.dir}.`);
  });

  test('--delete with this directory is the yes, and nobody is asked again', async () => {
    const m = fake();
    m.ctx.confirmed = m.dir;
    m.ctx.ask = yes(m);
    expect(await uninstall(m.ctx)).toBe(0);
    expect(m.asked).toEqual([]);
    expect(existsSync(m.dir)).toBe(false);
  });

  test('--delete naming any other path stops it before anything is done', async () => {
    const m = fake();
    m.ctx.confirmed = join(m.ctx.home, 'Documents');
    expect(await uninstall(m.ctx)).toBe(1);
    expect(m.ran).toEqual([]);
    expect(existsSync(m.dir)).toBe(true);
    expect(m.text()).toContain(`--delete names ${m.ctx.confirmed}, but draftgate's directory here is ${m.dir}.`);
  });

  test('a hook that could not be unregistered stops it: no link removed, nothing deleted, exit 1', async () => {
    const m = fake({ unregister: () => (m.ran.push('--unregister'), 1) });
    m.ctx.confirmed = m.dir;
    expect(await uninstall(m.ctx)).toBe(1);
    expect(m.ran).toEqual(['--unregister']);
    expect(existsSync(m.dir)).toBe(true);
    expect(m.text()).toContain('Nothing else was removed: draftgate is registered as it was, and reviews as before.');
  });

  test('a directory holding something draftgate did not write is not deleted, and a confirmed yes then FAILS', async () => {
    const files = { 'audit.jsonl': '', 'tools.json.bak-1': '', 'notes.txt': 'mine', 'src/x': '' };
    // Asked of nobody yet: kept, and said, which is not a failure.
    const unasked = fake({}, files);
    expect(await uninstall(unasked.ctx)).toBe(0);
    expect(row(unasked.text(), 4)).toEndWith('kept: holds files draftgate did not write');
    // The person said yes: kept is not what they asked for, and an agent reads the exit status.
    const m = fake({}, files);
    m.ctx.confirmed = m.dir;
    expect(await uninstall(m.ctx)).toBe(1);
    expect(m.ran.some((r) => r.startsWith('remove'))).toBe(false);
    expect(m.text()).toContain('It also holds things draftgate did not write: notes.txt, src.');
    expect(m.text()).toContain('1 copy of those (backups, temporary files): tools.json.bak-1');
    expect(row(m.text(), 4)).toEndWith('FAILED: kept: holds files draftgate did not write');
  });

  test("Finder's .DS_Store is no reason to keep it: one look at the folder must not block every uninstall", async () => {
    const m = fake({}, { 'audit.jsonl': '', '.DS_Store': '' });
    m.ctx.confirmed = m.dir;
    expect(await uninstall(m.ctx)).toBe(0);
    expect(existsSync(m.dir)).toBe(false);
  });

  test('a DRAFTGATE_HOME that is the home directory, or above it, is never deleted', async () => {
    for (const at of ['home', '.']) {
      const m = fake();
      m.ctx.dir = join(m.ctx.home, at === 'home' ? '' : '..');
      m.ctx.confirmed = m.ctx.dir;
      m.ctx.auditLog = null;
      expect(await uninstall(m.ctx)).toBe(1);
      expect(m.ran.some((r) => r.startsWith('remove'))).toBe(false);
      expect(m.text()).toContain('is your home directory or above it');
    }
  });

  test('a symlinked directory is not deleted: that would delete the link and leave the data', async () => {
    const m = fake();
    const link = join(m.ctx.home, '.draftgate-link');
    symlinkSync(m.dir, link);
    m.ctx.dir = link;
    m.ctx.confirmed = link;
    expect(await uninstall(m.ctx)).toBe(1);
    expect(existsSync(m.dir)).toBe(true);
    expect(m.text()).toContain('is a symlink');
  });

  test('no directory at all is nothing to delete, and not a failure', async () => {
    const m = fake();
    rmSync(m.dir, { recursive: true });
    expect(await uninstall(m.ctx)).toBe(0);
    expect(row(m.text(), 4)).toEndWith('nothing there');
  });

  test('the checkout inside it is named, and said to be the one running', async () => {
    const m = fake({}, { 'app/package.json': JSON.stringify({ name: 'draftgate' }) });
    m.ctx.root = join(m.dir, 'app');
    await uninstall(m.ctx);
    expect(m.text()).toContain('app/: the draftgate checkout itself, which this command is running from');
    expect(m.text()).not.toContain('It is yours to delete.');
  });

  test("an app/ that is not a draftgate checkout is somebody else's, and keeps the directory", async () => {
    const m = fake({}, { 'app/package.json': JSON.stringify({ name: 'my-project' }) });
    m.ctx.confirmed = m.dir;
    expect(await uninstall(m.ctx)).toBe(1);
    expect(existsSync(m.dir)).toBe(true);
    expect(m.text()).toContain('It also holds something draftgate did not write: app.');
  });

  test('what it leaves behind outside the directory is named: the checkout, and a log moved elsewhere', async () => {
    const m = fake();
    const log = join(m.ctx.home, 'elsewhere.jsonl');
    writeFileSync(log, '{}\n');
    m.ctx.auditLog = log;
    await uninstall(m.ctx);
    expect(m.text()).toContain('This checkout, /dev/checkout, is not inside');
    expect(m.text()).toContain(`The review log is ${log}, outside ${m.dir}, so it was not deleted.`);
  });

  test('a deletion that stops part way fails, and says what is left', async () => {
    const m = fake({ remove: () => { throw new Error('EACCES: permission denied'); } });
    m.ctx.confirmed = m.dir;
    expect(await uninstall(m.ctx)).toBe(1);
    expect(m.text()).toContain('Deleting it stopped part way: EACCES: permission denied.');
    expect(row(m.text(), 4)).toContain('FAILED');
  });

  test('a link that runs THIS checkout is removed; after a deletion, so is one into the directory', async () => {
    const m = fake();
    const inApp = join(m.dir, 'app', 'cli', 'src', 'main.ts');
    const targets = ['/dev/checkout/cli/src/main.ts', inApp, '/other/checkout/cli/src/main.ts'];
    const claimed: string[][] = [];
    m.ctx.unlink = (ours) => {
      claimed.push(targets.filter(ours));
      return { removed: [], left: [], failed: [] };
    };
    m.ctx.confirmed = m.dir;
    await uninstall(m.ctx);
    // Step 2 claims this checkout's CLI alone; after the deletion, whatever pointed into it.
    expect(claimed).toEqual([['/dev/checkout/cli/src/main.ts'], [inApp]]);
  });

  test('a link into the deleted directory that cannot be removed fails the step, and is named', async () => {
    const m = fake();
    let calls = 0;
    m.ctx.unlink = () =>
      ++calls === 1
        ? { removed: [], left: [], failed: [] }
        : { removed: [], left: [], failed: [{ path: '/u/bin/draftgate', why: 'EACCES' }] };
    m.ctx.confirmed = m.dir;
    expect(await uninstall(m.ctx)).toBe(1);
    expect(m.text()).toContain('Could not remove /u/bin/draftgate, which pointed into it: EACCES');
    expect(row(m.text(), 4)).toContain('FAILED');
  });

  test('a plugin Claude Code has installed is named, with the command that removes it, and nothing claims draftgate stopped', async () => {
    const install = (enabled: PluginHere['enabled'], over: Partial<PluginHere> = {}): PluginHere => ({
      id: PLUGIN_ID, scope: 'user', installPath: '/cfg/plugins/cache/draftgate/draftgate/0.3.0', version: '0.3.0', enabled, thisRoot: false, ...over,
    });
    const on = { enabled: true, by: { path: '/u/.claude/settings.json', scope: 'user' as const } };
    const m = fake({ plugins: () => ({ kind: 'read', installs: [install(on)] }) });
    expect(await uninstall(m.ctx)).toBe(0);
    const text = m.text();
    expect(text).toContain(`  ${PLUGIN_ID} 0.3.0, user scope, enabled in /u/.claude/settings.json`);
    expect(text).toContain(`Run \`/plugin uninstall ${PLUGIN_ID}\` in Claude Code.`);
    expect(row(text, 2)).toEndWith(`installed: \`/plugin uninstall ${PLUGIN_ID}\` removes it`);
    expect(text).toContain('The draftgate plugin is still installed and enabled here, so draftgate still reviews');
    expect(text).not.toContain('draftgate no longer reviews anything');

    // Off here, or another project's: still installed, still reviewing where it applies.
    const off = fake({
      plugins: () => ({
        kind: 'read',
        installs: [install({ enabled: false, by: { path: '/p/.claude/settings.json', scope: 'project' } }), install(null, { scope: 'project', projectPath: '/elsewhere' })],
      }),
    });
    expect(await uninstall(off.ctx)).toBe(0);
    expect(off.text()).toContain('user scope, switched off in /p/.claude/settings.json');
    expect(off.text()).toContain('project scope, for another project (/elsewhere)');
    expect(off.text()).toContain('The draftgate plugin is still installed, and reviews wherever it is enabled');
    expect(off.text()).not.toContain('draftgate no longer reviews anything');

    // A record it cannot read is not "not installed".
    const unread = fake({ plugins: () => ({ kind: 'unreadable', path: '/cfg/plugins/installed_plugins.json', why: 'EACCES' }) });
    expect(await uninstall(unread.ctx)).toBe(0);
    expect(unread.text()).toContain('could not be read (EACCES)');
    expect(unread.text()).toContain('(step 2 could not tell), it still reviews until it is uninstalled');
    expect(unread.text()).not.toContain('draftgate no longer reviews anything');
  });

  test('from a plugin: its settings entry, the plugin, then the files, and no link or checkout of its own', async () => {
    const m = fake({ plugin: true, root: '/cfg/plugins/cache/draftgate/draftgate/0.3.0', cli: '/cfg/plugins/cache/draftgate/draftgate/0.3.0/cli/src/main.ts' });
    expect(await uninstall(m.ctx)).toBe(0);
    expect(m.ran).toEqual(['--unregister']);
    const text = m.text();
    expect(text).toContain("1/3  Review hook in Claude Code's settings");
    expect(text).toContain('2/3  draftgate plugin');
    expect(text).toContain(`3/3  draftgate's files: ${m.dir}`);
    expect(text).not.toContain('draftgate on PATH');
    expect(text).not.toContain('It is yours to delete.');
    expect(row(text, 3)).toEndWith('kept: nobody could be asked');
  });

  test('the files it recognises are every file the runtime writes there', () => {
    // Each module's own constant, the adapter's included, and the window's literal (`window.ts`).
    const written = [
      AUDIT_BASENAME, CONFIG_BASENAME, REVIEW_CONFIG_BASENAME, JIRA_PROJECTS_BASENAME, GITHUB_REPOS_BASENAME,
      SCRATCH_BASENAME, WATERMARK_BASENAME, RELEASE_STATE_BASENAME, THEME_BASENAME, 'window.json',
      PLUGIN_LINK_BASENAME, SETUP_NAMES_BASENAME,
    ];
    expect(Object.keys(DRAFTGATE_FILES).sort()).toEqual(written.sort());
    expect(readFileSync(join(ROOT, 'cli', 'src', 'surfaces', 'window.ts'), 'utf8')).toContain("join(draftgateHome(), 'window.json')");
    // No runtime file names a path in draftgate's directory beyond the modules above.
    const writers = new Set<string>();
    for (const top of ['cli/src', 'adapters/hook/src']) {
      for (const rel of readdirSync(join(ROOT, top), { recursive: true }) as string[]) {
        if (!rel.endsWith('.ts')) continue;
        const text = readFileSync(join(ROOT, top, rel), 'utf8');
        // Any use: `const home = draftgateHome(env); join(home, X)` names a file there too.
        if (/draftgateHome\(/.test(text)) writers.add(`${top}/${rel}`);
      }
    }
    // Each a module above, plus `digest.ts` (the watermark main.ts writes) and this command.
    expect([...writers].sort()).toEqual([
      'adapters/hook/src/main.ts', 'adapters/hook/src/setupNames.ts', 'cli/src/audit.ts', 'cli/src/digest.ts', 'cli/src/githubRepos.ts',
      'cli/src/jiraProjects.ts', 'cli/src/main.ts', 'cli/src/releaseCheck.ts', 'cli/src/reviewConfig.ts',
      'cli/src/scratchTargets.ts', 'cli/src/surfaces/window.ts', 'cli/src/themePreference.ts',
      'cli/src/uninstall.ts',
    ]);
  });
});

// --- The real CLI ----------------------------------------------------------------------------

/** The settings a user had before draftgate: a token, a hook of their own, a status line. */
const BEFORE = JSON.stringify(
  {
    env: { JIRA_TOKEN: 'SECRET-TOKEN' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/guard.sh' }] }] },
    statusLine: { type: 'command', command: 'echo hi' },
  },
  null,
  2
) + '\n';

let ttys = 0;
/**
 * Run `argv` on a real terminal (`script`'s pty) and type `keys` once `prompt` is on screen.
 * Measured: bun's spawn hands a child sockets for its pipes, and macOS `script` refuses one as its
 * stdin, and a named FIFO too ("tcgetattr/ioctl: Operation not supported on socket"), where an
 * anonymous pipe works. So it reads a pipe from a `cat` of a FIFO, and writes to a polled file.
 */
async function onTerminal(
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
  prompt: string,
  keys: string
): Promise<{ code: number | null; seen: string }> {
  const fifo = join(scratch, `keys${ttys}.fifo`);
  const screen = join(scratch, `screen${ttys++}.txt`);
  spawnSync('mkfifo', [fifo]);
  // Read and write, so neither this open nor `cat`'s blocks waiting for the other end.
  const typing = openSync(fifo, 'r+');
  const out = openSync(screen, 'w');
  const child = spawn('/bin/sh', ['-c', 'cat "$0" | exec script -q /dev/null "$@"', fifo, ...argv], {
    ...opts,
    stdio: ['ignore', out, out],
  });
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  for (let waited = 0; !readFileSync(screen, 'utf8').includes(prompt); waited += 20) {
    if (waited > 20_000) throw new Error(`the prompt never appeared:\n${readFileSync(screen, 'utf8')}`);
    await Bun.sleep(20);
  }
  writeSync(typing, keys);
  // The only writer goes, so `cat` sees the end once it has passed the keys on.
  closeSync(typing);
  const code = await done;
  closeSync(out);
  return { code, seen: readFileSync(screen, 'utf8') };
}

let users = 0;
/**
 * A user with a checkout install in `~/.draftgate/app`, over settings of their own, as that install
 * left them: its entry in the settings with the backup the write made, and `draftgate` linked to it.
 */
function installed() {
  const u = scratchUser(join(scratch, `user${users++}`));
  mkdirSync(dirname(u.settings), { recursive: true });
  const dir = u.env.DRAFTGATE_HOME!;
  const app = releaseCopy(join(dir, 'app'));
  const cli = join(app, 'cli', 'src', 'main.ts');
  const entry = withCheckoutEntry(BEFORE, join(app, 'adapters', 'hook', 'src', 'main.ts'), u.settings);
  writeFileSync(u.settings, entry.text);
  writeFileSync(entry.backup, BEFORE, { mode: 0o600 });
  symlinkSync(cli, join(u.bin, 'draftgate'));
  writeFileSync(join(dir, 'audit.jsonl'), '{"ts":"2026-10-02T00:00:00.000Z"}\n');
  return { ...u, dir, app, cli, uninstall: (args: string[] = []) => u.cli(cli, ['uninstall', ...args]) };
}

describe('draftgate uninstall, the real CLI on an install in ~/.draftgate/app', () => {
  test('the settings file is as it was before install, the link is gone, and with no terminal the files stay', () => {
    const u = installed();
    const during = JSON.parse(readFileSync(u.settings, 'utf8'));
    expect(during.hooks.PreToolUse).toHaveLength(2);
    expect(lstatSync(join(u.bin, 'draftgate')).isSymbolicLink()).toBe(true);

    const r = u.uninstall();
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    // Byte for byte what the user had: their hook, their token, their status line.
    expect(readFileSync(u.settings, 'utf8')).toBe(BEFORE);
    expect(r.stdout).not.toContain('SECRET');
    expect(existsSync(join(u.bin, 'draftgate'))).toBe(false);
    expect(lstatSync(join(u.bin, 'draftgate'), { throwIfNoEntry: false })).toBeUndefined();
    expect(r.stdout).toContain(`Removed ${join(u.bin, 'draftgate')}.`);
    // The install's backup and uninstall's, both kept and both named.
    expect(u.backups()).toHaveLength(2);
    expect(r.stdout).toContain('2 backups draftgate made of this file are beside it');
    expect(existsSync(u.dir)).toBe(true);
    expect(r.stdout).toContain('app/: the draftgate checkout itself, which this command is running from');
    expect(r.stdout).toContain(`uninstall --delete '${u.dir}'`);
    for (const step of [1, 3]) expect(row(r.stdout, step)).toEndWith('  ok');
    expect(row(r.stdout, 2)).toEndWith('  not installed');
    expect(r.stdout).toContain("draftgate no longer reviews anything: its hook is out of Claude Code's settings.");

    // A second run changes nothing, and makes no backup.
    const again = u.uninstall();
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('draftgate is not registered in');
    expect(again.stdout).toContain('No `draftgate` link runs this checkout.');
    expect(u.backups()).toHaveLength(2);
  }, 60_000);

  test('the printed --delete command deletes the directory, the checkout it runs from included', () => {
    const u = installed();
    const first = u.uninstall();
    const command = /run `bun '([^']+)' uninstall --delete '([^']+)'`/.exec(first.stdout)!;
    expect(command[1]).toBe(u.cli);
    const r = u.uninstall(['--delete', command[2]!]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Deleted ${u.dir}.`);
    expect(existsSync(u.dir)).toBe(false);
    expect(readFileSync(u.settings, 'utf8')).toBe(BEFORE);
    // The checkout was in there, and is gone: under `/var -> /private/var`, a comparison made after
    // the deletion that reads the two paths as spelled says it is still there.
    expect(r.stdout).not.toContain('It is yours to delete.');
    expect(existsSync(u.app)).toBe(false);
  }, 60_000);

  test("a log Claude Code's settings move elsewhere is named: reviews wrote it, and this run would not find it", () => {
    const u = installed();
    const moved = join(u.home, 'logs', 'draftgate.jsonl');
    const settings = JSON.parse(readFileSync(u.settings, 'utf8'));
    writeFileSync(u.settings, JSON.stringify({ ...settings, env: { ...settings.env, DRAFTGATE_AUDIT_LOG: moved } }, null, 2) + '\n');
    const r = u.uninstall();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`settings.json sets DRAFTGATE_AUDIT_LOG to ${moved} for reviews, and this runs with ${u.env.DRAFTGATE_AUDIT_LOG}:`);
    expect(r.stdout).not.toContain('SECRET');
  }, 60_000);

  test('answered on a real terminal: Enter keeps it, and y deletes it', async () => {
    const u = installed();
    const answer = (keys: string) =>
      onTerminal([process.execPath, '--no-install', u.cli, 'uninstall'], { cwd: u.project, env: u.env }, '[y/N]', keys);
    const kept = await answer('\r');
    expect(kept.code).toBe(0);
    expect(kept.seen).toContain('Not deleted, as you answered.');
    expect(existsSync(u.dir)).toBe(true);

    const gone = await answer('y\r');
    expect(gone.code).toBe(0);
    expect(gone.seen).toContain(`Deleted ${u.dir}.`);
    expect(existsSync(u.dir)).toBe(false);
  }, 60_000);

  test('draftgate registered in a project file it does not edit: refused, and nothing is removed', () => {
    const u = installed();
    const project = join(u.project, '.claude', 'settings.json');
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(project, JSON.stringify({ hooks: { PreToolUse: [u.expectedBlock(join(u.app, 'adapters', 'hook', 'src', 'main.ts'))] } }));
    const settings = readFileSync(u.settings, 'utf8');
    const r = u.uninstall(['--delete', u.dir]);
    expect(r.code).toBe(1);
    // As the hook names it: the working directory, real path and all.
    expect(r.stderr).toContain(`draftgate uninstall: draftgate is also registered in ${realpathSync(project)}`);
    expect(r.stderr).toContain('Removing the entry here would leave that one reviewing.');
    expect(readFileSync(u.settings, 'utf8')).toBe(settings);
    expect(lstatSync(join(u.bin, 'draftgate')).isSymbolicLink()).toBe(true);
    expect(existsSync(u.dir)).toBe(true);
    expect(row(r.stdout, 1)).toContain('FAILED');
  }, 60_000);

  test('a broken tools.json does not keep the hook registered', () => {
    const u = installed();
    writeFileSync(join(u.dir, 'tools.json'), '{ not json');
    const r = u.uninstall();
    expect(r.code).toBe(0);
    expect(readFileSync(u.settings, 'utf8')).toBe(BEFORE);
  }, 60_000);
});
