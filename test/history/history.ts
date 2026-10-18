/**
 * The history check's rules: what counts as development history in a file, which area a file
 * belongs to, and each area's baseline. One module for `history.test.ts`, `writeBaseline.ts` and
 * `report.ts`, so the test and the commands can never disagree about what a hit is.
 *
 * ## What a hit is
 *
 * A file's text is cut into segments of three kinds:
 * - prose: a comment, a test's name, a markdown file, a shell comment, an HTML or SVG comment;
 * - a string: any other string literal, JSX text, HTML outside its comments, shell outside its;
 * - data: a JSON value.
 * Everything else (code, CSS declarations, regex literals) is not read.
 *
 * Prose is where history is written, and fixture data lives in strings: a `#12` in a test body is
 * a GitHub autolink under test, `'2026-09-02T10:00Z'` a record's timestamp. The patterns nothing
 * but history matches (`issue #N`, a finding ID, `§`, a pointer into the archive's docs) count
 * everywhere; `segmentHits` has the rest, one reason each.
 *
 * A commit hash is checked in prose only, and narrowly: hex in a colour, a UUID, a path or a code
 * span is a value, not a citation. "Used to"-style prose is not checked at all: no pattern tells a
 * story from a present-tense fact.
 *
 * This file and `history.test.ts` hold the patterns and their examples, so they are exempt.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..', '..');
export const BASELINE_DIR = join(import.meta.dir, 'baseline');

/** Exempt from their own patterns: they hold the patterns, the examples and the exceptions. */
const EXEMPT: ReadonlySet<string> = new Set(['test/history/history.ts', 'test/history.test.ts']);

/** Generated, or not text: never scanned. Anything else is read as text, NUL bytes or not. */
const SKIP = /(^|\/)(bun\.lock|package-lock\.json)$|\.(icns|ico|png|jpe?g|gif|webp|pdf|zip|woff2?|ttf|otf)$/;

// ---------------------------------------------------------------------------------------------
// Areas

export const AREA_NAMES = [
  'core-src',
  'core-test',
  'cli-src',
  'cli-test',
  'hook',
  'surface',
  'harness',
  'tools',
  'instructions',
] as const;
export type Area = (typeof AREA_NAMES)[number];

/**
 * Path -> area, first match wins. One baseline file per area, so cleanup PRs in different areas
 * never edit the same file. A tracked file no row matches fails the test.
 */
const AREAS: readonly (readonly [RegExp, Area])[] = [
  [/^(README\.md|LICENSE|docs\/NOTICE)$/, 'instructions'],
  [/^\.claude\//, 'instructions'],
  [/^tools\/[^/]+\/README\.md$/, 'instructions'],
  [/^core\/test\//, 'core-test'],
  [/^core\//, 'core-src'],
  [/^cli\/src\//, 'cli-src'],
  [/^cli\/test\//, 'cli-test'],
  [/^(adapters\/hook|plugin)\//, 'hook'],
  [/^surface\/harness\//, 'harness'],
  [/^surface\//, 'surface'],
  [/^(tools|test|docs)\//, 'tools'],
  [/^(install\.sh|package\.json|tsconfig\.json|\.gitignore)$/, 'tools'],
  [/^\.claude-plugin\//, 'tools'],
];

export function areaOf(path: string): Area | undefined {
  return AREAS.find(([re]) => re.test(path))?.[1];
}

/**
 * Every tracked file, repo-relative and sorted: a new file is checked once it is added, and a
 * scratch file nobody will commit never decides whether the suite passes.
 */
function treeFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return [...new Set(out.split('\0'))]
    .filter((p) => p !== '' && !SKIP.test(p) && existsSync(join(ROOT, p)))
    .sort();
}

// ---------------------------------------------------------------------------------------------
// Segments

/** Prose is written by hand; a string may be fixture data; a JSON value is data. */
type Kind = 'prose' | 'string' | 'data';

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly kind: Kind;
}

/** Calls whose first argument is a test's name. */
const TEST_CALLS = new Set(['test', 'it', 'describe']);

/**
 * Whether calling `e` names a test: `test`, `test.skip`, and what `test.each(rows)` returns. Not
 * `test.each` itself, whose argument is the table.
 */
function isTestCallee(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return TEST_CALLS.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return e.name.text !== 'each' && isTestCallee(e.expression);
  if (ts.isCallExpression(e)) {
    return ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'each' && isTestCallee(e.expression.expression);
  }
  return false;
}

function scriptSegments(path: string, text: string): Segment[] {
  const kind = path.endsWith('.json')
    ? ts.ScriptKind.JSON
    : /\.(tsx|jsx)$/.test(path)
      ? ts.ScriptKind.TSX
      : /\.(cjs|mjs|js)$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const json = kind === ts.ScriptKind.JSON;
  const sf =
    json
      ? ts.parseJsonText(path, text)
      : ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const out: Segment[] = [];
  const comments = new Set<number>();
  const testNames = new Set<ts.Node>();
  const addComments = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (comments.has(r.pos)) continue;
      comments.add(r.pos);
      out.push({ start: r.pos, end: r.end, kind: 'prose' });
    }
  };
  // Every comment is trivia around some token, so visiting every token sees all of them.
  const visit = (node: ts.Node, inTestName: boolean) => {
    // A doc comment's own nodes: the comment is read whole, as the next token's leading trivia.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isCallExpression(node) && node.arguments.length > 0 && isTestCallee(node.expression)) {
      testNames.add(node.arguments[0]!);
    }
    const named = inTestName || testNames.has(node);
    const children = node.getChildren(sf);
    if (children.length > 0) {
      for (const child of children) visit(child, named);
      return;
    }
    addComments(ts.getLeadingCommentRanges(text, node.pos));
    addComments(ts.getTrailingCommentRanges(text, node.end));
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateLiteralToken(node) ||
      ts.isJsxText(node)
    ) {
      // Without the delimiters (quotes, backticks, `}` and `${`), as every segmenter gives a string.
      const start = node.getStart(sf) + (ts.isJsxText(node) ? 0 : 1);
      const end = ts.isJsxText(node) ? node.end : node.end - (text.endsWith('${', node.end) ? 2 : 1);
      out.push({ start, end, kind: named ? 'prose' : json ? 'data' : 'string' });
    }
  };
  visit(sf, false);
  return out;
}

/** `/* *\/` comments are prose; `//` comments too where the language has them; strings are strings. */
function cLikeSegments(text: string, lineComments: boolean, strings: boolean): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out.push({ start: i, end: stop, kind: 'prose' });
      i = stop;
    } else if (lineComments && c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out.push({ start: i, end: stop, kind: 'prose' });
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (strings) out.push({ start: i + 1, end: j, kind: 'string' });
      i = j + 1;
    } else i++;
  }
  return out;
}

/** `<!-- -->` comments are prose and everything between them is a string. */
function markupSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
    out.push({ start: at, end: m.index, kind: 'string' }, { start: m.index, end: m.index + m[0].length, kind: 'prose' });
    at = m.index + m[0].length;
  }
  out.push({ start: at, end: text.length, kind: 'string' });
  return out;
}

/** Where a `#` comment starts on a shell line: at the start or after a space, outside quotes. */
function hashCommentAt(line: string): number {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== '') {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && line[i + 1] !== '!' && (i === 0 || /\s/.test(line[i - 1]!))) return i;
  }
  return line.length;
}

/** A `#` comment is prose and the rest of the line a string (`echo` text). */
function hashCommentSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const cut = hashCommentAt(line);
    out.push({ start: at, end: at + cut, kind: 'string' }, { start: at + cut, end: at + line.length, kind: 'prose' });
    at += line.length + 1;
  }
  return out;
}

function segments(path: string, text: string): Segment[] {
  if (/\.(ts|tsx|mts|cts|js|jsx|cjs|mjs|json)$/.test(path)) return scriptSegments(path, text);
  if (/\.css$/.test(path)) return cLikeSegments(text, false, false);
  if (/\.(m|h|c)$/.test(path)) return cLikeSegments(text, true, true);
  if (/\.(html|svg)$/.test(path)) return markupSegments(text);
  if (/\.sh$|(^|\/)\.gitignore$/.test(path)) return hashCommentSegments(text);
  return [{ start: 0, end: text.length, kind: 'prose' }]; // markdown, and anything new: all prose
}

// ---------------------------------------------------------------------------------------------
// Patterns

export type Code = 'issue' | 'finding' | 'commit' | 'section' | 'date' | 'pointer';

/** What each code means, as `history:report` prints it. */
export const PATTERNS: Readonly<Record<Code, string>> = {
  issue: 'an issue or PR reference: `#N` in prose; `issue #N`, `PR #N`, `archive#N` or an issue URL anywhere',
  finding: "a review finding's ID (`low-85`, `g041`)",
  commit: 'a commit hash in prose (`84c4abd`; `commit 199ed7b` in a code span too)',
  section: 'a `§` section reference',
  date: 'a date of what happened (`YYYY-MM-DD` in prose or a string, not a timestamp)',
  pointer: 'a pointer to `docs/decisions.md` or `docs/layout.md`',
};

/** Words that make a `#N` an issue or PR reference wherever it is, data included. */
const ISSUE_WORDS = 'issues?|PRs?|pull requests?|archive';
const ISSUE_WORD = new RegExp(`\\b(?:${ISSUE_WORDS})\\s*$`, 'i');
/** `draftgate#30` too, in prose. In a string it is a GitHub cross-repo reference under test. */
const PROSE_ISSUE_WORD = new RegExp(`\\b(?:${ISSUE_WORDS}|draftgate)\\s*$`, 'i');
/**
 * A `#N` right after one of these is not an issue: an entity, a path or URL, `##`, an escape, a
 * quote. And not right after `](`, where it is a markdown link to an anchor.
 */
const NOT_AFTER = /[\w&/#\\'"`]$|\]\($/;
/** A CommonMark spec example's number: a fact about the spec, not about draftgate. */
const SPEC_EXAMPLE = /\b(?:spec|example|examples)\s*$/i;
const ISSUE_URL = /github\.com\/Jakuboola\/draftgate(?:-[\w.-]+)?\/(?:issues|pull)\/\d+/gi;
const FINDING = /\b(?:low-\d+|g\d{3})\b/g;
const SECTION = /§/g;
/**
 * 7 to 40 hex digits with a letter and a digit among them, standing alone: not a colour (`#...`), a
 * UUID's part, a path, a version or a font build (`git-9221beed3`).
 */
const COMMIT = /(?<![\w#\-./:])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w\-.:/])/g;
/** Not followed by a time or a `.N` suffix: `2026-09-02T10:00`, `2026-09-02 10:00`, `2026-09-12.1` are data. */
const DATE = /\b(?:19|20)\d\d-[01]\d-[0-3]\d\b(?![T ]\d|\.\d)/g;
const POINTER = /\b(?:decisions|layout)\.md\b|\bdocs\/(?:decisions|layout)\b(?!\.md)/g;

export interface Hit {
  readonly path: string;
  readonly line: number;
  readonly code: Code;
  /** What matched, e.g. `#152` or `2026-09-30`. */
  readonly match: string;
  /** The whole line, trimmed. */
  readonly text: string;
}

/** Blank out code spans, so a `` `#123` `` quoting GitHub's syntax is not an issue reference. */
function maskCodeSpans(s: string): string {
  return s.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * Hits in one segment, as [offset in the segment, code, match].
 *
 * A bare `#N` counts in prose only: in a string it is a GitHub autolink under test or a colour. A
 * date counts in prose and in a string that holds more than the date (a message, a remedy), never
 * in JSON or in a string that IS the date, which is a value under test.
 */
function segmentHits(s: string, kind: Kind): [number, Code, string][] {
  const out: [number, Code, string][] = [];
  if (!/[\d§]|decisions|layout/.test(s)) return out; // every pattern needs one of these
  const masked = kind === 'prose' ? maskCodeSpans(s) : s;
  for (const m of s.matchAll(/#\d+(?![\w-])/g)) {
    if (masked[m.index] !== '#') continue;
    const before = s.slice(Math.max(0, m.index - 40), m.index);
    const strong = (kind === 'prose' ? PROSE_ISSUE_WORD : ISSUE_WORD).test(before);
    const bare =
      kind === 'prose' &&
      m[0].length <= 5 && // `#333337` is a colour: no issue number here runs to five digits
      !NOT_AFTER.test(before.slice(-2)) &&
      !SPEC_EXAMPLE.test(before);
    if (strong || bare) out.push([m.index, 'issue', m[0]]);
  }
  for (const m of s.matchAll(ISSUE_URL)) out.push([m.index, 'issue', m[0]]);
  for (const m of s.matchAll(FINDING)) out.push([m.index, 'finding', m[0]]);
  if (kind === 'prose') {
    for (const m of s.matchAll(COMMIT)) {
      // In a code span it is a value (a comment's ID, a nonce), unless named a commit.
      const quoted = masked[m.index] !== s[m.index];
      if (!quoted || /\bcommit\s*`$/i.test(s.slice(Math.max(0, m.index - 12), m.index))) out.push([m.index, 'commit', m[0]]);
    }
  }
  for (const m of s.matchAll(SECTION)) out.push([m.index, 'section', m[0]]);
  for (const m of s.matchAll(POINTER)) out.push([m.index, 'pointer', m[0]]);
  const isDate = kind === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);
  if (kind !== 'data' && !isDate) for (const m of s.matchAll(DATE)) out.push([m.index, 'date', m[0]]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Exceptions

interface Exception {
  readonly path: string;
  /** The hit's match, on a line containing `line`, is not history. Any other hit there still is. */
  readonly match: string;
  readonly line: string;
  readonly why: string;
}

/**
 * The permanent exceptions: hits that are not history, each with its reason. An entry that matches
 * no hit fails the test, so a stale one cannot linger and quietly cover a new hit on its line.
 */
export const EXCEPTIONS: readonly Exception[] = [
  {
    path: 'adapters/hook/test/doctor.test.ts',
    match: '§',
    line: "expect(text).not.toContain('§')",
    why: "asserts the doctor's output holds no `§`: the character is what is tested, not a reference",
  },
  {
    path: 'core/test/spec/inputs.ts',
    match: '499789b',
    line: '499789b, section "Tables (extension)"',
    why: "the upstream spec file's commit, which pins where the examples come from",
  },
  {
    path: 'cli/test/cli.test.ts',
    match: '§',
    line: "for (const text of [HELP, ...Object.values(COMMAND_HELP)]) expect(text).not.toContain('§')",
    why: 'asserts the same of `--help`',
  },
];

/**
 * `hits` minus the excepted ones, and which exceptions were used. An exception covers as many hits
 * on a line as its `match` occurs in its `line` text, so a second one written beside it still counts.
 */
export function applyExceptions(
  hits: readonly Hit[],
  exceptions: readonly Exception[]
): { kept: Hit[]; used: Set<Exception> } {
  const used = new Set<Exception>();
  const spent = new Map<string, number>();
  const kept = hits.filter((h) => {
    const i = exceptions.findIndex(
      (e, j) =>
        e.path === h.path &&
        e.match === h.match &&
        h.text.includes(e.line) &&
        (spent.get(`${j}:${h.line}`) ?? 0) < e.line.split(e.match).length - 1
    );
    if (i === -1) return true;
    const key = `${i}:${h.line}`;
    spent.set(key, (spent.get(key) ?? 0) + 1);
    used.add(exceptions[i]!);
    return false;
  });
  return { kept, used };
}

// ---------------------------------------------------------------------------------------------
// Scanning

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Every hit in `text`, read as the file at `path`, before exceptions. */
export function scanText(path: string, text: string): Hit[] {
  const starts = lineStarts(text);
  const out: Hit[] = [];
  for (const seg of segments(path, text)) {
    for (const [at, code, match] of segmentHits(text.slice(seg.start, seg.end), seg.kind)) {
      const line = lineOf(starts, seg.start + at);
      const lineText = text.slice(starts[line - 1], (starts[line] ?? text.length + 1) - 1);
      out.push({ path, line, code, match, text: lineText.trim() });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

interface Scan {
  /** Path -> its hits after exceptions, for every scanned file with at least one. */
  readonly hits: ReadonlyMap<string, readonly Hit[]>;
  /** Every scanned file. */
  readonly files: readonly string[];
  /** Exceptions that matched no hit. */
  readonly unusedExceptions: readonly Exception[];
}

export function scanTree(): Scan {
  const used = new Set<Exception>();
  const hits = new Map<string, Hit[]>();
  const scanned: string[] = [];
  for (const path of treeFiles()) {
    if (EXEMPT.has(path)) continue;
    scanned.push(path);
    const result = applyExceptions(scanText(path, readFileSync(join(ROOT, path), 'utf8')), EXCEPTIONS);
    for (const e of result.used) used.add(e);
    if (result.kept.length > 0) hits.set(path, result.kept);
  }
  return { hits, files: scanned, unusedExceptions: EXCEPTIONS.filter((e) => !used.has(e)) };
}

// ---------------------------------------------------------------------------------------------
// Baselines: `baseline/<area>.json`, file -> hit count. Like the spec checker's ratchet, a count
// may only go down, and it must be lowered when it does.

export type Baseline = Readonly<Record<string, number>>;

function baselinePath(area: Area): string {
  return join(BASELINE_DIR, `${area}.json`);
}

/** The `.json` files in `dir`; none when git holds no directory, as when no area allows anything. */
export function baselineFiles(dir: string = BASELINE_DIR): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
}

/** An area with no baseline file has an empty one. */
export function readBaseline(area: Area): Baseline {
  const p = baselinePath(area);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Baseline) : {};
}

/** Each file in `area` with hits, and how many. */
export function counts(scan: Scan, area: Area): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [path, hs] of scan.hits) if (areaOf(path) === area) out[path] = hs.length;
  return out;
}

/** Writes `area`'s baseline, or deletes its file when there is nothing left to allow. */
export function writeBaseline(area: Area, now: Baseline): void {
  const p = baselinePath(area);
  const keys = Object.keys(now).sort();
  if (keys.length === 0) {
    rmSync(p, { force: true });
    return;
  }
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(p, `${JSON.stringify(Object.fromEntries(keys.map((k) => [k, now[k]])), null, 2)}\n`);
}

/** Every file whose count differs between two baselines. */
export function moves(before: Baseline, after: Baseline): { path: string; was: number; is: number }[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .map((path) => ({ path, was: before[path] ?? 0, is: after[path] ?? 0 }))
    .filter((m) => m.was !== m.is);
}

/**
 * Every way `now` differs from `baseline`, one line each: a file with MORE hits than it is allowed
 * (history added), or with fewer (history removed, and the baseline not lowered to match).
 */
export function compare(area: Area, baseline: Baseline, now: Baseline): string[] {
  return moves(baseline, now).map(({ path, was, is }) =>
    is > was
      ? `${path}: ${is} history hits, ${was} allowed -- rewrite them (\`bun run history:report ${path}\`)`
      : `${path}: ${is} history hits, ${was} still allowed -- lower it: \`bun run history:baseline ${area}\``
  );
}
