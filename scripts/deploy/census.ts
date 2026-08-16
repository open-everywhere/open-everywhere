import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  censusResult,
  planRequiredCredentials,
  planRequiredEndpoints,
  proveKeyOpensRow,
  renderCensusReport,
  type EndpointObservation,
  type KeyProof,
  type MountedRoute,
  type PlumbingCredential,
} from "../../packages/core/agent/ops/census.js";
import { decryptCredential } from "../../packages/core/agent/credentials/db-broker.js";
import { deploymentOrg } from "../../packages/core/agent/identity/binding.js";
import { getOperationalStore } from "../../packages/core/agent/operational/provider.js";
import { connectOperatorStore } from "../../packages/core/scripts/operator-store-connect.js";

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

const CHANNEL_LIMITS: Record<string, string> = {
  "discord-gateway.ts":
    "/eve/v1/discord-gateway answers, but it only RECEIVES traffic while the always-on relay (deploy/discord-relay/) holds " +
    "the Discord WebSocket. Nothing here can see that process, so a dead relay looks exactly like a quiet guild (OPE-640).",
};

const STANDING_LIMITS: readonly string[] = [
  "a refused probe proves the ingress SERVES and refuses. It does not prove a correctly SIGNED delivery is accepted or reaches a session — `npm run deploy:smoke` proves that, for one declared hook only (OPE-640).",
  "the AES key tested here is THIS process's key. It proves the stored rows are openable; nothing observable from outside proves the deployment's own environment still carries OE_CREDENTIAL_ENCRYPTION_KEY (OPE-641).",
  "env-brokered secrets (an env var NAME as the ref) are not store rows, so the census cannot see whether the deployment holds them.",
  "the store censused is the one THIS process's DATABASE_URL opens. Nothing joins it to the deployment at --target, so pointing the two at different environments reports a clean census of the wrong pair.",
];

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

async function mountedRoutes(): Promise<{ routes: MountedRoute[]; plumbing: PlumbingCredential[]; limits: string[] }> {
  const routes: MountedRoute[] = [];
  const plumbing: PlumbingCredential[] = [];
  const limits: string[] = [];
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
    const limit = CHANNEL_LIMITS[file];
    if (limit) limits.push(limit);
  }
  return { routes, plumbing, limits };
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

  const { routes, plumbing, limits } = await mountedRoutes();
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

  const org = args.values.get("org")?.trim() || deploymentOrg();
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

  const result = censusResult({
    target,
    storeLabel: `${store.label}, org "${org}"`,
    plan: { required, declaredOnly: plan.declaredOnly, problems: plan.problems },
    endpoints,
    presentRefs,
    observations,
    ...(keyProof ? { keyProof } : {}),
    limits: [...limits, ...keyCheckLimits, ...STANDING_LIMITS],
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
