# Credential brokers

A **credential broker** is where static secrets actually come from. It's an
[adapter](./adapter-model.md), and there is **no deployment-wide selection**: several brokers are
registered at once, and each credential names the one home broker it resolves through (see
[No selection](#no-selection--every-credential-names-its-home-broker) below). This page is the
seam; how secrets are *used* (the two planes, injection vs exposure) is in
[Credentials & the two planes](../security/credentials-and-planes.md).

## The `CredentialBroker` interface

Every static secret is referenced by name (a `secretRef`), never inlined. One call,
`getSecret(ref, authorizationDetails?)`, resolves it through the active broker:

```ts
// packages/core/agent/access/credentials.ts
export interface CredentialBroker {
  getSecret(ref: string, authorizationDetails?: readonly CredentialAuthorizationDetail[]): Promise<string>;
}
```

Because there is exactly **one** broker call, and every consumer routes through it — egress
header stamping, the connector plane, the Notion memory token — re-stamping a credential moves
that secret to a different vault without touching any consumer, and nothing reads `process.env` raw.

## `env` and `db` (core) vs vendor brokers

- **`env`** — the core, zero-dependency floor. `ref` is an **environment variable name**;
  `getSecret` reads `process.env[ref]` and throws if it's missing. It implements the same
  interface as any vendor broker and registers the same way — it just ships in core because
  reading env needs no SDK. This is the always-available default for local dev, CI, and
  self-host.
- **`db`** — the other core broker: it resolves keys an operator pasted through the "Set API
  key" chat intake, encrypted at rest, and registers when its AES key
  (`OE_CREDENTIAL_ENCRYPTION_KEY`) is armed (see below).
- **A vendor broker** — a managed vault (a KMS, Vault, or a cloud secret store) implements the
  same `getSecret` interface out in `@open-everywhere/adapters` and registers when wired. Here
  `ref` is whatever that vault expects — an ARN, a Vault path. (The original built-in vendor
  broker was Vercel Connect, a managed OAuth+key vault, deleted once the own-rolled OAuth flow
  became the v1 default; OAuth token minting now lives on the connector plane's user-auth-flow —
  see [Connectors](./connectors.md) — not the `getSecret` broker seam.)

Note the key consequence: **the `ref` namespace is broker-specific.** Under `env` a ref is an
env-var name (`NOTION_TOKEN`); under a vault broker the same logical secret is whatever that
vault's ref convention is. The broker defines what a ref means.

## Credential lifetime — stored secrets vs minted ones

A broker read can also carry the secret's **lifetime**:

```ts
export interface BrokeredSecret {
  readonly value: string;
  /** Epoch ms at which the issuer says this stops working. Absent ⇒ no stated deadline. */
  readonly expiresAtMs?: number;
}
```

`getSecretWithLifetimeVia(broker, ref)` is the deadline-aware read; `getSecretVia` is the
value-only view of the **same** path. A broker only implements the optional
`getSecretWithLifetime` if it *mints* short-lived credentials and therefore knows a deadline. The
core brokers don't: an env var and an encrypted `stored_credential` row are static values, so they
report **no stated expiry** — the truth, not a placeholder. Nothing is ever re-fetched behind your
back because of this field.

The other half is the **always-warm seam** (`packages/core/agent/credentials/warm.ts`), for credentials Open
Everywhere mints *for itself* — Linear's `actor=app` token (30 days), GitHub App installation
tokens (1 hour, for both the unified reply arm and git-backed memory), the Teams Graph app-only
token (1 hour). It holds one credential per cache key,
re-mints it *ahead* of expiry, and single-flights concurrent callers so one process's parallel
turns can't stampede a vendor's token endpoint. Three postures, matching the
`ConnectorCredential.lifecycle` vocabulary:

- **`re-mint`** — fixed TTL, no refresh token: mint a fresh one from the app's own client
  credentials. Everything on the seam today. Must declare a fallback TTL, so a mint response that
  omits its expiry can never be held forever.
- **`manual-rotation`** — no automatic renewal; a value with no deadline is held for the life of
  the process.
- **`refresh-token`** — **refused** by this seam. An OAuth refresh against a stored refresh token
  needs durable, cross-process rotation safety (the encrypted KV vault's row-claim), not a
  process-local memo, so declaring it is a startup error rather than a silently wrong rhythm.

**A mint failure is loud, and a dead credential is never served.** Every failure writes a
`console.error` *and* a durable audit row, and the caller's promise rejects — there is no fallback
to the expired value it was holding. The row's action is per credential, so an operator can query
exactly one surface:

| Credential | Audit action |
| --- | --- |
| Linear `actor=app` token | `linear.token_mint_failed` |
| GitHub App installation token (unified reply arm, git-backed memory) | `github.token_mint_failed` |
| Teams Graph app-only token | `teams.token_mint_failed` |

```
GET /control/v1/audit?since=<iso>&actions=linear.token_mint_failed
```

The row carries the credential's name, its (non-secret) cache key, and the mint's own error text —
never the client secret, the private key, or the minted credential.

## Down-scoping a credential (`authorizationDetails`)

`getSecret(ref, authorizationDetails?)` carries an optional per-broker **down-scoping** hook: a
`Connection` (access/bundle.ts) can attach `authorizationDetails` to `secretRef`, and a broker
whose vault supports scoped grants narrows the minted credential accordingly. The shape is
broker-specific and untyped in core beyond a `type` discriminant (`CredentialAuthorizationDetail`,
bundle.ts) — core stays vendor-SDK-free; only a broker that understands a shape interprets it. The
core brokers (`env`, `db`) have no scoping mechanism and ignore the argument. (The one built-in
broker that consumed it — Vercel Connect, for `github_app_installation` grants — was deleted.)

## No selection — every credential names its home broker

There is **no global "selected" broker** (the `OE_CREDENTIAL_BROKER` selection was removed
2026-07-21). Every credential names its **one** home broker explicitly via its `broker` stamp
(`ConnectorCredential.broker`, `Connection.broker`: `"env" | "db" | …`), and it
resolves through **that** broker or not at all. A named broker **must be registered** — if it
isn't, `brokerFor()` / `getSecretVia()` throws rather than substituting another:

```ts
const broker = BROKERS[name];
if (!broker) throw new CredentialError(
  `credential home broker "${name}" is not registered … Refusing to fall back to another broker (fail closed).`,
);
```

An **unstamped** credential that reaches resolution also fails closed (`getSecretVia(undefined, …)`
throws) — there is no default to guess. This is deliberate: silently falling back to another broker
could inject the **wrong** secret — a coincidentally-named env var, or a stale dev value — against a
production integration.

**Registration = configured.** A broker is *available* iff it is registered, and it registers when
its backing config exists: the `env` adapter is always registered; the `db` broker registers when
its AES key (`OE_CREDENTIAL_ENCRYPTION_KEY`) is armed; a vendor broker registers when wired.

## Writing your own broker (KMS / Vault / …)

1. Implement `CredentialBroker.getSecret(ref, authorizationDetails?)` — map your `ref`
   convention to a vault lookup (an AWS Secrets Manager ARN, a Vault path, a GCP Secret
   Manager resource name). Ignore `authorizationDetails` unless your vault has an
   analogous down-scoping mechanism.
2. Register it at startup: `registerBroker("my-vault", myBroker)` (typically from your app's
   `agent/lib/register-adapters.ts`).
3. Stamp the credentials that live in it: `broker: "my-vault"` on each `ConnectorCredential` /
   `Connection` whose `secretRef` your vault owns.

Define your `secretRef` values to match whatever your broker expects, and every stamped consumer
resolves through it unchanged.

## On Vercel / Off Vercel

The credential brokers are the same everywhere: the core `env` broker (always) and the core `db`
broker (when `OE_CREDENTIAL_ENCRYPTION_KEY` is armed). The `env` broker needs no wiring — secrets
are env vars referenced by name, and env-backed credentials are stamped `broker: "env"`. Point at
your own KMS/Vault by implementing the interface, registering it, and stamping the credentials that
live there. (There is no longer a Vercel-specific managed broker — the Vercel Connect adapter was
deleted; OAuth connectors are minted by the built-in own-rolled flow on the connector plane.)
