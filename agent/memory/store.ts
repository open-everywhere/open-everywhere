import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import type { Partition } from "./partition.js";

export type MemoryFiles = Record<string, string>;
export type Tier = "workspace" | "surface";

export const ALL_TIERS: readonly Tier[] = ["workspace", "surface"];

const ROOT = process.env.OE_MEMORY_DIR
  ? process.env.OE_MEMORY_DIR
  : join(process.cwd(), ".open-everywhere-memory");

function tierRelDir(p: Partition, tier: Tier): string {
  return tier === "workspace"
    ? `${p.workspaceKey}/@workspace`
    : `${p.workspaceKey}/@surfaces/${p.surface}`;
}

function tierAbsDir(p: Partition, tier: Tier): string {
  return join(ROOT, ...tierRelDir(p, tier).split("/"));
}

function seedFor(p: Partition, tier: Tier): MemoryFiles {
  if (tier === "workspace") {
    return {
      "MEMORY.md": `# Workspace memory — index (${p.workspaceKey})

Shared across **every surface** (channel/DM) in this workspace. Put facts here
when they're true org-wide — deploy process, who owns what, standing decisions —
so a new or similar surface inherits them instead of starting blank.

## Standing instructions
<!-- e.g. "Changes go to acme/data-pipeline, never acme/website." -->
(none yet)

## People / ownership
<!-- e.g. "Payments area owner: @jane" -->
(none yet)

## Decisions
<!-- e.g. "2026-06-23: reports go out as tables, not prose." -->
(none yet)
`,
    };
  }
  return {
    "MEMORY.md": `# Surface memory — index (${p.surfaceKey})

Specific to **this surface only**. Put facts here when they matter here but not
workspace-wide. If something generalises, save it to workspace memory instead.

## Standing instructions
(none yet)

## People / ownership
(none yet)

## Decisions
(none yet)
`,
  };
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
  git(["config", "user.name", "Open Everywhere"], ROOT);
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
  commit(tierRelDir(p, tier), `seed ${tier} memory for ${tierRelDir(p, tier)}`);
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
  return commit(tierRelDir(p, tier), message);
}

export function storeRoot(): string {
  return ROOT;
}
