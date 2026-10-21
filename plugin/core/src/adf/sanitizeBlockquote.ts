/**
 * Sanitize ADF documents for the JSM internal-note REST endpoint.
 *
 * JSM's `/rest/api/3/issue/{key}/comment` validator rejects most node types
 * inside a `blockquote` with a generic 400 INVALID_INPUT. The empirically
 * confirmed allow-list (probed against a scratch Jira site):
 *
 *   paragraph, bulletList, orderedList, codeBlock, mediaSingle, mediaGroup
 *
 * Anything else inside a blockquote 400s the entire comment. This module
 * coerces disallowed children into allowed equivalents so no comment is lost.
 * Text content is always preserved; visual hierarchy may degrade.
 */

import { AdfDocument, AdfNode } from './types';
import { capitalize } from './util';

/*
 * The inline vocabulary comes from `adfSchema.ts`, so this fixer and the checker in `profiles/jira.ts`
 * cannot disagree (a split is a Jira 400). A node this set misses is dropped, not coerced: without
 * `mediaInline`, a `mediaInline` child of an unknown block goes to `blocks`, back through
 * `fallbackCoerce`, and returns `[]`. `__tests__/sanitizeBlockquote.test.ts` pins it.
 */
import { INLINE_TYPES } from '../adfSchema';

const BLOCKQUOTE_ALLOWED = new Set([
  'paragraph',
  'bulletList',
  'orderedList',
  'codeBlock',
  'mediaSingle',
  'mediaGroup',
]);

/** Walk an ADF doc and rewrite every blockquote to satisfy JSM's content model. */
export function sanitizeAdfForJsm(doc: AdfDocument): AdfDocument {
  return { ...doc, content: doc.content.map(sanitizeNode) };
}

function sanitizeNode(node: AdfNode): AdfNode {
  if (node.type === 'blockquote') {
    return { ...node, content: sanitizeBlockquoteChildren(node.content ?? []) };
  }
  if (node.content) {
    return { ...node, content: node.content.map(sanitizeNode) };
  }
  return node;
}

function sanitizeBlockquoteChildren(nodes: AdfNode[]): AdfNode[] {
  return nodes.flatMap(coerceForBlockquote);
}

function coerceForBlockquote(node: AdfNode): AdfNode[] {
  // Allowed types may still contain a nested blockquote (e.g. bulletList →
  // listItem → blockquote), so recurse via sanitizeNode rather than passing
  // through unchanged.
  if (BLOCKQUOTE_ALLOWED.has(node.type)) return [sanitizeNode(node)];

  switch (node.type) {
    case 'heading':
      return [paragraphFromInline(node.content ?? [], { boldText: true })];
    case 'rule':
      return [paragraphOf('———')];
    case 'panel':
      return [
        labelParagraph(`${capitalize((node.attrs?.panelType as string) ?? 'note')}:`, 'em'),
        ...sanitizeBlockquoteChildren(node.content ?? []),
      ];
    case 'expand':
    case 'nestedExpand':
      return [
        labelParagraph((node.attrs?.title as string) || 'Details', 'strong'),
        ...sanitizeBlockquoteChildren(node.content ?? []),
      ];
    case 'blockquote':
      return sanitizeBlockquoteChildren(node.content ?? []);
    case 'taskList':
      return [statefulListToBulletList(node, taskPrefix)];
    case 'decisionList':
      return [statefulListToBulletList(node, () => '→ ')];
    case 'table':
      return tableToParagraphs(node);
    default:
      return fallbackCoerce(node);
  }
}

function taskPrefix(item: AdfNode): string {
  return (item.attrs?.state as string) === 'DONE' ? '[x] ' : '[ ] ';
}

/** Coerce a stateful list (taskList, decisionList) into a bulletList. */
function statefulListToBulletList(node: AdfNode, prefixFor: (item: AdfNode) => string): AdfNode {
  const items = (node.content ?? []).map((item) => ({
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text' as const, text: prefixFor(item) }, ...(item.content ?? [])],
      },
    ],
  }));
  return { type: 'bulletList', content: items };
}

/**
 * Flatten a table into one paragraph per row (cells joined by ` | `).
 * Lift any block-level cell content (codeBlock, mediaSingle, etc.) out as
 * separate blocks emitted after the row paragraph so nothing is dropped.
 */
function tableToParagraphs(node: AdfNode): AdfNode[] {
  const out: AdfNode[] = [];
  for (const row of node.content ?? []) {
    if (row.type !== 'tableRow') continue;
    const cellTexts: AdfNode[] = [];
    const lifted: AdfNode[] = [];
    const cells = row.content ?? [];
    cells.forEach((cell, idx) => {
      for (const block of cell.content ?? []) {
        if (block.type === 'paragraph') {
          cellTexts.push(...(block.content ?? []));
        } else {
          lifted.push(...coerceForBlockquote(block));
        }
      }
      if (idx < cells.length - 1) cellTexts.push({ type: 'text', text: ' | ' });
    });
    if (cellTexts.length > 0) out.push({ type: 'paragraph', content: cellTexts });
    out.push(...lifted);
  }
  return out;
}

/**
 * Last-resort coercion for unknown disallowed types. Extract any inline
 * content into a paragraph; recurse into block content; never drop silently.
 */
function fallbackCoerce(node: AdfNode): AdfNode[] {
  const inline: AdfNode[] = [];
  const blocks: AdfNode[] = [];
  for (const child of node.content ?? []) {
    if (INLINE_TYPES.has(child.type)) inline.push(child);
    else blocks.push(...coerceForBlockquote(child));
  }
  const out: AdfNode[] = [];
  if (inline.length > 0) out.push({ type: 'paragraph', content: inline });
  out.push(...blocks);
  if (out.length === 0 && node.text) out.push(paragraphOf(node.text));
  return out;
}

function paragraphOf(text: string): AdfNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function labelParagraph(text: string, mark: 'strong' | 'em'): AdfNode {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text, marks: [{ type: mark }] }],
  };
}

function paragraphFromInline(
  inline: AdfNode[],
  opts: { boldText: boolean }
): AdfNode {
  const content = opts.boldText ? inline.map(addStrongToText) : inline;
  return { type: 'paragraph', content };
}

function addStrongToText(node: AdfNode): AdfNode {
  if (node.type !== 'text') return node;
  const existing = node.marks ?? [];
  if (existing.some((m) => m.type === 'strong')) return node;
  return { ...node, marks: [...existing, { type: 'strong' }] };
}
