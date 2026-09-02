import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

export const UNCAPPED_MAX_WORKERS = 2;
export const CGROUP_CAPPED_MAX_WORKERS = 1;

export interface MemoryProbe {
  readonly readFile: (path: string) => string;
  readonly totalMemoryBytes: () => number;
}

export const HOST_MEMORY_PROBE: MemoryProbe = {
  readFile: (path) => readFileSync(path, "utf8"),
  totalMemoryBytes: () => totalmem(),
};

export function ciMaxWorkersOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OE_IT_CI_MAX_WORKERS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function readLimitBytes(probe: MemoryProbe, path: string): number | undefined {
  let raw: string;
  try {
    raw = probe.readFile(path);
  } catch {
    return undefined;
  }
  const text = raw.trim();
  if (text === "" || text === "max") return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return n;
}

function limitFilesFor(selfCgroup: string): string[] {
  const files: string[] = [];
  for (const line of selfCgroup.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const controllers = parts[1];
    const path = parts.slice(2).join(":");
    const suffix = path === "/" ? "" : path;
    if (controllers === "") {
      files.push(`/sys/fs/cgroup${suffix}/memory.max`);
      files.push("/sys/fs/cgroup/memory.max");
    } else if (controllers.split(",").includes("memory")) {
      files.push(`/sys/fs/cgroup/memory${suffix}/memory.limit_in_bytes`);
      files.push("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    }
  }
  return files;
}

export function cgroupMemoryCapBytes(probe: MemoryProbe = HOST_MEMORY_PROBE): number | undefined {
  let selfCgroup: string;
  try {
    selfCgroup = probe.readFile("/proc/self/cgroup");
  } catch {
    return undefined;
  }
  let smallest: number | undefined;
  for (const file of limitFilesFor(selfCgroup)) {
    const bytes = readLimitBytes(probe, file);
    if (bytes !== undefined && (smallest === undefined || bytes < smallest)) smallest = bytes;
  }
  if (smallest === undefined || smallest >= probe.totalMemoryBytes()) return undefined;
  return smallest;
}

export function integrationMaxWorkers(env: NodeJS.ProcessEnv = process.env, probe: MemoryProbe = HOST_MEMORY_PROBE): number {
  const override = ciMaxWorkersOverride(env);
  if (override !== undefined) return override;
  return cgroupMemoryCapBytes(probe) === undefined ? UNCAPPED_MAX_WORKERS : CGROUP_CAPPED_MAX_WORKERS;
}
