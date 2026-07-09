#!/usr/bin/env bash
#
# Drain-aware git-pull deploy for backstage, run ON the EC2 box by the GitHub
# Actions workflow (.github/workflows/deploy.yml) via AWS SSM Run Command
# (AWS-RunShellScript). No inbound ingress, no SSH — GitHub authenticates to AWS
# with OIDC and calls ssm:SendCommand; the SSM agent on the box runs this.
#
# SSM runs commands as root. The checkout and the systemd service are owned by
# `ubuntu`, so git/bun run as ubuntu and only systemctl runs as root.
#
# Usage: deploy.sh <git-sha>   (defaults to origin/master)
set -euo pipefail

REPO_DIR=/home/ubuntu/projects/tella-backstage
# Rename compat: prefer the new /opensession health path, fall back to the
# legacy /backstage alias (a process started before the rename change only
# serves the old prefix; after a restart it serves both).
HEALTH_URL_NEW=http://127.0.0.1:3850/opensession/api/health
HEALTH_URL_OLD=http://127.0.0.1:3850/backstage/api/health
TARGET_SHA="${1:-origin/master}"
MAX_DRAIN_WAIT="${MAX_DRAIN_WAIT:-480}"   # wait up to 8 min for idle before forcing the restart

run_as_ubuntu() { runuser -u ubuntu -- "$@"; }

echo "[deploy] fetching origin, fast-forwarding to ${TARGET_SHA}"
run_as_ubuntu git -C "$REPO_DIR" fetch --prune origin
# Fast-forward only — never `reset --hard`. The box's checkout is shared, live,
# and hot-reloading; sessions edit and commit on it directly. A hard reset would
# silently delete any uncommitted or un-pushed work mid-flight (it bit us before).
# ff-only advances cleanly when the box is on master and clean, and ABORTS loudly
# if the checkout diverged or has local edits — surface that, don't destroy it.
if ! run_as_ubuntu git -C "$REPO_DIR" merge --ff-only "$TARGET_SHA"; then
  echo "[deploy] ERROR: cannot fast-forward to ${TARGET_SHA}." >&2
  echo "[deploy] The checkout has local commits or uncommitted changes. On the box:" >&2
  echo "[deploy]   cd $REPO_DIR && git status   # then commit+push, or stash, then re-run the deploy" >&2
  exit 1
fi

# (Re)install the shared-checkout tripwire hook: warns loudly if this live
# checkout ever gets switched off master (branch work must use a worktree).
if [ -f "$REPO_DIR/deploy/git-hooks/post-checkout" ]; then
  run_as_ubuntu install -m 755 "$REPO_DIR/deploy/git-hooks/post-checkout" "$REPO_DIR/.git/hooks/post-checkout"
fi

# Install deps only when the lockfile/manifest actually changed (fast path otherwise).
if ! run_as_ubuntu git -C "$REPO_DIR" diff --quiet 'HEAD@{1}' HEAD -- bun.lock package.json 2>/dev/null; then
  echo "[deploy] deps changed — bun install --frozen-lockfile"
  run_as_ubuntu bash -lc "cd '$REPO_DIR' && bun install --frozen-lockfile"
fi

# The deployed units are COPIES of the repo's *.service files (not symlinks) —
# sync whichever is installed when it changes so unit edits actually ship.
# opensession.service is the unit going forward; backstage.service is the
# deprecated pre-rename name (synced only while it's still installed).
UNITS_CHANGED=0
for unit in opensession.service backstage.service; do
  if [ -f "/etc/systemd/system/$unit" ] && ! cmp -s "$REPO_DIR/$unit" "/etc/systemd/system/$unit"; then
    echo "[deploy] $unit changed — syncing unit"
    cp "$REPO_DIR/$unit" "/etc/systemd/system/$unit"
    UNITS_CHANGED=1
  fi
done
[ "$UNITS_CHANGED" = "1" ] && systemctl daemon-reload

# Drain-aware restart: wait until the service reports no in-flight runs, so the
# restart kills as few runs / background tasks / subagents as possible. Anything
# still running after the cap is caught by the graceful SIGTERM drain + the run
# journal (resumed on boot), so nothing is lost — we're only minimizing churn.
health_json() {
  curl -s --max-time 4 "$HEALTH_URL_NEW" 2>/dev/null && return 0
  curl -s --max-time 4 "$HEALTH_URL_OLD" 2>/dev/null
}

echo "[deploy] waiting for idle (max ${MAX_DRAIN_WAIT}s)"
deadline=$(( $(date +%s) + MAX_DRAIN_WAIT ))
while :; do
  active=$(health_json \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("activeRuns","?"))' 2>/dev/null || echo "?")
  if [ "$active" = "0" ]; then echo "[deploy] idle — restarting"; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[deploy] still ${active} run(s) active after ${MAX_DRAIN_WAIT}s — restarting anyway (journal resumes the rest)"
    break
  fi
  echo "[deploy] ${active} run(s) in flight — waiting…"
  sleep 10
done

# Restart whichever unit is actually running the service (opensession.service
# after the rename window's unit swap, backstage.service before it).
ACTIVE_UNIT=backstage.service
if systemctl is-enabled --quiet opensession.service 2>/dev/null || systemctl is-active --quiet opensession.service 2>/dev/null; then
  ACTIVE_UNIT=opensession.service
fi
echo "[deploy] restarting $ACTIVE_UNIT"
systemctl restart "$ACTIVE_UNIT"

# Post-restart health gate — fail the deploy if it doesn't come back.
for _ in $(seq 1 30); do
  sleep 2
  if curl -fs --max-time 4 "$HEALTH_URL_NEW" >/dev/null 2>&1 || curl -fs --max-time 4 "$HEALTH_URL_OLD" >/dev/null 2>&1; then
    echo "[deploy] healthy after restart"
    exit 0
  fi
done
echo "[deploy] ERROR: service did not return healthy after restart" >&2
exit 1
