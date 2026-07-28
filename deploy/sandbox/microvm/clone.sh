#!/bin/bash
# Create/destroy a restored preview-VM clone in its own network namespace.
# Every clone wakes from the golden snapshot believing it is 172.16.100.2
# behind tap bkstap0 — a private netns per clone makes that true for all of
# them at once. Host reaches the guest via the veth: 10.200.<idx>.2 with
# ports DNAT'd into the guest (3300 dev, 8080 agent, 8081 root agent).
#
#   clone.sh create <idx> <pool-dir>   # prints CLONE_IP=10.200.<idx>.1 lines
#   clone.sh destroy <idx> <pool-dir>
#
# Layout per clone (under <pool-dir>): clone<idx>.ext4 (COW/sparse copy of
# golden.ext4), fc-clone<idx>.sock|log. The firecracker process runs inside
# netns bksns<idx> + a private mount ns binding the clone disk over the
# golden path (the vmstate references the golden's absolute path).
# Run as root.
set -euo pipefail
CMD="$1"; IDX="$2"; POOL="${3:-/opt/firecracker/store}"
NS="bksns$IDX"
VETH_H="bksveth${IDX}h"; VETH_N="bksveth${IDX}n"
HOST_IP="10.200.$IDX.1"; NS_IP="10.200.$IDX.2"
GUEST_IP="172.16.100.2"; TAP_HOST_IP="172.16.100.1"
API="$POOL/fc-clone$IDX.sock"; DISK="$POOL/clone$IDX.ext4"; LOG="$POOL/fc-clone$IDX.log"
FC=/opt/firecracker/firecracker

destroy() {
  # The scope is the process handle — no pkill patterns (a -f pattern once
  # matched the INVOKER's own command text and killed the calling shell).
  systemctl stop "bks-fc-clone$IDX" 2>/dev/null || true
  sleep 0.3
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_H" 2>/dev/null || true
  rm -f "$DISK" "$API" "$LOG"
}

if [ "$CMD" = "destroy" ]; then destroy; echo "destroyed clone $IDX"; exit 0; fi
[ "$CMD" = "create" ] || { echo "usage: clone.sh create|destroy <idx> [pool-dir]"; exit 2; }

# A golden refresh temporarily swaps the canonical disk before producing its
# matching memory/vmstate. Never let a clone observe a mixed generation.
exec 9>"$POOL/.refresh.lock"
flock -s 9

# Never destroy-first: a concurrent caller re-using a live index must FAIL,
# not silently kill the running VM (a claim's VM died mid-converge to a
# racing sweep spawn before this guard).
if systemctl is-active --quiet "bks-fc-clone$IDX" 2>/dev/null; then
  echo "index $IDX already has a live VM — pick another" >&2
  exit 3
fi
destroy 2>/dev/null || true

# COW disk: reflink when the store supports it (XFS), sparse copy otherwise.
cp --reflink=auto --sparse=always "$POOL/golden.ext4" "$DISK"

# netns + veth + in-ns tap with the exact name/subnet the snapshot expects.
ip netns add "$NS"
ip link add "$VETH_H" type veth peer name "$VETH_N"
ip link set "$VETH_N" netns "$NS"
ip addr replace "$HOST_IP/30" dev "$VETH_H"; ip link set "$VETH_H" up
ip netns exec "$NS" ip addr add "$NS_IP/30" dev "$VETH_N"
ip netns exec "$NS" ip link set "$VETH_N" up
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip tuntap add dev bkstap0 mode tap
ip netns exec "$NS" ip addr add "$TAP_HOST_IP/30" dev bkstap0
ip netns exec "$NS" ip link set bkstap0 up
ip netns exec "$NS" ip route add default via "$HOST_IP"
# in-ns NAT: host->veth traffic lands on the guest; guest egress masquerades.
ip netns exec "$NS" sysctl -qw net.ipv4.ip_forward=1
for p in 3300 8080 8081; do
  ip netns exec "$NS" iptables -t nat -A PREROUTING -d "$NS_IP" -p tcp --dport $p -j DNAT --to-destination "$GUEST_IP:$p"
done
ip netns exec "$NS" iptables -t nat -A POSTROUTING -o "$VETH_N" -j MASQUERADE
ip netns exec "$NS" iptables -t nat -A POSTROUTING -o bkstap0 -j MASQUERADE
# host side: let the clone subnet egress (IMDS stays blocked by setup-net's rule)
sysctl -qw net.ipv4.ip_forward=1
OUT_IF=$(ip route show default | awk '{print $5; exit}')
iptables -t nat -C POSTROUTING -s "10.200.$IDX.0/30" -o "$OUT_IF" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "10.200.$IDX.0/30" -o "$OUT_IF" -j MASQUERADE
iptables -C FORWARD -s "10.200.$IDX.0/30" -d 169.254.169.254 -j DROP 2>/dev/null \
  || iptables -I FORWARD 1 -s "10.200.$IDX.0/30" -d 169.254.169.254 -j DROP
iptables -C FORWARD -s "10.200.$IDX.0/30" -j ACCEPT 2>/dev/null || iptables -A FORWARD -s "10.200.$IDX.0/30" -j ACCEPT
iptables -C FORWARD -d "10.200.$IDX.0/30" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
  || iptables -A FORWARD -d "10.200.$IDX.0/30" -m state --state RELATED,ESTABLISHED -j ACCEPT

# pre-fault the memory file into host page cache: restores then fault against
# RAM, not EBS ("restored VM feels native immediately"). No-op when cached.
cat "$POOL/golden.mem" > /dev/null 2>&1 || true

# firecracker inside netns + private mountns (clone disk over the golden
# path), detached into its own transient systemd scope — clone VMs must
# OUTLIVE whoever spawned them (previews died on every opensession restart
# while FCs were children of the service cgroup; same fix as the detached
# opencode servers).
systemd-run --collect --unit "bks-fc-clone$IDX" \
  bash -c "exec ip netns exec '$NS' unshare -m bash -c \"mount --bind '$DISK' '$POOL/golden.ext4' && exec '$FC' --api-sock '$API'\" > '$LOG' 2>&1"
for i in $(seq 1 80); do [ -S "$API" ] && break; sleep 0.1; done
[ -S "$API" ] || { echo "firecracker api socket never appeared" >&2; destroy; exit 1; }

LOAD=$(curl -s --unix-socket "$API" -X PUT http://x/snapshot/load -H 'Content-Type: application/json' \
  -d "{\"snapshot_path\":\"$POOL/golden.vmstate\",\"mem_backend\":{\"backend_type\":\"File\",\"backend_path\":\"$POOL/golden.mem\"},\"resume_vm\":true}")
if echo "$LOAD" | grep -q fault_message; then
  echo "SNAPSHOT LOAD FAILED: $LOAD" >&2
  destroy
  exit 1
fi

# clock resync + boot-log truncate via the root agent (SigV4 needs <5min skew)
NOW=$(date -u +%s)
for i in $(seq 1 30); do
  R=$(curl -s -m 3 -X POST "http://$NS_IP:8081/exec" -H 'Content-Type: application/json' \
    -d "{\"command\":\"date -u -s @$NOW && echo resynced\",\"timeoutMs\":5000}" 2>/dev/null | grep -c resynced || true)
  [ "$R" = "1" ] && break; sleep 0.5
done

echo "CLONE_IDX=$IDX"
echo "CLONE_IP=$NS_IP"
echo "CLONE_API=$API"
