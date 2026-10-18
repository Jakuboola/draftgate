/**
 * The link button's address validation.
 *
 * Pure, so it is tested here rather than through a window. What makes it worth its own file: this
 * is the one place in the review surface where reviewer input becomes part of the OUTGOING payload
 * without passing through `render()`, which checks structure and destination limits but never
 * inspects an href.
 */

import { describe, expect, test } from 'bun:test';
import { normaliseHref } from './src/href';

describe('what the link button accepts', () => {
  test('an ordinary https address survives', () => {
    expect(normaliseHref('https://example.org/docs')).toBe('https://example.org/docs');
  });

  test('http is allowed -- plenty of internal tooling is not on https', () => {
    expect(normaliseHref('http://jira.internal/browse/X-1')).toBe('http://jira.internal/browse/X-1');
  });

  test('mailto is allowed', () => {
    expect(normaliseHref('mailto:support@example.org')).toBe('mailto:support@example.org');
  });

  test('a bare host gets https, because that is what people paste', () => {
    expect(normaliseHref('example.org')).toBe('https://example.org/');
    expect(normaliseHref('example.org/a/b')).toBe('https://example.org/a/b');
  });

  test('surrounding whitespace is trimmed', () => {
    expect(normaliseHref('  https://example.org  ')).toBe('https://example.org/');
  });

  test('empty or whitespace-only is refused', () => {
    expect(normaliseHref('')).toBeNull();
    expect(normaliseHref('   ')).toBeNull();
  });
});

describe('what it refuses, and why the scheme test comes FIRST', () => {
  // The ordering matters and is easy to get wrong: prefixing `https://` before checking for a
  // scheme would turn `javascript:alert(1)` into `https://javascript:alert(1)` -- a valid URL with
  // an https protocol, which would then PASS the allowlist. The scheme is detected first precisely
  // so these parse as what they are and get refused.
  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    test(`refuses ${hostile.trim().slice(0, 28)}`, () => {
      expect(normaliseHref(hostile)).toBeNull();
    });
  }

  test('the https prefix is never applied to something that already has a scheme', () => {
    // The specific regression the ordering prevents. If this ever returns a string, a
    // `javascript:` href can reach an approved payload.
    // `?? ''` so this reads the STRING it would wrongly return, rather than throwing on the null
    // it correctly returns. If the ordering broke, this is `https://javascript:alert(1)`.
    expect(normaliseHref('javascript:alert(1)') ?? '').not.toContain('https://');
  });

  test('an unparseable address is refused rather than passed through', () => {
    expect(normaliseHref('https://')).toBeNull();
    expect(normaliseHref('http://[')).toBeNull();
  });
});

