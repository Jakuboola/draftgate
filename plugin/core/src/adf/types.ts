/**
 * Atlassian Document Format (ADF) type definitions and converter map types.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

/** Media UUID or composite key → resolved asset URL (or URL + filename hint) */
type MediaMapEntry = string | { url: string; filename: string };
export type MediaMap = Record<string, MediaMapEntry>;
