import { dynamicSiteKey, type DynamicEnvRead } from "./env-read-scan.js";

export type EnvClass =
  | "settings-lever"
  | "root-of-trust"
  | "store-bootstrap"
  | "platform"
  | "per-run-seam"
  | "secret"
  | "connection"
  | "pending-migration";

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

allow("root-of-trust", [
  ["DATABASE_URL", "the Postgres DSN, which carries its credentials inline. Every stored secret lives behind it."],
  ["OE_DB_OWNER_URL", "the OWNER-role Postgres DSN, the second connection string of the two-role database setup — present ⇒ the app connects as a non-owner runtime role."],
  ["OE_CREDENTIAL_ENCRYPTION_KEY", "the AES-256-GCM key the db credential broker encrypts every stored credential with. The store cannot hold the key that opens it."],
  ["OE_PUBLIC_BASE_URL", "this deployment's own public origin, which callback URLs are built from. Each environment of one app (preview, production) has its own, so a committed value would be wrong in all but one."],
]);

allow("store-bootstrap", [
  ["OE_OPERATIONAL_PROVIDER", "adapter selection: which operational store to open at boot. That store holds every operator secret, so its selector cannot live in it, and the operator skins read it with no app config loaded."],
  ["OE_SQLITE_PATH", "the sqlite file path for the memory and operational stores — where the store is."],
  ["OE_PGLITE_DIR", "the PGlite data directory — where the store is."],
  ["OE_MEMORY_DIR", "the filesystem root the sqlite and PGlite stores derive their default paths from, and the per-fork state root the integration tier sets per worker."],
  ["OE_NEON_WS_PROXY", "the local Neon WebSocket proxy host the Postgres driver reaches DATABASE_URL through (docker-compose.yml) — part of opening the store."],
]);

allow("platform", [
  ["AWS_REGION", "the standard AWS SDK region var, injected by the host or the AWS toolchain."],
  [
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "the file holding this deployment's AWS OIDC web-identity token, the standard AWS spelling a federated host injects. The host writes the file; no operator sets the value.",
  ],
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
  [
    "OTEL_EXPORTER_OTLP_HEADERS",
    "the standard OTel collector-headers var (collector auth), same convention. The ruling names OTEL_* as platform: the OTel SDK defines the name, and a host's collector integration sets it. OE_TELEMETRY_OTLP_HEADERS, this repo's own name for its own telemetry, is the one that moves to the store.",
  ],
  ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "the standard OTel traces collector-headers var, same convention and the same ruling as OTEL_EXPORTER_OTLP_HEADERS."],
  ["VERCEL_OTEL_ENDPOINTS", "Vercel's marker that this function has an OTel collector on its own host, for a Vercel OpenTelemetry integration. Vercel injects it; the adapters OTLP destination exports there with @vercel/otel's own rules (OPE-2358)."],
  ["VERCEL_OTEL_ENDPOINTS_PORT", "the port of that Vercel collector, injected by Vercel (default 4318)."],
  ["VERCEL_OTEL_ENDPOINTS_PROTOCOL", "the protocol of that Vercel collector, injected by Vercel (default http/protobuf)."],
  ["CLAUDE_PROJECT_DIR", "injected by the Claude Code harness the ops server runs inside."],
  ["INIT_CWD", "the directory where the operator ran npm, injected by npm into every script. The app-root resolver (agent/scaffold/app-root.ts, OPE-2195) starts its walk there for a workspace script."],
  ["VERCEL_URL", "the per-deployment hostname Vercel injects — the self-dispatch route builds its own callback origin from it. No operator sets it."],
  ["VERCEL_PROJECT_PRODUCTION_URL", "the project's production hostname, injected by Vercel and preferred over VERCEL_URL so a preview never dispatches to itself."],
  ["NO_PROXY", "the standard no-proxy exemption list — which network destinations bypass the proxy. `host-egress.ts` mirrors undici's own `EnvHttpProxyAgent` reading of it, so this names the host's network, not behaviour."],
  ["EVE_DOCKER_PATH", "eve's OWN variable: eve's docker-cli sandbox binding reads it to find the docker binary on this host. This repo reads it back only so the sandbox stop path and `oe upgrade` reach the same binary eve does."],
]);

allow("per-run-seam", [
  ["OE_MODE", "the binding mode stand-in, read ONLY by bindLocal — the `eve dev`/unregistered-platform mapper — and clamped to the channel/dm/mpim enum. A per-shell value for a local run."],
  ["OE_VISIBILITY", "the binding visibility stand-in, read ONLY by bindLocal, clamped to private/public. A per-shell value for a local run."],
  ["OE_PRINCIPAL", "the bindLocal principal stand-in, a per-shell value: a committed one would ship to every environment, production included (OPE-2411, see the note above). An ambient posture, not a name."],
  ["OE_APP_ROOT", "the absolute path of the deployer's app checkout that operator scripts load the app config from (agent/scaffold/app-root.ts, OPE-2195). A path for one invocation; no deployed function reads it."],
]);

allow("secret", [
  ["OE_DIRECTORY_OKTA_TOKEN_REF", "secrets bootstrap: the ref that resolves to the Okta API token."],
  ["OE_DIRECTORY_OKTA_TOKEN_BROKER", "secrets bootstrap: which broker that Okta token ref resolves through."],
]);
allow("connection", [
  ["OE_DIRECTORY_PROVIDER", "adapter selection: which directory backing to arm at boot (\"okta\", or nothing)."],
  ["OE_DIRECTORY_OKTA_ORG_URL", "the Okta org this deployment syncs against — an HTTPS target, per install."],
]);

allow("pending-migration", [
  ["DISCORD_BOT_TOKEN", "OPE-2650: → operator secret. The Discord bot token — every Discord API call authenticates with it."],
  ["GITHUB_APP_PRIVATE_KEY", "OPE-2650: → operator secret. The GitHub App's PEM private key, which mints installation tokens."],
  ["OE_GITHUB_APP_PRIVATE_KEY", "OPE-2650: → operator secret, folded into GITHUB_APP_PRIVATE_KEY. The OE-prefixed spelling `scm/config.ts` reads."],
  ["GITHUB_TOKEN", "OPE-2650: → operator secret. The personal access token a deployment signs in to GitHub with when `github.auth` is \"token\" (scm/credential.ts, OPE-2530)."],
  ["GITHUB_WEBHOOK_SECRET", "OPE-2650: → operator secret. The GitHub webhook HMAC secret."],
  ["LINEAR_AGENT_ACCESS_TOKEN", "OPE-2650: → operator secret. The Linear agent token — the credential resolver's first choice."],
  ["LINEAR_ACCESS_TOKEN", "OPE-2650: → operator secret. The second Linear token spelling the resolver accepts."],
  ["LINEAR_API_KEY", "OPE-2650: → operator secret. The third Linear token spelling the resolver accepts."],
  ["LINEAR_API_TOKEN", "OPE-2650: → operator secret. The fourth Linear token spelling the resolver accepts."],
  ["LINEAR_CLIENT_SECRET", "OPE-2650: → operator secret. The Linear OAuth client secret."],
  [
    "LINEAR_WEBHOOK_SECRET",
    "OPE-2650: → operator secret. The Linear webhook HMAC secret, verified by this repo's `linear-webhook-verify.ts`. eve's bundled handler reads the same name from env, so the move also needs eve to accept the value from the store.",
  ],
  ["SLACK_BOT_TOKEN", "OPE-2650: → operator secret. The Slack bot token."],
  ["SLACK_SIGNING_SECRET", "OPE-2650: → operator secret. The Slack request signing secret."],
  ["OE_ADMIN_STATIC_TOKEN", "OPE-2650: → operator secret. The static bearer token for the admin control plane."],
  ["OE_CONTROL_READ_TOKENS", "OPE-2650: → operator secret. The service tokens the control read route accepts."],
  [
    "OE_CONTROL_INJECT_TOKENS",
    "OPE-2650: → operator secret. The WAKE-INJECTION service tokens `POST /control/v1/test/wake` authenticates against — a disjoint family from OE_CONTROL_READ_TOKENS.",
  ],
  [
    "OE_CONTROL_OAUTH_SIGNING_SECRET",
    "OPE-2650: → operator secret. The HS256 key the control plane's own authorization server signs access tokens and authorization codes with (agent/control/oauth-tokens.ts).",
  ],
  ["OE_EGRESS_PROXY_TOKEN", "OPE-2650: → operator secret (the app side; the proxy container keeps its own env). The bearer token for the self-host egress proxy."],
  ["OE_LOG_SHIP_TOKEN", "OPE-2650: → operator secret. The bearer token for the log endpoint."],
  ["OE_TELEMETRY_OTLP_HEADERS", "OPE-2650: → operator secret. OTLP request headers — the value carries the collector's auth token."],
  ["OE_RELAY_SECRET", "OPE-2650: → operator secret (the app side; the relay process keeps its own env). The shared secret between the Discord gateway relay and this agent."],
  ["OE_AWS_WEB_IDENTITY_TOKEN", "OPE-2650: → operator secret. The inline AWS OIDC web-identity token, used where no token file exists."],
  [
    "AI_GATEWAY_API_KEY",
    "OPE-2650: → operator secret. The model gateway key. The AI SDK reads the same name from env itself, so the move hands the stored key to `createGateway({ apiKey })` in the adapter.",
  ],
  ["OE_INTAKE_PAGE_SIGNING_KEY", "OPE-2650: → operator secret (self-shared, minted in the vault). The signing secret for intake page tokens."],
  ["OE_SPAWN_DISPATCH_SECRET", "OPE-2650: → operator secret (self-shared, minted in the vault). The shared secret the self-dispatch route authenticates a spawned wake with."],
  ["OE_TRANSCRIPT_RELAY_SECRET", "OPE-2650: → operator secret (self-shared, minted in the vault). The shared secret the transcript relay route authenticates with."],

  ["DISCORD_APPLICATION_ID", "OPE-2650: → setting `discord.applicationId`. Which Discord application this deployment is; public."],
  ["DISCORD_PUBLIC_KEY", "OPE-2650: → setting `discord.publicKey`. Discord's interaction PUBLIC key, which the webhook signature check verifies against — public by design, so Git can hold it."],
  ["GITHUB_APP_ID", "OPE-2650: → setting `github.app.id`. Which GitHub App this deployment is."],
  ["OE_GITHUB_APP_ID", "OPE-2650: → setting `github.app.id`, folded into one name with GITHUB_APP_ID."],
  ["GITHUB_APP_SLUG", "OPE-2650: → setting `github.app.slug`. That App's slug, which the agent's own posts are recognised by."],
  ["OE_GITHUB_APP_SLUG", "OPE-2650: → setting `github.app.slug`, folded into one name with GITHUB_APP_SLUG."],
  ["OE_GITHUB_APP_CLIENT_ID", "OPE-2650: → setting `github.app.clientId`. The GitHub App's PUBLIC OAuth client id."],
  ["OE_GITHUB_BOT_USER_ID", "OPE-2650: → setting `github.app.botUserId`. The GitHub user id this deployment posts as."],
  ["OE_GITHUB_INSTALLATION_ID", "OPE-2650: → setting `github.installations`. Which GitHub App installation this deployment acts through."],
  ["OE_GITHUB_OWNER", "OPE-2650: → setting `github.installations`. Which owner that installation id belongs to."],
  ["OE_GITHUB_INSTALLATIONS", "OPE-2650: → setting `github.installations`. The owner-to-installation-id table, the multi-entry form of the pair above."],
  ["LINEAR_APP_NAME", "OPE-2650: → setting `linear.appName`. Which Linear app this deployment is, when no registration supplies the name."],
  ["LINEAR_APP_USER_ID", "OPE-2650: → setting `linear.appUserId`. That app's Linear user id."],
  ["LINEAR_CLIENT_ID", "OPE-2650: → setting `linear.clientId`. The Linear OAuth client id — the public half of the client credential pair."],
  ["LINEAR_ORGANIZATION_ID", "OPE-2650: → setting `linear.organizationId`. Which Linear organization this deployment is bound to."],
  ["MICROSOFT_APP_ID", "OPE-2650: → setting `teams.appId`. Which Microsoft app this deployment is."],
  ["TEAMS_APP_ID", "OPE-2650: → setting `teams.appId`, folded into one name with MICROSOFT_APP_ID."],
  ["NOTION_BOT_NAME", "OPE-2650: → setting `notion.botName`. Which Notion bot this deployment posts as."],
  ["NOTION_BOT_USER_ID", "OPE-2650: → setting `notion.botUserId`. That bot's Notion user id."],
  ["OE_AWS_SSO_CLIENT_ID", "OPE-2650: → setting `aws.ssoClientId`. The pre-registered PUBLIC OIDC client id this deployment presents at the Identity Center link."],

  ["OE_AWS_REGION", "OPE-2650: → setting `aws.region`. The operator's default AWS region."],
  ["OE_AWS_SSO_REGION", "OPE-2650: → setting `aws.ssoRegion`. The Identity Center region."],
  ["OE_ADMIN_OIDC_ISSUER", "OPE-2650: → setting `control.adminOidc.issuer`. The admin identity provider's issuer URL."],
  ["OE_ADMIN_OIDC_AUDIENCE", "OPE-2650: → setting `control.adminOidc.audience`. The audience that provider mints for this deployment."],
  ["OE_EGRESS_PROXY_URL", "OPE-2650: → setting `egress.proxyUrl`. The self-host egress proxy origin."],
  ["OE_EGRESS_SOURCE_IP", "OPE-2650: → setting `egress.sourceIp`. The fixed source IP this deployment egresses from."],
  ["OE_EGRESS_DENIAL_LOG", "OPE-2650: → setting `egress.denialLog`. Where the self-host egress proxy writes its denial log."],
  ["OE_MEMORY_PROVIDER", "OPE-2650: → setting `memory.provider`. Which memory backing to register at boot."],
  ["OE_MEMORY_GIT_BRANCH", "OPE-2650: → setting `memory.gitBranch`. Which branch the git memory backing commits to."],
  ["OE_NOTION_SECRET_BROKER", "OPE-2650: → setting `memory.notionTokenSecret` (the Notion memory token becomes a named operator secret, so the broker indirection goes)."],
  ["OE_NOTION_SECRET_REF", "OPE-2650: → setting `memory.notionTokenSecret`, the name of the operator secret that holds the Notion memory token."],
  ["OE_LOG_SHIP_URL", "OPE-2650: → setting `observability.logShip.url`. The log endpoint this deployment ships to."],
  ["OE_LOG_SHIP_TOKEN_HEADER", "OPE-2650: → setting `observability.logShip.tokenHeader`. Which header that endpoint expects the token in."],
  ["OE_LOG_SERVICE", "OPE-2650: → setting `observability.logShip.service`. The service name this deployment ships its logs under."],
  ["OE_TELEMETRY", "OPE-1153, OPE-2650: → setting `telemetry.enabled`. Turns anonymous usage telemetry on or off (DO_NOT_TRACK stays the ambient opt-out)."],
  ["OE_TELEMETRY_DEBUG", "OPE-1153, OPE-2650: → setting `telemetry.debug`. Turns telemetry debug output on or off."],
  ["OE_TELEMETRY_OTLP_URL", "OPE-2650: → setting `telemetry.url`. The telemetry collector endpoint (a full redirect)."],
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
        `is a secret, read it with getOperatorSecret() so the db store holds it. Only the root of trust, what opens ` +
        `the store, a name the host or a vendor defines, or a per-run seam belongs in scripts/env-read-allowlist.ts, ` +
        `in the matching class WITH a reason.`,
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
