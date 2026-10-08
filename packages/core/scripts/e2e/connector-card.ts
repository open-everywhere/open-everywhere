import type { AuditWireEntry } from "./audit-read.js";
import type { SuspendedMessageAnchor } from "./suspended-approval.js";

export const CONNECTOR_CARD_KIND = "op.connector";

export const CONNECTOR_CARD_ACTIONS = [
  "wake.ingress",
  "wake.turn_start",
  "work.forwarded",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "connector.op_approved",
  "approval.decision_wake",
  "connector.op",
  "reply.post",
  "reply.edit",
] as const;

export interface ConnectorCardRequest {
  readonly askWakeId: string;
  readonly seatSessionId: string;
  readonly requestId: string;
  readonly pendingId: string;
  readonly requestedBy: string;
  readonly scopeKey: string;
  readonly requestedAt: string;
}

export interface ConnectorCardRun<T> {
  readonly approved: AuditWireEntry;
  readonly opApproved: AuditWireEntry;
  readonly decisionWakeId: string;
  readonly write: AuditWireEntry;
  readonly reply: AuditWireEntry;
  readonly replyShape: "post" | "edit";
  readonly candidate: T;
}

export interface ConnectorCardCandidate {
  readonly id: string;
  readonly editedTs?: string;
}

function s(row: AuditWireEntry, key: string): string | undefined {
  const value = row.detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ms(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : Number.NaN;
}

function after(row: AuditWireEntry, floorIso: string): boolean {
  return ms(row.ts) > ms(floorIso);
}

export function connectorCardRequest(
  rows: readonly AuditWireEntry[],
  input: { readonly anchor: SuspendedMessageAnchor; readonly requester: string },
): ConnectorCardRequest | undefined {
  const ingress = rows.filter(
    (row) =>
      row.action === "wake.ingress" &&
      row.platform === input.anchor.platform &&
      s(row, "surfaceKey") === input.anchor.surfaceKey &&
      s(row, "vendorTs") === input.anchor.vendorTs,
  );
  const wakeIds = [...new Set(ingress.map((row) => s(row, "wakeId")).filter((id): id is string => id !== undefined))];
  if (wakeIds.length !== 1) return undefined;
  const askWakeId = wakeIds[0]!;

  const sessions = [
    ...new Set(rows.filter((row) => row.action === "wake.turn_start" && s(row, "wakeId") === askWakeId).map((row) => s(row, "sessionId"))),
  ];
  if (sessions.length !== 1 || sessions[0] === undefined) return undefined;
  const seatSessionId = sessions[0];

  const forwards = rows.filter((row) => row.action === "work.forwarded" && s(row, "wakeId") === askWakeId);
  const requestIds = [...new Set(forwards.map((row) => s(row, "requestId")).filter((id): id is string => id !== undefined))];
  if (requestIds.length !== 1) return undefined;
  const forwardedAt = forwards.map((row) => row.ts).sort()[0]!;

  const cards = rows.filter(
    (row) =>
      row.action === "approval.requested" &&
      s(row, "kind") === CONNECTOR_CARD_KIND &&
      s(row, "scopeKey") === input.anchor.surfaceKey &&
      row.principalId === input.requester &&
      ms(row.ts) >= ms(forwardedAt),
  );
  const ids = [...new Set(cards.map((row) => s(row, "id")).filter((id): id is string => id !== undefined))];
  if (ids.length !== 1) return undefined;
  const card = cards.find((row) => s(row, "id") === ids[0])!;
  return {
    askWakeId,
    seatSessionId,
    requestId: requestIds[0]!,
    pendingId: ids[0]!,
    requestedBy: input.requester,
    scopeKey: input.anchor.surfaceKey,
    requestedAt: card.ts,
  };
}

const FRESH_WORK_RUNTIME: readonly string[] = ["minted", "rotated", "current"];

export function forwardedWorkSessionStale(
  rows: readonly AuditWireEntry[],
  anchor: SuspendedMessageAnchor,
): { readonly stale: false; readonly verdict: string } | { readonly stale: true; readonly why: string } | undefined {
  const wakeIds = [
    ...new Set(
      rows
        .filter((row) => row.action === "wake.ingress" && row.platform === anchor.platform && s(row, "surfaceKey") === anchor.surfaceKey && s(row, "vendorTs") === anchor.vendorTs)
        .map((row) => s(row, "wakeId"))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  if (wakeIds.length !== 1) return undefined;
  const forwards = rows.filter((row) => row.action === "work.forwarded" && s(row, "wakeId") === wakeIds[0]);
  const requestIds = new Set(forwards.map((row) => s(row, "requestId")).filter((id) => id !== undefined));
  if (requestIds.size !== 1) return undefined;
  const verdicts = [...new Set(forwards.map((row) => s(row, "workRuntime") ?? "absent"))];
  const fresh = verdicts.find((v) => FRESH_WORK_RUNTIME.includes(v));
  if (fresh !== undefined) return { stale: false, verdict: fresh };
  const workToken = forwards.map((row) => s(row, "workToken")).find((t) => t !== undefined) ?? "unknown";
  return {
    stale: true,
    why:
      verdicts.includes("unchecked")
        ? `the forward of request ${[...requestIds][0]} reached work session ${workToken}, and the host could not compare its code with this deployment's (workRuntime "unchecked")`
        : `the forward of request ${[...requestIds][0]} reached work session ${workToken} and recorded no runtime verdict, so the deployment that handled it predates OPE-2377 and that work session can run an older build`,
  };
}

export function completedConnectorWrites(rows: readonly AuditWireEntry[], surface: string): readonly AuditWireEntry[] {
  return rows.filter(
    (row) =>
      row.action === "connector.op" &&
      row.surface === surface &&
      (s(row, "opTier") === "write" || s(row, "opTier") === "destructive") &&
      s(row, "status") !== "error" &&
      row.detail?.isError !== true,
  );
}

export function connectorCardRun<T extends ConnectorCardCandidate>(
  rows: readonly AuditWireEntry[],
  input: {
    readonly request: ConnectorCardRequest;
    readonly clicker: string;
    readonly surface: string;
    readonly replyPlatform: string;
    readonly candidates: readonly T[];
  },
): ConnectorCardRun<T> | undefined {
  const { request } = input;
  const approvedRows = rows.filter((row) => row.action === "approval.approved" && s(row, "id") === request.pendingId);
  if (approvedRows.length !== 1 || approvedRows[0]!.principalId !== input.clicker) return undefined;
  const approved = approvedRows[0]!;
  if (rows.some((row) => row.action === "approval.rejected" && s(row, "id") === request.pendingId)) return undefined;

  const opApproved = rows.find(
    (row) =>
      row.action === "connector.op_approved" &&
      row.principalId === input.clicker &&
      s(row, "requestedBy") === request.requestedBy &&
      Math.abs(ms(row.ts) - ms(approved.ts)) <= 60_000,
  );
  if (!opApproved) return undefined;

  const decision = rows.filter(
    (row) => row.action === "approval.decision_wake" && s(row, "id") === request.pendingId && s(row, "outcome") === "approved" && row.detail?.delivered === true,
  );
  if (decision.length !== 1) return undefined;
  const decisionWakeId = s(decision[0]!, "wakeId");
  if (!decisionWakeId) return undefined;

  const writes = completedConnectorWrites(rows, input.surface);
  if (writes.some((row) => ms(row.ts) >= ms(request.requestedAt) && ms(row.ts) < ms(approved.ts))) return undefined;
  const write = writes.filter((row) => after(row, approved.ts)).sort((a, b) => ms(a.ts) - ms(b.ts))[0];
  if (!write) return undefined;

  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate] as const));
  const seatRow = (row: AuditWireEntry, action: string): boolean =>
    row.action === action && s(row, "platform") === input.replyPlatform && s(row, "sessionId") === request.seatSessionId;
  const seatPostIds = new Set(rows.filter((row) => seatRow(row, "reply.post")).map((row) => s(row, "id")));
  const posts = rows.filter(
    (row) => seatRow(row, "reply.post") && row.detail?.done !== false && after(row, write.ts) && byId.has(s(row, "id") ?? ""),
  );
  const edits = rows.filter((row) => {
    if (!seatRow(row, "reply.edit") || !after(row, write.ts)) return false;
    const id = s(row, "id");
    if (id === undefined || !seatPostIds.has(id)) return false;
    const editedSec = Number.parseFloat(byId.get(id)?.editedTs ?? "");
    return Number.isFinite(editedSec) && editedSec * 1000 >= ms(write.ts);
  });
  const reply = [...posts, ...edits].sort((a, b) => ms(a.ts) - ms(b.ts))[0];
  if (!reply) return undefined;
  return {
    approved,
    opApproved,
    decisionWakeId,
    write,
    reply,
    replyShape: reply.action === "reply.edit" ? "edit" : "post",
    candidate: byId.get(s(reply, "id")!)!,
  };
}
