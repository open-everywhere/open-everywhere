import { appendAudit } from "../audit/audit.js";
import { auditPersonOptOutRefusal, OPT_OUT_MEMORY_ROADS, readPersonOptOut, type PersonOptOutState } from "../identity/person-opt-out.js";
import { noteDurableMemoryWrite } from "./write-evidence.js";
import type { MemoryAccess, MemoryProvider } from "./provider.js";
import type { MemorySilo } from "./silo.js";
import type { Partition } from "./partition.js";
import { tierId, type MemoryFiles, type Tier } from "./store.js";
import type { SessionMode } from "../access/resolver.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export type MemoryWriteRoad =
  | "session-persist"
  | "control-edit"
  | "status-board"
  | "onboarding-marker"
  | "pinned-instructions"
  | "dream-learn"
  | "dream-tidy"
  | "purge"
  | "self-edit";

export type MemoryWriteKind = "memory" | "operational";

export const MEMORY_WRITE_ACTION = "memory.write";

const MEMORY_OPERATIONAL_WRITE_ACTION = "memory.operational_write";

export interface MemoryWriteRequest {
  readonly provider: MemoryProvider;
  readonly partition: Partition;
  readonly tier: Tier;
  readonly files: MemoryFiles;
  readonly message: string;
  readonly silo?: MemorySilo;
  readonly access?: MemoryAccess;
  readonly road: MemoryWriteRoad;
  readonly kind?: MemoryWriteKind;
  readonly turnId?: string;
  readonly principalId?: string;
  readonly surfaceMode?: SessionMode;
  readonly platform?: string;
  readonly workspace?: string;
  readonly extra?: AuditDetail;
  readonly personOptOut?: PersonOptOutState;
}

export interface MemoryWriteResult {
  readonly version: string | null;
  readonly changed: boolean;
  readonly refused?: "person-opt-out";
}

const CANONICAL_DETAIL_KEYS: ReadonlySet<string> = new Set(["road", "kind", "tier", "silo", "provider", "files", "version"]);

export async function writeMemoryTier(req: MemoryWriteRequest): Promise<MemoryWriteResult> {
  if (await refusedByPersonOptOut(req)) return { version: null, changed: false, refused: "person-opt-out" };
  const version = await req.provider.writeTier(req.partition, req.tier, req.files, req.message, req.silo, req.access);
  if (version === null) return { version: null, changed: false };

  const kind: MemoryWriteKind = req.kind ?? "memory";
  noteDurableMemoryWrite(req.turnId, {
    kind,
    road: req.road,
    ...(req.silo?.name !== undefined ? { silo: req.silo.name } : {}),
    version,
  });

  const extra = Object.fromEntries(Object.entries(req.extra ?? {}).filter(([k]) => !CANONICAL_DETAIL_KEYS.has(k)));
  await appendAudit({
    org: req.partition.org,
    platform: req.platform ?? req.partition.platform,
    workspace: req.workspace ?? req.partition.workspace,
    surface: req.partition.surface,
    ...(req.surfaceMode === undefined ? {} : { surfaceMode: req.surfaceMode }),
    principalId: req.principalId,
    action: kind === "operational" ? MEMORY_OPERATIONAL_WRITE_ACTION : MEMORY_WRITE_ACTION,
    detail: {
      road: req.road,
      kind,
      tier: tierId(req.tier),
      ...(req.silo?.name !== undefined ? { silo: req.silo.name } : {}),
      ...(req.silo?.provider !== undefined ? { provider: req.silo.provider } : { provider: req.provider.id }),
      files: Object.keys(req.files).length,
      version,
      ...extra,
    },
  }).catch(() => undefined);

  if (kind === "memory" && req.tier.kind === "silo") await notifyMemoryWriteObservers({ org: req.partition.org, silo: req.tier.name });

  return { version, changed: true };
}

async function refusedByPersonOptOut(req: MemoryWriteRequest): Promise<boolean> {
  if ((req.kind ?? "memory") !== "memory" || !req.principalId) return false;
  if (OPT_OUT_MEMORY_ROADS[req.road] !== "refuse") return false;
  const state = req.personOptOut ?? (await readPersonOptOut(req.partition.org, req.principalId));
  if (!state.optedOut) return false;
  console.log(
    `[open-everywhere:memory] ${req.road} write to ${tierId(req.tier)} refused — the person it is attributed to opted out` +
      `${state.readable ? "" : " (the opt-out store did not answer; fail-closed)"}`,
  );
  await auditPersonOptOutRefusal(
    {
      org: req.partition.org,
      platform: req.partition.platform,
      workspace: req.partition.workspace,
      surface: req.partition.surface,
      ...(req.surfaceMode === undefined ? {} : { surfaceMode: req.surfaceMode }),
      principalKey: req.principalId,
    },
    "memory-write",
    {
      road: req.road,
      tier: tierId(req.tier),
      ...(req.silo?.name !== undefined ? { silo: req.silo.name } : {}),
      storeReadable: state.readable,
    },
  );
  return true;
}

export interface MemoryWriteEvent {
  readonly org: string;
  readonly silo: string;
}

export type MemoryWriteObserver = (event: MemoryWriteEvent) => Promise<void>;

const MEMORY_WRITE_OBSERVER_BUDGET_MS = 1_500;
let observerBudgetMs = MEMORY_WRITE_OBSERVER_BUDGET_MS;

export function _setMemoryWriteObserverBudgetMsForTest(ms?: number): void {
  observerBudgetMs = ms ?? MEMORY_WRITE_OBSERVER_BUDGET_MS;
}

const observers = new Map<string, MemoryWriteObserver>();

export function registerMemoryWriteObserver(name: string, observer: MemoryWriteObserver): void {
  observers.set(name, observer);
}

export function _resetMemoryWriteObservers(): void {
  observers.clear();
}

async function notifyMemoryWriteObservers(event: MemoryWriteEvent): Promise<void> {
  if (observers.size === 0) return;
  const runs = [...observers.entries()].map(([name, observer]) =>
    Promise.resolve()
      .then(() => observer(event))
      .catch((err) => console.log(`[open-everywhere:memory] write observer "${name}" failed for silo "${event.silo}": ${String(err)}`)),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.log(`[open-everywhere:memory] write observers for silo "${event.silo}" passed the ${observerBudgetMs} ms budget; the write returns without them`);
      resolve();
    }, observerBudgetMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all(runs).then(() => undefined), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
