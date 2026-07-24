#!/bin/bash
# Host-side network for preview microVMs: one /30 tap per VM + NAT egress.
# Usage: setup-net.sh <tap-name> <host-cidr e.g. 172.16.100.1/30>
# Idempotent; run under sudo. NOT persisted across host reboots (the pool
# re-creates taps when it respawns VMs).
set -euo pipefail
TAP="$1"; CIDR="$2"
ip link show "$TAP" >/dev/null 2>&1 || ip tuntap add dev "$TAP" mode tap user ubuntu
ip addr replace "$CIDR" dev "$TAP"
ip link set "$TAP" up
sysctl -qw net.ipv4.ip_forward=1
OUT_IF=$(ip route show default | awk '{print $5; exit}')
SUBNET=$(python3 -c "import ipaddress,sys; print(ipaddress.ip_interface('$CIDR').network)")
iptables -t nat -C POSTROUTING -s "$SUBNET" -o "$OUT_IF" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "$SUBNET" -o "$OUT_IF" -j MASQUERADE
iptables -C FORWARD -s "$SUBNET" -j ACCEPT 2>/dev/null || iptables -A FORWARD -s "$SUBNET" -j ACCEPT
iptables -C FORWARD -d "$SUBNET" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
  || iptables -A FORWARD -d "$SUBNET" -m state --state RELATED,ESTABLISHED -j ACCEPT
# Guests must never reach the cloud metadata service (same rule as docker).
iptables -C FORWARD -s "$SUBNET" -d 169.254.169.254 -j DROP 2>/dev/null \
  || iptables -I FORWARD 1 -s "$SUBNET" -d 169.254.169.254 -j DROP
echo "[setup-net] $TAP @ $CIDR ready (egress via $OUT_IF)"
