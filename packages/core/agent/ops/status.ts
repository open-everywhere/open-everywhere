import { CONTRACT_NODE_RANGE, CONTRACT_REQUIREMENT_IDS, CONTRACT_ROUTES, CONTRACT_VERSION, type ContractRequirementId } from "./contract.js";
import { corePackageVersion, nodeRangeSatisfied } from "./package-info.js";
import { getAppInfo } from "../commands/app-info.js";
import { CREDENTIAL_KEY_ENV_NAME, credentialKeyStatus } from "./quickstart.js";
import { resolveOperationalSelection } from "../operational/selection.js";
import { resolveMemoryProviderId } from "../memory/backing-selection.js";
import type { SandboxBackendKind } from "../sandbox/backend-select.js";
import { platformName } from "../access/platform.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { pageBaseUrl, publicBaseUrlSource } from "../credentials/page-token.js";

export const OE_STATUS_PATH = "/eve/v1/oe/status";

export const STATUS_CACHE_MS = 15_000;

export type StatusVerdict = "yes" | "no" | "unknown";

export interface RequirementStatus {
  readonly id: ContractRequirementId;
  readonly met: StatusVerdict;
  readonly detail: string;
}

export interface ProbeAnswer {
  readonly met: StatusVerdict;
  readonly detail: string;
}

export type ProbedRequirementId = Extract<ContractRequirementId, "postgres" | "model-route">;

export type StatusProbe = () => Promise<ProbeAnswer>;

export interface SurfaceStatus {
  readonly credentials: StatusVerdict;
  readonly installed: StatusVerdict;
  readonly eventsVerified: StatusVerdict;
}

export interface StatusVersions {
  readonly app: string | null;
  readonly core: string;
  readonly eve: string | null;
}

export const HOST_ROUTES = [...CONTRACT_ROUTES, "self-host"] as const;
export type HostRoute = (typeof HOST_ROUTES)[number];

export interface DeploymentStatus {
  readonly contract: number;
  readonly version: StatusVersions;
  readonly host: HostRoute;
  readonly requirements: readonly RequirementStatus[];
  readonly surfaces: Readonly<Record<string, SurfaceStatus>>;
  readonly checkedAt: string;
}

const PROBES: Partial<Record<ProbedRequirementId, StatusProbe>> = {};
const SURFACE_REPORTERS: Record<string, () => Promise<Partial<SurfaceStatus>>> = {};

export function registerStatusProbe(id: ProbedRequirementId, probe: StatusProbe): void {
  PROBES[id] = probe;
  invalidateStatusCache();
}

export function registerSurfaceStatusReporter(platform: string, report: () => Promise<Partial<SurfaceStatus>>): void {
  if (!admitProviderRegistration(platform, "surface-status-reporter")) return;
  SURFACE_REPORTERS[platform] = report;
  invalidateStatusCache();
}

export function _resetStatusRegistriesForTest(): void {
  for (const k of Object.keys(PROBES)) delete PROBES[k as ProbedRequirementId];
  for (const k of Object.keys(SURFACE_REPORTERS)) delete SURFACE_REPORTERS[k];
  invalidateStatusCache();
}

export function hostRoute(platform: string = platformName()): HostRoute {
  const name = platform.trim().toLowerCase();
  return (HOST_ROUTES as readonly string[]).includes(name) ? (name as HostRoute) : "self-host";
}

function liveVersions(): StatusVersions {
  const info = getAppInfo();
  const real = (v: string): string | null => (v === "unknown" || v.trim() === "" ? null : v);
  return { app: real(info.version), core: corePackageVersion(), eve: real(info.evePin) };
}

function nodeStatus(version: string, range: string | undefined): RequirementStatus {
  const ok = range === undefined ? undefined : nodeRangeSatisfied(range, version);
  return {
    id: "node-24",
    met: ok === true ? "yes" : ok === false ? "no" : "unknown",
    detail:
      ok === undefined
        ? "the engines range could not be read or parsed, so this cannot be judged"
        : `running node ${version}, which ${ok ? "satisfies" : "does NOT satisfy"} ${range}`,
  };
}

function publicUrlStatus(env: NodeJS.ProcessEnv): RequirementStatus {
  const source = publicBaseUrlSource(env);
  const resolved = pageBaseUrl(env);
  if (resolved === undefined) {
    return {
      id: "public-https-url",
      met: "no",
      detail: "the deployment cannot discover its own public origin — set OE_PUBLIC_BASE_URL. Webhook verification and every OAuth callback build on it",
    };
  }
  const https = resolved.toLowerCase().startsWith("https://");
  return {
    id: "public-https-url",
    met: https ? "yes" : "no",
    detail: https
      ? `the deployment knows its own public origin, from ${source}`
      : `the origin resolved from ${source} is not https — a chat vendor will not verify a webhook URL on it, and no OAuth callback will resolve`,
  };
}

const KNOWN_BACKINGS = ["postgres", "sqlite", "git"] as const;

function namedBacking(id: string): string {
  return (KNOWN_BACKINGS as readonly string[]).includes(id) ? id : "a backing this build does not carry";
}

function storeStatus(env: NodeJS.ProcessEnv, memoryProvider: string, probed: ProbeAnswer | undefined): RequirementStatus {
  const op = resolveOperationalSelection(env);
  const memory = resolveMemoryProviderId(env, memoryProvider);
  const hosted = op.id === "postgres" && op.floor === "none";
  if (!hosted || memory !== "postgres") {
    const floor =
      op.floor === "pglite"
        ? "the embedded Postgres (PGlite) floor"
        : op.floor === "sqlite"
          ? "the deprecated sqlite floor"
          : namedBacking(op.id);
    return {
      id: "postgres",
      met: "no",
      detail: `no hosted Postgres is selected — the operational store resolves to ${floor} and the memory backing to ${namedBacking(memory)}. Set DATABASE_URL: it selects postgres for both`,
    };
  }
  if (!probed) {
    return { id: "postgres", met: "unknown", detail: "hosted Postgres is selected for both stores; reachability was not measured (no probe registered)" };
  }
  return { id: "postgres", met: probed.met, detail: `hosted Postgres is selected for both stores — ${probed.detail}` };
}

function sandboxStatus(kind: SandboxBackendKind): RequirementStatus {
  if (kind === "vercel") return { id: "sandbox-backend", met: "yes", detail: "Vercel Sandbox — a contained, per-session filesystem" };
  if (kind === "justbash") {
    return {
      id: "sandbox-backend",
      met: "no",
      detail: "the justbash backend shares the app process's filesystem — development only, never a deployment",
    };
  }
  return { id: "sandbox-backend", met: "yes", detail: "docker — a contained, per-session filesystem" };
}

function egressStatus(proxyUrl: string, vercelSandbox: boolean, allowUnenforced: boolean): RequirementStatus {
  if (vercelSandbox) return { id: "egress-control", met: "yes", detail: "the Vercel Sandbox firewall applies the compiled per-session policy" };
  if (proxyUrl.trim().length > 0) {
    return { id: "egress-control", met: "yes", detail: "the compiled policy is pushed to the egress-proxy sidecar on every session" };
  }
  if (allowUnenforced) {
    return {
      id: "egress-control",
      met: "no",
      detail: "egress is UNENFORCED by declaration (egress.allowUnenforced) — the agent runs without a network firewall",
    };
  }
  return {
    id: "egress-control",
    met: "no",
    detail: "no egress proxy is wired, so any session that resolves a host allow-list aborts at session start (fail-closed)",
  };
}

function modelStatus(probed: ProbeAnswer | undefined): RequirementStatus {
  if (!probed) return { id: "model-route", met: "unknown", detail: "the model route was not measured (no probe registered)" };
  return { id: "model-route", met: probed.met, detail: probed.detail };
}

function secretsStatus(env: NodeJS.ProcessEnv): RequirementStatus {
  const key = credentialKeyStatus(env[CREDENTIAL_KEY_ENV_NAME]);
  const db = (env.DATABASE_URL ?? "").trim().length > 0;
  if (key === "ok" && db) return { id: "secrets", met: "yes", detail: "both root-of-trust values are present and the credential store is armed" };
  if (key === "malformed") {
    return { id: "secrets", met: "no", detail: `${CREDENTIAL_KEY_ENV_NAME} is set but does not decode to a 32-byte key — the credential store fails closed on every read and write` };
  }
  const absent = [...(db ? [] : ["DATABASE_URL"]), ...(key === "ok" ? [] : [CREDENTIAL_KEY_ENV_NAME])];
  return { id: "secrets", met: "no", detail: `missing from this deployment's environment: ${absent.join(", ")}` };
}

function workflowStorageStatus(onVercelHost: boolean): RequirementStatus {
  if (onVercelHost) return { id: "workflow-storage", met: "yes", detail: "Vercel Workflow holds every run; nothing on this filesystem needs to be durable" };
  return {
    id: "workflow-storage",
    met: "unknown",
    detail: "off Vercel, eve persists runs under .eve/.workflow-data next to the server's working directory; whether that path is durable is a host fact this process cannot read",
  };
}

export interface StatusInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  readonly nodeVersion?: string;
  readonly nodeRange?: string;
  readonly version?: StatusVersions;
  readonly host?: string;
  readonly allowUnenforced?: boolean;
  readonly egressProxyUrl?: string;
  readonly memoryProvider?: string;
  readonly sandboxBackend?: SandboxBackendKind;
  readonly probes?: Partial<Record<ProbedRequirementId, StatusProbe>>;
  readonly surfaceReporters?: Readonly<Record<string, () => Promise<Partial<SurfaceStatus>>>>;
}

const UNKNOWN_SURFACE: SurfaceStatus = { credentials: "unknown", installed: "unknown", eventsVerified: "unknown" };

async function runProbe(probe: StatusProbe | undefined): Promise<ProbeAnswer | undefined> {
  if (!probe) return undefined;
  try {
    return await probe();
  } catch {
    return { met: "unknown", detail: "the probe could not complete" };
  }
}

export async function surfaceStatuses(
  reporters: Readonly<Record<string, () => Promise<Partial<SurfaceStatus>>>> = SURFACE_REPORTERS,
): Promise<Record<string, SurfaceStatus>> {
  const surfaces: Record<string, SurfaceStatus> = {};
  for (const platform of Object.keys(reporters).sort()) {
    let reported: Partial<SurfaceStatus> = {};
    try {
      reported = await reporters[platform]!();
    } catch {
    }
    surfaces[platform] = { ...UNKNOWN_SURFACE, ...reported };
  }
  return surfaces;
}

export async function deploymentStatus(inputs: StatusInputs = {}): Promise<DeploymentStatus> {
  const env = inputs.env ?? process.env;
  const host = hostRoute(inputs.host ?? platformName());
  const onVercelHost = host === "vercel";
  const sandboxBackend: SandboxBackendKind = inputs.sandboxBackend ?? (onVercelHost ? "vercel" : "docker");
  const probes = inputs.probes ?? PROBES;
  const reporters = inputs.surfaceReporters ?? SURFACE_REPORTERS;

  const op = resolveOperationalSelection(env);
  const memoryProvider = inputs.memoryProvider ?? "";
  const hostedPostgres = op.id === "postgres" && op.floor === "none" && resolveMemoryProviderId(env, memoryProvider) === "postgres";
  const [db, model] = await Promise.all([
    hostedPostgres ? runProbe(probes["postgres"]) : Promise.resolve(undefined),
    runProbe(probes["model-route"]),
  ]);

  const requirements: RequirementStatus[] = [
    nodeStatus(inputs.nodeVersion ?? process.versions.node, inputs.nodeRange ?? CONTRACT_NODE_RANGE),
    publicUrlStatus(env),
    storeStatus(env, memoryProvider, db),
    sandboxStatus(sandboxBackend),
    egressStatus(inputs.egressProxyUrl ?? "", sandboxBackend === "vercel", inputs.allowUnenforced ?? false),
    modelStatus(model),
    secretsStatus(env),
    workflowStorageStatus(onVercelHost),
  ];
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const ordered = CONTRACT_REQUIREMENT_IDS.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error(`status: contract requirement "${id}" has no verdict — ops/status.ts must answer every id in ops/contract.ts`);
    return row;
  });

  const surfaces = await surfaceStatuses(reporters);

  return {
    contract: CONTRACT_VERSION,
    version: inputs.version ?? liveVersions(),
    host,
    requirements: ordered,
    surfaces,
    checkedAt: (inputs.now ?? new Date()).toISOString(),
  };
}

let cached: { readonly at: number; readonly pending: Promise<DeploymentStatus> } | null = null;

export function invalidateStatusCache(): void {
  cached = null;
}

export async function cachedDeploymentStatus(inputs: StatusInputs = {}, nowMs: number = Date.now()): Promise<DeploymentStatus> {
  if (cached && nowMs - cached.at < STATUS_CACHE_MS) return cached.pending;
  const pending = deploymentStatus(inputs).catch((err: unknown) => {
    if (cached?.pending === pending) cached = null;
    throw err;
  });
  cached = { at: nowMs, pending };
  return pending;
}
