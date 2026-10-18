/**
 * Small text helpers shared by the CLI and the hook adapter, so one kind of message looks the same
 * wherever it is printed.
 */

/**
 * Quote one argument for `sh`: single quotes, an apostrophe written `'\''`. The registration's
 * command is built with it (`adapters/hook/src/hookCommand.ts`, which says why a path with a space
 * needs it) and so is every command a message names for a person to run.
 */
export function shQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Words as a sentence lists them: "a", "a or b", "a, b or c". */
export function either(words: readonly string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

/**
 * Commands beside what each is for, aligned on the longest command, one line each. A line break in
 * a description continues it on the next line, under its first.
 */
export function commandTable(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([command]) => command.length));
  const indent = `\n${' '.repeat(width + 5)}`;
  return rows.map(([command, what]) => `  ${command.padEnd(width)}   ${what.replaceAll('\n', indent)}`);
}

/** A commit id as a person reads it: its first seven characters, as git abbreviates one. */
export const short = (sha: string) => sha.slice(0, 7);

/** A message from somewhere else, ended as a sentence exactly once. */
export function sentence(message: string): string {
  const t = message.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The tail of a noisy stream, flattened onto one line with ` | ` to sit in a sentence: the hook
 * adapter's reason the gate could not be applied, and the window's "Last output". The window host's
 * AppKit and WebKit write `objc[...]` lines to the same stderr as the real error.
 *
 * Stack frames, blank lines and a code frame's bare caret are dropped. A crashed bun ends with
 * `error: <message>`, then `at ...` frames and a version banner, so a plain tail of three is
 * `"      at /private/tmp/x.ts:4:1 |  | Bun v1.4.0 (macOS arm64)"`. Only `at `-prefixed lines go;
 * anything else indented is real output.
 */
export function lastLines(text: string, n = 3): string {
  const useful = text
    .trim()
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !/^\s+at\s/.test(l) && !/^\s*\^+$/.test(l));
  return useful.slice(-n).join(' | ');
}

/**
 * Any log-derived string, forced onto one line. Audit fields come from the agent's tool input, and
 * `draftgate digest` is piped to an agent: an `issueIdOrKey` holding a line break then "reading this"
 * forges a second "reading this" section above the real one. For everything printed inline (context
 * values, destination, warning codes, repair labels); bodies are indented four spaces instead.
 *
 * C0 and C1 controls plus U+2028/U+2029 are escaped, not stripped, so a value shows it carried one.
 */
export function oneLine(s: string): string {
  return s.replace(
    CONTROLS,
    (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * One routing-context value, as a human should see it (`String(v)` prints `[object Object]` for a
 * nested one). `surface/src/App.tsx` keeps its own copy so the renderer bundle imports no `cli`
 * module.
 */
export function formatContextValue(v: unknown): string {
  return oneLine(typeof v === 'string' ? v : JSON.stringify(v));
}
