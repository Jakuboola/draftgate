/**
 * A minimal line diff, for showing what a change would do: the window's one-click fix
 * (`surface/src/FixDiff.tsx`), and what `draftgate register` wrote into Claude Code's settings
 * (`adapters/hook/src/register.ts`). Hand-rolled to keep `core` and `cli` dependency-free; in
 * `core` so the hook adapter need not import the window's source. Classic LCS over lines: O(n*m)
 * in table size, after the identical head and tail are trimmed off.
 */

export type DiffLine =
  | { kind: 'same'; text: string }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Strip the identical head and tail before building the table. Over a whole document it is not
  // cheap (measured: 1,000 lines 22.6ms and 7.0 MB, 6,000 lines 274ms and 175 MB), and neither the
  // wire protocol nor `runReview` caps the body. Both uses differ in a few rows: the fix preview's
  // `after` only rewrites blockquote children, and `register`'s two texts differ in one hook entry.
  let head = 0;
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail++;
  }

  const a = beforeLines.slice(head, beforeLines.length - tail);
  const b = afterLines.slice(head, afterLines.length - tail);
  const prefix: DiffLine[] = beforeLines.slice(0, head).map((text) => ({ kind: 'same', text }));
  const suffix: DiffLine[] = beforeLines
    .slice(beforeLines.length - tail)
    .map((text) => ({ kind: 'same', text }));

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return [...prefix, ...out, ...suffix];
}

/** Drop long runs of unchanged lines, keeping `context` either side of each change. */
export function collapseUnchanged(lines: DiffLine[], context = 2): (DiffLine | { kind: 'gap'; count: number })[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });

  const out: (DiffLine | { kind: 'gap'; count: number })[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped > 0) {
        out.push({ kind: 'gap', count: skipped });
        skipped = 0;
      }
      out.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: 'gap', count: skipped });
  return out;
}
