import { prApiHeaders } from "../scm/pr.js";
import { parseConfigFacts, type ConfigFacts } from "./config-facts.js";
import { readZipTextEntry, ZipReadError } from "./zip.js";

export type ArtifactFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export const CONFIG_DIFF_WORKFLOW_PATH = ".github/workflows/config-diff.yml";

export const CONFIG_DIFF_ARTIFACT_NAME = "config-diff";

export const CONFIG_DIFF_JSON_ENTRY = "config-diff.json";

export const OVERLAY_GATE_ENTRY = "access-diff.md";

export const MAX_OVERLAY_REPORT_CHARS = 8000;

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const CONFIG_DIFF_TRIGGER_PATHS: readonly string[] = [
  "agent/**",
  "scripts/config-snapshot*.ts",
  "scripts/config-diff.ts",
  "scripts/access-diff.ts",
  ".github/workflows/config-diff.yml",
];

export function pathMatchesGlob(path: string, glob: string): boolean {
  const rx = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${rx}$`).test(path);
}

export function triggersConfigDiff(paths: readonly string[]): boolean {
  return paths.some((p) => CONFIG_DIFF_TRIGGER_PATHS.some((g) => pathMatchesGlob(p, g)));
}

export interface FactsProvenance {
  readonly repo: string;
  readonly headSha: string;
  readonly workflowPath: string;
  readonly runId: number;
  readonly runUrl: string;
  readonly runAttempt: number;
  readonly runConclusion: string | null;
  readonly artifactId: number;
  readonly artifactName: string;
}

export type FactsSource =
  | {
      readonly kind: "artifact";
      readonly facts: ConfigFacts;
      readonly provenance: FactsProvenance;
      readonly overlayGateReport: string | undefined;
    }
  | {
      readonly kind: "not-triggered";
      readonly reason: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

interface WorkflowRun {
  readonly id: number;
  readonly path?: string;
  readonly event?: string;
  readonly head_sha?: string;
  readonly html_url?: string;
  readonly run_attempt?: number;
  readonly conclusion?: string | null;
  readonly created_at?: string;
}

export interface FetchConfigFactsOpts {
  readonly repo: string;
  readonly headSha: string;
  readonly token: string;
  readonly changedPaths?: readonly string[];
  readonly fetchFn?: ArtifactFetchFn;
  readonly apiBase?: string;
}

export async function fetchConfigFacts(opts: FetchConfigFactsOpts): Promise<FactsSource> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as ArtifactFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const headers = prApiHeaders(opts.token);

  if (opts.changedPaths !== undefined && !triggersConfigDiff(opts.changedPaths)) {
    return {
      kind: "not-triggered",
      reason:
        `this PR touches none of the paths that trigger ${CONFIG_DIFF_WORKFLOW_PATH} (${CONFIG_DIFF_TRIGGER_PATHS.join(", ")}), ` +
        `so no resolved-config facts exist for it. That is a COMPUTED absence, not a blind spot: the deployer config is unchanged by ` +
        `this PR. It says nothing about the CODE the PR changes — code is reviewed as code (CODEOWNERS), and no config diff can see it.`,
    };
  }

  let runs: readonly WorkflowRun[];
  try {
    const res = await fetchFn(`${apiBase}/repos/${opts.repo}/actions/runs?head_sha=${encodeURIComponent(opts.headSha)}&per_page=100`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      return { kind: "unavailable", reason: `the workflow-run listing for ${opts.repo}@${opts.headSha.slice(0, 12)} failed: ${res.status} ${await safeText(res)}` };
    }
    const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
    runs = body.workflow_runs ?? [];
  } catch (err) {
    return { kind: "unavailable", reason: `the workflow-run listing could not be read: ${errText(err)}` };
  }

  const candidates = runs
    .filter((r) => r.path === CONFIG_DIFF_WORKFLOW_PATH)
    .filter((r) => r.head_sha === opts.headSha)
    .filter((r) => r.event === "pull_request")
    .sort((a, b) => (b.run_attempt ?? 1) - (a.run_attempt ?? 1) || (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id);

  if (candidates.length === 0) {
    const others = runs.filter((r) => r.path === CONFIG_DIFF_WORKFLOW_PATH).length;
    return {
      kind: "unavailable",
      reason:
        `no \`pull_request\` run of ${CONFIG_DIFF_WORKFLOW_PATH} exists for head sha ${opts.headSha.slice(0, 12)} ` +
        `(${runs.length} run(s) at this sha, ${others} of them from that workflow). Either CI has not finished, or the run was ` +
        `re-triggered by a different event. This is an UNKNOWN — the config facts for this PR are NOT established.`,
    };
  }
  const run = candidates[0];

  let artifact: { id: number; name: string } | undefined;
  try {
    const res = await fetchFn(`${apiBase}/repos/${opts.repo}/actions/runs/${run.id}/artifacts?per_page=100`, { method: "GET", headers });
    if (!res.ok) {
      return { kind: "unavailable", reason: `the artifact listing for run ${run.id} failed: ${res.status} ${await safeText(res)}` };
    }
    const body = (await res.json()) as { artifacts?: { id?: number; name?: string; expired?: boolean }[] };
    const hit = (body.artifacts ?? []).find((a) => a.name === CONFIG_DIFF_ARTIFACT_NAME && a.expired !== true && typeof a.id === "number");
    if (!hit) {
      const expired = (body.artifacts ?? []).some((a) => a.name === CONFIG_DIFF_ARTIFACT_NAME && a.expired === true);
      return {
        kind: "unavailable",
        reason: expired
          ? `run ${run.id}'s "${CONFIG_DIFF_ARTIFACT_NAME}" artifact has EXPIRED (Actions retention), so the facts it computed are gone. Re-run the workflow to recompute them. This is an UNKNOWN, not a pass.`
          : `run ${run.id} uploaded no "${CONFIG_DIFF_ARTIFACT_NAME}" artifact — the config-diff step may have failed before writing one. Read the run log: ${run.html_url ?? "(no url)"}. This is an UNKNOWN, not a pass.`,
      };
    }
    artifact = { id: hit.id!, name: hit.name! };
  } catch (err) {
    return { kind: "unavailable", reason: `the artifact listing could not be read: ${errText(err)}` };
  }

  let zip: Buffer;
  try {
    const res = await fetchFn(`${apiBase}/repos/${opts.repo}/actions/artifacts/${artifact.id}/zip`, { method: "GET", headers });
    if (!res.ok) {
      return { kind: "unavailable", reason: `downloading artifact ${artifact.id} failed: ${res.status} ${await safeText(res)}` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      return { kind: "unavailable", reason: `artifact ${artifact.id} is ${bytes.length} bytes, over the ${MAX_ARTIFACT_BYTES}-byte cap — refusing to read it` };
    }
    zip = bytes;
  } catch (err) {
    return { kind: "unavailable", reason: `artifact ${artifact.id} could not be downloaded: ${errText(err)}` };
  }

  let json: string;
  try {
    json = readZipTextEntry(zip, CONFIG_DIFF_JSON_ENTRY);
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `artifact ${artifact.id} does not yield ${CONFIG_DIFF_JSON_ENTRY}: ${err instanceof ZipReadError ? err.message : errText(err)}`,
    };
  }

  const parsed = parseConfigFacts(json);
  if (!parsed.ok) {
    return { kind: "unavailable", reason: `artifact ${artifact.id}'s ${CONFIG_DIFF_JSON_ENTRY} could not be read: ${parsed.reason}` };
  }

  let overlayGateReport: string | undefined;
  try {
    const text = readZipTextEntry(zip, OVERLAY_GATE_ENTRY);
    overlayGateReport = text.length > MAX_OVERLAY_REPORT_CHARS ? `${text.slice(0, MAX_OVERLAY_REPORT_CHARS)}\n…[clipped at ${MAX_OVERLAY_REPORT_CHARS} chars]` : text;
  } catch {
    overlayGateReport = undefined;
  }

  return {
    kind: "artifact",
    facts: parsed.facts,
    overlayGateReport,
    provenance: {
      repo: opts.repo,
      headSha: opts.headSha,
      workflowPath: CONFIG_DIFF_WORKFLOW_PATH,
      runId: run.id,
      runUrl: run.html_url ?? `https://github.com/${opts.repo}/actions/runs/${run.id}`,
      runAttempt: run.run_attempt ?? 1,
      runConclusion: run.conclusion ?? null,
      artifactId: artifact.id,
      artifactName: artifact.name,
    },
  };
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "(no body)";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
