import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOutMs?: number;
};
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

export const EXEC_TIMEOUT_MS = 60_000;

export const REAL_EXEC_TIMEOUT_MS = 300_000;

export const realExec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: REAL_EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      const failure = err as (Error & { code?: unknown; killed?: boolean }) | null;
      const rawCode = failure?.code;
      const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
      const spawnError = typeof rawCode === "string" ? `${rawCode}: ${(err as Error).message}` : undefined;
      const killedByTimeout = failure?.killed === true && typeof rawCode !== "string";
      resolve({
        code,
        stdout: String(stdout ?? ""),
        stderr: killedByTimeout ? `${execTimeoutNote(command, REAL_EXEC_TIMEOUT_MS)} ${String(stderr ?? "")}`.trim() : String(stderr ?? ""),
        ...(spawnError ? { spawnError } : {}),
        ...(killedByTimeout ? { timedOutMs: REAL_EXEC_TIMEOUT_MS } : {}),
      });
    });
  });

export function execTimeoutNote(command: string, timeoutMs: number): string {
  return `\`${command}\` did not finish within ${timeoutMs}ms and was killed — refusing rather than waiting.`;
}

export function withExecDeadline(exec: Exec, timeoutMs: number = EXEC_TIMEOUT_MS): Exec {
  return async (command, args) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ExecResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ code: 1, stdout: "", stderr: execTimeoutNote(command, timeoutMs), timedOutMs: timeoutMs }),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([exec(command, args), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export type Env = Record<string, string | undefined>;

export const GITHUB_API_BASE = "https://api.github.com";

export function resolveGithubApiBase(env: Env): string {
  return env.GITHUB_API_URL?.trim().replace(/\/+$/, "") || GITHUB_API_BASE;
}

export function resolveGithubOwnerRepoFromEnv(env: Env): { owner: string; repo: string } | undefined {
  const raw = env.GITHUB_REPOSITORY?.trim();
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return { owner: raw.slice(0, slash), repo: raw.slice(slash + 1) };
}

export function pinGhRepoPlaceholders(args: readonly string[], env: Env): string[] {
  const ownerRepo = resolveGithubOwnerRepoFromEnv(env);
  if (!ownerRepo) return [...args];
  const pin = (arg: string): string => arg.replaceAll("{owner}", ownerRepo.owner).replaceAll("{repo}", ownerRepo.repo);
  return args.map((arg, i) => {
    if (i === 1 && args[0] === "api") return pin(arg);
    if (i > 0 && (args[i - 1] === "-F" || args[i - 1] === "--field")) return pin(arg);
    if (arg.startsWith("--field=")) return pin(arg);
    return arg;
  });
}

export type DeployEnv = {
  scope: string;
  alias: string;
  project?: string;
  baseUrl: string;
  stateFile: string;
};

export const DEFAULT_STATE_FILE = join(".open-everywhere-deploy", "known-good.json");

export class DeployConfigError extends Error {}

function required(env: Env, name: string, why: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new DeployConfigError(
      `${name} is not set — ${why}.\n` +
        `  Set it in your shell (or a gitignored .env you source) before running this script.\n` +
        `  See docs/deploy/rollback.md for the full variable list.`,
    );
  }
  return value;
}

export function resolveDeployEnv(env: Env, cwd = process.cwd()): DeployEnv {
  const scope = required(env, "OE_DEPLOY_SCOPE", "the Vercel REST API needs a team/scope slug to qualify every call");
  const alias = required(
    env,
    "OE_DEPLOY_ALIAS",
    "this is the production alias the agent is served on (e.g. `my-agent.vercel.app`) — the thing rollback re-points",
  );
  const project = env.OE_DEPLOY_PROJECT?.trim() || undefined;
  const baseUrl = (env.OE_DEPLOY_BASE_URL?.trim() || `https://${alias}`).replace(/\/+$/, "");
  const configured = env.OE_DEPLOY_STATE_FILE?.trim() || DEFAULT_STATE_FILE;
  const stateFile = isAbsolute(configured) ? configured : join(cwd, configured);
  return { scope, alias, project, baseUrl, stateFile };
}

export function resolveControlToken(env: Env): string {
  const token = env.OE_DEPLOY_CONTROL_TOKEN?.trim() || env.E2E_CONTROL_READ_TOKEN?.trim();
  if (!token) {
    throw new DeployConfigError(
      "no control-plane read token — set OE_DEPLOY_CONTROL_TOKEN (or E2E_CONTROL_READ_TOKEN).\n" +
        "  It must be a token whose sha256 is listed in the deployment's OE_CONTROL_READ_TOKENS.\n" +
        "  Mint one: npm run mint:control-token -w @open-everywhere/core -- <name>",
    );
  }
  return token;
}

export type DeploymentRow = {
  url: string;
  state?: string;
  target?: string;
  raw: string;
};

export function normalizeDeploymentUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function deploymentKey(target: string): string {
  return target
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "");
}

export type InspectResult = { id?: string; url?: string; state?: string; createdAt?: string };

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function parseDeploymentRecord(body: unknown): InspectResult {
  const result: InspectResult = {};
  if (!isRecord(body)) return result;
  const id = firstString(body.id, body.uid);
  if (id) result.id = id;
  const url = firstString(body.url);
  if (url) result.url = normalizeDeploymentUrl(url);
  const state = firstString(body.readyState, body.status, body.state);
  if (state) result.state = state.toUpperCase();
  const created = firstNumber(body.createdAt, body.created);
  if (created !== undefined) {
    const date = new Date(created);
    if (!Number.isNaN(date.getTime())) result.createdAt = date.toISOString();
  }
  return result;
}

export function parseDeploymentList(body: unknown): DeploymentRow[] {
  const list = isRecord(body) && Array.isArray(body.deployments) ? body.deployments : [];
  const ranked: { row: DeploymentRow; created: number }[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const rawUrl = firstString(item.url);
    const url = rawUrl ? normalizeDeploymentUrl(rawUrl) : "";
    if (!url) continue;
    const state = firstString(item.readyState, item.state)?.toUpperCase();
    const target = firstString(item.target)?.toUpperCase();
    ranked.push({
      row: {
        url,
        ...(state ? { state } : {}),
        ...(target ? { target } : {}),
        raw: `${url} ${state ?? "?"} ${target ?? "?"}`,
      },
      created: firstNumber(item.created, item.createdAt) ?? 0,
    });
  }
  return ranked.sort((a, b) => b.created - a.created).map((entry) => entry.row);
}

export type DeployEntry = {
  url: string;
  id?: string;
  commit?: string;
  recordedAt: string;
  note?: string;
};

export type DeployState = {
  version: 1;
  lastGood?: DeployEntry;
  history: DeployEntry[];
};

export const HISTORY_LIMIT = 10;

export const EMPTY_STATE: DeployState = { version: 1, history: [] };

export function readState(path: string): DeployState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ...EMPTY_STATE, history: [] };
  }
  return parseState(text);
}

export function parseState(text: string): DeployState {
  try {
    const parsed = JSON.parse(text) as Partial<DeployState>;
    const history = Array.isArray(parsed.history) ? parsed.history.filter(isEntry) : [];
    const lastGood = isEntry(parsed.lastGood) ? parsed.lastGood : undefined;
    return { version: 1, ...(lastGood ? { lastGood } : {}), history };
  } catch {
    return { ...EMPTY_STATE, history: [] };
  }
}

function isEntry(value: unknown): value is DeployEntry {
  return typeof value === "object" && value !== null && typeof (value as DeployEntry).url === "string";
}

export function writeState(path: string, state: DeployState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function recordGood(state: DeployState, entry: DeployEntry): DeployState {
  if (state.lastGood && state.lastGood.url === entry.url) {
    return { version: 1, lastGood: entry, history: state.history.slice(0, HISTORY_LIMIT) };
  }
  const history = [...(state.lastGood ? [state.lastGood] : []), ...state.history]
    .filter((e) => e.url !== entry.url)
    .slice(0, HISTORY_LIMIT);
  return { version: 1, lastGood: entry, history };
}

export type RollbackChoice =
  | { kind: "explicit"; url: string; why: string }
  | { kind: "pointer"; url: string; why: string }
  | { kind: "pointer-history"; url: string; why: string }
  | { kind: "discovered"; url: string; why: string }
  | { kind: "none"; url?: undefined; why: string };

export function chooseRollbackTarget(input: {
  explicitTo?: string;
  state: DeployState;
  currentUrl?: string;
  discovered: DeploymentRow[];
}): RollbackChoice {
  const current = input.currentUrl ? normalizeDeploymentUrl(input.currentUrl) : undefined;

  if (input.explicitTo) {
    const url = normalizeDeploymentUrl(input.explicitTo);
    return { kind: "explicit", url, why: "--to was passed explicitly" };
  }

  const lastGood = input.state.lastGood;
  if (lastGood && lastGood.url !== current) {
    return {
      kind: "pointer",
      url: lastGood.url,
      why: `known-good pointer (recorded ${lastGood.recordedAt}${lastGood.commit ? `, commit ${lastGood.commit}` : ""})`,
    };
  }
  if (lastGood && lastGood.url === current) {
    const previous = input.state.history[0];
    if (previous) {
      return {
        kind: "pointer-history",
        url: previous.url,
        why: `alias is already on the recorded known-good — stepping back one hop (recorded ${previous.recordedAt})`,
      };
    }
  }

  for (const row of input.discovered) {
    if (row.state && row.state !== "READY") continue;
    if (current && row.url === current) continue;
    return { kind: "discovered", url: row.url, why: "newest READY deployment in the project listing that is not the current alias target" };
  }

  return {
    kind: "none",
    why:
      "nothing to roll back to — the known-good pointer is empty (run `npm run deploy:record` after a good deploy) " +
      "and the project listing offered no READY deployment other than the current one. Pass `--to <deployment-url>` to name one.",
  };
}

export type ProbeOutcome = { ok: boolean; status?: number; url: string; error?: string; attempts: number };

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number }>;

export function probeUrl(baseUrl: string, now: Date, lookbackMs = 60 * 60 * 1000): string {
  const since = new Date(now.getTime() - lookbackMs).toISOString();
  return `${baseUrl.replace(/\/+$/, "")}/control/v1/audit?since=${encodeURIComponent(since)}`;
}

export async function probeHealth(input: {
  baseUrl: string;
  token: string;
  fetchImpl: FetchLike;
  now?: Date;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<ProbeOutcome> {
  const attempts = Math.max(1, input.attempts ?? 3);
  const delayMs = input.delayMs ?? 5_000;
  const timeoutMs = input.timeoutMs ?? 20_000;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = input.log ?? (() => {});
  const url = probeUrl(input.baseUrl, input.now ?? new Date());

  let last: ProbeOutcome = { ok: false, url, error: "not attempted", attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await input.fetchImpl(url, {
        headers: { authorization: `Bearer ${input.token}` },
        signal: controller.signal,
      });
      last = { ok: res.status === 200, status: res.status, url, attempts: attempt };
      if (last.ok) return last;
      log(`  attempt ${attempt}/${attempts}: HTTP ${res.status}`);
    } catch (err) {
      last = { ok: false, url, error: err instanceof Error ? err.message : String(err), attempts: attempt };
      log(`  attempt ${attempt}/${attempts}: ${last.error}`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return last;
}

export function decideAfterProbe(input: { outcome: ProbeOutcome; noRollback: boolean }):
  | { action: "pass"; message: string }
  | { action: "rollback"; message: string }
  | { action: "fail"; message: string } {
  if (input.outcome.ok) return { action: "pass", message: `HTTP 200 from ${input.outcome.url}` };

  if (input.outcome.status === 401) {
    return {
      action: "fail",
      message:
        "HTTP 401 — the deployment answered, so the lambda IS up; the probe token is wrong. " +
        "Not rolling back. Check OE_DEPLOY_CONTROL_TOKEN against the deployment's OE_CONTROL_READ_TOKENS.",
    };
  }
  if (input.outcome.status === 404) {
    return {
      action: "fail",
      message:
        "HTTP 404 — the control read route is fail-closed off (OE_CONTROL_READ_TOKENS unset on the " +
        "deployment) OR the route is genuinely missing. Ambiguous, so NOT rolling back: arm the token " +
        "and re-probe, or pass --to and roll back deliberately.",
    };
  }

  const detail = input.outcome.status !== undefined ? `HTTP ${input.outcome.status}` : (input.outcome.error ?? "unknown error");
  if (input.noRollback) {
    return { action: "fail", message: `probe failed (${detail}) — --no-rollback was passed, leaving the alias where it is.` };
  }
  return { action: "rollback", message: `probe failed (${detail}) after ${input.outcome.attempts} attempt(s) — rolling back.` };
}

export const VERCEL_API_BASE = "https://api.vercel.com";

export const DEPLOYMENT_LIST_LIMIT = 20;

export class VercelApiError extends Error {}

export type VercelApi = {
  token: string;
  project: VercelProjectRef;
  fetchImpl: ApiFetchLike;
  apiBase?: string;
};

export function teamQuery(project: VercelProjectRef): string {
  return project.teamId ? `teamId=${encodeURIComponent(project.teamId)}` : `slug=${encodeURIComponent(project.teamSlug)}`;
}

function describeApiFailure(body: unknown, text: string): string {
  if (isRecord(body) && isRecord(body.error)) {
    const detail = [firstString(body.error.code), firstString(body.error.message)].filter(Boolean).join(" — ");
    if (detail) return detail;
  }
  const trimmed = text.slice(0, 200).replace(/\s+/g, " ").trim();
  return trimmed || "(empty body)";
}

function redactToken(text: string, token: string): string {
  return token.length >= 8 ? text.split(token).join("«redacted-token»") : text;
}

export async function vercelApiJson(api: VercelApi, path: string, init?: { method: string; body: unknown }): Promise<unknown> {
  const base = (api.apiBase ?? VERCEL_API_BASE).replace(/\/+$/, "");
  const headers: Record<string, string> = { authorization: `Bearer ${api.token}` };
  if (init) headers["content-type"] = "application/json";
  const method = init?.method ?? "GET";
  const res = await api.fetchImpl(`${base}${path}`, {
    headers,
    ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new VercelApiError(redactToken(`${method} ${path} → HTTP ${res.status}: ${describeApiFailure(body, text)}`, api.token));
  }
  if (body === undefined) {
    throw new VercelApiError(`${method} ${path} → HTTP ${res.status} with a body that is not JSON`);
  }
  return body;
}

export type AliasSetResult = { ok: boolean; detail: string };

export type VercelClient = {
  ls(): Promise<DeploymentRow[]>;
  inspect(target: string): Promise<InspectResult>;
  aliasSet(deploymentUrl: string, alias: string): Promise<AliasSetResult>;
};

export function createVercelClient(api: VercelApi): VercelClient {
  const team = teamQuery(api.project);
  const readDeployment = async (target: string): Promise<InspectResult> =>
    parseDeploymentRecord(await vercelApiJson(api, `/v13/deployments/${encodeURIComponent(deploymentKey(target))}?${team}`));

  return {
    async ls() {
      const projectQuery = api.project.idOrName.startsWith("prj_")
        ? `projectId=${encodeURIComponent(api.project.idOrName)}`
        : `app=${encodeURIComponent(api.project.idOrName)}`;
      const body = await vercelApiJson(api, `/v6/deployments?${projectQuery}&${team}&limit=${DEPLOYMENT_LIST_LIMIT}&target=production`);
      return parseDeploymentList(body);
    },

    inspect: readDeployment,

    async aliasSet(deploymentUrl, alias) {
      let id: string;
      try {
        const target = await readDeployment(deploymentUrl);
        if (!target.id) return { ok: false, detail: `${deploymentUrl} resolved to a deployment with no dpl_ id, so the alias cannot be assigned` };
        id = target.id;
      } catch (err) {
        return { ok: false, detail: `could not resolve ${deploymentUrl} to a deployment id — ${err instanceof Error ? err.message : String(err)}` };
      }
      try {
        await vercelApiJson(api, `/v2/deployments/${encodeURIComponent(id)}/aliases?${team}`, { method: "POST", body: { alias } });
        return { ok: true, detail: `assigned ${alias} → ${deploymentUrl} (${id})` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function lazyVercelClient(build: () => VercelApi): VercelClient {
  let built: VercelClient | undefined;
  const client = (): VercelClient => (built ??= createVercelClient(build()));
  return {
    ls: () => client().ls(),
    inspect: (target) => client().inspect(target),
    aliasSet: (deploymentUrl, alias) => client().aliasSet(deploymentUrl, alias),
  };
}

export type AliasTarget = { kind: "resolved"; target: InspectResult } | { kind: "unresolved"; reason: string };

export async function currentAliasTarget(client: VercelClient, alias: string): Promise<AliasTarget> {
  let result: InspectResult;
  try {
    result = await client.inspect(alias);
  } catch (err) {
    return { kind: "unresolved", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!result.url && !result.id) {
    return { kind: "unresolved", reason: `the deployment record for ${alias} carried neither a url nor a dpl_ id` };
  }
  return { kind: "resolved", target: result };
}

export function unresolvedAliasFailure(input: { alias: string; reason: string; recording: boolean }): string {
  const disarmed = [
    "the cron deploymentId check (does the cron registration point at THIS deployment?)",
    "the cron staleness check (is the registration older than the deployment?)",
    ...(input.recording ? ["the known-good pointer record (--record) — the rollback target would stay on the PREVIOUS deploy"] : []),
    "the rollback no-op guard, which reads the same value",
  ];
  return (
    `deploy:verify: the probe passed, but ${input.alias} could not be resolved to a deployment — ${input.reason}\n` +
    "  This is FATAL, not a warning: these checks cannot run and would otherwise be skipped in silence —\n" +
    disarmed.map((line) => `    • ${line}`).join("\n") +
    "\n  Remedy: check OE_VERCEL_API_TOKEN, OE_DEPLOY_ALIAS and the project variables, then re-run.\n" +
    "  To record a known-good pointer without the lookup: `npm run deploy:record -- --url <deployment-url> [--id dpl_…]`."
  );
}

export async function currentCommit(exec: Exec = realExec): Promise<string | undefined> {
  try {
    const res = await exec("git", ["rev-parse", "HEAD"]);
    const sha = res.stdout.trim();
    return res.code === 0 && /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export function safeReadFileSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export type ReadFile = (path: string) => string | undefined;

export type RawProjectCrons = { deploymentId?: unknown; updatedAt?: unknown; definitions?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ApiFetchLike = (
  url: string,
  init: { headers: Record<string, string>; method?: string; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export const realApiFetch: ApiFetchLike = async (url, init) => {
  const res = await fetch(url, {
    headers: init.headers,
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return { status: res.status, text: () => res.text() };
};

const VERCEL_AUTH_RELATIVE_PATHS = [
  [".local", "share", "com.vercel.cli", "auth.json"],
  [".vercel", "auth.json"],
];

export function parseVercelAuthToken(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

export function resolveVercelApiToken(input: { env: Env; homeDir?: string; readFile?: ReadFile }): string | undefined {
  const fromEnv = input.env.OE_VERCEL_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const homeDir = input.homeDir ?? homedir();
  const readFile = input.readFile ?? safeReadFileSync;
  for (const segments of VERCEL_AUTH_RELATIVE_PATHS) {
    const text = readFile(join(homeDir, ...segments));
    const token = text ? parseVercelAuthToken(text) : undefined;
    if (token) return token;
  }
  return undefined;
}

export type VercelProjectRef = { idOrName: string; teamSlug: string; teamId?: string };

export function resolveProjectRef(input: {
  envProject?: string;
  envProjectId?: string;
  envTeamId?: string;
  envScope: string;
  projectJsonPath: string;
  readFile?: ReadFile;
}): VercelProjectRef | undefined {
  const envTeamId = input.envTeamId?.trim() || undefined;
  if (input.envProject) return { idOrName: input.envProject, teamSlug: input.envScope, ...(envTeamId ? { teamId: envTeamId } : {}) };
  const envProjectId = input.envProjectId?.trim() || undefined;
  if (envProjectId) return { idOrName: envProjectId, teamSlug: input.envScope, ...(envTeamId ? { teamId: envTeamId } : {}) };
  const readFile = input.readFile ?? safeReadFileSync;
  const text = readFile(input.projectJsonPath);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { projectId?: unknown; orgId?: unknown };
    if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) return undefined;
    const fileTeamId = typeof parsed.orgId === "string" && parsed.orgId.length > 0 ? parsed.orgId : undefined;
    return { idOrName: parsed.projectId, teamSlug: input.envScope, teamId: envTeamId ?? fileTeamId };
  } catch {
    return undefined;
  }
}

export function resolveVercelApi(input: {
  env: Env;
  deployEnv: DeployEnv;
  cwd: string;
  fetchImpl: ApiFetchLike;
  homeDir?: string;
  readFile?: ReadFile;
}): VercelApi {
  const token = resolveVercelApiToken({ env: input.env, ...(input.homeDir ? { homeDir: input.homeDir } : {}), ...(input.readFile ? { readFile: input.readFile } : {}) });
  if (!token) {
    throw new DeployConfigError(
      "no Vercel API token — set OE_VERCEL_API_TOKEN, or run `vercel login` on this machine.\n" +
        "  Every deployment read these scripts make goes to the Vercel REST API: which deployment the\n" +
        "  alias points at, the deployment listing rollback discovers from, the alias move itself, and\n" +
        "  the cron registration check. Without a token none of them can run, and a verify that cannot\n" +
        "  read the alias is not a safety net.\n" +
        "  A TEAM-SCOPED token is correct here. It is the `vercel` CLI, not the REST API, that refuses\n" +
        "  one (OPE-1045) — so do NOT set VERCEL_TOKEN in this shell to work around it (OPE-1031).",
    );
  }
  const project = resolveProjectRef({
    ...(input.deployEnv.project ? { envProject: input.deployEnv.project } : {}),
    ...(input.env.VERCEL_PROJECT_ID ? { envProjectId: input.env.VERCEL_PROJECT_ID } : {}),
    ...(input.env.VERCEL_ORG_ID ? { envTeamId: input.env.VERCEL_ORG_ID } : {}),
    envScope: input.deployEnv.scope,
    projectJsonPath: join(input.cwd, ".vercel", "project.json"),
    ...(input.readFile ? { readFile: input.readFile } : {}),
  });
  if (!project) {
    throw new DeployConfigError(
      "could not resolve the Vercel project — the REST API needs one to name the deployment.\n" +
        "  Set OE_DEPLOY_PROJECT (the project's name or its prj_ id), or set VERCEL_PROJECT_ID and\n" +
        "  VERCEL_ORG_ID (the pair `vercel link` prints), or run from a directory `vercel link` has\n" +
        "  linked. On a CI runner the checkout has no .vercel/project.json, so one of the two env\n" +
        "  sources is required there.",
    );
  }
  const apiBase = input.env.OE_VERCEL_API_BASE?.trim();
  return { token, project, fetchImpl: input.fetchImpl, ...(apiBase ? { apiBase } : {}) };
}

export async function fetchProjectInfo(input: {
  project: VercelProjectRef;
  token: string;
  fetchImpl: ApiFetchLike;
  apiBase?: string;
}): Promise<{ status: number; body?: unknown; parseError?: string }> {
  const base = (input.apiBase ?? VERCEL_API_BASE).replace(/\/+$/, "");
  const url = `${base}/v9/projects/${encodeURIComponent(input.project.idOrName)}?${teamQuery(input.project)}`;
  const res = await input.fetchImpl(url, { headers: { authorization: `Bearer ${input.token}` } });
  const text = await res.text();
  if (res.status !== 200) {
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status };
    }
  }
  try {
    return { status: 200, body: JSON.parse(text) };
  } catch (err) {
    return { status: 200, parseError: err instanceof Error ? err.message : String(err) };
  }
}

export type LocalCronCount = { kind: "absent" } | { kind: "malformed"; detail: string } | { kind: "count"; count: number };

export function readLocalCronCount(path: string, readFile: ReadFile = safeReadFileSync): LocalCronCount {
  const text = readFile(path);
  if (text === undefined) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "malformed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(parsed)) return { kind: "malformed", detail: "not a JSON object" };
  const crons = parsed.crons;
  if (crons === undefined) return { kind: "count", count: 0 };
  if (!Array.isArray(crons)) return { kind: "malformed", detail: "\"crons\" is present but not an array" };
  return { kind: "count", count: crons.length };
}

export type CronCheckOutcome = { kind: "pass" | "warn" | "fail"; message: string };

export function checkCronDeploymentId(input: { crons?: RawProjectCrons; resolvedDeploymentId?: string }): CronCheckOutcome {
  const deploymentId = input.crons?.deploymentId;
  if (typeof deploymentId !== "string" || deploymentId.length === 0) {
    return {
      kind: "warn",
      message: "crons.deploymentId is missing (or not a string) from the Vercel API response — cannot check the cron registration. Skipping.",
    };
  }
  if (!input.resolvedDeploymentId) {
    return { kind: "warn", message: "could not resolve the deployment id the alias currently points at (the deployment record carried no id) — skipping the cron deploymentId check." };
  }
  if (deploymentId !== input.resolvedDeploymentId) {
    return {
      kind: "fail",
      message:
        `crons.deploymentId (${deploymentId}) does not match the deployment the alias resolves to ` +
        `(${input.resolvedDeploymentId}) — the cron registration points at a stale deployment, so every ` +
        "scheduled tick runs OLD code. Run a fresh `vercel deploy --prod` to re-register crons — an alias " +
        "rollback will NOT fix this.",
    };
  }
  return { kind: "pass", message: `crons.deploymentId (${deploymentId}) matches the deployment the alias resolves to.` };
}

export function checkCronDefinitionCount(input: { crons?: RawProjectCrons; local: LocalCronCount }): CronCheckOutcome {
  if (input.local.kind === "absent") {
    return { kind: "warn", message: ".vercel/output/config.json was not found locally — skipping the cron count check. Run `npm run build` first if this check should run." };
  }
  if (input.local.kind === "malformed") {
    return { kind: "warn", message: `.vercel/output/config.json could not be read as a cron list (${input.local.detail}) — skipping the cron count check.` };
  }
  const definitions = input.crons?.definitions;
  if (!Array.isArray(definitions)) {
    return { kind: "warn", message: "crons.definitions is missing (or not an array) from the Vercel API response — skipping the cron count check." };
  }
  if (definitions.length !== input.local.count) {
    return {
      kind: "fail",
      message:
        `the Vercel project has ${definitions.length} registered cron(s) but the local build declares ` +
        `${input.local.count} — the registered set is out of date with this build.`,
    };
  }
  return { kind: "pass", message: `registered cron count (${definitions.length}) matches the local build.` };
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function checkCronUpdatedAt(input: { crons?: RawProjectCrons; deploymentCreatedAt?: string }): CronCheckOutcome {
  const updated = toDate(input.crons?.updatedAt);
  if (!updated) {
    return { kind: "warn", message: "crons.updatedAt is missing, not a date, or not a string/number in the Vercel API response — skipping the cron staleness check." };
  }
  if (!input.deploymentCreatedAt) {
    return { kind: "warn", message: "the deployment's created timestamp is unknown (the deployment record carried no `createdAt`) — skipping the cron staleness check." };
  }
  const created = toDate(input.deploymentCreatedAt);
  if (!created) {
    return { kind: "warn", message: `the deployment's created timestamp (${input.deploymentCreatedAt}) could not be parsed as a date — skipping the cron staleness check.` };
  }
  if (updated.getTime() < created.getTime()) {
    return {
      kind: "fail",
      message: `crons.updatedAt (${updated.toISOString()}) is OLDER than the deployment's created timestamp (${created.toISOString()}) — the cron registration predates this deploy.`,
    };
  }
  return { kind: "pass", message: `crons.updatedAt (${updated.toISOString()}) is not older than the deployment (${created.toISOString()}).` };
}

export type CronCheckResult = { ran: boolean; ok: boolean; outcomes: CronCheckOutcome[] };

export async function runCronCheck(input: {
  token?: string;
  project?: VercelProjectRef;
  resolvedDeploymentId?: string;
  deploymentCreatedAt?: string;
  localCrons: LocalCronCount;
  apiFetch: ApiFetchLike;
  apiBase?: string;
  log: Logger;
}): Promise<CronCheckResult> {
  const skip = (message: string): CronCheckResult => {
    input.log(`  ⚠ ${message}`);
    return { ran: false, ok: true, outcomes: [{ kind: "warn", message }] };
  };

  if (!input.token) {
    return skip("no Vercel API token found (checked OE_VERCEL_API_TOKEN and the vercel CLI's stored login) — skipping the cron registration check.");
  }
  if (!input.project) {
    return skip("could not resolve the Vercel project (set OE_DEPLOY_PROJECT, or run from a directory `vercel link` has linked) — skipping the cron registration check.");
  }

  const response = await fetchProjectInfo({
    project: input.project,
    token: input.token,
    fetchImpl: input.apiFetch,
    ...(input.apiBase ? { apiBase: input.apiBase } : {}),
  });
  if (response.status !== 200 || response.body === undefined) {
    const detail = response.parseError ? ` (unparsable body: ${response.parseError})` : "";
    return skip(`GET /v9/projects/${input.project.idOrName} returned HTTP ${response.status}${detail} — skipping the cron registration check.`);
  }

  const crons = isRecord(response.body) && isRecord(response.body.crons) ? (response.body.crons as RawProjectCrons) : undefined;
  const outcomes = [
    checkCronDeploymentId({ crons, resolvedDeploymentId: input.resolvedDeploymentId }),
    checkCronDefinitionCount({ crons, local: input.localCrons }),
    checkCronUpdatedAt({ crons, deploymentCreatedAt: input.deploymentCreatedAt }),
  ];
  for (const outcome of outcomes) {
    const prefix = outcome.kind === "pass" ? "✓" : outcome.kind === "warn" ? "⚠" : "✗";
    input.log(`  ${prefix} ${outcome.message}`);
  }
  return { ran: true, ok: !outcomes.some((o) => o.kind === "fail"), outcomes };
}

export type Logger = (line: string) => void;

export type PointerStore = { read(): DeployState; write(state: DeployState): void };

export function fileStore(path: string): PointerStore {
  return { read: () => readState(path), write: (state) => writeState(path, state) };
}

export type RollbackResult = { ok: boolean; target?: string; choice: RollbackChoice };

export async function runRollback(input: {
  env: DeployEnv;
  client: VercelClient;
  store: PointerStore;
  explicitTo?: string;
  dryRun?: boolean;
  log: Logger;
}): Promise<RollbackResult> {
  const { env, client, store, log } = input;

  const resolved = await currentAliasTarget(client, env.alias);
  const current = resolved.kind === "resolved" ? resolved.target : undefined;
  if (resolved.kind === "resolved") {
    const target = resolved.target;
    log(`  alias   ${env.alias} → ${target.url ?? "unknown"}${target.id ? ` (${target.id})` : ""}`);
  } else {
    log(`  ⚠ rollback: cannot read what ${env.alias} points at (${resolved.reason}).`);
    log("    The no-op guard is OFF for this run — a rollback onto the deployment already serving the alias would NOT be caught.");
  }

  const state = store.read();
  let choice = chooseRollbackTarget({ explicitTo: input.explicitTo, state, currentUrl: current?.url, discovered: [] });
  if (choice.kind === "none") {
    choice = chooseRollbackTarget({ state, currentUrl: current?.url, discovered: await client.ls() });
  }

  if (choice.kind === "none") {
    log(`✗ rollback: ${choice.why}`);
    return { ok: false, choice };
  }
  if (current?.url && choice.url === current.url) {
    log(`✗ rollback: the alias is ALREADY on ${choice.url} (${choice.why}) — nothing to do. Pass --to to name a different deployment.`);
    return { ok: false, choice };
  }

  log(`  target  ${choice.url}  [${choice.kind}: ${choice.why}]`);
  if (input.dryRun) {
    log(`✓ rollback (dry run): would assign ${env.alias} → ${choice.url} in scope ${env.scope}`);
    return { ok: true, target: choice.url, choice };
  }

  const result = await client.aliasSet(choice.url, env.alias);
  if (!result.ok) {
    log(`✗ rollback: the alias assignment failed — ${result.detail}`);
    return { ok: false, target: choice.url, choice };
  }

  const afterResolved = await currentAliasTarget(client, env.alias);
  const after = afterResolved.kind === "resolved" ? afterResolved.target : undefined;
  if (after?.url && after.url !== choice.url) {
    log(`✗ rollback: alias set reported success but ${env.alias} still resolves to ${after.url}.`);
    return { ok: false, target: choice.url, choice };
  }
  log(`✓ rollback: ${env.alias} now serves ${choice.url}`);
  log("  Next: confirm with `npm run deploy:verify -- --no-rollback`, then investigate the bad deployment (`vercel logs`).");
  return { ok: true, target: choice.url, choice };
}

export async function runRecord(input: {
  env: DeployEnv;
  client: VercelClient;
  store: PointerStore;
  url?: string;
  id?: string;
  commit?: string;
  note?: string;
  now?: Date;
  label?: string;
  log: Logger;
}): Promise<{ ok: boolean; entry?: DeployEntry }> {
  const { env, client, store, log } = input;
  const label = input.label ?? "deploy:record";

  let url = input.url ? normalizeDeploymentUrl(input.url) : undefined;
  let id = input.id;
  if (!url) {
    const resolved = await currentAliasTarget(client, env.alias);
    const current = resolved.kind === "resolved" ? resolved.target : undefined;
    url = current?.url;
    id = id ?? current?.id;
    if (!url) {
      const reason = resolved.kind === "unresolved" ? resolved.reason : "the deployment record carried no url";
      const script = label.split(" ")[0];
      log(`✗ ${label}: could not resolve what ${env.alias} points at — ${reason}`);
      log("    Nothing was recorded. The known-good pointer still names the PREVIOUS deployment, so a rollback");
      log(`    would go to the wrong place. Remedy: \`npm run ${script} -- --url <deployment-url> [--id dpl_…]\`.`);
      return { ok: false };
    }
  }

  const entry: DeployEntry = {
    url,
    ...(id ? { id } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    recordedAt: (input.now ?? new Date()).toISOString(),
    ...(input.note ? { note: input.note } : {}),
  };
  const next = recordGood(store.read(), entry);
  store.write(next);
  log(`✓ ${label}: known-good → ${entry.url}${entry.commit ? ` @ ${entry.commit}` : ""}`);
  log(`  pointer ${env.stateFile} (gitignored, per-operator); ${next.history.length} previous entry(ies) retained`);
  return { ok: true, entry };
}

export type Args = { flags: Set<string>; values: Map<string, string>; positional: string[] };

export function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      i++;
    } else {
      flags.add(name);
    }
  }
  return { flags, values, positional };
}
