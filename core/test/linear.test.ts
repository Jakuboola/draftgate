/**
 * Linear profile tests, a tripwire: Linear needs no conversion and emits no warnings.
 *
 * Probed: the torture fixture sent to a scratch Linear issue and read back through `list_comments`
 * and the GraphQL API was stored byte-identically apart from a trailing newline.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { linearProfile } from '../src/profiles/linear';
import { expectGolden, tortureFixture } from './golden';

describe('linear profile contract', () => {
  test('preview-only, because markdown is the only writable format', () => {
    expect(linearProfile.mode).toBe('preview-only');
    expect(linearProfile.bodyField).toBe('body');
    expect(linearProfile.extraToolInput).toEqual({});
  });

  test('context fields cover all six mutually exclusive parents, plus reply and update', () => {
    // `issueId` alone would fail to surface routing for a comment aimed at a project, initiative,
    // document, milestone or status update.
    for (const f of [
      'issueId', 'projectId', 'initiativeId', 'documentId', 'milestoneId', 'statusUpdateId',
      'parentId', 'id',
    ]) {
      expect(linearProfile.contextFields).toContain(f);
    }
  });
});

describe('conversion is the identity function (VERIFIED)', () => {
  test('the torture fixture passes through unchanged', () => {
    const src = tortureFixture();
    const r = render(src, 'linear');
    expect(r.converted).toBe(src);
    expect(r.canonical).toBe(src);
  });

  test('no warnings, and never blocked', () => {
    const r = render(tortureFixture(), 'linear');
    expect(r.warnings).toEqual([]);
    expect(r.blocked).toBe(false);
  });

  test('golden, so a future Linear behaviour change is visible in a diff', () => {
    const r = render(tortureFixture(), 'linear');
    expectGolden('torture-fixture.linear.json', {
      converted: r.converted,
      warnings: r.warnings,
      blocked: r.blocked,
    });
  });

  test('the fixture survives byte-identically', () => {
    const got = render(tortureFixture(), 'linear').converted as string;
    // Each confirmed intact in the stored Linear comment, cross-checked against raw GraphQL.
    for (const fragment of [
      '| 09:12 | Alert fired | Jakub |',
      '# Deploy postmortem',
      '- [x] Checked task',
      '---',
      '```python',
      '1. Checked the queue table',
      '![image](https://example.com/a.png)',
    ]) {
      expect(got).toContain(fragment);
    }
  });

  test('a blockquoted heading is fine here, and fatal on Jira', () => {
    // Jira 400s on this and loses the entire comment; Linear stores it as written.
    const md = '> ## Heading in a quote\n';
    expect(render(md, 'linear').blocked).toBe(false);
    expect(render(md, 'linear').converted).toBe(md);
    expect(render(md, 'jira').blocked).toBe(true);
  });
});

describe('all three destinations, same input', () => {
  test('a table is fine on all three', () => {
    // Slack's rendered client shows a real table. Do not judge this from slack_read_channel: it
    // flattens Block Kit to text, and the table reads as lost.
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    expect(render(table, 'jira').blocked).toBe(false);   // 201, verified
    expect(render(table, 'slack').blocked).toBe(false);  // renders as a real table, verified
    expect(render(table, 'linear').blocked).toBe(false); // stored verbatim, verified
  });

  test('a heading inside a blockquote is fatal only on Jira', () => {
    // The one hard asymmetry, and the only one resting on real HTTP 400s.
    const quotedHeading = '> ## H\n';
    expect(render(quotedHeading, 'jira').blocked).toBe(true);
    expect(render(quotedHeading, 'slack').blocked).toBe(false);
    expect(render(quotedHeading, 'linear').blocked).toBe(false);
  });

  test('every registered profile declares a mode explicitly', () => {
    // A required field with no default, because convert-and-replace is possible for exactly one
    // destination. GitHub's mode is pinned in `github.test.ts`.
    const modes = [
      ['jira', 'convert-and-replace'],
      ['slack', 'preview-only'],
      ['linear', 'preview-only'],
    ] as const;
    for (const [dest, mode] of modes) {
      expect(render('x', dest).mode).toBe(mode);
    }
  });
});
