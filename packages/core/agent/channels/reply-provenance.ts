import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import type { ReplyAudit } from "./reply-post.js";

export type ConnectorReadProof = "surface" | "wake" | "none";

export interface ConnectorReadRecord {
  readonly kind: string;
  readonly id: string;
}

export interface ConnectorRead {
  readonly proof: ConnectorReadProof;
  readonly connection: string;
  readonly op: string;
  readonly surfaceKey?: string;
  readonly wakeId?: string;
  readonly record?: ConnectorReadRecord;
}

interface ReplyProvenanceState {
  readonly turn?: string;
  readonly reads?: readonly ConnectorRead[];
}

const slot = defineState<ReplyProvenanceState>("open-everywhere.reply-provenance", () => ({}));

const MAX_READS = 32;

const MAX_NAMED = 6;

const MAX_FOOTER_CHARS = 160;

const MAX_RECORD_NAME_CHARS = 120;

const MAX_RECORD_NAMES = 256;

const recordNames = new Map<string, string>();

function recordNameKey(sessionId: string | undefined, turnId: string | undefined, kind: string, id: string): string | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined;
  if (turnId === undefined || turnId.length === 0) return undefined;
  if (kind.length === 0 || id.length === 0) return undefined;
  return `${sessionId}::${turnId}::${kind}::${id}`;
}

export const PROVENANCE_READ_TIER = "read" as const;

export const REPLY_PROVENANCE_ACTION = "reply.provenance";

function readRecord(v: unknown): ConnectorReadRecord | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const raw = v as { kind?: unknown; id?: unknown };
  if (typeof raw.kind !== "string" || raw.kind.length === 0) return undefined;
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  return { kind: raw.kind, id: raw.id };
}

function readState(v: unknown): ReplyProvenanceState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; reads?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const reads = Array.isArray(s.reads)
    ? s.reads.flatMap((r): ConnectorRead[] => {
        if (typeof r !== "object" || r === null) return [];
        const raw = r as { connection?: unknown; op?: unknown; surfaceKey?: unknown; wakeId?: unknown; proof?: unknown; record?: unknown };
        if (typeof raw.connection !== "string" || raw.connection.length === 0) return [];
        if (typeof raw.op !== "string" || raw.op.length === 0) return [];
        const record = readRecord(raw.record);
        return [
          {
            ...(record !== undefined ? { record } : {}),
            proof: raw.proof === "surface" || raw.proof === "wake" ? raw.proof : "none",
            connection: raw.connection,
            op: raw.op,
            ...(typeof raw.surfaceKey === "string" && raw.surfaceKey.length > 0 ? { surfaceKey: raw.surfaceKey } : {}),
            ...(typeof raw.wakeId === "string" && raw.wakeId.length > 0 ? { wakeId: raw.wakeId } : {}),
          },
        ];
      })
    : [];
  return { turn: s.turn, reads };
}

export function noteConnectorRead(turnId: string | undefined, read: ConnectorRead): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (read.connection.length === 0 || read.op.length === 0) return;
  const entry: ConnectorRead = {
    proof: read.proof,
    connection: read.connection,
    op: read.op,
    ...(read.surfaceKey !== undefined && read.surfaceKey.length > 0 ? { surfaceKey: read.surfaceKey } : {}),
    ...(read.wakeId !== undefined && read.wakeId.length > 0 ? { wakeId: read.wakeId } : {}),
    ...(read.record !== undefined && read.record.kind.length > 0 && read.record.id.length > 0 ? { record: { kind: read.record.kind, id: read.record.id } } : {}),
  };
  const same = (a: ConnectorRead, b: ConnectorRead): boolean =>
    a.connection === b.connection &&
    a.op === b.op &&
    a.proof === b.proof &&
    a.surfaceKey === b.surfaceKey &&
    a.wakeId === b.wakeId &&
    a.record?.kind === b.record?.kind &&
    a.record?.id === b.record?.id;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return { turn: turnId, reads: [entry] };
      const reads = state.reads ?? [];
      if (reads.length >= MAX_READS || reads.some((r) => same(r, entry))) return state;
      return { turn: turnId, reads: [...reads, entry] };
    });
  } catch {
  }
}

function flattenRecordName(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const flat = raw
    .replace(/\p{C}/gu, " ")
    .replace(/[(),]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (flat.includes(PROVENANCE_FOOTER_PREFIX)) return undefined;
  return flat.length === 0 ? undefined : Array.from(flat).slice(0, MAX_RECORD_NAME_CHARS).join("");
}

export function rememberRecordName(
  sessionId: string | undefined,
  turnId: string | undefined,
  kind: string,
  id: string,
  name: string | undefined,
): void {
  const key = recordNameKey(sessionId, turnId, kind, id);
  if (key === undefined) return;
  const flat = flattenRecordName(name);
  if (flat === undefined) return;
  recordNames.delete(key);
  if (recordNames.size >= MAX_RECORD_NAMES) {
    const oldest = recordNames.keys().next();
    if (oldest.done !== true) recordNames.delete(oldest.value);
  }
  recordNames.set(key, flat);
}

function recordDisplayName(
  sessionId: string | undefined,
  turnId: string | undefined,
  record: ConnectorReadRecord | undefined,
): string | undefined {
  if (record === undefined) return undefined;
  const key = recordNameKey(sessionId, turnId, record.kind, record.id);
  return key === undefined ? undefined : recordNames.get(key);
}

export function connectorReadsThisTurn(turnId: string | undefined): readonly ConnectorRead[] {
  if (turnId === undefined || turnId.length === 0) return [];
  let state: ReplyProvenanceState;
  try {
    state = readState(slot.get());
  } catch {
    return [];
  }
  if (state.turn !== turnId) return [];
  return state.reads ?? [];
}

export interface ReplyProvenance {
  readonly named: readonly string[];
  readonly otherDomains: number;
  readonly records?: Readonly<Record<string, string>>;
}

function provenanceForReply(
  reads: readonly ConnectorRead[],
  audit: Pick<ReplyAudit, "platform" | "workspace" | "surface" | "wakeId"> | undefined,
  sessionId: string | undefined,
  turnId: string | undefined,
): ReplyProvenance | undefined {
  if (reads.length === 0) return undefined;
  const wakeKey = audit?.wakeId !== undefined && audit.wakeId.length > 0 ? audit.wakeId : undefined;
  const roomKey =
    audit === undefined || audit.platform === "unified" || audit.surface === undefined || audit.surface.length === 0
      ? undefined
      : `${audit.platform}/${audit.workspace}/${audit.surface}`;
  const named: string[] = [];
  const other = new Set<string>();
  const records: Record<string, string> = {};
  for (const r of reads) {
    const visible =
      r.proof === "wake"
        ? wakeKey !== undefined && r.wakeId === wakeKey
        : r.proof === "surface"
          ? roomKey !== undefined && r.surfaceKey === roomKey
          : false;
    if (visible) {
      if (!named.includes(r.connection)) named.push(r.connection);
      if (records[r.connection] === undefined) {
        const name = recordDisplayName(sessionId, turnId, r.record);
        if (name !== undefined) records[r.connection] = name;
      }
    } else if (!named.includes(r.connection)) {
      other.add(r.connection);
    }
  }
  for (const n of named) other.delete(n);
  return { named, otherDomains: other.size, ...(Object.keys(records).length > 0 ? { records } : {}) };
}

export const PROVENANCE_FOOTER_PREFIX = "Sources read this turn:";

function stripForgedFooter(text: string): string {
  if (!text.includes(PROVENANCE_FOOTER_PREFIX)) return text;
  const forged = (line: string): boolean => line.replace(/^[\s*_>\-#]+/, "").startsWith(PROVENANCE_FOOTER_PREFIX);
  return text
    .split("\n")
    .filter((line) => !forged(line))
    .join("\n")
    .trimEnd();
}

function renderProvenanceFooter(p: ReplyProvenance | undefined): string | undefined {
  if (p === undefined) return undefined;
  const listed = p.named.slice(0, MAX_NAMED);
  const overflow = p.named.length - listed.length;
  const tail: string[] = [];
  if (overflow > 0) tail.push(`${overflow} more`);
  if (p.otherDomains > 0) tail.push(`${p.otherDomains} in another domain`);
  if (listed.length === 0 && tail.length === 0) return undefined;
  const line = (items: readonly string[]): string => `${PROVENANCE_FOOTER_PREFIX} ${[...items, ...tail].join(", ")}`;
  const items = listed.map((c) => {
    const record = p.records?.[c];
    return record === undefined ? c : `${c} (${record})`;
  });
  for (let i = items.length - 1; i >= 0 && line(items).length > MAX_FOOTER_CHARS; i--) items[i] = listed[i]!;
  return line(items);
}

function withProvenanceFooter(text: string, p: ReplyProvenance | undefined): string {
  const body = stripForgedFooter(text);
  const footer = renderProvenanceFooter(p);
  return footer === undefined ? body : `${body}\n\n${footer}`;
}

export async function auditReplyProvenance(
  audit: ReplyAudit | undefined,
  messageId: string,
  platform: string,
  reads: readonly ConnectorRead[],
  shown: ReplyProvenance | undefined,
): Promise<void> {
  if (!audit || reads.length === 0) return;
  const connections = [...new Set(reads.map((r) => r.connection))];
  await appendAudit({
    org: audit.org,
    platform: audit.platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: REPLY_PROVENANCE_ACTION,
    detail: {
      id: messageId,
      platform,
      connections,
      ops: [...new Set(reads.map((r) => `${r.connection}/${r.op}`))],
      reads: reads.length,
      named: shown?.named.length ?? 0,
      withheld: connections.length - (shown?.named.length ?? 0),
      ...(audit.wakeId ? { wakeId: audit.wakeId } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
    },
  }).catch(() => undefined);
}

export function applyReplyProvenance(
  text: string,
  audit: ReplyAudit | undefined,
): {
  readonly body: string;
  readonly bare: string;
  readonly footer: string | undefined;
  readonly reads: readonly ConnectorRead[];
  readonly shown: ReplyProvenance | undefined;
} {
  const reads = connectorReadsThisTurn(audit?.turnId);
  const shown = provenanceForReply(reads, audit, audit?.sessionId, audit?.turnId);
  return { body: withProvenanceFooter(text, shown), bare: withProvenanceFooter(text, undefined), footer: renderProvenanceFooter(shown), reads, shown };
}
