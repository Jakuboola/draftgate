---
paths:
  - "cli/src/main.ts"
  - "cli/src/review.ts"
  - "cli/src/types.ts"
  - "cli/src/surfaces/**"
  - "cli/src/stdout.ts"
  - "cli/src/audit.ts"
  - "cli/src/digest.ts"
  - "cli/src/decisionFile.ts"
  - "cli/src/routeFacts.ts"
  - "cli/src/reviewPlan.ts"
  - "cli/src/reviewConfig.ts"
  - "cli/src/themePreference.ts"
  - "cli/src/child.ts"
  - "cli/test/{cli,review,regressions,audit,pruneAudit,digest,decisionFile,reviewPlan,reviewConfig,themePreference,surfaceBundle,windowSurface,webkitSurface}.test.ts"
  - "adapters/hook/src/main.ts"
  - "adapters/hook/src/decide.ts"
  - "adapters/hook/test/hook.test.ts"
  - "test/stdoutWrites.test.ts"
  - "surface/rendererBridge.cjs"
  - "surface/contract.json"
  - "surface/src/useReview.ts"
  - "surface/harness/decisionFields.test.ts"
  - "surface/window.test.tsx"
---

# The wire, the decision, stdout and the review log

## The wire protocol (`cli/src/surfaces/windowProtocol.ts`)

- Serialisable data only, versioned by `PROTOCOL_VERSION`. **Never write a protocol literal in a
  test**; use `PROTOCOL_VERSION`.
- A stale window is caught by the bundle, not by the number: the host and the CLI both read
  `surface/contract.json` at runtime, so their versions always agree. The bundle's copy, resolved at
  build time, is what `useReview.ts` compares. That catches a wire change only; a converter change
  is caught by the build stamp (`bundleStamp.ts`), which hashes every input the build read. A failed
  rebuild never spawns the old bundle.
- `HumanDecision.fields` is one map keyed by PATH. The window reports every shown field;
  a value for a field nobody showed is dropped. An approval with no `fields` is a stale build. The
  wire keeps `fields` optional on purpose: were it required, a stale renderer's decision would parse
  as `null` (`surface/unavailable`) instead of reaching the stale-build denial that names
  `bun run build:surface`.
- **A new decision field crosses two allow-lists**: `sanitiseDecision`
  (`surface/rendererBridge.cjs`) and `parseWireDecision`. They cannot share code;
  `surface/harness/decisionFields.test.ts` puts one table through both and fails if they disagree,
  including a field missing from both.

## Route facts and the review plan

- `ReviewSurface` is an interface, so the gate is testable with no window; the hook is the only
  adapter. A surface nothing uses is deleted, not deprecated.
- `RouteFacts` (`cli/src/routeFacts.ts`) is the one type every layer embeds. `bodyField` is the one
  markdown field and may be a dotted path; a wildcard is refused there and in `proseFields`. Every
  default route's `contextFields` ends with `*`: an operator list is unioned with the
  default's, and a key the wildcard cannot address is refused (`context/unaddressable`), never
  dropped. `bodyOptional` is deliberately not a route fact. `review --help` is hand-written; a test
  asserts it names every route flag (`ROUTE_FLAG_NAMES`).
- `reviewPlan.ts` puts line fields first and the window walks the list: the order is data.
- `~/.draftgate/config.json`'s knobs degrade independently (`reviewConfig.ts`); a `releaseCheck`
  value it cannot read turns the check off, never on.
- The reviewer's theme is its own file (`themePreference.ts`, 0600), read by the window surface and
  never the gate; a choice made in a window that was then closed is not kept.

## Stdout and stderr

- The stdout contract inverts. For the CLI, stdout is the approved payload and every human byte goes
  to stderr. For the hook, stdout is the decision JSON and nothing else, so the adapter reads the
  CLI's `--decision` file and does not pipe its stdout.
- **Every stdout write in both entry points is `writeStdout` (`cli/src/stdout.ts`), awaited before
  `process.exit`**, crash path included; `test/stdoutWrites.test.ts` enforces it. Test it
  through a kernel pipe whose reader starts late; `spawnSync` drains as the child writes.
- **Never recover a decision by parsing another process's stderr.** `--decision` carries approval
  and denial; stderr formatting is not a contract.
- Detection belongs to the CLI, policy to the adapter: the CLI reports `body/missing-field` as a
  denial code and the adapter keys its policy on it.

## `updatedInput`

- **Always COMPLETE**: Claude Code replaces the tool input wholesale and validates it against the
  full schema first, so a partial object gets the call denied.
- Extra keys survive (unrecognised keys are filtered from the failure set and `z.data` is never
  read). That is what carries `contentFormat: "adf"` to Jira; if it changes, Jira renders the ADF
  JSON as literal text.

## Timeouts and children

- A timeout's kill is SIGKILL, complete before the callback returns: no escalation ladder, no
  grace. `runReview` races the surface and `main.ts` exits once an outcome exists.
- `runChild` (`cli/src/child.ts`) settles when the timer fires, not at `close`; `group` kills the
  process group.

## The review log (`cli/src/audit.ts`)

- `AuditRecord.code` is the denial code, never the `reason` (prose carrying payload values), and is
  absent on approvals, rejections, timeouts and older rows.
- An absent field and an empty one differ (root): `fixes` and `edited` on this path are
  three-state (`round-trip.md`).
- A classification answer names its destination, and `review.ts` drops one about another
  (`audience.md`).
- A reviewed patch has no `before`/`after`: its row is `patch`, every edit with its own `before`
  and, where a person changed it, `after` (`round-trip.md`). `MAX_DECISION_FIELDS` clears the
  largest patch plus the longest default route's lines; `cli/test/reviewPlan.test.ts` holds it.
- Retention (`pruneAudit`) runs on a review's write, on `digest` and on `--doctor`, and at no other
  time. When a cheap guard makes the expensive path rare, test the guard: `headTs` is exported and
  asserted directly, because `pruneAudit` returns `null` either way.
- `digest` prints no judgement: counts only, so its output stays evidence.
