/**
 * The reviewer's theme choice, remembered between reviews by the CLI.
 *
 * The WebKit host's `draftgate://` storage (`localStorage` and the other web stores) does not
 * survive a relaunch. So the choice rides the decision (`HumanDecision.theme`), this module keeps
 * it, and the next request carries it back (`WireRequest.rememberedTheme`), with no third function
 * on the page's bridge. A window closed or timed out writes no decision, so its choice is lost;
 * approving and rejecting both keep it.
 *
 * The window surface reads and keeps it (`THEME_STORE`), not the gate: `runReview` has no use for it.
 *
 * `~/.draftgate/theme.json`, `{ "theme": "dark" }`. Its own file because the host rewrites
 * `window.json` wholesale with bounds and zoom. Nothing here throws or changes a decision: an
 * unreadable preference is the default, and a failed write is said once on stderr by the caller.
 *
 * Node APIs only: it runs inside the CLI.
 */
import { join } from 'node:path';
import { draftgateHome, writePrivateFile } from './audit';
import { readConfigText } from './configFiles';
import { isPlainObject } from './json';
import { isThemeChoice, type ThemeChoice } from '../../core/src/index';

export const THEME_BASENAME = 'theme.json';

export function themePreferencePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(draftgateHome(env), THEME_BASENAME);
}

/**
 * The remembered choice, if there is one. A file that is there and cannot be used is a `problem`,
 * said once on stderr like every other `~/.draftgate/` file's (`configFiles.ts`), and no choice.
 * An absent file is neither: it is a reviewer who has not picked a theme yet.
 */
export function readThemePreference(path = themePreferencePath()): { theme?: ThemeChoice; problem?: string } {
  const text = readConfigText(path);
  if (text instanceof Error) return { problem: `${text.message}, so no remembered theme applies` };
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      problem: `${path} is not valid JSON (${(e as Error).message}), so no remembered theme applies. ` +
        'Delete it, or pick a theme again',
    };
  }
  const theme = isPlainObject(parsed) ? parsed.theme : undefined;
  if (isThemeChoice(theme)) return { theme };
  return { problem: `${path}: holds no theme (system, light or dark), so none applies. Delete it, or pick a theme again` };
}

/** Keep `pref`. An Error names the failure; the caller decides how loud to be. */
export function rememberThemePreference(pref: ThemeChoice, path = themePreferencePath()): Error | null {
  return writePrivateFile(path, JSON.stringify({ theme: pref }) + '\n');
}

/** Where a window surface reads the remembered choice and keeps a new one. Injected in tests. */
export interface ThemeStore {
  read(): { theme?: ThemeChoice; problem?: string };
  keep(theme: ThemeChoice): Error | null;
}

/** The reviewer's own file, resolved at each call so `DRAFTGATE_HOME` is read when it is used. */
export const THEME_STORE: ThemeStore = {
  read: () => readThemePreference(),
  keep: (theme) => rememberThemePreference(theme),
};
