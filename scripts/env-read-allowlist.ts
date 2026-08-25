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
]);

allow("connection", [
  ["DATABASE_URL", "the Postgres DSN, which carries its credentials inline."],
  ["BLOB_STORE_ID", "which Vercel Blob store this deployment writes hosted files to."],
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
]);

allow("identity", [
  ["OE_ORG", "which org this deployment is — the identity class settings.ts names as staying in env."],
  ["OE_SURFACE", "the ambient surface this process speaks as."],
  ["OE_CHANNEL", "the older spelling of OE_SURFACE, still read as its fallback."],
  ["OE_WORKSPACE", "the ambient workspace this process belongs to."],
  ["OE_MODE", "the binding mode stand-in, read ONLY by bindLocal — the `eve dev`/unregistered-platform mapper — and clamped to the channel/dm/mpim enum."],
  ["OE_VISIBILITY", "the binding visibility stand-in, read ONLY by bindLocal, clamped to private/public."],
  ["OE_AGENT_NAME", "this agent's full display name."],
  ["OE_AGENT_SHORT_NAME", "this agent's short display name."],
  ["OE_LOG_SERVICE", "the service name this deployment ships its logs under."],
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
]);

allow("platform", [
  ["AWS_REGION", "the standard AWS SDK region var, injected by the host or the AWS toolchain."],
  ["NODE_ENV", "Node's own ambient mode."],
  ["VERCEL", "Vercel's own marker that this process runs on Vercel."],
  ["VERCEL_ENV", "Vercel's deployment environment name."],
  ["VERCEL_DEPLOYMENT_ID", "Vercel's id for this deployment."],
  ["VERCEL_GIT_COMMIT_SHA", "the commit Vercel built this deployment from."],
  ["VERCEL_OIDC_TOKEN", "the OIDC token Vercel mints for this deployment — the platform sets it, no operator does."],
  ["DO_NOT_TRACK", "the cross-vendor ambient telemetry opt-out convention."],
  ["OTEL_EXPORTER_OTLP_ENDPOINT", "the standard OTel endpoint var, read by the vendored exporter's own conventions."],
  ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "the standard OTel traces endpoint var, same convention."],
  ["CLAUDE_PROJECT_DIR", "injected by the Claude Code harness the ops server runs inside."],
]);

allow("pending-migration", [
  ["OE_TRUST", "OPE-1153: not an identity — a fail-closed gate. binding.ts reads it DIRECTLY (outside the bindLocal dev stand-in) under `platform !== \"local\"`, so OE_TRUST=internal makes every unvouched DM partner internal on a real platform, and memory/domain.ts takes the same value as the vouched-internal requirement."],
  ["OE_PRINCIPAL", "OPE-1153: an ambient posture, not a name — hooks/job-posture.ts documents that this stand-in 'would read as a human is here on every fire' and deliberately reads the raw auth principal instead of routing through it."],
  ["OE_PLATFORM", "OPE-1153: not a host-injected fact — the operator-flipped override of platform detection. OE_PLATFORM=self-host makes onVercel() false, which removes the durable-memory floor in memory/provider.ts and un-refuses the egress spoof, both floors whose sibling switches are already in this backlog."],
  ["OE_ALLOW_UNVERIFIED_WEBHOOK", "OPE-1153: disarms a webhook signature check — a wall a dashboard must not lower."],
  ["OE_ALLOW_UNVERIFIED_GITHUB_WEBHOOK", "OPE-1153: the same wall on GitHub's ingress."],
  ["OE_ALLOW_UNVERIFIED_NOTION_WEBHOOK", "OPE-1153: the same wall on Notion's ingress."],
  ["OE_ADMIN_ROLE_RULES", "OPE-1153: an authorization policy carried as JSON in an env var."],
  ["OE_ADMIN_GITHUB", "OPE-1153: arms the GitHub OAuth verifier on the admin control plane."],
  ["OE_TEST_DRIVER_IDS", "OPE-1153: the identity allowlist the e2e driver is vouched for by."],
  ["OE_TEAMS_SERVICE_HOSTS", "OPE-1153: extends the trusted Teams service host list."],
  ["OE_EGRESS_SPOOF", "OPE-1153: a test valve that changes egress behaviour."],
  ["OE_ACCESS_DRY_RUN", "OPE-1153: arms or disarms the access-request writes."],
  ["OE_CREDENTIAL_BINDING_LIVE", "OPE-1153: arms the live credential-binding path."],
  ["OE_ALLOW_EPHEMERAL_MEMORY", "OPE-1153: lowers the durable-memory floor on a hosted deployment."],
  ["OE_ALLOW_EPHEMERAL_OPERATIONAL", "OPE-1153: lowers the durable-store floor on a hosted deployment."],
  ["OE_ALLOW_TEST_NETWORK", "OPE-1153: a test valve read by runtime routine code."],
  ["OE_MEMORY_EVAL", "OPE-1153: an eval-harness valve that reshapes the runtime domain set."],
  ["OE_DM_SEAT_ROTATE_EXPIRY_DAYS", "OPE-1153: a DM seat rotation clock. Live — dmSeatThresholds() reads it."],
  ["OE_DM_SEAT_ROTATE_QUIET_GAP_HOURS", "OPE-1153: a DM seat rotation clock. Live — dmSeatThresholds() reads it."],
  ["OE_DM_SEAT_ROTATE_TOKEN_BUDGET", "OPE-1153: a DM seat rotation backstop. Live — dmSeatThresholds() reads it."],
  ["OE_DM_SEAT_ROTATE_TURN_BUDGET", "OPE-1153: a DM seat rotation backstop. Live — dmSeatThresholds() reads it."],
  ["OE_SUPERVISOR_BACKSCROLL_REACHBACK_HOURS", "OPE-1153: the ambient-surface backscroll reach-back window."],
  ["OE_FORCE_MODEL", "OPE-1153: model policy, which the settings model stack already owns a home for."],
  ["OE_PRIMARY_MODEL", "OPE-1153: model policy, with the same home waiting."],
  ["OE_NOTION_MAX_DEPTH", "OPE-1153: a traversal cap."],
  ["OE_NOTION_MAX_PAGES", "OPE-1153: a traversal cap."],
  ["OE_NOTION_TTL_MS", "OPE-1153: a cache lifetime."],
  ["OE_LOG_SHIP_BATCH_MAX", "OPE-1153: a shipper batch size."],
  ["OE_LOG_SHIP_FLUSH_MS", "OPE-1153: a shipper flush interval."],
  ["OE_WEBHOOK_MAX_BODY_BYTES", "OPE-1153: an ingress body cap."],
  ["OE_WEBHOOK_MAX_SKEW_SECONDS", "OPE-1153: an ingress clock-skew tolerance."],
  ["OE_TIDY_ORGS", "OPE-1153: which orgs the tidy schedule runs for."],
  ["NOTION_VERSION", "OPE-1153: an API version pin, which is a product decision rather than a per-install fact."],
  ["OE_TELEMETRY", "OPE-1153: turns telemetry on or off."],
  ["OE_TELEMETRY_DEBUG", "OPE-1153: turns telemetry debug output on or off."],
]);

export const ENV_READ_ALLOWLIST: EnvAllowlist = ALLOWLIST;

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
