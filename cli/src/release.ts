#!/usr/bin/env bun
/**
 * Cut a release from this checkout's `main`:
 *
 *   bun run release [--notes <file>]
 *
 * What a release is (the `vX.Y.Z` tag, the release commit on `stable`, `plugin.json`'s version):
 * installer.md, "The release". This makes all of it on origin or none of it. The release commit is
 * one commit, so the window arrives in the same pull as the code it was built from. GitHub release
 * notes follow when origin is on GitHub (`--notes <file>`, or GitHub's generated ones). `bun run`
 * starts this in the checkout, so a relative `<file>` is read from there; one inside the checkout
 * must be git-ignored, or the clean-tree check refuses it.
 *
 * Nothing remote changes until every local step passed:
 *
 *  1. The checks, each a refusal that changes nothing: a clean tree (untracked files included: a
 *     build reads whatever is imported, tracked or not, and a release clone has only what is
 *     tracked), on `main`, HEAD exactly origin's `main`, `plugin.json`'s version newer than every
 *     release on origin and its tag name free here too, origin's `stable` a release commit adding
 *     only what a release adds, and `gh` able to reach the repository when origin is on GitHub.
 *  2. The window, built.
 *  3. and 4. `surface:probe` and `surface:e2e`, each as `bun run` runs it. Each rebuilds the window
 *     first; the build is deterministic, and every file of `surface/dist` is hashed before and after
 *     each run, so a difference stops the release. What the verifiers ran on is byte for byte what is
 *     committed.
 *  5. The tag object and the release commit, made locally with no ref pointing at either, then read
 *     back as a release clone has them: the window identical to the verified one at the root and in
 *     the plugin tree, its stamp accepted by `bundleState` with no toolchain in both (what a user's
 *     checkout and a plugin's cache copy run), and the old `stable` an ancestor. A failure here
 *     leaves nothing to undo.
 *  6. One atomic push of the tag and `stable`: both land or neither does. A failed push is judged by
 *     what origin then has, since a connection can drop after origin applied it: neither ref means
 *     the same command can run again; both is a release; anything else stops, for a person to look
 *     at. Only once origin has both is the local tag written.
 *  7. The release notes.
 *
 * The release commit is built, not merged: a `git merge` of `main` into `stable` would have to
 * resolve the old window against nothing, and could carry anything else `stable` held. The plugin
 * tree is made of the blobs it copies, so it costs the repository no storage.
 *
 * git runs with the maintainer's own configuration, for their credentials, but never prompts. The
 * verifiers open real windows, so this runs one at a time with nothing else building in this
 * checkout (CLAUDE.md, "Verifiers").
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REMEDY, typed } from '../../core/src/remedies';
import {
  CHECKOUT,
  RELEASE_BRANCH as STABLE,
  isNewerRelease,
  isReleaseTag,
  lsRemoteRefs,
  newestRelease,
  originUrl,
} from './releaseCheck';
import { PLUGIN_DIR, PLUGIN_MANIFEST, WINDOW_DIR, pluginTree, pluginVersion } from './pluginTree';
import { OK, detail, failed, quoted, stepReport } from './steps';
import { writeStdout } from './stdout';
import {
  STAMP_BASENAME,
  manifestDiff,
  parseStamp,
  readStamp,
  shippedWindowProblem,
  surfaceLayout,
  windowManifest,
  type BuildStamp,
} from './surfaces/bundleStamp';
import { shQuote, short } from './text';

/** The branch a release is cut from. */
const MAIN = 'main';
/** The verifiers that must pass on the window a release ships, in order. */
const VERIFIERS = ['surface:probe', 'surface:e2e'] as const;
/** How much of a child's output is quoted under a step. */
const QUOTED_LINES = 20;

const STEPS = [
  'checks',
  'build the window',
  ...VERIFIERS,
  'tag and release commit',
  'push',
  'release notes',
] as const;

/** A git or gh run, as this file reads it. */
export interface Run {
  ok: boolean;
  stdout: string;
  /** stderr, then stdout, for quoting. */
  output: string;
}

/** git in one checkout, with variables of its own (`GIT_INDEX_FILE`) on top, and what it reads on stdin. */
type Git = (args: string[], extra?: NodeJS.ProcessEnv, input?: string) => Run;

/** What `release` reads and runs. Each is the real thing by default, and replaced in tests. */
export interface ReleaseContext {
  /** The checkout the release is cut from. */
  root: string;
  /** The environment git and the scripts run in. */
  env: NodeJS.ProcessEnv;
  /** `bun run <script>` in `root`, stdio inherited; answers with its exit status. */
  script: (name: string) => number;
  gh: (args: string[]) => Run;
  print: (text: string) => Promise<void>;
}

function releaseContext(): ReleaseContext {
  return {
    root: CHECKOUT,
    env: process.env,
    script: (name) => runScript(CHECKOUT, name, process.env),
    gh: (args) => capture('gh', args, CHECKOUT, process.env),
    print: writeStdout,
  };
}

/** `bun run <name>` in `root`; its output goes to this process's own, unless a test says otherwise. */
export function runScript(root: string, name: string, env: NodeJS.ProcessEnv, stdio: 'inherit' | 'ignore' = 'inherit'): number {
  const r = spawnSync(process.execPath, ['run', name], { cwd: root, env, stdio });
  return r.status ?? 1;
}

function capture(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Run {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) return { ok: false, stdout: '', output: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout, output: `${r.stderr}${r.stdout}` };
}

/** git in `root`, never prompting: a prompt nobody answers would hold the release. */
export function gitIn(root: string, env: NodeJS.ProcessEnv): Git {
  return (args, extra = {}, input) => capture('git', args, root, { ...env, GIT_TERMINAL_PROMPT: '0', ...extra }, input);
}

/** git's answer, trimmed, or a refusal quoting why git failed. */
function must(git: Git, args: string[], what: string, extra?: NodeJS.ProcessEnv): string {
  const r = git(args, extra);
  if (!r.ok) throw new Refusal([`${what} failed:`, ...quoted(r.output, QUOTED_LINES)]);
  return r.stdout.trim();
}

/** `owner/repo` for a GitHub origin URL, https or ssh, or null for any other. */
export function githubRepo(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1]! : null;
}

/**
 * The parsed command line, or why it cannot be one. A version is not an argument: it is
 * `plugin.json`'s, and a second place to state it would be a second copy to disagree.
 */
export function parseReleaseArgs(argv: string[]): { notes: string | null } | { error: string[] } {
  const usage = `usage: ${typed(REMEDY.release)} [--notes <file>]`;
  let notes: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a !== '--notes') {
      const looksLikeVersion = isReleaseTag(a.startsWith('v') ? a : `v${a}`);
      return { error: looksLikeVersion ? [usage, `The version is ${PLUGIN_MANIFEST}'s: bump it there, in a commit on ${MAIN}.`] : [usage] };
    }
    const file = argv[++i];
    if (file === undefined || notes !== null) return { error: [usage] };
    notes = file;
  }
  return { notes };
}

/** A word as a shell reads it back, for a command printed to be pasted: quoted only when it must be. */
const shellWord = (w: string) => (/^[\w./:@=-]+$/.test(w) ? w : shQuote(w));

class Refusal extends Error {
  constructor(readonly lines: string[]) {
    super(lines[0]);
  }
}

/** Cut the release. Answers with the exit status: 0 when every step passed. */
export async function release(argv: string[], ctx: ReleaseContext = releaseContext()): Promise<number> {
  const { verdicts, out, header, child, finish } = stepReport(STEPS, ctx.print);
  const git = gitIn(ctx.root, ctx.env);
  const nothingChanged = 'Nothing was tagged, committed or pushed.';

  await out([`release: ${ctx.root}`, '']);

  // --- 1. The checks --------------------------------------------------------------------------
  let plan: Plan;
  try {
    plan = checks(argv, ctx, git);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    verdicts[0] = failed('refused');
    await out([header(1, 'Checks'), ...detail(e.lines), '']);
    return finish([nothingChanged]);
  }
  verdicts[0] = OK;
  await out([
    header(1, 'Checks'),
    ...detail([
      `${plan.tag} (${PLUGIN_MANIFEST}'s version) from ${MAIN} at ${short(plan.head)}, after ${plan.previous ?? 'no release'}.`,
      plan.oldStable ? `${STABLE} is at ${short(plan.oldStable)}, a release commit; it moves forward.` : `origin has no ${STABLE}; this release creates it.`,
      plan.repo ? `Release notes go to ${plan.repo} on GitHub.` : 'origin is not on GitHub, so this release has no release notes.',
    ]),
    '',
  ]);

  // --- 2 to 4. The window, built and verified ---------------------------------------------------
  const layout = surfaceLayout(ctx.root);
  if (!(await child(2, 'Build the window', () => ctx.script('build:surface'), 'the build failed'))) {
    return finish([nothingChanged]);
  }
  const built = windowManifest(layout.distDir);
  const stamp = readStamp(layout.stampFile);
  if (built.size === 0 || stamp === null) {
    verdicts[1] = failed('no stamped window');
    await out(detail([`The build exited 0 but left no stamped window in ${WINDOW_DIR}.`, '']));
    return finish([nothingChanged]);
  }
  // Before the verifiers, which are what a release spends its time on: the tree and its window are
  // all the assembly reads. Step 5 assembles it again, out of the blobs.
  const tracked = must(git, ['ls-files', '-z'], 'git ls-files').split('\0').filter(Boolean);
  const assembles = pluginTree([...tracked, ...[...built.keys()].map((p) => `${WINDOW_DIR}/${p}`)], stamp);
  if ('error' in assembles) {
    verdicts[1] = failed('no plugin tree');
    await out(detail([`The plugin tree cannot be assembled: ${assembles.error}.`, '']));
    return finish([nothingChanged]);
  }
  for (const [i, name] of VERIFIERS.entries()) {
    const n = 3 + i;
    if (!(await child(n, name, () => ctx.script(name), `${name} failed`))) return finish([nothingChanged]);
    const differs = manifestDiff(built, windowManifest(layout.distDir));
    if (differs !== null) {
      verdicts[n - 1] = failed('the window changed');
      await out(detail([`${WINDOW_DIR} is not what step 2 built after ${name}: ${differs} differs.`, 'The build is not deterministic, or something else built here meanwhile.', '']));
      return finish([nothingChanged]);
    }
  }

  // --- 5. The tag and the release commit ------------------------------------------------------
  let made: { tagObject: string; commit: string };
  try {
    made = releaseCommit(plan, git, built, stamp);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    verdicts[4] = failed('refused');
    await out([header(5, 'Tag and release commit'), ...detail(e.lines), '']);
    return finish([nothingChanged]);
  }
  const { tagObject, commit } = made;
  verdicts[4] = OK;
  await out([
    header(5, 'Tag and release commit'),
    ...detail([
      `Tag ${plan.tag} at ${short(plan.head)}; release commit ${short(commit)}.`,
      `Read back as a release clone and as the plugin: the window is the verified one in both, its`,
      `stamp is accepted with no toolchain, and it fast-forwards ${STABLE}.`,
    ]),
    '',
  ]);

  // --- 6. The push ----------------------------------------------------------------------------
  const pushed = git(['push', '--atomic', '--porcelain', 'origin', `${tagObject}:refs/tags/${plan.tag}`, `${commit}:refs/heads/${STABLE}`]);
  const landed = pushed.ok ? 'both' : originHas(plan, commit, git);
  if (landed !== 'both') {
    verdicts[5] = failed(landed === 'neither' ? 'refused' : 'unclear');
    await out([
      header(6, 'Push'),
      ...detail([
        landed === 'neither'
          ? `origin refused the push, so neither ${plan.tag} nor ${STABLE} moved there:`
          : `git push failed, and origin has neither the release nor what it had before:`,
      ]),
      ...quoted(pushed.output, QUOTED_LINES),
      '',
    ]);
    return finish([
      landed === 'neither'
        ? 'Nothing was released. Fix what step 6 says, then run this again.'
        : `${plan.tag} may be half released: look at origin's ${plan.tag} and ${STABLE} before anything else.`,
    ]);
  }
  // Written only now, and only where there is no such tag: the push is what made it a release.
  const local = git(['update-ref', `refs/tags/${plan.tag}`, tagObject, '']).ok
    ? `and so does this checkout`
    : `and this checkout already had a ${plan.tag} of its own, left as it is; git fetch --tags --force takes origin's`;
  // Best effort: the tracking ref is a convenience, and the release is pushed either way.
  git(['update-ref', `refs/remotes/origin/${STABLE}`, commit]);
  verdicts[5] = OK;
  await out([header(6, 'Push'), ...detail([`origin has ${plan.tag} and ${STABLE} at ${short(commit)}, ${local}.`]), '']);

  // --- 7. The release notes -------------------------------------------------------------------
  const done = `${plan.tag} is released: ${STABLE} is at ${short(commit)}.`;
  if (plan.repo === null) {
    verdicts[6] = { label: 'none: origin is not on GitHub' };
    await out([header(7, 'Release notes'), ...detail(['origin is not on GitHub, so there are none.']), '']);
    return finish([done]);
  }
  const notesArgs = plan.notes === null ? ['--generate-notes'] : ['--notes-file', plan.notes];
  const create = ['release', 'create', plan.tag, '--repo', plan.repo, '--verify-tag', '--title', `draftgate ${plan.tag}`, ...notesArgs];
  const notes = ctx.gh(create);
  if (!notes.ok) {
    verdicts[6] = failed('gh failed');
    await out([header(7, 'Release notes'), ...detail(['gh could not create them:']), ...quoted(notes.output, QUOTED_LINES), '']);
    return finish([done, `Only its notes are missing: gh ${create.map(shellWord).join(' ')}`]);
  }
  verdicts[6] = OK;
  await out([header(7, 'Release notes'), ...detail([notes.stdout.trim()]), '']);
  return finish([done]);
}

/** What step 1 established, and steps 5 to 7 act on. */
interface Plan {
  tag: string;
  notes: string | null;
  /** main's tip, the commit tagged. */
  head: string;
  /** The newest release on origin before this one. */
  previous: string | null;
  /** origin's `stable`, fetched, or null when there is none yet. */
  oldStable: string | null;
  /** `owner/repo` when origin is on GitHub. */
  repo: string | null;
}

/** Step 1: every refusal, before anything is built. Throws a `Refusal`; answers the plan. */
function checks(argv: string[], ctx: ReleaseContext, git: Git): Plan {
  const args = parseReleaseArgs(argv);
  if ('error' in args) throw new Refusal(args.error);
  const notes = args.notes === null ? null : resolve(ctx.root, args.notes);
  const notesFile = notes === null ? null : statSync(notes, { throwIfNoEntry: false });
  if (notes !== null && !(notesFile?.isFile() && notesFile.size > 0)) {
    throw new Refusal([`--notes ${notes} is not a file with something in it.`]);
  }

  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok || branch.stdout.trim() !== MAIN) {
    const on = branch.ok ? `on ${branch.stdout.trim()}` : 'not on a branch';
    throw new Refusal([`This checkout is ${on}. A release is cut from ${MAIN}.`]);
  }
  const status = must(git, ['status', '--porcelain'], 'git status');
  if (status !== '') {
    const lines = status.split('\n');
    throw new Refusal([
      `The tree has ${lines.length} change${lines.length === 1 ? '' : 's'} git would not ship (untracked files count:`,
      'the build reads them, and a release clone does not have them):',
      ...quoted(lines.slice(0, 5).join('\n')),
      'Commit, stash or remove them, then run this again.',
    ]);
  }
  const head = must(git, ['rev-parse', '--verify', 'HEAD'], 'git rev-parse HEAD');
  const manifest = git(['show', `${head}:${PLUGIN_MANIFEST}`]);
  if (!manifest.ok) throw new Refusal([`${MAIN} has no ${PLUGIN_MANIFEST}, whose version a release is.`]);
  const version = pluginVersion(manifest.stdout);
  if ('error' in version) throw new Refusal([`${version.error}.`]);
  const tag = version.tag;
  const bump = `Bump the version in ${PLUGIN_MANIFEST}, in a commit on ${MAIN}: it is the plugin's only update signal.`;

  const remote = lsRemoteRefs(must(git, ['ls-remote', 'origin', `refs/heads/${MAIN}`, `refs/heads/${STABLE}`, 'refs/tags/v*'], "listing origin's refs"));
  const originMain = remote.heads.get(MAIN);
  if (originMain !== head) {
    throw new Refusal([
      originMain === undefined
        ? `origin has no ${MAIN}.`
        : `HEAD is ${short(head)} and origin's ${MAIN} is ${short(originMain)}. A release is origin's ${MAIN}, exactly: pull or push first.`,
    ]);
  }

  if (remote.tags.has(tag)) throw new Refusal([`${tag}, ${PLUGIN_MANIFEST}'s version, is released already.`, bump]);
  if (git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).ok) {
    throw new Refusal([`${tag} exists already here, and not on origin: git tag -d it if nobody needs it.`]);
  }
  // Origin's releases alone: a tag only this checkout has was never released.
  const previous = newestRelease(remote.tags.keys());
  if (previous !== null && !isNewerRelease(tag, previous)) {
    throw new Refusal([`${tag}, ${PLUGIN_MANIFEST}'s version, is not newer than ${previous}, the newest release.`, bump]);
  }

  const oldStable = remote.heads.get(STABLE) ?? null;
  if (oldStable !== null) {
    must(git, ['fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${STABLE}`], `git fetch origin ${STABLE}`);
    stableIsRelease(oldStable, head, git);
  }

  const repo = githubRepo(originUrl(ctx.root, ctx.env) ?? '');
  if (repo !== null) {
    const seen = ctx.gh(['repo', 'view', repo, '--json', 'nameWithOwner']);
    if (!seen.ok) throw new Refusal([`origin is ${repo} on GitHub, and gh cannot reach it to write the release notes:`, ...quoted(seen.output, QUOTED_LINES)]);
  }
  return { tag, notes, head, previous, oldStable, repo };
}

/**
 * Is `stable`'s tip a release commit, adding only what a release adds to a release on `main`'s line?
 * Its last parent is the release it was made from; that must be an ancestor of `head`, the tip's
 * tree, outside the window and `plugin/`, must be that release's tree, and its `plugin/` must be
 * exactly what `pluginTree` assembles from that release and the tip's window (nothing beyond the
 * release's own `plugin/` files, for a release from before the plugin). Anything else on `stable`
 * would be dropped by the next release commit, or would ship to every plugin install, so it refuses
 * instead.
 */
function stableIsRelease(stable: string, head: string, git: Git): void {
  const parents = must(git, ['rev-list', '--parents', '-n', '1', stable], `git rev-list ${short(stable)}`).split(' ').slice(1);
  const made = parents.at(-1);
  const notRelease = (why: string) =>
    new Refusal([`origin's ${STABLE} (${short(stable)}) is not a release commit: ${why}.`, `Nothing but releases may move ${STABLE}; look at what is there before releasing over it.`]);
  if (made === undefined) throw notRelease('it has no parent');
  if (!git(['merge-base', '--is-ancestor', made, head]).ok) throw notRelease(`its last parent ${short(made)} is not on ${MAIN}`);
  const tip = entriesOf(git, ['ls-tree', '-r', '-z', '--full-tree', stable], LS_TREE_OBJECT);
  const release = entriesOf(git, ['ls-tree', '-r', '-z', '--full-tree', made], LS_TREE_OBJECT);
  const inPlugin = (p: string) => p.startsWith(`${PLUGIN_DIR}/`);
  const only = (m: Map<string, string>, keep: (p: string) => boolean) => new Map([...m].filter(([p]) => keep(p)));
  const released = (p: string) => !inPlugin(p) && !p.startsWith(`${WINDOW_DIR}/`);
  const changed = manifestDiff(only(release, released), only(tip, released));
  if (changed !== null) throw notRelease(`it changes more than ${WINDOW_DIR} and ${PLUGIN_DIR}/ over ${short(made)}, ${changed} among it`);
  // What the assembly reads: the tip's tree outside plugin/ (the release's, and its window), and the
  // release's own plugin/ files. A release from before the plugin assembles none, and its plugin/
  // holds only what the release had there.
  const source = new Map([...only(tip, (p) => !inPlugin(p)), ...only(release, inPlugin)]);
  let want = only(release, inPlugin);
  if (source.has(PLUGIN_MANIFEST)) {
    const stampText = git(['show', `${stable}:${WINDOW_DIR}/${STAMP_BASENAME}`]);
    const stamp = stampText.ok ? parseStamp(stampText.stdout) : null;
    const assembled = stamp === null ? { error: `it has no build stamp in ${WINDOW_DIR}` } : assembledEntries(source, stamp);
    if ('error' in assembled) throw notRelease(`its ${PLUGIN_DIR}/ cannot be assembled from it: ${assembled.error}`);
    want = assembled;
  }
  const differs = manifestDiff(want, only(tip, inPlugin));
  if (differs !== null) throw notRelease(`its ${differs} is not what an assembly of ${short(made)} makes`);
}

/** The plugin tree as index entries, path -> `<mode> <object>`, out of the entries of what it copies. */
function assembledEntries(source: Map<string, string>, stamp: BuildStamp): Map<string, string> | { error: string } {
  const tree = pluginTree([...source.keys()], stamp);
  return 'error' in tree ? tree : new Map([...tree].map(([at, from]) => [at, source.get(from)!]));
}

/** Where the object id is among the fields before the tab: `ls-tree`'s `<mode> <type> <object>`. */
const LS_TREE_OBJECT = 2;
/** `ls-files --stage`'s `<mode> <object> <stage>`. */
const LS_FILES_OBJECT = 1;

/**
 * A `-z` listing of `<fields>\t<path>` records, path -> `<mode> <object>`: the shape an index entry
 * is written back in. `object` is the object id's field; `extra` carries a scratch `GIT_INDEX_FILE`.
 */
function entriesOf(git: Git, args: string[], object: number, extra?: NodeJS.ProcessEnv): Map<string, string> {
  const listed = must(git, args, `git ${args[0]}`, extra);
  const out = new Map<string, string>();
  for (const line of listed.split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const fields = line.slice(0, tab).split(' ');
    out.set(line.slice(tab + 1), `${fields[0]} ${fields[object]}`);
  }
  return out;
}

/**
 * Step 5: the annotated tag's object, the release commit built in a scratch index, and the commit
 * read back as a release clone has it. No ref is written, so a refusal leaves nothing behind. Throws
 * a `Refusal`.
 */
function releaseCommit(plan: Plan, git: Git, built: Map<string, string>, stamp: BuildStamp): { tagObject: string; commit: string } {
  // Nothing may have moved while the verifiers ran.
  if (must(git, ['rev-parse', '--verify', 'HEAD'], 'git rev-parse HEAD') !== plan.head) {
    throw new Refusal([`HEAD moved while the verifiers ran. Run this again.`]);
  }
  if (must(git, ['status', '--porcelain'], 'git status') !== '') {
    throw new Refusal([`The tree changed while the verifiers ran. Run this again on a clean tree.`]);
  }

  const tagger = must(git, ['var', 'GIT_COMMITTER_IDENT'], 'git var GIT_COMMITTER_IDENT');
  const tagText = `object ${plan.head}\ntype commit\ntag ${plan.tag}\ntagger ${tagger}\n\ndraftgate ${plan.tag}\n`;
  const tagged = git(['mktag'], {}, tagText);
  if (!tagged.ok) throw new Refusal(['git mktag failed:', ...quoted(tagged.output, QUOTED_LINES)]);
  const tagObject = tagged.stdout.trim();

  const scratch = mkdtempSync(join(tmpdir(), 'draftgate-release-'));
  try {
    // The tagged tree plus the window, in an index of its own: the checkout's index is not touched.
    const index = { GIT_INDEX_FILE: join(scratch, 'index') };
    must(git, ['read-tree', plan.head], 'git read-tree', index);
    must(git, ['add', '--force', '--', WINDOW_DIR], `git add ${WINDOW_DIR}`, index);
    // Then the plugin tree, as index entries naming the blobs it copies.
    const assembled = assembledEntries(entriesOf(git, ['ls-files', '--stage', '-z'], LS_FILES_OBJECT, index), stamp);
    if ('error' in assembled) throw new Refusal([`The plugin tree cannot be assembled: ${assembled.error}.`]);
    const info = [...assembled].map(([at, entry]) => `${entry}\t${at}\0`).join('');
    const added = git(['update-index', '-z', '--index-info'], index, info);
    if (!added.ok) throw new Refusal(['git update-index failed:', ...quoted(added.output, QUOTED_LINES)]);
    const tree = must(git, ['write-tree'], 'git write-tree', index);
    const parents = plan.oldStable ? ['-p', plan.oldStable, '-p', plan.head] : ['-p', plan.head];
    const message =
      `Release ${plan.tag}\n\nThe built review window, verified by ${VERIFIERS.join(' and ')}: stamp ${stamp.stamp}.\n` +
      `The plugin tree under ${PLUGIN_DIR}/: ${assembled.size} files.\n`;
    const commit = must(git, ['commit-tree', tree, ...parents, '-m', message], 'git commit-tree');

    // Read back: that tree, written out as a clone of the commit has it on disk.
    const clone = join(scratch, 'clone');
    must(git, ['checkout-index', '--all', `--prefix=${clone}/`], 'git checkout-index', index);
    // The checkout a `stable` clone is, and the plugin root Claude Code copies into its cache.
    for (const [root, what] of [[clone, 'A release clone'], [join(clone, PLUGIN_DIR), `The release's ${PLUGIN_DIR}/`]] as const) {
      const problem = shippedWindowProblem(root, built);
      if (problem !== null) throw new Refusal([`${what} would not run the verified window: ${problem}.`]);
    }
    if (plan.oldStable && !git(['merge-base', '--is-ancestor', plan.oldStable, commit]).ok) {
      throw new Refusal([`The release commit does not fast-forward ${STABLE}.`]);
    }
    return { tagObject, commit };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * After a failed push: does origin have the tag at `head` and `stable` at `commit` (`both`), still
 * neither of them (`neither`), or anything else, a listing git could not make included (`unclear`)?
 */
export function originHas(
  plan: Pick<Plan, 'tag' | 'head' | 'oldStable'>,
  commit: string,
  git: Git
): 'both' | 'neither' | 'unclear' {
  // `*`, so the listing carries the peeled line too: the annotated tag's commit, not its object.
  const listed = git(['ls-remote', 'origin', `refs/heads/${STABLE}`, `refs/tags/${plan.tag}*`]);
  if (!listed.ok) return 'unclear';
  const { heads, tags } = lsRemoteRefs(listed.stdout);
  const tag = tags.get(plan.tag);
  const stable = heads.get(STABLE) ?? null;
  if (tag === plan.head && stable === commit) return 'both';
  if (tag === undefined && stable === plan.oldStable) return 'neither';
  return 'unclear';
}

if (import.meta.main) {
  release(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`release: unexpected failure: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(1);
    }
  );
}
