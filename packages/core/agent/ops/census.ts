import { connectorGrantCredential, connectorGrantName, type Bundle } from "../access/bundle.js";
import type { ConnectorCredential, ConnectorCredentials } from "../access/connector-credentials.js";
import type { CredentialBoundDomain } from "../access/domain-credentials.js";
import { CONTROL_OAUTH_ISSUER } from "../control/oauth-clients.js";
import { controlOAuthIssuer } from "../control/oauth-resource.js";
import { OAUTH_SIGNING_SECRET_ENV, oauthSigningSecret } from "../control/oauth-tokens.js";
import type { WebhookHook } from "../webhooks/config.js";

export interface CensusCredential {
  readonly ref: string;
  readonly reason: string;
}

export interface PlumbingCredential {
  readonly connector: string;
  readonly credentialId: string;
  readonly reason: string;
}

export interface CredentialPlanInput {
  readonly bundles: readonly Bundle[];
  readonly catalogues: readonly ConnectorCredentials[];
  readonly domains: readonly (CredentialBoundDomain & { readonly name: string })[];
  readonly hooks: readonly WebhookHook[];
  readonly plumbing: readonly PlumbingCredential[];
}

export interface CredentialPlan {
  readonly required: readonly CensusCredential[];
  readonly declaredOnly: readonly CensusCredential[];
  readonly problems: readonly string[];
}

function catalogueCredential(
  catalogues: readonly ConnectorCredentials[],
  connector: string,
  credentialId: string,
): ConnectorCredential | undefined {
  return catalogues.find((c) => c.connector === connector)?.credentials.find((c) => c.id === credentialId);
}

function dbRefOf(credential: ConnectorCredential): string | undefined {
  if (credential.broker !== "db") return undefined;
  const ref = credential.secretRef?.trim();
  return ref && ref.length > 0 ? ref : undefined;
}

export function planRequiredCredentials(input: CredentialPlanInput): CredentialPlan {
  const reasons = new Map<string, string[]>();
  const problems: string[] = [];
  const add = (ref: string, reason: string): void => {
    const list = reasons.get(ref);
    if (list) {
      if (!list.includes(reason)) list.push(reason);
      return;
    }
    reasons.set(ref, [reason]);
  };
  const viaCatalogue = (connector: string, credentialId: string, reason: string, where: string): void => {
    const credential = catalogueCredential(input.catalogues, connector, credentialId);
    if (!credential) {
      problems.push(`${where} names credential "${credentialId}", which connector "${connector}" does not configure`);
      return;
    }
    const ref = dbRefOf(credential);
    if (ref) add(ref, reason);
  };

  for (const bundle of input.bundles) {
    for (const connection of bundle.connections ?? []) {
      if (connection.broker !== "db") continue;
      const ref = connection.secretRef?.trim();
      if (ref) add(ref, `bundle "${bundle.name}" egress connection "${connection.id}"`);
    }
    for (const grant of bundle.connectors ?? []) {
      const name = connectorGrantName(grant);
      const credential = connectorGrantCredential(grant);
      if (credential === undefined) {
        problems.push(`bundle "${bundle.name}" grants connector "${name}" without naming a credential, so the resolver binds nothing`);
        continue;
      }
      viaCatalogue(
        name,
        credential,
        `bundle "${bundle.name}" grants connector "${name}" as "${credential}"`,
        `bundle "${bundle.name}"`,
      );
    }
  }

  for (const domain of input.domains) {
    for (const binding of domain.credentials ?? []) {
      viaCatalogue(
        binding.connector,
        binding.use,
        `domain "${domain.name}" binds "${binding.connector}"/"${binding.credential}" to "${binding.use}"`,
        `domain "${domain.name}"`,
      );
    }
  }

  for (const hook of input.hooks) {
    if (hook.broker !== "db") continue;
    const refs = Array.isArray(hook.secretRef) ? hook.secretRef : [hook.secretRef];
    for (const raw of refs) {
      const ref = typeof raw === "string" ? raw.trim() : "";
      if (ref) add(ref, `webhook hook "${hook.id}" signing secret`);
    }
  }

  for (const entry of input.plumbing) {
    viaCatalogue(entry.connector, entry.credentialId, entry.reason, `provider plumbing "${entry.connector}"`);
  }

  const required = [...reasons.entries()]
    .map(([ref, list]) => ({ ref, reason: list.join("; ") }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  const declaredOnly: CensusCredential[] = [];
  for (const catalogue of input.catalogues) {
    for (const credential of catalogue.credentials) {
      const ref = dbRefOf(credential);
      if (!ref || reasons.has(ref)) continue;
      declaredOnly.push({
        ref,
        reason: `declared by connector "${catalogue.connector}" as "${credential.id}" — no grant, binding or plumbing names it`,
      });
    }
  }
  declaredOnly.sort((a, b) => a.ref.localeCompare(b.ref));

  return { required, declaredOnly, problems };
}

export interface MountedRoute {
  readonly channel: string;
  readonly method: string;
  readonly path: string;
}

export interface CensusEndpoint {
  readonly method: "POST";
  readonly path: string;
  readonly reason: string;
  readonly meaning: string;
  readonly expect: "mounted" | "absent";
}

export interface SkippedRoute {
  readonly method: string;
  readonly path: string;
  readonly channel: string;
  readonly reason: string;
}

export interface EndpointPlan {
  readonly endpoints: readonly CensusEndpoint[];
  readonly skipped: readonly SkippedRoute[];
}

const WEBHOOK_ROUTE = "/webhooks/:id";

export interface ChannelArming {
  readonly channel: string;
  readonly armed: (env: NodeJS.ProcessEnv) => boolean;
  readonly darkReason: string;
}

export const ROUTE_ARMING: readonly ChannelArming[] = [
  {
    channel: "control-mcp.ts",
    armed: (env) => oauthSigningSecret(env) !== null && controlOAuthIssuer(CONTROL_OAUTH_ISSUER) !== null,
    darkReason:
      `dark by declaration: the control OAuth plane answers 404 on every route until ${OAUTH_SIGNING_SECRET_ENV} is set ` +
      `(at least 32 characters) AND a valid issuer is declared in agent/control/oauth-clients.ts. One of the two is absent ` +
      `here, so this route's 404 is the shipped design, not a missing mount. Arm both and the census requires it again.`,
  },
];

export function planRequiredEndpoints(input: {
  readonly routes: readonly MountedRoute[];
  readonly hooks: readonly WebhookHook[];
  readonly controlHookId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly arming?: readonly ChannelArming[];
}): EndpointPlan {
  const endpoints: CensusEndpoint[] = [];
  const skipped: SkippedRoute[] = [];
  const env = input.env ?? process.env;
  const darkChannels = new Set(
    (input.arming ?? ROUTE_ARMING).filter((entry) => !entry.armed(env)).map((entry) => entry.channel),
  );
  const darkReason = new Map((input.arming ?? ROUTE_ARMING).map((entry) => [entry.channel, entry.darkReason]));
  let controlHookId = input.controlHookId;
  while (input.hooks.some((h) => h.id === controlHookId)) controlHookId = `${controlHookId}-x`;
  const pageRoute = (route: MountedRoute): boolean =>
    input.routes.some((r) => r.channel === route.channel && r.path === route.path && r.method.toUpperCase() === "GET");

  for (const route of input.routes) {
    if (route.method.toUpperCase() !== "POST") continue;

    if (darkChannels.has(route.channel)) {
      skipped.push({
        method: route.method,
        path: route.path,
        channel: route.channel,
        reason: darkReason.get(route.channel) ?? "dark by declaration",
      });
      continue;
    }

    if (route.path === WEBHOOK_ROUTE) {
      for (const hook of input.hooks) {
        endpoints.push({
          method: "POST",
          path: `/webhooks/${hook.id}`,
          reason: `webhook hook "${hook.id}" is declared in agent/webhooks/hooks.ts`,
          meaning: "an unsigned delivery to a declared hook is refused; a 404 means this deployment does not carry the declaration",
          expect: "mounted",
        });
      }
      endpoints.push({
        method: "POST",
        path: `/webhooks/${controlHookId}`,
        reason: "negative control — this hook id is declared nowhere",
        meaning: "an undeclared hook id must 404; any other answer means every id answers, and the hook probes above prove nothing",
        expect: "absent",
      });
      continue;
    }

    if (pageRoute(route)) {
      skipped.push({
        method: route.method,
        path: route.path,
        channel: route.channel,
        reason: "a token-gated page route — it answers 404 without its signed token, so a bare probe cannot tell mounted from absent",
      });
      continue;
    }

    if (route.path.includes(":")) {
      skipped.push({
        method: route.method,
        path: route.path,
        channel: route.channel,
        reason: "a parameterised route — the census cannot synthesise a valid path parameter",
      });
      continue;
    }

    endpoints.push({
      method: "POST",
      path: route.path,
      reason: `channel "${route.channel}" declares this route`,
      meaning: "an unsigned POST is refused before any work; a 404 means the route is not mounted on this deployment",
      expect: "mounted",
    });
  }

  return { endpoints, skipped };
}

export type EndpointState = "mounted" | "absent" | "accepted-unsigned" | "server-error" | "unreachable";

export function classifyEndpoint(status: number | undefined): EndpointState {
  if (status === undefined) return "unreachable";
  if (status === 404) return "absent";
  if (status >= 200 && status < 400) return "accepted-unsigned";
  if (status >= 500) return "server-error";
  return "mounted";
}

export interface KeyProof {
  readonly ref: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function proveKeyOpensRow(input: { readonly ref: string; readonly ciphertext: string; readonly decrypt: (blob: string) => string }): KeyProof {
  try {
    const opened = input.decrypt(input.ciphertext).length > 0;
    return opened
      ? { ref: input.ref, ok: true, detail: "the AES key opens the stored rows (GCM auth tag verified; no value was returned or printed)" }
      : { ref: input.ref, ok: false, detail: "the envelope opened to an EMPTY value — the row exists and carries no secret" };
  } catch {
    return {
      ref: input.ref,
      ok: false,
      detail:
        "the AES key did NOT open this row — a wrong or rotated OE_CREDENTIAL_ENCRYPTION_KEY, or a corrupt envelope. " +
        "In this state every broker:\"db\" credential fails closed at once.",
    };
  }
}

export interface RequiredHeartbeat {
  readonly action: string;
  readonly reason: string;
  readonly maxAgeHours: number;
}

export interface ReportedHeartbeat {
  readonly action: string;
  readonly reason: string;
}

const CHANNEL_LIMITS: Readonly<Record<string, string>> = {
  "discord-gateway.ts":
    "/eve/v1/discord-gateway answers, but it only RECEIVES traffic while the always-on relay (deploy/discord-relay/) holds " +
    "the Discord WebSocket. Nothing here can see that process directly. `discord.dispatched` softens that a little: it dates " +
    "the last message the relay actually delivered, but stays REPORTED, never gated, because a quiet guild writes no rows " +
    "either — absence alone proves nothing. `discord.heartbeat` (OPE-775) is the stronger signal: the relay POSTs it on its OWN " +
    "timer, independent of guild traffic, and the deployment appends the row once its relay gate accepts that POST. A missing row " +
    "therefore reads most often as a dead relay or as a refused ingress — but the append is fire-and-forget, so the deployment " +
    "also answers 200 and drops the row when the append itself fails. Since OPE-785 it GATES the census — its ceiling derives from " +
    "OE_RELAY_HEARTBEAT_MS, the SAME env var the relay itself reads for its own interval (see docs/deploy/rollback.md).",
};

const CHANNEL_REPORTED_HEARTBEATS: Readonly<Record<string, readonly ReportedHeartbeat[]>> = {
  "discord-gateway.ts": [
    {
      action: "discord.dispatched",
      reason:
        "dates the last message the always-on Discord relay (deploy/discord-relay/) actually delivered. Reported, never gated: a quiet guild writes no rows either, so absence does NOT prove the relay is dead, and an age does not prove it is alive right now.",
    },
  ],
};

export function relayHeartbeatCeilingHours(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`census: relay heartbeat interval "${intervalMs}" must be a positive number of milliseconds.`);
  }
  return (intervalMs * 3) / 3_600_000;
}

export function channelGatedHeartbeats(files: readonly string[], discordRelayHeartbeatMs: number): readonly RequiredHeartbeat[] {
  if (!files.includes("discord-gateway.ts") || discordRelayHeartbeatMs <= 0) return [];
  return [
    {
      action: "discord.heartbeat",
      reason:
        "the always-on Discord relay (deploy/discord-relay/) POSTs this heartbeat on a fixed timer, whether or not any guild is talking. The DEPLOYMENT appends the row, and only after its relay gate accepts the POST — so a stale or missing row has two COMMON causes, and they take different remedies. (1) The relay is not posting. Redeploy the Railway relay; a bot-token rotation always needs that redeploy — docs/deploy/surfaces/discord.md, section \"Rotating the bot token\". (2) The relay is live, and the deployment refuses its POST. Rule this one out FIRST, because redeploying the relay does not fix it: an OE_RELAY_SECRET that is unset or disagrees between relay and deployment answers 401, and a route the deployment does not carry refuses every delivery. Those two are the common causes, not the whole list: the append is fire-and-forget, so a deployment that accepted the POST and answered 200 still holds no row when the append itself fails. Unlike discord.dispatched, this signal does not depend on guild traffic, so it CAN separate a dead relay from a quiet one. GATED since OPE-785: the ticket's own rollout order (land, redeploy, confirm live, THEN promote) ran its confirmation window and promoted this from reported to gated.",
      maxAgeHours: relayHeartbeatCeilingHours(discordRelayHeartbeatMs),
    },
  ];
}

export function channelCensusContributions(files: readonly string[]): {
  readonly limits: readonly string[];
  readonly reportedHeartbeats: readonly ReportedHeartbeat[];
} {
  const limits: string[] = [];
  const reportedHeartbeats: ReportedHeartbeat[] = [];
  for (const file of files) {
    const limit = CHANNEL_LIMITS[file];
    if (limit !== undefined) limits.push(limit);
    reportedHeartbeats.push(...(CHANNEL_REPORTED_HEARTBEATS[file] ?? []));
  }
  return { limits, reportedHeartbeats };
}

export interface HeartbeatObservation {
  readonly action: string;
  readonly lastSeenIso?: string;
}

export interface HeartbeatFinding {
  readonly action: string;
  readonly reason: string;
  readonly lastSeenIso?: string;
  readonly ageHours?: number;
  readonly maxAgeHours?: number;
  readonly ok: boolean;
}

export function cronCeilingHours(cron: string): number {
  const trimmed = cron.trim();
  if (/^\d+\s+\d+\s+\*\s+\*\s+\*$/u.test(trimmed)) return 24 + 2;
  if (/^\d+\s+\d+\s+\*\s+\*\s+[0-6]$/u.test(trimmed)) return 24 * 7 + 4;
  throw new Error(`census: cron "${cron}" is neither a daily nor a weekly pattern cronCeilingHours() understands — extend it rather than guessing a bound.`);
}

export function heartbeatFindings(input: {
  readonly gated: readonly RequiredHeartbeat[];
  readonly reported: readonly ReportedHeartbeat[];
  readonly observations: readonly HeartbeatObservation[];
  readonly now: Date;
}): readonly HeartbeatFinding[] {
  const observed = (action: string): HeartbeatObservation | undefined => input.observations.find((o) => o.action === action);
  const ageHoursOf = (iso: string): number => (input.now.getTime() - new Date(iso).getTime()) / 3_600_000;

  const gated = input.gated.map((h): HeartbeatFinding => {
    const lastSeenIso = observed(h.action)?.lastSeenIso;
    if (!lastSeenIso) return { action: h.action, reason: h.reason, maxAgeHours: h.maxAgeHours, ok: false };
    const ageHours = ageHoursOf(lastSeenIso);
    return { action: h.action, reason: h.reason, lastSeenIso, ageHours, maxAgeHours: h.maxAgeHours, ok: ageHours <= h.maxAgeHours };
  });

  const reported = input.reported.map((h): HeartbeatFinding => {
    const lastSeenIso = observed(h.action)?.lastSeenIso;
    if (!lastSeenIso) return { action: h.action, reason: h.reason, ok: true };
    return { action: h.action, reason: h.reason, lastSeenIso, ageHours: ageHoursOf(lastSeenIso), ok: true };
  });

  return [...gated, ...reported];
}

export interface RuntimeSignalFinding {
  readonly ok: boolean;
  readonly detail: string;
}

export function runtimeSignalFinding(observed: { readonly hasDeploymentId: boolean } | undefined): RuntimeSignalFinding {
  if (observed === undefined) {
    return {
      ok: false,
      detail:
        "GET /control/v1/runtime-signal did not answer — no E2E_CONTROL_READ_TOKEN/OE_DEPLOY_CONTROL_TOKEN set, the route is unmounted " +
        "(OE_CONTROL_READ_TOKENS unset on the deployment), or the call failed. This census cannot see whether the deployed function's env carries VERCEL_DEPLOYMENT_ID.",
    };
  }
  return observed.hasDeploymentId
    ? {
        ok: true,
        detail:
          "the deployed function's process env carries a non-empty VERCEL_DEPLOYMENT_ID — the fact eve's dynamic-tool-roster refresh keys off " +
          "(window-gated-test.ts §6). This proves the SIGNAL only, not that any standing session has consumed it.",
      }
    : {
        ok: false,
        detail:
          "VERCEL_DEPLOYMENT_ID is EMPTY on the deployed function. Eve falls back to a compiled-artifacts cache key for the refresh revision — " +
          "a standing seat's roster may not re-derive the way this deployment intends.",
      };
}

export interface CredentialBrokerArmedFinding {
  readonly ok: boolean;
  readonly detail: string;
}

export function credentialBrokerArmedFinding(observed: { readonly credentialBrokerArmed: boolean } | undefined): CredentialBrokerArmedFinding {
  if (observed === undefined) {
    return {
      ok: false,
      detail:
        "GET /control/v1/runtime-signal did not answer (or its response carried no credentialBrokerArmed field) — no " +
        "E2E_CONTROL_READ_TOKEN/OE_DEPLOY_CONTROL_TOKEN set, the route is unmounted (OE_CONTROL_READ_TOKENS unset on " +
        "the deployment), the call failed, or the deployment predates OPE-641. This census cannot see whether the " +
        "deployed function's env carries a valid OE_CREDENTIAL_ENCRYPTION_KEY.",
    };
  }
  return observed.credentialBrokerArmed
    ? {
        ok: true,
        detail:
          "the deployed function's process env carries a valid OE_CREDENTIAL_ENCRYPTION_KEY — the db credential " +
          "broker registers and every broker:\"db\" credential is reachable.",
      }
    : {
        ok: false,
        detail:
          "OE_CREDENTIAL_ENCRYPTION_KEY is absent or malformed on the deployed function. The db credential broker " +
          "never registers, and every broker:\"db\" credential fails closed at once, behind 200 responses, with no " +
          "audit trace.",
      };
}

export interface CredentialFinding {
  readonly ref: string;
  readonly reason: string;
  readonly present: boolean;
}

export interface EndpointFinding {
  readonly method: "POST";
  readonly path: string;
  readonly reason: string;
  readonly meaning: string;
  readonly expect: "mounted" | "absent";
  readonly status?: number;
  readonly state: EndpointState;
  readonly ok: boolean;
}

export interface AuditRowFinding {
  readonly action: string;
  readonly exercised: boolean;
  readonly notExercised?: string;
  readonly lastSeenIso?: string;
  readonly ok: boolean;
}

export function judgeAuditRow(
  declaration: { readonly action: string; readonly notExercised?: string },
  lastSeenIso: string | undefined,
): AuditRowFinding {
  const exercised = lastSeenIso !== undefined;
  const reason = (declaration.notExercised ?? "").trim();
  const stated = reason.length > 0;
  return {
    action: declaration.action,
    exercised,
    ...(stated ? { notExercised: declaration.notExercised } : {}),
    ...(lastSeenIso === undefined ? {} : { lastSeenIso }),
    ok: exercised || stated,
  };
}

export function auditRowProblems(findings: readonly AuditRowFinding[]): readonly string[] {
  return findings
    .filter((f) => !f.ok)
    .map(
      (f) =>
        `audit row "${f.action}" is declared CONSEQUENTIAL but the pack emitted none — drive it from an e2e leg, or declare \`notExercised\` on it in packages/core/agent/audit/action-registry.ts with what is missing`,
    );
}

export interface CensusResult {
  readonly ok: boolean;
  readonly target: string;
  readonly storeLabel: string;
  readonly credentials: readonly CredentialFinding[];
  readonly declared: readonly CredentialFinding[];
  readonly endpoints: readonly EndpointFinding[];
  readonly skipped: readonly SkippedRoute[];
  readonly problems: readonly string[];
  readonly keyProof?: KeyProof;
  readonly heartbeats: readonly HeartbeatFinding[];
  readonly runtimeSignal?: RuntimeSignalFinding;
  readonly credentialBrokerArmed?: CredentialBrokerArmedFinding;
  readonly auditRows: readonly AuditRowFinding[];
  readonly limits: readonly string[];
}

export interface EndpointObservation {
  readonly path: string;
  readonly status?: number;
}

export function censusResult(input: {
  readonly target: string;
  readonly storeLabel: string;
  readonly plan: CredentialPlan;
  readonly endpoints: EndpointPlan;
  readonly presentRefs: readonly string[];
  readonly observations: readonly EndpointObservation[];
  readonly keyProof?: KeyProof;
  readonly heartbeats?: readonly HeartbeatFinding[];
  readonly runtimeSignal?: RuntimeSignalFinding;
  readonly credentialBrokerArmed?: CredentialBrokerArmedFinding;
  readonly auditRows?: readonly AuditRowFinding[];
  readonly limits?: readonly string[];
}): CensusResult {
  const present = new Set(input.presentRefs);
  const finding = (c: CensusCredential): CredentialFinding => ({ ref: c.ref, reason: c.reason, present: present.has(c.ref) });
  const credentials = input.plan.required.map(finding);
  const declared = input.plan.declaredOnly.map(finding);

  const endpoints = input.endpoints.endpoints.map((e) => {
    const status = input.observations.find((o) => o.path === e.path)?.status;
    const state = classifyEndpoint(status);
    return { ...e, ...(status === undefined ? {} : { status }), state, ok: state === e.expect };
  });

  const heartbeats = input.heartbeats ?? [];
  const auditRows = input.auditRows ?? [];
  const ok =
    input.plan.problems.length === 0 &&
    credentials.every((c) => c.present) &&
    endpoints.every((e) => e.ok) &&
    (input.keyProof?.ok ?? true) &&
    heartbeats.every((h) => h.ok) &&
    (input.runtimeSignal?.ok ?? true) &&
    (input.credentialBrokerArmed?.ok ?? true) &&
    auditRows.every((r) => r.ok);
  return {
    ok,
    target: input.target,
    storeLabel: input.storeLabel,
    credentials,
    declared,
    endpoints,
    skipped: input.endpoints.skipped,
    problems: [...input.plan.problems, ...auditRowProblems(auditRows)],
    ...(input.keyProof ? { keyProof: input.keyProof } : {}),
    heartbeats,
    auditRows,
    ...(input.runtimeSignal ? { runtimeSignal: input.runtimeSignal } : {}),
    ...(input.credentialBrokerArmed ? { credentialBrokerArmed: input.credentialBrokerArmed } : {}),
    limits: input.limits ?? [],
  };
}

export function renderCensusReport(result: CensusResult): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  deployment: ${result.target}`);
  lines.push(`  store:      ${result.storeLabel}`);

  lines.push("");
  lines.push(`  CREDENTIAL ROWS (${result.credentials.filter((c) => c.present).length}/${result.credentials.length} present)`);
  for (const c of result.credentials) {
    lines.push(`    ${c.present ? "✓" : "✗"} ${c.ref}`);
    lines.push(`        required by ${c.reason}`);
  }
  if (result.credentials.length === 0) lines.push("    (none — no config names a db-brokered credential)");

  if (result.keyProof) {
    lines.push("");
    lines.push("  ENCRYPTION KEY");
    lines.push(`    ${result.keyProof.ok ? "✓" : "✗"} tested against ${result.keyProof.ref} — ${result.keyProof.detail}`);
  }

  if (result.declared.length > 0) {
    lines.push("");
    lines.push(`  DECLARED, NOT REQUIRED (${result.declared.length}) — inventory only, never a gate`);
    for (const c of result.declared) {
      lines.push(`    ${c.present ? "stored" : "absent"}  ${c.ref}`);
      lines.push(`        ${c.reason}`);
    }
  }

  lines.push("");
  lines.push(`  INGRESS ROUTES (${result.endpoints.filter((e) => e.ok).length}/${result.endpoints.length} as expected)`);
  for (const e of result.endpoints) {
    const observed = e.status === undefined ? "no answer" : String(e.status);
    lines.push(`    ${e.ok ? "✓" : "✗"} ${e.method} ${e.path} → ${observed} (${e.state}, expected ${e.expect})`);
    if (!e.ok) lines.push(`        ${e.meaning}`);
  }

  if (result.skipped.length > 0) {
    lines.push("");
    lines.push(`  NOT PROBED (${result.skipped.length})`);
    for (const s of result.skipped) lines.push(`    - ${s.method} ${s.path} [${s.channel}] — ${s.reason}`);
  }

  if (result.heartbeats.length > 0) {
    lines.push("");
    lines.push(`  CRON HEARTBEATS (${result.heartbeats.filter((h) => h.ok).length}/${result.heartbeats.length} as expected) — OPE-635`);
    for (const h of result.heartbeats) {
      const age = h.ageHours === undefined ? "never seen" : `${h.ageHours.toFixed(1)}h old`;
      const bound = h.maxAgeHours === undefined ? "report-only, not gated" : `bound ${h.maxAgeHours}h`;
      lines.push(`    ${h.ok ? "✓" : "✗"} ${h.action} — ${age} (${bound})`);
      if (!h.ok) lines.push(`        ${h.reason}`);
    }
  }

  if (result.runtimeSignal) {
    lines.push("");
    lines.push("  RUNTIME-REVISION SIGNAL (OPE-658)");
    lines.push(`    ${result.runtimeSignal.ok ? "✓" : "✗"} ${result.runtimeSignal.detail}`);
  }

  if (result.credentialBrokerArmed) {
    lines.push("");
    lines.push("  CREDENTIAL BROKER KEY, DEPLOYMENT'S OWN (OPE-641)");
    lines.push(`    ${result.credentialBrokerArmed.ok ? "✓" : "✗"} ${result.credentialBrokerArmed.detail}`);
  }

  if (result.problems.length > 0) {
    lines.push("");
    lines.push(`  CONFIG PROBLEMS (${result.problems.length})`);
    for (const p of result.problems) lines.push(`    ✗ ${p}`);
  }

  if (result.auditRows.length > 0) {
    const exercised = result.auditRows.filter((r) => r.exercised);
    const stated = result.auditRows.filter((r) => !r.exercised && r.notExercised !== undefined);
    const missing = result.auditRows.filter((r) => !r.ok);
    lines.push("");
    lines.push(`  AUDIT ROWS (${exercised.length}/${result.auditRows.length} exercised by the pack; ${stated.length} declared not-exercised)`);
    for (const r of missing) lines.push(`    ✗ ${r.action} — declared consequential, NO row in this window and no stated reason`);
    for (const r of stated) lines.push(`    – ${r.action} — not exercised: ${r.notExercised}`);
    if (missing.length === 0 && stated.length === 0) lines.push("    ✓ every declared consequential row was emitted at least once");
  }

  if (result.limits.length > 0) {
    lines.push("");
    lines.push(`  NOT PROVEN BY THIS CENSUS (${result.limits.length})`);
    for (const l of result.limits) lines.push(`    ! ${l}`);
  }

  lines.push("");
  if (result.ok) {
    lines.push("✓ deploy:census: the deployment holds every row and answers on every route the config requires.");
  } else {
    const missing = result.credentials.filter((c) => !c.present).map((c) => c.ref);
    const dead = result.endpoints.filter((e) => !e.ok).map((e) => `${e.method} ${e.path}`);
    const stale = result.heartbeats.filter((h) => !h.ok).map((h) => h.action);
    lines.push("✗ deploy:census: the deployment is MISSING required state.");
    if (missing.length > 0) lines.push(`  missing credential row(s): ${missing.join(", ")}`);
    if (dead.length > 0) lines.push(`  route(s) that did not answer as required: ${dead.join(", ")}`);
    if (stale.length > 0) lines.push(`  cron(s) with no fresh heartbeat: ${stale.join(", ")}`);
    if (result.keyProof && !result.keyProof.ok) lines.push(`  encryption key: ${result.keyProof.detail}`);
    if (result.runtimeSignal && !result.runtimeSignal.ok) lines.push(`  runtime-revision signal: ${result.runtimeSignal.detail}`);
    if (result.credentialBrokerArmed && !result.credentialBrokerArmed.ok) lines.push(`  credential broker key (deployment): ${result.credentialBrokerArmed.detail}`);
    if (result.problems.length > 0) lines.push(`  config problem(s): ${result.problems.length} — see above`);
    lines.push("  A missing row fails CLOSED at first use, with no audit trace. Store it before trusting this deploy.");
  }
  return lines;
}
