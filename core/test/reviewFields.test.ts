/**
 * The field vocabulary both ends of the wire read.
 *
 * The derivation is `cli/src/reviewPlan.ts` and has its own suite. What is here is the part the
 * RENDERER depends on: which entry is the block, and what makes a list unusable.
 */

import { describe, expect, test } from 'bun:test';
import {
  blockFieldOf,
  isBlockField,
  lineFieldsOf,
  reviewFieldsComplaint,
  type ReviewField,
} from '../src/index';

const line = (field: string): ReviewField => ({ field, kind: 'line' });
const markdown = (field: string): ReviewField => ({ field, kind: 'markdown' });
const text = (field: string): ReviewField => ({ field, kind: 'text' });

describe('which entry is the block', () => {
  test('both editor kinds are, and a line is not', () => {
    // The complement of `line`, in one place, so a fourth kind is decided once.
    expect(isBlockField(markdown('body'))).toBe(true);
    expect(isBlockField(text('body'))).toBe(true);
    expect(isBlockField(line('title'))).toBe(false);
  });

  test('a list with one block answers with it, values and all', () => {
    const fields = [
      { ...line('title'), value: 'Export fails' },
      { ...markdown('body'), value: 'It fails on empty tables.\n' },
    ];
    // Generic in the entry type, so the caller reads `.value` off the result without a cast -- the
    // renderer does exactly that.
    expect(blockFieldOf(fields)?.value).toBe('It fails on empty tables.\n');
    expect(lineFieldsOf(fields).map((f) => f.field)).toEqual(['title']);
  });

  test('a list with NO block answers undefined: a body-less review', () => {
    expect(blockFieldOf([line('title')])).toBeUndefined();
  });

  // `find` would answer with the first block, so a two-block list would send the second unread. An
  // ambiguous list has no block.
  test('and a list with TWO answers undefined rather than picking one', () => {
    expect(blockFieldOf([markdown('a'), markdown('b')])).toBeUndefined();
    expect(blockFieldOf([markdown('a'), line('t'), text('b')])).toBeUndefined();
  });
});

describe('what makes a list unusable', () => {
  test('nothing, for the lists a plan produces', () => {
    expect(reviewFieldsComplaint([markdown('body')])).toBeNull();
    expect(reviewFieldsComplaint([line('title'), markdown('body')])).toBeNull();
    // A list of lines alone is fine here: a body-less review.
    expect(reviewFieldsComplaint([line('title')])).toBeNull();
  });

  test('an empty list, because there is nothing to put in front of anyone', () => {
    expect(reviewFieldsComplaint([])).toContain('no fields at all');
  });

  test('and two block fields, naming both', () => {
    const complaint = reviewFieldsComplaint([markdown('description'), text('summary')]);
    expect(complaint).toContain('description');
    expect(complaint).toContain('summary');
    // The consequence: approving would send something unread.
    expect(complaint).toContain('without being read');
  });
});
