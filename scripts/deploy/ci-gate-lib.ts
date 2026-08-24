import { type Exec, realExec } from "./lib.js";

export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
};

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

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

export async function runCiGate(input: { sha: string; isTip: boolean; exec?: Exec }): Promise<CiGateDecision> {
  const fetched = await fetchCheckRunsForSha({ sha: input.sha, exec: input.exec });
  if (!fetched.ok) {
    return { verdict: "refuse", message: `could not read CI state for ${input.sha.slice(0, 12)}: ${fetched.reason}` };
  }
  return decideCiGate({ sha: input.sha, checkRuns: fetched.checkRuns, isTip: input.isTip });
}
