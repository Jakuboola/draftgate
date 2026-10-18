/**
 * Mark a destination's plain-text mention syntax as a TOKEN, without changing a character.
 *
 * The other half of `core/src/mentionTokens.ts` -- read that file for which destinations have
 * patterns and why, and for why a Slack token shows `<@U0123ABCDEF>` rather than a name.
 *
 * A decoration, not a node: the document is untouched. A node view that swallowed `<@U0123ABCDEF>`
 * into an atom would change what ProseMirror serialises, turning a cosmetic feature into a silent
 * body rewrite (and an `edited` row) on every Slack draft with a mention. `Decoration.inline` adds a
 * span at render time only, and the token stays editable: delete a character of the id and the
 * decoration stops matching until it is well formed again.
 *
 * Recomputed per document, not mapped through transactions (`LostHighlight` maps, because it
 * decorates one range an edit should carry along): a mapped decoration would stay on a token that
 * a typed `>` has broken. Cost is a scan of the text nodes per render, and `findMentionTokens`
 * returns at once for a destination with no patterns (Jira).
 *
 * The same treatment reaches a link the destination converts into a mention (`MentionSupport.links`:
 * Linear's profile link): the link stays a link and is drawn as the destination draws a mention. See
 * `mentionPillDecorations`.
 */

import type { EditorState } from '@tiptap/pm/state';
import { Decoration } from '@tiptap/pm/view';
import { derivedDecorations } from './derivedDecorations';
import { hrefOf } from './linkTarget';
import {
  findMentionTokens,
  mentionLinkName,
  type MentionSupport,
  type MentionTokenKind,
  type MentionTokenPattern,
} from '../../core/src/mentionTokens';

/** The class per kind. `broadcast` is the one that must look different; see `mentionTokens.ts`. */
const CLASS: Record<MentionTokenKind, string> = {
  user: 'dg-mtok dg-mtok-user',
  broadcast: 'dg-mtok dg-mtok-broadcast',
  group: 'dg-mtok dg-mtok-group',
  channel: 'dg-mtok dg-mtok-channel',
  // A thread reference, the one kind not about a person. Not `channel`: a Slack channel reference
  // notifies nobody, while a GitHub `#123` posts a cross-reference every watcher sees. `github.css`
  // draws it as a plain link, not a pill.
  reference: 'dg-mtok dg-mtok-reference',
};

/**
 * Every token in the document, as inline decorations.
 *
 * Exported for the test, which asserts positions against a real schema (as for `lostHighlight.ts`'s
 * root offset).
 *
 * Skipped: text carrying the `code` mark and everything inside a `codeBlock`. Slack renders both as
 * code, so a pill there would claim a ping that will not happen. This exclusion is NOT probed: it is
 * the conservative direction and matches `core/src/markdown.ts` ("callers never rewrite or inspect
 * code content"). To settle it, send a ref inside backticks and read the stored message back (Slack
 * rewrites a real ref on ingest to carry the resolved name). It lives here, not in `core`, because
 * the editor knows a code span structurally; a text scanner would need a second grammar.
 */
export function mentionDecorations(
  state: EditorState,
  patterns: readonly MentionTokenPattern[]
): Decoration[] {
  if (patterns.length === 0) return [];

  const codeMark = state.schema.marks.code;
  const out: Decoration[] = [];

  state.doc.descendants((node, pos) => {
    // Do not descend: every text node inside is code by construction.
    if (node.type.name === 'codeBlock') return false;
    if (!node.isText || node.text === undefined) return undefined;
    if (codeMark !== undefined && codeMark.isInSet(node.marks) !== undefined) return undefined;

    for (const t of findMentionTokens(node.text, patterns)) {
      /*
       * `pos` is the text node's own position, so a character offset adds directly (an element
       * node's content starts at `pos + 1`, hence the `isText` test above).
       */
      out.push(Decoration.inline(pos + t.start, pos + t.end, { class: CLASS[t.kind] }));
    }
    return undefined;
  });

  return out;
}

/** A stretch of text under one link: consecutive text nodes carrying the same href. */
interface LinkRun {
  from: number;
  to: number;
  text: string;
  href: string;
}

/**
 * Every link the destination turns into a mention, with the name its address holds.
 *
 * A run, not a text node: a partly bold link is several text nodes, and each would get its own `@`.
 * A run ends where positions stop being contiguous (a hard break or inline image ends it).
 */
function mentionLinkRuns(
  state: EditorState,
  links: MentionSupport['links']
): (LinkRun & { name: string })[] {
  if (links === null) return [];
  const runs: LinkRun[] = [];
  state.doc.descendants((node, pos) => {
    const href = node.isText ? hrefOf(state, node.marks) : undefined;
    if (href === undefined) return;
    const last = runs.at(-1);
    if (last !== undefined && last.to === pos && last.href === href) {
      last.to += node.nodeSize;
      last.text += node.text;
    } else {
      runs.push({ from: pos, to: pos + node.nodeSize, text: node.text!, href });
    }
  });
  return runs.flatMap((r) => {
    const name = mentionLinkName(r.href, links);
    return name === null ? [] : [{ ...r, name }];
  });
}

/**
 * One mention link, drawn as the destination draws a mention; the document is unchanged.
 *
 * Its text takes the `user` token's class (the destination's mention typography), and its first
 * character carries `dg-mlink-start`, whose `::before` draws the leading `@` unless the text has one.
 * The name shown is one the draft already holds (`LINEAR_PROFILE_LINK` says why it cannot be the
 * display name): a labelled link shows its label, a bare URL shows the slug with the address before
 * it under `dg-mlink-hidden`. Those characters stay in the sent body and the address stays one hover
 * or caret away (`linkTarget.tsx`).
 */
function mentionLinkDecorations({ from, to, text, href, name }: LinkRun & { name: string }): Decoration[] {
  // The bare form: the text IS the address, so only its slug is drawn.
  const shown = text === href ? from + href.length - name.length : from;
  const label = text.slice(shown - from);
  const at = label.startsWith('@') ? '' : ' dg-mlink-at';
  // One CODE POINT, not one UTF-16 unit: a span ending inside a surrogate pair would draw an emoji
  // as two replacement glyphs.
  const first = String.fromCodePoint(label.codePointAt(0)!).length;
  return [
    ...(shown > from ? [Decoration.inline(from, shown, { class: 'dg-mlink-hidden' })] : []),
    Decoration.inline(shown, to, { class: CLASS.user }),
    Decoration.inline(shown, shown + first, { class: `dg-mlink-start${at}` }),
  ];
}

/**
 * Every mention decoration in the document: tokens, and links that are mentions.
 *
 * A token inside a mention link is dropped, as `mentionSummary` drops it from the count: the label
 * of `[@jane](<profile URL>)` is one mention. Exported for the test.
 */
export function mentionPillDecorations(state: EditorState, mentions: MentionSupport): Decoration[] {
  const runs = mentionLinkRuns(state, mentions.links);
  const outside = (d: Decoration) => runs.every((r) => d.to <= r.from || d.from >= r.to);
  return [
    ...mentionDecorations(state, mentions.tokens?.patterns ?? []).filter(outside),
    ...runs.flatMap(mentionLinkDecorations),
  ];
}

/**
 * The extension the editor registers, closed over this destination's mention support, which arrives
 * from the profile as `RenderResult.mentions` (the window never switches on a destination name).
 */
export function mentionPills(mentions: MentionSupport) {
  return derivedDecorations('draftgateMentionPills', (state) => mentionPillDecorations(state, mentions));
}
