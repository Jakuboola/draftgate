/**
 * The two rules every operator config file in `~/.draftgate/` follows, written once.
 *
 * `jira-projects.json`, `github-repos.json` and `scratch.json` have three shapes and three parsers,
 * each keyed the way its destination's names are unique. They share policy: how a reader reports
 * what it dropped, and how a writer refuses a file it cannot safely merge into.
 */

import { readFileSync } from 'node:fs';
import { isPlainObject } from './json';

/**
 * The first few of something, named, with a marker when there are more.
 *
 * Names rather than counts, because "12 rows dropped" cannot be acted on. Truncates so a file with
 * fifty bad targets does not put a fifty-item line on stderr.
 */
export function namedSample(items: readonly string[], keep = 3): string {
  return items.slice(0, keep).join('; ') + (items.length > keep ? '; …' : '');
}

/**
 * A config file's parsed root, ready to merge into -- or an Error saying why it is not safe to.
 *
 * Refuses where the parsers degrade: a reader may drop what it does not understand, and a writer
 * that did the same would delete the operator's config. Refused: invalid JSON, and JSON that is not
 * a usable object (`[…]`, `"x"`, `42`, or a `container` key holding `5`), which falling through to
 * `{}` would let the writer replace the whole file without an error.
 *
 * `container` is the top-level key whose value must be an object if present (`sites`, `repos`,
 * `hooks`). The rest of the root is kept, so hand-added top-level keys survive. Empty text is `{}`,
 * the first write.
 */
export function configMergeBase(
  text: string,
  source: string,
  container: string,
  /**
   * What the person should do about it. The default is the classification stores': deleting one
   * loses only answers the window asks again. `draftgate register` passes its own, since deleting
   * Claude Code's `settings.json` is not advice.
   */
  remedy = 'Fix or delete the file; the answer was not saved.'
): Record<string, unknown> | Error {
  if (text.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return new Error(
      `${source} exists but is not valid JSON (${(e as Error).message}), so nothing was written ` +
        `to it. ${remedy}`
    );
  }
  if (!isPlainObject(parsed)) {
    return new Error(
      `${source} exists but is valid JSON and not an object, so nothing was written to it. ${remedy}`
    );
  }
  if (parsed[container] !== undefined && !isPlainObject(parsed[container])) {
    return new Error(
      `${source} has a "${container}" key that is not an object, so nothing was written to it. ` +
        remedy
    );
  }
  return parsed;
}

/**
 * A config file's text, for a writer about to merge into it -- or an Error saying why not.
 *
 * An absent file yields `''`, which `configMergeBase` reads as nothing to merge into. Every other
 * failure is an Error, because a writer that treated an unreadable file as empty would overwrite it.
 * Shared so every caller shows one sentence for one condition, `${path}: could not be read (…)`, the
 * form the readers (`loadJiraProjects`, `loadGithubRepos`) use too.
 */
export function readConfigText(path: string): string | Error {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return '';
    return new Error(`${path}: could not be read (${err.code ?? err.message})`);
  }
}
