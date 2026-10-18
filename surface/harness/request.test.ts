/**
 * `surface/request.cjs`: what a review window accepts as a request, executed.
 *
 * The host loads this one file into JavaScriptCore rather than restating it, so the rules are
 * tested here once, and `host.test.ts` holds `surface/host/draftgate.m` to LOADING it rather than
 * to a copy.
 */

import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SURFACE } from './shared';
import contract from '../contract.json';

const { parseRequest } = createRequire(import.meta.url)(join(SURFACE, 'request.cjs')) as {
  parseRequest(text: string, contract: { protocolVersion: number }): { destination: string };
};

const FIELD = { field: 'body', kind: 'markdown', value: 'Hello' };
const request = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ protocol: contract.protocolVersion, destination: 'jira', fields: [FIELD], ...over });

describe('parseRequest', () => {
  test('a well-formed request comes back as parsed', () => {
    expect(parseRequest(request(), contract)).toEqual(JSON.parse(request()));
  });

  test('another protocol is refused, naming both numbers and the remedy', () => {
    expect(() => parseRequest(request({ protocol: contract.protocolVersion - 1 }), contract)).toThrow(
      `request protocol ${contract.protocolVersion - 1} is not ${contract.protocolVersion}; rebuild the surface`
    );
  });

  test('a missing destination is refused', () => {
    expect(() => parseRequest(request({ destination: 7 }), contract)).toThrow('request is missing `destination`');
  });

  test('text that is not JSON throws, and so is fatal', () => {
    expect(() => parseRequest('{', contract)).toThrow();
    expect(() => parseRequest('null', contract)).toThrow('request protocol undefined');
  });

  /*
   * Each of these separates "is an array" from this check: a request with nothing to show, refused
   * before any window exists.
   */
  test.each([
    ['no fields at all', undefined],
    ['an empty list', []],
    ['a bare string', ['x']],
    ['null', [null]],
    ['an array entry', [[FIELD]]],
    ['an entry with no value', [{ field: 'body', kind: 'markdown' }]],
    ['a non-string kind', [{ ...FIELD, kind: 1 }]],
    ['a non-string field', [{ ...FIELD, field: null }]],
    ['one good entry beside a bad one', [FIELD, { field: 'x' }]],
  ])('fields as %s are refused', (_name, fields) => {
    expect(() => parseRequest(request({ fields }), contract)).toThrow(
      'request `fields` is not a non-empty list of {field, kind, value}'
    );
  });
});
