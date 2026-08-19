import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  censusResult,
  credentialBrokerArmedFinding,
  cronCeilingHours,
  channelCensusContributions,
  heartbeatFindings,
  planRequiredCredentials,
  planRequiredEndpoints,
  proveKeyOpensRow,
  renderCensusReport,
  runtimeSignalFinding,
  type CredentialBrokerArmedFinding,
  type EndpointObservation,
  type HeartbeatFinding,
  type HeartbeatObservation,
  type KeyProof,
  type MountedRoute,
  type PlumbingCredential,
  type ReportedHeartbeat,
  type RequiredHeartbeat,
  type RuntimeSignalFinding,
} from "../../packages/core/agent/ops/census.js";
import { readAudit } from "../../packages/core/agent/audit/audit.js";
import { decryptCredential } from "../../packages/core/agent/credentials/db-broker.js";
import { deploymentOrg } from "../../packages/core/agent/identity/binding.js";
import { getOperationalStore } from "../../packages/core/agent/operational/provider.js";
import { CONTROL_READ_RUNTIME_SIGNAL_PATH } from "../../packages/core/agent/control/read-route.js";
import { connectOperatorStore } from "../../packages/core/scripts/operator-store-connect.js";
import { assertStoreIdentity } from "../../packages/core/scripts/store-identity-guard.js";

import { loadBundles } from "../../agent/access/bundles.js";
import { loadConnectorCredentials } from "../../agent/access/connector-credentials.js";
import { loadDomains } from "../../agent/memory/domains.js";
import { loadWebhooks } from "../../agent/webhooks/hooks.js";
import { DeployConfigError, parseArgs } from "./lib.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHANNELS_DIR = join(REPO_ROOT, "agent", "channels");

const PLUMBING: Record<string, () => Promise<readonly PlumbingCredential[]>> = {
  "notion.ts": async () => {
    const { notionIntegrations, NOTION_PROVIDER } = await import("@open-everywhere/provider-notion/agent/channels/notion-credentials.js");
    return notionIntegrations(loadDomains()).map((i) => ({
      connector: NOTION_PROVIDER,
      credentialId: i.credentialId,
      reason: `the mounted notion channel resolves "${i.credentialId}" for ${i.domain ? `domain "${i.domain}"` : "the org default"}`,
    }));
  },
};

const CONTROL_HOOK_ID = "oe-census-control-no-such-hook";

const STANDING_LIMITS: readonly string[] = [
  "a refused probe proves the ingress SERVES and refuses. It does not prove a correctly SIGNED delivery is accepted or reaches a session — `npm run deploy:smoke` proves that, for one declared hook only (OPE-640).",
  "the AES key tested here is THIS process's key. It proves the stored rows are openable; the CREDENTIAL BROKER KEY finding below (OPE-641) is the observable proof of the deployment's own OE_CREDENTIAL_ENCRYPTION_KEY, when that check runs.",
  "env-brokered secrets (an env var NAME as the ref) are not store rows, so the census cannot see whether the deployment holds them.",
];

const GATED_SCHEDULES: readonly { readonly file: string; readonly action: string; readonly reason: string }[] = [
  {
    file: "directory-sync.ts",
    action: "identity.directory.sync",
    reason:
      "the daily directory-sync cron (agent/schedules/directory-sync.ts) writes this row on EVERY run since OPE-635, armed or not — a stale one means the cron itself stopped, not merely that the directory had nothing to report.",
  },
  {
    file: "tidy.ts",
    action: "memory.tidy_tick",
    reason:
      "the daily tidy cron (agent/schedules/tidy.ts) writes this heartbeat on EVERY run since OPE-635, whether or not anything needed tidying — a stale one means the cron itself stopped.",
  },
  {
    file: "dream-mode3.ts",
    action: "dream.mode3_tick",
    reason:
      "the weekly dream-mode3 cron (agent/schedules/dream-mode3.ts) writes this heartbeat on EVERY run since OPE-635, including an empty week — a stale one means the cron itself stopped.",
  },
];

const REPORTED_HEARTBEATS: readonly { readonly action: string; readonly reason: string }[] = [
  { action: "routine.fire", reason: "fires only when a routine is due — total absence is a legitimate state on a deployment with none configured, so this is reported, never gated." },
];

async function planHeartbeats(): Promise<readonly RequiredHeartbeat[]> {
  const dir = join(REPO_ROOT, "agent", "schedules");
  const out: RequiredHeartbeat[] = [];
  for (const s of GATED_SCHEDULES) {
    const mod = (await import(join(dir, s.file))) as { default?: { cron?: string } };
    const cron = mod.default?.cron;
    if (typeof cron !== "string" || cron.length === 0) {
      throw new DeployConfigError(`agent/schedules/${s.file} has no default-exported \`cron\` string — cannot derive its heartbeat bound.`);
    }
    out.push({ action: s.action, reason: s.reason, maxAgeHours: cronCeilingHours(cron) });
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function resolveTarget(): string {
  const explicit = args.values.get("target")?.trim();
  const alias = process.env.OE_DEPLOY_ALIAS?.trim();
  const url = explicit || process.env.E2E_TARGET_URL?.trim() || process.env.OE_DEPLOY_BASE_URL?.trim() || (alias ? `https://${alias}` : "");
  if (!url) {
    throw new DeployConfigError(
      "no deployment to census — pass --target https://<host>, or set E2E_TARGET_URL (or OE_DEPLOY_BASE_URL / OE_DEPLOY_ALIAS).",
    );
  }
  return url.replace(/\/+$/u, "");
}

async function mountedRoutes(): Promise<{
  routes: MountedRoute[];
  plumbing: PlumbingCredential[];
  limits: string[];
  reportedHeartbeats: ReportedHeartbeat[];
}> {
  const routes: MountedRoute[] = [];
  const plumbing: PlumbingCredential[] = [];
  const limits: string[] = [];
  const reportedHeartbeats: ReportedHeartbeat[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(CHANNELS_DIR).filter((f) => f.endsWith(".ts")).sort();
  } catch {
    throw new DeployConfigError(`no mounted channels at ${CHANNELS_DIR} — run \`npm run oe:build\` first.`);
  }
  for (const file of files) {
    const mod = (await import(join(CHANNELS_DIR, file))) as {
      default?: { readonly routes?: readonly { readonly method?: string; readonly path?: string }[] };
    };
    for (const route of mod.default?.routes ?? []) {
      if (typeof route.method === "string" && typeof route.path === "string") {
        routes.push({ channel: file, method: route.method, path: route.path });
      }
    }
    const supplier = PLUMBING[file];
    if (supplier) plumbing.push(...(await supplier()));
  }
  const contributions = channelCensusContributions(files);
  limits.push(...contributions.limits);
  reportedHeartbeats.push(...contributions.reportedHeartbeats);
  return { routes, plumbing, limits, reportedHeartbeats };
}

async function probe(target: string, path: string, timeoutMs: number): Promise<EndpointObservation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${target}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
      redirect: "manual",
    });
    return { path, status: res.status };
  } catch {
    return { path };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRuntimeSignal(
  target: string,
  token: string,
  timeoutMs: number,
): Promise<{ hasDeploymentId: boolean; credentialBrokerArmed?: boolean } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${target}${CONTROL_READ_RUNTIME_SIGNAL_PATH}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { hasDeploymentId?: unknown; credentialBrokerArmed?: unknown };
    if (typeof body.hasDeploymentId !== "boolean") return undefined;
    return {
      hasDeploymentId: body.hasDeploymentId,
      ...(typeof body.credentialBrokerArmed === "boolean" ? { credentialBrokerArmed: body.credentialBrokerArmed } : {}),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const target = resolveTarget();
  const timeoutMs = Number(args.values.get("timeout-ms") ?? "20000") || 20_000;
  const json = args.flags.has("json");

  const store = await connectOperatorStore();
  if (store.id !== "postgres" || !store.label.startsWith("hosted Postgres")) {
    throw new DeployConfigError(
      `the operational store this process opened is "${store.label}" — not the deployment's own.\n` +
        "  A census of a local floor store proves nothing about the deployment. Export DATABASE_URL\n" +
        "  (and OE_OPERATIONAL_PROVIDER, if your deployment sets it) and run again.",
    );
  }

  const org = args.values.get("org")?.trim() || deploymentOrg();

  {
    const identityToken = (process.env.OE_DEPLOY_CONTROL_TOKEN?.trim() || process.env.E2E_CONTROL_READ_TOKEN?.trim()) ?? "";
    if (!identityToken) {
      throw new DeployConfigError(
        "cannot verify this store is the deployment's own — no OE_DEPLOY_CONTROL_TOKEN / E2E_CONTROL_READ_TOKEN set.\n" +
          "  A census against an unverified store can report a clean read of the WRONG database (OPE-835).\n" +
          "  Set one of those env vars to a service token registered in the deployment's OE_CONTROL_READ_TOKENS and run again.",
      );
    }
    try {
      await assertStoreIdentity(getOperationalStore(), { targetUrl: target, readToken: identityToken, org });
    } catch (err) {
      throw new DeployConfigError(err instanceof Error ? err.message : String(err));
    }
  }

  const { routes, plumbing, limits, reportedHeartbeats } = await mountedRoutes();
  const plan = planRequiredCredentials({
    bundles: loadBundles(),
    catalogues: loadConnectorCredentials(),
    domains: loadDomains(),
    hooks: loadWebhooks(),
    plumbing,
  });
  const extra = (args.values.get("require") ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((ref) => ({ ref, reason: "--require on the command line" }));
  const required = [...plan.required, ...extra];

  const endpoints = planRequiredEndpoints({ routes, hooks: loadWebhooks(), controlHookId: CONTROL_HOOK_ID });

  const presentRefs = await getOperationalStore().listStoredCredentialRefs(org);

  const observations: EndpointObservation[] = [];
  for (const endpoint of endpoints.endpoints) observations.push(await probe(target, endpoint.path, timeoutMs));

  let keyProof: KeyProof | undefined;
  const keyCheckLimits: string[] = [];
  if (!args.flags.has("no-key-check")) {
    const testRef = required.find((r) => presentRefs.includes(r.ref))?.ref ?? presentRefs[0];
    const row = testRef ? await getOperationalStore().getStoredCredential(org, testRef) : undefined;
    if (row && testRef) {
      keyProof = proveKeyOpensRow({ ref: testRef, ciphertext: row.ciphertext, decrypt: decryptCredential });
    } else {
      keyCheckLimits.push("the encryption-key check DID NOT RUN — no stored credential row was available to open, so the key is untested this run");
    }
  }

  let heartbeats: readonly HeartbeatFinding[] = [];
  const heartbeatLimits: string[] = [];
  if (!args.flags.has("no-heartbeat-check")) {
    const gatedPlan = await planHeartbeats();
    const reported: readonly ReportedHeartbeat[] = [...REPORTED_HEARTBEATS, ...reportedHeartbeats];
    const actions = [...gatedPlan.map((h) => h.action), ...reported.map((h) => h.action)];
    const heartbeatObservations: HeartbeatObservation[] = [];
    for (const action of actions) {
      const rows = await readAudit({ org, action, limit: 1 });
      heartbeatObservations.push({ action, ...(rows[0] ? { lastSeenIso: rows[0].ts } : {}) });
    }
    heartbeats = heartbeatFindings({ gated: gatedPlan, reported, observations: heartbeatObservations, now: new Date() });
    heartbeatLimits.push("the heartbeat check reads ONE org — crons sweep OE_TIDY_ORGS, so on a multi-org deployment run one census per swept org");
  } else {
    heartbeatLimits.push("the cron-heartbeat check DID NOT RUN (--no-heartbeat-check) — nothing here proves directory-sync, tidy or dream-mode3 are still firing");
  }

  const wantRuntimeSignal = !args.flags.has("no-runtime-signal-check");
  const wantCredentialBrokerArmed = !args.flags.has("no-credential-key-armed-check");
  let runtimeSignal: RuntimeSignalFinding | undefined;
  let credentialBrokerArmed: CredentialBrokerArmedFinding | undefined;
  const runtimeSignalLimits: string[] = [];
  const credentialBrokerArmedLimits: string[] = [];
  if (!wantRuntimeSignal) runtimeSignalLimits.push("the runtime-revision signal check DID NOT RUN (--no-runtime-signal-check)");
  if (!wantCredentialBrokerArmed) credentialBrokerArmedLimits.push("the credential-broker-armed check DID NOT RUN (--no-credential-key-armed-check)");
  if (wantRuntimeSignal || wantCredentialBrokerArmed) {
    const runtimeToken = (process.env.OE_DEPLOY_CONTROL_TOKEN?.trim() || process.env.E2E_CONTROL_READ_TOKEN?.trim()) ?? "";
    if (!runtimeToken) {
      if (wantRuntimeSignal) {
        runtimeSignalLimits.push(
          "the runtime-revision signal check DID NOT RUN — no OE_DEPLOY_CONTROL_TOKEN / E2E_CONTROL_READ_TOKEN set, so nothing here proves VERCEL_DEPLOYMENT_ID is non-empty on the deployed function",
        );
      }
      if (wantCredentialBrokerArmed) {
        credentialBrokerArmedLimits.push(
          "the credential-broker-armed check DID NOT RUN — no OE_DEPLOY_CONTROL_TOKEN / E2E_CONTROL_READ_TOKEN set, so nothing here proves the deployment's OE_CREDENTIAL_ENCRYPTION_KEY is armed",
        );
      }
    } else {
      const observed = await fetchRuntimeSignal(target, runtimeToken, timeoutMs);
      if (wantRuntimeSignal) runtimeSignal = runtimeSignalFinding(observed ? { hasDeploymentId: observed.hasDeploymentId } : undefined);
      if (wantCredentialBrokerArmed) {
        credentialBrokerArmed = credentialBrokerArmedFinding(
          observed && typeof observed.credentialBrokerArmed === "boolean" ? { credentialBrokerArmed: observed.credentialBrokerArmed } : undefined,
        );
      }
    }
  }

  const result = censusResult({
    target,
    storeLabel: `${store.label}, org "${org}"`,
    plan: { required, declaredOnly: plan.declaredOnly, problems: plan.problems },
    endpoints,
    presentRefs,
    observations,
    ...(keyProof ? { keyProof } : {}),
    heartbeats,
    ...(runtimeSignal ? { runtimeSignal } : {}),
    ...(credentialBrokerArmed ? { credentialBrokerArmed } : {}),
    limits: [...limits, ...keyCheckLimits, ...heartbeatLimits, ...runtimeSignalLimits, ...credentialBrokerArmedLimits, ...STANDING_LIMITS],
  });

  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const line of renderCensusReport(result)) console.log(line);
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  if (err instanceof DeployConfigError) {
    console.error(`✗ deploy:census: ${err.message}`);
    process.exit(2);
  }
  console.error(`✗ deploy:census: could not complete — ${String(err instanceof Error ? err.message : err)}`);
  process.exit(2);
}
