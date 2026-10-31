/**
 * What `/draftgate:setup` ends with. `draftgate doctor --setup` prints it when the doctor finds no
 * problem, and the skill shows it as printed and adds nothing.
 *
 * Written here, not by the agent, which would write a long report, different every run. Every
 * count and name comes from the merged map, `tools.json`'s declines and the tools the extra-tools
 * entry covers.
 *
 * With a tool the person added, it ends with what that tool is handed and the guide's link
 * (`OTHER_TOOL_FORMAT`, what `--format` prints). Setup shows `--format`'s output before the person
 * picks a tool, but an agent can leave a command's output collapsed; the closing is the text setup
 * always shows, so the link reaches the person here even then. A route whose body the review
 * keeps as plain text (`reviewPlan`) is handed it unconverted, so the note never names one.
 *
 * Pure, like `doctorReport`: facts in, text out.
 */

import { profiles } from '../../../core/src/index';
import { REMEDY, typed } from '../../../core/src/remedies';
import { USER_COMMANDS } from '../../../cli/src/args';
import { AUDIT_ENV } from '../../../cli/src/audit';
import { blockFieldOf, reviewPlan } from '../../../cli/src/reviewPlan';
import { commandTable, either, oneLine } from '../../../cli/src/text';
import { CHOICE_GROUPS, OTHER_TOOL_FORMAT } from './reconcile';
import type { ToolMap } from './toolMap';

export interface ClosingFacts {
  /** The merged map: every tool reviewed by name, declined ones already out of it. */
  map: ToolMap;
  /** The tool halves `tools.json` declines that route something: a decline of nothing is no choice. */
  declined: readonly string[];
  /**
   * The mapped tools the plugin's own matcher cannot match, which the extra-tools entry reviews: the
   * tools the person added, which setup cannot tell from a vendor's, so it never calls them theirs.
   */
  ownTools: readonly string[];
  /** Whether reviews write the log: an empty `DRAFTGATE_AUDIT_LOG` turns it off. */
  logged: boolean;
}

/** The commands setup points at afterwards, and what each is for, in `draftgate help`'s words. */
const COMMANDS = (['digest', 'doctor', 'help'] as const).map((c) => [typed(REMEDY[c]), USER_COMMANDS[c]] as const);

/**
 * The declines in plain words: a group setup asks about (`CHOICE_GROUPS`), when every tool half
 * under it is declined, and the half itself otherwise -- a group named for part of it would claim
 * more than `tools.json` declines. The second value says whether the one name is a single tool.
 */
export function declinedNames(declined: readonly string[]): { names: string[]; oneTool: boolean } {
  const left = new Set(declined);
  const groups: string[] = [];
  for (const group of CHOICE_GROUPS) {
    if (!group.halves.every((half) => left.has(half))) continue;
    groups.push(group.label.replace(': ', ' '));
    for (const half of group.halves) left.delete(half);
  }
  const names = [...groups, ...[...left].map(oneLine)];
  return { names, oneTool: groups.length === 0 && names.length === 1 };
}

export function setupClosing(facts: ClosingFacts): string {
  // The destinations something is still reviewed for: with every Slack tool declined, "when Claude
  // sends to Slack, a window shows the message" would contradict the line naming the decline.
  const reviewedFor = new Set(Object.values(facts.map).map((route) => route.destination));
  const destinations = Object.entries(profiles)
    .filter(([name]) => reviewedFor.has(name as keyof typeof profiles))
    .map(([, profile]) => profile.displayName);
  const { names, oneTool } = declinedNames(facts.declined);
  const notReviewed =
    names.length === 0 ? 'none you declined' : `${names.join('; ')} (you declined ${oneTool ? 'it' : 'them'})`;
  // Without the tools the person added, which the next line names: "Also reviewed" adds to this.
  const reviewed = Object.keys(facts.map).length - facts.ownTools.length;
  const lines = [
    'draftgate is set up.',
    '',
    ...(destinations.length > 0
      ? [
          `When Claude sends to ${either(destinations)}, a window shows the message`,
          'as it will appear there. Edit it, then approve or reject. Nothing goes out until you do.',
        ]
      : ['Nothing is reviewed: every send tool is declined.']),
    '',
    `Reviewed: ${reviewed} send tool${reviewed === 1 ? '' : 's'}. Not reviewed: ${notReviewed}.`,
  ];
  if (facts.ownTools.length > 0) {
    const own = facts.ownTools.map(oneLine).join(', ');
    lines.push(`Also reviewed: ${own} (${facts.ownTools.length === 1 ? 'a tool' : 'tools'} you added).`);
  }
  lines.push(
    facts.logged
      ? "Every review is logged with the message's full text."
      : `Reviews are not logged: ${AUDIT_ENV} is set to empty.`,
    '',
    'Ask Claude to run:',
    ...commandTable(COMMANDS),
    '',
    // The headings are every tool draftgate knows, but other tools come from the tool list of the
    // session setup runs in. A server added for one project (its `.mcp.json`,
    // `docs/gating-your-own-sends.md`; or `claude mcp add` there, which `~/.claude.json` keeps per
    // project) is in that list only when Claude Code starts there.
    'Setup looked for other tools that send messages only in the connectors loaded in this',
    'session. A server added for one project (its .mcp.json, or claude mcp add there) loads only',
    `when Claude Code starts in that folder: run ${typed(REMEDY.pluginSetup)} there for those, and again`,
    'after adding a connector.'
  );
  const text = lines.join('\n') + '\n';
  // The tools the format note is true of: every one whose body the review converts. The plan decides
  // markdown or text, as it does for the review itself.
  const converts = (tool: string) => {
    const route = facts.map[tool];
    return route !== undefined && blockFieldOf(reviewPlan(route.destination, route))?.kind === 'markdown';
  };
  const converted = facts.ownTools.filter(converts).map(oneLine);
  if (converted.length === 0) return text;
  const which = converted.length === 1 ? converted[0] : `each of ${converted.join(', ')}`;
  return `${text}\nFor ${which}:\n${OTHER_TOOL_FORMAT}`;
}
