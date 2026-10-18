/**
 * `cli/src/githubRepos.ts`: the operator's answer about which repositories are public. Nothing
 * throws or degrades to silence, a row is signed (`audience.md`), and reader and writer spell the
 * `owner/repo` key identically, or the file looks correct and answers nothing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  githubRepoKeyOf,
  githubReposPath,
  githubReposSummary,
  isGitHubRepoVisibility,
  loadGithubRepos,
  parseGithubRepos,
  rememberGithubRepo,
  rememberGithubRepos,
  withGithubRepo,
  describeGithubReposWrite,
} from '../src/githubRepos';

/*
 * A draftgate HOME per test, removed afterwards (`test/tempDirs.test.ts`). `DRAFTGATE_HOME`, not
 * `HOME`: `draftgateHome()` falls back to `homedir()`, which reads the OS rather than this object,
 * so an env with only `HOME` writes into the reviewer's own `~/.draftgate`.
 */
const made: string[] = [];
function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'draftgate-github-repos-'));
  made.push(dir);
  return { DRAFTGATE_HOME: join(dir, '.draftgate') } as NodeJS.ProcessEnv;
}
function writeFile(env: NodeJS.ProcessEnv, text: string): string {
  const path = githubReposPath(env);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the key, which reader and writer must spell identically', () => {
  test('lowercased, two segments', () => {
    expect(githubRepoKeyOf('Jakuboola/DraftGate')).toBe('jakuboola/draftgate');
    expect(githubRepoKeyOf('  acme/crm  ')).toBe('acme/crm');
  });

  test('one segment is refused rather than guessed at', () => {
    // Defaulting an owner would silently classify some other account's repository of that name.
    expect(githubRepoKeyOf('draftgate')).toBeNull();
    expect(githubRepoKeyOf('a/b/c')).toBeNull();
    expect(githubRepoKeyOf('/draftgate')).toBeNull();
    expect(githubRepoKeyOf('jakuboola/')).toBeNull();
  });

  test('anything that is not a name is refused, so a path or a URL cannot get in', () => {
    expect(githubRepoKeyOf('https://github.com/a/b')).toBeNull();
    expect(githubRepoKeyOf('a b/c')).toBeNull();
  });
});

describe('parsing gives PARTIAL CREDIT, so one typo does not un-classify an estate', () => {
  test('good rows survive a bad one, and the problem names what went', () => {
    const parsed = parseGithubRepos(
      JSON.stringify({
        repos: { 'a/b': 'public', 'c/d': 'nonsense', 'not-a-pair': 'private', 'e/f': 'internal' },
      }),
      'FILE'
    );
    expect(Object.keys(parsed.repos).sort()).toEqual(['a/b', 'e/f']);
    expect(parsed.problem).toContain('2 rows dropped');
    expect(parsed.problem).toContain('c/d');
    expect(parsed.problem).toContain('The rest are still in use.');
  });

  test('nothing throws, whatever the file holds', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"repos": 3}', '{}']) {
      expect(() => parseGithubRepos(text, 'FILE')).not.toThrow();
      expect(parseGithubRepos(text, 'FILE').repos).toEqual({});
      expect(parseGithubRepos(text, 'FILE').problem).toBeDefined();
    }
  });

  test('a file with rows and no problem reports no problem', () => {
    const parsed = parseGithubRepos(JSON.stringify({ repos: { 'a/b': 'public' } }), 'FILE');
    expect(parsed.problem).toBeUndefined();
  });

  test('sources are read under either spelling of the key', () => {
    const parsed = parseGithubRepos(
      JSON.stringify({
        repos: { 'Jakuboola/DraftGate': 'private' },
        sources: { 'Jakuboola/DraftGate': 'github' },
      }),
      'FILE'
    );
    expect(parsed.repos['jakuboola/draftgate']).toEqual({ visibility: 'private', source: 'github' });
  });

  test('an unrecognised source is dropped, not carried as one', () => {
    const parsed = parseGithubRepos(
      JSON.stringify({ repos: { 'a/b': 'public' }, sources: { 'a/b': 'somebody' } }),
      'FILE'
    );
    // Absent counts as authoritative; an unknown marker read as `reviewer` would let a click
    // overwrite the row.
    expect(parsed.repos['a/b']).toEqual({ visibility: 'public' });
  });
});

describe('loading tells an absent file from an unreadable one', () => {
  test('absent is the ordinary state and says nothing', () => {
    const env = home();
    const loaded = loadGithubRepos(env);
    expect(loaded.present).toBe(false);
    expect(loaded.problem).toBeUndefined();
    expect(loaded.repos).toEqual({});
  });

  test('present and broken says so, and still reports present', () => {
    const env = home();
    writeFile(env, 'not json');
    const loaded = loadGithubRepos(env);
    // A reader that said `false` here would tell an operator their unreadable file does not exist.
    expect(loaded.present).toBe(true);
    expect(loaded.problem).toContain('not valid JSON');
  });
});

describe('the SIGNING rule', () => {
  const row = (root: Record<string, unknown>, key: string) =>
    (root.repos as Record<string, string>)[key];

  test("a reviewer's answer does not overwrite GitHub's", () => {
    const base = { repos: { 'a/b': 'private' }, sources: { 'a/b': 'github' } };
    const out = withGithubRepo(base, { key: 'a/b', visibility: 'public', source: 'reviewer' });
    expect(out).toEqual({ kept: 'private', source: 'github' });
  });

  test('an UNMARKED row counts as authoritative, so a hand-written file survives a click', () => {
    const base = { repos: { 'a/b': 'private' } };
    const out = withGithubRepo(base, { key: 'a/b', visibility: 'public', source: 'reviewer' });
    expect(out).toEqual({ kept: 'private', source: 'unmarked' });
  });

  test("a reviewer's answer DOES replace another reviewer's", () => {
    const base = { repos: { 'a/b': 'private' }, sources: { 'a/b': 'reviewer' } };
    const out = withGithubRepo(base, { key: 'a/b', visibility: 'public', source: 'reviewer' });
    expect('root' in out).toBe(true);
    if ('root' in out) expect(row(out.root, 'a/b')).toBe('public');
  });

  test("GitHub's own answer replaces anything", () => {
    for (const held of ['github', 'reviewer', undefined]) {
      const base = {
        repos: { 'a/b': 'private' },
        ...(held ? { sources: { 'a/b': held } } : {}),
      };
      const out = withGithubRepo(base, { key: 'a/b', visibility: 'public', source: 'github' });
      expect('root' in out, `held=${held}`).toBe(true);
    }
  });

  test('an existing SPELLING is updated in place rather than joined by a twin', () => {
    // With two rows for one repository, the one the reader does not reach is a classification the
    // operator believes they have.
    const base = { repos: { 'Jakuboola/DraftGate': 'private' }, sources: { 'Jakuboola/DraftGate': 'reviewer' } };
    const out = withGithubRepo(base, { key: 'jakuboola/draftgate', visibility: 'public', source: 'reviewer' });
    expect('root' in out).toBe(true);
    if ('root' in out) {
      expect(Object.keys(out.root.repos)).toEqual(['Jakuboola/DraftGate']);
      expect(row(out.root, 'Jakuboola/DraftGate')).toBe('public');
    }
  });
});

describe('remembering what the reviewer said', () => {
  test('writes the answer, signed', () => {
    const env = home();
    expect(rememberGithubRepo({ key: 'Jakuboola/draftgate', visibility: 'private' }, env)).toEqual({});
    const written = JSON.parse(readFileSync(githubReposPath(env), 'utf8'));
    expect(written.repos['jakuboola/draftgate']).toBe('private');
    expect(written.sources['jakuboola/draftgate']).toBe('reviewer');
  });

  test('a second repository does not discard the first', () => {
    const env = home();
    rememberGithubRepo({ key: 'a/b', visibility: 'public' }, env);
    rememberGithubRepo({ key: 'c/d', visibility: 'private' }, env);
    const written = JSON.parse(readFileSync(githubReposPath(env), 'utf8'));
    expect(Object.keys(written.repos).sort()).toEqual(['a/b', 'c/d']);
  });

  test('a file that PARSES but is the wrong shape is refused too', () => {
    // Valid JSON that is not a usable object must not fall through to an empty base and be written
    // over.
    for (const content of ['[{"repos":"kept"}]', '"a string"', '42', '{"repos": 5}']) {
      const env = home();
      const path = writeFile(env, content);
      const out = rememberGithubRepo({ key: 'a/b', visibility: 'public' }, env);
      expect(out.error?.message, content).toContain('nothing was written');
      expect(readFileSync(path, 'utf8'), content).toBe(content);
    }
  });

  test("a reviewer CAN correct their own earlier answer, whichever case the file uses", () => {
    // `repos` and `sources` are keyed independently and can disagree about case. A writer that looks
    // up the mark under the `repos` spelling sees `unmarked` where the reader sees `reviewer`, and
    // refuses the reviewer's own correction.
    const env = home();
    writeFile(
      env,
      JSON.stringify({
        repos: { 'Jakuboola/draftgate': 'private' },
        sources: { 'jakuboola/draftgate': 'reviewer' },
      })
    );
    expect(rememberGithubRepo({ key: 'Jakuboola/draftgate', visibility: 'public' }, env)).toEqual({});
    const written = JSON.parse(readFileSync(githubReposPath(env), 'utf8'));
    expect(written.repos['Jakuboola/draftgate']).toBe('public');
    // The mark stays on the spelling it was written under, without a twin.
    expect(Object.keys(written.sources)).toEqual(['jakuboola/draftgate']);
  });

  test('a CORRUPT file is refused rather than overwritten', () => {
    // Starting from `{}` would discard every repository the operator classified over one stray comma.
    const env = home();
    const path = writeFile(env, '{"repos": {"a/b": "public"');
    const out = rememberGithubRepo({ key: 'c/d', visibility: 'private' }, env);
    expect(out.error?.message).toContain('nothing was written');
    expect(readFileSync(path, 'utf8')).toBe('{"repos": {"a/b": "public"');
  });

  test('a key that is not a pair is refused with a reason', () => {
    const env = home();
    expect(rememberGithubRepo({ key: 'draftgate', visibility: 'public' }, env).error?.message)
      .toContain('owner/repo');
  });

  test('an unrelated top-level key is carried through', () => {
    const env = home();
    writeFile(env, JSON.stringify({ note: 'hand written', repos: {} }));
    rememberGithubRepo({ key: 'a/b', visibility: 'public' }, env);
    expect(JSON.parse(readFileSync(githubReposPath(env), 'utf8')).note).toBe('hand written');
  });
});

describe('the whole-owner writer, which is what the tool calls', () => {
  test('writes every row and reports the count', () => {
    const env = home();
    const out = rememberGithubRepos({ 'a/b': 'public', 'c/d': 'private' }, env);
    expect('written' in out && out.written).toBe(2);
    expect(describeGithubReposWrite(out)).toContain('wrote 2 repositories');
  });

  test("it CORRECTS a reviewer's guess, because GitHub outranks a click", () => {
    const env = home();
    rememberGithubRepo({ key: 'a/b', visibility: 'private' }, env);
    rememberGithubRepos({ 'a/b': 'public' }, env);
    const written = JSON.parse(readFileSync(githubReposPath(env), 'utf8'));
    expect(written.repos['a/b']).toBe('public');
    expect(written.sources['a/b']).toBe('github');
  });

  test('an unusable row is reported rather than written', () => {
    const env = home();
    const out = rememberGithubRepos({ 'not-a-pair': 'public', 'a/b': 'nope' as never }, env);
    expect('written' in out && out.written).toBe(0);
    expect(describeGithubReposWrite(out)).toContain('kept 2 existing rows');
  });
});

describe('the summary --- what `--doctor` and `draftgate setup` both print', () => {
  test('counts rows and public ones', () => {
    const parsed = parseGithubRepos(
      JSON.stringify({ repos: { 'a/b': 'public', 'c/d': 'private', 'e/f': 'public' } }),
      'FILE'
    );
    expect(githubReposSummary(parsed)).toEqual({ repos: 3, public: 2 });
  });
});

describe('isGitHubRepoVisibility is the ONE vocabulary check', () => {
  test('the three GitHub publishes, and nothing else', () => {
    for (const v of ['public', 'private', 'internal']) expect(isGitHubRepoVisibility(v)).toBe(true);
    // A Jira answer can reach the same field on the wire; it must not read as a visibility.
    for (const v of ['service_desk', 'PUBLIC', '', null, 1]) expect(isGitHubRepoVisibility(v)).toBe(false);
  });
});
