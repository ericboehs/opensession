#!/usr/bin/env bash
#
# OpenSession bootstrap: bare box -> configured checkout.
#
#   curl -fsSL https://opensession.com/install.sh | bash
#
# Installs Bun if missing, clones the repo, installs dependencies and hands
# off to `bun run setup` (scripts/setup.ts) for the interactive part. Safe to
# re-run: an existing checkout is updated rather than re-cloned, and setup
# backs up any config it would overwrite.
#
# Environment overrides:
#   OPENSESSION_REPO    git URL to clone       (default: the public repo)
#   OPENSESSION_DIR     install directory      (default: ~/opensession)
#   OPENSESSION_REF     branch/tag to check out (default: the repo default)
#   OPENSESSION_NO_SETUP=1  clone and install only, skip the setup wizard

set -euo pipefail

REPO="${OPENSESSION_REPO:-https://github.com/tellahq/opensession.git}"
DIR="${OPENSESSION_DIR:-$HOME/opensession}"
REF="${OPENSESSION_REF:-}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
die() {
  printf '\033[31merror: %s\033[0m\n' "$1" >&2
  exit 1
}

bold ""
bold "OpenSession installer"
dim "  target $DIR"

# ── prerequisites ───────────────────────────────────────────────────────────

command -v git >/dev/null 2>&1 || die "git is required. Install it and re-run."

if ! command -v bun >/dev/null 2>&1; then
  dim ""
  dim "Bun not found — installing from https://bun.sh ..."
  command -v curl >/dev/null 2>&1 || die "curl is required to install Bun."
  curl -fsSL https://bun.sh/install | bash

  # The Bun installer appends to the shell profile, which this non-interactive
  # shell has not sourced. Put it on PATH for the rest of this run.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  command -v bun >/dev/null 2>&1 ||
    die "Bun installed but is not on PATH. Open a new shell and re-run."
fi

dim "  bun    $(bun --version)"
dim "  git    $(git --version | awk '{print $3}')"

# ── checkout ────────────────────────────────────────────────────────────────

if [ -d "$DIR/.git" ]; then
  bold ""
  bold "Updating existing checkout"
  git -C "$DIR" fetch --quiet origin
  # Fast-forward only: never discard local work in an existing install.
  if ! git -C "$DIR" merge --ff-only --quiet FETCH_HEAD 2>/dev/null; then
    warn "  Local commits or changes present — skipping update, leaving as is."
  fi
else
  [ -e "$DIR" ] && die "$DIR exists but is not a git checkout. Move it or set OPENSESSION_DIR."
  bold ""
  bold "Cloning"
  if [ -n "$REF" ]; then
    git clone --branch "$REF" "$REPO" "$DIR"
  else
    git clone "$REPO" "$DIR"
  fi
fi

cd "$DIR"

bold ""
bold "Installing dependencies"
bun install

# ── hand off ────────────────────────────────────────────────────────────────

if [ "${OPENSESSION_NO_SETUP:-}" = "1" ]; then
  bold ""
  bold "Done. Next: cd $DIR && bun run setup"
  exit 0
fi

# Piped installs (curl | bash) have no TTY on stdin, so the wizard cannot
# prompt. Re-attach the terminal when there is one; otherwise fall back to
# defaults and tell the user how to redo it interactively.
if [ -t 1 ] && [ -r /dev/tty ]; then
  bun run setup </dev/tty
else
  warn ""
  warn "No terminal available — running setup with defaults."
  warn "Re-run \`cd $DIR && bun run setup\` interactively to change them."
  bun run setup --yes
fi
