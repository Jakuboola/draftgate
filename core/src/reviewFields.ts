/**
 * Which fields a review shows, as a vocabulary both ends of the wire can read.
 *
 * `cli/src/reviewPlan.ts` derives the list (it needs `bodyFieldFor`, the tool map and the operator's
 * config); the list itself is read by `cli/src/review.ts`, the renderer and the probe harness, and
 * the renderer may import only one `cli` module (`surface/harness/rendererImports.test.ts`), so it
 * lives in `core`.
 */

/**
 * How one field is put in front of the reviewer. Each kind is a different set of claims:
 *
 *  - `markdown` the TipTap editor. `render()`, the warnings taxonomy, `suggestedFix`,
 *    `lostInMarkdown`, the round trip and `silencedWarnings` all apply.
 *  - `text`     a textarea. `renderPlain()`: no conversion, no toolbar, no warnings taxonomy, no
 *               repairs. The destination stores these bytes, so `**bold**` is eight characters.
 *  - `line`     a single-line `<input>`. `proseWarnings()` and nothing else: a title is a plain
 *               string at every destination probed.
 *
 * The first two are block fields (`isBlockField`).
 */
export type ReviewFieldKind = 'markdown' | 'text' | 'line';

/**
 * One field a review may show and edit.
 *
 * `field`, though it is a path by `parseBodyPath`'s grammar: it matches `Warning.field`,
 * `AuditRecord.prose[].field` and the keys of `HumanDecision.prose`, and `Warning.path` already means
 * a position in a converted ADF tree.
 */
export interface ReviewField {
  field: string;
  kind: ReviewFieldKind;
}

/**
 * A field together with the value this payload carries for it.
 *
 * The block field's value is also `RenderResult.canonical`, an echo: `render()` returns its input
 * verbatim and `cli/src/review.ts` renders from this value.
 */
export type ReviewFieldValue = ReviewField & { value: string };

/**
 * Is this the field the body machinery is about? The complement of `line`, kept in one place so a
 * fourth kind is classified once.
 */
export function isBlockField(f: ReviewField): boolean {
  return f.kind !== 'line';
}

/**
 * The list's block field, or `undefined` when it has none or more than one. None is a route whose
 * body field the payload does not carry; two would let `find` review the first and send the second
 * unreviewed, and `reviewFieldsComplaint` refuses that list. Generic, so a `ReviewFieldValue` list
 * gets its `value` back without a cast.
 */
export function blockFieldOf<T extends ReviewField>(fields: readonly T[]): T | undefined {
  const blocks = fields.filter(isBlockField);
  return blocks.length === 1 ? blocks[0] : undefined;
}

/** The line fields, in reading order. */
export function lineFieldsOf<T extends ReviewField>(fields: readonly T[]): readonly T[] {
  return fields.filter((f) => !isBlockField(f));
}

/**
 * What is wrong with this list, as a sentence, or `null` when nothing is.
 *
 * Checked where a list is accepted: `cli/src/reviewPlan.ts` emits one block structurally, while the
 * renderer receives a list across a process boundary from a CLI that may be another version. A
 * sentence rather than a throw: the two callers report differently.
 */
export function reviewFieldsComplaint(fields: readonly ReviewField[]): string | null {
  if (fields.length === 0) return 'this review carries no fields at all, so there is nothing to show';
  const blocks = fields.filter(isBlockField);
  if (blocks.length > 1) {
    return (
      `this review carries ${blocks.length} body fields (${blocks.map((f) => f.field).join(', ')}) ` +
      'and the window can only show one, so the others would be sent without being read'
    );
  }
  return null;
}
