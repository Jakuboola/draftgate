/**
 * Building the WebKit host (`cli/src/reviewHost.ts`): when it counts as built, what a
 * source change does, and what every failure leaves behind.
 *
 * The builds are real: `clang` and `codesign` on a scratch copy of the host's inputs, so a test
 * may edit a source file without touching this checkout's. About a second a build; the binaries'
 * own properties are `surface/harness/host.test.ts`'s, and whether the host works is
 * `surface:host`'s.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_MACOS, ToolFailure, belowFloor, buildHost, hostApps, hostFacts, hostInputs, hostInputsHash, hostLayout, hostState,
  macosVersion, runner,
} from '../src/reviewHost';

const ROOT = join(import.meta.dir, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'draftgate-host-build-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A root holding exactly the host's inputs, which a test may then change. */
function root(name: string): string {
  const r = join(scratch, name);
  for (const rel of hostInputs(hostLayout(ROOT))) {
    mkdirSync(join(r, rel, '..'), { recursive: true });
    cpSync(join(ROOT, rel), join(r, rel));
  }
  cpSync(join(ROOT, 'package.json'), join(r, 'package.json'));
  return r;
}

describe('the inputs', () => {
  test('are every file in surface/host, the icon and the build script -- and never the build dir', () => {
    const inputs = hostInputs(hostLayout(ROOT));
    expect(inputs).toContain('surface/host/draftgate.m');
    expect(inputs).toContain('surface/host/harness.m');
    expect(inputs).toContain('surface/host/host.h');
    expect(inputs).toContain('surface/icon/draftgate.icns');
    expect(inputs).toContain('cli/src/reviewHost.ts');
    expect(inputs.some((p) => p.startsWith('surface/host/build'))).toBe(false);
  });

  test("a layout that builds elsewhere still never hashes the checkout's own build directory", () => {
    const inputs = hostInputs(hostLayout(ROOT, join(scratch, 'elsewhere')));
    expect(inputs.some((p) => p.startsWith('surface/host/build'))).toBe(false);
  });

  test('the package version is an input, because the Info.plist carries it', () => {
    const r = root('version');
    const before = hostInputsHash(hostLayout(r));
    writeFileSync(join(r, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(hostInputsHash(hostLayout(r))).not.toBe(before);
  });

  test('a NEW file in surface/host is an input with no listing, as a new header must be', () => {
    const r = root('new-file');
    const before = hostInputsHash(hostLayout(r));
    writeFileSync(join(r, 'surface', 'host', 'extra.h'), '// a new header\n');
    expect(hostInputs(hostLayout(r))).toContain('surface/host/extra.h');
    expect(hostInputsHash(hostLayout(r))).not.toBe(before);
  });
});

describe('built, stale, missing', () => {
  // One lifecycle, because every build costs a second.
  test('missing, then current, a no-op again, stale after an edit, and a rebuild that sweeps', async () => {
    const r = root('lifecycle');
    const layout = hostLayout(r);
    expect(hostState(layout).state).toBe('missing');

    const first = await buildHost(layout);
    expect(hostState(layout)).toEqual({ state: 'current', apps: first });
    // A current host needs no compiler, so `hostFacts` does not ask for one: both reports' verdict.
    const unasked = () => { throw new Error('asked for the Command Line Tools of a current host'); };
    expect(hostFacts(layout, { macos: '27.0', commandLineTools: unasked }).verdict).toEqual({ kind: 'current' });
    // ...and the floor comes before it: a current host on a Mac below the floor still opens nothing.
    expect(hostFacts(layout, { macos: '15.6', commandLineTools: unasked }).verdict.kind).toBe('below-floor');
    expect(existsSync(first.review.bin) && existsSync(first.harness.bin)).toBe(true);

    let ran = 0;
    expect(await buildHost(layout, { run: async () => void ran++ })).toEqual(first);
    expect(ran).toBe(0);

    appendFileSync(join(r, 'surface', 'host', 'draftgate.m'), '\n// an edit\n');
    const stale = hostState(layout);
    expect(stale.state).toBe('stale');
    expect(stale.state === 'stale' && stale.why).toContain(first.hash);

    // What a SIGKILLed build leaves, from a dead pid and from a live one (this test's parent).
    const dead = `.building-999999-00000000-${first.hash}`;
    const live = `.building-${process.ppid}-00000000-${first.hash}`;
    mkdirSync(join(layout.buildDir, dead, 'draftgate.app'), { recursive: true });
    mkdirSync(join(layout.buildDir, live), { recursive: true });

    const second = await buildHost(layout);
    expect(second.hash).not.toBe(first.hash);
    expect(hostState(layout).state).toBe('current');
    // The older source's build and the dead build are gone; a live builder's directory is not ours.
    expect(readdirSync(layout.buildDir).sort()).toEqual([live, second.hash].sort());
  }, 30_000);

  test('two builds of one source at once both succeed, and leave one build', async () => {
    const r = root('concurrent');
    const layout = hostLayout(r);
    const [a, b] = await Promise.all([buildHost(layout), buildHost(layout)]);
    expect(a.dir).toBe(b.dir);
    expect(hostState(layout).state).toBe('current');
    expect(readdirSync(layout.buildDir)).toEqual([a.hash]);
  }, 30_000);
});

describe('what names a build', () => {
  test("the CPU architecture is in it, so a build carried to the other kind of Mac is not this one's", () => {
    const layout = hostLayout(ROOT);
    const here = hostInputsHash(layout);
    const arch = process.arch;
    Object.defineProperty(process, 'arch', { value: arch === 'arm64' ? 'x64' : 'arm64' });
    try {
      expect(hostInputsHash(layout)).not.toBe(here);
    } finally {
      Object.defineProperty(process, 'arch', { value: arch });
    }
    expect(hostInputsHash(layout)).toBe(here);
  });

  test('a source edited DURING the build is not filed under the name it began with', async () => {
    const layout = hostLayout(root('moved'));
    const before = hostInputsHash(layout);
    let edited = false;
    // The first compile edits a source, as a save landing mid-build would; the retry builds clean.
    const run = async (cmd: string, args: readonly string[]) => {
      if (cmd === 'clang' && !edited) {
        edited = true;
        appendFileSync(join(layout.root, 'surface', 'host', 'draftgate.m'), '\n// edited mid-build\n');
      }
      if (cmd === 'clang') writeFileSync(args[args.indexOf('-o') + 1]!, '');
    };
    const apps = await buildHost(layout, { run, macos: '27.0' });
    expect(apps.hash).not.toBe(before);
    expect(apps.hash).toBe(hostInputsHash(layout));
    expect(existsSync(join(layout.buildDir, before))).toBe(false);
    expect(hostState(layout).state).toBe('current');
  });

  test('a source that keeps moving is built twice and then refused, with nothing filed', async () => {
    const layout = hostLayout(root('moving'));
    let compiles = 0;
    const run = async (cmd: string, args: readonly string[]) => {
      if (cmd !== 'clang') return;
      compiles++;
      appendFileSync(join(layout.root, 'surface', 'host', 'draftgate.m'), `\n// edit ${compiles}\n`);
      writeFileSync(args[args.indexOf('-o') + 1]!, '');
    };
    await expect(buildHost(layout, { run, macos: '27.0' })).rejects.toThrow('changed while it was being built, twice');
    // Two bundles a build, two builds.
    expect(compiles).toBe(4);
    expect(hostState(layout).state).not.toBe('current');
    expect(readdirSync(layout.buildDir)).toEqual([]);
  });
});

describe('a build that fails leaves nothing that reads as built', () => {
  test('a compile error names clang and its output', async () => {
    const r = root('broken');
    const layout = hostLayout(r);
    appendFileSync(join(r, 'surface', 'host', 'draftgate.m'), '\nthis is not Objective-C;\n');
    await expect(buildHost(layout)).rejects.toThrow(/clang exited 1: .*error/);
    expect(hostState(layout).state).toBe('missing');
    expect(existsSync(hostApps(layout).dir)).toBe(false);
    expect(readdirSync(layout.buildDir)).toEqual([]);
  }, 30_000);

  test('no Command Line Tools is said as such, before clang is ever run', async () => {
    const layout = hostLayout(root('no-tools'));
    const ran: string[] = [];
    const run = async (cmd: string) => {
      ran.push(cmd);
      if (cmd === 'xcode-select') throw new ToolFailure('exit', 'xcode-select exited 2');
    };
    await expect(buildHost(layout, { run })).rejects.toThrow('the Command Line Tools are not installed; run `xcode-select --install`');
    expect(ran).toEqual(['xcode-select']);
  });

  test("...but a deadline that kills xcode-select is the deadline, not advice to install the tools", async () => {
    const layout = hostLayout(root('tools-deadline'));
    const run = async () => {
      throw new ToolFailure('timeout', 'xcode-select ran past its deadline and was killed');
    };
    await expect(buildHost(layout, { run })).rejects.toThrow('xcode-select ran past its deadline');
    // Nor is anything that is not a tool's own failure.
    await expect(buildHost(layout, { run: async () => { throw new Error('something else'); } })).rejects.toThrow('something else');
  });
});

/*
 * macOS 26 and newer only. Read off the version file, not the kernel: the Darwin number does not
 * track macOS (macOS 26 is Darwin 25, macOS 27 is Darwin 27).
 */
describe('the macOS floor', () => {
  test('26 and newer build; older, or no version to read, is refused naming both', () => {
    expect(belowFloor(MIN_MACOS)).toBeNull();
    expect(belowFloor('27.0')).toBeNull();
    expect(belowFloor('26.4.1')).toBeNull();
    expect(belowFloor('15.6')).toContain(`needs macOS ${MIN_MACOS} or newer, and this Mac runs macOS 15.6`);
    expect(belowFloor(null)).toBe(`the review window needs macOS ${MIN_MACOS} or newer, and this is not macOS`);
    expect(belowFloor('')).toBe(`the review window needs macOS ${MIN_MACOS} or newer, and this Mac's version could not be read`);
    expect(belowFloor('not a version')).not.toBeNull();
  });

  test("the version is the plist's ProductVersion; off macOS there is none, and a Mac's plist that names none is ''", () => {
    const plist = join(scratch, 'SystemVersion.plist');
    writeFileSync(plist, '<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>26.1</string>\n</dict>');
    expect(macosVersion(plist, 'darwin')).toBe('26.1');
    // The platform decides, not the file: a Linux machine holding a copy of one is still not macOS.
    expect(macosVersion(plist, 'linux')).toBeNull();
    expect(macosVersion(plist, 'win32')).toBeNull();
    expect(macosVersion(join(scratch, 'absent.plist'), 'darwin')).toBe('');
    const versionless = join(scratch, 'versionless.plist');
    writeFileSync(versionless, '<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n</dict>');
    expect(macosVersion(versionless, 'darwin')).toBe('');
    // This Mac: whatever it is, it is read.
    expect(macosVersion()).toMatch(/^\d+\.\d+/);
  });

  test('the verdict both reports give: the floor first, then a host that needs building and a compiler', () => {
    const layout = hostLayout(root('verdict'));
    expect(hostFacts(layout, { macos: '27.0', commandLineTools: () => true }).verdict).toEqual({ kind: 'builds-on-review' });
    expect(hostFacts(layout, { macos: '27.0', commandLineTools: () => false }).verdict).toEqual({ kind: 'no-compiler' });
    // Below the floor nothing else is worth saying, the tools included.
    expect(hostFacts(layout, { macos: '15.6', commandLineTools: () => true }).verdict).toEqual({
      kind: 'below-floor', why: belowFloor('15.6')!,
    });
  });

  test('a build below the floor is refused before any tool runs', async () => {
    const layout = hostLayout(root('old-mac'));
    let ran = 0;
    await expect(buildHost(layout, { macos: '15.6', run: async () => void ran++ })).rejects.toThrow('this Mac runs macOS 15.6');
    expect(ran).toBe(0);
    expect(hostState(layout).state).toBe('missing');
  });
});

describe('every tool runs under the deadline', () => {
  // `clang` killed at the deadline while its `ld` still holds the inherited pipes: a runner that
  // waits for `close` waits for the grandchild too (`sleep 3 &` here).
  test('a killed tool whose grandchild still holds its pipes settles at the deadline', async () => {
    const started = Date.now();
    const failure = await runner(Date.now() + 200)('/bin/sh', ['-c', 'sleep 3 & exec sleep 3']).catch((e) => e);
    expect(failure).toBeInstanceOf(ToolFailure);
    expect((failure as ToolFailure).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('a tool that fails says how, with the end of what it printed', async () => {
    const failure = await runner(Date.now() + 5000)('/bin/sh', ['-c', 'echo nope >&2; exit 3']).catch((e) => e);
    expect((failure as ToolFailure).kind).toBe('exit');
    expect((failure as Error).message).toBe('/bin/sh exited 3: nope');
  });

  test('a tool that is not there is a spawn failure', async () => {
    const failure = await runner(Date.now() + 5000)('/nonexistent/tool', []).catch((e) => e);
    expect((failure as ToolFailure).kind).toBe('error');
  });
});
