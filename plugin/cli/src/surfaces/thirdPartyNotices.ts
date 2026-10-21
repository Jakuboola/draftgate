/**
 * The licence notices that travel with the built window.
 *
 * Minifying drops every `@license` banner, and MIT, BSD-3-Clause and ISC require the notice with
 * every copy. So the build writes `THIRD_PARTY_NOTICES` into `dist/` from the stamp's input list: a
 * package is credited because the build read one of its files, never because a list names it.
 *
 * A package's text is its own licence files, verbatim: every `LICENSE*`, `LICENCE*`, `COPYING*` and
 * `NOTICE*` at its root, or else its README's licence section (`lato-font`). A package with neither
 * fails the build, and so does a checkout with no `docs/NOTICE`.
 *
 * Virtual modules the toolchain injects (Vite's preload helper, rolldown's runtime) reach no `load`
 * hook as a file; each names its package (`\0vite/...`), resolved from the checkout and credited like
 * any other, and one that names none fails the build. A package whose files ship as assets (the
 * fonts) also gets its licence beside them, where a font's licence is looked for.
 *
 * `docs/NOTICE` opens the file, verbatim: it credits first-party source no package holds (the
 * Atlassian palette, the vendor stylesheet values). Every file read here is returned for the stamp.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isPlainObject } from '../json';
import { inputKey, inputPath } from './bundleStamp';

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES';

/** The repository's own attributions, under `docs/` in the checkout. */
const REPO_NOTICE = 'docs/NOTICE';

/** A licence file at a package's root, by its basename; a source file of that name is code. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i;
const CODE_FILE = /\.([cm]?[jt]sx?|json|map)$/i;

const RULE = '-'.repeat(80);

/** The package an input key lies in: its directory under the last `node_modules`, or null. */
export function packageDirOf(key: string): string | null {
  return /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(key)?.[1] ?? null;
}

export interface PackageNotice {
  /** The package's directory, as a stamp key. */
  dir: string;
  name: string;
  version: string;
  /** The manifest's licence, in its `license` or legacy `licenses` form, or `unstated`. */
  license: string;
  /** The licence text the package itself ships. */
  text: string;
  /** Every file the text was read from, absolute. */
  read: string[];
}

/** Each line's ATX heading level, or 0: none inside a fenced code block, where `#` is a comment. */
function headingLevels(lines: readonly string[]): number[] {
  let fence: string | null = null;
  return lines.map((l) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(l)?.[1];
    if (marker !== undefined && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      return 0;
    }
    return fence === null ? (/^(#{1,6})\s/.exec(l)?.[1]!.length ?? 0) : 0;
  });
}

/**
 * The README section headed `License` or `Licenses` (any ATX level), up to the next heading of the
 * same level or higher, less the link-reference definitions a README keeps at a section's end. Null
 * when there is none, and a README that states its licence some other way fails the build rather
 * than being guessed at.
 */
export function readmeLicenceSection(readme: string): string | null {
  const lines = readme.split('\n');
  const levels = headingLevels(lines);
  const start = lines.findIndex((l, i) => levels[i]! > 0 && /^#+\s+licen[cs]es?\b/i.test(l));
  if (start === -1) return null;
  const end = levels.findIndex((n, i) => i > start && n > 0 && n <= levels[start]!);
  const body = lines.slice(start, end === -1 ? undefined : end);
  while (body.length > 1 && /^\s*(\[[^\]]+\]:\s*\S.*)?$/.test(body.at(-1)!)) body.pop();
  return body.length > 1 ? body.join('\n').trim() : null;
}

/** The manifest's licence: `license` as a string or `{ type }`, or the legacy `licenses` list. */
function licenceOf(manifest: Record<string, unknown>): string {
  const one = (l: unknown) =>
    typeof l === 'string' ? l : isPlainObject(l) && typeof l.type === 'string' ? l.type : null;
  const list = Array.isArray(manifest.licenses) ? manifest.licenses.map(one).filter((l) => l !== null) : [];
  return one(manifest.license) ?? (list.length > 0 ? list.join(', ') : 'unstated');
}

/** One package's notice, read off its own directory. Throws when it ships no licence text. */
export function packageNotice(root: string, dir: string): PackageNotice {
  const abs = inputPath(root, dir);
  const manifestPath = join(abs, 'package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }
  if (!isPlainObject(manifest)) {
    throw new Error(`the bundle reads ${dir}, which has no readable package.json to credit it by`);
  }
  const name = typeof manifest.name === 'string' ? manifest.name : dir;
  const version = typeof manifest.version === 'string' ? manifest.version : 'unversioned';
  const license = licenceOf(manifest);
  const read = [manifestPath];
  const entries = readdirSync(abs).sort();

  const files = entries
    .filter((f) => LICENCE_FILE.test(f) && !CODE_FILE.test(f))
    .map((f) => join(abs, f))
    .filter((f) => statSync(f).isFile());
  if (files.length > 0) {
    read.push(...files);
    const text = files.map((f) => readFileSync(f, 'utf8').trim()).join(`\n\n`);
    return { dir, name, version, license, text, read };
  }

  const readme = entries.find((f) => /^readme(\.[a-z]+)?$/i.test(f));
  if (readme !== undefined) {
    const path = join(abs, readme);
    const section = readmeLicenceSection(readFileSync(path, 'utf8'));
    if (section !== null) {
      read.push(path);
      return { dir, name, version, license, text: section, read };
    }
  }
  throw new Error(
    `the bundle includes ${name} (${dir}), which ships no licence file and no README licence ` +
      `section, so ${NOTICES_FILE} could not credit it`
  );
}

/** A file name for a package's licence: `@scope/name` reads `scope-name`. */
const licenceFileName = (name: string) =>
  `${name.replace(/^@/, '').replace(/[^\w.-]+/g, '-')}.LICENSE.txt`;

const heading = (p: PackageNotice) => `${p.name} ${p.version}, ${p.license}`;

/** The notices file's text: the repository's `docs/NOTICE`, then every package, one text per group. */
export function noticesText(repoNotice: string, packages: readonly PackageNotice[]): string {
  // One copy of each distinct text, credited to every package that ships it: thirty tiptap
  // packages carry the same file.
  const groups = Map.groupBy(packages, (p) => p.text);
  const out = [
    "Third-party notices for draftgate's review window",
    '',
    repoNotice.trim(),
    '',
    RULE,
    'The packages this bundle is built from',
    '',
    ...packages.map((p) => `  ${heading(p)}`),
  ];
  for (const [text, group] of groups) {
    out.push('', RULE, ...group.map(heading), '', text);
  }
  return `${out.join('\n')}\n`;
}

/** An emitted asset: the file it was made from and where it landed under `dist/`. */
export interface EmittedAsset {
  source: string;
  fileName: string;
}

/** The checkout's `docs/NOTICE`, which the notices open with. Throws when there is none. */
export function repoNotice(root: string): string {
  const path = join(root, REPO_NOTICE);
  if (!existsSync(path)) {
    throw new Error(`the checkout has no ${REPO_NOTICE}, which ${NOTICES_FILE} opens with`);
  }
  return path;
}

export interface NoticeInputs {
  root: string;
  distDir: string;
  /** Every input the build recorded, as stamp keys. */
  keys: Iterable<string>;
  /** The id of every virtual module rendered into a chunk, `\0` and all. */
  virtual: Iterable<string>;
  /** Where a virtual module's package is looked for after the root: the toolchain's own directory. */
  toolchainDir: string;
  assets: readonly EmittedAsset[];
}

/** The package directory, as a stamp key, that a virtual module's id names. Throws when none. */
export function virtualPackageDir(root: string, id: string, toolchainDir: string): string {
  const name = /^\0?((?:@[^/]+\/)?[^/]+)\//.exec(id)?.[1];
  let manifest: string | undefined;
  if (name !== undefined) {
    try {
      manifest = createRequire(join(root, 'package.json')).resolve(`${name}/package.json`, {
        paths: [root, toolchainDir],
      });
    } catch {
      // Named, and not found: the same refusal as naming nothing.
    }
  }
  const dir = manifest === undefined ? null : packageDirOf(inputKey(root, manifest));
  if (dir === null) {
    throw new Error(
      `the bundle includes the virtual module ${id.replace('\0', '')}, which names no package ` +
        `this checkout has, so ${NOTICES_FILE} could not credit it`
    );
  }
  return dir;
}

/**
 * Write `THIRD_PARTY_NOTICES`, and each asset package's licence beside its assets. Resolves to every
 * file read, for the stamp. Throws on a package with no licence text, or a checkout with no `docs/NOTICE`.
 */
export function writeNotices({ root, distDir, keys, virtual, toolchainDir, assets }: NoticeInputs): string[] {
  const noticePath = repoNotice(root);
  const dirs = [
    ...new Set([
      ...[...keys].map(packageDirOf).filter((d): d is string => d !== null),
      ...[...virtual].map((id) => virtualPackageDir(root, id, toolchainDir)),
    ]),
  ];
  const packages = dirs
    .map((d) => packageNotice(root, d))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  writeFileSync(join(distDir, NOTICES_FILE), noticesText(readFileSync(noticePath, 'utf8'), packages));

  // Per target file, every package whose assets landed there: two copies of one package name
  // share a file name, and each is credited in it.
  const byDir = new Map(packages.map((p) => [p.dir, p]));
  const beside = new Map<string, Set<PackageNotice>>();
  for (const { source, fileName } of assets) {
    const pkg = byDir.get(packageDirOf(inputKey(root, source)) ?? '');
    if (pkg === undefined) continue;
    const target = join(distDir, dirname(fileName), licenceFileName(pkg.name));
    beside.set(target, (beside.get(target) ?? new Set()).add(pkg));
  }
  for (const [target, group] of beside) {
    writeFileSync(target, `${[...group].map((p) => `${heading(p)}\n\n${p.text}`).join(`\n\n${RULE}\n\n`)}\n`);
  }
  return [noticePath, ...packages.flatMap((p) => p.read)];
}
