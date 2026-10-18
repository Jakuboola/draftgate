---
paths:
  - "core/src/audience.ts"
  - "core/src/profiles/**"
  - "core/test/audience.test.ts"
  - "cli/src/jiraProjects.ts"
  - "cli/src/githubRepos.ts"
  - "cli/src/classificationStores.ts"
  - "cli/src/configFiles.ts"
  - "cli/src/scratchTargets.ts"
  - "surface/rendererBridge.cjs"
  - "surface/contract.json"
  - "surface/harness/contract.test.ts"
  - "cli/src/surfaces/windowProtocol.ts"
  - "tools/jira-projects/**"
  - "tools/github-repos/**"
  - "adapters/hook/test/toolAudience.test.ts"
  - "cli/test/{jiraProjects,githubRepos,classificationStores,configFiles,scratchTargets}.test.ts"
---

# Who receives the message

## The audience

- The audience travels beside the draft, on `WireRequest`; the rule lives in the profile and the
  fact comes from operator config. It is not on `RenderResult`: `render()` sees only the body.
- A JSM comment is a public reply or an internal note, and the flag is the `sd.public.comment`
  property the gated tool does not expose. Probed: absent means public; `commentVisibility` is not
  that switch; extra keys on `updatedInput` are dropped by the server; it cannot change
  after creation. An edit reports `unchanged`: it preserves a flag draftgate cannot read.
- An unknown project is asked about once and remembered (`Audience.ask`,
  `AudienceFacts.classified`), and the answer applies immediately: the window re-asks the profile.
- The audience is a claim about a tool, not just a destination. `addWorklogToJiraIssue` gets no
  banner (probe J); a Jira tool nobody has probed gets `unknown` naming itself; an unnamed caller
  (`review` without `--tool`) is `unknown`.
- An internal-note tool is recognised by name, in the profile (`POSTS_INTERNAL_NOTE` in
  `core/src/profiles/jira.ts`), and only on a configured route: an inferred route's server name
  was chosen by its author, so it is `unknown`. Never an operator-declared field on `ToolRoute`:
  someone could assert `internal` for a tool that replies to customers
  (`adapters/hook/test/toolAudience.test.ts`). No default entry is one: a server key is one
  installation's choice, so the operator who runs such a tool declares it in `tools.json`.

## A classification answer names its destination

- An answer is `{ destination, value }`, never a bare value checked by membership of a merged list.
  The bridge checks the shape, `parseWireDecision` checks the value against the vocabulary of the
  profile it names, `review.ts` drops an answer about another destination, and `audienceFor` drops
  a foreign one. All three ask it one way: `ownAnswerFor` (`core/src/profiles/index.ts`).
- `DestinationProfile.reviewerAnswers` is the answer vocabulary, not the config one: Jira's is the
  binary its question puts (`service_desk`, `software`), not `JIRA_PROJECT_TYPES`. Declared by all
  four (`[]` for Slack and Linear) and held equal to `ask.options` by `core/test/audience.test.ts`.
- `surface/contract.json` carries NO vocabulary; `contract.test.ts` asserts the absence.
- **An answer is acted on or the reviewer is told why not.** A click that changes the banner and
  then quietly does nothing is the failure: `remember` (`cli/src/classificationStores.ts`) says what
  it wrote or why it kept another value, silent only when the file already held that answer; only
  the e2e flow, a real click read back from the file, proves the answer lands.

## The stores in `~/.draftgate/`

- Nothing throws and nothing degrades to silence: a missing, broken or partial file yields
  `unknown`, which is a loud banner. Rows are signed (`jira`/`github` or `reviewer`); unmarked
  counts as authoritative.
- **Never key Jira projects by project key alone**: a key is unique only within a site, so the store
  is keyed by cloud ID. GitHub repos are `owner/repo` lowercased.
- A writer refuses what a reader may drop (`configMergeBase` in `cli/src/configFiles.ts`).
- `tools/github-repos` reads `.visibility`, not `.private` (an `internal` repo reports
  `private: true`), and uses `/user/repos` for the authenticated user (`/users/<you>/repos` lists
  public ones only). `tools/jira-projects/from-mcp.mjs`: read its header first.
- Which file a classification belongs in is a table (`cli/src/classificationStores.ts`); Slack and
  Linear have no row: each has one audience.
- What names a scratch target is the profile's `targetIdentity`; a Jira target must declare
  `cloudId` (root, "Safety": one issue key can name different issues on two sites).
