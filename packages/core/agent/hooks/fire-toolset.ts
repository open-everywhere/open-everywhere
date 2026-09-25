import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import { isScheduleOriginatedAuth, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { permissionKindsUnderKey } from "../routines/declared-permissions.js";
import { routineMarker, routinePermissionKeyStamped } from "../routines/routine.js";
import {
  candidateConnectionsForDeclarations,
  declaredConnectorToolNames,
  projectDeclaredConnectorOps,
  ROUTINE_DECLARED_OPS_MOUNTED_ACTION,
  type ConnectionCatalogue,
} from "../routines/fire-toolset.js";

const EVE_CONTEXT_STORAGE = Symbol.for("eve.context-storage");

export const CONNECTION_REGISTRY_KEY_NAME = "eve.connectionRegistry";

export const CONNECTION_SEARCH_RESULTS_KEY_NAME = "eve.connectionSearchResults";

interface EveContextContainer {
  get(key: { readonly name: string }): unknown;
  set(key: { readonly name: string }, value: unknown): unknown;
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
    return typeof container.get === "function" && typeof container.set === "function" ? (store as EveContextContainer) : undefined;
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

function projectedRows(container: EveContextContainer): readonly unknown[] {
  const value = container.get({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME });
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function projectedNames(rows: readonly unknown[]): string[] {
  return rows.flatMap((row) => {
    const name = row !== null && typeof row === "object" ? (row as { qualifiedName?: unknown }).qualifiedName : undefined;
    return typeof name === "string" && name.length > 0 ? [name] : [];
  });
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
      const row = entry as { name?: unknown; description?: unknown; inputSchema?: unknown; outputSchema?: unknown };
      if (typeof row.name !== "string" || row.name.length === 0) return [];
      return [
        {
          name: row.name,
          description: typeof row.description === "string" ? row.description : "",
          ...(row.inputSchema !== undefined ? { inputSchema: row.inputSchema } : {}),
          ...(row.outputSchema !== undefined ? { outputSchema: row.outputSchema } : {}),
        },
      ];
    });
    return { connection, ops };
  } catch {
    return { connection, ops: [] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DeclaredOpMountOutcome {
  readonly org: string;
  readonly mounted: readonly string[];
  readonly unresolved: readonly string[];
}

export async function mountDeclaredOps(ctx: HookContext, budgetMs: number = CATALOGUE_READ_BUDGET_MS): Promise<DeclaredOpMountOutcome | undefined> {
  if (isSubagentChildContext(ctx as unknown as BindableContext)) return undefined;
  const slots = ctx as unknown as {
    readonly session?: { readonly auth?: { readonly current?: unknown; readonly initiator?: unknown } | null };
  };
  const auth = (slots.session?.auth?.current ?? slots.session?.auth?.initiator ?? null) as
    | { authenticator?: unknown; principalId?: unknown; principalType?: unknown; attributes?: Record<string, string | readonly string[]> }
    | null;
  if (!isScheduleOriginatedAuth(auth)) return undefined;
  const permissionKey = routinePermissionKeyStamped(auth?.attributes);
  if (permissionKey === undefined) return undefined;

  const org = orgOf(ctx, auth?.attributes);
  const declared = declaredConnectorToolNames(await permissionKindsUnderKey(org, permissionKey, new Date().toISOString()));
  if (declared.length === 0) return undefined;

  const container = eveContext();
  if (container === undefined) return undefined;
  const registry = connectionRegistry(container);
  if (registry === undefined) return undefined;

  const candidates = candidateConnectionsForDeclarations(declared, registry.getConnectionNames());
  if (candidates.length === 0) return { org, mounted: [], unresolved: declared };
  const catalogues = await Promise.all(candidates.map((connection) => readCatalogue(registry, connection, budgetMs)));

  const already = projectedRows(container);
  const projection = projectDeclaredConnectorOps({ declared, catalogues, alreadyProjected: projectedNames(already) });
  if (projection.mount.length > 0) {
    container.set({ name: CONNECTION_SEARCH_RESULTS_KEY_NAME }, [...already, ...projection.mount]);
  }
  return { org, mounted: projection.mount.map((row) => row.qualifiedName), unresolved: projection.unresolved };
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

const auditedMount = defineState<{ key?: string }>("open-everywhere.fire-declared-ops-audited", () => ({}));

async function auditMount(ctx: HookContext, org: string, outcome: DeclaredOpMountOutcome): Promise<void> {
  if (outcome.mounted.length === 0 && outcome.unresolved.length === 0) return;
  const key = JSON.stringify([outcome.mounted, outcome.unresolved]);
  try {
    if (auditedMount.get().key === key) return;
    auditedMount.update(() => ({ key }));
  } catch {
  }
  try {
    const p = resolvePartition(ctx as unknown as BindableContext);
    await appendAudit({
      org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      action: ROUTINE_DECLARED_OPS_MOUNTED_ACTION,
      detail: {
        mounted: outcome.mounted,
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
        const outcome = await mountDeclaredOps(ctx);
        if (outcome !== undefined) await auditMount(ctx, outcome.org, outcome);
      } catch {
      }
    },
  },
});
