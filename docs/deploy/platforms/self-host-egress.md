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

## Sandbox backend: containment (`OE_SANDBOX_BACKEND`)

Off Vercel the agent's shell runs in one of two backends. **`docker()` is the default** and the
only one fit for a real deployment:

> [!WARNING]
> **`justbash` shares the app process's filesystem — dev/testing ONLY.** The `justbash()`
> backend runs the agent's shell in-process, so the agent can read and write the **app's own
> files, its container, and the host OS** — there is no filesystem boundary. It emits a loud
> boot warning for exactly this reason. Never front a real deployment with it. It exists because
> it runs the full e2e pack with zero extra privilege (no daemon, no image); egress still routes
> through the proxy (Tier A host allow/deny), but it has no real `git`/`npm` binaries so Tier B
> credentialed clone can't be exercised there.

- **`docker()` (default) — the contained tier.** The agent runs in a sibling container confined
  to a **limited, per-session filesystem (its workspace)** — never the app's fs or the host OS.
  Egress is forced through the proxy sidecar (Tier A + Tier B), and it has real `git`/`npm` for
  the credentialed checkout path. Honest trade-off: it needs the Docker **daemon socket** mounted
  into the app (Docker-out-of-Docker), so an app compromise is effectively a host compromise —
  run it only with a trusted runner. The end-to-end **checkout-on-docker** path (mid-turn broker
  `pushEgressPolicy` + a real `git clone` with the token injected at the firewall) is still
  **live-pending** — see [`deploy/egress-proxy/README.md`](../../../deploy/egress-proxy/README.md)
  ("Still live-pending").
- **`justbash` (dev opt-in) — set `OE_SANDBOX_BACKEND=justbash` explicitly.** Uncontained (see
  the warning above). Unknown `OE_SANDBOX_BACKEND` values fail loudly at boot.

The bundled `docker-compose.yml` pins `justbash` for the **local egress dev run** (fast, no
daemon socket); flip it to `docker` and uncomment the socket mount for the contained tier.

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
(`packages/core/agent/access/platform.ts`): `OE_PLATFORM` if set, else Vercel's own `VERCEL` env,
else `self-host`. Off Vercel it selects both the self-host sandbox backend and the self-host
egress push. `OE_EGRESS_PROXY_URL` then decides the posture: set ⇒ enforced; unset ⇒ fail-closed
(any session resolving a host allow-list aborts at `session.started`) — **unless**
`egress.allowUnenforced: true` is declared, which runs the agent with no network firewall at all
and a loud boot warning.

### The two proxy variables

| Variable | What it does |
| --- | --- |
| `OE_EGRESS_PROXY_URL` | The proxy control endpoint the app pushes each compiled policy to, and **the thing that arms this tier**. `docker-compose.yml` sets it for you. |
| `OE_EGRESS_PROXY_TOKEN` | The bearer token the push carries. |

`useSelfHostEgress()` is true only **off Vercel and with the URL set**; every other case keeps the
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
| `OE_EGRESS_DENIAL_POLL_MS` | Poll interval, default `60000`, floored at 5000. One row per host per interval, with a count — a crash-looping worker writes one row a minute, not a thousand. |

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
