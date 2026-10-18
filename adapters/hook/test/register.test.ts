/**
 * `draftgate register`'s two pure halves: which entries are draftgate's (`classifyEntry`), and what
 * writing one does to a settings file (`planRegistration`).
 *
 * The file a real run writes, and its exit code and stdout, are `cli/test/register.test.ts`; these
 * are the cases a subprocess per row would make slow.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeHook } from '../src/main';
import {
  changedLines,
  planRegistration,
  registerReport,
  movedElsewhere,
  unregisterReport,
  type HookBlock,
  type RegisterPlan,
} from '../src/register';
import {
  classifyEntry,
  inspectRegistration,
  type Checkout,
  type HookProbe,
} from '../src/registration';
import { hookBlock, shQuote } from '../src/hookCommand';
import { failClosedCommand } from './checkoutEntry';
import { DEFAULT_TOOL_MAP } from '../src/toolMap';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-register-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOOK = '/here/adapters/hook/src/main.ts';
const OTHER = '/elsewhere/adapters/hook/src/main.ts';
const GONE = '/moved/adapters/hook/src/main.ts';
const noRealpath = () => null;
/** A filesystem with this checkout, another draftgate clone, and a foreign project laid out alike. */
const probes: Record<string, HookProbe> = {
  [HOOK]: 'draftgate',
  [OTHER]: 'draftgate',
  '/foreign/adapters/hook/src/main.ts': 'foreign',
};
const probe = (p: string): HookProbe => probes[p] ?? 'unverifiable';
const classify = (command: string) => classifyEntry(command, { hookPath: HOOK, realpath: noRealpath, probe });
const ours = (command: string) => classify(command).kind === 'draftgate';

/** A checkout's settings entry, with a recognisable command. */
function block(command = failClosedCommand({ interpreter: '/opt/bun', hook: HOOK })): HookBlock {
  return hookBlock('^(?:mcp__x__send)$', command, 1260);
}
const foreignBlock = { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /my/guard.sh' }] };
const settings = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
/** The draftgate hook entries a settings text holds, by command. */
const draftgateCommands = (text: string): string[] =>
  (JSON.parse(text).hooks.PreToolUse as { hooks: { command: string }[] }[])
    .flatMap((b) => b.hooks.map((h) => h.command))
    .filter(ours);

const plan = (text: string | null, want: HookBlock | null = block()) =>
  planRegistration(text, want, classify, '/s.json');
/** A plan that must be a change, narrowed. */
function changed(text: string | null, want: HookBlock | null = block()) {
  const p = plan(text, want);
  if (p.kind !== 'changed') throw new Error(`expected a change, got ${p.kind}`);
  return p;
}
const report = (p: Exclude<RegisterPlan, { kind: 'refused' }>, backup: string | null = '/b', want = block(), tools = ['mcp__a__b']) =>
  registerReport(p, { target: '/s.json', backup, registered: { block: want, tools, link: '/here', root: '/plugin/root' } });

describe('classifyEntry: which entries register replaces', () => {
  test('the fail-closed wrapper is draftgate\'s whatever its $2 names', () => {
    // `draftgate-hook` is draftgate's own word, so a wrapper naming a path that moved, or that does
    // not end like the hook does, is still draftgate's, and the one to replace.
    for (const hook of [HOOK, OTHER, GONE, '/renamed/hook.ts']) {
      expect(ours(failClosedCommand({ interpreter: '/opt/bun', hook })), hook).toBe(true);
    }
  });

  test('a bare launch of another draftgate checkout is draftgate\'s', () => {
    // An install in another clone names that clone's hook. Not `ours` in `registration.ts`'s
    // sense, and left alone it is a second entry.
    expect(ours(`'/opt/bun' '${OTHER}'`)).toBe(true);
    expect(ours(`bun ${OTHER}`)).toBe(true);
  });

  test('a path that is gone counts only in the exact two-word shape older versions wrote', () => {
    expect(ours(`'/opt/bun' '${GONE}'`)).toBe(true);
    // Nothing can be verified about a path that is not there, so anything wider is somebody else's.
    expect(ours(`'/opt/bun' '${GONE}' --flag`)).toBe(false);
    expect(ours(`env X=1 bun ${GONE}`)).toBe(false);
    expect(ours(`'${GONE}'`)).toBe(false);
  });

  test('another project that lays out a hook the same way is NOT draftgate\'s', () => {
    // Without the package check, `register` would overwrite that project's hook entry.
    expect(ours(`'/opt/bun' '/foreign/adapters/hook/src/main.ts'`)).toBe(false);
  });

  test('a hook that only MENTIONS this hook\'s path is not draftgate\'s: it is `mentions`', () => {
    // `commandNamesHook` (the reader) takes the path as a substring. Deleting by that would remove
    // a user's own hook; ignoring it would leave a second registration beside the new one.
    for (const command of [
      `sh -c 'logger ${HOOK}.bak'`,
      `logger ${HOOK}.bak`,
      `bash -c "bun ${HOOK}"`,
      `sh -c 'exec bun ${HOOK}'`,
      `bun ${HOOK}||true`,
    ]) {
      expect(classify(command), command).toEqual({ kind: 'mentions' });
    }
    expect(classify(`'/opt/bun' '${HOOK}'`)).toEqual({ kind: 'draftgate', hook: HOOK });
  });

  test('it names the hook a draftgate entry launches', () => {
    expect(classify(failClosedCommand({ interpreter: '/opt/bun', hook: GONE }))).toEqual({ kind: 'draftgate', hook: GONE });
    expect(classify(`env X=1 bun ${OTHER}`)).toEqual({ kind: 'draftgate', hook: OTHER });
  });

  test('unrelated hooks, relative paths and lookalike suffixes are not draftgate\'s', () => {
    expect(ours('bash /my/guard.sh')).toBe(false);
    expect(ours(`bun adapters/hook/src/main.ts`)).toBe(false);
    expect(ours(`bun /x/not-adapters/hook/src/main.ts.bak`)).toBe(false);
    expect(ours(`bun /x/myadapters/hook/src/main.ts`)).toBe(false);
  });

  test('every entry inspectRegistration counts as ours is one register replaces or refuses', () => {
    // The two questions differ on purpose (a separate clone is not `ours`), but only this way: an
    // entry `--doctor` reports as this hook, left beside a new one, would be a second window. The
    // shapes draftgate writes are replaced; anything else the substring match takes is `mentions`,
    // and refused.
    const MAIN = '/repo/adapters/hook/src/main.ts';
    const WT = '/wt/adapters/hook/src/main.ts';
    const at = (root: string, worktree: boolean): Checkout =>
      ({ root, commonDir: '/repo/.git', relative: 'adapters/hook/src/main.ts', worktree });
    const checkouts: Record<string, Checkout> = { [MAIN]: at('/repo', false), [WT]: at('/wt', true) };
    const linked = '/tmp/link/main.ts';
    const realpath = (p: string) => (p === linked || p === WT ? WT : null);
    const commands = [
      `'bun' '${WT}'`,
      `'bun' '${linked}'`,
      `'bun' '${MAIN}'`,
      failClosedCommand({ interpreter: '/opt/bun', hook: MAIN }),
      `bash -c "bun ${WT}"`,
    ];
    const text = settings({
      hooks: { PreToolUse: commands.map((command) => ({ matcher: 'x', hooks: [{ type: 'command', command }] })) },
    });
    const report = inspectRegistration({
      declined: [],
      read: () => ({ kind: 'text', text }),
      realpath,
      checkoutOf: (p) => checkouts[p] ?? null,
      paths: ['/user.json'],
      hookPath: WT,
      toolMap: DEFAULT_TOOL_MAP,
    });
    expect(report.ours).toHaveLength(commands.length);
    const siblingProbe = (p: string): HookProbe => (p in checkouts ? 'draftgate' : 'unverifiable');
    const kinds = commands.map((c) => classifyEntry(c, { hookPath: WT, realpath, probe: siblingProbe }).kind);
    expect(kinds).toEqual(['draftgate', 'draftgate', 'draftgate', 'draftgate', 'mentions']);

  });
});

describe('probeHook, against real files', () => {
  function checkout(name: string, pkg: string | null): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'adapters/hook/src'), { recursive: true });
    writeFileSync(join(root, 'adapters/hook/src/main.ts'), '');
    if (pkg !== null) writeFileSync(join(root, 'package.json'), pkg);
    return join(root, 'adapters/hook/src/main.ts');
  }

  test('a checkout is draftgate\'s by its package.json name', () => {
    expect(probeHook(checkout('dg', JSON.stringify({ name: 'draftgate' })))).toBe('draftgate');
    expect(probeHook(checkout('other', JSON.stringify({ name: 'something-else' })))).toBe('foreign');
    expect(probeHook(checkout('nopkg', null))).toBe('foreign');
    expect(probeHook(checkout('badpkg', '{not json'))).toBe('foreign');
  });

  test('a hook that is not there is unverifiable, not foreign', () => {
    // A checkout that moved: calling it somebody else's would leave it beside the new entry.
    expect(probeHook(join(dir, 'nowhere/adapters/hook/src/main.ts'))).toBe('unverifiable');
  });

  test('this repository is draftgate\'s', () => {
    expect(probeHook(fileURLToPath(new URL('../src/main.ts', import.meta.url)))).toBe('draftgate');
  });
});

describe('planRegistration', () => {
  const want = block();

  test('no file: a file holding exactly the block, laid out as Claude Code writes it', () => {
    const p = changed(null);
    expect(p.text).toBe(settings({ hooks: { PreToolUse: [want] } }));
    expect([p.previous.length, p.shared, p.reformatted]).toEqual([0, 0, false]);
  });

  test('an empty file is the first-write case, not a parse failure', () => {
    for (const text of ['', '  \n']) {
      const p = plan(text);
      expect(p.kind).toBe('changed');
    }
  });

  test('refuses what it cannot read as settings, and says so naming the file', () => {
    const cases: [string, RegExp][] = [
      ['{ "hooks": ', /not valid JSON/],
      ['// comment\n{}', /not valid JSON/],
      ['[]', /not an object/],
      ['"x"', /not an object/],
      [settings({ hooks: [] }), /"hooks" key that is not an object/],
      [settings({ hooks: { PreToolUse: {} } }), /"hooks.PreToolUse" that is not an array/],
    ];
    for (const [text, why] of cases) {
      const p = plan(text);
      expect(p.kind, text).toBe('refused');
      if (p.kind === 'refused') {
        expect(p.why).toMatch(why);
        expect(p.why).toContain('/s.json');
        expect(p.why).toContain('nothing was written');
      }
    }
  });

  test('appends to an existing PreToolUse and leaves every other key and hook as it was', () => {
    const before = {
      env: { TOKEN: 'secret' },
      hooks: { SessionStart: [foreignBlock], PreToolUse: [foreignBlock] },
      model: 'x',
    };
    const p = changed(settings(before));
    expect(JSON.parse(p.text)).toEqual({
      ...before,
      hooks: { SessionStart: [foreignBlock], PreToolUse: [foreignBlock, want] },
    });
    // Key ORDER too: an edit that moved `model` above `hooks` would be a diff the user did not ask for.
    expect(Object.keys(JSON.parse(p.text))).toEqual(['env', 'hooks', 'model']);
  });

  test('replaces an entry for another checkout WHERE IT STANDS', () => {
    const old = block(failClosedCommand({ interpreter: '/old/bun', hook: GONE }));
    const p = changed(settings({ hooks: { PreToolUse: [foreignBlock, old, foreignBlock] } }));
    expect(JSON.parse(p.text).hooks.PreToolUse).toEqual([foreignBlock, want, foreignBlock]);
    expect(p.previous.length).toBe(1);
  });

  test('never leaves a second entry: duplicates collapse into one, in the first one\'s place', () => {
    const p = changed(settings({
      hooks: {
        PreToolUse: [
          block(`'/opt/bun' '${OTHER}'`),
          foreignBlock,
          block(`'/opt/bun' '${GONE}'`),
          block(failClosedCommand({ interpreter: '/opt/bun', hook: HOOK })),
        ],
      },
    }));
    expect(JSON.parse(p.text).hooks.PreToolUse).toEqual([want, foreignBlock]);
    expect(draftgateCommands(p.text)).toHaveLength(1);
    expect(p.previous.length).toBe(3);
  });

  test('a block draftgate SHARES keeps its matcher and the other hooks; draftgate gets its own', () => {
    // Rewriting the shared matcher would change which tools somebody else's hook fires on.
    const sharedBlock = {
      matcher: 'Bash|mcp__x__send',
      hooks: [foreignBlock.hooks[0], { type: 'command', command: `'/opt/bun' '${OTHER}'` }],
    };
    const p = changed(settings({ hooks: { PreToolUse: [sharedBlock] } }));
    expect(JSON.parse(p.text).hooks.PreToolUse).toEqual([
      { matcher: 'Bash|mcp__x__send', hooks: [foreignBlock.hooks[0]] },
      want,
    ]);
    expect([p.previous.length, p.shared]).toEqual([1, 1]);
  });

  test('a hook that NAMES draftgate\'s in a shape draftgate never wrote is refused, by place', () => {
    // Removing it could delete somebody's hook; keeping it beside a new one could be two windows.
    const secretive = { matcher: 'x', hooks: [{ type: 'command', command: `bash -c "bun ${HOOK} SECRET"` }] };
    const p = plan(settings({ hooks: { PreToolUse: [foreignBlock, secretive] } }));
    if (p.kind !== 'refused') throw new Error(p.kind);
    expect(p.why).toContain('hooks.PreToolUse[1]');
    expect(p.why).toContain('nothing was written');
    // Named by place and never by command, which can hold a token.
    expect(p.why).not.toContain('SECRET');
  });

  test('a hook of another TYPE, or a block it cannot read, is left exactly as it was', () => {
    const odd = [
      { matcher: 'x', hooks: [{ type: 'http', command: `'/opt/bun' '${OTHER}'` }] },
      { matcher: 'y', hooks: 'not a list' },
      'not a block',
    ];
    const p = changed(settings({ hooks: { PreToolUse: odd } }));
    expect(JSON.parse(p.text).hooks.PreToolUse).toEqual([...odd, want]);
  });

  test('already exactly registered: unchanged, so nothing is written and no backup is made', () => {
    const text = settings({ env: { A: '1' }, hooks: { PreToolUse: [foreignBlock, want] } });
    expect(plan(text)).toEqual({ kind: 'unchanged' });
  });

  test('keeps the file\'s own indent and its last byte', () => {
    const four = JSON.stringify({ a: 1 }, null, 4);
    const p4 = changed(four);
    expect(p4.text).toBe(JSON.stringify({ a: 1, hooks: { PreToolUse: [want] } }, null, 4));
    expect(p4.reformatted).toBe(false);
    const tabs = JSON.stringify({ a: 1 }, null, '\t') + '\n';
    const pt = changed(tabs);
    expect(pt.text).toBe(JSON.stringify({ a: 1, hooks: { PreToolUse: [want] } }, null, '\t') + '\n');
  });

  test('a file in some other layout is re-indented, SAYS so, and diffs only what changed', () => {
    const p = changed('{"a": 1, "b": [1, 2]}\n');
    expect(p.reformatted).toBe(true);
    expect(JSON.parse(p.text)).toEqual({ a: 1, b: [1, 2], hooks: { PreToolUse: [want] } });
    expect(p.diff.join('\n')).not.toContain('"a"');
  });

  test('a rewritten file claims nothing about values it cannot vouch for', () => {
    // A key written twice keeps only its last value through `JSON.parse`, and the diff is taken
    // between two renderings of the parsed form, so it cannot show the first one going.
    const p = changed('{\n  "env": { "A": "first" },\n  "env": { "A": "second" }\n}\n');
    expect(p.reformatted).toBe(true);
    const text = report(p, '/s.bak', want);
    expect(text).not.toContain('Nothing else in the file changed');
    expect(text).not.toContain('No value');
    expect(text).toContain('Compare it with the backup');
    // The other side: a file in Claude Code's own layout can hold no such thing, so it may say so.
    const clean = changed(settings({ env: { A: '1' } }));
    expect(report(clean, '/s.bak', want))
      .toContain('Nothing else in the file changed.');
  });

  test('the indent is a TOP-level key\'s, even when the first key shares a line with the brace', () => {
    const p = changed('{ "env": {\n    "X": "y"\n  },\n  "a": 1\n}\n');
    expect(p.text).toBe(settings({ env: { X: 'y' }, a: 1, hooks: { PreToolUse: [want] } }));
  });

  test('want null removes every draftgate entry and nothing else (the uninstall half)', () => {
    const text = settings({ hooks: { PreToolUse: [block(`'/opt/bun' '${OTHER}'`), foreignBlock] } });
    const p = changed(text, null);
    expect(JSON.parse(p.text)).toEqual({ hooks: { PreToolUse: [foreignBlock] } });
    expect(plan(null, null).kind).toBe('unchanged');
    expect(plan(settings({ a: 1 }), null).kind).toBe('unchanged');
  });

  test('a removal that empties PreToolUse takes it out, and hooks too when nothing else is in it', () => {
    // Every other key keeps its place: the diff is the removal and nothing else.
    const alone = settings({ env: { A: 'b' }, hooks: { PreToolUse: [block()] }, statusLine: { type: 'x' } });
    expect(changed(alone, null).text).toBe(settings({ env: { A: 'b' }, statusLine: { type: 'x' } }));
    const beside = settings({ hooks: { SessionStart: [foreignBlock], PreToolUse: [block(), block(`'/opt/bun' '${OTHER}'`)] } });
    expect(changed(beside, null).text).toBe(settings({ hooks: { SessionStart: [foreignBlock] } }));
    // What `register` wrote into a file that had none, `uninstall` takes back out.
    expect(changed(changed(null).text, null).text).toBe('{}\n');
  });

  test('an empty PreToolUse somebody else wrote is theirs, and is left as it was', () => {
    expect(plan(settings({ hooks: { PreToolUse: [] } }), null).kind).toBe('unchanged');
  });

  test('a removal from a block draftgate shares leaves the block, its matcher and the other hooks', () => {
    const shared = { matcher: 'Bash', hooks: [foreignBlock.hooks[0], block().hooks[0]] };
    const p = changed(settings({ hooks: { PreToolUse: [shared] } }), null);
    expect(JSON.parse(p.text)).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreignBlock.hooks[0]] }] } });
    expect(p.shared).toBe(1);
  });

  test('a removal refuses a hook that only NAMES draftgate\'s, as register does', () => {
    const named = { matcher: 'x', hooks: [{ type: 'command', command: `sh -c "bun ${HOOK}"` }] };
    const p = plan(settings({ hooks: { PreToolUse: [foreignBlock, named] } }), null);
    expect(p.kind).toBe('refused');
    expect((p as { why: string }).why).toContain('hooks.PreToolUse[1]');
  });
});

describe('movedElsewhere: where reviews kept files that a shell run of uninstall would not look', () => {
  const settingsWith = (env: unknown) => settings({ env, hooks: {} });

  test('a home or log the settings env sets differently from this run is named, with both values', () => {
    const text = settingsWith({ JIRA_TOKEN: 'SECRET-1', DRAFTGATE_AUDIT_LOG: '/logs/dg.jsonl', DRAFTGATE_HOME: '/dg' });
    expect(movedElsewhere(text, { DRAFTGATE_HOME: '/dg' })).toEqual([
      { name: 'DRAFTGATE_AUDIT_LOG', settings: '/logs/dg.jsonl', here: undefined },
    ]);
  });

  test('nothing to name: the same value, an empty one (the log turned off), no env, or a file that does not parse', () => {
    expect(movedElsewhere(settingsWith({ DRAFTGATE_AUDIT_LOG: '/l' }), { DRAFTGATE_AUDIT_LOG: '/l' })).toEqual([]);
    expect(movedElsewhere(settingsWith({ DRAFTGATE_AUDIT_LOG: '' }), {})).toEqual([]);
    expect(movedElsewhere(settings({ a: 1 }), {})).toEqual([]);
    expect(movedElsewhere('{ not json', {})).toEqual([]);
    expect(movedElsewhere(null, {})).toEqual([]);
  });

  test('the report says where, and that the value stays in the file', () => {
    const text = unregisterReport({ kind: 'unchanged' }, {
      target: '/c/settings.json', backup: null, backups: [],
      moved: [{ name: 'DRAFTGATE_AUDIT_LOG', settings: '/logs/dg.jsonl', here: undefined }],
    });
    expect(text).toContain('settings.json sets DRAFTGATE_AUDIT_LOG to /logs/dg.jsonl for reviews, and this runs with none:');
    expect(text).toContain('again with DRAFTGATE_AUDIT_LOG=/logs/dg.jsonl.');
  });
});

describe('unregisterReport', () => {
  const backups = ['/c/settings.json.draftgate-backup-1', '/c/settings.json.draftgate-backup-2'];

  test('says what it removed, what it ran, the backup, and every backup it leaves behind', () => {
    const p = changed(settings({ env: { T: 'SECRET-1' }, hooks: { PreToolUse: [block(`'/opt/bun' '${OTHER}'`)] } }), null);
    const text = unregisterReport(p, { target: '/c/settings.json', backup: backups[1]!, backups, moved: [] });
    expect(text).toContain('draftgate is no longer registered in /c/settings.json.');
    expect(text).toContain(`  was       ${OTHER}`);
    expect(text).toContain(`  backup    ${backups[1]}`);
    expect(text).toContain('2 backups draftgate made of this file are beside it (settings.json.draftgate-backup-*)');
    expect(text).toContain('tokens included');
    // `hooks` was the last key, so `env` lost its comma: somebody else's value, which is not shown.
    expect(text).not.toContain('SECRET');
  });

  test('nothing to remove: says so, and still names the backups', () => {
    const text = unregisterReport({ kind: 'unchanged' }, { target: '/c/settings.json', backup: null, backups: backups.slice(0, 1), moved: [] });
    expect(text).toStartWith('draftgate is not registered in /c/settings.json. Nothing changed.\n');
    expect(text).toContain('1 backup draftgate made of this file is beside it');
  });
});

/**
 * `settings.json` holds tokens, and what `register` prints in an agent session becomes part of a
 * conversation. The diff may show draftgate's entry and the punctuation around it, never a line of
 * somebody else's value.
 */
describe('the printed diff carries no secret', () => {
  const want = block();
  const shapes: [string, Record<string, unknown>][] = [
    // `hooks` is new, so it lands after the file's last key, and that key's last line gains a comma.
    ['env last', { permissions: { allow: [] }, env: { JIRA_TOKEN: 'SECRET-1', B: 'SECRET-2' } }],
    ['scalar last', { env: { A: 'SECRET-1' }, apiKeyHelper: 'SECRET-2' }],
    // A foreign hook's command can hold a token too, beside draftgate's in the same array or block.
    ['foreign hook before', {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'curl -H SECRET-1' }] }] },
    }],
    ['shared block', {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'curl -H SECRET-1' },
            { type: 'command', command: `'/opt/bun' '${OTHER}'` },
          ],
        }],
      },
    }],
  ];
  for (const [name, before] of shapes) {
    test(name, () => {
      const p = changed(settings(before), want);
      const printed = report(p, '/s.bak', want);
      expect(printed).not.toContain('SECRET');
      // What it does print is the entry it wrote.
      expect(printed).toContain(`+${' '.repeat(12)}"command": ${JSON.stringify(want.hooks[0].command)}`);
    });
  }
});

describe('changedLines', () => {
  test('a line that only gained or lost a trailing comma is not a change', () => {
    expect(changedLines('{\n  "a": 1\n}\n', '{\n  "a": 1,\n  "b": 2\n}\n')).toEqual([
      '@@ line 3 @@',
      '+  "b": 2',
    ]);
  });

  test('each run is headed by the new file\'s line number, and unchanged lines are left out', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'B', 'c', 'd', 'E', 'f'].join('\n');
    expect(changedLines(before, after)).toEqual(['@@ line 2 @@', '-b', '+B', '@@ line 5 @@', '-e', '+E', '+f']);
  });

  test('identical text has nothing to print', () => {
    expect(changedLines('x\ny\n', 'x\ny\n')).toEqual([]);
  });
});

describe('registerReport', () => {
  const want = block(failClosedCommand({ interpreter: '/opt/homebrew/bin/bun', hook: HOOK }));

  test('names what it wrote: the hook, how bun is found, each tool, the timeout and the backup', () => {
    const p = changed(null, want);
    const tools = Array.from({ length: 19 }, (_, i) => `mcp__s__t${i}`);
    const text = report(p, null, want, tools);
    expect(text).toContain('draftgate is registered in /s.json.');
    expect(text).toContain("Added draftgate's entry");
    expect(text).toContain(`hook      ${HOOK}`);
    expect(text).toContain("run by    bun, found the way the plugin's own hook finds it");
    for (const tool of tools) expect(text).toContain(`\n              ${tool}\n`);
    expect(text).toContain('timeout   1260s');
    expect(text).toContain('backup    none');
    // The entry runs through the plugin link, which each session keeps on the version it runs.
    expect(text).toContain('  through   /here -> /plugin/root\n');
    expect(text).toContain("so the entry\n  follows draftgate's updates. To check it: `draftgate doctor`");
  });

  test('names the hook a replaced entry RAN, when it was another one', () => {
    // A registration moved to whichever checkout this ran from is the consequence to know about.
    const text = settings({ hooks: { PreToolUse: [block(failClosedCommand({ interpreter: '/b', hook: GONE }))] } });
    const p = changed(text, want);
    expect(report(p, '/b', want))
      .toContain(`was       ${GONE}`);
    // And says nothing of the kind when the entry already ran this hook.
    const same = settings({ hooks: { PreToolUse: [block(`'/old/bun' '${HOOK}'`)] } });
    const q = changed(same, want);
    expect(report(q, '/b', want)).not.toContain('was  ');
  });

  test('says how many windows a collapsed duplicate was opening', () => {
    const text = settings({ hooks: { PreToolUse: [block(`'/opt/bun' '${OTHER}'`), block(`'/opt/bun' '${GONE}'`)] } });
    const p = changed(text, want);
    expect(report(p, '/b', want))
      .toContain('opened 2 review windows');
  });
});
