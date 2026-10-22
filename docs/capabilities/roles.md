# Roles & personas

How you give a channel group a *character*: a named **role** preset that gathers a
per-turn instruction block, a voice, themed status verbs, and (optionally) the same
knobs a domain already has — models, memory, sandbox size — declared once and
adopted by name.

Roles are **config-as-code and opt-in**. The library ships with the app but nothing is
bound until a domain says `role: "qa-engineer"`. And a role is *sugar, never a second
access path*: anything it presets resolves through exactly the same machinery as if you
had written the field on the domain yourself.

## The mental model: a preset over domain knobs, plus a prompt

A [domain](./memory.md) already carries the per-channel-group knobs — `models`,
`statusVerbs`, `memory`, `sandbox`. A **role** is a *named, reusable preset
across those knobs*, plus the one thing a domain doesn't have:

- **`instructions`** — a prompt block injected into the system prompt on every turn for
  the surfaces whose domain resolves to that role. *What the agent is acting as*:
  responsibilities, priorities, how to work.
- **`persona`** — the tone dimension of a role: *how it should sound*. A role that sets
  only `persona` is a voice-only persona (the pirate, the butler) — same registry, same
  mechanics, zero behavioural or access change.

```ts
// agent/roles/roles.ts
defineRole({
  name: "qa-engineer",
  instructions: "You are acting as this team's QA engineer. Hunt for edge cases…",
  persona: "Precise, a little skeptical.",
  statusVerbs: ["Probing", "Breaking"],        // themed working words
  models: { primary: { reasoning: "high" } },  // optional: any domain knob
})

// agent/memory/config/domains/qa.ts — one file per domain; list it in domains/index.ts
export const domain = defineDomain({ name: "qa", reach: ["slack/T…/C…"], role: "qa-engineer" })
```

A role's `name` is an **identifier** — `Domain.role` points at it, so renaming one breaks
every domain that references it (loudly, at config load). Set the optional `title` to
change what a human reads; see the note in the
[configuration reference](../deploy/configuration-reference.md#memory-domain--silo).

Bind a fun persona workspace-wide by putting it on the `org` pseudo-domain:

```ts
defineDomain({ name: "org", match: "org", role: "butler" })
```

## Merge rules: the domain always wins, field by field

A role never overrides what a deployer wrote on the domain. Precedence is the same
layering the rest of the system uses, with the role as its own rung **directly beneath
the domain that adopted it**:

```
framework defaults ← org pseudo-domain ← ROLE ← explicit domain
```

- **Single-valued knobs** (`memory`, `sandbox`) — the role fills the gap *only if the
  domain didn't set the field*. Resolved once at config load, so every downstream
  consumer (memory resolver, sandbox sizing, spend) sees a plain domain.
  There is **no capability knob** among them: a role has no access field, so it cannot
  confer tools. Bind a bundle to the domain instead
  (`{ level: "domain", domain: "<name>" }`). See the note below.
- **Status verbs** — the role's verbs join the existing layered merge as a rung: each
  layer *extends* what it inherited (default) or *replaces* it wholesale
  (`statusVerbsMode: "replace"`). A domain can add its in-jokes on top of its role's
  themed verbs. No surface shows them since OPE-2668: Slack's status line, their only
  reader, is gone. The field stays so a config that sets it still compiles.
- **Model routes** — merged field-by-field like every other route layer: a domain with
  `role: "qa-engineer"` and `models: { primary: { reasoning: "low" } }` keeps the
  role's model id and overrides only the reasoning. The
  [pin-drop rule](../how-it-works/access-and-scoping.md) holds through the role rung: a
  provider pin never survives a model-id change from a lower layer.
- **Instructions / persona** — not a domain knob; the winning role's block is rendered
  into the per-turn instructions. An explicit domain *without* a role falls through to
  the org pseudo-domain's role (the same workspace-default doctrine as model routes).

## Which sessions get the role

The role follows the session's domain, resolved by the same single-hop chain as memory
— at **domain grain**, so a thread asks its parent channel:

| Session | Role source |
|---|---|
| Channel in an explicit domain | that domain's role (falling through to `org`'s if unset) |
| Internal channel, unassigned | the `org` pseudo-domain's role |
| DM (internal partner) | the `dm` pseudo-domain's role — **no** fall-through to `org` |
| Externally-shared channel / external DM | the `public` pseudo-domain's role — **no** fall-through |
| Group chat (mpim) | none (execution-only) |

The shared-by-trust scopes deliberately don't inherit the org role: a workspace-wide
persona must not leak onto external or personal surfaces uninvited.

## Failure posture

- **Config load fails loud.** A typo'd `role:` name throws at startup, exactly like an
  unknown silo or an ambiguous channel — a role that silently presets nothing is the
  bug class this kills. Duplicate or facet-less role definitions are rejected the same
  way.
- **Runtime fails open.** At turn time a role is prompt flavour and tuning: any
  resolution error renders no block, contributes no verb/route rung, and applies no
  sandbox preset — it never takes a turn down.
- **No new access path.** `memory` arriving via a role goes through the unchanged
  [memory](./memory.md) resolution — the trust gate, exclusivity, and fail-closed rules
  all apply as if the field were written on the domain. A role never widens
  [access](../how-it-works/access-and-scoping.md) at all, and cannot: neither a role nor
  a domain has a field that grants a bundle. Capability comes only from a **binding**,
  which names the scope it applies to. Setting a capability knob on a role is a compile
  error, not a silent no-op.

## Sandbox sizing

A role (or a domain directly) may preset the sandbox size for its sessions:

```ts
defineRole({ name: "engineer", instructions: "…", sandbox: { vcpus: 4 } })
```

On the Vercel backend the app's `defineSandbox` selector applies it per session: it opens the
sandbox environment with `resources.vcpus`, which eve forwards to the Vercel SDK. It is fail-open end to end: if the resolution or the
sized open fails, the session opens at the default size and the turn proceeds.

## The starter library

The app template ships a deliberately generous cast in `agent/roles/roles.ts` — prune
to taste, none are bound by default:

- **Working roles** — `engineer`, `qa-engineer`, `product-manager`, `support`,
  `analyst`, `scribe`: each a tight instruction block plus themed status verbs.
- **Voice-only personas** — `butler`, `pirate`, `noir-detective`, `corporate-parody`,
  `hal-but-helpful`: tone only; access, memory and models untouched.

Writing your own: keep `instructions` to a short paragraph or a few bullets (it rides
every turn's prompt for the bound channels), say what to *prioritise* rather than
restating the base prompt, and keep `persona` to a sentence or two of voice.
