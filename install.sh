#!/bin/sh
# Install draftgate as a Claude Code plugin:
#   curl -fsSL https://raw.githubusercontent.com/Jakuboola/draftgate/stable/install.sh | sh
# Checks macOS 26+ and the Command Line Tools (before anything runs git), finds Claude Code,
# installs bun where the plugin looks if there is none, then installs the plugin with `claude plugin`.
# Safe to run again: it finishes an interrupted run and updates. One function, called on the last
# line, so a cut download runs nothing.

set -u

# The first macOS the review window runs on: `MIN_MACOS` in cli/src/reviewHost.ts. Here so a Mac
# below it gets neither bun nor the plugin.
MIN_MACOS=26.0
BUN_INSTALLER=https://bun.sh/install
MARKETPLACE=Jakuboola/draftgate
PLUGIN=draftgate@draftgate

say() { printf 'draftgate: %s\n' "$*"; }
step() { printf '\n==> Step %s of 4: %s\n' "$1" "$2"; }
die() { printf 'draftgate: %s\n' "$*" >&2; exit 1; }

# Is version $1 at least $2? Both dotted; a suffix such as -beta is ignored.
at_least() {
  awk -v have="$1" -v want="$2" 'BEGIN {
    split(have, h, /[.+-]/); split(want, w, ".")
    for (i = 1; i <= 3; i++) {
      if (h[i] + 0 > w[i] + 0) exit 0
      if (h[i] + 0 < w[i] + 0) exit 1
    }
    exit 0
  }'
}

main() {
  # Nothing here may wait on a credential prompt: inside Claude Code nobody can answer one, and the
  # repository is public.
  GIT_TERMINAL_PROMPT=0
  export GIT_TERMINAL_PROMPT

  # --- 1. macOS and the Command Line Tools ------------------------------------------------------
  # Claude Code clones the plugin with git and the first review compiles the host with their clang.
  # Without them /usr/bin/git opens an install dialog, which fails inside Claude Code.
  step 1 "macOS and Apple's Command Line Tools"
  system=$(uname -s)
  [ "$system" = Darwin ] || die "draftgate runs on macOS only, and this is $system. Nothing was installed."
  macos=$(sw_vers -productVersion 2>/dev/null) || macos=
  # Only a version it can read stops it here; the review window asks again.
  case $macos in
    [0-9]*)
      if ! at_least "$macos" "$MIN_MACOS"; then
        die "the review window needs macOS $MIN_MACOS or newer, and this Mac runs macOS $macos. Nothing was installed."
      fi ;;
  esac
  clt=$(xcode-select -p 2>/dev/null) ||
    die "Apple's Command Line Tools are not installed, and git and the review window both need them. Run \`xcode-select --install\`, then run this again. If it says the software is not available, update macOS first, or download the tools from https://developer.apple.com/download/all/ (needs an Apple ID)."
  say "macOS ${macos:-(version unread)}, and the Command Line Tools are at $clt."

  # --- 2. Claude Code ---------------------------------------------------------------------------
  step 2 "Claude Code"
  # On PATH, or in ~/.local/bin, where Claude Code's own installer puts it and which a new account's
  # PATH does not have. An alias in a shell's own config is neither: this shell cannot run it.
  claude_bin=$HOME/.local/bin/claude
  if claude=$(command -v claude 2>/dev/null); then :
  elif [ -x "$claude_bin" ]; then claude=$claude_bin
  else die "Claude Code (\`claude\`) is not on this shell's PATH or at $claude_bin. Install it (https://claude.com/claude-code), then run this again."
  fi
  version=$("$claude" --version 2>/dev/null </dev/null) || die "$claude does not run: \`$claude --version\` failed."
  # It answers "2.1.296 (Claude Code)".
  say "Claude Code ${version%% *}, at $claude."

  # --- 3. bun -----------------------------------------------------------------------------------
  step 3 "bun"
  # The plugin runs on bun and cannot install it. Where the plugin's hook and its `draftgate` command
  # look, in their order (`FIND_BUN` in adapters/hook/src/hookCommand.ts): a bun anywhere else is one
  # the plugin would not find.
  b=; for c in "$(command -v bun 2>/dev/null)" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do if [ -f "$c" ] && [ -x "$c" ]; then b=$c; break; fi; done
  if [ -z "$b" ]; then
    say "bun is not installed where the plugin looks, so this installs it now with bun's own installer ($BUN_INSTALLER), into ~/.bun."
    installer=$(mktemp "${TMPDIR:-/tmp}/draftgate-bun-install.XXXXXX") || die "could not create a temporary file for bun's installer."
    if ! curl -fsSL "$BUN_INSTALLER" -o "$installer"; then
      rm -f "$installer"
      die "could not download bun's installer from $BUN_INSTALLER. Check the network, then run this again."
    fi
    # Into ~/.bun, which the plugin looks in, whatever BUN_INSTALL says.
    if ! BUN_INSTALL=$HOME/.bun bash "$installer" </dev/null; then
      rm -f "$installer"
      die "bun's installer failed (above). Run this again to retry."
    fi
    rm -f "$installer"
    b=$HOME/.bun/bin/bun
    [ -x "$b" ] || die "bun's installer finished, but there is no bun at $b. Run this again to retry."
    say "If bun's installer asked you to add ~/.bun/bin to your PATH, draftgate does not need that: it looks there."
  fi
  have=$("$b" --version 2>/dev/null </dev/null) || die "$b does not run: \`$b --version\` failed."
  say "bun $have, at $b."

  # --- 4. The plugin ----------------------------------------------------------------------------
  step 4 "The draftgate plugin, through Claude Code's plugin commands"
  # Each says what it did. Run again, `marketplace add` and `install` leave what is there, and
  # `install` switches a plugin turned off back on; `update` then moves it to the newest release.
  "$claude" plugin marketplace add "$MARKETPLACE" </dev/null ||
    die "Claude Code could not add draftgate's marketplace, $MARKETPLACE (its reason is above). Fix that, then run this again."
  "$claude" plugin install "$PLUGIN" </dev/null ||
    die "Claude Code could not install $PLUGIN (its reason is above). Fix that, then run this again."
  "$claude" plugin update "$PLUGIN" </dev/null ||
    die "draftgate is installed, but Claude Code could not check it is the newest release (its reason is above). Run this again to retry."

  printf '\n'
  say "draftgate is installed, and reviews every send tool it knows in new Claude Code sessions."
  say "Now, in Claude Code, run /draftgate:setup to choose which of your tools it reviews. In a session that was already open, run /reload-plugins first."
}

main "$@"
