import { deploymentOrg } from "../identity/deployment-org.js";
import { getOperationalStore } from "../operational/provider.js";

const TURN_STATE_PREFIX = "oe-turn-state:";

export const TURN_STATE_TTL_MS = 6 * 60 * 60 * 1000;

export interface DurableCloseout {
  readonly count: number;
  readonly reason: string;
  readonly reported: boolean;
}

export interface TurnState {
  readonly steps: number;
  readonly closeout?: DurableCloseout;
}

export const EMPTY_TURN_STATE: TurnState = { steps: 0 };

export function turnPairKey(sessionId: string | undefined, turnId: string): string {
  return sessionId !== undefined ? `${sessionId}:${turnId}` : turnId;
}

export function turnStateRowKey(pair: string): string {
  return `${TURN_STATE_PREFIX}${pair}`;
}

function numberField(row: Record<string, unknown>, name: string): number | undefined {
  const value = row[name];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function parseTurnState(raw: string | null): TurnState | undefined {
  if (raw === null) return EMPTY_TURN_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const row = parsed as Record<string, unknown>;
  const steps = numberField(row, "steps");
  if (steps === undefined) return undefined;
  const closeoutRaw = row.closeout;
  if (typeof closeoutRaw !== "object" || closeoutRaw === null) return { steps };
  const closeout = closeoutRaw as Record<string, unknown>;
  const count = numberField(closeout, "count");
  const reason = closeout.reason;
  if (count === undefined || count === 0 || typeof reason !== "string" || reason.length === 0) return { steps };
  return { steps, closeout: { count, reason, reported: closeout.reported === true } };
}

export async function readTurnState(pair: string): Promise<TurnState | undefined> {
  try {
    return parseTurnState(await getOperationalStore().getTaskResult(deploymentOrg(), turnStateRowKey(pair)));
  } catch {
    return undefined;
  }
}

export async function writeTurnState(pair: string, state: TurnState): Promise<void> {
  try {
    await getOperationalStore().putTaskResult(
      deploymentOrg(),
      turnStateRowKey(pair),
      JSON.stringify(state),
      new Date().toISOString(),
      TURN_STATE_TTL_MS,
    );
  } catch {
  }
}

export async function deleteTurnState(pair: string): Promise<void> {
  try {
    await getOperationalStore().deleteTaskResult(deploymentOrg(), turnStateRowKey(pair));
  } catch {
  }
}
