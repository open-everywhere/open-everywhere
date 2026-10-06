# The browser — the agent operates a page it cannot otherwise reach

After changing a web app, "tests pass" is not the same as "it looks right". The browser gives the
agent a headless Chromium **inside its own sandbox** so it can spin up the dev server it just
edited, drive the page, screenshot it, and post the picture back into the thread — and vision-read
the screenshot itself to verify the change before a human ever looks.

It also reaches **third-party sites the operator declares**: a tool with no API is still a tool a
person operates through a page, and the browser operates it the same way — logging in with a
credential the **firewall injects and the browser never holds**.

It ships as **one flag-gated layer**: the [agent-browser toolkit](#the-agent-browser-toolkit-flag-gated)
(navigate, snapshot, find, click, fill, screenshot, …) from Vercel Labs'
[`@agent-browser/eve`](https://agent-browser.dev), **off by default** — armed by
`browser.enabled: true` plus a host declaration. It is **Vercel Sandbox only** for now: the
self-host image (`node:24-alpine`) has no Chromium. Off Vercel the whole plane **refuses and says
why**: no tool mounts, no declared egress host opens, and nothing bakes. The flag stays armed and
the deployment boots normally — one loud line names the platform as the reason.

🔴 **`OE_PLATFORM` overrides that refusal, and that is the operator's own call.** The platform seam
reads `OE_PLATFORM` **before** Vercel's own `VERCEL` variable, so a self-host deployment that sets
`OE_PLATFORM=vercel` re-arms the whole plane — all 20 tools mount and every declared egress host
opens, for a browser the image cannot run. That is the same override a Vercel deployment uses to
declare itself self-host, so the code cannot tell the two apart and does not try. If you set it,
either ship Chromium in your image or leave `browser.enabled` off.

## The agent-browser toolkit (flag-gated)

When armed, the agent gets the [agent-browser](https://agent-browser.dev) tool set, mounted as
`browser_*` tools: `browser_navigate`, `browser_snapshot` (accessibility tree with stable `@eN`
element refs), `browser_read`, `browser_click`, `browser_fill`, `browser_press_key`,
`browser_hover`, `browser_select_option`, `browser_set_checked`, `browser_scroll`, `browser_drag`,
`browser_upload`, `browser_wait_for`, `browser_get`, `browser_find`, `browser_screenshot`,
`browser_tabs`, `browser_console`, `browser_network_requests`, `browser_close`. Each shells out to
the `agent-browser` CLI inside the session's sandbox — the browser and all its state live entirely
in the sandbox; the app runtime only relays commands.

`browser_evaluate` — model-written JavaScript run in the page — is **not** in that list. It is
opt-in per host: see [Page scripting is opt-in](#page-scripting-is-opt-in).

**Cookie, storage, and saved-auth-state commands are not exposed as tools** — upstream
withholds them deliberately (they would make credential material visible to the model), and
Open Everywhere adds none back.

### Arming it — a flag and a declaration

Both halves are typed code, so arming the capability is a reviewed diff rather than an env edit.
That also removes the old build-vs-runtime trap: the sandbox template bake and the runtime mount
read the same committed values, so they cannot disagree about whether the browser exists.

```ts
// agent/settings/settings.ts — the master flag
export const SETTINGS_OVERRIDES = defineSettings({ browser: { enabled: true } });
```

```ts
// agent/access/browser-hosts.ts — the reach
import { registerBrowserHosts } from "@open-everywhere/core/agent/access/browser-hosts.js";

registerBrowserHosts([
  {
    host: "localhost",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    why: "The in-sandbox dev server a worker boots to see its own UI change.",
  },
  {
    host: "support.vendor.example",
    methods: ["GET", "HEAD", "POST"],   // POST is what permits a form submit here
    credential: "vendor-support",       // an egress Connection.id from agent/access/bundles.ts
    why: "Our ticketing tool has no API — the agent operates it through its web UI.",
  },
]);
```

Fail-closed matrix:

| State | Result |
|---|---|
| Flag unset | Byte-identical: no tools mount, no egress opens, no browser bakes. |
| Flag set, declaration empty | Does **not** arm; one loud log line says why. |
| Declaration holds an invalid row | The boot **throws**. Any bad row invalidates the whole declaration — there is no partial reach. |
| Armed, off-Vercel | Nothing arms: no tool mounts, no declared egress host opens, no template bakes. One loud line names the platform (no Chromium in the self-host image). The refusal is one core road (`browserPlaneRefusal`), read by the config loader every arming path goes through — and in core by the grain resolver and by the plane's own egress opener, so a registration that arrived by another door mounts nothing and opens no host. |
| Armed, off-Vercel, `OE_PLATFORM=vercel` | **Fully armed, and broken.** The operator's own override wins over the platform detection, so every gate above answers "on Vercel" and the plane arms for a browser that cannot run. Deliberate: the same override is how a Vercel deployment declares itself self-host. |
| Armed, on Vercel | Tools mount on worker seats; both containment walls carry the declared hosts; the browser is pre-baked into the sandbox template. |

### What one row says

Each row is four decisions, and the diff that adds it is the review:

| Field | What it decides |
|---|---|
| `host` | Where the browser may go. Bare lowercase hostname; loopback names and `127.0.0.0/8` allowed. No wildcards, schemes, ports, paths or literal IPs. `github.com` and `codeload.github.com` are reserved by the git read-broker and are refused, credential or not. |
| `methods` | Which HTTP verbs the **firewall** admits there. `["GET", "HEAD"]` is read-only and cannot submit a form. |
| `credential` | The egress connection whose secret the firewall stamps on requests to this host. Absent means "reach it logged out". |
| `evaluate` | Arm `browser_evaluate` for this host. Absent means off. |

**The row is the approval.** A form submit on a declared third-party host raises no card at turn
time — the consequential decision was made once, by the operator, when they wrote `POST` into that
row. That is the same rationale that makes `bash` an open-tier tool: reach is bounded by the egress
plane, not by a per-call judgement. Declare the narrowest verb set the work needs.

### The credential never enters the sandbox

A third-party log-in is a `credential` on the host's row. Open Everywhere resolves it **host-side**
through the ordinary [credential broker](../security/credentials-and-planes.md) and hands it to the
sandbox firewall as a header `transform`. The firewall stamps it on the way out.

So the browser process, the page it renders, any script on that page, and every model-visible tool
result see a request that is **already authenticated** and a secret they never held. The value is in
the compiled network policy and nowhere else: the model cannot read the credential and cannot
exfiltrate it. That is the property a stored cookie jar would not give you.

Four ways a declared credential can fail to resolve — the session was never granted that connection,
a break-glass revoke narrowed it away, the override store could not be read, the broker returned
nothing — and all four **omit the host from the policy**. None of them opens it logged out: driving
a third-party site signed out and reporting success is the silent-wrong-thing this refuses.

Four consequences worth knowing before you write a credentialed row:

- 🔴 **A credentialed row grants the whole sandbox, not just the browser.** The firewall cannot tell
  an agent-browser request from a `bash`/`curl` one — it is one network policy for the session. So
  the model can issue **authenticated requests of its own** to that host under the declared verbs,
  from `bash`, in any session whose access carries the connection, including sessions where the
  browser tools never mount. The secret still never leaves the firewall; the *authenticated reach*
  is not browser-scoped. This is why `methods` matters: declare the narrowest set the work needs, and
  treat a credentialed `POST` row as a grant to the agent, not to the browser.
- **A credentialed browse target is sandbox-plane only.** `web_fetch` runs host-side and sends no
  credential, so it does not gain reach to the host — it will refuse it. That asymmetry is
  deliberate and fail-closed. An *uncredentialed* row is reachable from both.
- **A bundle wins a tie.** If a bundle connection also reaches that host, the bundle's rules are the
  ones compiled and this row's credential never rides — that is what upholds one credential per host
  per session. No config-time check can see the clash (a bundle resolves per scope), so read the
  `egress.policy` audit row, which names the connection that actually stamped the host.
- 🔴 **`github.com` and `codeload.github.com` are refused outright.** The [git read-broker](../security/credentials-and-planes.md)
  replaces those two hosts' rules wholesale, mid-turn, so a row on either would lose both its verb
  narrowing and its credential the moment the agent checked out a repository. A row naming one fails
  the boot, and the policy compile refuses it again; `api.github.com` is not reserved.

### Page scripting is opt-in

The default kit is **snapshot-driven**: `browser_snapshot` returns the page's accessibility tree
with stable element refs, and `browser_find`/`browser_click`/`browser_fill` act on the elements it
showed. Every action names something the model actually saw.

`browser_evaluate` runs model-written JavaScript in the page, so its reach is the page's whole
scripting surface rather than one element. Two walls hold it:

1. **It does not mount** unless some declared host carries `evaluate: true`. With none, the tool is
   absent from the model's tool list — there is nothing to refuse.
2. **At call time** it is refused unless the session's last known page host is one that opted in. A
   session that has not navigated is refused too.

Wall 2 is best-effort by construction and the honest bound is worth stating: the vendor's
`evaluate` takes an expression and no URL, so the page host is tracked from what passes through the
tool seam — a `browser_navigate` target, and any later result that reports a URL. An in-page
navigation that surfaces no URL leaves that tracking stale. Every reachable page is a *declared*
host either way, so the exposure is bounded to "a declared host that did not opt in", never to the
open web. Wall 1 is what makes the whole class opt-in.

### The containment model — one list, two walls

The host declaration is the single containment decision, enforced twice; the model cannot browse
beyond it:

- **Inner wall — agent-browser's own `allowedDomains`**: restricts navigation *and*
  sub-resources, hardened upstream against WebRTC bypasses, workers, popups, restored
  session state, reused daemon sessions, and unsafe startup arguments. It takes the bare
  hostnames — the vendor has no notion of a verb or a credential.
- **Outer wall — the sandbox egress firewall**: the same hosts, with the full row applied. The
  declared verbs become a method match; a declared credential becomes the header transform above.
  Even a contained-browser escape (or a DNS rebind past the inner wall) cannot reach a host the
  operator didn't declare, nor use a verb the row didn't admit.

Loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) are **filtered off the egress seam** — they never
leave the sandbox VM, so declaring `localhost` widens no external reach; it only tells the inner
wall to allow navigating to the dev server the agent just booted. (Loopback still MUST be declared,
or agent-browser refuses to navigate to it.) A loopback row may carry no `credential`: there is no
boundary at which to inject one, so the declaration is refused rather than silently ignored.

Wildcards are rejected on purpose: agent-browser would accept `*.example.com`, but the egress
firewall matches exact hosts — a wildcard would be contained on the inner wall and open nothing on
the outer, so the lint refuses it rather than ship a half-working row.

### Pre-baked, never downloaded mid-session

The browser stack (agent-browser CLI + Chromium + system libraries) is installed **once, at
sandbox-template bootstrap** — sessions start warm. Nothing downloads inside a live session:
the runtime firewall wouldn't allow it, and the vendor's install-on-first-use path is bound
off (`autoInstall: false`), so a missing bake fails loud instead of pulling hundreds of MB
mid-turn. Since eve 0.69.0 the template key is a hash of the sandbox environment's options, and
the hash reads a function by its source text. So arming or disarming the bake, or an edit to its
`prepare` body, rebuilds the template on the next deploy. A bump of the agent-browser version alone
does NOT: the pin sits inside the vendor installer, where the hash cannot see it, so the warm
template stays on the old version until something the hash reads changes.

### Posture

- **Grain**: browsing is wide-hands work (same class as `bash`/`web_fetch`), so the toolkit
  mounts on worker seats only — a standing ambient watcher never sees the tools (structural
  absence, with an execute-time backstop behind it).
- **Consequence**: open tier, on the `bash` rationale — in-sandbox execution whose reach is
  bounded by the egress plane. The interaction verbs *can* submit forms, but only on a declared
  host and only under the verbs its row admits; the consequential decision is that row, made once
  in a reviewed diff. Declare read-only (`["GET", "HEAD"]`) unless the work needs to write.
- **Untrusted content**: page text returns wrapped in content-boundary markers
  (`contentBoundaries: true`) — web content is injection-bearing input, same as any ingest.
- **Screenshots**: saved as sandbox files (inline base64 embedding is off — no multi-MB blobs
  in durable transcripts). The agent posts them to the thread with `post_file` and
  vision-reads them with `describe_image({ kind: "path", ref: … })` — the tool's workspace source variant
  reads a screenshot straight off the session's sandbox workspace — closing the
  "screenshot → look at it → fix → re-screenshot" loop.
- **Audited**: each `browser_*` op lands an append-only audit row (`browser.<op>`, e.g.
  `browser.navigate`, `browser.screenshot`) — ids and the verb only, never the page content or
  the tool arguments — so the containment story is observable in the log.

### The localhost QA loop

The end-to-end shape the toolkit exists for: a worker seat boots the dev server it just edited on
`localhost` in its sandbox, `browser_navigate`s to it, `browser_screenshot`s the affected view,
then `describe_image({ kind: "path", ref })` reads the shot back — the agent *sees* its own render and
can fix-and-re-screenshot before a human looks. One `localhost` row in the declaration is all this
needs (it is filtered off the egress seam, so it opens no external reach).

The one shape that must be right is how the server is started: `bash` returns when the command's
output stream closes, so a background job that still holds stdout/stderr never lets the call
return. The server has to be started as `<command> > /tmp/dev.log 2>&1 &` — the agent's own
instructions say so, and `bash` refuses the unredirected form up front rather than stalling
(`packages/core/agent/stall/bash-hang-guard.ts`). Both halves of that guard — the refusal and the
per-call timeout behind it — are tunable: see
[`bash.backgroundGuard` and `bash.timeoutMs`](../deploy/configuration-reference.md#bash-hang-guard).

### Self-hosting note

The capability plane is adapter-shaped (`packages/adapters/agent/browser/` riding core's
browser-toolkit and extra-egress seams), so a self-host image that ships Chromium could lift
the Vercel-only gate later; today the gate stands.
