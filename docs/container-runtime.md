# Local container runtime

Commerce uses Podman for Dev, browser/E2E checks, and authorized Sandbox image builds.
No Docker executable, Docker Desktop, or Docker Engine is required. OCI image registry
names and the existing Dockerfile input remain unchanged.

On macOS install Podman, initialize a machine once, and start it only when needed:

```sh
brew install podman
podman machine init --cpus 2 --memory 4096 --disk-size 30
podman machine start
MINIFLARE_WORKERD_PATH=/absolute/path/to/verified/workerd npm run dev
# After the owned workload has closed:
podman machine stop
```

For a named machine set `AGENTIC_PODMAN_MACHINE`. Linux uses the local rootless Podman
service (`systemctl --user start podman.socket`). An explicit `CONTAINER_HOST` must
name a local Unix socket. Windows named pipes are not validated by this adapter.
The adapter binds Podman CLI and Miniflare to that same socket. `DOCKER_HOST` and
`WRANGLER_DOCKER_BIN` are Cloudflare compatibility settings, not Docker dependencies.

Wrangler 4.127.1 emits `--provenance=false`, which Podman rejects. The small executable
adapter removes only that disabled build option; other arguments and native failures
remain intact. No SDK source is patched. Remove this translation when the pinned
Wrangler supports Podman builds directly. See
[Cloudflare's upstream issue](https://github.com/cloudflare/workers-sdk/issues/9755).

`npm run check:integration` runs product suites where their source lives. Browser
validation retains bounded event capture, exclusive runtime identity locking, and
exact main/proxy ownership proof before cleanup. A local passing checkout loop does
not supply independent evaluator context or authorize a production deployment.

## Runtime compatibility

The workerd installed by Wrangler 4.127.1 emits an unset memory-swappiness value,
which Podman/crun rejects under cgroup v2 before the Sandbox proxy starts. The
source fix in [workerd#7270](https://github.com/cloudflare/workerd/pull/7270) omits
an unset value while preserving explicit values.

CI uses the Linux binary from
[fork source `649aa72a91e4`](https://github.com/huijoohwee/workerd/releases/tag/podman-649aa72a91e4),
verified against pinned archive and binary SHA-256 values in the workflow. Local
checks require a matching-platform binary verified against its build receipt and
checksums before setting `MINIFLARE_WORKERD_PATH` to its absolute path. Miniflare's
existing override selects that runtime without editing installed packages.

Podman 4.9 exposes a Go timestamp in event templates; newer versions expose integer
nanoseconds. The event template selects the native representation while preserving
nanosecond ordering and exact ownership checks. Container inspect templates use
the native `ID` field; the Docker `Id` alias is only normalized for a bare template
on Podman 4.9 and fails inside `json`. Native command failures retain bounded stderr
so compatibility errors remain diagnosable. Reference source:
[4.9 events](https://github.com/containers/podman/blob/v4.9.3/libpod/events/config.go),
[5.8 events](https://github.com/containers/podman/blob/v5.8.3/cmd/podman/system/events.go).

Require the complete `check:integration` result, including paid Dev flow and owned
runtime cleanup, before protected merge. Independent external provider/evaluator
proof and the local Node-only Canvas provider have separate release boundaries.
