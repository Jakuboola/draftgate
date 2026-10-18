import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NONCE_FILE, nonceIsLive } from '../../cli/src/harnessNonce';
import { releaseNonces, writeNonce } from './shared';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-nonce-writer-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The writer's half of the nonce invariant (`cli/test/harnessNonce.test.ts` is the gate's). The
 * gate refuses a stale nonce, so an interrupted run is safe; `writeNonce` and `releaseNonces` make a
 * completed run leave nothing. `e2e.ts` fails at its end if any nonce file survived.
 */
describe('writeNonce writes a key and releaseNonces takes it back', () => {
  test('the file exists while the run needs it, and not afterwards', () => {
    const scenario = join(dir, 'scenario');
    const nonce = writeNonce(scenario);
    const path = join(scenario, NONCE_FILE);

    expect(existsSync(path)).toBe(true);
    // One the gate honours, or the CLI would open the real window for every driven flow.
    expect(nonceIsLive(nonce, path).live).toBe(true);

    releaseNonces();
    expect(existsSync(path)).toBe(false);
    // Idempotent: `e2e.ts` calls it per flow AND from an `exit` handler.
    releaseNonces();
    expect(existsSync(path)).toBe(false);
  });

  test('every nonce written, not just the last one', () => {
    const a = join(dir, 'many-a');
    const b = join(dir, 'many-b');
    writeNonce(a);
    writeNonce(b);
    expect(existsSync(join(a, NONCE_FILE))).toBe(true);
    expect(existsSync(join(b, NONCE_FILE))).toBe(true);
    releaseNonces();
    expect(existsSync(join(a, NONCE_FILE))).toBe(false);
    expect(existsSync(join(b, NONCE_FILE))).toBe(false);
  });
});
