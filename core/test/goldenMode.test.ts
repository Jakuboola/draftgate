/**
 * `bun test` never comes back green from a run that blessed the goldens: `UPDATE_GOLDEN=1` makes
 * every golden assertion compare nothing (see `UPDATE` in `golden.ts`), so the mode fails here.
 */

import { describe, expect, test } from 'bun:test';
import { isBlessingGoldens } from './golden';

describe('golden files were checked, not blessed', () => {
  test('UPDATE_GOLDEN is not set for this run', () => {
    expect(
      isBlessingGoldens(),
      'UPDATE_GOLDEN=1 is set, so every golden assertion in this run WROTE its file instead of ' +
        'comparing against it. That is what `bun run test:update-golden` is for, and this failure ' +
        'is how that run says so. Read the diff, then run `bun test` with the variable unset.'
    ).toBe(false);
  });
});
