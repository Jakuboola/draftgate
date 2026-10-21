/**
 * What the review window accepts as a request. The CLI writes it (`cli/src/surfaces/window.ts`'s
 * `toWireRequest`); the rule lives here in CommonJS so `bun test` can load it and
 * `surface/host/draftgate.m` runs it unchanged in JavaScriptCore.
 *
 * Parsing only: reading the file is each host's business (a module importing `node:fs` could not
 * run in JavaScriptCore), and the contract is passed in, as `sanitiseDecision` takes it. A
 * malformed request is fatal: the host exits non-zero before a window exists, which the CLI reports
 * as `unavailable` naming the exit.
 */

// The one spelling of that predicate.
const { reportableObject } = require('./rendererBridge.cjs');

/** Parse the request's TEXT against the contract. Throws an `Error` naming what is wrong. */
function parseRequest(text, contract) {
  const parsed = JSON.parse(text);
  if (parsed?.protocol !== contract.protocolVersion) {
    throw new Error(
      `request protocol ${parsed?.protocol} is not ${contract.protocolVersion}; rebuild the surface`
    );
  }
  if (typeof parsed.destination !== 'string') {
    throw new Error('request is missing `destination`');
  }
  /*
   * At least one field, and every one a field. `Array.isArray` alone passes `[]`, `["x"]` and
   * entries with no value, each of which would spawn a real window showing a fatal screen. Shape
   * only: which `kind` and `destination` values exist is `core`'s answer, and a second copy of a
   * vocabulary in a file that cannot import one would drift.
   */
  const fields = parsed.fields;
  const shaped =
    Array.isArray(fields) &&
    fields.length > 0 &&
    fields.every(
      (f) =>
        reportableObject(f) &&
        typeof f.field === 'string' &&
        typeof f.kind === 'string' &&
        typeof f.value === 'string'
    );
  if (!shaped) {
    throw new Error('request `fields` is not a non-empty list of {field, kind, value}');
  }
  return parsed;
}

module.exports = { parseRequest };
