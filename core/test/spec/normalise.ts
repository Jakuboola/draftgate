/**
 * Two readings of one markdown text in one comparable shape: `viaConverter` (draftgate's converter)
 * and `viaSpec` (micromark + GFM, CommonMark 0.31.2, which agreed with GitHub's `POST /markdown` on
 * 8 of 10 disputed drafts and all 16 bare-URL cases tried). Both flatten to blocks and inline runs
 * of (text, marks), so the comparison is about structure and emphasis, not bytes.
 *
 * The converter runs with a markdown destination's flags (`inlineMedia`, `itemBlocks`,
 * `combineCodeSpanMarks`), under which it rewrites least of what it read; Jira's un-nesting and
 * code-mark stripping are destination rules with their own warnings.
 *
 * `DELIBERATE` lists every intended difference, with its reason; anything else is a gap and belongs
 * in `baseline.ts`. Test-only: nothing under `core/src` imports this.
 */

import { convertMarkdownToAdf } from '../../src/adf/markdownToAdf';
import { JIRA_ATTACHMENT_SCHEME } from '../../src/adf/util';
import { INLINE_TYPES } from '../../src/adfSchema';
import type { AdfNode } from '../../src/adf/types';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Definition, Nodes, PhrasingContent, Root, RootContent } from 'mdast';

/** `m` is the set of marks on the run, sorted: a doubled `strong` reads as bold once. */
export type Run = { t: string; m: string[] } | { img: string };
export type Block =
  | { b: 'p'; i: Run[] }
  | { b: 'h'; l: number; i: Run[] }
  | { b: 'code'; lang: string; text: string }
  | { b: 'quote'; c: Block[] }
  | { b: 'hr' }
  | { b: 'list'; k: ListKind; s?: number; items: Item[] }
  | { b: 'table'; rows: Run[][][] }
  | { b: 'other'; what: string };
type ListKind = 'bullet' | 'ordered' | 'task';
type Item = { ck?: boolean; c: Block[] };

/** Which deliberate differences to apply. All of them, except when a test proves one is reached. */
type Rules = ReadonlySet<RuleId>;
export type RuleId = (typeof DELIBERATE)[number]['id'];

/**
 * The differences the converter makes on purpose, with the reason for each. `where` says which
 * side absorbs it: `spec` rewrites the spec reading, `converter` the converter's, `both` normalises
 * the two alike, and `exempt` keeps the input out of the comparison (only where no rewrite is
 * honest). `example` reaches the rule: with the rule off the two readings must part.
 */
export const DELIBERATE = [
  {
    id: 'newline',
    what: 'a newline is a hard break',
    where: 'both',
    why: 'the converter maps every newline inside a paragraph to `hardBreak` on purpose; a soft break and a hard break are both "\\n" here',
    example: 'one\ntwo\n',
  },
  {
    id: 'list-kind',
    what: 'a list whose item kind changes becomes two lists',
    where: 'spec',
    why: 'ADF has no mixed list, so a bullet run that turns into checkboxes is split where the kind changes',
    example: '- a\n- [ ] b\n',
  },
  {
    id: 'adjacent-lists',
    what: 'adjacent lists of one kind are one list',
    where: 'converter',
    why: 'the converter splits on a blank line where the spec makes one loose list; a reader sees one list either way. Merged on the converter side only (see `mergeLists`)',
    example: '- a\n\n- b\n',
  },
  {
    id: 'html',
    what: 'raw HTML stays text',
    where: 'spec',
    why: 'no destination renders it, so an HTML block or inline tag is its own source text -- read as TEXT, so a backslash escape inside it resolves as it would anywhere else in a paragraph',
    example: 'a <b>bold</b> c\n',
  },
  {
    id: 'escaped-lt-amp',
    what: '`\\<` and `\\&` keep their backslash',
    where: 'spec',
    why: 'the converter reads raw HTML and entities as text, so `\\<br>` and `<br>` would be one text node and the writer would send the tag, which GitHub renders; kept, the body goes out byte for byte',
    example: 'Use \\<br> and \\&amp; here\n',
  },
  {
    id: 'slack-link',
    what: "Slack's `<url|label>` stays text",
    where: 'spec',
    why: 'the spec reads it as an autolink to `url|label`; it is Slack mrkdwn, and Slack receives the characters',
    example: '<https://e.test/a|label>\n',
  },
  {
    id: 'image-non-http',
    what: 'an image with a non-http URL is the text `[Image: alt]`',
    where: 'spec',
    why: 'Jira cannot fetch a relative or `data:` URL, so the converter degrades it rather than emit media that 404s',
    example: '![shot](rel/p.png)\n',
  },
  {
    id: 'jira-attachment',
    what: 'the `jira-attachment:` scheme names the URL after it',
    where: 'spec',
    why: 'an already-uploaded Jira asset; the converter strips the scheme and emits media for the content URL',
    example: '![a](jira-attachment:https://x.atlassian.net/c/1)\n',
  },
  {
    id: 'expand',
    what: 'a line starting `+++` opens an expand',
    where: 'exempt',
    why: "Jira's expand syntax, which has no CommonMark spelling to rewrite the spec reading into",
    example: '+++ Title\nbody\n+++\n',
  },
] as const satisfies readonly { id: string; what: string; where: 'spec' | 'converter' | 'both' | 'exempt'; why: string; example: string }[];

const ALL: Rules = new Set(DELIBERATE.map((d) => d.id));

/**
 * A line break as a reader sees it. With the `newline` rule on, a soft and a hard break are both
 * "\n"; with it off, a hard break is this instead, so the two parsers must agree on which breaks are
 * hard. U+2028 because no input here writes one.
 */
const breakFor = (rules: Rules): string => (rules.has('newline') ? '\n' : '\u2028');

function pushRun(out: Run[], t: string, marks: readonly string[]): void {
  if (!t) return;
  const m = [...new Set(marks)].sort();
  const last = out[out.length - 1];
  if (last && 'm' in last && last.m.join('\n') === m.join('\n')) last.t += t;
  else out.push({ t, m });
}

const isCode = (r: Run): boolean => 'm' in r && r.m.includes('code');

/**
 * Whitespace around a line break and at the edges of a block is not a parse question, except inside
 * a code span: there it is the span's content, and whether one space of padding was stripped is
 * exactly what the reader must agree on (`` ` a ` `` alone in a paragraph is `a`, not ` a `).
 */
export function tidy(runs: Run[]): Run[] {
  const s: Run[] = runs.map((r) => ('img' in r || isCode(r) ? r : { t: r.t.replace(/[ \t]+([\n\u2028])/g, '$1').replace(/([\n\u2028])[ \t]+/g, '$1'), m: r.m }));
  const first = s[0];
  if (first && 't' in first && !isCode(first)) first.t = first.t.replace(/^\s+/, '');
  const last = s[s.length - 1];
  if (last && 't' in last && !isCode(last)) last.t = last.t.replace(/\s+$/, '');
  const out: Run[] = [];
  for (const r of s) {
    if ('img' in r) out.push(r);
    else pushRun(out, r.t, r.m);
  }
  return out;
}

const isEmptyParagraph = (b: Block): boolean => b.b === 'p' && b.i.length === 0;

// ---------------------------------------------------------------- the converter's reading

/** What a `taskItem` holds as its own line rather than as a block. `mediaSingle` because `inlineMedia` puts one there. */
const INLINE = new Set([...INLINE_TYPES, 'mediaSingle']);

const mediaUrl = (n: AdfNode): Run => ({ img: String(n.content?.[0]?.attrs?.url ?? n.attrs?.url) });

function adfInline(nodes: readonly AdfNode[] = [], rules: Rules, out: Run[] = []): Run[] {
  for (const n of nodes) {
    if (n.type === 'text') {
      const marks = (n.marks ?? []).map((m) => (m.type === 'link' ? `link:${String(m.attrs?.href)}` : m.type));
      pushRun(out, n.text ?? '', marks);
    } else if (n.type === 'hardBreak') pushRun(out, breakFor(rules), []);
    else if (n.type === 'mention' || n.type === 'emoji') pushRun(out, String(n.attrs?.text ?? n.attrs?.shortName ?? ''), []);
    else if (n.type === 'mediaSingle' || n.type === 'mediaInline') out.push(mediaUrl(n));
    else pushRun(out, `<${n.type}>`, []);
  }
  return out;
}

function adfBlocks(nodes: readonly AdfNode[] = [], rules: Rules): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push({ b: 'p', i: tidy(adfInline(n.content, rules)) });
        break;
      case 'heading':
        out.push({ b: 'h', l: Number(n.attrs?.level), i: tidy(adfInline(n.content, rules)) });
        break;
      case 'codeBlock':
        out.push({ b: 'code', lang: String(n.attrs?.language ?? ''), text: (n.content ?? []).map((c) => c.text).join('') });
        break;
      case 'blockquote':
        out.push({ b: 'quote', c: adfBlocks(n.content, rules) });
        break;
      case 'rule':
        out.push({ b: 'hr' });
        break;
      case 'bulletList':
      case 'orderedList': {
        const ordered = n.type === 'orderedList';
        out.push({
          b: 'list',
          k: ordered ? 'ordered' : 'bullet',
          ...(ordered ? { s: Number(n.attrs?.order ?? 1) } : {}),
          items: (n.content ?? []).map((li) => ({ c: adfBlocks(li.content, rules) })),
        });
        break;
      }
      case 'taskList': {
        // A `taskItem` holds inline content directly, then (with `itemBlocks: 'all'`) blocks; a
        // nested `taskList` is a sibling of the item it belongs to. Both are folded back into the
        // item, which is how markdown and the spec hold them.
        const items: Item[] = [];
        for (const ti of n.content ?? []) {
          if (ti.type === 'taskItem') {
            const content = ti.content ?? [];
            const inline = content.filter((c) => INLINE.has(c.type));
            const blocks = content.filter((c) => !INLINE.has(c.type));
            const lead: Block = { b: 'p', i: tidy(adfInline(inline, rules)) };
            items.push({ ck: ti.attrs?.state === 'DONE', c: [lead, ...adfBlocks(blocks, rules)].filter((b) => !isEmptyParagraph(b)) });
          } else if (items.length) items[items.length - 1].c.push(...adfBlocks([ti], rules));
          else out.push(...adfBlocks([ti], rules));
        }
        out.push({ b: 'list', k: 'task', items });
        break;
      }
      case 'table':
        out.push({
          b: 'table',
          rows: (n.content ?? []).map((r) => (r.content ?? []).map((cell) => tidy((cell.content ?? []).flatMap((p) => adfInline(p.content, rules))))),
        });
        break;
      case 'mediaSingle':
        out.push({ b: 'p', i: [mediaUrl(n)] });
        break;
      default:
        out.push({ b: 'other', what: n.type });
    }
  }
  return out.filter((b) => !isEmptyParagraph(b));
}

export function viaConverter(md: string, rules: Rules = ALL): Block[] {
  const adf = convertMarkdownToAdf(md, { inlineMedia: true, itemBlocks: 'all', combineCodeSpanMarks: true });
  return mergeLists(adfBlocks(adf.content, rules), rules);
}

// ---------------------------------------------------------------- the spec's reading

type Ctx = { src: string; defs: Map<string, Definition>; rules: Rules };

/** The characters a node was read from. */
const sourceOf = (n: Nodes, ctx: Ctx): string => ctx.src.slice(n.position?.start.offset ?? 0, n.position?.end.offset ?? 0);

function image(url: string, alt: string, marks: readonly string[], ctx: Ctx, out: Run[]): void {
  if (ctx.rules.has('jira-attachment') && url.startsWith(JIRA_ATTACHMENT_SCHEME)) out.push({ img: url.slice(JIRA_ATTACHMENT_SCHEME.length) });
  else if (!ctx.rules.has('image-non-http') || /^https?:\/\//i.test(url)) out.push({ img: url });
  else pushRun(out, alt ? `[Image: ${alt}]` : '[Image]', marks);
}

/**
 * `text` as the converter reads the characters of a text node: every backslash escape resolved,
 * except `\<` and `\&` while `escaped-lt-amp` is on. CommonMark's escapable set is spelled here,
 * not imported from `core/src`, so the checker cannot agree with the converter by sharing it.
 */
const readEscapes = (text: string, rules: Rules): string =>
  text.replace(/\\([!-/:-@[-`{-~])/g, (m, c: string) => (rules.has('escaped-lt-amp') && (c === '<' || c === '&') ? m : c));

/**
 * A spec text node, with the backslash put back before each `<` and `&` its source escaped. Only
 * where the source, escapes read, equals the value once those backslashes go; a node with an entity
 * or anything else the spec decodes is left alone.
 */
function escapedLtAmp(n: Nodes & { value: string }, ctx: Ctx): string {
  if (!ctx.rules.has('escaped-lt-amp')) return n.value;
  const src = sourceOf(n, ctx);
  if (!/\\[<&]/.test(src)) return n.value;
  const read = readEscapes(src, ctx.rules);
  return read.replace(/\\([<&])/g, '$1') === n.value ? read : n.value;
}

/** A link replaces any link it sits inside: ADF holds one per run. */
const withLink = (marks: readonly string[], url: string): string[] => [...marks.filter((m) => !m.startsWith('link:')), `link:${url}`];

function mdInline(nodes: readonly PhrasingContent[], marks: readonly string[], ctx: Ctx, out: Run[] = []): Run[] {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        pushRun(out, escapedLtAmp(n, ctx), marks);
        break;
      case 'html':
        pushRun(out, ctx.rules.has('html') ? readEscapes(n.value, ctx.rules) : `<html ${n.value}>`, marks);
        break;
      case 'break':
        pushRun(out, breakFor(ctx.rules), []);
        break;
      case 'inlineCode':
        pushRun(out, n.value, [...marks, 'code']);
        break;
      case 'emphasis':
      case 'strong':
        mdInline(n.children, [...marks, n.type === 'strong' ? 'strong' : 'em'], ctx, out);
        break;
      case 'delete':
        mdInline(n.children, [...marks, 'strike'], ctx, out);
        break;
      case 'link': {
        const src = sourceOf(n, ctx);
        if (ctx.rules.has('slack-link') && /^<[^>]*\|/.test(src)) pushRun(out, src, marks); // Slack's `<url|label>` (DELIBERATE)
        else mdInline(n.children, withLink(marks, n.url), ctx, out);
        break;
      }
      case 'linkReference': {
        const d = ctx.defs.get(n.identifier);
        if (d) mdInline(n.children, withLink(marks, d.url), ctx, out);
        else pushRun(out, sourceOf(n, ctx), marks);
        break;
      }
      case 'image':
        image(n.url, n.alt ?? '', marks, ctx, out);
        break;
      case 'imageReference': {
        const d = ctx.defs.get(n.identifier);
        if (d) image(d.url, n.alt ?? '', marks, ctx, out);
        else pushRun(out, sourceOf(n, ctx), marks);
        break;
      }
      default:
        pushRun(out, `<${n.type}>`, marks);
    }
  }
  return out;
}

function mdBlocks(nodes: readonly RootContent[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push({ b: 'p', i: tidy(mdInline(n.children, [], ctx)) });
        break;
      case 'heading':
        out.push({ b: 'h', l: n.depth, i: tidy(mdInline(n.children, [], ctx)) });
        break;
      case 'code':
        out.push({ b: 'code', lang: n.lang ?? '', text: n.value });
        break;
      case 'blockquote':
        out.push({ b: 'quote', c: mdBlocks(n.children, ctx) });
        break;
      case 'thematicBreak':
        out.push({ b: 'hr' });
        break;
      case 'html':
        out.push(ctx.rules.has('html') ? { b: 'p', i: tidy([{ t: readEscapes(n.value, ctx.rules), m: [] }]) } : { b: 'other', what: 'html' });
        break;
      case 'definition':
        break;
      case 'list': {
        // A kind change starts a new list (DELIBERATE): ADF has no mixed list. An ordered chunk
        // after a split continues the numbering, as the converter's `order` does.
        let cur: Extract<Block, { b: 'list' }> | undefined;
        n.children.forEach((li, index) => {
          const kind: ListKind = li.checked != null ? 'task' : n.ordered ? 'ordered' : 'bullet';
          if (!cur || (cur.k !== kind && ctx.rules.has('list-kind'))) {
            cur = { b: 'list', k: kind, ...(kind === 'ordered' ? { s: (n.start ?? 1) + index } : {}), items: [] };
            out.push(cur);
          }
          const c = mdBlocks(li.children, ctx);
          cur.items.push(li.checked != null ? { ck: li.checked === true, c } : { c });
        });
        break;
      }
      case 'table': {
        // As GFM renders it: every row the header's width, excess dropped, short rows padded
        // (GFM example 204). mdast keeps the cells as written, and comparing those would report a
        // ragged row as agreeing while GitHub draws a different table.
        const width = n.children[0]?.children.length ?? 0;
        const rows = n.children.map((r) =>
          Array.from({ length: width }, (_, i) => {
            const cell = r.children[i];
            return cell ? tidy(mdInline(cell.children, [], ctx)) : [];
          })
        );
        out.push({ b: 'table', rows });
        break;
      }
      default:
        out.push({ b: 'other', what: n.type });
    }
  }
  return out.filter((b) => !isEmptyParagraph(b));
}

function collectDefs(node: Nodes, defs: Map<string, Definition>): Map<string, Definition> {
  // The first definition of a label wins, per the spec.
  if (node.type === 'definition' && !defs.has(node.identifier)) defs.set(node.identifier, node);
  if ('children' in node) for (const c of node.children) collectDefs(c, defs);
  return defs;
}

export function viaSpec(md: string, rules: Rules = ALL): Block[] {
  const tree: Root = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return mdBlocks(tree.children, { src: md, defs: collectDefs(tree, new Map()), rules });
}

// ---------------------------------------------------------------- shared

/**
 * Adjacent lists of one kind are one list to a reader (DELIBERATE): the converter splits on a blank
 * line where the spec makes one loose list. Merged on the converter side only, recursively, since
 * merging the spec's side would hide a converter that reads two lists as one. An ordered list
 * merges only where its numbering continues. Accepted cost: a changed marker after a blank line
 * (`- a`, blank, `+ b`) is two lists to both parsers and reads as a difference here.
 */
function mergeLists(blocks: readonly Block[], rules: Rules): Block[] {
  if (!rules.has('adjacent-lists')) return [...blocks];
  const out: Block[] = [];
  for (const b of blocks) {
    const nb: Block =
      b.b === 'quote' ? { ...b, c: mergeLists(b.c, rules) }
      : b.b === 'list' ? { ...b, items: b.items.map((it) => ({ ...it, c: mergeLists(it.c, rules) })) }
      : b;
    const prev = out[out.length - 1];
    if (prev?.b === 'list' && nb.b === 'list' && prev.k === nb.k && (nb.k !== 'ordered' || nb.s === (prev.s ?? 1) + prev.items.length)) {
      prev.items.push(...nb.items);
    } else out.push(nb);
  }
  return out;
}

const EXPAND = DELIBERATE.find((d) => d.id === 'expand')!;

/** Whether any block, at any depth, satisfies `p`. */
function holds(blocks: readonly Block[], p: (b: Block) => boolean): boolean {
  return blocks.some((b) => p(b) || (b.b === 'quote' && holds(b.c, p)) || (b.b === 'list' && b.items.some((it) => holds(it.c, p))));
}

/** The outcome of comparing one input: `agree`, `differ` (with both readings), or `exempt`. */
export type Verdict =
  | { kind: 'agree' }
  | { kind: 'exempt'; why: string }
  | { kind: 'differ'; converter: string; spec: string };

/**
 * Compare the two readings of `md`. `without` switches one deliberate difference off, which only
 * the test that proves each rule is reached should ever do.
 */
export function compare(md: string, without?: RuleId): Verdict {
  const rules: Rules = without ? new Set([...ALL].filter((r) => r !== without)) : ALL;
  let blocks: Block[] | undefined;
  let converter: string;
  try {
    blocks = viaConverter(md, rules);
    converter = JSON.stringify(blocks);
  } catch (e) {
    converter = `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Exempt only where the converter opened an expand: a `+++` line inside a code fence is code.
  if (rules.has('expand') && blocks && holds(blocks, (b) => b.b === 'other' && b.what === 'expand')) {
    return { kind: 'exempt', why: EXPAND.what };
  }
  const spec = JSON.stringify(viaSpec(md, rules));
  return converter === spec ? { kind: 'agree' } : { kind: 'differ', converter, spec };
}
