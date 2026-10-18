---
paths:
  - "install.sh"
  - "cli/src/cliLink.ts"
  - "cli/src/uninstall.ts"
  - "cli/src/steps.ts"
  - "cli/src/paths.ts"
  - "cli/src/releaseCheck.ts"
  - "cli/src/claudePlugin.ts"
  - "cli/test/claudePlugin.test.ts"
  - "adapters/hook/test/pluginDoctor.test.ts"
  - "cli/src/release.ts"
  - "cli/src/pluginTree.ts"
  - "cli/src/pluginDev.ts"
  - "cli/src/gitDirs.ts"
  - "cli/src/hookModes.ts"
  - "cli/test/installScript.test.ts"
  - "cli/test/cliLink.test.ts"
  - "cli/test/register.test.ts"
  - "adapters/hook/test/{register,registration,hookSwitches,hookCommand}.test.ts"
  - "cli/test/uninstall.test.ts"
  - "cli/test/releaseCheck.test.ts"
  - "cli/test/release.test.ts"
  - "cli/test/pluginTree.test.ts"
  - "adapters/hook/src/register.ts"
  - "adapters/hook/src/registration.ts"
  - "adapters/hook/src/hookSwitches.ts"
  - "adapters/hook/src/hookCommand.ts"
  - "test/importGraph.test.ts"
---

# `install.sh` and the user commands

## Never against the real setup

- On top of `.claude/CLAUDE.md`'s "Safety" rule (a scratch `HOME` + `CLAUDE_CONFIG_DIR` +
  `DRAFTGATE_HOME` + `DRAFTGATE_AUDIT_LOG`): a `PATH` whose `bun`, `git` and `claude` you chose. For
  a real `install.sh` run, serve a local origin as in "The release" below; `claude plugin` commands
  under a scratch `CLAUDE_CONFIG_DIR` need no login.

## What a user install may depend on

- **The CLI and the hook import no npm package**: bun would fetch one at runtime.
  `test/importGraph.test.ts` reads the graph with `Bun.build`.
- `install.sh` installs the plugin through Claude Code's own commands (`claude plugin marketplace
  add`, `install`, `update`) and writes nothing of Claude Code's itself. It checks the Command Line
  Tools before anything runs git, finds `claude` on PATH or in `~/.local/bin` (a new account's PATH
  has neither), and finds bun where the plugin does (`FIND_BUN`, held to it by a test), installing
  it into `~/.bun` with bun's own installer when there is none. Measured on Claude Code 2.1.296: run
  again, `marketplace add` and `install` exit 0 and change nothing, `install` turns a disabled
  plugin back on, and `update` moves it to a newer `stable`, so running the script again finishes
  and updates.
- `install.sh` is one function called on its last line, so a cut download runs nothing.
  `cli/test/installScript.test.ts` runs it whole, fed on stdin as `curl | sh` does, with a fake
  `claude`, in an environment built from nothing.

## The commands

- `register` replaces every draftgate entry in the user settings so exactly one is left, with a 0600
  backup and changed lines only (settings.json holds tokens). It refuses a file it cannot parse, and
  another settings file that registers draftgate too or cannot be read. A block draftgate shares is
  split, not re-matched. It runs from the plugin (`bin/draftgate`), and its one entry covers only
  the tools the plugin's own matcher cannot, through draftgate's plugin link, which it points at the
  plugin root first (`hook.md`). Leaving no such entry, `register` and `uninstall` remove the link.
  From a checkout it refuses and writes nothing: a checkout is not an install.
- `uninstall` deletes nothing without a terminal's yes or `--delete <the exact path this run
  resolved>`. It refuses a directory holding files draftgate did not write, the home directory or
  above, and a symlink. Paths compare as places (`cli/src/paths.ts`): `$TMPDIR` is under
  `/var -> /private/var`. Only Claude Code takes a plugin out, so it names every draftgate install
  Claude Code records with `/plugin uninstall`, and says draftgate no longer reviews anything only
  when there is none.

## Hooks switched off, and the release check

- `hookSwitches.ts` reads the hook switches Claude Code takes from the settings files
  (`HookSwitchKey`). Safe mode, bare mode and `--settings` belong to a session and no file can show
  them.
- **A review runs NO git and waits on no network.** The release check runs only after a decision a
  person's surface answered, at most once a day (claimed before the spawn, under a lock), as a
  detached child running `git ls-remote` with no git config at all: each softer variant measured
  leaks a credential path. `releaseNotice` is silent whenever it might be false.
- The version you have is the newest `vX.Y.Z` tag reachable from HEAD; no tag is no version, and a
  git that cannot list tags is a failure, never "no version". A plugin's version folder has no git:
  there it is `plugin.json`'s version (`installIdentity`), the check asks the manifest's
  `repository`, and the notice names `REMEDY.pluginUpdate` and `/reload-plugins`.

## The release

- A release is a `vX.Y.Z` tag on `main` and `stable` moved to a release commit: the tag's tree
  plus the built window (`surface/dist`, git-ignored on `main`, committed on `stable`) plus the
  plugin tree under `plugin/`, with the previous `stable` as first parent and the tag as second. So
  a user's pull is a fast-forward, `stable`'s tip is never the tagged commit, and the newest tag it
  reaches is the release (`installedRelease`). `release.ts` refuses a `stable` whose tip adds
  anything but the window and a `plugin/` an assembly could have made.
- The version is `plugin/.claude-plugin/plugin.json`'s, and `release` takes none: it is the
  plugin's only update signal (Claude Code compares it, measured), so one not newer than every
  release is refused.
- The plugin tree is one mapping (`cli/src/pluginTree.ts`): `main`'s `plugin/` as it is, the
  runtime and the window's stamped sources mirrored under it, the window, and no lockfile, since
  Claude Code installs every package a plugin-root lockfile names. `release` builds it from the
  blobs it copies; `bun run build:plugin` copies it out of a checkout. `test/importGraph.test.ts`
  fails if the CLI or the hook imports a file the tree leaves out.
- The marketplace fetches the plugin from `stable`'s `plugin/` (`git-subdir`, `ref: stable`,
  in `.claude-plugin/marketplace.json`). Measured: a marketplace added with no ref clones the
  default branch, so a relative `./plugin` would install `main`'s incomplete `plugin/`; with this
  source, `Jakuboola/draftgate` and `Jakuboola/draftgate#stable` both install `stable`'s.
- **The source's `url` is the full HTTPS URL**, never `owner/repo` or `git@github.com:`. Measured:
  Claude Code clones an `owner/repo` `git-subdir` source over SSH with no HTTPS retry, so `install`
  fails for anyone whose SSH key GitHub does not know, though `marketplace add` (which does retry)
  succeeded. `cli/test/pluginTree.test.ts` holds it.
- **Every local step passes before anything remote changes**, and the tag and `stable` go in one
  atomic push. The window the release commit carries is byte for byte the one `surface:probe` and
  `surface:e2e` ran on, and it is read back from the commit with no toolchain at the root and in
  `plugin/`, as a user's clone and a plugin's cache copy check it (`bundleState`). With no
  toolchain the stamp checks what the tree has: the window's sources, and `bun.lock` where it is
  there to pin the packages. The plugin tree has neither packages nor lockfile.
- Rehearse against a local bare origin (`.claude/CLAUDE.md`, "Safety"): `release`, then a second
  release. For the plugin, serve that origin over git's smart HTTP (`git http-backend`; Claude Code
  refuses `file://` and dumb HTTP), point a scratch `GIT_CONFIG_GLOBAL`'s `insteadOf` for the GitHub
  URL at it, and run `claude plugin marketplace add` and `install` under a scratch
  `CLAUDE_CONFIG_DIR`. Map the `git@github.com:` form to an address that refuses, and leave
  `CLAUDE_CODE_PLUGIN_PREFER_HTTPS` unset: a rehearsal that can reach the repository over SSH cannot
  see a source only SSH can clone.
