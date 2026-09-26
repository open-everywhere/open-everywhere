# Connectors

A **connector** gives the agent a vendor's tools — a host-side MCP connection grouped under a
provider, with scoped credentials and an allowlist. It's a [per-bundle adapter](./adapter-model.md):
each provider is selected inside config-as-code. This page is *how to add one*; the
[connectors & providers](../capabilities/connectors-and-providers.md) page is the concept, and
[credentials & the two planes](../security/credentials-and-planes.md) covers where the token lives.

## What a provider groups

A **provider** is the unit you connect ("Notion", "Linear"). It groups three things:

1. a host-side **MCP connection** — the vendor's tool server;
2. the **credentials** you've configured against it — each a fixed key or an OAuth connector,
   with an id you choose (`team-readonly`, `team-rw`, …); and
3. an **allowlist** of which credential types that connection accepts (an OAuth-only MCP server
   declares `[service-oauth, user-oauth]`; one that also takes a static token adds `api-key`).

```
connector credentials "notion" {
  connector:  notion              // the host-side MCP connection slug
  allows:     [api-key, service-oauth]
  credentials:
    team-key   : api-key       (broker db, secretRef db:notion:team-key)
    team-oauth : service-oauth (connector oauth/notion-app)
}
```

A bundle grants `connectors: [{ name: "notion", credential: "team-key", contentOrigin: "external" }]`; the
[resolver](../how-it-works/access-and-scoping.md) checks the allowlist and the universe gate
and binds that credential **to this surface**, narrowest-wins.

## Defining a new MCP connection

Eve discovers a connection from the app's `agent/connections/<slug>.ts`, and the file's slug (its
filename, minus `.ts`) becomes the connection's runtime name — exactly the name a catalogue's
`connector` field and a grant's `name` reference.

🔴 **That app directory is build output, not a place to author.** `.gitignore` excludes
`/agent/connections/`, and `npm run oe:build` rewrites the directory wholesale, so a file you
write there is deleted by the next build. Author the connection in a package and declare it, the
same way [a tool or a channel](./tools.md) is declared:

1. Write the module in the package — `packages/core/agent/connections/<slug>.ts`, or
   `packages/providers/<name>/agent/connections/<slug>.ts` for a [bundle](./provider-bundles.md).
2. Declare it in that package's `agent/contributions.ts`:
   `{ kind: "connection", name: "<slug>", module: "agent/connections/<slug>.js" }`.
3. Run `npx oe build --accept` and commit `roster.lock.json`. The build writes the app's
   `agent/connections/<slug>.ts` stub.

The module itself default-exports an Eve connection:

```ts
// packages/core/agent/connections/<slug>.ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.example.com/mcp", // the vendor's hosted MCP server
  description: "…",
  // `auth` resolves the credential HOST-SIDE per call: the per-surface hard gate
  // (assertConnectorGranted, access/connector-scope.ts) runs first, then the app-principal or
  // user-principal token path — see connections/connector-auth.ts.
  auth: …,
});
```

`packages/core/agent/connections/notion.ts` is the shipped worked example. It is the only
`defineMcpClientConnection` module in core today, and it takes its `url` and `auth` from
`selectConnectorTransport(...)` rather than writing them inline, so the connection picks up the
[transport seam](./adapter-model.md#the-connector-transport-seam-is-swappable-too). The other
files under `packages/core/agent/connections/` are helper modules, not connections.

The credential never lives on the connection — a provider's `ConnectorCredential` names a
`secretRef` + `broker` (or a `home` bag for an OAuth-homed credential, or a future registered
vendor home), and resolves through the [credential broker](./credential-brokers.md) or the
connector-plane OAuth transport. There is no separate "federation" registration layer or per-org
enable list: a
connection is either declared in a package's `contributions.ts` and mounted by the roster (once,
reviewable) or it isn't; **whether any surface may actually use it** is entirely the provider/bundle grant
(`allows` + a domain/channel binding) — an ungranted surface's calls are refused fail-closed by
`assertConnectorGranted`, never by a connection-level toggle.

## The credential catalogue and allowlists

A credential's **principal** — *who the agent acts as* — is derived from its `type`
(`principalOf`, `access/connector-credentials.ts`), not a separate field you set: `api-key` and
`service-oauth` are **app**-principal (an org-shared identity, e.g. a team Notion), reachable
from **channel/domain** surfaces; `user-oauth` is **user**-principal (the calling human's own
grant), reachable **only from that person's DM**. This is structural, not advisory: the
resolver refuses to attach a user-principal credential to any channel/domain binding — a
personal login can never leak into a shared channel, and is never even offered when an admin
scopes a domain. The provider's `allows` allowlist then constrains *which credential types*
its connection accepts at all, so a bundle can't bind a credential type the vendor's server
won't honour. See [Connectors & providers](../capabilities/connectors-and-providers.md#the-credential-axis-who-the-agent-acts-as)
for the full principal/universe table.

## MCP vs REST

The two transports differ in **whose credential they carry**, and that is what picks one.

**REST is the domain's road.** It is the **egress plane**: the agent calls the REST API and the
firewall injects the ORGANISATION's own key by host, guided by a
[skill](../capabilities/skills-and-plugins.md) that carries "which endpoint, when". That is a
bundle egress grant (host + credential) plus a skill, not a provider transport — see
[credentials & the two planes](../security/credentials-and-planes.md). The whole API is on this
road, not a long tail of it.

**A connector (host-side MCP) acts as the subject on its grant.** A `user-oauth` grant carries one
person's own account and reaches what that person can see, as that person. A `workspace-oauth`
grant carries the organisation's account through the org consent. It is the vendor's curated,
agent-shaped tool set — cheap, lazily discovered.

A provider can have both, and holding one is no reason to avoid the other. Pick the road by whose
account the work belongs to. The REST skill stays the domain's primary road, and a bound
`workspace-oauth` connector is a second organisation road. Work the domain owns never goes over a
`user-oauth` connector, because that connector acts as the person. See
[MCP vs REST](../capabilities/connectors-and-providers.md#mcp-vs-rest--when-to-use-which).

## On Vercel / Off Vercel

- **Everywhere:** OAuth connectors resolve through the built-in own-rolled OAuth flow, which mints
  and refreshes tokens host-side (DCR+PKCE against the hosted MCP server, tokens in an AES vault);
  the MCP call runs entirely host-side and never enters the sandbox. Its callback seam is
  `packages/core/agent/connections/oe-oauth-callback.ts` (`registerOeOauthCallbackCompleter` and
  `OE_OAUTH_CALLBACK_PATH`, both on the adapter-api barrel), mounted as the channel
  `oe-oauth-callback`. (The original Vercel Connect adapter that filled this seam was deleted.)
- **Static-key MCP** connections work with the `env` broker (the `secretRef` is an env var) — no
  OAuth flow needed. Long-lived bearer tokens can also be supplied as static credentials.
