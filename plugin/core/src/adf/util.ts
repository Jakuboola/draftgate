/**
 * Shared utilities for the ADF ↔ Markdown conversion pipeline.
 */

import type { AdfNode, AdfDocument } from './types';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const JIRA_ATTACHMENT_SCHEME = 'jira-attachment:';

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

/** Uppercase the first character. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Strip Jira's UUID suffix from filenames.
 * "myfile (a1b2c3d4-e5f6-7890-abcd-ef1234567890).png" → "myfile.png"
 */
export function stripFilenameUuid(filename: string): string {
  return filename.replace(
    / \([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/i,
    ''
  );
}

/**
 * Parse Jira wiki-link syntax [display|url|type] → { display, url }.
 * Strips the third segment (smart-link, smart-card, smart-embed).
 * Returns null if the text doesn't match the pattern.
 */
export function parseJiraWikiLink(
  text: string
): { display: string; url: string } | null {
  const match = text.match(/^\[([^|\]]+)\|([^|\]]+)(?:\|[^\]]+)?\]$/);
  if (!match) return null;
  const display = match[1];
  const url = match[2];
  return { display, url };
}

/** Check if a URL or filename points to an image by extension */
export function isImageReference(ref: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\?|#|$)/i.test(ref);
}

/**
 * A table cell's text, as a row writes it: every `|` escaped `\|`, a newline a space. The inverse is
 * `tableRowCells`, below. Inside a code span too: the code `a\|b` comes out `` `a\\|b` ``, which reads
 * back as one cell only under cmark-gfm's rule, not micromark's.
 */
export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * A row's cells, split the way GitHub splits them: on a pipe no backslash comes right before, with that
 * backslash dropped. Splitting on every `|` would not read back `escapeTableCell`'s output: `ls | wc`
 * becomes three cells under two headers, which Jira stores ragged (probed, 201).
 *
 * cmark-gfm's rule (GitHub's), not micromark's: its cell scanner is `(escaped_char|[^|\r\n])+` under
 * re2c's longest match, so `\\|` does not split where micromark splits (checked against GitHub's
 * renderer), and `unescape_pipes` drops the backslash before every pipe. Hence a lookbehind, not the
 * converter's `isEscaped`. A code span does not protect a bare pipe in either parser (the table layer
 * runs first), so there is no code-span scan.
 */
export function tableRowCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

/** Escape a string for use inside a RegExp constructor */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect media node info from an ADF tree in a single walk.
 * Returns both a filename→mediaId map (for filename-based bridging)
 * and an ordered list of media UUIDs (for positional fallback).
 */
export function collectMediaNodes(node: AdfNode | AdfDocument): {
  filenameToMediaId: Map<string, string>;
  orderedMediaIds: string[];
} {
  const filenameToMediaId = new Map<string, string>();
  const orderedMediaIds: string[] = [];
  function walk(n: AdfNode | AdfDocument): void {
    if ((n.type === 'media' || n.type === 'mediaInline') && (n as AdfNode).attrs?.id) {
      const attrs = (n as AdfNode).attrs!;
      const mediaId = attrs.id as string;
      orderedMediaIds.push(mediaId);
      const filename = (attrs.alt || attrs.__fileName || '') as string;
      if (filename && !filenameToMediaId.has(filename)) filenameToMediaId.set(filename, mediaId);
    }
    if (n.content) {
      for (const child of n.content) walk(child);
    }
  }
  walk(node);
  return { filenameToMediaId, orderedMediaIds };
}

/**
 * Text with every whitespace character removed: the one "same text" test for the writer's repair
 * check and the load's `body/text-changed` backstop, so they cannot disagree. Whitespace is out
 * because no escape changes it and markdown cannot carry a paragraph's leading spaces.
 */
export function withoutSpace(text: string): string {
  return text.replace(/\s+/g, '');
}
