/**
 * What the review window will WRITE as a decision, built from what the page said. Its own CommonJS
 * file so `bun test` can fail it and the host can `require` it in JavaScriptCore with no bundler: a
 * rule inside the host could only be checked as source TEXT, and a check that the host contains
 * `CONTRACT.maxAppliedFixes` is satisfied by `Number(64); // was CONTRACT.maxAppliedFixes`.
 *
 * This module owns the allow-list and the caps; the host supplies the contract they come from and
 * does everything with a side effect. That only the top-level frame may ask for the draft or decide
 * is the host's rule (`surface/host/draftgate.m`, checked by `surface:host` with a subframe).
 */

/** One field the renderer may report: a non-empty string within the caller's cap. */
function reportableString(v, maxFieldLength) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxFieldLength;
}

/**
 * A plain object the renderer may report. Twin of `cli/src/json.ts`'s `isPlainObject`, written
 * once for every sanitiser here (`decisionFields.test.ts` holds this file to its CLI twin by field
 * parity, not two guards in here against each other).
 */
function reportableObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The three-state list rule: absent, `[]`, or what was reported. `keep` validates one entry and
 * returns what to keep, or `undefined` to drop it. A non-empty input yielding nothing valid gives
 * `undefined`, never `[]`: `[]` is the positive claim "this window reports and there was nothing
 * to report", so a drifted renderer shape would log every clicked repair as a hand rewrite.
 * Twin of `reportedList` in `cli/src/surfaces/windowProtocol.ts` (CommonJS, so no shared code);
 * `decisionFields.test.ts` holds the pair.
 */
function reportedList(raw, max, keep) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const v of raw.slice(0, max)) {
    const kept = keep(v);
    if (kept !== undefined) out.push(kept);
  }
  return out.length === 0 && raw.length > 0 ? undefined : out;
}

/**
 * The accepted repairs the decision log records. The caps are the CALLER's (`sanitiseDecision`
 * passes the contract's `maxAppliedFixes` and `maxFixFieldLength`): truncation happens here, before
 * `windowProtocol.ts` sees the array, so a cap left as a literal would cut accepted repairs to the
 * old limit while every unit test passed. Degradation is `reportedList`'s, and must happen here:
 * `parseAppliedFixes`'s matching rule cannot fire on a `[]` this function wrote.
 */
function sanitiseFixes(raw, maxFixes, maxFieldLength) {
  const ok = (v) => reportableString(v, maxFieldLength);
  return reportedList(raw, maxFixes, (f) =>
    reportableObject(f) && ok(f.code) && ok(f.label)
      ? { code: f.code, label: f.label }
      : undefined
  );
}

/**
 * The warning codes the round trip silenced, with `sanitiseFixes`'s caps (both bound how much the
 * renderer may write into a decision file). `[]` is the claim "draftgate silenced nothing", and one
 * of these codes means a checkbox was destroyed, so a drifted shape must read as unknown.
 */
function sanitiseSilenced(raw, maxCodes, maxFieldLength) {
  return reportedList(raw, maxCodes, (c) => (reportableString(c, maxFieldLength) ? c : undefined));
}

/**
 * The target classification the renderer reports: its shape, not its meaning. It is written to disk
 * and read back on every later review. Membership is not checked because this process does not know
 * the destination, so only a merged vocabulary of all of them is available. `parseWireDecision`
 * validates against the profile the answer names, and `audienceFor` does so before any profile is
 * asked. Two string fields, capped (by `maxFixFieldLength`, so moving the fix cap moves this one),
 * every other key dropped. Malformed gives `undefined`, never a reason to discard an approval.
 */
function sanitiseClassification(raw, maxFieldLength) {
  if (!reportableObject(raw)) return undefined;
  const destination = raw.destination;
  const value = raw.value;
  if (!reportableString(destination, maxFieldLength)) return undefined;
  if (!reportableString(value, maxFieldLength)) return undefined;
  // Rebuilt, so a renderer cannot smuggle a third key through.
  return { destination, value };
}

/**
 * The field values the renderer reports: which fields may exist, and nothing else. Twin of
 * `parseFields` in `cli/src/surfaces/windowProtocol.ts`; `surface/harness/decisionFields.test.ts`
 * puts one table through both.
 *
 * The cap is not enforced here. This runs first, so an over-cap entry dropped here is gone before
 * the CLI looks, and the agent's title would be sent under a human's approval with `edited: true`.
 * Refusing here is worse: the host writes no file for a null, and an absent file reads as a
 * rejection. The cap lives in `cli/src/review.ts`, the only layer that knows which entries are
 * lines.
 *
 * An unusable entry drops the whole key (not a `continue`): `parseFields` would never see an entry
 * to refuse, and the fallback to the shown value would send the agent's text. `undefined` still
 * writes the decision file, and the CLI answers `staleSurfaceDenial`.
 */
function sanitiseFields(raw) {
  if (!reportableObject(raw)) return undefined;
  const out = {};
  for (const [field, value] of Object.entries(raw)) {
    if (typeof field !== 'string' || field === '') return undefined;
    if (typeof value !== 'string') return undefined;
    out[field] = value;
  }
  return out;
}

/**
 * The whole decision this process will write, built from what the renderer said. An allow-list: a
 * field draftgate adds must be added here too, and `surface/harness/decisionFields.test.ts` (one
 * table through this and `parseWireDecision`) fails if it is forgotten. `null` for anything
 * unrecognised, which the host writes as nothing: an absent decision file reads as a rejection.
 */
function sanitiseDecision(raw, contract) {
  if (raw?.action !== 'approve' && raw?.action !== 'reject') return null;

  const out = { protocol: contract.protocolVersion, action: raw.action };

  if (raw.action === 'approve') {
    // Did a human change the draft, as opposed to the editor normalising it on load? The body does
    // not answer it (loading rewrites a bare URL into a link). Only a real boolean is forwarded;
    // absence means the surface does not report it and the CLI compares the body. See `HumanDecision`.
    if (typeof raw.edited === 'boolean') out.edited = raw.edited;
    // The same, for the body alone (`edited` counts a changed line too).
    if (typeof raw.bodyEdited === 'boolean') out.bodyEdited = raw.bodyEdited;
    // Codes silenced in the agent's draft. Key stays off unless reportable (`[]` claims "nothing").
    const silenced = sanitiseSilenced(raw.silenced, contract.maxAppliedFixes, contract.maxFixFieldLength);
    if (silenced !== undefined) out.silenced = silenced;
    // Offered repairs the reviewer accepted. Key stays off unless reportable: its absence tells the
    // CLI the window does not report repairs, and `[]` would claim none were accepted.
    const fixes = sanitiseFixes(raw.fixes, contract.maxAppliedFixes, contract.maxFixFieldLength);
    if (fixes !== undefined) out.fixes = fixes;
    // Every shown field's value by path (protocol 5). Stricter than `fixes` and `silenced`: one
    // dropped field sends the shown value in place of the reviewer's rewrite. `{}` claims nothing
    // and `cli/src/review.ts` denies it.
    const fields = sanitiseFields(raw.fields);
    if (fields !== undefined) out.fields = fields;
  } else if (typeof raw.reason === 'string' && raw.reason.trim()) {
    out.reason = raw.reason.trim();
  }

  // The reviewer's word about the target, on either outcome. Shape only; the CLI checks the value.
  const classified = sanitiseClassification(raw.classifyProject, contract.maxFixFieldLength);
  if (classified !== undefined) out.classifyProject = classified;

  // The theme chosen in this window, either outcome (protocol 6). Shape only: `parseWireDecision`
  // asks `core` which strings are themes.
  if (reportableString(raw.theme, contract.maxFixFieldLength)) out.theme = raw.theme;

  return out;
}

module.exports = {
  reportableObject,
  sanitiseFields,
  sanitiseFixes,
  sanitiseSilenced,
  sanitiseClassification,
  sanitiseDecision,
};
