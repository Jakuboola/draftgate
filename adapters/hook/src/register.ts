/**
 * `draftgate register`: draftgate's one entry in Claude Code's user settings, the one that reviews
 * the tools the plugin's own hook cannot match (`extraToolsBlock`). `/draftgate:setup` runs it after
 * the user says yes; `draftgate uninstall` runs the same walk with nothing to add.
 *
 *  - It edits only draftgate's own entries in `hooks.PreToolUse` (`classifyEntry`); everything else
 *    is carried over. An entry naming draftgate's hook in a shape draftgate never wrote is refused.
 *  - It leaves exactly one entry (duplicates both fire, `registration.ts`): an existing one is
 *    replaced where it stands, extras are removed, and so a checkout's entry becomes the plugin's.
 *  - A draftgate hook sharing a block is taken out of it, since the block's `matcher` is the other
 *    hooks' too; draftgate's goes in its own block right after.
 *  - It refuses a file it cannot parse, or whose `hooks` or `hooks.PreToolUse` has the wrong shape
 *    (`configMergeBase` in `cli/src/configFiles.ts`).
 *
 * The diff it prints has no context lines: `settings.json`'s `env` holds API tokens, the output often
 * lands in an agent's conversation, and a new `hooks` key sits after the last key, often the end of
 * `env`. A line whose only change is a trailing comma belongs to somebody else's value and is not
 * shown.
 *
 * Pure: text in, text out. The reading, the backup and the write are `main.ts`'s.
 */

import { basename, join } from 'node:path';
import { AUDIT_ENV } from '../../../cli/src/audit';
import { HOOK_IN_REPO } from '../../../cli/src/hookModes';
import { configMergeBase } from '../../../cli/src/configFiles';
import { isPlainObject } from '../../../cli/src/json';
import { lineDiff } from '../../../core/src/lineDiff';
import { REMEDY } from '../../../core/src/remedies';
import { commandOf, hookEntriesOf, type EntryClass } from './registration';

/**
 * A backup of a settings file is `<file>` + this + the UTC time, beside it: `register` and
 * `uninstall` make one before every change they write, and `uninstall` names them all as what it
 * leaves behind.
 */
export const BACKUP_INFIX = '.draftgate-backup-';

/** One `hooks.PreToolUse` block, as `register` writes it and the plugin's file holds it. */
export interface HookBlock {
  matcher: string;
  hooks: [{ type: 'command'; command: string; timeout: number; statusMessage: string }];
}

export type RegisterPlan =
  | { kind: 'refused'; why: string }
  | { kind: 'unchanged' }
  | {
      kind: 'changed';
      /** The file's new text. */
      text: string;
      /** The hooks the draftgate entries the file held before launched, in file order. */
      previous: string[];
      /** How many of those shared a block with somebody else's hooks. */
      shared: number;
      /**
       * The file was not laid out the way `JSON.stringify` lays it out, so writing rewrites it from
       * its parsed form, which loses a key written twice and rounds an integer past 2^53. The diff
       * cannot show that, so the report points at the backup instead.
       */
      reformatted: boolean;
      /** The changed lines, ready to print. See the header for why there is no context. */
      diff: string[];
    };

/**
 * What writing `want` into this settings file would do. `text` null means the file does not exist;
 * `want` null removes every draftgate entry (`draftgate uninstall`). `classify` is asked of each
 * `type: "command"` hook's `command`.
 */
export function planRegistration(
  text: string | null,
  want: HookBlock | null,
  classify: (command: string) => EntryClass,
  source: string
): RegisterPlan {
  // The writer's rule every `~/.draftgate` file follows: refuse what a reader would merely drop.
  // An empty file holds nothing to lose, so it is the first-write case.
  const raw = text ?? '';
  const root = configMergeBase(raw, source, 'hooks', 'Fix the file and run this again.');
  if (root instanceof Error) return { kind: 'refused', why: root.message };
  const hooks = root.hooks as Record<string, unknown> | undefined;
  const blocks = hooks?.PreToolUse;
  if (blocks !== undefined && !Array.isArray(blocks)) {
    return {
      kind: 'refused',
      why: `${source} has a "hooks.PreToolUse" that is not an array, so nothing was written to it. ` +
        'Fix the file and run this again.',
    };
  }

  const next: unknown[] = [];
  const previous: string[] = [];
  let shared = 0;
  // Placed where the first existing entry stood, so a replacement is an edit in place and the diff
  // is the entry and nothing else. A file with none gets it at the end.
  let placed = want === null;
  for (const [i, block] of ((blocks as unknown[] | undefined) ?? []).entries()) {
    // Each entry is asked once: an answer can read the filesystem (`probeHook`).
    const mine: string[] = [];
    const theirs: unknown[] = [];
    for (const entry of hookEntriesOf(block)) {
      const command = commandOf(entry);
      const found = command === null ? { kind: 'other' as const } : classify(command);
      if (found.kind === 'mentions') {
        // Named by place, not by command: a hook's command can hold a token.
        return {
          kind: 'refused',
          why: `${source} has a hook at hooks.PreToolUse[${i}] that names draftgate's hook but is ` +
            'not one draftgate wrote, so this cannot tell whether it is a second registration, and ' +
            'nothing was written. If it is meant to run draftgate, remove it and run this again.',
        };
      }
      if (found.kind === 'draftgate') mine.push(found.hook);
      else theirs.push(entry);
    }
    if (mine.length === 0) {
      next.push(block);
      continue;
    }
    previous.push(...mine);
    if (theirs.length > 0) {
      shared += 1;
      next.push({ ...(block as Record<string, unknown>), hooks: theirs });
    }
    if (!placed) {
      next.push(want);
      placed = true;
    }
  }
  if (!placed) next.push(want);

  let nextRoot: Record<string, unknown> =
    blocks === undefined && want === null
      ? root
      : { ...root, hooks: { ...(hooks ?? {}), PreToolUse: next } };
  // A removal that empties `PreToolUse` takes the key with it, and `hooks` too when nothing else is
  // in it: what `register` added to a file, `uninstall` takes back out. Only what this removal
  // emptied -- an empty list somebody wrote is theirs, and is left as it was. Every other key keeps
  // its place, so the diff is the removal alone.
  if (want === null && previous.length > 0 && next.length === 0) {
    const { PreToolUse: _, ...rest } = hooks!;
    const { hooks: __, ...others } = root;
    // A spread over a key it already holds keeps that key's place.
    nextRoot = Object.keys(rest).length > 0 ? { ...root, hooks: rest } : others;
  }
  // A missing file parses as `{}`, so a removal from one is unchanged here too.
  if (JSON.stringify(nextRoot) === JSON.stringify(root)) return { kind: 'unchanged' };

  const empty = raw.trim() === '';
  const indent = indentOf(raw);
  // The file's own last byte, kept: Claude Code writes a trailing newline, a hand edit may not.
  const eol = empty || raw.endsWith('\n') ? '\n' : '';
  const after = JSON.stringify(nextRoot, null, indent) + eol;
  // Diffed against the original laid out the same way, so a file that was not in that layout shows
  // what changed in it rather than every line it re-indents -- `reformatted` says the rest.
  const before = empty ? '' : JSON.stringify(root, null, indent) + eol;
  return {
    kind: 'changed',
    text: after,
    previous,
    shared,
    reformatted: !empty && before !== raw,
    diff: changedLines(before, after),
  };
}

/**
 * What `--register` covers, for its report: the tools the plugin's own hook cannot match
 * (`extraToolsBlock`), and `block` null when there are none and the entry is not needed.
 */
export interface Registered {
  block: HookBlock | null;
  tools: string[];
  /** draftgate's plugin link, which the entry runs the hook through. */
  link: string;
  /** The plugin root `register` points the link at. */
  root: string;
}

/** What `--register` says it did. Pure, like the plan: `main.ts` supplies the paths. */
export function registerReport(
  plan: Planned,
  facts: {
    /** The settings file. */
    target: string;
    /** Where the file as it was is kept, or null when there was no file. */
    backup: string | null;
    registered: Registered;
  }
): string {
  const { registered } = facts;
  if (registered.block === null) return notNeededReport(plan, facts.target, facts.backup);
  if (plan.kind === 'unchanged') {
    return (
      `draftgate is already registered in ${facts.target}, exactly as it would write it. ` +
      'Nothing changed.\n'
    );
  }
  const [hook] = registered.block.hooks;
  const hookPath = join(registered.link, HOOK_IN_REPO);
  const found = plan.previous.length;
  // What the replaced entries ran, when that was another hook (a checkout's, another plugin
  // version's): a `-` line of a 3 KB command is not where anybody finds it.
  const was = [...new Set(plan.previous)].filter((p) => p !== hookPath);
  const lines = [`draftgate is registered in ${facts.target}.`];
  lines.push(
    found === 0
      ? "  Added draftgate's entry to hooks.PreToolUse."
      : found === 1
        ? "  Replaced draftgate's entry where it stood."
        : `  Replaced draftgate's ${found} entries with one. Each of them fired, so every send ` +
          `opened ${found} review windows.`
  );
  if (plan.shared > 0) {
    lines.push(
      "  Took draftgate's hook out of a block it shared with other hooks. Those keep the block and",
      '  its matcher; draftgate has a block of its own right after it.'
    );
  }
  lines.push(
    `  hook      ${hookPath}`,
    ...was.map((p) => `  was       ${p}`),
    `  through   ${registered.link} -> ${registered.root}`,
    "  run by    bun, found the way the plugin's own hook finds it",
    "  gates     these, which the plugin's own hook cannot match, and the same tools under any",
    '            MCP server:',
    ...registered.tools.map((t) => `              ${t}`),
    `  timeout   ${hook.timeout}s`,
    `  backup    ${facts.backup ?? 'none: there was no settings file before'}`,
    '  If the hook cannot start, Claude Code asks you instead of sending.',
    restOfFile(plan),
    '  Claude Code reloads its settings while it runs, so sessions already open use this too.',
    '  Each new session points that link at the plugin version Claude Code runs, so the entry',
    `  follows draftgate's updates. To check it: ${REMEDY.doctor}`,
    ...diffSection(plan)
  );
  return lines.join('\n') + '\n';
}

/**
 * The plugin's own hook covers every tool draftgate reviews, so any draftgate entry in the file was
 * taken out.
 */
function notNeededReport(plan: Planned, target: string, backup: string | null): string {
  const covered = "The draftgate plugin's own hook covers every tool draftgate reviews";
  if (plan.kind === 'unchanged') return `${covered}, so ${target} needs no entry of draftgate's. Nothing changed.\n`;
  const found = plan.previous.length;
  const lines = [
    `${covered}, so draftgate's ${found === 1 ? 'entry' : `${found} entries`} in ${target} ` +
      `${found === 1 ? 'is' : 'are'} not needed and ${found === 1 ? 'was' : 'were'} removed.`,
    ...removedLines(plan, backup),
    ...diffSection(plan),
  ];
  return lines.join('\n') + '\n';
}

/** What both removals say after their headline: the shared block, what the entries ran, the backup. */
function removedLines(plan: Extract<RegisterPlan, { kind: 'changed' }>, backup: string | null): string[] {
  return [
    ...(plan.shared > 0 ? ['  A block it shared with other hooks keeps them, and its matcher.'] : []),
    ...[...new Set(plan.previous)].map((p) => `  was       ${p}`),
    `  backup    ${backup}`,
    restOfFile(plan),
  ];
}

/** A plan that was not refused: what both reports describe. */
type Planned = Exclude<RegisterPlan, { kind: 'refused' }>;

/** What both reports claim about the rest of the file. See `RegisterPlan.reformatted`. */
function restOfFile(plan: Extract<RegisterPlan, { kind: 'changed' }>): string {
  return plan.reformatted
    ? '  The file was not laid out the way Claude Code writes it, so all of it was rewritten that\n' +
        '  way. Compare it with the backup: a key written twice, for one, keeps only its last value.'
    : '  Nothing else in the file changed.';
}

/** Both reports end with the changed lines, and only those: the module header says why. */
function diffSection(plan: Extract<RegisterPlan, { kind: 'changed' }>): string[] {
  return ['', 'What changed, the changed lines only (settings.json holds secrets, so no context is shown):', ...plan.diff];
}

/** The variables that move draftgate's files, which Claude Code's settings `env` can set for reviews. */
const MOVES_FILES = ['DRAFTGATE_HOME', AUDIT_ENV] as const;

/** One of `MOVES_FILES` that the settings file sets, with this run's value beside it. */
export interface MovedVariable {
  name: string;
  settings: string;
  here: string | undefined;
}

/**
 * Each of `MOVES_FILES` the settings file's `env` sets to something other than `here` has it: where
 * reviews kept their files is then not where `draftgate uninstall`, run from a shell, looks for them.
 * The README names that `env` as the way to move the log. Only these two values are read, never
 * anything else in `env`, which is where tokens live.
 */
export function movedElsewhere(text: string | null, here: NodeJS.ProcessEnv): MovedVariable[] {
  let root: unknown;
  try {
    root = JSON.parse(text ?? '{}');
  } catch {
    return [];
  }
  const env = isPlainObject(root) ? root.env : undefined;
  if (!isPlainObject(env)) return [];
  return MOVES_FILES.flatMap((name) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '' && value !== here[name]
      ? [{ name, settings: value, here: here[name] }]
      : [];
  });
}

/**
 * What `--unregister` says it did (`draftgate uninstall`'s first step): the removal half of
 * `registerReport`, from the same plan. Pure, like it.
 */
export function unregisterReport(
  plan: Planned,
  facts: {
    target: string;
    backup: string | null;
    /** Every backup beside the file now, the one just made included. */
    backups: string[];
    /** `movedElsewhere`'s answer: draftgate files reviews kept where this run does not look. */
    moved: MovedVariable[];
  }
): string {
  // Named, never deleted: each is the user's settings as they were, tokens included.
  const n = facts.backups.length;
  const kept =
    n === 0
      ? []
      : [
          `  ${n} backup${n === 1 ? '' : 's'} draftgate made of this file ${n === 1 ? 'is' : 'are'} beside it ` +
            `(${basename(facts.target)}${BACKUP_INFIX}*). Each is your settings`,
          '  as they were, tokens included, and they are yours to delete when you no longer need them.',
        ];
  // Left in the file, like every other `env` value: the user wrote them there, by hand.
  for (const m of facts.moved) {
    kept.push(
      `  ${basename(facts.target)} sets ${m.name} to ${m.settings} for reviews, and this runs with ` +
        `${m.here === undefined ? 'none' : m.here}:`,
      `  what reviews kept there is not this uninstall's to find. Delete it yourself, or run uninstall`,
      `  again with ${m.name}=${m.settings}.`
    );
  }
  if (plan.kind === 'unchanged') {
    return [`draftgate is not registered in ${facts.target}. Nothing changed.`, ...kept].join('\n') + '\n';
  }
  const found = plan.previous.length;
  const lines = [
    `draftgate is no longer registered in ${facts.target}.`,
    found === 1
      ? "  Removed draftgate's entry from hooks.PreToolUse."
      : `  Removed draftgate's ${found} entries from hooks.PreToolUse.`,
    ...removedLines(plan, facts.backup),
  ];
  lines.push(
    '  Claude Code reloads its settings while it runs, so sessions already open stop reviewing too.',
    ...kept,
    ...diffSection(plan)
  );
  return lines.join('\n') + '\n';
}

/**
 * The indent a settings file already uses, so a rewrite keeps it: the shallowest leading whitespace
 * of a line that opens with a key, which is a top-level key's -- the first such line need not be,
 * when the first key shares a line with the `{`. Two spaces, Claude Code's own, when there is none.
 */
function indentOf(text: string): string | number {
  let best: string | null = null;
  for (const m of text.matchAll(/^([ \t]+)"/gm)) {
    if (best === null || m[1]!.length < best.length) best = m[1]!;
  }
  return best ?? 2;
}

/**
 * The lines that changed between two layouts of the file, `-` and `+`, with `@@ line N @@` (the
 * line in the new file) before each run. No context lines, and a pair of lines that differ only by
 * a trailing comma is not a change -- the module header has both reasons.
 */
export function changedLines(before: string, after: string): string[] {
  const rows = lineDiff(before, after);
  const out: string[] = [];
  /** Lines of the NEW file passed so far. */
  let line = 0;
  let i = 0;
  const bare = (t: string) => t.replace(/,$/, '');
  while (i < rows.length) {
    if (rows[i]!.kind === 'same') {
      line += 1;
      i += 1;
      continue;
    }
    // One run of changed rows, each with the new-file line it sits at: its own for an added line,
    // the next one for a removed line.
    const run: { sign: '-' | '+'; text: string; at: number; hidden?: boolean }[] = [];
    for (; i < rows.length && rows[i]!.kind !== 'same'; i++) {
      const row = rows[i]!;
      const added = row.kind === 'added';
      if (added) line += 1;
      run.push({ sign: added ? '+' : '-', text: row.text, at: added ? line : line + 1 });
    }
    for (const r of run) {
      if (r.sign !== '-') continue;
      const twin = run.find(
        (a) => a.sign === '+' && !a.hidden && a.text !== r.text && bare(a.text) === bare(r.text)
      );
      if (twin) r.hidden = twin.hidden = true;
    }
    const shown = run.filter((r) => !r.hidden);
    if (shown.length === 0) continue;
    out.push(`@@ line ${shown[0]!.at} @@`);
    for (const r of shown) out.push(`${r.sign}${r.text}`);
  }
  return out;
}
