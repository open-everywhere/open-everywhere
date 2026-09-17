import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface LegacyGrantThreadRecord {
  readonly threadId: string;
  readonly raisedAt: string;
}

export interface ExactGrantThreadRecord extends LegacyGrantThreadRecord {
  readonly askId: string;
  readonly scopeKey: string;
}

export type GrantThreadRecord = ExactGrantThreadRecord | LegacyGrantThreadRecord;

export const DEFAULT_GRANT_THREAD_SINK = ".e2e-discord-grant-thread.json";

export const GRANT_RECORD_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export function isExactGrantThreadRecord(record: GrantThreadRecord | undefined): record is ExactGrantThreadRecord {
  return record !== undefined && "askId" in record && record.askId.length > 0 && "scopeKey" in record && record.scopeKey.length > 0;
}

export function serializeGrantThreadRecord(record: ExactGrantThreadRecord): string {
  return `${JSON.stringify(
    { threadId: record.threadId, raisedAt: record.raisedAt, askId: record.askId, scopeKey: record.scopeKey },
    null,
    2,
  )}\n`;
}

export function parseGrantThreadRecord(raw: string): GrantThreadRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { threadId, raisedAt, askId, scopeKey } = parsed as {
    threadId?: unknown;
    raisedAt?: unknown;
    askId?: unknown;
    scopeKey?: unknown;
  };
  if (typeof threadId !== "string" || threadId.trim().length === 0) return undefined;
  if (typeof raisedAt !== "string" || !Number.isFinite(Date.parse(raisedAt))) return undefined;
  const base: LegacyGrantThreadRecord = { threadId: threadId.trim(), raisedAt };
  if (typeof askId !== "string" || askId.trim().length === 0 || typeof scopeKey !== "string" || scopeKey.trim().length === 0) return base;
  return { ...base, askId: askId.trim(), scopeKey: scopeKey.trim() };
}

export type GrantThreadResolution =
  | {
      readonly kind: "record";
      readonly source: "sidecar" | "pin-confirmed";
      readonly threadId: string;
      readonly askId: string;
      readonly scopeKey: string;
      readonly raisedAt: string;
      readonly ageMs: number;
    }
  | {
      readonly kind: "ambiguous";
      readonly reason: "pin-only" | "legacy-record" | "pin-record-mismatch" | "future-record";
      readonly threadId?: string;
      readonly recordedThreadId?: string;
    }
  | { readonly kind: "absent" };

export function resolveGrantThread(opts: {
  readonly pin?: string;
  readonly record?: GrantThreadRecord;
  readonly nowMs: number;
}): GrantThreadResolution {
  const pin = opts.pin?.trim();
  const usablePin = pin !== undefined && pin.length > 0 ? pin : undefined;
  const record = opts.record;
  if (record === undefined) return usablePin === undefined ? { kind: "absent" } : { kind: "ambiguous", reason: "pin-only", threadId: usablePin };
  if (!isExactGrantThreadRecord(record)) {
    return {
      kind: "ambiguous",
      reason: "legacy-record",
      threadId: usablePin ?? record.threadId,
      ...(usablePin !== undefined && usablePin !== record.threadId ? { recordedThreadId: record.threadId } : {}),
    };
  }
  if (usablePin !== undefined && usablePin !== record.threadId) {
    return { kind: "ambiguous", reason: "pin-record-mismatch", threadId: usablePin, recordedThreadId: record.threadId };
  }
  const ageMs = opts.nowMs - Date.parse(record.raisedAt);
  if (ageMs < -GRANT_RECORD_FUTURE_TOLERANCE_MS) {
    return { kind: "ambiguous", reason: "future-record", threadId: record.threadId };
  }
  return {
    kind: "record",
    source: usablePin === undefined ? "sidecar" : "pin-confirmed",
    threadId: record.threadId,
    askId: record.askId,
    scopeKey: record.scopeKey,
    raisedAt: record.raisedAt,
    ageMs,
  };
}

export function readGrantThreadRecord(path: string): GrantThreadRecord | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return parseGrantThreadRecord(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeGrantThreadRecord(path: string, record: ExactGrantThreadRecord): boolean {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serializeGrantThreadRecord(record));
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.warn(
      `[e2e:discord-grant] could not persist the exact grant record to ${path}: ${String(err instanceof Error ? err.message : err)}`,
    );
    return false;
  }
}
