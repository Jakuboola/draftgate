/**
 * Which fields of a payload one review puts in front of a human, and how each is rendered.
 *
 * `RouteFacts` says it in three words (`bodyField`, `proseFields`, `bodyFormat`), which operators,
 * `tools.json`, `ROUTE_FLAGS` and `--propose-tools` keep. This turns them into one list at one
 * boundary, so no consumer reassembles the editable set or the markdown-or-text decision by hand.
 * The vocabulary (`ReviewField`, `blockFieldOf`, ...) lives in `core/src/reviewFields.ts`, because
 * the renderer reads the list too and the bundle may import exactly one `cli` module.
 */

import { type DestinationName, type ReviewField } from '../../core/src/index';
import { bodyFieldFor } from './payload';
import type { RouteFacts } from './routeFacts';

// Re-exported so a consumer imports the whole vocabulary from "the plan".
export {
  blockFieldOf,
  isBlockField,
  lineFieldsOf,
  reviewFieldsComplaint,
  type ReviewField,
  type ReviewFieldKind,
  type ReviewFieldValue,
} from '../../core/src/index';

/**
 * The fields one route puts in front of a reviewer, in reading order: lines, then the block (a
 * title above the draft, as at the destination). The window walks the list, so a block-first plan
 * draws the draft first; `cli/test/reviewPlan.test.ts` asserts the order.
 *
 * Exactly one block, since `bodyFieldFor` answers with one field. `render()`, `blocked`,
 * `suggestedFix`, `lostInMarkdown`, `silencedWarnings`, `FixDiff` and the stylesheet preview are
 * all singular, and no connector in the map has two markdown fields. `reviewFieldsComplaint`
 * checks it again where a list is accepted.
 */
export function reviewPlan(
  destination: DestinationName,
  facts: Pick<RouteFacts, 'bodyField' | 'proseFields' | 'bodyFormat'>
): readonly ReviewField[] {
  return [
    ...(facts.proseFields ?? []).map((field) => ({ field, kind: 'line' as const })),
    {
      field: bodyFieldFor(destination, facts.bodyField),
      // From the route; `markdown` when it says nothing, as `ROUTE_FLAGS` encodes it.
      kind: facts.bodyFormat === 'plain' ? ('text' as const) : ('markdown' as const),
    },
  ];
}
