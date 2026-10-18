/**
 * The rule that decides what the round trip CHANGED: `silencedWarnings`.
 *
 * Pure, so it is tested here rather than through a mounted tree; the row it draws is in
 * `window.test.tsx` under "the round trip cannot change the draft invisibly", which is also where
 * the checklist case is pinned end to end.
 *
 * The two halves are worth separating because this one has to be right for the window to be honest
 * at all. The window judges and sends the body it displays, which means it can change a draft
 * nobody asked it to change -- and the only thing standing between that and a silent
 * rewrite is this function plus the field it feeds.
 */

import { describe, expect, test } from 'bun:test';
import { silencedWarnings } from './src/useReview';
import { render, baselineFor, WARNING_CODES, type Warning } from '../core/src/index';

// Fabricated codes: these tests exercise SET operations over warnings, not codes, so the cast is
// the honest spelling of "any code will do here".
const w = (code: string, severity: Warning['severity'], message = code): Warning => ({
  code: code as Warning['code'], severity, message,
});

/**
 * Load a draft exactly the way `useReview` does, and answer with every half a test here needs.
 *
 * ONE model of that load path, so a change to it (a second `render`, of the shown body, say) lands
 * everywhere at once. Three call sites spelling it out separately would let a missed one silently
 * stop exercising the real thing.
 *
 * `baselineFor` is `core`'s own pairing of the two round-trip legs -- the same call the window
 * makes -- so this cannot drift from it by composing the legs differently.
 */
const loaded = (canonical: string, dest: string) => {
  const parsed = render(canonical, dest);
  const { doc, body } = baselineFor(parsed);
  const shownRender = render(body, dest);
  return {
    parsed,
    doc,
    shown: body,
    shownRender,
    canonicalWarnings: parsed.warnings,
    silencedAtLoad: silencedWarnings(parsed.warnings, shownRender.warnings),
  };
};

describe('what the round trip silenced', () => {
  test('a code the shown body no longer has is reported', () => {
    const canonical = [w('jira/task-item-media-only', 'warning'), w('jira/external-image-embedded', 'info')];
    const shown = [w('jira/external-image-embedded', 'info')];
    expect(silencedWarnings(canonical, shown).map((x) => x.code)).toEqual([
      'jira/task-item-media-only',
    ]);
  });

  test('nothing is reported when the two agree', () => {
    const both = [w('jira/external-image-embedded', 'info')];
    expect(silencedWarnings(both, both)).toEqual([]);
  });

  test('a code the shown body GAINED is not reported -- this is one-directional', () => {
    // The question is "what stopped being true", not "what changed". A warning the shown body has
    // is a live warning and belongs in the list above, which already draws it.
    expect(silencedWarnings([], [w('body/empty', 'error')])).toEqual([]);
  });

  test('the objects reported are the CANONICAL ones, by identity', () => {
    // Identity, not equality: the row renders `message`, and the message that describes the agent's
    // draft is the one on the canonical warning. Rebuilding it here would be inventing wording.
    const canonical = [w('slack/image-becomes-link', 'warning', 'the agent-side message')];
    const out = silencedWarnings(canonical, []);
    expect(out[0]).toBe(canonical[0]!);
  });

  test('two firings of one code report once', () => {
    // `AuditRecord.warnings` keeps duplicates because the count is the signal there. Here it is one
    // thing to tell the reviewer, and two identical rows would read as two different problems.
    const canonical = [w('jira/task-item-media-only', 'warning'), w('jira/task-item-media-only', 'warning')];
    expect(silencedWarnings(canonical, [])).toHaveLength(1);
  });

  test('severity order is preserved, because `allWarnings` already ranked them', () => {
    const canonical = [w('a/err', 'error'), w('a/warn', 'warning'), w('a/info', 'info')];
    expect(silencedWarnings(canonical, []).map((x) => x.code as string)).toEqual(['a/err', 'a/warn', 'a/info']);
  });

  test('a BLOCKING code can be silenced, and is reported like any other', () => {
    // A fuzz of 18,000 document-destination pairs reaches it 46 times, all degenerate whitespace,
    // with two codes (`jira/empty-body`, `jira/blockquote-child-rejected`). Approve goes live because
    // the body being SENT is genuinely fine -- Jira accepted each distinct shown body when probed --
    // so the reviewer can send a draft whose canonical form would be refused. That is only
    // defensible because the code is still reported, which is this line.
    expect(silencedWarnings([w('jira/blockquote-child-rejected', 'error')], []).map((x) => x.code))
      .toEqual(['jira/blockquote-child-rejected']);
  });
});

/**
 * The eight codes, computed rather than asserted from a list.
 *
 * `WARNING_CODES` declares them and this derives them, so the declaration and the code cannot
 * drift: add a warning whose subject the round trip removes and this test says so.
 */
describe('which codes the round trip actually silences', () => {
  const CASES: [string, string][] = [
    ['jira', '- [ ] ![i](https://e.test/a.png)\n- [ ] a normal item\n'],
    ['slack', 'Look ![x](https://example.com/a.png) here\n'],
    ['slack', 'See https://example.com/a\nnext line\n'],
    ['slack', 'See https://example.org/a/b/c/d/e\n\ntail\n'],
    ['jira', 'Look ![x](https://example.com/a.png) here\n'],
    ['linear', 'Look ![x](https://example.com/a.png) here\n'],
    ['jira', 'Intro.\n\n> ## Heading in a quote\n'],
    ['slack', '## Two\n\n### Three\n'],
    // Loading the draft applies the un-nesting the warning discloses, so the code is true of
    // `canonical` and not of the shown body. Every code needs a case here: with no nested checklist
    // in this list, the derived set could not contain the code and the comparison below would agree
    // with a registry that is wrong.
    ['jira', '- [ ] a\n  - b\n'],
    // Loading a Jira draft strips the emphasis off a code span, because ADF has no spelling for it
    // (Jira answers 400), so the code is true of `canonical` and not of the body shown.
    ['jira', 'a **`x` and words** b\n'],
    // The same class as the nested checklist: loading the draft moves the quote out of the item,
    // which is what the warning discloses.
    ['jira', '- a\n  > quoted\n- b\n'],
    // The Slack twin of the one above: loading moves the code block out of the item.
    ['slack', '- a\n  ```\n  x\n  ```\n- b\n'],
  ];

  const silencedFor = (dest: string, canonical: string) =>
    loaded(canonical, dest).silencedAtLoad.map((x) => x.code);

  test('exactly eight, across every probe this repo has -- and the registry says the same eight', () => {
    const all = new Set(CASES.flatMap(([d, b]) => silencedFor(d, b)));
    expect([...all].sort()).toEqual([
      'jira/code-span-emphasis-lost',
      'jira/list-item-block-moved-out',
      'jira/task-item-media-only',
      'jira/task-item-nested-list-unnested',
      'slack/image-becomes-link',
      'slack/list-item-block-moved-out',
      'slack/url-label-elided',
      'slack/url-swallows-next-line',
    ]);
    // `WARNING_CODES` carries this as a column, so the window's "which codes can land in
    // `silenced`" is a typed fact rather than a sentence in CLAUDE.md. Derived here, declared there,
    // and this is what stops the two drifting.
    const declared = Object.entries(WARNING_CODES)
      .filter(([, spec]) => 'silencedByRoundTrip' in spec)
      .map(([code]) => code)
      .sort();
    expect(declared).toEqual([...all].sort());
  });

  test('the checklist case, which is why the row is not optional', () => {
    // Two checkboxes in, one checkbox and a loose image out -- and the warning that says so is the
    // one silenced. The reader sees WORSE here, which is why none of these may be classified as
    // improvements.
    const canonical = '- [ ] ![i](https://e.test/a.png)\n- [ ] a normal item\n';
    expect(loaded(canonical, 'jira').shown).toBe(
      '- [ ] a normal item\n\n![i](https://e.test/a.png)\n'
    );
    expect(silencedFor('jira', canonical)).toEqual(['jira/task-item-media-only']);
  });

  test('a draft the round trip does not touch silences nothing', () => {
    expect(silencedFor('jira', 'Plain prose, nothing to convert.\n')).toEqual([]);
    expect(silencedFor('slack', '## Two\n\n### Three\n')).toEqual([]);
  });
});

/**
 * WHOSE work the row reports -- the one thing this function can get wrong without failing loudly.
 *
 * The set operation is only half the rule. The candidates it is applied to decide the ATTRIBUTION,
 * and `canonical`'s warnings are the wrong candidates: the reviewer's own editing also removes
 * codes from the live list, so `canonical` minus live credits draftgate with a human's repair.
 * Shown below with a real body through the real profile.
 *
 * It matters beyond the screen. The heading over these rows says "draftgate rewrote the draft when
 * it loaded", the codes ride the approval as `HumanDecision.silenced`, and `draftgate digest`
 * prints them under a column whose own note reads "the reviewer was NOT shown the warning". That is
 * `AuditRecord.silenced`'s documented corruption in mirror image -- and unlike the version it
 * mirrors, nothing downstream can detect it.
 */
describe('the row reports what DRAFTGATE changed, never what the reviewer did', () => {
  /*
   * A Slack heading ladder SURVIVES the round trip, so draftgate silences nothing on load. That is
   * what makes it the case that separates the two candidate sets: any body where the round trip
   * already did something cannot tell them apart.
   *
   * `h3`/`h4`, not `h2`/`h3`. Slack has two heading SIZES but three renderings -- `##` is
   * `level_2` at 900 and `###`..`######` are `level_3` at 700, read off the live DOM -- so
   * `## / ###` does not collapse and would not produce the code this needs. The first assertion
   * below is what notices that.
   */
  const LADDER = '### Three\n\n#### Four\n';
  const FLAT = '### Three\n\n### Also three\n';

  test('the fixture silences nothing at load, which is what makes this test able to fail', () => {
    const { canonicalWarnings, silencedAtLoad } = loaded(LADDER, 'slack');
    expect(canonicalWarnings.map((x) => x.code)).toEqual(['slack/heading-level-collapsed']);
    expect(silencedAtLoad).toEqual([]);
  });

  test("a warning the REVIEWER edits away is not reported as draftgate's rewrite", () => {
    const { silencedAtLoad } = loaded(LADDER, 'slack');
    const afterTheirEdit = render(FLAT, 'slack');
    expect(afterTheirEdit.warnings).toEqual([]);
    // The candidates are what the round trip removed, which is nothing.
    expect(silencedWarnings(silencedAtLoad, afterTheirEdit.warnings)).toEqual([]);
  });

  test('and the candidate set that WOULD misreport it, so this cannot regress quietly', () => {
    const { canonicalWarnings } = loaded(LADDER, 'slack');
    const afterTheirEdit = render(FLAT, 'slack');
    // `canonical` minus live names the reviewer's own repair.
    expect(silencedWarnings(canonicalWarnings, afterTheirEdit.warnings).map((x) => x.code)).toEqual([
      'slack/heading-level-collapsed',
    ]);
  });

  test('what the round trip DID silence is still reported after an unrelated edit', () => {
    // The narrowing must not throw the real answer away. Slack rewrites the image to a link on
    // load, and editing the prose around it changes nothing about that.
    const { silencedAtLoad } = loaded('Look ![x](https://e.test/a.png) here\n', 'slack');
    expect(silencedAtLoad.map((x) => x.code)).toEqual(['slack/image-becomes-link']);
    const edited = render('Look [x](https://e.test/a.png) here, and more prose.\n', 'slack');
    expect(silencedWarnings(silencedAtLoad, edited.warnings).map((x) => x.code)).toEqual([
      'slack/image-becomes-link',
    ]);
  });

  test('and a code the reviewer brings BACK stops being reported, which needs the live half', () => {
    const { silencedAtLoad } = loaded('Look ![x](https://e.test/a.png) here\n', 'slack');
    // An editor on Slack cannot hold an image, but the CLI judges whatever body arrives -- and this
    // is the property the second application exists for, so it is asserted on the function.
    const back = render('Look ![x](https://e.test/a.png) here, edited.\n', 'slack');
    expect(back.warnings.map((x) => x.code)).toContain('slack/image-becomes-link');
    expect(silencedWarnings(silencedAtLoad, back.warnings)).toEqual([]);
  });
});
