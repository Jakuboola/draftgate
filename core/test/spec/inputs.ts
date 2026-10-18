/**
 * What the spec checker reads, and only this: the CommonMark spec's examples, the repo's fixtures
 * and a seeded fuzz set. Never the audit log, which holds customer text the baseline would publish.
 */

import spec from 'commonmark-spec';
import { EXAMPLES_DIR, example, shippedBodies } from '../golden';

export interface SpecExample {
  readonly number: number;
  readonly section: string;
  readonly markdown: string;
}

/**
 * CommonMark 0.31.2's 652 examples. `spec.txt` writes a TAB as `→` so it is visible, and the
 * package hands the examples over unconverted; the spec's own runner substitutes it back.
 */
export function specExamples(): SpecExample[] {
  return spec.tests.map((t) => ({ number: t.number, section: t.section, markdown: t.markdown.replace(/→/g, '\t') }));
}

/**
 * GFM 0.29's table examples, verbatim, numbered as in its `spec.txt` (github/cmark-gfm at
 * 499789b, section "Tables (extension)"); `commonmark-spec` carries none. `gfm #200`, the escaped
 * pipe, is the one a plain `split('|')` reads wrongly. GFM's numbers overlap CommonMark's, so the
 * key is `gfm #200`.
 */
export const GFM_TABLE_EXAMPLES: readonly { readonly number: number; readonly markdown: string }[] = [
  { number: 198, markdown: '| foo | bar |\n| --- | --- |\n| baz | bim |\n' },
  { number: 199, markdown: '| abc | defghi |\n:-: | -----------:\nbar | baz\n' },
  { number: 200, markdown: '| f\\|oo  |\n| ------ |\n| b `\\|` az |\n| b **\\|** im |\n' },
  { number: 201, markdown: '| abc | def |\n| --- | --- |\n| bar | baz |\n> bar\n' },
  { number: 202, markdown: '| abc | def |\n| --- | --- |\n| bar | baz |\nbar\n\nbar\n' },
  { number: 203, markdown: '| abc | def |\n| --- |\n| bar |\n' },
  { number: 204, markdown: '| abc | def |\n| --- | --- |\n| bar |\n| bar | baz | boo |\n' },
  { number: 205, markdown: '| abc | def |\n| --- | --- |\n' },
];

/** `shippedBodies` plus the GitHub example, which that list does not carry. */
export function fixtures(): { name: string; markdown: string }[] {
  return [...shippedBodies(), [`${EXAMPLES_DIR}/github-payload.json`, example('github-payload.json', 'body')] as const].map(([name, markdown]) => ({ name, markdown }));
}

/** What a fuzz family's bodies are made of. See `FUZZ`. */
export interface Vocabulary {
  readonly words: readonly string[];
  readonly wrap: readonly ((w: string) => string)[];
  readonly stray: readonly string[];
  readonly openers: readonly string[];
}

/**
 * The fuzz set's vocabulary: mostly ordinary words, plus a construct around a word, a stray
 * delimiter or a block opener. Tuned so some bodies differ and most do not. `_` lives in
 * `UNDERSCORE_FUZZ` (adding it here would redraw all 400 bodies); `+++` is exempt.
 */
export const FUZZ: Vocabulary = {
  words: ['word', 'the', 'fix', 'see', 'x', 'API', '2h', 'done.', 'it,', 'v1.2'],
  wrap: [
    (w) => `**${w}**`, (w) => `*${w}*`, (w) => `~~${w}~~`, (w) => `\`${w}\``, (w) => `***${w}***`,
    (w) => `[${w}](https://e.test/${w.length})`, (w) => `![${w}](https://e.test/i.png)`, (w) => `<https://e.test/${w.length}>`,
  ],
  stray: ['*', '**', '~~', '`', '\\*', '[', ']', '(', ')', '&amp;', '<b>', '|', '!', 'https://e.test/y.', 'www.e.test', '  \n', '\\\n'],
  openers: ['# ', '### ', '> ', '- ', '* ', '1. ', '2) ', '- [ ] ', '- [x] ', '  - ', '   1. ', '    ', '---\n', '```\n', '| a | b |\n| - | - |\n| '],
};

/**
 * The underscore family: `_` beside what it meets in a real draft (`snake_case`, `__init__.py`, a
 * URL or link holding one, a code span, a star, punctuation). Inline only, bar a heading: a list or
 * quote adds a lazy-continuation difference that says nothing about `_`.
 */
export const UNDERSCORE_FUZZ: Vocabulary = {
  words: ['word', 'the', 'fix', 'see', 'x', 'done.', 'it,', 'snake_case', 'my_var_', '__init__.py'],
  wrap: [
    (w) => `_${w}_`, (w) => `__${w}__`, (w) => `___${w}___`, (w) => `*${w}*`, (w) => `**${w}**`, (w) => `\`${w}\``,
    (w) => `(_${w}_)`, (w) => `"_${w}_"`, (w) => `[${w}](https://e.test/${w.length}_x_)`, (w) => `https://e.test/${w}_/y`,
  ],
  stray: ['_', '\\_', '*', '[', ']', '(', ')', '`', 'https://e.test/a_.b ', '<https://e.test/q=__> ', '  \n'],
  openers: ['# ', '### '],
};

/**
 * `count` bodies from a fixed-seed generator, so the baseline is the same on every machine. The
 * seeds are arbitrary; changing one redraws its family's baseline.
 */
export function fuzzBodies(count: number, seed = 90, { words: WORDS, wrap: WRAP, stray: STRAY, openers: OPENERS }: Vocabulary = FUZZ): string[] {
  let s = seed;
  // `Math.imul`, not `*`: the plain product passes 2^53, its low bits round to zero, and after a few
  // draws the state repeats -- measured: 53 of 400 bodies are duplicates.
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const lines: string[] = [];
    const lineCount = 1 + Math.floor(next() * 4);
    for (let l = 0; l < lineCount; l++) {
      const words: string[] = [];
      const wordCount = 2 + Math.floor(next() * 6);
      for (let w = 0; w < wordCount; w++) {
        const r = next();
        words.push(r < 0.7 ? pick(WORDS) : r < 0.9 ? pick(WRAP)(pick(WORDS)) : pick(STRAY) + pick(WORDS));
      }
      lines.push((next() < 0.35 ? pick(OPENERS) : '') + words.join(' '));
      if (next() < 0.3) lines.push('');
    }
    out.push(lines.join('\n') + '\n');
  }
  return out;
}
