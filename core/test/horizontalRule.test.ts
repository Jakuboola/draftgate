/**
 * The horizontal-rule test. A pattern like `/^(\s*[-*_]\s*){3,}$/` backtracks exponentially on a
 * short line like `- - - ... x`, and `render()` runs before draftgate's own deadline timer exists,
 * so a stall there runs into Claude Code's hook timeout, which fails OPEN.
 */

import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { baselineFor } from '../src/editor';
import { profiles, type DestinationName } from '../src/index';

describe('a near-rule line is linear, not exponential', () => {
  // Many lines rather than one longer one: on Bun the exponential per-line cost stops growing at
  // about 30 markers. With an exponential pattern this body takes tens of seconds; the linear test
  // takes a millisecond.
  const BUDGET_MS = 2000;
  const line = (marker: string) => `${marker} `.repeat(30) + 'x';
  const body = ['-', '*', '_'].flatMap((m) => Array(10).fill(line(m))).join('\n\n') + '\n';
  for (const destination of Object.keys(profiles) as DestinationName[]) {
    test(`${destination}: renders and loads in under ${BUDGET_MS} ms`, () => {
      const started = performance.now();
      baselineFor(render(body, destination));
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  }
});

describe('what is a rule', () => {
  const topLevel = (body: string) =>
    (render(body, 'jira').converted as { content: { type: string }[] }).content.map((n) => n.type);

  test.each(['---', '***', '___', '_ _ _', '-----', '  ---  '])('%p is a rule', (line) => {
    expect(topLevel(`${line}\n`)).toEqual(['rule']);
  });

  // CommonMark requires ONE marker character throughout. GitHub's own renderer (POST /markdown,
  // gfm) agrees: `-*_` and `-_-` render as plain text. A pattern that accepts any marker per
  // position would make them rules.
  test.each(['-*_', '-_-', '---x', '--'])('%p is not a rule', (line) => {
    expect(topLevel(`${line}\n`)).toEqual(['paragraph']);
  });

  // The same predicate ends a paragraph, through `isBlockStart`.
  test('a rule line ends the paragraph above it, a mixed line does not', () => {
    expect(topLevel('a\n___\nb\n')).toEqual(['paragraph', 'rule', 'paragraph']);
    expect(topLevel('a\n-*_\nb\n')).toEqual(['paragraph']);
  });

  // A rule wins over a bullet item, as in CommonMark. GitHub's renderer (POST /markdown,
  // gfm) draws every one of these as the same list / <hr> / list split.
  test.each([
    ['- - -\n', ['rule']],
    ['* * *\n', ['rule']],
    ['- a\n- - -\n- b\n', ['bulletList', 'rule', 'bulletList']],
    ['- a\n* * *\n', ['bulletList', 'rule']],
  ])('%p: the rule is not a list item', (body, types) => {
    expect(topLevel(body)).toEqual(types);
  });

  // The body SENT: a spaced divider read as a bullet would go out as `- * *`.
  for (const destination of Object.keys(profiles) as DestinationName[]) {
    test(`${destination}: a spaced divider is sent as a rule`, () => {
      expect(baselineFor(render('a\n\n* * *\n\nb\n', destination)).body).toBe('a\n\n---\n\nb\n');
      expect(baselineFor(render('- a\n- - -\n- b\n', destination)).body).toBe('- a\n\n---\n\n- b\n');
    });
  }

  // A bullet whose text is only dashes must not be WRITTEN as `- --`, which is a rule on GitHub and
  // here. The writer uses `*` for it.
  for (const destination of Object.keys(profiles) as DestinationName[]) {
    test(`${destination}: a bullet of dashes stays a bullet`, () => {
      const shown = baselineFor(render('- a\n* --\n', destination));
      expect(shown.body).toBe('- a\n* --\n');
      const sent = render(shown.body, destination, shown.doc);
      expect(sent.warnings).toEqual([]);
    });
  }

  test('jira: a bullet of dashes is sent as a bullet', () => {
    const shown = baselineFor(render('* --\n', 'jira'));
    expect(topLevel(shown.body)).toEqual(['bulletList']);
  });

  // Slack's checklist scan reads a divider as a divider too, or it names `* *` as a bullet that
  // will become a to-do, and that line is no bullet.
  test('slack: a divider in a checklist run is not a coerced bullet', () => {
    expect(render('- [ ] a\n* * *\n- b\n', 'slack').warnings).toEqual([]);
  });
});
