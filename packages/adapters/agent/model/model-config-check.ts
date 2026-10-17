import type { ModelDataPolicy, ModelTarget } from "@open-everywhere/core/agent/adapter-api.js";

const DEFAULT_GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";

export type CheckVerdict = "yes" | "no" | "unknown";

export interface EndpointFacts {
  readonly provider: string;
  readonly zdr: boolean | undefined;
  readonly noTraining: boolean | undefined;
  readonly regions: readonly string[] | undefined;
}

export interface CheckedModel {
  readonly id: string;
  readonly via?: string;
}

export interface ConfigFinding {
  readonly met: Exclude<CheckVerdict, "yes">;
  readonly model?: string;
  readonly row: string;
  readonly detail: string;
}

export interface ConfigCheckResult {
  readonly met: CheckVerdict;
  readonly findings: readonly ConfigFinding[];
  readonly checked: number;
}

export function modelEndpointsUrl(id: string, baseUrl?: string): string {
  let origin = DEFAULT_GATEWAY_ORIGIN;
  if (baseUrl !== undefined) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
    }
  }
  return `${origin}/v1/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`;
}

const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export function parseEndpoints(body: unknown): EndpointFacts[] | undefined {
  const eps = (body as { data?: { endpoints?: unknown } } | null)?.data?.endpoints;
  if (!Array.isArray(eps)) return undefined;
  const out: EndpointFacts[] = [];
  for (const e of eps) {
    if (e === null || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r["provider_name"] !== "string") continue;
    const regions = Array.isArray(r["inference_regions"])
      ? (r["inference_regions"] as unknown[]).flatMap((x) => {
          const g = (x as { geo_region?: unknown } | null)?.geo_region;
          return typeof g === "string" ? [g] : [];
        })
      : undefined;
    out.push({ provider: r["provider_name"], zdr: asBool(r["has_zdr"]), noTraining: asBool(r["has_no_training"]), regions });
  }
  return out;
}

const and = (a: CheckVerdict, b: CheckVerdict): CheckVerdict => (a === "no" || b === "no" ? "no" : a === "unknown" || b === "unknown" ? "unknown" : "yes");
const any = (vs: readonly CheckVerdict[]): CheckVerdict => (vs.includes("yes") ? "yes" : vs.every((v) => v === "no") ? "no" : "unknown");
const fromBool = (b: boolean | undefined): CheckVerdict => (b === undefined ? "unknown" : b ? "yes" : "no");

function rowJudges(policy: ModelDataPolicy, eps: readonly EndpointFacts[]): { label: string; judge: (e: EndpointFacts) => CheckVerdict }[] {
  const rows: { label: string; judge: (e: EndpointFacts) => CheckVerdict }[] = [];
  if (policy.zeroRetention === true) rows.push({ label: "zeroRetention", judge: (e) => fromBool(e.zdr) });
  if (policy.noTraining === true) rows.push({ label: "noTraining", judge: (e) => fromBool(e.noTraining) });
  const region = policy.region;
  if (region !== undefined) {
    const listed = eps.some((e) => e.regions !== undefined);
    rows.push({ label: `region ${region}`, judge: (e) => (e.regions !== undefined ? fromBool(e.regions.includes(region)) : listed ? "no" : "unknown") });
  }
  return rows;
}

export function judgeModelEndpoints(id: string, eps: readonly EndpointFacts[], target: ModelTarget, policy: ModelDataPolicy, via = "gateway"): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const only = target.providers?.only;
  const candidates = only === undefined ? eps : eps.filter((e) => only.includes(e.provider));
  if (only !== undefined && candidates.length === 0) {
    findings.push({ met: "no", model: id, row: `models.targets.${via}.providers.only`, detail: `providers.only: no allowed provider serves ${id}` });
    return findings;
  }
  const rows = rowJudges(policy, eps);
  if (rows.length === 0) return findings;
  const joint = any(candidates.map((e) => rows.reduce<CheckVerdict>((v, r) => and(v, r.judge(e)), "yes")));
  if (joint === "yes") return findings;
  const alone = rows.map((r) => ({ label: r.label, v: any(candidates.map(r.judge)) }));
  const failing = alone.filter((r) => r.v === joint);
  const named = failing.length > 0 ? failing.map((r) => r.label) : [rows.map((r) => r.label).join(" + ")];
  for (const label of named) {
    findings.push({
      met: joint,
      model: id,
      row: `models.dataPolicy ${label}`,
      detail: joint === "no" ? `${label}: no provider for ${id}` : `${label}: the gateway does not say whether a provider of ${id} meets it`,
    });
  }
  return findings;
}

export interface ConfigCheckInput {
  readonly models: readonly CheckedModel[];
  readonly targets: Readonly<Record<string, ModelTarget>>;
  readonly policy: ModelDataPolicy;
  readonly baseUrlFor: (via: string) => string | undefined;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export async function checkModelConfig(input: ConfigCheckInput): Promise<ConfigCheckResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const seen = new Map<string, CheckedModel & { via: string }>();
  for (const m of input.models) {
    const via = m.via ?? "gateway";
    seen.set(`${via}\u0000${m.id}`, { id: m.id, via });
  }
  const controller = new AbortController();
  const fuse = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  const servedBy = new Map<string, Set<string>>();
  try {
    const perModel = await Promise.all(
      [...seen.values()].map(async (m): Promise<ConfigFinding[]> => {
        const target = input.targets[m.via];
        if (target === undefined) return [{ met: "no", model: m.id, row: `via ${m.via}`, detail: `via ${m.via}: models.targets names no such target` }];
        let res: Response;
        try {
          res = await fetchImpl(modelEndpointsUrl(m.id, input.baseUrlFor(m.via)), { method: "GET", signal: controller.signal });
        } catch {
          return [{ met: "unknown", model: m.id, row: "endpoints", detail: `${m.id}: the gateway did not answer the endpoints read` }];
        }
        const retargeted = input.baseUrlFor(m.via) !== undefined;
        if (retargeted && (res.status === 404 || res.status === 405)) {
          return [{ met: "unknown", model: m.id, row: "endpoints", detail: `${m.id}: the target ${m.via} does not serve the endpoints read` }];
        }
        if (res.status === 404) return [{ met: "no", model: m.id, row: "model id", detail: `${m.id}: the gateway does not know this model` }];
        if (!res.ok) return [{ met: "unknown", model: m.id, row: "endpoints", detail: `${m.id}: the endpoints read answered HTTP ${res.status}` }];
        let eps: EndpointFacts[] | undefined;
        try {
          eps = parseEndpoints(await res.json());
        } catch {
          eps = undefined;
        }
        if (eps === undefined) return [{ met: "unknown", model: m.id, row: "endpoints", detail: `${m.id}: the endpoints read is not in the expected shape` }];
        const served = servedBy.get(m.via) ?? new Set<string>();
        for (const e of eps) served.add(e.provider);
        servedBy.set(m.via, served);
        return judgeModelEndpoints(m.id, eps, target, input.policy, m.via);
      }),
    );
    const findings = perModel.flat();
    for (const [via, served] of servedBy) {
      const readAll = ![...seen.values()].some((m) => m.via === via && findings.some((f) => f.model === m.id && f.row === "endpoints"));
      if (!readAll) continue;
      for (const slug of input.targets[via]?.providers?.only ?? []) {
        if (!served.has(slug)) findings.push({ met: "unknown", row: `models.targets.${via}.providers.only`, detail: `providers.only: "${slug}" serves none of the checked models` });
      }
    }
    const met: CheckVerdict = findings.some((f) => f.met === "no") ? "no" : findings.length > 0 ? "unknown" : "yes";
    return { met, findings, checked: seen.size };
  } finally {
    clearTimeout(fuse);
  }
}

export function configCheckSummary(r: ConfigCheckResult): string {
  const plural = r.checked === 1 ? "model" : "models";
  if (r.findings.length === 0) return `model config: ${r.checked} ${plural} checked, every demand can be served`;
  const no = r.findings.filter((f) => f.met === "no");
  const shown = (no.length > 0 ? no : r.findings).map((f) => f.detail);
  const head = no.length > 0 ? `${no.length} problem${no.length === 1 ? "" : "s"}` : "not fully measured";
  return `model config: ${head} — ${shown.slice(0, 3).join("; ")}${shown.length > 3 ? `; and ${shown.length - 3} more` : ""}`;
}
