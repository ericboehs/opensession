#!/usr/bin/env bash
# Host-side one-time setup for the Docker sandbox provider (Phase 1).
#
# Installs a DOCKER-USER iptables rule that DROPs container traffic to the EC2
# instance-metadata service (169.254.169.254). This mirrors the
# IPAddressDeny=169.254.169.254/32 that opensession.service and the systemd run
# hosts already enforce: agent code must never be able to mint instance-role
# credentials, sandboxed or not. DOCKER-USER is the chain Docker guarantees to
# consult before its own forwarding rules, so the drop applies to every
# container on every network.
#
# Idempotent: safe to re-run. Needs passwordless sudo (the aws-creds precedent
# on this box). NOT persisted across reboots by default — Docker recreates the
# DOCKER-USER chain on daemon start but does not restore our rule, so re-run
# this after a host reboot (or wire it into a @reboot cron / systemd oneshot;
# left manual in Phase 1 and noted in the README).
set -euo pipefail

if ! command -v iptables >/dev/null; then
  echo "iptables not found" >&2
  exit 1
fi

if ! sudo -n true 2>/dev/null; then
  echo "sudo requires a password on this host — run manually: sudo iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j DROP" >&2
  exit 2
fi

if ! sudo -n iptables -nL DOCKER-USER >/dev/null 2>&1; then
  echo "DOCKER-USER chain missing (is the docker daemon running?)" >&2
  exit 3
fi

if sudo -n iptables -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null; then
  echo "ok: DOCKER-USER IMDS drop rule already present"
else
  sudo -n iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j DROP
  echo "installed: DOCKER-USER -d 169.254.169.254/32 -j DROP"
fi

sudo -n iptables -nL DOCKER-USER | sed -n '1,5p'
