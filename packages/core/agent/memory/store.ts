import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import type { Partition } from "./partition.js";
import { safeName, seedFor, tierRelDir } from "./layout.js";

export type MemoryFiles = Record<string, string>;

export type Tier =
  | { readonly kind: "workspace" }
  | { readonly kind: "silo"; readonly name: string }
  | { readonly kind: "surface" };

export const WORKSPACE: Tier = { kind: "workspace" };
export const SURFACE: Tier = { kind: "surface" };
export const siloTier = (name: string): Tier => ({ kind: "silo", name });

export function tierId(t: Tier): string {
  return t.kind === "silo" ? `silo:${t.name}` : t.kind;
}

const ROOT = process.env.OE_MEMORY_DIR
  ? process.env.OE_MEMORY_DIR
  : join(process.cwd(), ".open-everywhere-memory");

function storeRelDir(p: Partition, tier: Tier): string {
  return `${safeName(p.org)}/${tierRelDir(p, tier)}`;
}

function tierAbsDir(p: Partition, tier: Tier): string {
  return join(ROOT, ...storeRelDir(p, tier).split("/"));
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.error) return { ok: false, stdout: "" };
    return { ok: r.status === 0, stdout: r.stdout ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function ensureRepo(): void {
  if (existsSync(join(ROOT, ".git"))) return;
  if (!git(["init", "--quiet"], ROOT).ok) return;
  git(["config", "user.email", "open-everywhere@local"], ROOT);
  git(["config", "user.name", "OpenEverywhere"], ROOT);
}

async function readDir(dir: string): Promise<MemoryFiles> {
  if (!existsSync(dir)) return {};
  const out: MemoryFiles = {};
  async function walk(abs: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out[relative(dir, child).split(sep).join(posix.sep)] = await readFile(child, "utf-8");
    }
  }
  await walk(dir);
  return out;
}

function commit(relDir: string, message: string): string | null {
  if (!git(["add", "-A", "--", relDir], ROOT).ok) return null;
  const status = git(["status", "--porcelain", "--", relDir], ROOT);
  if (status.ok && status.stdout.trim() === "") return null;
  if (!git(["commit", "--quiet", "-m", message], ROOT).ok) return null;
  const sha = git(["rev-parse", "--short", "HEAD"], ROOT);
  return sha.ok ? sha.stdout.trim() : null;
}

export async function readTier(p: Partition, tier: Tier): Promise<MemoryFiles> {
  return readDir(tierAbsDir(p, tier));
}

export async function ensureTier(p: Partition, tier: Tier): Promise<MemoryFiles> {
  await mkdir(ROOT, { recursive: true });
  ensureRepo();
  const existing = await readTier(p, tier);
  if (Object.keys(existing).length > 0) return existing;

  const dir = tierAbsDir(p, tier);
  const seed = seedFor(p, tier);
  for (const [rel, content] of Object.entries(seed)) {
    const abs = join(dir, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  commit(storeRelDir(p, tier), `seed ${tier} memory for ${storeRelDir(p, tier)}`);
  return seed;
}

export async function writeTier(
  p: Partition,
  tier: Tier,
  files: MemoryFiles,
  message: string,
): Promise<string | null> {
  await mkdir(ROOT, { recursive: true });
  ensureRepo();
  const dir = tierAbsDir(p, tier);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return commit(storeRelDir(p, tier), message);
}

export async function deleteTier(p: Partition, tier: Tier): Promise<void> {
  const dir = tierAbsDir(p, tier);
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true, force: true });
  ensureRepo();
  commit(storeRelDir(p, tier), `delete ${tierId(tier)} memory for ${storeRelDir(p, tier)}`);
}

export async function deleteFile(p: Partition, tier: Tier, relPath: string): Promise<string | null> {
  const dir = tierAbsDir(p, tier);
  const abs = join(dir, ...relPath.split("/"));
  if (!existsSync(abs)) return null;
  await rm(abs, { force: true });
  return commit(storeRelDir(p, tier), `delete ${relPath} from ${tierId(tier)} memory for ${storeRelDir(p, tier)}`);
}

export function storeRoot(): string {
  return ROOT;
}
