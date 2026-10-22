# draftgate

A destination-aware review gate for agent-generated outbound messages (Jira, Slack, Linear, GitHub).
It pauses a send, shows the draft as its destination will render it, lets a human edit, then approves.

## How this file is organised

- This file: what every session needs. `.claude/rules/*.md` hold the rules for one part of the
  tree; each loads when Claude reads a file matching its `paths:`. Open one directly when the work
  spans it:
  - `styles.md` -- destination stylesheets, fonts, rulers and token extractors
  - `window.md` -- the React window, the host, the harness and its verifiers
  - `round-trip.md` -- editor <-> markdown, what an approval sends, silenced warnings
  - `converter.md` -- `core/`: the converter, ADF, profiles, warnings, the spec checker
  - `audience.md` -- who receives a message, and the classification stores
  - `wire.md` -- the wire protocol, decisions, stdout, timeouts, the review log
  - `hook.md` -- the hook adapter: tool map, matcher, `ask` and its exceptions, timeouts
  - `installer.md` -- `install.sh` and the user commands
- A code comment citing `CLAUDE.md` means this file or one of the rule files.
- Docs voice: plain and direct, present tense, `--` and never em dashes.

## Where work is tracked

- Open work lives in GitHub issues and nowhere else. `gh issue list` is the state; each issue is
  written to stand alone.
- No `TODO.md`, no task list in the README, no "next steps" block in a doc. This overrides any
  instruction to keep a project-level `TODO.md`.
- No development history in any file. A comment or doc says why the code is the way it is now: no
  issue numbers, no dates of what happened, no "used to" or "was reverted". `test/history.test.ts`
  fails on a new hit; `bun run history:report` lists them.

## Safety

- **To try `install.sh`, `claude plugin install`, `register` or `uninstall`, use a scratch `HOME` +
  `CLAUDE_CONFIG_DIR` + `DRAFTGATE_HOME`** (+ `DRAFTGATE_AUDIT_LOG`, a `PATH` you chose; more in
  `installer.md`). Against the real setup they install over the live gate, rewrite its settings
  entry or the log; `uninstall` removes the gate and the log.
- A checkout registers nothing. To run a checkout's code as the gate, `bun run build:plugin`, then
  load the tree it prints (`claude --plugin-dir`, or a local marketplace).
- **To try `release`, use a scratch clone whose origin is a local bare repository.** Against the
  real origin it pushes a `vX.Y.Z` tag that no one can move or delete afterwards, and moves the
  `stable` every install follows.
- **A live probe posts to a real destination.** Probe only targets you own and that reach nobody
  else, list them in `~/.draftgate/scratch.json` so `digest` holds them apart, and delete what you
  posted afterwards unless you keep it on purpose. Jira's REST API can delete a comment and its MCP
  tools cannot; no Slack MCP tool can delete a message.
- **Pass a Jira site explicitly.** One token can reach several sites, and one issue key can name a
  scratch issue on one and a customer's ticket on another.

## Commands

The counts tell a truncated run from a complete one (see "Where facts live" below).

```sh
bun test                    # 4083 tests across 111 files; opens no window.  Every suite is bun:test
                            # (there is no vitest)
bun run typecheck           # three configs: ours; core/ at `types: []` + `lib: ES2022` (a host global
                            # is a compile error); the renderer
bun run spec:baseline       # rewrite the CommonMark ratchet and print each moved row -- READ it
bun run spec:report Links   # both readings of every differing spec example in a section (or `412`)
bun run history:report hook  # every history hit (issue refs, finding IDs, dates...) in an area or path;
                            # no argument: the counts per area
bun run history:baseline hook  # rewrite an area's history baseline from the tree, printing each move
bun run test:update-golden  # regenerate goldens, then READ the diff before committing
bun run build:surface       # build the window's page and its licence notices under surface/.build.lock
                            # and stamp it; a review rebuilds a stale bundle itself
bun run surface:probe       # render the window for real: 61 scenarios, 1474 assertions, ~9s
bun run surface:e2e         # CLI -> real window -> real click -> payload: 22 flows, 164 assertions, ~20s
bun run build:host          # compile the WebKit host into surface/host/build/<hash>/; a review
                            # builds a missing or stale one itself.  Needs the Command Line Tools
bun run surface:host        # the host's own guarantees: 160 checks in 11 sections, ~18s
bun run fonts:lato          # the bundled Lato against Slack's served files, in a harness window
                            # (needs network): the numbers fonts.css cites
bun run icon:build          # surface/icon/draftgate.svg (and -small.svg, 16 and 32 px) -> the committed
                            # draftgate.icns (dev Electron)
bun run measure:blocks      # Jira's values off the editor-core ruler; also measure:headings, :styles,
                            # :linenos, :dark.  Pinned display, comparable on any Mac
bun run measure:renderer    # the Jira READER's values (@atlaskit/renderer, a public site, anonymous;
                            # needs network).  Never point it at a site of your own
bun run measure:github      # GitHub's values off a real rendered comment, cross-checked live
bun run tokens:jira         # regenerate jira.css's palettes from @atlaskit/tokens; also tokens:linear,
                            # tokens:slack (both need network)
bun run jira:projects <site>  # which projects are service desks -> ~/.draftgate/jira-projects.json
                            # (JIRA_EMAIL + JIRA_TOKEN); tools/jira-projects/from-mcp.mjs needs neither
bun run github:repos <owner>  # which repositories are public -> ~/.draftgate/github-repos.json (gh api)
bun run build:plugin        # the plugin tree a release ships, out of this checkout, into
                            # dist/marketplace: for --plugin-dir or a local marketplace.  [--out <dir>]
bun run release             # maintainers, on `main`, at plugin.json's bumped version: build and verify
                            # the window (probe + e2e), tag, commit the window and the plugin tree
                            # onto `stable`; pushes last.  [--notes <file>]
bun cli/src/main.ts review --dest jira --in docs/examples/jira-payload.json [--tool <name>]
                            # a review by hand; an unnamed caller's Jira audience is `unknown`
bun cli/src/main.ts digest --limit 5   # read the review log; scratch targets held apart
                            # (~/.draftgate/scratch.json), --include-scratch to merge
bun adapters/hook/src/main.ts --doctor           # are hooks on; registration vs tool map; exits 1 on
                            # a misconfiguration
bun adapters/hook/src/main.ts --propose-tools <name>...  # reconcile the tool map with real names
bun adapters/hook/src/main.ts --print-plugin-hooks > plugin/hooks/hooks.json   # the plugin's
                            # registration; --print-plugin-launcher > plugin/bin/draftgate likewise
draftgate doctor|digest|uninstall|version|help   # the user commands; /draftgate:setup runs register
                            # and propose-tools.  `draftgate <command> --help`: its options
sh install.sh               # what `curl | sh` runs: the plugin, through `claude plugin`
```

## Verifiers

- **Every script that starts with `build:surface` and then opens a window runs one at a time, never
  concurrently, and never while anything else builds**: `surface:probe`, `surface:e2e`,
  `surface:host`, `fonts:lato`, and `release`, which runs the first two. Each builds into the one
  `surface/dist/`; a build landing while a window loads tears the bundle, and the failure reads as a
  gesture that did not land. The build lock serialises builds, not readers. `build:plugin` builds
  and then copies `surface/dist/`, so it keeps to the same rule (it refuses a copy torn under it).
- Run probe and e2e after touching `surface/`, the wire protocol or `cli/src/review.ts`;
  `surface:host` after touching `surface/host/`, `cli/src/reviewHost.ts` or a `.cjs` the host loads.
- Read the whole log, not its tail. A check prints where it is decided, so one early failure leaves
  every later line `ok` above a bare `1 FAILED.`
- None puts a window on your screen: they drive the harness build of the host, drawn off-screen. A
  real review is the review build and always appears (`window.md`).

## Map

One line per area; each module's header comment says why it is shaped the way it is.

```
.claude-plugin/  the marketplace manifest: the plugin, fetched from `stable`'s `plugin/`
install.sh     what `curl | sh` runs: CLT, Claude Code, bun, then `claude plugin` installs the plugin
core/          render(body, destination) -> { converted, warnings }.  PURE: no I/O, clock, network
               or `node:` import -- it runs in the browser renderer too
  src/adf/     draftgate's ADF <-> Markdown converter (origin in PROVENANCE.md)
  src/adfSchema.ts  the one source of ADF structure, for the fixer and the checker alike
  src/profiles/  one per destination, `satisfies DestinationProfile`: every destination fact
  test/spec/   the spec checker: the converter vs micromark + GFM, a ratchet that may only shrink
cli/           orchestration and I/O: the review, the window surface, the wire, the review log, the
               commands (uninstall, register, doctor), the stores in ~/.draftgate/,
               and the maintainers' `release`
adapters/hook/ the Claude Code PreToolUse adapter, the only adapter; wraps the CLI as a subprocess
plugin/        the Claude Code plugin's own files (manifest, generated hooks.json and bin/draftgate,
               the /draftgate:setup skill); a release puts the runtime beside them
surface/       the review window: React + one TipTap editor + the destination stylesheets
  host/        the window's native host on the system WebKit (Objective-C, macOS 26+)
  harness/     everything that verifies or measures the window in its own engine, and nothing it
               ships
test/          repo-wide invariants (temp dirs, NUL bytes, stdout writes, import graph, ruler display,
               no em dash in window text, no development history in any file: a per-area baseline
               that may only shrink)
tools/         dev instruments, not shipped: rulers, token extractors, the dev Electron, the icon,
               the README's demo video (Remotion, its own install); the project/repo classifiers
               do ship, in the plugin tree (`CLASSIFIERS_IN_REPO`)
docs/          gating-your-own-sends.md (make a script's send reviewable), torture-fixture.md (the
               corpus every converter claim is checked against), NOTICE (third-party credits, which
               the built window's THIRD_PARTY_NOTICES opens with), demo.gif (the README's demo)
  examples/    sample Jira, Slack and GitHub payloads, for a review by hand
```

## Rules that apply everywhere

The rule files apply these to their part of the tree.

The gate:
- `core` is pure ("Map"); `core/tsconfig.json` and `core/test/purity.test.ts` hold it.
- **When the gate cannot be applied, the answer is `ask`**, with the recorded exceptions in
  `hook.md`. `allow` sends what nobody saw; `deny` claims a person objected.
- An approval sends the body the reviewer was shown, and the window never changes a message
  invisibly (`round-trip.md`).
- **`updatedInput` is always COMPLETE**: Claude Code replaces the tool input wholesale (`wire.md`).
- The stdout contract: the CLI's stdout is the approved payload, the hook's is the decision JSON,
  every human byte goes to stderr, and every stdout write is an awaited `writeStdout` (`wire.md`).
- **No review auto-approves unless a live test harness asked for it, or the CLI's own caller passed
  `--surface auto-approve`** (a flag for tests). The hook never passes it on its own: its
  auto-approving surface and the host's harness build (which can click Approve) open only for a live
  nonce (`cli/src/harnessNonce.ts`), so no leftover variable can open either. Prefer removing a test
  capability to gating it.

Evidence:
- A value with no cited source is a guess. If a declaration cannot name where its number came from
  (a probe, a ruler, the vendor's own file), treat it as unmeasured. A CSS value names its source
  (`styles.md`).
- Measure the surface the reader sees, not a stand-in for it. Never derive destination behaviour
  from a read-back API (`slack_read_channel` flattens Block Kit); Jira's `expand=renderedBody`
  re-parses through a legacy wiki path. Verify against the rendered surface or an unambiguous HTTP
  status. A vendor's CSS rule, a `font-family` and a constraint true of ADF are stand-ins too
  (`styles.md`, `converter.md`).
- Probe a destination claim, and more than once before you generalise. If a probe contradicts the
  docs, trust the probe and correct the docs.

Tests and guards:
- Assert the value a mechanism produces, never the value you handed it, at the boundary where the
  consequence is visible: the payload for a payload field, pixels for layout. Counting an element is
  not proving it works.
- A guard must be able to fail. Its test builds the input that separates its true case from its
  false one; an absence is asserted against the thing that lacks it; a cheap guard is tested
  directly, not through the outcome it makes rare. When you remove a capability, find every check
  that depended on it: it may now pass vacuously.
- When you mutation-check a guard, break the consumer, not only the producer.
- A test double more forgiving than reality hides the bug. Prefer a real subprocess for anything
  I/O-shaped. A fixture tidier than production cannot see production's bug.

Where facts live:
- One fact, one place. Two hand-kept copies drift, and the drift fails silently. A fixer and its
  checker, or a scanner and the converter, read one source: ADF structure lives only in
  `core/src/adfSchema.ts`, the matcher is generated from `toolMap.ts`, commands in messages live in
  `core/src/remedies.ts`, warning codes in `core/src/warnings.ts`. A doc names the constant; it does
  not copy its value.
- Destination behaviour belongs in a profile: never in the window (no `destination === ...` in JSX)
  and never in a route the operator declares. Target facts (which project is a service desk) come
  from operator config.
- An absent field and an empty one are different facts. No `?? []` on a path that feeds the log.
- Hand-kept counts go stale. When you change what one counts, correct it where it is written: the
  verifier counts in "Commands", the recorded exceptions in `hook.md`.

## Environment

- `bun` 1.4.0 or newer in a checkout, the first that reads `bun.lock`; `gh` authed with `repo` scope
  for `github:repos`; `npm` only to install the Jira ruler (`tools/jira-ruler/README.md`) and
  `tools/atlassian-tokens` for `tokens:jira`.
- The review window is draftgate's own host on the system WebKit: macOS 26 and newer, compiled with
  the Command Line Tools' `clang`.
- `electron` 44.3.0 is a dev tool (rulers, icon) in `tools/electron/`, installed there on first use,
  on no review's path and not in the root install.
