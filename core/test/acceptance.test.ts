/**
 * Acceptance rules markdown input cannot reach.
 *
 * Three of the Jira profile's ADF nesting rules are unexercised from markdown: the converter moves
 * block content out of list items, has no syntax for `panel`, and only puts paragraphs in table
 * cells (probed). They are tested here against hand-built ADF, since an ADF body given directly can
 * produce all three.
 */

import { describe, expect, test } from 'bun:test';
import { jiraProfile } from '../src/profiles/jira';
import { render } from '../src/render';
import { fixture } from './golden';
import { JSM_BLOCKQUOTE_ALLOWED, walk } from '../src/adfSchema';
import type { AdfDocument } from '../src/adf/types';

const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });

describe('markdown cannot reach these rules (documented, not assumed)', () => {
  test('block content indented under a list item moves out of the list, and is not rejected', () => {
    // Jira refuses a table or heading in a list item (400), so the converter sends each just after
    // its item and says so.
    const r = render(fixture('list-item-hostile.md'), 'jira');
    const content = (r.converted as AdfDocument).content;
    expect(content.map((n) => n.type)).toEqual(['orderedList', 'table', 'orderedList', 'heading']);
    walk(r.converted as AdfDocument, (n) => {
      if (n.type === 'listItem') expect((n.content ?? []).map((c) => c.type)).toEqual(['paragraph']);
    });
    expect(r.warnings.map((w) => w.code)).toEqual(['jira/list-item-block-moved-out']);
    expect(r.blocked).toBe(false);
  });

  test('the converter never emits a panel from markdown', () => {
    const r = render('Some text\n\n> quoted\n\n- item\n', 'jira');
    expect(JSON.stringify(r.converted)).not.toContain('"panel"');
  });
});

describe('rules reachable only by an ADF body given directly', () => {
  // These assert the RULE SETS are correct, sourced, and complete. The walk that applies them
  // is exercised by the blockquote case in render.test.ts, which markdown can reach.

  test('JSM blockquote allow-list matches the empirically probed set exactly', () => {
    // The set read out of core, against the probe: all six together return 201, and `heading`,
    // `table`, `rule`, `taskList`, `panel`, `expand` and a nested `blockquote` each return 400,
    // losing the whole comment. Change it only on a fresh probe.
    expect([...JSM_BLOCKQUOTE_ALLOWED].sort()).toEqual([
      'bulletList',
      'codeBlock',
      'mediaGroup',
      'mediaSingle',
      'orderedList',
      'paragraph',
    ]);
  });

  test('every allowed child passes the rule, and none of them is flagged', () => {
    const doc: AdfDocument = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          // Built from the set, so a node added to it is exercised here.
          content: [...JSM_BLOCKQUOTE_ALLOWED].map((type) =>
            type === 'paragraph' ? para('allowed') : { type, content: [] }
          ),
        },
      ],
    };
    expect(collectBlockquoteRejections(doc)).toEqual([]);
  });

  test('every non-allowed blockquote child is flagged as an error', () => {
    for (const bad of ['heading', 'table', 'panel', 'expand', 'rule', 'taskList', 'blockquote']) {
      expect(JSM_BLOCKQUOTE_ALLOWED.has(bad), `${bad} is supposed to be rejected`).toBe(false);
      const doc: AdfDocument = {
        version: 1,
        type: 'doc',
        content: [{ type: 'blockquote', content: [{ type: bad, content: [] }] }],
      };
      expect(collectBlockquoteRejections(doc)).toEqual([bad]);
    }
  });

  /**
   * The local walk against the profile, for every shape markdown can reach: the profile's answer is
   * the oracle (same node type, `error`, its code).
   */
  test('the local walk agrees with the profile wherever markdown can reach the shape', () => {
    const reachable: [string, string][] = [
      ['heading', '> # Heading in a quote\n'],
      ['table', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n'],
      ['rule', '> text\n>\n> ---\n'],
      ['taskList', '> - [ ] a task\n'],
      ['blockquote', '> > nested\n'],
    ];
    for (const [type, markdown] of reachable) {
      const r = render(markdown, 'jira');
      const flagged = r.warnings.filter((w) => w.code === 'jira/blockquote-child-rejected');
      expect(flagged.map((w) => w.nodeType), markdown).toContain(type);
      expect(flagged.every((w) => w.severity === 'error'), markdown).toBe(true);
      expect(r.blocked, markdown).toBe(true);
      // The same document through the local walk.
      expect(collectBlockquoteRejections(r.converted as AdfDocument)).toContain(type);
    }
  });
});

/**
 * Apply the blockquote rule to a hand-built document. Local because the profile's surface is
 * `convert(markdown)`; reads `JSM_BLOCKQUOTE_ALLOWED` and `walk`, not copies.
 */
function collectBlockquoteRejections(doc: AdfDocument): string[] {
  const out: string[] = [];
  walk(doc, (node, _path, parent) => {
    if (parent?.type === 'blockquote' && !JSM_BLOCKQUOTE_ALLOWED.has(node.type)) out.push(node.type);
  });
  return out;
}

describe('profile contract', () => {
  test('declares the fields that locating the target and substituting the body both need', () => {
    expect(jiraProfile.mode).toBe('convert-and-replace');
    expect(jiraProfile.bodyField).toBe('commentBody');
    expect(jiraProfile.contextFields).toContain('cloudId');
    // cloudId is required by addCommentToJiraIssue.
    expect(jiraProfile.extraToolInput.contentFormat).toBe('adf');
  });
});
