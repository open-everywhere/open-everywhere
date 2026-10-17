# Configuration reference

The reference appendix: every config field (bundles, grants, scopes, caps, routines,
providers, silos, domains) and every environment variable. Config-as-code lives in your
git repo and deploys with it; env vars hold secrets, instant state, and adapter selection.
See [Config-as-code](../how-it-works/config-as-code.md) for the repo-vs-runtime split.

---

## Config-as-code (in your repo)

These are TypeScript definitions, reviewed by PR. Field names below are the real interface
shapes — use the `define*` helpers (`defineBundle`, `defineBinding`, `defineConnectorCredentials`,
`defineDomain`, `defineNetworkAccess`).

**Every** config file is TypeScript — there is one authoring language, and no JSON dialect to
learn. But three of them are **machine-owned**, and that is a different distinction from the
language they are written in:

| File | Written by | Flow |
|---|---|---|
| `agent/access/grants.generated.ts` | the grants codemod | [access requests](../how-it-works/access-requests.md) |
| `agent/access/credential-bindings.generated.ts` | the credential-bindings codemod | [credential custody](../security/credentials-and-planes.md#moving-custody-env--db-the-binding-pr) |
| `agent/webhooks/hooks.generated.ts` | the hooks codemod | [`declare_webhook`](../extending/webhook-ingress.md) |

Each is a **data module**: a fixed header, one type-only import, and exactly one
`export default { … } satisfies <Type>;` statement. Nothing else. A deterministic codemod writes
it on a bot-PR branch, the PR merge is the approval gate, and the bytes are a pure function of the
data — which is what makes each PR a minimal, reviewable diff.

**Don't hand-edit them.** The overlay check re-emits each file from its own parsed data and fails
on any byte difference below the header, so a hand-edit — including one that adds executable code —
fails the check. The header must open with the fixed `GENERATED + MACHINE-OWNED` banner and hold only
`//` lines; its other words may be older than the current emit, so a header change in a new release
does not refuse an existing app's overlays. If you must change one by hand, edit only the data and
then re-emit it.

| | An npm app (`npx create-open-everywhere`) | This repository |
| --- | --- | --- |
| Check | `npx oe overlays check`, or `npx oe build --check`, which runs it | `npm run lint:overlays`, a required leg of the `npm test` chain |
| Re-emit | `npx oe overlays normalize` | `npm run overlays:normalize` |

The check runs only when something runs it. In an npm app, run `npx oe build --check` before you
merge a pull request that changes an overlay; the merge is the approval gate. Hand-authored grants belong in `bundles.ts`,
hand-authored hooks in `hooks.ts`.

### Bundle

A named capability set. Defined once, bound to many scopes.

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | Stable id; referenced by a binding. **Immutable once referenced** — see the note under [Memory domain & silo](#memory-domain--silo). |
| `title` | `string` | Optional human-facing display label. Cosmetic only. Absent → `name`. |
| `connections` | `Connection[]` | Egress (firewall) credential plane: hosts + static creds injected at the sandbox boundary. |
| `connectors` | `{ name, credential, contentOrigin }[]` | Connector plane, and the **only** grant grammar for it. `name` is the Eve connection slug (host-side MCP/OpenAPI). `credential` names which configured identity this scope reaches it as, from that connector's catalogue in `agent/access/connector-credentials.ts` — **mandatory**, with no default resolution, so a connector with exactly one credential still names it; `npm run lint:connections` fails a grant naming one that is not configured, and the resolver contributes **nothing** for such a grant (not the connector without its identity). `contentOrigin` says **who authors the bytes the connection returns** — `"internal"` (only org members can) or `"external"` (anyone can) — and feeds the source-tier table. It is a question about authorship, not authentication: an org-owned, VPN-only support desk whose tickets strangers type is `"external"`. **Required**, and never inferred: omitting it is a config error naming the connection and the accepted shapes. Per-tool grain for a server where only some tools reach outside content: `{ name: "helpdesk", contentOrigin: { default: "internal", except: { search_tickets: "external" } } }`, where `except` keys are BARE tool names (no `helpdesk__` prefix). Exempt from `contentOrigin` **only**: connectors written by an access-request or agent-creation codemod, whose vocabularies write `{ name, credential }` and refuse an origin so that no *assertion* on those paths is model-authored — those declare no origin and stay on the fail-closed default. They still name their credential. See [Connectors & providers](../capabilities/connectors-and-providers.md#declaring-who-authors-a-connectors-content). |
| `connectorOps` | `ConnectorOpGating[]` | Connector-**op** plane: `{ connector, gated?, destructive? }` — **raise-only** per-operation gating over the verb classifier. See [Connectors & providers](../capabilities/connectors-and-providers.md). |
| `repos` | `string[]` | GitHub repos granted (grant ≠ auto-clone; clones only when named). |
| `domains` | `string[]` | Credential-less egress allowlist — hosts reachable without a credential. |
| `plugins` | `string[]` | Plugin packages granted by name; each expands to its connectors / skills / subagents. |
| `instructions` | `string` | Owner-authored standing rules; concatenated across scopes in precedence order. |

> `domains` here means *egress hosts*, not the `domain` scope level (a surface grouping).
> Unfortunate word overlap; they are different concepts.

### Connection (egress plane)

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Connection id. |
| `credentialType` | `"bearer" \| "basic" \| "github-app"` | Static, header-stampable types only. |
| `secretRef` | `string` | Reference to the secret (resolved via the broker); never the value. |
| `allowedWebsites` | `string[]` | Hosts reachable AND the only hosts the credential is sent to. Leftmost-label wildcard only (`*.googleapis.com`) — enforced at config load; see [Host patterns](#host-patterns-one-wildcard-form-and-it-is-enforced). `github.com` and `codeload.github.com` are reserved by the git read-broker and may not be claimed. |
| `pathPrefixes` | `string[]` | Optional path-prefix narrowing. |
| `customHeaders` | `CustomHeader[]` | Secret-valued headers (`name` + optional `prefix` + `secretRef`). |
| `methods` | `HttpMethod[]` | Optional read-only narrowing to specific HTTP methods. |

#### Host patterns: one wildcard form, and it is enforced

🔴 **`allowedWebsites` and `domains` admit exactly one wildcard spelling: a single LEADING `*.`**
— `*.vendor.com`. Every other spelling is refused at config load, and the boot assertion names the
pattern. This applies to both fields, in every bundle.

**Migration.** If your own `agent/access/bundles.ts` carries a pattern like `api.*.vendor.com`,
`*vendor.com`, `api.vendor.*` or `*.a.*.com`, this release stops it loading. It never worked: this
deployment expands only the leading form, so any other spelling was compared as a **literal**, read
as one destination of its own, and never paired with the hosts you meant — which also means the
one-credential-per-host rungs stayed clean over it. Replace each with the real hosts, or with a
leading `*.` over the suffix they share:

| Was | Write instead |
|---|---|
| `api.*.vendor.com` | `api.eu.vendor.com`, `api.us.vendor.com`, … (or `*.vendor.com` if one credential really may reach them all) |
| `*vendor.com` | `*.vendor.com`, plus `vendor.com` if the apex is reachable too |
| `api.vendor.*` | the real hosts, one per TLD you use |

A leading `*.` covers subdomains only, never the apex — declare `vendor.com` beside it if you need
both. `*` and a bare-TLD `*.com` are refused separately, as overly broad.

### Binding & Scope

A binding attaches a bundle (by name) to a scope.

| Field | Type | Meaning |
|---|---|---|
| `bundle` | `string` | References `Bundle.name`. |
| `scope.level` | `"org" \| "tenant" \| "domain" \| "surface" \| "group" \| "principal"` | Specificity for narrowest-wins: `org < tenant < domain < surface`. `group` and `principal` are off the ladder — they are the DM universe and never co-resolve with the rest (`group < principal` between themselves). |
| `scope.tenant` | `string` | Required for `tenant`, and **only** for it. The platform-qualified tenant key `platform/<tenant-id>` (`"slack/T0123ABC"`, `"discord/1300000000000000100"`, `"github/acme"`). A bare vendor id is rejected at config load. |
| `scope.domain` | `string` | Required for `domain`, and only for it. The memory-domain's **bare name** — deliberately not tenant-qualified, because a domain is cross-platform. |
| `scope.surface` | `string` | Required for `surface`, and only for it. The fully-qualified surface key `platform/<tenant-id>/<container-id>` — the same form a domain's `reach` entries take. |
| `scope.group` | `string` | Required for `group`, and only for it. An `identity/groups.ts` group **name**, bare (no platform qualifier — a group is a set of humans, cross-platform by construction). See [Person-groups](../how-it-works/access-and-scoping.md#person-groups-grouping-people-not-rooms) for `defineGroup`, membership forms, and resolution. |
| `scope.principal` | `string` | Required for `principal`, and only for it. The qualified principal key `platform/<principal-id>` (`"discord/300000000000000104"`) — and on a **tenant-scoped** platform the workspace rung too, `platform/<tenant-id>/<principal-id>` (`"slack/T0AB1CD2E/U0123ABC"`), because a Slack member id is issued per workspace. A bare member id is rejected at config load — it names no namespace, and this level selects one person's *own* credentials. A Slack key missing its workspace is rejected for the same reason one rung down, with the exact replacement string in the error. |

> A scope carries **exactly one** address field — its level's. A stray one (a `tenant` on a
> `domain` scope, say) fails at config load: it means the author meant a different level.

### Network-access binding (the environment axis, OPE-509)

A `defineNetworkAccess` binding pins a named network-access **level** to a scope — a policy
orthogonal to a `Binding`'s capability grant, resolved narrowest-wins the same way, restricted
to the container ladder only (no `group`/`principal`: [why](../how-it-works/access-and-scoping.md#network-access-levels-the-environment-apart-from-credentials)).

| Field | Type | Meaning |
|---|---|---|
| `scope` | `Scope` | Same shape as a `Binding`'s scope, restricted to `"org" \| "tenant" \| "domain" \| "surface"`. |
| `level` | `"trusted" \| "none" \| "full"` | `"trusted"` adds the curated package-registry + developer-host set (`TRUSTED_ACCESS_HOSTS`); `"none"` (the default when nothing pins a scope) adds nothing; `"full"` adds an unrestricted catch-all. All three are ADDITIVE — never a restriction on what a bundle already grants. |

Declared in `agent/access/network-access.ts`, registered via `AppConfig.loadNetworkAccess`
(optional — absent/empty means every scope resolves `"none"`, byte-identical to a deployment
that predates this axis).
### ConnectorCredentials (the credential catalogue)

One catalogue per connector: the identities configured against it, and the credential types
that connection accepts. See [Connectors & credentials](../capabilities/connectors-and-providers.md).

| `ConnectorCredentials` field | Type | Meaning |
|---|---|---|
| `connector` | `string` | The host-side MCP connection slug this catalogue configures — the same string a bundle grant's `name` carries. One catalogue per connector. |
| `allows` | `ConnectorCredentialType[]` | Credential types the connection accepts (`api-key` / `service-oauth` / `user-oauth`). |
| `credentials` | `ConnectorCredential[]` | Configured credentials; each `{ id, type, secretRef?, broker?, home? }`. |
| `skill` | `string` | Optional agent-facing reference skill. |
| `description` | `string` | Optional. |

A bundle grant names one of these ids in `connectors: [{ name, credential, contentOrigin }]`.
Universe gate: `user-oauth` credentials resolve only in DMs. A grant whose credential does not
resolve contributes nothing (fail closed).

### Memory domain & silo

A domain anchors the opt-in memory model. See [Memory](../capabilities/memory.md).

#### Wake, seat, memory: three independent axes

Three domain fields answer three different questions about a channel. Each field changes one
answer and leaves the other two alone. All three resolve per channel, from the channel's explicit
domain, else from the `org` pseudo-domain.

| Question | Field | A channel in an explicit domain | An undeclared channel (no explicit domain) |
|---|---|---|---|
| **What wakes the channel's standing seat?** | `ambientSupervisor` | The domain's value, else the `org` value, else on. | The `org` value, else on. |
| **How many channels share one standing seat?** | `mode`, `windows` | A `windows` group, else the domain's `mode`. A declared team domain that omits `mode` defaults to `unified` when it qualifies, else `solo`. | **Solo: the channel has its own standing seat, and shares it with no other channel.** Config load refuses `mode` and `windows` on `org`, `public` and `dm`. |
| **Which memory does the seat read?** | `memory`, `includeOrg` | The domain's silos, plus the `org` silos under `includeOrg`. An external channel reads the `public` domain's silos, read-only ([trust gate](../capabilities/memory.md#the-trust-gate-the-security-keystone)). | The `org` domain's silos, but only when `org` declares `memory`. An external channel reads the `public` domain's silos, read-only ([trust gate](../capabilities/memory.md#the-trust-gate-the-security-keystone)). |

- 🔴 **`ambientSupervisor` never creates, merges or splits a seat.** On at `org` means that each
  undeclared channel's OWN standing seat wakes on an unaddressed message, on a surface that reads
  the flag. It does not put the
  undeclared channels into one seat or one context.
- **A shared seat exists only where a deployer declares one:** an explicit team domain whose `mode`
  resolves `unified`, or a `windows` group. The code is `windowModeFor`, `resolvedWindowMode` and
  `supervisorGrainFor` (`packages/core/agent/memory/domain.ts`,
  `packages/core/agent/channels/unified-supervisor.ts`).
- **Shared memory is not a shared seat.** Two seats that read one silo share what a turn wrote to
  that silo. They do not share their live conversation context.
- **The precondition is `window.topology`** (on, shipped). Off, no channel has a standing seat. A
  deployment that declares no `org` pseudo-domain also gives an undeclared channel no standing
  seat and no ambient wake from `ambientSupervisor`: there is nothing to inherit.
- **Discord and Teams do not read `ambientSupervisor`.** Each surface page says which untagged
  messages wake the agent there.

#### Where a domain lives, and how you add one

**One file per domain.** Each lives in `agent/memory/config/domains/<name>.ts` and exports exactly
one `defineDomain(...)`, so a membership change is a one-file diff and every domain has its own
review surface:

```ts
// agent/memory/config/domains/payments.ts
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";

export const domain = defineDomain({
  name: "payments",
  reach: ["github/acme/payments-*", "slack/T_CO/C_PAY"],
  exclude: ["github/acme/payments-secrets"],
  memory: "payments-silo",
});

/** Optional. Absent = always registered; the loader reads this before it registers the domain. */
export const enabled = (): boolean => process.env.SOME_FIXTURE_FLAG === "1";
```

**Adding one is two edits:** write the file, then add it to the list in
`agent/memory/config/domains/index.ts` (an `import * as payments from "./payments.js";` plus a line
in `MODULES`). The list is explicit rather than a directory scan for two reasons: the deployment
builds to a bundle, where a runtime directory read finds nothing; and an explicit list makes the
domain set a reviewable diff — a new domain shows up as a line in that file, never as a file that
appeared.

**The loader refuses a duplicate name**, loudly, naming both entries. A domain name is an
identifier: it keys the operational store's domain rows and the synthetic session-registry key
`oe-domain::<name>`, so two modules under one name would put two configurations on one set of rows
and whichever loaded last would silently win. A module whose `enabled()` is false is not registered
at all, so a flag-gated fixture and the domain it stands in for may share a name across the flag.

**Everything cross-domain stays one assertion over the whole set**, in
`agent/memory/config/domains.ts` — at most one domain per key, no unorderable overlap, every room a
domain names outright routing back to it, silo validity, the agents-overlay merge. None of those is
decidable one file at a time. That module also still exports `loadDomains()`, `loadSilos()` and
`domainsForSurface()`, so nothing that imports the config had to change.

> **Names are identifiers, and identifiers are immutable.** A `Domain`, `Role`, `Bundle` or
> `MemorySilo` `name` is what other config — and, for a domain, *stored data* — points at.
> A domain name is persisted verbatim into operational rows (its model pick, its runtime
> skills, a domain-scoped spend cap's scope key, credential labels), into routine rows frozen
> at arm time, into audit detail, and into the session-registry key `oe-domain::<name>`.
> **Nothing migrates on a rename**: the old rows are orphaned and the renamed domain starts
> empty, silently. Bundle and role names are cheaper — a dangling reference fails loud at
> config load — but they are still identifiers.
>
> To change what a **human** reads, set the optional `title` instead. It is cosmetic by
> construction: nothing resolves, matches, partitions, authorizes or persists on it. If a
> `name` genuinely must change, treat it as a data migration, not an edit.

| `Domain` field | Type | Meaning |
|---|---|---|
| `name` | `string` | Stable id; also the on-disk bucket name. **Immutable once referenced** — it is persisted into rows and registry keys (see the note below). |
| `title` | `string` | Optional human-facing display label (approval cards, refusal copy, reports). Cosmetic only. Absent → `name`. |
| `reach` | `string[]` | **What this domain reaches — one list, three shapes.** An exact `platform/workspace/surface` key names one room; a two-segment tenant key (`github/acme`, `linear/<orgId>`, `notion/<workspaceId>`) reaches everything under that tenant; a three-segment **same-level glob** (`github/acme/payments-*`) reaches just the surfaces whose last segment starts with that prefix. The last two are CONTAINERS: they include surfaces created later — that is the point — so nothing enumerates them, and the callers that need a finite list (approval-card venue, `reportChannel`, a `governance` venue) read the exact entries only. **Most specific wins**, across domains and within one: an exact key beats a container, a longer container beats a shorter one. So a channel belongs to **at most one** domain — one when some entry matches it, none when none does — and handing a slice of one domain's tenant to another is written by writing the narrower entry. One trailing `*` only, on the last segment (no `**`, no regex, never in the platform/tenant segment); a deeper key is refused at config load, as are two entries in different domains that reach exactly the same keys. XOR `match`. |
| `exclude` | `string[]` | Carve-outs from this domain's `reach`, and **exclusions always win**: `reach: ["github/acme/payments-*"], exclude: ["github/acme/payments-secrets"]`. Three-segment entries — an exact surface key, or the same trailing-`*` glob. An excluded surface leaves the domain entirely and falls through to `org` unless another domain reaches it; handing a slice to another domain needs no exclusion at all, since the narrower entry wins on its own. Refused at config load: a whole-tenant exclusion, an exclusion that cancels a whole `reach` entry, one that matches none of this domain's entries, and one aimed at a key this domain reaches exactly. |
| `match` | `"org" \| "public" \| "dm"` | Criteria pseudo-domain (selected by trust/mode). At most one per value. XOR `reach`. `org` is the fallback for every channel in no explicit domain: such a channel inherits `org`'s `ambientSupervisor` and reads `org`'s silos when `org` declares `memory`, but its standing seat is always solo — config load refuses `mode` and `windows` on a pseudo-domain. See [Wake, seat, memory: three independent axes](#wake-seat-memory-three-independent-axes). |
| `memory` | `string \| string[]` | MemorySilo name(s) this domain's memory lives in. Omit = grouping only. |
| `includeOrg` | `"readonly" \| "inherit"` | Pull the `org` pseudo-domain's silos in as one unit. Forbidden on `org` / `public`. |
| `memoryCanvas` | `boolean` | Show this domain's memory as the channel canvas of its **internal** Slack channels, rewritten on every write to one of its silos. Default on for a domain with `memory`; `false` turns it off and takes the app's existing canvas down (replaced with a notice that holds no memory) on the next write to the domain's silos or the next join or share in the channel. Written only into a channel that Slack confirms unshared and whose every member is a confirmed full member (both checks fail closed), and never over a canvas a person made. Needs the `canvases:write` scope. See [Memory you can see](../capabilities/memory.md#memory-you-can-see). |
| `dmQuestions` | `boolean` | May a member ask this domain from their own DM (OPE-2452)? Default on. The person's DM seat sends the question to the standing seat of this domain's room the person sits in; that seat answers under this domain's own policy, and the answer goes to the person's DM only. Only a full member of the workspace who sits in one of this domain's **internal** rooms may ask (both checks fail closed). `false` refuses every DM question to this domain, and refuses an answer to a question asked before the change. Slack only today: a platform with no membership probe refuses. See [Your DM can ask your domains](../capabilities/domain-questions.md). |
| `nameDropWake` | `boolean` | Judged reply to a top-level message that says the agent's name without a mention. **No inheritance** — an explicit domain's flag is its word (absent = off); unassigned channels use the `org` pseudo-domain's. Default off. See [Slack](surfaces/slack.md). |
| `ambientSupervisor` | `boolean` | **The chattiness switch: does an UNADDRESSED message wake this domain's standing seats?** 🔴 It answers only that question. It does not decide how many channels share a seat (`mode`, `windows`: an undeclared channel's seat is always solo), and it does not decide which memory a seat reads (`memory`). See [Wake, seat, memory: three independent axes](#wake-seat-memory-three-independent-axes). **On — the default since 0.4.0 (OPE-2409)** — the seat is woken by every message/comment on this domain's surfaces and steps in only where it adds something, with every silence audited (the "always-on teammate"). `false` makes the room **addressed-only**: a mention or a name-drop wakes the seat, ambient talk does not, and that talk still reaches the seat as context on its next wake. **It inherits like `engagementTier`:** an explicit domain's own value, else the `org` pseudo-domain's, else on. So `org: { ambientSupervisor: false }` turns it off for every domain that does not set `true` itself, and an explicit domain can opt back in. The one fail-closed arm: a surface in no explicit domain on a deployment with **no** `org` domain is off — there is nothing to inherit. 🔴 **The flag lifts no fence.** The checks below it still apply whatever it says: Slack's positive internal-channel confirmation (an externally-shared or unconfirmable channel gets no ambient wake), GitHub's private-repo floor, the per-surface author and trust checks, the tenant fence and the spend caps. DMs never take the ambient road. **Reach on a default install:** Slack channels confirmed internal, private or vouched GitHub repos, every Linear team the app can see, and every Notion page the integration can see — including a page in no explicit domain, at `external` trust unless vouched. Discord and Teams do not read this flag. **What it costs:** a quiet room costs nothing — there is no timer and no poll. Each unaddressed message costs one judged turn on the `supervisor` model route (the scaffold routes it to a cheap tier at `low` reasoning; unset, it falls back to `primary`), and a silent verdict is still a paid turn. 🔴 **It does not decide whether a seat EXISTS.** Every channel the bot is in has one standing seat once `window.topology` is armed; this flag decides only what wakes it, which is also what decides whether the agent can reply at all (a turn's reply target comes from the wake it answers). Applies across platforms — one flag covers a domain of Slack channels + GitHub repos + Notion docs + Linear teams. See [Notion](surfaces/notion.md), [GitHub](surfaces/github.md), [Linear](surfaces/linear.md), and [UPGRADING](../../packages/core/UPGRADING.md) for a 0.3.x deployment. |
| `admission` | `string` | **Which messages ENTER this domain's standing seats, by the NAME of an admission function** (`agent/channels/seat-admission.ts`). `wide` (the default) admits every person at any trust tier, the agent's own prior posts, another OE session's relay and the harness's own lines, and refuses foreign bots; `wide-with-bots` also admits an **attributable** foreign bot at the `relay` tier; `members-only` admits only people the trust plane vouched (`principal`/`peer`), keeping a guest's or a Connect stranger's words out of the seat. A name selects **deterministic code**, so a new policy is a PR against that registry, never a config string — an unregistered name is **refused at config load**. Same **no-inheritance** rule as `nameDropWake` (not `ambientSupervisor`, which inherits): an explicit domain's declaration is its word (absent = `wide`, never the org's); unassigned channels use the `org` pseudo-domain's. Setting it on `org` therefore covers undeclared channels only — declare it on each domain you mean. Admission decides what the seat **reads** on a wake it is already taking; it never decides whether the seat wakes.<br><br>**A seat reads through two slots, and the policy governs both.** The **catch-up read** — what the room said since this seat's last wake — is policed on all six surfaces. The **hydration slot** — the surrounding conversation a mention or a name-drop attaches, plus the issue/PR **title** on GitHub and Linear — is policed on Slack, Discord, GitHub and Linear; Teams and Notion fill that slot on no road, so there is nothing to police there. 🔴 **THE SEAT DECIDES, NEVER THE ROAD.** Slack and Discord each have a native per-thread wake beside the seat's own, and the policy runs on both wherever the room HAS a seat — so a Discord wake that falls back to the native road because the guild is not operator-vouched is still policed. One domain therefore gets one admission answer, never a second one chosen by a runtime vouch. 🔴 **A room with NO seat is outside this**: `window.topology` unarmed, or no seat domain reaches the room. Its native wake keeps the whole hydration, which is the only context such a wake carries. GitHub and Linear have no native hydration road at all, so their supervisor wake is policed whatever `window.topology` says. 🔴 **On GitHub and Linear the title line carries no vouched author** — neither wake knows who OPENED the issue — so it floors at `unauth` and `members-only` refuses it: that seat reads the comment without the title. `wide` and `wide-with-bots` admit it unchanged. |
| `mode` | `"solo" \| "unified"` | **Standing-window topology for the containers no `windows` group claims — inert unless the deployment arms `window.topology` (see below).** `solo` gives each of them its own standing window; `unified` fans **every** unclaimed source's wakes into ONE session, so a GitHub reply can quote a Slack decision from live context rather than memory. `unified` is a materially **wider data blast radius** — everything said on those surfaces is in one context — so a window holding more than one source additionally requires every source to be operator-vouched-internal at config load. 🔴 **Omitted on a declared team domain, it defaults to `unified`** (OPE-2412, since 0.5.0). The default never applies to `org`, `public` or `dm`. The default falls back to `solo`, and the boot logs one `[open-everywhere:window]` line, when the domain's `reach` holds a tenant or glob entry, or when a room outside Slack is not declared internal. It falls back silently when one room or none is left after the `windows` groups. An explicit `mode: "unified"` keeps the fail-loud vouch rule instead. Write `mode: "solo"` to keep one seat per room. It is **independent of `ambientSupervisor`**: topology says how many channels share one context, the flag says what wakes the seat. Forbidden on `org`/`public`/`dm`, which is what keeps every undeclared channel's seat **solo** — its own room's, never a shared one. The default never applies to a pseudo-domain or to a DM seat. See [Wake, seat, memory: three independent axes](#wake-seat-memory-three-independent-axes). |
| `windows` | `{ name, reach?, exclude? }[]` | **Named standing windows — N per domain, instead of the two shapes `mode` can express.** Each entry gives its members ONE shared context window; a member no group lists falls through to `mode` exactly as before. So `windows` is additive: a domain that omits it behaves identically. Membership uses the same one list and the same rule as the domain itself: **most specific wins**, so a group's exact key beats another group's broader glob whatever order the groups are declared in, and `exclude` always wins. A group can only slice what its domain already holds — never annex a surface. **Memory, trust and access stay at the DOMAIN grain**: a group slices the live context window only, so two groups in one domain share one memory. Same gate and same required chain as `mode` — inert unless the deployment arms `window.topology`, forbidden on `org`/`public`/`dm` (and, since OPE-1695, independent of `ambientSupervisor`). 🔴 **The name IS the window id**, and a window id keys the session registry globally, so a name is lowercase kebab (≤64 chars), unique across every domain, and never a domain name — all refused at config load, as are two groups of one domain whose entries reach exactly the same keys (the one case specificity cannot order). A window holding more than one source carries the same operator-vouch requirement `mode: "unified"` does. Example: `windows: [{ name: "support", reach: ["slack/T1/C_TIER1", "slack/T1/C_TIER2"] }]` on a domain whose other channels stay solo. |
| `engagementTier` | `"aggressive" \| "neutral" \| "reserved"` | How eagerly the ambient supervisor steps in on this domain's surfaces — the calibration dial. **Inherits like `models`** (a tuning knob): explicit domain ← `org` pseudo-domain ← the per-platform default (**GitHub defaults `reserved`** — an over-eager bot in a collaborative code space reads as spam; everything else `neutral`). `neutral` is exactly the shared engagement bar; the other tiers tune it, never bypass the judge. Meaningful wherever the seat is woken — on an addressed-only domain that is a mention or a name-drop. |
| `credentials` | `{ connector, credential, use, inboundSecret? }[]` | **Per-domain credential override** — this domain reaches a connector through **its own** credential instead of the deployment default. Read it as a sentence: *for `connector`, wherever this deployment would use `credential`, use `use` instead*. A domain that declares nothing here uses the org default, unchanged — an override is an addition, never a precondition. A binding that names a credential the connector does not declare is **refused at boot**, never silently downgraded to the org key. `inboundSecret` names the operator secret holding that integration's **inbound** webhook signing key, which is what lets a second vendor subscription's deliveries verify at all. Built for Notion, where one integration per domain buys **vendor-enforced** isolation — see [Notion](surfaces/notion.md#step-4--one-integration-per-domain-optional). Two Notion roles honour a binding today: `channel-key` (replies, the webhook two-step, the read tools) and `memory` (the read-only page-subtree projection). They are independent — bind one, both, or neither. A binding for any other `(connector, credential)` pair validates and resolves but is **inert**; it is not evidence that a vendor honours it.<br><br>**WORK roles read this field by the OPPOSITE rule.** Declaring a provider's WORK role here is not an override — it is the **grant**, and absence is a refusal, never the deployment default. Two work roles exist today: `{ connector: "notion", credential: "team-key" }` mounts the Notion work tools for this domain's delegated workers, and `{ connector: "linear", credential: "workspace" }` lets a session woken on **any** surface in this domain file into Linear and mutate the issues it finds there (`set_state` / `assign` / `add_label`), with `use` naming the Linear **organization id** — which is at once the destination workspace and the token the write is made with. The domain needs no Linear channel for this: chat presence is never a precondition for using a tool. A domain that declares neither role may do no work on that provider from any surface. See [Linear § Working from another surface](surfaces/linear.md#working-from-another-surface-the-linear-work-grant) and [Notion § one integration per domain](surfaces/notion.md#step-4--one-integration-per-domain-optional). |
| `models` | `ModelRoutes` | Per-role model routing for this domain's channels. **Inherits field-by-field**: agent static defaults ← `org` pseudo-domain ← explicit domain — set org-wide once, override only what a group needs. Roles: `primary` (the turn model, and the model that writes compaction summaries) and `utility` (the dream cycle's judge/distiller — see [Memory](../capabilities/memory.md#memory-hygiene-the-dream-cycle)). |
| `statusVerbs` | `string[]` | The working-status vocabulary ("Tinkering…", "Untangling…") — one is picked at random per status update. On Slack, a tool step with a code-owned step label (`Searching Notion…`) shows that label instead. **Inherits**: framework defaults ← `org` pseudo-domain ← explicit domain; each layer extends the inherited list by default. Purely cosmetic fun — give your org house verbs, let a team add in-jokes. |
| `statusVerbsMode` | `"extend" \| "replace"` | How this domain's `statusVerbs` combine with the inherited list: `extend` (default) appends; `replace` makes its list the whole vocabulary. Replace-with-empty falls back to the defaults. |
| `language` | `string` | **The output language for this domain's sessions** (OPE-2450): one BCP 47 tag, e.g. `"fr"`, `"de"`, `"pt-BR"`. It overrides the org default, the `language.output` setting. **Inherits like a role:** an explicit domain without its own tag takes the `org` pseudo-domain's, then `language.output`; the `dm` and `public` scopes read their own tag, then `language.output`, and never the `org` pseudo-domain's. Set, every session in the domain — the seat and every worker it delegates to — reads one prompt section: write in that language, unless the person writes in another language or asks for another one, and keep code, commands, identifiers and quoted text as they are. A malformed or unknown tag is refused at config load. 🔴 It is an instruction to the model, not a translation layer: approval cards, slash-command output and other host-rendered text stay in English. |
| `admins` | `string[]` | RBAC (`packages/core/agent/access/roles.ts`): qualified principal keys granted admin over this domain — `platform/<principal-id>` (`"discord/300000000000000104"`), plus the workspace rung on a tenant-scoped platform (`"slack/T0AB1CD2E/U0EXUSER002"`). One roster covers a human on several surfaces; a bare id is rejected at config load, since every matcher builds the qualified key from the wake's own surface, and so is a Slack key missing its workspace. Note that on Slack **the same human in two workspaces is two entries** — admin standing is exact-account, with no runtime link-set read on the highest-privilege gate. The one exception is a Slack Enterprise Grid, where one member id serves every workspace: an entry at the Grid id (`"slack/E0GRIDID/U0EXUSER002"`) admits that person in every workspace whose delivery names that Grid (OPE-2400, see [Slack § Admin keys on a Grid](./surfaces/slack.md#admin-keys-on-a-grid)). On the `org` pseudo-domain, means the ORG admins (workspace-wide); on an explicit domain, that domain's admins. **Does not inherit** from `org` (an explicit domain's admins are its own list only) — but an org admin is also a domain admin everywhere. Absent/empty = no admins for that scope (the anyone-in-the-domain tier still applies wherever an operation is tiered that way). See [Access & scoping](../how-it-works/access-and-scoping.md#roles-whos-an-admin). |

`ModelRoute` (each role's value; every field optional — absent inherits). The schema is
**vendor-neutral**: how a route reaches a model transport is the configured **model
backend adapter**'s job. The reference backend is the Vercel AI Gateway
(`@open-everywhere/adapters`); a deploy on OpenRouter or a direct provider SDK swaps
the backend without touching domains or core.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Model id in the backend's namespace (`creator/model` on a gateway, e.g. `anthropic/claude-sonnet-5`). |
| `providerOrder` | `string[]` | The order the backend tries serving providers in — a PREFERENCE, never an allowlist (the AI Gateway maps it to `order`, which still fails over; a direct-provider backend ignores it). It wins over the target's own `providers.order`. For an allowlist, set `models.targets.<name>.providers.only` (see [models & the AI Gateway](../extending/models-and-gateway.md#model-targets-where-calls-go)). Renamed from `providers` in OPE-2556: a route that still names `providers` fails config load and names the new key. A pin belongs to the id it was set with: an overlay that changes `id` without `providerOrder` **drops** the inherited pin rather than pinning a new model to an upstream that may not host it. |
| `via` | `string` | The `models.targets` entry this route's calls go through (OPE-2556). Absent: `gateway`. A name that is not in `models.targets` fails config load. It inherits field by field, like `reasoning`. |
| `reasoning` | `"none"…"xhigh"` | Reasoning effort for this route (overrides the agent's static `reasoning`). Provider-agnostic; backends that can't map it ignore it. |

Routing is **fail-soft**: it tunes which model answers, it is not an access boundary — any
resolution failure falls through to the agent's static model config (logged, never fatal).

**DM/public routing.** The `dm` and `public` [criteria pseudo-domains](../capabilities/memory.md#criteria-pseudo-domains-org-public-dm)
can carry their own `models` route too — not just `org`. The merge order is
`agent static defaults ← org ← (dm | public criteria, whichever the session
classifies as) ← explicit domain`: a DM (which never has an explicit domain) picks up
the `dm` domain's route on top of `org`; an externally-shared/guest surface picks up
`public`'s. An explicit channel domain still wins over either, same as it wins over
`org` today. Session classification mirrors the memory resolver exactly (internal DM
→ `dm`, external DM or external channel → `public`, a normal internal channel →
neither layer, just `org` + explicit).

| `MemorySilo` field | Type | Meaning |
|---|---|---|
| `name` | `string` | Stable id; also the on-disk dir name. |
| `provider` | `string` | Backing type, resolved against the MemoryProvider registry at startup. The built-in names are `sqlite`, `postgres`, `git`, `github` and `notion`; a self-roll may register its own `MemoryProvider` and name it here. Required — every silo materialises. |
| `description` | `string` | One-line purpose, surfaced in the memory index. |
| `container` | `string` | Repo (`github`), teamspace/page id (`notion`), or unused for plain DB. |
| `path` | `string` | Subtree within the container. |
| `readOnly` | `boolean` | Read into the sandbox but never persisted; files locked fail-loud. |
| `skill` | `string` | The skill that teaches how to update this source. |
| `recursive` | `boolean` | Descend the subtree (default `true`). Mutually exclusive with `select`. |
| `select` | `MemorySelection` | Curated subset of a tree backing (per-node `recurse` / `include` / `exclude`). |

### Model policy (the model/reasoning envelope)

Config-as-code in `agent/model/policy.ts` (`defineModelPolicy`, validated at import by
`assertModelPolicyValid`). This is the git-config **security envelope** around model choice —
*what a deployment may ever call* — not which allowed model a given domain picks (that's a
separate runtime self-serve layer, a domain admin's live pick — see "Runtime self-serve
(the pick)" below). **Absent = fully permissive** (no allow-list, no reasoning ceiling, no
provider/model deny — today's behaviour unchanged), same optional-seam convention as webhooks/spend.

| Field | Type | Meaning |
|---|---|---|
| `allow` | `{ id: string; tier: "high"\|"medium"\|"low"; selectable?: boolean }[]` | The allow-listed model strings, each tagged a tier. Doubles as the pick-menu. Absent/empty = every id usable (subject to `providerDeny`/`deny`). `selectable: false` keeps an id **callable** (its own role still uses it, a route may still name it concretely) but bars it from **tier resolution and fail-soft substitution** — for a model that is only correct for one out-of-band job, such as the vision describer, which on a conversational turn answers badly instead of erroring. |
| `reasoningCeiling` | `ModelReasoning` | The **org default** max reasoning effort a route may resolve to. Default `"medium"` when omitted — `high`/`xhigh` are per-turn cost amplifiers, gated org-wide until deliberately raised. |
| `providerDeny` | `string[]` | Vendor prefixes (the `creator` half of `creator/model`, e.g. `"openai"`) that are never usable — compliance/residency. |
| `deny` | `string[]` | Specific model **ids** blocked outright — the per-model complement of `allow`. **Wins over `allow`** (a denied id is unusable even when allow-listed) and works **without** an allow-list, so it blocks one model while leaving its vendor and every other id open (which neither `providerDeny` — whole vendor — nor `allow` — everything-else-off — can express). Config load rejects an id that is both allow-listed and denied. |

**Tiers vs concrete models.** A role/persona or domain names a **tier** (`models: { primary: {
tier: "high" } }`) rather than a concrete model — the org's allow-list resolves the tier to its
designated model, so the role stays portable across orgs and can never name a disallowed model.
A route *may* still name a concrete `id` (escape hatch), but that id must be in the allow-list —
enforced **fail-loud at config load** (`assertRoutesWithinPolicy`, run from
`agent/lib/register-config.ts`). A concrete `id` wins over a `tier` on the same route.

**Reasoning ceiling is per-domain overridable.** The `reasoningCeiling` above is the org default;
a `Domain` sets its own `reasoningCeiling` to **raise** (an engineering domain → `"high"`/`"xhigh"`)
or **lower** (a cost-sensitive domain → `"low"`) it for that domain only. Effective ceiling =
org default ← `org` domain ← dm/public criteria ← explicit domain (narrowest-set wins,
`reasoningCeilingFor`). Reasoning is otherwise free self-serve — it is *not* allow-listed (same
model, same provider, no security surface); the ceiling is a cost-**blast-radius** control (the
spend cap bounds cumulative spend, not one turn's burn rate), not a security boundary.

**Resolution order** (each step clamped to the allow-list): concrete runtime pick > concrete
git-config `id` > role/domain `tier` > agent static default. Runtime resolution is
**fail-soft** — a model that somehow lands outside the envelope at call time is substituted and
logged once, never blocking the turn. The substitute is **the route's own role default** when
that model is itself allowed (so a stale pick on a `primary` route falls back to the primary
model, not to something unrelated), else the cheapest **selectable** allow-listed entry, else the
agent's static default.

**Runtime self-serve (the pick).** A domain admin picks their domain's model id and/or
reasoning effort at runtime — no redeploy — via the control-plane `set_domain_model` /
`clear_domain_model` tools (see
[Control plane → Domain model self-serve](../security/control-plane.md#domain-model-self-serve)).
The pick is an operational-store overlay (not a git edit), keyed by `(org, domain)`,
validated against this same envelope at SET time (`isModelUsable`, and the domain's
effective `reasoningCeiling` via `reasoningCeilingForDomain`) — a domain admin can only
self-serve *within* what the org already allowed. `packages/core/agent/model/routing.ts`'s resolver
overlays the pick onto the git route BEFORE the envelope clamp runs, so the pick is
re-clamped at call time too (defence in depth against a policy narrowing after the pick
was set). Authority is the domain admin, not org-admin-only — the one control-plane write
a domain admin gets on their own scope (`Domain.admins`); an org admin may set any
domain's pick. No expiry: unlike a spend override, a pick isn't a temporary bridge — a
domain owns it until it's deliberately changed or cleared. A pick on a model with no
committed price still lands, and returns `unpriced: true` with a warning — calls on that model
add $0 to the spend ledger, so this domain's turn spend stops counting against any USD cap over
it until you commit the rate in `agent/spend/model-pricing.ts` (see
[Spend & cost controls](../security/spend-and-cost.md)).

### Spend budgets

Config-as-code, uncapped by default (Open Everywhere never invents a budget). Declared in
`agent/spend/budgets.ts` with `defineSpendBudgets` (validated at import by
`assertSpendBudgetsValid` — a malformed scope key, a typo'd field, or a non-positive
amount fails the build instead of silently never enforcing).

Resolution is narrowest-entry-wins across the PLACE layers: `perSurface` → `perDomain` →
`perWorkspace` → `default`. `perUser` is not one of those rungs — see below.

| `SpendBudgets` field | Type | Meaning |
|---|---|---|
| `default` | `Caps` | Blanket cap applied to every scope without a narrower entry. |
| `perWorkspace` | `Record<string, Caps>` | Entry keyed by `platform/workspace`. |
| `perDomain` | `Record<string, Caps>` | Entry keyed by a **memory domain name** (see [memory & domains](../capabilities/memory.md)) — reaches every channel/DM/guest-surface a domain covers without listing them. A surface's domain: its explicit `reach` membership, else the `dm`/`public` criteria domain it classifies into, else none. |
| `perSurface` | `Record<string, Caps>` | Entry keyed by `platform/workspace/surface`. |
| `perUser` | `{ default?: UserCaps; overrides?: Record<string, UserCaps> }` | A budget on a **person**. `default` is the allowance for everyone; `overrides[<person>]` wins wholesale for that one person. Scope is that person's **DM** usage. Keys are **qualified** principal keys (`"slack/T0AB1CD2E/U0123ABCD"`, `"discord/300000000000000104"`) — the same spelling admin rosters use, and the one a runtime `level:"user"` override reconciles into. A bare id fails the build: it names no namespace, so one entry would cap that id on every connected platform at once. A Slack key missing its workspace fails too, for the same reason one rung down. |

`Caps` — each entry sets any combination (≥1) of:

| Field | Type | Meaning |
|---|---|---|
| `surfaceMonthlyTokens` | `number` (int) | Monthly token budget for one channel. |
| `workspaceMonthlyTokens` | `number` (int) | Monthly token budget for the whole workspace. |
| `surfaceMonthlyUsd` | `number` | Monthly **USD** budget for one channel — enforced against the spend ledger's write-time-priced `usd_micros` (evidence-only: an unpriced model contributes $0). |
| `workspaceMonthlyUsd` | `number` | Monthly USD budget for the whole workspace (DM spend counts in the rollup, and DMs are themselves blockable). |

`UserCaps` (the `perUser` entries) is `Caps` narrowed to its two **surface**-shaped fields —
`surfaceMonthlyTokens` and `surfaceMonthlyUsd`. A person's spend is measured within one
surface's ledger rows, so `workspaceMonthly*` would name a quantity nothing computes; writing
one there **fails the build** rather than sitting in the registry enforcing nothing.

**`perUser` is an independent constraint, not a fourth rung.** A turn is over budget if the
person's budget trips **or** the surface's **or** the workspace's — all three are checked.
Giving somebody an allowance therefore never switches off the cap on the room they are in,
which is what slotting it into the narrowest-entry-wins ladder would have done. Person and
place answer different questions.

One thing follows that is worth knowing before you reach for it: `perDomain["dm"]` already
gives *every* person their own repeated budget (a DM surface is 1:1 with a person, and a
`perDomain` entry applies per member surface rather than pooling) — so `perUser.default` and
`perDomain["dm"]` express nearly the same thing, and the genuinely new capability is
`overrides`: naming **one** person, which previously would have meant keying on their opaque DM
channel id.

**A per-person allowance is bridgeable at runtime too.** `set_spend_limit` / `clear_spend_limit`
take `level: "user"`, whose scope key is the person — `user:<principal-key>` — defaulting to
whoever is asking. That override overlays this registry component-wise and expires back to it,
like any other bridge, and **needs an org admin** to approve (a domain admin cannot: the person
whose allowance moves is not in the room the card lands in). Reconcile a kept bridge into
`perUser.overrides` by dropping the marker — `user:slack/T1/U1` → `"slack/T1/U1"`. Writing the marked
form into this registry **fails the build**: it is a scope address, not a config key, and it
would sit here looking reconciled while matching nobody.

Resolution is narrowest-**entry**-wins (surface → workspace → default); every component
the winning entry sets is enforced independently, calendar-month window (UTC). Enforcement
is pre-flight at each new-spend origin (mention / routine fire / webhook fire): the check
fails **open** on a check error, a definitively-over scope fails **closed**. Runtime admin
overrides (token and/or USD) overlay the config baseline per-component and auto-expire
only when they *narrow*. See [Spend & cost controls](../security/spend-and-cost.md).

### Session cost checkpoints (soft control)

Distinct from the monthly budget above: a **per-session** circuit-breaker that pauses only
*consequential* actions and asks a human "keep going?" once a single conversation gets
expensive — reads and replies are never blocked. Config-as-code, **uncapped by default**,
declared in `agent/spend/checkpoints.ts` with `defineSpendCheckpoints` (validated at import by
`assertSpendCheckpointsValid`, same posture as budgets). Resolution is narrowest-entry-wins:
`perSurface` → `perDomain` → `perWorkspace` → `default`, keyed exactly like `SpendBudgets`.

`Checkpoint` — each entry sets any combination (≥1) of:

| Field | Type | Meaning |
|---|---|---|
| `sessionTokens` | `number` (int) | Billable tokens (input+output) accumulated by **one session** before consequential actions pause. |
| `sessionModelCalls` | `number` (int) | Model calls / agent steps accumulated by one session — the closest durable analogue to "turns" (usage rows are model calls, not user turns). |
| `sessionUsd` | `number` | Estimated USD spent by one session (priced per-row like `session_cost`; an all-unpriced deploy never trips this). |

Only **gate:member** consequential tools are gated (PRs, memory writes, skill/routine
create+cancel, access requests); gate:admin control actions are excluded (they're the escape
hatch). The pause posts a `session.checkpoint` approval card once; a member's approval arms a
session-continue grant. The grant ends on window rotation or when its TTL lapses, whichever comes
first: [`approvals.checkpointTtlHours`](#agent-settings-behaviour-config-as-code) (default 24). The
TTL is a real bound, because one window generation can outlive it, so the click answer names it. A ROUTINE fire's grant carries no expiry and rebases the threshold on the
approved cost instead, so approving a durable job settles it until the job spends that much again. See
[Spend & cost controls](../security/spend-and-cost.md).

### Routine

Routines are created at runtime (by the agent, in-thread), not in repo config, but their
shape is part of the model. See [Proactivity & routines](../capabilities/proactivity-and-routines.md).

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Routine id. |
| `org` | `string` | Tenant partition. |
| `surfaceKey` | `string` | `platform/workspace/surface` it belongs to and posts back to. |
| `trigger` | `RoutineTrigger` | Stored kinds: `{ kind: "cron", expr }` (5-field UTC), `interval` (every N min), `watch` (= only-on-change; cadence *or* cron), or `event`. The model-facing `create_routine` API is one `scheduled` kind + a required `postPolicy` (`every-run` \| `only-on-change` \| `never`), mapped onto these at creation. |
| `report` | `RoutineReport?` | Where the output goes. Absent = post every fire (the default, and every pre-2026-07 row). `{ kind: "silent" }` = **posts nothing** (`postPolicy: "never"`) — the work is the product; only an unresolvable problem, or the self-disable notice, reaches the surface. `silent` + `watch` is refused. |
| `prompt` | `string` | What the agent should do when it fires. |
| `createdBy` | `string` | Creator, for audit. Routines are **surface-owned**, not principal-owned. |
| `status` | `RoutineStatus` | Runtime state; self-disables past a consecutive-failure threshold. |
| `bound` | `RoutineBound?` | **The ceiling** — `{ until?, maxFires? }`, whichever trips first. Minted host-side at arm time for a **durable job only** (a plain routine is meant to run forever), never model-authored, and renewed from scratch on a re-arm. It exists because every other stop counts *failure*, and a job that succeeds forever without calling `complete_job` is invisible to all of them. Defaults [`routines.jobMaxFires`](#agent-settings-behaviour-config-as-code) / [`routines.jobMaxDays`](#agent-settings-behaviour-config-as-code). Absent = unbounded. |
| `fireCount` | `number?` | Fires attempted under the current `bound`. Written only for a bounded routine; reset to 0 when a re-arm mints a fresh bound. |

Both dimensions of a durable job's ceiling are tunable per deployment, in
[agent settings](#agent-settings-behaviour-config-as-code) — a nonsense ceiling is refused at boot
rather than silently absorbed.

### Webhook trigger

Config-as-code, declared once in the deployer app (`agent/webhooks/hooks.ts`), empty by
default. See [Inbound webhook triggers](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers).

A conversation can **propose** a hook (`declare_webhook` opens the PR) and **issue its signing
secret** once merged (`rotate_webhook`, for a `broker: "db"` hook), but it cannot create or remove
one — both are merged pull requests. Which sources a secret may be minted for is narrowed by
`loadWebhookSources` below. See [Getting a webhook's signing secret without a
redeploy](../capabilities/proactivity-and-routines.md#getting-a-webhooks-signing-secret-without-a-redeploy).

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | URL path segment — fires at `POST /webhooks/<id>`. Url-safe (`[a-zA-Z0-9_-]+`), unique. |
| `source` | `string` | Which registered **signature scheme** authenticates this hook's deliveries. `"oe-standard-webhook"` is our own — the public [standard-webhooks](https://www.standardwebhooks.com/) spec (`webhook-id` + `webhook-timestamp` + `webhook-signature: v1,<base64>` over `<id>.<ts>.<rawBody>`, 300s skew) — for senders you configure, and it has drop-in sender libraries in most languages. A vendor name (`"github"`, `"notion"`, …) verifies in **that vendor's** scheme, which is what lets one ingress take a third-party system's webhooks unmodified; those verifiers ship with the provider bundle, so a de-selected bundle's sources stop authenticating. **Required, no default**, and **declared, never sniffed** from the request — letting the request choose its verifier would let a sender pick the weaker of two schemes. An unregistered source is a fail-closed 401 naming the registered set (not waived by `webhooks.allowUnverified`). |
| `secretRef` | `string \| string[]` | Where this hook's shared HMAC secret lives — a *ref*, never the value. What a ref names depends on `broker` (an env var name for `"env"`, a stored-credential ref for `"db"`). A list is an **ordered rotation overlap, current key first**: every key is accepted until the outgoing entry is deleted. A missing *current* ref (index 0) resolves no keys at all ⇒ 401; a missing *previous* ref is normal and dropped. |
| `broker` | `string` | The ONE home every `secretRef` above resolves through — `"env"`, `"db"`, or any registered broker name (same semantics as `Connection.broker`). **Required, no default**: an absent or unregistered broker fails closed rather than guessing another home. One broker per hook, so a rotation can't move custody mid-flight. `"env"` means an operator sets a variable **and redeploys** before the hook can authenticate; `"db"` means the value is stored here instead and armed afterwards through `rotate_webhook`'s one-time link — **no redeploy**, and still no secret in the diff. |
| `target` | `string?` | Where this hook's turn runs: a room on any surface, `<platform>/<workspace>/<surface>` (`slack/T…/C…`, `discord/<guild>/<channel>`, `teams/<tenant>/<conversation>`), or a person's DM, `dm:<principal key>` (`dm:slack/T…/U…`, `dm:discord/<user>`, `dm:teams/<29: id>`). Config load checks the shape; the target resolves when a delivery fires, and an unresolvable one declines with a reason on the `webhook.declined` row (OPE-2419). **Optional, and paired with `instruction`** — declare both for a *fused* hook (every delivery runs that instruction in that channel) or neither for an *emit-only* one (the delivery's only consequence is the event-plane emission, and `event` routines decide what happens). One without the other is **refused at config load** in both directions. |
| `instruction` | `string?` | What the agent should do on every accepted delivery — an unattended standing prompt, running with the target channel's full access, indefinitely. **Optional, and paired with `target`** (see above). |
| `readableBy` | `Scope[]` | **WHO may read this hook's events** — the entire confidentiality decision for the ingress, in the same `Scope` vocabulary as access bindings. `{ level: "org" }` is *every domain in the org*; `{ level: "domain", domain: "payments" }` names one; several entries are a **union**. **Required, no default, validated non-empty** — an implicit default is how a hook came to be readable by nobody, accepting deliveries and refusing every routine forever in silence. A `domain` entry naming a domain the deployment does not declare is **refused at config load**. It decides who may *read*, never what a routine *acts on* — that is the routine's own filter. |
| `posture` | `"trigger-only" \| "projection" \| "content-bearing"` | **How much of the sender's payload reaches the prompt**, on every delivery, forever: none of it / only the fields in `project` / the entire raw body as untrusted data. **Optional; absent means `content-bearing`**, which is exactly what every config hook did before the field existed. Governs *both* of a hook's consequences — its declared `target` + `instruction` fire (when it has one) and its emission into the event plane. A `content-bearing` or `projection` fire is **tainted**; a `trigger-only` one is not. |
| `project` | `string[]` | The normalizer field keys a `projection` hook renders, in declaration order. **Required when `posture` is `"projection"` and refused otherwise** (a key list under any other posture narrows nothing). A projection also drops the entity pointer, so no hydration fetch happens. Whether a named key is one the source's adapter can produce is checked by `declare_webhook`, not at config load — normalizers register at startup, after this file is validated. |

---

## Agent settings (behaviour, config-as-code)

The agent's **behaviour** opinions — which walls are up, which apparatus is armed, what the caps
are — are typed code, not environment variables. They live in one schema
(`packages/core/agent/settings/settings.ts`) and your deployment declares its own overrides in
`agent/settings/settings.ts`:

```ts
import { defineSettings } from "@open-everywhere/core/agent/settings/settings.js";

export const SETTINGS_OVERRIDES = defineSettings({
  window: { topology: false },                       // opt out of standing seats (they ship on)
  connectors: { dmOnly: true, opTiering: false, userPrincipal: false },    // keep connectors in DMs only (they ship channel-reachable)
});
```

`defineSettings` validates at module load, so a typo'd key or an out-of-range value fails your boot
and your CI rather than silently doing nothing.

### How a row in this table is declared, and what keeps the table honest

Every row is one `SettingSpec` (`packages/core/agent/settings/settings.ts`): the dotted `path` that
docs, lints and error messages all use, the `shipped` default every clone gets with nothing configured,
the `summary` this table prints, and — optionally — a `validate` that runs against your override, a
`format` that renders the default for the table, and an `env` name where a setting has an ops override.

`settingDocs()` flattens every spec in the schema, renders its default, and sorts the result by path.
**The table above is exactly that list**, so a knob the schema declares always reaches the operator.

Three gates keep the two in step, and all three run in the `test` chain:

- **The table must match the schema.** `npm run lint:settings-docs` re-renders the table and reds when
  it differs, so editing a spec without regenerating fails the suite.
- **A schema-declared ops override this page never mentions is a red.** That arm exists because such a
  variable is read through a schema field rather than a literal environment read, so the
  environment-documentation lint cannot see the name.
- **A runtime module outside the schema that reads a schema-owned name directly is a red.** One owner
  keeps one vocabulary and one default.

**Why this is not env.** An env var lives outside the repo: CI never sees it, no diff records it,
`git blame` cannot explain it, and reverting it is not a revert. Behaviour is an opinion, and an
opinion belongs on the reviewed path beside your bundles, domains and model policy. The line this
project draws is: **connection targets, secrets and deployment identity are environment; behaviour,
wiring and policy are typed code in your repo, changed by pull request.**

**The ops override — there isn't one.** Exactly one row below names an environment variable, and it
is `models.stack`, a test-harness seam rather than a behaviour opinion. Every other setting is
code-only: your `agent/settings/settings.ts` over the shipped default, and nothing else. The forty-eight env
mirrors that used to sit beside these values were deleted in OPE-411 — see [Every behaviour setting
is code-only](#every-behaviour-setting-is-code-only) below for what that costs and what it buys.

**Values are resolved fresh on every read**, so a deploy that changes one takes effect on the next
call rather than the next cold start. **Five settings are exceptions**, each noted in its own row:
`agent.sessionInputTokenBudget` and `agent.compactionThresholdPercent` are arguments the agent
definition hands to the framework at startup, and `sandbox.timeoutMs`,
`sandbox.snapshotExpirationMs` and `sandbox.image` are arguments to the sandbox backend eve
evaluates at module load — all five are read once and a change applies at the **next boot**. The two
sandbox clocks are additionally applied at sandbox *create* and then persist on the sandbox, so a
change only reaches NEW conversations. (The `rotation.*` clocks were a sixth exception until OPE-409:
they backed exported constants resolved before your `agent/settings/settings.ts` was registered, so an
override could never land and `defineSettings` refused one by name. Their consumers are lazy
functions now, and the group is ordinary.)

The table below is **generated from the schema** — edit the schema, run `npm run docs:generate`.

<!-- BEGIN GENERATED: agent-settings (scripts/settings-docs.ts) -->

| Setting | Shipped default | Meaning |
|---|---|---|
| `a2a.inbound` | `false` | Whether this deployment accepts INBOUND A2A calls: another organisation's agent calls this agent through its published A2A agent card (`GET /.well-known/agent-card.json`) and its JSON-RPC route (`POST /a2a/jsonrpc`). Off (shipped) ⇒ both routes answer 404 — the ingress does not exist. On, the routes ALSO need at least one caller declared in `agent/access/a2a-inbound.ts`: with none, they still answer 404. Every call must authenticate as a declared caller (a JWT from a declared issuer, or a declared bearer secret by credential-store ref); an unauthenticated or undeclared call is refused 401 before any turn starts. A call lands as a job in its caller's own surface of the caller's declared domain, bound EXTERNAL (read-only `public` memory) and unattended — and it holds that domain's tool and connector grants, so declare a caller only in a domain whose grants you would expose to it. See docs/extending/a2a-agents.md. |
| `agent.compactionThresholdPercent` | `0.5 (50% of the window)` | eve's `compaction.thresholdPercent` — the fraction of the model context window at which compaction fires. COMPACTION OWNS SIZE for every window type (rotation is context-motivated and time-triggered), so this is the in-generation size lever. A FRACTION IS THE ONLY THING AUTHORED: the absolute token count is this value times the active model stack's primary context window, so pointing `models.stack` at a smaller-window stack compacts proportionally lower with no edit here. `/oe status` prints the count this deploy resolved. Per-type thresholds are not reachable on the pinned eve. Read at BOOT. |
| `agent.sessionInputTokenBudget` | `30000000` | eve's `limits.maxInputTokensPerSession`, set BELOW the hosted 40M hard kill so the graceful park/fail fires first. KEEP IT UNDER 40M — above that the hosted wall wins and the session dies ungracefully instead of parking. ONE SHARED BUDGET: every delegated worker's input counts toward its seat's total, and a worker starts with only the seat's remaining share. Read at BOOT (it is a `defineAgent` argument). |
| `approvals.checkpointTtlHours` | `24 h` | TTL for the session-checkpoint memos of a LIVE session, in hours. A REAL bound, not only a GC bound (OPE-2161). The memo's session id embeds the window generation, so a rotation can drop it first. But one generation can live for days, and then this clock ends the grant. The card and the click answer name this value. It does NOT bound a ROUTINE fire's continue grant, which carries no expiry: approving a durable job's checkpoint records the cost at that moment as the approved mark, and the next card fires only once the session spends a fresh threshold's worth on top of it. It still bounds that fire's "asked" marker, which is what lets a declined job be asked again. |
| `approvals.judgeMode` | `"enforce"` | The LLM approval judge. `enforce` (shipped): for a judge-deferred act, the judge allows it with no card ONLY when it cites one of the scope's authored pre-approval rules (`preApprovalRules` on a bundle); every other answer, an unreachable judge model and a timeout all post the card. Admin acts never reach the judge. A consult costs up to two model calls on the `judge` model role, and a scope with no authored rule costs none. `shadow` decides nothing and logs a would-be verdict beside every real card. `off` runs no judge, so every gated act posts a card. |
| `approvals.routineCardWaitSeconds` | `120 s` | How long an unattended routine fire's APPROVALS-PLANE refusal WAITS for its permission card to be answered before it declines for that run. 120 (shipped) holds the refusing call for up to two minutes, so a person who is around can answer the card while the run is still up. 0 is the opt-out: the refusal is immediate and the card decides only FUTURE runs. It does NOT govern the CONNECTOR plane's refusal, which posts its card and refuses at once whatever this says: that refusal is computed inside the connection's own approval gate, so a wait there holds the connector call open rather than the model's turn. Armed, the refusing tool call polls the card's own pending row, and an approval inside the window lets that run proceed. THE BUDGET, and why 120 is the shipped value: the deployed function's wall ceiling is 300 s (measured, platform default, no app pin); the turn's own elapsed time is read off its start stamp and subtracted; the model still has to be told and the run's report posted, so 60 s is reserved. The wait is CLAMPED to what is left, whatever this value says — so a turn already 250 s old waits not at all rather than dying mid-report, and 120 is the value a turn that reached its refusal at the assumed 120 s can still afford (300 − 120 − 60). 🔴 A deadline never decides the card: it stays pending and clickable, and approving it still arms every later run. |
| `approvals.routineGrantTtlHours` | `24 h` | TTL for a routine's standing grant, in hours: the grant the middle button of a routine's `pr.open` card writes ("Approve for this routine", the `approve_session` click verb). Later fires of that routine skip the card for that kind until the grant expires, a break-glass `revoke_session_grants` deletes it, or an `edit_routine` moves the routine's key. A card in a conversation has no middle button and keeps no grant (OPE-2363), so this clock never applies to one. Was `approvals.sessionTtlHours` before 0.2.0. |
| `approvals.ttlHours` | `24 h` | TTL before a pending approval action lazily expires, in hours. |
| `auditExport.targets` | `[] (no export)` | The SIEMs the audit log streams to (OPE-2437). Empty (shipped) exports nothing. Each entry is `{ name, format, url, tokenSecret?, tokenHeader?, tokenScheme?, orgs? }`. `format` is `"otlp"` (OTLP/HTTP JSON logs, POSTed to the collector's `/v1/logs` URL), `"json"` (one JSON array per batch — Datadog, Microsoft Sentinel's Logs Ingestion API, any HTTPS intake) or `"splunk-hec"` (Splunk HTTP Event Collector envelopes). `tokenSecret` NAMES a secret in the DB-backed store (`oe secret set <name>`) in env style (`SPLUNK_HEC_TOKEN`) and never holds a value; it resolves from the store ONLY, never from an environment variable of the same name, so a config line cannot send an infrastructure secret to the SIEM; it is sent as `<tokenScheme> <value>` in `tokenHeader` (defaults: `authorization`, and `Splunk` for HEC or `Bearer` otherwise). The `audit-export` schedule ships every row after the target's cursor, oldest first, each with its `seq`, `prevSha` and recomputed `sha`, so the receiver can verify the hash chain. Delivery is AT-LEAST-ONCE: the cursor advances only after a 2xx, so a failed or interrupted batch is sent again and a receiver deduplicates on `(org, seq)`. The rows carry `detail` in full, so the SIEM holds what an org admin can read on the control plane. `url` must be `https:` (an `http:` loopback collector is accepted). A rename re-sends the log from the start, because the name keys the cursor. |
| `aws.enabled` | `false` | The AWS access plane's master flag (was `OE_AWS_ENABLED`). Off (shipped), nothing registers and core's AWS mint and exec paths fail closed. On, the adapter registers the STS mint, the CLI executor and the Identity Center link callback at boot. The regions and the public OIDC client id stay environment wiring (`OE_AWS_REGION`, `OE_AWS_SSO_REGION`, `OE_AWS_SSO_CLIENT_ID`). |
| `aws.ssoScopes` | `(the minter's default)` | The OAuth scopes the Identity Center link asks for (was `OE_AWS_SSO_SCOPES`). Empty (shipped) asks for the minter's default, `sso:account:access` plus `openid`. A scope list is what access is asked for, so a wider list widens the agent's reach. A non-empty list must keep `openid`: without it the link cannot verify who consented, and it refuses. |
| `bash.backgroundGuard` | `true` | Refuse before it runs any command that backgrounds a segment with a bare `&` while redirecting neither stdout nor stderr. |
| `bash.timeoutMs` | `600000 ms` | Wall-clock cap on one `bash` call, in ms. `0` disables the timeout entirely. |
| `browser.enabled` | `false` | The in-sandbox browser master flag. Unarmed the capability does not exist: no `browser_*` tools mount, no egress hosts open, no browser bakes into the sandbox template. Arming ALSO requires at least one row in the host declaration (`agent/access/browser-hosts.ts`), which is where the reach itself lives — each row names a host, the HTTP verbs the firewall admits there, an optional credential the firewall injects at the boundary, and whether `browser_evaluate` is armed for it. Both halves are compiled into the build, so the sandbox template and the runtime mount cannot disagree. |
| `connectors.dmOnly` | `false` | The connector DM-only wall. Off (shipped), a channel reaches a connector exactly when a domain or bundle grants it the connection, and `connectors.opTiering` decides which calls need a card. On, a connector operation must come from a positively-DM context (or a task worker spawned from one) or it is refused fail-closed before a token exists. The wall bites only while `connectors.opTiering` is off: with tiering on, a granted non-DM context still passes, because tiering keeps each write behind an approval. |
| `connectors.linkSetVault` | `true` | The C.3 shared user-OAuth vault. On (shipped, OPE-2414), a confirmed link-set member keys the vault by their org-scoped link-set subject, so one consent covers all of that person's linked accounts. Because a confirmed membership then carries a credential, it also suppresses directory auto-confirm for every link-set: a person confirms each link. Off, each account keys its own token. |
| `connectors.memberPlane` | `false` | The member plane (OPE-944): a member's own connector credential resolves in a SHARED ROOM their domain declared it for, keyed to the one verified requester of that turn, reads only. The room must also be DECLARED INTERNAL in agent/identity/surfaces.ts (OPE-1472) — an undeclared room vouches for nobody, so a deployment that has declared nothing internal has no member plane until it declares something. It does not govern DMs — a personal credential always resolves in the asker's own DM, where a write takes the ordinary approval card. |
| `connectors.opTiering` | `true` | The per-op consequence gate (A2). On (shipped), each `<connection>__<op>` call is classified individually: a read runs with no card, a write or a destructive op gets an approval card that approves that one call. The approval judge may pre-approve a write or a recognised delete on a domain credential under a bound pre-approval rule, and it never caches that allow. An op whose name carries no recognised verb gets a card that the judge never lifts, unless the tool annotations of its registered server bring its final tier down to `read`. Off, every op takes the blanket grain: each call, a read included, needs a card. Either way the approval is an OE card that posts and returns, never a native wait (OPE-2340). |
| `connectors.userPrincipal` | `true` | The per-user credential path (A1). On (shipped, OPE-2414), a DM surface with a `user-oauth` credential bound resolves the OAuth subject to the calling human instead of the app principal: in a DM, a person signs in with their own account, and a person who has not signed in yet gets the "Connect my account" card. Channels keep the org credential paths. Off, a DM's `user-oauth` binding is refused: the app-principal path takes no personal credential, so a server declared in `agent/access/mcp-servers.ts` does not work in a DM. It REQUIRES `connectors.opTiering`, which ships on: the member-plane deny of a personal-credential write is computed only on the tiering branch, so settings load refuses `userPrincipal` on with `opTiering` set to off rather than ship a posture where a declared `connector.tool:` row can lift an unattended personal-credential write. |
| `control.adminRoleRules` | `(none)` | Which verified control-plane identity gets which roles (was the `OE_ADMIN_ROLE_RULES` JSON). Each rule names `roles` and at least one matcher — `issuer`, `subject`, `email` or `emailDomain` — and grants its roles to an identity that matches every matcher it names. The `email` and `emailDomain` matchers match a VERIFIED email only. Default-deny: empty (shipped) grants nothing, except that a configured `OE_ADMIN_STATIC_TOKEN` always carries the single-operator `admin` rule. A rule with no matcher fails the boot, because it would match every verified identity. |
| `control.githubAdmin` | `false` | Arm the GitHub user-login verifier on the admin control plane (was `OE_ADMIN_GITHUB=1`). Off (shipped), a GitHub token authenticates nobody there. On, a GitHub user token is a verified identity, and `control.adminRoleRules` decides which roles it gets — an identity no rule grants is denied. |
| `delegation.oneshotAgent` | `true` | Whether this deployment DELEGATES at all. Armed, a conversational seat may forward a self-contained job with `work` to its own conversation's work session, which hands it to a full-hands worker through eve's built-in `agent`, and `spawn_thread_session` may mint a persistent thread seat. Disarming makes the whole delegation machinery inert: no session holds `work` or `agent`, `spawn_thread_session` never mounts, and the wide-hands kit widens back to the task and native grains. There is no switch between delegation ROUTES — the built-in is the only one — so the only posture this expresses is LESS delegation. |
| `directory.autoConfirm` | `"off"` | Whether the directory sync confirms a mapping itself (was `OE_DIRECTORY_AUTOCONFIRM`). `off` (shipped): every new IdP→platform mapping lands as `suggested` and waits for its person's own DM tap. `attested`: a mapping the IdP itself provisioned (the downstream platform wrote the id back) is confirmed by the sync; an `asserted` or `email-match` mapping still waits, always. There is no third value: "confirm everything" would make an email collision a person-merge. An Okta app mapped with `field: "userName"` grades `asserted`, so `attested` never confirms it. |
| `directory.groupAllowlist` | `(every group)` | Which IdP groups the group sync reads, by their VERBATIM IdP names (was `OE_DIRECTORY_GROUP_ALLOWLIST`). Empty (shipped) syncs every group. Set, a group outside the list is neither added nor kept in the machine-owned person-group overlay. |
| `directory.oktaApps` | `(none)` | The Okta application → platform table the Okta adapter syncs (was `OE_DIRECTORY_OKTA_APPS`). One entry per app: `{ platform, tenant?, appId, field? }`. `tenant` names the workspace the app's ids belong to; absent, they belong to this deployment's sole admitted workspace, and the sync still refuses a workspace the deployment never admitted. `field` says where the app-side id lives: `externalId` (default) is the SCIM write-back and grades `attested`; `userName` is usually an email an app admin can edit, so it grades `asserted` and `directory.autoConfirm` never confirms it. Two entries for one platform and workspace fail the boot. |
| `discord.autoThread` | `true` | Reply in a thread when the bot is @mentioned in a Discord text or announcement channel (never inside a thread — threads don't nest, and an unknown channel type keeps the inline reply). |
| `discord.statusUx` | `true` | The Discord 'working' affordances — the 👀/✅ reaction and the holding message edited into the reply. Off, the surface behaves exactly as before the feature: one plain reply post, no reaction, no holding message. |
| `egress.allowUnenforced` | `false` | Let a session CONTINUE when the sandbox backend cannot apply fine-grained network policy. Off, an unenforceable policy aborts the session instead of running it unfirewalled. Dev and self-host-without-a-proxy only — a deployment that needs it says so in `agent/settings/settings.ts`, where the choice is reviewable. |
| `egress.enforce` | `true` | Apply the compiled per-session egress policy for real. Off ⇒ dry-run (compile + audit, no apply) — except a COMPILE ERROR, whose deny-all is applied either way: dry-run relaxes the intended policy, never a failure to compute one. |
| `externalPolicy.authorGrain` | `"withhold"` | What the agent does with a message an EXCLUDED author wrote — an author the SURFACE positively refuted (Slack `is_restricted`/`is_ultra_restricted`/`is_stranger`, Entra `userType: "guest"`) or the OPERATOR's author-trust register refuted (`agent/identity/authors.ts`, Discord and Notion). `withhold` (shipped) stops the text ENTERING: an @mention or DM from that author gets a private notice and no action, ambient engagement never triggers on their messages, and their reply inside a permitted member's thread reaches the model as an arrived-marker with no body. It binds the READ verbs too: `read_channel`/`read_thread` replace that author's message text with the same arrived-marker, so a body a wake suppressed cannot be fetched back by reading the channel. A withheld body never ingests, so it never keys taint. The two mechanisms COEXIST — the envelope is provenance-based and stays as it is; withhold is identity-based. On Discord and Notion, where the operator's register is the only evidence, a tenant the operator has NOT armed excludes nobody, so `withhold` changes nothing there. `taint` is the deliberate OPT-OUT: it lets the text enter the context inside the untrusted-content envelope and leaves the consequence to the tainted-turn model and the approval plane. Choose it only where an excluded author's text must reach the model. ⚠️ EVERY CHAT SURFACE READS IT, BUT THE EVIDENCE DIFFERS PER SURFACE. Slack and Teams refute an author themselves; Discord and Notion read the operator's register; GitHub refutes on the comment's `author_association` (`OWNER`, `MEMBER` and `COLLABORATOR` each hold a deliberate access grant and are internal — every other value, `CONTRIBUTOR` and `MANNEQUIN` included, is excluded); Linear refutes a workspace guest (`User.guest`). ⚠️ GITHUB AND LINEAR HAVE NO PRIVATE CHANNEL back to a commenter, so an AMBIENT excluded author's message is a silent drop with an audit row and nothing posted. An explicit @mention from an excluded author still gets one fixed, identity-blind acknowledgement line (`EXTERNAL_MENTION_ACK` — names no person, no organisation, no setting, no verdict) on both surfaces, so the mentioning member never reads the agent as broken; on Linear it posts as a `response` Agent Activity, which also ends the session, so no spinner is left open. One known limit elsewhere — Discord's hydrated context lines are not filtered, so an excluded author quoted there still reaches the model when the TRIGGER author is permitted. EVERY chat reader — `read_channel`/`read_thread` and the delegated worker's `read_work_channel`/`read_work_thread` — routes through ONE grade-and-project body (`readChannelResult`/`readThreadResult`), so the author-taint mark and the `withhold` read half are declared once and no reader can declare them differently. |
| `externalPolicy.roomGrain` | `"silent"` | Whether the agent engages in a room the classification calls EXTERNAL — a room the operator declared `public` in the trust registry, a room the vendor reports as spanning another organisation (Slack Connect, a Teams shared channel), or a room whose ingested set contains a refuted author. `silent` (shipped) suppresses the wake and announces at most twice per room — once on join, once on the first wake it suppresses — and never repeats; there is deliberately NO periodic re-announcement. `engage` is the deliberate OPT-OUT: the agent answers in an external room as it does in an internal one. A room that no leg classifies external is never silenced, so a member-only room sees no change. ⚠️ NOT EVERY SURFACE READS IT THE SAME WAY: `silent` suppresses a wake on SLACK, DISCORD, TEAMS, GITHUB and LINEAR. Discord and Teams post the suppressed-wake notice only, because neither surface delivers a join event the agent can hang the join notice on. Slack posts both halves, but its JOIN half fires only where `conversations.info` already refused the channel as not-internal — a channel the operator declared `public` that Slack reports internal is still silenced and still announces at its first suppressed wake, but gets no join notice. GitHub and Linear read the OPERATOR-DECLARED leg and the REFUTED-AUTHOR leg (neither surface has a vendor-external signal) and post NO announcement on either half — neither has a private channel back to a commenter, so an AMBIENT or NAME-DROP wake it silences is a silent drop with an audit row and nothing posted. An explicit @mention still gets the same fixed, identity-blind acknowledgement line every other silenced surface's addressed suppression gets; on Linear it posts as a `response` Agent Activity, which also ends the session. ⚠️ `silent` HAS NO CONFIG-VALIDATION ERROR FOR A HALF-DECLARATION, ONLY A BOOT WARNING: the EXTERNAL classification has three legs and only the OPERATOR-DECLARED one is visible in static config, so a domain that sets `roomGrain: "silent"` with no matching `public` trust entry gets a `console.warn` at boot naming the channel, not a boot failure — a vendor-external or guest-present signal can still arm it correctly at runtime, and refusing boot on that shape would be a false positive (`agent/lib/register-config.ts` calls `warnSilentRoomGrainWithoutPublicSignal`, `packages/core/agent/memory/domain.ts`). |
| `github.auth` | `"app"` | How this deployment signs in to GitHub (OPE-2530). There is ONE credential and NO fallback between the two. `app` (shipped) — the GitHub App (`OE_GITHUB_APP_*`): every call mints a short-lived token narrowed to its repository and its job, and `GITHUB_TOKEN` is never read, even when it is set. A repository the App is not installed on is refused by name. `token` — the personal access token in `GITHUB_TOKEN`, for an organisation that will not create a GitHub App. It reaches ONLY the deployment's own repository (`OE_ACCESS_CONFIG_REPO`) and the repositories `github.tokenRepos` names, and only where a bundle also grants the repository to the room. Checkout, pull requests and the config-change pull requests work there. The App is never used in this mode: the GitHub webhook route runs only the event-routine fan-out and starts no conversation, and GitHub search and GitHub-backed memory are off. The token cannot be narrowed per session the way an App token is: checkout injects it at the sandbox firewall only on the two exact clone and fetch requests of each repository it reaches (whole-path matches, never a prefix), and refuses on a backend without the firewall. Use a fine-grained token limited to those repositories. TO MOVE TO THE APP, in this order: create it with the ops MCP tool `surface_app_create` (`variant: "source-control"` keeps what token mode does); push every name it wrote to `.env.local` to the deployment's environment; set this to `app` and redeploy; then install the App (a token-mode deployment ignores the App's `installation` delivery, so installing first leaves app mode with no installation). The App brings its own `GITHUB_WEBHOOK_SECRET`, which replaces the old one: a repository webhook that feeds event routines needs the new secret, and with `source-control` (no event subscriptions) it stays the only source of those events. With `full`, delete that webhook, or each event reaches your routines twice. Nothing else changes: the grants stay, and `github.tokenRepos` stops being read. See docs/capabilities/source-control.md. |
| `github.tokenRepos` | `(none — the deployment's own repository only)` | With `github.auth: "token"`, the repositories the personal access token reaches BESIDES the deployment's own repository (`OE_ACCESS_CONFIG_REPO`), each `owner/repo`. A repository here is still reached only where a bundle grants it to the room. Empty (shipped) ⇒ the token reaches the deployment's own repository and nothing else. Inert with `github.auth: "app"`, where the App's installations decide the reach, so moving to the App needs no edit here. |
| `governance.floorTtlMs` | `900000 ms` | Memoisation TTL for the room roster and the governance attestation behind the audience floor — the one computation shared by the admin-governance floor, the connector-disclosure floor, the triggered-fire disclosure floor, the approval-card clicker floor and the card-disclosure floor. It applies in full to a RESOLVED roster only. An unresolved answer (a failed or rate-limited membership read, a non-shared room larger than one members page, a room the app cannot read) is memoised for at most 30 s (`UNRESOLVED_ROSTER_TTL_MS` in access/audience-floor.ts), because the observed-guest legs of the four non-governance floors are inert on it, and a memoised failure disarms them for as long as it is held (OPE-2150). Two legs refuse instead, and for them the 30 s memo bounds a refusal window: the clicker floor's beneficiary leg on any unresolved roster, and the connector-disclosure floor on a FAILED one (a transient read failure on an askable surface, Slack today, OPE-2306). An UNOBSERVABLE roster (a surface that cannot be asked, or a steady-state non-answer) leaves the connector-disclosure floor inert. The governance attestation memo still holds a disarmed attestation for the TTL — that direction is closed. |
| `identity.allowMultiTenantPrincipals` | `false` | The opt-out of the multi-tenant principal fence (was `OE_ALLOW_MULTI_TENANT_PRINCIPALS=1`). On a tenant-scoped platform (Slack) a person id is issued PER WORKSPACE while a principal key is only `platform/id`, so two workspaces can hand one person another's standing on an id collision. Off (shipped), config load refuses a deployment that declares two tenants of one such platform, and the wake door drops a delivery from a tenant no domain declares. On accepts that known aliasing exposure for the whole deployment. |
| `identity.blanketTrust` | `"none"` | A deployment-wide trust declaration for the bindings no platform mapper verifies (was `OE_TRUST`). `none` (shipped) declares nothing: a real platform that cannot verify a surface fails closed to `external`, and the local stand-in binding is `internal`. `internal` is the single-tenant opt-in: it raises an unverified surface to internal, lets an unvouched DM partner read the shared DM layer, and satisfies the multi-source window vouch and the governance vouch at config load. It never overrides a platform mapper's own verdict or a surface the operator declared `public`. `external` forces the local stand-in binding to external, which a test uses to drive the fail-closed path. Prefer a per-surface declaration in `agent/identity/surfaces.ts`: it names WHICH rooms are internal. |
| `identity.commandName` | `/oe` | The name of the zero-inference control-plane slash command, without its slash (OPE-2334). Shipped `oe`, so the command is `/oe`. It reaches every place the command name lives: the Slack app manifest's `slash_commands` entry, the Slack command route's own name check, Discord's command registration and interaction-router match, and the help, acknowledgement and error text the commands render. ⚠️ CHANGING IT IS AN INSTALL STEP, NOT ONLY A DIFF: Slack registers the command from the manifest, so paste the re-rendered manifest (`surface_manifest`) into the Slack app; Discord registers it at boot under the new name, and the old command stays listed until it is deleted in the Discord developer portal. |
| `identity.dmTrustTtlMs` | `300000 ms` | Memo TTL for live trust verification on every surface that performs one — the Slack per-author membership probe (which answers both the DM-partner question and a channel author's own standing), the Slack channel-internal cache, the Teams member/guest lookup and the Linear guest lookup. One knob, because it is one question asked four ways; a miss re-verifies against the platform. |
| `identity.name` | ``` (unset — generic identity line; per-surface handle still shown separately where resolved)` | The deployment's CANONICAL agent name — the ONLY name the agent calls itself, on every surface (OPE-610). Unset (the shipped `""`) renders the generic identity line ("Identify as this team's agent") even where a surface has a live display-name arm: a per-surface app's own name is a HANDLE/address, never a substitute identity, so it never feeds the identity line. Each provider bundle registers that arm (`agent/identity/bot-display-name.ts`); Slack, Microsoft Teams and Discord ship one, rendered as a separate handle line ("your mention/handle on X appears as Y") for self-recognition of mentions/backscroll — the other surfaces resolve no handle. Configuring this setting matters most for a CROSS-SURFACE session, which speaks on several surfaces from one standing block: before this setting existed, a Teams delivery introduced the agent by the SLACK workspace display name (OPE-569). Set it and one name answers everywhere, on the per-surface path and the cross-surface path alike. It ALSO joins the name-drop token set (`agent/identity/bot-name.ts`) that the Notion synthetic-mention recogniser and the addressed link-claim hook match on, so the agent answers to the name it introduces itself by. 🔴 It REPLACES the brand there (OPE-2334): with this setting or `identity.shortName` set, ONLY the configured names (and a surface's platform-resolved integration name) match, and the brand tokens "open everywhere" and "oe" match only on a deployment that configures no name. The same name also renders every install artifact (the Slack and Teams app manifests) and every user-facing and model-facing string that used to spell the brand; unset, those fall back to the brand default "Open Everywhere" or a neutral phrase. It ALSO joins the SLACK, DISCORD and TEAMS ambient name-drop wake trigger set (OPE-571, Teams since OPE-2444), alongside those surfaces' own live display names — see `wake.nameDrop.include`/`wake.nameDrop.exclude` to extend or narrow that set further. |
| `identity.shortName` | ``` (unset — no short-name token)` | The agent's SHORT name (OPE-2334) — a second name token beside `identity.name`, for the abbreviation people type ("ari" for "Aria"). It joins the name-drop token set (`agent/identity/bot-name.ts`) that the Notion synthetic-mention recogniser and the addressed link-claim hook match on. Setting it, like setting `identity.name`, makes the CONFIGURED names the only wake tokens: the brand tokens "open everywhere" and "oe" stop matching. It does NOT join the Slack/Discord/Teams ambient name-drop set, which stays narrow on purpose — add it to `wake.nameDrop.include` to widen that set. Unset (the shipped `""`) adds no token. |
| `identityLinking.codeBack` | `false` | Code-back on the DIRECTORY transport: after the named account consents in its own DM, it receives a second code the initiator must feed back to finalize. Off by default — a consent given in the target's own DM already proves both account holders agreed. The CODE transport forces the code-back whatever this says, because there the initiator's yes is the reflexable step. |
| `language.output` | `"" (no language rule)` | The org-level OUTPUT LANGUAGE, as a BCP 47 tag (`"fr"`, `"de"`, `"pt-BR"`, `"ja"`). Empty (shipped) adds no language rule, so the model answers in the language it is addressed in. Set, every session's prompt carries one section: the seat and every worker it delegates to write in that language, unless the person writes in another language or asks for another one, and code, commands, identifiers and quoted text stay as they are. A domain overrides it with its own `language` field in `agent/memory/config/domains.ts`; an explicit domain without one inherits the `org` pseudo-domain's, then this value. The tag is checked with `Intl.getCanonicalLocales` at boot, and a bad tag fails the boot. It is an instruction to the model, not a translation layer: card text, slash-command output and other host-rendered strings stay in English. |
| `memory.dreamCandidateCap` | `10` | Per-silo judge budget for the dream/tidy sweep — how many candidate memories one pass may put in front of the judge. |
| `memory.skillProposalPr` | `true` | Whether a Mode-1 SKILL proposal also opens a PULL REQUEST on the config repo (`accessRequests.configRepo`), adding the drafted skill under `.agents/skills/<name>/SKILL.md` on its own branch. It ships ON, and it acts only where the deployer configured a config repo: with no `accessRequests.configRepo` the proposal is recorded in the review queue, nothing reaches GitHub, and nothing errors. A config repo in dry-run mode (`dryRun: true` in `agent/access/access-requests.ts`) holds this write like every other config-repo write: the attempt is audited with `dryRun: true`, and no branch or pull request is opened. `false` is the opt-out, and keeps the v1 behaviour on every deployment: the review-queue row only. On, MERGING the pull request is what arms the skill — the cycle never merges, never pushes to the base branch, and needs no credential beyond the one the access-request and credential-binding flows already use. A person's review or comment on a proposal is read back as a CORRECTION and carried into the next proposal for that scope, and only an author with repository standing (GitHub's `author_association`: OWNER, MEMBER or COLLABORATOR) counts. |
| `memory.syncTiming` | `false` | A measurement mode (was `OE_MEMORY_SYNC_TIMING=1`): write one `memory.sync_timing` audit row per session, with each read silo's load, sync and lock time, so a session's boot time can be attributed and not only bounded. Off (shipped), the memory hook allocates nothing, reads no clock and adds no await. On costs a durable row per session and one store insert inside the boot window, so arm it while you investigate where boot time goes, then disarm it. The row holds names, counts, sizes and durations only — never content. |
| `models.dataPolicy` | `{} (no demand)` | What EVERY model call demands of its provider, on every target: `{ zeroRetention?, noTraining?, region? }` (OPE-2535). `zeroRetention: true` allows only providers with a zero-data-retention agreement, `noTraining: true` only providers that do not train on prompts, and `region` (`"eu"` or `"us"`) only providers that run the inference in that region. The model adapter puts the rows on every call it serves: the turn, compaction, the utility judges, the approval judge, the meeting recap, the image describer, gateway transcription, and a bare model id string (a declared subagent's model, eve's `evaluate()`) through the AI SDK default provider the adapter installs. A call cannot remove a row. Two exceptions: under `eve dev`, eve resolves a literal model id string through its own local gateway, and those calls carry no rows; and a default provider another module set first is kept, so under a policy every call through it refuses. FAIL CLOSED: a call that no provider can serve errors and names the rows; it never falls back. With any row set, the `deepinfra` transcription route refuses, because it cannot carry the rows. Empty (shipped) demands nothing. |
| `models.force` | ``` (no pin)` | A HARD PIN: one model id for EVERY resolved route (was `OE_FORCE_MODEL`). Set, it wins over the stack, over `models.primary`, over a domain's concrete route pin, over the runtime domain pick and over the model-policy envelope. Only the model id moves: the route's reasoning and provider hints and the reasoning ceiling stay as they are, and a route's `tier` is dropped. Empty (shipped) pins nothing. |
| `models.primary` | ``` (the stack's primary)` | The primary role's model id, over the stack's own primary (was `OE_PRIMARY_MODEL`). Empty (shipped) runs the stack's primary. It is the DEFAULT id only: a domain route that pins a concrete model id still wins over it. The derived model allow-list names this id, so the model-policy envelope accepts the model the deployment was told to run. |
| `models.stack` | `"american-closed"` | The named model stack this deployment runs — one alias picks a coherent model for all five roles (primary/utility/vision/supervisor/judge). Aliases are defined in `agent/model/stacks.ts`; an unknown one fails config load. Per-role overrides layer on top there, and `models.primary` and `models.force` override the primary role last. |
| `models.targets` | `gateway: Vercel AI Gateway` | WHERE model calls go (OPE-2556): named targets, `{ <name>: { kind, url?, providers?: { only?, order? }, options? } }`. One kind is implemented, `"vercel-ai-gateway"`, and an unknown kind fails config load. A route or a stack role picks a target with `via`; with no `via` it uses the target named `gateway`, which must exist. `url` is the target's base URL (for example a relay or an on-prem gateway); it replaces the `OE_AI_GATEWAY_URL` env var, which still works for the `gateway` target for one release (the process warns once, the first time the process reads the target), and the setting wins when both are set. It is read once, at the target's first call, so a change needs a restart. `providers.only` is a DEMAND: only those providers may serve a call through the target, a call cannot widen the list, and a model with no allowed provider fails closed with an error that names the row. Under `eve dev`, eve resolves a literal model id through its own local gateway, and that call carries no `only` row. `providers.order` is a preference for the order the gateway tries providers in; a route's `providerOrder` wins over it. `options` are gateway options for every call through the target, as a floor (a call's own key wins); an option that a typed row owns (`only`, `order`, `zeroDataRetention`, `disallowPromptTraining`, `inferenceRegion`) fails config load. Shipped: one `gateway` target with no rows, so no request changes. |
| `policyPages.privacy` | ``` (unset — `/privacy` serves the placeholder page)` | The operator's PRIVACY POLICY, served as `GET /privacy` — the URL the rendered Teams app manifest (`packages/providers/teams/agent/app-manifest.ts`, served by `surface_manifest`) declares as `privacyUrl`. Free text, rendered ESCAPED and as PLAIN TEXT with its line breaks kept: never as HTML and never as markdown, so the route cannot become a way to serve arbitrary markup from this deployment's origin. Empty (shipped) ⇒ the route answers 200 with a placeholder page saying no policy is published yet and naming this setting; it never 404s, because a manifest pointing at a 404 is the defect the route exists to remove. |
| `policyPages.terms` | ``` (unset — `/terms` serves the placeholder page)` | The operator's TERMS OF USE, served as `GET /terms` — the URL the rendered Teams app manifest (`packages/providers/teams/agent/app-manifest.ts`, served by `surface_manifest`) declares as `termsOfUseUrl`. Same rendering and same unset behaviour as `policyPages.privacy`. |
| `retention.sessionTranscriptDays` | `90 d` | Days a FINISHED session transcript is kept. The daily tidy pass deletes every finished run whose last activity is older, together with its events, steps, hooks and streams, and writes one `exit.retention_swept` audit row with the counts. A live run is never touched. It acts on eve's local workflow world (`.eve/.workflow-data`, the default off Vercel). On Vercel the transcripts live in Vercel's hosted workflow store, which offers no delete call, so this setting cannot reach them there and the audit row says so. 0 keeps every transcript. See docs/security/exit-and-your-data.md. |
| `retention.storedStateDays` | `90 d` | Days the conversational state in the operational store is kept: conversation tails and DM summaries, job results, Slack file links, captured webhook bodies, status lines, the words of repeated questions and soak captures. The daily tidy pass deletes the older rows (agent/exit/catalogue.ts lists each table and its time column). The audit log, the usage and tool-call ledgers and the skill and prompt histories are append-only, and this setting never deletes them. Nor does it delete decided approval cards, grants or memory proposals (the runtime role holds no DELETE on them), or meeting data, which expires by its own clock and holds long-lived provenance marks. Memory is not aged: a person removes it with Forget, and an operator with `oe erase`. 0 keeps all of it. |
| `rotation.contextSizeTokens` | `120000` | Context-size BACKSTOP: the LAST request's measured `inputTokens` (the whole prompt, cache reads included) — the same measure compaction reads, not the cumulative counter `rotation.tokenBudget` meters. It sits BELOW the compaction fire point on purpose, so a standing seat re-mints a fresh generation with a recorded tail instead of compacting into a summary. Compaction still owns delegated and worker runs, which never reach the rotation chain. |
| `rotation.dmSummaryTokenCap` | `32000` | Token cap on a DM seat's CONVERSATION SUMMARY (OPE-2431): the DM's most recent messages (at most 200 entries, about the last 100 exchanges of ordinary length), each cut to 480 characters, that every DM rotation carries beside the verbatim tail, so the person's chief of staff reads as one conversation that carries on. EXTRACTIVE, not model-written: each entry is one recorded message with its own author grain, and a refuted or ungraded author's message never enters it. Each rotation folds the outgoing generation into the summary it inherited, and the oldest entries drop first. Counted by the same characters-per-token proxy as the tail. A COST LEVER: the fresh generation holds the summary in context for its whole life, so it removes up to this many tokens of headroom under `rotation.contextSizeTokens` and adds up to this many tokens to every request against the DM token backstop. Both backstops therefore rotate a long DM sooner. A channel seat carries no summary. |
| `rotation.expiryDays` | `7 d` | PRIMARY rotation trigger, in days: a standing generation older than this is retired for context freshness (measured from its own `created_at`, reset on every rotation). `0` or a negative value DISABLES the trigger. |
| `rotation.quietGapHours` | `12 h` | Idleness threshold, in hours: a standing generation not woken for this long rotates fresh on its NEXT wake rather than resuming a stale session. 12 hours holds a standing seat for a working day, so a morning question and an afternoon follow-up reach the same session. 🔴 What BOUNDS the longer gap is the rest of the chain, not this row: `rotation.expiryDays` still retires a generation on age, and the token, turn and context-size backstops still bound one generation's growth. `rotation.tailTokenCap` is NOT that bound — it caps what a rotation carries forward, so it makes each rotation cheap rather than making a long gap safe. Re-derive against the backstops before raising this. |
| `rotation.tailTokenCap` | `5000` | Token cap on the last-generation TAIL a fresh generation's first wake carries — the recorded wake messages and the seat's own posts, selected most-recent-first, VERBATIM. Tight on purpose: the tail makes the seat conversational. On a channel seat, its read tools and memory cover everything older. A DM seat also carries its conversation summary (`rotation.dmSummaryTokenCap`). |
| `rotation.tokenBudget` | `4000000` | Token BACKSTOP (demoted from primary by OPE-345, value unchanged): the measured cumulative `inputTokens` on one generation. `inputTokens` is the whole prompt, so it already includes the cache reads, and each cached token counts once. Also the route the session-park remedy uses — parking saturates this counter. |
| `rotation.turnBudget` | `60` | Turn BACKSTOP: turn count on one generation. 60 is derived from the substrate — a workflow run caps at 25,000 events and OE measures ~295 events/turn, so the wall binds near ~85 turns and this sits ~30% under it. It must ALSO satisfy the older invariant it was first derived against, C(budget) < 40M cumulative input on its own (C(60)≈4.9M ✓; the pre-OPE-345 150 was ✓ at 25.65M, 300 is ✗ at ~96M) — both bounds are pinned in `scripts/rotation-trigger-test.ts`. RE-DERIVE it (do not nudge it) if the events-per-turn measurement moves. |
| `routines.attentionPauseRuns` | `24` | Further runs after the Keep going card before the routine pauses itself and posts a Resume card. Counted from the run the card actually posted, so a routine never pauses without a warning. |
| `routines.attentionWarnRuns` | `100` | Runs a recurring clock routine makes with no human check-in before it posts a Keep going card where its reports land (OPE-2511). A check-in is a press of that card, a Resume, or a carded edit, rule change or re-enable. `0` turns the check off. One-time and event routines are not counted. |
| `routines.discoveryMinWeeks` | `3 weeks` | Workflow discovery (OPE-2512, OPE-2539): the weeks, out of the last five, in which a person must run the same connector op, or ask the agent the same question with no connector call, on the same weekday before their chief-of-staff watch offers ONE routine for it, as a Set it up / No thanks card in their own DM. It reads only the person's own tool-call and question ledgers, and obeys their watch dial and DM stop. The same rule asks a shared room, with one card in the room, about work that two or more people there repeat, at most once per room per 14 days. A declined idea is never offered again. `0` turns both off. |
| `routines.eventMaxFanout` | `3` | Max routines ONE inbound event may fan out to. Every over-cap match is a genuine drop, so it writes a throttled `routine.skip` audit row (reason `fanout_cap`) rather than silently not firing. |
| `routines.firstConversationDays` | `3 days` | First conversation ends in a routine (OPE-2514): for this many days after a person's first DM turn, or after a room's first introduction, the seat may offer ONE routine that fits what they said they do, in one plain sentence, with the routine card as the one confirmation. The host ends the offer when the routine card posts, and a decline or a set-up routine records how it ended. A no said in words before any card posts is covered only by the seat's instruction and this window. A person gets it when their first DM turn after this shipped creates their watch row, and a room when it is first introduced after this shipped. `0` turns it off. |
| `routines.jobMaxDays` | `7 d` | Wall-clock grace minted onto a fresh durable-job bound, in days. Stretched so a slow cadence still gets a fair sample of runs. |
| `routines.jobMaxFires` | `200` | Fire cap minted onto a fresh durable-job bound. Plain `cron`/`interval` routines carry no ceiling: the check-in (`routines.attentionWarnRuns`) is what pauses one that nobody looks at. |
| `routines.maxConcurrency` | `3` | Max routine ROOT sessions started per dispatcher tick. The rest stay claimable and fire on a later tick (their `nextRunAt` is untouched, so they remain due). |
| `sandbox.extendMaxMinutes` | `120 min` | Per-call cap on the `extend_workspace_time` tool, in minutes. Plan ceilings still apply. |
| `sandbox.image` | ``` (the backend's own default)` | Off-Vercel `docker()` backend only: the sandbox container image. Empty ⇒ the bare `docker({})` eve otherwise mints. Ignored under `justbash` and on Vercel. |
| `sandbox.region` | ``` (no pin — Vercel's own default region)` | Vercel region to create sandboxes in — the data-residency pin for sandbox COMPUTE, the sibling of the AI Gateway's `inferenceRegion` for inference. Empty (the default) pins nothing. Read at boot, applied at sandbox CREATE, and inert off Vercel (a loud warning says so). Existing sandboxes keep the region they were created in. Should a future eve stop forwarding the region to sandbox creation, `npm run test:sandbox-region` goes red — that red is the signal, and it is the only automatic part. The boot keeps pinning until a maintainer flips the hand-maintained capability constant to `false`. That flip is what makes setting this REFUSE THE BOOT with the reason, rather than run in the default region under a residency claim. |
| `sandbox.selfHostBackend` | `"docker"` | Which backend runs the agent's shell on a NON-Vercel host (was `OE_SANDBOX_BACKEND`). `docker` (shipped) CONTAINS the shell in a per-session container with its own filesystem; it needs the daemon socket, and its session containers sit outside the egress proxy, so `docker` with `OE_EGRESS_PROXY_URL` set refuses to boot. `justbash` runs in-process and the agent's shell SHARES THE APP PROCESS'S FILESYSTEM — development and testing grade, with a loud boot warning. The Docker image carries a just-bash template only, so an app built into that image declares `justbash`. A Vercel host always runs the Vercel Sandbox, so this setting is inert there. Read at BOOT; eve also provisions the sandbox template at BUILD time on the backend this resolves. |
| `sandbox.snapshotExpirationMs` | `604800000 ms` | Auto-GC age for a stopped sandbox's snapshot, in ms. Past it a conversation resumes onto a FRESH sandbox: the working tree is lost, the conversation and memory are not (`git push` is the real durability boundary for code). Also applied at CREATE. |
| `sandbox.stopAfterTurn` | `true` | Stop the sandbox compute the moment each turn's reply is sent rather than letting it idle out the timeout window. On a WORK SESSION, which owns the conversation's sandbox, the stop waits until the work session is idle: it owes no unsettled task and no forwarded job. On Vercel the stop auto-snapshots and the next turn auto-resumes; on the docker backend the session container is stopped (never removed) and restarted on next use. The just-bash backend has no compute to stop — it runs inside the app process — so this setting is inert there and the hook logs which backend owns the stop at the first turn end. |
| `sandbox.timeoutMs` | `1800000 ms` | The per-session sandbox window, in ms. With stop-after-turn owning idle cost this is a BACKSTOP fuse — it binds only when the turn-end hook cannot run — and the max continuous work one session may do. On a work session, whose stop waits until it is idle, this is the longest one job may hold the sandbox. **Applied at sandbox CREATE and persisted on the sandbox, so a change only affects NEW conversations.** |
| `sandbox.useVercelSandbox` | `false` | Run the agent's shell in the Vercel Sandbox from a NON-Vercel host (was `OE_PLATFORM=vercel` on that host) — the "self-host app, Vercel Sandbox executor" route. On, the app selects the `vercel()` backend, the egress policy takes the Vercel Sandbox firewall path (`sandbox.setNetworkPolicy`) instead of the self-host proxy push, and the browser plane may arm. The app then needs `VERCEL_TOKEN`, `VERCEL_TEAM_ID` (or `VERCEL_ORG_ID`) and `VERCEL_PROJECT_ID` to create sandboxes; this route is UNVERIFIED live. It does NOT make the app a Vercel host: the durable-store floors follow the real host. Inert on a Vercel host, which always runs the Vercel Sandbox. Read at BOOT. |
| `schedules.sweepOrgs` | `default` | The orgs the scheduled sweeps cover — the tidy sweep, dream mode 3 and the daily directory sync (was `OE_TIDY_ORGS`). Shipped `["default"]`, the single-operator org. A multi-org deployment lists each org its sweeps run for; an org not listed is never swept. |
| `skills.domainSkillCap` | `50` | Max runtime-authored domain skills per domain (`create_skill` refuses past this). Per-skill content size is capped separately, in code. |
| `slack.suggestedPrompts` | `“What can you do?”, “What do you remember?”, “Help me write”` | The suggested prompts Slack's side panel offers a person who opens the app there (OPE-2457) — each a short `title` the person sees and the `message` it sends. At most 4, as Slack's agent view shows. They are written into the Slack app MANIFEST (`features.agent_view.suggested_prompts`), so a change reaches people only after the operator pastes the manifest again (App Manifest → Save Changes). The shipped three name no product. Empty shows none. |
| `soak.capture` | `false` | Record the COMPOSED request body of every model call on a matching surface (gzipped, with the model id, session, turn/step index and a sha256) into `model_call_capture`, for the soak tests' prefix-replay bench. **Arm it for one soak run and disarm it after.** A capture body holds the whole prompt — rendered member messages and tool output verbatim — so the store is as sensitive as a session transcript: it lives in this deployment's own database, it is served only over a service token (`GET /control/v1/session/:id/model-calls`), and no agent tool reaches it. Retention is an explicit delete-by-session after the harvest, not a TTL. Off (shipped) the recorder does one boolean read per model call and writes nothing. |
| `soak.captureSurfacePrefix` | `(every surface)` | Narrow `soak.capture` to part of the deployment: a call is recorded only when its surface key starts with one of these prefixes. A bare string is shorthand for a one-prefix list. Surface keys read `platform/workspace/surface`, so `"slack/T0123/"` is one workspace and `"slack/T0123/C0SOAK"` is one channel — a list lets a run scope several platform families at once (e.g. `["slack/T0123/", "notion/ws1/"]`) instead of only one. **Set it whenever you arm capture.** Empty (shipped `""`, or `[]`, or any list containing `""`) means every surface, which records the deployment's whole conversational traffic and is almost never what a soak run wants. |
| `spend.sandboxGiBHourUsd` | `$0.0212/GiB-hr` | Vercel Sandbox's 'Provisioned Memory' rate, $/GiB-hr. EVIDENCE-ONLY: this number is here because it was verified twice — the published pricing page AND a real bill that matched it to the cent. A deployment that cannot verify its own rate should report seconds, never a guessed $ figure. |
| `spend.sandboxMemoryGiB` | `4 GiB` | The sandbox memory size the $ estimate prices against, in GiB. 4 is Vercel's platform default, confirmed by the same real-billing reconciliation as the rate — change it only if this deploy pins an explicit `memory` on its sandbox backend. |
| `spend.usageEventsTtlDays` | `90 d` | Retention window for the per-event `usage_events` table, in days. Pruned opportunistically on write; a documented no-op on Postgres, where the table is append-only. |
| `stall.repeatThreshold` | `3` | Identical-(tool, args, result) run length before the NEXT identical call is nudged instead of executed. `0` disables the stall guard entirely. |
| `storage.allowEphemeralMemory` | `false` | Accept a per-instance, ephemeral DM/personal memory store on a Vercel host (was `OE_ALLOW_EPHEMERAL_MEMORY=1`). Off (shipped), a Vercel host with no durable memory backing refuses to resolve the DM store: a memory write would report success and the fact would vanish at the next cold start. Set `DATABASE_URL` instead, which selects Postgres on its own. On is for a knowingly single-instance host only. Off a Vercel host the local floor is correct, and this setting is inert. |
| `storage.allowEphemeralOperational` | `false` | Accept a per-instance, ephemeral operational store (the PGlite or sqlite floor) on a Vercel host (was `OE_ALLOW_EPHEMERAL_OPERATIONAL=1`). Off (shipped), a Vercel host with no hosted Postgres refuses to boot: the audit log, the spend ledger and break-glass revocations would be per-instance, so a revoke would report success and never take effect. Set `DATABASE_URL` instead. On is for a knowingly single-instance host only. Off a Vercel host the floor is correct, and this setting is inert. |
| `taint.mode` | `"on"` | Whether the tainted-turn model runs at all. `on` (shipped) marks a turn that ingests untrusted content and lets that marking reach approval disclosure, the `taint: "gate"` sinks and both delegation legs. Those sinks are the tools that DECLARE `postTurnSurface: "arms" | "disarms"` — the ones that arm, rewrite or remove instruction and execution surface a later run obeys (routines, skills, agents, routine rules, webhook ingress). A build lint fails on any tool that writes such surface and declares nothing, so the set follows the code rather than a hand-kept list. At those sinks the mark FLOORS the verdict at `ask` — a human decides, and an unattended run denies because the `unattended` transform runs last and reads that ask; it does not refuse outright. It does not gate memory: a memory write is an ordinary file edit with no write verb to mark (OPE-389). `off` is a deployer's reviewed opt-out: no marks, no verdict floor, and no mark travels to a delegated worker in either direction — untrusted content is still FENCED, and every session records `taint.mode: off` in the audit trail. **No environment variable can reach `off`** — it is a one-line diff in `agent/settings/settings.ts`, which is the bar disabling a security model deserves. |
| `taint.tierMode` | `"enforced"` | Whether the reviewed source-tier table DECIDES a read's untrusted-content marking (`enforced`) or only logs what it would have decided (`dryrun`). Enforcement is relaxation-only. |
| `taint.undeclaredSurface` | `"clean"` | What a chat wake does on a surface the operator has NEVER declared in the trust registry (`agent/identity/surfaces.ts`). `clean` (shipped) marks nothing and relocates the complaint to preflight, where it names the surface once and is actionable — a declared room is judged by its declaration and a refuted author still marks, so the bit keeps discriminating. `mark` restores per-turn pressure at ROOM grain: every human-authored turn on an undeclared surface marks. That is much narrower than the pre-OPE-489 behaviour, because a DECLARED surface never reaches it. The residual under `clean` is real and bounded: between install and the first declaration a genuinely public chat room reads clean, the ACL plane still fences it to the read-only `public` pseudo-domain, and the approval plane is the defence against a consequential act. |
| `teams.serviceHosts` | `(the global-cloud default only)` | Bot Connector hosts the Teams provider admits BEYOND the global-cloud default (was `OE_TEAMS_SERVICE_HOSTS`). Each entry is an exact host or a dot-anchored `.suffix`. Empty (shipped) admits the global (commercial) cloud only, which is the Teams provider's own built-in host list. A sovereign-cloud deployment adds its own host here — GCC `smba.infra.gcc.teams.microsoft.com`, GCC High `smba.infra.gov.teams.microsoft.us`, DoD `smba.infra.dod.teams.microsoft.us`. The reply's bearer token only ever goes to a matched host, so list Microsoft-owned hosts only. |
| `tools.maxResultChars` | `120000 chars` | Per-tool-result character cap (~30k tokens), applied inside the untrusted-ingestion funnel so one avalanche result cannot blow the context window in a single shot. |
| `turn.stepBackstopMultiple` | `3× the budget` | HARD backstop, as a multiple of `turn.stepBudget`: past it the resolver returns a text-only stub whose reply says the turn was stopped, so eve's own continue-decision ends the turn. For the pathological loop that ignores the wrap-up instruction. Clamped to a minimum of 1. |
| `turn.stepBudget` | `120 round-trips` | SOFT per-turn boundary: model round-trips one turn may take before every subsequent call carries a wrap-up instruction (finish, report, yield — the turn is NOT killed). Guards the runaway tool spiral (one live turn ran 446 steps / 36 min of gateway spend) without capping legitimately long work. `0` disables both tiers. |
| `voiceClips.enabled` | `true` | Hear voice clips (OPE-2524). On (shipped), an audio file or voice clip that a person sends in a conversation the agent already answers is transcribed through the stack's transcription role (`agent/model/stacks.ts`, the same primary and fallback routes a meeting uses) and handled as if the person had typed it. The transcript joins the message body with the author's own trust, and the audio is held in memory for the one call only. Slack is the one wired surface: a DM, a group DM, an @mention, and a reply in a thread the agent is in and was not asked to stand down. A clip in a room that did not address the agent is never downloaded, and neither is a bot's clip (the named e2e driver's DM aside). A call that carries a measured cost bills to the conversation's spend row (an answer with no cost field, and a failed attempt, record no row). A conversation over its cap is not transcribed; the cap check fails open with a warning. Off, a clip reaches the agent as a file it cannot hear, with one line saying so. |
| `wake.driverAllowlist` | `(none)` | The test-deployment exception to "never act on another bot" (a real deployment's one exception is a reply in an asked thread, OPE-2426, docs/capabilities/bot-delegation.md): the e2e DRIVER bot pairs the Slack engagement and mention doors and the Discord relay ingress admit as if they were a user, so full-path tests can drive the real agent. Each entry is ONE pair: `guildId:botUserId` on Discord, `teamId:botId` on Slack (the posting app's `B…` bot record). Guild/workspace-pinned, exact match, no wildcards; a malformed entry fails the boot. On Discord, a listed driver id that posts from a DIFFERENT guild than its pair names is still refused, and the refusal writes a `discord.relay_admission_refused` audit row (OPE-647) — every other bot-authored message stays a silent no-op. Empty (shipped) ⇒ every bot-authored message drops, except a reply in an asked thread (OPE-2426). Deliberately SEPARATE from `wake.e2eDrivers`, which admits a driver into a standing seat: that is a larger grant, made by its own reviewed diff. Was the `OE_TEST_DRIVER_IDS` env var until OPE-2411. TEST BEDS ONLY — a real deployment leaves it empty. 🔴 This repository's own `agent/settings/settings.ts` names the maintainers' test-deployment pairs, so a deployment made from a clone of this repository must delete that entry. |
| `wake.e2eDrivers` | `(none)` | The e2e DRIVER bot identities the seat doors admit, one `{ surface, principal }` entry per identity. `principal` is written in the surface's OWN id vocabulary: Slack a `teamId:botId` pair (the workspace and the POSTING APP's `B…` bot record, which is what a `message.im`/`message.mpim` event carries in `bot_id`), Discord the driver bot's user-id snowflake, Notion the driver integration's bot id. Every chat surface stamps a machine author on anything a script posts — Slack does it on a USER token too, and Discord bans user tokens outright — so without this the e2e pack cannot drive a real seat and its legs can only forge an envelope. Empty (shipped) ⇒ a bot-authored DM drops at the Slack DM door with its `surface.wake_dropped` row, and a message a surface tags as machine-authored is refused in a seat's catch-up read by the domain's own admission policy, exactly as before. 🔴 NOTION IS THE ONE SURFACE THAT CANNOT TAG ONE (OPE-1857): it serves a comment's `created_by` as a partial user with no `type`, so a catch-up read cannot tell an integration's comment from a person's and `wide` admits it at the `unauth` floor whether or not this list names it. A `notion` entry therefore widens only the case where Notion DOES state a `type`; it is not what admits the driver today. 🔴 A `members-only` domain refuses an UNLISTED machine author alike, but NOT a listed one: the carve-out ORs past the domain's own policy, so a LISTED identity enters a seat in any domain. Set ⇒ a LISTED identity is admitted at the Slack DM door (which writes a `surface.wake_admitted` row naming the carve-out, and resolves author trust from the HUMAN `user` the post carries — no trust is invented for the bot), and enters the standing seat's own reads — the since-last-wake catch-up, the bootstrap window and the name-drop hydration, every read `seatAdmissionFor` governs — wherever that ONE identity speaks on its own surface, at the `relay` tier every machine author already carries. The PRINCIPAL is what pins the reach: a Slack entry is workspace-pinned by its `teamId:botId` pair, while a Discord or Notion entry names a globally unique vendor id and reaches that identity's rooms on that surface. 🔴 THE DOOR AND THE READ ASK ONE PREDICATE (OPE-1969), so the two cannot disagree about one identity: the read was scoped to the `e2e-engaged` domain alone until a fixture room no domain claims showed the disagreement — the door admitted the driver and the seat's catch-up dropped it. An unlisted bot is refused exactly as it was before, on every surface and in every room. Deliberately SEPARATE from the `wake.driverAllowlist` pairs that lift a driver at the engagement and mention doors: a seat holds a window token, delegation and memory, so admitting a bot there is a larger grant and is made by its own reviewed diff. TEST BEDS ONLY — a real deployment leaves it empty. |
| `wake.nameDrop.exclude` | `(none)` | Name tokens the Slack/Discord/Teams name-drop wake NEVER fires on, even when the live display name, `identity.name`, or `wake.nameDrop.include` would otherwise carry them. WINS over both — the narrowing always has the last word. |
| `wake.nameDrop.include` | `(none)` | Extra name tokens the Slack/Discord/Teams AMBIENT name-drop wake fires on, beyond the surface's live vendor display name and `identity.name` (OPE-571). Case-insensitive, matched the same word-boundary way as the automatic base — no regex, no predicate. Widening ambient wake is the operator's own choice, made by diff. |
| `wake.testWakeRoute` | `false` | Whether the spoofed-wake injection route `POST /control/v1/test/wake` exists. The e2e packs and the eval harnesses use it to feed a synthesised wake into a standing window. Off (shipped) ⇒ the route answers 404 — it does not exist. On, it ALSO needs the `OE_CONTROL_INJECT_TOKENS` credential family and a matching bearer: either half alone leaves the route dead. Injection transitively WRITES (the agent acts and replies for real) and can mint a full-kit task seat. Was the `OE_TEST_WAKE` env var until OPE-2411. TEST BEDS ONLY — a real deployment leaves it off. 🔴 This repository's own `agent/settings/settings.ts` turns it on for the maintainers' test bed, so a deployment made from a clone of this repository must delete that entry, or the credential alone guards the route. |
| `webhooks.allowUnverified` | `false` | Accept a delivery whose DECLARED hook has no secret configured. Off (shipped) refuses it. On, the acceptance is stamped `unverified: true` in the fire's audit row. It never bypasses signature verification once a secret IS set, never waives VERIFIER RESOLUTION (an unregistered `source` is still a 401), and is never honoured for a hook whose secret this deployment itself holds (`broker: "db"`) — a missing key there means nobody minted it or the vault read failed, not a laptop without a value. Local development only. |
| `webhooks.allowUnverifiedGithub` | `false` | Accept a GitHub delivery when `GITHUB_WEBHOOK_SECRET` is unset. Off (shipped) rejects the whole route with a 401, which is the fail-closed posture a deployment wants. On, the event fan-out and the ambient-supervisor leg run for a delivery whose only proof is possession of the URL. It changes nothing once the secret IS set — a bad signature still 401s. Local development only. |
| `webhooks.allowUnverifiedNotion` | `false` | Accept a Notion delivery when no verification token is configured. Off (shipped) rejects it. On, the delivery reaches the ambient supervisor but identifies NO SIGNER, so a page a domain reaches only through a container entry is still refused, and the delivery deliberately never enters the routine-trigger plane — an acceptance proved only by possession of the URL must not start member-authored work. Local development only. |
| `window.topology` | `true` | The STANDING-SEAT apparatus — the ONE gate governing every seat and every window shape: the per-channel `solo` seat every channel the bot is in gets, a named `windows` group, and the cross-surface `unified` window. On, addressing decides what enters a seat and what wakes it, never the shape of the session: a mention lands in the room's own standing seat, and an undeclared channel inherits the `org` pseudo-domain's defaults (its own solo seat — never a shared context). 🔴 That inheritance is the ONE fail-closed arm: a deployment that declares NO `org` pseudo-domain leaves an undeclared channel with no domain to inherit, so it keeps the native per-container path even with this gate on. On is the shipped posture. The `org` pseudo-domain stays solo: config load refuses `mode` on it, because the whole org is never one window. A shared window exists only where a deployer declares one: an explicit team domain (its `reach`), which is `unified` by default (OPE-2412), or a named `windows` group. A declared domain falls back to `solo` when config load cannot prove its window safe, and `mode: "solo"` keeps it solo outright. A fresh install declares none, so every channel gets its own solo seat. The gate also arms mid-session memory re-sync org-wide: on each wake, a supervisor-shaped session re-reads the read silos whose store version advanced, and the re-sync propagates deletes into the sandbox. Off, every domain runs the native per-container path, a mention opens eve's per-thread session, and `mode` and `windows` are inert. **Declare a `unified` window deliberately: it is a wider data blast radius.** The since-last-wake catch-up read — a seat arriving with what the room said while it was not woken — runs on every surface through one shared path, each reading its own container (a Slack or Discord channel, a Teams channel over Microsoft Graph, a GitHub issue or pull request, a Linear issue, a Notion page discussion). A surface that registers NO history fetch states that in the wake rather than arriving with an empty context; a registered read that fails stays fail-soft to empty, so a revoked history scope reads as a quiet room. |

<!-- END GENERATED: agent-settings -->

Each setting's full reasoning — why its default is what it is, what flag-off is byte-identical to,
which failure it fails toward — stays in the schema's doc comments.

#### Every behaviour setting is code-only

No row names an environment variable. OPE-411 left one, `models.stack` (`OE_MODEL_STACK`), as a
"harness seam" for the per-stack e2e lane; OPE-2411 deleted it. That lane cannot flip the stack: the
operator sets it on the target and deploys first, and a one-line commit does that equally well. The same ticket moved twenty
behaviour choices that were environment variables into rows of this table — the model pins, the
admin roles, the trust and tenant walls, the directory sync, AWS, the sweep orgs, the sandbox backend
and the store floors. [Moved to config (OPE-2411)](#moved-to-config-ope-2411) maps each old variable
to its row.

That was not always true. Until OPE-411, forty-nine of these settings also named an environment
variable that **won** over both your `agent/settings/settings.ts` and the shipped default. The argument for
keeping them was that a kill switch should work when shipping a diff is the thing you cannot do. The
argument against, which won, is that it made a deployment's real posture the env store *XOR* the
committed file — so reading this repo told you what your agent would do only if you also had a
platform dashboard open. Forty-nine hand-rolled parsers with forty-nine slightly different
off-spellings came with it, and every one of them failed *soft*, because at parse time there is
nobody to tell.

**What that costs you.** Changing any behaviour setting is now a commit and a deploy. There is no
redeploy-free path, including for the switches that used to advertise one (`window.topology`,
`bash.timeoutMs`, `taint.tierMode`, `delegation.oneshotAgent`).

**What it buys.** The value in this repo is the value your agent runs. A bad value fails your
**boot** — `defineSettings` validates every override and throws, naming the setting — instead of
resolving to a surprising posture nobody can trace. And a stale variable left behind in an env store
is inert: it cannot silently arm a wider window or take a security wall down.

#### Moved to config (OPE-2411)

The rule is that env vars carry infrastructure secrets and platform wiring only, and every
behaviour is config in Git. OPE-2411 moved each REAL CHOICE that was still an environment variable
into config and deleted the read. A variable below that is still set in an env store does nothing:
copy its value into the line it names, then delete it from the store.

| Retired variable | Its value now lives in |
|---|---|
| `OE_MODEL_STACK` | `models.stack` in `agent/settings/settings.ts` |
| `OE_PRIMARY_MODEL` | `models.primary` |
| `OE_FORCE_MODEL` | `models.force` |
| `OE_ADMIN_GITHUB=1` | `control.githubAdmin: true` |
| `OE_ADMIN_ROLE_RULES` (JSON) | `control.adminRoleRules` — the same `RoleRule[]`, as a typed literal |
| `OE_ALLOW_MULTI_TENANT_PRINCIPALS=1` | `identity.allowMultiTenantPrincipals: true` |
| `OE_TRUST=internal` / `external` | `identity.blanketTrust: "internal"` / `"external"` |
| `OE_TEAMS_SERVICE_HOSTS` (comma list) | `teams.serviceHosts` (string array) |
| `OE_TIDY_ORGS` (comma list) | `schedules.sweepOrgs` (string array) |
| `OE_DIRECTORY_AUTOCONFIRM` | `directory.autoConfirm` |
| `OE_DIRECTORY_GROUP_ALLOWLIST` (comma list) | `directory.groupAllowlist` (string array) |
| `OE_DIRECTORY_OKTA_APPS` (`platform[/tenant]:appId[:field]` list) | `directory.oktaApps` — `{ platform, tenant?, appId, field? }` entries |
| `OE_AWS_ENABLED=1` | `aws.enabled: true` |
| `OE_AWS_SSO_SCOPES` (space list) | `aws.ssoScopes` (string array) |
| `OE_MEMORY_SYNC_TIMING=1` | `memory.syncTiming: true` |
| `OE_SANDBOX_BACKEND` | `sandbox.selfHostBackend` |
| `OE_PLATFORM=vercel` on a non-Vercel host | `sandbox.useVercelSandbox: true` (the host itself is Vercel's `VERCEL`, never a setting) |
| `OE_PLATFORM=self-host` on a Vercel host | nothing: the floors it lowered have their own settings below |
| `OE_ALLOW_EPHEMERAL_MEMORY=1` | `storage.allowEphemeralMemory: true` |
| `OE_ALLOW_EPHEMERAL_OPERATIONAL=1` | `storage.allowEphemeralOperational: true` |
| `OE_ACCESS_DRY_RUN=1` | `dryRun: true` in `agent/access/access-requests.ts` |
| `OE_CREDENTIAL_BINDING_LIVE=1` | `credentialBindingLive: true` in `agent/access/access-requests.ts` |
| `OE_OAUTH_ENABLED`, `OE_OAUTH_CONFIG`, `OE_OAUTH_NOTION_RESOURCE` | each connector's sign-in declaration, in its connection module next to its URL (`declareConnectionSignIn`); no master flag |

Two variables stay, with a written reason. `OE_PRINCIPAL` is the principal stand-in for a context
with no authenticated caller: a committed value would ship to every environment, production
included, so it stays a per-shell test variable. `OE_TELEMETRY` and `OE_TELEMETRY_DEBUG` stay by
the maintainer's ruling.

#### Turning the tainted-turn model off

`taint.mode` was the first setting to decline an environment variable, and the reasoning behind it is
why none of them have one now. Disabling a security model has no *safe direction*: a mistyped
variable, or one set on the wrong deployment, or copied from staging, could only ever widen the blast
radius. So turning taint off is a **one-line reviewed diff**, in your git history, visible to CI and
to anyone reading the repo.

```ts
// agent/settings/settings.ts
export default defineSettings({
  taint: { mode: "off" },
});
```

**What you get.** Reads no longer mark the turn; every `taint: "gate"` sink — the routine, skill,
resident-agent, routine-rule and webhook-ingress verbs — resolves at its
ordinary registry verdict, so a config lowering can auto-approve them again; approval cards and
`approval.chain` rows stop carrying provenance
disclosure; and — usually the reason people want this — **native delegation is never withdrawn**, so
a turn that read a web page can still delegate.

**What `off` costs in memory.** A bullet a worker adds on a turn that read external content normally
takes a durable `[external-provenance: …]` suffix in the memory file itself (see
[Memory](../capabilities/memory.md#the-shape-memory-keeps)). Under `off` that mark is never written —
the host does not even read the tree to compare — so the store keeps no record of which facts arrived
with outside content in the room. The prose instruction in the seeded `MEMORY.md` still asks the
agent to say where a fact came from, and that is unaffected.

**What you keep, and cannot opt out of here.** Every ingested body is still **fenced**: the
untrusted-content envelope, its delimiter defang and its escalation notice are byte-identical in
both modes. `taint.mode` governs what the *host* does with a read, never what the *model* sees.
The approval system itself is untouched — cards, modes, the floor and the deny-invariant all work
exactly as documented.

**What it costs you, stated plainly.** The launder chain is open: an untrusted read followed by a
delegation hands a child a clean signal, and there is no seam to forward the parent's taint into it.
Standing instructions and durable webhook paths can be armed in the same turn that ingested the
text asking for them. Those are real, and they are why the shipped default is `on`.

**Your audit trail still says so.** Every session running `taint.mode: off` writes one
`taint.mode` audit row, and every `approval.chain` row carries `taintMode: "off"` beside its
`tainted: false` — so "the model ran and found nothing" is never confusable with "the model was not
running". `explain_permission` says the same in prose. On an `on` deployment none of those appear,
and the rows are byte-identical to what they were before this setting existed.

---

## Environment variables

Selection knobs are **fail-closed**: a knob naming an unregistered adapter is an error,
not a downgrade.

Everything here is a **connection target, a secret, a deployment identity, or a test-harness
seam** — plus the ops overrides for the behaviour settings above, which are cross-referenced to
their setting path. If you are looking for a behaviour knob, it is in
[Agent settings](#agent-settings-behaviour-config-as-code).

### Host-injected (set by the platform, not you)

Standard vendor/runtime env vars this codebase reads as **fallbacks or signals**, never as a
config surface you populate yourself — they're already set by whichever host you're running on
(Vercel, Claude Code, the AWS SDK's own convention). Listed for completeness, so a reader who
greps the source for `process.env.X` finds every name accounted for somewhere.

| Var | Default | Meaning |
|---|---|---|
| `VERCEL_ENV` | unset | Vercel-injected deployment stage (`production` / `preview` / `development`). Read as the `deployment.environment.name` resource attribute on every OTel span and the `env` field on every shipped log record; falls back to `NODE_ENV === "production" ? "production" : "development"` when absent (i.e. off Vercel). |
| `VERCEL_GIT_COMMIT_SHA` | unset | Vercel-injected commit sha this deployment was built from (OPE-991, the running-version seam). Read once at boot into the `AppInfo` fact bag `/oe status` and the `agent_version` tool both answer from — never re-read per call, never a guess. Unset off Vercel (local `eve dev`) or on a platform that doesn't set it ⇒ both surfaces answer `"unknown"`, on purpose: a running process cannot trust its own checkout to still match what it was actually built from, so this seam never falls back to a repo read. |
| `VERCEL_PROJECT_PRODUCTION_URL` | unset | Vercel-injected hostname of the project's PRODUCTION deployment. The self-dispatch route builds its own callback origin from it, and prefers it over `VERCEL_URL` so a preview deployment dispatches to production rather than to itself. Never set by hand — Vercel injects it. |
| `VERCEL_URL` | unset | Vercel-injected hostname of THIS deployment. The self-dispatch fallback when `VERCEL_PROJECT_PRODUCTION_URL` is absent. Never set by hand. |
| `VERCEL_OTEL_ENDPOINTS` | unset | Vercel-injected when the project has an OpenTelemetry integration that reads spans from a collector on the function's own host. When it is set, the OTLP destination (the app's `agent/instrumentation/otlp.ts`) also exports to that collector, at `http://localhost:<VERCEL_OTEL_ENDPOINTS_PORT>/v1/traces` — the rule `@vercel/otel` applies (OPE-2358). The collector skips a request that reports trace drains, because the Agent Runs export delivers those spans to the drains. If `agent/instrumentation/agent-runs.ts` turns Agent Runs off, a request with trace drains sends its spans to neither the drains nor the collector. Never set by hand. |
| `VERCEL_OTEL_ENDPOINTS_PORT` | `4318` | Vercel-injected port of that collector. Never set by hand. |
| `VERCEL_OTEL_ENDPOINTS_PROTOCOL` | `http/protobuf` | Vercel-injected protocol of that collector. `http/protobuf` exports protobuf; any other value exports JSON, as `@vercel/otel` does. Never set by hand. |
| `NODE_ENV` | unset | Standard Node env. Used only as the fallback above when `VERCEL_ENV` is absent — this codebase has no other `NODE_ENV`-gated behaviour. |
| `CLAUDE_PROJECT_DIR` | `process.cwd()` | Set by Claude Code when the [ops MCP server](../introduction/quick-start.md) (`preflight`, `scaffold_env` and the rest) runs inside a Claude Code session — points at the adopter's project root so those tools resolve `.env.local`, and the app's installed `@open-everywhere/core` version they compare against on every call, correctly regardless of the shell's own cwd. Outside Claude Code, `process.cwd()` is exactly as good. |
| `AWS_REGION` | `us-east-1` | The AWS SDK's own standard region var. Consulted as the last-resort fallback (after the OE-specific `OE_AWS_REGION`/`OE_AWS_SSO_REGION`) when the optional AWS-access plane (`OE_AWS_ENABLED=1`, `packages/adapters/agent/aws/`) resolves a default region for STS federation or the `aws` CLI executor. Irrelevant unless that plane is armed. |

### Model & gateway

| Var | Default | Meaning |
|---|---|---|
| `AI_GATEWAY_API_KEY` | — | Vercel AI Gateway key. Unneeded on a deployed Vercel project (OIDC auto-injected) or after `eve link`. |
| `OE_AI_GATEWAY_URL` | unset (`https://ai-gateway.vercel.sh/v4/ai`) | **DEPRECATED (OPE-2556): set `models.targets.gateway.url` in [agent settings](#agent-settings-behaviour-config-as-code) instead.** Where the `gateway` target connects: your own gateway, a compatible proxy, an on-prem relay, or a record/replay fixture. For one release it still retargets the `gateway` target when that target has no `url`, and the process warns once, the first time the process reads the target. When both are set, the setting wins, and the process warns once, the first time the process reads the target to say that this var is ignored. Read **once, at the target's first call**: a target that changed mid-process would mean two calls in one turn hitting two different places, so a change needs a restart. Credentials are unaffected either way (`AI_GATEWAY_API_KEY`, or Vercel's OIDC). |

**The build itself also talks to the gateway, separately from any deployed traffic.** `npm run
build` (`eve build`) resolves each configured model id's context window and output limit from the
public AI Gateway model catalog (`https://ai-gateway.vercel.sh/v1/models/catalog`). This call needs
no gateway key — the endpoint is unauthenticated. It does need outbound network access to that
host. A build environment that cannot reach it (an egress-filtered sandbox, an offline CI runner)
fails the build, unless a cache already exists at `.eve/cache/model-catalog.json`. Run `npm run
seed:model-catalog` before building to seed that cache from a small, committed snapshot
(`agent/model/model-catalog-snapshot.json`, trimmed to this repo's configured model ids). Add
`--refresh` to refetch the live catalog and update the snapshot itself.

### Identity & partitioning

**The deployment's own identity is tracked config, not env** (OPE-1545). Its org, its ambient
workspace and its ambient surface are declared in `agent/identity/surfaces.ts`, in the
`deploymentIdentity` object beside the surface vouches, and change by PR:

```ts
export const deploymentIdentity: DeploymentIdentity = {
  org: "default", // tenant — the OUTERMOST partition key. One org per deployment today.
  workspace: "dev", // `eve dev` gap-filler: the workspace a delivery with no platform identity gets
  surface: "default", // the same gap-filler for the room
};
```

A tenant id and a room key are literals a reviewer must be able to read in Git, so `OE_ORG`,
`OE_WORKSPACE`, `OE_SURFACE` and the older `OE_CHANNEL` spelling are no longer read and have no
fallback. Setting one has no effect. The `workspace`/`surface` pair applies only to a delivery that
carries no platform identity — an `eve dev` HTTP call, or a platform with no registered identity
mapper; every wired surface derives the real values from the inbound event.

🔴 **An operator-tier entrypoint never loads this declaration, so it needs the org named.** Seven
declare the org before they open the store: `oe secret`; the four core-workspace scripts
`npm run audit`, `npm run spend`, `npm run routines` and `npm run control` (the local control MCP
server, `scripts/control-mcp.ts`); `npm run deploy:census`; and the **ops MCP server**
(`open-everywhere-ops`), which takes the org as the `org` argument of `secret_set` / `secret_list` /
`secret_rm` rather than as a flag. Each runs before (or
without) an agent boot, so none of them ever loads `agent/identity/surfaces.ts` — the six that live
in `@open-everywhere/core` may not import an app module, and the census imports the app's access and
memory config without booting the agent that registers the declaration. Each therefore resolves the org
to `default` unless you name yours. On a deployment whose declared org is `default` that
is nothing to think about. On any other, name it: without it such a process answers about the
`default` partition, and the `audit.integrity` row it may write is filed under `default` while every
runtime row carries your org — no single reader sees both.

🔴 **Pass it after `--`, or npm eats it.**

```bash
npm run audit --workspace @open-everywhere/core -- --org <your org>    # correct
npm run audit --workspace @open-everywhere/core --org <your org>       # WRONG — silently runs as "default"
```

npm claims a bare `--org` as its own config and forwards only the value, so the script sees no flag
and reports no error. `oe secret` is a binary rather than an npm script and takes `--org` directly.

Two entrypoints are outside that list. `scripts/deploy/census.ts` accepts `--org`, but only to scope
the rows it READS: it parses the flag AFTER `connectOperatorStore()`, so it declares nothing, and any
`audit.integrity` row that connect writes is filed under `default` whatever the flag says
(OPE-1576). The app-tier ops MCP server (`scripts/ops-mcp.ts`) needs no flag at all — it registers
the declaration at start-up.

| Var | Default | Meaning |
|---|---|---|
| `OE_VISIBILITY` | `public` | Local-dev surface visibility (`public` / `private`). |
| `OE_MODE` | `channel` | Local-dev session mode (`channel` / `dm` / `mpim`). |
| `OE_PRINCIPAL` | — | Calling principal, for DM-mode testing. It applies to a context with no authenticated caller, so set it in a test shell only. |

`OE_PLATFORM` and `OE_TRUST` are gone (OPE-2411). The host is Vercel's own `VERCEL`; the
sandbox choice is [`sandbox.selfHostBackend`](#agent-settings-behaviour-config-as-code) and
[`sandbox.useVercelSandbox`](#agent-settings-behaviour-config-as-code); the deployment-wide trust
declaration is [`identity.blanketTrust`](#agent-settings-behaviour-config-as-code).

### Access & egress

The sandbox backend is the [`sandbox.selfHostBackend`](#agent-settings-behaviour-config-as-code) and
[`sandbox.useVercelSandbox`](#agent-settings-behaviour-config-as-code) settings since OPE-2411 (they
were `OE_SANDBOX_BACKEND` and the `OE_PLATFORM=vercel` override).

| Var | Default | Meaning |
|---|---|---|
| `EVE_DOCKER_PATH` | unset (plain `docker` on `PATH`) | Eve's own variable, read by Open Everywhere too. Path to a Docker-compatible CLI when it is not called `docker` — Podman, for example. Eve runs the sandbox container through it; the turn-end stop hook stops that container through the same binary, so one value governs both. Only read on the `docker` backend. |
| `OE_EGRESS_SOURCE_IP` | unset (proxy infers from the POST's own source address) | Off-Vercel self-host egress only: overrides the source-IP key `pushEgressPolicy` reports to the [egress proxy sidecar](./platforms/self-host-egress.md)'s per-source-IP policy store. The inferred default is correct for `justbash` (the app POSTs from the same IP its own traffic uses); set this if your `docker()` topology puts the sandbox container behind a different address than the app's own outbound POST. |

### Approvals

The general pending-action TTL ([`approvals.ttlHours`](#agent-settings-behaviour-config-as-code),
default 24h) is documented alongside the approval card mechanism itself in [The control plane §
In-Slack approvals](../security/control-plane.md#in-slack-approvals). Its narrower sibling
([`approvals.checkpointTtlHours`](#agent-settings-behaviour-config-as-code)) and the judge's arming
mode ([`approvals.judgeMode`](#agent-settings-behaviour-config-as-code)) are all typed settings.

🔴 **Expiry notices ride [`schedules.sweepOrgs`](#agent-settings-behaviour-config-as-code)** (it was
`OE_TIDY_ORGS` until OPE-2411). The daily sweep that rewrites an unclicked approval card, tells a
credential-grant requester that the ask lapsed, and writes the `approval.expired` and
`grant.expired` rows walks only the orgs that setting names (shipped `["default"]`). The functional
half needs no sweep: a lapsed card or ask refuses an approve click in every org. A multi-tenant
deployment that leaves the setting at its default gets no expiry notices for any org except
`default`. It also gets no `approval.expired` row there until someone clicks the lapsed approval
card, and never a `grant.expired` row. Declare the full org list.

### Delegation

[`delegation.oneshotAgent`](#agent-settings-behaviour-config-as-code) is a typed setting with no
environment variable, and it is the only delegation switch: it decides whether this deployment
delegates at all. There is no switch between delegation ROUTES — eve's built-in `agent` is the only
one — so the only posture an operator can express here is *less* delegation.

### Models

The model stack and the two primary-role pins are settings, not environment variables:
[`models.stack`](#agent-settings-behaviour-config-as-code),
[`models.primary`](#agent-settings-behaviour-config-as-code) and
[`models.force`](#agent-settings-behaviour-config-as-code). They were `OE_MODEL_STACK`,
`OE_PRIMARY_MODEL` and `OE_FORCE_MODEL` until OPE-2411. A committed pin is also priced by
`npm run lint:model-ids`, which an env pin never was.

### Connector plane (host-side Eve connections)

The DM-only wall and the three arming flags —
[`connectors.dmOnly`](#agent-settings-behaviour-config-as-code),
[`connectors.userPrincipal`](#agent-settings-behaviour-config-as-code),
[`connectors.linkSetVault`](#agent-settings-behaviour-config-as-code),
[`connectors.opTiering`](#agent-settings-behaviour-config-as-code) — are typed settings. Taking a
credential wall down is a reviewed diff, not an env edit.

### AWS access plane (optional, off by default)

Off unless armed. Armed, the agent federates its deployment OIDC token into short-lived STS
credentials and runs the `aws` CLI in a deny-by-default child environment. The master flag is the
[`aws.enabled`](#agent-settings-behaviour-config-as-code) setting and the link's scope list is
[`aws.ssoScopes`](#agent-settings-behaviour-config-as-code) (they were `OE_AWS_ENABLED` and
`OE_AWS_SSO_SCOPES` until OPE-2411). The variables below are the plane's wiring, and nothing here is
read while the flag is off.

| Var | Default | Meaning |
|---|---|---|
| `OE_AWS_REGION` | unset | The operator's default region, applied when a role grant names none. STS falls back further to `AWS_REGION`, then `us-east-1`. |
| `OE_AWS_SSO_REGION` | falls back to `OE_AWS_REGION`, then `AWS_REGION` | The Identity Center region — where the `oidc.<region>.amazonaws.com` and `portal.sso.<region>.amazonaws.com` endpoints live. |
| `OE_AWS_SSO_CLIENT_ID` | unset | The pre-registered **public** OIDC client id for the Identity Center auth-code + PKCE link flow. Not a secret (it rides the authorize URL). Missing ⇒ the link flow fails closed with an actionable message; arming the master flag never requires SSO to be configured. |
| `AWS_WEB_IDENTITY_TOKEN_FILE` | unset | The standard AWS spelling for the file holding this deployment's OIDC web-identity token; a federated host (EKS/IRSA) injects it. Tried **first**, and **fails loudly** when set but unreadable or empty — never a silent fallback to no access. |
| `OE_AWS_WEB_IDENTITY_TOKEN` | unset | The inline web-identity token, for a host that injects no token file. Tried only when `AWS_WEB_IDENTITY_TOKEN_FILE` is unset; neither ⇒ the mint throws, fail-closed. |

### Own-rolled OAuth layer

No environment variable configures it since OPE-2411. Each connector declares its own SIGN-IN next
to its URL — discovery resource, scopes, or a static client id with a credential-store **ref** for
the secret (never the value) — and the flow always registers. For an MCP server the app declares,
that place is its entry in `agent/access/mcp-servers.ts` (OPE-2414): `oe build` writes the
connection module from the entry. A connection a package ships declares its sign-in in its own
connection module. A
connector that declares a sign-in offers "Connect my account" to a person a bundle grants its
`user-oauth` credential. A mint for a home that no connector declares fails closed, unless the
vault already holds a client record or an unexpired token for that home: a stored row keeps serving, so that a
re-keyed declaration does not strand the people who signed in. The off switch is therefore the
bundle grant: remove the `user-oauth` credential from the bundle, and no mint reaches the flow. The
shipped Notion connection
declares hosted Notion MCP's sign-in. `OE_OAUTH_ENABLED`, `OE_OAUTH_CONFIG` and
`OE_OAUTH_NOTION_RESOURCE` are deleted. See
[connectors and providers](../capabilities/connectors-and-providers.md#the-three-oe-oauth-dialects).

### Sandbox lifecycle (Vercel backend)

[`sandbox.stopAfterTurn`](#agent-settings-behaviour-config-as-code),
[`sandbox.extendMaxMinutes`](#agent-settings-behaviour-config-as-code),
[`sandbox.timeoutMs`](#agent-settings-behaviour-config-as-code),
[`sandbox.snapshotExpirationMs`](#agent-settings-behaviour-config-as-code) and
[`sandbox.image`](#agent-settings-behaviour-config-as-code) are typed settings. ⚠️ The last three
are read **once at boot** — they are arguments to the sandbox backend eve evaluates at module load,
and the two clocks are applied at sandbox CREATE and then persist on the sandbox, so a change only
affects NEW conversations.

### Bash hang guard

The `bash` tool resolves only when the command's **output stream closes** — not when its process
exits. A backgrounded process that still holds stdout/stderr therefore keeps the call open
indefinitely (measured: 753s with zero bytes flowing, still open when the probe gave up). Two
layers guard that, both armed by default, both backend-independent, and both typed settings:
[`bash.backgroundGuard`](#agent-settings-behaviour-config-as-code) refuses a bare `… &` that
redirects neither stream before it runs, and [`bash.timeoutMs`](#agent-settings-behaviour-config-as-code)
caps one call's wall clock (`0` disables it).

### Stall guard (repeated tool-call loop)

Detects the agent spinning — the SAME tool called with the SAME arguments AND the SAME result,
repeatedly — and nudges the model with a visible message instead of aborting or pausing the turn
(eve's hooks are observe-only; there is no authored turn-abort). State is per-session-turn, so a
repeat across two separate wakes is never mistaken for a live spin. The run length before a nudge is
[`stall.repeatThreshold`](#agent-settings-behaviour-config-as-code) (`0` disables the guard).

### The browser ([the in-sandbox browser](../capabilities/browser-qa.md))

The master flag [`browser.enabled`](#agent-settings-behaviour-config-as-code) is a typed setting. The
reach is **not** a setting: it is the host declaration in `agent/access/browser-hosts.ts`, where each
row names a host, the HTTP verbs the firewall admits there, an optional credential the firewall
injects at the boundary, and whether `browser_evaluate` is armed for it. Both halves are compiled
into the build, so the sandbox template bake and the runtime mount resolve the same values — there is
no build-env / runtime-env pair to keep in step.

### Domain skills

The per-domain count cap is
[`skills.domainSkillCap`](#agent-settings-behaviour-config-as-code); per-skill content size is capped
separately in code (32KB) and is not configurable.

### Spend & usage analytics

No environment variable configures this surface. The monthly budgets and the per-session
checkpoints are config-as-code (`agent/spend/budgets.ts` and `agent/spend/checkpoints.ts`, above),
model prices are committed in `agent/spend/model-pricing.ts`, and a live allowance is bridged
through the control plane's `set_spend_limit` / `clear_spend_limit` rather than through env. See
[Spend & cost controls](../security/spend-and-cost.md).

### Session rotation (standing seats)

A standing seat — a channel window, the unified cross-surface window, a DM seat — runs on a
*generation*. Rotating mints a fresh session for the next wake and carries the outgoing generation's
**tail** into it, so the new generation starts small but not amnesiac.

**What a tail is.** The deployment records the seat's conversation as it happens: every wake message
it delivers, and every post the seat makes. At a rotation it reads that record back, caps it at
[`rotation.tailTokenCap`](#rotation) most-recent-first, and renders it as the fresh generation's
opening backscroll. It reaches exactly **one generation** — a tail contains only what that generation
itself said and heard, never the tail it was shown when it started. Anything older is the seat's job
to look up: its memory holds durable state, and its read tools reach the surface.

The design point is that a tail makes a seat **competently conversational, not knowledgeable**. It is
deliberately tight — large contexts cost adherence, and a single window can span several surfaces.

**A DM seat carries more: its conversation summary.** A DM is one person's own thread, so every DM
rotation also carries the DM's most recent messages — at most 200 entries, about the last 100
exchanges — capped at [`rotation.dmSummaryTokenCap`](#rotation). Each entry is one recorded message cut
to 480 characters, with its own author grain, and the oldest drop first. The summary rolls from
generation to generation, so the person can refer to something said about 100 exchanges back and the
seat follows. It is extractive, not model-written, and a refuted or ungraded author's message never
enters it. It is stored as one row per DM seat. Each rotation replaces it, and a confirmed `edit_reply` rewrites the text of the one post it changed. Nothing else deletes it. A channel
seat carries its tail only. See
[DM seats](../how-it-works/agent-and-loop.md#dm-seats-and-the-dm-audience).

Two cases carry no tail, and both fall back to a capped fetch of the surface's own recent history: a
channel the deployment has never woken on, and — once, per seat — a generation minted before this
mechanism existed. A surface with no history read at all (Teams) simply opens cold.

**Rotation is about CONTEXT, and nothing else.** It is not a hygiene sweep, not a security boundary
and not a way to pick up a new deploy: a generation is retired because its context has gone stale,
full stop. Three things follow, and they are the whole shape of the table below:

- **Time is the primary trigger.** A seat's world view decays on a calendar — last month's norms, a
  resolved incident still described as open — and no counter measures that. So a generation rotates
  once it is older than its expiry clock, whether it has been busy or idle.
- **A standing seat re-mints rather than compacts.** [`rotation.contextSizeTokens`](#rotation) reads
  the last request's input tokens — the same measure compaction reads — and sits *below* the
  compaction fire point. A seat therefore crosses the rotation line first and starts a fresh
  generation with its tail (and, on a DM, its conversation summary), instead of crossing the
  compaction line and carrying a model-written summary of itself.
- **Compaction still owns the runs that cannot rotate.** Within one generation eve summarises older
  turns once the transcript passes
  [`agent.compactionThresholdPercent`](#agent-settings-behaviour-config-as-code) of the model's
  context window. That is what governs one-shot workers and job seats, which have no rotation clock
  at all (a clock over a session that lives for one unit of work measures nothing).

The turn and token limits are therefore **backstops**, not the everyday path. They exist for the
cases the clock cannot see: a broken usage counter, or a generation that outgrows the underlying
run before its clock elapses.

**One rotation is not about context — it is about which code the seat runs.** A durable session is
one workflow run, and a workflow run is **pinned to the deployment that created it**. Every later
turn of that seat, and every worker it delegates, executes the **minting deployment's** bundle,
however many times the instance has shipped since. The seat's ingress runs the new code and its turn
runs the old one. An agent runtime upgrade is the harder face of the same fact: after an upgrade
that crosses a storage-format floor, the new runtime cannot read the old run's event log at all, and
the failure is silent — the wake is enqueued, the turn dies below the harness, and nobody is told.

So OE **compares, on every wake, what the seat was last served with against what this bundle is**.
Each seat's registry row records two fingerprints:

- the **code fingerprint** — the pinned agent-runtime version and two build-time hashes of runtime
  source. The **product half** hashes the Open Everywhere packages and is baked into
  `@open-everywhere/core` when the package is built. The **app half** hashes **your app's own tree**
  as the build checkout holds it: every `.ts` file (except `.d.ts`) and every `instructions.md` under
  `agent/` (subagents included), plus `roster.config.ts`, `roster.lock.json` and `patches/`. The walk
  reads the disk, not git, so build from a clean checkout: an untracked `.ts` file under `agent/`
  gives one commit two fingerprints, and every seat rotates on a deploy that changed nothing. `oe build` computes the app half on every
  build and writes it to `agent/lib/app-code-fingerprint.generated.ts` (gitignored); the generated
  provider table imports it at boot. Both halves leave out the same three things: the per-domain
  declarations, the materialised eve slot tree and other `oe build` output, and the tests; and
- the **domain fingerprint** — a stable hash of that seat's own domain declaration, as the settings
  module loads it.

If either differs from the running pair, the wake retires that seat's generation and is delivered to
a fresh one, with a `session.runtime_rotation` audit row naming which half moved, both pairs, and the
deployment that was serving. The deployment id is a **fact on the row, never part of the identity**.
Four things follow, and each is the reason the comparison replaced the old per-deployment claim:

| what you do | what rotates |
|---|---|
| ship changed code — Open Everywhere's, or only your app's own code or config | every standing seat, on its own next wake |
| redeploy the identical tree, or change an environment value | nothing |
| edit one domain's declaration | that domain's seats only |
| `npm run rollback` to code that already served | every standing seat, on its own next wake |

A code ship therefore costs every standing seat its in-context state once — the recorded
conversation tail (and a DM's conversation summary) and durable memory survive, and the seat's next
turn runs the code you just shipped. A config-only change costs that only to the seats it actually changed.

**A conversation's work session takes the same comparison, at each forward.** Its run is pinned to
the deployment that started it, as a seat's is. When the code under it differs from the running
code, the forward goes to a new work session on the running code, with a `work.session_rotated` row
(trigger `runtime-changed`). Two things differ from a seat. A work-session row that records no code
rotates, because a work session must never keep code that nothing identifies; a seat row adopts.
And the rotation loses no job: the old work session keeps running the jobs it holds on its own
deployment, and their results still reach the room (`drainingRequests` on the row). A DM's work
session takes the DM seat's domain half (the `no-domain` literal). See
[the work session's lifetime](../how-it-works/agent-and-loop.md#the-work-sessions-lifetime).

🔴 **A rollback rotates, and that is the point.** `npm run rollback` moves the alias back to a
deployment that already served. Its code fingerprint is not the one the seats were last served with,
so they rotate onto the code the alias now serves. A seat that has never been stamped — one this
bundle minted moments ago, or one that predates this mechanism — **adopts** the running pair without
rotating, so a fresh seat is never retired before its second wake.

🔴 **A behaviour change outside the domain declarations rotates every seat.** `agent/settings/settings.ts`,
the access bundles, their machine-written overlays (`agent/access/grants.generated.ts` and the four
beside it), the A2A agent declarations and the model policy are all inside the code fingerprint (the
app half), because no per-seat fingerprint covers them. This holds in an app that installs
Open Everywhere from the registry, too: a deploy that changes only the app's config retires every
standing seat and work session that ran the old config. Before OPE-2466 only the product half
existed, so such a deploy rotated nothing and the change never reached a live seat. That is the safe direction: the alternative is a revoked grant that no standing seat
ever picks up. The code half also covers `patches/`, which rewrites the runtime bytes a seat
executes. **What neither fingerprint covers:** a dependency bump (neither `package.json` nor
`package-lock.json` is hashed — a lockfile moves on every devDependency bump, and rotating every
seat for a change no seat runs is what this mechanism exists to stop), and any change under
`docs/`. Retire a seat by hand with the operator mark below if one of those matters.

🔴 **Two deployments serving one instance rotate each other's seats.** A Vercel cron is registered
against a **deployment id**, and an alias move does not re-point it — so after `npm run rollback` the
alias serves one deployment while scheduled ticks still run another, and a seat woken by both
alternates between their two fingerprints, losing its working memory on every message. **Nothing
closes this for you.** The rung that detects it, `checkCronDeploymentId`, runs only inside
`npm run deploy:verify` — it does **not** run on the `npm run rollback` path that opens the split,
and it reports green without checking when there is no Vercel API token
(`OE_VERCEL_API_TOKEN`), no resolvable project, or a non-200 from the Vercel API. So after a
rollback, run `npm run deploy:verify`, and treat a cron-registration disagreement as "run a fresh
`vercel deploy --prod`" — never as noise. OPE-1829 tracks an identity that converges under two
writers.

**An operator can retire a generation by hand, and the way that works is a mark.** The ops sweep
stamps each standing seat's registry row; the next wake to reach that seat reads the stamp, rotates
before it delivers, and the stamp is spent. It is the out-of-band verb — a deploy already retires
every generation whose code changed, so the mark is for retiring one seat without changing any code. The mark
exists because only a seat's own rotation can carry a tail: the
tail is handed to the wake being delivered, in memory, at the moment the generation is retired. A
tool that rotated the row from outside would leave the next wake a plain resume, with no tail and
nothing to fall back on but a platform history fetch.

**One more thing writes that mark, and it is a repair.** A standing seat is one long-lived workflow
run, and the platform can delete the deployment that created it. The seat is then unreachable
forever: every wake fails while it fetches the run's key, and the person is told nothing. So a wake
that fails in exactly that way marks the seat, and the surface delivers the same wake a second time
— into the fresh generation the mark just produced. One audit row per stranded wake
(`session.pruned_deployment_strand`) names the run and the missing deployment. Every other wake
failure is left alone: a retry there would throw away a healthy generation's context on a blip.

The DM seat's own thresholds and the backscroll reach-back are **code constants, with no env var
and no setting** (OPE-2411). No deployment has a reason to turn them, so a change to one is a code
change.

- **`DM_SEAT_ROTATE_EXPIRY_MS` — 30 days.** The same clock for a DM seat, deliberately longer: a
  personal thread accrues staleness far more slowly than a room full of other people. It was
  `OE_DM_SEAT_ROTATE_EXPIRY_DAYS`.
- **`DM_SEAT_ROTATE_TURN_BUDGET` — 50.** The turn **backstop** for a DM seat (its observed latency
  creep is turn-count-driven). It was `OE_DM_SEAT_ROTATE_TURN_BUDGET`.
- **`DM_SEAT_ROTATE_TOKEN_BUDGET` — 5000000.** The same **backstop** for a DM seat, on input
  tokens. It was `OE_DM_SEAT_ROTATE_TOKEN_BUDGET`.
- **`SUPERVISOR_BACKSCROLL_REACHBACK_HOURS` — 168 (7 days).** How far back a channel or unified
  window's **first-wake raw backscroll fetch** paginates, on both Slack and Discord. It is one
  supervisor-backscroll concept, so both adapters take this one core constant. It is generous
  enough that the spine cluster (the most-recent, enrichment-cap-exempt cluster) still spans a
  weekend or overnight gap, and it is still a hard floor that bounds the fetch. It was
  `OE_SUPERVISOR_BACKSCROLL_REACHBACK_HOURS`.

One turn-scoped sibling has **no env var at all**. The per-turn **step boundary** used to be
`OE_TURN_STEP_CEILING`, read inside the patched `eve` bytes — the only seam a byte-patch had. It is
userland now (`packages/core/agent/model/step-boundary.ts`, counted in the `step.started` model
resolver), so it is two ordinary [agent settings](#agent-settings-behaviour-config-as-code) —
[`turn.stepBudget`](#agent-settings-behaviour-config-as-code) and
[`turn.stepBackstopMultiple`](#agent-settings-behaviour-config-as-code) — changed in `agent/settings/settings.ts`,
i.e. in a reviewed diff. There is deliberately no ops override: a runaway-turn budget is a tuning
number, not a wall anyone needs to drop without shipping.

It is also **two tiers now, not a cap**. At the budget (120 round-trips) the turn is *not* killed:
every subsequent model call carries a wrap-up instruction telling the agent to finish, report and
yield the turn. Only at the backstop (3× the budget, so 360) does a text-only stub reply take over,
which ends the turn through eve's own continue-decision. Both crossings write a `turn.step_boundary`
audit row (`detail.tier` = `soft` / `hard`, with the count, the budget and the turn id). Set
`turn.stepBudget` to `0` to disable both tiers. The guard exists because a live turn was measured at
446 steps / 36 minutes of gateway spend — but the failure there was a turn that never *yielded*,
which is what the soft tier addresses without capping legitimately long work.

### Soak capture (`soak.capture`) — arm it for a run, then disarm it

`soak.capture` records the **composed request body of every model call** into the
`model_call_capture` table, so the soak tests can replay a real 100k-token prefix ten times instead
of re-rendering an approximation of it. It ships **off**, it has no environment variable, and it is
meant to be armed for one run and disarmed after.

**Always set [`soak.captureSurfacePrefix`](#agent-settings-behaviour-config-as-code) too.** It
narrows capture to surface keys with that prefix, which is how a run records the soak fixtures and
not the rest of the deployment. Surface keys read `platform/workspace/surface`, so
`"slack/T0123/C0SOAK"` is one channel. The shipped value is empty — every surface — only because a
default cannot know your soak surface. Leaving it empty on a deployment carrying real conversations
records all of them.

Three things to know before you arm it:

- **The store is transcript-grade.** A body is the whole prompt — rendered member messages, tool
  results, the system prompt — verbatim. Read the posture in
  [The deployment-mounted read route](../security/control-plane.md#the-deployment-mounted-read-route)
  before arming it on any deployment carrying real conversations.
- **Retention is your act.** Harvest the captures over
  `GET /control/v1/session/<sessionId>/model-calls`, then delete them by session. There is no TTL.
- **A capture gap is loud.** The recorder counts what it captured; eve's `step.completed` events
  count what actually ran. If a model call reaches a provider on a path the recorder does not wrap,
  the turn writes one `soak.capture_gap` audit row carrying both counts. Treat that session's
  captures as unusable for replay and fix the seam — a partial prefix library is worse than none.

The write is **awaited**, not fire-and-forget: a lost capture is usually the deepest, most valuable
prefix in the run, so an armed run pays a little latency per model call to keep it. That is another
reason not to leave it armed.

A rotation never blocks on continuity. Reading the outgoing generation's tail is a store read, and a
store failure yields an empty tail rather than a failed wake — the fresh generation then falls back
to a capped fetch of the surface's own recent history, exactly as a brand-new seat does.

### Memory backing

The **first-party** backings below are configured by env because their "connection" is the
deployment identity. The **connector-owned** backings (`github`, `notion`) are not configured
here at all: each is declared by its provider bundle and rides the domain's connector grant — a
silo naming a connector the domain doesn't hold, or a container outside that grant, is a
fail-loud error at config load. See
[Memory backings](../extending/memory-backings.md#connector-owned-memory).

| Var | Default | Meaning |
|---|---|---|
| `OE_MEMORY_PROVIDER` | `postgres` when `DATABASE_URL` is set, else `git` — ⚠️ a deployment that already held a `DATABASE_URL` and relied on the `git` default must now set `OE_MEMORY_PROVIDER=git` explicitly to keep its store, or migrate memory first ([upgrade note](./database-graduation.md#-upgrading-into-the-derived-default-your-memory-backing-may-move)) | `git` / `sqlite` / `postgres`. **Not required on a hosted deploy:** a present `DATABASE_URL` selects `postgres` on its own (OPE-2230), and this variable overrides that in either direction. Postgres needs a registered client at startup. |
| `OE_MEMORY_DIR` | `./.open-everywhere-memory` | Durable host-side store location. |
| `OE_SQLITE_PATH` | `<OE_MEMORY_DIR>/open-everywhere.sqlite3` | SQLite DB file (memory + operational stores). |
| `OE_MEMORY_GIT_BRANCH` | `main` | Branch for the `github` Contents-API backing. |

### Memory dream/tidy sweep

Which orgs the sweep covers is the [`schedules.sweepOrgs`](#agent-settings-behaviour-config-as-code)
setting (was `OE_TIDY_ORGS`), shared with the daily directory sync. On Vercel, accepting an
ephemeral DM memory store is [`storage.allowEphemeralMemory`](#agent-settings-behaviour-config-as-code)
(was `OE_ALLOW_EPHEMERAL_MEMORY`). The per-silo judge budget is
[`memory.dreamCandidateCap`](#agent-settings-behaviour-config-as-code), a typed setting. See [Memory
hygiene: the dream cycle](../capabilities/memory.md#memory-hygiene-the-dream-cycle).

### Operational store

On Vercel, accepting the per-instance PGlite or sqlite floor is the
[`storage.allowEphemeralOperational`](#agent-settings-behaviour-config-as-code) setting (was
`OE_ALLOW_EPHEMERAL_OPERATIONAL` until OPE-2411).

| Var | Default | Meaning |
|---|---|---|
| `OE_OPERATIONAL_PROVIDER` | `postgres` — hosted when `DATABASE_URL` is set, else the embedded PGlite floor | `sqlite` (DEPRECATED, reachable only by naming it) or `postgres` (hosted; register a client at startup). **Not required on a hosted deploy:** a present `DATABASE_URL` selects hosted `postgres` on its own (OPE-2230), and this variable overrides that in either direction. Backs spend, routines, audit. |
| `OE_NEON_WS_PROXY` | unset (**hosted Neon, untouched**) | Local-dev-only: `host:port` of a local `wsproxy` (the Neon serverless driver replaces TCP with a WebSocket, which a vanilla `postgres:16` speaks neither side of) so `OE_MEMORY_PROVIDER=postgres`/`OE_OPERATIONAL_PROVIDER=postgres` can point at a plain Postgres over a docker-compose network instead of hosted Neon. No-op unless set. Never point this at a remote endpoint — it configures insecure WS with no TLS/connect pipelining, correct only for a same-network, non-TLS local proxy. |

### Credential broker

| Var | Default | Meaning |
|---|---|---|
| `OE_CREDENTIAL_ENCRYPTION_KEY` | unset | 32-byte base64 AES-256-GCM key. Arming it **registers the `db` credential broker** (the self-host store for chat-pasted keys); absent, `db` is unavailable and the "Set API key" chat intake is hidden. Arming it also keys the egress state digest (an HKDF subkey, label `egress-state-digest`; see [Revocation latency](../security/revocation-latency.md)). A rotation makes each session re-apply its egress policy once. Absent, the digest key is random per process, so a failed turn re-apply that another process handles refuses the turn, unless the policy in force is deny-all or the new policy is allow-all. |
| `OE_INTAKE_PAGE_SIGNING_KEY` | **mints on first use** | HMAC secret for **both** one-shot page routes. (a) The **credential-intake page** (`/connect/v1/intake`) — the write-only, single-use, ~15-min link non-Slack surfaces (Discord/Teams/Notion/GitHub/Linear) deliver so a requester can enter an API key on a browser form instead of a native modal. (b) The **secret-reveal page** (`/connect/v1/reveal`) — the single-use, 15-min link that shows a webhook signing secret exactly once, including the Notion subscription handshake token (see [Notion](./surfaces/notion.md)). **Self-shared — no counterparty ever reads it** (OPE-408 step 3): this deployment both mints and verifies its own tokens, so there is nothing for an operator to set. Resolution order: a value already in the encrypted vault wins; this env var (if still set) is the announced-once on-ramp; neither ⇒ a fresh value mints and stores itself, keyed off `OE_CREDENTIAL_ENCRYPTION_KEY`. Both routes `404` only when the vault itself is unarmed (no `OE_CREDENTIAL_ENCRYPTION_KEY`) or the public base URL (`OE_PUBLIC_BASE_URL`, else the Vercel deployment URL) is unresolvable. |
| ~~`OE_CREDENTIAL_BROKER`~~ | — | **Removed (inert).** There is no global broker selection any more — every credential names its home `broker` explicitly (`env`/`db`/…). Delete this var from your env. |
| `OE_CREDENTIAL_BINDINGS_PATH` | `agent/access/credential-bindings.generated.ts` | Repo-relative path of the credential-bindings overlay — the data-only file the [credential-binding PR](../security/credentials-and-planes.md) writes to re-stamp one credential's custody from `env` to `db` after a chat-pasted key lands in the store. |

### Observability

Everything here is optional and **fail-open**: with none of these set, logging stays plain
console (platform runtime logs only) and tracing stays a no-op. See
[Observability](./observability.md) for the full deployer story and a recommended
free-tier setup.

| Var | Default | Meaning |
|---|---|---|
| `OE_LOG_SHIP_URL` | — (**off**) | HTTP log-ingest endpoint (any backend accepting a POSTed JSON array — Axiom, Better Stack, a collector). Presence enables structured log shipping: every `[open-everywhere:…]` console line + structured error records, batched and fire-and-forget. Never blocks a turn; all transport failures are swallowed. |
| `OE_LOG_SHIP_TOKEN` | — | Auth header **value** (e.g. `Bearer xaat-…`). Secret — env only, never config-as-code. |
| `OE_LOG_SHIP_TOKEN_HEADER` | `authorization` | Auth header **name** (e.g. `x-honeycomb-team` for Honeycomb-style APIs). |
| `OE_LOG_SERVICE` | `open-everywhere` | `service` field stamped on every record (the relay stamps its own). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — (**no-op**) | Standard OTel var. Presence adds an OTLP/HTTP collector as an eve trace destination (the app's `agent/instrumentation/otlp.ts`). Spans go to `<endpoint>/v1/traces`. eve owns the OpenTelemetry pipeline. On Vercel preview and production, eve also exports to Vercel Agent Runs by default. Spans carry metadata only: the trace policy in the app's `agent/instrumentation/otel.ts` records no model input or output. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — (**no-op**) | Standard OTel per-signal variant: the full traces URL, used unchanged. It wins over `OTEL_EXPORTER_OTLP_ENDPOINT`. Either one turns the OTLP destination on. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Standard OTel var: `http/protobuf` or `http/json`. Any other value (`grpc` too) exports with `http/protobuf` and logs a warning. |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | — | Standard OTel per-signal variant of `OTEL_EXPORTER_OTLP_PROTOCOL`. It wins when both are set. |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Standard OTel var — collector auth, e.g. `Authorization=Bearer%20…,X-Axiom-Dataset=…`. Comma-separated `key=value` pairs. Each value is percent-decoded. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | — | Standard OTel per-signal variant of `OTEL_EXPORTER_OTLP_HEADERS`. A key here replaces the same key there. |

### Telemetry

Anonymous usage telemetry — **default ON**, closed vocabulary of ten runtime events, fail-open. See
[Telemetry](./telemetry.md) for the full disclosure (every event/attribute, the
never-collected list, retention, one example payload).

| Var | Default | Meaning |
|---|---|---|
| `OE_TELEMETRY` | `on` | `off` / `0` / `false` disables everything. Checked first — wins over every other setting. |
| `DO_NOT_TRACK` | — | Any truthy value disables everything (honored as a courtesy). Checked second. |
| `OE_TELEMETRY_DEBUG` | — | `1` prints every would-be payload to the console **without sending it**. |
| `OE_TELEMETRY_OTLP_URL` | Our default collector | Any OTLP/HTTP logs endpoint. **A FULL redirect — 100% of the payload goes there, nothing is ever teed to the default.** |
| `OE_TELEMETRY_OTLP_HEADERS` | — | `Name=value,Name2=value2` — auth headers for a redirected, authed collector. |
| `EVE_TELEMETRY_DISABLED` | `1`, set by Open Everywhere | **eve's** switch for its own CLI telemetry, not Open Everywhere's. Every npm script that runs `eve` sets it, and so does each stage of the Dockerfile. So `eve dev`, `eve build` and `eve start` send nothing to `telemetry.vercel.com` (OPE-2526). `OE_TELEMETRY` does not change it. `npm run lint:eve-telemetry` pins it. See [Telemetry § Every default outbound call](./telemetry.md#every-default-outbound-call). |

### Test & eval harness (no env var arms a test seam)

No environment variable arms a test seam (OPE-2411). The six that did now take one of three forms:

- **An in-process test valve** (`packages/core/agent/testing/test-valves.ts`). Only code inside the
  process can arm one: a test file, the integration harness, or a `node --import` preload that a
  developer names on the command line. A production build ships none of those, so it cannot arm a
  valve by accident. The valves are `egress-spoof` (was `OE_EGRESS_SPOOF`: every outbound room post
  swallows its send — see `agent/channels/egress-spoof.ts` for the coverage rule; a local eval
  target arms it with `NODE_OPTIONS="--import=$PWD/packages/core/scripts/eval/arm-egress-spoof.mjs"`), `scripted-model`
  (was `OE_SCRIPTED_MODEL`: the integration tier's model double, fail-closed three ways and pinned by
  `scripts/boot-smoke-test.ts` ⑤) and `memory-eval` (was `OE_MEMORY_EVAL`: the memory-battery eval
  topology, armed by `node --import ./packages/core/scripts/eval/arm-memory-eval.mjs`). The
  `egress-spoof` and `scripted-model` valves also refuse outright on Vercel.
- **A code-only setting** for the two seams a deployed test bed needs: `wake.testWakeRoute` (was
  `OE_TEST_WAKE`) and `wake.driverAllowlist` (was `OE_TEST_DRIVER_IDS`). See
  [Agent settings](#agent-settings-behaviour-config-as-code). A test bed arms them in its own
  tracked settings file, so arming one is a reviewed commit.
- **Nothing.** `OE_ALLOW_TEST_NETWORK` opted a `-test.ts` process back into live entity hydration.
  It had no caller, so it is gone: a test that wants a live read passes its own `deps.read`.

### Source control (GitHub App)

| Var | Meaning |
|---|---|
| `OE_GITHUB_APP_ID` | App id (required to enable the plane). |
| `OE_GITHUB_APP_CLIENT_ID` | Preferred JWT issuer when present. |
| `OE_GITHUB_APP_PRIVATE_KEY` | PEM private key — server-side secret, never in a sandbox. |
| `OE_GITHUB_APP_SLUG` | App slug → bot user `<slug>[bot]`. |
| `OE_GITHUB_BOT_USER_ID` | Numeric bot user id, for commit attribution. |
| `OE_GITHUB_INSTALLATIONS` | JSON map `owner → installation id` (multi-org). **Authoritative but optional**: GitHub delivers the `installation` webhook to every App by default (nothing to subscribe to), so each install registers itself and this map is composed *over* the discovered entries. See [GitHub § Multi-org installs](surfaces/github.md#multi-org-installs-self-registering). |
| `OE_GITHUB_OWNER` / `OE_GITHUB_INSTALLATION_ID` | Single-owner pair (alternative to the map). |
| `GITHUB_TOKEN` | The personal access token, read ONLY when `github.auth` is `"token"` (OPE-2530). It then reaches this deployment's own repository and `github.tokenRepos`, nothing else. With the shipped `"app"` it is never read, even when set: there is no fallback. See [Source control § A personal access token instead of the App](../capabilities/source-control.md#a-personal-access-token-instead-of-the-app). |
| `GITHUB_WEBHOOK_SECRET` | HMAC-verifies inbound `event` routine deliveries. **Required** — unset = every delivery rejected 401 (fail closed). |

### Access requests ([the widen-slow path](../how-it-works/access-requests.md))

Fail-closed: with either of the first two unset, the `request_access` tool refuses
politely and the flow is off. Needs write access to the config repo through the deployment's
GitHub credential: the App above, or `GITHUB_TOKEN` when `github.auth` is `"token"`.

| Var | Default | Meaning |
|---|---|---|
| `OE_ACCESS_ADMIN_CHANNEL` | — | Slack channel id notified "PR opened — merge to grant". |
| `OE_ACCESS_CONFIG_REPO` | — | `owner/repo` of this deployment's config repo (where the grants overlay lives). |
| `OE_ACCESS_CONFIG_BASE` | `main` | Base branch the request branch cuts from / the PR merges into. |
| `OE_ACCESS_GRANTS_PATH` | `agent/access/grants.generated.ts` | Repo-relative path of the grants overlay. |
| `OE_WEBHOOK_HOOKS_PATH` | `agent/webhooks/hooks.generated.ts` | Repo-relative path of the webhook-declaration overlay — the `declare_webhook` flow rides this SAME config repo/branch/credential, only the file differs. |
| `OE_AGENTS_PATH` | `agent/memory/config/agents.generated.ts` | Repo-relative path of the agents overlay — the `create_agent` flow's machine-written file, riding the same config repo/branch/credential again. |

### Tenant fence (one workspace per tenant-scoped platform)

On a **tenant-scoped** platform a person id is issued *per tenant* — Slack is the one such
platform today — while a principal key is only `platform/<id>`. So two workspaces of that vendor
on one deployment make two different humans share one key, and every matcher over it (admin
rosters, wake trust, who may click an approval card, the DM binding that resolves somebody's
*personal* credentials) can hand one person the other's standing on a chance id collision. Slack's
Events API authenticates an **app-level** signing secret that every installing workspace shares, so
nothing else in the stack notices a second one arriving.

The fence is on by default and needs no configuration: the tenants you declare across
`agent/memory/config/domains/` are the admitted set. Declaring two workspaces fails the build; a
delivery from an undeclared tenant is dropped with a `surface.wake_dropped` audit row and no model
turn. A deployment that declares no Slack channels at all is unaffected — an empty admitted set means
the fence is inert, not that everything is refused.

**Every door that STARTS a model turn from an inbound delivery carries it**: the `@mention` door,
the four dispatching
engagement routes, the channel-join door, the interactivity (shortcut) door, and the DM door —
a `message.im` or `message.mpim`, a shortcut invoked inside a DM, and the group-DM mention divert.
The `/oe` slash command carries it too, though it runs no turn. The DM door matters most: a DM seat
holds a window token, delegation and memory, and a DM is exactly where a colliding member id
resolves somebody's *personal* credentials.

**Every door that runs NO turn carries it as well** (OPE-1680): the approval click, the set-key
click and its modal submit, the connect click, the grant-card click, and the reaction branch. The
first five arrive on the interactivity URL; a reaction arrives as an Events API envelope on its own
branch. **One of the six does reach a turn, indirectly: an approval click that DECIDES.** It starts
no turn from the click. `approvals/flow.ts` calls `deliverDecisionFeedback`, which wakes the
PROPOSING session's standing window seat with a silence-biased ambient notice
(`channels/unified.ts` `dispatchApprovalDecisionWake`). That seat sits in the ADMITTED workspace, so
an unadmitted click updates a belief there rather than starting a fresh turn in its own workspace.
The other five reach no turn at all. What the six refuse is therefore mostly not a turn — it is the
aliasing itself, plus the host-side work each one
would otherwise do on this deployment's own credentials: decide and execute a pending approval, open
a credential intake, store a pasted secret, mint an OAuth URL, answer a credential-grant ask, or —
for the ✋ stop reaction — cancel a running turn through an anchor resolved by org and never by
workspace. A refused delivery gets the empty `200` its route owes and one `surface.wake_dropped` row
naming the door, the workspace and the Grid. A click carries no message, so the row is keyed to the
click's own channel where the payload names one and to the surface `interactivity` where it does not
(a `view_submission` names a view, not a room), and its `ts` is `null` rather than an invented stamp.

The `/oe` slash command runs no model turn, so what it refuses is not a turn — it is the aliasing
itself: `/oe budget` reports this deployment's spend for the scope the invoker's principal key picks,
and `/oe budget raise|clear` posts a real approval card against it. An unadmitted workspace's command
gets an empty `200` and an audit row, and nothing is said back into that workspace. No door posts
anything back: we cannot safely identify anybody in an unadmitted workspace, and the audit row plus
the operator log line are the whole signal.

**A declaration names either rung, and the id shape says which.** A Slack workspace id is `T…` and an
Enterprise Grid organisation id is `E…`, so `slack/T…/<channel>` declares a workspace and
`slack/E…/<channel>` declares a Grid. The fence judges a delivery on whichever ids it carries:

- a delivery naming a **declared workspace** is admitted, whatever Grid it names;
- a delivery naming a **declared Grid** is admitted, including one that names no workspace at all —
  which is what an org-wide install's interactivity payload sends;
- a delivery naming an **undeclared** workspace and an undeclared Grid is refused;
- a delivery naming **neither** id proceeds to the next gate: the unmapped-channel guard is the
  tenant-*presence* check, and a blank tenant is not evidence of a foreign one.

🔴 **Declaring a Grid admits every workspace under it.** That is what an org-wide install means, and
it is the operator's decision to make: member ids are still issued per workspace, so two workspaces
of that organisation reaching this deployment is the same aliasing exposure
[`identity.allowMultiTenantPrincipals`](#agent-settings-behaviour-config-as-code) exists to name. The build cannot catch it — your config does not
say how many workspaces the organisation holds. Declare the workspace instead if you serve one.

The opt-out is the [`identity.allowMultiTenantPrincipals`](#agent-settings-behaviour-config-as-code)
setting (was `OE_ALLOW_MULTI_TENANT_PRINCIPALS=1` until OPE-2411). Declaring it serves two or more
workspaces of one tenant-scoped platform and accepts that their members share a principal-key
namespace.

### Identity directory sync ([pre-populating links from an IdP](../how-it-works/identity.md#pre-populating-links-from-an-idp-okta))

Off unless armed. The IdP is a **sync source, never a live dependency and never a merge
authority**: nothing on a request path calls it, everything it proposes lands as a `suggested`
link that changes nothing until a person confirms it in their own DM, and a deprovision is the
one thing applied eagerly. Unarmed, the daily schedule is a logged no-op and both control verbs
report "not wired". The sync's POLICY is settings since OPE-2411:
[`directory.oktaApps`](#agent-settings-behaviour-config-as-code) (was `OE_DIRECTORY_OKTA_APPS`),
[`directory.autoConfirm`](#agent-settings-behaviour-config-as-code) (was `OE_DIRECTORY_AUTOCONFIRM`),
[`directory.groupAllowlist`](#agent-settings-behaviour-config-as-code) (was
`OE_DIRECTORY_GROUP_ALLOWLIST`) and [`schedules.sweepOrgs`](#agent-settings-behaviour-config-as-code)
(was `OE_TIDY_ORGS`). The variables below say where the directory is.

| Var | Default | Meaning |
|---|---|---|
| `OE_DIRECTORY_PROVIDER` | unset (**off**) | Which directory adapter to arm. `okta` is the only one today; a typo leaves the plane off rather than half-arming it. |
| `OE_DIRECTORY_OKTA_ORG_URL` | — | Your Okta org URL, e.g. `https://acme.okta.com`. **Required** when the selector is armed (missing ⇒ fails loudly at boot). 🔴 **Must be `https://`** — every request carries the SSWS API token in an `authorization` header, so an `http://` value is refused at boot rather than putting an admin credential on the wire on every sync. There is no localhost exception. |
| `OE_DIRECTORY_OKTA_TOKEN_REF` | — | The credential **ref** for the Okta API token — resolved through a broker at call time, never read as a raw value by the adapter. **Required** when armed. |
| `OE_DIRECTORY_OKTA_TOKEN_BROKER` | `db` | Which [credential broker](../extending/credential-brokers.md) holds that ref (OPE-408 step 2 — re-stamped from `env`). `db` = the encrypted credential store, so the token need not be an env var at all (load it with `oe secret set <ref>`); `env` = the ref names an env var, opt back into it by setting this to `env`. |

### Webhook triggers

The per-hook secret itself is named by each hook's `secretRef` + `broker` (config-as-code,
above) — there is no single shared secret var for this surface, unlike `GITHUB_WEBHOOK_SECRET`,
and with `broker: "db"` a hook's secret need not be an env var at all.

Two ingress bounds on this surface are **code constants, with no env var and no setting**
(OPE-2411):

- **The body cap is 256 KiB** (262144 bytes) for `POST /webhooks/<id>`. An oversized delivery is
  rejected 413 before HMAC verification. It was `OE_WEBHOOK_MAX_BODY_BYTES`.
- **The skew window is 300 seconds** (5 minutes), the window Slack, Stripe and Discord all use. It
  was `OE_WEBHOOK_MAX_SKEW_SECONDS`. It applies to the schemes that sign a timestamp
  (`oe-standard-webhook` and `slack`). `github` and `notion` sign the body alone, so it does not
  apply to them. A delivery whose signed timestamp is further than this from local time is rejected
  **before** any HMAC is computed.

`loadWebhookSources` (optional, on the app config seam) narrows which sources a **chat-issued**
hook may name. Absent means every source this deployment can both authenticate (a registered
signature verifier) and route (a registered event normalizer) is available — usually just a
function of which provider bundles are selected. It is **narrowing-only**: listing a source with
no verifier adds nothing, because deliveries to it could never be authenticated.

### Control plane (remote admin auth)

The remote MCP control surface validates a bearer token, never issues one. **Fail-closed**:
with none of these set, every remote request is refused (401). The local stdio entry
(`npm run control`) needs no auth, but it does need to reach the deployment's own operational
store: it opens the store this env selects before it builds the server, names that store on its
ready line, and exits non-zero if it cannot open it. See
[The local stdio entry](../security/control-plane.md#the-local-stdio-entry--npm-run-control) and
[The control plane](../security/control-plane.md). Who may administer the deployment is policy, so
the GitHub user-login verifier and the role rules are the
[`control.githubAdmin`](#agent-settings-behaviour-config-as-code) and
[`control.adminRoleRules`](#agent-settings-behaviour-config-as-code) settings (they were
`OE_ADMIN_GITHUB` and `OE_ADMIN_ROLE_RULES` until OPE-2411).

| Var | Meaning |
|---|---|
| `OE_ADMIN_OIDC_ISSUER` | Generic OIDC issuer URL (Google / Auth0 / Okta / Entra / WorkOS). |
| `OE_ADMIN_OIDC_AUDIENCE` | Expected audience (your OAuth client id). |
| `OE_ADMIN_STATIC_TOKEN` | Single-operator self-host token (token == admin). |
| `OE_CONTROL_READ_TOKENS` | **Read-only service tokens** for machines (CI / the e2e harness): comma-separated `name:sha256hex` entries — the sha256 **hash** of each token, never the token itself (mint with `npm run mint:control-token -w @open-everywhere/core`). A matching bearer authenticates as `svc:<name>` with read views only (the write tools are structurally unregistered for it) and every call is audited. Also arms the deployment-mounted read routes — `GET /control/v1/usage`, `/audit`, `/unified-audit`, `/session/:id/transcript` and `/runtime-signal` (which answers both the OPE-658 roster-refresh signal and the OPE-641 credential-broker-armed signal) (**fail-closed**: unset → every one of them answers 404 to everything). Malformed entries are dropped fail-closed. See [Service tokens](../security/control-plane.md#service-tokens-read-only). **Read-only is literal:** this family does *not* open the test-wake injection route — that has its own `OE_CONTROL_INJECT_TOKENS` below, and neither family falls back to the other. |
| `OE_CONTROL_OAUTH_SIGNING_SECRET` | **The one env var of the control-plane OAuth 2.1 plane** — the HS256 key this deployment's own small authorization server signs access tokens and authorization codes with, and its resource server verifies them against. At least 32 characters; a shorter value is **ignored with a warning and the plane stays off** (never a weaker arm). **Fail-closed**: unset ⇒ `POST /control/v1/mcp`, both discovery documents, `/control/v1/oauth/authorize` and `/control/v1/oauth/token` all answer 404 — the seam is not disclosed. Everything else about the plane is **tracked config, not env**: the issuer (`CONTROL_OAUTH_ISSUER` — this deployment's public origin), the registered clients, their client-secret sha256 **digests**, their redirect URIs and any extra accepted token audiences all live in `packages/core/agent/control/oauth-clients.ts` and change by pull request. **Two things decide whether the routes exist** — this secret and a declared issuer — and a third, the client registry, decides whether anyone can obtain a token. The issuer and the registry both ship empty. With the secret and the issuer set and no client registered, the discovery documents are published and the mount answers 401, but neither grant can issue a token. The issuer is never read from the request's `Host` header: the token audience is `<CONTROL_OAUTH_ISSUER>/control/v1/mcp`, so the caller cannot name the audience its own token is bound to. There is **no refresh token and no per-token revocation list**: an access token lives 10 minutes, and rotating this value revokes every outstanding token at once. Disjoint from `OE_CONTROL_READ_TOKENS` and `OE_CONTROL_INJECT_TOKENS` — no family falls back to another. See [Control-plane MCP over HTTPS](../security/control-plane.md#control-plane-mcp-over-https-oauth-21). |
| `OE_CONTROL_INJECT_TOKENS` | **Wake-injection service tokens** — a family disjoint from `OE_CONTROL_READ_TOKENS`, in the same `name:sha256hex` hash-only format (mint with `npm run mint:control-token -w @open-everywhere/core -- <name> --inject`). The **only** credential that opens the spoofed-ingest route `POST /control/v1/test/wake`, which e2e packs and the eval harnesses use to feed a synthesised wake into a standing window. Injection transitively **writes** (the agent then acts and replies for real) and can mint a full-kit task seat, so it is deliberately not a read power: a read token presented to that route is refused with 401, and an injection token opens no read view or MCP mount. **Fail-closed**: unset → the route answers 404 to everything, regardless of the `wake.testWakeRoute` setting. See [Injection tokens](../security/control-plane.md#injection-tokens-the-test-wake-seam). |
| `OE_TRANSCRIPT_RELAY_SECRET` | Arms `read_routine_transcript` — the agent's own, same-channel replay of a past routine run ([Proactivity and routines](../capabilities/proactivity-and-routines.md#and-what-did-it-actually-do)). **Self-shared — mints on first use** (OPE-408 step 3): a session's durable event stream is reachable only from a route handler, never from the process a tool executes in, so the tool signs an HMAC request to the deployment's own internal relay route (which also needs a resolvable `OE_PUBLIC_BASE_URL`/`VERCEL_*` host); nothing outside this deployment ever holds the value, so there is nothing for an operator to set. Resolution order: the encrypted vault wins; this env var (if still set) is the announced-once on-ramp; neither ⇒ mints itself. A **third disjoint family** — not `OE_CONTROL_READ_TOKENS`, not `OE_SPAWN_DISPATCH_SECRET` (also self-shared and self-minting) — with no fallback in either direction, so arming the read never arms session-opening. **Fail-closed:** the vault unarmed (no `OE_CREDENTIAL_ENCRYPTION_KEY`) → the relay route 404s *and* the tool is simply absent (never present-and-refusing). |

### Notion memory backing

| Var | Default | Meaning |
|---|---|---|
| `OE_NOTION_SECRET_REF` | `db:notion:memory` | secretRef for the ORG-DEFAULT Notion memory token (OPE-408 step 2 — re-stamped from `NOTION_TOKEN`, an env var name). A domain that binds its own `memory` credential does **not** read through this ref — it resolves that credential's own `secretRef`/`broker` (see the `credentials` domain field). |
| `OE_NOTION_SECRET_BROKER` | `db` | Which [credential broker](../extending/credential-brokers.md) resolves `OE_NOTION_SECRET_REF` — `db` (the encrypted credential store; load it with `oe secret set db:notion:memory`) or `env` (the ref names an env var). Set alongside `OE_NOTION_SECRET_REF` to point the hot-cache backing at a plain env var instead. |

### Notion connector routes (backlog item 19 — the live 3-route test)

The `notion-connectors` bundle (`agent/access/bundles.ts`, bound to the test channel) grants
all three ways to reach Notion off ONE integration token, resolved through the `db` credential
store under the ref `db:notion:team-key` (the same ref `agent/access/connector-credentials.ts`'s
`"team-key"` credential declares — OPE-408 step 2, re-stamped from the env var `NOTION_API_KEY`):

| Ref | Meaning |
|---|---|
| `db:notion:team-key` | The Notion internal integration's token. Feeds route ① (the `notion-rest` egress connection's `secretRef`) AND route ③ (the `notion` connector's `"team-key"` credential) — one token, two planes. Route ② (the `notion-rest` skill) rides route ①'s same egress connection, so it needs no separate ref. Load it with `oe secret set db:notion:team-key`. |
| `db:notion:channel-key` | The **channel-plumbing** key (reply posting, the webhook two-step, the channel read tools) — a separate credential from `team-key` even if you store the same value under both (`agent/access/connector-credentials.ts`'s `channel-key`). Load it with `oe secret set db:notion:channel-key`. |
| `db:notion:memory` | The **memory backing** key (the read-only page-subtree projection) — the `agent/access/connector-credentials.ts` `memory` credential, and the ORG-DEFAULT role a domain's `credentials` binding replaces. Load it with `oe secret set db:notion:memory`. |

**These are DIFFERENT refs from `OE_NOTION_SECRET_REF`/`db:notion:memory` above** — that one
feeds the read-only memory hot-cache backing (a distinct concern: materializing a page subtree
to disk as context, not a live connector call). Point `OE_NOTION_SECRET_REF` at
`db:notion:team-key` too if you want ONE token to do everything; keep them separate if the
hot-cache should use a narrower, read-only-scoped integration than the connector routes' key.

**Broker note:** which broker resolves each ref is decided by the credential's `broker` stamp,
not by any global selection. The shipped `team-key`/`channel-key` credentials are stamped
`broker: "db"` — load their values with `oe secret set db:notion:team-key` /
`oe secret set db:notion:channel-key` (or the "Set API key" chat intake, which writes to the
same refs). To opt a self-hosted fork back onto a plain env var instead, re-stamp the credential
to `broker: "env"` with a `secretRef` naming the env var. See
[Credential brokers](../extending/credential-brokers.md).

### Surface credentials

Each surface reads its own credentials from env (or a broker). See the per-surface guides
([Slack](./surfaces/slack.md), [Teams](./surfaces/teams.md), [Discord](./surfaces/discord.md),
[Linear](./surfaces/linear.md)) for the full set —
e.g. `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET`, `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD`,
`DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY`, `LINEAR_ACCESS_TOKEN`.
Connection `secretRef`s resolve through whichever broker their credential is stamped with — the
shipped Notion connection is `db` (`db:notion:team-key`, OPE-408 step 2); a self-hosted fork's
own connections default to the `env` broker (a plain env var name) unless re-stamped.

A few more, per surface:

| Var | Default | Meaning |
|---|---|---|
| `TEAMS_APP_ID` | — | Teams: an alternate name for `MICROSOFT_APP_ID` — eve's own `verifyTeamsRequest` accepts either, and this codebase mirrors that fallback in its own presence checks. Set one or the other, not neither; `MICROSOFT_APP_PASSWORD` is required either way. |
| `OE_RELAY_SECRET` | unset (**fail closed, every delivery rejected**) | Discord: shared HMAC-SHA256 secret verifying `x-oe-relay-signature` on deliveries from the [Discord Gateway relay](../../deploy/discord-relay/README.md) — the small always-on process that holds the persistent Gateway WebSocket Discord requires for ambient messages/reactions (Discord never delivers those to an HTTP endpoint). Generate one value and set it on both the relay's own deployment and this one; unset here means every relay delivery is rejected as unverified — never a dev bypass, this is a real ingress. |

#### Linear token lifecycle (mint-on-demand)

Linear's client-credentials access token expires every 30 days. A deployment reading only a
static `LINEAR_ACCESS_TOKEN` (or its `LINEAR_AGENT_ACCESS_TOKEN` / `LINEAR_API_KEY` /
`LINEAR_API_TOKEN` siblings) goes silent on every renewal unless someone manually re-mints it —
so, for a durable production deploy, set `LINEAR_CLIENT_ID` + `LINEAR_CLIENT_SECRET` (the OAuth
application's client-credentials pair, from [the Linear setup runbook](./surfaces/linear.md) Step
1.4) instead, and OE mints + caches an `actor=app` access token itself
(`agent/channels/linear-credentials.ts`), refreshing ahead of expiry with a safety margin.

- **Precedence**: a static token (any of the four vars above) ALWAYS wins over the
  client-credentials pair when present — an existing deployment is byte-identical, and the mint
  path is never even attempted. Only a deployment with NONE of the static vars set, and BOTH
  `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` present, engages the mint. Neither family set → the
  same "missing Linear access token" error as before.
- **One token per workspace, every call site.** Every Linear API call in this codebase (Agent
  Activities, team-privacy/issue reads, `commentCreate` replies) resolves ONE token from the same
  env fallback chain — the minted token stands in for whichever static token would have served all
  of them; it does not introduce a second, differently-scoped credential. A deployment serving a
  second Linear workspace holds one such token per workspace — see below.
- **Single-flight, in-process.** Concurrent turns share one in-flight mint (no stampede on the
  token endpoint); this is an in-process memo + refresh margin, not a cross-process lock — the
  minted token is a disposable derived artifact any process can mint independently, unlike a
  shared stored secret (contrast the [credential broker](../extending/credential-brokers.md)'s
  cross-process row-claim).
- **Loud failure.** A mint failure (bad client id/secret, network error, malformed response) throws
  and appends a `linear.token_mint_failed` audit row (`GET /control/v1/audit?since=<iso>&actions=linear.token_mint_failed`) —
  a silent monthly death becomes a loud, queryable one.

#### A second Linear workspace

A Linear access token is **workspace-scoped**, and a Linear OAuth application is private to the
workspace that created it unless you make it public. So one deployment that serves two Linear
workspaces registers a second OAuth application, in that second workspace, and OE maps the Linear
**organization id** on each delivery to that application's own client pair and webhook secret.

Register a workspace with four variables. `<SLOT>` is any label you choose (`[A-Z0-9]+`); it names
nothing in the code, it only groups the four values:

| Var | Meaning |
|---|---|
| `LINEAR_APP_<SLOT>_ORG_ID` | The Linear organization id of the workspace this application is installed in. It is the `organizationId` on every webhook that workspace sends. |
| `LINEAR_APP_<SLOT>_CLIENT_ID` | That application's OAuth client id. |
| `LINEAR_APP_<SLOT>_CLIENT_SECRET` | That application's OAuth client secret. OE mints the `actor=app` token from this pair, exactly as it does for the primary application, and holds one warm token per workspace. |
| `LINEAR_APP_<SLOT>_WEBHOOK_SECRET` | That application's webhook signing secret. Inbound deliveries naming this organization are verified against **this** secret and no other. |

An entry missing its client id or client secret is dropped — a half-configured workspace never
looks configured.

| Var | Default | Meaning |
|---|---|---|
| `LINEAR_ORGANIZATION_ID` | unset | The **primary** application's own Linear organization id. Optional, and it changes one thing: what happens to a delivery from an organization OE has never heard of. Unset, the primary credentials are the catch-all and any unrecognised organization is served with them — the behaviour of every deployment before multi-workspace support. Set, the primary credentials serve only that one organization, and an unregistered stranger gets no token and no webhook secret, so its calls fail closed and its deliveries are refused. |

- **One secret per delivery, never a try-both loop.** Verification picks exactly one signing secret
  from the delivery's own `organizationId` and compares once. Trying every configured secret in turn
  would make each added workspace's secret a valid signing key for every other workspace's traffic.
- **The organization in the body is unauthenticated, and that is fine.** A forger chooses which
  secret we verify against, but still has to produce a valid HMAC under it. Naming another
  workspace only means forging that workspace's signature instead.
- **Replies post under the workspace they answer.** Every reply, reaction, progress activity and
  session close resolves the token registered for the workspace that sent the wake.
- **One read stays on the primary application: an inbound image.** A Linear-hosted image on the
  triggering comment is fetched inside the framework's own inbound path, which cannot name a
  workspace. On a second workspace the fetch fails and the framework drops the image from the turn.
  The comment text is unaffected and no reply path depends on it.
