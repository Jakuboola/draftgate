/**
 * Mention syntax a destination resolves out of plain text, so the window can mark it as a token.
 *
 * `mentions.ts` handles the mention that is a node. A Slack mention travels as characters,
 * `<@U0123ABCDEF>`, which Slack renders as a pill reading `@Ada Lovelace` (screenshotted against the
 * real client); `<!here>` notifies everyone in the channel and looks like prose. draftgate holds no
 * destination credentials and never calls the destination, so it cannot resolve the id: it finds the
 * tokens and the window marks them without changing a character.
 *
 * Marking a token claims the destination resolves it, so each profile's answer is probed and the
 * patterns live there: Slack (`<@U…>`, `<!here>`, `<!subteam^…>`, `<#C…>`, resolved and rewritten
 * into the stored message, probed), Linear (a bare `@displayName`, matched on shape alone; see
 * `profiles/linear.ts`) and GitHub (`profiles/github.ts`). Jira declares `tokens: null`
 * (`profiles/jira.ts`). This module keeps the destination-agnostic part: types, scanner, counts and
 * `mentionNote`.
 */

import { bareDestination } from './linkDestination';
import { blankRanges, markdownLinkSpans, maskCode, spanParts } from './markdown';
import { MENTION_SCHEME } from './mentions';

/** What a token does, which is the only distinction the window draws differently. */
export type MentionTokenKind =
  /** One person. Resolved and notified by the destination. */
  | 'user'
  /** Everyone currently in the channel: `<!here>`, `<!channel>`, `<!everyone>`. */
  | 'broadcast'
  /** A user group, `<!subteam^S…>`. Several people, named as one. */
  | 'group'
  /** A channel reference, `<#C…>`. Renders as a link and notifies nobody. */
  | 'channel'
  /**
   * A reference to another thread, which the destination turns into a link and a public event on
   * that thread: GitHub's `#123`, `GH-123` and `owner/repo#123`. Probed read-only against
   * `nodejs/node#1`, which carries `cross-referenced` timeline events from other issues and another
   * repository, so `#12` writes onto issue 12 under the author's name. Announced, apart from people.
   */
  | 'reference';

/**
 * The announcements, widest blast radius first: a room notified beats people pinged beats a thread
 * gaining a row. Also the domain: `MentionAnnouncement` is derived from it, so a new announcement
 * cannot be counted yet never become `leading`.
 */
const ANNOUNCEMENT_ORDER = ['broadcast', 'people', 'reference'] as const;

/**
 * What the strip says about a kind, when a draft carries one. A group, since kinds can share one:
 * `user` and `group` are both people pinged.
 */
export type MentionAnnouncement = (typeof ANNOUNCEMENT_ORDER)[number];

/** What `MENTION_KINDS` states about each kind. See that table. */
export interface MentionKindSpec {
  /** Which announcement it belongs to, or `null` for counted-and-deliberately-silent. */
  readonly announces: MentionAnnouncement | null;
  /**
   * Whether the profile's token caveat applies. False for `broadcast`, which has its own sentence,
   * and for anything unannounced.
   */
  readonly tokenAdvice: boolean;
}

/**
 * Every mention kind, and what the window does about it: a registry, like `WARNING_CODES`.
 *
 * `countMentionTokens` and `surface/src/mentionPills.ts` are exhaustive `Record<MentionTokenKind,…>`.
 * Never enumerate kinds by name in `mentionNote`: a new kind would compile clean and be counted but
 * never announced. The rationale per row is a comment, not a field, because nothing renders it.
 */
export const MENTION_KINDS = {
  /** One person, resolved and notified by the destination. */
  user: { announces: 'people', tokenAdvice: true },
  /** Several people named as one, which is still people being pinged. */
  group: { announces: 'people', tokenAdvice: true },
  /* A room notified. It carries its own sentence, so the token caveat is not attached. */
  broadcast: { announces: 'broadcast', tokenAdvice: false },
  /* Renders as a link and notifies nobody: counted, and deliberately not announced. */
  channel: { announces: null, tokenAdvice: false },
  /* Writes a timeline event onto the target thread (see `MentionTokenKind`): announced. */
  reference: { announces: 'reference', tokenAdvice: true },
} satisfies Record<MentionTokenKind, MentionKindSpec>;

/** Every kind, once, rather than an `Object.keys` per call on the per-render path. */
const KIND_NAMES = Object.keys(MENTION_KINDS) as MentionTokenKind[];

/** One pattern, and the kind of token it finds. */
export interface MentionTokenPattern {
  /**
   * Matches one token. Must not carry `/g`: `findMentionTokens` drives the scan with `lastIndex`,
   * and a shared global regex would start the next scan part-way through its text.
   */
  readonly re: RegExp;
  readonly kind: MentionTokenKind;
  /**
   * A literal every match of `re` must contain, so a body without it skips the pattern. Optional,
   * a cost guard that changes no result. GitHub's `owner/repo#123` pattern starts
   * `[A-Za-z0-9._-]+` and tries nearly every word boundary: measured over 16 KB of prose, 26.7us
   * against 0.64us for each of the other three, and 215us on dot-dense text. The scan runs on the
   * keystroke path (`mentionSummary` per render, `mentionPills` per text node per transaction).
   */
  readonly must?: string;
}

/** Where a token is, and what it is. Offsets are into the string that was scanned. */
export interface MentionTokenMatch {
  readonly start: number;
  /** Exclusive, so `text.slice(start, end)` is the token. */
  readonly end: number;
  readonly kind: MentionTokenKind;
  readonly text: string;
}

/**
 * Everything a destination has to say about mentions, as one descriptor on its profile.
 *
 * `tokens` is the mention that is characters (Slack's `<@U…>`, Linear's `@name`), `chips` the one
 * that is a node (Jira's ADF `mention`), `links` a link the destination converts (Linear's profile
 * URL). Each carries the panel's sentence about it, since the caveat differs per destination, and
 * `null` means none of that kind, so a pattern without a caveat is unrepresentable.
 */
export interface MentionSupport {
  /** Plain-text syntax this destination resolves, and what to tell the reviewer about it. */
  readonly tokens: {
    readonly patterns: readonly MentionTokenPattern[];
    readonly advice: string;
  } | null;
  /**
   * Whether a `mention:` link becomes a mention node here (a chip in the preview, a notifying
   * mention at the destination), and what to tell the reviewer about one.
   */
  readonly chips: { readonly advice: string } | null;
  /**
   * A link this destination turns into a mention of the person it points at, and what to tell the
   * reviewer about one. Sent as a link; it changes only what the window draws
   * (`surface/src/mentionPills.ts`) and what the strip counts (`mentionSummary`).
   *
   * `href` matches a whole href, anchored at both ends; its first capture group names the person.
   * No `/g`, for `MentionTokenPattern.re`'s reason.
   */
  readonly links: { readonly href: RegExp; readonly advice: string } | null;
}

/** No mention of any kind: a result with no editor, and the window's default. */
export const NO_MENTIONS: MentionSupport = { tokens: null, chips: null, links: null };

/**
 * The name in `href`, when it is a link this destination turns into a mention, or `null`: the
 * capture group `MentionSupport.links.href` declares, read out of the address since nothing can
 * look the person up.
 */
export function mentionLinkName(href: string, links: MentionSupport['links']): string | null {
  if (links === null) return null;
  return links.href.exec(href)?.[1] ?? null;
}


/**
 * The global-flagged twin of a pattern, cached because `findMentionTokens` is on the keystroke
 * path. Measured with Slack's four patterns: a fresh `RegExp` per call costs 9.9µs per keystroke on
 * a 14-node draft and 115µs on a 200-node one, against 2.0µs and 17.5µs cached (allocation and
 * `JSRegExp` setup, ~0.15µs a clone; V8 caches the compiled pattern). A `WeakMap`, so entries are
 * bounded by the pattern constants.
 */
const GLOBAL_CLONES = new WeakMap<RegExp, RegExp>();

function globalClone(re: RegExp): RegExp {
  let g = GLOBAL_CLONES.get(re);
  if (g === undefined) {
    g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    GLOBAL_CLONES.set(re, g);
  }
  return g;
}

/**
 * Every token in `text`, in document order, non-overlapping, as offsets the window maps onto
 * ProseMirror positions. Code spans are the caller's to skip (`surface/src/mentionPills.ts` knows
 * the `code` mark; `mentionSummary` masks code first). On overlap the earliest start wins, then
 * pattern order; two decorations over the same characters would nest and double the pill's padding.
 */
export function findMentionTokens(
  text: string,
  patterns: readonly MentionTokenPattern[]
): MentionTokenMatch[] {
  if (patterns.length === 0 || text === '') return [];

  const found: MentionTokenMatch[] = [];
  for (const { re, kind, must } of patterns) {
    // See `must`.
    if (must !== undefined && !text.includes(must)) continue;
    const scan = globalClone(re);
    // The clone is cached, so reset it; safe because this function is synchronous.
    scan.lastIndex = 0;
    for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
      found.push({ start: m.index, end: m.index + m[0].length, kind, text: m[0] });
      // A zero-length match would spin forever; a guard, since no pattern produces one.
      if (m[0].length === 0) scan.lastIndex++;
    }
  }

  found.sort((a, b) => a.start - b.start);
  const out: MentionTokenMatch[] = [];
  let usedTo = -1;
  for (const t of found) {
    if (t.start < usedTo) continue;
    out.push(t);
    usedTo = t.end;
  }
  return out;
}

/** A tally per kind, derived from the union so a new kind needs no second declaration. */
export type MentionCounts = Record<MentionTokenKind, number>;

/** Tally by kind. `channel` is counted and not announced (see `MENTION_KINDS`). */
export function countMentionTokens(tokens: readonly MentionTokenMatch[]): MentionCounts {
  // Zeroed from the registry, so a new kind is never counted as `NaN`.
  const counts = Object.fromEntries(KIND_NAMES.map((k) => [k, 0])) as MentionCounts;
  for (const t of tokens) counts[t.kind]++;
  return counts;
}

/**
 * The tokens plus the structural mentions, which is what the strip reports on: `chips` are
 * `mention` nodes (where `mentions.chips` is set), `links` are links the destination converts
 * (where `mentions.links` is set).
 */
export interface MentionSummary extends MentionCounts {
  chips: number;
  links: number;
}

/** What the strip shows and what the panel explains, named once so the window uses this shape. */
export interface MentionNote {
  /** A few words for the fixed-height strip. Must never wrap -- see `mentionNote`. */
  label: string;
  /** The sentences for the unfurled panel. */
  detail: string;
  /** Whether a channel-wide ping is present. Returned, never inferred from `label`. */
  broadcast: boolean;
}

/**
 * What to say about the mentions in a draft, or `null` for nothing worth saying. In `core` because,
 * like a `Warning.message`, it states what a destination will do.
 *
 * A `channel` reference is pilled but not announced (`MENTION_KINDS`). The label is a few words:
 * `.dg-status-row` is one fixed-height line that may never wrap, or the editor moves under the
 * reviewer's cursor, and `surface/harness/probe.ts` pins its height with the longest label.
 */
export function mentionNote(
  s: MentionSummary,
  /**
   * What to say about each kind of mention here, from `DestinationProfile.mentions`: Slack's id is
   * opaque, Linear's name is unverifiable, Jira's chip label is the agent's.
   */
  mentions: MentionSupport
): MentionNote | null {
  /*
   * How many of each announcement this draft carries. `chips` and `links` join `people`; they are
   * not a `MentionTokenKind` (a node and a mark, not characters).
   */
  const present = Object.fromEntries(
    ANNOUNCEMENT_ORDER.map((a) => [a, 0])
  ) as Record<MentionAnnouncement, number>;
  present.people = s.chips + s.links;
  for (const kind of KIND_NAMES) {
    const announces = MENTION_KINDS[kind].announces;
    if (announces !== null) present[announces] += s[kind];
  }
  const people = present.people;

  // Nothing announced means nothing to say, read off the registry's sum, not kinds named by hand.
  const leading = ANNOUNCEMENT_ORDER.find((a) => present[a] > 0);
  if (leading === undefined) return null;

  const n = present[leading];
  const label =
    leading === 'broadcast'
      ? // A room leads whatever else is present; "+ more" says something else is too.
        n === 1 && people === 0
        ? 'notifies the channel'
        : 'notifies the channel + more'
      : leading === 'people'
        ? /*
           * People lead references, and a draft carrying both says only the people count: the
           * one-line strip cannot hold "2 mentions, 1 reference". The detail names the reference.
           */
          n === 1
          ? '1 mention'
          : `${n} mentions`
        : n === 1
          ? '1 reference'
          : `${n} references`;

  const parts: string[] = [];
  if (present.broadcast > 0) {
    parts.push(
      'This draft contains a channel-wide ping, which notifies everyone in the channel rather ' +
        'than one person.'
    );
  }
  // Every kind the registry says the profile's caveat applies to.
  const needsAdvice = KIND_NAMES.some((kind) => MENTION_KINDS[kind].tokenAdvice && s[kind] > 0);
  if (needsAdvice && mentions.tokens !== null) {
    // The profile's caveat: draftgate cannot check what it marks, so the token is the reviewer's to
    // verify (see the module header).
    parts.push(mentions.tokens.advice);
  }
  if (s.chips > 0 && mentions.chips !== null) {
    // What a chip's label is evidence of is the profile's (Jira's is in `profiles/jira.ts`).
    parts.push(mentions.chips.advice);
  }
  if (s.links > 0 && mentions.links !== null) {
    // What the destination draws in place of the link is the profile's (`profiles/linear.ts`).
    parts.push(mentions.links.advice);
  }
  /*
   * `broadcast` is returned, never derived from the label: a reword of that display copy would
   * silently drop the bold treatment from the room-sized case.
   */
  return { label, detail: parts.join(' '), broadcast: present.broadcast > 0 };
}

/**
 * How many mention chips the draft carries, read off the body: `state.doc` is frozen at load
 * (`useReview`: "Replaced only by the one-click fix", since `useEditor`'s deps are `[doc]`), so
 * counting nodes there misses every edit. The body is `markdownFor(doc)` per keystroke, and a chip
 * is exactly a `mention:` link in it (`encodeMentions`/`decodeMentions` are inverses).
 *
 * `chips` is passed in because a `mention:` link becomes a chip only where the profile says so; on
 * Slack and Linear it ships as literal characters that notify nobody. Scanned with
 * `markdownLinkSpans`, the repo's one model of a link span.
 */
export function countMentionChips(body: string, chips: boolean): number {
  return chips ? linkSpansWhere(body, (dest) => dest.startsWith(MENTION_SCHEME)).length : 0;
}

/**
 * Where the links the destination turns into a mention are in the body (live, see
 * `countMentionChips`). A bare profile URL loads as `[url](url)`, so it is found like a labelled
 * one; a URL the reviewer types stays plain text (`Link` has `autolink: false`) and is not.
 */
function mentionLinkSpans(body: string, links: MentionSupport['links']): [number, number][] {
  return links === null ? [] : linkSpansWhere(body, (dest) => mentionLinkName(dest, links) !== null);
}

/**
 * The link spans in `body` whose destination `matches` accepts. Images, which `markdownLinkSpans`
 * returns with their leading `!`, are skipped.
 */
function linkSpansWhere(body: string, matches: (dest: string) => boolean): [number, number][] {
  return markdownLinkSpans(body).filter(
    // `<...>` is stripped so an angle-bracketed href is recognised too.
    ([from, to]) => body[from] !== '!' && matches(bareDestination(spanParts(body.slice(from, to)).destination))
  );
}

/**
 * Everything the strip needs, from the body being sent, and only the body: `state.doc` is frozen at
 * load (see `countMentionChips`). `maskCode` blanks every code region preserving length, so a token
 * inside `` ` `` or a fence is not there; the window's decoration reaches the same answer from the
 * `code` mark, and `core/test/mentionTokens.test.ts` pins that the two agree.
 */
export function mentionSummary(
  body: string,
  /**
   * From `RenderResult.mentions`: which syntax to scan for, whether a `mention:` link is a chip and
   * which links are mentions.
   */
  mentions: MentionSupport
): MentionSummary {
  const masked = maskCode(body);
  const links = mentionLinkSpans(masked, mentions.links);
  return {
    // Mention links blanked out, so `[@jane](<profile URL>)` is one mention, not a link plus a token.
    ...countMentionTokens(findMentionTokens(blankRanges(masked, links, '\u00b7'), mentions.tokens?.patterns ?? [])),
    // Masked too, so a `mention:` link quoted inside a code sample is not counted as a ping.
    chips: countMentionChips(masked, mentions.chips !== null),
    links: links.length,
  };
}
