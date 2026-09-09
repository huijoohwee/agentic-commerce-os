# Device-session execution host

## Adopted availability decision

For the current MVP, server-side execution may stop when the operator's Mac is
asleep, offline, or the host process is stopped. Availability independent of that
Mac is a future roadmap requirement. The public browser and execution host have
separate availability; a successful static page response does not imply that a
job can execute.

## Current runtime

`npm run build:local-host` builds the Node host from the existing sandbox harness,
request validator, server-owned execution identity allocator, and direct Podman
executor. The build uses Wrangler's locked esbuild dependency, adds no runtime
package, and enforces a 500,000-byte bundle ceiling. It does not modify a Cloudflare
Worker, create a tunnel, install a daemon, start a VM, pull an image, or grant
production release authority.

The host listens exclusively on `127.0.0.1`. Every route requires its separate
64-hex-character bearer credential, including liveness. Browser Origin headers,
foreign Host headers, and content encodings are refused. There is no CORS grant
or browser token handoff. The credential file must be owned by the running user,
have no group/other access, contain only the credential and an optional final LF,
and be a regular file opened without following a symlink. Do not reuse operator,
checkout, discovery, or provider credentials.

| Route | Behavior |
| --- | --- |
| `GET /livez` | Authenticated host-process liveness; availability is `device-session`. |
| `GET /readyz` | Fresh isolated Node-version probe; returns 503 if unavailable or busy. Reports the image and host bundle digests. |
| `POST /v1/run` | Existing sandbox request/result contract; allocates a server-owned execution ID. |

The host accepts one active operation and no queue. Concurrent callers receive
503 and `Retry-After: 1`; the caller must decide whether a new attempt is valid.
It bounds body/output to 1,000,000 bytes, body reads to five seconds, incoming
connections to eight, headers to 8 KiB, and jobs to the existing sandbox limits.
The underlying container has no host mounts, credentials, network, or capabilities.
Client disconnect and graceful shutdown terminate the active executor and await
its cleanup. A failed executor operation that leaves runtime state uncertain
locks the host against further work until the operator investigates and restarts
it. Liveness remains distinct from readiness.

The host never caches a successful readiness result or accepts a caller's chosen
runtime identity. It returns explicit errors when it cannot execute; it does not
queue work invisibly during sleep or claim that requests will complete offline.

## Start and stop

Use the exact Node image already resolved from `config/sandbox.Dockerfile`. Start
the owning Podman machine when needed, and obtain its existing immutable image ID.
The startup probe checks Node v22.22.3 and the runner checks rootless Linux,
seccomp, cgroup v2 controllers and conmon compatibility before accepting work.
The command never downloads an image as a side effect.

Create a private credential once, outside the checkout. For example, with
`COMMERCE_HOST_TOKEN_FILE` set to a new absolute path in a private directory:

```sh
node --input-type=module -e 'import fs from "node:fs"; import {randomBytes} from "node:crypto"; fs.writeFileSync(process.env.COMMERCE_HOST_TOKEN_FILE, randomBytes(32).toString("hex")+"\n", {mode:0o600,flag:"wx"})'
npm run build:local-host
npm run start:local-host -- \
  --token-file="$COMMERCE_HOST_TOKEN_FILE" \
  --podman="$AG_PODMAN_EXECUTABLE" \
  --image-id="$AG_PODMAN_IMAGE_ID" \
  --port=5191
```

The startup line reports the loopback origin, never the credential. SIGINT or
SIGTERM closes the listener and cancels active work. Readiness is authenticated;
check it with an operator client that loads the credential file without printing
it or placing the credential in a browser URL, shell history, or process arguments.
Restart the service after rebuilding: a running service retains its loaded bundle.

`npm run check:local-host` runs the real compiled CLI against the supplied Podman
image. CI runs it immediately after the existing direct isolation checks. It
verifies authentication, host-file denial during a real registration run,
server-owned IDs, cancellation/recovery, and listener shutdown. Unit tests cover
malformed/oversized requests, authority boundaries, concurrency, failed readiness,
uncertain-runtime refusal and partial-upload shutdown.

## Production composition and roadmap

Production and Staging use a private Worker relay over authenticated HTTPS.
Configure its protected `EXECUTION_HOST_PINS_JSON` and dedicated
`EXECUTION_HOST_BEARER_TOKEN`; never expose the credential to the browser.
The relay requires `commerce.local-execution-host/v2` and sends both
`x-commerce-host-bundle-sha256` and `x-commerce-host-image-id` on each request.
The host checks those pins before execution and rejects a mismatch or partial
pair with HTTP 409. Unpinned authenticated local clients remain supported.

The source-owned controller records fresh host identity and availability instead
of a Cloudflare Container rollout. Dev retains its existing local four-Worker
sandbox fixture. See [Production runtime contract](production-runtime.md) for
release, recovery and evidence requirements. A running host or tunnel alone is
not a production deployment receipt.

For the current phase, that transport must show executor unavailability when
this Mac sleeps or disconnects. It must not automatically replay a checkout.
For the future phase, move the same isolation contract to an independently
available Free/FOSS host, add supervised startup and authenticated transport,
durable idempotent scheduling, host lease/fence ownership, stale-result rejection,
health monitoring and tested recovery. Accept always-on readiness only after
execution succeeds with this Mac disconnected. This roadmap makes no current
24/7 or uptime claim.
