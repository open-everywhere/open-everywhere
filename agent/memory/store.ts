import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import type { Partition } from "./partition.js";

export type MemoryFiles = Record<string, string>;

const ROOT = process.env.OE_MEMORY_DIR
  ? process.env.OE_MEMORY_DIR
  : join(process.cwd(), ".open-everywhere-memory");

function seedFiles(p: Partition): MemoryFiles {
  return {
    "MEMORY.md": `# Channel memory — index (${p.key})

This file is loaded at the start of a task. Keep it a short, curated index of
what matters for this channel. Detail goes in the topic files alongside it and
is read on demand.

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

function partitionDir(p: Partition): string {
  return join(ROOT, ...p.relDir.split("/"));
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.error) return { ok: false, stdout: "", stderr: String(r.error) };
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
}

function ensureRepo(): void {
  if (existsSync(join(ROOT, ".git"))) return;
  const init = git(["init", "--quiet"], ROOT);
  if (!init.ok) return;
  git(["config", "user.email", "open-everywhere@local"], ROOT);
  git(["config", "user.name", "Open Everywhere"], ROOT);
}

export async function readPartition(p: Partition): Promise<MemoryFiles> {
  const dir = partitionDir(p);
  if (!existsSync(dir)) return {};
  const out: MemoryFiles = {};
  async function walk(abs: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        const rel = relative(dir, child).split(sep).join(posix.sep);
        out[rel] = await readFile(child, "utf-8");
      }
    }
  }
  await walk(dir);
  return out;
}

export async function ensurePartition(p: Partition): Promise<MemoryFiles> {
  await mkdir(ROOT, { recursive: true });
  ensureRepo();
  const dir = partitionDir(p);
  const existing = await readPartition(p);
  if (Object.keys(existing).length > 0) return existing;

  const seed = seedFiles(p);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    const abs = join(dir, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  commit(p, `seed memory for ${p.key}`);
  return seed;
}

export async function writePartition(
  p: Partition,
  files: MemoryFiles,
  message: string,
): Promise<string | null> {
  await mkdir(ROOT, { recursive: true });
  ensureRepo();
  const dir = partitionDir(p);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return commit(p, message);
}

function commit(p: Partition, message: string): string | null {
  const add = git(["add", "-A", "--", p.relDir], ROOT);
  if (!add.ok) return null;
  const status = git(["status", "--porcelain", "--", p.relDir], ROOT);
  if (status.ok && status.stdout.trim() === "") return null;
  const done = git(["commit", "--quiet", "-m", message], ROOT);
  if (!done.ok) return null;
  const sha = git(["rev-parse", "--short", "HEAD"], ROOT);
  return sha.ok ? sha.stdout.trim() : null;
}

export function storeRoot(): string {
  return ROOT;
}
