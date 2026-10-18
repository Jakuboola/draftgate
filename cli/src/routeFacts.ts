/**
 * What a route knows about one tool's payload, and how those facts reach a review. They live on this
 * side because `adapters/` imports `cli/`, never the reverse. `ToolRoute`, `HookReviewRequest`,
 * `ReviewOptions` and `ParsedArgs` all extend `RouteFacts`, since an optional field omitted from one
 * copy is no type error.
 *
 * `ROUTE_FACTS` (`adapters/hook/src/toolMap.ts`) governs inference and `--propose-tools`; this module
 * governs the hop from route to review. By hand that hop is eight sites per field, all optional. A
 * missed one means the window never shows the tool's title and it goes out unseen under an approval;
 * the field is missing from the plan, so `staleSurfaceDenial` cannot notice.
 *
 * `bodyOptional` is not here: it is a fail-open the adapter applies before any review, so the CLI
 * is never told, and its correct encoding would be "no flag".
 */

// The same path grammar `toolMap.ts` and `args.ts` import.
import { parseBodyPath, BodyPathError } from './payload';

/**
 * The facts about a tool's payload that travel from a route into a review. Each is optional, and
 * absent means the destination profile's answer stands, so `ROUTE_FLAGS` keeps them threaded.
 */
export interface RouteFacts {
  /**
   * The field this tool's prose travels in, when it is not the profile's `bodyField`. Linear alone
   * spells it three ways: `body` (`save_comment`, `save_status_update`, `save_diff_comment`),
   * `description` (`save_issue`, `save_project`, `save_initiative`) and `content` (`save_document`,
   * `save_release_note`). Without it, gating `save_issue` finds `description` as drift
   * (`body/missing-field`), an operator route asks, and no draft is ever shown.
   *
   * Such a route stays `schemaOwner: 'operator'` and keeps asking on a missing body. A dotted path,
   * because `editJiraIssue`'s prose sits in `fields.description`.
   */
  bodyField?: string;
  /**
   * Routing fields to show beside this tool's draft, added to the profile's list (a union, see
   * `contextFieldsFor`). Linear's list is `save_comment`-shaped: `save_status_update` keeps only `id`
   * of `project` / `initiative` / `type` / `health` / `id`, `save_customer_need` keeps nothing, and
   * `extractContext` drops the rest silently.
   */
  contextFields?: readonly string[];
  /**
   * The other prose this call carries: fields the agent wrote that are not the body. The default map
   * declares `createJiraIssue.summary`, `editJiraIssue.fields.summary`,
   * `save_issue.title`, `save_project.name`, GitHub's PR and issue `title`.
   *
   * Plain lines, not markdown (a Jira `summary` and a Linear `title` are plain strings): no
   * `render()`, warnings, `lostInMarkdown` or repairs, shown in a single-line input and sent as typed.
   * Prose only; structured fields (`status`, `assignee`) stay read-only in `contextFields`. Paths, like
   * `bodyField`, and never the body (`proseFieldsComplaint`).
   */
  proseFields?: readonly string[];
  /**
   * The body is plain text, not markdown. Linear's `Release.description` and `Release.name` are plain
   * `String` columns, where `Issue.description` has `descriptionState` and `Comment.body` has
   * `bodyData`; a round trip shows the MCP layer parses markdown for the rich ones (`_em_` comes back
   * `*em*`) and not for these. Without this a reviewer gets a toolbar over a field that sends
   * `**word**` literally.
   *
   * `renderPlain` instead of `render`: no conversion, toolbar, warnings, repairs, mentions, media or
   * `extraToolInput`. The body stays editable.
   */
  bodyFormat?: 'markdown' | 'plain';
}

/** A route flag's value was unusable. Rewrapped as `ArgError` by the parser that owns that type. */
export class RouteFlagError extends Error {}

/**
 * How one route fact is spelled on the CLI.
 *
 *  - `path`      one value, an addressable field path. Passed only when the route overrides.
 *  - `path-list` the same, repeated once per name rather than delimited, so no escape rule is
 *                needed. An empty list cannot be expressed (no flags reads as absent), which is why
 *                `parseRoute` refuses one.
 *  - `choice`    one value out of a fixed set, passed only when it is not the `unchanged` one.
 */
type RouteFlagSpec<T = string> =
  | { flag: string; kind: 'path' }
  | { flag: string; kind: 'path-list' }
  | {
      flag: string;
      kind: 'choice';
      // Tied to the field's own type. Which value the far end assumes when the flag is absent no type
      // can say; `cli/test/review.test.ts` asserts it.
      values: readonly Extract<T, string>[];
      unchanged: Extract<T, string>;
    };

/**
 * Every route fact's wire encoding, once: `cliArgs` (`adapters/hook/src/main.ts`) writes it and
 * `parseArgs` (`cli/src/args.ts`) reads it. A fact the writer forgets is one the review never hears.
 * Keyed by `keyof RouteFacts` with no `Partial`, so a fifth fact is a compile error until encoded.
 * `review --help` stays hand-written.
 */
export const ROUTE_FLAGS: {
  [K in keyof Required<RouteFacts>]: RouteFlagSpec<Required<RouteFacts>[K]>;
} = {
  bodyField: { flag: '--body-field', kind: 'path' },
  contextFields: { flag: '--context-field', kind: 'path-list' },
  proseFields: { flag: '--prose-field', kind: 'path-list' },
  bodyFormat: {
    flag: '--body-format',
    kind: 'choice',
    values: ['markdown', 'plain'],
    unchanged: 'markdown',
  },
};

/** The flag names, for a parser that has to know which flags belong to `review`. */
export const ROUTE_FLAG_NAMES: readonly string[] = Object.values(ROUTE_FLAGS).map((s) => s.flag);

const BY_FLAG = new Map<string, { field: keyof RouteFacts; spec: RouteFlagSpec }>(
  Object.entries(ROUTE_FLAGS).map(([field, spec]) => [
    spec.flag,
    { field: field as keyof RouteFacts, spec },
  ])
);

/**
 * The facts a source object claims: not an absent one, and not a `choice` at its `unchanged` value,
 * so a route restating a default looks like one that does not. Every hop spreads this onward
 * (`decide.ts`, `main.ts`, `parseRoute`), so a fifth fact joins them all.
 */
export function claimedRouteFacts(source: RouteFacts): RouteFacts {
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(ROUTE_FLAGS) as [keyof RouteFacts, RouteFlagSpec][]) {
    const value = source[field];
    if (value === undefined) continue;
    if (spec.kind === 'choice' && value === spec.unchanged) continue;
    out[field] = value;
  }
  return out as RouteFacts;
}

/**
 * The route facts, as CLI arguments: the writer of the format `applyRouteFlag` reads. A `choice` at
 * its `unchanged` value comes back absent, the same claim downstream; the sweep in
 * `adapters/hook/test/hook.test.ts` asserts that, not argv equality.
 */
export function routeFlagArgs(facts: RouteFacts): string[] {
  const out: string[] = [];
  for (const [field, value] of Object.entries(claimedRouteFacts(facts))) {
    const spec = ROUTE_FLAGS[field as keyof RouteFacts];
    if (spec.kind === 'path-list') for (const name of value as readonly string[]) out.push(spec.flag, name);
    else out.push(spec.flag, value as string);
  }
  return out;
}

/**
 * Read one occurrence of a route flag into `out`: the reader of `routeFlagArgs`' format. An unusable
 * value is refused, since treating it as absent would review the profile's field instead of the one
 * named.
 */
export function applyRouteFlag(out: RouteFacts, flag: string, value: string): void {
  const found = BY_FLAG.get(flag);
  if (found === undefined) throw new RouteFlagError(`${flag} is not a route flag`);
  const { field, spec } = found;
  // The switch is on kind, so no expression here knows which field it writes; hence one widened view.
  const bag = out as Record<string, unknown>;
  switch (spec.kind) {
    case 'path':
      bag[field] = fieldName(flag, value);
      break;
    case 'path-list':
      // Replaced, not pushed into, so `RouteFacts`' lists stay `readonly`.
      bag[field] = [...((bag[field] as readonly string[]) ?? []), fieldName(flag, value)];
      break;
    case 'choice': {
      if (!spec.values.includes(value)) {
        // Refused, not defaulted: an unknown value read as `unchanged` gives a plain field a toolbar.
        const legal = spec.values.map((v) => `"${v}"`).join(' or ');
        throw new RouteFlagError(`${flag} must be ${legal}, got "${value}"`);
      }
      bag[field] = value;
      break;
    }
  }
}

/**
 * A value that must be an addressable field path, by `parseBodyPath`, the grammar `tools.json` uses.
 * Without it `--body-field a..b` parses clean and throws out of `extractBody`, where the denial names
 * no flag. The trim check is needed because `parseBodyPath` refuses `''` but not `'  '`.
 */
function fieldName(flag: string, value: string): string {
  if (value.trim() === '') throw new RouteFlagError(`${flag} needs a field name, not an empty one`);
  try {
    parseBodyPath(value);
  } catch (e) {
    if (!(e instanceof BodyPathError)) throw e;
    throw new RouteFlagError(`${flag} needs a field name. ${e.message}`);
  }
  return value;
}
