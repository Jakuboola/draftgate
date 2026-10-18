/**
 * A list item keeps its own kind through the round trip, same-level and nested. Same-level kinds
 * are kept by the parser's run-break, nested ones by `ListBlock.listKind`; without it `- a` /
 * `  - [ ] b` sends `- a` / `  - b`. Probed (`adfSchema.ts`, `TASK_LIST_CHILDREN`): `listItem >
 * taskList` 201, `taskList > taskList` too.
 *
 * Without the run-break `listToAdf` retypes a mixed run, worst a plain bullet into an unchecked
 * to-do. The damage is on the way in, so the round trip is self-consistent and no warning fires:
 * these tests assert the converted tree as well as the round trip.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { baselineFor } from '../src/editor';
import type { DestinationName } from '../src/profiles';
import type { AdfDocument, AdfNode } from '../src/adf/types';
import { orphanedTaskLists } from '../src/adfSchema';

const DESTINATIONS = ['jira', 'slack', 'linear'] as const;

/** The list nodes of a Jira render, as `type` plus the item types inside. */
const listShape = (body: string) =>
  ((render(body, 'jira').converted as { content: AdfNode[] }).content ?? []).map((n) => ({
    type: n.type,
    items: (n.content ?? []).map((i) => i.type),
  }));

/** The body an approval would send, for one destination. */
const sent = (body: string, dest: DestinationName = 'jira') => baselineFor(render(body, dest)).body;

/** Does what an approval sends, sent again, come back as itself? Module scope: two describes use it. */
const fixedPointOf = (body: string, dest: DestinationName) =>
  sent(sent(body, dest), dest) === sent(body, dest);

/** The converted Jira tree as nested `type[child,child]` strings. Module scope: two describes use it. */
const jiraShapeOf = (body: string) =>
  ((render(body, 'jira').converted as { content: AdfNode[] }).content ?? []).map(function shape(n): string {
    const kids = (n.content ?? []).filter((c) => c.type !== 'text');
    return kids.length ? `${n.type}[${kids.map(shape).join(',')}]` : n.type;
  });

describe('a heterogeneous run becomes two lists, not one retyped list', () => {
  // Each row is a corruption a merged run produces; the last column is the damage.
  const CORRUPTED: [string, string, string][] = [
    ['bullet then task', '- a\n- [ ] b\n', 'a bullet became an unchecked to-do'],
    ['task then bullet', '- [ ] b\n- a\n', 'a bullet became an unchecked to-do'],
    ['two bullets then task', '- a\n- b\n- [ ] c\n', 'both bullets became to-dos'],
    ['ordered then task', '1. a\n- [ ] b\n', 'numbering destroyed, both became to-dos'],
    ['ordered then bullet', '1. a\n- b\n', 'a bullet gained a number it never had'],
    ['bullet then ordered', '- a\n1. b\n', 'an ordered item lost its number'],
    ['task in the middle', '- [ ] a\n- b\n- [x] c\n', 'the middle bullet became a to-do'],
  ];

  test.each(CORRUPTED)('%s: no item is retyped (%#)', (_label, body) => {
    // On the converted tree: every list node holds only its own item type, which a merged run breaks.
    const ALLOWED: Record<string, string> = {
      taskList: 'taskItem',
      bulletList: 'listItem',
      orderedList: 'listItem',
    };
    const shape = listShape(body);
    expect(shape.length, `${body}: expected more than one list node`).toBeGreaterThan(1);
    for (const node of shape) {
      const want = ALLOWED[node.type!];
      expect(want, `unexpected node type ${node.type}`).toBeDefined();
      for (const item of node.items) expect(item, `${node.type} holds ${item}`).toBe(want);
    }
  });

  // The two markers whose count must survive: a checkbox, and an ordered marker.
  const MARKERS: [string, RegExp][] = [
    ['checkbox', /^\s*- \[[ xX]\]/gm],
    ['ordered marker', /^\s*\d+\./gm],
  ];

  test.each(CORRUPTED)('%s: every marker count survives (%#)', (_label, body) => {
    for (const [what, re] of MARKERS) {
      const before = (body.match(re) ?? []).length;
      for (const dest of DESTINATIONS) {
        const after = (sent(body, dest).match(re) ?? []).length;
        expect(after, `${dest} ${what}: ${JSON.stringify(body)}`).toBe(before);
      }
    }
  });

  test.each(CORRUPTED)('%s: and the result is a FIXED POINT (%#)', (_label, body) => {
    // The lists go out separated by a blank line, which parses as two blocks too, so it converges.
    // A second pass that moved the body would rewrite the draft per keystroke.
    for (const dest of DESTINATIONS) {
      const once = sent(body, dest);
      expect(sent(once, dest), `${dest}: ${JSON.stringify(body)}`).toBe(once);
    }
  });
});

describe('the task predicate is ONE predicate, not two that must agree', () => {
  /*
   * The run-break and the per-item parse read a task marker with one `TASK_ITEM_RE`. A run-break
   * requiring whitespace after `]` beside a per-item `\s*` parse makes `- [x]` / `- a` / `- b` send
   * `- [ ] a` / `- [ ] b` to Jira: the break never fires.
   */
  const MARKER_ONLY: [string, string][] = [
    ['a checked marker with no text at all', '- [x]\n- a\n- b\n'],
    ['an unchecked marker with no text', '- [ ]\n- a\n'],
    ['no space between marker and text', '- [ ]done\n- a\n'],
    ['an ordered marker-only task', '1. [ ]\n1. a\n'],
  ];

  // Task items under any marker: ADF's `taskList` has no ordering, so `1. [ ]` comes out `- [ ]`.
  const taskItems = (md: string) => (md.match(/^\s*(?:[-*+]|\d+\.)\s*\[[ xX]\]/gm) ?? []).length;

  test.each(MARKER_ONLY)('%s: no plain item gains a checkbox', (_l, body) => {
    for (const dest of DESTINATIONS) {
      const out = sent(body, dest);
      // `<=`: a text-less task item can be dropped on Jira, a separate known loss. Never up.
      expect(
        taskItems(out),
        `${dest}: ${JSON.stringify(body)} -> ${JSON.stringify(out)}`
      ).toBeLessThanOrEqual(taskItems(body));
    }
  });

  test.each(MARKER_ONLY)('%s: the plain text survives (%#)', (_l, body) => {
    // Whatever the degenerate first item does, the ordinary items after it arrive.
    for (const dest of DESTINATIONS) expect(sent(body, dest), dest).toContain('a');
  });
});

describe('breaking a run must not DROP a nested item', () => {
  /*
   * A nested run of mixed kinds comes back from `parseListItems` in halves, which the caller must
   * append; an overwrite (`parent.children = nested.items`) keeps only the second:
   *
   *   - a                 sent   - a
   *     - b          ->            - c        `b` gone entirely
   *     - [ ] c
   *
   * Asserted on content; the nested shape is in the `nesting keeps every kind` describe.
   */
  const NESTED: { label: string; body: string; words: string[] }[] = [
    { label: 'mixed kinds nested under one parent', body: '- a\n  - b\n  - [ ] c\n', words: ['a', 'b', 'c'] },
    { label: 'task first, then a plain sibling', body: '- a\n  - [ ] b\n  - c\n', words: ['a', 'b', 'c'] },
    { label: 'ordered nested among bullets', body: '- a\n  - b\n  1. c\n', words: ['a', 'b', 'c'] },
    { label: 'three nested halves', body: '- a\n  - b\n  - [ ] c\n  - d\n', words: ['a', 'b', 'c', 'd'] },
    { label: 'a nested run then a sibling', body: '- a\n  - b\n  - [ ] c\n- d\n', words: ['a', 'b', 'c', 'd'] },
  ];

  test.each(NESTED)('$label: every item survives', ({ body, words }) => {
    for (const dest of DESTINATIONS) {
      const out = sent(body, dest);
      for (const w of words) {
        expect(
          out,
          `${dest}: ${JSON.stringify(body)} -> ${JSON.stringify(out)} lost "${w}"`
        ).toContain(w);
      }
    }
  });

  test('and the top-level count is unchanged by a nested run breaking', () => {
    // An overwrite also changes how many items the parent has; a line count catches it.
    for (const dest of DESTINATIONS) {
      const out = sent('- a\n  - b\n  - [ ] c\n', dest);
      expect(out.split('\n').filter((l) => l.trim() !== '').length, dest).toBe(3);
    }
  });
});

describe('a homogeneous run is untouched, so the run-break does not over-fire', () => {
  const CLEAN = [
    ['bullets', '- a\n- b\n- c\n'],
    ['ordered', '1. a\n2. b\n'],
    ['tasks, mixed checked state', '- [ ] a\n- [x] b\n'],
    ['a single bullet', '- a\n'],
    ['a single task', '- [x] a\n'],
    ['nested bullets', '- a\n  - b\n  - c\n- d\n'],
    ['already separated by a blank line', '- a\n\n- [ ] b\n'],
  ] as const;

  test.each(CLEAN)('%s round-trips byte-identically on every destination', (_label, body) => {
    for (const dest of DESTINATIONS) expect(sent(body, dest), dest).toBe(body);
  });

  test('a checked and an unchecked item stay ONE list -- state is not kind', () => {
    // They differ in `checked`'s value, not in whether it is set: one kind, one `taskList`.
    expect(listShape('- [ ] a\n- [x] b\n')).toEqual([
      { type: 'taskList', items: ['taskItem', 'taskItem'] },
    ]);
  });

  test('a `*` and a `-` bullet are the same kind', () => {
    // CommonMark starts a new list on a marker change; ADF has one bullet list either way.
    expect(listShape('* a\n- b\n')).toEqual([{ type: 'bulletList', items: ['listItem', 'listItem'] }]);
  });

  test('an ordered list keeps its start number', () => {
    // `listToAdf` carries `start` only from the first item, so a split run must not lose it.
    const shape = render('3. c\n4. d\n', 'jira').converted as { content: AdfNode[] };
    expect(shape.content[0]?.attrs?.order).toBe(3);
  });
});

describe('the split preserves the ordered start of the SECOND list too', () => {
  test('a bullet then an ordered run starting at 5', () => {
    // The second block takes `start` from its own first item, not 1.
    const doc = render('- a\n5. e\n6. f\n', 'jira').converted as { content: AdfNode[] };
    expect(doc.content.map((n) => n.type)).toEqual(['bulletList', 'orderedList']);
    expect(doc.content[1]?.attrs?.order).toBe(5);
    expect(sent('- a\n5. e\n6. f\n')).toBe('- a\n\n5. e\n6. f\n');
  });
});

describe('nesting keeps every kind, where ADF can carry it', () => {
  /*
   * Probed (`adfSchema.ts`, `TASK_LIST_CHILDREN`): `listItem > taskList` 201, `taskList > taskList`
   * 201, `taskList > bulletList` 400. So:
   *   - a checklist under a bullet item is carried as written, everywhere;
   *   - a checklist under a checklist item too: a sibling `taskList` in ADF, `taskItem > [paragraph,
   *     taskList]` in the editor;
   *   - a bullet under a checklist item is un-nested for Jira (kind and order kept, disclosed by
   *     `jira/task-item-nested-list-unnested`) and sent as written to Slack and Linear.
   * Every row is a fixed point per destination.
   */
  const jiraShape = (body: string) =>
    ((render(body, 'jira').converted as { content: AdfNode[] }).content ?? []).map(function shape(n): string {
      const kids = (n.content ?? []).filter((c) => c.type !== 'text');
      return kids.length ? `${n.type}[${kids.map(shape).join(',')}]` : n.type;
    });
  const fixedPoint = (body: string, dest: DestinationName) => sent(sent(body, dest), dest) === sent(body, dest);

  test('a checklist under a bullet keeps its checkbox, on every destination', () => {
    const body = '- a\n  - [ ] b\n';
    for (const dest of DESTINATIONS) {
      expect(sent(body, dest), dest).toBe(body);
      expect(fixedPoint(body, dest), dest).toBe(true);
    }
    expect(jiraShape(body)).toEqual(['bulletList[listItem[paragraph,taskList[taskItem]]]']);
    // And under a numbered item, with a checked one in the run.
    const numbered = '1. a\n   - [ ] b\n   - [x] c\n';
    for (const dest of DESTINATIONS) expect(sent(numbered, dest), dest).toBe(numbered);
    expect(jiraShape(numbered)).toEqual(['orderedList[listItem[paragraph,taskList[taskItem,taskItem]]]']);
  });

  test('a checklist under a checklist nests, as a sibling taskList in ADF', () => {
    const body = '- [ ] a\n  - [ ] b\n';
    for (const dest of DESTINATIONS) {
      expect(sent(body, dest), dest).toBe(body);
      expect(fixedPoint(body, dest), dest).toBe(true);
    }
    expect(jiraShape(body)).toEqual(['taskList[taskItem,taskList[taskItem]]']);
    expect(render(body, 'jira').warnings).toEqual([]);
  });

  test('a bullet under a checklist is un-nested for Jira, disclosed, and a fixed point', () => {
    const body = '- [ ] a\n  - b\n- [ ] c\n';
    const r = render(body, 'jira');
    expect(sent(body, 'jira')).toBe('- [ ] a\n\n- b\n\n- [ ] c\n');
    expect(fixedPoint(body, 'jira')).toBe(true);
    expect(jiraShape(body)).toEqual(['taskList[taskItem]', 'bulletList[listItem[paragraph]]', 'taskList[taskItem]']);
    expect(r.warnings.map((w) => w.code)).toEqual(['jira/task-item-nested-list-unnested']);
    expect(r.blocked).toBe(false);
    // Never an empty checklist left behind: `EMPTY_FORBIDDEN` is a probed 400.
    for (const n of (r.converted as { content: AdfNode[] }).content) {
      if (n.type === 'taskList') expect(n.content?.length).toBeGreaterThan(0);
    }
  });

  test('...and kept exactly as written for the two destinations that receive markdown', () => {
    const body = '- [ ] a\n  - b\n- [ ] c\n';
    for (const dest of ['slack', 'linear'] as const) {
      expect(sent(body, dest), dest).toBe(body);
      expect(fixedPoint(body, dest), dest).toBe(true);
      expect(render(body, dest).warnings.map((w) => w.code), dest).toEqual([]);
    }
  });

  test('a bullet two checklists deep is lifted out of BOTH, for Jira', () => {
    const body = '- [ ] a\n  - [ ] b\n    - c\n';
    expect(sent(body, 'jira')).toBe('- [ ] a\n  - [ ] b\n\n- c\n');
    expect(fixedPoint(body, 'jira')).toBe(true);
    expect(jiraShape(body)).toEqual(['taskList[taskItem,taskList[taskItem]]', 'bulletList[listItem[paragraph]]']);
    // The tree Jira receives must never carry the rejected shape.
    expect(render(body, 'jira').warnings.map((w) => w.code)).toEqual(['jira/task-item-nested-list-unnested']);
    for (const dest of ['slack', 'linear'] as const) expect(sent(body, dest), dest).toBe(body);
  });

  test('mixed nested kinds under one bullet keep every kind, in order', () => {
    // The case an overwrite drops `b` from: two blocks, each its own kind.
    const body = '- a\n  - b\n  - [ ] c\n';
    for (const dest of DESTINATIONS) expect(sent(body, dest), dest).toBe(body);
    expect(jiraShape(body)).toEqual(['bulletList[listItem[paragraph,bulletList[listItem[paragraph]],taskList[taskItem]]]']);
  });

  test('the disclosure counts, and reaches lists inside a blockquote', () => {
    const r = render('- [ ] a\n  - b\n- [ ] c\n  1. d\n', 'jira');
    expect(r.warnings[0]!.message).toContain('2 lists nested');
    const quoted = render('> - [ ] a\n>   - b\n', 'jira');
    expect(quoted.warnings.map((w) => w.code)).toContain('jira/task-item-nested-list-unnested');
  });
});

/**
 * A list item with more than one nested run under it, reachable from a three-line list. Both
 * halves of the pipeline must handle the pair by order, not by position.
 */
describe('a list item with two nested runs', () => {
  const sentDest = (body: string, dest: DestinationName) => sent(body, dest);
  /** What `render()` reports once the draft is in the editor -- the path `body/structure-lost` needs. */
  const afterLoad = (body: string, dest: DestinationName) => {
    const r = render(body, dest);
    const { doc, body: shown } = baselineFor(r);
    return render(shown, dest, doc);
  };

  test('two runs of one kind at different indents do not BLOCK the send', () => {
    /*
     * One `ListBlock` per run would hold `listItem > [paragraph, bulletList, bulletList]`; the writer
     * indents by depth, so the round trip re-parses one list and `lostInMarkdown` raises
     * `body/structure-lost`: blocking, every destination, no `suggestedFix`.
     */
    for (const body of ['- a\n    - b\n  - c\n', '1. a\n    - b\n  - c\n', '- [ ] a\n    - b\n  - c\n']) {
      for (const dest of DESTINATIONS) {
        const codes = afterLoad(body, dest).warnings.map((w) => w.code);
        expect(codes, `${JSON.stringify(body)} ${dest}`).not.toContain('body/structure-lost');
      }
    }
  });

  test('the two runs merge into one list rather than becoming siblings', () => {
    // The parse agrees with what the round trip does to it.
    expect(jiraShapeOf('- a\n    - b\n  - c\n')).toEqual([
      'bulletList[listItem[paragraph,bulletList[listItem[paragraph],listItem[paragraph]]]]',
    ]);
  });

  test('a run of a DIFFERENT kind still becomes its own block (the run-break intact)', () => {
    // The merge is guarded on kind.
    expect(jiraShapeOf('- a\n    - b\n  - [ ] c\n')).toEqual([
      'bulletList[listItem[paragraph,bulletList[listItem[paragraph]],taskList[taskItem]]]',
    ]);
  });

  test('a nested checklist and a nested bullet keep the order they were written in', () => {
    // Lifting every `taskList` out and pushing it after would send `- [ ] a` / `  - e` / `  - [ ] d`,
    // d and e swapped, with no warning.
    const body = '- [ ] a\n  - [ ] d\n  - e\n';
    for (const dest of ['slack', 'linear'] as const) {
      expect(sentDest(body, dest), dest).toBe(body);
    }
    // Order survives on both. Slack reports `list-item-becomes-task`: `d` and `e` are siblings and
    // Slack types a list rather than an item, so `e` arrives as an unchecked to-do.
    expect(afterLoad(body, 'linear').warnings.map((w) => w.code)).toEqual([]);
    expect(afterLoad(body, 'slack').warnings.map((w) => w.code)).toEqual([
      'slack/list-item-becomes-task',
    ]);
    // Jira un-nests the bullet instead of nesting it, and that path keeps the order.
    expect(sentDest(body, 'jira')).toBe('- [ ] a\n  - [ ] d\n\n- e\n');
  });

  test('a TRAILING nested checklist is still lifted to the sibling ADF spells', () => {
    // Keeping order must not stop the lift where it crosses nothing, or Jira answers 400. A
    // checklist that is the item's only nested run is trailing, so it moves.
    expect(jiraShapeOf('- [ ] a\n  - [ ] d\n')).toEqual(['taskList[taskItem,taskList[taskItem]]']);
    // With a bullet before it the checklist has nothing to hang from and goes out at the top level
    // (describe below).
    const body = '- [ ] a\n  - e\n  - [ ] d\n';
    expect(jiraShapeOf(body)).toEqual([
      'taskList[taskItem]',
      'bulletList[listItem[paragraph]]',
      'taskList[taskItem]',
    ]);
    for (const dest of ['slack', 'linear'] as const) expect(sentDest(body, dest), dest).toBe(body);
  });
});

/**
 * A nested `taskList` with no `taskItem` before it. Jira answers 201, so this is fidelity, not
 * delivery: Jira renders the item indented under nothing, `foldNestedTaskLists` flattens it in the
 * editor. Two producers: the converter's un-nesting, and `hoistMedia` dropping a media-only item a
 * nested checklist hung under, which is why the detector is swept over every fixture.
 */
describe('a nested checklist with no item to hang from', () => {
  test('the converter puts it at the top level rather than in an item-less taskList', () => {
    const body = '- [ ] a\n  - e\n  - [ ] d\n';
    const r = render(body, 'jira');
    expect(orphanedTaskLists(r.converted as AdfDocument)).toEqual([]);
    // a, then e, then d, as written.
    expect(sent(body, 'jira')).toBe('- [ ] a\n\n- e\n\n- [ ] d\n');
    expect(fixedPointOf(body, 'jira')).toBe(true);
    expect(r.blocked).toBe(false);
  });

  test('...and BOTH lost indentations are disclosed, not just the bullet', () => {
    // `d` loses its indentation as `e` does. The count comes from the converter's own report:
    // whether `d` is un-nested depends on what the sibling before it did.
    const one = render('- [ ] a\n  - b\n', 'jira').warnings.find(
      (w) => w.code === 'jira/task-item-nested-list-unnested'
    );
    expect(one!.message).toContain('A list nested');
    const two = render('- [ ] a\n  - e\n  - [ ] d\n', 'jira').warnings.find(
      (w) => w.code === 'jira/task-item-nested-list-unnested'
    );
    expect(two!.message).toContain('2 lists nested');
    // A nested checklist that can stay nested raises nothing.
    expect(render('- [ ] a\n  - [ ] b\n', 'jira').warnings).toEqual([]);
  });

  test('the deeper case counts the un-nesting once, where it happened', () => {
    // `- c` un-nests inside the inner checklist; `- [ ] d` is then orphaned in the outer one.
    const body = '- [ ] a\n  - [ ] b\n    - c\n  - [ ] d\n';
    const r = render(body, 'jira');
    expect(orphanedTaskLists(r.converted as AdfDocument)).toEqual([]);
    expect(
      r.warnings.find((w) => w.code === 'jira/task-item-nested-list-unnested')!.message
    ).toContain('2 lists nested');
  });

  test('hoistMedia dropping a media-only item lifts the checklist that hung under it', () => {
    // No un-nest disclosure of its own: `jira/task-item-media-only` states the item is dropped.
    const body = '- [ ] ![i](https://e.test/i.png)\n  - [ ] d\n';
    const r = render(body, 'jira');
    expect(orphanedTaskLists(r.converted as AdfDocument)).toEqual([]);
    expect(jiraShapeOf(body)).toEqual(['taskList[taskItem]', 'mediaSingle[media]']);
    expect(r.warnings.map((w) => w.code)).toContain('jira/task-item-media-only');
    expect(sent(body, 'jira')).toContain('- [ ] d');
  });

  test('the two destinations that receive markdown are untouched', () => {
    for (const body of ['- [ ] a\n  - e\n  - [ ] d\n', '- [ ] a\n  - [ ] b\n    - c\n  - [ ] d\n']) {
      for (const dest of ['slack', 'linear'] as const) {
        expect(sent(body, dest), `${JSON.stringify(body)} ${dest}`).toBe(body);
      }
    }
  });
});
