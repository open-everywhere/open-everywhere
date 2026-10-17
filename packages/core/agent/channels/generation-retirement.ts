import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { isUnifiedSupervisorToken } from "./unified-supervisor.js";
import { bareTokenFromEveContext } from "./window-key.js";

export const GENERATION_RETIRED_AUDIT_ACTION = "session.generation_retired";

export const GENERATION_RETIRE_SKIPPED_AUDIT_ACTION = "session.generation_retire_skipped";

export const GENERATION_RETIREMENT_PRINCIPAL = "oe:rotation";

export const GENERATION_RETIREMENT_REASON = "open-everywhere: the seat rotated to a fresh generation";

export const MAX_PENDING = 64;

export interface PendingGenerationRetirement {
  readonly org: string;
  readonly registryKey: string;
  readonly token: string;
}

let pending: PendingGenerationRetirement[] = [];

export function noteGenerationForRetirement(input: { readonly org: string; readonly registryKey: string; readonly token: string }): void {
  const token = bareTokenFromEveContext(input.token) ?? input.token;
  if (!isUnifiedSupervisorToken(token)) return;
  if (pending.some((p) => p.org === input.org && p.token === token)) return;
  pending.push({ org: input.org, registryKey: input.registryKey, token });
  if (pending.length > MAX_PENDING) pending = pending.slice(pending.length - MAX_PENDING);
}

export function takeGenerationsForRetirement(org: string): readonly PendingGenerationRetirement[] {
  const mine = pending.filter((p) => p.org === org);
  if (mine.length > 0) pending = pending.filter((p) => p.org !== org);
  return mine;
}

export function __pendingGenerationRetirementsForTest(): readonly PendingGenerationRetirement[] {
  return [...pending];
}

export function __resetGenerationRetirementsForTest(): void {
  pending = [];
}

function generationOwesKey(token: string): string {
  return `oe-gen-owes:${token}`;
}

function taskGenerationKey(taskId: string): string {
  return `oe-task-gen:${taskId}`;
}

export const GENERATION_DELEGATION_TTL_MS = 6 * 60 * 60 * 1000;

export const MAX_GENERATION_DELEGATIONS = 32;

function readOwedTasks(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown } | null;
    const tasks = parsed?.tasks;
    if (!Array.isArray(tasks)) return [];
    return tasks.filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch {
    return [];
  }
}

export type DelegationLedgerStore = Pick<OperationalStore, "getTaskResult" | "putTaskResult" | "deleteTaskResult">;

export async function noteGenerationDelegation(
  org: string,
  windowToken: string | undefined,
  taskId: string,
  store?: DelegationLedgerStore,
): Promise<void> {
  try {
    if (windowToken === undefined || taskId.length === 0) return;
    const token = bareTokenFromEveContext(windowToken) ?? windowToken;
    if (!isUnifiedSupervisorToken(token)) return;
    const s = store ?? getOperationalStore();
    const at = new Date().toISOString();
    const owed = readOwedTasks(await s.getTaskResult(org, generationOwesKey(token)));
    if (!owed.includes(taskId)) {
      if (owed.length >= MAX_GENERATION_DELEGATIONS) return;
      await s.putTaskResult(org, generationOwesKey(token), JSON.stringify({ tasks: [...owed, taskId] }), at, GENERATION_DELEGATION_TTL_MS);
    }
    await s.putTaskResult(org, taskGenerationKey(taskId), JSON.stringify({ token }), at, GENERATION_DELEGATION_TTL_MS);
  } catch (err) {
    console.warn(`[open-everywhere:generation-retirement] could not record the owed delegation ${taskId}: ${String(err)}`);
  }
}

export async function clearGenerationDelegation(org: string, taskId: string, store?: DelegationLedgerStore): Promise<void> {
  try {
    if (taskId.length === 0) return;
    const s = store ?? getOperationalStore();
    const raw = await s.getTaskResult(org, taskGenerationKey(taskId));
    if (raw === null) return;
    const token = (JSON.parse(raw) as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.length === 0) return;
    const owed = readOwedTasks(await s.getTaskResult(org, generationOwesKey(token)));
    if (owed.includes(taskId)) {
      const next = owed.filter((t) => t !== taskId);
      const at = new Date().toISOString();
      if (next.length === 0) await s.deleteTaskResult(org, generationOwesKey(token));
      else await s.putTaskResult(org, generationOwesKey(token), JSON.stringify({ tasks: next }), at, GENERATION_DELEGATION_TTL_MS);
    }
    await s.deleteTaskResult(org, taskGenerationKey(taskId));
  } catch (err) {
    console.warn(`[open-everywhere:generation-retirement] could not clear the owed delegation ${taskId}: ${String(err)}`);
  }
}

export async function generationOwedDelegation(
  org: string,
  token: string,
  store?: Pick<OperationalStore, "getTaskResult">,
): Promise<"owed" | "none" | "unreadable"> {
  try {
    const s = store ?? getOperationalStore();
    return readOwedTasks(await s.getTaskResult(org, generationOwesKey(token))).length > 0 ? "owed" : "none";
  } catch (err) {
    console.warn(`[open-everywhere:generation-retirement] owed-delegation row unreadable for ${token}: ${String(err)} — not retiring`);
    return "unreadable";
  }
}

export async function generationOwedTaskIds(org: string, token: string, store?: Pick<OperationalStore, "getTaskResult">): Promise<readonly string[]> {
  try {
    return readOwedTasks(await (store ?? getOperationalStore()).getTaskResult(org, generationOwesKey(token)));
  } catch {
    return [];
  }
}

export async function generationOfTask(org: string, taskId: string, store?: Pick<OperationalStore, "getTaskResult">): Promise<string | undefined> {
  try {
    const raw = await (store ?? getOperationalStore()).getTaskResult(org, taskGenerationKey(taskId));
    if (raw === null) return undefined;
    const token = (JSON.parse(raw) as { token?: unknown } | null)?.token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export type RetirementVerdict = "retire" | "skip-incoming" | "skip-still-live" | "skip-live-turn" | "skip-owed-delegation" | "skip-unreadable";

export function retirementVerdict(input: {
  readonly token: string;
  readonly incomingToken: string;
  readonly registry: "rotated" | "still-live" | "unreadable";
  readonly turn: "live" | "none" | "unreadable";
  readonly delegation: "owed" | "none" | "unreadable";
}): RetirementVerdict {
  if (input.token === input.incomingToken) return "skip-incoming";
  if (input.registry === "unreadable" || input.turn === "unreadable" || input.delegation === "unreadable") return "skip-unreadable";
  if (input.registry === "still-live") return "skip-still-live";
  if (input.turn === "live") return "skip-live-turn";
  if (input.delegation === "owed") return "skip-owed-delegation";
  return "retire";
}

export interface RetirementSource {
  reset(options?: { readonly reason?: string }): Promise<{ readonly status?: string } | undefined>;
}

export const RESET_STATUS_RETIRED = "reset";

export type RetirementFrom = (address: string) => RetirementSource;

export interface RetirementDeps {
  readonly store?: Pick<OperationalStore, "getChannelSession" | "getTurnAnchorByWindow" | "getTaskResult">;
  readonly labelsFor: (token: string) => { readonly workspace: string; readonly surface: string | undefined };
  readonly confirmTimeoutMs?: number;
}

async function withConfirmTimeout(
  reset: Promise<{ readonly status?: string } | undefined>,
  ms: number,
): Promise<{ confirmed: boolean; status?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const confirmed = reset.then((r) => ({ confirmed: true, ...(r?.status !== undefined ? { status: r.status } : {}) }));
  try {
    return await Promise.race([
      confirmed,
      new Promise<{ confirmed: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ confirmed: false }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const UNIFIED_TOKEN_PREFIX = "unified:";

const RETIREMENT_CONFIRM_TIMEOUT_MS = 5_000;

async function registryState(
  store: Pick<OperationalStore, "getChannelSession">,
  org: string,
  registryKey: string,
  token: string,
): Promise<"rotated" | "still-live" | "unreadable"> {
  try {
    const row = await store.getChannelSession(org, registryKey);
    return row?.token === token ? "still-live" : "rotated";
  } catch (err) {
    console.warn(`[open-everywhere:generation-retirement] registry row unreadable for ${registryKey}: ${String(err)} — not retiring`);
    return "unreadable";
  }
}

async function turnState(
  store: Pick<OperationalStore, "getTurnAnchorByWindow">,
  org: string,
  token: string,
): Promise<"live" | "none" | "unreadable"> {
  try {
    for (const key of [token, `${UNIFIED_TOKEN_PREFIX}${token}`]) {
      if (await store.getTurnAnchorByWindow(org, key)) return "live";
    }
    return "none";
  } catch (err) {
    console.warn(`[open-everywhere:generation-retirement] turn anchor unreadable for ${token}: ${String(err)} — not retiring`);
    return "unreadable";
  }
}

export async function drainGenerationRetirements(
  from: RetirementFrom,
  input: { readonly org: string; readonly incomingToken: string },
  deps: RetirementDeps,
): Promise<void> {
  const taken = takeGenerationsForRetirement(input.org);
  if (taken.length === 0) return;
  const store = deps.store ?? getOperationalStore();
  const incoming = bareTokenFromEveContext(input.incomingToken) ?? input.incomingToken;
  const deadline = Date.now() + (deps.confirmTimeoutMs ?? RETIREMENT_CONFIRM_TIMEOUT_MS);
  for (const p of taken) {
    const registry = p.token === incoming ? "rotated" : await registryState(store, input.org, p.registryKey, p.token);
    const turn = p.token === incoming ? "none" : await turnState(store, input.org, p.token);
    const delegation = p.token === incoming ? "none" : await generationOwedDelegation(input.org, p.token, store);
    const verdict = retirementVerdict({ token: p.token, incomingToken: incoming, registry, turn, delegation });
    if (verdict !== "retire") {
      await auditRetirement(p, deps, GENERATION_RETIRE_SKIPPED_AUDIT_ACTION, { skipped: verdict });
      continue;
    }
    try {
      const outcome = await withConfirmTimeout(from(p.token).reset({ reason: GENERATION_RETIREMENT_REASON }), Math.max(0, deadline - Date.now()));
      if (outcome.confirmed === false) {
        await auditRetirement(p, deps, GENERATION_RETIRE_SKIPPED_AUDIT_ACTION, { skipped: "reset-unconfirmed" });
      } else if (outcome.status === RESET_STATUS_RETIRED) {
        await auditRetirement(p, deps, GENERATION_RETIRED_AUDIT_ACTION, {});
      } else {
        await auditRetirement(p, deps, GENERATION_RETIRE_SKIPPED_AUDIT_ACTION, { skipped: "no-active-session", status: outcome.status ?? "" });
      }
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      console.warn(`[open-everywhere:generation-retirement] reset refused for ${p.token}: ${error} — the generation's workers stay parked`);
      await auditRetirement(p, deps, GENERATION_RETIRE_SKIPPED_AUDIT_ACTION, { skipped: "reset-failed", error });
    }
  }
}

async function auditRetirement(
  p: PendingGenerationRetirement,
  deps: RetirementDeps,
  action: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const { workspace, surface } = deps.labelsFor(p.token);
  await appendAudit({
    org: p.org,
    platform: "unified",
    workspace,
    ...(surface !== undefined ? { surface } : {}),
    principalId: GENERATION_RETIREMENT_PRINCIPAL,
    action,
    detail: { registryKey: p.registryKey, token: p.token, ...extra },
  }).catch(() => undefined);
}
