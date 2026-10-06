import { fetchChangedPaths } from "../ci/changed-paths.js";
import { isSkippableDiff, runtimePaths } from "../ci/skippable-paths.js";
import { CLOUD_PROOF_CONTEXT } from "./cloud-proof-post-lib.js";
import {
  EXEC_TIMEOUT_MS,
  type Env,
  type Exec,
  pinGhRepoPlaceholders,
  realExec,
  resolveGithubApiBase,
  resolveGithubOwnerRepoFromEnv,
  withExecDeadline,
} from "./lib.js";
import { ensureProxyDispatcher } from "./proxy-dispatcher.js";

export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
};

const PASSING_CONCLUSIONS = new Set(["success", "neutral"]);

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
          message: `no CI run found for ${short}, and it is not the tip of main — its run may never have reported (tip-wins concurrency on a fork that runs Actions). Deploy the current tip of main instead; its own run is the proof.`,
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

export type GithubApiFetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export const GITHUB_API_TIMEOUT_MS = 30_000;

export const realGithubApiFetch: GithubApiFetchLike = async (url, init) => {
  ensureProxyDispatcher();
  const res = await fetch(url, { headers: init.headers, signal: init.signal });
  return { status: res.status, text: () => res.text() };
};

export function resolveGithubRestToken(env: Env): string | undefined {
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined;
}

export function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | undefined {
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

export async function resolveGithubOwnerRepoFromGit(exec: Exec): Promise<{ owner: string; repo: string } | undefined> {
  const res = await exec("git", ["remote", "get-url", "origin"]);
  if (res.spawnError || res.code !== 0) return undefined;
  return parseGithubOwnerRepo(res.stdout);
}

export type GithubApiBody = { ok: true; body: unknown } | { ok: false; reason: string; http?: { status: number; text: string } };

function parseJsonBody(text: string): GithubApiBody {
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, reason: `response is not JSON: ${text.slice(0, 200)}` };
  }
}

export async function fetchGithubApi(input: {
  ghArgs: string[];
  restPathSuffix: string;
  exec: Exec;
  fetchImpl: GithubApiFetchLike;
  env: Env;
  timeoutMs?: number;
  execTimeoutMs?: number;
}): Promise<GithubApiBody> {
  const ghArgs = pinGhRepoPlaceholders(input.ghArgs, input.env);
  const res = await withExecDeadline(input.exec, input.execTimeoutMs)("gh", ghArgs);

  if (res.timedOutMs !== undefined) {
    return { ok: false, reason: `\`gh ${ghArgs.join(" ")}\` timed out after ${res.timedOutMs}ms — refusing rather than waiting.` };
  }

  if (!res.spawnError) {
    if (res.code !== 0) {
      return { ok: false, reason: `\`gh api\` exited ${res.code}: ${(res.stderr || res.stdout || "no output").trim().slice(0, 500)}` };
    }
    return parseJsonBody(res.stdout);
  }

  const token = resolveGithubRestToken(input.env);
  if (!token) {
    return {
      ok: false,
      reason:
        `could not run \`gh\` (${res.spawnError}) — install the GitHub CLI and put it on PATH, ` +
        "or set GH_TOKEN (or GITHUB_TOKEN) to let this gate read CI state over the GitHub REST API instead.",
    };
  }

  const ownerRepo = resolveGithubOwnerRepoFromEnv(input.env) ?? (await resolveGithubOwnerRepoFromGit(input.exec));
  if (!ownerRepo) {
    return {
      ok: false,
      reason:
        `could not run \`gh\` (${res.spawnError}); a token is set for the REST fallback, but neither GITHUB_REPOSITORY ` +
        "nor `git remote get-url origin` named a github.com owner/repo to read.",
    };
  }

  const suffix = input.restPathSuffix ? `/${input.restPathSuffix}` : "";
  const url = `${resolveGithubApiBase(input.env)}/repos/${ownerRepo.owner}/${ownerRepo.repo}${suffix}`;
  const timeoutMs = input.timeoutMs ?? GITHUB_API_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`no response after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let httpRes: { status: number; text(): Promise<string> };
  let text: string;
  try {
    const read = (async () => {
      const res = await input.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      return { res, body: await res.text() };
    })();
    const got = await Promise.race([read, deadline]);
    httpRes = got.res;
    text = got.body;
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        reason: `REST fallback GET ${url} timed out after ${timeoutMs}ms — no answer from the GitHub REST API within the deadline; refusing rather than waiting.`,
      };
    }
    return { ok: false, reason: `REST fallback GET ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (httpRes.status < 200 || httpRes.status >= 300) {
    return { ok: false, reason: `REST fallback GET ${url} → HTTP ${httpRes.status}: ${text.slice(0, 500)}`, http: { status: httpRes.status, text } };
  }
  return parseJsonBody(text);
}

export const GITHUB_API_PAGE_SIZE = 100;

export const GITHUB_API_MAX_PAGES = 10;

function exhaustedPagesReason(input: { received: number; pages: number; what: string }): string {
  return (
    `the ${input.what} read filled all ${input.pages} pages this gate will follow (${input.received} record(s) at ` +
    `per_page=${GITHUB_API_PAGE_SIZE}), so GitHub may still hold more behind it. A red record beyond the last page ` +
    "would be invisible — refusing rather than passing on a read that cannot be shown to be complete."
  );
}

function selfInconsistentCountReason(input: { received: number; totalCount: unknown; pages: number; what: string }): string | undefined {
  if (input.pages !== 1) return undefined;
  const total = typeof input.totalCount === "number" && Number.isFinite(input.totalCount) ? input.totalCount : undefined;
  if (total === undefined || total === input.received) return undefined;
  return (
    `the ${input.what} response does not describe itself consistently: GitHub reports total_count=${total} but this page carries ${input.received} record(s). ` +
    "This gate cannot tell which is the true set — refusing rather than passing on a read it cannot trust."
  );
}

export type PageRecords = { records: unknown[]; totalCount: unknown } | undefined;

export type PagedRecordsResult =
  | { ok: true; records: unknown[]; pages: number; totalCount: unknown }
  | { ok: false; reason: string; http?: { status: number; text: string } };

async function fetchPagedRecords(input: {
  ghArgsFor: (page: number) => string[];
  restPathSuffixFor: (page: number) => string;
  read: (body: unknown) => PageRecords;
  shapeReason: string;
  what: string;
  exec: Exec;
  fetchImpl: GithubApiFetchLike;
  env: Env;
  maxPages?: number;
}): Promise<PagedRecordsResult> {
  const maxPages = input.maxPages ?? GITHUB_API_MAX_PAGES;
  const records: unknown[] = [];
  let totalCount: unknown;
  let pages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchGithubApi({
      ghArgs: input.ghArgsFor(page),
      restPathSuffix: input.restPathSuffixFor(page),
      exec: input.exec,
      fetchImpl: input.fetchImpl,
      env: input.env,
    });
    if (!raw.ok) return { ok: false, reason: raw.reason, ...(raw.http ? { http: raw.http } : {}) };

    const got = input.read(raw.body);
    if (got === undefined) return { ok: false, reason: input.shapeReason };
    pages = page;
    records.push(...got.records);
    if (page === 1) totalCount = got.totalCount;
    if (got.records.length < GITHUB_API_PAGE_SIZE) {
      const inconsistent = selfInconsistentCountReason({ received: records.length, totalCount, pages, what: input.what });
      return inconsistent ? { ok: false, reason: inconsistent } : { ok: true, records, pages, totalCount };
    }
  }

  return { ok: false, reason: exhaustedPagesReason({ received: records.length, pages: maxPages, what: input.what }) };
}

export const PAT_FORBIDDEN_MESSAGE_MARKER = "not accessible by personal access token";

export function isTokenForbiddenResponse(http: { status: number; text: string } | undefined): boolean {
  if (!http || http.status !== 403) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(http.text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const message = (parsed as Record<string, unknown>).message;
  return typeof message === "string" && message.toLowerCase().includes(PAT_FORBIDDEN_MESSAGE_MARKER);
}

export type FetchCheckRunsResult = { ok: true; checkRuns: CheckRun[] } | { ok: false; reason: string; forbiddenForToken?: true };

function readCheckRunsPage(body: unknown): PageRecords {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  if (!Array.isArray(rec.check_runs)) return undefined;
  return { records: rec.check_runs, totalCount: rec.total_count };
}

const NO_CHECK_RUNS_ARRAY = "the check-runs response has no `check_runs` array — cannot evaluate CI state";

function parseCheckRunsRecords(raw: readonly unknown[]): FetchCheckRunsResult {
  const runs: CheckRun[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const entryRec = entry as Record<string, unknown>;
    runs.push({
      name: typeof entryRec.name === "string" ? entryRec.name : "unnamed check-run",
      status: typeof entryRec.status === "string" ? entryRec.status : "unknown",
      conclusion: typeof entryRec.conclusion === "string" ? entryRec.conclusion : null,
    });
  }
  return { ok: true, checkRuns: runs };
}

export async function fetchCheckRunsForSha(input: {
  sha: string;
  exec?: Exec;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
  maxPages?: number;
}): Promise<FetchCheckRunsResult> {
  const raw = await fetchPagedRecords({
    ghArgsFor: (page) => [
      "api",
      `repos/{owner}/{repo}/commits/${input.sha}/check-runs`,
      "--method",
      "GET",
      "-f",
      `per_page=${GITHUB_API_PAGE_SIZE}`,
      "-f",
      `page=${page}`,
    ],
    restPathSuffixFor: (page) => `commits/${input.sha}/check-runs?per_page=${GITHUB_API_PAGE_SIZE}&page=${page}`,
    read: readCheckRunsPage,
    shapeReason: NO_CHECK_RUNS_ARRAY,
    what: "check-runs",
    exec: input.exec ?? realExec,
    fetchImpl: input.fetchImpl ?? realGithubApiFetch,
    env: input.env ?? process.env,
    ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
  });
  if (!raw.ok) {
    return isTokenForbiddenResponse(raw.http) ? { ok: false, reason: raw.reason, forbiddenForToken: true } : { ok: false, reason: raw.reason };
  }

  return parseCheckRunsRecords(raw.records);
}

export const WALK_BACK_MAX_DEPTH = 50;

export type AncestorListResult = { ok: true; shas: string[] } | { ok: false; reason: string };

export async function listFirstParentAncestors(input: { sha: string; count: number; exec?: Exec; execTimeoutMs?: number }): Promise<AncestorListResult> {
  const exec = withExecDeadline(input.exec ?? realExec, input.execTimeoutMs ?? EXEC_TIMEOUT_MS);
  const res = await exec("git", ["rev-list", "--first-parent", "-n", String(input.count), input.sha]);
  if (res.timedOutMs !== undefined) {
    return { ok: false, reason: `\`git rev-list\` timed out after ${res.timedOutMs}ms — refusing rather than waiting.` };
  }
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

export type CheckRunsReadOutcome = { kind: "empty" } | { kind: "forbidden" };

function checkRunsClause(outcome: CheckRunsReadOutcome, short: string): string {
  return outcome.kind === "forbidden"
    ? `check-runs for ${short} could not be read with this token (HTTP 403, ${PAT_FORBIDDEN_MESSAGE_MARKER})`
    : `no GitHub check-run exists for ${short}`;
}

export type CommitStatus = { context: string; state: string };

export type FetchCombinedStatusResult = { ok: true; statuses: CommitStatus[] } | { ok: false; reason: string };

function readCombinedStatusPage(body: unknown): PageRecords {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  if (!Array.isArray(rec.statuses)) return undefined;
  return { records: rec.statuses, totalCount: rec.total_count };
}

const NO_STATUSES_ARRAY = "the combined status response has no `statuses` array — cannot evaluate cloud-proof state";

function parseCombinedStatusRecords(raw: readonly unknown[]): FetchCombinedStatusResult {
  const statuses: CommitStatus[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const entryRec = entry as Record<string, unknown>;
    if (typeof entryRec.context === "string" && typeof entryRec.state === "string") {
      statuses.push({ context: entryRec.context, state: entryRec.state });
    }
  }
  return { ok: true, statuses };
}

export async function fetchCombinedStatusForSha(input: {
  sha: string;
  exec?: Exec;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
  maxPages?: number;
}): Promise<FetchCombinedStatusResult> {
  const raw = await fetchPagedRecords({
    ghArgsFor: (page) => [
      "api",
      `repos/{owner}/{repo}/commits/${input.sha}/status`,
      "--method",
      "GET",
      "-f",
      `per_page=${GITHUB_API_PAGE_SIZE}`,
      "-f",
      `page=${page}`,
    ],
    restPathSuffixFor: (page) => `commits/${input.sha}/status?per_page=${GITHUB_API_PAGE_SIZE}&page=${page}`,
    read: readCombinedStatusPage,
    shapeReason: NO_STATUSES_ARRAY,
    what: "combined status",
    exec: input.exec ?? realExec,
    fetchImpl: input.fetchImpl ?? realGithubApiFetch,
    env: input.env ?? process.env,
    ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
  });
  if (!raw.ok) return { ok: false, reason: raw.reason };

  return parseCombinedStatusRecords(raw.records);
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

export async function walkBackForCloudProof(input: {
  sha: string;
  exec?: Exec;
  maxDepth?: number;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
  checkRunsRead?: CheckRunsReadOutcome;
}): Promise<CiGateDecision> {
  const exec = input.exec ?? realExec;
  const fetchImpl = input.fetchImpl ?? realGithubApiFetch;
  const env = input.env ?? process.env;
  const maxDepth = input.maxDepth ?? WALK_BACK_MAX_DEPTH;
  const short = input.sha.slice(0, 12);
  const clause = checkRunsClause(input.checkRunsRead ?? { kind: "empty" }, short);

  const ancestors = await listFirstParentAncestors({ sha: input.sha, count: maxDepth + 1, exec });
  if (!ancestors.ok) {
    return { verdict: "refuse", message: `cloud-proof walk-back for ${short}: could not list ancestor commits (${ancestors.reason}) — refusing rather than guessing.` };
  }

  for (let i = 1; i < ancestors.shas.length; i++) {
    const candidate = ancestors.shas[i];
    const candidateShort = candidate.slice(0, 12);
    const fetched = await fetchCombinedStatusForSha({ sha: candidate, exec, fetchImpl, env });
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
        message: `CI is green for ${short} via oe/cloud-proof: ${clause}, but the nearest ancestor with a green oe/cloud-proof status is ${candidateShort} and the diff since then is non-runtime.`,
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

export async function decideCiGateViaCloudProof(input: {
  sha: string;
  isTip: boolean;
  exec?: Exec;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
  checkRunsRead?: CheckRunsReadOutcome;
}): Promise<CiGateDecision> {
  const exec = input.exec ?? realExec;
  const fetchImpl = input.fetchImpl ?? realGithubApiFetch;
  const env = input.env ?? process.env;
  const short = input.sha.slice(0, 12);
  const checkRunsRead = input.checkRunsRead ?? { kind: "empty" };
  const clause = checkRunsClause(checkRunsRead, short);
  const fetched = await fetchCombinedStatusForSha({ sha: input.sha, exec, fetchImpl, env });
  if (!fetched.ok) {
    return {
      verdict: "refuse",
      message: `${clause}, and its oe/cloud-proof status could not be read (${fetched.reason}) — refusing rather than guessing.`,
    };
  }

  const cloud = classifyCloudProofStatus(fetched.statuses);
  if (cloud.kind === "success") {
    return { verdict: "pass", message: `CI is green for ${short} via oe/cloud-proof (${clause}; oe/cloud-proof reports success).` };
  }
  if (cloud.kind === "pending") {
    return { verdict: "refuse", message: `oe/cloud-proof is still pending for ${short} — retry once it completes.` };
  }
  if (cloud.kind === "red") {
    return { verdict: "refuse", message: `oe/cloud-proof is red for ${short} (${cloud.state}) — refusing.` };
  }
  return walkBackForCloudProof({ sha: input.sha, exec, fetchImpl, env, checkRunsRead });
}

export async function runCiGate(input: { sha: string; isTip: boolean; exec?: Exec; fetchImpl?: GithubApiFetchLike; env?: Env }): Promise<CiGateDecision> {
  const exec = input.exec ?? realExec;
  const fetchImpl = input.fetchImpl ?? realGithubApiFetch;
  const env = input.env ?? process.env;
  const fetched = await fetchCheckRunsForSha({ sha: input.sha, exec, fetchImpl, env });
  if (!fetched.ok) {
    if (fetched.forbiddenForToken) {
      return decideCiGateViaCloudProof({ sha: input.sha, isTip: input.isTip, exec, fetchImpl, env, checkRunsRead: { kind: "forbidden" } });
    }
    return { verdict: "refuse", message: `could not read CI state for ${input.sha.slice(0, 12)}: ${fetched.reason}` };
  }

  if (fetched.checkRuns.length === 0) {
    return decideCiGateViaCloudProof({ sha: input.sha, isTip: input.isTip, exec, fetchImpl, env, checkRunsRead: { kind: "empty" } });
  }

  return decideCiGate({ sha: input.sha, checkRuns: fetched.checkRuns, isTip: input.isTip });
}
