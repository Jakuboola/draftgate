/**
 * The plain-object narrowing, for every module that reads somebody's JSON (the config readers and
 * the hook adapter's registration reader). Open-coded, each use needs an `as Record<string,
 * unknown>` cast afterwards. Its own module so a "utils.ts" does not acquire unrelated tenants; in
 * `cli/` because nothing in `core` parses operator config.
 */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
