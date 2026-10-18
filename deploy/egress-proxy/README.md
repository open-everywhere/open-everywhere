# Open Everywhere — self-host egress proxy (Tier A + Tier B)

A forced local egress proxy that restores Open Everywhere's **default-deny egress firewall**
when running **without Vercel Sandbox** (the `justbash()`/`docker()` backends can't apply
the fine-grained `setNetworkPolicy` that the Vercel firewall does). It is the sole container
with a route to the internet; the app reaches the outside world only through it.

**Only the `justbash` backend runs behind this proxy.** See "Which sandbox backend" below: the
`docker` backend's session containers sit outside it, so the app refuses to boot on that pair.

Two tiers:

| | Tier A (default) | Tier B (`OE_EGRESS_MITM=1`) |
|---|---|---|
| Decrypts TLS? | **No** | Yes (local CA) |
| Enforces | host allow/deny (SNI/CONNECT) | host + method/path narrowing + **credential injection** |
| Restores | exfiltration backstop (default-deny reach) | full Vercel parity ("secret never in-sandbox") |
| Needs | nothing | CA in the guest trust store; proxy-honoring clients |

## Two principals: the app and the session (OPE-2406)

Two different principals send traffic through this proxy, and they get different allow lists:

| Principal | What it is | How the proxy knows it | Allow list it is held to |
|---|---|---|---|
| **The app** | the app process's own model call (the gateway provider in `packages/adapters/agent/model/gateway.ts`), and the meeting bot's non-gateway transcription routes | the request carries `Proxy-Authorization: Bearer <OE_EGRESS_PROXY_TOKEN>` | the **host plane**: the model gateway host (`ai-gateway.vercel.sh`, or the host of `OE_AI_GATEWAY_URL`), plus the hosts of any non-gateway transcription route the app registers (OPE-2470). The app keeps one list and pushes it whole. |
| **The session** | the agent's sandboxed shell, plus the app's other host-side calls made on the session's behalf (Slack posts, connector calls, `oeFetch`) | no credential | the **session policy** the app compiles and pushes for its source IP, default-deny |

Under `justbash` both principals send from the **same source IP**, because the session runs
inside the app process. So the address cannot separate them; the credential does. The control
service (`control/handlers.ts` `handleAcl`) decides a credentialed request against the host plane
**only**, an uncredentialed one against the session policy **only**, and a request with a wrong
credential is denied. A credentialed request never falls through to the session policy.

**Why this does not widen what a session reaches.** A session request carries no credential, so
the host plane is never consulted for it: the session still cannot reach the model gateway unless
its own compiled policy names it. To add the credential, a session would need the token. The token
is the same one that authorises `POST /policy`, so a session that held it could already push
itself any policy: the host plane adds no new secret and no new reach. The host plane itself is
narrow by construction: the proxy accepts only a non-empty list of exact hosts (no `allow-all`, no
wildcard, no rule map, so no credential injection on this plane).

**How far "the session cannot read the token" holds.** The token lives in the app process's
environment. The repository's sandbox rating still says a `justbash` shell can read the app's
files and environment (the `sandbox-backend` contract entry, the justbash boot warning), and this
change does not alter that rating. One probe on this build found that eve's just-bash shell has a
virtual environment and a filesystem rooted in its session directory: it could not read
`/proc/self/environ`, follow a symlink out of its root, or see the app's variables through `$VAR`
or `env`. That probe covers those paths, not every path. The host-plane argument does not depend
on it: a session that reads the token could already push itself any policy through
`POST /policy`, before the host plane existed. So this boundary is as strong as the justbash
sandbox, and no stronger.

**Tier B (`OE_EGRESS_MITM=1`).** The credential rides only on the CONNECT. A bumped inner request
carries none, so `tier-b.conf` SPLICES a credentialed CONNECT at step 1 (`ssl_bump splice step1
oe_proxy_cred oe_allowed`): the model call is tunnelled, never decrypted. A live probe with a
Tier B proxy showed the credentialed gateway CONNECT as `TCP_TUNNEL/200`, and the same call denied
without the splice rule. A session request is still peeked and bumped as before. The splice
matches only a `Bearer <value>` header: a session CONNECT that sends `Proxy-Authorization: -`
(which the control service reads as "no credential") is bumped, not spliced. A live probe showed
it bumped with this rule, and tunnelled past Tier B's narrowing with a match-anything rule. The docker smoke
runs Tier A only.

**What changed for a failed compile.** When a session's policy fails to compile, the app still
pushes `deny-all` for the session. That now cuts the session only; the model call keeps working,
because it is decided against the host plane.

The app pushes the host plane (`POST /policy {"plane":"host","hostPlane":{"allow":[…]}}`) on its
first model call, and again after any failed call (a restarted proxy forgets it). Code:
`packages/core/agent/access/host-plane-egress.ts`.

**Rebuild the proxy with the app.** A proxy built before the host plane does not know `plane`. The
push carries its list in `hostPlane` and no `policy` field, so such a proxy answers 400 and the
model call fails closed. It never stores the gateway list as the app IP's session policy (a smoke
mutation run against the old proxy showed that a `policy`-shaped push would open the gateway to the
session). `docker compose up --build` rebuilds both.

**Still true:** the session policy is one policy per source IP. Under `justbash` every session
shares the app's IP, so two concurrent sessions overwrite each other's policy: the later push wins
for both. That is a known limit of the per-source keying, not changed here.

## Which sandbox backend (OPE-2407)

| Backend | Runs in the shipped image? | Session egress behind this proxy? | Isolation |
|---|---|---|---|
| `justbash` (**what an app in the image declares**) | **Yes** — the only template the image carries | **Yes** — its egress leaves through the app process, so the session policy applies to every request | the session **shares the app process's filesystem** (dev and testing grade; loud boot warning) |
| `docker` | **No** — eve 0.71 provisions templates at build time and the build stage has no daemon, so every sandbox step refuses (`Prepared sandbox artifact … belongs to provider "just-bash", not "docker"`) | **No** — eve starts each session container on the Docker daemon's default network (a direct WAN route, no proxy env), and its docker options expose no network field | a per-session container; needs the daemon socket, so app compromise ≈ host |

Because a docker session would be outside the proxy while the audit recorded "enforced", the app
**refuses to boot** with the setting `sandbox.selfHostBackend: "docker"` and `OE_EGRESS_PROXY_URL` set. Without the
proxy, docker applies only the coarse `"deny-all"` (a session that reaches nothing boots with no
network) and a session that needs a host allow-list aborts at `session.started` (fail-closed).

The app picks its backend from the setting `sandbox.selfHostBackend` in its
`agent/settings/settings.ts` (was `OE_SANDBOX_BACKEND` until OPE-2411). This repository's root app
declares `"justbash"`. An app built into this image must declare `"justbash"` too, because compose
sets no backend variable.

## What's in here

| File | Role | Proven |
|---|---|---|
| `control/acl.ts` | Pure ACL match + policy store (the enforcement decision) | **unit-tested** (`control/acl-test.ts`, 96 assertions) |
| `control/handlers.ts` | Pure policy-push + ACL-query handlers + the auth primitives | **unit-tested** (same file) |
| `control/server.ts` | HTTP control service (`POST /policy`, `GET /acl`, `/healthz`) | **process-tested** (`control/server-boot-test.ts`, 35 assertions — spawns the real service under `node --experimental-strip-types`: token-less boot refusal, the `/policy` bearer gate, the `/acl` loopback path, the host-plane credential path) |
| `control/helper.cjs` | Squid `external_acl_type` helper (per-request callout → control; forwards `Proxy-Authorization` for the host plane) | **live-verified** by `npm run test:docker-smoke` leg 2 |
| `squid.conf` / `tier-b.conf` | Tier A base / Tier B MITM overlay | **live-pending** (needs Squid + TLS) |
| the **denial log** (`logformat oe_deny` in `squid.conf` → `/var/log/oe-egress/denied.log`) | the only file the app reads back off this container: three fields (timestamp, result tag, **domain**) filtered to refusals | reducer/aggregation/tailing **unit-tested** (`packages/core/scripts/egress-denial-log-test.ts`, 71 assertions); the Squid half (`%>rd`, the `http_status 403` log ACL) is **live-pending** |
| `gen-ca.sh` / `install-ca.sh` | CA generation / guest-trust install (Tier B) | syntax-checked; **live-pending** |
| `entrypoint.sh` / `Dockerfile` | Container wiring | **live-pending** (needs Docker build) |

The TypeScript **seam** into the app (`useSelfHostEgress`/`pushEgressPolicy` in
`packages/core/agent/access/self-host-egress.ts`, wired into `hooks/egress.ts` and
`tools/checkout_repo.ts`) is **unit-tested** (`packages/core/scripts/self-host-egress-test.ts`).

## Bring the stack up

From the repo root:

```sh
cp .env.example .env          # fill AI_GATEWAY_API_KEY, SLACK_* etc. Leave egress.allowUnenforced off.
echo "OE_EGRESS_PROXY_TOKEN=$(openssl rand -hex 32)" >> .env   # REQUIRED — see below
docker compose up --build     # app (internal-only) + oe-egress-proxy (sole WAN route)
```

**`OE_EGRESS_PROXY_TOKEN` is mandatory, not optional.** Compose refuses to bring the stack up
without it (`${OE_EGRESS_PROXY_TOKEN:?…}`) and the control service refuses to boot without it
(fatal + exit 1). There is no token-less mode and no opt-out flag, because the control service
listens on the same internal network the sandbox runs on: a token-less `POST /policy` lets any
peer there — including a compromised agent — install itself an `allow-all` policy and defeat
default-deny egress outright, or `DELETE` another source's policy. The same value goes to both
the proxy and the app (compose passes it to both from the one `.env` entry).

The compose file (`../../docker-compose.yml`) puts the app on an `internal: true` Docker
network with **no WAN route** — its only path out is `oe-egress-proxy`. That topology is the
structural backstop: even if the runtime policy push failed, the app cannot reach the
internet except through the proxy, whose default is deny.

### Env (set by compose; override in `.env`)

| Var | Where | Meaning |
|---|---|---|
| `OE_EGRESS_PROXY_URL` | app | control endpoint the app POSTs policy to (`http://oe-egress-proxy:8080`) |
| `HTTP_PROXY`/`HTTPS_PROXY` | app | forward proxy (`http://oe-egress-proxy:3128`) |
| `NODE_USE_ENV_PROXY=1` | app | **Node 24**: makes the built-in `fetch` honor `*_PROXY` on its **global** dispatcher (model/Slack calls route via the proxy). ⚠️ It has **no effect on a fetch that passes an explicit `dispatcher`** — an explicit one overrides the global outright. OE's own guarded host-side fetches do pass one (they pin the connection), so they read `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` **themselves** and dispatch through the proxy — see "Host-side fetches" below |
| `OE_EGRESS_MITM` | proxy | `1` = Tier B (MITM); default `0` = Tier A |
| `OE_EGRESS_PROXY_TOKEN` | both | **REQUIRED** shared secret gating `POST/DELETE /policy`. The app also presents it as `Proxy-Authorization` on its own model call, which is how the proxy tells the app from the session (see "Two principals"). Unset/empty ⇒ compose refuses to start the stack and the control service exits 1. Generate with `openssl rand -hex 32` |
| `OE_EGRESS_CONTROL_PORT` | proxy | control-service port (default `8080`); the app's `OE_EGRESS_PROXY_URL` and the Squid helper must agree with it |
| `OE_EGRESS_CONTROL_HOST` | proxy | control-service bind address (default `0.0.0.0` — the app pushes policy cross-container, so it cannot be loopback-only) |
| `OE_EGRESS_CONTROL_HOST_INTERNAL` | proxy | host the **in-container Squid helper** calls for `/acl` (default `127.0.0.1`). ⚠️ **Leave it loopback.** `/acl` returns the Tier B credential-injection headers and is refused for any non-loopback peer (403), so pointing this at a non-loopback address makes every ACL callout fail — which fails **closed**: all egress is denied and the proxy blacks out |
| `OE_EGRESS_DENIAL_LOG` | app | Path to the proxy's **denial log** on the shared `oe-egress-log` volume (`/var/log/oe-egress/denied.log`). The app tails it and turns each denied host into an aggregated `egress.denied` audit row, which is what lets `permission_fit_report`'s widening loop see this plane at all (OPE-314). **Unset ⇒ the poller does not run.** Read-only on the app side — nothing here writes to the volume |
| `AI_GATEWAY_API_KEY`, `SLACK_*` | app | operator-supplied creds |

### Host-side fetches (not the sandbox) — what routes through the proxy, and what does not

Some tools reach the network from the **app process**, not from the sandbox, so the Squid ACL is
their transport rather than their only fence (they are separately checked against the same compiled
allow-list before dispatch).

| Path | On this stack |
|---|---|
| `describe_image`'s `{url}` source, and every other `oeFetch` caller | **Routes via the proxy.** `oeFetch` reads `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` itself and dispatches through an undici `ProxyAgent` |
| Slack `url_private` attachment download (`describe_image` on a pasted screenshot) | **Routes via the proxy**, same seam. The bot token traverses your proxy: Tier A tunnels it undecrypted, Tier B decrypts it with your CA |
| `web_fetch` | ⚠️ **Does not route via the proxy.** Its dispatch belongs to the framework, which passes its own explicit dispatcher, so it fails at the transport (`Network unreachable`) on this internal-only network — even for a host the allow-list permits. Fails **closed**; use `bash`/`curl` in the sandbox (which does go through the proxy) until the framework exposes a dispatcher seam |

On the **direct** (Vercel) path those fetches resolve the destination, refuse any private/loopback/
link-local address, and pin the socket to the validated IP. Through a forward proxy that pin cannot
apply — the proxy is handed a hostname in the `CONNECT` line and resolves it itself — so the
anti-rebind property is **delegated to this proxy's default-deny ACL** on this tier. Each audited
allow row records which held (`antiRebind: "ip-pin"` vs `"proxy-acl"`).

**The unenforced-egress escape hatch is NOT needed** here — the proxy applies the compiled policy
natively, so the session-start hook records `enforced:true` without it. You need the hatch only to
run off-Vercel *without* a proxy (`OE_EGRESS_PROXY_URL` unset), and it is the `egress.allowUnenforced`
setting in `agent/settings/settings.ts`, declared by pull request. No environment variable reaches it.

### Tier B (MITM) extra steps

```sh
OE_EGRESS_MITM=1 docker compose up --build
# The proxy generates a CA into the shared `oe-ca` volume on first boot. Then, inside the
# app container (baked into the sandbox image for the docker() backend):
docker compose exec app sh /opt/oe-egress/install-ca.sh
```

`install-ca.sh` installs the CA into the OS trust store and prints the `NODE_EXTRA_CA_CERTS`
/ `GIT_SSL_CAINFO` the app already sets. **Client-compat caveats** (do not paper over):
tools that **pin certificates** or **ignore the proxy env** break under MITM — the former
must be Tier-A-spliced (host allow, no decrypt); the latter simply fail to connect on the
internal-only network (a proxy-bypass becomes a hard failure, not a leak).

## Live verification — PROVE it works (a human/CI must run this)

**Tier A live run — PASSED 2026-07-08** (`docker compose up --build`, justbash backend). The
first real run surfaced and fixed 7 container-wiring bugs (none in the unit-tested ACL logic):
the proxy image was `alpine:3.20` whose `nodejs` is too old for `--experimental-strip-types`
(→ `node:24-alpine`); Squid 6/7 FATALs on an empty `conf.d/*.conf` include (→ Tier B is now
appended to the config, not `include`d); Squid can't open root-owned `/dev/stdout` as the
`squid` user (→ entrypoint chowns the pipes; `cache_effective_user root` is itself refused by
Squid 7); the `external_acl` helper path was `/opt/oe-egress/helper.js` but the file ships at
`/opt/oe-egress/control/helper.js` (renamed `helper.cjs` in 0.8.0, OPE-2619); and the app image lacked the `just-bash` package the
`justbash()` sandbox backend requires (→ added as a dep). After the fixes, **verified live**:
default-deny with no policy (`TCP_DENIED/403 CONNECT example.com:443`); a pushed
`{allow:["example.com"]}` → `TCP_TUNNEL/200 … HIER_DIRECT` (TLS tunnelled, not decrypted);
a non-allowed host (`pastebin.com`) still denied under the same policy; and the internal-only
network backstop (direct WAN from the app = `Network unreachable`).

**Still live-pending:** a full Slack-driven turn end-to-end (needs Slack creds), and all of Tier B
below.

**Fixed — the app's model call (OPE-2406):** on release 0.3.0 the proxy decided the app's model
call against the SESSION policy for the app's address, which never names the model gateway, so it
denied every turn (`TCP_DENIED/403 CONNECT ai-gateway.vercel.sh:443`, measured 2026-10-09,
OPE-2193). The model call now goes out on the app's host plane (see "Two principals").
`npm run test:docker-smoke` leg 2 proves it on the compose topology: a real model call succeeds
through the enforcing proxy while a just-bash session `curl` in the same container is refused for
the model gateway and for an undeclared host, and reaches its one declared host. 🔴 The smoke's
session shell turns off just-bash's private-range DNS pre-check (`denyPrivateRanges: false`). The
shell as eve builds it, under the image's `NODE_ENV=production`, runs that pre-check, the lookup
fails on the internal-only network, and its `curl` reaches **no** host, declared or not (the smoke
prints this as a NOTE). So on the compose stack today the session's own `curl` does not work; it
fails closed.

Everything below is **live-pending**: it needs a real Docker + TLS run and is not covered by
the unit tests. Mark each as it passes.

### (a) A turn completes with the proxy enforcing; a blocked host is denied

1. `docker compose up --build`; wait for the app to be healthy and the proxy log to show
   `listening` + `launching squid`.
2. Drive a turn (Slack signed-injection harness, `E2E_TARGET_URL=http://localhost:3000`, or
   the app's normal Slack ingress). Confirm the reply posts.
3. Check the app log for `[open-everywhere:egress] enforced: allow N host(s), default-deny`
   **with `egress.allowUnenforced` off**, and the proxy `access_log` (stdout) for
   `TCP_TUNNEL/200` to the model gateway (the host plane) and to `slack.com` (the session policy).
   The model-call half of this step is covered by `npm run test:docker-smoke` leg 2; a full
   Slack-driven turn is still live-pending.
4. **Blocked host:** from inside the app container, `curl https://example.com` (not in any
   bundle) → the proxy denies it (`403`/reset). Confirm the proxy log shows the deny.

### (b) Tier B: MITM bump + credential injection — MECHANIC PASSED 2026-07-08

The core Tier B mechanic is live-verified (`OE_EGRESS_MITM=1 docker compose up`, justbash
backend, an allow-map policy with a `transform.headers` Authorization pushed for an echo
host): Node fetch to the bumped host **trusted the proxy-minted cert** (MITM works, CA trust
via `NODE_EXTRA_CA_CERTS`); the proxy `access_log` showed the **decrypted** `GET …/get` line
(not just a CONNECT tunnel); and the origin **received an `Authorization` the app never sent**,
injected verbatim including the mandatory space in `Bearer <jwt>`. Two Tier B wiring bugs were
fixed to get here: Squid 7 rejects `%external_acl_message` in `request_header_add` (→ read the
helper's annotation as `%note{authz}`), and `%note` URL-encodes by default, turning the
credential's space into `%20` (→ the `'` / `LOG_QUOTE_NONE` modifier: `%'note{authz}`).

**On CA trust:** the *app container* needs no `install-ca.sh` — Node reads the CA via
`NODE_EXTRA_CA_CERTS` and git via `GIT_SSL_CAINFO` (both set by compose to the shared-volume
CA). `install-ca.sh` (OS trust store) is baked into the *proxy* image. It was written for a
**docker() sandbox guest**, which this proxy cannot front today (see "Which sandbox backend").

**Not reachable on this stack:** the full `checkout_repo` path with a real `git clone` needs real
git binaries, which only the docker backend has, and the docker backend does not run behind this
proxy (OPE-2407). The mid-turn broker `pushEgressPolicy` itself runs under justbash.

### (c) An exfil attempt to a non-allow-listed host is RESET

1. From inside the app container: `curl -x http://oe-egress-proxy:3128 https://pastebin.com`
   (or any non-allow-listed host). Expect a proxy **deny/reset**, not a 200.
2. Bypass attempt: `curl --noproxy '*' https://1.1.1.1` from the app container → **no route**
   (the internal-only network has no WAN). Confirms the structural backstop.

### (d) A denial becomes an `egress.denied` audit row — OPE-314, LIVE-PENDING

The docker tier is the one topology where the firewall is ours, so it is the one where the
individual blocked request can be recorded at all. (On Vercel the sandbox host denies out of band
and the attempt is never observed — that half of the OPE-308 finding is unchanged and still true.)

1. Trigger a deny as in §(c). Then, inside the **proxy** container:
   `cat /var/log/oe-egress/denied.log` → a line of the form `1754654400.123 TCP_DENIED/403
   pastebin.test`. **Three fields.** Confirm there is no path, no query string, no method, no
   client address — under Tier B especially, since Squid has decrypted the request there and the
   conventional format on stdout *does* carry the full URL.
2. Within one poll interval (60 s, a code constant), an `egress.denied` audit row appears carrying
   `{ host, count, policyFingerprint, windowMs }` and nothing else. The fingerprint matches the
   `egress.policy` row for the generation in force.
3. Repeat the deny several times inside one interval → **one** row with `count: N`, not N rows.
4. Kill the volume (or unset `OE_EGRESS_DENIAL_LOG`) → the app logs the "not readable" note
   **once** and keeps serving turns. The plane going dark must never be an outage.

## Unit-proven vs live-pending — summary

- **Unit-proven now** (`npx tsx …`): the ACL match logic (deny-all/allow-all, wildcard hosts,
  Tier A host-only vs Tier B method/path narrowing, credential-header return, fail-closed on
  unknown source), the policy-push + ACL-query handlers, the control server's boot contract and
  endpoints (a real spawned process: it exits 1 without `OE_EGRESS_PROXY_TOKEN`, gates
  `POST/DELETE /policy` on the bearer token, and still answers `/acl` for a loopback peer only),
  and the app-side push seam (serialises the exact compiled policy; throws fail-closed on push
  failure). The host plane (OPE-2406): the push and ACL handlers (`control/acl-test.ts`), the real
  process's `/acl` credential path (`control/server-boot-test.ts`), and the app's host-plane fetch,
  including the `Proxy-Authorization` header on the wire to a stub proxy
  (`packages/core/scripts/self-host-egress-test.ts`).
- **Live-verified by `npm run test:docker-smoke` leg 2** (Docker, Tier A, justbash): Squid hands
  `Proxy-Authorization` to the helper; the app's real model call tunnels to the gateway; the
  session (a just-bash `curl` in the same container, with just-bash's DNS pre-check off — see
  "Fixed" above) is refused for the gateway and an undeclared host and reaches its declared host;
  the credential reaches no undeclared host; the denial log names the refused hosts; no log
  (proxy, app, probe) carries the token; docker behind the proxy refuses to boot.
- **Live-verified 2026-07-08** (Docker + TLS run, justbash backend): Squid enforcing via the
  helper callout, Tier A CONNECT tunnel (allow → `TCP_TUNNEL/200`, deny → `TCP_DENIED/403`,
  default-deny before any push), Tier B peek/bump + CA trust + verbatim credential injection
  (space intact), and the internal-only-network backstop (`Network unreachable`). The Squid
  `external_acl_type` format codes and the Tier B `request_header_add` annotation wiring did
  need per-version tweaks — now settled in `squid.conf` / `tier-b.conf` (helper path,
  conf.d→append, `/dev/stdout` chown, `%note{authz}` + `LOG_QUOTE_NONE`).
- **Still live-pending:** a full Slack-driven turn (needs Slack creds).
- **Not supported:** the `docker()` sandbox backend behind this proxy (OPE-2407), and so the real
  `git clone` half of `checkout_repo` on this stack (§(b)).
