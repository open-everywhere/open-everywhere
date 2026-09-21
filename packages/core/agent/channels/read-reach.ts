import {
  currentSessionId,
  currentTurnId,
  currentTurnIssue,
  currentTurnPage,
  currentWakeId,
  isUnifiedWindowContext,
  type BindableContext,
} from "../identity/binding.js";
import { addressedWakeThisTurn } from "../access/dispatch-origin-signal.js";
import { resolvePartition } from "../memory/partition.js";
import { noteConnectorRead, rememberRecordName, type ConnectorRead, type ConnectorReadProof } from "./reply-provenance.js";
import { noteDelegatedRead } from "./delegated-provenance.js";

export type ReadReach = Pick<ConnectorRead, "proof" | "surfaceKey" | "wakeId">;

export function stampReadReach(bind: BindableContext, turnId: string | undefined, surfaceKey: string | undefined): ReadReach {
  const unified = isUnifiedWindowContext(bind);
  const wakeId = unified ? (addressedWakeThisTurn(turnId) ?? currentWakeId(bind)) : undefined;
  const proof: ConnectorReadProof = unified ? (wakeId !== undefined ? "wake" : "none") : surfaceKey !== undefined ? "surface" : "none";
  return {
    proof,
    ...(proof === "surface" && surfaceKey !== undefined ? { surfaceKey } : {}),
    ...(proof === "wake" && wakeId !== undefined ? { wakeId } : {}),
  };
}

export type AuthoredRecordKind = "notion-page" | "linear-issue";

const AUTHORED_READ_TOOLS: Readonly<Record<AuthoredRecordKind, { readonly connection: string; readonly op: string }>> = {
  "notion-page": { connection: "notion", op: "read_notion_page" },
  "linear-issue": { connection: "linear", op: "read_linear_issue" },
};

export interface AuthoredRecordRead {
  readonly kind: AuthoredRecordKind;
  readonly id: string;
  readonly alsoKnownAs?: readonly (string | undefined)[];
  readonly name?: string;
}

function idKey(v: string): string {
  const lower = v.toLowerCase();
  const dashless = lower.replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(dashless) ? dashless : lower;
}

function sameId(a: string, b: string): boolean {
  const key = idKey(a);
  return key.length > 0 && key === idKey(b);
}

function roomRecordId(kind: AuthoredRecordKind, bind: BindableContext): string | undefined {
  switch (kind) {
    case "linear-issue":
      return currentTurnIssue(bind);
    case "notion-page":
      return currentTurnPage(bind);
  }
}

function roomHoldsRecordId(read: AuthoredRecordRead, bind: BindableContext): boolean {
  const room = roomRecordId(read.kind, bind);
  if (room === undefined || room.length === 0) return false;
  for (const candidate of [read.id, ...(read.alsoKnownAs ?? [])]) {
    if (typeof candidate === "string" && candidate.length > 0 && sameId(candidate, room)) return true;
  }
  return false;
}

export function noteAuthoredRecordRead(ctx: unknown, read: AuthoredRecordRead): void {
  try {
    const spec = AUTHORED_READ_TOOLS[read.kind];
    if (spec === undefined || typeof read.id !== "string" || read.id.length === 0) return;
    const bind = ctx as BindableContext;
    const turnId = currentTurnId(bind);
    if (turnId === undefined || turnId.length === 0) return;
    let surfaceKey: string | undefined;
    try {
      surfaceKey = resolvePartition(bind).surfaceKey;
    } catch {
      surfaceKey = undefined;
    }
    const named = roomHoldsRecordId(read, bind);
    noteConnectorRead(turnId, {
      ...stampReadReach(bind, turnId, surfaceKey),
      connection: spec.connection,
      op: spec.op,
      ...(named ? { record: { kind: read.kind, id: read.id } } : {}),
    });
    noteDelegatedRead(bind, spec.connection, spec.op);
    if (named) rememberRecordName(currentSessionId(bind), turnId, read.kind, read.id, read.name);
  } catch {
  }
}

export const BORROWED_RECORD_KIND = "credential-grant";

export const BORROWED_READ_OP = "credential_grant_borrow";

export interface BorrowedRecordRead {
  readonly connection: string;
  readonly grantId: string;
  readonly targetLabel?: string;
}

export function noteBorrowedRecordRead(ctx: unknown, read: BorrowedRecordRead): void {
  try {
    if (read.connection.length === 0 || read.grantId.length === 0) return;
    const bind = ctx as BindableContext;
    const turnId = currentTurnId(bind);
    if (turnId === undefined || turnId.length === 0) return;
    let surfaceKey: string | undefined;
    try {
      surfaceKey = resolvePartition(bind).surfaceKey;
    } catch {
      surfaceKey = undefined;
    }
    const label = read.targetLabel !== undefined && read.targetLabel.length > 0 ? read.targetLabel : undefined;
    noteConnectorRead(turnId, {
      ...stampReadReach(bind, turnId, surfaceKey),
      connection: read.connection,
      op: BORROWED_READ_OP,
      ...(label === undefined ? {} : { record: { kind: BORROWED_RECORD_KIND, id: read.grantId } }),
    });
    if (label !== undefined) rememberRecordName(currentSessionId(bind), turnId, BORROWED_RECORD_KIND, read.grantId, label);
    noteDelegatedRead(bind, read.connection, BORROWED_READ_OP);
  } catch {
  }
}
