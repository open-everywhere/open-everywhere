import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
};
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

export const realExec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
      const spawnError = typeof rawCode === "string" ? `${rawCode}: ${(err as Error).message}` : undefined;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(spawnError ? { spawnError } : {}) });
    });
  });

export type BinLookupIo = { exists: (path: string) => boolean; listDir: (path: string) => string[] };

const REAL_BIN_IO: BinLookupIo = {
  exists: (path) => existsSync(path),
  listDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

export type BinResolution = { kind: "found"; path: string; via: string } | { kind: "missing"; searched: string[] };

export function resolveExecutable(input: { name: string; overrideVar?: string; env: Env; cwd: string; io?: BinLookupIo }): BinResolution {
  const io = input.io ?? REAL_BIN_IO;
  const searched: string[] = [];
  const tryPath = (candidate: string): boolean => {
    searched.push(candidate);
    return io.exists(candidate);
  };

  const override = input.overrideVar ? input.env[input.overrideVar]?.trim() : undefined;
  if (override) {
    return tryPath(override) ? { kind: "found", path: override, via: input.overrideVar ?? "override" } : { kind: "missing", searched };
  }

  const local = join(input.cwd, "node_modules", ".bin", input.name);
  if (tryPath(local)) return { kind: "found", path: local, via: "node_modules/.bin" };

  for (const dir of (input.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, input.name);
    if (tryPath(candidate)) return { kind: "found", path: candidate, via: "PATH" };
  }

  const nvmDir = input.env.NVM_DIR?.trim() || join(input.env.HOME ?? homedir(), ".nvm");
  const versionsDir = join(nvmDir, "versions", "node");
  for (const version of io.listDir(versionsDir).sort().reverse()) {
    const candidate = join(versionsDir, version, "bin", input.name);
    if (tryPath(candidate)) return { kind: "found", path: candidate, via: `nvm (${version})` };
  }

  return { kind: "missing", searched };
}

export function binResolutionError(name: string, searched: string[]): DeployConfigError {
  return new DeployConfigError(
    `could not find the \`${name}\` executable — it never ran, so nothing this script reads from it is known.\n` +
      `  \`execFile\` uses no shell: it resolves \`${name}\` against this node process's PATH, which is not\n` +
      "  your interactive shell's PATH when nvm has swapped node versions.\n" +
      `  Remedy: install it (\`npm i -g ${name}\`) for the node version you run the deploy chain with,\n` +
      `  or point OE_VERCEL_BIN at the absolute path of the binary you want.\n` +
      `  Searched (${searched.length}): ${searched.slice(0, 12).join(", ")}${searched.length > 12 ? ", …" : ""}`,
  );
}

export const VERCEL_BIN_OVERRIDE_VAR = "OE_VERCEL_BIN";

export const vercelExec: Exec = async (command, args) => {
  const found = resolveExecutable({ name: command, overrideVar: VERCEL_BIN_OVERRIDE_VAR, env: process.env, cwd: process.cwd() });
  if (found.kind === "missing") throw binResolutionError(command, found.searched);
  const res = await realExec(found.path, args);
  if (res.spawnError) throw binResolutionError(command, [`${found.path} (${res.spawnError})`]);
  return res;
};

export type Env = Record<string, string | undefined>;

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
  const scope = required(env, "OE_DEPLOY_SCOPE", "the vercel CLI needs a team/scope slug (`vercel --scope <slug>`)");
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

const DEPLOYMENT_URL = /\bhttps?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s]*)?/i;
const STATE_WORD = /\b(READY|ERROR|BUILDING|QUEUED|CANCELED|CANCELLED|INITIALIZING)\b/i;
const TARGET_WORD = /\b(PRODUCTION|PREVIEW)\b/i;

export function parseDeploymentList(stdout: string): DeploymentRow[] {
  const rows: DeploymentRow[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = DEPLOYMENT_URL.exec(line);
    if (!match) continue;
    const url = normalizeDeploymentUrl(match[0]);
    if (!url) continue;
    rows.push({
      url,
      state: STATE_WORD.exec(line)?.[1]?.toUpperCase(),
      target: TARGET_WORD.exec(line)?.[1]?.toUpperCase(),
      raw: line,
    });
  }
  return rows;
}

export function normalizeDeploymentUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export type InspectResult = { id?: string; url?: string; state?: string; createdAt?: string };

export function parseInspect(output: string): InspectResult {
  const result: InspectResult = {};
  const id = /(?:^|\s)id\s+(dpl_[A-Za-z0-9]+)/.exec(output);
  if (id) result.id = id[1];
  const url = /(?:^|\s)url\s+(\S+)/.exec(output);
  if (url) result.url = normalizeDeploymentUrl(url[1]);
  const state = /(?:^|\s)status\s+(\S+)|(?:^|\s)state\s+(\S+)/.exec(output);
  if (state) result.state = (state[1] ?? state[2])?.toUpperCase();
  const created = /(?:^|\s)created\s+(.+)$/m.exec(output);
  if (created) result.createdAt = created[1].replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  return result;
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
    return { kind: "discovered", url: row.url, why: "newest READY deployment from `vercel ls` that is not the current alias target" };
  }

  return {
    kind: "none",
    why:
      "nothing to roll back to — the known-good pointer is empty (run `npm run deploy:record` after a good deploy) " +
      "and `vercel ls` offered no READY deployment other than the current one. Pass `--to <deployment-url>` to name one.",
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

export type VercelClient = {
  ls(): Promise<DeploymentRow[]>;
  inspect(target: string): Promise<InspectResult>;
  aliasSet(deploymentUrl: string, alias: string): Promise<ExecResult>;
};

export function createVercelClient(env: DeployEnv, exec: Exec = vercelExec, bin = "vercel"): VercelClient {
  const scoped = (args: string[]): string[] => [...args, "--scope", env.scope];
  return {
    async ls() {
      const args = env.project ? ["ls", env.project] : ["ls"];
      const res = await exec(bin, scoped(args));
      return parseDeploymentList(`${res.stdout}\n${res.stderr}`);
    },
    async inspect(target) {
      const res = await exec(bin, scoped(["inspect", target]));
      return parseInspect(`${res.stdout}\n${res.stderr}`);
    },
    async aliasSet(deploymentUrl, alias) {
      return exec(bin, scoped(["alias", "set", deploymentUrl, alias]));
    },
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
    return { kind: "unresolved", reason: `\`vercel inspect ${alias}\` returned neither a url nor a dpl_ id` };
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
    "\n  Remedy: make the `vercel` CLI runnable from this process (see OE_VERCEL_BIN), then re-run.\n" +
    "  To record a known-good pointer without the CLI: `npm run deploy:record -- --url <deployment-url> [--id dpl_…]`."
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

export type ApiFetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

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

export function resolveProjectRef(input: { envProject?: string; envScope: string; projectJsonPath: string; readFile?: ReadFile }): VercelProjectRef | undefined {
  if (input.envProject) return { idOrName: input.envProject, teamSlug: input.envScope };
  const readFile = input.readFile ?? safeReadFileSync;
  const text = readFile(input.projectJsonPath);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { projectId?: unknown; orgId?: unknown };
    if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) return undefined;
    const teamId = typeof parsed.orgId === "string" && parsed.orgId.length > 0 ? parsed.orgId : undefined;
    return { idOrName: parsed.projectId, teamSlug: input.envScope, teamId };
  } catch {
    return undefined;
  }
}

export async function fetchProjectInfo(input: {
  project: VercelProjectRef;
  token: string;
  fetchImpl: ApiFetchLike;
}): Promise<{ status: number; body?: unknown; parseError?: string }> {
  const teamParam = input.project.teamId
    ? `teamId=${encodeURIComponent(input.project.teamId)}`
    : `slug=${encodeURIComponent(input.project.teamSlug)}`;
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(input.project.idOrName)}?${teamParam}`;
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
    return { kind: "warn", message: "could not resolve the deployment id the alias currently points at (`vercel inspect` gave no id) — skipping the cron deploymentId check." };
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
    return { kind: "warn", message: "the deployment's created timestamp is unknown (`vercel inspect` gave no `created`) — skipping the cron staleness check." };
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
  log: Logger;
}): Promise<CronCheckResult> {
  const skip = (message: string): CronCheckResult => {
    input.log(`  ⚠ ${message}`);
    return { ran: false, ok: true, outcomes: [{ kind: "warn", message }] };
  };

  if (!input.token) {
    return skip("no Vercel API token found (checked OE_VERCEL_API_TOKEN and the CLI's stored login) — skipping the cron registration check.");
  }
  if (!input.project) {
    return skip("could not resolve the Vercel project (set OE_DEPLOY_PROJECT, or run from a directory `vercel link` has linked) — skipping the cron registration check.");
  }

  const response = await fetchProjectInfo({ project: input.project, token: input.token, fetchImpl: input.apiFetch });
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
    log(`✓ rollback (dry run): would run \`vercel alias set ${choice.url} ${env.alias} --scope ${env.scope}\``);
    return { ok: true, target: choice.url, choice };
  }

  const result = await client.aliasSet(choice.url, env.alias);
  if (result.code !== 0) {
    log(`✗ rollback: \`vercel alias set\` exited ${result.code}`);
    for (const line of `${result.stderr}\n${result.stdout}`.split("\n").filter(Boolean).slice(0, 20)) log(`    ${line}`);
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
      const reason = resolved.kind === "unresolved" ? resolved.reason : "`vercel inspect` gave no url";
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
