---
paths:
  - "adapters/hook/**"
  - "plugin/**"
  - "docs/gating-your-own-sends.md"
---

# The hook adapter: which sends are gated, and what it answers

Claude Code's `PreToolUse` adapter, wrapping the CLI as a subprocess.

## The tool map and the matcher

- `toolMap.ts` is the source of truth for which tools are gated. **Every `matcher` is generated from
  a map (`matcherFor`) and anchored, never hand-written**: `slack_send_message` is a prefix of
  `slack_send_message_draft`. `--register` from a checkout writes nothing: draftgate installs as the
  plugin, and a checkout's entry beside it would be a second hook.
- The default map is `DEFAULT_TOOL_MAP`. An installation gates those tools plus its own
  `tools.json` entries, less what it declines; `--doctor` prints the count.
- An edit to `tools.json` that adds or removes a tool the plugin's matcher cannot see means running
  `/draftgate:setup` again: the extra-tools entry's matcher is generated from the map. Removing one
  is the sharp case: the old matcher keeps firing and an unmapped tool is denied, with
  `/draftgate:setup` as its remedy. `null` removes the entry, but a remaining entry sharing its tool
  half still routes it, as `inferred`. An added tool cannot be caught in time: it is never routed
  here.
- To not gate a tool, decline it: `tools.json`'s top-level `"declined"` lists tool halves.
  `mergeToolConfig` removes every entry using one; an operator entry for a declined half stays
  dormant and is named by `--doctor`.
- The matcher has two branches, and the second infers: exact names, plus
  `mcp__<server>__(?:<every tool half the map routes>)`, so a server nobody named is still reviewed.
  An inferred route carries `schemaOwner: 'inferred'`, can never take the fail-open below, and the
  window says `destination inferred`. A name neither branch reaches is denied.
- The plugin's matcher is the default map's: `plugin/hooks/hooks.json` ships to every machine, so it
  is generated from `DEFAULT_TOOL_MAP` alone (`--print-plugin-hooks`), never the merged map. An
  alias of a known half under any server is matched by the inferred branch; a `tools.json` tool with
  a new half is not, and `--doctor` names it. `plugin/bin/draftgate` is generated too
  (`--print-plugin-launcher`); `pluginHooks.test.ts` fails when either committed file differs.
- Those tools get one settings entry, and only those (`extraToolsBlock`): `--register` run from the
  plugin writes it, and `/draftgate:setup` runs that only after the user says yes. Its matcher is
  their exact names plus their new halves, never a half the plugin infers: two matchers firing for
  one tool are two windows per send. With nothing uncovered, `--register` takes every draftgate
  entry out of the user settings instead. The entry is the plugin wrapper (so bun is found and the
  hook reads both registrations), at the plugin's timeout, with draftgate's plugin link
  (`~/.draftgate/plugin`) as its root, never a version folder, which Claude Code removes after an
  update.
- The plugin's `SessionStart` hook (`PLUGIN_SESSION_SCRIPT`) keeps `~/.draftgate/plugin` on the
  version Claude Code runs, and only refreshes a link `register` made. A missing or dangling link
  asks. An entry naming a version folder is still draftgate's: `--doctor` notes it, and `--write`
  names it for setup to replace. The link is one per machine: with two installs open (a
  `--plugin-dir` tree beside the plugin) the session that started last wins, and `--doctor` from the
  other says so.
- **Never match `^mcp__.*$`**: unmapped would have to mean allow (a typo in `tools.json` would
  send), and it spawns a process per MCP call.
- `--propose-tools` (`reconcile.ts`) works from names the caller supplies, never discovered: an
  alias of a mapped tool becomes a proposal carrying `destination` and every fact `ROUTE_FACTS`
  marks `proposed`, never `bodyOptional`; an outbound-looking tool is reported, not guessed. With
  `--decline ... --write` it writes the answer's `tools.json` itself (the setup skill has only
  `Bash(draftgate *)`) and names the tools no registered matcher covers. `draftgate propose-tools`
  is the same mode.
- Setup types only the names that matter, once. `--known` prints the halves `reconcileTools` can use
  (`knownHalves`); the agent passes only names ending in one, since the rest change no choice,
  proposal or file. A run keeps its names in `~/.draftgate/setup-names.json` (0600, `setupNames.ts`)
  for the Claude Code session named by `CLAUDE_CODE_SESSION_ID`; a run in that session with no names
  reads them back (`--write` needs them, and removes them once the answer is written), and never
  replaces them with none. What is reviewed never depends on these names: the matchers come from the
  map.
- A send through `Bash`, `curl` or a script has no tool name and is invisible to the gate; the fix
  is to give it one (`docs/gating-your-own-sends.md`).

## What the hook answers

- When the gate cannot be applied, the answer is `ask`: a missing window, unparseable input, a
  broken `tools.json`, a crash, no decision written, `body/preformatted`, an approved payload that
  cannot be read back (never fall back to the original input), and a hook that cannot start.
- **Exactly four recorded exceptions.**
  1. `allow` for `body/missing-field` on a default-mapped `connector` route: the schema-drift hatch.
     Not for an operator route (a tool whose schema the operator wrote included), a
     `connector-open` route (`editJiraIssue`), a wrong-typed body, or prose in a declared
     `proseFields` field (`plausibleProseField` excludes them).
  2. `allow` for `body/unrecognised` with `outcome: 'unavailable'` on a `bodyOptional` route: the
     call carries no message. It applies on any route but an inferred one, operator routes included,
     which is why `bodyOptional` is refused unless literally `true`. Both hatches are the
     `FAIL_OPEN` table in `toolMap.ts`.
  3. `deny` for a tool the map does not know: someone asked for it to be reviewed.
  4. No decision (empty stdout, the normal permission flow) for a tool whose half is declined,
     reached only through a stale matcher. Not `allow`, and not logged.
- `body/unrecognised` therefore means "probably misrouted, ask" on an ordinary route and "nothing to
  review, allow" on a `bodyOptional` one. A code never says whether a human objected: key on
  `outcome` too.
- Who reads each field of an answer is measured, per decision, in `hookOutput.ts`'s table. On an
  `ask`, the reason's first line is the whole message for the
  person (what was not reviewed, what approving does), and `additionalContext` says what already
  happened: never the CLI's `guidance`, which is written for a message that was not sent and would
  invite a duplicate. Every `ask` goes through `decide.ts`'s `ask`.
- Who reads an `allow`: every `allow` carries `additionalContext`, the
  agent's only word of the review: a person approved it as written; a person edited it, with each
  line they changed and the body if they changed it (the decision file's `sentLines` and
  `sentBody`), cut to Claude Code's cap (`CONTEXT_MAX_CHARS`, `CONTEXT_MAX_LINES`) and saying so; a
  machine surface approved it and nobody read it; or nobody reviewed it (the two hatches above). It
  says what happened, never what to send next, and never that a person read what nobody did.
- A delta is read before the body (`DestinationProfile.deltaFields`, `extractPatch`). One the
  profile's grammar accounts for, every key of every operation, is reviewed edit by edit
  (`round-trip.md`); anything else still asks (`body/patch-unreadable`, naming what could not be
  shown), even on a `bodyOptional` route such as Linear `save_issue`, and so does a patch beside a
  body. Do not concatenate the ops into a draft.

## Timeouts and registration

- **Claude Code's per-hook `timeout` is fail-open, not a backstop**: it falls through with the
  agent's original input and draws nothing. draftgate's own timer must fire first, so the review
  gets `min(configured, registered - grace)` (`reviewTimeout.ts`), read on every review, and every
  registration carries a `timeout`, a review deadline plus a grace (`hookTimeoutSecondsFor`).
- A registration it cannot find caps the review at `UNREGISTERED_CEILING_MS` (the event default less
  its grace), never at `DEFAULT_TIMEOUT_MS`.
- A hook that cannot start is the same fail-open, closed by the registration's own `/bin/sh` wrapper
  (`hookCommand.ts`), which answers `ask`; stdout is replayed only on exit 0. Hook commands run
  under `/bin/sh -c`, not `$SHELL`. A bare-shape registration is a `--doctor` note.
- The plugin's wrapper (`PLUGIN_FAIL_CLOSED_SCRIPT`) is the same script behind a search: it takes
  the root Claude Code substitutes for `${CLAUDE_PLUGIN_ROOT}`, finds bun (`FIND_BUN`) and hands
  both to `FAIL_CLOSED_SCRIPT`, so the plugin hook asks for a missing hook, no bun, or no decision.
  One fail-open no wrapper closes: when the plugin's whole version folder is gone, Claude Code skips
  the hook before starting it and the tool runs.
- A plugin's `timeout` is a ceiling: `PLUGIN_REVIEW_CEILING_MS` plus the grace, fixed in the shipped
  file, and a longer `reviewSeconds` is clamped to it like any registration; the clamp's note and
  `--doctor` both say to ask for less, since nothing can lengthen it. It is read back from the
  plugin root (`pluginRootOf`: `CLAUDE_PLUGIN_ROOT`, or `DRAFTGATE_PLUGIN_ROOT`, which the plugin
  wrapper and `bin/draftgate` export), which counts only when its hook is this very file.
- What the fall-through lands in is not a prompt: in `auto` mode a send the user asked for clears
  the "External System Writes" soft block.
- The runtime tells a hook nothing about its own registration, so `registration.ts` reads it back
  out of the settings files, and out of the plugin's `hooks/hooks.json` when it runs from a plugin.
  An entry naming this file in another checkout of the repo (a worktree) is ours. `settingsSources`
  lists each file once by its `path.resolve` form, lexically, as Claude Code does: one file through
  a symlink is two.
- Duplicate registrations both fire, concurrently, and a `deny` from either decides (measured): two
  windows for one send. Two entries are a duplicate only when they fire for one tool (`firesTwice`):
  the plugin's and its extra-tools entry are not. The clamp takes the shortest registered timeout.
  Settings are hot-reloaded, unless a `ConfigChange` hook blocks it.
- Matcher drift can only be reported, never prevented: a tool no matcher covers never reaches this
  code. `--doctor` and a one-line note on the next review are all there is; do not call it
  protection.
- A `deny` rule outranks `PreToolUse`, and `~/.claude/settings.json` has two deny lists
  (`permissions.deny` and top-level `denyTools`). `--doctor` reads both in every settings file.
  Removing a `deny` only helps if the matcher then fires. The split is per agent.
- The one line a review may spend on a `--doctor` subject is prepended to `systemMessage`, which
  Claude Code trims from the end. On an `ask` it goes into the reason instead, under the headline.
- `--doctor` exits 1 on a misconfiguration only. Audience facts (an unprobed gated Jira tool, no
  classified project) are reported without touching the exit code.

## `--doctor` on a plugin install

- The plugin's `hooks.json` is there whether or not Claude Code loads it, so `--doctor` asks Claude
  Code's own record (`cli/src/claudePlugin.ts`): an install in `installed_plugins.json` that applies
  here, and `enabledPlugins` across the settings files (local over project over user, managed over
  all; only `true` enables; measured with `claude plugin list --json`). Not installed, switched off,
  two draftgate plugins enabled, or a record it cannot read: each a problem. A directory
  marketplace's plugin runs in place, not from its `installPath`.
- Any other draftgate entry in the settings fires beside the plugin's hook: a checkout's is a
  problem (two windows per send), and `/draftgate:setup` replaces it (`--write` names it, the skill
  asks, `register` rewrites). From a checkout, an enabled plugin beside its own entry is the same
  problem, seen from the other side.
- From the plugin, every remedy that rewrites the registration is `/draftgate:setup`, never
  `draftgate register`; the plugin's matcher cannot be narrowed, and its timeout is fixed.
- Hook switches: `strictPluginOnlyCustomization` leaves a plugin's hook running,
  `allowManagedHooksOnly` stops it unless managed settings force the plugin on, `disableAllHooks`
  stops it (the settings reference and the hooks page; `disableAllHooks` measured).
- The window's bundle is reported too (`bundleState`): one no toolchain can rebuild makes every
  review ask, and from a plugin the fix is installing the plugin again.
- `--doctor --setup` (`draftgate doctor --setup`) is how `/draftgate:setup` ends: with no problem it
  prints setup's closing (`setupClosing.ts`) in place of the report, and the skill shows it as
  printed. Its counts and names come from the merged map, `tools.json`'s declines and the tools the
  extra-tools entry covers, never from the agent. With a problem it prints the report and exits 1,
  so setup never says it is done when the doctor would not. Under `--setup` an entry for the
  operator's own tools that does not follow the plugin is a problem, not a note: the closing would
  call those tools reviewed while every send through them asks, or after the next update.
