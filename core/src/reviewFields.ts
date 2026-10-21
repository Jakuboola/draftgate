/**
 * Which fields a review shows, as a vocabulary both ends of the wire can read.
 *
 * `cli/src/reviewPlan.ts` derives the list (it needs `bodyFieldFor`, the tool map and the operator's
 * config); the list itself is read by `cli/src/review.ts`, the renderer and the probe harness, and
 * the renderer may import only one `cli` module (`surface/harness/rendererImports.test.ts`), so it
 * lives in `core`.
 */

import { patchWarnings, type PatchEdit } from './patch';
import { proseWarnings } from './render';
import type { DestinationName } from './profiles';
import type { Warning } from './warnings';

/**
 * How one field is put in front of the reviewer. Each kind is a different set of claims:
 *
 *  - `markdown` the TipTap editor. `render()`, the warnings taxonomy, `suggestedFix`,
 *    `lostInMarkdown`, the round trip and `silencedWarnings` all apply.
 *  - `text`     a textarea. `renderPlain()`: no conversion, no toolbar, no warnings taxonomy, no
 *               repairs. The destination stores these bytes, so `**bold**` is eight characters.
 *  - `line`     a single-line `<input>`. `proseWarnings()` and nothing else: a title is a plain
 *               string at every destination probed.
 *  - `edit`     the text one operation of a delta writes (`core/src/patch.ts`): a textarea holding
 *               the exact characters, its operation's anchors drawn read-only beside it, and a
 *               read-only preview. `patchWarnings()` and nothing else. Not the editor: a fragment
 *               spliced into a document the window cannot see is not a document, and the editor's
 *               round trip rewrites one (it drops the `"\n\n"` that joins it to its neighbours).
 *
 * The first two are block fields (`isBlockField`).
 */
export type ReviewFieldKind = 'markdown' | 'text' | 'line' | 'edit';

/**
 * One field a review may show and edit.
 *
 * `field`, though it is a path by `parseBodyPath`'s grammar: it matches `Warning.field`,
 * `AuditRecord.prose[].field` and the keys of `HumanDecision.prose`, and `Warning.path` already means
 * a position in a converted ADF tree.
 */
export type ReviewField =
  | { field: string; kind: Exclude<ReviewFieldKind, 'edit'> }
  /** `edit` carries what the operation applies at, which the reviewer reads and cannot change. */
  | { field: string; kind: 'edit'; edit: PatchEdit };

/**
 * A field together with the value this payload carries for it.
 *
 * The block field's value is also `RenderResult.canonical`, an echo: `render()` returns its input
 * verbatim and `cli/src/review.ts` renders from this value.
 */
export type ReviewFieldValue = ReviewField & { value: string };

/** One operation of a patch, with the agent's text (`core/src/patch.ts`). */
export type EditFieldValue = Extract<ReviewFieldValue, { kind: 'edit' }>;

/** Is this the field the body machinery is about? Kept in one place so a new kind is classified once. */
export function isBlockField(f: ReviewField): boolean {
  return f.kind === 'markdown' || f.kind === 'text';
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
  return fields.filter((f) => f.kind === 'line');
}

/**
 * Every field's warnings that are not the body's, by kind: `proseWarnings` for a line,
 * `patchWarnings` for an edit. The one place a kind's rule is chosen, for the window's verdict and
 * the CLI's backstop alike; `value` is what the field holds now.
 */
export function fieldWarnings(
  fields: readonly ReviewFieldValue[],
  destination: DestinationName,
  toolName?: string
): Warning[] {
  return [
    ...proseWarnings(
      fields.filter((f) => f.kind === 'line').map((f) => ({ field: f.field, value: f.value })),
      destination,
      toolName
    ),
    ...patchWarnings(editFieldsOf(fields)),
  ];
}

/** The edit fields, in the order the destination applies them. */
export function editFieldsOf<T extends ReviewField>(
  fields: readonly T[]
): readonly Extract<T, { kind: 'edit' }>[] {
  return fields.filter((f): f is Extract<T, { kind: 'edit' }> => f.kind === 'edit');
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
  // A delta stands in place of the body (`extractPatch`), so a list with both is not a review of
  // one send.
  if (blocks.length > 0 && fields.some((f) => f.kind === 'edit')) {
    return 'this review carries a body and a list of edits together, and only one of them is sent';
  }
  return null;
}
