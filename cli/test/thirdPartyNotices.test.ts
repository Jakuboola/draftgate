/**
 * Where a bundled package's licence text is found, and what happens when it is not.
 *
 * Real directories, because what is judged is a package as it lies on disk. What the real build
 * writes is asserted in `surfaceBundle.test.ts`, the one suite that builds the window.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOTICES_FILE,
  noticesText,
  packageDirOf,
  packageNotice,
  readmeLicenceSection,
  virtualPackageDir,
  writeNotices,
  type PackageNotice,
} from '../src/surfaces/thirdPartyNotices';

const REPO = join(import.meta.dir, '..', '..');

const made: string[] = [];
afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

/** A checkout root holding one package at `node_modules/<name>` with the given files. */
function withPackage(name: string, files: Record<string, string>): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'draftgate-notices-'));
  made.push(root);
  const dir = `node_modules/${name}`;
  mkdirSync(join(root, dir), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, dir, file), text);
  return { root, dir };
}

const manifest = (name: string, license = 'MIT') =>
  JSON.stringify({ name, version: '1.2.3', license });

describe('which package an input belongs to', () => {
  test.each([
    ['node_modules/react-dom/cjs/react-dom.production.min.js', 'node_modules/react-dom'],
    ['node_modules/@tiptap/pm/state/dist/index.js', 'node_modules/@tiptap/pm'],
    // The last `node_modules` names the package, whatever holds it.
    ['node_modules/a/node_modules/@s/b/index.js', 'node_modules/a/node_modules/@s/b'],
    ['surface/node_modules/x/index.js', 'surface/node_modules/x'],
  ])('%s is in %s', (key, dir) => {
    expect(packageDirOf(key)).toBe(dir);
  });

  test.each([['surface/src/main.tsx'], ['bun.lock'], ['node_modules/loose-file.js']])(
    '%s is in no package',
    (key) => {
      expect(packageDirOf(key)).toBeNull();
    }
  );
});

describe('a package with a licence file', () => {
  test('is credited with every licence file at its root, verbatim, and they are all read', () => {
    const { root, dir } = withPackage('p', {
      'package.json': manifest('p'),
      'LICENSE.md': 'MIT text\n',
      NOTICE: 'notice text\n',
      'README.md': '## License\n\nnot this one\n',
      'licensed.js': 'not a licence\n',
      // Named like a licence, and code.
      'license.js': 'module.exports = 1;\n',
      'notice.d.ts': 'export {};\n',
    });
    const notice = packageNotice(root, dir);
    expect(notice).toMatchObject({ name: 'p', version: '1.2.3', license: 'MIT' });
    expect(notice.text).toBe('MIT text\n\nnotice text');
    expect(notice.read.map((f) => f.slice(root.length + 1)).sort()).toEqual(
      [`${dir}/LICENSE.md`, `${dir}/NOTICE`, `${dir}/package.json`].sort()
    );
  });
});

describe('a package whose licence is in its README', () => {
  const README = [
    '# lato-font',
    '',
    'Intro.',
    '',
    '## Licenses',
    '',
    '### Library',
    '',
    '    MIT text',
    '',
    '### Font',
    '',
    '    OFL text',
    '',
    '## Changelog',
    '',
    'not a licence',
  ].join('\n');

  test('is credited with that section, sub-headings included, up to the next heading at its level', () => {
    const { root, dir } = withPackage('lato-font', {
      'package.json': manifest('lato-font', '(MIT AND OFL-1.1)'),
      'README.md': README,
    });
    const notice = packageNotice(root, dir);
    expect(notice.text).toContain('MIT text');
    expect(notice.text).toContain('OFL text');
    expect(notice.text).not.toContain('Changelog');
    expect(notice.text).not.toContain('Intro');
    expect(notice.read.some((f) => f.endsWith('README.md'))).toBe(true);
  });

  test('a section running to the end of the file is all of it', () => {
    expect(readmeLicenceSection('# x\n\n## License\n\nMIT\n')).toBe('## License\n\nMIT');
  });

  test('a `#` inside a fenced block is a comment, not a heading', () => {
    const readme = '```sh\n# license\n```\n\n## License\n\n```sh\n# install it\n```\nMIT\n\n## Next\n';
    expect(readmeLicenceSection(readme)).toBe('## License\n\n```sh\n# install it\n```\nMIT');
  });

  test('the link-reference definitions at its end are not licence text', () => {
    const readme = '## License\n\nMIT, see [site].\n\n[site]: https://example.com\n[email]: mailto:a@example.com\n';
    expect(readmeLicenceSection(readme)).toBe('## License\n\nMIT, see [site].');
  });

  test('a heading with nothing under it is no section', () => {
    expect(readmeLicenceSection('# x\n\n## License\n\n## Next\n\nbody\n')).toBeNull();
  });
});

describe('a package with no licence text', () => {
  test.each([
    ['no licence file and no README', { 'package.json': manifest('bare') }],
    ['a README without a licence section', { 'package.json': manifest('bare'), 'README.md': '# bare\n\nhi\n' }],
  ])('%s fails, naming the package', (_name, files) => {
    const { root, dir } = withPackage('bare', files);
    expect(() => packageNotice(root, dir)).toThrow(/bare \(node_modules\/bare\).*no licence file/);
  });

  test('no package.json fails too: there is nothing to credit it by', () => {
    const { root, dir } = withPackage('nameless', { LICENSE: 'MIT\n' });
    expect(() => packageNotice(root, dir)).toThrow(/node_modules\/nameless.*no readable package\.json/);
  });
});

describe('the licence a manifest states', () => {
  test.each([
    [{ license: 'MIT' }, 'MIT'],
    [{ license: { type: 'BSD-3-Clause' } }, 'BSD-3-Clause'],
    [{ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }, 'MIT, Apache-2.0'],
    [{}, 'unstated'],
  ])('%j reads %s', (fields, license) => {
    const { root, dir } = withPackage('p', {
      'package.json': JSON.stringify({ name: 'p', version: '1.0.0', ...fields }),
      LICENSE: 'text\n',
    });
    expect(packageNotice(root, dir).license).toBe(license);
  });
});

describe('a virtual module', () => {
  test('is credited to the package its id names, found from the checkout', () => {
    expect(virtualPackageDir(REPO, '\0vite/preload-helper.js', REPO)).toBe('node_modules/vite');
    expect(virtualPackageDir(REPO, '\0rolldown/runtime.js', REPO)).toBe('node_modules/rolldown');
  });

  test.each([['\0commonjsHelpers.js'], ['\0no-such-package-here/x.js']])(
    '%s names no package this checkout has, and fails',
    (id) => {
      expect(() => virtualPackageDir(REPO, id, REPO)).toThrow(/names no package this checkout has/);
    }
  );
});

describe('the licence beside the assets', () => {
  test('two copies of one package name share its file, and both are credited in it', () => {
    const { root } = withPackage('font', { 'package.json': manifest('font', 'OFL-1.1'), LICENSE: 'outer\n' });
    const inner = join(root, 'node_modules', 'other', 'node_modules', 'font');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'font', version: '2.0.0', license: 'OFL-1.1' }));
    writeFileSync(join(inner, 'LICENSE'), 'inner\n');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'NOTICE'), 'repo\n');
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    const sources = ['node_modules/font/a.woff2', 'node_modules/other/node_modules/font/b.woff2'];
    writeNotices({
      root,
      distDir: dist,
      keys: sources,
      virtual: [],
      toolchainDir: root,
      assets: sources.map((s, i) => ({ source: join(root, s), fileName: `assets/f${i}.woff2` })),
    });
    expect(readdirSync(join(dist, 'assets'))).toEqual(['font.LICENSE.txt']);
    const beside = readFileSync(join(dist, 'assets', 'font.LICENSE.txt'), 'utf8');
    expect(beside).toContain('font 1.2.3, OFL-1.1\n\nouter');
    expect(beside).toContain('font 2.0.0, OFL-1.1\n\ninner');
    expect(readFileSync(join(dist, NOTICES_FILE), 'utf8')).toContain('repo');
  });
});

describe('the notices text', () => {
  const pkg = (name: string, text: string): PackageNotice => ({
    dir: `node_modules/${name}`,
    name,
    version: '1.0.0',
    license: 'MIT',
    text,
    read: [],
  });

  test('opens with the repository NOTICE, lists every package, and prints each distinct text once', () => {
    const out = noticesText('REPO NOTICE\n', [pkg('a', 'shared'), pkg('b', 'own'), pkg('c', 'shared')]);
    expect(out.startsWith("Third-party notices for draftgate's review window\n\nREPO NOTICE\n")).toBe(true);
    for (const name of ['a', 'b', 'c']) expect(out).toContain(`  ${name} 1.0.0, MIT\n`);
    expect(out.match(/^shared$/gm)).toHaveLength(1);
    expect(out.match(/^own$/gm)).toHaveLength(1);
    // The shared text is credited to both packages that ship it, together.
    expect(out).toContain('a 1.0.0, MIT\nc 1.0.0, MIT\n\nshared');
  });
});
