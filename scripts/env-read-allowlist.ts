import { dynamicSiteKey, type DynamicEnvRead } from "./env-read-scan.js";

export type EnvClass = "settings-lever" | "secret" | "connection" | "identity" | "platform" | "pending-migration";

export interface AllowEntry {
  readonly klass: EnvClass;
  readonly why: string;
}

export type EnvAllowlist = ReadonlyMap<string, AllowEntry>;

const ALLOWLIST = new Map<string, AllowEntry>();

function allow(klass: EnvClass, entries: readonly (readonly [string, string])[]): void {
  for (const [name, why] of entries) {
    if (ALLOWLIST.has(name)) throw new Error(`env-read-allowlist: duplicate entry for ${name}`);
    ALLOWLIST.set(name, { klass, why });
  }
}

allow("settings-lever", []);

allow("secret", [
  ["DISCORD_BOT_TOKEN", "the Discord bot token — every Discord API call authenticates with it."],
  ["DISCORD_PUBLIC_KEY", "Discord's interaction public key, which the webhook signature check verifies against."],
  ["GITHUB_APP_PRIVATE_KEY", "the GitHub App's PEM private key, which mints installation tokens."],
  ["GITHUB_TOKEN", "the personal access token the approval and PR paths act with."],
  ["GITHUB_WEBHOOK_SECRET", "the GitHub webhook HMAC secret."],
  ["LINEAR_AGENT_ACCESS_TOKEN", "the Linear agent token — the credential resolver's first choice."],
  ["LINEAR_ACCESS_TOKEN", "the second Linear token spelling the resolver accepts."],
  ["LINEAR_API_KEY", "the third Linear token spelling the resolver accepts."],
  ["LINEAR_API_TOKEN", "the fourth Linear token spelling the resolver accepts."],
  ["LINEAR_CLIENT_SECRET", "the Linear OAuth client secret."],
  ["SLACK_BOT_TOKEN", "the Slack bot token."],
  ["SLACK_SIGNING_SECRET", "the Slack request signing secret."],
  ["OE_ADMIN_STATIC_TOKEN", "the static bearer token for the admin control plane."],
  ["OE_CONTROL_READ_TOKENS", "the service tokens the control read route accepts."],
  ["OE_EGRESS_PROXY_TOKEN", "the bearer token for the self-host egress proxy."],
  ["OE_LOG_SHIP_TOKEN", "the bearer token for the log endpoint."],
  ["OE_RELAY_SECRET", "the shared secret between the Discord gateway relay and this agent."],
  ["OE_TELEMETRY_OTLP_HEADERS", "OTLP request headers — the value carries the collector's auth token."],
  ["OE_NOTION_SECRET_BROKER", "secrets bootstrap: which broker holds the Notion memory token."],
  ["OE_NOTION_SECRET_REF", "secrets bootstrap: the ref that broker resolves to the Notion memory token."],
  [
    "OE_CONTROL_OAUTH_SIGNING_SECRET",
    "the HS256 key the control plane's own authorization server signs access tokens and authorization codes with, and the resource server verifies them against (agent/control/oauth-tokens.ts). Infrastructure, not a roster: the clients, their secret DIGESTS and the allowed audiences are tracked literals in agent/control/oauth-clients.ts and change by pull request. Rotating this value revokes every outstanding token at once.",
  ],
  [
    "OE_CONTROL_INJECT_TOKENS",
    "the WAKE-INJECTION service tokens `POST /control/v1/test/wake` authenticates against — a disjoint family from OE_CONTROL_READ_TOKENS, and the sharper of the two (injection is a write and a spoofing vector).",
  ],
  [
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "secrets bootstrap: the file holding this deployment's AWS OIDC web-identity token, the standard AWS spelling a federated host injects.",
  ],
  ["OE_AWS_WEB_IDENTITY_TOKEN", "the inline AWS OIDC web-identity token, used where no token file exists."],
  ["OE_DIRECTORY_OKTA_TOKEN_REF", "secrets bootstrap: the ref that resolves to the Okta API token."],
  ["OE_DIRECTORY_OKTA_TOKEN_BROKER", "secrets bootstrap: which broker that Okta token ref resolves through."],
  ["OE_CREDENTIAL_ENCRYPTION_KEY", "the AES-256-GCM key the db credential broker encrypts every stored credential with."],
  ["OE_INTAKE_PAGE_SIGNING_KEY", "the signing secret for intake page tokens — absent, both page routes 404."],
  ["AI_GATEWAY_API_KEY", "the model gateway key — the quickstart preflight checks its presence, and every inference call authenticates with it."],
  ["LINEAR_WEBHOOK_SECRET", "the Linear webhook HMAC secret, verified by this repo's own `linear-webhook-verify.ts` as well as by eve's bundled handler."],
  ["OE_GITHUB_APP_PRIVATE_KEY", "the GitHub App PEM this deployment mints installation tokens with — the OE-prefixed spelling `scm/config.ts` reads."],
  ["OE_SPAWN_DISPATCH_SECRET", "the shared secret the self-dispatch route authenticates a spawned wake with."],
  ["OE_TRANSCRIPT_RELAY_SECRET", "the shared secret the transcript relay route authenticates with."],
]);

allow("connection", [
  ["DATABASE_URL", "the Postgres DSN, which carries its credentials inline."],
  ["EVE_DOCKER_PATH", "where the docker binary sits on this host."],
  ["OE_AI_GATEWAY_URL", "the model gateway base URL."],
  ["OE_NEON_WS_PROXY", "the Neon WebSocket proxy host."],
  ["OE_MEMORY_DIR", "the filesystem root of the git memory backing."],
  ["OE_SQLITE_PATH", "the sqlite file path for the memory and operational stores."],
  ["OE_PGLITE_DIR", "the PGlite data directory."],
  ["OE_PUBLIC_BASE_URL", "this deployment's own public origin, which callback URLs are built from."],
  ["OE_LOG_SHIP_URL", "the log endpoint this deployment ships to."],
  ["OE_LOG_SHIP_TOKEN_HEADER", "which header that endpoint expects the token in — part of its wire contract."],
  ["OE_TELEMETRY_OTLP_URL", "the OTLP collector endpoint."],
  ["OE_EGRESS_PROXY_URL", "the self-host egress proxy origin."],
  ["OE_EGRESS_SOURCE_IP", "the fixed source IP this deployment egresses from — a host fact, not a policy."],
  ["OE_MEMORY_GIT_BRANCH", "which branch the git memory backing commits to."],
  ["OE_MEMORY_PROVIDER", "adapter selection: which memory backing to register at boot."],
  ["OE_OPERATIONAL_PROVIDER", "adapter selection: which operational store to register at boot."],
  ["OE_CREDENTIAL_BINDINGS_PATH", "where the generated credential-binding table lives."],
  ["OE_ACCESS_CONFIG_REPO", "which repo holds this deployment's config-as-code."],
  ["OE_ACCESS_CONFIG_BASE", "the base branch of that config repo."],
  ["OE_ACCESS_GRANTS_PATH", "where the generated grant table lives in that repo."],
  ["OE_AGENTS_PATH", "where the generated agent roster lives in that repo."],
  ["OE_WEBHOOK_HOOKS_PATH", "where the generated webhook table lives in that repo."],
  ["OE_ACCESS_ADMIN_CHANNEL", "the channel access requests are posted to — a wiring target, per install."],
  ["OE_ADMIN_OIDC_ISSUER", "the admin identity provider's issuer URL."],
  ["OE_ADMIN_OIDC_AUDIENCE", "the audience that provider mints for this deployment."],
  ["OE_AWS_REGION", "the operator's default AWS region — which regional endpoints a mint and a CLI call reach."],
  ["OE_AWS_SSO_REGION", "the Identity Center region, where the SSO OIDC and portal endpoints live."],
  ["OE_DIRECTORY_PROVIDER", "adapter selection: which directory backing to arm at boot (\"okta\", or nothing)."],
  ["OE_DIRECTORY_OKTA_ORG_URL", "the Okta org this deployment syncs against — an HTTPS target, per install."],
  ["OE_DB_OWNER_URL", "the OWNER-role Postgres DSN, the second connection string of the two-role database setup — present ⇒ the app connects as a non-owner runtime role."],
  ["NO_PROXY", "the standard no-proxy exemption list — which network destinations bypass the proxy. `host-egress.ts` mirrors undici's own `EnvHttpProxyAgent` reading of it, so this names destinations, not behaviour."],
  ["OE_EGRESS_DENIAL_LOG", "where the self-host egress proxy writes its denial log — a filesystem path on a shared volume, per install."],
  ["OE_GITHUB_INSTALLATION_ID", "which GitHub App INSTALLATION this deployment acts through — a wiring target, per install."],
  ["OE_GITHUB_OWNER", "which owner that installation id belongs to; the pair builds the one-entry installation table."],
  ["OE_GITHUB_INSTALLATIONS", "the owner-to-installation-id table, for a deployment installed into several orgs — the multi-entry form of the pair above."],
  ["OE_APP_ROOT", "the absolute path of the deployer's app checkout that operator scripts load the app config from (agent/scaffold/app-root.ts, OPE-2195). A path; no deployed function reads it."],
]);

allow("identity", [
  ["OE_MODE", "the binding mode stand-in, read ONLY by bindLocal — the `eve dev`/unregistered-platform mapper — and clamped to the channel/dm/mpim enum."],
  ["OE_VISIBILITY", "the binding visibility stand-in, read ONLY by bindLocal, clamped to private/public."],
  ["OE_LOG_SERVICE", "the service name this deployment ships its logs under."],
  ["DISCORD_APPLICATION_ID", "which Discord application this deployment is — the id every application-command route is addressed to, and the public half of the DISCORD_BOT_TOKEN pair. The GUILDS it registers into are NOT here: they are tracked literals in agent/commands/discord-commands.ts (OPE-1687)."],
  ["OE_GITHUB_APP_ID", "the GitHub App id the surface credential probe checks for presence."],
  ["GITHUB_APP_ID", "which GitHub App this deployment is."],
  ["GITHUB_APP_SLUG", "that App's slug, which the agent's own posts are recognised by."],
  ["LINEAR_APP_NAME", "which Linear app this deployment is, when no registration supplies the name."],
  ["LINEAR_APP_USER_ID", "that app's Linear user id."],
  ["LINEAR_CLIENT_ID", "the Linear OAuth client id — the public half of the client credential pair."],
  ["LINEAR_ORGANIZATION_ID", "which Linear organization this deployment is bound to."],
  ["MICROSOFT_APP_ID", "which Microsoft app this deployment is."],
  ["TEAMS_APP_ID", "the Teams spelling of that same app identity."],
  ["NOTION_BOT_NAME", "which Notion bot this deployment posts as."],
  ["NOTION_BOT_USER_ID", "that bot's Notion user id."],
  [
    "OE_AWS_SSO_CLIENT_ID",
    "the pre-registered PUBLIC OIDC client id this deployment presents at the Identity Center link — the same class as LINEAR_CLIENT_ID, the public half of a client pair.",
  ],
  ["OE_GITHUB_APP_CLIENT_ID", "the GitHub App's PUBLIC OAuth client id — the same class as LINEAR_CLIENT_ID, the public half of a client pair."],
  ["OE_GITHUB_APP_SLUG", "that App's slug, which the agent recognises its own posts by."],
  ["OE_GITHUB_BOT_USER_ID", "the GitHub user id this deployment posts as."],
]);

allow("platform", [
  ["AWS_REGION", "the standard AWS SDK region var, injected by the host or the AWS toolchain."],
  ["NODE_ENV", "Node's own ambient mode."],
  ["VERCEL", "Vercel's own marker that this process runs on Vercel."],
  ["VERCEL_ENV", "Vercel's deployment environment name."],
  ["VERCEL_DEPLOYMENT_ID", "Vercel's id for this deployment."],
  ["VERCEL_GIT_COMMIT_SHA", "the commit Vercel built this deployment from."],
  ["DO_NOT_TRACK", "the cross-vendor ambient telemetry opt-out convention."],
  ["OTEL_EXPORTER_OTLP_ENDPOINT", "the standard OTel endpoint var. The adapters OTLP destination (packages/adapters/agent/instrumentation.ts) reads it with the OTel SDK's own conventions."],
  ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "the standard OTel traces endpoint var, same convention."],
  ["OTEL_EXPORTER_OTLP_PROTOCOL", "the standard OTel protocol var, same convention."],
  ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "the standard OTel traces protocol var, same convention."],
  ["OTEL_EXPORTER_OTLP_HEADERS", "the standard OTel collector-headers var (collector auth), same convention."],
  ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "the standard OTel traces collector-headers var, same convention."],
  ["CLAUDE_PROJECT_DIR", "injected by the Claude Code harness the ops server runs inside."],
  ["INIT_CWD", "the directory where the operator ran npm, injected by npm into every script. The app-root resolver (agent/scaffold/app-root.ts, OPE-2195) starts its walk there for a workspace script."],
  ["VERCEL_URL", "the per-deployment hostname Vercel injects — the self-dispatch route builds its own callback origin from it. No operator sets it."],
  ["VERCEL_PROJECT_PRODUCTION_URL", "the project's production hostname, injected by Vercel and preferred over VERCEL_URL so a preview never dispatches to itself."],
]);

allow("pending-migration", [
  ["OE_PRINCIPAL", "OPE-2411: the bindLocal principal stand-in, left in env deliberately — a committed value would ship to every environment, production included (see the note above). An ambient posture, not a name."],
  ["OE_TELEMETRY", "OPE-1153: turns telemetry on or off."],
  ["OE_TELEMETRY_DEBUG", "OPE-1153: turns telemetry debug output on or off."],
]);

export const ENV_READ_ALLOWLIST: EnvAllowlist = ALLOWLIST;

const DYNAMIC_SITES = new Map<string, string>([
  [
    "packages/core/agent/access/credentials.ts::ref",
    "an operator-authored credential ref resolved through the env broker — the name is config data, not a name this repo can carry.",
  ],
  [
    "packages/core/agent/credentials/operator-secrets.ts::name",
    "an operator secret looked up by the name the operator gave it.",
  ],
  [
    "packages/core/agent/credentials/self-secrets.ts::name",
    "the agent's own secret lookup, keyed by the same operator-given name.",
  ],
  [
    "packages/providers/linear/agent/channels/linear-credentials.ts::name",
    "`linearAppRegistry` sweeping `Object.keys(env)` for the multi-app slot ids — the key it tests is every name the process happens to carry, so no scanner resolves it. The slot family it looks for is the same runtime-built one the three template-literal sites below cover.",
  ],
  [
    "packages/providers/linear/agent/channels/linear-credentials.ts::`${APP_SLOT_PREFIX}${slot}_CLIENT_ID`",
    "a multi-app SLOT key — the slot id is deployment data, so the full variable name only exists at runtime.",
  ],
  [
    "packages/providers/linear/agent/channels/linear-credentials.ts::`${APP_SLOT_PREFIX}${slot}_CLIENT_SECRET`",
    "the client-secret half of that same runtime slot key.",
  ],
  [
    "packages/providers/linear/agent/channels/linear-credentials.ts::`${APP_SLOT_PREFIX}${slot}_WEBHOOK_SECRET`",
    "the webhook-secret half of that same runtime slot key.",
  ],
  [
    "packages/adapters/agent/aws/cli.ts::k",
    "the AWS CLI child-env builder copying its literal CHILD_ENV_PASSTHROUGH list plus LC_* locale keys out of this process — a deny-by-default copy, never a config read.",
  ],
  [
    "packages/providers/teams/agent/ops.ts::k",
    "the Teams preflight's `pick(env, ...keys)` helper walking the literal key list its caller passes. 🔴 The names reached this way are NOT inventoried — MICROSOFT_APP_PASSWORD, TEAMS_APP_PASSWORD, MICROSOFT_TENANT_ID and TEAMS_TENANT_ID have no allowlist entry, because no arm resolves a call-site argument list. Closing that needs call-site resolution, which OPE-1212 carries with the alias half.",
  ],
  [
    "packages/core/agent/access/host-egress.ts::names[0]",
    "the proxy-variable pair chosen by protocol. The pair holds BOTH spellings — the lowercase `https_proxy`/`http_proxy`, outside the `[A-Z][A-Z0-9_]*` shape either arm covers, and the uppercase HTTPS_PROXY/HTTP_PROXY, which are name-shaped and reached only through this index. So this excuse covers a real uppercase read, not just a lowercase one.",
  ],
  [
    "packages/core/agent/access/host-egress.ts::key",
    "the winner of that same lowercase-beats-uppercase choice, read one line later, with the same two spellings behind it.",
  ],
]);

export const DYNAMIC_ENV_READ_SITES: ReadonlyMap<string, string> = DYNAMIC_SITES;

const MIN_REASON_LENGTH = 10;

export function auditEnvReads(reads: ReadonlyMap<string, readonly string[]>, allowlist: EnvAllowlist = ENV_READ_ALLOWLIST): string[] {
  const out: string[] = [];

  for (const [name, where] of [...reads].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (allowlist.has(name)) continue;
    out.push(
      `ENV READ NOT ALLOWLISTED: the runtime reads process.env.${name} (${where[0] ?? "unknown file"}) but nothing ` +
        `allows it. If it is a behaviour knob, move it to settings/config — add the setting to ` +
        `packages/core/agent/settings/settings.ts, read it with getSettings(), and run npm run docs:generate. If it ` +
        `is genuinely a secret, a connection target, this deployment's identity, or a fact the host injects, add it ` +
        `to the matching class in scripts/env-read-allowlist.ts WITH a reason.`,
    );
  }

  for (const [name, entry] of allowlist) {
    if (!reads.has(name)) {
      out.push(
        `STALE ALLOWLIST ENTRY: ${name} is allowlisted in scripts/env-read-allowlist.ts (${entry.klass}) but nothing ` +
          `in the runtime reads it any more — delete the entry.`,
      );
      continue;
    }
    if (entry.why.trim().length < MIN_REASON_LENGTH) {
      out.push(
        `UNREASONED ALLOWLIST ENTRY: ${name} is allowlisted in scripts/env-read-allowlist.ts (${entry.klass}) with no ` +
          `stated reason. Say why this name is env rather than settings, or move it to settings/config.`,
      );
    }
    if (entry.klass === "pending-migration" && !/OPE-\d+/.test(entry.why)) {
      out.push(
        `UNTICKETED PENDING MIGRATION: ${name} is held as pending-migration in scripts/env-read-allowlist.ts but its ` +
          `reason names no OPE ticket. File one and name it, or move the knob to settings/config.`,
      );
    }
  }

  return out;
}

export function auditDynamicEnvReads(
  sites: readonly DynamicEnvRead[],
  allowlist: ReadonlyMap<string, string> = DYNAMIC_ENV_READ_SITES,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const site of [...sites].sort((a, b) => dynamicSiteKey(a).localeCompare(dynamicSiteKey(b)))) {
    const key = dynamicSiteKey(site);
    seen.add(key);
    if (allowlist.has(key)) continue;
    out.push(
      `DYNAMIC ENV READ NOT ALLOWLISTED: ${site.file}:${site.line} reads the environment with a key this gate cannot ` +
        `resolve to a name (\`${site.expr}\`), so no allowlist entry can cover the variable it reaches. If the key IS a ` +
        `name, read it through a module-level \`const X = "NAME"\` (or an exported one) so the scan resolves it and the ` +
        `name joins the allowlist in scripts/env-read-allowlist.ts. If the key is genuinely runtime data — an operator ` +
        `secret ref, a credential slot — add "${key}" to DYNAMIC_ENV_READ_SITES in scripts/env-read-allowlist.ts WITH a ` +
        `reason.`,
    );
  }

  for (const [key, why] of allowlist) {
    if (!seen.has(key)) {
      out.push(
        `STALE DYNAMIC SITE: "${key}" is excused in scripts/env-read-allowlist.ts but no such env read exists any ` +
          `more — delete the entry.`,
      );
      continue;
    }
    if (why.trim().length < MIN_REASON_LENGTH) {
      out.push(
        `UNREASONED DYNAMIC SITE: "${key}" is excused in scripts/env-read-allowlist.ts with no stated reason. Say why ` +
          `the key cannot be a name, or write the read so the scan resolves it.`,
      );
    }
  }

  return out;
}
