/**
 * The report `uninstall` and `release` print: numbered steps, each with a verdict, a summary row per
 * step, the closing lines, and the exit status they add up to. An agent reads these off stdout and
 * keys on the exit code, so the two must not word a `FAILED` row or count a failure differently.
 */

/** One step's verdict: `ok`, `not run`, or what happened. Only `failed` changes the exit status. */
export type Verdict = { label: string; failed?: true };

export const OK: Verdict = { label: 'ok' };
export const failed = (label: string): Verdict => ({ label, failed: true });

/** A step's own lines, indented under its header. */
export const detail = (lines: string[]) => lines.map((l) => `      ${l}`);

/** A child's own words (git's, gh's), quoted under a step: its last `max` lines when given. */
export const quoted = (text: string, max?: number) =>
  detail(text.trimEnd().split('\n').filter(Boolean).slice(max === undefined ? 0 : -max).map((l) => `| ${l}`));

export function stepReport(steps: readonly string[], print: (text: string) => Promise<void>) {
  const verdicts: Verdict[] = steps.map(() => ({ label: 'not run' }));
  const width = Math.max(...steps.map((s) => s.length));
  const out = (lines: string[]) => print(lines.join('\n') + '\n');
  const header = (n: number, title: string) => `${n}/${steps.length}  ${title}`;
  return {
    verdicts,
    out,
    header,
    detail,
    /**
     * Step `n` as a child process that prints its own report, stdio inherited: the header, the
     * child, then one verdict worded once, `failure`, for both its summary row and the line under
     * the child's output. Answers whether it exited 0.
     */
    child: async (n: number, title: string, run: () => number, failure: string): Promise<boolean> => {
      await out([header(n, title), '']);
      const ok = run() === 0;
      verdicts[n - 1] = ok ? OK : failed(`${failure} (above)`);
      await out(['', ...detail([ok ? 'ok' : `FAILED: ${failure}; why is above.`]), '']);
      return ok;
    },
    /** The summary and the closing lines; answers with the exit status: 0 when nothing failed. */
    finish: async (closing: string[]): Promise<number> => {
      await print(
        [
          'Summary',
          ...steps.map((s, i) => {
            const v = verdicts[i]!;
            return `  ${i + 1}  ${s.padEnd(width)}  ${v.failed ? `FAILED: ${v.label}` : v.label}`;
          }),
          '',
          ...closing,
          '',
        ].join('\n')
      );
      return verdicts.some((v) => v.failed) ? 1 : 0;
    },
  };
}
