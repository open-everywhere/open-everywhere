# Self-host with enforced egress (Vercel-less)

Open Everywhere's egress firewall (default-deny + credential injection) is applied by the
**Vercel Sandbox** in the reference deploy. Off Vercel, the `justbash()`/`docker()` sandbox
backends can't apply that fine-grained policy — so this stack restores enforcement with a
**forced local egress proxy**: the app runs on an internal-only Docker network with no route
to the internet except through the proxy, and the same compiled policy the agent resolves is
pushed to the proxy and enforced there.

Two tiers:

- **Tier A (default)** — the proxy allows/denies each connection by destination host
  (SNI/CONNECT), no TLS decryption. Restores the exfiltration backstop.
- **Tier B (`OE_EGRESS_MITM=1`)** — the proxy terminates TLS with a local CA, enabling
  method/path narrowing and **credential injection at the firewall** (git read-broker token
  never enters the sandbox) — full parity with the Vercel path.

<a id="sandbox-backend-containment-oe_sandbox_backend"></a>

## Sandbox backend: containment (`sandbox.selfHostBackend`)

Off Vercel the agent's shell runs in one of two backends. The setting `sandbox.selfHostBackend` in
the app's `agent/settings/settings.ts` picks it (it was `OE_SANDBOX_BACKEND` until OPE-2411). **Today only `justbash` runs behind this
proxy**, and it is development grade. The `docker()` backend contains the filesystem, but its
session containers sit outside the proxy (below), so no Docker configuration gives both a
contained filesystem and enforced egress yet (OPE-2407).

| Backend | Runs in the shipped image | Session egress behind the proxy | Filesystem |
| --- | --- | --- | --- |
| `justbash` (what an app in the image declares) | Yes | Yes | shared with the app process |
| `docker()` (the code's default off Vercel) | No: the image carries a just-bash template only | No: the app refuses to boot on `docker` with `OE_EGRESS_PROXY_URL` set | a per-session container |

> [!WARNING]
> **`justbash` shares the app process's filesystem — dev/testing ONLY.** The `justbash()`
> backend runs the agent's shell in-process, so the agent can read and write the **app's own
> files, its container, and the host OS** — there is no filesystem boundary. It emits a loud
> boot warning for exactly this reason. Never front a real deployment with it. It exists because
> it runs the full e2e pack with zero extra privilege (no daemon, no image); egress still routes
> through the proxy (Tier A host allow/deny), but it has no real `git`/`npm` binaries so Tier B
> credentialed clone can't be exercised there.

- **`docker()` (the code's default off Vercel) — contained, but NOT behind this proxy.** The agent
  runs in a sibling container confined to a **limited, per-session filesystem (its workspace)**,
  with real `git`/`npm`. It needs the Docker **daemon socket** mounted into the app
  (Docker-out-of-Docker), so an app compromise is effectively a host compromise. 🔴 Its egress is
  **not** enforced by the proxy: eve starts each session container with no `--network` flag, so it
  joins the daemon's default bridge network (a direct WAN route, no proxy env), and eve's docker
  options expose no network field. With the proxy wired, the policy would go to the proxy and never
  reach the container, while the audit recorded "enforced". So the app **refuses to boot** with
  `sandbox.selfHostBackend: "docker"` and `OE_EGRESS_PROXY_URL` set. Without the proxy, docker applies only
  the coarse `"deny-all"`, and a session that needs a host allow-list aborts at `session.started`.
  The shipped image cannot run it either: eve 0.71 provisions sandbox templates at build time, and
  the build stage has no daemon, so the image carries a just-bash template only.
- **`justbash` — the only backend behind this proxy.** Uncontained (see the warning above). Its
  egress leaves through the app process, so the proxy holds every session request to the session's
  allow list. Settings load refuses any other `sandbox.selfHostBackend` value at boot.

The bundled `docker-compose.yml` runs `justbash`, because this repository's root app declares
`sandbox: { selfHostBackend: "justbash" }`. Compose sets no backend variable. An app built into the
Docker image must declare `"justbash"` too.

## The app's own model call: the host plane (OPE-2406)

Under `justbash` the app process and the session send from the same source IP, so the proxy cannot
tell them apart by address. The app's model call therefore carries the proxy token as
`Proxy-Authorization: Bearer <OE_EGRESS_PROXY_TOKEN>`, and the proxy decides it against a separate
**host plane** that names the model gateway host (`ai-gateway.vercel.sh`, or the host of
`OE_AI_GATEWAY_URL`), plus the hosts of any non-gateway transcription route the app registers for the
meeting bot (`api.deepinfra.com`, a self-hosted speech server; OPE-2470). The app keeps one host list
and pushes it whole, because the proxy replaces its host plane on every push. A request without the credential is a session request, held to the session's
compiled policy, which never needs to name the gateway. Under Tier B the credentialed CONNECT is
spliced at step 1, so the model call is never decrypted (a bumped request would lose the header).
A failed session compile still pushes
`deny-all`, and that now cuts the session only, not the model call. The full boundary, and how far
it holds, is in [`deploy/egress-proxy/README.md`](../../../deploy/egress-proxy/README.md)
("Two principals").

## Host-side fetches route through the proxy too — with one exception

A few tools reach the network from the **app process** rather than from the sandbox, so the proxy
is their transport as well as the sandbox's. Because the app container has no WAN route at all,
"skips the proxy" there is not a weaker request, it is a **failed** one.

- **`describe_image`'s `kind: "url"` source** (and every other fetch Open Everywhere dispatches itself,
  including the Slack `url_private` attachment download) reads `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`
  and dispatches through the proxy. Note `NODE_USE_ENV_PROXY=1` alone is *not* what does this — that
  env only affects Node's global dispatcher, and these calls pass an explicit one.
- **`web_fetch` does not**, and fails at the transport on this stack even for an allow-listed host.
  Its dispatch belongs to the framework, which supplies its own dispatcher; the failure is closed,
  and the sandbox's `curl` (which does go through the proxy) is the workaround.

On Vercel these fetches resolve the destination, refuse private/loopback/link-local addresses and
pin the socket to the validated IP. A forward proxy resolves the `CONNECT` hostname itself, so that
pin cannot apply here and the anti-rebind property is **delegated to the proxy's default-deny ACL**.
Every audited allow row records which posture held, so the trail never overstates it.

## Quick start

```sh
cp .env.example .env    # AI_GATEWAY_API_KEY, SLACK_* … (leave `egress.allowUnenforced` off)
docker compose up --build
```

`docker-compose.yml` wires four services — `app` (internal-only, no WAN), `oe-egress-proxy` (the
sole WAN route), a `postgres` sidecar (the docker-tier operational-store default) and
`neon-wsproxy` (the WebSocket bridge the Neon driver needs to reach it) — plus a memory volume.
The Discord relay is a commented option. The one "am I on Vercel?" seam is `platformName()`
(`packages/core/agent/access/platform.ts`): Vercel's own `VERCEL` env, else `self-host`. No
operator override exists (`OE_PLATFORM` was one until OPE-2411). Off Vercel, and with
`sandbox.useVercelSandbox` off, the app selects both the self-host sandbox backend and the
self-host egress push. `OE_EGRESS_PROXY_URL` then decides the posture: set ⇒ enforced; unset ⇒ fail-closed
(any session resolving a host allow-list aborts at `session.started`) — **unless**
`egress.allowUnenforced: true` is declared, which runs the agent with no network firewall at all
and a loud boot warning.

### The two proxy variables

| Variable | What it does |
| --- | --- |
| `OE_EGRESS_PROXY_URL` | The proxy control endpoint the app pushes each compiled policy to, and **the thing that arms this tier**. `docker-compose.yml` sets it for you. |
| `OE_EGRESS_PROXY_TOKEN` | The bearer token the push carries. |

`useSelfHostEgress()` is true only **off the Vercel Sandbox and with the URL set**; every other case keeps the
sandbox backend's own network-policy call. With the URL unset, a session that resolves a host
allow-list aborts unless `egress.allowUnenforced` is declared.

**An unset token still fails closed.** The push simply carries no authorisation header, the proxy
control service rejects it, the push throws, and the session aborts — so a missing token is a refused
session rather than an unauthenticated policy write. Generate one with `openssl rand -hex 32`.

Both variables are read in one module (`packages/core/agent/access/self-host-egress.ts`), and the push
throws a named error when the URL is unset, so a mis-wired deployment fails at the push rather than
quietly running with no policy.

## Denials are visible here (and only here)

The docker tier is the one topology where Open Everywhere owns the firewall, so it is the one
where a **blocked request** — not merely the policy that blocked it — reaches the audit log.

Squid writes a second, deliberately minimal access log into a volume the proxy mounts read-write
and the app mounts **read-only** (`oe-egress-log`). The app tails it and appends one
`egress.denied` audit row per denied host per poll window, which
[permission homeostasis](../../security/permission-homeostasis.md)'s widening loop reads as
evidence — *"this scope was denied `registry.example.com` 7 times across 2 windows; here is where
to grant it"*. On Vercel none of this exists: the sandbox host's firewall is not ours, it emits no
log, and the individual attempt is never observed.

**What crosses the volume, and what deliberately does not.** The log line is three fields —
timestamp, Squid's result tag, and the request **domain**. No path, no query string, no method, no
client address, no bytes, no proxy user. That is enforced twice over: `logformat oe_deny` in
[`deploy/egress-proxy/squid.conf`](../../../deploy/egress-proxy/squid.conf) never writes them, and
the reader (`packages/core/agent/access/egress-denial-log.ts`) truncates any value it is given at
the first `/`, `?` or `#`, strips `user:pass@` userinfo and the port, and drops anything that does
not then match a strict hostname. This matters most under Tier B, where Squid has *decrypted* the
request and the conventional log format would carry the full URL.

There is **no new port and no new credential** — the app only ever reads a file. Two knobs, both
set by `docker-compose.yml`:

| Var | Meaning |
|---|---|
| `OE_EGRESS_DENIAL_LOG` | Path to the denial log (`/var/log/oe-egress/denied.log`). **Unset ⇒ the poller does not run**, which is the Vercel case and any self-host run without the volume. |

The poll interval is one minute, a code constant (OPE-2411). The app writes one row per host per
interval, with a count, so a crash-looping worker writes one row a minute, not a thousand.

Fail-quiet by requirement: a missing, unreadable or rotated log degrades to doing nothing, says so
**once**, and never touches the turn. A denial seen before this process has applied any policy is
dropped rather than attributed to an org that cannot be known — the plane simply stays as dark as
it is on Vercel.

⚠ **Live-pending.** The Squid side of this (the `%>rd` format code and the `http_status 403` log
ACL) has not been exercised against a running Squid yet; the reducer, the aggregation, the tailing
arithmetic and every fail-quiet path are unit-proven (from `packages/core`:
`npm run test:egress-denial-log`, 71 assertions). Verify it alongside the exfil-reset check in the proxy README's live-verification
list: deny a host, then confirm a line appears in `denied.log` **and** an `egress.denied` row
appears in the audit log.

## Full runbook + live-verification steps

See **[`deploy/egress-proxy/README.md`](../../../deploy/egress-proxy/README.md)** — it covers
the env, Tier B CA install + client-compat caveats, and the live-verification checklist
(a turn enforced through the proxy, a Tier B git clone with the injected credential, an exfil
attempt reset) that proves the stack, plus exactly what is unit-proven vs live-pending.

## Relationship to the other self-host docs

- [`self-roll.md`](./self-roll.md) — the general "bring your own host" table (stores,
  scheduler, durable sessions). This page is the **egress-enforcement** piece it flagged as
  UNVERIFIED for non-Vercel backends.
- [`comparison.md`](./comparison.md) — backend trade-offs. Eve's `microsandbox()` enforces only
  host-grain allow/deny natively on a `/dev/kvm` host — credential injection and `match` narrowing
  are measured gaps (OPE-917) — and Open Everywhere does not wire it as a selectable backend.
