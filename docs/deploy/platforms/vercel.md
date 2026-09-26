# Vercel — the reference platform

The reference happy path, built and exercised end to end. Vercel's adapter-set wires the
agent, its database, its secrets, and its scheduler in one deploy.

## The adapter-set

| Seam | Adapter | Status |
|---|---|---|
| Sandbox | Vercel Sandbox | Built |
| Operational store | Neon Postgres (`OE_OPERATIONAL_PROVIDER=postgres`) | Built |
| Memory backing | Neon Postgres (`OE_MEMORY_PROVIDER=postgres`) | Built |
| Credential brokers | `env` (always) + `db` (when `OE_CREDENTIAL_ENCRYPTION_KEY` armed); each credential names its home `broker`. OAuth connectors via the built-in own-rolled flow | Built |
| Scheduler | Scheduled cron → the routine dispatcher | Built |
| Model | Vercel AI Gateway (`american-closed` default; `chinese-open-weights` one config flip away) | Built |
| Source control | GitHub App | Built |

## What's automatic

- **Deploy button.** One click forks the template and deploys it. The
  [quickstart skill](../../introduction/quick-start.md) drives the rest.
- **Neon marketplace.** Provision a Neon database from the Vercel integrations
  marketplace; `DATABASE_URL` is injected, and the operational + memory stores point at it
  with `OE_OPERATIONAL_PROVIDER=postgres` / `OE_MEMORY_PROVIDER=postgres`.
- **Credential brokers** are the core `env` broker (always) and the core `db` broker (when
  `OE_CREDENTIAL_ENCRYPTION_KEY` is armed); OAuth connectors are minted host-side by the built-in
  own-rolled OAuth flow (`packages/adapters/agent/oe-oauth`). There is no Vercel-specific managed broker — the
  earlier Vercel Connect adapter was deleted. See
  [Credential brokers](../../extending/credential-brokers.md).
- **Model auth via OIDC.** On a deployed Vercel project the AI Gateway credential is
  auto-injected — no `AI_GATEWAY_API_KEY` needed. Locally you supply the key or run
  `eve link`.
- **A capped build heap.** The repo's `build` script sets `NODE_OPTIONS=--max-old-space-size=6144`,
  and Vercel's remote build runs that script unless your project overrides the Build Command in its
  settings. Without the flag V8 sizes its heap at about half the physical memory it READS, and a
  container's memory limit never lowers that reading — measured, a 2 GB cgroup still left
  `heap_size_limit` at 8216 MB — so `eve build` can grow past the 8 GB build container and be
  killed. The flag is a CAP only where the build machine reports more than about 12 GB. Where the
  machine reports 8 GB, the default is already about 4 GB and the flag RAISES the ceiling instead,
  so read `heap_size_limit` from the build log before you raise the number again. The assignment
  also REPLACES any `NODE_OPTIONS` your project settings carry, for the build step only.
- **Egress enforcement.** The egress firewall is enforced by default on the Vercel Sandbox backend.
  Set `egress.enforce: false` only to opt out to dry-run while a host the agent needs isn't yet in a bundle.

## The one manual step

Surface registration is the single manual surface step: create the chat app (e.g. a Slack
app), copy its token and signing secret, and point its event webhook at the surface route
(`/eve/v1/slack`). Everything downstream of that — identity binding, access, memory,
routines — is automatic. Follow the [surface guides](../setup-runbook.md#5-surfaces) for
each chat tool.

## Swapping a seam on Vercel

Each seam is still independent. You can keep Vercel Sandbox and the scheduled cron but point
memory at a `github` silo, or swap the broker for your own KMS, without leaving Vercel.
The [adapter model](../../extending/adapter-model.md) covers how, and each
[seam page](../../extending/adapter-model.md) ends with an On-Vercel / Off-Vercel note.

## Deploying, and undoing a deploy

`vercel deploy --prod` does **not** move a custom-domain alias — that is a separate
`vercel alias set` step, which means rolling back is also just moving that pointer. The repo ships
that as one command, plus the health probe that decides whether it's needed:

```bash
vercel alias set <new-deployment-url> "$OE_DEPLOY_ALIAS" --scope "$OE_DEPLOY_SCOPE"
npm run deploy:verify -- --record   # HTTP-probe the alias; stamp known-good, or auto-roll-back
npm run deploy:smoke                # one real turn, asserted on audit rows; red ⇒ run the rollback
npm run deploy:census               # every required credential row + every ingress route answers
npm run rollback                    # one hop back to the last known-good, any time
```

See [Rollback, verify, record](../rollback.md) for the env vars, the known-good pointer, and what
auto-rollback deliberately won't do.

## Sandbox snapshots and storage cost

Every conversation runs on a persistent Vercel sandbox, and every turn-end stop snapshots it so
the next turn can resume. One fixed policy and one setting govern the storage this accumulates, and
Vercel executes both server-side (the agent never calls a delete API):

- `keepLastSnapshots: {count: 1, deleteEvicted: true}` is a **fixed core constant**, not a knob
  (`packages/core/agent/sandbox/vercel-create.ts`). It deletes the previous turn's snapshot the
  moment a new one lands, so an active conversation holds roughly one snapshot at a time.
- `sandbox.snapshotExpirationMs` (a typed setting; the 7-day default is shipped in the schema,
  `packages/core/agent/settings/settings.ts`, and your deployment overrides it in
  `agent/settings/settings.ts`)
  reaps a conversation's last snapshot once the conversation goes idle.

Storage cost therefore scales with the number of distinct conversations active in the trailing
retention window, and resolves itself as conversations age out. To lower the cost, lower
`sandbox.snapshotExpirationMs` — but note both bind at sandbox CREATE and persist on the
sandbox, so a lower expiration reaches only conversations that start after the deploy; existing
sandboxes keep the expiry they were created with. The trade-off: a conversation idle for longer
than the window resumes onto a fresh sandbox and loses its uncommitted working tree. The
transcript and the memory store are unaffected; `git push` is the durability boundary for code.

## Next

- [Setup runbook](../setup-runbook.md) — the full configuration walk.
- [Rollback, verify, record](../rollback.md) — the post-deploy safety net.
- [Configuration reference](../configuration-reference.md) — every field and env var.
- [Hosting overview](../hosting-overview.md) — how this set compares to off-Vercel.
