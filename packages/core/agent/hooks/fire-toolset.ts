import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeFrom, isScheduleOriginatedAuth, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { isWorkSessionChildContext } from "../access/work-session.js";
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
import { optional } from "./control-refusal.js";
import { listMountedConnector, mountedConnectorNames } from "../connections/connector-catalogue.js";

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

/**
 * One connection's ops, from the OE connector catalogue (`connections/connector-catalogue.ts`).
 * On eve 1.x a connection is an OE connector mount, so eve's connection registry is empty: the
 * mount's memoised listing (or a live one, inside the budget) is the catalogue.
 */
async function readCatalogue(connection: string, ctx: unknown, budgetMs: number = CATALOGUE_READ_BUDGET_MS): Promise<ConnectionCatalogue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listed = await Promise.race([
      listMountedConnector(connection, ctx),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
      }),
    ]);
    if (listed === undefined) return { connection, ops: [] };
    return { connection, ops: listed.filter((op) => op.name.length > 0).map((op) => ({ name: op.name })) };
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
  const bindable = ctx as unknown as BindableContext;
  const forwardedFireChild = isWorkSessionChildContext(bindable);
  if (!forwardedFireChild && isSubagentChildContext(bindable)) return undefined;
  const slots = ctx as unknown as {
    readonly session?: { readonly auth?: { readonly current?: unknown; readonly initiator?: unknown } | null };
  };
  const auth = (slots.session?.auth?.current ?? slots.session?.auth?.initiator ?? null) as
    | { authenticator?: unknown; principalId?: unknown; principalType?: unknown; attributes?: Record<string, string | readonly string[]> }
    | null;
  const fireTurn = forwardedFireChild ? routineMarker(auth?.attributes) !== null : isScheduleOriginatedAuth(auth);
  if (!fireTurn) {
    if (declaredOpsForReach().length > 0) keepDeclaredOps([]);
    return undefined;
  }
  if (jobFireStamped(auth?.attributes ?? {})) return undefined;
  const permissionKey = routinePermissionKeyStamped(auth?.attributes);
  if (permissionKey === undefined) return undefined;

  const org = orgOf(ctx, auth?.attributes);
  const declared = declaredConnectorToolNames(await permissionKindsUnderKey(org, permissionKey, new Date().toISOString()));
  const held = declaredOpsForReach();
  const kept = held.filter((op) => declared.includes(op.qualifiedName));
  if (kept.length !== held.length) keepDeclaredOps(kept);
  if (declared.length === 0) return undefined;

  const already = kept.map((op) => op.qualifiedName);
  const pending = declared.filter((name) => !already.includes(name));
  const candidates = candidateConnectionsForDeclarations(pending, mountedConnectorNames());
  const catalogues = await Promise.all(candidates.map((connection) => readCatalogue(connection, ctx, budgetMs)));
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
      ...auditSurfaceModeFrom(ctx as unknown as BindableContext),
      action: ROUTINE_DECLARED_OPS_RESOLVED_ACTION,
      detail: {
        resolved: outcome.resolved,
        ...(outcome.unresolved.length > 0 ? { unresolved: outcome.unresolved } : {}),
      },
    });
  } catch {
  }
}

// The access instructions read the slot this hook writes (`declaredOpsForReach`). That works only
// because eve runs the `turn.started` hooks to completion before it builds the step's instructions;
// `test:fire-reach-hook-order` is the tripwire on that order.
export default defineHook({
  events: {
    "turn.started": optional("fire-toolset", async (_event, ctx) => {
      const outcome = await resolveDeclaredOps(ctx);
      if (outcome !== undefined) await auditResolution(ctx, outcome.org, outcome);
    }),
  },
});
