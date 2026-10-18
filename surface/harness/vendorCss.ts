/**
 * A VENDOR's stylesheet, as the extractors read it: every rule once, and the two questions both
 * `tools/slack-tokens/` and `tools/linear-tokens/` ask of it -- how the vendor rasterises its text,
 * and which font file it serves.
 *
 * One module so the two extractors cannot drift apart. The parser is uncapped: a length cap
 * silently skips long rules, a hole in a scan whose job is to find EVERY rule setting smoothing. And
 * two copies would record the overrides in two shapes that two tests then judge by two rules.
 * Beside `fontFile.ts` for the same reason that file is here: the harness reads the other side of
 * each comparison, and one reading is what makes it one comparison.
 */

import { fontFacts, type FontFacts } from './fontFile';

export interface CssRule {
  /** The stylesheet's URL, so a relative `url()` in the rule resolves the way a browser does. */
  sheet: string;
  /** Whitespace-collapsed; `@font-face` for a face. */
  selector: string;
  /** By property, the LAST declaration winning as it does in CSS. */
  declarations: Record<string, string>;
}

/**
 * Every innermost rule in `css`, in source order. Uncapped on purpose (see the header), and a rule
 * nested in `@media` is found by its own selector, since `[^{}]` cannot pair a wrapper with a body.
 */
export function cssRules(css: string, sheet: string): CssRule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sheet,
    selector: m[1]!.replace(/\s+/g, ' ').trim(),
    declarations: Object.fromEntries(
      [...m[2]!.matchAll(/([\w-]+)\s*:\s*([^;}]+)/g)].map((d) => [d[1]!, d[2]!.trim()])
    ),
  }));
}

/**
 * A selector list's items, split on its top-level commas only, so `:is(a, b)` stays one item. Here
 * so `tools/linear-tokens/` and `tokens.test.ts` split a vendor's selectors the same way: the
 * extractor writes them into `tokens.json` and the test reads them back.
 */
export function selectorItems(list: string): string[] {
  const items = [''];
  let depth = 0;
  for (const c of list) {
    depth += c === '(' ? 1 : c === ')' ? -1 : 0;
    if (c === ',' && depth === 0) items.push('');
    else items[items.length - 1] += c;
  }
  return items;
}

const SMOOTHING = '-webkit-font-smoothing';

/**
 * The vendor's `body` rule that sets `-webkit-font-smoothing`, verbatim, and every OTHER rule that
 * sets it -- or `null` when no `body` rule does.
 *
 * Found by the DECLARATION, not the selector: Slack holds three exact `body` rules across its
 * sheets and only one declares smoothing, so a first-match lookup would record the wrong one and
 * call it the source. The overrides are what `surface/harness/tokens.test.ts` needs to say whether
 * the message pane really inherits the body's value.
 */
export function smoothingOf(
  rules: CssRule[]
): { bodyText: Record<string, string>; smoothingOverrides: { selector: string; value: string }[] } | null {
  const setting = rules.filter((r) => SMOOTHING in r.declarations);
  const body = setting.find((r) => r.selector === 'body');
  if (!body) return null;
  return {
    bodyText: body.declarations,
    smoothingOverrides: setting
      .filter((r) => r !== body)
      .map((r) => ({ selector: r.selector, value: r.declarations[SMOOTHING]! })),
  };
}

/** Which `@font-face` a caller wants: the family unquoted, the style, and the weight if it matters. */
export interface FaceWanted {
  family: string;
  style: 'normal' | 'italic';
  weight?: string;
}

/**
 * The font file the vendor SERVES for the `@font-face` `want` names, fetched and read by
 * `fontFacts` -- its first woff2 `url()`, resolved against the rule's own sheet. Throws with a
 * message the extractor prints, like its other exits.
 */
export async function servedFace(rules: CssRule[], want: FaceWanted): Promise<FontFacts & { src: string }> {
  const face = rules.find(
    ({ selector, declarations: d }) =>
      selector === '@font-face' &&
      d['font-family']?.replace(/["']/g, '') === want.family &&
      d['font-style'] === want.style &&
      (want.weight === undefined || d['font-weight'] === want.weight)
  );
  if (!face) throw new Error('no stylesheet declares the @font-face asked for');
  const rel = [...(face.declarations.src ?? '').matchAll(/url\(["']?([^)"']+)["']?\)/g)]
    .map((m) => m[1]!)
    .find((u) => /\.woff2(\?|$)/.test(u));
  if (!rel) throw new Error(`the @font-face in ${face.sheet} has no woff2 src`);
  return fetchedFace(new URL(rel, face.sheet).href);
}

/**
 * The font file at `src`, fetched and read by `fontFacts`. For a face no public stylesheet declares
 * -- Slack's code face is one -- so the URL came from somewhere else and says where in the caller.
 */
export async function fetchedFace(src: string): Promise<FontFacts & { src: string }> {
  return { src, ...fontFacts(await fetchedFontBytes(src)) };
}

/** The font file at `src`, as bytes. */
export async function fetchedFontBytes(src: string): Promise<Uint8Array> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${res.status} for ${src}`);
  return new Uint8Array(await res.arrayBuffer());
}
