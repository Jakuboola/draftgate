/**
 * What to call each routing field on screen.
 *
 * A `contextFields` entry is a path (`fields.priority`). The container prefix is draftgate's
 * addressing detail and costs width on a strip with none to spare: on a real review, prefixed labels
 * push it to four rows and cut the fourth in half. The leaf is the field's real name; a prettified
 * "Summary" would claim destination knowledge the window lacks.
 *
 * A leaf is used only when unique: a payload with both `summary` and `fields.summary` would draw two
 * rows with one name, and a value under the wrong label is worse than a longer label.
 */
export function contextLabels(fields: readonly string[]): Map<string, string> {
  const leafOf = (field: string) => field.slice(field.lastIndexOf('.') + 1);
  const seen = new Map<string, number>();
  for (const field of fields) {
    const leaf = leafOf(field);
    seen.set(leaf, (seen.get(leaf) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const field of fields) {
    const leaf = leafOf(field);
    // An empty leaf cannot happen (`parseBodyPath` refuses an empty segment) but a one-segment
    // field is its own leaf, so this is the identity for every route that names no container.
    out.set(field, seen.get(leaf) === 1 && leaf !== '' ? leaf : field);
  }
  return out;
}
