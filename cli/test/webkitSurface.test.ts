/**
 * `cli/src/surfaces/webkit.ts`: which binary a WebKit review spawns.
 *
 * The host is built by the review that finds none of this source, and a build that fails spawns
 * nothing. The harness binary, whose channel can click Approve, is handed over only for a live
 * harness nonce. The window itself is `surface:host`'s and `surface:e2e`'s.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMEDY } from '../../core/src/remedies';
import { MIN_MACOS, hostInputs, hostLayout } from '../src/reviewHost';
import { HARNESS_ENV, HARNESS_NONCE_ENV, harnessRequested, resolveHostBinary } from '../src/surfaces/webkit';
import { tooLittleLeft } from '../src/surfaces/window';

const ROOT = join(import.meta.dir, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'draftgate-webkit-surface-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A root holding exactly the host's inputs. */
function root(name: string): string {
  const r = join(scratch, name);
  for (const rel of hostInputs(hostLayout(ROOT))) {
    mkdirSync(join(r, rel, '..'), { recursive: true });
    cpSync(join(ROOT, rel), join(r, rel));
  }
  cpSync(join(ROOT, 'package.json'), join(r, 'package.json'));
  return r;
}

/** A channel directory holding a nonce, as a harness writes one; returns the env that names it. */
function harness(name: string, nonce = randomUUID()): Record<string, string> {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nonce'), nonce);
  return { [HARNESS_ENV]: dir, [HARNESS_NONCE_ENV]: nonce };
}

describe('the harness binary is for a live harness only', () => {
  test('no request is no request', () => {
    expect(harnessRequested({})).toEqual({ open: false, why: null });
  });

  test('a live nonce opens it', () => {
    expect(harnessRequested(harness('live'))).toEqual({ open: true, why: null });
  });

  test('a channel with no nonce, the wrong one, or a stale file is refused, saying why', () => {
    const live = harness('refusals');
    expect(harnessRequested({ [HARNESS_ENV]: live[HARNESS_ENV]! }).why).toContain('no nonce');
    expect(harnessRequested({ ...live, [HARNESS_NONCE_ENV]: randomUUID() }).why).toContain('holds a different value');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(live[HARNESS_ENV]!, 'nonce'), old, old);
    expect(harnessRequested(live).why).toContain('left over');
  });
});

describe('the binary a review spawns', () => {
  test('a host nobody built is built by the review, and a live harness gets the harness build', async () => {
    const layout = hostLayout(root('build-on-demand'));
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const first = await resolveHostBinary(Date.now() + 60_000, { layout, env: {}, log });
    expect('bin' in first && first.bin).toMatch(/\/draftgate\.app\/Contents\/MacOS\/draftgate$/);
    expect(lines.join('\n')).toContain('building it before the review');

    // Built now, so the next review builds nothing -- and a live harness is handed its own binary.
    lines.length = 0;
    const driven = await resolveHostBinary(Date.now() + 60_000, { layout, env: harness('handed'), log });
    expect('bin' in driven && driven.bin).toMatch(/\/draftgate-harness\.app\/Contents\/MacOS\/draftgate$/);
    expect(lines).toEqual([]);

    // A variable left over is ignored, loudly, and the review opens the real window.
    const stale = harness('stale');
    const staleNonce = stale[HARNESS_NONCE_ENV]!;
    const refused = await resolveHostBinary(Date.now() + 60_000, {
      layout,
      env: { ...stale, [HARNESS_NONCE_ENV]: staleNonce.slice(0, 8) },
      log,
    });
    expect('bin' in refused && refused.bin).toMatch(/\/draftgate\.app\/Contents\/MacOS\/draftgate$/);
    expect(lines.join('\n')).toContain(`ignoring ${HARNESS_ENV}`);
  }, 60_000);

  test('a build says it spent the deadline, and too little left spawns nothing: a window killed at once reads as a timeout', async () => {
    const layout = hostLayout(root('late'));
    const out = await resolveHostBinary(Date.now() + 60_000, { layout, env: {}, log: () => {} });
    const spent = 'bin' in out ? out.spent : undefined;
    expect(spent?.what).toBe('Building the review host');
    // `windowSurface`'s one check, which the bundle rebuild goes through too.
    expect(tooLittleLeft(Date.now() + 5_000, [spent])).toContain('too little of the review deadline');
    // The build succeeded, so there is nothing to run: the next send finds it built.
    expect(tooLittleLeft(Date.now() + 5_000, [spent])).toContain('The next send opens the window.');
    expect(tooLittleLeft(Date.now() + 60_000, [spent])).toBeNull();
    // Nothing spent, nothing to hold it to: a review with seconds left and a current host still opens.
    expect(tooLittleLeft(Date.now() + 1_000, [undefined])).toBeNull();
    // And the built host is current, so the next review spends nothing.
    const again = await resolveHostBinary(Date.now() + 60_000, { layout, env: {}, log: () => {} });
    expect('bin' in again && again.spent).toBeUndefined();
  }, 60_000);

  test('a Mac below the floor is told so, with no command that would only refuse again', async () => {
    const out = await resolveHostBinary(Date.now() + 60_000, {
      layout: hostLayout(root('old-mac')), env: {}, log: () => {}, macos: '15.6',
    });
    expect('refusal' in out && out.refusal).toContain('this Mac runs macOS 15.6');
    expect('refusal' in out && out.refusal).not.toContain(REMEDY.install);
  });

  test('a machine with no macOS is told it is not macOS, not that it is a Mac', async () => {
    const out = await resolveHostBinary(Date.now() + 60_000, {
      layout: hostLayout(root('not-a-mac')), env: {}, log: () => {}, macos: null,
    });
    expect('refusal' in out && out.refusal).toBe(
      `The review host could not be built, so no window was shown: the review window needs macOS ${MIN_MACOS} or newer, and this is not macOS.`
    );
  });

  test('a host that cannot be built spawns nothing, and says what fixes it', async () => {
    const r = root('broken');
    appendFileSync(join(r, 'surface', 'host', 'draftgate.m'), '\nthis is not Objective-C;\n');
    const out = await resolveHostBinary(Date.now() + 60_000, { layout: hostLayout(r), env: {}, log: () => {} });
    expect('refusal' in out && out.refusal).toContain('The review host could not be built, so no window was shown');
    expect('refusal' in out && out.refusal).toContain(REMEDY.doctor);
  }, 60_000);
});
