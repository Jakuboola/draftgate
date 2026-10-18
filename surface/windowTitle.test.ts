/**
 * The OS title bar's text, and the one drift risk in it.
 *
 * `surface/windowTitle.cjs` splits an MCP name the same way `adapters/hook/src/toolMap.ts` does.
 * That is a second spelling of one rule, which drifts silently -- so the table goes through BOTH
 * and fails if they ever disagree. The two cannot share code: one is CommonJS the WebKit host loads
 * into JavaScriptCore, the other TypeScript in the adapter, exactly the boundary
 * `decisionFields.test.ts` sits across.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { toolHalfOf } from '../adapters/hook/src/toolMap';

const require = createRequire(import.meta.url);
const { toolHalf, windowTitle } = require('./windowTitle.cjs') as {
  toolHalf: (name?: string) => string;
  windowTitle: (destination: string, toolName?: string) => string;
};

describe('the window title', () => {
  test('names the tool, because the window itself does not', () => {
    // The tool half, so a long MCP name does not crowd out the part a reviewer is checking.
    expect(windowTitle('jira', 'mcp__claude_ai_Atlassian_Rovo__editJiraIssue')).toBe(
      'draftgate review → jira · editJiraIssue'
    );
  });

  test('a review with no tool name is just the destination', () => {
    // A direct CLI run has no originating tool, and a trailing separator would name nothing.
    for (const missing of [undefined, '', null as unknown as string]) {
      expect(windowTitle('slack', missing)).toBe('draftgate review → slack');
    }
  });

  test('a non-MCP name is used whole', () => {
    expect(windowTitle('linear', 'some_local_tool')).toBe('draftgate review → linear · some_local_tool');
  });
});

describe('its split agrees with the tool map, which is the canonical one', () => {
  const NAMES = [
    'mcp__claude_ai_Atlassian_Rovo__editJiraIssue',
    'mcp__atlassian__addCommentToJiraIssue',
    'mcp__linear-server__save_comment',
    'mcp__jsm__jira_add_internal_note',
    'mcp__claude_ai_Slack__slack_send_message',
  ];

  test.each(NAMES)('%s splits the same way in both', (name) => {
    expect(toolHalf(name)).toBe(toolHalfOf(name)!);
  });

  test('and both leave a non-MCP name alone, by their own routes', () => {
    // `toolHalfOf` answers null (not an MCP name); the title uses the name whole. Different
    // answers to different questions -- pinned so a reader does not take the divergence for drift.
    expect(toolHalfOf('Bash')).toBeNull();
    expect(toolHalf('Bash')).toBe('Bash');
  });
});
