import { appendAudit } from "../audit/audit.js";
import { getSettings } from "../settings/settings.js";
import type { Partition } from "./partition.js";
import type { MemoryFiles } from "./store.js";
import type { AuditDetail, AuditDetailBuilder } from "../audit/scrubbed-text.js";

export const MEMORY_SYNC_TIMING_SETTING = "memory.syncTiming";

export const MEMORY_SYNC_TIMING_ACTION = "memory.sync_timing";

export function memorySyncTimingEnabled(): boolean {
  return getSettings().memory.syncTiming;
}

export interface SiloSyncTiming {
  readonly silo: string;
  readonly tier: string;
  readonly provider: string;
  readonly readOnly: boolean;
  readonly loadMs: number;
  readonly syncMs: number;
  readonly lockMs: number | null;
  readonly files: number;
  readonly bytes: number;
  readonly ok: boolean;
}

export interface MemorySyncTiming {
  readonly sessionId: string | null;
  readonly hookMs: number;
  readonly baselineMs: number | null;
  readonly sandboxMs: number | null;
  readonly indexMs: number | null;
  readonly versionsMs: number | null;
  readonly silos: readonly SiloSyncTiming[];
}

export type SyncPhase = "baseline" | "sandbox" | "index" | "versions";

class MemorySyncTimingCollector {
  private readonly startedAt = Date.now();
  private readonly phases: Partial<Record<SyncPhase, number>> = {};
  private readonly silos: SiloSyncTiming[] = [];

  now(): number {
    return Date.now();
  }

  mark(phase: SyncPhase, startedAt: number): void {
    this.phases[phase] = Date.now() - startedAt;
  }

  silo(entry: SiloSyncTiming): void {
    this.silos.push(entry);
  }

  finish(sessionId: string | null): MemorySyncTiming {
    return {
      sessionId,
      hookMs: Date.now() - this.startedAt,
      baselineMs: this.phases.baseline ?? null,
      sandboxMs: this.phases.sandbox ?? null,
      indexMs: this.phases.index ?? null,
      versionsMs: this.phases.versions ?? null,
      silos: [...this.silos],
    };
  }
}

export function startMemorySyncTiming(): MemorySyncTimingCollector | null {
  return memorySyncTimingEnabled() ? new MemorySyncTimingCollector() : null;
}

export function byteSize(files: MemoryFiles): number {
  let total = 0;
  for (const content of Object.values(files)) total += Buffer.byteLength(content, "utf8");
  return total;
}

const MAX_ID_LEN = 128;

function idString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.length === 0 || v.length > MAX_ID_LEN) return null;
  if (/[\r\n]/.test(v)) return null;
  return v;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function put(into: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) into[key] = value;
}

export const SILO_DETAIL_KEYS = ["silo", "tier", "provider", "readOnly", "loadMs", "syncMs", "lockMs", "files", "bytes", "ok"] as const;

export const SYNC_DETAIL_KEYS = ["sessionId", "hookMs", "baselineMs", "sandboxMs", "indexMs", "versionsMs", "siloCount", "silos"] as const;

export function toAuditDetail(record: MemorySyncTiming): AuditDetail {
  const src = record as unknown as Record<string, unknown>;
  const out: AuditDetailBuilder = {};
  put(out, "sessionId", idString(src["sessionId"]));
  put(out, "hookMs", finiteNumber(src["hookMs"]));
  put(out, "baselineMs", finiteNumber(src["baselineMs"]));
  put(out, "sandboxMs", finiteNumber(src["sandboxMs"]));
  put(out, "indexMs", finiteNumber(src["indexMs"]));
  put(out, "versionsMs", finiteNumber(src["versionsMs"]));

  const rawSilos = Array.isArray(src["silos"]) ? (src["silos"] as unknown[]) : [];
  const silos: Record<string, unknown>[] = [];
  for (const raw of rawSilos) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;
    const entry: Record<string, unknown> = {};
    put(entry, "silo", idString(s["silo"]));
    put(entry, "tier", idString(s["tier"]));
    put(entry, "provider", idString(s["provider"]));
    put(entry, "readOnly", bool(s["readOnly"]));
    put(entry, "loadMs", finiteNumber(s["loadMs"]));
    put(entry, "syncMs", finiteNumber(s["syncMs"]));
    put(entry, "lockMs", finiteNumber(s["lockMs"]));
    put(entry, "files", finiteNumber(s["files"]));
    put(entry, "bytes", finiteNumber(s["bytes"]));
    put(entry, "ok", bool(s["ok"]));
    silos.push(entry);
  }
  out["siloCount"] = silos.length;
  out["silos"] = silos;
  return out;
}

export function isTaintCleanDetail(detail: unknown): boolean {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
  const d = detail as Record<string, unknown>;
  const top = new Set<string>(SYNC_DETAIL_KEYS);
  const siloKeys = new Set<string>(SILO_DETAIL_KEYS);
  const scalarOk = (v: unknown): boolean =>
    idString(v) !== null || finiteNumber(v) !== null || bool(v) !== null;
  for (const [k, v] of Object.entries(d)) {
    if (!top.has(k)) return false;
    if (k === "silos") {
      if (!Array.isArray(v)) return false;
      for (const e of v) {
        if (!e || typeof e !== "object" || Array.isArray(e)) return false;
        for (const [ek, ev] of Object.entries(e as Record<string, unknown>)) {
          if (!siloKeys.has(ek) || !scalarOk(ev)) return false;
        }
      }
      continue;
    }
    if (!scalarOk(v)) return false;
  }
  return true;
}

export async function emitMemorySyncTiming(
  p: Partition,
  principalId: string | undefined,
  record: MemorySyncTiming,
): Promise<void> {
  const detail = toAuditDetail(record);
  if (!isTaintCleanDetail(detail)) {
    console.warn(`[open-everywhere:memory] sync-timing row DROPPED — projected detail failed the taint check (names/paths/counts only)`);
    return;
  }
  await appendAudit({
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    surface: p.surface,
    principalId,
    action: MEMORY_SYNC_TIMING_ACTION,
    detail,
  });
}
