/**
 * A delta field: edit operations a destination applies to content only it holds, in place of the
 * whole content. draftgate never calls a destination, so it cannot read what they apply to; what it
 * can show is the operations themselves: for each, the text it applies at and the text it writes.
 *
 * The grammar is a fact about one tool's schema, so it lives in the profile that declares the field
 * (`DestinationProfile.deltaFields`). This module only reads a payload against it, and refuses, with
 * a sentence, anything the grammar does not account for: an operation it does not name, a key an
 * operation does not declare, a value of the wrong type. A key nobody declared is a key no reviewer
 * would see, so it is never skipped.
 */

import { isPlainObject } from './plainObject';
import type { EditFieldValue } from './reviewFields';
import { warn, type Warning } from './warnings';

/** One kind of operation, as the destination's schema spells it. */
export interface PatchOpGrammar {
  /** What the window calls it, in a few words ("Insert before"). */
  readonly label: string;
  /**
   * The text the operation applies at, read-only, in the order the window draws them, each with
   * the words it is drawn under. Every one is required and is a non-empty string. `kept`: the
   * operation leaves this text in place (`replace_range`'s `to`); every other anchor of a replacing
   * operation is what it replaces, so the window strikes it through when the new text is empty.
   */
  readonly anchors: readonly { readonly key: string; readonly label: string; readonly kept?: true }[];
  /** The key holding the text the operation writes: the one value a reviewer edits. Required. */
  readonly text: string;
  /**
   * What an empty `text` does: `deletes` (the match is removed) or `refused` (the schema's
   * `minLength: 1`, so the call is refused before it runs).
   */
  readonly empty: 'deletes' | 'refused';
  /** Optional booleans the operation may carry, each drawn as its label when `true`. */
  readonly flags: readonly { readonly key: string; readonly label: string }[];
  /** What the window must say about this operation beyond its anchors, when something is unseen. */
  readonly note?: string;
}

/** A field that carries edit operations rather than a body. */
export interface DeltaField {
  /** The payload key (`patch`). */
  readonly field: string;
  /** The key naming each operation's kind. */
  readonly opKey: string;
  readonly ops: Readonly<Record<string, PatchOpGrammar>>;
  /** The schema's `maxItems`. */
  readonly maxOps: number;
}

/** One operation as the reviewer is shown it. Serialisable: it crosses the wire. */
export interface PatchEdit {
  /** Its position in the payload's list, from 0: the order the destination applies them in. */
  index: number;
  /** The operation's kind as the payload spells it (`replace`). */
  op: string;
  /** `PatchOpGrammar.label`. */
  label: string;
  anchors: { key: string; label: string; value: string; kept?: true }[];
  /** The labels of the flags set `true`. */
  flags: string[];
  /** The key the text lives at, for the field path (`patchEditPath`). */
  textKey: string;
  empty: PatchOpGrammar['empty'];
  note?: string;
}

/**
 * Every operation as the review field it is shown as, in order: at the path its text is written back
 * to, with the agent's text as its value. Or the first thing that cannot be shown.
 */
export type PatchRead = { ok: true; fields: EditFieldValue[] } | { ok: false; why: string };

/** The path one operation's text is reported under: `patch.3.new_string`. */
export function patchEditPath(delta: Pick<DeltaField, 'field'>, index: number, textKey: string): string {
  return `${delta.field}.${index}.${textKey}`;
}

/**
 * Read a delta field's value against its grammar. Every operation in order, or the first thing
 * that cannot be shown, as a sentence for the denial. Edits are numbered from 1 in the sentence, as
 * the window numbers them.
 */
export function readPatch(delta: DeltaField, value: unknown): PatchRead {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, why: `"${delta.field}" is not a list of edits` };
  }
  if (value.length > delta.maxOps) {
    return {
      ok: false,
      why: `"${delta.field}" carries ${value.length} edits, more than the ${delta.maxOps} the tool accepts`,
    };
  }
  const fields: EditFieldValue[] = [];
  for (const [i, raw] of value.entries()) {
    const n = i + 1;
    if (!isPlainObject(raw)) return { ok: false, why: `edit ${n} is not an object` };
    const kind = raw[delta.opKey];
    // `Object.hasOwn`: a payload's `op: "toString"` must not find the prototype's function.
    if (typeof kind !== 'string' || !Object.hasOwn(delta.ops, kind)) {
      return {
        ok: false,
        why: `edit ${n} has ${delta.opKey} ${JSON.stringify(kind ?? null)}, which draftgate cannot show`,
      };
    }
    const grammar = delta.ops[kind]!;
    const known = new Set([
      delta.opKey, grammar.text, ...grammar.anchors.map((a) => a.key), ...grammar.flags.map((f) => f.key),
    ]);
    const stray = Object.keys(raw).find((k) => !known.has(k));
    if (stray !== undefined) {
      return { ok: false, why: `edit ${n} (${kind}) carries "${stray}", which draftgate cannot show` };
    }
    const anchors: PatchEdit['anchors'] = [];
    for (const a of grammar.anchors) {
      const v = raw[a.key];
      if (typeof v !== 'string' || v === '') {
        return { ok: false, why: `edit ${n} (${kind}) has no text in "${a.key}" to apply at` };
      }
      anchors.push({ key: a.key, label: a.label, value: v, ...(a.kept ? { kept: true as const } : {}) });
    }
    const text = raw[grammar.text];
    if (typeof text !== 'string') {
      return { ok: false, why: `edit ${n} (${kind}) has no "${grammar.text}" string` };
    }
    // A text box reports every line break as LF, so one keystroke anywhere in the text would rewrite
    // each CR the reviewer never saw. Asked about instead.
    if (text.includes('\r')) {
      return {
        ok: false,
        why: `edit ${n} (${kind}) holds a carriage return in "${grammar.text}", which the review's text box cannot keep`,
      };
    }
    const flags: string[] = [];
    for (const f of grammar.flags) {
      if (!Object.hasOwn(raw, f.key)) continue;
      const v = raw[f.key];
      if (typeof v !== 'boolean') {
        return { ok: false, why: `edit ${n} (${kind}) has a "${f.key}" that is not true or false` };
      }
      if (v) flags.push(f.label);
    }
    fields.push({
      field: patchEditPath(delta, i, grammar.text),
      kind: 'edit',
      value: text,
      edit: {
        index: i,
        op: kind,
        label: grammar.label,
        anchors,
        flags,
        textKey: grammar.text,
        empty: grammar.empty,
        ...(grammar.note === undefined ? {} : { note: grammar.note }),
      },
    });
  }
  return { ok: true, fields };
}

/**
 * What blocks an edit as it stands: a text the tool refuses when empty (`PatchOpGrammar.empty`).
 * `field` is the edit's path, as `prose/empty` names a line. Whitespace is text here, unlike in a
 * body: `" "` is a real insertion and the schema's `minLength: 1` accepts it.
 */
export function patchWarnings(
  edits: readonly { field: string; edit: Pick<PatchEdit, 'index' | 'empty' | 'label'>; value: string }[]
): Warning[] {
  return edits.flatMap((e) =>
    e.edit.empty === 'refused' && e.value === ''
      ? [
          warn({
            code: 'patch/empty-text',
            severity: 'error',
            field: e.field,
            message:
              `Edit ${e.edit.index + 1} (${e.edit.label}) inserts nothing, and the tool refuses an empty ` +
              'insertion, so the whole call would fail. Give it text, or reject.',
          }),
        ]
      : []
  );
}
