---
paths:
  - "core/**"
  - "cli/test/remedies.test.ts"
---

# `core/`: the converter, ADF, profiles and warnings

## Purity

- Purity (root, "Map") is held by `core/tsconfig.json` (`types: []`, `lib: ES2022`) and
  `core/test/purity.test.ts`.

## One pipeline, one place each

- **One markdown -> ADF pipeline, never a second**: `markdownToAdfFor` (`core/src/editor.ts`), under
  the editor and Jira's `convert`; `editorOptionsFor` is the one place profile fields become flags.
- `core` has no `URL` global: hosts are parsed by hand, as a browser reads them (`linkHosts.ts`).
- A length or line-break limit blocks only where probed, and only on the tool it was probed on.
  A length limit is a bracket (longest accepted, shortest refused; `lengthLimit.ts`), and
  Jira's count is a lower bound. A line break is an `error` only in Jira `fields.summary` on
  `editJiraIssue` (`lineBreaks`).
- The review-field kinds (`markdown`, `text`, `line`) are sets of claims, not display choices
  (`core/src/reviewFields.ts`). Check a list where it is accepted (`reviewFieldsComplaint`);
  `blockFieldOf` answers `undefined` for two block fields as well as none.

## ADF structure

- Add to `core/src/adfSchema.ts` (root, "One fact, one place") only with evidence from a live probe
  or Atlassian's own docs. When the fixer (`hoistMedia`) and the checker disagree, Jira answers 400
  and the whole comment is lost.
- **A fixer must leave a valid document, not merely legal media.** An emptied container is a 400 too
  (`EMPTY_FORBIDDEN` / `emptyContainers()`); `core/test/hoistMedia.test.ts` sweeps every fixture.
- A constraint true of the intermediate representation is not true of the destination. ADF's `code`
  mark combines with `link` only (`CODE_MARK_COMBINES_WITH`: `code`+`link` 201,
  `code`+`strong`/`em`/`strike` 400), but three destinations store markdown verbatim. Per
  destination it is `DestinationProfile.codeSpanMarks`.
- Marks on a code span live in three layers, and all three must hold: the converter keeps
  them; the writer groups text into maximal shared-mark stretches and keeps marks in `applyMarks`'s
  `code` branch; the editor schema's `code` exclusion is derived from `TOOLBAR_MARKS` minus
  `CODE_MARK_COMBINES_WITH` (via `pmMarkName`). `extendMarkSchema` cannot set `excludes`.
- Test the shape where the mark does not extend past what it covers (`` a **`code`** b ``), not only
  where it does.

## Scanners and the converter

- A markdown-level scanner must not disagree with the converter (root, "One fact, one place"). Where
  a scan decides anything that matters, read the converter's output instead (`imagesAsLinks` emits
  the link in the converter; Jira's checks walk the converted tree). Bare URLs end in one place
  (`bareUrl.ts`), link destinations in one (`linkDestination.ts`), code spans in one
  (`codeSpan.ts`).
- The spec checker (`core/test/spec/`) compares the converter with micromark + GFM. `baseline.ts`
  may only shrink; after the converter moves, run `bun run spec:baseline` and read every row it
  prints. Every intended difference is in `DELIBERATE` (`normalise.ts`) with its reason.

## Empty bodies and fields

- An empty body is a live Jira 400 no structural check can see: `jira/empty-body` (probed),
  plus `body/empty` for every destination. Use `isBlankBody`, not `=== ''`: Jira trims
  first.
- An empty prose field is the same 400 one field over (probed): `prose/empty`, an error, from
  `proseWarnings()` (`render()` sees only the body). Both set `blocked` (`round-trip.md`);
  `review.ts` refuses `prose/empty` again for a surface that never asks core.

## Profiles and registries

- **An unprobed claim does not go in a profile.**
- Each profile `satisfies DestinationProfile` (so a stray field is an error) and declares `mode`
  explicitly. `mediaPlacement` (where the model puts media) and `rendersMedia` (whether a picture is
  drawn at all) are orthogonal.
- `render`, `renderPlain` and `renderNoBody` are three functions because each is a different set of
  claims; `format` is the discriminator. `renderNoBody` is not `render('')`.
- `WARNING_CODES` (`core/src/warnings.ts`) is the registry: each row states what input reaches the
  code and which optional fields it carries; `core/test/warnings.test.ts` holds both.
- `REMEDY` (`core/src/remedies.ts`) spells every command a runtime message tells a person to run;
  `cli/test/remedies.test.ts` fails on a `bun` command in any other string literal.
- Slack's `<url|label>` is a link only where the profile says so (`angleLinkLabels`, probed on
  Slack): the label's characters as written, nothing parsed inside it, and the link mark's `angle`
  carries the spelling so the writer sends `<url|label>` (or `<url>`) back. One grammar for the
  reader and the writer (`linkDestination.ts`); a label or address the form cannot hold (a `>`, a
  second `|`, a `mailto:`) goes out as a markdown link, every character kept. Unprobed label shapes
  stay text.
- Mention tokens live in the profiles, and Jira's `mentions.tokens` is `null`: `[~accountid:x]`
  renders literally (probed), so marking it would promise a ping that never happens.
- A link the destination turns into a mention is declared on the profile too (`mentions.links`), and
  only Linear has one: its profile link, labelled or bare, is a user mention (probed). The link is
  sent as a link; the window draws it as a mention and the strip counts it. Never rewrite it to
  `@Label`: Linear and GitHub resolve a bare `@name`, which can notify someone else.
- `core/src/adf/` is draftgate's own converter (origin in `PROVENANCE.md`). Do not call it
  "vendored" or cite a modification number.
