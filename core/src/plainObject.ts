/**
 * The plain-object narrowing, for every module that reads somebody's JSON or a tool payload (the
 * config readers, the hook adapter's registration reader, a delta's operations). Open-coded, each use
 * needs an `as Record<string, unknown>` cast afterwards. In `core` because `readPatch` reads a
 * payload; `cli/src/json.ts` re-exports it.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
