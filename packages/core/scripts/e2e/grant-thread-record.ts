import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface GrantThreadRecord {
  readonly threadId: string;
  readonly raisedAt: string;
}

export const GRANT_THREAD_RECORD_MAX_AGE_MS = 30 * 60 * 1000 + 12 * 60 * 60 * 1000;

export const DEFAULT_GRANT_THREAD_SINK = ".e2e-discord-grant-thread.json";

export function serializeGrantThreadRecord(record: GrantThreadRecord): string {
  return `${JSON.stringify({ threadId: record.threadId, raisedAt: record.raisedAt }, null, 2)}\n`;
}

export function parseGrantThreadRecord(raw: string): GrantThreadRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { threadId, raisedAt } = parsed as { threadId?: unknown; raisedAt?: unknown };
  if (typeof threadId !== "string" || threadId.trim().length === 0) return undefined;
  if (typeof raisedAt !== "string" || !Number.isFinite(Date.parse(raisedAt))) return undefined;
  return { threadId: threadId.trim(), raisedAt };
}

export type GrantThreadResolution =
  | { readonly kind: "pin"; readonly threadId: string }
  | { readonly kind: "record"; readonly threadId: string; readonly ageMs: number }
  | { readonly kind: "expired"; readonly threadId: string; readonly ageMs: number; readonly maxAgeMs: number }
  | { readonly kind: "absent" };

export function resolveGrantThread(opts: {
  readonly pin?: string;
  readonly record?: GrantThreadRecord;
  readonly nowMs: number;
  readonly maxAgeMs?: number;
}): GrantThreadResolution {
  const pin = opts.pin?.trim();
  if (pin !== undefined && pin.length > 0) return { kind: "pin", threadId: pin };
  const record = opts.record;
  if (record === undefined) return { kind: "absent" };
  const maxAgeMs = opts.maxAgeMs ?? GRANT_THREAD_RECORD_MAX_AGE_MS;
  const ageMs = opts.nowMs - Date.parse(record.raisedAt);
  if (ageMs > maxAgeMs) return { kind: "expired", threadId: record.threadId, ageMs, maxAgeMs };
  return { kind: "record", threadId: record.threadId, ageMs };
}

export function readGrantThreadRecord(path: string): GrantThreadRecord | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return parseGrantThreadRecord(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeGrantThreadRecord(path: string, record: GrantThreadRecord): boolean {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serializeGrantThreadRecord(record));
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.warn(`[e2e:discord-grant] could not persist the grant thread record to ${path}: ${String(err instanceof Error ? err.message : err)}`);
    return false;
  }
}
