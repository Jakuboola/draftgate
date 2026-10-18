/**
 * Mention syntax a destination resolves out of plain text. The two claims that would fail silently,
 * each probed: which destinations have patterns (Jira's list is empty, which looks like a forgotten
 * one), and that a token inside code is not found (`mentionPills` reaches it by the `code` mark).
 */

import { describe, expect, test } from 'bun:test';
import {
  countMentionChips,
  countMentionTokens,
  findMentionTokens,
  mentionLinkName,
  mentionNote,
  mentionSummary,
  MENTION_KINDS,
  type MentionSupport,
  type MentionSummary,
  type MentionTokenPattern,
} from '../src/mentionTokens';
import { profiles } from '../src/profiles';

/** Slack's, because it declares both a token caveat and the widest set of kinds. */
const SLACK_MENTIONS: MentionSupport = profiles.slack.mentions;

// Read off the profiles. The first test in this file fails if Slack or Linear stops declaring tokens.
const SLACK = profiles.slack.mentions.tokens!.patterns;
const LINEAR = profiles.linear.mentions.tokens!.patterns;
/** A destination with no plain-text mention scans with nothing. Jira's `tokens` is `null`. */
const NONE: readonly MentionTokenPattern[] = [];

describe('which destinations claim a plain-text mention at all', () => {
  /*
   * A pill asserts "the destination will resolve this", each answer probed: Slack yes (it rewrites
   * the stored message), Jira no (`[~accountid:x]` renders literally, screenshotted), Linear resolves
   * `@displayName`, marked on its shape alone (see the `@slug` test). GitHub resolves `@name`, `#123`,
   * `GH-123` and `owner/repo#123`, probed through its renderer, which links only the ones that exist.
   */
  test('Slack, Linear and GitHub have patterns; Jira has none', () => {
    const withPatterns = Object.entries(profiles)
      .filter(([, p]) => p.mentions.tokens !== null)
      .map(([name]) => name);
    expect(
      withPatterns,
      'a destination gained or lost mention-token patterns: its stylesheet needs a `.dg-mtok` rule, ' +
        'or it has one styling nothing'
    ).toEqual(['slack', 'linear', 'github']);
  });

  test('every half a destination declares carries a NON-EMPTY caveat', () => {
    // The pairing is a type (`MentionSupport`); an empty string is what the type cannot see, and a
    // marked token with no caveat over-claims, most for Linear, marked on shape alone.
    for (const [name, p] of Object.entries(profiles)) {
      if (p.mentions.tokens !== null) {
        expect(p.mentions.tokens.patterns.length, `${name}: tokens declared but no patterns`).toBeGreaterThan(0);
        expect(p.mentions.tokens.advice, `${name}: token advice`).not.toBe('');
      }
      if (p.mentions.chips !== null) {
        expect(p.mentions.chips.advice, `${name}: chip advice`).not.toBe('');
      }
    }
  });

  test('only Jira draws a chip, and it is the one destination with NO token', () => {
    // Complementary here as a fact, not a rule: another destination could have both.
    expect(profiles.jira.mentions).toEqual({ tokens: null, chips: { advice: expect.any(String) }, links: null });
    expect(profiles.slack.mentions.chips).toBeNull();
    expect(profiles.linear.mentions.chips).toBeNull();
  });

  test("Jira's empty list finds nothing, and does not throw looking", () => {
    expect(findMentionTokens('hi <@U0123ABCDEF> <!here> @slug', NONE)).toEqual([]);
  });

  test("Jira's own mention syntax is NOT a token -- it reaches Jira as characters", () => {
    // Probed with a logged-in screenshot: `[~accountid:x]` renders literally, so no ping.
    expect(
      findMentionTokens('Hey [~accountid:712020:5e0c4a1b] look', NONE)
    ).toEqual([]);
  });

  test("Linear's @slug IS a token -- the operator's call, and the residual is real", () => {
    /*
     * Linear resolves `@displayName` (screenshotted). Marked on shape alone, so `@todo` is marked and
     * not resolved: the operator's call, bounded by Linear's own typography rather than a pill, the
     * token advice saying the name is unverified, and email addresses excluded below.
     */
    expect(
      findMentionTokens('cc @ada.lovelace and @todo', LINEAR).map((t) => t.text)
    ).toEqual(['@ada.lovelace', '@todo']);
  });

  test('an email address does NOT produce a Linear mention', () => {
    // The lookbehind rejects an `@` preceded by a word character.
    expect(findMentionTokens('write to someone@example.com today', LINEAR)).toEqual(
      []
    );
  });

  test('an `@` inside a URL path or an npm scope is NOT a mention', () => {
    // The accepted residual is prose-shaped (`@todo` in a sentence); a path segment is not prose.
    for (const text of [
      'Fixed in https://github.com/acme/repo/blob/main/@types/x.ts',
      'Install @scope/pkg globally',
      'see docs/@internal/readme.md',
    ]) {
      expect(findMentionTokens(text, LINEAR), text).toEqual([]);
    }
  });

  test('a trailing full stop is not swallowed into the name', () => {
    // Dots match only between segments, so a sentence-ending period stays prose.
    expect(
      findMentionTokens('ask @ada.lovelace. Then wait.', LINEAR).map((t) => t.text)
    ).toEqual(['@ada.lovelace']);
  });

  test('Linear does NOT match Slack\'s bracketed forms, and vice versa', () => {
    // A shared list would mark `<@U…>` in a Linear draft, where Linear renders it verbatim.
    expect(findMentionTokens('<@U0123ABCDEF>', LINEAR).map((t) => t.text)).toEqual([]);
    expect(findMentionTokens('@ada.lovelace', SLACK)).toEqual([]);
  });
});

describe("Slack's forms", () => {
  const kinds = (text: string) => findMentionTokens(text, SLACK).map((t) => `${t.kind}:${t.text}`);

  test('all four, in document order', () => {
    expect(
      kinds('hi <@U0123ABCDEF> <!here> <#C0456GHIJ|random> <!subteam^S0123ABC|@support>')
    ).toEqual([
      'user:<@U0123ABCDEF>',
      'broadcast:<!here>',
      'channel:<#C0456GHIJ|random>',
      'group:<!subteam^S0123ABC|@support>',
    ]);
  });

  test('every broadcast spelling', () => {
    for (const t of ['<!here>', '<!channel>', '<!everyone>']) {
      expect(kinds(`x ${t} y`), t).toEqual([`broadcast:${t}`]);
    }
  });

  test('a `W` user id and a `G` channel id, which Enterprise Grid and private groups produce', () => {
    expect(kinds('<@W123ABC> <#G456DEF>')).toEqual(['user:<@W123ABC>', 'channel:<#G456DEF>']);
  });

  test('the |label tail is matched and never read', () => {
    // Slack discards the label and shows the name it resolves from the id (probed with a wrong
    // label), so no field on the match exposes one.
    const [t] = findMentionTokens('<@U0123ABCDEF|zzz-not-my-name>', SLACK);
    expect(t?.text).toBe('<@U0123ABCDEF|zzz-not-my-name>');
    expect(JSON.stringify(t)).not.toContain('label');
  });

  test('offsets slice back to the token, which is what the decoration relies on', () => {
    const text = 'please ask <@U0123ABCDEF> about it';
    for (const t of findMentionTokens(text, SLACK)) {
      expect(text.slice(t.start, t.end)).toBe(t.text);
    }
  });

  test('a lowercase id is not a token', () => {
    // `[A-Z0-9]` deliberately, so `<@ualreadyprose>` stays prose.
    expect(kinds('<@ualreadyprose> <#cnope>')).toEqual([]);
  });

  test('an unterminated or malformed token is not one', () => {
    expect(kinds('<@U0123ABCDEF and <! and <#>')).toEqual([]);
  });

  test('repeated scans do not drift -- the patterns are shared module constants', () => {
    // A `/g` regex kept on the pattern would carry `lastIndex` between calls.
    const text = '<@U1AAAAA> <@U2BBBBB>';
    const first = findMentionTokens(text, SLACK);
    expect(findMentionTokens(text, SLACK)).toEqual(first);
    expect(first).toHaveLength(2);
  });
});

describe('code is excluded, and BY THE SAME RULE the editor applies', () => {
  /*
   * `mentionSummary` masks code in markdown; `surface/src/mentionPills.ts` skips a `code` mark.
   * `surface/harness/probe.ts`'s `slack-mentions` scenario asserts the editor half (five tokens
   * written, four counted).
   */
  test('a token in an inline code span is not counted', () => {
    const s = mentionSummary('real <@U1AAAAA>, not `<@U2BBBBB>`', profiles.slack.mentions);
    expect(s.user).toBe(1);
  });

  test('a token in a fenced block is not counted', () => {
    const s = mentionSummary('```\n<@U1AAAAA> <!here>\n```\nprose <@U2BBBBB>', profiles.slack.mentions);
    expect(s.user).toBe(1);
    expect(s.broadcast).toBe(0);
  });

  test('masking preserves offsets, so the surviving tokens still slice correctly', () => {
    // `maskCode` blanks length-for-length, or every offset after a code span would land on prose.
    const body = 'a `code` then <@U1AAAAA>';
    const [t] = findMentionTokens(body.replace(/`code`/, '······'), SLACK);
    expect(body.slice(t!.start, t!.end)).toBe('<@U1AAAAA>');
  });
});

describe('counts and chips', () => {
  test('tallies by kind', () => {
    const c = countMentionTokens(findMentionTokens('<@U1AAAAA> <@U2BBBBB> <!here>', SLACK));
    expect(c).toEqual({ user: 2, broadcast: 1, group: 0, channel: 0, reference: 0 });
  });

  const ID = '712020:5e0c4a1b';

  test('a chip is a `mention:` link in the body, at any position', () => {
    const body = `Hi [@A](mention:${ID}), and\n\n- [@B](mention:${ID}) in a bullet\n`;
    expect(countMentionChips(body, true)).toBe(2);
  });

  test('and ONLY where the destination turns that link into a chip', () => {
    // Slack and Linear ship a `mention:` link as literal characters, so the flag has no default.
    expect(countMentionChips(`Hi [@A](mention:${ID}).`, false)).toBe(0);
  });

  test('an ordinary link is not a chip', () => {
    expect(countMentionChips('see [docs](https://e.test/x)', true)).toBe(0);
    expect(countMentionChips('', true)).toBe(0);
  });

  test('the angle-bracket destination form counts too', () => {
    // `markdownLinkSpans` handles `](<...>)`, so the scheme test has to see through the brackets.
    expect(countMentionChips(`Hi [@A](<mention:${ID}>).`, true)).toBe(1);
  });

  test('a chip quoted inside code is NOT counted', () => {
    // Through `mentionSummary`, which masks code first.
    const s = mentionSummary(`real [@A](mention:${ID}) and \`[@B](mention:${ID})\``, profiles.jira.mentions);
    expect(s.chips).toBe(1);
  });

  test('the chip count is LIVE, because it comes from the body and not a frozen document', () => {
    /*
     * `useReview`'s `state.doc` changes only on the one-click fix (else `useEditor` remounts per
     * keystroke), so a document-based count would freeze at load. `surface/window.test.tsx` drives
     * this through the real React tree.
     */
    const before = `Hi [@A](mention:${ID}), look.`;
    expect(mentionSummary(before, profiles.jira.mentions).chips).toBe(1);
    expect(mentionSummary('Hi, look.', profiles.jira.mentions).chips).toBe(0);
  });
});

/**
 * A link the destination turns into a mention: Linear's profile link, labelled or bare.
 *
 * Probed: Linear stores both forms as a user-mention node and draws `@<display name>`. Elsewhere a
 * profile link is a link, so a mention claimed there would be a notification that never happens.
 */
describe('links that are mentions', () => {
  const HREF = 'https://linear.app/acme/profiles/jane.doe';
  const LINEAR_LINKS = profiles.linear.mentions.links;
  /** How many links in `body` the strip counts as mentions on Linear. */
  const links = (body: string) => mentionSummary(body, profiles.linear.mentions).links;

  test('only Linear turns a link into a mention, and says so in its own words', () => {
    const withLinks = Object.entries(profiles)
      .filter(([, p]) => p.mentions.links !== null)
      .map(([name]) => name);
    expect(withLinks).toEqual(['linear']);
    expect(LINEAR_LINKS!.advice).not.toBe('');
  });

  test('the name is the slug in the address, and only a whole profile address has one', () => {
    expect(mentionLinkName(HREF, LINEAR_LINKS)).toBe('jane.doe');
    expect(mentionLinkName('https://linear.app/other-ws/profiles/ada_l', LINEAR_LINKS)).toBe('ada_l');
    for (const href of [
      `${HREF}/`,
      `${HREF}?x=1`,
      `${HREF}/activity`,
      'http://linear.app/acme/profiles/jane',
      'https://linear.app/acme/issue/HELP-1',
      'https://example.com/acme/profiles/jane',
      `x${HREF}`,
    ]) {
      expect(mentionLinkName(href, LINEAR_LINKS), href).toBeNull();
    }
    // A destination that declares none has no name to read, whatever the address.
    expect(mentionLinkName(HREF, profiles.slack.mentions.links)).toBeNull();
  });

  test('both forms an agent writes are counted, because a bare URL loads as a link', () => {
    const body = `Hi [Jane](${HREF}) and [${HREF}](${HREF}), see [docs](https://e.test/x).`;
    expect(links(body)).toBe(2);
    expect(links(`Hi [Jane](<${HREF}>).`)).toBe(1);
  });

  test('a label written as `@name` is ONE mention, the link, not a link plus a token', () => {
    const s = mentionSummary(`Hi [@jane](${HREF}).`, profiles.linear.mentions);
    expect(s.links).toBe(1);
    expect(s.user).toBe(0);
    const note = mentionNote(s, profiles.linear.mentions)!;
    expect(note.label).toBe('1 mention');
    expect(note.detail).not.toContain(profiles.linear.mentions.tokens!.advice);
    // A `@name` outside the link is still its own token.
    expect(mentionSummary(`Hi [@jane](${HREF}) and @ada.`, profiles.linear.mentions).user).toBe(1);
  });

  test('an IMAGE whose source is a profile address is not a mention', () => {
    // Linear draws an image as a picture; the editor holds an image node, not a link to decorate.
    expect(links(`![avatar](${HREF})`)).toBe(0);
    expect(links(`\\![avatar](${HREF})`)).toBe(1);
  });

  test('a profile link quoted inside code is NOT counted', () => {
    expect(mentionSummary(`real [Jane](${HREF}) and \`[Jane](${HREF})\``, profiles.linear.mentions).links).toBe(1);
  });

  test('on Linear the strip says who is notified; elsewhere the same text notifies nobody', () => {
    const body = `Hi [Jane](${HREF}) and [${HREF}](${HREF}).`;
    for (const [name, p] of Object.entries(profiles)) {
      const note = mentionNote(mentionSummary(body, p.mentions), p.mentions);
      if (name === 'linear') {
        expect(note?.label).toBe('2 mentions');
        expect(note!.detail).toContain(LINEAR_LINKS!.advice);
        // A profile link is not a `@name` token: Linear's token caveat (an unrecognised name is
        // sent as plain text) is not true of it, so it is not printed for one.
        expect(note!.detail).not.toContain(profiles.linear.mentions.tokens!.advice);
      } else {
        expect(note, name).toBeNull();
      }
    }
  });
});

describe('what the strip is told to say', () => {
  const ADVICE = 'ADVICE-FROM-THE-PROFILE';
  const CHIP_ADVICE = 'CHIP-ADVICE-FROM-THE-PROFILE';
  const LINK_ADVICE = 'LINK-ADVICE-FROM-THE-PROFILE';
  /** A synthetic destination with EVERY kind, so every branch of the note is reachable from one. */
  const BOTH: MentionSupport = {
    tokens: { patterns: [], advice: ADVICE },
    chips: { advice: CHIP_ADVICE },
    links: { href: /^x:(.+)$/, advice: LINK_ADVICE },
  };
  /** The zeroed summary, spelled ONCE. `mentions` is a parameter so no caller has to rebuild it. */
  const note = (s: Partial<MentionSummary>, mentions: MentionSupport = BOTH) =>
    mentionNote({ user: 0, broadcast: 0, group: 0, channel: 0, reference: 0, chips: 0, links: 0, ...s }, mentions);

  test('nothing at all when there is nothing to notify', () => {
    expect(note({})).toBeNull();
  });

  test('a bare channel reference is NOT announced -- it notifies nobody', () => {
    // `<#C…>` renders as a link and pings no one. It is still pilled.
    expect(note({ channel: 3 })).toBeNull();
  });

  test('singular and plural', () => {
    expect(note({ user: 1 })?.label).toBe('1 mention');
    expect(note({ user: 2 })?.label).toBe('2 mentions');
    expect(note({ user: 1, group: 1, chips: 1 })?.label).toBe('3 mentions');
  });

  test('a chip counts as a mention, so Jira gets the note too', () => {
    expect(note({ chips: 1 })?.label).toBe('1 mention');
  });

  test('the broadcast FLAG is returned, not left for the caller to sniff', () => {
    // Not `label.startsWith('notifies')` in `App.tsx`: a reword of the label would drop the bold.
    expect(note({ broadcast: 1 })!.broadcast).toBe(true);
    expect(note({ user: 3, group: 1, chips: 2 })!.broadcast).toBe(false);
  });

  test('a broadcast leads, whatever else is present', () => {
    // A reviewer who reads four words of the strip reads that a room is about to be notified.
    expect(note({ broadcast: 1 })?.label).toBe('notifies the channel');
    expect(note({ broadcast: 1, user: 2 })?.label).toBe('notifies the channel + more');
    expect(note({ broadcast: 2 })?.label).toBe('notifies the channel + more');
  });

  test('every label is short enough to stay on one line', () => {
    // `.dg-status` has a fixed height; a wrap moves the editor under the cursor.
    // `surface/harness/probe.ts` pins the rendered height.
    const labels = [
      note({ user: 1 }),
      note({ user: 99 }),
      note({ broadcast: 1 }),
      note({ broadcast: 1, user: 9 }),
      note({ chips: 4 }),
    ].map((n) => n!.label);
    for (const l of labels) expect(l.length, l).toBeLessThanOrEqual(30);
  });

  test("the detail carries the PROFILE's advice, not a sentence written here", () => {
    // A destination claim: Slack's "cannot turn a Slack id into a name" is false for Linear.
    expect(note({ user: 1 })!.detail).toContain(ADVICE);
  });

  test('a destination with no tokens says nothing about tokens, and one with no chips nothing about chips', () => {
    // Jira: `tokens: null`, so no token sentence can apply. A chip still gets its own.
    const jira = note({ chips: 1 }, profiles.jira.mentions);
    expect(jira!.detail).not.toContain(ADVICE);
    expect(jira!.detail).toContain('resolves the account id');
    // The mirror: no chip sentence where no chip is drawn, even handed a pair `mentionSummary` never
    // produces.
    const slack = note({ user: 1, chips: 1 }, profiles.slack.mentions);
    expect(slack!.detail).not.toContain('resolves the account id');
  });

  test('Slack, Linear and Jira supply advice that reads as their own caveat', () => {
    expect(note({ user: 1 }, profiles.slack.mentions)!.detail).toContain(
      'cannot turn a Slack id into a name'
    );
    // Linear's is the mirror: readable, unverifiable, and silent when unrecognised.
    expect(note({ user: 1 }, profiles.linear.mentions)!.detail).toContain(
      'sends one it does not as plain text'
    );
    // Jira's is about the chip: the label is the agent's, the id is what notifies.
    expect(note({ chips: 1 }, profiles.jira.mentions)!.detail).toContain('resolves the account id');
  });

  test('the detail names the blast radius when a broadcast is present', () => {
    expect(note({ broadcast: 1 })!.detail).toContain('everyone in the channel');
  });

  test("a mention link counts as a mention, and its detail is the PROFILE's link advice", () => {
    expect(note({ links: 1 })?.label).toBe('1 mention');
    expect(note({ links: 1, chips: 1, user: 1 })?.label).toBe('3 mentions');
    expect(note({ links: 1 })!.detail).toContain(LINK_ADVICE);
    expect(note({ chips: 1 })!.detail).not.toContain(LINK_ADVICE);
    // A destination that declares no mention link prints no sentence about one, even if handed a count.
    const slack = profiles.slack.mentions;
    expect(note({ user: 1, links: 1 }, slack)!.detail).toBe(note({ user: 1 }, slack)!.detail);
  });

  test("a chip's detail is the PROFILE's chip advice", () => {
    // Probed: the account id makes a Jira mention notify, and Jira corrects the label.
    expect(note({ chips: 1 })!.detail).toContain(CHIP_ADVICE);
  });
});

/**
 * The registry, swept: `mentionNote` reads kinds from `MENTION_KINDS`, so a sixth `MentionTokenKind`
 * counted but never announced fails here.
 */
describe('MENTION_KINDS', () => {
  test('an unannounced kind attaches no advice either, so silence is total', () => {
    // A kind nothing announces cannot be the reason a caveat appears (only `channel` today).
    const kinds = Object.keys(MENTION_KINDS) as (keyof typeof MENTION_KINDS)[];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const spec = MENTION_KINDS[kind];
      if (spec.announces === null) expect(spec.tokenAdvice, `${kind}`).toBe(false);
    }
  });

  test('every ANNOUNCED kind actually reaches the note, one kind at a time', () => {
    // One token of one kind and the note must exist; a kind defaulting to silence fails.
    for (const kind of Object.keys(MENTION_KINDS) as (keyof typeof MENTION_KINDS)[]) {
      const summary = {
        user: 0, broadcast: 0, group: 0, channel: 0, reference: 0, chips: 0, links: 0,
        [kind]: 1,
      } as Parameters<typeof mentionNote>[0];
      const note = mentionNote(summary, SLACK_MENTIONS);
      if (MENTION_KINDS[kind].announces === null) {
        expect(note, `${kind} is announced and the registry says it is not`).toBeNull();
      } else {
        expect(note, `${kind} declares an announcement and produces no note`).not.toBeNull();
        expect(note!.label.length).toBeGreaterThan(0);
      }
    }
  });

  test('and the profile caveat is attached to exactly the kinds that claim it', () => {
    for (const kind of Object.keys(MENTION_KINDS) as (keyof typeof MENTION_KINDS)[]) {
      const summary = {
        user: 0, broadcast: 0, group: 0, channel: 0, reference: 0, chips: 0, links: 0,
        [kind]: 1,
      } as Parameters<typeof mentionNote>[0];
      const note = mentionNote(summary, SLACK_MENTIONS);
      const carried = note?.detail.includes(SLACK_MENTIONS.tokens!.advice) ?? false;
      expect(carried, `${kind}: tokenAdvice says ${MENTION_KINDS[kind].tokenAdvice}`).toBe(
        MENTION_KINDS[kind].tokenAdvice
      );
    }
  });

  test('the widest blast radius wins the label when several are present', () => {
    const all = { user: 2, broadcast: 1, group: 0, channel: 3, reference: 4, chips: 0, links: 0 };
    expect(mentionNote(all, SLACK_MENTIONS)!.label).toBe('notifies the channel + more');
    expect(mentionNote({ ...all, broadcast: 0 }, SLACK_MENTIONS)!.label).toBe('2 mentions');
    expect(mentionNote({ ...all, broadcast: 0, user: 0 }, SLACK_MENTIONS)!.label).toBe(
      '4 references'
    );
    // `channel` alone says nothing.
    expect(mentionNote({ user: 0, broadcast: 0, group: 0, channel: 3, reference: 0, chips: 0, links: 0 }, SLACK_MENTIONS)).toBeNull();
  });
});
