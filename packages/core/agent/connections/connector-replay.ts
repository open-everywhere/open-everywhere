import { registerConnectorReplayResolver, registerConnectorReplaySettler } from "../access/connection-execute-target.js";
import { clearConnectorCardInput, type ConnectorCardRetentionStore } from "./connector-card-retention.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import { CONNECTOR_REPLAY_ADMISSION_TTL_MS, connectorReplayAdmissionKey, readConnectorReplayCardId, storedConnectorCall } from "../approvals/connector-op-offer.js";

export interface ConnectorReplayDeps {
  readonly store?: Pick<ReturnType<typeof getOperationalStore>, "hasEventSeen" | "getPendingAction">;
}

function refused(why: string): Error {
  return new Error(`The replay of an approved card was refused, because ${why}. Nothing ran.`);
}

export async function resolveConnectorReplayInput(callId: unknown, executeInput: unknown, deps: ConnectorReplayDeps = {}): Promise<Record<string, unknown>> {
  const call = executeInput as Record<string, unknown>;
  const cardId = readConnectorReplayCardId(call["input"]);
  if (cardId === undefined) throw refused("the input is not a well-formed replay");
  if (typeof callId !== "string" || callId.length === 0) throw refused("the call has no call id");
  const store = deps.store ?? getOperationalStore();
  const org = deploymentOrg();
  const nowIso = new Date().toISOString();
  const admitted = await store.hasEventSeen(org, connectorReplayAdmissionKey(cardId, callId), nowIso, CONNECTOR_REPLAY_ADMISSION_TTL_MS).catch(() => false);
  if (!admitted) throw refused(`the approval check did not admit this call for card ${cardId}`);
  const row = await store.getPendingAction(org, cardId).catch(() => null);
  const stored = row === null ? undefined : storedConnectorCall(row.argsJson);
  if (stored === undefined) throw refused(`card ${cardId} stores no input`);
  if (`${String(call["connection"])}__${String(call["tool"])}` !== stored.tool) throw refused(`card ${cardId} approves another op`);
  return { ...call, input: JSON.parse(JSON.stringify(stored.input)) as Record<string, unknown> };
}

export async function settleConnectorReplayCall(executeInput: unknown, deps: { readonly store?: ConnectorCardRetentionStore } = {}): Promise<void> {
  const cardId = readConnectorReplayCardId((executeInput as Record<string, unknown> | null)?.["input"]);
  if (cardId === undefined) return;
  await clearConnectorCardInput(deps.store ?? getOperationalStore(), deploymentOrg(), cardId);
}

registerConnectorReplayResolver((callId, executeInput) => resolveConnectorReplayInput(callId, executeInput));
registerConnectorReplaySettler((executeInput) => settleConnectorReplayCall(executeInput));
