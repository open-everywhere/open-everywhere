export const DEPLOY_STATUS_PATH = "/eve/v1/oe/status";

export const DEPLOYED_ENV_REQUIREMENTS = ["secrets", "postgres", "model-route"] as const;

export type Verdict = "yes" | "no" | "unknown";

export interface DeployedRequirement {
  readonly id: string;
  readonly met: Verdict;
  readonly detail: string;
}

export type DeployedStatusRead =
  | { readonly ok: true; readonly url: string; readonly requirements: readonly DeployedRequirement[] }
  | { readonly ok: false; readonly url: string; readonly detail: string };

const VERDICTS: readonly string[] = ["yes", "no", "unknown"];

export function parseStatusRequirements(body: unknown): DeployedRequirement[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const rows = (body as { requirements?: unknown }).requirements;
  if (!Array.isArray(rows)) return undefined;
  const out: DeployedRequirement[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return undefined;
    const { id, met, detail } = row as Record<string, unknown>;
    if (typeof id !== "string" || typeof met !== "string" || !VERDICTS.includes(met)) return undefined;
    out.push({ id, met: met as Verdict, detail: typeof detail === "string" ? detail : "" });
  }
  return out;
}

export async function readDeployedStatus(origin: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<DeployedStatusRead> {
  const url = `${origin}${DEPLOY_STATUS_PATH}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  } catch (err) {
    return { ok: false, url, detail: `${url} did not answer (${err instanceof Error ? err.message : String(err)})` };
  }
  if (res.status !== 200) return { ok: false, url, detail: `${url} answered ${res.status}, not the status document` };
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return { ok: false, url, detail: `${url} answered 200, but the body is not JSON` };
  }
  const requirements = parseStatusRequirements(body);
  if (requirements === undefined) return { ok: false, url, detail: `${url} answered 200, but the body is not a status document` };
  return { ok: true, url, requirements };
}

export function deployedEnvVerdict(requirements: readonly DeployedRequirement[]): { satisfied: boolean; summary: string } {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const rows = DEPLOYED_ENV_REQUIREMENTS.map((id) => byId.get(id) ?? { id, met: "unknown" as const, detail: "not in the document" });
  const satisfied = byId.get("secrets")?.met === "yes" && rows.every((r) => r.met !== "no");
  return { satisfied, summary: rows.map((r) => `${r.id}=${r.met} (${r.detail})`).join("; ") };
}
