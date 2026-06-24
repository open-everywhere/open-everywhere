import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Partition } from "../memory/partition.js";
import { safeName } from "../memory/layout.js";
import type { Routine } from "./routine.js";

const ROOT = process.env.OE_ROUTINES_DIR
  ? process.env.OE_ROUTINES_DIR
  : join(process.cwd(), ".open-everywhere-routines");

export function routinesRoot(): string {
  return ROOT;
}

export function newRoutineId(): string {
  return `r-${randomUUID().slice(0, 8)}`;
}

function surfaceDir(org: string, surfaceKey: string): string {
  return join(ROOT, safeName(org), ...surfaceKey.split("/"));
}
function surfaceFile(org: string, surfaceKey: string): string {
  return join(surfaceDir(org, surfaceKey), "routines.json");
}

function git(args: string[]): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
    if (r.error) return { ok: false, stdout: "" };
    return { ok: r.status === 0, stdout: r.stdout ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function ensureRepo(): void {
  if (existsSync(join(ROOT, ".git"))) return;
  if (!git(["init", "--quiet"]).ok) return;
  git(["config", "user.email", "open-everywhere@local"]);
  git(["config", "user.name", "Open Everywhere"]);
}

function commit(message: string): string | null {
  if (!git(["add", "-A"]).ok) return null;
  if (git(["status", "--porcelain"]).stdout.trim() === "") return null;
  if (!git(["commit", "--quiet", "-m", message]).ok) return null;
  const sha = git(["rev-parse", "--short", "HEAD"]);
  return sha.ok ? sha.stdout.trim() : null;
}

async function readFileList(org: string, surfaceKey: string): Promise<Routine[]> {
  const file = surfaceFile(org, surfaceKey);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    return Array.isArray(parsed) ? (parsed as Routine[]) : [];
  } catch {
    return [];
  }
}

async function writeFileList(org: string, surfaceKey: string, routines: Routine[], message: string): Promise<string | null> {
  await mkdir(ROOT, { recursive: true });
  ensureRepo();
  const file = surfaceFile(org, surfaceKey);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(routines, null, 2) + "\n", "utf-8");
  return commit(message);
}

export function listRoutines(p: Partition): Promise<Routine[]> {
  return readFileList(p.org, p.surfaceKey);
}

export async function getRoutine(org: string, surfaceKey: string, id: string): Promise<Routine | null> {
  return (await readFileList(org, surfaceKey)).find((r) => r.id === id) ?? null;
}

export async function addRoutine(p: Partition, routine: Routine): Promise<Routine> {
  const list = await readFileList(p.org, p.surfaceKey);
  list.push(routine);
  await writeFileList(p.org, p.surfaceKey, list, `routine add ${routine.id} [${p.org}/${p.surfaceKey}]`);
  return routine;
}

export async function updateRoutine(
  org: string,
  surfaceKey: string,
  id: string,
  patch: Partial<Routine>,
): Promise<Routine | null> {
  const list = await readFileList(org, surfaceKey);
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const updated = { ...list[i], ...patch, id: list[i].id, org: list[i].org, surfaceKey: list[i].surfaceKey };
  list[i] = updated;
  await writeFileList(org, surfaceKey, list, `routine update ${id} [${org}/${surfaceKey}]`);
  return updated;
}

export async function removeRoutine(p: Partition, id: string): Promise<boolean> {
  const list = await readFileList(p.org, p.surfaceKey);
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  await writeFileList(p.org, p.surfaceKey, next, `routine remove ${id} [${p.org}/${p.surfaceKey}]`);
  return true;
}

export async function listAllRoutines(): Promise<Routine[]> {
  if (!existsSync(ROOT)) return [];
  const out: Routine[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
      } else if (entry.isFile() && entry.name === "routines.json") {
        try {
          const parsed = JSON.parse(await readFile(child, "utf-8"));
          if (Array.isArray(parsed)) out.push(...(parsed as Routine[]));
        } catch {
        }
      }
    }
  }
  await walk(ROOT, 0);
  return out;
}
