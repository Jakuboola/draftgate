/**
 * No runtime message spells a `bun` command outside `core/src/remedies.ts`. Every string and
 * template literal in the runtime sources is read through TypeScript's own parser, so a comment
 * quoting a command is not a hit and a string split across `+` still is. `args.ts` (`--help`) is
 * left out by name: human text written as a whole; the commands it shares still come from `REMEDY`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { REMEDY } from '../../core/src/remedies';

const ROOT = join(import.meta.dir, '..', '..');
/** Every runtime source: TypeScript under the four trees, and the CommonJS the window runs. */
const SOURCES = [
  'cli/src/**/*.ts',
  'adapters/hook/src/**/*.ts',
  'core/src/**/*.ts',
  'surface/src/**/*.{ts,tsx}',
  'surface/*.cjs',
];
const EXCLUDED = new Set(['core/src/remedies.ts', 'cli/src/args.ts']);
/**
 * A command, not the word: `bunx`, `bun <subcommand>`, bun running a path -- or `bun ` ending a
 * template chunk, which is how a command around an interpolated path reads to the parser.
 */
const BUN_COMMAND =
  /\bbunx\b|\bbun (run|install|add|build|pm|link|x|test|[\w./-]+\.(ts|mjs|cjs|js))\b|\bbun $/;

function sourceFiles(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync(ROOT)]
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes('__tests__') && !EXCLUDED.has(f))
    .sort();
}

/**
 * Every string and template literal's text, off a real parse. A bare scanner cannot tell a regex
 * from a division, and misreads doc comments as strings.
 */
function literals(text: string, name: string): string[] {
  const kind = name.endsWith('.tsx') ? ts.ScriptKind.TSX : name.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, kind);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

describe('commands are spelled in one place', () => {
  const files = SOURCES.flatMap(sourceFiles);

  test('installPlugin is install, then the plugin setup, spelled as they are', () => {
    expect(REMEDY.installPlugin as string).toBe(`${REMEDY.install}, then ${REMEDY.pluginSetup} in Claude Code`);
  });

  test('the scan sees the files it guards, so it cannot pass vacuously', () => {
    for (const f of [
      'cli/src/surfaces/window.ts',
      'adapters/hook/src/decide.ts',
      'surface/src/useReview.ts',
      'surface/request.cjs',
    ]) {
      expect(files).toContain(f);
    }
    // The literal reader finds every REMEDY string in `remedies.ts` itself; a reader that returned
    // nothing would pass every scan.
    const own = literals(readFileSync(join(ROOT, 'core/src/remedies.ts'), 'utf8'), 'remedies.ts');
    const strings = (Object.values(REMEDY) as unknown[]).filter((v): v is string => typeof v === 'string');
    expect(strings.length).toBeGreaterThanOrEqual(5);
    for (const v of strings) expect(own).toContain(v);
  });

  // A fixed table, not REMEDY: counting REMEDY's bun entries goes vacuous the moment they are
  // respelled without bun.
  test.each([
    ['`bun run build:surface`', true],
    ['run `bun install` first', true],
    ['bunx tsc', true],
    ['bun cli/src/main.ts review', true],
    ['`bun ', true],
    ['a bun of bread', false],
    ['`xcode-select --install`', false],
    ['`draftgate doctor`', false],
  ] as const)('the bun pattern reads %j as a command: %p', (text, isCommand) => {
    expect(BUN_COMMAND.test(text)).toBe(isCommand);
  });

  /*
   * The bun pattern cannot see a non-bun REMEDY (`xcode-select --install`) written out again, so
   * each is looked for as itself, backticks included: a `draftgate` command's bare words are also
   * how a sentence names the program. A command written without backticks is not caught.
   */
  test('no runtime string outside remedies.ts writes out any REMEDY command', () => {
    const commands = (Object.values(REMEDY) as unknown[])
      .filter((v): v is string => typeof v === 'string');
    const hits = files.flatMap((f) =>
      literals(readFileSync(join(ROOT, f), 'utf8'), f)
        .filter((l) => commands.some((c) => l.includes(c)))
        .map((l) => `${f}: ${JSON.stringify(l.slice(0, 120))}`)
    );
    expect(hits, 'use the REMEDY from core/src/remedies.ts instead of writing the command out').toEqual([]);
  });

  test('no runtime string outside remedies.ts spells a bun command', () => {
    const hits = files.flatMap((f) =>
      literals(readFileSync(join(ROOT, f), 'utf8'), f)
        .filter((l) => BUN_COMMAND.test(l))
        .map((l) => `${f}: ${JSON.stringify(l.slice(0, 120))}`)
    );
    expect(hits, 'use a REMEDY from core/src/remedies.ts instead of writing the command out').toEqual(
      []
    );
  });
});
