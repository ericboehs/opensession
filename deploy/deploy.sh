#!/usr/bin/env bash
#
# Drain-aware git-pull deploy for Open Session, run ON the EC2 box by a CI
# deploy job (this repo ships no such workflow — wire up your own) via AWS SSM
# Run Command (AWS-RunShellScript). No inbound ingress, no SSH — CI
# authenticates to AWS with OIDC and calls ssm:SendCommand; the SSM agent on
# the box runs this.
#
# SSM runs commands as root. The checkout and the systemd service are owned by
# `ubuntu`, so git/bun run as ubuntu and only systemctl runs as root.
#
# Usage: deploy.sh <git-sha>   (defaults to origin/main)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${OPENSESSION_REPO_DIR:-$(dirname "$SCRIPT_DIR")}"
HEALTH_URL="${OPENSESSION_HEALTH_URL:-http://127.0.0.1:3850/api/health}"
SERVICE_USER="${OPENSESSION_SERVICE_USER:-$(stat -c '%U' "$REPO_DIR")}"
SERVICE_UID="${OPENSESSION_SERVICE_UID:-$(id -u "$SERVICE_USER")}"
SERVICE_GROUP="${OPENSESSION_SERVICE_GROUP:-$(id -gn "$SERVICE_USER")}"
SERVICE_HOME_DIR="${OPENSESSION_SERVICE_HOME_DIR:-$(getent passwd "$SERVICE_USER" | cut -d: -f6)}"
TARGET_SHA="${1:-origin/main}"
MAX_DRAIN_WAIT="${MAX_DRAIN_WAIT:-480}"   # wait up to 8 min for idle before forcing the restart

case "$SERVICE_HOME_DIR" in
  ""|"/")
    echo "[deploy] ERROR: unsafe home directory for service user $SERVICE_USER: '$SERVICE_HOME_DIR'" >&2
    exit 1
    ;;
esac

run_as_service_user() { runuser -u "$SERVICE_USER" -- "$@"; }

echo "[deploy] fetching origin, fast-forwarding to ${TARGET_SHA}"
run_as_service_user git -C "$REPO_DIR" fetch --prune origin
# Fast-forward only — never `reset --hard`. The box's checkout is shared and
# sessions edit and commit on it directly. A hard reset would
# silently delete any uncommitted or un-pushed work mid-flight (it bit us before).
# ff-only advances cleanly when the box is on main and clean, and ABORTS loudly
# if the checkout diverged or has local edits — surface that, don't destroy it.
if ! run_as_service_user git -C "$REPO_DIR" merge --ff-only "$TARGET_SHA"; then
  echo "[deploy] ERROR: cannot fast-forward to ${TARGET_SHA}." >&2
  echo "[deploy] The checkout has local commits or uncommitted changes. On the box:" >&2
  echo "[deploy]   cd $REPO_DIR && git status   # then commit+push, or stash, then re-run the deploy" >&2
  exit 1
fi

# (Re)install the shared-checkout tripwire hook: warns loudly if this live
# checkout ever gets switched off main (branch work must use a worktree).
if [ -f "$REPO_DIR/deploy/git-hooks/post-checkout" ]; then
  run_as_service_user install -m 755 "$REPO_DIR/deploy/git-hooks/post-checkout" "$REPO_DIR/.git/hooks/post-checkout"
fi

# Install deps only when the lockfile/manifest actually changed (fast path otherwise).
if ! run_as_service_user git -C "$REPO_DIR" diff --quiet 'HEAD@{1}' HEAD -- bun.lock package.json 2>/dev/null; then
  echo "[deploy] deps changed — bun install --frozen-lockfile"
  run_as_service_user bash -lc "cd '$REPO_DIR' && bun install --frozen-lockfile"
fi

# Personal MCP OAuth grants are encrypted with a root-owned installation key.
# PID 1 exposes it only inside opensession.service's private credential mount;
# model-controlled runtimes enter the AppArmor profile below and cannot read it.
install -d -m 0700 /var/lib/opensession
if [ ! -s /var/lib/opensession/mcp-oauth.key ]; then
  echo "[deploy] creating protected MCP OAuth encryption key"
  dd if=/dev/urandom of=/var/lib/opensession/mcp-oauth.key bs=32 count=1 status=none
fi
chown root:root /var/lib/opensession/mcp-oauth.key
chmod 0400 /var/lib/opensession/mcp-oauth.key

APPARMOR_SOURCE="$REPO_DIR/deploy/apparmor/opensession-agent"
APPARMOR_PATH="/etc/apparmor.d/opensession-agent"
APPARMOR_PARSER="$(command -v apparmor_parser 2>/dev/null || true)"
if [ -z "$APPARMOR_PARSER" ] && [ -x /usr/sbin/apparmor_parser ]; then
  APPARMOR_PARSER=/usr/sbin/apparmor_parser
fi
if [ -n "$APPARMOR_PARSER" ]; then
  if ! cmp -s "$APPARMOR_SOURCE" "$APPARMOR_PATH"; then
    echo "[deploy] installing agent credential-isolation profile"
    install -m 0644 "$APPARMOR_SOURCE" "$APPARMOR_PATH"
  fi
  "$APPARMOR_PARSER" -r "$APPARMOR_PATH"
else
  echo "[deploy] WARNING: AppArmor unavailable; personal MCP connections remain disabled" >&2
fi

# Was the unit ALREADY credential-bearing? Read before the sync below: the
# first start that gains LoadCredential is the moment a still-unconfined
# survivor could read the key out of the coordinator's credential mount.
CREDENTIAL_ALREADY_MOUNTED=no
if grep -q '^LoadCredential=' /etc/systemd/system/opensession.service 2>/dev/null; then
  CREDENTIAL_ALREADY_MOUNTED=yes
fi

# The deployed unit is a COPY of the repo's opensession.service (not a symlink) —
# sync it when it changes so unit edits actually ship.
if ! cmp -s "$REPO_DIR/opensession.service" /etc/systemd/system/opensession.service; then
  echo "[deploy] opensession.service changed — syncing unit + daemon-reload"
  cp "$REPO_DIR/opensession.service" /etc/systemd/system/opensession.service
  systemctl daemon-reload
fi

# Host safety fuses: the coordinator gets its own ceiling, while detached
# engine/preview scopes share a bounded user slice. The per-scope limits are
# passed by the application at systemd-run time; this persistent parent catches
# many individually healthy scopes accumulating until the box becomes inert.
OPENSESSION_RESOURCE_SOURCE="$REPO_DIR/deploy/systemd/opensession.service.d/resources.conf"
OPENSESSION_RESOURCE_PATH="/etc/systemd/system/opensession.service.d/resources.conf"
if ! cmp -s "$OPENSESSION_RESOURCE_SOURCE" "$OPENSESSION_RESOURCE_PATH"; then
  echo "[deploy] Open Session resource override changed — syncing drop-in + daemon-reload"
  install -d -m 0755 "$(dirname "$OPENSESSION_RESOURCE_PATH")"
  install -m 0644 "$OPENSESSION_RESOURCE_SOURCE" "$OPENSESSION_RESOURCE_PATH"
  systemctl daemon-reload
fi

OPENSESSION_SLICE_SOURCE="$REPO_DIR/deploy/systemd/user/opensession.slice"
OPENSESSION_SLICE_PATH="$SERVICE_HOME_DIR/.config/systemd/user/opensession.slice"
if ! cmp -s "$OPENSESSION_SLICE_SOURCE" "$OPENSESSION_SLICE_PATH"; then
  echo "[deploy] Open Session user slice changed — syncing aggregate resource budget"
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$(dirname "$OPENSESSION_SLICE_PATH")"
  install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_GROUP" \
    "$OPENSESSION_SLICE_SOURCE" "$OPENSESSION_SLICE_PATH"
  run_as_service_user env XDG_RUNTIME_DIR="/run/user/$SERVICE_UID" systemctl --user daemon-reload
  run_as_service_user env XDG_RUNTIME_DIR="/run/user/$SERVICE_UID" systemctl --user start opensession.slice
fi

# When Caddy's listener binds directly to the host's Tailscale IP, at boot
# Caddy can otherwise race tailscaled, fail with EADDRNOTAVAIL, and remain down
# forever because the package unit has no restart policy. Keep the host drop-in
# in source control and recover a currently failed Caddy when it first ships.
CADDY_DROPIN_SOURCE="$REPO_DIR/deploy/systemd/caddy.service.d/opensession.conf"
CADDY_DROPIN_PATH="/etc/systemd/system/caddy.service.d/opensession.conf"
if systemctl cat caddy.service >/dev/null 2>&1 \
  && ! cmp -s "$CADDY_DROPIN_SOURCE" "$CADDY_DROPIN_PATH"; then
  echo "[deploy] Caddy Tailscale boot override changed — syncing drop-in + daemon-reload"
  install -d -m 0755 "$(dirname "$CADDY_DROPIN_PATH")"
  install -m 0644 "$CADDY_DROPIN_SOURCE" "$CADDY_DROPIN_PATH"
  systemctl daemon-reload

  if ! systemctl is-active --quiet caddy.service; then
    echo "[deploy] Caddy is not active — restarting after installing boot override"
    systemctl restart caddy.service
  fi
fi

# Drain-aware restart: wait until the service reports no in-flight runs, so the
# restart kills as few runs / background tasks / subagents as possible. Anything
# still running after the cap is caught by the graceful SIGTERM drain + the run
# journal (resumed on boot), so nothing is lost — we're only minimizing churn.
echo "[deploy] waiting for idle (max ${MAX_DRAIN_WAIT}s)"
deadline=$(( $(date +%s) + MAX_DRAIN_WAIT ))
while :; do
  active=$(curl -s --max-time 4 "$HEALTH_URL" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("activeRuns","?"))' 2>/dev/null || echo "?")
  if [ "$active" = "0" ]; then echo "[deploy] idle — restarting"; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[deploy] still ${active} run(s) active after ${MAX_DRAIN_WAIT}s — restarting anyway (journal resumes the rest)"
    break
  fi
  echo "[deploy] ${active} run(s) in flight — waiting…"
  sleep 10
done

# First credential-bearing start only: retire model-controlled scopes that
# predate confinement. They run at this uid and are NOT under the profile, so
# once the new unit holds the key they could read it straight out of
# /proc/<coordinator>/root/run/credentials. The in-process boot sweep
# (retirePreConfinementRecords) still runs as defence in depth, but it can only
# run after the mount already exists. Skipped on every later deploy, so
# detached engines keep surviving restarts the way they are designed to.
if [ "$CREDENTIAL_ALREADY_MOUNTED" = no ] && [ -s /var/lib/opensession/mcp-oauth.key ]; then
  echo "[deploy] first credential-bearing start — retiring pre-confinement agent scopes"
  user_systemctl() {
    run_as_service_user env XDG_RUNTIME_DIR="/run/user/$SERVICE_UID" systemctl --user "$@"
  }
  stale_scopes="$(user_systemctl list-units --plain --no-legend --type=scope \
    'opensession-oc-*.scope' 'opensession-preview-*.scope' 2>/dev/null | awk '{print $1}' || true)"
  for scope in $stale_scopes; do
    echo "[deploy]   stopping $scope"
    user_systemctl stop "$scope" || true
  done
fi

systemctl restart opensession.service

# Post-restart health gate — fail the deploy if it doesn't come back.
for _ in $(seq 1 30); do
  sleep 2
  if curl -fs --max-time 4 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "[deploy] healthy after restart"
    exit 0
  fi
done
echo "[deploy] ERROR: service did not return healthy after restart" >&2
exit 1
