/**
 * Typed view of the page's bridge, which the WebKit host's user script defines (`BRIDGE_SCRIPT` in
 * `surface/host/draftgate.m`).
 *
 * `window.draftgate` is the whole of the renderer's privileged surface: fetch the review, submit
 * one decision. Anything else the window wants it must compute itself from `core`, which is why
 * `core` is pure.
 */

import type { AppliedFix, HumanDecision, WireRequest } from '../../cli/src/surfaces/windowProtocol';

/**
 * The decision as the renderer expresses it; the host's `sanitiseDecision` stamps the protocol
 * version.
 *
 * An alias: separate copies of the union would each type-check alone, so a field added to one
 * and missed in another would go uncaught.
 */
export type SurfaceDecision = HumanDecision;

interface DraftgateBridge {
  request(): Promise<WireRequest | null>;
  decide(decision: SurfaceDecision): void;
}

declare global {
  interface Window {
    draftgate?: DraftgateBridge;
  }
}

export function bridge(): DraftgateBridge {
  const b = window.draftgate;
  // Reachable only if something other than the review host opened the bundle. Fail loudly rather
  // than render a review that can never be submitted.
  if (!b) throw new Error("the draftgate bridge is missing: this page must be opened by draftgate's review window");
  return b;
}

export type { AppliedFix, WireRequest };
