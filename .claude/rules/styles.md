---
paths:
  - "surface/src/styles/**"
  - "surface/src/main.tsx"
  - "surface/harness/{probe,fontFile,vendorCss,shared,wkSession,lato}.ts"
  - "surface/harness/injected.cjs"
  - "surface/harness/{tokens,fontAssets}.test.ts"
  - "test/rulerDisplay.test.ts"
  - "cli/test/icon.test.ts"
  - "tools/*-ruler/**"
  - "tools/*-tokens/**"
  - "tools/electron/**"
  - "tools/icon/**"
  - "surface/icon/**"
---

# Destination stylesheets, fonts, and the instruments that measure them

## Every value names its source

- **A declaration that cannot say where its number came from is unmeasured**, however well sourced
  the values around it are. Name the source in a comment beside the value.
- The sources, per destination:
  - Jira: `tools/jira-ruler` reads editor-core, the AUTHOR's surface; `probe-renderer.cjs`
    (`measure:renderer`) reads `@atlaskit/renderer`, the READER's. Palettes come from
    `@atlaskit/tokens` (`tokens:jira`).
  - Slack: `tokens:slack`, colour and the message renderer's geometry from `app.slack.com/client`'s
    stylesheets (the tool's header names each).
  - Linear: `tokens:linear`, two sources: colour from linear.app (the
    marketing site), geometry and type from `static.linear.app/client/assets/style-<hash>.css` (the
    issue editor's own, found via `id=app-stylesheet` on the login page). Read the tool's header
    before trusting a value; `previewFidelity` stays `indicative`.
  - GitHub: `tools/github-ruler`, GitHub's own renderer (`POST /markdown`) under github.com's real
    stylesheets, cross-checked against a live page.
- A vendor's values are credited in `docs/NOTICE`, which the built window ships verbatim in
  `THIRD_PARTY_NOTICES`. A new vendor source gets a line there.
- A vendor's declaration is evidence about a selector, not about a surface. One element can carry
  two classes that both style it: a GitHub comment is `comment-body markdown-body`, and
  `.comment-body` (14px) beats `.markdown-body` (16px) on link order. Ask the engine, not the CSS
  you found by name.
- Query the live DOM for the class before trusting a rule you found by name. A Slack mrkdwn
  message renders through `p-header_block` with `flat_scale`, not the composer's
  `p-rich_text_header`. A Linear comment heading is `.heading-node` at 600, not a bare `hN` at
  500.
- A stub is not a measurement, and not a reason to stop. editor-core's stubbed link and media
  providers return browser defaults; the shipped CSS often still holds the answer.

## Ask the instrument that can answer

- A weight: read the DOM (`getComputedStyle`). A screenshot cannot show a weight split at one
  size.
- Which typeface drew: ask the font file or the rasteriser, never `font-family`.
  `surface/harness/fontFile.ts` reads a file's family, version, axes and italic bit; the extractors
  read the vendor's files with it and `tokens.test.ts` ours. `getComputedStyle` reports the weight
  asked for, never the instance drawn.
- On WebKit there is no public rasteriser question: the probe's `wkFacesByWidth` matches text by
  width against each loaded face. It names a family, not an instance, cannot tell faces with equal
  advances apart, and misses a run inside the node drawn in another face.

## Fonts

- **Every numeric weight a sheet names must be covered by a bundled `@font-face`, upright and
  italic.** A missing weight silently serves the nearest face. `tokens.test.ts` asserts it; a face
  is a weight and a style.
- Faces are declared only in `surface/src/styles/fonts.css`, each the vendor's own file: Inter
  variable on Linear's `opsz` + `wght` axes, Lato 2.015 whole for Slack (Lato 2 reserves its name,
  so no subset), and Roboto Mono variable as `Slack-Roboto-Mono`. Jira gets none (Atlassian Sans is
  proprietary); GitHub gets none (a comment draws in the system face).
- `fonts:lato` measures the bundled Lato against Slack's own files in the window's engine:
  advances, kerning, wraps and the slanted upright against the real italic. `fonts.css` cites it.
- The probe proves the right italic drew, not just an italic. On WebKit: the text has the italic's
  own advances (a synthetic slant keeps the upright's widths), and a loaded italic face covers the
  em's weight -- matching prefers style over weight, so with no 400 italic the em draws in the bold
  italic.
- Rasterisation is a property. `-webkit-font-smoothing` is set on Slack's and Linear's `body`
  and on neither Jira's nor GitHub's; the probe pins both halves.

## Stylesheet structure

- **Do not put shared rules in a shared stylesheet.** Destination sheets are scoped
  `[data-destination="x"] .ProseMirror ...`, so a bare `.ProseMirror` rule loses on specificity, not
  on order. Duplicate the declarations and share the guard: `SHARED_STRUCTURE` in
  `surface/harness/probe.ts` lists them, with the chrome every destination shares, and reads them
  back for every destination.
- If you add a rule, assert it for every destination that has it.
- Assert a link's hover as a pair, rest and hover, so a sheet that loses either half fails: Jira
  underlines at rest and drops it on hover, Slack and Linear the opposite, GitHub keeps it in both
  states. Every measured palette is pinned.
- On WebKit `:hover` is forced deterministically by `wkForceHover`, a twin of every `:hover` rule on
  an attribute, because a synthesised mouse move never reaches an inactive app's page.

## Where an assertion goes

- **The probe's job is to disagree with the stylesheet**: it reads computed values back from the
  real engine. A check of what a sheet says belongs in `surface/harness/tokens.test.ts` (no window,
  every destination by construction), including declared state pseudos (`:disabled`,
  `:focus-visible`). A pseudo-element can be read: split the style key on `::`.
- A CSS rule lookup must find every rule that lists the selector, comments stripped, not the rule
  whose selector list ends with it; otherwise "does not declare" guards pass vacuously (root: a
  guard must be able to fail).
- `measured-github.json` is read by `tokens.test.ts` and not by `probe.ts`, which must keep
  disagreeing with the sheet. The Jira ruler's output is committed nowhere and read by nothing: a
  shared source would make the probe assert that the CSS says what the CSS says.
- The token tools commit `tokens.json` as evidence; `tokens.test.ts` fails if a sheet drifts and
  needs no network (its font-file checks need `bun install`).

## Running the instruments

- `tools/electron/` (root, "Environment") installs its pinned Electron on first use, and `run.ts`
  runs every script on `RULER_DISPLAY` at scale 1 with legacy scroll bars;
  `test/rulerDisplay.test.ts` holds it. `bun audit`, there as at the root, is the dependency check.
- `measure:renderer` reads public `hibernate.atlassian.net` issues anonymously (root, "Commands").
- `icon:build` uses Electron because it reproduces the committed `.icns` byte for byte and WebKit's
  canvas does not; `draftgate.icns.json` holds each SVG's hash so an unrebuilt edit fails a test.
  The 16 and 32 px slots come from `draftgate-small.svg`: the full drawing's pause bars blur into
  one block there.

## When a vendor changes how it renders

Re-run the tool a value cites, then read what moved:

| Destination | Run | Writes |
|---|---|---|
| Slack | `tokens:slack` (network) | `tools/slack-tokens/tokens.json`, committed |
| Linear | `tokens:linear` (network) | `tools/linear-tokens/tokens.json`, committed |
| Jira palettes | `tokens:jira` | `tools/atlassian-tokens/tokens.json`, committed |
| Jira, reader | `measure:renderer` (network) | `tools/jira-ruler/measured-renderer.json`, git-ignored |
| Jira, author | `measure:blocks`, `:headings`, `:styles`, `:linenos`, `:dark` | stdout (build the ruler first: `tools/jira-ruler/README.md`) |
| GitHub | `measure:github` (network) | `tools/github-ruler/measured-github.json`, committed |

Then `git diff` a committed file (each changed line is a value the vendor changed), or, for a Jira
ruler, diff against the output you kept from the run before. `tokens.test.ts` and `surface:probe`
fail where a sheet still states the old value (above); correct the value and the source it cites.

The editor-core ruler and `tokens:jira` read the `@atlaskit` versions their lockfiles pin, so a
change Atlassian ships reaches them only when that dependency is updated; `measure:renderer` reads
the live site.
