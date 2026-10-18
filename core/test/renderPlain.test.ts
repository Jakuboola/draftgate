/**
 * A body that is text, not markdown.
 *
 * Probed: Linear's `Release.description` and `Release.name` are plain `String` columns with no
 * document state, where `Issue.description` has `descriptionState`. Every assertion here is one
 * markdown affordance not offered, since each would show the reviewer something the send drops.
 */
import { describe, expect, test } from 'bun:test';
import { render, renderPlain, isPlainBody } from '../src/index';

const MARKDOWNY = '## Not a heading\n\n**not bold** and _not italic_\n\n- not a list\n';

describe('renderPlain', () => {
  test('does not CONVERT: the body is the output, byte for byte', () => {
    // `**bold**` stays eight characters: what the field stores and its reader sees.
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      const r = renderPlain(MARKDOWNY, dest);
      expect(r.converted, dest).toBe(MARKDOWNY);
      expect(r.canonical, dest).toBe(MARKDOWNY);
    }
  });

  test('offers NO toolbar, because every button would apply what is sent literally', () => {
    const r = renderPlain(MARKDOWNY, 'slack');
    expect(r.toolbar).toEqual({ headingLevels: [], marks: [], blocks: [], inserts: [] });
    // Slack's real profile has a toolbar, so the difference is the mode's.
    expect(render(MARKDOWNY, 'slack').toolbar.marks.length).toBeGreaterThan(0);
  });

  test('stamps NO extraToolInput, or Jira is told a plain string is ADF', () => {
    // `buildUpdatedInput` spreads `extraToolInput` over the payload; Jira's `contentFormat: "adf"`
    // on a plain body tells Jira to parse a string as ADF, a successful send of visible garbage.
    expect(renderPlain(MARKDOWNY, 'jira').extraToolInput).toEqual({});
    expect(render(MARKDOWNY, 'jira').extraToolInput).toEqual({ contentFormat: 'adf' });
  });

  test('is preview-only whatever the destination is, so nothing stringifies it', () => {
    // `wireBody` JSON-stringifies for `convert-and-replace`. A plain string must travel as itself.
    expect(renderPlain(MARKDOWNY, 'jira').mode).toBe('preview-only');
    expect(render(MARKDOWNY, 'jira').mode).toBe('convert-and-replace');
  });

  test('raises no markdown warnings, and offers no repair', () => {
    // Every rule in the taxonomy is about how a destination renders markdown.
    const bareUrl = 'see https://example.com/a/b/c/d/e now\n- [ ] x\n  - nested\n';
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      const r = renderPlain(bareUrl, dest);
      expect(r.warnings, dest).toEqual([]);
      expect(r.blocked, dest).toBe(false);
      expect(r.suggestedFix, dest).toBeUndefined();
    }
  });

  test('still BLOCKS an empty body, which is the one rule that is not about markdown', () => {
    // "The reviewer approved an empty message" is not a claim about rendering. A tool whose body is
    // legitimately optional says so with `bodyOptional`, which is settled before a review starts.
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      const r = renderPlain('', dest);
      expect(r.blocked, dest).toBe(true);
      expect(r.warnings.map((w) => w.code), dest).toEqual(['body/empty']);
    }
  });

  test('draws no mentions and no media, because the field renders neither', () => {
    const r = renderPlain('hi <@U0123ABCDEF> ![x](https://e.test/a.png)\n', 'slack');
    expect(r.mentions).toEqual({ tokens: null, chips: null, links: null });
    expect(r.rendersMedia).toBe(false);
  });

  test('`format` is the discriminator, and it says so directly', () => {
    // Its own field, not a value of `previewFidelity`, which says how far a stylesheet can be
    // trusted.
    for (const dest of ['jira', 'slack', 'linear'] as const) {
      expect(renderPlain('x\n', dest).format, dest).toBe('plain');
      expect(render('x\n', dest).format, dest).toBe('markdown');
      expect(isPlainBody(renderPlain('x\n', dest)), dest).toBe(true);
      expect(isPlainBody(render('x\n', dest)), dest).toBe(false);
    }
  });
});
