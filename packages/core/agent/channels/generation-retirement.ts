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

export type RetirementVerdict = "retire" | "skip-incoming" | "skip-still-live" | "skip-live-turn" | "skip-unreadable";

export function retirementVerdict(input: {
  readonly token: string;
  readonly incomingToken: string;
  readonly registry: "rotated" | "still-live" | "unreadable";
  readonly turn: "live" | "none" | "unreadable";
}): RetirementVerdict {
  if (input.token === input.incomingToken) return "skip-incoming";
  if (input.registry === "unreadable" || input.turn === "unreadable") return "skip-unreadable";
  if (input.registry === "still-live") return "skip-still-live";
  if (input.turn === "live") return "skip-live-turn";
  return "retire";
}

export interface RetirementSource {
  reset(options?: { readonly reason?: string }): Promise<{ readonly status?: string } | undefined>;
}

export const RESET_STATUS_RETIRED = "reset";

export type RetirementFrom = (address: string) => RetirementSource;

export interface RetirementDeps {
  readonly store?: Pick<OperationalStore, "getChannelSession" | "getTurnAnchorByWindow">;
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

export const RETIREMENT_CONFIRM_TIMEOUT_MS = 5_000;

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
    const verdict = retirementVerdict({ token: p.token, incomingToken: incoming, registry, turn });
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
