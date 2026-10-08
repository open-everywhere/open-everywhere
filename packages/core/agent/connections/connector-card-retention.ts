import { connectorArgsWithoutInput, connectorCardCall, CONNECTOR_OP_CARD_KIND } from "../approvals/connector-op-offer.js";
import type { PendingActionRow } from "../approvals/types.js";
import type { OperationalStore } from "../operational/store.js";

export type ConnectorCardRetentionStore = Pick<OperationalStore, "getPendingAction" | "rewriteDecidedPendingActionArgs" | "listDecidedPendingActionsWithArg">;

async function clearRow(store: ConnectorCardRetentionStore, org: string, row: PendingActionRow): Promise<boolean> {
  if (row.kind !== CONNECTOR_OP_CARD_KIND || row.status === "pending") return false;
  if (connectorCardCall(row.argsJson)?.input === undefined) return false;
  const next = JSON.stringify(connectorArgsWithoutInput(JSON.parse(row.argsJson) as object));
  return store.rewriteDecidedPendingActionArgs(org, row.id, next);
}

async function softly<T>(fn: () => Promise<T>, fallback: T, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[open-everywhere:connector] ${what}: ${String(err)}`);
    return fallback;
  }
}

export async function clearConnectorCardInput(store: ConnectorCardRetentionStore, org: string, cardId: string): Promise<boolean> {
  return softly(
    async () => {
      const row = await store.getPendingAction(org, cardId);
      return row === null ? false : clearRow(store, org, row);
    },
    false,
    `could not clear card ${cardId}'s stored input`,
  );
}

export async function clearSpentConnectorCards(store: ConnectorCardRetentionStore, org: string, sessionKey: string, memoKind: string, nowIso: string): Promise<number> {
  return softly(
    async () => {
      let cleared = 0;
      for (const row of await store.listDecidedPendingActionsWithArg(org, CONNECTOR_OP_CARD_KIND, "input")) {
        if (row.status !== "approved" || row.decidedAt === null || row.decidedAt > nowIso) continue;
        const call = connectorCardCall(row.argsJson);
        if (call?.sessionKey !== sessionKey || call.memoKind !== memoKind) continue;
        if (await clearRow(store, org, row)) cleared++;
      }
      return cleared;
    },
    0,
    "could not clear the stored input of a spent card",
  );
}

export async function sweepConnectorCardInputs(store: ConnectorCardRetentionStore, org: string, now: Date, lapseAfterMs: number): Promise<number> {
  return softly(
    async () => {
      const lapsedBefore = new Date(now.getTime() - lapseAfterMs).toISOString();
      let cleared = 0;
      for (const row of await store.listDecidedPendingActionsWithArg(org, CONNECTOR_OP_CARD_KIND, "input")) {
        const closed = row.status === "rejected" || row.status === "expired";
        const lapsed = row.status === "approved" && row.decidedAt !== null && row.decidedAt < lapsedBefore;
        if (!closed && !lapsed) continue;
        if (await softly(() => clearRow(store, org, row), false, `could not clear card ${row.id}'s stored input`)) cleared++;
      }
      return cleared;
    },
    0,
    "the stored-input sweep failed",
  );
}
