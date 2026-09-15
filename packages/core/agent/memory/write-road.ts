import { appendAudit } from "../audit/audit.js";
import { noteDurableMemoryWrite } from "./write-evidence.js";
import type { MemoryAccess, MemoryProvider } from "./provider.js";
import type { MemorySilo } from "./silo.js";
import type { Partition } from "./partition.js";
import { tierId, type MemoryFiles, type Tier } from "./store.js";

export type MemoryWriteRoad =
  | "session-persist"
  | "control-edit"
  | "status-board"
  | "onboarding-marker"
  | "pinned-instructions"
  | "dream-learn"
  | "dream-tidy"
  | "purge";

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
  readonly platform?: string;
  readonly workspace?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface MemoryWriteResult {
  readonly version: string | null;
  readonly changed: boolean;
}

const CANONICAL_DETAIL_KEYS: ReadonlySet<string> = new Set(["road", "kind", "tier", "silo", "provider", "files", "version"]);

export async function writeMemoryTier(req: MemoryWriteRequest): Promise<MemoryWriteResult> {
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

  return { version, changed: true };
}
