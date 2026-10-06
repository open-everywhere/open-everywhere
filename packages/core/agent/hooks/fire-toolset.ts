import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import { isScheduleOriginatedAuth, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { jobFireStamped } from "../access/job-posture.js";
import { resolvePartition } from "../memory/partition.js";
import { permissionKindsUnderKey } from "../routines/declared-permissions.js";
import { routineMarker, routinePermissionKeyStamped } from "../routines/routine.js";
import {
  candidateConnectionsForDeclarations,
  declaredConnectorToolNames,
  resolveDeclaredConnectorOps,
  ROUTINE_DECLARED_OPS_RESOLVED_ACTION,
  type ConnectionCatalogue,
  type DeclaredConnectorOp,
} from "../routines/fire-toolset.js";

const EVE_CONTEXT_STORAGE = Symbol.for("eve.context-storage");

export const CONNECTION_REGISTRY_KEY_NAME = "eve.connectionRegistry";

interface EveContextContainer {
  get(key: { readonly name: string }): unknown;
}

interface EveConnectionRegistry {
  getConnectionNames(): readonly string[];
  getClient(connectionName: string): { getToolMetadata(): Promise<readonly unknown[]> };
}

function eveContext(): EveContextContainer | undefined {
  try {
    const storage = (globalThis as Record<symbol, unknown>)[EVE_CONTEXT_STORAGE] as
      | { getStore?: () => unknown }
      | undefined;
    const store = storage?.getStore?.();
    if (store === null || typeof store !== "object") return undefined;
    const container = store as Partial<EveContextContainer>;
    return typeof container.get === "function" ? (store as EveContextContainer) : undefined;
  } catch {
    return undefined;
  }
}

function connectionRegistry(container: EveContextContainer): EveConnectionRegistry | undefined {
  const value = container.get({ name: CONNECTION_REGISTRY_KEY_NAME });
  if (value === null || typeof value !== "object") return undefined;
  const registry = value as Partial<EveConnectionRegistry>;
  return typeof registry.getConnectionNames === "function" && typeof registry.getClient === "function"
    ? (value as EveConnectionRegistry)
    : undefined;
}

const declaredOpsSlot = defineState<{ ops?: readonly DeclaredConnectorOp[] }>("open-everywhere.fire-declared-ops", () => ({}));

export function declaredOpsForReach(): readonly DeclaredConnectorOp[] {
  try {
    return declaredOpsSlot.get().ops ?? [];
  } catch {
    return [];
  }
}

function keepDeclaredOps(ops: readonly DeclaredConnectorOp[]): void {
  try {
    declaredOpsSlot.update(() => ({ ops }));
  } catch {
  }
}

export const CATALOGUE_READ_BUDGET_MS = 3_000;

async function readCatalogue(
  registry: EveConnectionRegistry,
  connection: string,
  budgetMs: number = CATALOGUE_READ_BUDGET_MS,
): Promise<ConnectionCatalogue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const metadata = await Promise.race([
      registry.getClient(connection).getToolMetadata(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
      }),
    ]);
    if (!Array.isArray(metadata)) return { connection, ops: [] };
    const ops = metadata.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const name = (entry as { name?: unknown }).name;
      return typeof name === "string" && name.length > 0 ? [{ name }] : [];
    });
    return { connection, ops };
  } catch {
    return { connection, ops: [] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DeclaredOpResolutionOutcome {
  readonly org: string;
  readonly resolved: readonly string[];
  readonly unresolved: readonly string[];
}

export async function resolveDeclaredOps(ctx: HookContext, budgetMs: number = CATALOGUE_READ_BUDGET_MS): Promise<DeclaredOpResolutionOutcome | undefined> {
  if (isSubagentChildContext(ctx as unknown as BindableContext)) return undefined;
  const slots = ctx as unknown as {
    readonly session?: { readonly auth?: { readonly current?: unknown; readonly initiator?: unknown } | null };
  };
  const auth = (slots.session?.auth?.current ?? slots.session?.auth?.initiator ?? null) as
    | { authenticator?: unknown; principalId?: unknown; principalType?: unknown; attributes?: Record<string, string | readonly string[]> }
    | null;
  if (!isScheduleOriginatedAuth(auth)) return undefined;
  if (jobFireStamped(auth?.attributes ?? {})) return undefined;
  const permissionKey = routinePermissionKeyStamped(auth?.attributes);
  if (permissionKey === undefined) return undefined;

  const org = orgOf(ctx, auth?.attributes);
  const declared = declaredConnectorToolNames(await permissionKindsUnderKey(org, permissionKey, new Date().toISOString()));
  const held = declaredOpsForReach();
  const kept = held.filter((op) => declared.includes(op.qualifiedName));
  if (kept.length !== held.length) keepDeclaredOps(kept);
  if (declared.length === 0) return undefined;

  const container = eveContext();
  if (container === undefined) return undefined;
  const registry = connectionRegistry(container);
  if (registry === undefined) return undefined;

  const already = kept.map((op) => op.qualifiedName);
  const pending = declared.filter((name) => !already.includes(name));
  const candidates = candidateConnectionsForDeclarations(pending, registry.getConnectionNames());
  const catalogues = await Promise.all(candidates.map((connection) => readCatalogue(registry, connection, budgetMs)));
  const resolution = resolveDeclaredConnectorOps({ declared, catalogues, alreadyResolved: already });
  keepDeclaredOps([...kept, ...resolution.resolved]);
  return { org, resolved: resolution.resolved.map((op) => op.qualifiedName), unresolved: resolution.unresolved };
}

function orgOf(ctx: HookContext, attributes: Readonly<Record<string, string | readonly string[]>> | undefined): string {
  const marker = routineMarker(attributes);
  if (marker !== null) return marker.org;
  try {
    return resolvePartition(ctx as unknown as BindableContext).org;
  } catch {
    return "default";
  }
}

const auditedResolution = defineState<{ key?: string }>("open-everywhere.fire-declared-ops-audited", () => ({}));

async function auditResolution(ctx: HookContext, org: string, outcome: DeclaredOpResolutionOutcome): Promise<void> {
  if (outcome.resolved.length === 0 && outcome.unresolved.length === 0) return;
  const key = JSON.stringify([declaredOpsForReach().map((op) => op.qualifiedName), outcome.unresolved]);
  try {
    if (auditedResolution.get().key === key) return;
    auditedResolution.update(() => ({ key }));
  } catch {
  }
  try {
    const p = resolvePartition(ctx as unknown as BindableContext);
    await appendAudit({
      org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      action: ROUTINE_DECLARED_OPS_RESOLVED_ACTION,
      detail: {
        resolved: outcome.resolved,
        ...(outcome.unresolved.length > 0 ? { unresolved: outcome.unresolved } : {}),
      },
    });
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      try {
        const outcome = await resolveDeclaredOps(ctx);
        if (outcome !== undefined) await auditResolution(ctx, outcome.org, outcome);
      } catch {
      }
    },
  },
});
