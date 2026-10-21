/**
 * Slack destination profile.
 *
 * Mode is `preview-only`: `slack_send_message` exposes a single content field, `message`,
 * typed as a markdown string, with no `blocks` parameter. The markdown is sent verbatim and Slack
 * converts it server-side.
 *
 * Read from `slack_read_channel`, Slack appears to destroy tables, flatten headings, invert task
 * state, renumber ordered lists and drop code-fence languages: the read-back flattens Block Kit to
 * text. The rendered client shows the torture fixture with:
 *
 *   - `#` and `##` as real headings, visibly different sizes (see 3. below)
 *   - the GFM table as a real table, with borders and a bold header row
 *   - the ordered list numbered 1, 2, 3 correctly, with nested bullets as indented hollow circles
 *   - `- [ ]` / `- [x]` as real checkboxes, the checked one ticked
 *   - the code fence with a "Python" label, line numbers, and syntax highlighting
 *   - blockquote with its left rule; bold, italic, inline code and strikethrough all correct
 *   - underscores as CommonMark reads them: `_x_` italic, `__x__` bold, `___x___` both, and an
 *     underscore inside a word text (ten lines through a gated send, read off a screenshot)
 *   - `---`, `***` and `___` each as a visible divider (labelled markers either side of each form)
 *
 * So `converted` is the markdown itself, as for Linear, and the preview renders it with Slack
 * styling.
 *
 * ## What is lost
 *
 * Each verified against a live render, and each reported by a code below:
 *
 *   0. A plain bullet in a list that also holds a `- [ ]` item arrives as an unchecked to-do
 *      (`coercedBullets`, `slack/list-item-becomes-task`): the one loss that changes what a line
 *      says rather than how it looks.
 *   1. `![alt](url)` renders as a plain link, never an image, and is not unfurled -- confirmed with
 *      a real reachable image URL: no picture, no thumbnail, no card (`slack/image-becomes-link`).
 *   2. A bare URL's label is elided in the middle, host/first/…/last, from five path segments
 *      (`slackElidesLabel`, `slack/url-label-elided`).
 *   3. h3..h6 collapse into one rendering. Measured off the live DOM, a mrkdwn message renders each
 *      heading as `p-header_block__text` with a level and the `flat_scale` message variant:
 *
 *          `#`              level_1   18px / 1.33334 / 900
 *          `##`             level_2   15px / 1.46668 / 900
 *          `###`..`######`  level_3   15px / 1.46668 / 700
 *
 *      All six confirmed individually in one message. So `##` is distinct from `###` -- same size,
 *      different weight -- and only h3..h6 collapse (`slack/heading-level-collapsed`). A size read
 *      off a screenshot cannot see a weight split at one size, so read the DOM.
 *      `p-rich_text_header` is the WYSIWYG composer's rule set: the same type scale, which
 *      cross-checks the sizes, but not the level-to-weight mapping an agent's markdown reaches.
 *      Without `flat_scale`, `level_1` is 22px: a canvas or file unfurl, not a message.
 *   4. A list item's code block, second paragraph or quote is flattened into the item's text, so
 *      it is moved out (`movedOut`, `slack/list-item-block-moved-out`).
 *   5. A bare URL ending a line followed by text takes the next line's first word into its label
 *      and the line break vanishes (`slack/url-swallows-next-line`).
 *   6. A line starting with an escaped `\>` is drawn as a quote (`slack/escaped-quote-marker`).
 */

import { type Warning, warn } from '../warnings';
import { lengthWarnings } from '../lengthLimit';

import type { DestinationProfile } from './index';
import type { MentionTokenPattern } from '../mentionTokens';
import {
  markdownImages, markdownLinkSpans, maskCode, replaceLinkSpans, segments,
} from '../markdown';
import { bareUrlEnd } from '../bareUrl';
import { writeLink } from '../linkDestination';
import { isRule, mayHoldListItem } from '../adf/markdownToAdf';
import { baselineFor, editorOptionsFor, markdownToAdfFor } from '../editor';

// ---------------------------------------------------------------------------
// Scanning the draft for what Slack changes
// ---------------------------------------------------------------------------

/**
 * Will Slack shorten the label it shows for this bare URL?
 *
 * PROBED: a ladder of eight URLs, then four more separating the two variables the first ladder
 * confounded. It is the path segment count, not the length: four segments at 87 characters
 * renders in full, five segments at 29 characters is shortened. Onset is exactly five; a rule read
 * off one example ("more than two segments") warns about URLs Slack renders in full.
 *
 *   example.org/documentation/configuration/extractors/snowflake-database-connector   4 segs, full
 *   example.org/a/b/c/d/e                                                             5 segs, cut
 *
 * No label is returned: how many leading segments survive depends on rendered width (in the same
 * run `example.org/a/b/.../e` kept two, `example.org/docs/.../snowflake` one). Not modelled: a very
 * long single segment, and a query string, are both truncated with a trailing ellipsis at what
 * looked like different character counts (~29 and ~53), which points at rendered width again.
 */
export function slackElidesLabel(url: string): boolean {
  /*
   * Path segments only: the query and fragment are cut off first, so
   * `example.org/search?q=a/b/c/d/e` (one path segment) does not warn. Empty segments are dropped:
   * `a//b//c` shows a reader three, and nothing about `//` was probed.
   */
  const path = url.replace(/^https?:\/\//, '').split(/[?#]/)[0]!;
  const [, ...segments] = path.split('/');
  return segments.filter((s) => s !== '').length >= 5;
}

/**
 * What counts as a bare URL, written once for both scans (`url-label-elided` anywhere in a line,
 * `url-swallows-next-line` at its end), so they cannot disagree about what is a URL. Greedy:
 * `bareUrlEnd`, shared with the converter, decides where the URL ends.
 */
const BARE_URL = String.raw`https?:\/\/[^\s<>|)]+`;

/** A bare URL at the very end of a line, the only position where the swallow happens. */
const LINE_END_BARE_URL_RE = new RegExp(String.raw`(?:^|\s)(${BARE_URL})$`);

const HEADING_RE = /^ {0,3}(#{1,6})\s+\S/gm;
const BARE_URL_RE = new RegExp(String.raw`(?:^|[\s(])(${BARE_URL})`, 'g');

interface Found {
  /** Markdown images, which Slack renders as links. */
  images: { alt: string; url: string }[];
  /** Bare URLs whose displayed label will be elided. */
  elidedUrls: string[];
  /** Distinct heading levels >= 3 in use: only h3..h6 render alike (this file's header, 3.). */
  collapsedLevels: number[];
  /**
   * Bare URLs that end a line followed by more text, with both repairs the message names, each as
   * the whole draft: `asLink` shows the full URL as the label, `withBlankLine` keeps the bare URL
   * and Slack's elided `example.org`. Both verified to render correctly.
   */
  swallowing: { url: string; nextWord: string; asLink: string; withBlankLine: string }[];
  /** Plain bullet items that will arrive as unchecked to-dos. See `coercedBullets`. */
  coercedBullets: string[];
}

/**
 * Blank out markdown links and images, preserving length and line structure. Deleting them would
 * pull what followed onto the end of the line and manufacture a false "URL at end of line".
 */
function maskLinks(text: string): string {
  return replaceLinkSpans(text, (m) => '\u00b7'.repeat(m.length));
}

/**
 * A bullet-list item (`-`, `*`, `+`), and whether it is a to-do. Not ordered items: measured, a
 * task item inside an ordered run does not coerce the numbered items (they keep their numbers and
 * the task splits off), so an ordered item breaks a bullet run.
 */
const BULLET_ITEM_RE = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/;
/** Any list item at all, ordered included -- what ENDS a bullet run without being part of it. */
const ANY_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Plain bullet items Slack will render as unchecked checkboxes. Slack types the list, not the
 * item: `data-stringify-type=check-list` sits on the `<ul>`, so one `- [ ]` in a bullet run makes
 * every plain item in it a to-do. Measured against a live render, four cases: order does not
 * matter; a blank line does not separate runs (Slack merges them); an ordered run is untouched.
 *
 * Siblings are reported at any indent, an inference from the mechanism rather than a probe: this is
 * a `warning`, so over-reporting costs a sentence while under-reporting sends a phantom to-do (the
 * trade `link/unsafe-href` makes). A bullet nested under a task item is not reported: nothing
 * measured says Slack types a child list from its parent, and two `listKinds` tests assert that
 * body is clean. The probe that would settle it: `- [ ] a` / two-space `- [ ] b` / two-space
 * `- c`, and whether `c` gets a checkbox.
 */
function coercedBullets(text: string): string[] {
  const out: string[] = [];
  // Per indent within the run, keyed on the indent's length so a tab and a space are not two levels
  // (a mixed-indent draft is unprobed; collapsing it reports less).
  let run = new Map<number, { plain: string[]; hasTask: boolean }>();
  const flush = (): void => {
    for (const level of run.values()) if (level.hasTask) out.push(...level.plain);
    run = new Map();
  };
  for (const line of text.split('\n')) {
    // A blank line does not end a run: Slack merges across it (probed). Anything else that is not
    // a bullet item does; a paragraph between two lists kept the probe's four cases apart.
    if (line.trim() === '') continue;
    // A rule (`* * *`) is a divider, not a bullet, and the converter reads it so too.
    const m = isRule(line) ? null : BULLET_ITEM_RE.exec(line);
    if (!m) {
      // An ordered item is not part of a bullet run and does not continue one; nor is prose.
      flush();
      continue;
    }
    const indent = (m[1] ?? '').length;
    let level = run.get(indent);
    if (!level) {
      level = { plain: [], hasTask: false };
      run.set(indent, level);
    }
    if (m[3]) level.hasTask = true;
    else if (m[4]!.trim() !== '') level.plain.push(m[4]!.trim());
  }
  flush();
  return out;
}

function inspect(markdown: string): Found {
  const found: Found = {
    images: [], elidedUrls: [], collapsedLevels: [], swallowing: [], coercedBullets: [],
  };
  const levels = new Set<number>();

  for (const { code, text } of segments(markdown)) {
    if (code) continue;

    // Per segment, so a checklist inside a code fence is not read as one.
    found.coercedBullets.push(...coercedBullets(text));

    HEADING_RE.lastIndex = 0;
    for (const m of text.matchAll(HEADING_RE)) {
      const level = (m[1] ?? '').length;
      // `>= 3`: `##` renders at its own weight, so it collapses against nothing.
      if (level >= 3) levels.add(level);
    }

    // One span scan for both uses below: collecting the images, and blanking the links out of the
    // bare-URL scan. `markdownLinkSpans` is linear (see `linkLabelStart`); do not match
    // `!?[label](dest)` with `/!?\[[^\]]*\]\([^)\s]+\)/g`, which is quadratic in unclosed `[` --
    // 1.7 s per pass on 100 KB of them.
    const links = markdownLinkSpans(text);
    found.images.push(...markdownImages(text, links));

    // Bare URLs only: skip any already inside a markdown link or image.
    const withoutLinks = replaceLinkSpans(text, () => '', links);
    for (const m of withoutLinks.matchAll(BARE_URL_RE)) {
      // Judged on the trimmed URL, which can only remove segments -- so it fires less, never more.
      const url = bareUrlEnd(m[1]!);
      if (slackElidesLabel(url)) {
        found.elidedUrls.push(url);
      }
    }
  }

  // The line-swallow scan runs over the whole markdown, because the next line may sit across a
  // `segments()` boundary; `maskCode` is the same code model with the lines left intact.
  //
  // `\r?\n`, so the `$` anchor also matches in a CRLF document, and split keeping the line endings
  // so an absolute offset into `markdown` is exact: the repairs splice the original string, which
  // keeps a CRLF draft CRLF.
  const parts = markdown.split(/(\r?\n)/);
  const lines: string[] = [];
  const starts: number[] = [];
  for (let k = 0, at = 0; k < parts.length; k += 2) {
    lines.push(parts[k]!);
    starts.push(at);
    at += parts[k]!.length + (parts[k + 1]?.length ?? 0);
  }
  const masked = maskCode(markdown).split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    // Exact: neither mask can add a `://` the raw line lacked. Most lines stop here, before any
    // allocation.
    if (!line.includes('://')) continue;

    const m = LINE_END_BARE_URL_RE.exec(maskLinks(masked[i]!));
    if (!m) continue;
    const next = lines[i + 1]!;
    // A blank line stops it -- verified: the same URL with a blank line after rendered correctly.
    if (next.trim() === '') continue;
    // Read the URL from the UNMASKED line at the same offset; both masks preserve positions.
    const end = m.index + m[0]!.length;
    // FIRES on the untrimmed candidate (whether Slack swallows after a full stop is not probed), and
    // names the trimmed URL.
    const url = bareUrlEnd(line.slice(end - m[1]!.length, end));
    // The repair, spliced into the original string: the bare URL becomes `[url](url)`. Only
    // `url.length` characters are replaced, so trailing punctuation stays outside the link.
    const from = starts[i]! + end - m[1]!.length;
    const asLink = markdown.slice(0, from) + writeLink(url, url) + markdown.slice(from + url.length);
    // The other repair: a blank line after the URL's line, a copy of that line's own ending.
    const eol = parts[i * 2 + 1] ?? '\n';
    const lineEnd = starts[i]! + line.length + eol.length;
    const withBlankLine = `${markdown.slice(0, lineEnd)}${eol}${markdown.slice(lineEnd)}`;
    found.swallowing.push({
      url,
      nextWord: next.trim().split(/\s+/)[0] ?? '',
      asLink,
      withBlankLine,
    });
  }

  // Only a loss if two or more of H3..H6 are used together: one alone has nothing to collapse
  // against, since Slack renders it as its single third heading style.
  if (levels.size >= 2) found.collapsedLevels = [...levels].sort((a, b) => a - b);

  return found;
}

/**
 * A block written inside a list item that Slack would flatten into the item's text is sent just
 * after the item instead, and the list resumes after it, numbered on.
 *
 * PROBED in a self-DM, twice. Inside the item, a code block lost its formatting and was glued to
 * the text around it (`it:SELECT id, name`), paragraphs were glued together with no space
 * (`bun testand then:`) and a quote lost its bar. Written after the item with the list resumed as
 * `2.`, each rendered as its own formatted block and the numbering continued. Nested lists render
 * inside an item (the torture fixture), so they stay. Moved and disclosed, never blocked.
 *
 * Counted by the converter that does the move (`listItemBlocks: 'lists'`); a checklist item's list
 * moved out behind such a block is tallied as `unnestedFromTasks`. Returns the body too: the editor
 * can hold a code block inside an item again (typed, pasted, undone), and `converted` is what
 * `wireBody` sends, so the note describes the body that ships. Only a body that moves is
 * re-serialised.
 */
function movedOut(markdown: string): { body: string; warnings: Warning[] } {
  // Every Slack keystroke renders, so a body with no list skips the conversion (2.5 ms on 40 KB).
  if (!mayHoldListItem(markdown)) return { body: markdown, warnings: [] };
  const { report } = markdownToAdfFor(markdown, editorOptionsFor(slackProfile));
  const n = report.movedOutOfListItems + report.unnestedFromTasks;
  if (n === 0) return { body: markdown, warnings: [] };
  // The load's own round trip, so the body sent and the body a reviewer is first shown are one
  // spelling. A second conversion, paid only by a body that moves.
  return { body: baselineFor({ ...slackProfile, canonical: markdown }).body, warnings: [
    warn({
      code: 'slack/list-item-block-moved-out',
      severity: 'warning',
      message:
        // Slack glues a list item's code block, extra paragraph or quote into the item's text;
        // every other block but a nested list is moved the same way.
        `${n === 1 ? 'A block inside a list item arrives' : `${n} blocks inside list items arrive`} ` +
        'just after the item, outside the list, because Slack cannot show ' +
        `${n === 1 ? 'it' : 'them'} inside the item. Every word arrives; only the indentation is lost.`,
    }),
  ] };
}

/**
 * Up to two items, quoted and clipped, then `...` when there are more: how a warning names lines the
 * reviewer should find. Clipped by code POINT, so an emoji at the edge is not split in two.
 */
function quotedSample(items: readonly string[]): string {
  const quoted = items.slice(0, 2).map((t) => {
    const points = Array.from(t);
    return `"${points.length > 40 ? `${points.slice(0, 39).join('')}…` : t}"`;
  });
  return quoted.join(', ') + (items.length > 2 ? ', ...' : '');
}

/**
 * `slack/escaped-quote-marker`, for lines of the sent body that start with an escaped `>`, which
 * Slack draws as a quote. Probed: Linear honoured every line-start escape the writer sends, and so
 * did Slack but for this one -- `\> not a quote` drew the quote bar, the `>` gone. The writer sends
 * this spelling for any line the reviewer sees starting with `>` (`escapeLineStarts`).
 *
 * Read off what is sent (`movedOut`'s body), not the draft: a block moved out of a list item loses
 * its indent, so `  \> b` goes out at column 0. Column 0 only, outside a fenced code block, the
 * shape probed (a paragraph's continuation; a first line follows from the same rule). A code span
 * over lines is not masked and its line is named, erring toward saying too much; behind a list
 * marker, inside a quote or indented was not probed and earns nothing.
 */
function escapedQuoteWarnings(sent: string): Warning[] {
  if (!sent.includes('\\>')) return [];
  const raw = sent.split(/\r?\n/);
  const masked = maskCode(sent).split(/\r?\n/);
  // As the reviewer reads them: the escaping backslash dropped, so the named text starts `>`.
  const lines = raw.flatMap((line, i) => (masked[i]!.startsWith('\\>') ? [line.slice(1).trimEnd()] : []));
  if (lines.length === 0) return [];
  /*
   * A `warning`: the line reaches the reader as a quote, the `>` gone. No spelling of a leading `>`
   * that Slack keeps as text was probed, so there is no repair, and draftgate does not slip in an
   * invisible character the reviewer never saw.
   */
  const one = lines.length === 1;
  return [
    warn({
      code: 'slack/escaped-quote-marker',
      severity: 'warning',
      message:
        `${one ? 'A line starts' : `${lines.length} lines start`} with '>' ` +
        `(${quotedSample(lines)}), which Slack shows as ${one ? 'a quote' : 'quotes'}: the '>' ` +
        `disappears. Reword ${one ? 'the line so it does' : 'them so they do'} not start with '>'.`,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Every code here is `info` or `warning`, like `slack/escaped-quote-marker` in `convert()`: Slack
 * delivers every word, and `error` means the destination rejects or loses the content. The one
 * Slack `error`, `slack/body-too-long`, is a length refusal in `convert()`.
 * `url-swallows-next-line` corrupts (a link label absorbs a word and a line break vanishes) and is
 * still a `warning`: the reviewer is told what will happen and can fix it in the editor.
 */
function checkSlack(found: Found): Warning[] {
  const out: Warning[] = [];

  for (const img of found.images) {
    out.push(
      warn({
        code: 'slack/image-becomes-link',
        severity: 'warning',
        message:
          `Slack shows the image ${img.url} as a plain link${img.alt ? ` labelled "${img.alt}"` : ''}, ` +
          `with no picture or preview. Upload the file to the channel if readers need to see it.`,
      })
    );
  }

  if (found.coercedBullets.length > 0) {
    /*
     * A `warning`, not `info`: it changes what the line says. "Ask the customer for logs" written
     * as a bullet arrives as an unfinished task. Not repairable: a numbered list or separate
     * messages avoid it, and neither is a transform draftgate can apply to somebody's prose. A
     * blank line, the obvious repair, does not avoid it (probed), so the message says so.
     */
    const n = found.coercedBullets.length;
    // Capped (`quotedSample`) because the message sits at the top of the window.
    const named = quotedSample(found.coercedBullets);
    out.push(
      warn({
        code: 'slack/list-item-becomes-task',
        severity: 'warning',
        message:
          `${n === 1 ? 'A plain bullet' : `${n} plain bullets`} (${named}) ` +
          `${n === 1 ? 'shares' : 'share'} a list with a '- [ ]' item, so Slack shows ${
            n === 1 ? 'it as an unchecked to-do' : 'them as unchecked to-dos'
          }, even across a blank line. Number the plain items or send them separately.`,
      })
    );
  }

  if (found.collapsedLevels.length >= 2) {
    out.push(
      warn({
        code: 'slack/heading-level-collapsed',
        severity: 'info',
        message:
          `Heading levels ${found.collapsedLevels.map((l) => 'h' + l).join(', ')} look the same ` +
          `in Slack: '#' is large, '##' is body size in black, and '###' to '######' are bold ` +
          `body text. Use fewer levels if the hierarchy matters.`,
      })
    );
  }

  for (const { url, nextWord, asLink, withBlankLine } of found.swallowing) {
    out.push(
      warn({
        code: 'slack/url-swallows-next-line',
        severity: 'warning',
        message:
          // Probed on Slack, and both repairs below render correctly there.
          `Slack joins "${nextWord}" from the next line onto the link ${url} and drops the line ` +
          `break. Write [text](${url}), or leave a blank line after the URL.`,
        // Both: they render differently and the reviewer picks. See `Warning.fixes`.
        fixes: [
          { label: 'Write it as an explicit link', body: asLink },
          { label: 'Add a blank line after it', body: withBlankLine },
        ],
      })
    );
  }

  for (const url of found.elidedUrls) {
    out.push(
      warn({
        code: 'slack/url-label-elided',
        severity: 'info',
        message:
          // How much is kept depends on the reader's window; see `slackElidesLabel`.
          `Slack shortens the middle of the link text for ${url}, a URL with five or more path ` +
          `segments; the link still opens the full URL. Use [text](url) if the text matters.`,
      })
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Slack's own mention syntax. Every form takes an optional `|label` tail, matched but never read:
 * Slack discards the label and substitutes the name it resolves from the id (probed by sending a
 * deliberately wrong one; the stored message came back carrying the real name). So the window
 * shows the literal characters, not a label the destination throws away.
 *
 * Order matters: `findMentionTokens` resolves overlaps first-match-wins, so `broadcast` precedes
 * `group` as an invariant, though the current patterns cannot both match the same text.
 *
 * Ids are `[A-Z0-9]+` after a leading letter: a user id is `U` (or `W`, which Enterprise Grid
 * issues), a channel id `C` or `G` (the private-group form, which still renders as a channel
 * reference). Not `\w`: a lowercase match would pill `<@ualreadyprose>`.
 */
const SLACK_TOKENS: readonly MentionTokenPattern[] = [
  { re: /<!(?:here|channel|everyone)(?:\|[^<>]*)?>/, kind: 'broadcast' },
  { re: /<!subteam\^[A-Z0-9]+(?:\|[^<>]*)?>/, kind: 'group' },
  { re: /<@[UW][A-Z0-9]+(?:\|[^<>]*)?>/, kind: 'user' },
  { re: /<#[CG][A-Z0-9]+(?:\|[^<>]*)?>/, kind: 'channel' },
];

export const slackProfile = {
  name: 'slack' as const,
  displayName: 'Slack',
  /** Forced: one content field, no `blocks` parameter. A near-no-op: Slack renders markdown. */
  mode: 'preview-only' as const,
  extraToolInput: {} as const,
  bodyField: 'message',
  /*
   * `post_at` is for `slack_schedule_message`, gated alongside `slack_send_message` with the same
   * `message` field and audience: when it arrives is part of what the reviewer approves. Per the
   * live schema (`{channel_id, message, post_at}` required, plus `thread_ts` and
   * `reply_broadcast`), a scheduled message "cannot be edited via API" afterwards.
   *
   * `reply_broadcast` follows `thread_ts` because it changes what `thread_ts` means: both tools'
   * schemas say it also posts the reply to the channel. Named here so an operator route that lists
   * its own fields still shows it, in this position.
   */
  contextFields: ['channel_id', 'thread_ts', 'reply_broadcast', 'draft_id', 'post_at'],

  /**
   * Structure and warnings are verified against live Slack; the styling is a likeness. The heading
   * rule (this file's header, 3.) is probed and `surface/harness/probe.ts` asserts it per level,
   * but one verified rule does not make the sheet probe-derived.
   */
  previewFidelity: 'indicative' as const,
  /**
   * Both. `app.slack.com/client` serves the application shell unauthenticated, and
   * `rollup-style-plastic.*.min.css` defines 417 `--dt_color-*` tokens under exactly two selectors:
   * `:root,.sk-client-theme--light` and `.sk-client-theme--dark`. A custom sidebar theme cannot
   * change them: `.sk-client-theme--light-inverted-sidebar` defines zero colour tokens across all
   * eight stylesheets. Cross-validated: three values this sheet holds by hand are byte-identical to
   * Slack's tokens (`content-pry` #1d1c1d, `content-hgl-1` #1264a3, `content-hgl-2` #007a5a). See
   * `tools/slack-tokens/`.
   */
  themes: ['light', 'dark'] as const,
  /**
   * Every block, and the three heading levels a reader can tell apart (this file's header, 3.):
   * `####` and below draw as `###`, so offering them would invite the loss
   * `slack/heading-level-collapsed` reports.
   *
   * The blocks, all read off a live render: real checkboxes with the checked label struck through,
   * code blocks with a language label and line numbers, tables with borders and a bold header row,
   * nested bullets, ordered lists that keep their numbers, horizontal rules, and blockquotes.
   */
  toolbar: {
    headingLevels: [1, 2, 3],
    marks: ['bold', 'italic', 'strike', 'code', 'link'],
    blocks: ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'rule'],
    /* Emoji is Unicode, carried as written. */
    inserts: ['emoji'],
  } as const,

  /**
   * `tokens`: Slack's own syntax, the only destination with any. `<@U…>`, `<!here>`,
   * `<!subteam^…>` and `<#C…>` are resolved by Slack, which rewrites the stored message to carry
   * the resolved name (probed). draftgate holds no Slack credentials, so the id is opaque to it and
   * the advice leaves checking it to the reviewer.
   *
   * `chips: null`: Slack resolves `<@U123>` from text; a `mention:` link would ship as literal
   * characters.
   */
  mentions: {
    tokens: {
      patterns: SLACK_TOKENS,
      advice:
        'draftgate cannot turn a Slack id into a name -- it holds no Slack credentials -- so the id is ' +
        'shown exactly as it will be sent. Check it is the person you mean; Slack resolves and ' +
        'notifies them.',
    },
    chips: null,
    // No link is a mention here: Slack's mention is the token above, and a link stays a link.
    links: null,
  },

  // Slack turns an inline image into a link in place, so the preview leaves it in place. Vacuous
  // either way (`rendersMedia: false`).
  mediaPlacement: 'inline' as const,
  // PROBED: Slack renders `![alt](url)` as a plain link labelled with the alt text, never as a
  // picture, and does not unfurl it. `slack/image-becomes-link` says so at review time.
  rendersMedia: false,
  // The markdown is sent verbatim, so draftgate does not rewrite the sentence on the way past.
  // Whether Slack draws the bold across the span is not claimed either way.
  codeSpanMarks: 'any',
  listItemBlocks: 'lists',
  /*
   * PROBED, read off the client: `<url|label>` renders as a link reading exactly its label -- with
   * spaces, with `*` and `_` shown as characters rather than formatting, and with a label that is
   * itself another address (the real one is visible only on hover).
   */
  angleLinkLabels: true,
  // A `C…`/`U…` id is globally unique and case-SENSITIVE, so there is nothing to require and
  // folding it would make a declaration match channels it was not written for.
  targetIdentity: { requiredFields: [], caseFolded: [] },
  // Every Slack tool here posts rather than edits (checked against the live `slack_send_message`
  // schema), so there is no prior content for a delta.
  deltaFields: [],

  // One audience, so nothing to ask: `audienceFor` is absent and `cli/src/classificationStores.ts`
  // has no row for Slack.
  reviewerAnswers: [],

  /**
   * 12,000 characters for the WHOLE message, Slack's own `markdown_text` limit, bracketed by the
   * probe (`slack_send_message`): 11,542 accepted, 12,037 and 13,046 refused with
   * `msg_too_long` -- AFTER the reviewer approved. One 5,027-character paragraph arrived whole, so
   * the tool description's "5000 chars per text element" is not a limit this needs to check.
   */
  bodyLimit: { accepted: 12_000, refused: 12_001, unit: 'characters' },
  lineLimits: {},
  // Not probed: Slack routes carry no line field today.
  lineBreaks: {},

  convert(markdown: string): { converted: string; warnings: Warning[] } {
    // Pass-through, like Linear: Slack renders markdown, so the markdown is what the preview
    // renders; literal mrkdwn (`*bold*`, `<url|text>`) would show the wire format instead. The one
    // exception is a block Slack would flatten into a list item, moved out (`movedOut`).
    const moved = movedOut(markdown);
    return {
      converted: moved.body,
      warnings: [
        ...checkSlack(inspect(markdown)),
        ...escapedQuoteWarnings(moved.body),
        ...moved.warnings,
        // Counted on what is SENT: `converted` is the body `wireBody` puts in the payload.
        ...lengthWarnings({
          code: 'slack/body-too-long',
          subject: 'This draft',
          value: moved.body,
          limit: slackProfile.bodyLimit,
          refuses: 'Slack refuses a message',
        }),
      ],
    };
  },
} satisfies DestinationProfile;
