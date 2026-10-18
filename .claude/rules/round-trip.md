---
paths:
  - "core/src/editor.ts"
  - "core/src/render.ts"
  - "core/src/warnings.ts"
  - "core/src/markdown.ts"
  - "core/src/prosemirror.ts"
  - "core/src/adf/adfToMarkdown.ts"
  - "core/src/adf/markdownToAdf.ts"
  - "surface/src/{App,Editor,FixDiff,linkEditor}.tsx"
  - "surface/src/{useReview,lostHighlight,derivedDecorations,settledWarnings}.ts"
  - "surface/{silencedWarnings,schema,settledWarnings}.test.ts"
  - "surface/window.test.tsx"
  - "cli/src/review.ts"
  - "cli/src/audit.ts"
  - "cli/src/digest.ts"
---

# The round trip: what the reviewer sees is what is sent

Interchange is markdown end to end; the editor pipeline is markdown -> ADF -> ProseMirror for every
destination.

## One body

- **An approval sends the body the reviewer was shown, edited or not**, never `canonical`. One body
  is judged and sent; `blocked` and Approve come from it.
- **The window must never change a message invisibly**: that half is what makes the rule above safe,
  since loading can change a message. `silencedWarnings` (`surface/src/useReview.ts`) reports every
  code true of `canonical` and not of the body first shown. The candidate set is fixed at load
  (`silencedAtLoad`) and the live comparison only narrows it, so a warning the reviewer edited away
  is never booked as draftgate's. The codes ride the decision as `silenced` into the review log.
- Those rows' chips say `note`: never a severity word (it contradicts the green verdict), never
  `info` (indistinguishable from a live info row), never `fixed` (some codes lost something).
- Exactly the codes in `WARNING_CODES`' `silencedByRoundTrip` column can land there;
  `surface/silencedWarnings.test.ts` derives the set and compares. Some mean a loss
  (`jira/task-item-media-only` destroys a checkbox). Do not classify them mechanically as fixed or
  lost: nothing in a `Warning` tells them apart. The test's `CASES` must reach every code (root: a
  guard must be able to fail).
- A warning can be blocking on `canonical` and absent from the shown body; Approve is then live
  because the sent body is fine, and the silenced row keeps it visible.

## What the editor can hold that markdown cannot

- **A structural shape with no markdown spelling must block.** `lostInMarkdown`
  (`core/src/editor.ts`) re-parses the serialised markdown and reports any structural node that did
  not come back: `body/structure-lost`, an error. A round trip, not a hand-written table of legal
  shapes. It ignores text, characters, moves (`hoistMedia` relocates media on purpose) and an empty
  paragraph (ProseMirror keeps a trailing one; counting it would make ticking a checkbox block).
- A lost mark warns (`body/mark-lost`); the text still arrives.
- Lost text warns (`body/text-changed`), the one editor check `render()` asks with an
  unbuilt document at load (`render(shown, dest, doc, false)`). The writer escapes every line-start
  marker either reader takes (`escapeLineStarts` in `adfToMarkdown.ts`).
- `render(body, destination)` with no document reports no editor checks, on purpose: at load the
  body IS `markdownFor(doc)`.

## Facts the log depends on

- The round trip ends the way its input ends. `matchTrailingNewline` (`core/src/markdown.ts`), in
  `markdownFor` and Jira's `suggestFix`: matched, never imposed. Otherwise every draft logs an
  `after` that differs by one byte.
- `edited` means a human changed something and travels as its own wire field; the body cannot answer
  it. It is sticky once `fixes` is non-empty. Absent means a surface that does not report, and the
  CLI then falls back to `body !== canonical`. It counts a changed line too, so `bodyEdited` travels
  beside it, same rules: the agent is shown a body only when a person changed it
  (`ReviewOutcome.sent`), never one the editor only reformatted.
- **`fixes` is three-state**: a list (accepted repairs), `[]` (a reporting surface, none accepted),
  absent (a surface that cannot report). Never `?? []` on that path; the window always sends `fixes`
  on approve.
- A rule that gates the UI sets `blocked`, not a denial in `runReview` afterwards: a body rule in
  `render()` (`body/empty`), a prose-field rule in `proseWarnings()`, which the window merges into
  `blocked` (`render()` is handed only the body).
- A Slack angle link round-trips byte-identically, edited or not, because its link mark carries
  `angle` and the writer spells it back (`converter.md`). Two links to one address with nothing
  between them are one link in the editor and go out as one, as two markdown links do. The editor
  declares that attribute (`AngleLinkSpelling` in `Editor.tsx`): ProseMirror silently drops a mark
  attribute its schema does not name, so without it every such link would go out as a markdown link.
- `slack/url-swallows-next-line` is the only warning with per-warning repairs, reachable only from a
  URL the reviewer types (`Link` has `autolink: false`); tests type one (`typeBareUrl`).
