/**
 * What the link button will accept as an address. No React import, so it is unit-testable without a
 * renderer. The href travels into the approved payload, and `render()` only warns about one
 * (`link/unsafe-href`, `link/text-host-mismatch`), so this affordance validates its own input. An
 * allowlist: a denylist of `javascript:` and `data:` is one scheme behind the next one a browser or
 * destination supports.
 */
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/**
 * Normalise what the reviewer typed, or `null` if it cannot be a safe link. `null` is a refusal the
 * caller must surface: a link button that discards the address lets the reviewer approve believing a
 * link is in the draft.
 */
export function normaliseHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // A bare `example.org` gets https, but only with no scheme at all, so `javascript:alert(1)` is
  // refused below instead of becoming `https://javascript:alert(1)`.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return SAFE_PROTOCOLS.includes(url.protocol) ? url.toString() : null;
}

