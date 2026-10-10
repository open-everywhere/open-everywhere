# Sandbox

The **sandbox** is the isolated executor the agent's own code runs in — every `git`, `curl`,
and shell command. It's a [deploy-singleton seam](./adapter-model.md), and it's where the
**egress firewall** sits. The fixed-spine firewall is documented in the
[security model](../security/security-model.md); this page is the swappable executor underneath it.

## What the sandbox is

Open Everywhere doesn't run the agent's shell on the host. Each session gets a sandboxed
microVM; the durable memory store lives host-side and is materialised into the sandbox per
session, and the sandbox is released after each run. This is what bounds blast radius: the
agent's code is isolated, and the durable state it can reach is only the resolved partition's
files, copied in.

The sandbox backend itself is **owned by Eve**, not by an Open Everywhere adapter. Eve's
`defineSandbox({ backend })` selects the executor — Vercel Sandbox (Firecracker microVM),
microsandbox, Docker, or `just-bash` — and a custom `SandboxBackend` (E2B, Modal, …) is
authorable through Eve. Open Everywhere holds the *policy*, not the executor: **Eve is the
adapter** here.

## The egress firewall sits at this boundary

The security-load-bearing thing Open Everywhere adds is a **default-deny egress firewall** at
the sandbox boundary. Open Everywhere compiles the resolved access into a network policy; the
sandbox enforces it. The compiler turns each reachable host into an allow rule, injects any
auth header **at the firewall** (so the secret never enters the sandbox), and denies everything
else implicitly:

```ts
// packages/core/agent/access/egress.ts — compileNetworkPolicy
//   credentialed host  -> allow rule + transform that injects the auth header at the firewall
//   credential-less    -> bare allow
//   everything else    -> denied implicitly ("all traffic not explicitly allowed is denied")
if (Object.keys(allow).length === 0) return "deny-all";
```

This is the same property Claude Tag's Agent Proxy gives, and it's why a credential the agent
uses is never a credential the agent *holds*.

**Name the tier before you lean on that parity, because who owns the proxy differs and the
difference is observable.** On the **Vercel** tier the enforcing firewall is the *platform's*:
it denies out of band, Open Everywhere never sees the attempt, and the agent's own report is
the only signal a request was blocked. On the [self-host egress
tier](../deploy/platforms/self-host-egress.md) the proxy is **ours**, so each denial becomes an
`egress.denied` audit row that [permission homeostasis](../security/permission-homeostasis.md)
can read. The injection property holds on both; the *visibility* of a denial does not, so a
claim of proxy parity is only true once it says which tier it is describing. The third case is
the [connector plane](../security/credentials-and-planes.md#the-connector-plane--the-runtimes-mcp-tool-calls),
where no firewall is involved at all: its narrowing is an in-process check on the credential
itself, and its denials are always ours to see.

It governs **the sandbox**, which is a narrower statement than it sounds: `bash` (and so
`curl`, `git`, `npm`) runs in here and is bounded by it, while `web_fetch` and `web_search`
execute host-side. The *policy* still reaches one of them — `web_fetch` is fenced against the
same resolved allow-list before it dispatches, host-side rather than at the firewall — and
reaches `web_search` not at all. See
[the toolset](../how-it-works/agent-and-loop.md#the-toolset-it-works-with) for both.

## The agent's view of the firewall

The firewall denies out of band — the agent gets a connection failure with no explanation of
which hosts it *could* have reached, or that the wall was deliberate. The predictable
response to an unexplained failure is a retry, and a retry is the one response that can never
work here.

So every time the policy is applied, two files are materialised into the sandbox, beside the
memory tree and read-only:

```
/workspace/egress/STATUS.json   enforcement state, allowed hosts + narrowing, policy fingerprint
/workspace/egress/README.md     the protocol: don't retry, don't route around it, report it
```

`STATUS.json` is derived from the **compiled policy** rather than from the config it came
from, so it cannot describe a policy somebody merely intended to apply. It is deliberately
hosts-only: per host it carries the method/path narrowing and a boolean saying whether a
credential is injected there, and it never carries the header name or its value — that
policy object holds the real secret, and a status file that leaked it would hand the agent,
in a file it can `cat`, exactly what the firewall took away.

Regeneration rides the same skip-unchanged gate as the apply itself
([revocation latency](../security/revocation-latency.md#egress-is-turn-grained)), so an
unchanged turn writes nothing. A turn whose apply *failed* writes nothing either: the older
policy is still in force, and a file describing the new one would be the most misleading
thing this surface could say.

## What an alternative executor must provide

Because the firewall is the load-bearing seam, the contract an executor must satisfy is the
network policy:

- **Fine-grained, per-host network policy with header transforms** — to enforce two-surface
  egress and inject credentials at the boundary. Eve's own `setNetworkPolicy` is honoured
  fully, natively, only by the **Vercel Sandbox** backend. The **microsandbox** backend
  enforces the host-grain part natively (per-host allow, deny-by-default) but not the rest:
  at-boundary credential injection silently does not happen, and `match` (method/path)
  narrowing is dropped (measured, OPE-917 — upstream defect OPE-954). Plain Docker honours
  coarse allow-all / deny-all only, and `just-bash` rejects `setNetworkPolicy` entirely. See
  the [hosting comparison](../deploy/platforms/comparison.md) for what has actually been run
  where. Open Everywhere's own off-Vercel deployment (`docker()`, the default) doesn't rely
  on Eve's native policy at all off Vercel — it gets full parity by **pushing the compiled
  policy to a forced local egress proxy** instead; see
  [Self-host with enforced egress](../deploy/platforms/self-host-egress.md).
- A POSIX-ish shell environment the agent's tools (`git`, `curl`) run in, with the resolved
  memory files materialised in — and, on the same seam, the `egress/` self-diagnosis files
  above. An executor that can't take a `writeTextFile` loses the diagnostics, not the
  firewall: the publish is best-effort by construction.

There is deliberately **no default allow-list**, package registries included — see
[Credentials & the two planes](../security/credentials-and-planes.md#the-host-can-change-the-policy-the-agent-cant)
for why, and for the one-line opt-in a repo-working bundle uses instead.

Open Everywhere's policy compiler runs everywhere (it's pure), but it only *enforces* on a
backend that honours fine-grained policies. Enforcement is on by default; `egress.enforce: false`
opts out to dry-run. An executor that rejects `setNetworkPolicy` **aborts the session** (fail
closed — the session default is allow-all, so unenforced means unfirewalled); set
`egress.allowUnenforced: true` to knowingly run such a backend with a warning instead.

## On Vercel / Off Vercel

- **On Vercel:** the Vercel Sandbox is the default executor and the **only** backend that fully
  enforces the fine-grained egress firewall (per-host allow + at-boundary credential injection).
  Enforcement is on by default; set `egress.enforce: false` to opt out to dry-run.
- **Off Vercel:** Open Everywhere's own deployment picks between two Eve backends via the
  setting `sandbox.selfHostBackend` — `docker()` (the default, contained) or `justbash` (dev-only, shares the
  app process's filesystem); see [Self-host with enforced egress](../deploy/platforms/self-host-egress.md).
  The egress-proxy sidecar enforces the session policy for `justbash` only. `docker()` honours
  only Eve's coarse `setNetworkPolicy` strings, and its session containers sit outside the proxy,
  so the app refuses to boot on `docker()` with the proxy wired (OPE-2407). A from-scratch adapter could instead
  pick Eve's `microsandbox` backend (needs `/dev/kvm`) for native host-grain enforcement — but
  not full parity: credential injection and `match` narrowing are measured gaps (OPE-917,
  upstream defect OPE-954) — or a custom backend like E2B; any backend that doesn't honour
  per-host policies with header transforms degrades the credential-injection property.

## Where the sandbox runs (data residency)

`sandbox.region` names the Vercel region to create sandboxes in — the residency pin for sandbox
compute, the sibling of the AI Gateway's `inferenceRegion` for inference. It ships empty, which
pins nothing.

**The pinned Eve honours it.** Open Everywhere never calls `Sandbox.create`; Eve does, through its
own vendored copy of the SDK, and since Eve 0.52.2 that copy types `region` on create and posts it
to the API. Set it on Vercel and the region applies at sandbox **create** — sandboxes that already
exist keep the region they were created in. Off Vercel the setting is inert and says so in a boot
warning: the `docker()` and `justbash` backends run on your host.

The capability is measured, not read off a version number, because half of it would be invisible.
Eve's create call **enumerates** the fields it forwards, so a `region` that is typed but missing
from that enumeration compiles and is then dropped without an error — the sandbox would run in the
default region while the deployment claimed otherwise. `npm run test:sandbox-region` re-derives
both halves from Eve's own files on every run.

🔴 **Which vendored copy creates is itself a moving fact, and the guard resolves it every run.** Eve
vendors several copies. Through 0.51.0 the create path loaded `@vercel/sandbox`; at 0.52.2 it loads
`@vercel/sandbox-drives`, and `@vercel/sandbox` became the *delete* path. The guard reads which copy
Eve's binding gives its `loadSandboxModule` default, so a future swap reds rather than quietly
measuring a module that mints nothing.

Should a later Eve withdraw the passthrough, that suite turns red. **The red is the signal, and it
is the only automatic part.** `SANDBOX_REGION_PASSTHROUGH_SUPPORTED` is a hand-maintained constant
in `packages/core/agent/sandbox/vercel-create.ts`, and the boot keeps pinning the region until a
human flips it to `false`. That flip is what makes the setting **fail closed**: a set region then
refuses the boot and names the gap, instead of running in the default region under a pin Eve cannot
honour. See
[Data governance](models-and-gateway.md#residency-covers-inference-and-sandbox-compute).

## Who stops the sandbox at turn end

`sandbox.stopAfterTurn` (on by default) stops the session's compute as soon as the reply is
sent, rather than letting it idle out the timeout window. The mechanics differ per backend, so
the hook names the owner in the log at the first turn end of each process:

| Backend | What the stop does | Runtime billed per second? |
| --- | --- | --- |
| Vercel | `Sandbox.list` by session tag, then `stop()` on each running VM. (The direct `Sandbox.get` for a sandbox this turn opened, OPE-722, no longer runs: eve 0.69.0 exposes no sandbox name to authored code, so nothing records one, and the narrow create-then-stop race is open again.) The stop auto-snapshots and the next turn auto-resumes. | Yes — each stop writes a priced spend-ledger row, so USD caps count runtime. |
| `docker` | `docker ps` by Eve's per-session container label, then `docker stop -t 0`. The container is stopped, never removed, and Eve restarts it by name with the filesystem intact. | No — the box is yours. No spend row is written; pricing it at Vercel's GB-hour rate would invent a charge that the caps then enforce. |
| `justbash` | Nothing. The just-bash executor runs inside the app process — there is no VM or container to stop. | No. |

Every path is a **zero-side-effect peek first**: it lists what already exists and acts only on
that. Eve's own `ctx.getSandbox().stop()` is not usable here, because `getSandbox()` provisions —
on a session that never touched a sandbox it would create one just to stop it, on every chat-only
turn.

**On a work session the stop waits until the work session is idle.** Every conversation seat (a
domain seat, a thread seat and a DM seat) runs its jobs through the conversation's work session
([three tiers](../how-it-works/agent-and-loop.md#the-three-tiers-seat-work-session-worker)), and the
work session owns the conversation's sandbox and runs every job in it. Its turn end stops the sandbox
only when the work session owes nothing: no task it started is still unsettled, and no job the seat
forwarded is still waiting to start. The hook reads the work session's durable ledger for this, and
an unreadable ledger reads as busy, so the sandbox then idles to its `timeoutMs` fuse instead of
stopping under a job. On a work session `timeoutMs` is therefore the longest a job may hold the
sandbox, not the longest turn. Every other session keeps the stop after its turn.

A **delegated child does not stop the sandbox.** Eve's built-in `agent` tool runs its child on the
parent's sandbox, and re-tags that sandbox with the child's session id on attach. So a child turn
skips the stop and restores the parent's tag, handing ownership straight back. Without that, the
parent's own sweep would find nothing and the shared VM would idle out its full fuse.

**Nor does the parent, while a child still holds that VM.** Since OPE-2350 the only session that
starts a child is a work session, so the idle rule above is what keeps the parent's sweep off a
live child: the work session's turn end skips the stop while a task it started is unsettled. A VM
the hook never stops still falls back to its own `timeout` fuse.
