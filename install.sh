#!/usr/bin/env bash
#
# OpenSession installer.
#
#   curl -fsSL https://opensession.com/install.sh | bash
#
# Gets a bare box to a working `opensession` command: installs Bun if needed,
# clones the source, installs dependencies, puts a shim on PATH, and hands off
# to `opensession onboard`.
#
# Safe to re-run — an existing install is fast-forwarded, never clobbered.
#
# Flags (also settable as environment variables):
#   --dir <path>          OPENSESSION_DIR      install location
#   --channel <ref>       OPENSESSION_CHANNEL  branch or tag to track
#   --repo <url>          OPENSESSION_REPO     source repository
#   --no-modify-path      NO_MODIFY_PATH=1     do not touch shell profiles
#   --no-onboard          NO_ONBOARD=1         install only, skip the wizard
#   --yes                 NO_PROMPT=1          accept defaults, never prompt
#   --uninstall                                remove the install
#
set -euo pipefail

OPENSESSION_HOME="${OPENSESSION_HOME:-$HOME/.opensession}"
DIR="${OPENSESSION_DIR:-$OPENSESSION_HOME/src}"
BIN_DIR="$OPENSESSION_HOME/bin"
REPO="${OPENSESSION_REPO:-https://github.com/tellahq/opensession.git}"
CHANNEL="${OPENSESSION_CHANNEL:-}"
NO_MODIFY_PATH="${NO_MODIFY_PATH:-0}"
NO_ONBOARD="${NO_ONBOARD:-0}"
NO_PROMPT="${NO_PROMPT:-0}"
DO_UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --no-modify-path) NO_MODIFY_PATH=1; shift ;;
    --no-onboard) NO_ONBOARD=1; shift ;;
    --yes|-y) NO_PROMPT=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── output ──────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; D=""; G=""; Y=""; R=""; N=""
fi

step() { printf '%s\n' "${B}$1${N}"; }
info() { printf '  %s\n' "$1"; }
muted() { printf '  %s%s%s\n' "$D" "$1" "$N"; }
good() { printf '  %sok%s      %s\n' "$G" "$N" "$1"; }
warn() { printf '  %swarn%s    %s\n' "$Y" "$N" "$1"; }
die() { printf '  %serror%s   %s\n' "$R" "$N" "$1" >&2; exit 1; }

# ── uninstall ───────────────────────────────────────────────────────────────

if [ "$DO_UNINSTALL" = "1" ]; then
  step "Uninstalling OpenSession"
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files opensession.service >/dev/null 2>&1; then
    sudo systemctl disable --now opensession 2>/dev/null || true
    sudo rm -f /etc/systemd/system/opensession.service
    sudo systemctl daemon-reload 2>/dev/null || true
    good "service removed"
  fi
  rm -rf "$BIN_DIR"
  good "shim removed from $BIN_DIR"
  muted "left in place (delete by hand if you mean it):"
  muted "  $DIR            the checkout"
  muted "  $OPENSESSION_HOME/config.json   your configuration"
  muted "  $HOME/.opensession.env          your secrets"
  muted "  $HOME/.opensession-chats        your sessions"
  exit 0
fi

# ── prompting ───────────────────────────────────────────────────────────────
#
# Under `curl | bash` stdin is the script itself, so anything interactive must
# be re-attached to the terminal. Test stdin (-t 0), never stdout: redirecting
# output would otherwise silently turn an interactive install into a
# defaults-only one.

STDIN_PATH=""
if [ "$NO_PROMPT" = "1" ]; then
  STDIN_PATH=/dev/null
elif [ ! -t 0 ]; then
  if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    STDIN_PATH=/dev/tty
  else
    STDIN_PATH=/dev/null
  fi
fi

# Run a command with stdin pointed somewhere it can actually prompt from.
run_interactive() {
  if [ -n "$STDIN_PATH" ]; then "$@" <"$STDIN_PATH"; else "$@"; fi
}

# ── plan ────────────────────────────────────────────────────────────────────

printf '\n'
step "OpenSession"
muted "source      $REPO${CHANNEL:+ ($CHANNEL)}"
muted "install to  $DIR"
muted "command     $BIN_DIR/opensession"
printf '\n'

# ── prerequisites ───────────────────────────────────────────────────────────

step "Prerequisites"
command -v git >/dev/null 2>&1 || die "git is required — install it and re-run"
good "git $(git --version | awk '{print $3}')"

if ! command -v bun >/dev/null 2>&1; then
  # The Bun installer appends to a shell profile this non-interactive shell has
  # not sourced, so put it on PATH for the rest of this run explicitly.
  muted "installing Bun ..."
  command -v curl >/dev/null 2>&1 || die "curl is required to install Bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "Bun install failed"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun installed but not on PATH — open a new shell and re-run"
fi
good "bun $(bun --version)"

# ── source ──────────────────────────────────────────────────────────────────

step "Source"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin
  target="${CHANNEL:-$(git -C "$DIR" rev-parse --abbrev-ref HEAD)}"
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    warn "local changes present — leaving the checkout alone"
  elif git -C "$DIR" merge --ff-only --quiet "origin/$target" 2>/dev/null; then
    good "updated to $(git -C "$DIR" rev-parse --short HEAD)"
  else
    warn "could not fast-forward — leaving the checkout alone"
  fi
else
  [ -e "$DIR" ] && die "$DIR exists but is not a git checkout — move it or pass --dir"
  mkdir -p "$(dirname "$DIR")"
  if [ -n "$CHANNEL" ]; then
    git clone --quiet --branch "$CHANNEL" "$REPO" "$DIR" || die "clone failed"
  else
    git clone --quiet "$REPO" "$DIR" || die "clone failed"
  fi
  good "cloned to $DIR"
fi

step "Dependencies"
(cd "$DIR" && bun install --silent) || die "bun install failed"
good "installed"

# ── shim ────────────────────────────────────────────────────────────────────

step "Command"
mkdir -p "$BIN_DIR"
BUN_BIN="$(command -v bun)"
cat >"$BIN_DIR/opensession" <<EOF
#!/usr/bin/env bash
# Generated by the OpenSession installer. Safe to delete; re-run install.sh.
BUN="$BUN_BIN"
[ -x "\$BUN" ] || BUN="\$(command -v bun 2>/dev/null)" || {
  echo "opensession: bun not found — see https://bun.sh" >&2; exit 1; }
exec "\$BUN" "$DIR/scripts/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/opensession"
good "opensession -> $DIR/scripts/cli.ts"

# ── PATH ────────────────────────────────────────────────────────────────────

add_to_path() {
  config_file="$1"; line="$2"
  if grep -Fxq "$line" "$config_file" 2>/dev/null; then
    good "PATH already set in $config_file"
  elif [ -w "$config_file" ] || [ ! -e "$config_file" ]; then
    printf '\n# opensession\n%s\n' "$line" >>"$config_file"
    good "added to PATH in $config_file"
  else
    warn "add this to $config_file by hand:"
    muted "  $line"
  fi
}

if [ "$NO_MODIFY_PATH" != "1" ]; then
  case "$(basename "${SHELL:-bash}")" in
    fish) profile="$HOME/.config/fish/config.fish"; line="fish_add_path $BIN_DIR" ;;
    zsh)  profile="${ZDOTDIR:-$HOME}/.zshrc";        line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
    *)    profile="$HOME/.bashrc";                   line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  case ":$PATH:" in
    *":$BIN_DIR:"*) good "already on PATH for this shell" ;;
    *) add_to_path "$profile" "$line" ;;
  esac
fi
export PATH="$BIN_DIR:$PATH"

# GitHub Actions needs PATH additions written to a file rather than exported.
[ -n "${GITHUB_PATH:-}" ] && echo "$BIN_DIR" >>"$GITHUB_PATH"

# ── onboard ─────────────────────────────────────────────────────────────────

if [ "$NO_ONBOARD" = "1" ]; then
  printf '\n'
  step "Installed"
  info "Next: ${B}opensession onboard${N}"
  exit 0
fi

printf '\n'
if [ "$STDIN_PATH" = "/dev/null" ] && [ "$NO_PROMPT" != "1" ]; then
  warn "no terminal available — onboarding with defaults"
  muted "re-run 'opensession onboard --force' interactively to change them"
fi
run_interactive "$BIN_DIR/opensession" onboard || true

printf '\n'
step "Done"
info "opensession start     ${D}run the server${N}"
info "opensession doctor    ${D}check the install${N}"
info "opensession --help    ${D}everything else${N}"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) muted "open a new shell (or source your profile) to get 'opensession' on PATH" ;;
esac
printf '\n'
