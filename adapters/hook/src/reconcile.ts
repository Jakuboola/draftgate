/**
 * The tool map against the tool names that exist on this machine.
 *
 * `--doctor` checks the registered matchers against the merged map, not the map against the
 * connectors here: with the shipped `mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue` and a
 * local `mcp__atlassian__addCommentToJiraIssue`, it would report full coverage. The names are
 * reachable only from an agent session's tool list (`~/.claude.json` keeps `mcpServers` per
 * project, and claude.ai connectors are not in it), so the caller supplies them; nothing is
 * discovered.
 *
 * A name whose tool half matches a mapped entry under another server is the same tool
 * (`toolMap.ts`), and is proposed as an alias. Anything else is reported as unknown, never guessed
 * (`toolMap.ts` on "is it outbound"). `--write` (in `main.ts`) writes the answer's `tools.json`.
 */

import { REMEDY } from '../../../core/src/remedies';
import { oneLine } from '../../../cli/src/text';
import { isKnownDestination, profiles, type DestinationName } from '../../../core/src/index';
import {
  DECLINED_KEY,
  declinedHalfOf,
  restates,
  entryForHalf,
  routeFactsFor,
  toolHalfOf,
  toolHalvesOf,
  type ToolConfig,
  type ToolMap,
  type ToolRoute,
} from './toolMap';

export interface Proposal {
  /** The name as the caller sees it. */
  name: string;
  /** The mapped entry it matches on the tool half. */
  matches: string;
  route: ToolRoute;
}

export interface Reconciliation {
  /** Names the merged map already gates. */
  gated: string[];
  /** Names that are the same TOOL under a different server, with the route they should take. */
  proposed: Proposal[];
  /** MCP names draftgate has no opinion about. Counted, not listed as a suggestion. */
  unknown: string[];
  /** Names that are not MCP tool names at all -- `Bash`, `Read`, an agent's own tools. */
  notMcp: string[];
  /** Names whose tool half the operator DECLINED in `tools.json`. Never proposed. */
  declined: string[];
  /**
   * What each declined name with no entry of its own would be proposed as, were its half
   * re-enabled, so a re-enable from setup brings it back as an alias rather than inferred.
   */
  proposedIfEnabled: Proposal[];
  /**
   * The choice: one row per tool half this session can see and draftgate can route, the unit a
   * decline records. Sorted by group (`CHOICE_GROUPS`, the order setup asks in), then by half.
   */
  halves: HalfChoice[];
  /**
   * `tools.json` entries that say just what the default entry of the same name says. An answer's
   * file drops them (`answeredToolsJson`): today they change nothing, and kept, they stop every
   * later change to the default reaching the tool, so there is nothing to ask.
   */
  restated: string[];
}

export interface HalfChoice {
  half: string;
  destination: DestinationName;
  /** The plain-words heading it is asked about under (`groupOf`). */
  group: string;
  /** How many of the given names carry this half: the connectors it is reachable through. */
  connectors: number;
  /** Declined already, so the checklist shows it unticked. */
  declined: boolean;
}

/**
 * What a person choosing is asked about: kinds of message in plain words, in the order setup asks.
 * A group is a list of tool halves, so declining one declines each half under it and `tools.json`
 * still holds halves. Every half the default map routes is in exactly one group
 * (`reconcile.test.ts`); a half only `tools.json` routes is a group of its own (`groupOf`).
 */
export const CHOICE_GROUPS: readonly { label: string; halves: readonly string[] }[] = [
  { label: 'Jira: comments', halves: ['addCommentToJiraIssue'] },
  { label: 'Jira: work log notes', halves: ['addWorklogToJiraIssue'] },
  { label: 'Jira: new and edited issues', halves: ['createJiraIssue', 'editJiraIssue'] },
  { label: 'Slack: messages, sent now or scheduled', halves: ['slack_send_message', 'slack_schedule_message'] },
  { label: 'Linear: comments', halves: ['save_comment', 'save_diff_comment'] },
  { label: 'Linear: new and edited issues', halves: ['save_issue'] },
  { label: 'Linear: project status updates', halves: ['save_status_update'] },
  { label: 'Linear: customer requests', halves: ['save_customer_need'] },
  { label: 'GitHub: issues and issue comments', halves: ['add_issue_comment', 'issue_write'] },
  { label: 'GitHub: pull requests', halves: ['create_pull_request', 'update_pull_request'] },
  {
    label: 'GitHub: pull request reviews',
    halves: ['add_comment_to_pending_review', 'add_reply_to_pull_request_comment', 'pull_request_review_write'],
  },
];

/** The heading a half is asked about under, and where that heading sorts. */
export function groupOf(half: string, destination: DestinationName): { label: string; order: number } {
  const order = CHOICE_GROUPS.findIndex((g) => g.halves.includes(half));
  return order >= 0
    ? { label: CHOICE_GROUPS[order]!.label, order }
    : { label: `${profiles[destination].displayName}: ${half}`, order: CHOICE_GROUPS.length };
}

/**
 * Every tool half `reconcileTools` can use: the merged map's and the declined ones. Other names
 * come out `unknown` or `notMcp`, which nothing an answer writes reads, so setup passes only names
 * ending in `__<half>` (a filter that can keep a name it need not, never drop one it needs).
 */
export function knownHalves(tools: Pick<ToolConfig, 'map' | 'declinedRoutes'>): string[] {
  return toolHalvesOf({ ...tools.map, ...tools.declinedRoutes });
}

/** Compare the names a caller can see with the map draftgate would apply. Pure. */
export function reconcileTools(
  names: string[],
  map: ToolMap,
  /**
   * The operator's declines, and the routes they removed: a declined half has no entry left in
   * `map`, so its destination (for the checklist and a re-enable) comes from `declinedRoutes`. And
   * the entries shadowing a default, for the answer's file.
   */
  config: Pick<ToolConfig, 'declined' | 'declinedRoutes' | 'shadows'> = {
    declined: [], declinedRoutes: {}, shadows: [],
  }
): Reconciliation {
  const out: Reconciliation = {
    gated: [], proposed: [], unknown: [], notMcp: [], declined: [], proposedIfEnabled: [], halves: [],
    restated: config.shadows.filter(restates).map((s) => s.name),
  };
  const choices = new Map<string, HalfChoice>();
  /** Where each half's group sorts, read once, with its label, when the half's row is made. */
  const orderOf = new Map<string, number>();
  const count = (half: string, destination: DestinationName, isDeclined: boolean) => {
    let row = choices.get(half);
    if (row === undefined) {
      const { label: group, order } = groupOf(half, destination);
      orderOf.set(half, order);
      row = { half, destination, group, connectors: 0, declined: isDeclined };
      choices.set(half, row);
    }
    row.connectors++;
  };
  for (const name of [...new Set(names)].sort()) {
    const half = toolHalfOf(name);
    if (declinedHalfOf(name, config.declined) !== null) {
      out.declined.push(name);
      const routes = config.declinedRoutes;
      const from = entryForHalf(routes, half!);
      if (from === null) continue;
      count(half!, routes[from]!.destination, true);
      if (!Object.hasOwn(routes, name)) {
        out.proposedIfEnabled.push({ name, matches: from, route: { ...routes[from]! } });
      }
      continue;
    }
    // `Object.hasOwn`, not `in`: `--propose-tools toString constructor` would print "GATED already".
    if (Object.hasOwn(map, name)) {
      out.gated.push(name);
      if (half !== null) count(half, map[name]!.destination, false);
      continue;
    }
    if (half === null) { out.notMcp.push(name); continue; }
    // `entryForHalf`, as `resolveRoute`: the proposal copies the entry the gate uses.
    const matches = entryForHalf(map, half);
    if (matches === null) { out.unknown.push(name); continue; }
    out.proposed.push({ name, matches, route: { ...map[matches]! } });
    count(half, map[matches]!.destination, false);
  }
  // By group, then by half; a half no group names sorts last, by its own heading.
  out.halves = [...choices.values()].sort(
    (a, b) =>
      orderOf.get(a.half)! - orderOf.get(b.half)! || a.group.localeCompare(b.group) || a.half.localeCompare(b.half)
  );
  return out;
}

/**
 * The proposals that apply once `declined` is the answer: this run's, plus any declined name the
 * answer re-enables, minus any it declines. The report and the printed file both read this list.
 */
export function proposalsFor(r: Reconciliation, declined: readonly string[]): Proposal[] {
  return [...r.proposed, ...r.proposedIfEnabled]
    .filter((p) => declinedHalfOf(p.name, declined) === null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The words `/draftgate:setup` asks again on (`plugin/skills/setup/SKILL.md`). */
export const UNANSWERED = 'the answer leaves these unanswered';

/**
 * The `declined` list after a setup answer, or a refusal. `chosen` (`--decline`) and `reviewed`
 * (`--review`) are the full answer for the halves shown; a half declined earlier and not shown (its
 * connector not loaded here) stays declined.
 *
 * An answer that names any half names every one shown, each once: a question whose answer never
 * came back would otherwise be read as one, declining what the person never declined or
 * re-enabling what they did. `--decline` alone, naming none, reviews every one shown.
 */
export function declinedAfter(
  r: Reconciliation,
  existing: readonly string[],
  chosen: readonly string[],
  /** Null when `--review` was not given: only then does an answer naming nothing mean "every one". */
  reviewed: readonly string[] | null
): { declined: string[] } | { error: string } {
  const shown = new Set(r.halves.map((h) => h.half));
  const quoted = (halves: readonly string[]) => halves.map((h) => `"${oneLine(h)}"`).join(', ');
  const named = [...chosen, ...(reviewed ?? [])];
  const stray = named.filter((h) => !shown.has(h));
  if (stray.length > 0) {
    return {
      error:
        `${quoted(stray)} is not a tool in the checklist. Name tools as the checklist prints them ` +
        '(e.g. slack_send_message).',
    };
  }
  const both = chosen.filter((h) => reviewed?.includes(h));
  if (both.length > 0) return { error: `${quoted(both)} is after both --decline and --review. Name each tool once.` };
  if (named.length > 0 || reviewed !== null) {
    const answered = new Set(named);
    const open = r.halves.filter((h) => !answered.has(h.half));
    if (open.length > 0) {
      const groups = [...new Set(open.map((h) => h.group))].map(
        (group) => `  ${oneLine(group)}: ${open.filter((h) => h.group === group).map((h) => oneLine(h.half)).join(' ')}`
      );
      return {
        error:
          `${UNANSWERED}, so it was not taken:\n` +
          groups.join('\n') +
          '\nAn answer names every tool in the checklist, after --review or --decline. Ask about these too, ' +
          'then pass the whole answer.',
      };
    }
  }
  const kept = existing.filter((h) => !shown.has(h));
  return { declined: [...new Set([...kept, ...chosen])].sort() };
}

/**
 * The `tools.json` an answer makes: the operator's file with `declined` set to the answer, the
 * entries that restate a default dropped, and the proposals that answer leaves standing added.
 * What the report prints as "the file below" and what `--write` writes, so the two cannot differ.
 */
export function answeredToolsJson(
  r: Reconciliation,
  existing: Record<string, unknown>,
  declined: readonly string[]
): string {
  const kept = Object.fromEntries(Object.entries(existing).filter(([name]) => !r.restated.includes(name)));
  return proposedToolsJson(proposalsFor(r, declined), kept, declined);
}

/**
 * The `tools.json` an operator should end up with: their current file (`existing`, which the
 * caller must pass, or an agent writing the block would delete every alias) plus the proposals.
 * `schemaOwner` is not emitted: `mergeToolMap` stamps it and never reads it from the file.
 */
export function proposedToolsJson(
  proposals: Proposal[],
  existing: Record<string, unknown>,
  /**
   * The `declined` list to write, when setup has an answer; omitted leaves the file's own. Aliases
   * for a declined half are kept (dormant, `mergeToolConfig`). Pass `proposalsFor(r, declined)`.
   */
  declined?: readonly string[]
): string {
  const merged: Record<string, unknown> = { ...existing };
  if (declined !== undefined) {
    if (declined.length > 0) merged[DECLINED_KEY] = [...declined];
    else delete merged[DECLINED_KEY];
  }
  // Which facts travel is `ROUTE_FACTS`' answer (`bodyOptional` never does).
  for (const p of proposals) {
    merged[p.name] = { destination: p.route.destination, ...routeFactsFor(p.route, 'proposed') };
  }
  return JSON.stringify(merged, null, 2);
}

/** The clause an answer's report spends on the restating entries its file drops. */
function restatedDropped(r: Reconciliation): string {
  return r.restated.length === 0 ? '' : `, ${r.restated.length} entry(ies) that restate draftgate's own dropped,`;
}

/**
 * The report, for a human or for the agent relaying it. It always says it saw only the names it
 * was given, so a short list does not read as complete.
 */
export function describeReconciliation(
  r: Reconciliation,
  /** How many tools the merged map routes. No default: the unmerged count would be wrong. */
  mappedCount: number,
  /** The operator's CURRENT `tools.json`, so the printed file is their file plus the proposals. */
  existing: Record<string, unknown>,
  /** Where that file lives. `draftgateHome` honours `DRAFTGATE_HOME`; a hardcoded `~` does not. */
  toolsPath: string,
  /** The `declined` list setup's answer produces (`declinedAfter`), when it was given. */
  answer?: readonly string[]
): string {
  const lines: string[] = [];
  const seen =
    r.gated.length + r.proposed.length + r.declined.length + r.unknown.length + r.notMcp.length;
  lines.push(`draftgate: reconciled ${seen} tool name(s) against ${mappedCount} mapped.`);
  lines.push('');

  if (r.gated.length > 0) {
    lines.push(`  GATED already (${r.gated.length}):`);
    for (const n of r.gated) lines.push(`    ${oneLine(n)}`);
  }
  if (r.declined.length > 0) {
    lines.push('');
    lines.push(`  DECLINED in tools.json, so not reviewed (${r.declined.length}):`);
    for (const n of r.declined) lines.push(`    ${oneLine(n)}`);
  }
  // The choice, one row per tool half under its group; `x` is gated, blank declined.
  if (r.halves.length > 0) {
    const groups = new Set(r.halves.map((h) => h.group)).size;
    lines.push('');
    lines.push(`  CHOOSE which to review -- ${r.halves.length} tool(s) in ${groups} group(s), x = reviewed:`);
    const width = Math.max(...r.halves.map((h) => h.half.length));
    // The rows are sorted by group, so a heading is printed where the group changes.
    let heading: string | null = null;
    for (const h of r.halves) {
      if (h.group !== heading) lines.push(`    ${oneLine((heading = h.group))}`);
      const via = `${h.connectors} connector${h.connectors === 1 ? '' : 's'}`;
      lines.push(`      [${h.declined ? ' ' : 'x'}] ${oneLine(h.half).padEnd(width)}  ${via}`);
    }
    lines.push('  To answer, run this again with --review and every tool to review, and --decline and');
    lines.push('  every tool not to: every tool above, under one of the two. --decline alone reviews');
    lines.push('  every one, and re-enables any declined above.');
  }
  // With an answer, the proposals that answer leaves standing: the list the printed file is built from.
  const proposals = answer === undefined ? r.proposed : proposalsFor(r, answer);
  if (proposals.length > 0) {
    lines.push('');
    // Reviewed already, through the matcher's tool-half branch, as an inferred route.
    lines.push(`  SAME TOOL, different server -- reviewed as an inferred route until tools.json names it (${proposals.length}):`);
    for (const p of proposals) {
      // `oneLine`: names from argv or `tools.json` with a newline would forge the report's blocks.
      lines.push(`    ${oneLine(p.name)}  ->  ${p.route.destination}   (matches ${oneLine(p.matches)})`);
    }
  }
  if (answer !== undefined || proposals.length > 0) {
    lines.push('');
    // Not `register`: a decline needs no settings change, and the tool-half branch already fires
    // for a proposal. `--doctor` checks that.
    lines.push(
      answer === undefined
        ? '  The file below is tools.json as it is now, plus the proposals.'
        : `  The file below is tools.json as it is now, with your answer applied (${answer.length} declined)` +
          `${restatedDropped(r)} and the proposals added.`
    );
    lines.push(`  Write it to ${toolsPath}, then run ${REMEDY.doctor} to check Claude Code's settings:`);
    lines.push('');
    const file = answer === undefined ? proposedToolsJson(proposals, existing) : answeredToolsJson(r, existing, answer);
    for (const line of file.split('\n')) {
      lines.push(`    ${line}`);
    }
  }
  if (r.gated.length === 0 && r.proposed.length === 0 && r.declined.length === 0) {
    lines.push('  NOTHING given matches a tool draftgate routes. Either this session has no');
    lines.push('  outbound connector loaded, or the names were not passed in.');
  }
  if (r.unknown.length > 0) {
    lines.push('');
    lines.push(`  ${r.unknown.length} other MCP tool(s) are not tools draftgate routes, so none is proposed.`);
  }
  lines.push('');
  // What is reviewed comes from the map and the registered matchers, never from these names; saying
  // otherwise would have setup pass every name it has.
  lines.push('  This compares only the names it was GIVEN: a connector not loaded in that session is');
  lines.push('  missing from the lists above, but what is reviewed does not depend on the names given here.');
  return lines.join('\n') + '\n';
}

/**
 * The servers a person did not set up themselves, by the prefix Claude Code gives their tools:
 * claude.ai's connectors and the servers plugins bring. Setup offers only a person's own servers'
 * tools for `--add`: a vendor's connector tool draftgate does not list is not a send it reviews.
 */
export const NOT_OWN_SERVERS: readonly { prefix: string; what: string }[] = [
  { prefix: 'mcp__claude_ai_', what: 'a claude.ai connector' },
  { prefix: 'mcp__plugin_', what: "a plugin's server" },
];

/** The entry `--add` writes for a tool of the person's own: every field it sends shown beside the draft. */
export function ownToolEntry(destination: DestinationName, bodyField: string): Record<string, unknown> {
  return { destination, bodyField, contextFields: ['*'] };
}

/**
 * Why `--add` refuses a tool, or null. Only a tool of a server the person set up, ending in a half
 * draftgate does not route or decline (one that does is reviewed, or declined, already), with no
 * `tools.json` entry yet, to a destination draftgate has. The loader checks the rest when it is
 * written.
 */
export function ownToolRefusal(
  name: string,
  destination: string,
  bodyField: string,
  tools: Pick<ToolConfig, 'map' | 'declined' | 'declinedRoutes'>,
  existing: Record<string, unknown>
): string | null {
  const shown = `"${oneLine(name)}"`;
  const half = toolHalfOf(name);
  if (half === null) return `${shown} is not an MCP tool name (mcp__<server>__<tool>).`;
  const server = NOT_OWN_SERVERS.find((s) => name.startsWith(s.prefix));
  if (server !== undefined) {
    return `${shown} is a tool of ${server.what}, not of a server you set up, so it is not offered.`;
  }
  // Every declined half, a decline no route uses included: an entry for one is dormant at once.
  if (tools.declined.includes(half)) {
    return `${shown} ends in ${oneLine(half)}, which tools.json declines: setup's choice turns it back on.`;
  }
  if (knownHalves(tools).includes(half)) {
    return `${shown} ends in ${oneLine(half)}, a tool draftgate routes already: setup's choice covers it.`;
  }
  if (Object.hasOwn(existing, name)) return `${shown} has a tools.json entry already.`;
  if (!isKnownDestination(destination)) {
    return `"${oneLine(destination)}" is not a destination. Name one of: ${Object.keys(profiles).join(', ')}.`;
  }
  if (bodyField.trim() === '') return 'the field the message is in is empty. Name the input field that holds it.';
  return null;
}
