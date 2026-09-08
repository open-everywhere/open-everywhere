import { deploymentOrg } from "../identity/deployment-org.js";
import { getOperationalStore } from "../operational/provider.js";

const TURN_STATE_PREFIX = "oe-turn-state:";

export const TURN_STATE_TTL_MS = 6 * 60 * 60 * 1000;

export const TURN_STATE_STORE_DEADLINE_MS = 500;

const TIMED_OUT: unique symbol = Symbol("turn-state-store-deadline");

async function withStoreDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), TURN_STATE_STORE_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DurableCloseout {
  readonly count: number;
  readonly reason: string;
  readonly reported: boolean;
}

export interface TurnState {
  readonly steps: number;
  readonly closeout?: DurableCloseout;
  readonly stoppedAck?: true;
}

export const EMPTY_TURN_STATE: TurnState = { steps: 0 };

export function turnPairKey(sessionId: string | undefined, turnId: string): string {
  return sessionId !== undefined ? `${sessionId}:${turnId}` : turnId;
}

export function durableTurnKey(sessionId: string | undefined, turnId: string): string | undefined {
  return sessionId === undefined || sessionId.length === 0 ? undefined : turnPairKey(sessionId, turnId);
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
  const stoppedAck = row.stoppedAck === true ? ({ stoppedAck: true } as const) : undefined;
  const closeoutRaw = row.closeout;
  if (typeof closeoutRaw !== "object" || closeoutRaw === null) return { steps, ...stoppedAck };
  const closeout = closeoutRaw as Record<string, unknown>;
  const count = numberField(closeout, "count");
  const reason = closeout.reason;
  if (count === undefined || count === 0 || typeof reason !== "string" || reason.length === 0) return { steps, ...stoppedAck };
  return { steps, ...stoppedAck, closeout: { count, reason, reported: closeout.reported === true } };
}

export async function readTurnState(pair: string): Promise<TurnState | undefined> {
  try {
    const raw = await withStoreDeadline<string | null | typeof TIMED_OUT>(
      getOperationalStore().getTaskResult(deploymentOrg(), turnStateRowKey(pair)),
      TIMED_OUT,
    );
    return raw === TIMED_OUT ? undefined : parseTurnState(raw);
  } catch {
    return undefined;
  }
}

export async function writeTurnState(pair: string, state: TurnState): Promise<void> {
  try {
    await withStoreDeadline(
      getOperationalStore().putTaskResult(
        deploymentOrg(),
        turnStateRowKey(pair),
        JSON.stringify(state),
        new Date().toISOString(),
        TURN_STATE_TTL_MS,
      ),
      undefined,
    );
  } catch {
  }
}

export async function noteStoppedAck(pair: string): Promise<void> {
  const state = await readTurnState(pair);
  if (state === undefined) return;
  await writeTurnState(pair, { ...state, stoppedAck: true });
}

export async function stoppedAckSpent(pair: string): Promise<boolean> {
  return (await readTurnState(pair))?.stoppedAck === true;
}

export async function deleteTurnState(pair: string): Promise<void> {
  try {
    await withStoreDeadline(getOperationalStore().deleteTaskResult(deploymentOrg(), turnStateRowKey(pair)), undefined);
  } catch {
  }
}
