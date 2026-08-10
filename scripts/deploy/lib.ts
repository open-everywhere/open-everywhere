import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

export const realExec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

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

export type InspectResult = { id?: string; url?: string; state?: string };

export function parseInspect(output: string): InspectResult {
  const result: InspectResult = {};
  const id = /(?:^|\s)id\s+(dpl_[A-Za-z0-9]+)/.exec(output);
  if (id) result.id = id[1];
  const url = /(?:^|\s)url\s+(\S+)/.exec(output);
  if (url) result.url = normalizeDeploymentUrl(url[1]);
  const state = /(?:^|\s)status\s+(\S+)|(?:^|\s)state\s+(\S+)/.exec(output);
  if (state) result.state = (state[1] ?? state[2])?.toUpperCase();
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

export function createVercelClient(env: DeployEnv, exec: Exec = realExec, bin = "vercel"): VercelClient {
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

export async function currentAliasTarget(client: VercelClient, alias: string): Promise<InspectResult | undefined> {
  try {
    const result = await client.inspect(alias);
    return result.url || result.id ? result : undefined;
  } catch {
    return undefined;
  }
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

  const current = await currentAliasTarget(client, env.alias);
  log(`  alias   ${env.alias} → ${current?.url ?? "unknown"}${current?.id ? ` (${current.id})` : ""}`);

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

  const after = await currentAliasTarget(client, env.alias);
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
  log: Logger;
}): Promise<{ ok: boolean; entry?: DeployEntry }> {
  const { env, client, store, log } = input;

  let url = input.url ? normalizeDeploymentUrl(input.url) : undefined;
  let id = input.id;
  if (!url) {
    const current = await currentAliasTarget(client, env.alias);
    url = current?.url;
    id = id ?? current?.id;
    if (!url) {
      log(
        `✗ deploy:record: could not resolve what ${env.alias} points at (\`vercel inspect\` gave no url). ` +
          `Pass --url <deployment-url> explicitly.`,
      );
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
  log(`✓ deploy:record: known-good → ${entry.url}${entry.commit ? ` @ ${entry.commit}` : ""}`);
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
