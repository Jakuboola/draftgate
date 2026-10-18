/**
 * The harness nonce gate, against one table. The writer's half -- that a run leaves no nonce
 * behind -- is `surface/harness/nonces.test.ts`, beside the harness helpers it tests.
 *
 * `nonceIsLive` guards the hook's `--surface` override and the CLI's choice of the host's harness
 * build, both approval paths. The two back doors:
 *
 *  - Emptiness dressed as a value: `!!' '` is true and `''.trim() === ' '.trim()`, so a gate that
 *    only trims and compares accepts `' '` against `/dev/null`, and the hook answers `allow`.
 *  - A stale match: a perfect match left over from a finished run, so a file must also be recent.
 *
 * A window run cannot check the gate that lets it in, so this runs under `bun test`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NONCE_MAX_AGE_MS, NONCE_MIN_LENGTH, nonceIsLive } from '../src/harnessNonce';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-nonce-gates-'));
// Removed after the run, like every suite's scratch directory: `test/tempDirs.test.ts` is the guard.
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write a nonce file and return its path. `ageMs` backdates it. */
function nonceFile(name: string, content: string, ageMs = 0): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  if (ageMs !== 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }
  return path;
}

const live = randomUUID();
const livePath = nonceFile('live', live);
const emptyPath = nonceFile('empty', '');
const shortValue = 'letmein';
const shortPath = nonceFile('short', shortValue);
const leftover = randomUUID();
const leftoverPath = nonceFile('leftover', leftover, 60 * 60 * 1000);
const futureNonce = randomUUID();
const futurePath = nonceFile('future', futureNonce, -60 * 60 * 1000);
const paddedNonce = randomUUID();
const paddedPath = nonceFile('padded', `  ${paddedNonce}\n`);

/** Every case: what goes in, and whether a harness is really alive. */
const CASES: Array<{ label: string; nonce: unknown; path: unknown; live: boolean }> = [
  // The one shape that must work, or the harness stops verifying anything.
  { label: 'the nonce this run wrote', nonce: live, path: livePath, live: true },
  // Surrounding whitespace on either side is incidental; it is why the gate trims at all.
  { label: 'the same nonce, file padded with whitespace', nonce: paddedNonce, path: paddedPath, live: true },

  // Emptiness dressed as a value.
  { label: 'a space against /dev/null', nonce: ' ', path: '/dev/null', live: false },
  { label: 'a newline against /dev/null', nonce: '\n', path: '/dev/null', live: false },
  { label: 'a space against an empty file', nonce: ' ', path: emptyPath, live: false },
  { label: 'tabs and spaces against an empty file', nonce: ' \t \n ', path: emptyPath, live: false },
  { label: 'the empty string against an empty file', nonce: '', path: emptyPath, live: false },
  { label: 'a short guessable value the file agrees with', nonce: shortValue, path: shortPath, live: false },

  // A perfect match that is simply old.
  { label: 'a leftover file from an hour ago', nonce: leftover, path: leftoverPath, live: false },
  { label: 'a file dated an hour in the FUTURE', nonce: futureNonce, path: futurePath, live: false },

  // The ordinary refusals.
  { label: 'a nonce with no file named', nonce: live, path: undefined, live: false },
  { label: 'a nonce naming a file that is not there', nonce: live, path: join(dir, 'nope'), live: false },
  { label: 'a file that holds a different nonce', nonce: randomUUID(), path: livePath, live: false },
  { label: 'no nonce at all', nonce: undefined, path: livePath, live: false },
  { label: 'an empty path', nonce: live, path: '', live: false },
];

describe('the nonce gate', () => {
  test('has bounds that mean something', () => {
    // A min length of 0 or an age bound of Infinity would pass the "refused" cases for the wrong
    // reason, or none of them.
    expect(NONCE_MIN_LENGTH).toBeGreaterThanOrEqual(32);
    expect(NONCE_MAX_AGE_MS).toBeGreaterThanOrEqual(60_000);
    expect(NONCE_MAX_AGE_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  for (const c of CASES) {
    test(`${c.label} is ${c.live ? 'LIVE' : 'refused'}`, () => {
      const verdict = nonceIsLive(c.nonce as string, c.path as string);
      expect(verdict.live, `${c.label}: ${'why' in verdict ? verdict.why : 'accepted'}`).toBe(c.live);
      // A refusal must say why, or nothing on stderr shows it.
      if (!c.live) expect('why' in verdict && verdict.why.length > 0).toBe(true);
    });
  }

  test('and the table exercises both outcomes, so neither half can be vacuous', () => {
    expect(CASES.filter((c) => c.live).length).toBeGreaterThanOrEqual(2);
    expect(CASES.filter((c) => !c.live).length).toBeGreaterThanOrEqual(10);
  });
});
