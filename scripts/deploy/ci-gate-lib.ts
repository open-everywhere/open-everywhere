import { fetchChangedPaths } from "../ci/changed-paths.js";
import { isSkippableDiff, runtimePaths } from "../ci/skippable-paths.js";
import { CLOUD_PROOF_CONTEXT } from "./cloud-proof-post-lib.js";
import { type Exec, realExec } from "./lib.js";

export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
};

const PASSING_CONCLUSIONS = new Set(["success", "neutral"]);

export const HEAVY_JOB_NAME = "eve build + integration tier";

export type CiGateClassification = {
  pending: CheckRun[];
  failing: CheckRun[];
  cancelled: CheckRun[];
  passing: CheckRun[];
};

export function classifyCheckRuns(checkRuns: CheckRun[]): CiGateClassification {
  const result: CiGateClassification = { pending: [], failing: [], cancelled: [], passing: [] };
  for (const run of checkRuns) {
    if (run.status !== "completed") {
      result.pending.push(run);
    } else if (run.conclusion === "cancelled") {
      result.cancelled.push(run);
    } else if (run.conclusion !== null && PASSING_CONCLUSIONS.has(run.conclusion)) {
      result.passing.push(run);
    } else {
      result.failing.push(run);
    }
  }
  return result;
}

export type CiGateDecision = { verdict: "pass"; message: string } | { verdict: "refuse"; message: string };

export function decideCiGate(input: { sha: string; checkRuns: CheckRun[]; isTip: boolean }): CiGateDecision {
  const { sha, checkRuns, isTip } = input;
  const short = sha.slice(0, 12);

  if (checkRuns.length === 0) {
    return isTip
      ? {
          verdict: "refuse",
          message: `no CI run found yet for ${short} — the main-push workflow may not have started. Retry in a few minutes; never deploy an unproven tip.`,
        }
      : {
          verdict: "refuse",
          message: `no CI run found for ${short}, and it is not the tip of main — its run may never have reported (tip-wins concurrency, OPE-1099/ci.yml). Deploy the current tip of main instead; its own run is the proof.`,
        };
  }

  const { pending, failing, cancelled, passing } = classifyCheckRuns(checkRuns);

  if (pending.length > 0) {
    const names = pending.map((r) => r.name).join(", ");
    return {
      verdict: "refuse",
      message: `CI is still in flight for ${short} (${names}) — retry in about 10 minutes once it completes. This gate does not wait; it re-checks on the next invocation.`,
    };
  }

  if (failing.length > 0) {
    const names = failing.map((r) => `${r.name} (${r.conclusion ?? "no conclusion"})`).join(", ");
    return { verdict: "refuse", message: `CI is red for ${short}: ${names}. Fix or revert on main before deploying — a red main-push run is fix-forward priority.` };
  }

  if (cancelled.length > 0) {
    const names = cancelled.map((r) => r.name).join(", ");
    return isTip
      ? {
          verdict: "refuse",
          message: `CI for the tip ${short} shows cancelled (${names}), with no later commit to explain it — investigate before deploying. A cancelled run is never read as a pass.`,
        }
      : {
          verdict: "refuse",
          message: `CI for ${short} was cancelled (${names}) — a later push on main superseded it (tip-wins concurrency, expected, not a red). Deploy the current tip of main; its own run is the proof.`,
        };
  }

  if (passing.length === checkRuns.length && passing.length > 0) {
    return { verdict: "pass", message: `CI is green for ${short}: ${checkRuns.map((r) => r.name).join(", ")}.` };
  }

  return { verdict: "refuse", message: `could not classify CI state for ${short} from ${checkRuns.length} check-run(s) — refusing rather than guessing.` };
}

export type FetchCheckRunsResult = { ok: true; checkRuns: CheckRun[] } | { ok: false; reason: string };

function parseCheckRunsResponse(body: unknown): CheckRun[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>).check_runs;
  if (!Array.isArray(raw)) return undefined;
  const runs: CheckRun[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    runs.push({
      name: typeof rec.name === "string" ? rec.name : "unnamed check-run",
      status: typeof rec.status === "string" ? rec.status : "unknown",
      conclusion: typeof rec.conclusion === "string" ? rec.conclusion : null,
    });
  }
  return runs;
}

export async function fetchCheckRunsForSha(input: { sha: string; exec?: Exec }): Promise<FetchCheckRunsResult> {
  const exec = input.exec ?? realExec;
  const res = await exec("gh", ["api", `repos/{owner}/{repo}/commits/${input.sha}/check-runs`, "--method", "GET", "-f", "per_page=100"]);

  if (res.spawnError) {
    return { ok: false, reason: `could not run \`gh\` (${res.spawnError}) — is the GitHub CLI installed, on PATH, and authenticated?` };
  }
  if (res.code !== 0) {
    return { ok: false, reason: `\`gh api\` exited ${res.code}: ${(res.stderr || res.stdout || "no output").trim().slice(0, 500)}` };
  }

  let body: unknown;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    return { ok: false, reason: `\`gh api\` returned output that is not JSON: ${res.stdout.slice(0, 200)}` };
  }

  const checkRuns = parseCheckRunsResponse(body);
  if (checkRuns === undefined) {
    return { ok: false, reason: "the check-runs response has no `check_runs` array — cannot evaluate CI state" };
  }
  return { ok: true, checkRuns };
}

export type HeavyJobStatus =
  | { kind: "success" }
  | { kind: "skipped" }
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "red"; conclusion: string | null };

export function classifyHeavyJob(checkRuns: CheckRun[]): HeavyJobStatus {
  const run = checkRuns.find((r) => r.name === HEAVY_JOB_NAME);
  if (!run) return { kind: "absent" };
  if (run.status !== "completed") return { kind: "pending" };
  if (run.conclusion === "success" || run.conclusion === "neutral") return { kind: "success" };
  if (run.conclusion === "skipped") return { kind: "skipped" };
  return { kind: "red", conclusion: run.conclusion };
}

export const WALK_BACK_MAX_DEPTH = 50;

export type AncestorListResult = { ok: true; shas: string[] } | { ok: false; reason: string };

export async function listFirstParentAncestors(input: { sha: string; count: number; exec?: Exec }): Promise<AncestorListResult> {
  const exec = input.exec ?? realExec;
  const res = await exec("git", ["rev-list", "--first-parent", "-n", String(input.count), input.sha]);
  if (res.spawnError) {
    return { ok: false, reason: `could not run \`git rev-list\` (${res.spawnError})` };
  }
  if (res.code !== 0) {
    return {
      ok: false,
      reason: `\`git rev-list --first-parent -n ${input.count} ${input.sha}\` exited ${res.code}: ${(res.stderr || res.stdout || "no output").trim().slice(0, 500)}`,
    };
  }
  const shas = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (shas.length === 0) {
    return { ok: false, reason: `\`git rev-list\` returned no commits for ${input.sha} — is this a shallow checkout, or an unresolvable sha?` };
  }
  return { ok: true, shas };
}

export async function walkBackForHeavyProof(input: { sha: string; exec?: Exec; maxDepth?: number }): Promise<CiGateDecision> {
  const exec = input.exec ?? realExec;
  const maxDepth = input.maxDepth ?? WALK_BACK_MAX_DEPTH;
  const short = input.sha.slice(0, 12);

  const ancestors = await listFirstParentAncestors({ sha: input.sha, count: maxDepth + 1, exec });
  if (!ancestors.ok) {
    return { verdict: "refuse", message: `walk-back for ${short}: could not list ancestor commits (${ancestors.reason}) — refusing rather than guessing.` };
  }

  for (let i = 1; i < ancestors.shas.length; i++) {
    const candidate = ancestors.shas[i];
    const candidateShort = candidate.slice(0, 12);
    const fetched = await fetchCheckRunsForSha({ sha: candidate, exec });
    if (!fetched.ok) {
      return { verdict: "refuse", message: `walk-back for ${short}: could not read CI state for ancestor ${candidateShort} (${fetched.reason}) — refusing.` };
    }

    const heavy = classifyHeavyJob(fetched.checkRuns);
    if (heavy.kind === "skipped") continue;

    if (heavy.kind !== "success") {
      const shown = heavy.kind === "red" ? `red: ${heavy.conclusion ?? "no conclusion"}` : heavy.kind;
      return { verdict: "refuse", message: `walk-back for ${short}: ancestor ${candidateShort} has no usable heavy-job proof (${shown}) — refusing rather than guessing.` };
    }

    const diff = await fetchChangedPaths({ before: candidate, after: input.sha, exec });
    if (!diff.ok) {
      return { verdict: "refuse", message: `walk-back for ${short}: found a green heavy run at ${candidateShort}, but could not read the diff since then (${diff.reason}) — refusing.` };
    }
    if (isSkippableDiff(diff.paths)) {
      return {
        verdict: "pass",
        message: `CI is green for ${short}: the heavy job was legitimately skipped (non-runtime diff), covered by the green heavy run at ${candidateShort}.`,
      };
    }
    const blocking = runtimePaths(diff.paths);
    const shown = blocking.slice(0, 10).join(", ") + (blocking.length > 10 ? ", …" : "");
    return {
      verdict: "refuse",
      message: `walk-back for ${short}: the nearest green heavy run is ${candidateShort}, but the diff since then includes runtime path(s) the workflow's own skip never covered: ${shown} — waiting for this sha's own heavy run.`,
    };
  }

  return { verdict: "refuse", message: `walk-back for ${short}: no green heavy run found within ${maxDepth} ancestor commit(s) — refusing rather than guessing.` };
}

export type CommitStatus = { context: string; state: string };

function parseCombinedStatusResponse(body: unknown): CommitStatus[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>).statuses;
  if (!Array.isArray(raw)) return undefined;
  const statuses: CommitStatus[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.context === "string" && typeof rec.state === "string") {
      statuses.push({ context: rec.context, state: rec.state });
    }
  }
  return statuses;
}

export type FetchCombinedStatusResult = { ok: true; statuses: CommitStatus[] } | { ok: false; reason: string };

export async function fetchCombinedStatusForSha(input: { sha: string; exec?: Exec }): Promise<FetchCombinedStatusResult> {
  const exec = input.exec ?? realExec;
  const res = await exec("gh", ["api", `repos/{owner}/{repo}/commits/${input.sha}/status`, "--method", "GET"]);

  if (res.spawnError) {
    return { ok: false, reason: `could not run \`gh\` (${res.spawnError}) — is the GitHub CLI installed, on PATH, and authenticated?` };
  }
  if (res.code !== 0) {
    return { ok: false, reason: `\`gh api\` exited ${res.code}: ${(res.stderr || res.stdout || "no output").trim().slice(0, 500)}` };
  }

  let body: unknown;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    return { ok: false, reason: `\`gh api\` returned output that is not JSON: ${res.stdout.slice(0, 200)}` };
  }

  const statuses = parseCombinedStatusResponse(body);
  if (statuses === undefined) {
    return { ok: false, reason: "the combined status response has no `statuses` array — cannot evaluate cloud-proof state" };
  }
  return { ok: true, statuses };
}

export type CloudProofStatus = { kind: "success" } | { kind: "absent" } | { kind: "pending" } | { kind: "red"; state: string };

const CLOUD_PROOF_PASSING_STATES = new Set(["success"]);
const CLOUD_PROOF_PENDING_STATES = new Set(["pending"]);

export function classifyCloudProofStatus(statuses: CommitStatus[]): CloudProofStatus {
  const status = statuses.find((s) => s.context === CLOUD_PROOF_CONTEXT);
  if (!status) return { kind: "absent" };
  if (CLOUD_PROOF_PASSING_STATES.has(status.state)) return { kind: "success" };
  if (CLOUD_PROOF_PENDING_STATES.has(status.state)) return { kind: "pending" };
  return { kind: "red", state: status.state };
}

export async function walkBackForCloudProof(input: { sha: string; exec?: Exec; maxDepth?: number }): Promise<CiGateDecision> {
  const exec = input.exec ?? realExec;
  const maxDepth = input.maxDepth ?? WALK_BACK_MAX_DEPTH;
  const short = input.sha.slice(0, 12);

  const ancestors = await listFirstParentAncestors({ sha: input.sha, count: maxDepth + 1, exec });
  if (!ancestors.ok) {
    return { verdict: "refuse", message: `cloud-proof walk-back for ${short}: could not list ancestor commits (${ancestors.reason}) — refusing rather than guessing.` };
  }

  for (let i = 1; i < ancestors.shas.length; i++) {
    const candidate = ancestors.shas[i];
    const candidateShort = candidate.slice(0, 12);
    const fetched = await fetchCombinedStatusForSha({ sha: candidate, exec });
    if (!fetched.ok) {
      return { verdict: "refuse", message: `cloud-proof walk-back for ${short}: could not read status for ancestor ${candidateShort} (${fetched.reason}) — refusing.` };
    }

    const cloud = classifyCloudProofStatus(fetched.statuses);
    if (cloud.kind === "absent") continue;

    if (cloud.kind !== "success") {
      const shown = cloud.kind === "red" ? `red: ${cloud.state}` : cloud.kind;
      return { verdict: "refuse", message: `cloud-proof walk-back for ${short}: ancestor ${candidateShort} has no usable oe/cloud-proof proof (${shown}) — refusing rather than guessing.` };
    }

    const diff = await fetchChangedPaths({ before: candidate, after: input.sha, exec });
    if (!diff.ok) {
      return { verdict: "refuse", message: `cloud-proof walk-back for ${short}: found a green oe/cloud-proof at ${candidateShort}, but could not read the diff since then (${diff.reason}) — refusing.` };
    }
    if (isSkippableDiff(diff.paths)) {
      return {
        verdict: "pass",
        message: `CI is green for ${short} via oe/cloud-proof: no GitHub check-run exists for this sha, but the nearest ancestor with a green oe/cloud-proof status is ${candidateShort} and the diff since then is non-runtime.`,
      };
    }
    const blocking = runtimePaths(diff.paths);
    const shown = blocking.slice(0, 10).join(", ") + (blocking.length > 10 ? ", …" : "");
    return {
      verdict: "refuse",
      message: `cloud-proof walk-back for ${short}: the nearest green oe/cloud-proof is at ${candidateShort}, but the diff since then includes runtime path(s): ${shown} — refusing.`,
    };
  }

  return { verdict: "refuse", message: `cloud-proof walk-back for ${short}: no green oe/cloud-proof status found within ${maxDepth} ancestor commit(s) — refusing rather than guessing.` };
}

export async function decideCiGateViaCloudProof(input: { sha: string; isTip: boolean; exec?: Exec }): Promise<CiGateDecision> {
  const exec = input.exec ?? realExec;
  const short = input.sha.slice(0, 12);
  const fetched = await fetchCombinedStatusForSha({ sha: input.sha, exec });
  if (!fetched.ok) {
    return {
      verdict: "refuse",
      message: `no GitHub check-run exists for ${short}, and its oe/cloud-proof status could not be read (${fetched.reason}) — refusing rather than guessing.`,
    };
  }

  const cloud = classifyCloudProofStatus(fetched.statuses);
  if (cloud.kind === "success") {
    return { verdict: "pass", message: `CI is green for ${short} via oe/cloud-proof (no GitHub check-run exists for this sha; oe/cloud-proof reports success).` };
  }
  if (cloud.kind === "pending") {
    return { verdict: "refuse", message: `oe/cloud-proof is still pending for ${short} — retry once it completes.` };
  }
  if (cloud.kind === "red") {
    return { verdict: "refuse", message: `oe/cloud-proof is red for ${short} (${cloud.state}) — refusing.` };
  }
  return walkBackForCloudProof({ sha: input.sha, exec });
}

export async function runCiGate(input: { sha: string; isTip: boolean; exec?: Exec }): Promise<CiGateDecision> {
  const exec = input.exec ?? realExec;
  const fetched = await fetchCheckRunsForSha({ sha: input.sha, exec });
  if (!fetched.ok) {
    return { verdict: "refuse", message: `could not read CI state for ${input.sha.slice(0, 12)}: ${fetched.reason}` };
  }

  if (fetched.checkRuns.length === 0) {
    return decideCiGateViaCloudProof({ sha: input.sha, isTip: input.isTip, exec });
  }

  const decision = decideCiGate({ sha: input.sha, checkRuns: fetched.checkRuns, isTip: input.isTip });
  if (decision.verdict === "pass") return decision;

  const heavy = classifyHeavyJob(fetched.checkRuns);
  const others = fetched.checkRuns.filter((r) => r.name !== HEAVY_JOB_NAME);
  const othersGreen = others.length > 0 && others.every((r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "neutral"));
  if (heavy.kind !== "skipped" || !othersGreen) {
    return decision;
  }

  return walkBackForHeavyProof({ sha: input.sha, exec });
}
