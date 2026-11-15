# Scheduler & control-plane identity

Two smaller [seams](./adapter-model.md): the **scheduler** that fires routines, and the
**control-plane identity** that authenticates admins. Both are swappable; this page covers them
together.

## The scheduler

Routines — the agent's [proactive, scheduled work](../capabilities/proactivity-and-routines.md)
— split the way every operational concept does: the **definition** (trigger + prompt) is
config-as-code, and the **run-status** (last run, failures, paused) is runtime state in the
[operational store](./database.md). What's a *seam* is the third thing: **how a routine fires** —
the cron source that decides "it's time, run this routine."

The routine store and the **dispatcher** live in core; the cron that drives the dispatcher is the
adapter. The dispatcher is one Eve `defineSchedule` that ticks every 10 minutes, reads the durable
routine store, finds the routines that are due (`nextRunAt <= now`), advances each one's schedule,
and starts a session on its surface. Because it uses a `nextRunAt` model rather than matching "is
it this exact cron minute," the dispatcher is **tick-cadence-independent** — a routine fires on the
first tick at or after its due time and never double-fires, so a slower or jittery cron source only
costs timing precision, not correctness. The recompute is anchored on the instant the routine was
**due**, not the instant it was dispatched, so a jittery source's lateness never accumulates into
the routine's period; the tick does, however, bound the finest cadence achievable (one dispatch per
tick, whatever the trigger asks for).

What's swappable is therefore just the cron source that wakes the dispatcher:

- **Vercel Cron** — drives Eve's `defineSchedule` on the Vercel reference path. The built default.
- **GitHub Actions scheduled workflows** — git-native, no extra infrastructure. Best-effort timing
  (delays, ~5-minute granularity, auto-disabled on inactive repos), fine for hourly/daily routines.
- **A cron daemon / systemd timer** — for a self-hosted box.
- **A hosted scheduler** (QStash, Inngest, Temporal) — when you need tighter SLAs or
  at-least-once delivery.

Swapping the scheduler means pointing a different cron source at the dispatcher's entry point; the
routine definitions and run-status are unchanged.

### A new schedule pins its principal first

A scheduled run starts under eve's schedule app principal, not under a person. So every OE schedule
module (a file anywhere under an `agent/schedules/` tree that calls `defineSchedule`) has a row in
`OE_SCHEDULES` in `scripts/eve-auth-paths-lint.ts`. The row says whether the schedule sends into a
session with `to(…).send`. A sending row names the spec that pins the auth it sends with. Three
schedules send today: `dispatch`, `cover-recap` and `personal-watch`. Only the dispatcher has an
integration-tier pin of the principal (`tests/integration/routine-fire-attendedness.test.ts`). The
other two pin their fire stamps at the unit tier.

`npm run lint:eve-auth-paths` refuses a new schedule module with no row. Its message says to pin the
auth principal of that path with a spec first. It also refuses a `markdown:` schedule and a
`<name>.md` schedule, which run the agent under eve's principal with no OE fire stamp. And it refuses
a code-only row whose module starts to send, and a module there that default-exports anything but a
`defineSchedule({ … })` call (eve runs any default export under that tree as a schedule). The same lint keeps a census of the eve files that
write the session auth (eve's `AuthKey`), so an eve bump that adds a writer goes red and names it
(OPE-2686).

## Control-plane identity

The [control plane](../security/control-plane.md) is an MCP server (no web dashboard). Its admin
write tools — break-glass revokes, spend overrides — gate on `requiredRole: "admin"`. **Who** an
admin is comes from a pluggable identity seam, not a hardcoded list:

- An identity is `(issuer, subject)` — the OIDC issuer plus the subject claim.
- Roles are resolved from token claims via `RoleRule[]`; a claim maps to a role.
- The verifier is a pluggable `TokenVerifier`. Core ships a generic OIDC verifier (and a static
  token for the simplest case); swap in **Google, Auth0, Okta, Entra, WorkOS, or GitHub** as the
  issuer by configuring `OE_ADMIN_*` — no separate adapter package needed.

This keeps admin authority out of code: you change *who can administer the runtime* by
configuring an issuer and claim→role rules, the same way you'd wire any OIDC app. Admin is
org-wide today; scoped/delegated admin (admin of one workspace's break-glass) is a scope-bound
role rule, demand-driven for multi-team single orgs.

## On Vercel / Off Vercel

- **On Vercel:** Vercel Cron drives Eve's 10-minute dispatcher tick; admin identity uses the
  generic OIDC verifier pointed at your chosen issuer.
- **Off Vercel:** wake the dispatcher from GitHub Actions (git-native, no Vercel), a systemd timer,
  or a hosted scheduler. The OIDC verifier is host-agnostic — point it at any issuer, or use a
  static admin token for the simplest self-host.
