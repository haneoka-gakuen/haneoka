#!/bin/sh
# Forced command for the CI deploy key: replaces the collector source with the
# tarball on stdin and rebuilds; .env and the egress config stay on the host.
set -eu
base=/opt/haneoka-collector
stage=$(mktemp -d "$base/stage.XXXXXX")
trap 'rm -rf "$stage"' EXIT
head -c 67108864 | tar -xzf - -C "$stage"
test -f "$stage/cloud.py" && test -f "$stage/deploy/compose.yaml" && test -f "$stage/host/main.mjs"
cp -p "$base/app/deploy/.env" "$stage/deploy/.env"
cp -p "$base/host.env" "$stage/deploy/host.env"
ln -sfn "$base/egress" "$stage/deploy/egress"
docker compose -f "$stage/deploy/compose.yaml" --project-directory "$stage/deploy" build -q collector host
rm -rf "$base/previous" && mv "$base/app" "$base/previous" && mv "$stage" "$base/app"
trap - EXIT
cd "$base/app/deploy"
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
sleep 5
docker compose exec -T collector python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=10).read().decode())"
