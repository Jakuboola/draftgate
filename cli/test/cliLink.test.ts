/**
 * The `draftgate` link a checkout install left on PATH, as `draftgate uninstall` finds and removes
 * it, and the path comparison it judges a link's target by.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isThisCli, LINK_NAME, unlinkCli } from '../src/cliLink';
import { canonical, isInside } from '../src/paths';

describe('unlinkCli, against a real filesystem: uninstall takes out its own link and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'draftgate-unlink-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a link to this checkout goes, wherever it is; another checkout\'s link and a plain file stay, named', () => {
    const home = join(root, 'home');
    const entry = join(home, 'app', 'cli', 'src', 'main.ts');
    const other = join(home, 'dev', 'cli', 'src', 'main.ts');
    const [onPath, alsoOnPath, local, gone] = ['onpath', 'also', '.local/bin', 'gone'].map((d) => join(home, d));
    for (const d of [onPath, alsoOnPath, local!, gone!, join(entry, '..'), join(other, '..')]) mkdirSync(d!, { recursive: true });
    writeFileSync(entry, '#!/usr/bin/env bun\n');
    writeFileSync(other, '#!/usr/bin/env bun\n');
    symlinkSync(entry, join(onPath!, LINK_NAME));
    symlinkSync(other, join(alsoOnPath!, LINK_NAME));
    // ~/.local/bin, which PATH does not list, holds a plain file somebody put there.
    writeFileSync(join(local!, LINK_NAME), '#!/bin/sh\n');
    // A link to this checkout's CLI that dangles is still this checkout's.
    symlinkSync(join(home, 'moved', 'cli', 'src', 'main.ts'), join(gone!, LINK_NAME));

    // A dangling target is judged as the place it names, whose ancestors are real.
    const r = unlinkCli(
      (t) => t === realpathSync(entry) || t === canonical(join(home, 'moved', 'cli', 'src', 'main.ts')),
      { env: { PATH: [onPath, alsoOnPath, gone].join(':') }, home }
    );
    expect(r.removed.sort()).toEqual([join(gone!, LINK_NAME), join(onPath!, LINK_NAME)].sort());
    expect(r.left).toEqual([
      { path: join(alsoOnPath!, LINK_NAME), is: `a link to ${realpathSync(other)}` },
      { path: join(local!, LINK_NAME), is: 'a regular file, not a link' },
    ]);
    expect(r.failed).toEqual([]);
    expect(readlinkSync(join(alsoOnPath!, LINK_NAME))).toBe(other);
    expect(readdirSync(local!)).toEqual([LINK_NAME]);
  });

  test('isThisCli compares places: the real path of the entry', () => {
    const dir = join(root, 'real');
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, 'main.ts');
    writeFileSync(entry, '');
    expect(isThisCli(entry)(realpathSync(entry))).toBe(true);
    expect(isThisCli(entry)(join(root, 'elsewhere.ts'))).toBe(false);
  });
});

describe('canonical and isInside: the place a path names', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'draftgate-paths-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a path through a symlink, and one that does not exist yet, name the place they will be', () => {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(canonical(join(root, 'link'))).toBe(join(root, 'real'));
    // Gone, or never there: its deepest existing ancestor is resolved, and the rest appended.
    expect(canonical(join(root, 'link', 'gone', 'x'))).toBe(join(root, 'real', 'gone', 'x'));
  });

  test('inside is strict, and compares places, not spellings', () => {
    expect(isInside(join(root, 'link'), join(root, 'real', 'a'))).toBe(true);
    expect(isInside(join(root, 'real'), join(root, 'link'))).toBe(false);
    expect(isInside(join(root, 'real'), join(root, 'realer'))).toBe(false);
    expect(isInside(join(root, 'real', 'a'), join(root, 'real'))).toBe(false);
  });
});
