/**
 * The scripts the harness injects into the renderer live in `injected.cjs` as functions. A script
 * written as a template literal ends early at any backtick inside it, still parses in the outer file,
 * and reaches the renderer truncated: the probe hangs instead of failing. The only expression built
 * anywhere is `(${fn.toString()})(${args})`, so a backtick in a body is a character in a string.
 *
 * The review host evaluates nothing in its page; the driver's two sites (`evaluate`,
 * `evaluateNoWait` in `wkSession.ts`) are built from `toString()`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS, INJECTED, SURFACE } from './shared';

// The REVIEW host's source: `harness.m` is the harness build's alone, and is where evaluation lives.
const HOST = readFileSync(join(SURFACE, 'host', 'draftgate.m'), 'utf8');
const DRIVER = readFileSync(join(HARNESS, 'wkSession.ts'), 'utf8');
// The file's own text, which is what gets injected (see `sourceOf`).
const INJECTED_SOURCE = readFileSync(join(HARNESS, 'injected.cjs'), 'utf8');
// Through `shared.ts`, not a second `require`. The cast is compile-time only, so `Object.keys` still
// sees a function missing from the `Injected` interface.
const injected = INJECTED as unknown as Record<string, (...a: never[]) => unknown>;

describe('the application injects nothing, and the driver injects only sources', () => {
  /**
   * The review host's two user scripts (the bridge and the context-menu guard) are injected at
   * document start as fixed text, not evaluated. One evaluation site would bring the class back.
   */
  test('the review host executes no script in its page', () => {
    for (const call of ['evaluateJavaScript', 'callAsyncJavaScript']) {
      expect(
        HOST.split(call).length - 1,
        `draftgate.m calls ${call}. The harness drives from outside (harness.m, wkSession.ts); an ` +
          'evaluation site in the review build is either instrumentation coming back or an approval path'
      ).toBe(0);
    }
  });

  // Two halves of one claim: a hand-written expression at a call site passes the second, and an
  // `expressionFor` that stopped using `toString()` passes the first.
  test("every eval op in wkSession.ts takes its expression from the one builder", () => {
    const sites = [...DRIVER.matchAll(/op\('eval', \{([^}]*)\}\)/g)];
    expect(sites.length, 'no eval sites found -- this cannot pass vacuously').toBeGreaterThanOrEqual(2);
    for (const [, params] of sites) {
      expect(
        params,
        'an eval whose expression is not built by `expressionFor` means a hand-written script is ' +
          'back; put it in injected.cjs instead'
      ).toContain('expressionFor(fn, args)');
    }
  });

  test('...and the builder builds it from the function source', () => {
    const at = DRIVER.indexOf('function expressionFor');
    expect(at, 'wkSession.ts no longer has an `expressionFor`').toBeGreaterThan(-1);
    expect(DRIVER.slice(at, DRIVER.indexOf('\n}', at))).toContain('fn.toString()');
  });

  test('the driver requires the injected module rather than inlining it', () => {
    const shared = readFileSync(join(HARNESS, 'shared.ts'), 'utf8');
    expect(shared).toContain("require(join(HARNESS, 'injected.cjs'))");
  });
});

describe('every injected script is self-contained', () => {
  const names = Object.keys(injected);

  /**
   * Each function's source as the file holds it. Not `fn.toString()`: bun transpiles and minifies the
   * `.cjs` (`return false` comes back `return !1`, comments gone), so a module-scope constant bun
   * inlined would pass here and throw `ReferenceError` under node. Brace-matched on the `}` at column
   * zero; `parses as a program` fails if that stops holding.
   */
  function sourceOf(name: string): string {
    const decl = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(INJECTED_SOURCE);
    expect(decl, `${name} is exported but not declared as a top-level function`).not.toBeNull();
    const from = decl!.index;
    const close = INJECTED_SOURCE.indexOf('\n}', from);
    expect(close, `${name} has no closing brace at column zero`).toBeGreaterThan(from);
    return INJECTED_SOURCE.slice(from, close + 2);
  }

  test('there are some to check, and each is a function', () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) expect(typeof injected[name], name).toBe('function');
  });

  // The source runs in the renderer, where nothing from node exists.
  const FORBIDDEN = ['require(', '__dirname', '__filename', 'process.'];

  test('none references anything from the node side', () => {
    const bad = names.flatMap((name) => {
      const source = sourceOf(name);
      return FORBIDDEN.filter((token) => source.includes(token)).map((token) => `${name} uses ${token}`);
    });
    expect(bad, 'these do not exist in the renderer').toEqual([]);
  });

  /**
   * Every top-level name in `injected.cjs`. A module-scope `const` is the realistic reach `FORBIDDEN`
   * cannot see. A declaration-name check: it cannot see an identifier undeclared everywhere (a typo).
   */
  const TOP_LEVEL = [
    ...INJECTED_SOURCE.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm),
    ...INJECTED_SOURCE.matchAll(/^(?:const|let|var) ([A-Za-z_$][\w$]*)/gm),
  ].map((m) => m[1]!);

  test('the declaration scan found every export, so it is looking at the right thing', () => {
    for (const name of names) expect(TOP_LEVEL).toContain(name);
  });

  test('none reaches for a top-level name but its own', () => {
    const bad = names.flatMap((name) => {
      // The body only: the declaration line names the function itself.
      const source = sourceOf(name);
      const body = source.slice(source.indexOf('{'));
      return TOP_LEVEL.filter((other) => other !== name && new RegExp(`\\b${other}\\b`).test(body))
        .map((other) => `${name} names ${other}`);
    });
    expect(bad, 'module scope here, which does not exist in the renderer').toEqual([]);
  });

  // `new Function` compiles without running, so a body that cannot be a program fails here rather
  // than as a hung renderer.
  test('each parses as a program when wrapped for injection', () => {
    const bad = names.filter((name) => {
      try {
        new Function(`return (${sourceOf(name)})();`);
        return false;
      } catch {
        return true;
      }
    });
    expect(bad).toEqual([]);
  });
});
