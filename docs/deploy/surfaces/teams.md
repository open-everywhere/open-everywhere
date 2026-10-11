# Microsoft Teams

Run Open Everywhere as a Microsoft Teams bot: `@mention` it in a team channel, drop it into a group chat, or DM it 1:1. It acts under one bot identity shared by the deployment — never under a member's account and never with a member's permissions — with per-conversation memory.

This page is the Teams-specific setup runbook. For the concept of a *surface* and how surfaces plug in, see [Surfaces](../../extending/surfaces.md). For how memory is scoped per tenant and conversation, see [Memory](../../capabilities/memory.md). For how Teams' feature set compares to the other surfaces — including which features are built but not yet verified against a live tenant — see the [surface support matrix](./support-matrix.md).

Teams is the richest native fit for the silo model — its `tenant → team → channel` hierarchy maps directly onto `org → workspace → surface`, with no impedance mismatch.

## How the silo model maps

Open Everywhere's memory is [opt-in domains and silos](../../capabilities/memory.md), not an
automatic per-tenant tier stack. A Teams conversation is a **surface**; the tenant is the
natural `workspace` identity key many channels' surface keys share, but sharing memory across
them still needs an explicit `domain` (or the `org` pseudo-domain fallback) — nothing pools
automatically, and (see "Trust" below) `visibility` is *not* what gates it.

| Open Everywhere concept | Teams concept | Source field |
| --- | --- | --- |
| `org` (deployment tenant) | the Open Everywhere deployment (one org today, from `deploymentIdentity.org`) | tracked config |
| `workspace` (identity key) | the **Microsoft tenant** (the Entra/Azure AD org) | `tenant_id` |
| `surface` (partition key) | the **conversation** — a team channel, a group chat, or a 1:1 | `conversation_id` |
| `mode` | `channel` (team channel) · `mpim` (group chat) · `dm` (1:1) | `scope` |
| `visibility` | `public` only for a confirmed team-wide channel; else `private` | `membership_type` |
| `trust` | `internal` only for a positively-verified in-tenant channel; else `external` | `membership_type` + `tenant_id` |

`scope` maps via `teamsMode`: `personal → dm`, `groupChat → mpim`, `channel → channel`.

**Visibility is tracked but isn't the memory gate — trust is (below).** A team channel is
only treated as **public** when `membershipType == "standard"` — the org/team-wide channel
everyone on the team can see; everything else (1:1 chats, group chats, a `private` or
`shared` channel, or an unconfirmed one) is `private`. But a **private** in-tenant channel
still shares its domain's or the org's brain exactly like a public one does — visibility just
isn't the thing `teamsTrust` reads. The catch is the *positive-confirmation* requirement
`teamsVisibility` and `teamsTrust` both share: inbound Teams activities almost never carry
`membershipType` (it's a Graph/Teams-API property, not a guaranteed field on a Bot Framework
Activity), so both default `private`/`external` until a Graph-API enrichment supplies it —
correct-but-conservative rather than assuming either bit.

**Trust fails closed too.** Trust is the [memory gate](../../capabilities/memory.md): an `external` surface gets read-only `public` memory at most, never an internal domain or the org brain. Only positive facts produce a verdict (`teamsTrust`):

- `membershipType == "shared"` — a Teams **Shared Channel**, which can include people from *other* tenants (the Teams analog of Slack Connect) — is `external`, always. No override reaches it.
- `membershipType == "standard"` or `"private"` with a known `tenant_id` is a positively-identified in-tenant channel — `internal`.
- **Anything unverifiable** — absent `membershipType` (the common case), an unrecognised value, or a missing tenant id — produces NO verdict, so the surface falls through to the next rung of the trust chain. With nothing declared it binds `external`. **Two things promote it, not one.** A **register declaration** covering the surface (`defineSurface({ key: "teams/<tenantId>", trust: "internal" })`, the section below) binds it `internal` — and a declaration counts at any rung, so a tenant line covers every room under the tenant. A **single-tenant deployment** can instead use the blanket setting `identity.blanketTrust: "internal"` (the same escape hatch Discord/Linear use). Both sit BELOW the platform verdict in `identity/binding.ts`, so neither overrides a positive `external` one; a `public` declaration outranks both and demotes. What neither does is fence an ambiguous activity out of the org brain: once you declare the tenant, a room with no `membershipType` reaches it. Weigh that reach before you pick the grain.
- 1:1 and group chats are personal silos (the channel-trust gate doesn't apply), but the **DM-partner gate** still fails closed: Teams doesn't positively verify who the 1:1 partner is, so a DM gets the per-user personal store plus read-only `public` — not the `dm`-shared layer.

### Vouching a Teams surface — `agent/identity/surfaces.ts`

Teams declares its vouched surfaces where every other platform does: `agent/identity/surfaces.ts`,
config-as-code reviewed by pull request. No trust lever is an environment variable. The blanket vouch is the
setting `identity.blanketTrust: "internal"` described above (it was `OE_TRUST` until OPE-2411). A surface key
carries your Microsoft 365 tenant id, which is an identifier, not a credential — the same class as
the Discord guild id and the GitHub org already in that file. Note what that still costs on a public
repository: the id names your organisation, permanently, because the history goes public with the
tree. That is a disclosure to weigh, not a secret to protect.

**Declare the tenant. That is the vouch.**

```ts
defineSurface({ key: "teams/<tenantId>", trust: "internal" }),
```

A declaration counts at **any rung**. Trust resolution is most-specific-wins with a fallback to the
tenant, so this one line makes every channel and thread under that tenant bind `internal` — the same
workspace-grain shape the Discord guild and GitHub org lines use. Declare a single channel instead
(`teams/<tenantId>/<threadId>`) when you want to narrow it to one room.

**One line serves both planes, the cross-surface single window included.** The Teams single-window
privacy floor reads `isVouchedSurface`, and that reader walks the declaration rungs like every other
trust read (**OPE-1521**), so a channel covered by the tenant vouch both binds `internal` for memory
and joins a shared cross-surface window.

It did not always. The floor used to be an exact-key match no tenant declaration satisfied, so a
tenant line kept boot green while the channel quietly failed to join the window — one register, two
grain semantics, and nothing said so. If you are reading an older deploy's config, that is why a
second channel-grain line sits beside a tenant line. Such a line changes no verdict now, and this
deployment's own config dropped its copy (**OPE-1533**).

`identity.blanketTrust: "internal"` opens that floor too, regardless of declaration grain — it is the deploy-wide
blanket described above, and it satisfies the window check without any per-surface vouch.

**What a tenant declaration reaches.** Every room under it, including a cross-tenant
Connect/**shared** channel that can carry people from other organisations. Inbound activities usually
omit `membershipType` (see below), so trust falls back to the vouch rather than to a positive
in-tenant signal. Declare the tenant where you trust the tenant; declare single channels where you do
not.

**Narrowing one whole team out of a tenant.** A Teams channel keys as `teams/<tenantId>/<threadId>`,
and the team is nowhere in that key, so a **group rung** names it instead:

```ts
defineSurface({ key: "teams/<tenantId>", trust: "internal" }),
defineSurface({ key: "teams/<tenantId>/team:<teamId>", trust: "public" }),
```

The group rung outranks the tenant entry, so every channel of that team binds `external` and stays
out of the shared window, while the rest of the tenant keeps the tenant line. The window floor reads
the same rung as the binding and memory planes (**OPE-1538**); before that it skipped the tier and
admitted a room the other two planes had already demoted.

🔴 **`preflight` reports a working Teams container line as a dead declaration.** It folds traffic from
audit rows, which name one workspace and one room and no rung above them. Two Teams shapes name a
container:

- the **group rung** above — no traffic row carries the team;
- a **channel line** (`teams/<tenantId>/<channelId>`), because a Teams room keys on the CONVERSATION
  id. A reply chain keys as `<channelId>;messageid=<root>`, and only a post at the channel root keys
  as the channel itself.

Both report as dead declarations while they work. Where such a line is the only cover for the rooms
under it, those rooms also report as undeclared traffic — a red that flips the ops report's `ready`
to false. Do not delete either line on that advice. Deleting the group rung above returns every
channel of that team to the tenant's `internal`; deleting a channel line returns every reply chain in
it to `external`. **OPE-1560** carries the audit-row half that closes this, and the
dead-declaration check says so itself.

**Fail closed.** A surface with no entry stays `external`. There is no default vouch.

**A vouch does not put a channel in a memory domain.** It says the channel is `internal`; which
channels share a brain is a separate decision in `agent/memory/config/domains/<name>.ts`. The two lists stay
separate on purpose — a window roster derived from the vouch list would enroll every channel you
vouch in one cross-surface window and one silo, and it would make the window's own un-vouched-source
check vacuous. Write the key in both places.

This vouch is precise. The setting `identity.blanketTrust: "internal"` is the blunt single-tenant
alternative described above, which vouches every unverifiable surface on every platform at once.

## Prerequisites

- An **Azure subscription** and **Entra ID (Azure AD)** admin rights — you need to create an Azure Bot resource and an app registration, and someone with admin rights to upload/approve the Teams app.
  - **No work tenant, or no admin rights in yours?** Start a **[Microsoft 365 Business Basic 1-month free trial](https://www.microsoft.com/microsoft-365/business/microsoft-365-business-basic)** — a full tenant where you *are* Global Admin, with 25 free seats for the trial month; after that, one Business Basic seat (a few £/$ a month, monthly commit) keeps it alive, and free **guest** accounts cover extra test users. Two day-one moves: turn OFF recurring billing (the trial otherwise auto-converts to an *annual* term) and enable custom app upload (Teams admin center → Teams apps → Setup policies — can take up to 24h to appear/propagate on a fresh tenant). Mind the SKU: the cheaper "Business Basic *(no Teams)*" variant won't work. (The old [Microsoft 365 Developer Program](https://developer.microsoft.com/microsoft-365/dev-program) sandbox is closed to unaffiliated developers since 2024 — it now requires a Visual Studio Pro/Enterprise *standard* subscription or a Microsoft partner program; Microsoft's own Teams docs point everyone else at the trial/purchase route. An Azure subscription for the Bot resource is still needed; the free F0 tier covers it and the Teams channel is free.)
- A **deployed Open Everywhere instance** — see the [docs index](../../README.md) and [setup runbook](../setup-runbook.md). Teams requires a **public HTTPS endpoint**: the Bot Framework Connector calls *your* messaging endpoint, so it cannot reach `localhost`.
  - For local development, expose your instance with a tunnel — e.g. a [VS Code dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/), `ngrok`, or Cloudflare Tunnel — and use the public `https://…` URL as the messaging endpoint.

## Step 1 — Register the Azure Bot + Entra app

1. In the [Azure Portal](https://portal.azure.com), **Create a resource → Azure Bot** (the modern replacement for *Bot Channels Registration*; either works).
2. For the bot's identity, choose **Single-tenant** and set `MICROSOFT_TENANT_ID` to that tenant's Directory ID. (Microsoft deprecated new **multi-tenant** Azure Bot creation after **31 July 2025** — fresh registrations are Single-tenant or User-Assigned Managed Identity only, and this integration uses the app-id + secret flow, i.e. Single-tenant. `MICROSOFT_TENANT_ID` is therefore effectively required for any new bot, not optional.) Azure either creates a new **Entra app registration** for you or lets you point at an existing one.
3. Note the app registration's **Application (client) ID** — this is `MICROSOFT_APP_ID`.
4. In the app registration, go to **Certificates & secrets → New client secret**, create one, and copy its **Value** immediately — this is `MICROSOFT_APP_PASSWORD`. (Azure calls it a "client secret"; the Bot Framework calls it the "app password" — same thing.)
5. For a single-tenant bot, copy the **Directory (tenant) ID** — this is `MICROSOFT_TENANT_ID`.
6. On the Azure Bot resource, open **Configuration** and set the **Messaging endpoint** to:

   ```
   https://<your-deploy-url>/eve/v1/teams
   ```

   (`/eve/v1/teams` is the route Open Everywhere's Teams channel listens on.)
7. On the Azure Bot resource, open **Channels** and **enable the Microsoft Teams channel**.

## Step 2 — Package the Teams app

The Azure Bot exists, but Teams needs an **app package** (a manifest + icons) to surface the bot inside Teams. The manifest is **rendered**, not static (OPE-2334): the Teams bundle renders it from this deployment's settings, so the app carries the configured [`identity.name`](../configuration-reference.md) in `name.short`, `name.full` and `description.full` ("Open Everywhere" when no name is configured). Get it from the ops MCP tool — `surface_manifest { "surface": "teams", "baseUrl": "https://<the deployment's host>" }` — which also substitutes your deploy host. An explicit `appName` (at most 30 characters) overrides the configured name. The icons and a build/install README ship at [`teams-app/`](../../../teams-app/). The icons are the project mark, rendered from [`brand/`](../../../brand/README.md): with no name configured the agent presents as the project, so the mark is its default avatar. The manifest is already scoped for `team` + `groupChat` + `personal`.

1. Fill the package: save the rendered manifest as `teams-app/manifest.json`, replace `{{MICROSOFT_APP_ID}}` (your `MICROSOFT_APP_ID`, used for both `id` and `bots[].botId`) and `{{DEVELOPER_NAME}}`, then zip it flat — the `teams-app/README.md` has a one-liner. Keep `color.png` / `outline.png` unless you set `identity.name` and chose your own icon. In that case, replace both before any org-wide install. A checkout without `teams-app/` gets both from <https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/teams-app/color.png> and <https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/teams-app/outline.png>.
   - Prefer a GUI? The [Developer Portal for Teams](https://dev.teams.microsoft.com/) (formerly *App Studio*) → **Apps → New app** → **App features → Bot** → select the bot by its app ID does the same thing interactively.
   - The manifest's `privacyUrl` and `termsOfUseUrl` are **not** placeholders: they point at `/privacy` and `/terms` on your own deploy host, and **the deployment serves both**. The host `surface_manifest` substitutes is all they need. The TEXT of both is yours — declare it as `policyPages.privacy` and `policyPages.terms` in `agent/settings/settings.ts` (see [the configuration reference](../configuration-reference.md#agent-settings-behaviour-config-as-code)). Undeclared, each route still answers `200` with a short page saying no document is published yet, so a sideload never breaks; publish real text before an **org-wide** upload, where a reviewer reads them.
2. The package already declares the three **scopes** — `team` (channel surfaces), `groupChat` (mpim surfaces), `personal` (dm surfaces). Trim them in `manifest.json` if you want a narrower install.
3. The package declares three **RSC (resource-specific consent) permissions** (all Application), under `authorization.permissions.resourceSpecific`, paired with a `webApplicationInfo` block (`id` = your app id, `resource` = any URI):
   - **`ChannelMessage.Read.Group`** — read a **team's channel** messages, and receive *every* channel message activity rather than only @mentions. Granted by a **team owner** at install time.
   - **`ChatMessage.Read.Chat`** — the chat analogue: read a **chat's** messages (group chats, and the chats behind meetings) and receive every chat message activity. Granted by any **chat member** authorised to install apps in that chat.
   - **`ChannelMember.Read.Group`** — read a **team channel's** membership list. Granted by a **team owner** at install time, same as `ChannelMessage.Read.Group`. It powers the routine fire-eligibility room check (see [Proactive routines](#proactive-routines)) — see that section for what changes when it's missing.

   None of the three lives in the Azure app registration's API-permissions blade — RSC exists only in the Teams manifest — and none goes through Microsoft's Protected-API approval queue (which is what `ChannelMessage.Read.All` would need). Keeping `ChannelMessage.Read.Group` is also what keeps Microsoft's own per-team boundary on channel reads; see [Which boundary governs your reads](#which-boundary-governs-your-reads). **@mentions reach the bot without any of them**, so if you only want mention-driven behaviour you can remove *all three* along with the `authorization` and `webApplicationInfo` blocks; keep them for ambient watching, [channel/thread history reads](#reading-channelthread-history), and enforced [routine fire-eligibility](#proactive-routines) checks.

   > **What `ChatMessage.Read.Chat` does and doesn't change.** It is what makes Microsoft *deliver* non-mention group-chat messages to OE at all — without it they never arrive, so nothing downstream could ever act on them. It does **not** make OE answer everything a chat says. OE's own ingress admits a non-mention chat message only when the chat is **engaged** — somebody `@mentioned` the bot there and has not asked it to stop following. An un-engaged chat wakes nothing — except an answer to a question the agent itself parked there, which is always admitted. The cross-surface window's privacy floor still admits `channel` scope only (a group chat is a per-person surface, not an org container), so a chat never joins the shared window. See the [gotcha below](#gotchas).
   - **`webApplicationInfo` is required whenever `authorization` is present.** An RSC manifest with `authorization` but no `webApplicationInfo` fails to upload with a generic *"We couldn't parse the app manifest from your app package"* — even though the JSON is schema-valid. Teams needs the pair to bind the RSC grant to your Entra app.
   - **Getting the grant onto the team is the hard part, and the Teams client UI is unreliable for it.** A client/admin-center install can appear to succeed (consent dialog shows) yet silently fail to persist the grant — the app responds to @mentions (the Azure Bot delivers those without a team install) while ambient stays dark. **Verify** with Graph: `GET https://graph.microsoft.com/beta/teams/{team-group-id}/permissionGrants` — you want an entry with `permission` = `ChannelMessage.Read.Group` and `clientAppId` = your app id (an empty `value: []` means no grant). If the UI won't take, the **reliable** path is to install via Graph with consent in one call:
     ```
     POST /v1.0/teams/{team-id}/installedApps
     { "teamsApp@odata.bind": "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/{catalog-app-id}",
       "consentedPermissionSet": { "resourceSpecificPermissions":
         [ { "permissionValue": "ChannelMessage.Read.Group", "permissionType": "application" } ] } }
     ```
     Use the **catalog** `teamsApp.id` (find it via `GET /appCatalogs/teamsApps?$filter=externalId eq '{your-app-id}'`), **not** the manifest/app id — the latter returns *"non existent App definition"*. The caller needs delegated `TeamsAppInstallation.ReadWriteAndConsentForTeam` (plus `AppCatalog.Read.All` for the lookup). The grant appears in `permissionGrants` ~10–20 s later. Team RSC is enabled by default (`ManagedByMicrosoft`), so this is rarely a tenant-policy block.
   - **Adding a permission to an *already-installed* app**: Teams keys an app by the `id` GUID (not by where you uploaded it), and RSC consent is captured at **install time into a specific team or chat** — bumping the catalog version does *not* retroactively grant a new RSC permission to a team/chat that already has the app. Bump `version` (e.g. `1.0.1` → `1.0.2`), repackage, then either re-add (client) or use the Graph install-with-consent above.
     - **This applied to `ChatMessage.Read.Chat` at `version` `1.0.2`**, and now applies to `ChannelMember.Read.Group` at `version` `1.0.3`: every team **or chat** that installed an earlier version keeps its old grant set. To pick up a new permission: rebuild the package, re-upload it to the catalog (Admin Center → *Teams apps → Manage apps →* the app *→ Update*), then **re-add the app to each affected chat/team** — or run the Graph install-with-consent call above with the new permission name (`permissionType: "application"`) in the `resourceSpecificPermissions` array. For a **chat** the endpoint is `POST /v1.0/chats/{chat-id}/installedApps` rather than `/teams/{team-id}/installedApps`, and the verification read is `GET https://graph.microsoft.com/beta/chats/{chat-id}/permissionGrants`. Until that re-consent happens the permission is inert — exactly like the UI-consent-silently-failed case above. **This is the path existing installs use to pick up `ChannelMember.Read.Group`** (new installs get it automatically as part of the default manifest — see [Proactive routines](#proactive-routines)).
4. **Install / sideload** the app:
   - Org-wide: an admin uploads it in the [Teams Admin Center](https://admin.teams.microsoft.com) (**Teams apps → Manage apps → Upload**).
   - **To list it in the Teams admin centre** — an org-wide upload or a Teams Store submission — build the zip with the ops tool `surface_app_package` instead of by hand. It fills the placeholders, refuses the project's name, and checks the package against the route's rules. See [Listing the Teams app in the admin centre](#listing-in-the-teams-admin-centre).
   - Single team: **Apps → Manage your apps → Upload an app** in the Teams client (custom-app upload must be enabled by your tenant admin).

## Step 3 — Configure the environment

Set these on your deployment (see the Microsoft Teams section of `.env.example`):

```bash
MICROSOFT_APP_ID=<application-client-id>
MICROSOFT_APP_PASSWORD=<client-secret-value>
# Required for any new (Single-tenant) bot — the Directory (tenant) ID:
MICROSOFT_TENANT_ID=<directory-tenant-id>
```

Restart the instance so the Teams channel picks up the credentials. **Identity binds automatically**: the channel captures the tenant, conversation, scope, and (when present) membership type from each inbound activity, and `bindTeams` resolves the workspace, surface, mode, and visibility with no further config.

## Step 4 — Invoke it

1. **In a team channel:** `@Open Everywhere` followed by a request. An `@mention` is how a conversation STARTS, and it also **engages** that reply chain: later plain messages in it wake the bot with no new mention, until someone asks it to stop following (it then goes quiet there until the next `@mention`). A non-mention message in a chain the bot was never invited into is still dropped. The follow-ups depend on the `ChannelMessage.Read.Group` RSC grant — without it Microsoft delivers only `@mention` activities, so the bot answers once per mention.
2. **In a 1:1 chat:** message the bot directly — no `@mention` needed; personal chats are always for it.
3. Expected behaviour: a typing indicator, then a Markdown reply in-thread. A DM keeps its own per-user memory, so what it learns in a 1:1 does not appear in the channel. Channel learnings stay siloed because an unconfirmed channel binds **`external` trust**, not because it is private — see [Gotchas](#gotchas).

## What the agent calls itself here

A Teams session's IDENTITY — the name it introduces itself by — comes from one place only: the
[`identity.name`](../configuration-reference.md) setting. Set it and it **wins on every surface**,
byte-identically — the right answer for a deployment that spans Slack and Teams from one window:
one name, everywhere. Unset, the session renders the generic identity line ("this team's agent").
It never borrows a name from another surface, and (since OPE-610) never from this surface's own
Teams display name either — that is a HANDLE, not an identity; see below.

Separately, the session also carries a HANDLE line — "your mention/handle here appears as X" — so
the agent recognises its own mentions and backscroll lines under the app's real Teams name. Two
Graph reads feed it, tried in this order:

1. **The Teams app-catalog name** — the app manifest's `name.short` the Teams client
   renders beside a message. The agent reads it from Microsoft Graph
   (`GET /appCatalogs/teamsApps?$filter=externalId eq '…'&$expand=appDefinitions`). This call needs
   a tenant-admin-consented `AppCatalog.Read.All`. Without that consent, or if the call fails for
   any other reason, the agent falls straight to the next option below.
2. **The display name of your own Entra app registration** — the name you gave the app in Step 1.
   The agent reads it from Microsoft Graph
   (`GET /servicePrincipals(appId='…')?$select=displayName`) through the same app-only token the
   read adapter mints, and it needs **no extra Graph permission** — measured against a
   single-tenant app that carries only an RSC grant, where the implicit self-read answered 200. A
   multi-tenant install is reasoned to behave the same (the service principal exists in each
   consenting tenant) but is not measured.

If your app manifest's `name.short` and the app registration's display name are the
same string, both options answer identically and there is nothing to think about. They can differ
in case or spacing (`open-everywhere` vs `Open Everywhere` is a real example) — grant
`AppCatalog.Read.All` if you want the exact catalog string; otherwise the registration name is
the handle a session shows.

Either read is resolved once per instance, so a rename or a newly granted consent takes effect on
the next cold start. If neither lookup can answer — no token, an unconsented tenant, a network
failure — the session simply carries no handle line; the identity line above is unaffected either
way.

## Reading channel/thread history

Teams supports the generic `read_channel`/`read_thread` verbs (the same tools Slack and Discord
use), backed by Microsoft **Graph** rather than the Bot Framework Connector — the Connector token
this integration already mints (`MICROSOFT_APP_ID`/`MICROSOFT_APP_PASSWORD`/`MICROSOFT_TENANT_ID`)
can post activities but exposes no history-read API. The read adapter (`agent/channels/teams-read.ts`)
mints its own app-only Graph token via the same client-credential flow, same three env vars.

- **Permission needed:** the app registration's Graph API permissions need something that can read
  channel messages. If your Teams app package already grants the per-team RSC permission
  `ChannelMessage.Read.Group` (Step 2 above — the same grant that enables *ambient* watching), reads
  work in that team with **no extra Azure configuration**. This is the shipped default, and it is
  the option to keep — read [Which boundary governs your reads](#which-boundary-governs-your-reads)
  before you choose the other one. Missing every option surfaces as a Graph 401/403 — fail-loud,
  never a silent empty read.
- **Teams has two team ids, and Graph takes the second one.** An inbound activity carries the Bot
  Connector's team id — a `19:…@thread.tacv2` string. Every Graph URL under `/teams/{team-id}/…`
  takes the team's **Microsoft 365 group id** (a GUID) instead; Graph keeps the `19:` spelling as a
  team's `internalId`. For these read verbs and for the [since-last-wake catch-up](#reading-channelthread-history),
  Open Everywhere resolves the one into the other over the Connector
  (`GET {serviceUrl}/v3/teams/{teamId}`, whose `aadGroupId` is the group id) and caches the answer
  per team, so you configure nothing. A team whose group id will not resolve gets **no read** and a
  stated reason, never a read of the wrong team. **Every** Graph caller resolves the id this way,
  the routine fire-eligibility room-membership probe included (see
  [Proactive routines](#proactive-routines)).

### The since-last-wake catch-up read

A standing Teams seat reads its own room on every wake, so it sees most of what was said while it
was idle. That read uses the same Graph credential as the verbs above, and it makes **two calls**,
because Graph splits one channel's history across two endpoints:

| Call | What Graph returns |
| --- | --- |
| `/teams/{group-id}/channels/{channel-id}/messages` | the channel's **top-level** messages only — a reply is never in it |
| `…/messages/{root-id}/replies` | that **one reply chain's** replies, and not its root |

The seat is bound to a channel, and each wake arrives inside one reply chain. So the catch-up reads
both and merges them: the chain call is added whenever the activity names a chain, which a Teams
channel activity always does (its conversation id carries `;messageid=<root>`). Reading only the
channel is what made a chain that *had* carried the message read as an empty room.

**Know this bound.** The window is the channel's top-level messages plus the **one** chain the wake
sits in. A reply in another of the channel's reply chains does not reach the seat, because Graph
exposes no channel-wide replies endpoint — reading every chain would cost one call per chain. So an
empty catch-up is not proof the channel was quiet.

The read is **fail-soft**: a wake is never *failed* by its catch-up, and one endpoint refusing does
not throw away what the other returned. It does cost time — the two Graph calls and their two audit
writes run inline, before the seat is woken, though all of it sits behind the Bot Framework ack.
The audit row is what makes the read readable: without one, a 404, an empty page and a bound that
excluded everything all reach you as the same silence. One row per Graph call, action
**`teams.catch_up`**:

| Field | What it says |
| --- | --- |
| `resource` | `channel-messages`, `thread-replies`, or `none` when the address could not be built |
| `status` | `ok`, `error`, or `unaddressable` |
| `httpStatus` | the HTTP status, when Graph refused the call |
| `path` | the Graph resource path the call addressed, host and query stripped |
| `raw` | how many messages **Graph** returned |
| `kept` | how many survived this surface's visibility gate and the since-bound |
| `since` | the window's lower bound |

`raw: 0` is Graph answering nothing. `raw` above zero with `kept: 0` is Open Everywhere's own bound
or gate dropping what Graph sent. No message text and no author name goes in the row.

`kept` is not "what the seat read". The shared catch-up path then drops the trigger message itself,
applies the domain's admission policy and caps the window by tokens, so a counted message can still
not reach the seat.

### Which boundary governs your reads

Microsoft accepts the one app-only Graph token Open Everywhere mints under **two very different
authorizations**. They are not alternatives of equal weight, and the runbook used to present them as
if they were.

| | Per-team (RSC) | Tenant-wide |
|---|---|---|
| **Permission** | `ChannelMessage.Read.Group`, granted by a team owner at install | any of `ChannelMessage.Read.All`, `Group.Read.All`, `Group.ReadWrite.All`, admin-consented on the Entra app registration |
| **What Microsoft checks** | the grant on **that team**, on every request | nothing about teams |
| **Reach** | the teams the app is installed in | **every channel message in the tenant** |
| **What holds the line** | Microsoft | only Open Everywhere's own domain allowlist (`memory/config/domains/`) — application code |

**A tenant-wide permission is boundary-REMOVING, not merely the other way to do it.** It deletes
Microsoft's per-team check. The agent's reads are then fenced by nothing but Open Everywhere's own
allowlist, so a bug or a misconfiguration in that allowlist reaches the whole tenant rather than one
team. Grant it only when RSC is genuinely unavailable to you, and know that is the trade you made.

Two of the three tenant-wide permissions are easy to hold by accident: `Group.Read.All` and
`Group.ReadWrite.All` are commonly consented for unrelated reasons, and either one gives the app
tenant-wide channel-message reach whether or not anyone intended it. Microsoft lists all three as
the higher-privileged application permissions for
[list channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages) and
[list message replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies).

**How to see which one you are on.** Open Everywhere reads the answer out of its own Graph token —
the token's `roles` claim carries the tenant-wide permissions, and an RSC grant never appears there
(RSC lives on the team resource, not on the app registration). Two places report it:

- **The ops preflight.** Run the `preflight` tool of the `open-everywhere-ops` MCP server. With
  Teams credentials in your `.env.local` it mints a token and reports a `teams: channel-read
  boundary` check — `ok` for `per-team`, `info` for `tenant-wide` with the roles to remove. With no
  Teams credentials it reports nothing. A failed mint degrades to one `info` line; the preflight
  never blocks on it.
- **The audit trail.** The deployment writes a `teams.read_boundary` row whenever the determination
  changes — on the first Graph read after a cold start, and again if you change the permissions. The
  row carries the boundary, which tenant-wide roles were found, and what is left enforcing the
  fence. Every Teams `read.refused` row also carries a `boundary` field. Both carry ids and verdicts
  only, never message content or any part of the token.

> **The detection is one-sided, on purpose.** A tenant-wide role in the token is proof the boundary
> is gone. Its absence is not proof an RSC grant exists — it means the token cannot reach past a
> team by itself, so any read that *succeeds* went through Microsoft's per-team check. A deployment
> with neither gets Graph 403s. The check is a denylist of the three roles above, so a *new*
> tenant-wide permission Microsoft adds later would read as `per-team` until the list is updated;
> there is no positive RSC signal to match instead.
- **Domain `reach` entries use the SANITIZED channel id**, not the raw Teams id. A Teams channel
  id looks like `19:abc…@thread.tacv2`; Open Everywhere's identity binding filesystem-sanitizes every
  channel/domain key (colons and `@` become `-`) before it's used as a memory/allowlist grain — the
  same sanitization Slack/Discord ids never visibly need (they're already filesystem-safe). So a
  domain listing a Teams channel should use the sanitized form, e.g.
  `"teams/<tenant-id>/19-abc-thread.tacv2"`, not the raw `19:abc@thread.tacv2` string.
- **A resource grant uses the SAME sanitized id**, for the same reason and with one addition. Write
  `teams:channel/19-abc-thread.tacv2` and `teams:person/29-1abc…`, never the raw ids — the address
  grammar refuses a second colon, so a pasted raw id fails at config load with a "malformed resource"
  error rather than in front of a member. The Teams provider restores the raw Bot Framework id at the
  transport edge, from an index it writes whenever an activity arrives. **One consequence to know:**
  a container or a person this deployment has never seen an inbound activity from cannot be restored,
  so the grant is refused out loud at send time. Grant a room the bot is in, and a person who has
  spoken to it or in one of its channels. **A granted container write starts a NEW thread in the
  channel.** A Teams channel activity arrives on one reply chain (`…;messageid=<root>`), and the
  index records the channel at BOTH grains, so the plain channel id you write in the roster is the id
  the write lands in — never whichever reply chain the bot last saw traffic in.
- **Scope, and refusals are audited.** Same allowlist as every surface: the current channel plus any
  other Teams channel the session's [memory domain](../../capabilities/memory.md) lists in
  `reach`. An out-of-scope channel is refused before any Graph call, and every refusal writes a
  `read.refused` audit row naming the (sanitized) channel id, the caller's domain and the verdict —
  ids only, never message content. Query it with `GET /control/v1/audit?since=<iso>&actions=read.refused`.
- **Ordering:** Graph's channel-messages and thread-replies endpoints support no `$orderby` and are
  observed to return messages **newest-first** (the opposite of Slack's thread-replies API) — the
  adapter always sorts by `createdDateTime` itself, so this is invisible to callers.

## Proactive routines

Scheduled [routines](../../capabilities/proactivity-and-routines.md) work on Teams — with one platform rule worth knowing: Bot Framework only allows **proactive** messages to a conversation the bot has a stored *conversation reference* for (`serviceUrl` + conversation id, captured on a prior inbound turn); there is no cold-send to an arbitrary user or channel. Open Everywhere captures that reference off every inbound activity and stores it on the routine at creation, so any routine you create in-thread posts back **into the same conversation** with nothing to configure. A routine missing its reference fails closed — it runs dry (logged, schedule held) rather than posting anywhere else. Spend caps apply to channel/group-chat routines — and to personal (1:1) chat routines too, same as Slack: a fire never gets the admin bypass, because there is no attending admin to bypass on its behalf.

**Creator eligibility at fire time.** Every clock fire re-checks the routine's creator, mirroring
Slack (see [Proactivity & routines](../../capabilities/proactivity-and-routines.md)): a creator
removed from the team channel, or whose Entra account is disabled, **skips** that one fire rather
than posting — logged as a `routine.skip` row, never a failure. Two Graph app-only permissions
drive it:

- **Room membership** — `GET /teams/{team-id}/channels/{channel-id}/members`. The **least
  privileged** application permission is `ChannelMember.Read.Group`, an **RSC** grant of the same
  family as `ChannelMessage.Read.Group`. **The shipped manifest carries it by default** (added at
  `version` `1.0.3`, paired with `ChannelMessage.Read.Group` under the same philosophy — see
  [Step 2](#step-2--package-the-teams-app)), so a new install enforces the room-membership check
  with no extra Azure configuration, on the same per-team boundary [described
  above](#which-boundary-governs-your-reads). An install that predates `1.0.3` needs the version
  bump + re-consent flow in Step 2 to pick it up — RSC grants never backfill on their own.
  `ChannelMember.Read.All` is the tenant-wide alternative, with the identical boundary trade-off.
- **Account status** — `GET /users/{aad-object-id}?$select=accountEnabled`. This one has **no RSC
  equivalent** — a directory user lookup isn't scoped to a team — so it always needs the
  tenant-wide application permission `User.Read.All`, admin-consented on the Entra app
  registration. It stays a manual, eyes-open operator step; it cannot ship in the default manifest.

Missing either permission is **not an outage**: a Graph 401/403 on either call is read as
"unresolvable", exactly like a network hiccup, and the routine keeps firing on schedule — an
unresolved check never skips a fire. `User.Read.All` still needs a deliberate grant to make its
half of the check enforce instead of silently passing through.

**The room check enforces, exactly as Slack's does.** A creator Graph confirms is no longer in the
channel stops getting that routine — the same outcome and the same `creator_removed_from_room` audit
row the Slack path writes. Only an answer the probe could not **get** lets the fire through, and
every such fire writes a `routine.eligibility_unresolved` row naming the check and the cause:

| Cause on the row | What it means | What to do |
| --- | --- | --- |
| `read_error` | The Graph call failed — a network error, a 5xx, or a 401/403 for a permission this install does not hold. | Confirm `ChannelMember.Read.Group` is consented (Step 2). |
| `team_id_unresolved` | The Bot Connector could not give this team's Microsoft 365 group id, which the Graph URL takes. | Check the Connector credential and the team's own state. |
| `roster_incomplete` | The channel roster is larger than the probe's page bound, so the creator was neither found nor ruled out. | Nothing to fix — the bound is deliberate. |
| `malformed_response` | Graph answered with something that is not a member page. | Report it; the probe refuses to guess a verdict from it. |
| `no_provider` | No Teams provider is booted. | Only reachable on a misconfigured instance. |
| `missing_ids` | The routine posts into a channel, but carries no team id or no creator Azure AD object id, so the roster cannot be asked about. | Expected on a routine created before those ids were captured. Re-create it to bring it under the check. |

Read those rows before you conclude the check is working. A fire that was **really** checked writes
none of them, so the row's presence — not its absence — is what tells you a fire went unchecked. A
**personal (1:1) chat** routine writes none either, and that is not a gap: a 1:1 chat has no channel
roster, so room membership is not a question that exists there. The account-status half still runs.

## Direct messages and the account directory

Teams is the one surface that cannot cold-address a person: a Bot Framework write needs a **regional**
`serviceUrl` and a Microsoft-minted conversation id, and both exist only on an inbound activity. Open
Everywhere therefore records a conversation reference for every inbound activity it acts on — a **1:1
chat** reference from a personal chat, keyed on the person, and a **team** reference from a channel,
keyed on the team. The rows are refreshed by later activities, because Microsoft does not promise a
tenant keeps its region, and they live in the operational store, not in configuration.

Two capabilities read that record, and both are used by [identity
linking](../../how-it-works/identity.md):

- **Direct messages.** The agent posts into a stored 1:1 chat. Where it holds none and the deployment
  has seen exactly one tenant, it opens the chat with `POST /v3/conversations` and remembers it.
- **The account directory** — "who here is called that?" — reads the Bot Connector roster
  (`pagedmembers`) of the teams it has references for. It needs no Graph permission at all: the bot's
  own credential carries it. Graph is deliberately *not* used, because Graph has no Bot Framework
  `29:` id and that is the id a Teams identity link is keyed on.

What that means for you, in three lines:

- A deployment whose bot has never been added to a **team channel** has no account directory. Add it
  to one channel and the directory works from the next message.
- **A person must have the Teams app installed in the personal scope** before the agent can open a
  1:1 chat with them. Microsoft refuses the open otherwise, and Open Everywhere reports the refusal
  with its reason rather than dropping the message.
- A deployment serving **two tenants** will not open a cold 1:1 chat for somebody it has never met —
  it refuses rather than guess which organisation the account belongs to. A single message from that
  person to the bot fixes it permanently.

## Approval cards

A governed act — a spend limit, a routine, a memory purge, any verb that needs a person's yes —
asked in a Teams **channel** posts an approval card into that channel. The card is an Adaptive Card
with **Approve** and **Reject** buttons. It posts as a new post in the channel, not inside the reply
chain that asked, and the agent says where it is.

- **The tap is authenticated.** A tap reaches the deployment as an `adaptiveCard/action` invoke on
  the same public route as a message (`/eve/v1/teams`). The route verifies the Bot Framework JWT
  before it reads the body, and it answers 401 to an unsigned or forged invoke. The token proves only
  that the Bot Framework service relayed the request to this bot; it does not bind the body, and
  every channel on the bot registration (Web Chat, Direct Line) gets the same token. So a tap counts
  only when the activity's `channelId` is `msteams`, and a tap with no tenant is refused. The card
  payload names only the pending id and the org; the person, the tenant and the room come from the
  relayed Teams activity.
- **The decision is the same as on Slack and Discord.** One decide core holds the approver tiers,
  the clicker gate, the halt check and the `approval.*` audit rows. An admin-tier card needs a person
  on a `Domain.admins` roster, written `teams/<user-id>` (the Bot Framework `29:` id). A Teams team
  owner is not an approver on that standing alone.
- **The card opens with one plain sentence** of what will happen and to whom, then the
  `Approval requested: <kind>` label and the detail — the same layout as Slack and Discord
  ([Approval cards](../../security/control-plane.md#in-slack-approvals)). Several asks from one job
  still post one Teams card each; grouping them into one card is Slack-only today.
- **What the person sees.** A decided card replaces the pending one, and a decision notice posts
  into the card's own reply chain. A notice with no tap behind it — a TTL expiry, or a card a
  routine grant released — posts as a new post in the channel instead. A refused tap — a
  non-admin on an admin-tier card, a tap from another Teams channel, a guest — shows a note to
  that person only, and the card stays live.
- **A personal or group chat cannot host the card.** It carries no channel id, so the card goes to
  a card-capable channel in the same domain (a Slack, Discord or Teams channel). With no such
  channel, or no explicit domain, the agent refuses and names the config to change.
- **No Teams room roster is read yet**, so the clicker gate cannot see a guest in the room. A kind
  that hands the clicker a live secret (`declare_webhook`) is therefore refused on a Teams tap.

The card needs no extra manifest permission: `Action.Execute` is answered by the bot itself.
Status: built and unit-tested, not yet proven on a live tenant — the
[support matrix](./support-matrix.md) cell stays 🔧 until the `S-CARD-teams` leg passes.

## Listing in the Teams admin centre

This section is written for an **agent** that drives the setup over the ops MCP server, as in
[Agent-driven setup](../agent-driven-setup.md). It takes a deployment whose Teams bot already
answers (steps 1 to 4 above) to an app that a Teams admin can find and
manage in the Teams admin centre. The operator does every step that a Microsoft console reserves for
a person. You build the package, check it, and hand over each step.

### The two routes

A Teams admin manages third-party apps and agents in the Teams admin centre, under **Teams apps →
Manage apps**. An app reaches that list in one of two ways.

| Route | Who acts | What the admin centre shows | When to use it |
| --- | --- | --- | --- |
| `org` | A Teams admin in the operator's own tenant uploads the package (**Manage apps → Upload new app**). | A custom app, for that tenant only. | One organisation runs its own agent. |
| `store` | A publisher submits the package in Partner Center. Microsoft reviews it and lists it in the Teams Store. | A store app. After the listing, it can also show **publisher attestation** and **Microsoft 365 Certification**. | Other organisations install the agent from the store. |

Both routes take the same package: a zip with `manifest.json`, `color.png` and `outline.png` at its
root. The ops tool `surface_app_package` builds that zip from this deployment's config and checks it
against the rules of the route you name.

🔴 **The app carries the operator's agent name, never the project's.** The tool refuses a package
whose name holds "Open Everywhere". On the store route it also refuses the shipped project-mark
icon files (`teams-app/color.png`, `teams-app/outline.png`, compared byte for byte); on the org
route it warns, because the mark is the default avatar of a tenant's own deployment. Set
[`identity.name`](../configuration-reference.md) in `agent/settings/settings.ts`, and put the
operator's own icons in the project, before you build.

### Before you build

Ask the operator for each item below. Do not guess any of them.

1. **The agent's name.** `identity.name` in `agent/settings/settings.ts`, at most 30 characters. On
   the store route, the name must not contain a Microsoft product name ("Teams", "Microsoft",
   "Excel" and others), must not start with a core Teams feature ("Chat", "Calendar", "Help" and
   others), and must not contain "Beta", "Dev", "Preview" or "UAT".
2. **Two icons**, saved in the project (by default `teams-app/color.png` and
   `teams-app/outline.png`). `color.png` is 192x192. `outline.png` is 32x32, a white glyph on a
   transparent background. On the store route, the two icons must show the same symbol.
3. **The policy text.** `policyPages.privacy` and `policyPages.terms` in
   `agent/settings/settings.ts`, deployed. The manifest points at `/privacy` and `/terms` on the
   deployment. An admin and a store reviewer read both pages.
4. **The developer name**: the publisher's name, at most 32 characters. On the store route it must
   be the Partner Center publisher name.
5. **The deployment's public origin**, for example `https://agent.example.com`. Not `localhost`, and
   on the store route not a domain under `azurewebsites.net`, `microsoft.com` or `onmicrosoft.com`.
6. **`MICROSOFT_APP_ID`** in `.env.local`. It is the Azure Bot's application id, not a secret.

For the **store** route, also ask for:

7. **A report contact**: an email address or an `https` URL that a person reads. The store requires
   a way for a user to report harmful AI-generated content. The tool adds it to the long
   description.
8. **The Partner ID** (Microsoft AI Cloud Partner Program ID), digits only. The store recommends it
   in `developer.mpnId`.
9. **The channel choice** — see [Channels on the store route](#channels-on-the-store-route).

### Build the package

Call the tool. For the `org` route:

```
surface_app_package {
  "surface": "teams",
  "route": "org",
  "baseUrl": "https://agent.example.com",
  "developerName": "Example Ltd"
}
```

For the `store` route, add the store inputs:

```
surface_app_package {
  "surface": "teams",
  "route": "store",
  "baseUrl": "https://agent.example.com",
  "developerName": "Example Ltd",
  "partnerId": "1234567",
  "supportContact": "ai-reports@example.com",
  "channelFeatures": "omit"
}
```

Optional inputs: `appName` overrides `identity.name`; `icons` gives other icon paths
(`{"color": "…", "outline": "…"}`, relative to the project); `version` sets the package version;
`outPath` sets where the zip goes. Every path must stay inside the project.

The reply holds `findings`. A finding with `level: "block"` stops the package: the tool writes no
file, and the reply says what to fix. A finding with `level: "warn"` does not stop it. Read every
finding to the operator. When nothing blocks, the reply holds `path` (by default
`teams-app/<name>-teams-<version>.zip`), its `sha256`, and the `steps` for the route. Git ignores
`teams-app/*.zip`: build the zip again from config when you need it.

### What the package checks

The tool checks the result, not only the inputs. Each check comes from the Teams app manifest
schema (versions 1.17 and 1.25) or from Microsoft's Teams Store validation guidelines (read
2026-10-12).

| Check | `org` | `store` |
| --- | --- | --- |
| No placeholder is left; `id`, `bots[0].botId` and `webApplicationInfo.id` are the same GUID | block | block |
| `version` is `MAJOR.MINOR.PATCH`; names and descriptions are within the schema lengths | block | block |
| The developer URLs are `https`; `accentColor` is `#RRGGBB` | block | block |
| The name is not the project's name | block | block |
| The icons are not the shipped project-mark files (byte for byte) | warn | block |
| `color.png` is a 192x192 PNG; `outline.png` is a 32x32 white-on-transparent PNG | block | block |
| `validDomains` is a bare domain that a tenant can reach | block | block |
| `validDomains` holds no wildcard and no domain the store refuses | warn | block |
| The name holds no Microsoft product name, no lead with a core Teams feature, no preproduction word | warn | block |
| `policyPages.privacy` and `policyPages.terms` are declared | warn | block |
| A channel choice is made (see below) | — | block |
| A report contact is given; the description says the app uses AI | — | block |
| A Partner ID is given | — | warn |

The package holds the three files and nothing else, because the store refuses extra files. The long
description names "Microsoft Teams" in full, and says that the agent uses AI and that a reply can be
wrong.

### Channels on the store route

From July 2026, Microsoft's store guidelines require a **channel** app to use manifest schema 1.25
or later and to declare `"supportsChannelFeatures": "tier1"`. That flag also lets a team install the
app in **shared and private channels**. The org route has no such rule, so its package stays on
schema 1.17 with the channel scope.

On the store route the operator must choose, and the tool refuses to choose for them:

- **`"omit"`** drops the `team` scope and the two channel RSC grants (`ChannelMessage.Read.Group`,
  `ChannelMember.Read.Group`). The agent works in 1:1 chats and group chats only. The package stays
  on schema 1.17.
- **`"tier1"`** keeps channels, moves the package to schema 1.25 and declares the flag. The tool
  warns, because this behaviour is not proven: Open Everywhere treats a channel that is not confirmed
  team-wide as a private surface, but no one has tested a shared channel with external members on a
  live tenant. Ask the operator to test a shared channel and a private channel before they submit.

### Hand-over: the org route

Give the operator these steps. Each needs a Teams admin.

1. Open the [Teams admin centre](https://admin.teams.microsoft.com) → **Teams apps → Manage apps →
   Upload new app**, and pick the zip.
2. On the app's **Permissions** tab, grant consent if the tenant's policy needs it. The three RSC
   grants are consented per team or per chat when someone installs the app.
3. Allow the app in an **app permission policy**. To pin it for people, add it to an **app setup
   policy**.
4. Install it in one team and one group chat, and `@mention` it in each. A reply proves the round
   trip.

An update is the same zip with a higher `version`: **Manage apps →** the app **→ Update**. A team
or chat that installed an older version keeps its old RSC grants (see the
[Teams runbook](#step-2--package-the-teams-app)).

### Hand-over: the store route

Microsoft's review is a person, not a schema check. The package passes the checks above, but the
reviewer also tests the running agent. Give the operator these steps, in order.

1. **Publisher verification** (required by the store). Mark the bot's Entra app registration as
   publisher verified: Entra → **App registrations →** the app **→ Branding & properties →
   Publisher verification**. It needs a verified Partner Center account.
2. **Bot metadata.** Make the Azure Bot resource's display name, icon, privacy URL and terms URL
   match the manifest. The reviewer compares them.
3. **Partner Center.** Create the Teams app offer (**Marketplace offers → Microsoft 365 and
   Copilot**). Use the manifest's app name, developer name, short description and long description
   exactly. Upload the same colour icon as the store icon. Add screenshots.
4. **Test notes.** Give the reviewer a test tenant and test accounts that stay valid until the app is
   live. Say what the agent does in a channel, a group chat and a 1:1 chat, and what it needs (an
   Open Everywhere deployment that the publisher runs). Before you submit, check that the agent gives
   a useful reply to "Hi", "Hello" and "Help": the store tests these words on every bot. Tell the
   operator that the replies carry no in-chat AI label, which the store requires (see below).
5. **Upload** the zip under the offer's **Packages**, and submit.
6. **After the listing**, complete **publisher attestation** in Partner Center (Microsoft 365 App
   Compliance). A new app cannot attest before it is listed. Microsoft 365 Certification is a
   separate, later audit.

An update must raise `version` and keep the same app id. When a capability changes, submit the new
package for review again.

### What the package cannot prove

These items are outside the package. The tool does not check them, and this repository has not
tested them on a live tenant.

- 🔴 **The in-chat AI disclaimer.** The store guidelines also require an AI disclaimer that is
  "clearly visible in the UI where users interact with generative AI content" (Must fix). The
  package covers only the description. Open Everywhere's Teams replies carry no AI label today, so a
  store submission can fail on this rule until the replies carry one.
- **The prompt-injection rule.** The store guidelines require safeguards against attempts to
  override the system instructions or safety controls. The reviewer judges this; the package cannot
  show it.
- The reviewer's live test of the agent, including the "Hi", "Hello" and "Help" replies.
- The match between the Azure Bot resource's metadata and the manifest.
- The agent's behaviour in shared and private channels (the `tier1` choice).
- That the two icons show the same symbol, and that the store icon in Partner Center is the colour
  icon.
- Microsoft's app recommendations in the admin centre. The ticket names a change from November 2026
  (message-centre post MC1481316) that recommends apps by usage. This page does not depend on it.

## Gotchas

- **Public endpoint is mandatory.** The Bot Framework Connector pushes activities to your messaging endpoint over HTTPS; it can't reach `localhost`. Use a tunnel for local work and update the messaging endpoint whenever the tunnel URL changes.
- **The Bot Framework SDK is archived; this transport is not.** Microsoft archived the Bot Framework SDK and the Bot Framework Emulator on GitHub, stopped maintaining them, and ends support tickets for the SDK on 31 December 2025, pointing at the Microsoft 365 Agents SDK and the Teams SDK as successors (Bot Framework basics, read 2026-09-02). **Open Everywhere does not use that SDK.** `packages/providers/teams/agent/channels/teams-connector.ts` calls the Bot Framework **Connector REST API** directly — `POST /v3/conversations/{id}/activities` and its reply and update siblings — under a client-credentials token eve mints. The Connector REST API is the Azure Bot Service protocol, and Microsoft has not archived it. So this is a long-horizon transport risk, not a defect: re-read it if Microsoft deprecates the Connector REST surface itself, or if a Teams feature we want turns out to be Agents-SDK-only.
- **Tenant ID is required.** New Azure Bots are Single-tenant (multi-tenant creation was deprecated after 31 July 2025), so you **must** set `MICROSOFT_TENANT_ID` to the app registration's Directory (tenant) ID — auth fails without it. A mismatch between the registration's tenant and your env is the most common "the bot never responds" cause. (Legacy multi-tenant bots registered before the cutoff still work and omit it.)
- **Channels default to private *and* external — and it is the EXTERNAL half that contains memory.** Because inbound activities usually omit `membershipType`, every team channel is treated as `private` **and** binds `external` trust. The `external` trust is what does the work: read-only `public` memory at most, no internal domain, no org brain. 🔴 The `private` half contains NOTHING on its own. Visibility is tracked and audited; no code reads it to gate memory (`resolveMemoryPlan` branches on mode and trust), and there is no per-channel "surface tier" for a channel's learnings to stay in. So when the Graph-API enrichment below lands and a channel positively confirms `internal`, a private channel with no domain falls straight to the org fallback and WRITES the org brain — privacy will not hold it back. This is intentional fail-closed behaviour today, for the trust reason only. To light up shared memory today, either declare the surface in `agent/identity/surfaces.ts` (the vouch above — the precise option), or set `identity.blanketTrust: "internal"` on a single-tenant deployment you vouch for, or wait for the Graph-API enrichment that positively confirms `membershipType`; until then channel memory is correct-but-conservative.
- **The app password (client secret) expires.** Entra client secrets have a finite lifetime (default ~6–24 months). When it expires the bot silently stops authenticating — rotate it in **Certificates & secrets** and update `MICROSOFT_APP_PASSWORD`.
- **A group chat answers when it is ENGAGED, and `ChatMessage.Read.Chat` alone does not engage it.** The RSC permission is necessary (without it Microsoft never delivers non-mention chat activities) but not sufficient: OE's ingress admits a plain chat message only where somebody `@mentioned` the bot in that chat and has not asked it to stop following. Granting the permission therefore does not turn every message in every chat into an agent session — which is what it used to do, before the engagement seam gated that branch. The cross-surface single window is separate and still admits `scope === "channel"` only — a group chat is a per-person surface, not an org container, and admitting one would let it join a private shared window (the same channels-only rule Slack follows). **Undirected ambient watching** — waking on messages in a room nobody invited the bot into — therefore stays a **team-channel** capability.

## End-to-end testing (Graph API driver)

The [e2e driver pack](../../../packages/core/scripts/e2e/) drives each surface with a real message and reads the reply back. Slack and Discord can inject a synthetic wake — Slack by signing a forged event with the deployment's own signing secret, Discord via a second driver bot. **Teams can't:** the Bot Framework JWT on a real inbound Activity is *Microsoft-signed*, and we don't hold the key, so there's no way to forge an event the deployment will trust. Instead the Teams driver drives a **genuine** message — it `@mentions` the bot over *delegated Microsoft Graph* (a real test user's session), which makes Azure deliver a real Activity that wakes the bot, then reads OE's reply back from the message's native reply chain. Scenario `J-TEAMS` is the repeatable version of the manual "mention it and watch it reply" check.

**One-time setup:**

1. **Register a separate Entra app** as a **public client** (this is *not* OE's bot app registration): in the app registration, **Authentication → Advanced settings → Allow public client flows → Yes**, and under **API permissions** add the *delegated* Microsoft Graph perms `ChannelMessage.Send`, `ChannelMessage.Read.All`, and `offline_access`, then have a tenant admin **Grant admin consent**. Note its **Application (client) ID**.
2. The **test user** whose session you'll authenticate must be a **member of the team** OE is installed in (the same team/channel `J-TEAMS` posts into).
3. Mint the refresh token and discover the ids — run once:

   ```bash
   export E2E_TEAMS_TENANT_ID=<directory-tenant-id>
   export E2E_TEAMS_CLIENT_ID=<the public-client app's client id>
   npm run e2e:teams-auth
   ```

   It runs a device-code sign-in (open the URL, enter the code), prints the `export E2E_TEAMS_REFRESH_TOKEN='…'` line, and lists your teams + channels so you can copy the team and channel ids. The token is printed to stdout only — it's never written to a file; paste it into your shell / CI secrets.
4. **Set the six `E2E_TEAMS_*` vars** and run the scenario:

   ```bash
   export E2E_TEAMS_TENANT_ID=<directory-tenant-id>
   export E2E_TEAMS_CLIENT_ID=<public-client app id>
   export E2E_TEAMS_REFRESH_TOKEN=<from the helper above>
   export E2E_TEAMS_TEAM_ID=<from the helper's listing>
   export E2E_TEAMS_CHANNEL_ID=<from the helper's listing>
   export E2E_TEAMS_BOT_APP_ID=<OE's MICROSOFT_APP_ID>
   E2E_ONLY=J-TEAMS npm run test:e2e-driver
   ```

   Use the `E2E_ONLY` env var to run a single scenario, not `-- --only J-TEAMS`: the root
   `test:e2e-driver` delegates to a workspace script via `npm run`, and the inner `npm`
   swallows a forwarded `--only` as its own (deprecated) config flag rather than passing it
   through — so the flag form silently runs the *whole* pack. `E2E_ONLY` bypasses npm entirely.

Without these vars the scenario self-skips (fail-closed), naming exactly what's missing — the same posture as every other driver half.

**The 1:1 DM plane (`J-TEAMS-DM`, OPE-972).** This leg drives the bot's personal (1:1) chat, not
a channel. It rides the SAME six `E2E_TEAMS_*` vars as `J-TEAMS` — no extra fixture var — but needs
two more things true of the deployment and the driver app, and derives both at RUNTIME rather than
through an env var:

1. **The driver user has OE installed in the PERSONAL scope.** Microsoft auto-provisions the 1:1
   chat only after that install exists. `resolveDmChat()` finds the install row itself
   (`GET /me/teamwork/installedApps?$expand=teamsApp`, matched on `teamsApp.externalId ===
   E2E_TEAMS_BOT_APP_ID`) — no new var carries this.
2. **The driver app's Entra registration has a `Chat.*` delegated Graph permission consented** —
   `Chat.ReadWrite`, or `ChatMessage.Send` + `Chat.Read` separately. The one-time setup above only
   grants `ChannelMessage.*` (channel messages), which is a *different* Graph permission family
   from chat messages; Graph 403s a `/chats/{id}/messages` call under either scope alone. Add the
   `Chat.ReadWrite` delegated permission to the same app registration used above and have a tenant
   admin **Grant admin consent** for it — the existing refresh token picks up the new scope on its
   next `.default` refresh, no re-auth needed.

Either gap self-skips the leg with the exact missing thing named (`ctx.skip`, never a false red) —
run `E2E_ONLY=J-TEAMS-DM npm run test:e2e-driver` and read the skip reason.

**The approval card (`S-CARD-teams`, OPE-2424).** This leg rides the same six `E2E_TEAMS_*` vars as
`J-TEAMS`, plus `E2E_TARGET_URL` and `E2E_CONTROL_READ_TOKEN` for the audit read. It has three legs:

1. **The propose.** The driver `@mentions` the bot with a governed ask (a one-shot routine), and the
   leg waits for an OE Adaptive Card in the channel whose Approve and Reject actions name one pending
   id, and for the matching `approval.requested` row.
2. **The refused forgery.** The leg POSTs an `adaptiveCard/action` invoke that carries the real card's
   Approve payload to `/eve/v1/teams`, once with no `Authorization` header and once with a self-minted
   bearer. Both must get 401, and the pending row must have no decision row afterwards.
3. **The tap.** Graph cannot press a card button, and the deployment trusts only invokes that
   Microsoft signs, so this leg needs a person in the Teams client. Set `E2E_TEAMS_CARD_TAP=manual`,
   run the leg, and tap **Reject** on the card when the log says `TAP NOW`. The leg then gates on the
   decision row (named for a `29:` principal) and on the decision notice in the card's reply chain.
   Without `E2E_TEAMS_CARD_TAP=manual` the leg SKIPS after legs 1 and 2 — it never scores green over
   a tap nobody made.

```bash
E2E_TEAMS_CARD_TAP=manual E2E_ONLY=S-CARD-teams npm run test:e2e-driver
```
