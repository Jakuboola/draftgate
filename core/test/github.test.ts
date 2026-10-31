/**
 * The GitHub profile, against what GitHub was probed doing. The probes are named in
 * `core/src/profiles/github.ts`: `POST /markdown` with `mode=gfm` (GitHub's own renderer), a
 * read-only sweep of `cross-referenced` timeline events on a public issue, and `tools/github-ruler/`
 * for typography. Same shape as `linear.test.ts` (identity `convert`); the only losses are HTML:
 * `github/html-stripped` and `github/html-comment-hidden`.
 */

import { describe, expect, test } from 'bun:test';
import { render, profiles, githubAudience, githubRepoKey, WARNING_CODES } from '../src/index';
import { expectGolden, tortureFixture } from './golden';
import { hiddenComments } from '../src/profiles/github';

const githubProfile = profiles.github;
const codes = (md: string) => render(md, 'github').warnings.map((w) => w.code);

describe('the profile declares what it was measured declaring', () => {
  test('preview-only, identity conversion, no delta spelling', () => {
    expect(githubProfile.mode).toBe('preview-only');
    expect(githubProfile.extraToolInput).toEqual({});
    // Read off every live schema: none carries a patch or an edit-operations array
    // (`DestinationProfile.deltaFields`).
    expect(githubProfile.deltaFields).toEqual([]);
    expect(githubProfile.bodyField).toBe('body');
  });

  test('both spellings of the thread number are context, because the connector uses both', () => {
    // The issue tools say `issue_number`, the pull-request tools `pullNumber`.
    for (const f of ['owner', 'repo', 'issue_number', 'pullNumber']) {
      expect(githubProfile.contextFields).toContain(f);
    }
  });
});

describe('the taxonomy is six codes, and that count is asserted rather than written down', () => {
  // Derived from the registry, so adding or dropping a code fails here.
  const githubCodes = Object.entries(WARNING_CODES).filter(([code]) => code.startsWith('github/'));

  test('six codes, all owned by this profile', () => {
    expect(githubCodes.map(([code]) => code).sort()).toEqual([
      'github/alert-becomes-callout',
      'github/body-too-long',
      'github/html-comment-hidden',
      'github/html-rendered',
      'github/html-stripped',
      'github/image-proxied',
    ]);
    for (const [, spec] of githubCodes) expect(spec.owner).toBe('github');
  });

  test('three info, two warnings, and one `error`: the length GitHub refuses', () => {
    // Severity lives on the emitted warning, so one body per code (which also proves each is
    // reachable). GitHub rejects no GFM structure; the one error is a 422 for length.
    const severities = new Map<string, string>();
    for (const [md] of [
      ['> [!NOTE]\n> x\n'],
      ['a <kbd>K</kbd> b\n'],
      ['a <u>x</u> b\n'],
      ['![x](https://e.test/a.png)\n'],
      ['x'.repeat(262_145)],
      ['a <!-- x --> b\n'],
    ] as [string][]) {
      for (const w of render(md, 'github').warnings) severities.set(w.code, w.severity);
    }
    expect([...severities.values()].filter((s) => s === 'info')).toHaveLength(3);
    expect([...severities.entries()].filter(([, s]) => s === 'warning').map(([c]) => c).sort()).toEqual([
      'github/html-comment-hidden',
      'github/html-stripped',
    ]);
    expect([...severities.entries()].filter(([, s]) => s === 'error')).toEqual([['github/body-too-long', 'error']]);
  });

  test('none can be silenced by the round trip, because the round trip loses none of them', () => {
    // The key's absence, not an `undefined` value: the registry omits it where the answer is no.
    for (const [code, spec] of githubCodes) {
      expect('silencedByRoundTrip' in spec, code).toBe(false);
    }
  });
});

describe('conversion is the identity function (VERIFIED)', () => {
  test('the torture fixture passes through unchanged', () => {
    const src = tortureFixture();
    const r = render(src, 'github');
    expect(r.converted).toBe(src);
    expect(r.canonical).toBe(src);
  });

  test('nothing in the torture fixture BLOCKS -- GitHub rejects no GFM structure', () => {
    // Jira 400s on a heading inside a blockquote. Warnings are expected (the fixture has an image).
    expect(render(tortureFixture(), 'github').blocked).toBe(false);
  });

  test('golden, so a future GitHub behaviour change is visible in a diff', () => {
    const r = render(tortureFixture(), 'github');
    expectGolden('torture-fixture.github.json', {
      converted: r.converted,
      warnings: r.warnings,
      blocked: r.blocked,
    });
  });

  test('a blockquoted heading is fine here, and fatal on Jira', () => {
    const md = '> ## Heading in a quote\n';
    expect(render(md, 'github').blocked).toBe(false);
    expect(render(md, 'jira').blocked).toBe(true);
  });
});

describe('alerts', () => {
  test('each of the five is reported, and the marker line is named as deliberate', () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      expect(codes(`> [!${kind}]\n> careful\n`)).toContain('github/alert-becomes-callout');
    }
  });

  test('lowercase works, because GitHub accepts it', () => {
    // Probed alongside the five: `[!note]` renders the same callout as `[!NOTE]`.
    expect(codes('> [!note]\n> careful\n')).toContain('github/alert-becomes-callout');
  });

  test('an unknown marker is NOT reported, because it stays an ordinary quote', () => {
    // Probed: `[!FOO]` renders as a plain blockquote.
    expect(codes('> [!FOO]\n> careful\n')).not.toContain('github/alert-becomes-callout');
  });

  test('a marker inside a code fence is not a marker', () => {
    const md = '```\n> [!NOTE]\n> careful\n```\n';
    expect(codes(md)).not.toContain('github/alert-becomes-callout');
  });

  test('it is INFO: the body is delivered exactly as written', () => {
    const w = render('> [!NOTE]\n> careful\n', 'github').warnings;
    expect(w.find((x) => x.code === 'github/alert-becomes-callout')?.severity).toBe('info');
    expect(render('> [!NOTE]\n> careful\n', 'github').blocked).toBe(false);
  });
});

describe('HTML, which is the one thing GitHub does that LOSES something', () => {
  test('a rendered tag is info -- the reviewer is reading source, not output', () => {
    const w = render('a <kbd>K</kbd> b\n', 'github').warnings;
    const found = w.find((x) => x.code === 'github/html-rendered');
    expect(found?.severity).toBe('info');
    expect(found?.message).toContain('<kbd>');
  });

  test('a STRIPPED tag is a warning, because the emphasis silently disappears', () => {
    const w = render('a <u>underlined</u> b\n', 'github').warnings;
    const found = w.find((x) => x.code === 'github/html-stripped');
    expect(found?.severity).toBe('warning');
    // `<u>` gets its own sentence: markdown has no underline, so an agent reaches for it.
    expect(found?.message).toContain('<u>');
  });

  test('`<script>` is reported as ESCAPED rather than as deleted, which is a different fact', () => {
    const found = render('<script>alert(1)</script>\n', 'github').warnings.find(
      (x) => x.code === 'github/html-stripped'
    );
    expect(found?.message).toContain('arrives as visible text');
    expect(found?.message).toContain('does not run');
  });

  test('generics in prose are NOT html -- this is the false positive the list exists to avoid', () => {
    // GitHub escapes both; a shape-matching `<tag>` rule would report a rendering that never happens.
    const md = 'It takes an Array<string> and a Vec<u8>.\n';
    expect(codes(md)).not.toContain('github/html-rendered');
    expect(codes(md)).not.toContain('github/html-stripped');
  });

  test('HTML inside a code fence is text about HTML, not HTML', () => {
    expect(codes('```html\n<details>x</details>\n```\n')).not.toContain('github/html-rendered');
  });

  test('an autolink is not a tag', () => {
    // CommonMark's autolink starts with `<h`, which a loose tag-name pattern reads as a tag.
    expect(codes('see <https://example.com>\n')).not.toContain('github/html-rendered');
  });
});

describe('images', () => {
  test('the camo proxy is reported, with both consequences', () => {
    const found = render('![x](https://e.test/a.png)\n', 'github').warnings.find(
      (w) => w.code === 'github/image-proxied'
    );
    expect(found?.severity).toBe('info');
    expect(found?.message).toContain('through its own proxy');
    expect(found?.message).toContain('never sees readers');
    // A URL GitHub cannot fetch renders broken for everyone.
    expect(found?.message).toContain('broken');
  });

  test('a data: URL is not proxied and is not reported', () => {
    expect(codes('![x](data:image/png;base64,iVBOR)\n')).not.toContain('github/image-proxied');
  });

  test('the picture is DRAWN -- GitHub renders it, so the preview must too', () => {
    expect(githubProfile.rendersMedia).toBe(true);
    expect(githubProfile.mediaPlacement).toBe('inline');
  });
});

describe('mention tokens', () => {
  const kinds = (md: string) => {
    const patterns = githubProfile.mentions.tokens!.patterns;
    const out: string[] = [];
    for (const { re, kind } of patterns) {
      const g = new RegExp(re.source, `${re.flags}g`);
      for (const m of md.matchAll(g)) out.push(`${kind}:${m[0]}`);
    }
    return out;
  };

  test('a username is a user', () => {
    expect(kinds('hi @torvalds')).toContain('user:@torvalds');
  });

  test('an EMAIL ADDRESS is not a mention, which is what the left guard is for', () => {
    // Without a left guard the domain matches and the strip reads "1 mention". `profiles/linear.ts`
    // carries the same guard.
    expect(kinds('Ping ada.lovelace@example.com if it recurs.')).toEqual([]);
    // Without the local part it is still a mention, so the guard has not turned the pattern off.
    expect(kinds('Ping @acme if it recurs.')).toContain('user:@acme');
  });

  test('a TEAM reference is left alone, including its owner half', () => {
    // Probed: `@github/docs` renders as plain text through GitHub's own renderer.
    expect(kinds('hi @github/docs')).toEqual([]);
  });

  test('all three reference spellings are references', () => {
    expect(kinds('see #30')).toContain('reference:#30');
    expect(kinds('see GH-30')).toContain('reference:GH-30');
    expect(kinds('see Jakuboola/draftgate#30')).toContain('reference:Jakuboola/draftgate#30');
  });

  test('a cross-repository reference is matched WHOLE, not as a bare number', () => {
    // The order in `GITHUB_TOKENS`: the bare `#\d+` pattern would otherwise claim the tail.
    const found = kinds('see Jakuboola/draftgate#30').filter((k) => k.startsWith('reference:'));
    expect(found).toContain('reference:Jakuboola/draftgate#30');
  });

  test('a reference is its own KIND, because it is neither a person nor a silent link', () => {
    // A `channel` notifies nobody; a `#123` posts a cross-referenced event on the thread it names
    // (verified read-only against nodejs/node#1).
    const patterns = githubProfile.mentions.tokens!.patterns;
    expect(patterns.some((p) => p.kind === 'reference')).toBe(true);
    expect(patterns.some((p) => p.kind === 'channel')).toBe(false);
  });

  test('the advice states the limit draftgate actually has', () => {
    const advice = githubProfile.mentions.tokens!.advice;
    // Probed both ways: GitHub links what exists and passes the rest as text; draftgate cannot tell.
    expect(advice).toContain('EXISTS');
    expect(advice).toContain('cross-reference');
  });

  test('no chips: GitHub resolves from text, so a `mention:` link would ship as characters', () => {
    expect(githubProfile.mentions.chips).toBeNull();
  });
});

describe('audience: repository visibility', () => {
  const ctx = { owner: 'Jakuboola', repo: 'draftgate' };

  test('unknown by default, and it ASKS rather than guessing', () => {
    const a = githubAudience(ctx);
    expect(a?.kind).toBe('unknown');
    // The internet or a team: there is no safe guess between them.
    expect(a?.ask?.options.map((o) => o.value).sort()).toEqual(['internal', 'private', 'public']);
  });

  test('a public repository says so in the words that matter', () => {
    const a = githubAudience(ctx, { repos: { 'jakuboola/draftgate': { visibility: 'public' } } });
    expect(a?.kind).toBe('public');
    expect(a?.detail).toContain('internet');
    expect(a?.detail).toContain('search engines');
  });

  test('private and internal are both `internal`, and are LABELLED differently', () => {
    const priv = githubAudience(ctx, {
      repos: { 'jakuboola/draftgate': { visibility: 'private' } },
    });
    const ent = githubAudience(ctx, {
      repos: { 'jakuboola/draftgate': { visibility: 'internal' } },
    });
    expect(priv?.kind).toBe('internal');
    expect(ent?.kind).toBe('internal');
    // Both a team rather than the internet; "everyone in the enterprise" is the wider room.
    expect(priv?.label).toBe('Private repository');
    expect(ent?.label).toBe('Internal repository');
    expect(ent?.detail).toContain('enterprise');
  });

  test('the lookup is case-insensitive, because GitHub names are', () => {
    const a = githubAudience(
      { owner: 'JAKUBOOLA', repo: 'DraftGate' },
      { repos: { 'jakuboola/draftgate': { visibility: 'public' } } }
    );
    expect(a?.kind).toBe('public');
  });

  test('but the reviewer is SHOWN the spelling the payload used', () => {
    // The lookup keys on a lowercased pair; the banner shows the name as typed.
    const a = githubAudience({ owner: 'Jakuboola', repo: 'DraftGate' });
    expect(a?.ask?.question).toBe('Is Jakuboola/DraftGate public?');
  });

  test("the reviewer's answer outranks the config, and takes effect immediately", () => {
    const a = githubAudience(ctx, {
      repos: { 'jakuboola/draftgate': { visibility: 'private' } },
      classified: { destination: 'github', value: 'public' },
    });
    expect(a?.kind).toBe('public');
  });

  // A Jira answer reaching this profile is refused one layer up, by `audienceFor`;
  // `core/test/audience.test.ts` drives that case in both directions.

  test('a payload with no owner/repo pair says so and offers NOTHING to click', () => {
    const a = githubAudience({ repo: 'draftgate' });
    expect(a?.kind).toBe('unknown');
    // Nothing to remember an answer under, so no `ask`.
    expect(a?.ask).toBeUndefined();
    expect(a?.unavailable).toContain('owner/repo');
  });

  test('an unprobed tool says so, on top of the unknown repository', () => {
    const a = githubAudience(ctx, { toolName: 'mcp__x__create_gist' });
    expect(a?.detail).toContain('create_gist');
  });

  test('a probed tool adds no such sentence', () => {
    const a = githubAudience(ctx, { toolName: 'mcp__claude_ai_Github_MCP__add_issue_comment' });
    expect(a?.detail).not.toContain('Nothing has been probed');
  });
});

describe('audienceProbed covers the ones that were read, and nothing else', () => {
  const probed = [
    'add_issue_comment',
    'update_issue_comment',
    'issue_write',
    'create_pull_request',
    'update_pull_request',
    'add_comment_to_pending_review',
    'add_reply_to_pull_request_comment',
    'pull_request_review_write',
  ];

  test('each one read, under any server prefix', () => {
    for (const tool of probed) {
      expect(githubProfile.audienceProbed(`mcp__whatever__${tool}`)).toBe(true);
      expect(githubProfile.audienceProbed(tool)).toBe(true);
    }
  });

  test('a tool nobody looked at does not borrow the claim', () => {
    // What varies is whether a tool's output lands in the repository at all (a gist, a release).
    expect(githubProfile.audienceProbed('mcp__x__create_gist')).toBe(false);
  });

  test('a PREFIX of a probed name is not a probed name', () => {
    // Anchored on both ends, like the hook matcher: `issue_write_draft` is a different tool.
    expect(githubProfile.audienceProbed('mcp__x__issue_write_draft')).toBe(false);
  });
});

describe('destinationLabel needs no config at all', () => {
  test('owner/repo#number when the payload carries one', () => {
    expect(
      githubProfile.destinationLabel({ owner: 'Jakuboola', repo: 'draftgate', issue_number: 30 })
    ).toBe('Jakuboola/draftgate#30');
  });

  test('the pull-request spelling too', () => {
    expect(
      githubProfile.destinationLabel({ owner: 'Jakuboola', repo: 'draftgate', pullNumber: 7 })
    ).toBe('Jakuboola/draftgate#7');
  });

  test('just the repository when there is no number', () => {
    expect(githubProfile.destinationLabel({ owner: 'Jakuboola', repo: 'draftgate' })).toBe(
      'Jakuboola/draftgate'
    );
  });

  test('undefined when either half is missing -- never a half-name', () => {
    expect(githubProfile.destinationLabel({ owner: 'Jakuboola' })).toBeUndefined();
    expect(githubProfile.destinationLabel({ repo: 'draftgate' })).toBeUndefined();
  });
});

describe('githubRepoKey is the ONE spelling a reader and a writer share', () => {
  test('lowercased, joined by a slash', () => {
    expect(githubRepoKey({ owner: 'Jakuboola', repo: 'DraftGate' })).toBe('jakuboola/draftgate');
  });

  test('whitespace is trimmed, and an empty half is no key', () => {
    expect(githubRepoKey({ owner: ' Jakuboola ', repo: 'draftgate' })).toBe('jakuboola/draftgate');
    expect(githubRepoKey({ owner: '   ', repo: 'draftgate' })).toBeUndefined();
    expect(githubRepoKey({ repo: 'draftgate' })).toBeUndefined();
  });

  test('a non-string is not a name', () => {
    expect(githubRepoKey({ owner: 42, repo: 'draftgate' })).toBeUndefined();
  });
});

/*
 * An HTML comment GitHub hides from readers. The first case is the probe's own input, verbatim, and
 * the four outcomes are what `POST /markdown` returned for it.
 */
describe('github/html-comment-hidden', () => {
  const comments = (md: string) => hiddenComments(md).map((c) => [c.text.trim(), c.unclosed]);
  const hidden = (md: string) => render(md, 'github').warnings.filter((w) => w.code === 'github/html-comment-hidden');

  test('the probe: inline and block hidden, a code span literal, an unclosed line-start comment hides the rest', () => {
    const probe =
      'visible <!-- hidden inline secret --> text\n<!--\nmulti-line hidden block\n-->\nafter the block\n' +
      '`code <!-- in code span -->`\n<!-- unterminated comment runs to the end\nstill hidden?\n';
    expect(comments(probe)).toEqual([
      ['hidden inline secret', false],
      ['multi-line hidden block', false],
      ['unterminated comment runs to the end\nstill hidden?', true],
    ]);
    const [w] = hidden(probe);
    expect(w!.severity).toBe('warning');
    // The unclosed one leads and names what it swallows.
    expect(w!.message).toMatch(/^An HTML comment opened with <!-- is never closed/);
    expect(w!.message).toContain('"unterminated comment runs to the end still hidden?"');
    expect(w!.message).toContain('"hidden inline secret"');
  });

  test('code is literal: a fence and a code span warn about nothing', () => {
    expect(hidden('```\n<!-- in a fence\n```\n')).toEqual([]);
    expect(hidden('say `<!-- x -->` to comment\n')).toEqual([]);
  });

  test('an unclosed comment MID-LINE is literal text in CommonMark, so no claim is made', () => {
    expect(hidden('text <!-- never closed\n\nnext para\n')).toEqual([]);
    // ...and one closed only in a LATER paragraph is not a comment either.
    expect(hidden('a <!-- x\n\nb --> c\n')).toEqual([]);
  });

  test('an unclosed block comment hides to the END, past fences and paragraphs', () => {
    expect(comments('ok\n\n<!-- start\n\n```\ncode\n```\n\nlast\n')).toEqual([
      ['start\n\n```\ncode\n```\n\nlast', true],
    ]);
  });

  test('ordinary prose earns nothing', () => {
    expect(hidden('a < b and c -> d\n')).toEqual([]);
  });

  // Each of these is a shape a looser scanner reports as a false claim; here each makes no claim.
  test('a list item\'s indented comment is not claimed to hide the rest of the body', () => {
    expect(hidden('- item\n\n  <!-- note\n\nafter the list\n')).toEqual([]);
  });

  test('an indented code block is code, so its comment is literal', () => {
    expect(hidden('para\n\n    <!-- indented code -->\n')).toEqual([]);
  });

  test('a `-->` on a LATER line is not a close: a heading is one line', () => {
    expect(hidden('# Title <!-- x\n-->\n')).toEqual([]);
  });

  test('an unclosed comment with nothing after it hides nothing, and says nothing', () => {
    expect(hidden('text\n<!--\n')).toEqual([]);
    // ...and neither does an EMPTY comment, closed or not.
    expect(hidden('a <!-- --> b\n<!---->\n')).toEqual([]);
  });

  test('a tag inside a hidden comment is not ALSO reported as rendered or stripped', () => {
    const codes = render('<!-- <details> and <u>x</u> -->\nhi\n', 'github').warnings.map((w) => w.code);
    expect(codes).toEqual(['github/html-comment-hidden']);
  });

  test('linear in the number of comments: a 250 KB body of them renders in well under a second', () => {
    for (const body of [
      'a<!--'.repeat(50_000),
      '`c` <!-- x -->\n'.repeat(17_000),
    ]) {
      const t = performance.now();
      render(body, 'github');
      expect(performance.now() - t).toBeLessThan(500);
    }
  });

  test('an unclosed `<!--` on every line is still linear: no `<!--` searches afresh to the END', () => {
    // Measured: 1.5 ms fixed, 213 ms with the forward-only `-->` cache removed (quadratic, ~4x per
    // doubling).
    for (const body of [' a <!--\n'.repeat(32_000), ' a <!-- x\n'.repeat(26_000) + '-->\n']) {
      const t = performance.now();
      hiddenComments(body);
      expect(performance.now() - t).toBeLessThan(50);
    }
  });

  test('only GitHub was probed, so no other destination warns', () => {
    for (const d of ['jira', 'slack', 'linear']) {
      expect(render('a <!-- x --> b\n', d).warnings.map((w) => w.code)).not.toContain('github/html-comment-hidden');
    }
  });
});
