# jira-ruler: Jira's own editor, as a measuring instrument

Atlassian's `@atlaskit/editor-core`, built into a page and opened in the dev Electron, so the values
`surface/src/styles/jira.css` states about the editor (the surface a comment's AUTHOR types into)
can be read off the real thing. It is a dev instrument, not a dependency and not in the plugin
tree: nothing in the review window or the bundle comes from here.

`probe-renderer.cjs` (`measure:renderer`) sits beside it and measures the other Jira surface, the
READER's (`@atlaskit/renderer`).

## Build it once

```sh
cd tools/jira-ruler
npm install          # about 1 GB of @atlaskit dependencies, git-ignored
npm run build        # dist/, about 17 MB, git-ignored; about 20 s
```

Keep the built `dist/`: rebuilding means reinstalling the whole dependency tree. Use
`npm install`, not `npm ci`: the lockfile records an optional Loom package that is not on public
npm, and `npm ci` refuses the whole install over it.

## Measure

From the repository root:

```sh
bun run measure:blocks       # blockquote, lists, table cells, code block
bun run measure:headings     # h1-h6
bun run measure:styles       # a summary: paragraph, h1, h2, code, table, quote (its own harness)
bun run measure:linenos      # whether and how a code block numbers its lines
bun run measure:dark         # the same values under Atlassian's dark theme
bun run measure:renderer     # the READER's values; needs network, no build, no credentials
```

The `measure:*` probes on editor-core print JSON on stdout. `measure:renderer` writes
`measured-renderer.json` here, git-ignored. Each script's header says what it reads and what it
cannot measure.

They run under `tools/electron/run.ts`, which installs the dev Electron on first use and pins the
display (scale 1, legacy scroll bars), so runs on different Macs are comparable. Do not run a probe
with `bun` directly: under bun, `require('electron')` is not Electron's API. `measure.cjs` is the
harness the editor-core probes share; it reports a missing `dist/` rather than failing obscurely.

`measure:renderer` reads a public Jira Cloud site anonymously. Never point it at a site of your
own.

Nothing in the repo reads these outputs (`.claude/rules/styles.md`). To see what moved, keep the
previous run's output and diff the two.

## Look at it by hand

```sh
cd tools/jira-ruler
npm run try          # build, then open the editor to type in
npm run try:nobuild  # the same, with the existing dist/
npm start            # non-interactive: writes ruler-result/ and quits after 12 s
npm run start:build  # the same, after a rebuild
```

The page loads the torture fixture as ADF (`src/fixture.json`, identical to
`core/test/__golden__/torture-fixture.jira.adf.json`). The window is frameless and always on top, so
it has no close button: **Esc, Cmd-W or Cmd-Q quits**, with an application menu as a backstop. The
editor is a lazily loaded chunk of about 9 MB and appears about a second after the window. The dark
bar along the bottom is live diagnostics.

A non-interactive run writes `ruler-result/` (git-ignored): `screenshot.png`, `dom.html` and
`console.log`.

## What it does not show

- **Images.** editor-core draws media through a `mediaProvider`, and none is wired, so an image
  renders nothing. The same holds for mentions and smart links (`.claude/rules/styles.md`: a stub
  is not a measurement).
- **Anything Atlassian changed since the pinned version.** The ruler measures the
  `@atlaskit/editor-core` its `package-lock.json` pins; update that dependency and rebuild to pick
  up a change.

## What the build works around

**Broken subpath exports.** Several `@atlaskit` packages declare a subpath in their `exports` map
and do not ship the file, so no bundler resolves it. `vite.config.mjs` aliases each to a stub in
`stubs/`, which exports only the names the editor imports. A stub fails quietly: if upstream renames
an export, the stub keeps returning a no-op. If something renders blank after an upgrade, check the
stubs first.

**Node builtins in browser code.** `@atlaskit/editor-plugin-block-controls` imports `events`, and
`iconv-lite` pulls in `string_decoder` and `buffer`. `vite-plugin-node-polyfills` supplies them, so
the renderer stays sandboxed with no Node integration.

**Three `overrides` in `package.json`.** Each forces a version its requirer's range excludes:

| override | requirer asks for | why it is tolerable |
|---|---|---|
| `lodash: ^4.18.0` | `@loomhq/lens` pins exactly `4.17.23` | the top level is already 4.18; this only lets the nested copy hoist. Same major |
| `prismjs: ^1.30.0` | `refractor` wants `~1.27.0` | patch level inside 1.x; syntax highlighting only |
| `path-to-regexp: ^3.3.0` | `fetch-mock` wants `^2.2.1` | a major, but `fetch-mock` is a test utility this instrument never runs |

If a measured value moves after an install, these three are the first suspects: the Loom plugin,
`refractor` and `fetch-mock` are what they touch, and none should move a size or a margin.
