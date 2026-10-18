/**
 * Failures that are invisible to a test of one module: a payload cut by a pipe, a timer that wraps,
 * an approval lost to a bad `--out`, media in a place Jira refuses, an image decaying to a link, a
 * node type the editor cannot hold, a warning computed for the wrong body. Several need a real
 * subprocess through a real pipe: a stub of `process.stdout.write` never exercises the asynchronous
 * path where a payload is truncated.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, ArgError, MAX_TIMEOUT_MS } from '../src/args';
import { runReview } from '../src/review';
import { autoApprove } from '../src/surfaces/autoApprove';
import {
  render, toEditorDoc, fromEditorDoc, editorDocToAdf,
  illegalMediaPlacements, nodeTypes, PM_KNOWN,
} from '../../core/src/index';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-regr-'));
// Removed after the run, like every suite's scratch directory: `test/tempDirs.test.ts` is the guard.
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const REPO = join(import.meta.dir, '..', '..');

describe('a piped payload must not be truncated', () => {
  // process.exit() before the stdout write drains cuts the JSON at the 128 KB pipe buffer: exactly
  // 131072 bytes of invalid JSON.
  test('a 260 KB payload survives a real pipe intact', () => {
    const big = join(dir, 'big.json');
    // GitHub, because every destination refuses a body past its probed length, and GitHub's
    // 262,144 bytes is the only limit well above the 128 KB buffer this is about.
    const body = 'x'.repeat(260_000);
    writeFileSync(big, JSON.stringify({ owner: 'Jakuboola', repo: 'draftgate', issue_number: 1, body }));

    const r = spawnSync(
      'sh',
      ['-c', `bun cli/src/main.ts review --dest github --in ${big} --surface auto-approve --no-audit | cat`],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(260_000);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.body).toHaveLength(260_000);
  }, 30_000);
});

describe('--timeout cannot overflow the timer', () => {
  // setTimeout's delay is a signed 32-bit int; beyond that it wraps and fires at once, denying.
  test('a value past the 32-bit limit is rejected at parse time', () => {
    expect(() => parseArgs(['review', '--dest', 'jira', '--in', 'p', '--timeout', '2500000'])).toThrow(ArgError);
  });
  test('the largest accepted value still fits in the timer', () => {
    const a = parseArgs(['review', '--dest', 'jira', '--in', 'p',
                         '--timeout', String(Math.floor(MAX_TIMEOUT_MS / 1000))]);
    expect(a.timeoutMs!).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
  });
  test('an ordinary value is untouched', () => {
    expect(parseArgs(['review', '--dest', 'jira', '--in', 'p', '--timeout', '600']).timeoutMs).toBe(600_000);
  });
});

describe('an approved payload is never lost to a bad --out', () => {
  test('an unwritable --out falls back to stdout instead of crashing', () => {
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ issueId: 'HELP-42', body: 'hello' }));
    const r = spawnSync(
      'bun',
      ['cli/src/main.ts', 'review', '--dest', 'linear', '--in', p,
       '--surface', 'auto-approve', '--no-audit', '--out', '/nope/nowhere/x.json'],
      { cwd: REPO, encoding: 'utf8' }
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).body).toBe('hello');
    expect(r.stderr).toContain('could not write --out');
  }, 20_000);
});

describe('mediaSingle is hoisted out of paragraphs in EVERY container', () => {
  // Probed against Jira:
  //   listItem > paragraph > [text, mediaSingle]  ->  400 INVALID_INPUT, whole comment lost
  //   listItem > [paragraph, mediaSingle]         ->  201
  const containers: [string, string][] = [
    ['list item', '- item with ![pic](https://example.com/a.png)\n'],
    ['task item', '- [ ] task with ![pic](https://example.com/a.png)\n'],
    ['blockquote', '> quoted ![pic](https://example.com/a.png)\n'],
    ['table cell', '| a |\n| --- |\n| ![pic](https://example.com/a.png) |\n'],
    ['top level', 'before ![pic](https://example.com/a.png) after\n'],
  ];

  // hoistMedia's invariant, through core's own checker: every inline-only container.
  const nested = (doc: unknown) => illegalMediaPlacements(doc as any);

  for (const [label, md] of containers) {
    test(`${label}: render() emits no media inside a paragraph`, () => {
      expect(nested(render(md, 'jira').converted)).toEqual([]);
    });
    test(`${label}: the editor round trip emits none either`, () => {
      expect(nested(editorDocToAdf(toEditorDoc(md)))).toEqual([]);
    });
  }

  test('media bubbles OUT of an inline-only container, past the list wrapper', () => {
    // Probed: taskItem > [text, mediaSingle] is also a 400. A taskItem has no legal position for
    // media and taskList accepts only taskItem, so it rises to a container that takes blocks.
    const adf: any = render('- [ ] task with ![p](https://example.com/a.png)\n', 'jira').converted;
    const types = adf.content.map((n: any) => n.type);
    expect(types).toContain('taskList');
    expect(types).toContain('mediaSingle');
    // The media is a sibling of the taskList, not inside it.
    const taskList = adf.content.find((n: any) => n.type === 'taskList');
    expect(JSON.stringify(taskList)).not.toContain('mediaSingle');
    expect(render('- [ ] task with ![p](https://example.com/a.png)\n', 'jira').blocked).toBe(false);
  });

  test('a heading gives up its media too', () => {
    // heading > [text, mediaSingle] is a verified 400.
    const adf: any = render('## head ![p](https://example.com/a.png)\n', 'jira').converted;
    const heading = adf.content.find((n: any) => n.type === 'heading');
    expect(JSON.stringify(heading)).not.toContain('mediaSingle');
    expect(adf.content.map((n: any) => n.type)).toContain('mediaSingle');
  });

  test('splitting a paragraph preserves the image position, not just the text', () => {
    // Merging the surrounding text into one paragraph and appending the image would silently move
    // it to the end.
    const adf: any = render('before ![p](https://example.com/a.png) after\n', 'jira').converted;
    expect(adf.content.map((n: any) => n.type)).toEqual(['paragraph', 'mediaSingle', 'paragraph']);
    expect(adf.content[0].content[0].text).toContain('before');
    expect(adf.content[2].content[0].text).toContain('after');
  });

  test('an empty body still yields the one block ADF requires', () => {
    // Splitting must not filter away the deliberately-empty paragraph the converter emits.
    expect((render('', 'jira').converted as any).content).toEqual([{ type: 'paragraph', content: [] }]);
  });

  test('a block node inside a paragraph is BLOCKED, not silently accepted', () => {
    // Built by hand: the hoist prevents this shape, so nothing should produce it.
    const bad: any = { version: 1, type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'x' },
        { type: 'mediaSingle', attrs: { layout: 'center' }, content: [
          { type: 'media', attrs: { type: 'external', url: 'https://example.com/a.png' } }] },
      ] },
    ] };
    const nestedCount = nested(bad).length;
    expect(nestedCount).toBe(1);
  });
});

describe('an image URL without a file extension survives an edit', () => {
  const cases = [
    'https://example.com/timeline',
    'https://example.com/render?id=7',
    'https://cdn.example.com/v2/abc123def',
  ];
  for (const url of cases) {
    test(url, () => {
      const back = fromEditorDoc(toEditorDoc(`![diagram](${url})`));
      // Must stay an image (`![...]`), not decay to a plain link (`[...]`).
      expect(back).toContain(`![diagram](${url})`);
    });
  }
  test('a normal .png is unaffected', () => {
    expect(fromEditorDoc(toEditorDoc('![d](https://example.com/a.png)'))).toContain('![d](https://example.com/a.png)');
  });
});

describe('the editor never receives an unregistered node type', () => {
  const unknownTypes = (doc: unknown): string[] =>
    [...nodeTypes(doc as any)].filter((t) => !PM_KNOWN.has(t));

  test('a pasted unified-diff header does not produce an `expand`', () => {
    // The converter turns any `+++` line into an expand block, and ProseMirror throws on an
    // unregistered type.
    const doc = toEditorDoc('Here is the patch:\n\n+++ b/src/app.ts\n\nrest\n');
    expect(unknownTypes(doc)).toEqual([]);
    // The degraded container must keep its title text rather than drop it.
    expect(JSON.stringify(doc)).toContain('b/src/app.ts');
  });

  test('the torture fixture produces only registered types', () => {
    expect(unknownTypes(toEditorDoc(readFileSync(join(REPO, 'docs/torture-fixture.md'), 'utf8')))).toEqual([]);
  });
});

describe('an edit is re-rendered, so warnings are never stale', () => {
  // A surface that reuses the original render after an edit lets a reviewer add a Jira-fatal
  // blockquote heading, see "no warnings", approve, and only then be refused.
  test('rendering the edited body reflects the edit', async () => {
    const original = 'All fine here.\n';
    const edited = '> ## Heading in a quote\n';
    expect(render(original, 'jira').blocked).toBe(false);
    expect(render(edited, 'jira').blocked).toBe(true);

    // The orchestration refuses the approval whatever the surface displayed.
    const out = await runReview({
      destination: 'jira',
      toolInput: { cloudId: 'c', issueIdOrKey: 'K', commentBody: original },
      surface: autoApprove({ commentBody: edited }),
    });
    expect(out.exitCode).toBe(1);
  });
});
