#!/bin/sh
# L3 — GEB
# Input: Wrangler Docker arguments and the locally built egress image.
# Output: Real Docker operations with local-only image resolution for the compatibility sidecar.
# Pos: [Map](../L2.md); Wrangler Docker CLI adapter.
# Effects/Dependencies: Uses the existing Docker engine; no registry publication or host configuration changes.
set -eu
docker_bin=${HANEOKA_DOCKER_BIN:-docker}
if [ "${1-}" = pull ] && [ "${2-}" = haneoka-local-egress:bridge-bypass-v1 ] &&
  "$docker_bin" image inspect "$2" >/dev/null 2>&1; then
  exit 0
fi
exec "$docker_bin" "$@"
