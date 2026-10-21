/**
 * Reading a delta against its grammar (`core/src/patch.ts`), and Linear's grammar against the tool
 * schema it restates.
 */

import { describe, expect, test } from 'bun:test';
import { readPatch, patchWarnings, patchEditPath, type DeltaField } from '../src/patch';
import { profiles } from '../src/profiles';

const [LINEAR] = profiles.linear.deltaFields as readonly DeltaField[];

/**
 * `save_issue`'s `patch.items.oneOf`, read off the live tool schema (`save_document` carries the
 * same list), reduced to what the grammar restates: each operation's `op` constant, its keys, which
 * are required, their types, and `minLength`. If the tool changes, update this from the live schema
 * and the profile with it.
 */
const LIVE_SCHEMA = [
  {
    op: 'replace',
    required: ['op', 'old_string', 'new_string'],
    props: { old_string: ['string', 1], new_string: ['string', 0], replace_all: ['boolean', 0] },
  },
  { op: 'insert_before', required: ['op', 'anchor', 'text'], props: { anchor: ['string', 1], text: ['string', 1] } },
  { op: 'insert_after', required: ['op', 'anchor', 'text'], props: { anchor: ['string', 1], text: ['string', 1] } },
  { op: 'prepend', required: ['op', 'text'], props: { text: ['string', 1] } },
  { op: 'append', required: ['op', 'text'], props: { text: ['string', 1] } },
  {
    op: 'replace_range',
    required: ['op', 'from', 'to', 'new_string'],
    props: { from: ['string', 1], to: ['string', 1], new_string: ['string', 0] },
  },
] as const;
const LIVE_MAX_ITEMS = 50;

describe("Linear's grammar restates the live schema", () => {
  test('the same operations, and nothing more', () => {
    expect(Object.keys(LINEAR!.ops).sort()).toEqual(LIVE_SCHEMA.map((o) => o.op).sort());
    expect(LINEAR!.field).toBe('patch');
    expect(LINEAR!.opKey).toBe('op');
    expect(LINEAR!.maxOps).toBe(LIVE_MAX_ITEMS);
  });

  for (const live of LIVE_SCHEMA) {
    test(`${live.op}: the same keys, required as the schema requires them, empty where it allows`, () => {
      const g = LINEAR!.ops[live.op]!;
      const keys = [g.text, ...g.anchors.map((a) => a.key), ...g.flags.map((f) => f.key)].sort();
      expect(keys).toEqual(Object.keys(live.props).sort());
      const props = live.props as Record<string, readonly [string, number]>;
      // The text is a required string; it may be empty exactly where `minLength` is 0.
      expect(live.required as readonly string[]).toContain(g.text);
      expect(props[g.text]![0]).toBe('string');
      expect(g.empty).toBe(props[g.text]![1] === 0 ? 'deletes' : 'refused');
      // Anchors are required, non-empty strings; flags are optional booleans.
      for (const a of g.anchors) {
        expect(live.required as readonly string[]).toContain(a.key);
        expect(props[a.key]).toEqual(['string', 1]);
      }
      for (const f of g.flags) {
        expect(live.required as readonly string[]).not.toContain(f.key);
        expect(props[f.key]![0]).toBe('boolean');
      }
    });
  }
});

describe('readPatch', () => {
  test('every operation, in order, each with its index, anchors, flags and text, at its write-back path', () => {
    const read = readPatch(LINEAR!, [
      { op: 'replace', old_string: 'a', new_string: 'b', replace_all: true },
      { op: 'replace', old_string: 'c', new_string: 'd', replace_all: false },
      { op: 'prepend', text: 'x' },
    ]);
    if (!read.ok) throw new Error(read.why);
    expect(read.fields.map((e) => [e.edit.index, e.edit.op, e.value])).toEqual([
      [0, 'replace', 'b'],
      [1, 'replace', 'd'],
      [2, 'prepend', 'x'],
    ]);
    expect(read.fields.map((f) => [f.field, f.kind])).toEqual([
      ['patch.0.new_string', 'edit'],
      ['patch.1.new_string', 'edit'],
      ['patch.2.text', 'edit'],
    ]);
    // A flag set to `false` changes nothing, so it is not drawn.
    expect(read.fields.map((e) => e.edit.flags)).toEqual([['every occurrence'], [], []]);
    expect(read.fields[0]!.edit.anchors).toEqual([{ key: 'old_string', label: 'Replaces', value: 'a' }]);
    expect(read.fields[2]!.edit.anchors).toEqual([]);
  });

  test('the text is kept byte for byte, separators and all', () => {
    const text = '\n\n## Rollout\n\nShip on Monday. ';
    const read = readPatch(LINEAR!, [{ op: 'append', text }]);
    expect(read.ok && read.fields[0]!.value).toBe(text);
  });

  test('an operation named after an object method is not an operation', () => {
    // `in` would find `Object.prototype.toString` and read a function as the grammar.
    const read = readPatch(LINEAR!, [{ op: 'toString', text: 'x' }]);
    expect(read).toEqual({ ok: false, why: 'edit 1 has op "toString", which draftgate cannot show' });
  });

  test('a missing op is named as missing', () => {
    expect(readPatch(LINEAR!, [{ text: 'x' }])).toEqual({
      ok: false,
      why: 'edit 1 has op null, which draftgate cannot show',
    });
  });

  test('the first refusal is named by its position, counted from 1', () => {
    const read = readPatch(LINEAR!, [{ op: 'append', text: 'fine' }, { op: 'append', text: 'x', at: 2 }]);
    expect(read).toEqual({ ok: false, why: 'edit 2 (append) carries "at", which draftgate cannot show' });
  });

  test('a carriage return in a text is refused: a text box reports every break as LF', () => {
    // One keystroke would rewrite each CR the reviewer never saw; an anchor is never written back.
    const read = readPatch(LINEAR!, [{ op: 'append', text: 'one\r\ntwo' }]);
    expect(read).toEqual({
      ok: false,
      why: `edit 1 (append) holds a carriage return in "text", which the review's text box cannot keep`,
    });
    expect(readPatch(LINEAR!, [{ op: 'insert_after', anchor: 'a\r\nb', text: 'x' }]).ok).toBe(true);
  });

  test("only the anchor an operation keeps is marked kept: a range's end, never what it replaces", () => {
    const read = readPatch(LINEAR!, [
      { op: 'replace_range', from: '## Old', to: '## Next', new_string: '' },
      { op: 'replace', old_string: 'x', new_string: '' },
    ]);
    if (!read.ok) throw new Error(read.why);
    expect(read.fields.map((e) => e.edit.anchors.map((a) => [a.key, a.kept === true]))).toEqual([
      [['from', false], ['to', true]],
      [['old_string', false]],
    ]);
  });

  test('an anchor of an empty string has nothing to apply at', () => {
    const read = readPatch(LINEAR!, [{ op: 'replace', old_string: '', new_string: 'x' }]);
    expect(read.ok).toBe(false);
  });

  test('the schema maximum is accepted and one more is not', () => {
    const ops = (n: number) => Array.from({ length: n }, () => ({ op: 'append', text: 'x' }));
    expect(readPatch(LINEAR!, ops(LIVE_MAX_ITEMS)).ok).toBe(true);
    expect(readPatch(LINEAR!, ops(LIVE_MAX_ITEMS + 1)).ok).toBe(false);
  });
});

describe('patchWarnings', () => {
  const field = (op: string, index: number, value: string) => {
    const g = LINEAR!.ops[op]!;
    return {
      field: patchEditPath(LINEAR!, index, g.text),
      edit: { index, label: g.label, empty: g.empty },
      value,
    };
  };

  test('an empty insertion blocks, naming its edit; an empty replacement is a deletion', () => {
    const out = patchWarnings([field('replace', 0, ''), field('insert_after', 1, ''), field('append', 2, 'x')]);
    expect(out.map((w) => [w.code, w.field, w.severity])).toEqual([['patch/empty-text', 'patch.1.text', 'error']]);
    expect(out[0]!.message).toContain('Edit 2 (Insert after)');
  });

  test('whitespace is text in an edit: the schema accepts one space', () => {
    expect(patchWarnings([field('append', 0, ' '), field('prepend', 1, '\n')])).toEqual([]);
  });
});
