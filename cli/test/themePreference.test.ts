/**
 * `cli/src/themePreference.ts`: the reviewer's theme, kept by the CLI between reviews.
 *
 * Nothing here may throw into a review: a file that is missing, broken, or not a theme reads as no
 * choice, and the last two say so (`configFiles.ts`). A write that fails comes back as an Error for
 * the caller to mention. The file is private.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THEME_BASENAME, readThemePreference, rememberThemePreference, themePreferencePath } from '../src/themePreference';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-theme-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the remembered theme', () => {
  test('lives in draftgate home, under its own name', () => {
    expect(themePreferencePath({ DRAFTGATE_HOME: '/somewhere' })).toBe(join('/somewhere', THEME_BASENAME));
  });

  test('a choice comes back as itself, in a file only its owner can read', () => {
    const path = join(dir, 'home', THEME_BASENAME);
    for (const theme of ['dark', 'light', 'system'] as const) {
      expect(rememberThemePreference(theme, path)).toBeNull();
      expect(readThemePreference(path)).toEqual({ theme });
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('nothing there is no choice, and says nothing', () => {
    expect(readThemePreference(join(dir, 'absent.json'))).toEqual({});
  });

  test('something unusable is no choice, and names the file', () => {
    for (const [name, text] of [
      ['broken', '{'],
      ['array', '[]'],
      ['null', 'null'],
      ['other', '{"theme":"sepia"}'],
      ['number', '{"theme":1}'],
    ] as const) {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, text);
      const read = readThemePreference(path);
      expect(read.theme, name).toBeUndefined();
      expect(read.problem, name).toContain(path);
    }
    // One that cannot be read is not one that is not there.
    const unreadable = join(dir, 'a-directory.json');
    mkdirSync(unreadable, { recursive: true });
    expect(readThemePreference(unreadable).problem).toContain('could not be read');
  });

  test('a write that cannot land is an Error, not a throw', () => {
    const path = join(dir, 'blocked', THEME_BASENAME);
    mkdirSync(path, { recursive: true }); // a DIRECTORY where the file should go
    expect(rememberThemePreference('dark', path)).toBeInstanceOf(Error);
  });
});
