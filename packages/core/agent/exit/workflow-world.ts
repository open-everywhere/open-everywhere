import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_WORKFLOW_DATA_DIR = ".eve/.workflow-data";

export interface LocalRun {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

const FINISHED = new Set(["completed", "failed", "cancelled"]);

const RUN_ID = /^wrun_[A-Za-z0-9]+$/u;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function listLocalRuns(dataDir: string): LocalRun[] {
  const runsDir = join(dataDir, "runs");
  if (!existsSync(runsDir)) return [];
  const out: LocalRun[] = [];
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith(".json")) continue;
    const runId = name.slice(0, -".json".length);
    if (!isRunId(runId)) continue;
    const run = readJson(join(runsDir, name));
    if (run === undefined) continue;
    const createdAt = str(run["createdAt"]) ?? new Date(statSync(join(runsDir, name)).mtimeMs).toISOString();
    const times = [str(run["completedAt"]), str(run["updatedAt"]), createdAt].filter((t): t is string => t !== undefined).sort();
    out.push({ runId, status: str(run["status"]) ?? "unknown", createdAt, lastActivityAt: times[times.length - 1]! });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function namedForRun(name: string, runId: string): boolean {
  return name === runId || name.startsWith(`${runId}.`) || name.startsWith(`${runId}-`);
}

function walk(dir: string, visit: (path: string, name: string, isDir: boolean) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    visit(path, entry.name, entry.isDirectory());
  }
}

function pruneEmptyIndexDirs(dataDir: string): void {
  for (const index of ["id-index", "token-index"]) {
    const dir = join(dataDir, "hooks", index);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
    }
  }
}

export type DeleteRunResult =
  | { readonly outcome: "deleted"; readonly files: number }
  | { readonly outcome: "absent" }
  | { readonly outcome: "refused-live"; readonly status: string };

export function deleteLocalRun(dataDir: string, runId: string): DeleteRunResult {
  if (!isRunId(runId)) throw new Error(`"${runId}" is not a session id — a session id starts with wrun_`);
  const runFile = join(dataDir, "runs", `${runId}.json`);
  const run = existsSync(runFile) ? readJson(runFile) : undefined;
  if (run !== undefined) {
    const status = str(run["status"]) ?? "unknown";
    if (!FINISHED.has(status)) return { outcome: "refused-live", status };
  } else {
    if (existsSync(runFile)) return { outcome: "refused-live", status: "unreadable" };
    let named = false;
    walk(dataDir, (_path, name, isDir) => {
      if (!isDir && namedForRun(name, runId)) named = true;
    });
    return named ? { outcome: "refused-live", status: "unknown" } : { outcome: "absent" };
  }
  const streamList = readJson(join(dataDir, "streams", "runs", `${runId}.json`));
  const streams = Array.isArray(streamList?.["streams"]) ? (streamList["streams"] as unknown[]).filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9_-]+$/u.test(s)) : [];

  let files = 0;
  const remove = (path: string): void => {
    rmSync(path, { recursive: true, force: true });
    files++;
  };
  for (const name of streams) {
    const dir = join(dataDir, "streams", "chunks", name);
    if (existsSync(dir)) remove(dir);
  }
  walk(dataDir, (path, name, isDir) => {
    if (!isDir && namedForRun(name, runId) && path !== runFile) remove(path);
  });
  walk(join(dataDir, "hooks"), (path, name, isDir) => {
    if (isDir || !name.endsWith(".json")) return;
    if (readJson(path)?.["runId"] === runId) remove(path);
  });
  pruneEmptyIndexDirs(dataDir);
  if (existsSync(runFile)) remove(runFile);
  return { outcome: "deleted", files };
}

export function runsOlderThan(dataDir: string, before: string): LocalRun[] {
  return listLocalRuns(dataDir).filter((r) => FINISHED.has(r.status) && r.lastActivityAt < before);
}
