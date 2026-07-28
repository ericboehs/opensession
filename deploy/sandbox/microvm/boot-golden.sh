#!/bin/bash
# Boot the golden preview microVM (P1 manual test / golden-snapshot source).
# Usage: boot-golden.sh <rootfs.ext4> [api-sock] [tap] [guest-ip/30-host-ip]
set -euo pipefail
FC=/opt/firecracker/firecracker
KERNEL=/opt/firecracker/vmlinux
ROOTFS="$1"
API="${2:-/tmp/fc-golden.sock}"
TAP="${3:-bkstap0}"
HOST_IP="${4:-172.16.100.1}"
GUEST_IP="${5:-172.16.100.2}"
LOG="${API%.sock}.log"

sudo bash "$(dirname "$0")/setup-net.sh" "$TAP" "$HOST_IP/30"
rm -f "$API"
"$FC" --api-sock "$API" > "$LOG" 2>&1 &
FC_PID=$!
[ -n "${BKS_FIRECRACKER_PID_FILE:-}" ] && printf '%s\n' "$FC_PID" > "$BKS_FIRECRACKER_PID_FILE"
echo "firecracker pid $FC_PID (api $API, serial log $LOG)"
sleep 0.3
fc() { curl -s --unix-socket "$API" -X "$1" "http://x$2" -H 'Content-Type: application/json' -d "$3"; }
fc PUT /boot-source "{\"kernel_image_path\":\"$KERNEL\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 pci=off init=/sbin/bks-init ip=$GUEST_IP::$HOST_IP:255.255.255.252::eth0:off\"}"
fc PUT /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$ROOTFS\",\"is_root_device\":true,\"is_read_only\":false}"
fc PUT /network-interfaces/eth0 "{\"iface_id\":\"eth0\",\"guest_mac\":\"06:00:AC:10:64:02\",\"host_dev_name\":\"$TAP\"}"
fc PUT /machine-config '{"vcpu_count":4,"mem_size_mib":12288}'
fc PUT /actions '{"action_type":"InstanceStart"}'
echo "started — guest at $GUEST_IP (dev :3300, agent :8080); serial: tail -f $LOG"
