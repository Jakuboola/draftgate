/**
 * Argument parsing, kept separate so it can be tested without running the CLI. Hand-rolled: `core`
 * and `cli` have no dependencies.
 */

import { isKnownDestination, profiles, type DestinationName } from '../../core/src/index';
import { REMEDY, typed } from '../../core/src/remedies';
import { AUDIT_ENV } from './audit';
import { commandTable, either } from './text';
// For the help text, interpolated so it cannot go stale. `review.ts` imports nothing from here, so
// this import cannot cycle.
import { DEFAULT_TIMEOUT_MS } from './review';
// The route facts and their flag encoding, from the module that owns both: the hook's `cliArgs`
// writes these flags and this file reads them. A flag's field path is validated by `parseBodyPath`,
// as `tools.json` is, so a flag and a config entry accept the same things.
import {
  ROUTE_FLAGS, ROUTE_FLAG_NAMES, applyRouteFlag, RouteFlagError, type RouteFacts,
} from './routeFacts';

/**
 * The surfaces a review can run on; the type, the error message and the help text derive from it.
 * `webkit` is the window; the other two are for tests. There is no terminal surface: a terminal
 * cannot render a draft as its destination does. With no window server the review is
 * `unavailable` and the adapter asks.
 */
export const SURFACES = ['webkit', 'auto-approve', 'auto-reject'] as const;
export type SurfaceKind = (typeof SURFACES)[number];

export type Command =
  | 'review' | 'digest' | 'uninstall' | 'register' | 'doctor' | 'help' | 'version' | 'propose-tools';

/**
 * One invocation's arguments. Extends `RouteFacts`, so a new route flag arrives by the table that
 * emits it, with no edit here.
 */
export interface ParsedArgs extends RouteFacts {
  command: Command;
  /** `help`: the command whose `--help` was asked for. Absent, `draftgate help`: the command list. */
  helpFor?: Exclude<Command, 'help'>;
  inferredFrom?: string;
  destination?: DestinationName;
  /** Path to the payload JSON, or '-' for stdin. */
  input?: string;
  output?: string;
  timeoutMs?: number;
  surface: SurfaceKind;
  toolName?: string;
  json: boolean;
  /** Where the audit log goes. Overrides `DRAFTGATE_AUDIT_LOG`. */
  audit?: string;
  /** Suppress the audit log entirely. Wins over both `--audit` and the environment. */
  noAudit: boolean;
  /** Where to write the machine-readable outcome (approval OR denial). See `decisionFile.ts`. */
  decision?: string;
  /**
   * The agent session this review belongs to (`AuditRecord.session`), from `PreToolUse`'s
   * `session_id`. A direct CLI run has none.
   */
  sessionId?: string;
  /**
   * `uninstall --delete <path>`: the person was asked, and said yes, about deleting draftgate's
   * directory, which this names. See `cli/src/uninstall.ts`.
   */
  deleteDir?: string;
  /**
   * `propose-tools`: its arguments, handed to the hook's `--propose-tools` as they are. The hook
   * parses them, so the grammar has one reader.
   */
  proposeArgs?: string[];
  /**
   * `doctor --setup`: `/draftgate:setup`'s last step, which prints setup's closing message instead
   * of the report when nothing is wrong. See `adapters/hook/src/setupClosing.ts`.
   */
  setup?: boolean;
  /** `digest`: how many of the most recent edited approvals to print. */
  limit?: number;
  /** `digest`: report only reviews since the last `--mark`. */
  sinceLast: boolean;
  /**
   * `digest`: count scratch-target reviews in the headline numbers instead of holding them apart
   * (`scratchTargets.ts`). Off by default: scratch reviews can outnumber real ones.
   */
  includeScratch: boolean;
  /**
   * `digest`: advance the watermark after printing. Opt-in, so reading twice gives the same answer.
   */
  mark: boolean;
}

export class ArgError extends Error {}

/** setTimeout's delay is a signed 32-bit int; beyond this it wraps and fires immediately. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** How many edits `digest` prints when nobody says. Enough to see a pattern, bounded enough to read. */
export const DEFAULT_DIGEST_LIMIT = 20;

/**
 * Which command each flag belongs to. Absent means both (`--json`, `--audit`, `--help`). The two
 * commands share a parser, so without this `review --mark` would parse and do nothing, and
 * `digest --dest jira` would look like it filtered.
 */
const FLAG_COMMAND: Record<string, 'review' | 'digest'> = {
  '--dest': 'review', '-d': 'review', '--in': 'review', '--out': 'review', '--tool': 'review',
  '--timeout': 'review', '--surface': 'review', '--decision': 'review', '--no-audit': 'review',
  '--session': 'review', '--route-inferred-from': 'review',
  // Every route flag, so a new one is `review`-only with no entry typed here.
  ...Object.fromEntries(ROUTE_FLAG_NAMES.map((f) => [f, 'review' as const])),
  '--limit': 'digest', '--since-last': 'digest', '--mark': 'digest',
  '--include-scratch': 'digest',
};

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: 'help', surface: 'webkit', json: false, noAudit: false, sinceLast: false, mark: false,
    includeScratch: false,
  };
  if (argv.length === 0) return out;

  const [first, ...rest] = argv;
  const isHelp = (arg: string | undefined) => arg === '--help' || arg === '-h';
  if (isHelp(first) || first === 'help') return { ...out, command: 'help' };
  // The bare word too: the help lists `draftgate version` as a command.
  const command = first === '--version' || first === '-v' ? 'version' : first!;
  // `<command> --help`, anywhere among its arguments: that command's own text. One check for every
  // command, before any of them reads an argument it would refuse.
  if (Object.hasOwn(COMMAND_HELP, command) && rest.some(isHelp)) {
    return { ...out, command: 'help', helpFor: command as Exclude<Command, 'help'> };
  }
  if (command === 'version') return { ...out, command: 'version' };
  // The hook adapter's `--register` and `--doctor`, run as they are (`hookModes.ts`). Neither takes
  // a flag but `doctor --setup`: any other would be dropped silently, so it is refused.
  if (first === 'register' || first === 'doctor') {
    const allowed = first === 'doctor' ? ['--setup'] : [];
    if (rest.length > 1 || rest.some((a) => !allowed.includes(a))) {
      // The argument that is wrong, not `--setup` beside it: the first other one, or a second `--setup`.
      const got = rest.find((a) => !allowed.includes(a)) ?? rest[1];
      throw new ArgError(`draftgate ${first} takes ${allowed.length > 0 ? `only ${allowed.join(', ')}` : 'no options'}; got "${got}".`);
    }
    return rest.length === 1 ? { ...out, command: first, setup: true } : { ...out, command: first };
  }
  // The hook's `--propose-tools`, which reads the tool map and `tools.json` (`hookModes.ts`).
  if (first === 'propose-tools') {
    return { ...out, command: 'propose-tools', proposeArgs: rest };
  }
  // One option, `--delete <path>`, and nothing else: see `uninstall.ts` for why it takes the path.
  if (first === 'uninstall') {
    const [flag, path, ...extra] = rest;
    if (flag === undefined) return { ...out, command: 'uninstall' };
    if (flag !== '--delete') throw new ArgError(`draftgate uninstall takes only --delete <path>; got "${flag}".`);
    if (path === undefined || path.trim() === '') {
      throw new ArgError("--delete needs the path of draftgate's directory, as uninstall printed it.");
    }
    if (extra.length > 0) throw new ArgError(`draftgate uninstall takes only --delete <path>; got "${extra[0]}" too.`);
    return { ...out, command: 'uninstall', deleteDir: path };
  }
  if (first !== 'review' && first !== 'digest') {
    // Not a command: point at the command list, not one command's flags.
    throw new ArgError(`Unknown command "${first}". Try: draftgate --help`);
  }
  out.command = first;

  // Flags that belong to the other command, named by the check below.
  const wrong: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const owner = FLAG_COMMAND[arg];
    if (owner !== undefined && owner !== out.command) wrong.push(arg);
    const needsValue = () => {
      const v = rest[++i];
      if (v === undefined) throw new ArgError(`${arg} needs a value`);
      return v;
    };
    // A route fact, read by the table that also writes it (`routeFlagArgs`, from the hook's
    // `cliArgs`). Rewrapped as `ArgError`, which `main.ts` catches to print a usage line.
    if (ROUTE_FLAG_NAMES.includes(arg)) {
      try {
        applyRouteFlag(out, arg, needsValue());
      } catch (e) {
        if (!(e instanceof RouteFlagError)) throw e;
        throw new ArgError(e.message);
      }
      continue;
    }
    switch (arg) {
      case '--dest':
      case '-d': {
        const v = needsValue();
        if (!isKnownDestination(v)) {
          throw new ArgError(
            `Unknown destination "${v}". Known: ${Object.keys(profiles).join(', ')}.`
          );
        }
        out.destination = v;
        break;
      }
      case '--in': out.input = needsValue(); break;
      case '--out': out.output = needsValue(); break;
      case '--tool': out.toolName = needsValue(); break;
      case '--json': out.json = true; break;
      case '--audit': {
        // Empty is an error, not the default: `--audit "$LOG"` with `LOG` unset would otherwise
        // log to ~/.draftgate/audit.jsonl.
        const v = needsValue();
        if (v.trim() === '') throw new ArgError('--audit needs a path; use --no-audit to disable.');
        out.audit = v;
        break;
      }
      case '--no-audit': out.noAudit = true; break;
      case '--decision': {
        const v = needsValue();
        if (v.trim() === '') throw new ArgError('--decision needs a path.');
        out.decision = v;
        break;
      }
      case '--timeout': {
        const v = needsValue();
        const seconds = Number(v);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new ArgError(`--timeout needs a positive number of seconds, got "${v}"`);
        }
        const ms = Math.round(seconds * 1000);
        // `MAX_TIMEOUT_MS`: past it the timer wraps and a long timeout would deny at once.
        if (ms > MAX_TIMEOUT_MS) {
          throw new ArgError(
            `--timeout must be at most ${Math.floor(MAX_TIMEOUT_MS / 1000)} seconds ` +
              `(about 24 days); got ${seconds}. Larger values overflow the timer and deny at once.`
          );
        }
        out.timeoutMs = ms;
        break;
      }
      case '--session': out.sessionId = needsValue(); break;
      // The caller says the destination was inferred and from what; this layer has no tool map.
      case '--route-inferred-from': out.inferredFrom = needsValue(); break;
      case '--since-last': out.sinceLast = true; break;
      case '--include-scratch': out.includeScratch = true; break;
      case '--mark': out.mark = true; break;
      case '--limit': {
        const v = needsValue();
        // `Number('')` is 0, so an unset variable would mean "no edits". Empty is an error;
        // `--limit 0` asks for none.
        const n = v.trim() === '' ? NaN : Number(v);
        if (!Number.isInteger(n) || n < 0) {
          throw new ArgError(`--limit needs a whole number of edits (0 for none), got "${v}"`);
        }
        out.limit = n;
        break;
      }
      case '--surface': {
        const v = needsValue();
        if (!(SURFACES as readonly string[]).includes(v)) {
          throw new ArgError(`--surface must be one of ${SURFACES.join(', ')}; got "${v}"`);
        }
        out.surface = v as SurfaceKind;
        break;
      }
      default:
        throw new ArgError(`Unknown option "${arg}"`);
    }
  }

  if (wrong.length > 0) {
    throw new ArgError(
      `${wrong.join(', ')} ${wrong.length > 1 ? 'are' : 'is'} not valid for ` +
        `draftgate ${out.command}.`
    );
  }

  if (out.command === 'digest') {
    out.limit ??= DEFAULT_DIGEST_LIMIT;
    return out;
  }

  if (!out.destination) {
    // Derived from the profiles, like the `--dest` help line.
    throw new ArgError(`--dest is required (${Object.keys(profiles).join(', ')})`);
  }
  if (!out.input) throw new ArgError("--in is required (a payload JSON file, or - for stdin)");
  return out;
}

/**
 * `--body-format`'s values, interpolated from `ROUTE_FLAGS` like `SURFACES`. The route flags'
 * explanations are hand-written; a test asserts `review --help` names every flag.
 */
const FORMATS = (() => {
  const spec = ROUTE_FLAGS.bodyFormat;
  if (spec.kind !== 'choice') return 'plain';
  return spec.values.map((v) => (v === spec.unchanged ? `${v} (default)` : v)).join(' | ');
})();

/**
 * The commands a user asks Claude Code to run, in the order `draftgate help` lists them, and what
 * each is for. Setup's closing (`adapters/hook/src/setupClosing.ts`) points at some of them in the
 * same words. A line break continues a description on the next line (`commandTable`).
 *
 * `review`, `register` and `propose-tools` are not here: the hook and `/draftgate:setup` run them.
 * Each answers `--help`, as every command does (`COMMAND_HELP`).
 */
export const USER_COMMANDS = {
  doctor: 'check the gate is working',
  digest: 'what you changed in reviews, to teach your agent your style',
  uninstall: "remove draftgate's settings entry, name the command that\nremoves the plugin, then delete ~/.draftgate after asking",
  version: 'the installed version',
  help: 'the command list',
} as const satisfies Partial<Record<Command, string>>;

const SETUP = typed(REMEDY.pluginSetup);

/** `draftgate help`: what a user runs, on one screen. */
export const HELP = `draftgate holds each message your agent sends to ${either(Object.values(profiles).map((p) => p.displayName))}
until you approve it.

Ask Claude Code to run these:
${commandTable(Object.entries(USER_COMMANDS).map(([c, what]) => [`draftgate ${c}`, what])).join('\n')}

${SETUP} chooses which tools are reviewed. Run it again after adding a connector.
draftgate <command> --help shows a command's options.
`;

/**
 * `draftgate <command> --help`: one command's own text, options included.
 *
 * `config.json` is spelled out, not imported as `REVIEW_CONFIG_BASENAME`: `reviewConfig.ts` imports
 * `MAX_TIMEOUT_MS` from here, and these are evaluated at module load, so the cycle throws `Cannot
 * access 'REVIEW_CONFIG_BASENAME' before initialization` on every invocation. Only a real
 * subprocess sees it; unit tests import the modules in the other order.
 */
export const COMMAND_HELP: Record<Exclude<Command, 'help'>, string> = {
  doctor: `draftgate doctor [--setup]

Check that hooks are on and the registration matches the tool map. Exits 1 if a send could go
out unreviewed, or the review deadline is cut short.

  --setup   ${SETUP}'s last step: when nothing is wrong, print what setup ends with
            instead of the report
`,

  digest: `draftgate digest [options]

Read the review log: outcomes, warnings, what reviewers edited.

  --limit <n>        how many edited approvals to print, newest first (default ${DEFAULT_DIGEST_LIMIT}, 0 for none)
  --since-last       only reviews logged since the last --mark
  --mark             record how far this digest read, for the next --since-last
  --include-scratch  count scratch-target reviews in the headline numbers instead of holding
                     them apart (see ~/.draftgate/scratch.json)
  --json             print the digest as JSON instead of text
  --audit <path>     the log to read (default: $${AUDIT_ENV}, else
                     ~/.draftgate/audit.jsonl)
`,

  uninstall: `draftgate uninstall [--delete <path>]

Take draftgate's entries out of Claude Code's settings (and, from a checkout, its draftgate
link), name the command that removes the plugin (/plugin uninstall), then, after asking, delete
~/.draftgate: the review log and your draftgate settings.

  --delete <path>   the yes to deleting that directory, with its path as uninstall printed it.
                    With no terminal to ask on, uninstall deletes nothing and says what to ask
`,

  version: `draftgate version

Print the installed version: the plugin's, or in a checkout the newest vX.Y.Z tag.
`,

  register: `draftgate register

Write the one entry in ~/.claude/settings.json that reviews the tools in ~/.draftgate/tools.json
the plugin's own hook cannot match, or take it out when there are none, and print what changed.
${SETUP} runs it after asking. It keeps a backup and refuses a file it cannot read as
settings. It takes no options.
`,

  'propose-tools': `draftgate propose-tools <tool name>... [--review <tool>...] [--decline <tool>...] [--write]
draftgate propose-tools --known
draftgate propose-tools --drop <tool name>...
draftgate propose-tools --add <tool name> <destination> <field>

Compare a session's MCP tool names with the tools draftgate reviews, and list the ones you can
choose not to review. ${SETUP} runs it.

  --known               list the short tool names draftgate knows. A name that does not end in
                        one of them changes nothing here
  --review <tool>...    the tools to review, by the short names the list prints
  --decline <tool>...   the tools not to review, likewise. An answer names every tool in the list
                        after one of the two, or it is refused. --decline alone reviews every one
  --write               write that answer to ~/.draftgate/tools.json. Needs one. With no
                        tool names, it takes the ones the last run in this Claude Code session kept.
                        It drops the entries that say just what draftgate's own entry says, and
                        names the ones that override it
  --drop <tool name>... take these entries out of ~/.draftgate/tools.json, so draftgate's own entry
                        for the tool applies. Only an entry for one of draftgate's own tools
  --add <tool name> <destination> <field>
                        review a tool of a server you set up yourself (not a claude.ai connector
                        or a plugin's), its message read from <field>. <destination> is one of:
                        ${Object.keys(profiles).join(', ')}. The tool must take what draftgate hands
                        it: for jira, an ADF document as a JSON string with contentFormat "adf";
                        markdown for the rest. Then run ${SETUP} again
`,

  review: `draftgate review --dest <name> --in <path> [options]

Hold one outbound message for a person, then print the approved payload.

Normally you do not type this: the hook runs it. By hand, it shows how a payload renders. A
checkout has samples:

  bun cli/src/main.ts review --dest jira   --in docs/examples/jira-payload.json
  bun cli/src/main.ts review --dest slack  --in docs/examples/slack-payload.json
  bun cli/src/main.ts review --dest github --in docs/examples/github-payload.json

Options
  -d, --dest <name>     ${Object.keys(profiles).join(' | ')}
      --in <path>       the tool's input as JSON, or - for stdin. The approved payload is that
                        object with the body replaced
      --surface <kind>  ${SURFACES.join(' | ')}  (default: webkit)
      --tool <name>     the calling tool; decides what the review may say about the audience
      --timeout <secs>  seconds to wait for a decision (default: ${DEFAULT_TIMEOUT_MS / 1000},
                        or "reviewSeconds" from ~/.draftgate/config.json)

Options a caller supplies
      --decision <path> write the outcome, approval or denial, as versioned JSON. Read the
                        outcome from this file, never from stderr
      --out <path>      write the approved payload here (default: stdout)
      --session <id>    the calling session, to tell a retry from a new message
      --route-inferred-from <tool>
                        the destination was inferred from sharing a tool half with <tool>
      --body-field <name>
                        the input field that holds the message (default: the profile's)
      --context-field <name>
                        a routing field to show read-only, added to the profile's. Repeatable
      --body-format <kind>
                        ${FORMATS}. plain: stored verbatim, no formatting offered
      --prose-field <name>
                        another plain-text field the reviewer may edit, like a title. Repeatable
      --json            print denials as JSON on stderr
      --audit <path>    the review log (default: $${AUDIT_ENV},
                        else ~/.draftgate/audit.jsonl)
      --no-audit        do not log this review

Output
  stdout   the approved payload, and nothing else
  stderr   everything meant for a human, denials included
  exit     0 approved   1 rejected   2 timed out
`,
};
