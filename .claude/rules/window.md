---
paths:
  - "surface/src/**"
  - "surface/*.ts"
  - "surface/*.tsx"
  - "surface/*.cjs"
  - "surface/index.html"
  - "surface/vite.config.mts"
  - "surface/host/**"
  - "surface/harness/**"
  - "cli/src/surfaces/{webkit,window}.ts"
  - "cli/src/harnessNonce.ts"
  - "cli/src/reviewHost.ts"
  - "cli/src/buildSurface.ts"
  - "cli/test/{harnessNonce,reviewHost,webkitSurface,windowSurface}.test.ts"
---

# The review window, its host, and the harness that verifies it

## Running the verifiers

- One at a time (`.claude/CLAUDE.md`, "Verifiers"). A torn bundle fails as `the harness drove the
  window (...)`, which reads like a flaky test.
- **No window reaches the screen.** The harness build (`draftgate-harness.app`) switches WebKit's
  occlusion judgement off (SPI, harness only), orders its window far off every screen at near-zero
  opacity (`harness.m`), and has no Dock icon (`LSUIElement`). The review build carries none of that
  and always appears. The CLI spawns the harness build only for a live harness nonce.
- The three verifiers and `fonts:lato` drive the harness build over its FIFO channel
  (`surface/harness/wkSession.ts`, which inherits no `DRAFTGATE_` variable).
- Scripts that run in the renderer are real functions in `surface/harness/injected.cjs`, evaluated
  via `toString()` and never transpiled, so a backtick in a body is a character, not the end of a
  template.
- `surface/harness/` is node-typed and `surface/*.test.ts` and `src/**` are DOM-typed: the directory
  carries the flavour, and every file under `surface/` is covered by exactly one config
  (`tsconfigCoverage.test.ts`).

## What only a live harness can approve

- The harness capability is absent from the review binary, not gated in it. `harness.m` is
  compiled only into the harness build, and `host.test.ts` reads the review binary's selector table
  to prove it holds none of it.
- A probe run cannot approve because it sets no `DRAFTGATE_DECISION` and `launchHost` inherits no
  `DRAFTGATE_` variable; `probe.test.ts` asserts the spawn's env literal and a real spawn.
- A nonce is live only if it is long enough to be one, a file still holds exactly it, and the file
  was written recently (`cli/src/harnessNonce.ts`, the one gate the hook and the CLI ask). The
  harness deletes it when the run ends and `surface:e2e` fails if one survived. Never `.trim()` both
  sides of a comparison: whitespace then matches emptiness.
- Leave nothing that can go stale: `WKSession.channel` empties its directory before every spawn.

## What the window may do

- **It must not fetch anything before the human decides.** A draft's `<img>` is the exfiltration;
  rejecting afterwards is no mitigation. `surface/src/deferredImage.ts` shows the URL and sets `src`
  only on "Load image"; `data:` and `blob:` render at once. The fix is in the renderer, not the CSP.
- Prove the CSP is live by provoking a refusal, since every other CSP check is an absence: a
  trusted `securitypolicyviolation` naming `connect-src`, heard in the harness's own content world.
  `surface:host` forges one both ways a page could and watches both arrive untrusted.
- Destination facts arrive through `RenderResult` (root, "Destination behaviour belongs in a
  profile"): `previewFidelity`, and `suggestedFix` as `Fix = { code, label, body }`.
- The bundle holds no `@atlaskit` package.
- The host restates no rule: it loads `request.cjs`, `rendererBridge.cjs`, `geometry.cjs` and
  `windowTitle.cjs` into JavaScriptCore; never copy one into Objective-C. Its three environment
  variables are pinned by `host.test.ts`.
- The page's `contextmenu` is cancelled in every frame: AppKit adds items after `willOpenMenu:`.
- `-show` makes the web view first responder before ordering the window in, or WebKit focuses the
  page's first control and stray typing reaches the draft. The harness runs `-show` too (minus
  activation): a harness that skips the review's path onto the screen cannot see what happens on it.
- The build credits every package it bundles, or fails: `THIRD_PARTY_NOTICES` in `dist/`,
  derived from what the build read (`cli/src/surfaces/thirdPartyNotices.ts` has the contract). Never
  hand-list a package there.
- A host that is not there is built by the review that needs it, inside the deadline, or the review
  is `unavailable` with the build's reason: never fetched, never an older host. A
  dead WebContent exits 1.

## Approve and every path to it

- **An error boundary must remove the Approve button**, not just the broken part; only the caller
  can unmount the footer.
- And the keyboard path with it: register `⌘↵` only while the shell that names it is mounted.
- **TipTap substitutes an empty document for one it cannot load, silently.** `enableContentCheck:
  true` alone does not stop it; handle `onContentError` and re-throw into `EditorBoundary`.
- A document of registered node names can still be invalid. Load every fixture with
  `errorOnInvalidContent: true`. `image` is inline; a block-position image is wrapped in a
  paragraph.
- `aria-modal` is not a focus trap. `FixDiff` moves focus in and wraps Tab onto the panel, not
  the primary button (applying discards undo). `App.tsx` also closes the dialog when the body its
  preview was computed against changes; that second guard is the one that matters.
- Approve's `disabled` comes from `blocked` (`round-trip.md`); a denial after the click closes the
  window as though it sent.

## Layout and highlighting

- Prose fields are unlabelled, permanently, even on routes with several (Linear `save_project`,
  `save_initiative`): the text in a field identifies it, and an empty one draws its own placeholder
  naming the field (the raw path is also its `placeholder`/`title`/`aria-label`). `"   "` draws no
  placeholder, which is why `prose/empty` uses `isBlankBody`.
- The chrome above the draft never changes height and is never absent. `.dg-status` is always
  present (green "No problems found" when clean), with a fixed `height`, never `min-height`; the
  unfurled list is `position: absolute`; blocked is `data-blocked`; severity is a left rail plus the
  chip. `probe.ts` pins its computed height.
- The full toolbar is pinned: `position: sticky` in `.dg-body`, on the frame's opaque ground.
  The window's stacking order is written once, in `.dg-toolbar`'s comment in `shell.css`. WebKit
  pins a sticky box inside its scroller's padding, so `top` is minus `--dg-body-pad-top`.
  ProseMirror cannot see the toolbar, so `PinnedToolbarClearance` (`Editor.tsx`) keeps the caret
  from scrolling under it. The `*-pinned-toolbar` probe scenarios hold all of it in pixels.
- An outline on an inline leaf draws nothing (a `<br>` has no box). `rangeOfPath` widens an inline
  leaf to the block holding it (`isInline && isLeaf`). Check with `getBoundingClientRect`, not
  presence.
- Point at the right node or at none. `Warning.editorPath` holds child indices into the editor's
  document, resolved by `surface/src/lostHighlight.ts`; test it by asking `nodeAt` what it landed
  on. It is a decoration with an `outline`: no selection (the next keystroke would replace the
  node), no border (it would reflow).
- Two answers to one question read one clock: which warnings are shown and when to wake come out
  of one `settle()` call in `surface/src/settledWarnings.ts`. A blocking warning is never withheld.

## Tests of the window

- `surface/window.test.tsx` is the one test that mounts the React tree (happy-dom). Its subjects
  share one file on purpose: `mock.module` is registry-wide in bun and does not reliably come back.
- `surface/schema.test.ts` validates each destination against `schemaFor(rendersMedia,
  codeSpanMarks)`, not one shared schema that has every node (root: a guard must be able to fail).
- happy-dom appends no `img.ProseMirror-separator`; a real engine does, so the probe does not count
  it.
