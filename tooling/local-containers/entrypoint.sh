#!/bin/sh
# L3 — GEB
# Input: Miniflare proxy arguments and the sidecar network namespace.
# Output: The original egress proxy with Docker bridge control traffic preserved.
# Pos: [Map](../L2.md); local Containers compatibility entrypoint.
# Effects/Dependencies: Adjusts only this sidecar's mangle table; no host firewall changes.
set -u

bridge_cidr=
expect_cidr=false
for argument in "$@"; do
  if [ "$expect_cidr" = true ]; then
    bridge_cidr=$argument
    expect_cidr=false
  fi
  case "$argument" in
    --docker-gateway-cidr) expect_cidr=true ;;
    --docker-gateway-cidr=*) bridge_cidr=${argument#*=} ;;
  esac
done
case "$bridge_cidr" in
  ''|*[!0-9./]*) exec /proxy-everything "$@" ;;
esac

/proxy-everything "$@" &
proxy_pid=$!
forward_signal() { kill -TERM "$proxy_pid" 2>/dev/null || :; }
trap forward_signal INT TERM

attempt=0
while kill -0 "$proxy_pid" 2>/dev/null && [ "$attempt" -lt 100 ]; do
  if iptables -t mangle -C PREROUTING -p tcp -m socket -j DIVERT 2>/dev/null; then
    if iptables -t mangle -C PREROUTING -s "$bridge_cidr" -d "$bridge_cidr" -j RETURN 2>/dev/null ||
      iptables -t mangle -I PREROUTING 1 -s "$bridge_cidr" -d "$bridge_cidr" -j RETURN; then
      printf '[local-containers] Docker bridge bypass ready: %s\n' "$bridge_cidr"
    fi
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done

status=0
wait "$proxy_pid" || status=$?
trap '' INT TERM
wait "$proxy_pid" 2>/dev/null || :
exit "$status"
