# Webhook ingress

Every webhook **source** Open Everywhere can accept a delivery on is an **adapter**, and there are
only two kinds of adapter. Either **(a)** it defines a *vendor's* authentication scheme and payload
shape — GitHub and Notion today, and any Stripe-shaped vendor next — or **(b)** *we* define the
scheme and the payload shape and the caller implements them. Both are adapters, registered through
the same registries, with no special-casing anywhere. This page is the doctrine behind that split,
what decides whether a source can be set up from a conversation at all, and two worked recipes.

(The scope here is the hook ingress at `POST /webhooks/<id>` and the event plane behind it. A chat
platform's own event ingress — the Slack or Discord front door — is a different thing that produces
a conversation turn directly; [§2](#2-topology-how-many-hooks-and-where) says why that distinction
is a doctrine rather than an accident of history.)

If you only want to *use* a webhook — declare one in config, or ask the agent to connect a
system — start at [Proactivity & routines](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers).
This page is for the person writing the adapter, evaluating the security posture, or wiring a
sender they control.

> **Read [the adapter model](./adapter-model.md) first.** Webhook ingress follows its rules
> exactly, including the one that surprises people: core's own scheme (`oe-standard-webhook`)
> is not a privileged built-in, it is a registry entry like any other —
> the same argument the `env` credential broker makes.

## 1. The two categories

### (a) Vendor adapters — we receive someone else's contract

The vendor defines the signature scheme **and** the payload shape. The adapter ships a signature
verifier, an event normalizer and an event scope grant.
It lives in a [provider bundle](./provider-bundles.md#event-ingress-plane), so de-selecting the
bundle removes the source entirely rather than leaving half of it registered.

We are the *receiver* here. We do not get to choose the headers, the basestring, the timestamp
tolerance, whether there is a message id, or where in the body the interesting fields live. The
adapter's whole job is to translate all of that into the vendor-neutral event shape.

### (b) Contracts we define — the caller implements ours

For a system nobody has written an adapter for — your CI, a build box, an internal service — the
direction reverses. **We** publish the signing scheme and the payload envelope; the sender
implements both. That ships as an adapter too, through the same three registries, and it is the
`oe-standard-webhook` source described in [§7's recipe](#7-recipe-a-connect-a-sender-you-control).

### 🔴 The inversion, which is the load-bearing part

A **bare signature scheme can never have a normalizer**, and that refusal is structural rather
than a deferral. A signature scheme says how bytes were signed and nothing about what they *mean*,
so there is no payload shape to read: a normalizer for one would have to invent a shape. Core
shipped exactly such a scheme once (`oe-hmac`) and it was correctly excluded from the
mintable vocabulary for this reason for as long as it existed.

**The premise fails for (b), and only for (b), because for (b) we define the payload shape too.**
The sender implements *our* contract, so the normalizer is ours to write and it is trivial: it
reads four fields we published. That is what lets a generic sender be routed at all.

Two things follow, and they are easy to get backwards:

- This is a **source key of its own**, with its own verifier, its own envelope, its own normalizer
  and its own grant — a contract, not a signature scheme wearing a new name. A bare signature
  scheme registered alongside it authenticates and can never route. One such entry exists on
  purpose — Slack's verifier, registered so the gate's 401 names a scheme this deployment really
  can authenticate. It stays harmless because `declarableSourceVocabulary`
  (`packages/core/agent/webhooks/source-vocabulary.ts`) requires a normalizer, which is the
  mechanism that keeps the rule intact rather than an exception to it.
- The old idea that a generic sender could instead *declare* where in its own payload the event
  lived — an operator-supplied extraction path — was **dropped**. Defining the payload is strictly
  better: it needs no declaration, it cannot be declared wrongly, and it makes the scope path
  ours rather than the sender's (see [§3](#3-the-scope-invariant-stated-correctly)).

## 2. Topology: how many hooks, and where

**Instance-wide is the default wherever the events come from a vendor. Per-hook multiplicity is
for the contracts we define.** Two forces make that near-deterministic:

1. **The registration-paste asymmetry.** An instance-wide ingress costs one paste, ever. A
   per-routine ingress costs one paste *per routine*, into someone else's admin UI, by someone
   with admin rights there. And we cannot amortise it away: programmatic webhook registration is a
   strictly larger credential grant at every vendor that permits it, and at least one major vendor
   does not permit it at all.
2. **The normalizer is where the authorization model lives.** It produces the scope path, which is
   the only thing the read-grant check can evaluate. Choosing per-routine URLs to avoid writing a
   normalizer is not "routing without authorization" — with no normalizer the delivery normalises
   to nothing and is dropped before it is even de-duplicated. It is *no routing at all*.

**A correction to a claim that is easy to repeat:** this doctrine does **not** rest on vendors
only offering one webhook. Most offer many — thousands, in some cases. What is near-universal is
something else entirely: **many hooks, one shared secret**. See
[§5](#5-what-decides-whether-we-can-mint-a-sources-secret) for why that shape belongs on the config
plane rather than the conversational one.

### Work surfaces, not communication surfaces

The taxonomy that makes this *predictive* for an adapter nobody has written yet:

| Surface kind | Examples | What it needs |
|---|---|---|
| **Communication** | Slack, Discord, Teams | Channel wrap + identity binding. **No routable webhook source.** Its ingress already produces a chat turn — the agent is woken directly, so routing it through the event plane would give one message two wake paths with two authorization models. |
| **Work / dual** | GitHub, Linear, Notion | Everything above *if* it also carries conversation, **plus** the event-ingress plane: verifier, normalizer, scope grant, entity reads. Expect one instance-wide ingress; expect the vendor to mint the secret. |

That taxonomy tells you which contract you are writing before you open a new vendor's docs. Read
the "what it needs" column as the SHAPE to aim for, not as an invariant the tree enforces — two
shipped surfaces sit off it, both deliberately:

- **Slack registers a verifier and no other event-plane seam** (`packages/providers/slack/agent/register.ts`,
  `registerWebhookVerifier(slackWebhookVerifier)`). Its signing scheme is therefore in the gate's
  401 vocabulary, so an operator-declared hook can name it — but with no normalizer it stays out of
  the declarable set and can never route.
- **GitHub's normalizer and scope grant register from core**, not from its bundle
  (`packages/core/agent/routines/github-normalizer.ts` registers both at module load, for the
  reason its own header states). De-selecting the GitHub bundle therefore removes its verifier
  only. **Linear** is the mirror case: it registers a normalizer and a scope grant
  (`packages/providers/linear/agent/register.ts`) and no verifier, because its signature check is
  inline in its own front door (`linear-webhook-verify.ts`) rather than a registry entry.

Nothing enforces "all three or nothing". A source missing a normalizer is silently narrowed out of
the declarable set by `packages/core/agent/webhooks/source-vocabulary.ts`, so the gap surfaces as
"your source is not in the list", never as a registration error.

> **Known documentation gap:** [Surfaces](./surfaces.md) is written end-to-end for
> *communication* surfaces and presents that as *the* surface contract. The work-surface half is
> this page plus the [event-ingress plane table](./provider-bundles.md#event-ingress-plane).

## 3. The scope invariant, stated correctly

A normalizer emits a **scope path** — an ordered list of steps (`tenant`, `group`, `container`,
`entity`, `sub`) that says what the delivery is *about*. The read grant is evaluated over that
path. So the question "where may the path come from?" is a security question, and it has been
stated wrongly more than once. The rule is **not** "hook-constant, never payload-derived" — that
is an overgeneralisation, and a reader applying it would "fix" a correct normalizer. The rule is:

> **Scope may be derived from the payload only to the extent the verifier makes the sender
> authoritative over that namespace.**

Worked both ways:

- **GitHub.** The signature proves GitHub sent it, and GitHub *is* authoritative about which
  repository an event came from. So deriving the entire path from the body is **correct**, and the
  per-repo grant it produces is a real one.
- **A sender holding a secret we minted.** The signature proves possession of *that hook's key* and
  nothing else. The sender is authoritative over exactly one fact — **which hook this is** — and
  its authority over every external namespace is **zero**. So its path is built from the stored
  row, never the body: `container` is the hook's name, and nothing else is emitted at all.
- **A vendor whose secret you hand out per tenant — Notion.** This is the case that reads like the
  GitHub one and is not. The signature proves which *subscription* signed the bytes, and Notion
  mints one `verification_token` per subscription. A deployment that runs one subscription per
  domain has therefore distributed that key to one operator per domain, and any of them can sign a
  body naming another domain's workspace or page. The path is still payload-derived, because the
  vendor gives no alternative — but the ingress fences it before the routing plane, by asking
  whether the domain that owns the named surface is a domain the **signing integration** serves
  (`notionTriggerScopeVerdict`). Ask this question of any vendor whose signing key you distribute:
  *does the signature identify the vendor, or only one of its senders?*

  The same answer serves the **conversational** plane, which is a separate decision on the same
  delivery. A comment wakes a session on a surface key built from a workspace and a page. The page
  is established from a fetch under the verified credential, so it is authenticated; the workspace
  cannot be, because the vendor exposes no workspace id on any object. So the ingress fences the
  workspace instead of proving it: a domain the delivery reaches through a container `reach` entry
  must be one the signing integration serves (`notionDeliveryScopeVerdict`). A domain reached
  through a page **roster** entry is exempt, because a roster hit does not depend on the field
  under suspicion. The general shape: fence the derived value the sender controls, and leave the
  ones your own config or an authenticated lookup decided.

The scope path is a **routing** artefact — it is what a routine's scope selector matches. It is not
where a hook's read grant comes from; that is `readableBy`, below.

The design deliberately left an *optional* payload-derived narrowing available below `container`
for matching granularity, and the shipped (b) adapter **declines it**. That turns the invariant
from an argument into a structural property: the function that builds the path takes only the
delivery's declared row fields, so it cannot see a payload even in principle. What makes declining
safe is the one-way rule elsewhere in the event model — **a shorter path makes matching coarser,
never wrongly narrower** — so a sender could only ever make its own events match *fewer* routines.

## 4. The read grant

The shipped justification for the read-grant check is that **event-triggering is a latency
optimisation on an already-granted poll**: the trigger tells you nothing you could not have
learned by fetching, and the fetch is authorized by the same grant. That argument has three
load-bearing assumptions — there is a fetch, it is authorized by the same grant, and an ungated
poll of it already ships — and all three require Open Everywhere to hold a credential for the
source system.

**For a sender implementing our own contract, none of them have a referent.** There is no fetch,
no poll, and nothing the grant could already be granting. So a hook needs its own answer, and the
answer is a field on the hook:

> **`readableBy` is the whole confidentiality decision.** It lists the scopes whose surfaces may read
> this hook's events. It is **required**, has **no default**, and combines by **union**.

```ts
defineWebhook({
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  target: "slack/T0123ABCD/C0456EFGH",
  readableBy: [{ level: "domain", domain: "engineering" }],  // ← who may read its events
  instruction: "Summarise the deploy result for the channel.",
});
```

It takes the same `Scope` vocabulary your access bindings use
([access and scoping](../how-it-works/access-and-scoping.md)):

| entry | means |
|---|---|
| `{ level: "org" }` | **every domain in the org** — the widest grant expressible |
| `{ level: "tenant", tenant: "slack/T0123ABC" }` | every domain in one vendor tenant |
| `{ level: "domain", domain: "payments" }` | one named memory domain |
| `{ level: "surface", surface: "slack/T0123ABC/C0123ABC" }` | one container |

Several entries are a **union** — many domains may legitimately read one hook, which is the ordinary
case for a shared work system and the thing the previous single-owning-domain design could not
express. The shape is shared with access bundles; the **combining rule is not**. Bundles resolve
narrowest-wins; this is may-read-if-any-entry-matches, and there are no deny entries: a narrower
entry never revokes a broader one.

**What it refuses, concretely:** a routine in a domain the hook does not name cannot subscribe to it.
It is told so — a real refusal naming the partition — rather than the "no grant adapter registered"
every such event would get without a declared grant. A `principal` (DM) entry never grants at all: a
DM is a separate connector universe.

**What `readableBy` decides and what it does not.** It decides **who may read**. It does not decide
**what a routine acts on** — that is the routine's own filter, written by the person who cares.
Anything finer-grained than `readableBy` is **another webhook**, not a cleverer grant.

> 🔴 **`readableBy` is a routing boundary with a confidentiality floor. It is not isolation.**
> Ten teams that each want *different events* is a routing problem: one integration, one hook, ten
> routines with ten filters. Ten teams that must *not see each other's data* is an isolation problem,
> and the only real answer is separate integrations with separate credentials and separate hooks —
> enforced by the source system, where no bug of ours can cross it. One hook = one sensitivity tier.

**Two honest caveats, both worth knowing before you rely on it:**

- **A single-domain deployment collapses this to "always true" in effect.** Accepted — it collapses
  because there genuinely is one tenant, not because the check is missing, and it still refuses the
  second domain on the day one appears. An unconditional yes would not.
- **A `domain` entry's authority class is tied to domain membership staying deployer-owned.** Domain
  membership comes from static configuration in your repo, merged by pull request and validated at
  module load — the same authority class as a bundle binding. The loader behind it is documented as a
  swappable seam. If a dashboard ever lets a non-deployer edit domain membership, a `domain` grant
  silently weakens to whatever *that* dashboard's authorization is, with no test going red, because
  the shape of the check would not change. That is the assumption most likely to shift.

### There is no way to declare a hook nobody can read

A hook with an empty read grant would accept deliveries, authenticate them, answer `200`, and then
refuse every routine — forever, silently. That state used to be reachable by *omission*: a hook
created from a channel that belonged to no memory domain got an empty grant and nobody was told.
`readableBy` is required with no default and validated non-empty at config load, and creating a hook
from a channel in no domain is refused with a sentence explaining why. There is no path left that
produces a mute hook by omission — and a hook that is mute by *typo* (a grant naming a domain that
does not exist) is refused too, which is the next section.

### Declarations are checked for reachability, not just for shape

A declaration used to be validated for *syntax* and nothing else: a non-blank instruction, a
well-formed target, a well-formed grant. So a hook could name a memory domain nobody had declared,
pass validation, boot cleanly, authenticate deliveries, answer `200` — and refuse every routine,
forever, with no message anywhere. The same gap existed on the other side: arming a routine on a
source its own channel could not read **succeeded**, and the routine then simply never fired.

Both are the same missing question — *from where this will fire, with the authority it will have,
can its declared consequence actually happen?* — and it is now asked at declaration time, in three
strengths:

| verdict | example | what happens |
|---|---|---|
| **impossible** | the grant names a domain this deployment does not declare | **refused** — a boot-time error naming the domains that *do* exist |
| **unreachable** | the hook's own target channel is in a domain the grant does not name | **warned** — the declaration stands; the hook still fires its own instruction |
| **undecidable** | the domain registry is not loadable at that moment | **nothing is said** |

The third row is the important one. A check that cannot decide is **inert, never fail-closed** —
"we could not ask" must not become a refusal, because a diagnostic that takes a deployment down is
worse than the silence it replaced. Concretely: validation runs at module import, where the
app-config seam may not be armed yet, and a deployment mid-setup with no domains declared is a
legitimate state, not a defect.

`create_routine` calls the same check and — being a different caller with a different case — takes a
**stronger** answer from it: it refuses on *unreachable* too. A hook with an unreadable target still
does its declared job; a subscription that can never read the events it names does nothing at all.

> 🔴 **This is a diagnostic, not a second belt.** Fire-time enforcement remains the only boundary,
> and it must: a grant revoked *after* arming has to stop the fire, which no create-time check can
> see. Nothing here grants, widens, or is consulted at fire time — every verdict can only ever
> refuse *more* than fire time would. The point is not a stronger boundary; it is that the failure
> arrives as a sentence someone can act on rather than as permanent silence.

### The integrity boundary enforces itself — there is no ingress-time permission probe

A triggered fire acts with the **domain's** authority, and therefore the domain's outbound
credential. If a routine fires on an entity its own credential cannot read, the routine can do
nothing with it — enforced at the point of action, for free. Probing the source system at ingress
("can this domain read this page?") would check permission twice, once expensively and speculatively.
It is **not** a deferred feature; it is a dissolved idea. What remains is a thinner disclosure — a
granted domain learns the entity *exists* and whatever the event metadata says — and `readableBy` is
where that is bounded.

## 4b. Two shapes of hook, and they are not two ways to do one thing

There are two hook shapes, and `declare_webhook` proposes either. They differ in **what the ingress
is fused to**, not in how much ceremony you feel like doing:

| | emit-only | fused |
|---|---|---|
| what you pass | omit `target` and `instruction` together | pass both |
| what it makes | an ingress and nothing else | an ingress bound to one channel and one standing instruction |
| what decides consequences | `event` routines, each separately approved | the declaration itself — *and* `event` routines, which can subscribe as well |
| reach for it when | the consequences are unsettled, likely to change, or several | the consequence is one fixed thing in one fixed room |

Both are declared the same way and gated the same way: **a standing prompt aimed at a named channel
is reviewable intent, and reviewable intent belongs in a diff.** A fused hook's instruction runs
unattended, with the target channel's full existing access, on anyone's POST, indefinitely — nobody
should be able to arm one with a single tap. An emit-only hook decides nothing on its own, but its
ingress is just as durable and just as public, so it takes the same reviewed path.

> ⚠️ **There used to be a second, chat-created hook class**, minted from an approval card into the
> operational store, and this section was a two-column comparison against it. It is deleted. It
> existed to provide two things — the emit-only *shape*, and a secret that did not cost a redeploy —
> and both are now properties a declaration can carry: the shape is the optional pair above, and
> `broker: "db"` puts the secret in this deployment's vault, issued through `rotate_webhook`'s
> one-time link with nothing redeployed and no value in the diff.

What `declare_webhook` changes is only *who writes the file*. Ask for a hook and the agent opens a
PR adding the declaration; a human reviews and merges it; an operator sets the secret. Git stays the
source of truth, review happens where your org already reviews (branch protection, CODEOWNERS), and
nobody hand-edits config. **An unmerged PR declares nothing, and a merged one still authenticates
nobody until the secret exists** — the declaration carries a `secretRef` and a `broker`, never a
value, so the secret never touches a diff, a chat transcript or a log.

The diff itself is produced by a **deterministic codemod** from a frozen, validated declaration — the
same machinery, and the same promise, as the [access-request flow](../how-it-works/access-requests.md).
No model authors any part of it after the card is posted. The codemod only **adds**: re-declaring an
existing id with different settings is refused, because redirecting an already-authenticated sender
is an edit a human makes in the file, not something a chat request performs on their behalf.

## 4c. Posture: how much of the payload reaches the model

`readableBy` answers *who may read this hook's events*. **Posture answers a different question —
how much of an outside party's bytes reach the model at all** — and the two are independent: a hook
readable by one domain can still hand that domain the whole raw body, and a hook readable by every
domain in the org can still hand them nothing but the fact that it fired.

It is **one axis with three points**:

| posture | what enters the prompt | tainted? |
|---|---|---|
| `trigger-only` | nothing — a fixed line built only from the hook's own declared id | no |
| `projection` | only the fields named in `project` | **yes** |
| `content-bearing` | the entire raw body, as untrusted data | **yes** |

```ts
defineWebhook({
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  target: "slack/T0123ABCD/C0456EFGH",
  readableBy: [{ level: "domain", domain: "engineering" }],
  posture: "projection",
  project: ["status", "branch"],   // ← required for "projection", refused for the other two
  instruction: "Summarise the deploy result for the channel.",
});
```

**Omitting `posture` means `content-bearing`**, which is what every hook did before the field
existed — deliberately *not* a safe-by-default `trigger-only`, and the asymmetry has a reason: a
declaration is a reviewed diff, where an absent field is a fact about *when the file was written*,
not about what its author wanted. Defaulting those to `trigger-only` would silently stop every already-deployed hook from
seeing the payload it was written to read: no error, no log, a product that quietly does less.
`declare_webhook` makes posture a required, explicit choice instead, so nothing **new** is created
without someone deciding.

**What `projection` actually drops.** The fields come from the source's normalizer — the adapter
layer that already flattens a payload into matchable scalars — so a projection is expressed in the
vocabulary the adapter declares, and `declare_webhook` refuses a key that source cannot produce
rather than shipping a hook that renders nothing forever. **That check is decidable only sometimes,
and goes inert rather than refusing when it isn't:** a source whose normalizer declares its key space
**open** (`oe-standard-webhook`, whose fields are the *sender's* to choose) and a source with no
registered normalizer at all are both *undecidable*, not wrong, so no key is refused for them. Since
`oe-standard-webhook` is exactly the scheme you use for a sender you control, in practice the
projection key check bites for vendor adapters and not for your own. Beyond the un-named fields, a projection
also drops the **entity pointer**, so no hydration fetch happens: "only these fields" cannot survive
a refetch that pulls the whole object back in by another route.

**What it does not change.** Filters still see the *whole* field set and the *whole* scope path. A
filter evaluates to a boolean, and a boolean is not text — matching on a field never puts it in front
of the model — so narrowing the render deliberately does not narrow what a subscribed routine can
match on. A projection is a render-time narrowing, not a routing change.

> 🔴 **A projection bounds volume, not trust.** The values that survive are still an outside party's
> bytes — fewer of them, chosen by you, not sanitised. So a `projection` fire is **tainted** exactly
> as a `content-bearing` one is: anything the agent tries to persist off it asks a human first. Only
> `trigger-only`, where no payload byte reaches the prompt at all, is untainted.

**`trigger-only` stays absolute.** Adding a third posture did not soften the first: the ingress
derives at most one narrowing declaration from one posture value, and the normalizer applies
redaction *first* and returns — so a delivery that somehow carried both declarations is redacted and
projects nothing. A posture that exists to keep payloads away from humans cannot have a back door,
and "the projection ran anyway" is the back door a third posture could have opened.

**Both of a config hook's consequences take the same posture** — its own declared `target` +
`instruction` fire, *and* its emission into the event plane. A hook cannot be `trigger-only` where
it was declared and content-bearing in every room a routine subscribed from.

**`projection` needs a declared key list**, which is why it is the one posture that cannot be
chosen without also naming `project`. The keys are checked against what the source's normalizer can
actually produce, at propose time, where the registry is live — a projection over a field nothing
emits would otherwise render an empty block on every delivery forever, with no error anywhere.

## 4d. `authFloor`: how strongly a delivery must be authenticated

Posture decides how much of a delivery reaches the model. **`authFloor` decides how well the sender
had to prove who they were before any of it counted.** It is optional, and it is a *floor* — the
weakest acceptance this hook is willing to have.

| grade | what it means | which sources reach it |
| --- | --- | --- |
| `unverified` | no signature checked at all; the only proof is possession of the hook URL | reachable **only** through the local-dev hatch (`webhooks.allowUnverified`, `broker: "env"`, no resolvable key) |
| `signed` | a signature verified against a resolvable key, on a scheme that signs **no** timestamp | any source whose verifier declares `signedTimestamp: false` |
| `signed-fresh` | the above **plus** a scheme-covered timestamp inside an enforced skew window | any source whose verifier declares `signedTimestamp: true` |

```ts
{
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  authFloor: "signed-fresh",
  readableBy: [{ level: "domain", domain: "eng" }],
}
```

**Declared, never inferred — and that is the entire security argument.** A strength read off what a
delivery happens to *carry* would let the sender pick its own grade: present the weaker scheme's
header and the stronger checks evaporate. That is the same downgrade primitive the verifier registry
refuses for scheme selection, and it is why both inputs to the comparison are ours — this field, and
the registered verifier's own `signedTimestamp` declaration. A hook's floor is identical on every
delivery it will ever take, and no request can move it.

**A floor your source cannot reach refuses every delivery, immediately.** `authFloor: "signed-fresh"`
on a source whose scheme signs no timestamp is a 401 on the first delivery, naming the floor, the
scheme and the declaration that decided it. Fail closed: refused, never quietly downgraded to
whatever the source *could* manage. This is checked at delivery rather than at boot because it needs
the verifier registry, which is not armed when configuration is validated — the same ordering that
makes an unregistered `source` a delivery-time refusal.

**What declaring one actually buys.** Naming a source silently decides your replay posture today:
`source: "github"` means no signed timestamp, therefore no single-use replay defence, and nothing
anywhere tells you. `authFloor: "signed-fresh"` turns that silence into a refusal that names the
mismatch — so a hook written in the belief that it had replay defence cannot quietly not have it.

**Omitting `authFloor` means no floor**, which is what every hook did before the field existed. The
default is deliberately not the strict one: a floor of `signed` by default would silently kill the
local-dev hatch for every hook that had not opted out, and safety that arrives as an unannounced
outage is not safety. The lever for turning the hatch off is `webhooks.allowUnverified` itself.

**A hook that declares any floor above `unverified` cannot use the dev hatch.** The hatch is the one
path that accepts with nothing checked, so it is the only place a delivery could come in under a
declared floor — and it is refused there rather than accepted-and-stamped.

**Two things are deliberately *not* on the ladder.** `keyKind`/`keyOrigin` say who *chooses* the key,
not how well a delivery was authenticated — a vendor-issued key is not weaker than one we minted, and
an asymmetric scheme is arguably stronger. And a rotation-overlap acceptance (an old-but-still-valid
key) is key *currency*, orthogonal to scheme strength, and the one fact here the **sender** picks: a
floor that moved with it would be inferred from the delivery. Both stay audited; neither is a rung.

## 5. What decides whether we can mint a source's secret

One question, answered in one place: **can this scheme authenticate a secret we generated?** It is
read off the verifier's own `keyKind` + `keyOrigin` declaration, and it is the whole of the rule.

- `keyOrigin: "receiver-minted"` + `keyKind: "shared-secret"` ⇒ a hook on this source can hold a
  secret this deployment issues. Declare it `broker: "db"`, and after the PR merges a human approves
  a card, the secret is minted host-side at the click, and the person who ASKED for the rotation gets
  a one-time link to read it.
- Anything else — a key the **vendor** generates, or an asymmetric scheme with no shared secret at
  all — cannot. A hook on such a source names an `env` ref (or another broker) and an operator sets
  the value from whatever the vendor gave them. Minting one here would produce a hook that is
  approved, revealed, and then **401s forever**, so the vocabulary refuses it rather than delivery
  time doing so.

The mintable vocabulary is therefore *(registered verifiers that accept a minted key) ∩ (registered
normalizers)*, narrowed by the operator's optional `loadWebhookSources` list. It is **measured**
against the live registries and is never written down anywhere — including here. The refusal copy a
caller sees names the measured set, so the error message *is* the vocabulary.

> ⚠️ This rule used to decide something stronger: whether a source could be **created** from chat at
> all. Hook creation left chat entirely (see §4b), so what it gates now is narrower and sharper —
> not *may this exist*, but *may we be the one holding the key*.

### The other vocabulary: what may be *declared*

*May this exist* is a different question with a different answer, and there is a second measured set
for it: **declarable** = *(registered verifiers) ∩ (registered normalizers)*, narrowed by the same
operator list. No key-family condition — a vendor-issued or asymmetric source is perfectly
declarable, it simply names an `env` ref whose value an operator sets.

**Mintable ⊆ declarable, always**, and that containment is the whole safety argument: the two sets
come from one derivation with one flag, and the wider one waives *only* the key-family condition. A
source missing a verifier, or missing a normalizer, is absent from both — those are the conditions
whose absence is silent and permanent (a 401 forever, or a hook nothing can subscribe to), and
neither is waived anywhere.

`declare_webhook` asks them in that order: **declarable** for the `source`, then **mintable** only if
you asked for `secretHome: "db"`. Ask for `db` on a vendor-issued source and the refusal names the
one field that would work rather than sending you away:

> I can declare a "notion" webhook, but not with `secretHome: "db"`. […] Ask me again with
> `secretHome: "env"` and this works: the declaration names the variable `OE_WEBHOOK_NOTION_SECRET`,
> an operator puts the value "notion" gave them into it and redeploys, and the hook authenticates.

> ⚠️ **This was a real bug, not a hypothetical.** The mintability rule was applied to *every*
> declaration regardless of broker, so a vendor hook was refused with copy saying "an operator has to
> declare the hook in configuration instead" — which is exactly what `declare_webhook` does. The
> refusal pointed at the tool the requester was already using, and the one parameter that would have
> worked was never mentioned. The prose above had described the corrected rule since §4b landed; the
> code was the half that never followed.

### What the 20-vendor survey found

Doc-cited across twenty work systems. The headline is not the count:

- **Only 3 of 20 let the caller supply the secret** — GitHub, Bitbucket, Jira *system* webhooks.
  Fifteen mint it themselves with no caller path; two are partial.
- **🔴 The correlation is the finding.** Every system that lets you supply a secret signs the
  **body only**, with no timestamp and no nonce (3 of 3). Every system with a signed timestamp and
  a tolerance window **mints the secret itself** (6 of 6). One vendor is the smoking gun for
  direction of travel: its old user-entered token was a plaintext header with no signature at all,
  and when it added real HMAC signing it made the new token vendor-generated and shown once.
- **Who owns the hook identity predicts the rest.** A resource-scoped hook created by a resource
  admin *can* be caller-supplied. An app-scoped hook's secret *is* the app credential and is
  necessarily vendor-issued — one secret shared across every subscription, which is exactly the
  shape no runtime lifecycle verb can safely touch, because rotating or revoking one hook would
  re-key all the others. A vendor-minted per-endpoint secret is the modern default. One product
  sits in both buckets simultaneously, split exactly along that line.

So **chat-minting a signing secret is not a GitHub-shaped design so much as an old-webhook-shaped
one.** Build for vendor-issued as the general case, and route it through config.

### 🔴 A vocabulary that was built, shipped and deleted — recorded so it is not rebuilt

A six-axis provisioning vocabulary once lived here (`acquisition` · `cardinality` · `setup` ·
`liveness` · `revocationStatus` · `remediation`), with an adapter-supplied setup handler, two
host-served setup pages, and an ingress arm that accepted a signing key from an **unauthenticated
body** inside an operator-opened window. Every axis value was anchored to a named vendor in the
survey above and a test enforced that anchoring.

It was still wrong, and the reason is worth more than the vocabulary was:

- **The anchoring was real; the vendors were Asana, Shopify, Intercom and Stripe** — none of which
  this project supports. The gate proved the survey was internally coherent. It proved nothing about
  whether *we* needed the axes.
- **Three of the six axes had no reader at all.** Two of the remaining three were read only by code
  no route could reach: nothing in the tree ever put a hook into the status the setup arm required,
  and no source ever declared the acquisition arm the setup pages were offered for.
- **The unauthenticated arm ran on every unresolved delivery** and was fail-closed *only* because
  that status had no writer. A safety property held by the absence of a writer is one bug away from
  not holding.

If a vendor-issued arm is wanted again, re-derive the **flow** — what a human does, in what order,
inside what window — and build only the axes that flow reads. Do not restore a vocabulary because it
was carefully argued; it was, and it was still unreachable.

## 6. The lifecycle of a declared hook

A hook has no status field and no state machine, and that is the whole of this section. It exists
because a pull request declaring it was merged, and it stops existing because another one removed
it. There is nothing in between for a deployment to get stuck in.

| Act | Who does it | What changes |
|---|---|---|
| **Declare** | a merged PR (`declare_webhook` opens it) | the hook exists and the endpoint stops 404ing |
| **Issue / rotate its secret** | an approval card, member tier (`rotate_webhook`) | the hook can authenticate, or authenticates against a new key |
| **Remove** | another merged PR | the hook stops existing and the endpoint 404s again |

> ⚠️ **It used to be a two-state machine on a stored row** — `active` / `revoked`, with a retained
> row keeping a dead endpoint dead and a name retired. That was the chat-created class, and it is
> deleted. Everything the retained row bought is now free: an id nobody declares simply is not a
> hook, and re-declaring one is a reviewed diff rather than a race between two clicks.

### Issuing and rotating the secret

**`rotate_webhook`** mints a fresh secret for a `broker: "db"` hook, stores it encrypted, and hands
over a one-time link to read it. The same verb does both jobs — a hook that has never had a value
gets its first one, and a hook that has gets a replacement — because they are the same act and
splitting them would be two cards saying the same sentence.

There is deliberately no way to re-show an existing secret: issuing a new one *is* the recovery. A
re-reveal would make every hook a standing disclosure oracle, and in the audit log it is
indistinguishable from an attacker extracting a live production secret.

**Whether the old key keeps working is the declaration's choice.** A hook whose `secretRef` lists a
second ref has a rotation overlap: the outgoing value is copied there before the current one is
overwritten, and both verify until a PR removes the entry. A hook with one ref has no overlap and
the outcome line says so, rather than promising a grace period it cannot honour.

**It refuses any other broker, by name.** An `env`-homed hook's value is set outside this deployment;
minting one here would store a secret nothing resolves. The refusal names the variable an operator
must set and the one-line config change (`broker: "db"`) that would make the hook rotatable from
here in future.

**And it refuses a source whose key the vendor issues, by name.** `broker: "db"` says the value lives
*here*; it does not say we get to *choose* it. A hook declaring a vendor-issued source (see
[§5](#5-what-decides-whether-we-can-mint-a-sources-secret)) would be minted a value that source has
never seen, so the secret would be revealed once and then every delivery would 401 forever. Nothing is
written; the refusal names the declaration change (`broker: "env"`, plus the variable an operator
sets) that makes the hook work. `declare_webhook` will not author that pairing, but a hand-written
hook in a merged PR can — which is why the check is at the mint and not only in the
vocabulary.

**One shared key across many hooks is guarded, not assumed.** Before every write, rotation checks
whether any **other declaration** names the same ref. A `secretRef` is an indirection, so N hooks
pointing at one ref is representable — the shape a vendor that signs every subscription with one app
credential would take — and re-minting it would silently break the others. A shared ref is refused
by name, saying which hooks would have broken, and nothing is written.

> ⚠️ **There is no `revoke_webhook`.** Removing a hook is removing its declaration, which is a PR.
> That is a deliberate consequence of hooks being config: a runtime verb that made an endpoint
> disagree with the merged file would put the repo and the deployment out of step with nothing to
> reconcile them. If a secret leaked and the integration must survive, **rotate**; if the integration
> must die, open the PR.

Every crossing writes an audit row: `webhook.rotated` and `webhook.secret_revealed`, plus
`webhook.declined` and throttled `webhook.rejected` on the delivery path. Audit appends are
best-effort by contract and never throw, so "every secret crossing leaves exactly one row" is a
property of the code path — necessary but not sufficient as a guarantee about the log.

### Status: what is reachable today

Being precise, because this section has previously described arms that no route could reach:

- **A conversation can PROPOSE any hook and ISSUE a secret for a `broker: "db"` one. It cannot
  create or remove a hook.** Both of those are merged pull requests.
- **A vendor-issued key is an `env` (or other broker) ref an operator sets.** There is no path here
  that mints one, because there is nothing we could mint that the vendor would accept. The hook
  itself is proposed the same way as any other — `declare_webhook` with the default
  `secretHome: "env"`. Two refusals hold that line, and both are needed: `declare_webhook` will not
  *author* `secretHome: "db"` for such a source, and `rotate_webhook` will not *mint* for one even
  when a hand-written declaration asks it to.
- **Reopening an unauthenticated window on a live hook is not built and is not a roadmap item at
  member tier.** A card whose consequences the clicker cannot reasonably model is not a meaningful
  approval, however well-bounded the risk.

## 7. Recipe A: connect a sender you control

The end-to-end path for a CI job, a build box, a cron script — anything that can run `openssl` and
`curl`. Nothing needs to be merged; no adapter is written.

**Step 1 — ask.** In Slack, ask the agent to set up a webhook. It calls `declare_webhook` with
`source: "oe-standard-webhook"` and `secretHome: "db"`:

- **`id`** is the *handle* — a short lowercase token (`my-ci`, `deploy-bot`), the path segment of
  `POST /webhooks/<id>`, and the same string a routine subscribes to. Several senders can share the
  contract under different ids; their deliveries never fire each other's routines.
- **`source`** is the *contract* — the registry key that decides which verifier, normalizer and
  grant handle the hook. For a vendor, name the vendor instead.
- **`secretHome: "db"`** means the value lives here and is issued in Step 2. Leave it off and the
  hook waits on an operator setting an environment variable and redeploying.
- **`posture`** is `trigger-only` (the payload is discarded), `projection` (only the fields you name
  in `project`) or `content-bearing` (the whole payload enters the prompt as untrusted data on every
  delivery, forever). Ask for the narrowest one that lets the job work; see
  [posture](#4c-posture-how-much-of-the-payload-reaches-the-model) above.
- **`readableBy`** is **required and has no default** — an array of memory domain **names**
  (`["support"]`), naming whose routines may read this hook's events. `["*"]` means every domain in
  the org, and the tool's own description says to state that out loud before using it. Note the
  shape: the tool takes plain names, where the `readableBy` field in
  [§4, the read grant](#4-the-read-grant) takes `Scope` objects — so the `tenant` and `surface`
  levels that field documents are not reachable from this tool. Omitting it is an invalid call.
- **`target` + `instruction`** are optional and travel together — pass both for a fused hook, or
  neither for an emit-only one whose consequences Step 5 decides.

`declare_webhook` does **not** offer
[`authFloor`](#4d-authfloor-how-strongly-a-delivery-must-be-authenticated). It is a field on the
declaration, so add it in the diff — either by editing the PR this step opens, or in a later one.
It is enforced identically however the declaration got there.

A card is posted, a member reads it and approves, and the agent opens a **pull request** adding the
declaration. Nothing exists until a human merges it.

**Step 2 — get the secret.** Once the PR is merged, ask the agent to rotate the `my-ci` webhook.
Another card is posted; a member approves; and only then does the deployment mint the signing
secret. **The person who asked** receives a **private, one-time link** to read it — not the approver,
who sees only the decision. Approval is fungible across the admins of a room; custody of a live
signing key is not. The link is shown on one page, once,
expiring in fifteen minutes. Nothing can display it again, because a mechanism that could would be
indistinguishable in the audit log from an attacker extracting a live production secret. If it is
lost, issue another one. No redeploy is involved at any point.

**Step 3 — sign and send.** The scheme is
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks), adopted whole:

```
webhook-id:         <opaque message id>
webhook-timestamp:  <unix seconds>
webhook-signature:  v1,<base64 sig>          # space-delimited list; extra entries allowed

signed content = "<webhook-id>.<webhook-timestamp>.<raw body>"
signature      = base64( HMAC-SHA256(secret, signed content) )
```

```sh
URL='https://<your deployment>/webhooks/my-ci'    # the id you declared
SECRET='whsec_...'                                # from the one-time link

BODY='{"event":"build","action":"failed","fields":{"status":"failed","branch":"main"}}'
ID=$(uuidgen); TS=$(date +%s)
KEY=$(printf '%s' "${SECRET#whsec_}" | base64 -d | od -An -tx1 | tr -d ' \n')
SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -binary | base64)
curl -X POST "$URL" -H "webhook-id: $ID" -H "webhook-timestamp: $TS" \
     -H "webhook-signature: v1,$SIG" -H 'content-type: application/json' -d "$BODY"
```

The details that actually bite:

- **The key is the decoded secret, not the string.** The spec describes the secret as base64
  prefixed with `whsec_`, and reference libraries base64-decode it unconditionally. Open Everywhere
  mints exactly that form — `whsec_` followed by 44 base64 characters — so an off-the-shelf
  Standard Webhooks *client library* takes the value verbatim and works. If you sign by hand, you
  must **strip the prefix and base64-decode** before the HMAC, which is what the `KEY=` line above
  does; passing the whole string to `openssl dgst -hmac` signs the wrong bytes and every delivery
  401s for no stated reason.
  The rule is prefix-discriminated rather than unconditional: a secret starting `whsec_` is decoded
  per the spec, and anything else is used as **raw UTF-8 bytes**. That second branch exists so
  secrets minted before this format still verify without a forced rotation. It is *not* a
  "try both" fallback — each secret takes exactly one branch, decided by its own first six
  characters — because trying both would be a downgrade primitive.
- **The timestamp is signed and skew-checked.** More than **300 seconds** from ours and the delivery
  is rejected before any HMAC is computed. The window is a code constant (OPE-2411). The header's bytes are signed **verbatim** — `" 123 "` is malformed, not
  silently trimmed.
- **The message id is a real nonce.** It is covered by the signature, so re-presenting a delivery
  inside the skew window is refused **409** — durable, cross-instance, keyed per hook. This is the
  first source you can **propose** from a conversation that is genuinely replay-defended rather than
  merely de-duplicated. Proposing is as far as a conversation goes: `declare_webhook` opens a pull
  request, and the hook exists once that lands
  (see [§6, the lifecycle of a declared hook](#6-the-lifecycle-of-a-declared-hook)). Ids must match `[A-Za-z0-9][A-Za-z0-9_.+=-]{0,127}` — notably **no colons**,
  which is what keeps two hooks' deliveries from ever colliding in one dedupe key. `uuidgen` output
  is fine.
- **Verification runs on the exact bytes received.** A reserialised JSON body produces different
  bytes and fails. Bodies over **256 KiB** are rejected before hashing (a code constant).
- **Several signatures may be presented at once**, space-delimited, so a sender mid-rotation can
  offer old and new. Entries tagged with a version we do not know are skipped, not refused.

**Step 4 — the envelope.** Four fields, one required:

| Field | Required | What it is |
|---|---|---|
| `event` | ✅ | The event name, verbatim — `build`, `deploy`, `alert`. What a filter keys on first. |
| `action` | | The sub-kind — `failed`, `succeeded`. |
| `fields` | | A **flat** bag of matchable scalars. Strings, numbers and booleans are kept (numbers and booleans coerced to strings); objects and arrays are **dropped** rather than stringified, because matching `"[object Object]"` against itself means nothing. Capped at **16 keys** over the merged map. |
| `occurredAt` | | ISO-8601, per the sender — deliberately distinct from our receive time, kept verbatim if it parses and dropped if it does not. |

**Unknown fields are ignored, never rejected**, so a sender can grow its payload without breaking
against a receiver nobody redeployed. There is no nesting and that is not an oversight: the moment
a filter can name a path, the match language becomes a payload-traversal language. `event` and
`action` are reserved and cannot be shadowed from inside `fields`.

**Step 5 — say what should happen.** An emit-only hook is an **ingress and nothing else** — no
target, no instruction. Follow it with `create_routine` using an event trigger on the **id** you
chose, filtering on `event`, `action`, or any key your sender put in `fields`. Several routines can
subscribe to one hook, each with its own filter and its own room, and you can add, change and remove
them without touching the ingress — which is the reason to prefer emit-only when the consequences
are not settled. Use `list_webhooks` to see what is declared.

## 8. Recipe B: what an adapter for a vendor has to bring

If the sender is a vendor, you are writing category (a). Bring all three items below: one third of
the checklist produces a hook that authenticates and can never route, or one that routes and is
refused for want of a grant. 🔴 **Nothing enforces this — it is the shape to aim for, not an
invariant.** A source missing a normalizer is narrowed out of the declarable vocabulary in silence
(`packages/core/agent/webhooks/source-vocabulary.ts`), so the miss reaches you as "your source is
not in the list" rather than as a registration error. Two shipped surfaces are deliberately partial;
[§2](#work-surfaces-not-communication-surfaces) says which and why.

1. **A signature verifier**, keyed on the scheme, declaring `keyKind`, `keyOrigin` and
   `signedTimestamp` honestly. `signedTimestamp` is not documentation: it decides whether the
   single-use replay bound engages at all.
2. **An event normalizer** producing the scope path and the matchable `fields`. Flattening the
   payload well is the whole job: a routine's filter is a
   [jq expression](../capabilities/proactivity-and-routines.md#event-filters-are-jq) over what you
   surface, so fields people will actually filter on should be reachable without path gymnastics.
   `matchKeys` names them (it feeds the tool description and the create-time probe), and
   `scopeKeys` / `scopeKinds` are what the mandatory-narrowing refusal reads. Declare
   `deliveryIdHeader` if the vendor publishes one — that is what arms the TTL-bounded delivery
   dedupe.
3. **An event scope grant** over the step your vendor's own permission model is expressed at. If the
   credential you actually hold cannot express anything narrower than the whole tenant, **say so**
   rather than returning true.

All three are exported from the [adapter-api barrel](./adapter-model.md#import-the-ports-from-one-door-the-adapter-api-barrel),
and a bundle that registers all three from its own `agent/register.ts` contributes none of them
when it is de-selected. Two shipped surfaces do not follow that shape, so check before you assume
de-selection removes a source whole: Linear registers its normalizer and scope grant but verifies
inline rather than through the registry, and GitHub's normalizer and scope grant register from
core (`packages/core/agent/routines/github-normalizer.ts`) rather than from its bundle. The full
seam table is in [Provider bundles](./provider-bundles.md#event-ingress-plane).

## 9. The delivery gate, in order

`gateWebhookDelivery` (`packages/core/agent/webhooks/gate.ts`) decides every inbound delivery. It
refuses in a fixed, **fail-closed** order, and each rung is cheaper than the one after it:

| Order | Condition | Status |
| --- | --- | --- |
| 1 | The hook id names no declared hook. | `404` |
| 2 | The body exceeds the route's byte cap. | `413` |
| 3 | No verifier is registered for the hook's scheme. | `401` |
| 4 | The hook's `authFloor` is above what its scheme can ever reach. | `401` |
| 5 | No signing key resolves (and the local-dev hatch does not apply). | `401` |
| 6 | The verifier rejects the signature, or throws. | `401` |

Rung 3 refuses rather than borrowing another source's scheme: authenticating with a scheme the hook
did not declare would be the wrong question asked correctly.

**The local-dev unverified hatch is narrow.** `acceptedUnverified` reports a delivery that passed with
no key at all, and the gate offers that path **only** when the deployment sets
`webhooks.allowUnverified` **and** the hook's broker is `env` **and** no key resolved. A hook whose
secret lives in any other broker is never offered the hatch — its refusal copy points at
`rotate_webhook` instead. A hook that declares an `authFloor` above `unverified` is refused even on the
hatch, because accepting there would downgrade its own declared floor.

**A hook whose `authFloor` exceeds its scheme's ceiling refuses every delivery forever.**
`meetsWebhookAuthFloor` (`webhooks/verifier.ts`) compares the two grades on one ordered ladder. The
gate states that outright rather than accepting anything below the floor, and names the two fixes:
lower the floor, or declare a source whose scheme signs a timestamp.

**An unresolvable current secret discards the rotation keys too.** `resolveHookKeys`
(`webhooks/secrets.ts`) treats `secretRef[0]` as the current key: when it throws or resolves empty,
the function returns an **empty** list at once, so every previous rotation key is dropped with it and
deliveries 401. A *previous* ref that fails is different — the rotation is treated as complete and the
remaining keys stand.

### The Standard Webhooks verifier

`standardWebhookVerifier` (`webhooks/oe-standard-webhook.ts`) checks in this order: the signature
header must be present, the message id must be present and well-formed, the timestamp must be present
and digits-only, and **the skew is checked before any HMAC is computed** — 300 seconds, a code
constant. Only then does it hash.

The signature header may carry **several space-separated values**, which is how a sender rotates a
key. The verifier keeps the `v1,` tagged ones and accepts a delivery when **any** presented `v1`
signature matches **any** configured key, comparing in constant time. It answers the matching key's
index, plus the replay key derived from the message id.

**A minted secret is `whsec_` followed by 33 random bytes, base64-encoded** with no padding
(`mintStandardWebhookSecret`). Thirty-three bytes divide evenly into four-character base64 groups, so
the encoding carries no `=`.

### Replay refusal

**A replay nonce is retained for two skew widths plus 60 seconds** — 660 seconds at the default skew
(`webhookReplayNonceTtlMs`, `webhooks/replay-dedupe.ts`). That covers the whole span in which a
captured delivery would still pass the skew check.

**Nonces are namespaced per hook id** (`webhookReplayStoreKey` writes
`webhook-replay:<hookId>:<replayKey>`), so two hooks that share a secret can never collide on one
message id.

`firstSightingOfWebhookDelivery` refuses a validly-signed delivery seen before inside that window. **A
store error fails open** and admits the delivery, with one process-level warning: an availability blip
must never silence a genuine delivery.

**The caller learns nothing.** The response body is the constant `delivery refused`
(`REPLAYED_DELIVERY_CALLER_BODY`); the full reason goes only to the audit row, so the refusal is no
oracle for whoever is replaying.

**Rejection rows are throttled to one per hook and status per 60 seconds**
(`REJECTION_WINDOW_MS`, `webhooks/reject-audit.ts`), and a caller-supplied hook id is truncated to
**100 characters** in `detail` (`REJECTION_ID_MAX_CHARS`) — the input is hostile and unbounded, so the
row must stay bounded.

## 10. What a fire may disclose, store and spend

**A projection hook with an empty key list withholds the payload.** `configHookDisclosure`
(`webhooks/config.ts`) answers `redactPayload` for a `trigger-only` hook, and for a `projection` hook
that names no keys — it does **not** widen to the raw body. Only a `content-bearing` hook discloses
everything.

**A webhook fire is spend-capped with no admin bypass.** `fireWebhook` (`webhooks/dispatch.ts`) runs
the same budget gate as the routine dispatcher, and every mode is capped — the earlier DM exemption
was removed. The bypass path is consulted only by the attended ingress gates, so a fire that no human
asked for gets no escape.

**A capture window defaults to 15 minutes and is clamped between 1 second and 60 minutes**
(`captureDeadline`, `webhooks/capture-window.ts`). A non-finite request falls back to the default.
Arming a capture on a `trigger-only` hook is refused outright, because it would be a storage back door
around that posture's own guarantee.

**A redacted event is never stored, and an oversized document is dropped rather than truncated.**
`captureDocument` answers `undefined` for a redacted event, and again when the serialised document
exceeds **16,384 characters** (`CAPTURE_DOCUMENT_MAX_CHARS`). A truncated capture would be a document
nobody could trust.

**A webhook-secret reveal link lives 15 minutes and is single-use** (`REVEAL_GRANT_TTL_MS`,
`webhooks/reveal-page.ts`). The **POST** consumes the grant, and it consumes before it reads the
vault. The **GET** writes nothing: it renders a confirm page that carries no secret. GET stays inert
because link scanners and mail gateways fetch a URL the moment it appears anywhere — a consume-on-GET
link is burned before the human clicks it. The page fails closed with no oracle: a bad, expired,
tampered or already-consumed token all answer the same way.

**A captured handshake secret is logged only as a fingerprint** — the first **8** hexadecimal
characters of its SHA-256 (`secretFingerprint`, `webhooks/handshake-capture.ts`). The value itself
never reaches a log line.

**An emit-only hook's read-grant reach is inert, never a refusal.** `webhookReach`
(`webhooks/achievability.ts`) reports that a hook declaring no target has no room whose ability to
read its events could be checked. Such a hook's consequences live in `event` routines, anywhere its
grant reaches, so calling the absent room a failure would be a false negative.

---

**See also:** [Proactivity & routines](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers)
for the user-facing view and the config-declared hook · [Provider bundles](./provider-bundles.md)
for the seam tables · [Access & scoping](../how-it-works/access-and-scoping.md) for what a domain
grant actually is · [Audit & provenance](../security/audit-and-provenance.md) for the rows above.
