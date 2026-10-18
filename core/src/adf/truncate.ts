/**
 * Markdown-aware truncation.
 */

/**
 * Truncate markdown to `maxLen` characters without breaking links, code blocks,
 * or inline code. Prefers clean breaks at paragraph > line > word boundaries.
 */
export function truncateMarkdown(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const ellipsis = '…';
  const limit = maxLen - ellipsis.length;

  // Build protected regions that must not be split: [start, end)
  const regions: Array<[number, number]> = [];
  let m: RegExpExecArray | null;

  // Code blocks (``` ... ```)
  const codeBlockRe = /```[\s\S]*?```/g;
  while ((m = codeBlockRe.exec(text)) !== null) {
    if (m.index > limit) break;
    regions.push([m.index, m.index + m[0].length]);
  }

  // Inline code (` ... `)
  const inlineCodeRe = /`[^`]+`/g;
  while ((m = inlineCodeRe.exec(text)) !== null) {
    if (m.index > limit) break;
    regions.push([m.index, m.index + m[0].length]);
  }

  // Links and images ( [text](url) or ![alt](url) )
  const linkRe = /!?\[[^\]]*\]\([^)]*\)/g;
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > limit) break;
    regions.push([m.index, m.index + m[0].length]);
  }

  regions.sort((a, b) => a[0] - b[0]);

  // If a position falls inside a protected region, back up to its start.
  function safePosition(pos: number): number {
    for (const [start, end] of regions) {
      if (start > pos) break;
      if (pos > start && pos < end) return start;
    }
    return pos;
  }

  const safeCut = safePosition(limit);
  const slice = text.slice(0, safeCut);

  // Prefer a clean boundary (at least 30% through the budget)
  const minBreak = safeCut * 0.3;

  const paraBreak = slice.lastIndexOf('\n\n');
  if (paraBreak > minBreak) {
    return text.slice(0, paraBreak).trimEnd() + ellipsis;
  }

  const lineBreak = slice.lastIndexOf('\n');
  if (lineBreak > minBreak) {
    return text.slice(0, lineBreak).trimEnd() + ellipsis;
  }

  const wordBreak = slice.lastIndexOf(' ');
  if (wordBreak > minBreak) {
    return text.slice(0, wordBreak).trimEnd() + ellipsis;
  }

  return slice.trimEnd() + ellipsis;
}

/**
 * Hard-truncate markdown to a strict character budget (e.g. Jira's 32,767-char rich-text limit,
 * CONTENT_LIMIT_EXCEEDED, probed; Jira counts a wiki-like form, see `jiraLengthLowerBound` in
 * `core/src/profiles/jira.ts`). Nothing on the review path calls this: draftgate never truncates a
 * message.
 *
 * Unlike `truncateMarkdown`, this keeps the head of an oversized fenced code block (the usual case is
 * a pasted log in one fence), prefers a line boundary near the budget, and re-closes a fence the cut
 * left open so the ADF converter still produces a codeBlock. No ellipsis: callers add their own notice.
 */
export function truncateMarkdownToLimit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Prefer a line boundary in the back half of the budget.
  const lastNewline = text.lastIndexOf('\n', maxLen);
  const cut = lastNewline > maxLen * 0.5 ? lastNewline : maxLen;
  let slice = text.slice(0, cut);

  // Re-close a fenced code block the cut left open (odd number of ``` fences).
  const fenceCount = slice.split('```').length - 1;
  if (fenceCount % 2 === 1) {
    slice = slice.trimEnd() + '\n```';
  }

  return slice;
}
