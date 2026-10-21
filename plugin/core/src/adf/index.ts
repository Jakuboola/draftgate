/**
 * ADF ↔ Markdown conversion module, a standalone library.
 *
 * Pure: no I/O, so every lookup (the media map)
 * must be pre-resolved by callers before invoking these functions.
 */

export { convertAdfToMarkdown } from './adfToMarkdown';
export { convertMarkdownToAdf } from './markdownToAdf';
export { truncateMarkdown, truncateMarkdownToLimit } from './truncate';
export { sanitizeAdfForJsm } from './sanitizeBlockquote';

// Types
export type {
  AdfNode,
  AdfDocument,
  AdfMark,
  MediaMap,
} from './types';

// Utilities and constants (for callers preparing input before conversion)
export {
  stripFilenameUuid,
  parseJiraWikiLink,
  isImageReference,
  escapeRegex,
  escapeTableCell,
  collectMediaNodes,
  JIRA_ATTACHMENT_SCHEME,
} from './util';
