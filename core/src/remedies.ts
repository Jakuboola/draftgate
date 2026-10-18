/** A `REMEDY` as a person types it, without its backticks: a usage line, or a list of commands. */
export const typed = (remedy: string) => remedy.replaceAll('`', '');

/** A command run by bun from an absolute, shell-quoted path: the one shape of every path-taking entry. */
const bunAt = (quotedPath: string, args: string) => `\`bun ${quotedPath} ${args}\``;

/**
 * The commands draftgate's own messages tell a person to run, spelled once. A message composes its
 * sentence, which stays with the cause, around an entry; `cli/test/remedies.test.ts` fails if a
 * runtime string spells a `bun` command or a `REMEDY` anywhere else.
 *
 * A user runs the plugin from `stable` (window built, host built by the first review, no
 * `node_modules`); a contributor runs a checkout after `bun install`. A message a user can reach
 * names a `draftgate` command, or one by absolute path where the bare command may run another
 * install or none; a `bun run` script only where the cause exists in a checkout alone. Every entry
 * reaches both readers unless it says "Contributor only".
 *
 * In `core` because the renderer reads it too and may import only one `cli` module.
 */
export const REMEDY = {
  /**
   * Contributor only: rebuild the review window from source. A stale window needs the Vite
   * toolchain (`hasToolchain`), which a user install does not have.
   */
  rebuildWindow: '`bun run build:surface`',
  /** Maintainers only: cut a release from `main` (`cli/src/release.ts`). */
  release: '`bun run release`',
  /** Contributor only: assemble the plugin tree out of a checkout (`cli/src/pluginDev.ts`). */
  buildPlugin: '`bun run build:plugin`',
  /** Contributor only: install the packages the window is built from. */
  installDependencies: '`bun install`',
  /** Install Apple's Command Line Tools, which the host's `clang` (and git) come from. */
  installCommandLineTools: '`xcode-select --install`',
  /**
   * Install draftgate: `install.sh` from `stable`, which installs the plugin through Claude Code's
   * own `claude plugin` commands. Running it again finishes an interrupted run.
   */
  install: '`curl -fsSL https://raw.githubusercontent.com/Jakuboola/draftgate/stable/install.sh | sh`',
  /**
   * Write the one settings entry for the tools the plugin's own hook cannot match, or take it out
   * when there are none.
   */
  register: '`draftgate register`',
  /** Check that hooks are on and the registration matches the tool map. */
  doctor: '`draftgate doctor`',
  /** Compare tool names with the tool map and propose `tools.json` entries; the setup skill runs it. */
  proposeTools: '`draftgate propose-tools`',
  /** Read the review log: outcomes, warnings, what reviewers edited. */
  digest: '`draftgate digest`',
  /** The commands a user runs; each answers `--help` with its options. */
  help: '`draftgate help`',
  /** Install bun with bun's own installer, which the plugin cannot do for itself. */
  installBun: '`curl -fsSL https://bun.sh/install | bash`',
  /** Claude Code's command that loads the plugins installed now into a running session. */
  reloadPlugins: '`/reload-plugins`',
  /** Claude Code's plugin manager, where a plugin is installed, updated and removed. */
  pluginManager: '`/plugin`',
  /** Turn an installed plugin on, opening `/plugin` at it. Takes the plugin's id. */
  pluginEnable: (id: string) => `\`/plugin enable ${id}\``,
  /**
   * Take a plugin out of Claude Code: its hook, its `bin/` and its enabled flag. Claude Code's own
   * command, which opens `/plugin` at the plugin. Takes the plugin's id, `draftgate@<marketplace>`.
   */
  pluginUninstall: (id: string) => `\`/plugin uninstall ${id}\``,
  /**
   * Move a plugin to the newest release, in a terminal: its marketplace's copy first, then the
   * plugin (measured; the update alone compares against the copy the last refresh left). A running
   * session loads it on `/reload-plugins`. Takes the plugin's id, `<plugin>@<marketplace>`.
   */
  pluginUpdate: (id: string) =>
    `\`claude plugin marketplace update ${id.slice(id.indexOf('@') + 1)} && claude plugin update ${id}\``,
  /**
   * The plugin's setup skill: it chooses the tools draftgate reviews and covers the ones the
   * plugin's own matcher cannot.
   */
  pluginSetup: '`/draftgate:setup`',
  /**
   * What a checkout, which registers nothing, names to put draftgate in place: `install`, then
   * `pluginSetup`, whose `register` replaces every draftgate entry in the user settings. A literal;
   * `cli/test/remedies.test.ts` holds it equal to those two.
   */
  installPlugin:
    '`curl -fsSL https://raw.githubusercontent.com/Jakuboola/draftgate/stable/install.sh | sh`, then `/draftgate:setup` in Claude Code',
  /**
   * One of draftgate's commands by absolute path, where `draftgate` on PATH may be missing, broken
   * or another install's. Takes the CLI's shell-quoted path: a checkout path may hold a space.
   */
  cli: (quotedCliPath: string, command: string) => bunAt(quotedCliPath, command),
  /**
   * A given install's `--doctor`, by its hook's absolute path (the one `register` just wrote, or
   * another install's): every version of the hook answers `--doctor`, and an older CLI may have no
   * `doctor` command.
   */
  doctorAt: (quotedHookPath: string) => bunAt(quotedHookPath, '--doctor'),
  /**
   * Classify a Jira site's projects from Jira itself (`JIRA_EMAIL`, `JIRA_TOKEN`).
   * By absolute path, since the reader is rarely in the checkout. Takes the script's quoted path.
   */
  jiraProjects: (quotedScript: string) => bunAt(quotedScript, '<site>'),
  /** Classify an owner's GitHub repositories through `gh api`. As `jiraProjects`. */
  githubRepos: (quotedScript: string) => bunAt(quotedScript, '<owner>'),
} as const;
