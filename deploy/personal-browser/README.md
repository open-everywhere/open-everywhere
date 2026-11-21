# Open Everywhere personal browser

The box behind each person's own browser (OPE-2441). One box runs one Chromium for one person, with a
**persistent profile**: the sites the person signs in to stay signed in after the box stops, until the
profile expires unused. OE starts the box through its own sandbox backend: a persistent Vercel Sandbox on
the hosted stack, a docker container on a named volume on the self-host stack. No third party holds the
profile.

The operator guide is [`docs/capabilities/personal-browser.md`](../../docs/capabilities/personal-browser.md).
This page is the box's own contract: the image, the environment OE gives the box, and the HTTP API OE calls.

## Build the image

```bash
docker build -t oe-personal-browser:1 deploy/personal-browser
```

- **Docker stack:** the docker daemon that runs OE's sandbox needs the image. Set `box.image` in
  `agent/personal-browser/policy.ts` to the tag. Set `box.dockerNetwork` when the app runs in a container
  on a user-defined network, so it reaches the box by name. Behind the egress proxy (the browser overlay,
  `docker-compose.browser.yml`, OPE-2671), set it to `oe-net-boxctl`: the box joins `oe-net-box` for its
  egress and `oe-net-boxctl` for the app, and the proxy holds it to the person's host list.
- **Vercel stack:** push the same image to your project's Vercel Container Registry, and set `box.image` to
  the registry reference. Each person gets one persistent, named sandbox from that image.

## The environment OE gives the box

OE passes these to the box program at each start (`packages/core/agent/personal-browser/lifecycle.ts`,
`browserBoxSpec`). On Vercel they go to the one command, never into the sandbox's stored configuration. The
box holds no deployment credential. The only secret is this start's own request key.

| Variable | Meaning |
|---|---|
| `OE_PB_KEY` | This start's request key (64 hex characters). The program deletes it from its own environment, and Chromium starts without it. |
| `OE_PB_PORT` | The HTTP port (8080). |
| `OE_PB_ALLOW` | The hosts the person's DM egress declaration admits, as a JSON list (`example.com`, `*.example.com`, or `*`). |
| `OE_PB_IDLE_MINUTES` | The policy's idle window. The box closes itself after this plus five minutes with no signed request. |
| `OE_PB_PROFILE_DIR` | Where the profile lives: on the docker volume (`/profile/chromium`). On Vercel the default is under the home directory, inside the persistent filesystem. |
| `OE_BOX_EGRESS_PROXY` | Docker behind the egress proxy only: the proxy's `http://host:port` origin. The fence then asks the proxy for each connection by name (below). Not an `http://` origin ⇒ the box refuses to start. |
| `OE_BOX_EGRESS_CA` | Docker behind a Tier B proxy only: the proxy's CA, as PEM. The box trusts it in Chromium's NSS store (`certutil`), and deletes the variable from its own environment. It is a public certificate, not a secret. |

## The HTTP API

Every request carries `x-oe-box-auth: <epoch ms>.<hex HMAC-SHA256>`. The signature covers
`<ts>\n<METHOD>\n<path?query>\n<sha256 hex of the body>` under `OE_PB_KEY`. The box refuses a request more
than two minutes off, and a signature it already saw, with a bare 401. On Vercel the port is a public HTTPS
URL, so this signature is the only door.

| Route | What it does |
|---|---|
| `GET /health` | The page's address and title. |
| `POST /cmd` | One agent action: `go` (url), `look` (the page's text and its elements, each with a ref), `find` (role, name: is that element on the page — a read the rehearsal of a taught draft uses), `click` (ref), `type` (ref, text, submit), `select` (ref, value), `key`, `scroll`, `back`, `sites` (cookie domains only). |
| `GET /frame` | A JPEG of the page (1280×800), for the watch page. |
| `POST /input` | One event from the person while they hold the controls: `click`, `dblclick`, `text`, `key`, `scroll`, `go`, `back`, `reload`. OE checks the take-over lock before it forwards one. |
| `POST /lock` | Who holds the controls, from OE. While the person does, `/cmd` refuses. |
| `POST /teach` | `{"action":"start","maxMs":…}` starts recording the person's demonstration (at most ten minutes); `{"action":"stop"}` stops it and answers with the steps, or `none: true` when no recording was running (OPE-2454). |
| `POST /shutdown` | Close Chromium cleanly (the profile flushes to disk), then exit. |

An action that fails answers `{ "ok": false, "code": …, "message": … }` with a fixed code and a short fixed
message, never the page's own error text (which can carry a URL with a token).

## What the box does and does not do

- **The host fence.** Chromium sends all its traffic, loopback included, through a forward proxy inside the
  box program (QUIC is off), and the proxy refuses every connection to a host or IP literal outside
  `OE_PB_ALLOW` — on every hop, so a redirect from a declared host to an undeclared one is refused too. The
  proxy (`fence.mjs`) resolves each target once and refuses it when any address is loopback, unspecified,
  link-local (the cloud metadata endpoint) or one of the box's own interface addresses, in any spelling,
  whatever the list says — a catch-all `*` included, and a name that resolves to 127.0.0.1 too. It then
  connects to the address it checked, so a second DNS answer cannot swap one in. Other private addresses (RFC
  1918, the docker host's gateway) stay reachable when the list admits them; a catch-all `*` does. A
  request route repeats the check on each first URL, and service workers cannot register. On Vercel the
  sandbox firewall holds the same list at the network. On docker behind the egress proxy (OPE-2671) the proxy
  holds it at the network: the box sits on internal networks only, OE pushes the list for the box's own IP, and
  the fence sends each connection on to the proxy by NAME (`upstreamTarget`, `upstreamTunnel` in `fence.mjs`),
  because the box cannot resolve an outside name there. Then the fence refuses an undeclared name, a loopback
  name and an internal IP literal, and the proxy resolves the rest. The proxy refuses no private address, so a
  declared name that resolves to an internal or link-local address (the cloud metadata endpoint) is not refused
  there. That is why a catch-all `*` refuses to open on this stack. On docker without the proxy this check
  inside the box is the only one, and OE opens a docker box only under the declared unenforced posture
  (`egress.allowUnenforced`).
- **The take-over lock.** `POST /lock` (`{"holder":"agent"|"person","until":…}`) tells the box who holds the
  controls. While the person does, `/cmd` refuses every agent action; `/input` (the person's own) still works.
- **Secret fields are the person's.** `type` refuses a password, one-time-code or card field. The person types
  it after they take the controls.
- **No values leave the box.** No answer carries a field's value or a cookie value. `sites` lists cookie
  domains only.
- **The agent never submits a payment form** (`never.mjs`, OPE-2672). A click, an Enter or a typed submit that
  would send a form holding a card or bank field, or an embedded payment provider's frame (Stripe Elements, a
  PayPal button), is refused, whatever OE approved. With no form, the whole page counts for a control whose
  label reads as paying ("Pay", "Place order"). A box built before this rule does not refuse: rebuild and
  publish the image.
- **A demonstration records names, never the text in a field** (`teach.mjs`). While OE has started a
  recording, each input from the person adds one step: the page's origin and path (never a query, a fragment
  or a title), and the role and label of the link, button or field they used. A text input records the field,
  never the text; an editor is named from its label or placeholder, never from its contents; and a secret field
  is marked so. A path can still carry an id or a token, and a label can repeat typed text. The recording stops
  at ten minutes or 200 steps, and it lives in the box process's memory only.
- **One Chromium per profile.** At start the program removes Chromium's stale single-instance lock, because OE
  stops any other box on the same profile before it starts this one.
- It runs as the image's non-root user (`pwuser`). OE starts the docker container with no capabilities, no
  new privileges and a pid limit.
- It is headless Chromium, with no stealth mode. A site may treat it as a bot. A CAPTCHA is a step for the
  person: the agent hands them the controls.
- Passkeys and device-bound session credentials do not move into the box. The person signs in inside the box
  with a password and a code, or with a passkey on their phone.

## Smoke test without OE

```bash
cd deploy/personal-browser && npm install
OE_PB_KEY=$(openssl rand -hex 32) OE_PB_ALLOW='["example.com"]' node box.mjs
```

Then sign each request as above. The builder of OPE-2441 ran this against a local site: a login cookie set
in one run was still present in a second run with a new key, a password field refused `type`, an unlisted
host refused `go`, and an unsigned request got 401.
