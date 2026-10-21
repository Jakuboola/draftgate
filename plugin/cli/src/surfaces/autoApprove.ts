/**
 * Non-interactive surfaces, for tests and CI.
 *
 * Not a review gate. `--surface auto-approve` exists so the CLI's wiring can be exercised
 * end-to-end without a human or a window, and `auto-reject` so the denial path can be too.
 */

import type { Decision, ReviewSurface } from '../types';

/**
 * Approve every review, substituting `overrides` by path. `human: false`, so its approval is never
 * described to the agent as a person's, nor counted as one by the digest.
 *
 * The approval is total: every shown field is reported, with the payload's value where nothing is
 * overridden, so `decision.fields === undefined` always means a decision that cannot be carried
 * out. Unchanged values cannot invent an edit: `cli/src/review.ts` compares each with what was shown.
 */
export function autoApprove(overrides: Readonly<Record<string, string>> = {}): ReviewSurface {
  return {
    human: false,
    async review(request) {
      // Built from what was shown, so an override for a field this review never carried is dropped,
      // as `review.ts` drops one from a window's report. `Object.hasOwn`, not `??`: a field named
      // `toString` would read a function off `Object.prototype`.
      const fields = Object.fromEntries(
        request.fields.map((f) => [
          f.field,
          Object.hasOwn(overrides, f.field) ? overrides[f.field]! : f.value,
        ])
      );
      return { action: 'approve', fields };
    },
  };
}

export function autoReject(reason?: string): ReviewSurface {
  return { human: false, async review() { return { action: 'reject', reason } as Decision; } };
}
