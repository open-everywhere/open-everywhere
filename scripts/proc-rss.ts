import { readdirSync, readFileSync } from "node:fs";

export interface ProcProbe {
  readonly listPids: () => readonly number[];
  readonly readStatus: (pid: number) => string;
}

export const HOST_PROC_PROBE: ProcProbe = {
  listPids: () =>
    readdirSync("/proc")
      .map((name) => Number(name))
      .filter((n) => Number.isInteger(n) && n > 0),
  readStatus: (pid) => readFileSync(`/proc/${pid}/status`, "utf8"),
};

export function rssBytesOf(status: string): number | undefined {
  const m = /^VmRSS:\s+(\d+)\s*kB$/mu.exec(status);
  if (m === null) return undefined;
  const kb = Number(m[1]);
  return Number.isSafeInteger(kb) ? kb * 1024 : undefined;
}

export function ppidOf(status: string): number | undefined {
  const m = /^PPid:\s+(\d+)$/mu.exec(status);
  if (m === null) return undefined;
  const ppid = Number(m[1]);
  return Number.isSafeInteger(ppid) ? ppid : undefined;
}

export function treeRssBytes(rootPid: number, probe: ProcProbe = HOST_PROC_PROBE): number {
  let pids: readonly number[];
  try {
    pids = probe.listPids();
  } catch {
    return 0;
  }
  const rss = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const pid of pids) {
    let status: string;
    try {
      status = probe.readStatus(pid);
    } catch {
      continue;
    }
    const bytes = rssBytesOf(status);
    if (bytes !== undefined) rss.set(pid, bytes);
    const parent = ppidOf(status);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  let total = 0;
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    total += rss.get(pid) ?? 0;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return total;
}

export const DEFAULT_RSS_SAMPLE_MS = 2_000;

export interface RssSampler {
  stop(): number;
}

export function samplePeakRss(rootPid: number, intervalMs = DEFAULT_RSS_SAMPLE_MS, probe: ProcProbe = HOST_PROC_PROBE): RssSampler {
  let peak = treeRssBytes(rootPid, probe);
  const timer = setInterval(() => {
    const now = treeRssBytes(rootPid, probe);
    if (now > peak) peak = now;
  }, intervalMs);
  timer.unref?.();
  return {
    stop(): number {
      clearInterval(timer);
      return peak;
    },
  };
}

export function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "not measured";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
