/**
 * What the gate is registered to do, for two readers: `doctorReport` is `--doctor`, a page a person
 * asks for; `registrationNote` is the one line a review may spend on the same findings. One file so
 * the two cannot disagree.
 *
 * The report is pure (findings in, text out); the caller does the reading. Sections run in order of
 * what fails silently: an unregistered tool sends with no window, no log row and no error, then a
 * deny rule that shadows the gate, then the deadline, which needs a long review before it bites.
 */

import { toolAudienceProbed } from '../../../core/src/index';
import type { DestinationName } from '../../../core/src/index';
import { oneLine } from '../../../cli/src/text';
import { join } from 'node:path';
import { firesBesidePlugin, type RegisteredHook, type RegistrationReport } from './registration';
import { PLUGIN_HOOKS_IN_ROOT } from './pluginHooks';
import { matcherCovers, restates, shadowLine } from './toolMap';
import { asSeconds, clampRemedy, type Deadline } from './reviewTimeout';
import type { Shadow, ToolMap } from './toolMap';
export type { ClassificationState } from '../../../cli/src/classificationStores';
import { GITHUB_REFRESH, JIRA_REFRESH, type ClassificationState } from '../../../cli/src/classificationStores';
import { REMEDY } from '../../../core/src/remedies';
import type { HostFacts } from '../../../cli/src/reviewHost';
import type { ReleaseStatus } from '../../../cli/src/releaseCheck';
import { shQuote } from './hookCommand';
import type { HookSwitch, HookSwitchKey, HooksReport } from './hookSwitches';
import { enabledWhere, recordUnreadable, type PluginHere, type PluginRecord } from '../../../cli/src/claudePlugin';

export interface DoctorInput {
  report: RegistrationReport;
  deadline: Deadline;
  toolMap: ToolMap;
  /** Tool halves declined in `tools.json`: reported as a FACT, never a problem. */
  declined?: readonly string[];
  /** Declined halves nothing routes -- a decline of nothing, almost always a typo. */
  declinedUnrouted?: readonly string[];
  /** `tools.json` entries held dormant by a decline of their half. */
  dormant?: readonly string[];
  /** `tools.json` entries that replace a default entry of the same name. Absent means none. */
  shadows?: readonly Shadow[];
  /**
   * The matchers draftgate expects registered: from a checkout, its entry's for the merged map; from
   * the plugin its own file's and the settings entry's for the tools that file cannot match, when
   * there are any.
   */
  expectedMatchers: string[];
  /** Where the operator's `reviewSeconds` came from, for the deadline paragraph. */
  configPath: string;
  configPresent: boolean;
  configProblem?: string;
  /**
   * The classification stores, for the audience sections: counts, not records (a list of 157
   * project keys is not a diagnostic). Partial: Slack and Linear have one audience each, so no
   * classification question and no section.
   */
  classifications?: Partial<Record<DestinationName, ClassificationState>>;
  /**
   * The review window: whether this machine can run it, and whether its host is built from this
   * source. Absent means not asked, and prints nothing.
   */
  host?: HostFacts;
  /** Whether Claude Code runs hooks at all. Absent means not asked. */
  hooks?: HooksReport;
  /** The daily release check, read by the caller. Absent means not asked. */
  release?: ReleaseStatus;
  /**
   * draftgate entries that launch ANOTHER install's hook. From a checkout they are reported only
   * when none launches this one; from the plugin, each fires beside the plugin's own hook. Absent
   * or empty means there are none, and "not found" is the truth.
   */
  otherInstalls?: OtherInstall[];
  /** The draftgate plugin, as Claude Code records it. Absent means not asked. */
  plugin?: PluginFacts;
  /**
   * The review window's bundle, as a review would find it (`bundleState`, `describeState`), and
   * what to tell a person when a review would refuse it (`bundleRemedy`). Absent means not asked.
   */
  window?: { fresh: boolean; described: string; remedy: string | null };
  /**
   * `--setup`, setup's last step: an entry for the operator's own tools that does not follow the
   * plugin is then a problem, not a note, or setup's closing would call those tools reviewed while
   * every send through them asks, or after the next update.
   */
  setup?: boolean;
}

/** The plugin, for `--doctor`: where this hook runs from, and what Claude Code has installed. */
export interface PluginFacts {
  /** The plugin root this hook runs from, or null when it runs from a checkout. */
  root: string | null;
  record: PluginRecord;
  /** The user settings file, the one `register` edits. */
  userSettings: string;
  /**
   * draftgate's plugin link, which the extra-tools entry runs the hook through, and what is at its
   * path. Present when this hook runs from a plugin root.
   */
  link?: { path: string; at: AtLink };
}

/** What is at the plugin link's path: nothing, a link and where it points, or something else. */
export type AtLink = { kind: 'none' } | { kind: 'link'; target: string } | { kind: 'notLink' };

/** A draftgate entry that launches another install's hook, as `register` would recognise it. */
export interface OtherInstall {
  /** The settings file it is in. */
  source: string;
  /** The hook it launches. */
  hook: string;
  /** Whether that hook is there: a checkout that moved or was deleted leaves an entry that is not. */
  present: boolean;
  /** Whether the entry is the fail-closed wrapper, which asks when its hook cannot start. */
  failClosed: boolean;
  /** The plugin root a plugin wrapper entry names: the extra-tools entry `register` writes. */
  pluginRoot?: string;
}

/**
 * A `NOTE:` paragraph, the one shape every note in this report has: a blank line, the first line
 * after `NOTE:`, the rest indented under it, then one item per line.
 */
function pushNote(lines: string[], items: readonly string[] | undefined, ...text: string[]): void {
  if (!items || items.length === 0) return;
  lines.push('');
  lines.push(`  NOTE: ${text[0]}`);
  for (const t of text.slice(1)) lines.push(`    ${t}`);
  for (const item of items) lines.push(`      ${shown(item)}`);
}

/** A switch as the line that names it reads. */
const SWITCH_SPELLING: Record<HookSwitchKey, string> = {
  disableAllHooks: 'disableAllHooks: true',
  allowManagedHooksOnly: 'allowManagedHooksOnly: true',
  strictPluginOnlyCustomization: 'strictPluginOnlyCustomization, which locks hooks,',
};

const switchLine = (s: HookSwitch) =>
  `      ${SWITCH_SPELLING[s.key]} in ${shown(s.path)}${s.scope === 'managed' ? ' (managed)' : ''}`;

/** The hooks paragraph, first sentence in plain words for a reader who has never heard of a hook. */
function hooksSection(hooks: HooksReport, lines: string[], problems: string[]): void {
  if (hooks.stopping.length > 0) {
    problems.push('hooks turned off');
    lines.push('  PROBLEM: your Claude Code has hooks turned off, so draftgate cannot run. Every');
    lines.push('    gated tool sends with no review, no window and no audit-log entry, whatever the');
    lines.push('    rest of this report says:');
    for (const s of hooks.stopping) lines.push(switchLine(s));
    // Several only when each would decide the merge once the ones after it went (`hookSwitches`).
    const managed = hooks.stopping.filter((s) => s.scope === 'managed');
    const own = hooks.stopping.length - managed.length;
    if (own === 1) lines.push('    Remove that line from its file, or set it to false.');
    if (own > 1) {
      lines.push('    Remove all of those lines, or set the last of them to false. Removing only the');
      lines.push('    last leaves the one before it deciding.');
    }
    if (own > 0) {
      lines.push("    In a project's settings it switches hooks off for sessions in that project only.");
    }
    if (managed.length > 0) {
      lines.push('    Managed settings belong to whoever administers this machine, and only they can');
      lines.push('    change them.');
      if (managed.some((s) => s.leaves === 'managed')) {
        lines.push('    Every switch but disableAllHooks still runs a hook registered in managed');
        lines.push('    settings, so registering draftgate there is the other way back.');
      }
    }
  } else {
    if (hooks.stoppingPart.length > 0) {
      problems.push("hooks off for the plugin's extra-tools entry");
      lines.push("  PROBLEM: the plugin's hook runs, and the entry for the tools you added in your settings");
      lines.push('    does not, so the tools only it covers send with no review:');
      for (const s of hooks.stoppingPart) lines.push(switchLine(s));
      lines.push('');
    }
    if (hooks.spared.length > 0 && !hooks.registeredIn.includes('managed')) {
      // Spared because its hook is a plugin's (`hookSwitches.ts`'s `stops`), not a managed entry.
      lines.push("  draftgate runs, because its hook is the plugin's. Hooks from your own settings");
      lines.push('    files do not run here, so a registration in one would not:');
      for (const s of hooks.spared) lines.push(switchLine(s));
    } else if (hooks.spared.length > 0) {
      // Not "hooks are on": only managed ones are, and that is what lets this registration run.
      lines.push('  draftgate runs, because it is registered in managed settings. Only managed hooks');
      lines.push('    run here, so a registration anywhere else would not:');
      for (const s of hooks.spared) lines.push(switchLine(s));
    } else {
      lines.push('  Hooks are on in every settings file read.');
    }
    // What the reading cannot reach, said where its answer is.
    const project = hooks.projectDir === undefined ? 'no project' : shown(hooks.projectDir);
    lines.push(`    Project settings were read for ${project} only, and another project's can turn`);
    lines.push('    hooks off there. A session can also start with none: --bare, --safe-mode,');
    lines.push('    CLAUDE_CODE_SIMPLE, CLAUDE_CODE_SAFE_MODE or a --settings file.');
  }
  pushNote(
    lines,
    hooks.unread,
    'Claude Code also takes managed settings from a configuration profile, which',
    'draftgate cannot read. If it turns hooks off, nothing in this report can say so:'
  );
}

/**
 * Every settings file read: the registration's, then the managed tiers read for the hook switches
 * alone. A switch may be in any of them, so an unreadable one is a problem.
 */
const filesRead = (scanned: RegistrationReport['scanned'], hooks: HooksReport | undefined) => [
  ...scanned,
  ...(hooks?.policyFiles ?? []),
];

/**
 * A value read out of a settings file or `tools.json`, on one line: a newline in it would reach
 * column 0 and forge a `PROBLEM:` or `NOTE:` line.
 */
const shown = (v: string) => oneLine(v);

/**
 * The sentences each destination's audience section needs; the loop in `doctorReport` writes the
 * structure once. Report copy, so here and not in `core`; the destination facts it reports
 * (`toolAudienceProbed`) come from the profiles. Slack and Linear have one audience each, so no
 * section.
 */
export interface AudienceSection {
  /** '  Jira audience' */
  heading: string;
  /** The plural noun the counts are about: 'gated Jira tool(s)'. */
  toolNoun: string;
  /** Why an unprobed tool matters HERE, ending in a colon: the tool names follow. */
  unprobedWhy: string[];
  /** What the evidence for a probed audience actually is, named so it can be read. */
  evidence: string;
  /** The thing a reviewer can classify, singular: 'project', 'repository'. */
  subject: string;
  /** The same, plural, for the zero-state line: 'sites', 'repositories'. */
  plural: string;
  /**
   * The count sentence(s) from this destination's store. A function, since the vocabularies differ:
   * Jira counts sites, projects and service desks; GitHub counts repositories and the public ones.
   */
  counted(counts: Readonly<Record<string, number>>, path: string): string[];
  /** The `problems` entry when the file exists and cannot be used. */
  problemLabel: string;
  /** What zero classified means and how to answer up front. Follows 'so every'. */
  zeroWhy: string[];
  /** What follows the counts. */
  countedWhy: string[];
}

export const AUDIENCE_SECTIONS: Partial<Record<DestinationName, AudienceSection>> = {
  jira: {
    heading: 'Jira audience',
    toolNoun: 'gated Jira tool(s)',
    unprobedWhy: [
      'draftgate has measured nothing about who reads what they post, so rather than borrow',
      "another endpoint's answer it reports \"Audience unknown\" -- on a service desk, and on any",
      'project nothing has classified. On a project classified as something else,',
      'no banner at all -- there is no customer there to warn about:',
    ],
    evidence: 'probe against a live service desk, named in core/src/profiles/jira.ts',
    subject: 'project',
    plural: 'sites',
    counted: (c, path) => [
      `${c.sites} classified site(s), ${c.projects} project(s), ${c.serviceDesks} service desk(s) (${path}).`,
    ],
    problemLabel: 'jira-projects unreadable',
    zeroWhy: [
      'Jira review asks which project it is looking at and remembers the answer. That is a',
      'working install -- one click, once per project. To answer them up front instead, run',
      `${JIRA_REFRESH} if you have a Jira API token.`,
    ],
    countedWhy: [
      'A project it does not name is asked about at review time and remembered. A row that is',
      "WRONG is the case that does not self-heal: a reviewer's click never overwrites Jira's own",
      'answer, so re-classifying the site is the only correction.',
    ],
  },
  // Jira's audience varies by tool (a worklog, an internal note and a request comment reach three
  // sets of people); GitHub's by target: every write tool lands in the `owner`/`repo` repository, so
  // the unprobed line asks only whether an unchecked tool lands there at all.
  github: {
    heading: 'GitHub audience',
    toolNoun: 'gated GitHub tool(s)',
    unprobedWhy: [
      'Nothing has been checked about where what they write ends up, so rather than assume it',
      'lands in the repository named by owner/repo, the review reports "Audience unknown":',
    ],
    evidence: 'schema read, named in core/src/profiles/github.ts',
    subject: 'repository',
    plural: 'repositories',
    counted: (c, path) => {
      const lines = [
        `${c.repos} classified repositor${c.repos === 1 ? 'y' : 'ies'}, ${c.public} public (${path}).`,
      ];
      if (c.public > 0) {
        lines.push(
          `${c.public} of them ${c.public === 1 ? 'is' : 'are'} PUBLIC -- a comment there is a message to the internet.`
        );
      }
      return lines;
    },
    problemLabel: 'github-repos unreadable',
    zeroWhy: [
      'GitHub review asks whether the repository is public and remembers the answer. That is a',
      'working install -- one click, once per repository. To answer them up front instead, run',
      `${GITHUB_REFRESH}.`,
    ],
    countedWhy: [
      'One it does not name is asked about at review time and remembered. A row that is WRONG is',
      "the case that does not self-heal: a reviewer's click never overwrites GitHub's own answer,",
      'so re-reading the owner is the only correction.',
    ],
  },
};

/**
 * The remedy that rewrites the registration. From the plugin its own file is fixed and setup writes
 * the one entry beside it; a checkout registers nothing, so from one the fix is installing the plugin.
 */
function reregisterRemedy(fromPlugin: boolean): string {
  return fromPlugin ? REMEDY.pluginSetup : REMEDY.installPlugin;
}

/**
 * Render the report. `ok` (the exit code) is false when something here changes whether a message
 * gets reviewed: a clamped deadline counts (the operator asked for a longer review and is not
 * getting it), audience facts do not. One root cause is one problem: with no registration found,
 * the uncovered tools and the capped deadline follow from it and are not counted again.
 */
export function doctorReport(input: DoctorInput): { text: string; ok: boolean } {
  const { report, deadline, toolMap } = input;
  const lines: string[] = [];
  const problems: string[] = [];
  const fromPlugin = input.plugin?.root != null;
  const reregister = reregisterRemedy(fromPlugin);
  const found = report.ours.length > 0;

  lines.push('draftgate registration');
  lines.push('');

  // With hooks off a perfect registration reviews nothing, so this goes first.
  if (input.hooks) {
    hooksSection(input.hooks, lines, problems);
    lines.push('');
  }

  // Before the registration: a plugin Claude Code does not load makes its hooks.json a file
  // nobody reads.
  if (input.plugin) pluginSection(input.plugin, input.otherInstalls ?? [], report.ours, lines, problems, input.setup === true);

  const others = found ? [] : (input.otherInstalls ?? []);
  if (others.length > 0) {
    otherInstallSection(others, lines, problems);
    // What the other install gates and how long it waits are for its own --doctor to say.
    return finish(lines, problems, input);
  }
  if (!found) {
    problems.push('registration not found');
    lines.push('  REGISTERED: not found. No PreToolUse entry in the settings files below launches');
    lines.push('    this hook, so nothing is reviewed, unless draftgate is registered where this');
    lines.push('    cannot look: a plugin, or `claude --settings <file>`, which bypass these files.');
    lines.push(`    Run ${reregister}.`);
  } else {
    for (const hook of report.ours) {
      lines.push(`  REGISTERED in ${shown(hook.source)}`);
      lines.push(
        `    timeout ${hook.timeout === undefined ? '(unset, so the 600s event default)' : `${hook.timeout}s`}` +
          `  matcher covers ${matcherSummary(hook.matcher, toolMap)}`
      );
      if (hook.checkout !== undefined) {
        lines.push(`    launches the checkout at ${shown(hook.checkout.root)}, not this one`);
      }
    }
    // Another checkout of this repository is a working install, unless it is a worktree, which
    // stops working when the worktree is removed.
    if (report.ours.some((h) => h.checkout?.worktree)) {
      problems.push('registered for a worktree');
      lines.push('');
      lines.push('  PROBLEM: the registration launches the copy in a git WORKTREE, which stops');
      lines.push('    working the moment that worktree is removed -- and a hook that cannot launch');
      lines.push('    does not review anything. A checkout registers nothing: to put draftgate in place,');
      lines.push(`    run ${REMEDY.installPlugin}.`);
    } else if (report.ours.every((h) => h.checkout !== undefined)) {
      lines.push('');
      lines.push('  NOTE: this is another checkout of the same repository (a git worktree, usually),');
      lines.push('    and the hook Claude Code runs is the one named above. Nothing to register: a');
      lines.push('    registration naming this path would stop working when this checkout is removed.');
      lines.push("    Coverage is read against THIS checkout's tool map, so a map edited here and not");
      lines.push('    merged reads as covered early.');
    }
    if (report.firesTwice.length > 1) {
      problems.push(`registered ${report.firesTwice.length} times`);
      lines.push('');
      lines.push(`  PROBLEM: registered ${report.firesTwice.length} times, and both entries fire.`);
      lines.push('    Claude Code runs two matching PreToolUse entries CONCURRENTLY, and a deny from');
      lines.push('    either decides the call: two review windows on screen for one send, and the one');
      // From the plugin, beside it only the entry `register` writes: setup rewrites that one to
      // cover just the tools the plugin cannot match. The plugin's own cannot be removed.
      const { plugin } = input;
      if (plugin?.root != null && firesBesidePlugin(report.firesTwice, join(plugin.root, PLUGIN_HOOKS_IN_ROOT), plugin.userSettings)) {
        lines.push(`    you ignore can veto the one you used. Run ${REMEDY.pluginSetup} in Claude Code: it`);
        lines.push("    narrows draftgate's entry in your user settings to the tools the plugin cannot match.");
      } else {
        lines.push('    you ignore can veto the one you used. Remove all but one.');
      }
    }
    // Only with a registration found: with none, every mapped tool is uncovered and the paragraph
    // above says so.
    lines.push('');
    if (report.unregistered.length > 0) {
      problems.push(`${report.unregistered.length} gated tool(s) unregistered`);
      lines.push('  PROBLEM: these tools are in the map but no registered matcher covers them.');
      lines.push('    They send with no review, no window and no audit-log entry, and nothing says so:');
      for (const name of report.unregistered) lines.push(`      ${shown(name)}`);
      lines.push(
        fromPlugin
          ? `    Run ${reregister}: it adds one settings entry that reviews exactly the tools the plugin cannot.`
          : `    Run ${reregister}; the matcher is generated from the map.`
      );
    } else {
      lines.push(`  All ${Object.keys(toolMap).length} mapped tools are covered by a registered matcher.`);
    }
  }

  // A decline is recorded in `tools.json`, not a removed entry, so it can be reported as a fact.
  const declined = input.declined ?? [];
  if (declined.length > 0) {
    lines.push(`  ${declined.length} tool(s) deliberately not gated (declined in tools.json):`);
    for (const half of declined) lines.push(`      ${shown(half)}`);
  }
  const note = (items: readonly string[] | undefined, ...text: string[]) => pushNote(lines, items, ...text);
  note(
    input.declinedUnrouted,
    'these are declined, but nothing draftgate routes uses that name. A decline of',
    'nothing is usually a typo -- and if so, the tool you meant is still gated:'
  );
  note(
    input.dormant,
    'these tools.json entries are kept DORMANT because their tool is declined. They',
    'come back exactly as written if you re-enable it:'
  );
  // Notes, not problems: an entry that differs may be the operator's choice, and one that does not
  // changes nothing today. What is lost is every later change to draftgate's own entry.
  const shadows = input.shadows ?? [];
  note(
    shadows.filter(restates).map((s) => s.name),
    "these tools.json entries say just what draftgate's own entry for the tool says. An",
    "entry replaces draftgate's whole, so a change draftgate makes to its own never reaches the",
    `tool. ${REMEDY.pluginSetup} drops them, or ${REMEDY.dropToolEntries} with their names:`
  );
  note(
    shadows.filter((s) => !restates(s)).map(shadowLine),
    "these tools.json entries override draftgate's own entry for the same tool. An entry",
    "replaces draftgate's whole, so a change draftgate makes to its own never reaches the tool.",
    'Each line says what yours does differently. Kept on purpose, that is fine; to use',
    `draftgate's instead, run ${REMEDY.dropToolEntries} with the name:`
  );
  note(
    report.declinedStillMatched,
    'the registered matcher still covers these declined tools. They are not reviewed,',
    "as tools.json asks -- Claude Code's own permission flow decides -- but the hook",
    fromPlugin
      ? "still starts for every call: the plugin's matcher is the same on every machine:"
      : `still starts for every call. ${reregister} narrows it:`
  );
  // A note, not a problem: a registration without the fail-closed wrapper reviews until its hook
  // cannot start.
  note(
    // One line per file: two bare entries in one file are one place to fix.
    [...new Set(report.ours.filter((h) => !h.failClosed).map((h) => h.source))],
    'this registration does not fail closed. If its hook cannot start -- bun gone, the',
    'checkout moved, a file that no longer loads -- Claude Code runs the tool UNREVIEWED,',
    `because a hook that exits non-zero lets the call through. The one ${reregister} writes`,
    'answers "ask" instead. It replaces the entry in your user settings; remove one in any other',
    'file first. The entries:'
  );

  if (report.unmapped.length > 0) {
    problems.push(`${report.unmapped.length} registered name(s) unmapped`);
    lines.push('');
    lines.push('  PROBLEM: the matcher names tools the map does not know. Those arrive here and are');
    lines.push('    DENIED -- somebody asked for them to be reviewed and draftgate cannot route them:');
    for (const name of report.unmapped) lines.push(`      ${shown(name)}`);
    lines.push(`    Either add them to ~/.draftgate/tools.json or run ${reregister}.`);
  }

  if (report.opaqueMatchers.length > 0) {
    lines.push('');
    lines.push('  NOTE: a registered matcher is not an anchored alternation, so the check above');
    lines.push('    could not ask it which names it claims. Coverage of the mapped tools was still');
    lines.push('    tested directly and is reported. The matcher:');
    for (const m of report.opaqueMatchers) lines.push(`      ${shown(m)}`);
  }

  // From the plugin, a half nothing infers is a tool its fixed matcher cannot match, already named
  // above as uncovered.
  if (report.halvesNotInferred.length > 0 && !(fromPlugin && report.unregistered.length > 0)) {
    problems.push('registration predates tool-half matching');
    lines.push('');
    lines.push('  PROBLEM: this registration gates only the tool names it LISTS. A connector under a');
    lines.push('    server name you have not configured -- a project-scoped MCP server in another');
    lines.push('    folder, say -- is not reviewed at all, and nothing else here can see that: the');
    lines.push('    tools it would miss have no map entry to be missing from, so coverage still');
    lines.push('    reads complete. The matcher draftgate registers now also infers from these');
    lines.push('    tool names, whatever server offers them:');
    for (const half of report.halvesNotInferred) lines.push(`      ${shown(half)}`);
    lines.push(`    Run ${reregister}.`);
  }

  // The general finding, only when no specific one above already covers it.
  if (
    found &&
    report.halvesNotInferred.length === 0 &&
    report.unregistered.length === 0 &&
    report.declinedStillMatched.length === 0 &&
    !input.expectedMatchers.every((m) => report.ours.some((h) => h.matcher === m))
  ) {
    lines.push('');
    lines.push('  NOTE: no registered matcher is byte-identical to the one draftgate registers now,');
    lines.push('    though everything checked above is covered. The registration is older than the');
    lines.push(`    current tool map; ${reregister} costs nothing and removes the question.`);
  }

  if (report.shadowed.length > 0) {
    problems.push(`${report.shadowed.length} gated tool(s) shadowed by a deny rule`);
    lines.push('');
    lines.push('  PROBLEM: a deny rule outranks PreToolUse, so these never reach a review at all.');
    lines.push('    The map entry reads as protection that is not being provided:');
    for (const s of report.shadowed) {
      lines.push(`      ${shown(s.tool)}  <- "${shown(s.rule)}" in ${shown(s.source)}`);
    }
    lines.push('    Intentional for an agent that must not reach the destination at all; a mistake');
    lines.push('    anywhere the gate is meant to be the control.');
  }

  /*
   * Who reads the message. Not problems: an unprobed tool or an unclassified target still opens a
   * window; they change what its banner can say. Reported because the two look identical on
   * screen: the target question is one click and self-heals, the tool question has no user remedy.
   * Only a destination with a gated tool gets a section, so a broken classification file (the one
   * problem here) counts only where a review reads it. The skeleton is this loop; each
   * destination's sentences are `AUDIENCE_SECTIONS`, and its tools are counted on their own.
   */
  for (const [destination, section] of Object.entries(AUDIENCE_SECTIONS) as [
    DestinationName,
    AudienceSection,
  ][]) {
    const tools = Object.keys(toolMap).filter((t) => toolMap[t]?.destination === destination);
    if (tools.length === 0) continue;
    const unprobed = tools.filter((t) => !toolAudienceProbed(destination, t));
    lines.push('');
    lines.push(`  ${section.heading}`);
    if (unprobed.length > 0) {
      lines.push(`    ${unprobed.length} of ${tools.length} ${section.toolNoun} have no probed audience.`);
      for (const line of section.unprobedWhy) lines.push(`    ${line}`);
      for (const name of unprobed) lines.push(`      ${shown(name)}`);
      lines.push('    Not a misconfiguration and not fixable from any config file -- the evidence is a');
      lines.push(`    ${section.evidence}.`);
      lines.push(
        `    Unlike the ${section.subject} question below, no click in the review window can answer it.`
      );
    } else {
      lines.push(`    All ${tools.length} ${section.toolNoun} have a probed audience.`);
    }

    const state = input.classifications?.[destination];
    if (state === undefined) continue;
    if (state.problem) {
      // A file that lost an entry: the operator believes a target is classified when it is not.
      problems.push(section.problemLabel);
      lines.push(`    PROBLEM: ${shown(state.problem)}`);
      lines.push(`    Every ${section.subject} it dropped falls back to the ask, which is safe; every one it`);
      lines.push('    dropped is also a classification you believe you have and do not.');
    }
    if (state.classified === 0) {
      lines.push(
        `    No classified ${section.plural} (${shown(state.path)}${state.present ? '' : ', absent'}), so every`
      );
      for (const line of section.zeroWhy) lines.push(`    ${line}`);
    } else {
      // `shown`: the count sentence embeds a path.
      for (const line of section.counted(state.counts, state.path)) lines.push(`    ${shown(line)}`);
      for (const line of section.countedWhy) lines.push(`    ${line}`);
    }
  }

  if (input.host || input.window) {
    lines.push('');
    lines.push('  Review window');
  }
  if (input.window) {
    const { fresh, described, remedy } = input.window;
    if (fresh) {
      lines.push('    the window is built from this source.');
    } else if (remedy !== null) {
      // No toolchain to rebuild it: every review would answer `unavailable`, which asks.
      problems.push('the review window cannot be used');
      lines.push(`    PROBLEM: no review can show its window, so every gated send asks instead.`);
      lines.push(`    ${shown(remedy)}`);
    } else {
      lines.push(`    NOTE: the window is ${shown(described)}. The next review rebuilds it first.`);
    }
  }
  if (input.host) {
    const { host, verdict } = input.host;
    if (verdict.kind === 'below-floor') {
      problems.push('no macOS the review window runs on');
      lines.push(`    PROBLEM: ${shown(verdict.why)}.`);
      lines.push("    No review can open here, so every gated send reaches Claude Code's own");
      lines.push('    permission prompt instead.');
    } else if (host.state === 'current') {
      lines.push('    the host is built from this source.');
    } else if (verdict.kind === 'no-compiler') {
      problems.push('the review host cannot be built');
      lines.push(`    PROBLEM: the host is ${host.state} (${shown(host.why)}), and without the Command Line`);
      lines.push('    Tools it cannot be built, so every review would be unavailable. Run');
      lines.push(`    ${REMEDY.installCommandLineTools}.`);
    } else {
      lines.push(`    NOTE: the host is ${host.state} (${shown(host.why)}). The next review builds it first,`);
      lines.push('    in about a second.');
    }
  }

  lines.push('');
  lines.push('  Review deadline');
  lines.push(
    `    asked for ${asSeconds(deadline.wantedMs)}` +
      (input.configPresent ? ` (${input.configPath})` : ' (shipped default; no config file)')
  );
  if (input.configProblem) {
    problems.push('config unreadable');
    lines.push(`    PROBLEM: ${input.configProblem}`);
  }
  switch (deadline.basis.kind) {
    case 'asked':
      lines.push(`    granted ${asSeconds(deadline.ms)}, which the registration outlives.`);
      break;
    case 'clamped':
      problems.push('deadline clamped');
      lines.push(
        `    PROBLEM: granted only ${asSeconds(deadline.ms)} -- the registered timeout is ` +
          `${asSeconds(deadline.basis.registeredMs)} and draftgate's deadline must fire FIRST.`
      );
      lines.push("    Claude Code's own hook timeout is fail-open: when it wins, the runtime falls");
      lines.push('    through with the agent\'s original input and nothing is drawn for the user.');
      lines.push(`    ${clampRemedy(deadline.ms, { plugin: fromPlugin, configPath: input.configPath })}`);
      break;
    case 'unregistered':
      // Counted with the missing registration it follows from. "only" claims a loss, so it is said
      // only when the operator asked for more than the cap.
      lines.push(
        deadline.ms < deadline.wantedMs
          ? `    granted only ${asSeconds(deadline.ms)}: with no registration found, the event default ` +
            'less its grace is the most that can be assumed.'
          : `    granted ${asSeconds(deadline.ms)}, which is under the event-default cap that applies ` +
            'when no registration can be found.'
      );
      break;
  }

  // Never a problem: no release state changes whether a message is reviewed. The `newer` line is
  // the one a review prepends (`releaseNotice`).
  if (input.release) {
    lines.push('');
    lines.push('  Releases');
    for (const line of releaseLines(input.release, input.configPath, fromPlugin)) lines.push(`    ${line}`);
  }

  return finish(lines, problems, input);
}

/**
 * The plugin paragraph: from the plugin, whether Claude Code loads it (`hooks/hooks.json` is there
 * either way); from a checkout with a registration, whether a plugin reviews the same tools.
 */
function pluginSection(
  plugin: PluginFacts,
  others: readonly OtherInstall[],
  ours: readonly RegisteredHook[],
  lines: string[],
  problems: string[],
  setup: boolean
): void {
  const { root, record } = plugin;
  if (root === null) {
    if (record.kind === 'read') checkoutBesidePlugin(record.installs, ours.length > 0, lines, problems);
    return;
  }
  if (record.kind === 'unreadable') {
    problems.push("Claude Code's plugin record unreadable");
    lines.push(`  PROBLEM: ${shown(recordUnreadable(record))}, so this cannot say whether`);
    lines.push(`    Claude Code loads this plugin. ${REMEDY.pluginManager} lists it.`);
  } else {
    installSection(record.installs, root, lines, problems);
  }
  leftoverSection(others, plugin.userSettings, lines, problems);
  if (plugin.link) followSection(ours, others, plugin.link, plugin.userSettings, lines, setup ? problems : null);
  lines.push('');
}

/** From a checkout: a plugin enabled here fires for every tool this registration does. */
function checkoutBesidePlugin(installs: readonly PluginHere[], ours: boolean, lines: string[], problems: string[]): void {
  const ids = [...new Set(installs.filter((i) => i.enabled?.enabled).map((i) => i.id))];
  if (!ours || ids.length === 0) return;
  problems.push('the draftgate plugin reviews here too');
  lines.push(`  PROBLEM: the draftgate plugin is enabled here too (${ids.map(shown).join(', ')}), and its hook`);
  lines.push('    fires for the tools this registration does: two review windows for every send.');
  lines.push(`    Run ${REMEDY.pluginSetup} in Claude Code: it takes draftgate's entry out of your user`);
  lines.push('    settings and keeps only one for tools the plugin cannot match, if you have any.');
  lines.push('');
}

/** What Claude Code has installed, against the plugin root this runs from. */
function installSection(installs: readonly PluginHere[], root: string, lines: string[], problems: string[]): void {
  const here = installs.filter((i) => i.enabled !== null);
  const enabled = here.filter((i) => i.enabled!.enabled);
  const ids = [...new Set(enabled.map((i) => i.id))];

  for (const i of here) {
    lines.push(`  PLUGIN ${shown(i.id)} ${shown(i.version)}, ${shown(i.scope)} scope, ${shown(enabledWhere(i.enabled!))}`);
    lines.push(`    runs from ${shown(i.inPlace ?? i.installPath)}`);
  }
  if (here.length === 0) {
    problems.push('plugin not installed');
    lines.push('  PROBLEM: Claude Code has no draftgate plugin installed for sessions here, so the');
    lines.push("    registration below is a file it does not load, and nothing is reviewed. Install it");
    lines.push(`    in ${REMEDY.pluginManager}. A session started with --plugin-dir loads it for that session`);
    lines.push('    alone, which no file shows.');
  } else if (enabled.length === 0) {
    problems.push('plugin switched off');
    lines.push('');
    lines.push("  PROBLEM: the draftgate plugin is installed and switched off here, so its hook does");
    lines.push(`    not run and nothing is reviewed. Turn it on: ${REMEDY.pluginEnable(here[0]!.id)}.`);
  } else if (ids.length > 1) {
    problems.push(`${ids.length} draftgate plugins enabled`);
    lines.push('');
    lines.push(`  PROBLEM: ${ids.length} draftgate plugins are enabled here, and every hook fires: one`);
    lines.push('    review window per plugin for every send, and a deny from any of them decides it.');
    lines.push('    Uninstall all but one:');
    for (const id of ids) lines.push(`      ${shown(REMEDY.pluginUninstall(id))}`);
  } else if (!enabled.some((i) => i.thisRoot)) {
    lines.push('');
    lines.push(`  NOTE: this report reads the plugin at ${shown(root)}, which is not the folder above.`);
    lines.push('    New sessions run the one above; a session started before an update runs its own');
    lines.push(`    until ${REMEDY.reloadPlugins}.`);
  }
}

/** Every other draftgate entry in the settings: Claude Code runs it beside the plugin's hook. */
function leftoverSection(others: readonly OtherInstall[], userSettings: string, lines: string[], problems: string[]): void {
  const leftovers = others.filter((o) => o.pluginRoot === undefined);
  if (leftovers.length > 0) {
    problems.push("another install's draftgate hook beside the plugin");
    lines.push('');
    lines.push('  PROBLEM: the settings also register draftgate from another install, and it fires');
    lines.push("    for tools the plugin's hook reviews: two review windows for every send.");
    for (const o of leftovers) lines.push(`      ${shown(o.source)} launches ${shown(o.hook)}`);
    if (leftovers.some((o) => o.source === userSettings)) {
      lines.push(`    ${REMEDY.pluginSetup} takes it out of your user settings.`);
    }
    if (leftovers.some((o) => o.source !== userSettings)) {
      lines.push("    draftgate edits only your user settings: take it out of any other file yourself.");
    }
  }
}

/**
 * The extra-tools entry, when it does not follow the plugin: it names a version folder, or the
 * plugin link it runs through leads somewhere other than this root. Its tools, when no entry
 * covers them, are named below as uncovered; this says why, and what makes it follow. A `NOTE`,
 * or under `--setup`, given `problems`, a `PROBLEM` (`DoctorInput.setup`).
 */
function followSection(
  ours: readonly RegisteredHook[],
  others: readonly OtherInstall[],
  link: NonNullable<PluginFacts['link']>,
  userSettings: string,
  lines: string[],
  problems: string[] | null
): void {
  const label = problems === null ? 'NOTE' : 'PROBLEM';
  const before = lines.length;
  const fix = (source: string) =>
    source === userSettings
      ? `${REMEDY.pluginSetup} points it at this one, through the link.`
      : 'draftgate edits only your user settings: take it out of that file yourself.';
  // An entry naming a version folder, this one's included (then it counts as ours).
  for (const e of [...ours.map((h) => ({ ...h, present: true })), ...others]) {
    if (e.pluginRoot === undefined || e.pluginRoot === link.path) continue;
    lines.push('');
    lines.push(`  ${label}: the entry for the tools you added in ${shown(e.source)} names one plugin version's folder,`);
    lines.push(`    ${shown(e.pluginRoot)}${e.present ? '' : ', which is gone'}, so it does not follow draftgate's updates.`);
    lines.push(`    ${fix(e.source)}`);
  }
  // An entry through the link that does not lead to this root: one that did would be ours.
  for (const o of others.filter((e) => e.pluginRoot === link.path)) {
    lines.push('');
    lines.push(`  ${label}: the entry for the tools you added in ${shown(o.source)} runs the plugin through ${shown(link.path)},`);
    if (link.at.kind === 'notLink') {
      // Not draftgate's to replace, so setup cannot mend it until it is moved.
      lines.push('    which is not a link: something else is there, so every send through those tools asks.');
      lines.push(`    Move it away, then ${o.source === userSettings ? `run ${REMEDY.pluginSetup}` : 'take the entry out of that file'}.`);
      continue;
    }
    lines.push(
      link.at.kind === 'none'
        ? '    which is missing, so every send through those tools asks.'
        : `    which points at ${shown(link.at.target)}${o.present ? ', not this plugin version' : ', which is gone'}.`
    );
    lines.push(`    ${fix(o.source)}`);
  }
  if (problems !== null && lines.length > before) problems.push('the entry for the tools you added does not follow the plugin');
}

/** The files read and the verdict, which every report ends with. */
function finish(lines: string[], problems: string[], input: DoctorInput): { text: string; ok: boolean } {
  lines.push('');
  lines.push('  Settings files read');
  const unreadable: string[] = [];
  for (const s of filesRead(input.report.scanned, input.hooks)) {
    if (s.problem) {
      unreadable.push(s.path);
      lines.push(`    ${shown(s.path)}  UNREADABLE: ${shown(s.problem)}`);
    } else {
      lines.push(`    ${shown(s.path)}  ${s.present ? 'read' : 'absent'}`);
    }
  }
  // One problem naming every unreadable file, not one per file.
  if (unreadable.length > 0) problems.push(`unreadable: ${unreadable.join(', ')}`);

  lines.push('');
  lines.push(
    problems.length === 0
      ? '  No problems found.'
      : `  ${problems.length} problem(s): ${problems.join('; ')}.`
  );

  return { text: lines.join('\n') + '\n', ok: problems.length === 0 };
}

/** A recorded instant, to the minute, in UTC whatever offset it was written with. */
const when = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The release check's paragraph: the facts are `releaseStatus`'s, the sentences this file's. */
function releaseLines(status: ReleaseStatus, configPath: string, plugin: boolean): string[] {
  // A plugin is judged by its manifest's version, not by git (`installIdentity`).
  const here = plugin ? 'this plugin' : 'this checkout';
  const origin = plugin ? "the plugin's repository" : 'origin';
  switch (status.kind) {
    case 'off':
      return status.because !== undefined
        ? [
            'the daily release check is off, and stays off until the file can be used:',
            `  ${shown(status.because)}`,
          ]
        : [
            `the daily release check is off ("releaseCheck": false in ${shown(configPath)}), so`,
            `${origin} is never asked and no review says when an update exists.`,
          ];
    case 'unchecked':
      return [
        `not checked yet. The first review asks ${origin} whether a newer release exists, after its`,
        'decision is written, and at most once a day after that.',
      ];
    case 'running':
      return [`a check started ${when(status.attemptedAt)} is still running.`];
    case 'unfinished':
      return [
        `a check started ${when(status.attemptedAt)} never finished (killed, or the machine`,
        `slept). The next review after ${when(status.nextAt)} starts another.`,
      ];
    case 'git-failed':
      return [
        `git could not list this checkout's tags (${shown(status.why)}, ${when(status.checkedAt)}),`,
        `so nothing is compared. The next check is due ${when(status.nextAt)}.`,
      ];
    case 'no-head':
      return plugin
        ? [`this plugin's version is not a vX.Y.Z release (${when(status.checkedAt)}), so nothing is compared.`]
        : [`could not read this checkout's HEAD (${when(status.checkedAt)}), so nothing is compared.`];
    case 'unreleased':
      return [
        'this checkout carries no vX.Y.Z release tag, so there is nothing to compare and origin',
        `is not asked (checked ${when(status.checkedAt)}).`,
      ];
    case 'moved':
      return [
        `${here} has moved since the last check (${when(status.checkedAt)}), so nothing is`,
        `said until the next one, due ${when(status.nextAt)}.`,
      ];
    case 'failed':
      return [
        `the last check got no answer from ${origin} (${shown(status.why)}, ` +
          `${when(status.checkedAt)}),`,
        `so nothing is said until one does. The next is due ${when(status.nextAt)}.`,
      ];
    case 'newer':
      return [`NOTE: ${status.line}`];
    case 'current':
      return [
        `${status.have}, and nothing newer to update to (checked ${when(status.checkedAt)}).`,
      ];
  }
}

/**
 * draftgate is registered for another install than this one (a dev checkout beside the plugin,
 * say). Not "not found": registering this one too would be a second entry, two windows per send.
 */
function otherInstallSection(others: readonly OtherInstall[], lines: string[], problems: string[]): void {
  const gone = others.filter((o) => !o.present);
  const there = others.filter((o) => o.present);
  if (there.length > 0) {
    problems.push('registered for another install');
    lines.push('  REGISTERED for another install, not this checkout:');
    for (const o of there) lines.push(`    ${shown(o.source)} launches ${shown(o.hook)}`);
    lines.push('    That is the hook Claude Code runs, so this report cannot vouch for what it gates or');
    lines.push("    how long it waits. Ask that install's own --doctor, which reads both against its map:");
    for (const o of there) lines.push(`      ${shown(REMEDY.doctorAt(shQuote(o.hook)))}`);
  }
  if (gone.length > 0) {
    problems.push('registered for an install that is gone');
    if (there.length > 0) lines.push('');
    lines.push('  REGISTERED for an install that is not there any more:');
    for (const o of gone) lines.push(`    ${shown(o.source)} launches ${shown(o.hook)}, which does not exist`);
    lines.push('    A hook that cannot start reviews nothing.');
    if (gone.some((o) => o.failClosed)) {
      lines.push('    The fail-closed entry makes Claude Code ask you about every gated send instead.');
    }
    if (gone.some((o) => !o.failClosed)) {
      lines.push('    The bare entry lets Claude Code run every gated tool UNREVIEWED.');
    }
    lines.push(`    Run ${REMEDY.installPlugin}: it replaces the entry where it stands.`);
  }
  if (others.length > 1) {
    problems.push(`registered ${others.length} times`);
    lines.push('    All of these fire, so one send opens one window per entry, and a deny from any');
    lines.push(`    one of them decides the call. ${REMEDY.pluginSetup} leaves exactly one.`);
  }
}

/** How many mapped tools a matcher fires for, through `matcherCovers` (the one definition). */
function matcherSummary(matcher: string, toolMap: ToolMap): string {
  const names = Object.keys(toolMap);
  // A pattern that will not compile would read as "0/11" and send the operator after a missing tool.
  try {
    new RegExp(matcher);
  } catch {
    return 'an unreadable pattern';
  }
  return `${names.filter((n) => matcherCovers(matcher, n)).length}/${names.length} mapped tools`;
}

/**
 * The one line a review may spend on this, or null. Prepended to the decision's own message,
 * because Claude Code trims `systemMessage` to 20 lines and 2000 characters from the end.
 */
export function registrationNote(report: RegistrationReport, plugin = false): string | null {
  const reregister = reregisterRemedy(plugin);
  // First: with no registration found `unregistered` is every mapped tool, yet this hook is
  // answering a review, so it is registered somewhere this cannot see (`claude --settings`, an
  // unreadable file). Saying "these send unreviewed" would be false on every review.
  if (report.ours.length === 0) {
    return (
      'draftgate: could not find its own hook registration in any settings file, so the review ' +
      `deadline is capped and drift cannot be checked. Run ${REMEDY.doctor}.`
    );
  }
  if (report.unregistered.length > 0) {
    const names = report.unregistered.join(', ');
    return (
      `draftgate: ${report.unregistered.length} mapped tool(s) are NOT registered and send ` +
      `unreviewed (${names}). Run ${reregister}.`
    );
  }
  if (report.firesTwice.length > 1) {
    return (
      `draftgate: this hook is registered ${report.firesTwice.length} times, so a send opens that many ` +
      `review windows and a denial in any of them wins. Run ${REMEDY.doctor}.`
    );
  }
  if (report.shadowed.length > 0) {
    const names = [...new Set(report.shadowed.map((s) => s.tool))].join(', ');
    return `draftgate: a deny rule outranks the gate for ${names}; those never reach a review.`;
  }
  // Last, though nothing else reports the tools it misses: the findings above are named tools or a
  // gate that is not running.
  if (report.halvesNotInferred.length > 0) {
    return (
      'draftgate: this registration gates only the tool names it lists, so a connector under a ' +
      `server name you have not configured is not reviewed at all. Run ${reregister}.`
    );
  }
  return null;
}
