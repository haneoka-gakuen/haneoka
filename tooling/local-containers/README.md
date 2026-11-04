# Local Containers on recent Linux kernels

If Wrangler starts only a `-proxy` sidecar and reports `Container failed to
start`, inspect the sidecar's `mangle PREROUTING` rules. The `socket -> DIVERT`
rule can intercept Docker bridge control traffic before the application
container is created. This reproduces
[workerd #6794](https://github.com/cloudflare/workerd/pull/6794).

Build the pinned proxy image wrapper from the repository root:

```sh
docker build -t haneoka-local-egress:bridge-bypass-v1 tooling/local-containers
```

Start the existing development command with the local image override:

```sh
WRANGLER_DOCKER_BIN="$PWD/tooling/local-containers/docker.sh" \
MINIFLARE_CONTAINER_EGRESS_IMAGE=haneoka-local-egress:bridge-bypass-v1 pnpm dev:worker
```

Set `DOCKER_HOST` to the active engine socket when needed. The wrapper reads
the bridge CIDR supplied by Miniflare and places an idempotent bridge-to-bridge
`RETURN` before `DIVERT`. It changes only the sidecar network namespace, keeps
the original proxy arguments and forwards shutdown signals. It does not alter
the production Worker, application image or host firewall.

Wrangler unconditionally pulls its sidecar image during startup. The Docker
adapter resolves this one local image from the existing engine and forwards
all other operations to Docker. `HANEOKA_DOCKER_BIN` can select another Docker
CLI path. The compatibility image is never published to a registry.

Verification uses a normal image/video upload through the community API:
the workload container must start, retained media variants must appear, and
automatic moderation must complete. A successful standalone `docker run` alone
does not verify the Worker-to-container path. Remove the override when the
upstream fix is included in the installed runtime.
