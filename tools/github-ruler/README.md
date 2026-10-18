# github-ruler: what a GitHub comment looks like

`measure.cjs` renders `fixture.md` through GitHub's own renderer (`POST /markdown`), wraps it the
way a comment is wrapped, loads github.com's real stylesheets, and reads the computed values back in
the dev Electron. It then cross-checks them against a live GitHub page. `measured-github.json`
beside it is the unedited output, committed as evidence. The script's header says how the surface
is assembled and why.

```sh
bun run measure:github       # from the repository root; needs network, no credentials
```

A run writes over `measured-github.json` and the assembled `page-*.html` (git-ignored). `git diff`
the JSON to see what GitHub changed.

## Who reads it

`surface/harness/tokens.test.ts` holds `github.css` to it: every colour the sheet declares is
compared numerically with the colour GitHub computes, and the heading ladder as pixels. The test
also fails if the committed run recorded a disagreement with the live page that `KNOWN` does not
explain, or if the cross-check covered so little that agreement would be vacuous.
`surface/harness/probe.ts` must not read it (`.claude/rules/styles.md`).

Computed values, not GitHub's declarations, are the evidence: `.markdown-body` declares 16px, but a
comment renders at 14px, because the same element also carries `.comment-body`, declared in another
bundle at equal specificity, which wins. Every heading is sized in `em`, so taking `.markdown-body`
at face value makes all six headings 14% too large.

## Which typeface: read `faces`, never `font-family`

`getComputedStyle`'s `font-family` is the DECLARED list. GitHub's begins with `"Mona Sans VF"`, but
no stylesheet on the page has an `@font-face` for it, so a comment draws in the system face. The run
asks the rasteriser (`CSS.getPlatformFontsForNode`) and records the answer as `faces`, per surface
and theme and for the live page. `tokens.test.ts` fails if any of them is a web font, or if
`github.css` names a family the window bundles.

## The cross-check, and what it does not cover

Every run compares the assembled surface against a **live GitHub page**: a different DOM, different
ancestors, a different origin, sharing only the stylesheets. The output reports coverage per key
rather than averaging it away:

- The **comment** page (`nodejs/node/issues/1`) renders its rich content through React, leaving only
  short prose inside `.markdown-body`. It cross-checks the font, the size cascade, the colour and the
  link, which is where the 16px-vs-14px question lives, and nothing else.
- The **README** page (`primer/css`) puts headings, lists, quotes, code and images in the real DOM
  and cross-checks ten keys. It renders at 16px because it carries no `.comment-body`, so it is
  compared against an assembled README wrapper, not the comment one.

Anything neither page contains is reported `untested`, never `agree`. Two disagreements are
**expected** and named in `KNOWN` with the rule that produces each: the last child's zeroed bottom margin (`.markdown-body > :last-child`), and GitHub
painting a code block's background on the wrapper in one pipeline and on the `pre` in the other.
Anything else prints as `DIFFER`.

## Caveats that live with the data

- **Syntax-highlight token colours are not taken.** They are in the `.pl-*` classes and measurable,
  but only for whichever languages the fixture contains, which is a claim about `fixture.md`, not
  about GitHub. `github.css` takes none of them.
- **The `.highlight` wrapper is not a draftgate element.** draftgate draws its own code block; the
  wrapper is measured only so its disagreement is explained.
- **Signed out.** Everything here is what an anonymous reader is served. A signed-in reader can pick
  a different theme; the two measured are the two GitHub serves by default
  (`data-light-theme="light"`, `data-dark-theme="dark"`).
- **Box geometry depends on the display.** The quote and alert borders measure `3.5px` at a device
  scale of 2 and `3px` at 1, which is what the committed file holds. The launcher pins scale 1 and
  legacy scroll bars, so a plain run is the comparable one. The scale-2 reading is
  `bun tools/electron/run.ts --unpinned tools/github-ruler/measure.cjs` on a Retina display, which
  writes over `measured-github.json` like every run (`git checkout` it afterwards).
- **The two page URLs can rot.** They are constants, overridable with `GITHUB_RULER_ISSUE` and
  `GITHUB_RULER_README`, and the script fails loudly with that instruction rather than measuring a
  404.
