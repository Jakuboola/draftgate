/**
 * The two ends of the decision wire carry the same fields.
 *
 * A decision is rebuilt by two allow-lists: `sanitiseDecision` in the window's process (CommonJS the
 * host runs in JavaScriptCore) and `parseWireDecision` in the CLI. They cannot share code, so this
 * table holds them together, as `contract.test.ts` holds the contract's caps. A field forgotten in one
 * passes every unit test of the other end (`cli/test/windowSurface.test.ts` covers only the CLI).
 * `cli/src/surfaces/window.ts` destructures `protocol` off, so there is no third rebuild.
 */

import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SURFACE } from './shared';
import contract from '../contract.json';
import {
  parseWireDecision, MAX_DECISION_FIELDS, type HumanDecision,
} from '../../cli/src/surfaces/windowProtocol';

/** Every key of every member of a union; `keyof` alone gives only the shared ones. */
type KeysOf<T> = T extends unknown ? keyof T : never;

const require_ = createRequire(import.meta.url);
const bridge = require_(join(SURFACE, 'rendererBridge.cjs')) as {
  sanitiseDecision(raw: unknown, contract: typeof import('../contract.json')): unknown;
};

/**
 * One decision per shape the window can submit, carrying every optional field it may set. `fields`
 * and `reason` belong to different actions, so both actions appear.
 */
const SUBMITTED: { what: string; raw: Record<string, unknown>; expect: HumanDecision }[] = [
  {
    what: 'an approval with everything on it',
    raw: {
      action: 'approve',
      edited: true,
      bodyEdited: true,
      silenced: ['jira/task-item-media-only'],
      fixes: [{ code: 'jira/blockquote-child-rejected', label: 'Suggested fix' }],
      // Every field the reviewer was shown, body included: the only thing holding `sanitiseFields`
      // and `parseFields` together.
      fields: { commentBody: 'edited text', 'fields.summary': 'a title the reviewer rewrote' },
      // The pair: a value alone is a shape neither end carries.
      classifyProject: { destination: 'jira', value: 'service_desk' },
      // The theme the reviewer chose in this window.
      theme: 'dark',
    },
    expect: {
      action: 'approve',
      edited: true,
      bodyEdited: true,
      silenced: ['jira/task-item-media-only'],
      fixes: [{ code: 'jira/blockquote-child-rejected', label: 'Suggested fix' }],
      fields: { commentBody: 'edited text', 'fields.summary': 'a title the reviewer rewrote' },
      classifyProject: { destination: 'jira', value: 'service_desk' },
      theme: 'dark',
    },
  },
  {
    what: 'an approval nobody edited, reporting no repairs and no rewrite',
    // `edited: false` and `silenced: []` are claims and must survive as themselves: `undefined`
    // means "this surface does not report", and for `edited` the CLI would then compare bodies.
    raw: {
      action: 'approve', fields: { commentBody: 'shown text' }, edited: false, bodyEdited: false, silenced: [], fixes: [],
    },
    expect: {
      action: 'approve', fields: { commentBody: 'shown text' }, edited: false, bodyEdited: false, silenced: [], fixes: [],
    },
  },
  {
    what: 'a title-only edit: edited, the body not, and neither end may copy one into the other',
    raw: { action: 'approve', fields: { title: 'new title', body: 'shown' }, edited: true, bodyEdited: false, fixes: [] },
    expect: { action: 'approve', fields: { title: 'new title', body: 'shown' }, edited: true, bodyEdited: false, fixes: [] },
  },
  {
    what: 'a surface that reports neither distinction, which must stay UNKNOWN on both',
    raw: { action: 'approve' },
    expect: { action: 'approve' },
  },
  {
    what: 'a rejection with everything on it',
    raw: {
      action: 'reject',
      reason: 'not yet',
      classifyProject: { destination: 'github', value: 'private' },
      // A different theme again, so neither end can be hard-coding one value.
      theme: 'system',
    },
    // A different destination from the approval row: both ends validate against the profile the
    // answer names, so Jira-only rows could not see either end hard-coding one.
    expect: {
      action: 'reject',
      reason: 'not yet',
      classifyProject: { destination: 'github', value: 'private' },
      theme: 'system',
    },
  },
  {
    what: 'a bare rejection',
    raw: { action: 'reject' },
    expect: { action: 'reject' },
  },
];

describe('every field survives both rebuilds', () => {
  test.each(SUBMITTED)('$what', ({ raw, expect: want }) => {
    // The window's process decides which fields exist at all...
    const written = bridge.sanitiseDecision(raw, contract);
    expect(written, 'sanitiseDecision refused a decision the window can submit').not.toBeNull();

    // ...and the CLI re-validates what it reads back, through JSON as on disk.
    const read = parseWireDecision(JSON.parse(JSON.stringify(written)));
    expect(read, 'parseWireDecision refused what sanitiseDecision wrote').not.toBeNull();

    const { protocol: _p, ...human } = read!;
    expect(
      human,
      'a field the window submitted did not survive both rebuilds -- see the header'
    ).toEqual(want);
  });

  test('too MANY fields REFUSES, and is not quietly truncated by either end', () => {
    /*
     * The bridge runs first. Had it dropped an over-cap entry while the CLI refused the decision,
     * the CLI would never see one to refuse: a rewritten title is dropped and the agent's goes out
     * under the approval, with `edited: true`. The count only; the per-value length cap is
     * `cli/src/review.ts`'s, where the field kinds are known (`cli/test/review.test.ts`).
     */
    const many = Object.fromEntries(
      Array.from({ length: MAX_DECISION_FIELDS + 1 }, (_, i) => [`f${i}`, 'value'])
    );
    const written = bridge.sanitiseDecision({ action: 'approve', edited: true, fields: many }, contract);
    // The bridge passes them all: it decides which fields may exist. `Object.keys`, not
    // `toHaveProperty`, which reads a dot as a path.
    const passed = (written as { fields?: Record<string, string> }).fields ?? {};
    expect(Object.keys(passed).length).toBe(MAX_DECISION_FIELDS + 1);
    // And the CLI refuses the whole decision, which reads as `unavailable` and asks.
    expect(parseWireDecision(JSON.parse(JSON.stringify(written)))).toBeNull();
  });

  test('an unusable ENTRY drops the whole key, so the CLI sees silence rather than a short map', () => {
    /*
     * The same disagreement, one condition over. A bridge that skipped a bad entry would hand the
     * CLI a short map, and the CLI would fall back to the value it showed for the missing field: a
     * rewritten title goes out as the agent wrote it. Dropping the whole key instead makes the CLI
     * read a surface that reported nothing, and `staleSurfaceDenial` fires.
     */
    for (const bad of [
      { good: 'x', bad: 123 },
      { good: 'x', bad: null },
      { good: 'x', '': 'unaddressable' },
      { bad: 123 },
    ]) {
      const written = bridge.sanitiseDecision(
        { action: 'approve', edited: true, fields: bad },
        contract
      ) as Record<string, unknown>;
      // The approval survives: a bad value does not withdraw it.
      expect(written.action).toBe('approve');
      // But it carries no field values, which is what the CLI denies as a stale build.
      expect('fields' in written, `sanitiseFields kept a short map for ${JSON.stringify(bad)}`).toBe(false);
      // And the CLI reads no map, not one it would half-apply.
      const read = parseWireDecision(JSON.parse(JSON.stringify(written)))!;
      expect(read.action === 'approve' && read.fields).toBeUndefined();
    }
  });

  /**
   * The keys as a set: a field both ends drop leaves every row above green. `declared` is typed
   * against `HumanDecision` both ways, so a key missing here or not on the type fails typecheck.
   */
  test('and the keys that arrive are the keys the type declares', () => {
    const declared = [
      'action', 'edited', 'bodyEdited', 'silenced', 'fixes', 'fields', 'reason', 'classifyProject', 'theme',
    ] as const satisfies readonly KeysOf<HumanDecision>[];
    // Type-only: `bun run typecheck` fails here, `bun test` cannot.
    const everyKeyDeclared: [Exclude<KeysOf<HumanDecision>, (typeof declared)[number]>] extends [never] ? true : never = true;
    void everyKeyDeclared;
    const arrived = new Set<string>();
    for (const { raw } of SUBMITTED) {
      const written = bridge.sanitiseDecision(raw, contract);
      const read = parseWireDecision(JSON.parse(JSON.stringify(written)))!;
      for (const key of Object.keys(read)) if (key !== 'protocol') arrived.add(key);
    }
    expect(
      [...arrived].sort(),
      'a key on HumanDecision reaches neither end; the table above needs a case for it'
    ).toEqual([...declared].sort());
  });
});

describe('and neither end forwards what the renderer invents', () => {
  test('an unknown field is dropped', () => {
    const written = bridge.sanitiseDecision(
      { action: 'approve', somethingNew: 'nope', __proto__: { polluted: true } },
      contract
    ) as Record<string, unknown>;
    expect('somethingNew' in written).toBe(false);
    expect('polluted' in written).toBe(false);
  });

  test('an unrecognised action writes nothing at all', () => {
    // The host's `writeDecision` turns `null` into no file, which reads as a rejection.
    for (const action of ['send', '', undefined, null, 42]) {
      expect(bridge.sanitiseDecision({ action }, contract)).toBeNull();
    }
  });

  test('and a malformed metadata field never withdraws the decision', () => {
    // `action` and the body are the decision; `fixes`, `classifyProject` and `theme` are metadata,
    // and a bad one does not withdraw it.
    const written = bridge.sanitiseDecision(
      { action: 'approve', fixes: 'not an array', classifyProject: 'SERVICE_DESK', theme: 42 },
      contract
    ) as Record<string, unknown>;
    expect(written.action).toBe('approve');
    expect('fixes' in written).toBe(false);
    expect('classifyProject' in written).toBe(false);
    expect('theme' in written).toBe(false);
    // A string that is no theme passes the bridge (shape only) and the CLI, which holds the
    // vocabulary, drops it.
    const read = parseWireDecision(JSON.parse(JSON.stringify(bridge.sanitiseDecision({ action: 'approve', theme: 'sepia' }, contract))));
    expect(read?.action).toBe('approve');
    expect(read && 'theme' in read).toBe(false);
  });
});
