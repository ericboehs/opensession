#!/usr/bin/env bash
#
# migrate-opensession-state.sh — one-shot Backstage → OpenSession state rename
# (docs/rename-opensession-plan.md, Tier B).
#
# Renames every `~/.backstage-*` state dir/file (plus `~/.backstage` and
# `~/.backstage.env`) to its `~/.opensession*` equivalent and leaves a symlink
# at the old name, so anything still holding the old path — un-migrated code,
# other tooling, cron scripts, the systemd EnvironmentFile — keeps working.
#
# Run it ONLY in a restart window with the server STOPPED (a long-running
# process resolves paths once at boot and must not see the rename mid-flight):
#
#   sudo systemctl stop backstage.service   # or opensession.service
#   bash scripts/migrate-opensession-state.sh
#   sudo systemctl start opensession.service
#
# Idempotent: a second run finds only symlinks at the old names and does
# nothing. If a target already exists at the new name (partial earlier run),
# the entry is skipped with a warning — nothing is ever merged or deleted.
set -euo pipefail

HOME_DIR="${HOME:-/home/ubuntu}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Refuse to run while the server is up unless forced.
for unit in backstage.service opensession.service; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    if [ "$FORCE" = "1" ]; then
      echo "[migrate] WARNING: $unit is active — continuing because of --force" >&2
    else
      echo "[migrate] ERROR: $unit is active. Stop the server first" >&2
      echo "[migrate]   sudo systemctl stop $unit    # then re-run (or pass --force)" >&2
      exit 1
    fi
  fi
done

migrated=0
skipped=0

migrate_one() {
  local old="$1"
  [ -e "$old" ] || [ -L "$old" ] || return 0
  if [ -L "$old" ]; then
    echo "[migrate] skip (already a symlink): $old -> $(readlink "$old")"
    return 0
  fi
  local base new
  base="$(basename "$old")"
  new="$HOME_DIR/${base/.backstage/.opensession}"
  if [ -e "$new" ] || [ -L "$new" ]; then
    echo "[migrate] WARNING: $new already exists — leaving $old in place (dual-read keeps it working; reconcile by hand)" >&2
    skipped=$((skipped + 1))
    return 0
  fi
  mv "$old" "$new"
  ln -s "$new" "$old"
  echo "[migrate] $old -> $new (symlink left at old name)"
  migrated=$((migrated + 1))
}

# All ~/.backstage-* state (dirs AND files, e.g. .backstage-pins.json,
# .backstage-opencode.json, .backstage-codex-transport.json), then the config
# home and the systemd env file.
shopt -s nullglob dotglob
for p in "$HOME_DIR"/.backstage-*; do
  migrate_one "$p"
done
migrate_one "$HOME_DIR/.backstage"
migrate_one "$HOME_DIR/.backstage.env"

echo "[migrate] done: $migrated migrated, $skipped skipped"
echo "[migrate] old names remain as symlinks — remove them only after every"
echo "[migrate] consumer (cron scripts, tooling, the deprecated unit) is converted."
