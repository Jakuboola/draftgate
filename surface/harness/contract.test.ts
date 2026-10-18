/**
 * `surface/contract.json` is the source of truth; the host and `windowProtocol.ts` read it.
 * `index.html` cannot import JSON, so its `<meta>` CSP is a copy, held here. A CSP mismatch between
 * the served header and the meta tag would be silent; a protocol one fails every review.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SURFACE } from './shared';
import contract from '../contract.json';
import {
  MAX_APPLIED_FIXES,
  MAX_FIX_FIELD_LENGTH,
  PROTOCOL_VERSION,
} from '../../cli/src/surfaces/windowProtocol';

// `index.html`, `contract.json` and `host/` live beside the app.
const HERE = SURFACE;

describe('surface/contract.json is the single source', () => {
  test('the protocol version the CLI speaks comes from the contract', () => {
    expect(PROTOCOL_VERSION).toBe(contract.protocolVersion);
  });

  test('the host reads the contract rather than restating either value', () => {
    const host = readFileSync(join(HERE, 'host', 'draftgate.m'), 'utf8');
    expect(host).toContain('[self read:@"contract.json"]');
    // A literal policy here would be a second definition.
    expect(host).not.toContain("default-src 'none'");
  });

  test('the fix caps come from the contract at BOTH ends', () => {
    /*
     * The host truncates before `windowProtocol.ts` sees the array, so a cap raised at one end only
     * would keep cutting accepted repairs at the other. The rule lives in `rendererBridge.cjs`, and
     * `rendererBridge.test.ts` runs the contract's numbers through it; this checks only that the
     * host passes the contract rather than literals.
     */
    expect(MAX_APPLIED_FIXES).toBe(contract.maxAppliedFixes);
    expect(MAX_FIX_FIELD_LENGTH).toBe(contract.maxFixFieldLength);
    /*
     * The host hands the whole contract to `sanitiseDecision`, so no single cap can be a literal.
     * Not `not.toContain("64")`: the number occurs in the file's prose.
     */
    const host = readFileSync(join(HERE, 'host', 'draftgate.m'), 'utf8');
    expect(host).toContain('fn:@"sanitiseDecision" args:@[ raw, _modules.contract ]');
    expect(host).not.toMatch(/MAX_FIXES\s*=\s*\d/);
    expect(host).not.toMatch(/MAX_FIX_FIELD\s*=\s*\d/);
  });

  test("index.html's meta CSP is byte-identical to the contract", () => {
    const html = readFileSync(join(HERE, 'index.html'), 'utf8');
    const match = html.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/
    );
    expect(match).not.toBeNull();
    expect(match![1]).toBe(contract.csp);
  });
});

describe('the policy itself', () => {
  const directives = new Map(
    contract.csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values.join(' ')];
    })
  );

  test('nothing may be fetched by default', () => {
    expect(directives.get('default-src')).toBe("'none'");
  });

  test('no unsafe-eval, anywhere', () => {
    expect(contract.csp).not.toContain('unsafe-eval');
  });

  test('the window cannot phone home', () => {
    // What holds the `img-src https:` trade: images may load, but no channel carries a response back.
    expect(directives.get('connect-src')).toBe("'none'");
  });

  test('scripts come only from the bundle', () => {
    expect(directives.get('script-src')).toBe("'self'");
  });

  test('inline styles are allowed, and only styles', () => {
    // ProseMirror sets inline `style` attributes (table column widths) and injects a <style>; there
    // is no nonce path for attribute styles. The exception stays scoped to styles.
    expect(directives.get('style-src')).toBe("'self' 'unsafe-inline'");
    for (const [name, value] of directives) {
      if (name === 'style-src') continue;
      expect(value).not.toContain('unsafe-inline');
    }
  });

  /**
   * Every directive, not only the four above. `default-src 'none'` back-stops the fetch directives,
   * but `form-action` and `base-uri` do not fall back to it, and `img-src` could be widened to `*`
   * (`surface/src/deferredImage.ts`).
   */
  test('every directive is what it is meant to be, not just the four with their own tests', () => {
    expect(Object.fromEntries(directives)).toEqual({
      'default-src': "'none'",
      'script-src': "'self'",
      'style-src': "'self' 'unsafe-inline'",
      // The trade the renderer defers rather than the policy refusing (`deferredImage.ts`).
      'img-src': "'self' data: blob: https:",
      'font-src': "'self' data:",
      'connect-src': "'none'",
      'media-src': "'none'",
      'object-src': "'none'",
      'frame-src': "'none'",
      'worker-src': "'none'",
      // No fallback to `default-src`: without it, a form in the draft could post anywhere.
      'form-action': "'none'",
      // Nor does this. Without it, an injected <base> retargets every relative URL in the window.
      'base-uri': "'none'",
    });
  });

  test('and the two directives that do not fall back to default-src are present by name', () => {
    // Separate from the table, to name why it must be exhaustive.
    expect(directives.has('form-action')).toBe(true);
    expect(directives.has('base-uri')).toBe(true);
  });
});

/**
 * The target vocabulary is not in the contract: there it would be every destination's merged into
 * one list, a copy nothing holds to `core`. The window's process checks the answer's shape;
 * `parseWireDecision` checks it against the profile it names, `audienceFor` against the one it asks.
 */
describe('the target classification vocabulary', () => {
  test('is not in the contract at all', () => {
    expect('targetClassifications' in contract).toBe(false);
  });

  // The checks themselves run in `rendererBridge.test.ts` (shape) and
  // `cli/test/windowSurface.test.ts` (vocabulary, per destination).
});
