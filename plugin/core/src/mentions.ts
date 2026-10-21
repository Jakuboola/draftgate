/**
 * Mentions across the markdown boundary. A mention is a node carrying an id, and writing it as
 * `@Label` drops the id:
 *
 *   editor -> ADF       {"type":"mention","attrs":{"id":"557058:abc","text":"@Jakub"}}
 *   editor -> markdown  "@Jakub"                                   <- the id is gone
 *
 * The window would show a mention chip and send text that pings nobody. So the id is written out
 * as `[@Label](mention:ID)` and parsed back: a link, which the converter already round-trips, so
 * both halves are transforms over its output like `hoistMedia`. Not Jira's `[~accountid:x]`, which
 * renders literally (see `mentions` in `profiles/jira.ts`) and would draw a chip for characters. An
 * explicit scheme cannot be typed by accident, and leaked, it renders as an odd link.
 */

import type { AdfDocument, AdfNode } from './adf/types';

/** The href scheme that marks a link as a mention in canonical markdown. */
export const MENTION_SCHEME = 'mention:';

/** A display name with any leading `@` removed, so the `@` is added in exactly one place. */
const atName = (v: unknown) => String(v ?? '').replace(/^@/, '');

/**
 * Apply `fn` to every node in the tree, returning the original node where nothing changed. It runs
 * on every keystroke, and a document with no mentions allocates nothing. Measured on the repo's own
 * payload against rebuilding with spreads: 1.07µs vs 4.9µs at 93 nodes, 9.03µs vs 28.3µs at 737.
 */
function mapNodes(node: AdfNode, fn: (n: AdfNode) => AdfNode): AdfNode {
  if (!Array.isArray(node.content)) return node;

  let next: AdfNode[] | null = null;
  for (let i = 0; i < node.content.length; i++) {
    const child = node.content[i]!;
    const mapped = fn(mapNodes(child, fn));
    if (mapped === child) {
      next?.push(mapped);
      continue;
    }
    // First change: copy what came before, then diverge.
    next ??= node.content.slice(0, i);
    next.push(mapped);
  }
  return next === null ? node : { ...node, content: next };
}

/**
 * Mention nodes -> `[@Label](mention:ID)`, so the id survives serialisation to markdown. A mention
 * with no id becomes plain text rather than a link to a bare `mention:`.
 */
export function encodeMentions<T extends AdfDocument>(doc: T): T {
  return mapNodes(doc as AdfNode, (n) => {
    if (n.type !== 'mention') return n;
    const id = n.attrs?.id;
    const label = atName(n.attrs?.text);
    if (typeof id !== 'string' || id === '') return { type: 'text', text: `@${label}` };
    return {
      type: 'text',
      text: `@${label}`,
      marks: [{ type: 'link', attrs: { href: `${MENTION_SCHEME}${id}` } }],
    };
  }) as T;
}

/**
 * `[@Label](mention:ID)` -> mention nodes, so a mention reaches the editor as a chip and Jira as an
 * ADF mention. Only a `MENTION_SCHEME` href is converted.
 */
export function decodeMentions<T extends AdfDocument>(doc: T): T {
  return mapNodes(doc as AdfNode, (n) => {
    if (n.type !== 'text' || !n.marks) return n;
    const link = n.marks.find(
      (m) => m.type === 'link' && String(m.attrs?.href ?? '').startsWith(MENTION_SCHEME)
    );
    if (!link) return n;
    const id = String(link.attrs?.href).slice(MENTION_SCHEME.length);
    if (!id) return n;
    // ADF spells the display text `text`, including the leading `@`.
    return { type: 'mention', attrs: { id, text: `@${atName(n.text)}` } };
  }) as T;
}
