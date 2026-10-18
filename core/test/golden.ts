/**
 * Golden-file harness. Files on disk, not inline snapshots, so an ADF diff is reviewable in
 * `git diff`. Regenerate with `bun run test:update-golden`, then read the diff before committing.
 */

import { expect } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Repo root, from `core/test/`. */
const ROOT = join(import.meta.dir, '..', '..');
const GOLDEN_DIR = join(import.meta.dir, '__golden__');
/**
 * Blessing mode: `expectGolden` writes and returns, so every golden test passes having asserted
 * nothing. So every changed write is named on stderr, and `core/test/goldenMode.test.ts` fails
 * whenever this is on: `test:update-golden` writes every file and then reports that one failure.
 */
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Whether this process is blessing rather than checking. Read by `goldenMode.test.ts`. */
export function isBlessingGoldens(): boolean {
  return UPDATE;
}

export function expectGolden(name: string, actual: unknown): void {
  const path = join(GOLDEN_DIR, name);
  const serialized = JSON.stringify(actual, null, 2) + '\n';

  if (UPDATE || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const changed = !existsSync(path) || readFileSync(path, 'utf8') !== serialized;
    writeFileSync(path, serialized);
    if (UPDATE) {
      // Only the files that moved: the diff to read before committing.
      if (changed) process.stderr.write(`[UPDATE_GOLDEN] rewrote ${name}\n`);
      return;
    }
    // A missing golden file is created, but the test still fails: a first run must not
    // silently self-bless. Read the new file, then re-run.
    throw new Error(
      `Golden file did not exist and was created: ${name}. Review it, then re-run.`
    );
  }

  expect(serialized).toBe(readFileSync(path, 'utf8'));
}

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8');
}

/** The corpus the converter's claims are verified against. */
export function tortureFixture(): string {
  return readFileSync(join(import.meta.dir, '..', '..', 'docs', 'torture-fixture.md'), 'utf8');
}

/** Where the repo's example payloads live, from its root: what `example` reads and a label names. */
export const EXAMPLES_DIR = 'docs/examples';

/** A body out of one of the repo's example payloads. */
export function example(name: string, field: string): string {
  return String(JSON.parse(readFileSync(join(ROOT, EXAMPLES_DIR, name), 'utf8'))[field]);
}

/**
 * Every document this repo ships, as `[label, body]`, enumerated from disk so adding a fixture file
 * is enough. Each caller spreads its own extra shapes onto the result.
 */
export function shippedBodies(): [string, string][] {
  const dir = join(import.meta.dir, 'fixtures');
  return [
    ['docs/torture-fixture.md', tortureFixture()],
    ...readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f): [string, string] => [`fixtures/${f}`, fixture(f)]),
    [`${EXAMPLES_DIR}/jira-payload.json`, example('jira-payload.json', 'commentBody')],
    [`${EXAMPLES_DIR}/slack-payload.json`, example('slack-payload.json', 'message')],
  ];
}
