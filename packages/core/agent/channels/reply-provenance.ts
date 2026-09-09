import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import type { ReplyAudit } from "./reply-post.js";

export interface ConnectorRead {
  readonly connection: string;
  readonly op: string;
  readonly surfaceKey?: string;
}

interface ReplyProvenanceState {
  readonly turn?: string;
  readonly reads?: readonly ConnectorRead[];
}

const slot = defineState<ReplyProvenanceState>("open-everywhere.reply-provenance", () => ({}));

const MAX_READS = 32;

const MAX_NAMED = 6;

export const PROVENANCE_READ_TIER = "read" as const;

export const REPLY_PROVENANCE_ACTION = "reply.provenance";

function readState(v: unknown): ReplyProvenanceState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; reads?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const reads = Array.isArray(s.reads)
    ? s.reads.flatMap((r): ConnectorRead[] => {
        if (typeof r !== "object" || r === null) return [];
        const raw = r as { connection?: unknown; op?: unknown; surfaceKey?: unknown };
        if (typeof raw.connection !== "string" || raw.connection.length === 0) return [];
        if (typeof raw.op !== "string" || raw.op.length === 0) return [];
        return [
          {
            connection: raw.connection,
            op: raw.op,
            ...(typeof raw.surfaceKey === "string" && raw.surfaceKey.length > 0 ? { surfaceKey: raw.surfaceKey } : {}),
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
    connection: read.connection,
    op: read.op,
    ...(read.surfaceKey !== undefined && read.surfaceKey.length > 0 ? { surfaceKey: read.surfaceKey } : {}),
  };
  const same = (a: ConnectorRead, b: ConnectorRead): boolean => a.connection === b.connection && a.op === b.op && a.surfaceKey === b.surfaceKey;
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
}

function provenanceForReply(
  reads: readonly ConnectorRead[],
  audit: Pick<ReplyAudit, "platform" | "workspace" | "surface"> | undefined,
): ReplyProvenance | undefined {
  if (reads.length === 0) return undefined;
  const roomKey =
    audit === undefined || audit.platform === "unified" || audit.surface === undefined || audit.surface.length === 0
      ? undefined
      : `${audit.platform}/${audit.workspace}/${audit.surface}`;
  const named: string[] = [];
  const other = new Set<string>();
  for (const r of reads) {
    const visible = roomKey !== undefined && r.surfaceKey === roomKey;
    if (visible) {
      if (!named.includes(r.connection)) named.push(r.connection);
    } else if (!named.includes(r.connection)) {
      other.add(r.connection);
    }
  }
  for (const n of named) other.delete(n);
  return { named, otherDomains: other.size };
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
  const parts: string[] = [...listed];
  if (overflow > 0) parts.push(`${overflow} more`);
  if (p.otherDomains > 0) parts.push(`${p.otherDomains} in another domain`);
  if (parts.length === 0) return undefined;
  return `${PROVENANCE_FOOTER_PREFIX} ${parts.join(", ")}`;
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
  const shown = provenanceForReply(reads, audit);
  return { body: withProvenanceFooter(text, shown), bare: withProvenanceFooter(text, undefined), footer: renderProvenanceFooter(shown), reads, shown };
}
