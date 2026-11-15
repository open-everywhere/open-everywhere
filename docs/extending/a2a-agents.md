# A2A agents — delegating to another organisation's agent, and taking its calls

Open Everywhere is the chief of staff. It does not try to hold every system's tools itself. When a
task belongs to a focused enterprise agent — an Agentforce, ServiceNow, Workday or Copilot Studio
agent — it hands that agent the task and brings the answer back to the thread that asked. The door
to those agents is **A2A**, the Agent2Agent protocol, a Linux Foundation project. This page covers
both halves. The outbound half: how a deployment declares an agent, and what happens when the agent
delegates. The [inbound half](#inbound-another-agent-calls-this-one): how another organisation's
agent calls this one, which ships dark.

## MCP and A2A side by side

The two protocols answer different questions, and a deployment can use both.

| | [MCP](./connectors.md) | A2A |
|---|---|---|
| What it gives the agent | **Tools and data**: one vendor operation per call | **Other agents**: a whole task in plain language, worked on by the remote agent |
| Who decides how the work is done | Open Everywhere's own model, one operation at a time | The remote agent, inside its own system |
| How long one call runs | One request and its response | A task, which can run for minutes and report its state while it runs |
| Where it is declared | `agent/access/mcp-servers.ts` | `agent/access/a2a-agents.ts` |
| Whose identity it carries | The grant's credential: a person's own account in a DM, or the org's account in a channel | The deployment's credential for the agent, plus the asker's identity in the message metadata |
| Its tools | `connection_search`, `connection_execute` | `delegate_to_agent`, `check_agent_task` |

Pick MCP when you want the agent to operate a system step by step. Pick A2A when the system already
has its own agent and you want that agent to own the task.

## Declare an agent in your app

An admin declares each agent in one reviewed file, by pull request:

```ts
// agent/access/a2a-agents.ts
import { defineA2aAgents } from "@open-everywhere/core/agent/a2a/agents.js";

export const A2A_AGENTS = defineA2aAgents([
  {
    name: "it-helpdesk", // the name a delegation uses
    cardUrl: "https://<the vendor's agent host>/.well-known/agent-card.json",
    description: "The IT helpdesk agent: opens, reads and updates IT tickets for a person.",
  },
  {
    name: "hr-agent",
    cardUrl: "https://agents.hr.example/.well-known/agent-card.json",
    description: "The HR agent: answers questions about leave, payroll dates and benefits.",
    auth: { scheme: "bearer", secretRef: "db:a2a:hr-agent-token" }, // the REF, never the token
    domains: ["people-ops"], // optional: only conversations in these memory domains may use it
  },
]);
```

`defineA2aAgents` validates the list when the module loads, so a bad entry fails the build and the
boot. It refuses a card URL that is not `https`, and a URL with a user-info part, a query string or
a fragment, because a token in a URL is a secret in Git. It refuses a literal `token` or `secret`
in `auth`. Store a token with `npx oe secret set <ref>` and name the ref in `auth.secretRef`. The
`broker` defaults to `db`, the encrypted credential store.

🔴 **A person cannot add an agent.** A delegation names a declared agent by its `name`, and the tool
refuses any other name. Nothing at runtime writes the list.

## What a delegation does

`delegate_to_agent` takes the agent's `name` and the task text. It runs in two calls with the
same input:

1. **The first call posts an approval card and sends nothing.** The `a2a.delegate` card shows the
   agent, its host and the exact task text, because the card is the injection gate: the approver
   reads what the remote agent will receive. Any member may approve it.
2. **A click arms one more call.** The click writes a one-call approval for exactly that agent and
   that text, for that asker, under the key of the conversation that asked. The decision wake tells the job that
   asked to call `delegate_to_agent` again with the same input. That call spends the approval and
   sends the task. A different text, or a different asker, is a different call and takes a new card. An approver-chain
   lift (a pre-approval rule or the approval judge) runs the second step inside the first call.

The sending call then:

- reads the agent's published **agent card** through the official A2A SDK (`@a2a-js/sdk`). The client
  speaks A2A v1.0, and it reaches a v0.3 agent through the SDK's own compatibility layer, because many
  enterprise agents still publish v0.3 cards. It checks that every endpoint the card names sits on
  the declared card URL's ORIGIN: the same scheme, host and port. A card that points elsewhere is
  refused;
- sends the task as an A2A message, with the asker's identity in the message metadata under the key
  `open-everywhere/caller`: the platform, the workspace and the asker's verified id. When a person
  approved the card, `approvedBy` names that person. When a pre-approval rule or the approval judge
  lifted it, `approvedByPolicy` names the rule instead, and `approvedBy` is absent, so a remote agent
  never reads a policy as a person's approval;
- sends it ONCE per approval. The sending call claims its one send before it sends. After a click,
  the claim keys on the spent approval, so a redelivery of the step finds it taken. An approval a
  chain lift wrote is spent ONLY inside the lifting call: that call spends it, burns its claim, and
  claims the lift's decided approval row (the wedge row). A redelivery of the step, and a repeat of
  the call in the same turn, re-lift onto the same wedge row and find it claimed. A lift in a turn with
  no session and turn identity sends nothing, because its wedge row would then be new on every
  delivery, and its approval is used up all the same. A run that finds a claim taken sends nothing
  and says the task may or may not have reached the agent. The claim comes first, so a crash between the claim and the send loses the send
  rather than doubling it. The message id is derived from the claim, so an agent that de-duplicates by
  message id sees the same id;
- follows the task for up to one minute, polling its state. A task that finishes in that time comes
  back with its result. A task that is still running comes back with its state and its task id;
- reports the result. The worker returns it to the conversation seat, which reports it in the
  thread that asked.

`check_agent_task` follows a task that was still running. It takes the agent's name and the remote
task id (`agentTaskId`), waits up to one more minute, and reports the state and the result. It is a
read and takes no card. It follows only a task that THIS conversation delegated in the last 24 hours, so a task id
from anywhere else — including from a remote agent's own text — is refused.

## Who may delegate, and from where

A delegation sends a task out on the organisation's credential, and the answer comes back into the
room that asked. So both tools check the room first, before any card or request, and refuse with a
plain reason and an `a2a.refused` audit row:

- **The room must be internal.** A Slack Connect or other shared room, a room declared `public` in
  `agent/identity/surfaces.ts`, a room whose trust the host cannot determine, and a DM with a guest
  or a stranger all bind `external`, and all are refused. This is the strictest default that external
  and guest rooms get everywhere else, and the same check `create_agent` and `request_access` make.
  🔴 One operator setting matters here: `identity.blanketTrust: "internal"` raises a room or a DM
  partner to internal only where the platform gave NO verdict (for example a Discord, GitHub, Linear
  or Notion surface, or a Slack DM with no partner lookup). A platform's own `external` verdict — a
  Slack Connect room, an unchecked Slack channel, a Slack guest DM partner — and a declared-`public`
  room still bind external and are still refused. In a room the setting raised, only the non-member
  mark below refuses a guest, and only when the platform's membership probe answered.
- **No guest or external account in the request.** When the host has positively refuted an author
  of the request as a member (a Slack guest or stranger, an Entra guest, an account in the operator's
  author register), the wake carries that mark, and the tools refuse it even in an internal room. The
  mark is positive-only: an unmarked wake is not proof that every author is a member.
- **The agent's domains, when it names them.** `domains` lists the memory domains whose conversations
  may use the agent. A conversation in another domain, or in no domain (a DM, an unclaimed room), is
  refused. Without `domains`, every internal room may use the agent.

The card also says where the answer will be posted: the asking conversation.

## What protects the delegation

- **Only declared agents, only their origin.** Every request goes through one guarded fetch
  (`packages/core/agent/a2a/egress.ts`). Per request it checks the declared origin (scheme, host and
  port), then takes the
  host-side reach decision, which applies the break-glass halt, then the SSRF guard: no literal
  internal host, a socket pinned to a resolved public address or the forward proxy. It refuses
  redirects. The declared host is NOT added to the sandbox's allow-list, so the sandbox cannot reach
  the agent.
- **The token stays host-side.** The bearer token resolves through its credential broker for each
  delegation and goes only to the declared origin. It never reaches the model or the sandbox.
- **The answer is untrusted.** What the remote agent returns — its text, its task id, its error
  text — is fenced through the untrusted-content boundary as a `connector` ingestion with an
  external content origin, so the turn that reads it is tainted: a later verb that arms a post-turn
  surface then needs a person.
- **A tainted turn is not floored.** The `delegate_to_agent` row in
  `packages/core/agent/access/consequence.ts` carries taint tolerance `disclose`, as a connector write
  does. Since OPE-2717 the card shows no taint line. The chain floors a tainted turn at a
  person's decision only for the verbs that arm a post-turn surface, and a delegation arms none. So a
  pre-approval rule or the approval judge can still lift a delegation in a tainted turn, exactly as it
  can lift a connector write. With no rule and no judge lift, a person decides. An unattended run is
  refused: the tool needs an acting person, and the chain turns `ask` into `deny` on a fire.
- **Audit.** A click writes `a2a.delegate_approved`, a send writes `a2a.delegated`, and every
  request writes an `egress.hostside.allow` or `egress.hostside.deny` row — an origin-pin refusal, a
  reach refusal and an SSRF-guard refusal each write their own deny row. These rows carry ids, the
  host and the task state, never the task text or the answer.

## How it is tested

- `packages/core/scripts/a2a-client-test.ts` (`npm run test:a2a-client`) drives the client against the
  A2A project's own sample agent, served by the official SDK on a loopback socket
  (`packages/core/scripts/a2a-reference-agent.ts`): a quick task, a task that outlives one wait, a
  failed task, a v0.3 agent, the origin pin, the halt, the SSRF-guard row, the untrusted fence, the one-call spend,
  the one send, the approver identity and the task ownership.
- `tests/integration/connectors/a2a-delegation.test.ts` drives the whole chain on the booted host: the
  card, the signed Approve click, the decision wake, the second call, and the answer in the fence.
- The live e2e leg `S-A2A-DELEGATE` asks a deployed agent to delegate to the first declared agent
  whose name starts with `reference`. On a TEST deployment, declare the A2A community's public Hello
  World agent (`https://hello-world-gxfr.onrender.com/.well-known/agent.json`) for it. 🔴 That is a
  third-party host: never declare it on a deployment that carries real work. An app with no
  `agent/access/a2a-agents.ts` ends the leg as the missing-fixture precondition
  `a2a-declaration-file`, and a file that declares no agent ends it as `a2a-declared-agent`.

## Limits today

These are the honest edges of the first slice. Each is a known gap, not a hidden property.

- **The remote agent cannot verify the asker's identity.** The metadata names the asker, and the
  remote agent trusts it because it trusts the deployment's own credential. There is no per-person
  token exchange (for example OAuth on-behalf-of) yet.
- **Polling only.** The client does not use A2A streaming or push notifications. One call follows a
  task for one minute. A task that runs longer is followed by asking again with `check_agent_task`
  within 24 hours.
- **Text first.** Text parts come back as text, data parts as JSON, and a file part as its URL or
  its size. A task that waits on its caller (`input-required`, `auth-required`) is reported as such;
  the client cannot answer it.

## Inbound: another agent calls this one

A deployment can also take calls: another organisation's agent — for example a Copilot Studio agent
in a Microsoft shop — reads this deployment's A2A agent card and sends it a task. 🔴 **This is an
external ingress, and it ships dark.** It exists only when both of these are true:

1. `a2a: { inbound: true }` in `agent/settings/settings.ts`. The shipped value is off.
2. `agent/access/a2a-inbound.ts` declares at least one caller, by pull request.

With either one missing, `GET /.well-known/agent-card.json` and `POST /a2a/jsonrpc` both answer 404:
the routes do not exist.

### Declare a caller

```ts
// agent/access/a2a-inbound.ts
import { defineA2aInbound } from "@open-everywhere/core/agent/a2a/inbound/declaration.js";

export const A2A_INBOUND = defineA2aInbound({
  name: "Acme chief of staff", // the card shows it
  description: "Answers questions about Acme's IT projects.",
  skills: [
    // The card lists these: what a caller may ask for. Never the agent's tool roster.
    { id: "it-questions", name: "IT questions", description: "Answers questions about the IT team's open projects." },
  ],
  callers: [
    {
      name: "contoso-copilot", // the audit rows and the task owner carry it
      description: "Contoso's procurement agent in Copilot Studio.",
      domain: "it", // the ONE team domain its calls land in
      auth: {
        scheme: "jwt",
        issuer: "https://login.microsoftonline.com/<tenant id>/v2.0",
        jwksUrl: "https://login.microsoftonline.com/<tenant id>/discovery/v2.0/keys",
        audience: "api://<this deployment's app id>",
        subject: "<the calling agent's service principal object id>",
      },
    },
    // A platform that can only send a static secret: `npx oe secret set <ref>`, then name the REF.
    { name: "partner-helpdesk", description: "The partner's helpdesk agent.", domain: "it", auth: { scheme: "bearer", secretRef: "db:a2a-inbound:partner-helpdesk" } },
  ],
});
```

`defineA2aInbound` validates the declaration when the module loads, so a bad entry fails the build
and the boot. It refuses a caller with no `auth`, a wildcard `subject`, an issuer or JWKS URL that is
not `https` or that carries a user-info part, a query string or a fragment, a literal secret in
`auth`, a name declared twice, and two callers that pin one issuer, audience and subject. The boot
also refuses a caller whose `domain` is not a declared TEAM domain (`agent/memory/config/domains.ts`):
a missing name and a pseudo-domain such as `org` are both refused. 🔴 **A person cannot add a caller:**
nothing at runtime writes the list.

### Who is calling

Every call must authenticate. There is no anonymous door. The JSON-RPC route reads the
`Authorization: Bearer <credential>` header **before it reads the body**, and a call that does not
authenticate as a declared caller gets a 401 before any task, any store write or any turn:

- **A JWT** (the first scheme). The token's signature must verify against the JWKS of the caller's
  declared issuer, with the declared `issuer` and `audience`, an `exp` and a `sub`. The verified
  `sub` must equal the caller's declared `subject`. A token that verifies but whose subject no caller
  declares is refused. The algorithms are the asymmetric ones only: an HMAC token is refused, so no
  token can be signed with a public key.
- **A bearer secret** (the fallback). The secret resolves through its broker by its REF, at most once
  per 60 seconds on each instance, a failed resolution included, so an unauthenticated burst costs no
  broker read per request. It is compared in constant time. An unresolvable secret matches nothing.
  🔴 A revoked or rotated secret takes effect within that window: the old secret can still admit its
  caller for up to 60 seconds, and a newly stored secret can be refused for up to 60 seconds after a
  miss.

The 401 body is one constant: it does not say which check failed. Each refusal writes an
`a2a.inbound_refused` row with the reason — never the credential — throttled to about one row per
reason per minute, with a `suppressed` count, because the route is public and an unthrottled row per
refusal would let anyone write unbounded rows into the audit log.

### Where a call lands

One call is one A2A task, and the task becomes ONE job:

- **Its own surface.** The job runs in the work session of the caller's own synthetic surface,
  `a2a/inbound/<caller>`, inside the caller's declared domain. That surface is bound to the domain by
  the declaration alone: no domain's `reach` can claim it (a glob included), and it never falls back
  to the `org` pseudo-domain. It never shares the domain's window, so the job cannot read a room's
  history, and it never lands in a human channel or DM. A caller whose domain no longer exists is
  refused, and the task ends `rejected`.
- **What narrows the job, and what does not.** An inbound caller is another organisation's agent.
  These hold for every call:
  - the call binds **external**, so the memory plan reads only the read-only `public` pseudo-domain
    and writes nothing;
  - the job is **unattended**: no person is acting, so a gate that needs a person refuses, and the
    approval chain turns `ask` into `deny`;
  - the invoker posture is `untrusted-remote`, the narrowest class, the one a webhook fire takes;
  - the caller's text rides inside the untrusted fence (ingestion kind `a2a-inbound`), and the job's
    turn is tainted from its first byte.

  🔴 **The external binding narrows MEMORY, not tools.** The surface resolves to the caller's declared
  domain, so every grant bound to that domain — its tools, its connectors (a Notion workspace, for
  example), its coding bundles — applies to the job. A read needs no person, so the unattended stamp
  does not stop it, and anything the job reads through those grants can reach the answer. Only the
  job's brief tells the model what must not leave the organisation, and a brief is not a control.
  **Declare a caller only in a domain whose grants you would expose to that organisation.** A
  per-caller tool and connector roster is not built.
- **No seat, no room.** The host forwards the task into the work session as a fire that owes no room,
  so no seat turn runs and nothing posts into any room. A scope over its spend cap (the `public`
  criteria budget, because the call binds external) and a domain with no work session also end the
  task `rejected`.

### The answer

The task answers `working` at once. The caller follows it with `tasks/get` (or `GetTask`); a follow-up
message on a task is refused, because an inbound task takes no further input. When the job settles,
the work session's result path writes the task's final state, in place of a seat wake:

- `completed` — the job's final report, as the task's one artifact, with every memory citation cut to
  its silo-relative path (the same pass a room reply takes), cut at 20 000 characters;
- `failed` or `canceled` — a fixed host sentence. A failed job's error text is never sent, because it
  can name internal hosts or paths.

Tasks are kept for 24 hours, keyed on the AUTHENTICATED caller: one caller cannot read, or detect,
another caller's task. The task row keeps ids, states and the answer, never a copy of what the caller
sent.

### The card

`GET /.well-known/agent-card.json` needs no credential, by the protocol's design. It carries only what
the declaration chose to publish: the name, the description, the declared skills, the JSON-RPC
interface and the security schemes the callers use (`bearerJwt`, `bearerSecret`). It never names a
caller, an issuer, a subject, a domain or a tool. The card is A2A v1.0. The route also answers the
v0.3 method names (`message/send`, `tasks/get`), so a v0.3 client that reaches the route works.
Streaming and push notifications are not served.

### Audit

| Row | When | Carries |
|---|---|---|
| `a2a.inbound_refused` | A call did not authenticate | the reason (throttled) |
| `a2a.inbound_accepted` | An authenticated caller started a task | the caller, the task id, whether it landed and why not, the text's length |
| `work.forwarded` | The task became a job | the request id, the work-session token, `fire: true`, `owesRoom: false` |
| `a2a.inbound_answered` | The job settled | the caller, the task id, the outcome, the answer's length, whether the task row still existed |

No row carries the task text or the answer.

### How it is tested

- `packages/core/scripts/a2a-inbound-test.ts` (`npm run test:a2a-inbound`) drives the declaration, every
  authentication refusal, the gate order (404 with the setting off or no caller, 401 before the body,
  the refusal throttle), the official SDK client end to end against the routes, the owner scope, the
  card, the answer, the domain binding of an `a2a/` surface, and the fire half of the work request.
- `tests/integration/ingress/a2a-inbound.test.ts` drives the booted host: the SDK client reads the
  card, sends a task with a JWT a stubbed issuer's JWKS verifies, the job runs in the caller's own
  work session with no seat turn and refuses a person-only act, and `tasks/get` returns the report. An
  unauthenticated call, an undeclared subject, no declaration and the setting off are each refused.
- The live e2e leg `S-A2A-INBOUND` reads a deployment's card and checks that an unauthenticated call
  is refused 401 and audited. A deployment with the ingress off ends the leg as the missing-fixture
  precondition `a2a-inbound-enabled`. The pack holds no caller credential, so the authenticated leg
  runs on the integration tier only.

### Limits of the inbound half

- **One message per task.** A follow-up message, streaming and push notifications are not served.
- **No per-caller roster.** A caller holds what its domain grants, narrowed only as listed above. A
  per-caller tool and connector roster, and a reviewed widening per caller, are not built.
- **No mTLS.** JWT and bearer secrets only.
- **The JWKS is fetched directly.** The key set of a declared issuer is fetched by the host, from the
  declared `https` URL, as the control plane fetches its issuers' key sets; it does not go through the
  agent's egress guard.
