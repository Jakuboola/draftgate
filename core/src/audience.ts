/**
 * Who receives the message, as opposed to what it says.
 *
 * For Jira Service Management this is the most consequential fact of a send: a JSM comment is a
 * public reply the reporter sees in the portal, or an internal note they never see. The flag is a
 * comment property (`sd.public.comment`) the gated Rovo tool does not expose, and, probed, its
 * absence means public.
 *
 * Not on `RenderResult`: the audience depends on the payload (which issue) and on operator config
 * (whether that project is a service desk), which pure `render(body, destination)` cannot reach. The
 * CLI assembles it and it travels beside the draft; the destination knowledge (names, meanings,
 * which payload lands where) lives here and in the profiles. See `audience.md`.
 */

/**
 * Which audience a send lands in.
 *
 *  - `public`    the recipient is outside the team. For JSM: the reporter, in the portal.
 *  - `internal`  the message stays with the team. Reached only through a tool the profile
 *                recognises by name as posting an internal note (`POSTS_INTERNAL_NOTE`, Jira).
 *  - `unchanged` this call edits an existing message and keeps its visibility. Probed: an edit
 *                through Rovo preserves the flag, which draftgate cannot read.
 *  - `unknown`   draftgate has no fact for this destination target. "No audience question exists"
 *                is `undefined`, not a value.
 */
export type AudienceKind = 'public' | 'internal' | 'unchanged' | 'unknown';

export interface Audience {
  kind: AudienceKind;
  /** The destination's own name for this audience: `Reply to customer`, the words on JSM's tab. */
  label: string;
  /** One line: what happens on send, or precisely what draftgate does not know. */
  detail: string;
  /**
   * The audience this send cannot reach, in the destination's words (for a JSM public reply,
   * `Add internal note`). Present only where the reviewer would look for an alternative. The surface
   * renders it as text, never a control: probed, the gated tool has no parameter for the audience.
   */
  unavailable?: string;
  /**
   * The question to put to the reviewer, when one would settle this, words included because they
   * are the destination's.
   *
   * `value` stays a plain string so this module imports nothing. It is validated on the way back by
   * `parseWireDecision` (against the profile the answer names) and by `audienceFor`;
   * `surface/rendererBridge.cjs` checks only the shape, since `sanitiseDecision` never sees the
   * destination.
   */
  ask?: {
    question: string;
    options: { label: string; value: string }[];
  };
  // No `askAbout`: nothing would read it, and `ask.question` already names the target.
}

// No `settable` flag: the gated tool has no parameter for the audience (probed), so nothing could
// act on it.

/**
 * What the reviewer answered about the target of a review, and which destination they answered
 * about.
 *
 * The destination is on the answer so no layer tells answers apart by membership of one merged
 * list, which breaks the day two destinations share a value. `parseWireDecision` checks the value
 * against the vocabulary of the destination the answer names; `cli/src/review.ts` refuses an answer
 * about another destination.
 *
 * Bare `TargetAnswer` is what the window builds and `AudienceFacts` carries;
 * `TargetAnswer<DestinationName>` is the wire (`HumanDecision.classifyProject`);
 * `TargetAnswer<'jira', JiraProjectType>` is a profile's, through `AudienceAnswer`. `audienceFor`
 * narrows the widest to the narrowest against the profile's `reviewerAnswers`. The defaults are
 * strings because naming `DestinationName` here is a circular type alias in `tsc`.
 */
export interface TargetAnswer<D extends string = string, V extends string = string> {
  destination: D;
  value: V;
}

/**
 * What a reviewer answered about the target, plus which tool is being gated. Generic over both
 * halves (`AudienceAnswer<'jira', JiraProjectType>`, `AudienceAnswer<'github',
 * GitHubRepoVisibility>`) so this module keeps importing nothing; see `TargetAnswer` for why the
 * destination travels with the answer.
 */
export type AudienceAnswer<D extends string, V extends string> = {
  /**
   * The reviewer's own answer about this target, which outranks any config lookup. A profile reads
   * `classified?.value` with no guard of its own: `audienceFor` makes the narrow type true at
   * runtime.
   */
  classified?: TargetAnswer<D, V>;
  /**
   * The tool being gated, when the caller knows it. Jira's comment probes ran against
   * `addCommentToJiraIssue`, and `addWorklogToJiraIssue` routes to the same profile: without the
   * name, a worklog on a service-desk project would claim "Reply to customer", and probed, every
   * clause of that is false for a worklog.
   */
  toolName?: string;
  /**
   * `toolName` reached this review through an inferred route: no tool-map entry names it, and the
   * matcher routed it because its tool half matches an entry under another server. Only a claim that
   * reassures (Jira's internal note, "the reporter never sees this") reads it. Absent means a
   * configured route or a caller that named the tool itself (`--tool`).
   */
  routeInferred?: boolean;
};
