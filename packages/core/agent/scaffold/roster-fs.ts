import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeLock, type PlanFile, type ResolvedPackage, type DeclaredPackage } from "./roster-plan.js";
import type { RosterLock } from "./roster-config.js";
import { findUpward } from "./app-root.js";

export const CONFIG_FILE = "roster.config.ts";
const LOCK_FILE = "roster.lock.json";

export function findRepoRoot(start: string): string | undefined {
  return findUpward(start, (dir) => existsSync(join(dir, CONFIG_FILE)));
}

export async function loadRosterConfig(repoRoot: string): Promise<{ raw?: unknown; error?: string }> {
  const path = join(repoRoot, CONFIG_FILE);
  if (!existsSync(path)) return { error: `${path} does not exist. Every Open Everywhere app declares its roster there.` };
  try {
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    return { raw: mod.default };
  } catch (err) {
    return { error: `${path} could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function readLock(repoRoot: string): { lock?: unknown; error?: string } {
  const path = join(repoRoot, LOCK_FILE);
  if (!existsSync(path)) return {};
  try {
    return { lock: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (err) {
    return { error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function writeLock(repoRoot: string, lock: RosterLock): void {
  writeFileSync(join(repoRoot, LOCK_FILE), serializeLock(lock));
}

function owningPackage(file: string): { name?: string; version?: string } {
  let dir = dirname(file);
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const json = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        return { name: json.name, version: json.version };
      } catch {
        return {};
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

function resolveFromApp(repoRoot: string, specifier: string): string {
  return createRequire(pathToFileURL(join(repoRoot, "package.json")).href).resolve(specifier);
}

export async function resolvePackages(repoRoot: string, declared: readonly DeclaredPackage[]): Promise<ResolvedPackage[]> {
  const out: ResolvedPackage[] = [];
  for (const pkg of declared) {
    if (pkg.decision === false) {
      out.push({ ...pkg });
      continue;
    }
    const specifier = `${pkg.name}/agent/contributions.js`;
    let file: string;
    try {
      file = resolveFromApp(repoRoot, specifier);
    } catch (err) {
      out.push({ ...pkg, error: `cannot resolve "${specifier}" (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    let manifest: unknown;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { CONTRIBUTIONS?: unknown; default?: unknown };
      manifest = mod.CONTRIBUTIONS ?? mod.default;
    } catch (err) {
      out.push({ ...pkg, error: `"${specifier}" failed to load (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    if (manifest === undefined) {
      out.push({ ...pkg, error: `"${specifier}" exports neither CONTRIBUTIONS nor a default` });
      continue;
    }
    const owner = owningPackage(file);
    out.push({ ...pkg, manifest, resolvedName: owner.name, version: owner.version });
  }
  return out;
}

export function unresolvableSpecifiers(repoRoot: string, specifiers: readonly string[]): [string, string][] {
  const bad: [string, string][] = [];
  for (const specifier of [...new Set(specifiers)].sort()) {
    try {
      resolveFromApp(repoRoot, specifier);
    } catch (err) {
      bad.push([specifier, err instanceof Error ? err.message.split("\n")[0]! : String(err)]);
    }
  }
  return bad;
}

export interface Reconciliation {
  readonly written: readonly string[];
  readonly deleted: readonly string[];
  readonly unchanged: readonly string[];
  readonly skipped: readonly string[];
}

export function diffAgainstDisk(repoRoot: string, files: readonly PlanFile[], ownedDirs: readonly string[]): Reconciliation {
  const planned = new Map(files.map((f) => [f.path, f.content]));
  const written: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const [path, content] of planned) {
    const abs = join(repoRoot, path);
    if (existsSync(abs) && readFileSync(abs, "utf8") === content) unchanged.push(path);
    else written.push(path);
  }
  for (const dir of ownedDirs) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      const rel = `${dir}/${entry}`;
      if (planned.has(rel)) continue;
      if (statSync(join(abs, entry)).isDirectory()) skipped.push(rel);
      else deleted.push(rel);
    }
  }
  return { written: written.sort(), deleted: deleted.sort(), unchanged: unchanged.sort(), skipped: skipped.sort() };
}

export function applyPlan(repoRoot: string, files: readonly PlanFile[], ownedDirs: readonly string[]): Reconciliation {
  const diff = diffAgainstDisk(repoRoot, files, ownedDirs);
  for (const dir of ownedDirs) mkdirSync(join(repoRoot, dir), { recursive: true });
  for (const f of files) {
    if (diff.unchanged.includes(f.path)) continue;
    const abs = join(repoRoot, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  for (const path of diff.deleted) rmSync(join(repoRoot, path), { force: true });
  return diff;
}
