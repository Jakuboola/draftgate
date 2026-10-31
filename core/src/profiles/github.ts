/**
 * GitHub destination profile. Verified against GitHub's own renderer -- `POST /markdown` with
 * `mode=gfm`, the endpoint GitHub uses for comment bodies -- and against GitHub's own rendered
 * surface, read out of Chromium by `tools/github-ruler/`.
 *
 * Probed on the torture fixture, GitHub renders almost everything:
 *
 *   all six heading levels render distinctly, `**bold**` / `*italic*` / `~~strike~~` / `` `code` ``,
 *   tables, nested bullet lists, ordered lists including an explicit `start`, `- [ ]` / `- [x]` as
 *   real checkboxes, blockquotes nested to any depth, fenced code with syntax highlighting, rules,
 *   footnotes, bare-URL autolinking at full length, and images.
 *
 * Underscores as CommonMark reads them: `_x_` italic, `__x__` bold, `___x___` both, an underscore
 * inside a word (`snake_case`, `foo_bar_`) text, and an unbackticked `__init__` a bold "init".
 * Probed on ten lines through `POST /markdown`, both modes alike.
 *
 * Three behaviours are the opposite of a sibling destination's:
 *
 *  - A single newline is a `<br>`. Probed: `line one\nline two` renders as two lines. Slack does
 *    the same; Jira and Linear do not.
 *  - A bare URL keeps its whole label at any path depth: nothing corresponds to
 *    `slack/url-label-elided`.
 *  - An ordered list keeps its start: `7.` renders as 7.
 *
 * Six codes. Three `info`: delivered intact, only the rendering differs from the source. Two
 * `warning`: `github/html-stripped`, the only loss (`<u>`, `<small>`, `<abbr>` and a dozen others
 * deleted, text kept, silently), and `github/html-comment-hidden` (see `hiddenComments`). One
 * `error`, `github/body-too-long`, a 422 past 262,144 UTF-8 bytes (`bodyLimit`): GitHub rejects no
 * structure a GFM body can express. None is `silencedByRoundTrip`: the editor returns every one of
 * these inputs byte for byte (twelve GFM shapes; only a table's `|---|` is re-spelled `| --- |`).
 *
 * No emoji-shortcode code: `:tada:` renders as 🎉, but draftgate holds no list of GitHub's ~1900
 * names, and the shape `:word:` matches `10:30:00`. No empty-body code: `render()`'s `body/empty`
 * already blocks, and the connector's schema states `minLength: 1` on `add_issue_comment`.
 */

import { type Warning, warn } from '../warnings';
import { lengthWarnings } from '../lengthLimit';

import type { Audience, AudienceAnswer } from '../audience';
import type { DestinationProfile } from './index';
import type { MentionTokenPattern } from '../mentionTokens';
import { bareDestination } from '../linkDestination';
import { blankRanges, markdownImages, maskCode, segments } from '../markdown';

// ---------------------------------------------------------------------------
// Repository visibility -- the operator fact, and the types that carry it
// ---------------------------------------------------------------------------

/**
 * What a repository's visibility means for who can read a comment in it: GitHub's own three
 * values, as `/repos/{owner}/{repo}` reports `visibility`. `internal` exists only on Enterprise
 * Cloud and means "everyone in the enterprise", a team-sized audience, so it is grouped with
 * `private` for the banner and kept distinct in the file.
 */
export type GitHubRepoVisibility = 'public' | 'private' | 'internal';

/** Where a visibility row came from. The sibling of `JiraProjectSource`, and for the same reason. */
export type GitHubRepoSource = 'github' | 'reviewer';

/**
 * One repository, as the operator's config knows it. See `cli/src/githubRepos.ts`. Keyed by
 * `owner/repo` lowercased, GitHub's globally unique name for a repository -- unlike a Jira project
 * key, unique only within a site, which is why `jira-projects.json` is keyed by cloud id.
 */
export interface GitHubRepo {
  readonly visibility: GitHubRepoVisibility;
  /**
   * Where this row came from: `github` is the API's own answer, `reviewer` what a human said when
   * the window asked. Absent counts as authoritative, as it does for Jira.
   */
  readonly source?: GitHubRepoSource;
}

/**
 * The `owner/repo` key for a payload's routing fields, or `undefined` when the payload has no pair.
 * Lowercased, because GitHub's names are case-insensitive and case-preserving: `Jakuboola/
 * draftgate` and `jakuboola/draftgate` are one repository. Exported so the CLI's writer keys rows
 * the same way the reader looks them up.
 */
export function githubRepoKey(context: Record<string, unknown>): string | undefined {
  const name = repoName(context);
  return name === undefined ? undefined : (githubRepoKeyOf(name) ?? undefined);
}

/**
 * `owner/repo`, normalised, or `null` for anything that is not one: two segments, neither empty,
 * each a name GitHub could have issued. A bare `draftgate` is refused: defaulting an owner would
 * classify another account's repository of the same name.
 *
 * In `core` so the lookup key (`githubRepoKey`) and the config parser apply one rule. With two, a
 * payload's `owner: "a b"` becomes a key the parser never accepts, and the parser drops a
 * hand-written `"Jakuboola / draftgate"` such a lookup would match.
 */
export function githubRepoKeyOf(spelling: string): string | null {
  const parts = spelling.trim().toLowerCase().split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  // GitHub's own grammar for both halves: alphanumerics, hyphen, underscore, dot. Anything else is
  // not a name this could have come from, and accepting it would let a path or a URL in.
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `${owner}/${repo}`;
}

/**
 * The same pair in the spelling the payload used, for a human to read. Separate from
 * `githubRepoKey` so the banner does not ask about `jakuboola/draftgate` while the context strip
 * beside it says `Jakuboola/draftgate`.
 */
export function repoName(context: Record<string, unknown>): string | undefined {
  const owner = typeof context.owner === 'string' ? context.owner.trim() : '';
  const repo = typeof context.repo === 'string' ? context.repo.trim() : '';
  if (owner === '' || repo === '') return undefined;
  return `${owner}/${repo}`;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * GitHub's five alert types, case-insensitively, as the first line of a blockquote.
 *
 * Probed: all five render as a coloured callout with an icon and a title
 * (`.markdown-alert-note` and siblings), `[!note]` lowercase renders the same as `[!NOTE]`, and
 * `[!FOO]` stays an ordinary blockquote.
 */
const ALERT_RE = /^>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/gim;

/**
 * HTML tags GitHub renders as elements in a comment, probed one by one. A list, not a `<tag>`
 * shape: GitHub escapes `Array<string>` and `Vec<u8>`, prose an agent writes.
 *
 * A floor, not GitHub's allow-list: the probe put each tag in a paragraph on its own, which cannot
 * see a tag that needs a parent (a bare `<tr>x</tr>` is discarded by the HTML parser, not by the
 * sanitizer). A second probe settles those -- `<table><tr><td>cell` renders in full -- and `<a>`,
 * stripped bare and rendered with an `href`. A tag in neither list warns about nothing; the
 * preview shows the source either way.
 */
const HTML_RENDERED = [
  'details', 'summary', 'kbd', 'sub', 'sup', 'b', 'i', 'em', 'strong', 'del', 'ins', 'mark', 's',
  'tt', 'samp', 'var', 'q', 'br', 'hr', 'img', 'a', 'p', 'div', 'span', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'picture', 'source', 'video', 'ruby', 'rt', 'rp',
];

/**
 * HTML tags GitHub deletes, keeping the text inside, silently: `<u>underlined</u>` arrives as
 * `underlined`. Markdown has no underline, so `<u>` is exactly what an agent reaches for. Probed
 * the same way. `script` is escaped instead, arriving as visible literal text; it is listed here
 * because either way it does not execute.
 */
const HTML_STRIPPED = [
  'small', 'u', 'abbr', 'cite', 'dfn', 'figure', 'figcaption', 'script', 'style', 'iframe', 'form',
  'input', 'button', 'object', 'embed', 'link', 'meta',
];

/**
 * `<tag`, `<tag ...>` or `</tag>`, for a known tag name and nothing else, compiled once. Built per
 * prose segment it would be compiled on every keystroke, and every inline `` `code` `` span splits
 * a segment. Measured on a realistic 761-byte comment (13 prose segments, so 26 constructions per
 * keystroke): `convert()` takes 3.2us compiled once and 13.4us built per segment, against 0.84us
 * for the whole of Linear's render. At 64 KB it is 239us against 1155us. `mentionTokens.ts`'s
 * `GLOBAL_CLONES` makes the same trade.
 */
function tagMatcher(names: readonly string[]): RegExp {
  return new RegExp(`</?(${names.join('|')})(?=[\\s/>])`, 'gi');
}
const RENDERED_RE = tagMatcher(HTML_RENDERED);
const STRIPPED_RE = tagMatcher(HTML_STRIPPED);

/**
 * Every known tag in `text`, added to `into`. `matchAll` clones the shared `/g` pattern and does
 * not write `lastIndex` back, so no caller leaves state for the next (the footgun
 * `MentionTokenPattern` documents).
 */
function addTags(text: string, re: RegExp, into: Set<string>): void {
  for (const m of text.matchAll(re)) into.add(m[1]!.toLowerCase());
}

/**
 * An HTML comment GitHub HIDES from readers: its text, and whether it was ever closed.
 */
interface HiddenComment {
  readonly text: string;
  readonly unclosed: boolean;
  /** `[start, end)` of the whole comment, `<!--` to `-->` inclusive, in the body. */
  readonly range: readonly [number, number];
}

/** A line indented four or more (a tab reaching column four counts): indented code, or can be. */
const INDENTED = /^(?: {4}| {0,3}\t)/;

/**
 * Every HTML comment in `markdown` that GitHub hides from readers.
 *
 * PROBED through `POST /markdown` (mode `gfm`, context `Jakuboola/draftgate`):
 * `visible <!-- hidden inline secret --> text` came back `<p>visible  text</p>`, a block comment
 * spanning lines came back as nothing, a comment inside a code span came back as literal text, and
 * an unclosed `<!--` opening a line hid everything after it to the end of the body. The preview
 * draws the source, so the reviewer reads text nobody else will.
 *
 * Claimed only where CommonMark's rule cannot be read another way:
 *
 *  - a `<!--` at column 0 opens an HTML block, which runs to the line holding `-->` or, with none,
 *    to the end of the body (the unclosed case). Column 0 exactly: indented one to three it may be
 *    a list item's continuation, whose HTML block ends with the item, and indented four is code;
 *  - anywhere else, only a comment that closes on its own line, on a line not indented four or
 *    more. A `-->` on a later line may sit in the next block, and one never closed is literal text
 *    in CommonMark (not probed).
 *
 * Code is masked first (`maskCode`). An empty comment, or an unclosed one at the very end, hides
 * nothing and is not reported. One forward-only pass: this runs on every keystroke, over bodies up
 * to GitHub's 262,144 bytes.
 */
export function hiddenComments(markdown: string): HiddenComment[] {
  if (!markdown.includes('<!--')) return [];
  const masked = maskCode(markdown);
  const end = masked.length;
  const out: HiddenComment[] = [];
  const lineEnd = (from: number) => {
    const n = masked.indexOf('\n', from);
    return n === -1 ? end : n;
  };
  // Every search moves forward only, so the walk is linear however many comments go unclosed;
  // searching `-->` afresh from every `<!--` is quadratic: 312 ms on 262 KB of `a <!--` lines.
  let nextClose = -1;
  const closeFrom = (from: number) => {
    if (nextClose < from) {
      const c = masked.indexOf('-->', from);
      nextClose = c === -1 ? end : c;
    }
    return nextClose;
  };
  const found = (from: number, close: number) => {
    const text = markdown.slice(from + 4, close);
    if (text.trim() !== '') out.push({ text, unclosed: false, range: [from, close + 3] });
  };
  let lineStart = 0;
  let lineStop = lineEnd(0);
  for (let i = masked.indexOf('<!--'); i !== -1; ) {
    while (i > lineStop) {
      lineStart = lineStop + 1;
      lineStop = lineEnd(lineStart);
    }
    // `<!-->` and `<!--->` are complete comments in CommonMark, hence the search from `+ 2`.
    const close = closeFrom(i + 2);
    let next = i + 4;
    if (i === lineStart) {
      if (close === end) {
        const text = markdown.slice(i + 4);
        if (text.trim() !== '') out.push({ text, unclosed: true, range: [i, end] });
        break;
      }
      found(i, close);
      // The HTML block ends with the line holding `-->`, and the rest of that line is inside it.
      next = lineEnd(close) + 1;
    } else if (close + 3 <= lineStop && !INDENTED.test(masked.slice(lineStart, lineStart + 4))) {
      found(i, close);
      next = close + 3;
    }
    i = masked.indexOf('<!--', next);
  }
  return out;
}

interface Found {
  readonly alerts: readonly string[];
  readonly htmlRendered: readonly string[];
  readonly htmlStripped: readonly string[];
  readonly images: readonly { alt: string; url: string }[];
  readonly comments: readonly HiddenComment[];
}

/**
 * Everything the checks below need, in one pass over the prose regions of the body. Code-aware
 * through `segments`: a fence showing how to write an alert or a `<details>` is text about
 * markdown, and GitHub renders the fence, not its contents.
 */
function scan(body: string): Found {
  // Comments first, and every other scan reads the body without them: a tag, an alert or an image
  // inside a hidden comment is not rendered.
  const comments = hiddenComments(body);
  const markdown = blankRanges(body, comments.map((c) => c.range), ' ');
  const alerts = new Set<string>();
  const rendered = new Set<string>();
  const stripped = new Set<string>();

  // Two cheap guards, hoisted above the segment loop (per segment they would cost more than they
  // save): the ordinary draft has no `<`, `[!` or `![`. With the cached matchers above, a 1 KB
  // comment with none of the three takes 1.6us, against 20.9us without them.
  const mayHaveTags = markdown.includes('<');
  const mayHaveAlerts = markdown.includes('[!');

  if (mayHaveTags || mayHaveAlerts) {
    for (const { code, text } of segments(markdown)) {
      if (code) continue;
      if (mayHaveAlerts) for (const m of text.matchAll(ALERT_RE)) alerts.add(m[1]!.toUpperCase());
      if (mayHaveTags) {
        addTags(text, RENDERED_RE, rendered);
        addTags(text, STRIPPED_RE, stripped);
      }
    }
  }

  // Images over the whole body: `markdownImages` takes link spans off the full text, and an offset
  // into a slice is not one into the body. A fenced `![x](y)` is an accepted false positive (the
  // code is `info` and names the URL), rather than a second span-scanner that could drift.
  const images = markdown.includes('![')
    ? markdownImages(markdown).filter((i) => /^https?:/i.test(bareDestination(i.url)))
    : [];

  // Sorted once, at the end, so the message is stable.
  return {
    alerts: [...alerts],
    htmlRendered: [...rendered].sort(),
    htmlStripped: [...stripped].sort(),
    images,
    comments,
  };
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

function checkGitHub(found: Found): Warning[] {
  const out: Warning[] = [];

  if (found.alerts.length > 0) {
    out.push(
      warn({
        code: 'github/alert-becomes-callout',
        severity: 'info',
        message:
          // GitHub recognises NOTE, TIP, IMPORTANT, WARNING and CAUTION, in any case (`ALERT_RE`);
          // anything else stays an ordinary quote.
          `GitHub shows the quote${found.alerts.length === 1 ? '' : 's'} marked ` +
          `${found.alerts.map((a) => `[!${a}]`).join(', ')} as ` +
          `${found.alerts.length === 1 ? 'a coloured callout' : 'coloured callouts'} with an icon ` +
          `and title, not a plain quote, and hides the marker line. Leave the marker in place.`,
      })
    );
  }

  if (found.htmlStripped.length > 0) {
    const hasScript = found.htmlStripped.includes('script');
    const deleted = found.htmlStripped.filter((t) => t !== 'script');
    // One sentence per condition, joined: the form `mentionNote` in `core/src/mentionTokens.ts`
    // uses, so no combination of conditions leaves a stray space.
    const parts: string[] = [];
    if (deleted.length > 0) {
      parts.push(
        `GitHub silently removes <${deleted.join('>, <')}> and keeps only the text inside, so ` +
          'that formatting is lost.'
      );
    }
    if (deleted.includes('u')) {
      parts.push('Markdown has no underline to use instead.');
    }
    if (hasScript) {
      // Escaped rather than removed.
      parts.push('<script> arrives as visible text and does not run.');
    }
    out.push(warn({ code: 'github/html-stripped', severity: 'warning', message: parts.join(' ') }));
  }

  if (found.htmlRendered.length > 0) {
    out.push(
      warn({
        code: 'github/html-rendered',
        severity: 'info',
        message:
          // The preview shows the source because the body sent is the markdown the reviewer edits.
          `GitHub renders <${found.htmlRendered.join('>, <')}> as HTML. The preview shows the ` +
          `source; readers see the rendered result.`,
      })
    );
  }

  if (found.comments.length > 0) out.push(commentsHidden(found.comments));

  for (const img of found.images) {
    out.push(
      warn({
        code: 'github/image-proxied',
        severity: 'info',
        message:
          // GitHub's camo proxy: the stored body keeps the URL, and a reader's browser fetches the
          // picture from githubusercontent.com, never from the host serving it.
          `GitHub serves the image ${img.url} through its own proxy, so the image host never sees ` +
          `readers, and a URL GitHub cannot reach (private, signed or expiring) shows broken for ` +
          `everyone.`,
      })
    );
  }

  return out;
}

/** A comment's text as one short line: whitespace collapsed, and the head of a long one. */
function gist(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= 60 ? one : `${one.slice(0, 59)}…`;
}

/**
 * One warning for every hidden comment in the draft, naming what readers will not see. A `warning`,
 * `github/html-stripped`'s slot: the body is delivered, and part of what the reviewer reads is not
 * shown to anyone else. The unclosed case leads, because it hides the rest of the message.
 */
function commentsHidden(comments: readonly HiddenComment[]): Warning {
  const unclosed = comments.find((c) => c.unclosed);
  const closed = comments.filter((c) => !c.unclosed);
  const parts: string[] = [];
  if (unclosed) {
    parts.push(
      `An HTML comment opened with <!-- is never closed, so GitHub hides everything after it, ` +
        `starting "${gist(unclosed.text)}". Close it with --> or remove it.`
    );
  }
  if (closed.length > 0) {
    parts.push(
      `GitHub hides HTML comments, so readers will not see ` +
        `${closed.slice(0, 3).map((c) => `"${gist(c.text)}"`).join(', ')}` +
        `${closed.length > 3 ? ` and ${closed.length - 3} more` : ''}. Remove the <!-- --> ` +
        `markers if they should.`
    );
  }
  return warn({ code: 'github/html-comment-hidden', severity: 'warning', message: parts.join(' ') });
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/**
 * GitHub's plain-text tokens: one that names a person, and three that name a thread.
 *
 * The username is matched on shape, which is not sufficient, probed: `@zzznotarealuser99887`
 * renders as plain text while `@Jakuboola` and `@torvalds` become real mention links. GitHub
 * resolves what exists and passes the rest through, Linear's trade, and the advice says so.
 * `@org/team` is not matched: probed, `@github/docs` renders as plain text through this endpoint.
 *
 * `#123`, `GH-123` and `owner/repo#123` all render as issue links, and each posts a
 * `cross-referenced` event on the thread it names (verified read-only against `nodejs/node#1`,
 * whose timeline carries them from other issues and from `nodejs/node-v0.x-archive`), hence the
 * `reference` kind rather than `channel`, which notifies nobody. Probed, `#999999` and `#123456`
 * render as plain text (no such issue), so a six-digit hex colour outside a code span is marked;
 * the advice names the limit.
 */
const GITHUB_TOKENS: readonly MentionTokenPattern[] = [
  /*
   * GitHub's username grammar: alphanumerics and single interior hyphens, up to 39. The left guard
   * `(?<![\w@<\/])` keeps out the `@example` of `ada.lovelace@example.com` (`profiles/linear.ts`
   * carries the same guard); the right guard `(?!\/)` keeps `@github` out of `@github/docs`.
   */
  { re: /(?<![\w@<\/])@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?!\/)\b/, kind: 'user' },
  /*
   * `owner/repo#123` first: the bare `#123` pattern would otherwise claim its tail. `must` is a
   * cost guard: this pattern's unanchored leading class costs 26.7us over 16 KB of prose where its
   * siblings cost 0.64us, because the engine has no prefix to filter on.
   */
  { re: /\b[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+\b/, kind: 'reference', must: '#' },
  { re: /(?:^|(?<=[\s([]))#\d+\b/, kind: 'reference', must: '#' },
  { re: /\bGH-\d+\b/, kind: 'reference', must: 'GH-' },
];

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/**
 * The tools whose audience claim has been probed, matched on the tool half of an MCP name: the
 * eight write tools whose schemas were read. What each writes lands in the repository named by
 * `owner`/`repo`, readable by exactly its readers. Another tool may write elsewhere (a gist, a
 * discussion in another org, a release draft), so it gets `unknown` naming itself
 * (`POSTS_REQUEST_COMMENT`'s argument, one destination over).
 */
const PROBED_TOOLS =
  /(?:^|__)(?:add_issue_comment|update_issue_comment|issue_write|create_pull_request|update_pull_request|add_comment_to_pending_review|add_reply_to_pull_request_comment|pull_request_review_write)$/;

/**
 * Who can read this, from the repository's visibility. `owner` and `repo` are names, and turning
 * one into a visibility is an authenticated call draftgate does not make, so it is an operator
 * fact, like which Jira projects are service desks: `cli/src/githubRepos.ts`, filled by
 * `tools/github-repos/`.
 *
 * `unknown` is loud, not a default: `private` would let a public comment pass as internal, and
 * `public` would cry wolf on every internal repo. So it asks once and remembers.
 */
export function githubAudience(
  context: Record<string, unknown>,
  facts: GitHubAudienceFacts & GitHubAudienceAnswer = {}
): Audience | undefined {
  const tool = facts.toolName;
  const key = githubRepoKey(context);
  // The payload's own spelling for the human: "Is jakuboola/draftgate public?" beside a strip
  // showing `Jakuboola/draftgate` names a repository nobody typed. The key is for the lookup.
  const where = repoName(context) ?? 'this repository';

  // Narrowed by its type: `audienceFor` drops an answer outside this profile's `reviewerAnswers`
  // (`ownAnswerFor`) before this runs, so a Jira `service_desk` never becomes a visibility here.
  const answered = facts.classified?.value;

  const visibility = answered ?? (key === undefined ? undefined : facts.repos?.[key]?.visibility);

  if (visibility === undefined) {
    return {
      kind: 'unknown',
      label: 'Audience unknown',
      detail:
        `draftgate does not know whether ${where} is public or private, and the two are a message ` +
        `to the internet and a message to a team. It holds no GitHub credentials and never asks ` +
        `GitHub about your repositories, so this is a fact only you have.` +
        (tool !== undefined && !PROBED_TOOLS.test(tool)
          ? ` Nothing has been probed about "${tool}" either, so even a known repository would ` +
            `not settle where this one lands.`
          : ''),
      ...(key === undefined
        ? {
            unavailable:
              'This payload carries no owner/repo pair, so there is nothing to look up or ' +
              'remember. Check the route: every GitHub write tool takes both.',
          }
        : {
            ask: {
              question: `Is ${where} public?`,
              options: [
                { label: 'Public -- anyone can read it', value: 'public' },
                { label: 'Private -- only people with access', value: 'private' },
                { label: 'Internal -- everyone in the enterprise', value: 'internal' },
              ],
            },
          }),
    };
  }

  if (visibility === 'public') {
    return {
      kind: 'public',
      label: 'Public repository',
      detail:
        `Anyone on the internet can read this, including people who are not logged in, and search ` +
        `engines index it. It is attributed to the account whose token sent it and editing it ` +
        `later leaves an edit history anyone can open.`,
    };
  }

  // Same `kind` for both: each is a team rather than the internet.
  if (visibility === 'internal') {
    return {
      kind: 'internal',
      label: 'Internal repository',
      detail:
        `Everyone in the enterprise can read ${where}. That is a wider room than a private ` +
        `repository and a narrower one than the internet.`,
    };
  }
  return {
    kind: 'internal',
    label: 'Private repository',
    detail: `Only people with access to ${where} can read this.`,
  };
}

/**
 * What a GitHub audience decision needs beyond the payload, declared with the destination that
 * reads it, as Jira's are in `jira.ts`.
 */
export interface GitHubAudienceFacts {
  /** Keyed by `owner/repo` lowercased, from the operator's config. See `cli/src/githubRepos.ts`. */
  repos?: Record<string, GitHubRepo>;
}

/**
 * The reviewer's own answer about this repository, which outranks the config lookup: Jira's
 * `JiraAudienceAnswer` for GitHub. Beside the facts rather than in them because the composed
 * `AudienceFacts` carries one wide `classified`, which an extending interface cannot narrow;
 * `audienceFor` makes this narrower type true at runtime. The window sets it the moment somebody
 * answers and re-asks the profile, so the banner is the real one before they decide.
 */
export type GitHubAudienceAnswer = AudienceAnswer<'github', GitHubRepoVisibility>;

/**
 * The three values `classified` may carry for this destination: the profile's `reviewerAnswers`
 * (see `DestinationProfile.reviewerAnswers`). `ask.options` spells them again with labels;
 * `core/test/audience.test.ts` reads the options back and requires every one to be accepted, so a
 * renamed visibility cannot become a button that silently remembers nothing.
 */
export const GITHUB_REPO_VISIBILITIES: readonly GitHubRepoVisibility[] = [
  'public',
  'private',
  'internal',
];

/**
 * The one predicate for that vocabulary. `cli/src/githubRepos.ts` re-exports it rather than keep
 * its own set, which a fourth visibility would leave silently dropping rows (`jiraProjects.ts`
 * re-exports its sibling likewise). A type predicate, so callers narrow by proof rather than by a
 * cast; they validate strings at the store's boundary (the config reader off disk, and the store
 * before it writes an answer). The reviewer's answer is narrowed in `audienceFor`.
 */
export function isGitHubRepoVisibility(v: unknown): v is GitHubRepoVisibility {
  return typeof v === 'string' && (GITHUB_REPO_VISIBILITIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** The tool both of this profile's probed title facts (length, line breaks) were measured on. */
const ISSUE_WRITE = /(?:^|__)issue_write$/;

export const githubProfile = {
  name: 'github',
  displayName: 'GitHub',
  /**
   * The markdown is the payload: each of the eight gated tools takes a GFM `body` string and GitHub
   * stores the markdown (`POST /markdown` is a rendering endpoint), so `convert` is the identity.
   */
  mode: 'preview-only' as const,
  extraToolInput: {} as const,
  /**
   * The values in `surface/src/styles/github.css` were read out of Chromium off GitHub's own
   * rendered comment surface by `tools/github-ruler/`, and cross-checked against a live GitHub page
   * (a different DOM, ancestors and origin, sharing only the stylesheets) with zero unexpected
   * disagreements.
   *
   * The declaration a `*-tokens` fetch would take, `.markdown-body { font-size: 16px }`, is wrong
   * for a comment: the same element carries `.comment-body` from another bundle at equal
   * specificity, and a comment renders at 14px. Every heading is sized in `em`, so trusting the
   * sheet would make all six 14% too large, h1 at 32px against a real 28px.
   */
  previewFidelity: 'probe-derived' as const,
  /** Both, measured: GitHub serves `data-light-theme="light"` and `data-dark-theme="dark"`. */
  themes: ['light', 'dark'] as const,
  /**
   * Everything: `convert()` is the identity function. All six heading levels on measured
   * distinctness: 28 / 21 / 17.5 / 14 / 12.25 / 11.9 px, h1 and h2 with a rule under them and h6
   * in muted grey, so even h5 and h6, 0.35px apart, are told apart by colour.
   */
  toolbar: {
    headingLevels: [1, 2, 3, 4, 5, 6],
    marks: ['bold', 'italic', 'strike', 'code', 'link'],
    blocks: ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'rule'],
    inserts: ['emoji'],
  } as const,
  mentions: {
    tokens: {
      patterns: GITHUB_TOKENS,
      advice:
        'GitHub resolves a name or a number that EXISTS and passes the rest through as plain text ' +
        '-- probed: @torvalds becomes a link, @zzznotarealuser99887 does not, and #999999 does ' +
        'not either. draftgate holds no GitHub credentials, so it marks these on their shape and ' +
        'cannot tell you which will resolve. A reference that does resolve also posts a ' +
        'cross-reference on the thread it names, where anyone watching that thread can see it.',
    },
    chips: null,
    // No link is a mention here: a link to a profile is drawn as a link, so the preview draws one.
    links: null,
  },
  /** GitHub draws the picture where it was written, mid-sentence if that is where it is. */
  mediaPlacement: 'inline' as const,
  rendersMedia: true,
  // Asked of GitHub's own renderer (`POST /markdown`, gfm): `**`code` and words**` comes back
  // `<strong><code>code</code> and words</strong>`, `*`c` italic*` as `<em><code>c</code>
  // italic</em>`, `~~`c` struck~~` as `<del>...</del>`, and `[**`c` x**](url)` as one anchor.
  // See `CodeSpanMarks`.
  codeSpanMarks: 'any',
  listItemBlocks: 'all',
  // Not probed here, so the converter keeps `<url|label>` as the text it was written as.
  angleLinkLabels: false,
  targetIdentity: {
    requiredFields: ['owner', 'repo'],
    // GitHub's names are case-insensitive and case-preserving, which is also why `githubRepoKey`
    // lowercases and why `githubRepos.ts` keys its config that way.
    caseFolded: ['owner', 'repo'],
    ambiguity:
      'a repository is named by BOTH halves -- one alone matches repositories that are not the ' +
      'scratch one',
  },
  // None: all eight live schemas carry a whole `body`, with no patch, edit-operations array or
  // other delta spelling.
  deltaFields: [],

  bodyField: 'body',
  /**
   * `owner` and `repo` are the sole input to `githubAudience` and to the CLI's writer.
   * `issue_number` and `pullNumber` are both here because the connector spells the same idea
   * snake-case in the issue tools and camel-case in the pull-request ones.
   */
  contextFields: ['owner', 'repo', 'issue_number', 'pullNumber'],

  /**
   * PROBED through `gh api`, an issue comment: 262,144 ASCII characters accepted, and
   * 131,073 x `é` -- 262,146 UTF-8 BYTES, half as many characters -- refused with a 422. So the
   * unit is bytes, and the error text, which says "maximum is 65536 characters", is wrong twice.
   */
  bodyLimit: { accepted: 262_144, refused: 262_145, unit: 'utf8-bytes' },
  /**
   * Probed through REST on an issue, which is what `issue_write` writes: a title was accepted at
   * 1,024 characters and refused at 4,096 (422, whose text wrongly says "maximum is 256"). The
   * cutoff between them was not found, so past 4,096 is an `error` and between the two a `warning`
   * saying it is not known. A pull request's title (`create_pull_request`, `update_pull_request`)
   * was not probed and gets no claim.
   */
  lineLimits: { title: { accepted: 1_024, refused: 4_096, unit: 'characters', tools: ISSUE_WRITE } },
  // PROBED on an issue `title` (REST): LF and CR are both stored verbatim.
  lineBreaks: { title: { lf: 'stored', cr: 'stored', tools: ISSUE_WRITE } },

  convert(markdown: string): { converted: string; warnings: Warning[] } {
    // The identity function, like Linear's: GitHub stores the markdown it is given.
    return {
      converted: markdown,
      warnings: [
        ...checkGitHub(scan(markdown)),
        ...lengthWarnings({
          code: 'github/body-too-long',
          subject: 'This draft',
          value: markdown,
          limit: githubProfile.bodyLimit,
          refuses: 'GitHub refuses a comment',
        }),
      ],
    };
  },

  audienceFor(context: Record<string, unknown>, facts: GitHubAudienceFacts & GitHubAudienceAnswer) {
    return githubAudience(context, facts);
  },
  /**
   * `GITHUB_REPO_VISIBILITIES` itself: here the question's options are the whole vocabulary, unlike
   * Jira, whose config file may hold two more. `core/test/audience.test.ts` requires this and the
   * options to be equal.
   */
  reviewerAnswers: GITHUB_REPO_VISIBILITIES,

  audienceProbed(tool: string): boolean {
    return PROBED_TOOLS.test(tool);
  },

  /**
   * `owner/repo#123`, from the payload alone: GitHub's routing fields are the human name
   * (`Jakuboola/draftgate#30`), where Jira needs `sites` to turn a cloud id into a hostname. So it
   * works on a machine whose `github-repos.json` is empty, which is every machine on its first
   * review.
   */
  destinationLabel(context: Record<string, unknown>): string | undefined {
    const name = repoName(context);
    if (name === undefined) return undefined;
    const number =
      typeof context.issue_number === 'number'
        ? context.issue_number
        : typeof context.pullNumber === 'number'
          ? context.pullNumber
          : undefined;
    return number === undefined ? name : `${name}#${number}`;
  },
} satisfies DestinationProfile;
