/** The plan: which fields a review shows, in what order, rendered how. */

import { describe, expect, test } from 'bun:test';
import { profiles, type DestinationName } from '../../core/src/index';
import { blockFieldOf, lineFieldsOf, reviewPlan } from '../src/reviewPlan';

const DESTINATIONS: DestinationName[] = ['jira', 'slack', 'linear', 'github'];

describe('the block field', () => {
  test('is the destination profile\'s body field when the route overrides nothing', () => {
    for (const destination of DESTINATIONS) {
      expect(blockFieldOf(reviewPlan(destination, {}))).toEqual({
        field: profiles[destination].bodyField,
        kind: 'markdown',
      });
    }
  });

  test('is the ROUTE\'s body field when it names one, dotted paths included', () => {
    // `editJiraIssue` has no `description` parameter: its prose sits at `fields.description`.
    expect(blockFieldOf(reviewPlan('jira', { bodyField: 'fields.description' }))).toEqual({
      field: 'fields.description',
      kind: 'markdown',
    });
  });

  test('is TEXT rather than markdown when the route says the field is plain', () => {
    // Linear's `Release.description` is a plain `String` column with no document state beside it
    // (probed against Linear). `text` routes the window to a textarea and the CLI to `renderPlain`.
    expect(blockFieldOf(reviewPlan('linear', { bodyFormat: 'plain' }))).toEqual({
      field: 'body',
      kind: 'text',
    });
  });

  test('and a route restating the default is not a claim', () => {
    // `ROUTE_FLAGS` refuses to encode `bodyFormat: "markdown"`; the derivation agrees, or two
    // spellings of an ordinary markdown body would produce two plans.
    expect(reviewPlan('jira', { bodyFormat: 'markdown' })).toEqual(reviewPlan('jira', {}));
  });

  test('there is exactly ONE, for every route shape', () => {
    // `render()`, `blocked`, `suggestedFix`, `lostInMarkdown`, `silencedWarnings` and `FixDiff` are
    // all singular; `blockFieldOf` returning the first would hide a second.
    for (const destination of DESTINATIONS) {
      for (const facts of [
        {},
        { bodyFormat: 'plain' as const },
        { bodyField: 'fields.description' },
        { proseFields: ['title', 'name'] },
      ]) {
        const blocks = reviewPlan(destination, facts).filter((f) => f.kind !== 'line');
        expect(blocks).toHaveLength(1);
      }
    }
  });
});

describe('the line fields', () => {
  test('are the route\'s prose fields, in the order it wrote them', () => {
    // The reading order is the operator's: `save_project` carries `name` and `summary`.
    const plan = reviewPlan('linear', { proseFields: ['name', 'summary'] });
    expect(lineFieldsOf(plan)).toEqual([
      { field: 'name', kind: 'line' },
      { field: 'summary', kind: 'line' },
    ]);
  });

  test('are empty for a route whose body is the only prose it carries', () => {
    expect(lineFieldsOf(reviewPlan('slack', {}))).toEqual([]);
  });
});

/*
 * The invariant `surface/src/App.tsx` rests on and cannot see: it renders `.dg-prose` and then the
 * compose frame as two containers, so a plan with the block first would silently draw the title
 * below the draft.
 */
describe('the order is the reading order', () => {
  test('every line precedes the block, for every route shape', () => {
    for (const destination of DESTINATIONS) {
      for (const proseFields of [[], ['title'], ['fields.summary', 'name', 'x.y']]) {
        const plan = reviewPlan(destination, { proseFields });
        const block = plan.findIndex((f) => f.kind !== 'line');
        expect(block).toBe(plan.length - 1);
      }
    }
  });
});
