import type { RequestApprovalInput } from "../approvals/flow.js";
import {
  ROUTINE_PERMISSION_KIND,
  routinePermissionCardLines,
  type RoutinePermissionArgs,
} from "../approvals/routine-permission.js";
import { routinePermissionAskedMemo, routinePermissionDeclinedMemo } from "../approvals/session-grant.js";
import type { RoutineCardProbe } from "./permission-card-wait.js";
import { ROUTINE_GRANT_NO_EXPIRY } from "./grants.js";
import { getOperationalStore } from "../operational/provider.js";
import type { PendingActionRow } from "../approvals/types.js";
import { resolveMessagePermalink } from "../channels/surface-message-ops.js";
import { listAllRoutines, getRoutine } from "./store.js";
import { isSilentRoutine, routineReportSurfaceKey, type Routine } from "./routine.js";
import { routineGrantKeyParts } from "./grant-key.js";
import { resolveRoutineTarget } from "../schedules/routine-dispatch.js";

export type RoutinePermissionCardState = "declined" | "live" | "lapsed" | "unreadable" | "absent" | "n/a";

export { routineGrantKeyParts };

export function declarableRoutinePermission(actionKind: string): { grantKind: string; declaration: string } | undefined {
  return actionKind === "pr.open" ? { grantKind: "pr.open", declaration: "pr.open" } : undefined;
}

export interface RoutinePermissionCardRead {
  readonly state: RoutinePermissionCardState;
  readonly cardId?: string;
}

export async function readRoutinePermissionCardState(
  org: string,
  grantKey: string,
  grantKind: string,
  nowIso: string,
): Promise<RoutinePermissionCardRead> {
  const store = getOperationalStore();
  let asked: unknown;
  try {
    const declined = await store.getSessionApproval(org, grantKey, routinePermissionDeclinedMemo(grantKind), nowIso);
    if (declined) return { state: "declined" };
    asked = await store.getSessionApproval(org, grantKey, routinePermissionAskedMemo(grantKind), nowIso);
  } catch {
    return { state: "n/a" };
  }
  if (!asked) return { state: "absent" };
  const probe = await probeRoutinePermissionCard(org, grantKey, grantKind);
  if (!probe.read) return { state: "unreadable" };
  return probe.cardId === undefined ? { state: "lapsed" } : { state: "live", cardId: probe.cardId };
}

export interface RoutinePermissionOffer {
  readonly org: string;
  readonly actionKind: string;
  readonly grantKey: string;
  readonly scopeKey: string;
  readonly domain?: string | null;
  readonly requestedBy: string;
  readonly tainted: boolean;
  readonly nowIso: string;
}

export interface RoutinePermissionPlan {
  readonly state: RoutinePermissionCardState;
  readonly card?: RequestApprovalInput;
  readonly cardId?: string;
  readonly platform?: string;
  readonly askedMemoKind?: string;
  readonly grantKind?: string;
}

async function routineForGrantKey(org: string, scopeKey: string, routineId: string): Promise<Routine | null> {
  const keyed = await getRoutine(org, scopeKey, routineId).catch(() => null);
  if (keyed) return keyed;
  const all = await listAllRoutines().catch(() => [] as Routine[]);
  return all.find((r) => r.org === org && r.id === routineId) ?? null;
}

export async function planRoutinePermissionCard(offer: RoutinePermissionOffer): Promise<RoutinePermissionPlan> {
  try {
    if (offer.tainted) return { state: "n/a" };
    const declarable = declarableRoutinePermission(offer.actionKind);
    if (!declarable) return { state: "n/a" };
    const parts = routineGrantKeyParts(offer.grantKey);
    if (!parts) return { state: "n/a" };

    const read = await readRoutinePermissionCardState(offer.org, offer.grantKey, declarable.grantKind, offer.nowIso);
    if (read.state !== "absent" && read.state !== "lapsed") {
      return { state: read.state, grantKind: declarable.grantKind, ...(read.cardId !== undefined ? { cardId: read.cardId } : {}) };
    }

    const routine = await routineForGrantKey(offer.org, offer.scopeKey, parts.routineId);
    if (!routine) return { state: "n/a" };
    if (isSilentRoutine(routine)) return { state: "n/a" };
    const dest = resolveRoutineTarget(routine);
    const channelId = readChannelId(dest?.target);
    const surfaceKey = routineReportSurfaceKey(routine);
    const platform = surfaceKey.split("/")[0];
    if (!dest || channelId === undefined || platform === undefined || platform.length === 0) return { state: "n/a" };

    const args: RoutinePermissionArgs = {
      org: offer.org,
      scopeKey: offer.scopeKey,
      grantKey: offer.grantKey,
      routineId: routine.id,
      routineSurfaceKey: routine.surfaceKey,
      grantKind: declarable.grantKind,
      declaration: declarable.declaration,
      prompt: routine.prompt,
    };
    return {
      state: read.state,
      platform,
      grantKind: declarable.grantKind,
      askedMemoKind: routinePermissionAskedMemo(declarable.grantKind),
      card: {
        org: offer.org,
        kind: ROUTINE_PERMISSION_KIND,
        args,
        scopeKey: offer.scopeKey,
        domain: offer.domain ?? null,
        requestedBy: offer.requestedBy,
        channelId,
        threadTs: null,
        postedTo: surfaceKey,
        summaryLines: routinePermissionCardLines(args),
        noClockExpiry: true,
      },
    };
  } catch {
    return { state: "n/a" };
  }
}

function readChannelId(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const id = (target as { channelId?: unknown }).channelId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function probeRoutinePermissionCard(
  org: string,
  grantKey: string,
  grantKind: string,
): Promise<{ read: boolean; cardId?: string }> {
  let rows: readonly PendingActionRow[];
  try {
    rows = await getOperationalStore().listPendingActions(org);
  } catch {
    return { read: false };
  }
  for (const row of rows) {
    if (row.kind !== ROUTINE_PERMISSION_KIND) continue;
    let args: Partial<RoutinePermissionArgs> | null;
    try {
      args = JSON.parse(row.argsJson) as Partial<RoutinePermissionArgs> | null;
    } catch {
      return { read: false };
    }
    if (args?.grantKey === grantKey && args.grantKind === grantKind) return { read: true, cardId: row.id };
  }
  return { read: true };
}

export interface RoutineCardPointer {
  readonly permalink?: string;
  readonly room?: string;
}

export async function routinePermissionCardPointer(org: string, cardId: string): Promise<RoutineCardPointer> {
  try {
    const row = await getOperationalStore().getPendingAction(org, cardId);
    if (!row || row.postedTo === null) return {};
    const room = row.postedTo;
    if (row.messageTs === null) return { room };
    const [platform, workspace] = room.split("/");
    if (platform === undefined || platform.length === 0) return { room };
    const permalink = await resolveMessagePermalink(platform, {
      channelId: row.channelId,
      messageId: row.messageTs,
      ...(workspace !== undefined && workspace.length > 0 ? { workspace } : {}),
    });
    return { room, ...(permalink !== undefined && permalink.length > 0 ? { permalink } : {}) };
  } catch {
    return {};
  }
}

export async function routineCardProbe(org: string, cardId: string, grantKey: string, grantKind: string): Promise<RoutineCardProbe> {
  const store = getOperationalStore();
  const row = await store.getPendingAction(org, cardId);
  if (!row) return { status: "gone", armed: false };
  if (row.status !== "approved") return { status: row.status, armed: false };
  const grant = await store.getSessionApproval(org, grantKey, grantKind, new Date().toISOString());
  return { status: "approved", armed: grant !== null };
}

export async function routineCardGrantedBy(org: string, grantKey: string, grantKind: string): Promise<string | undefined> {
  const grant = await getOperationalStore()
    .getSessionApproval(org, grantKey, grantKind, new Date().toISOString())
    .catch(() => null);
  return grant?.grantedBy;
}

export async function markRoutinePermissionAsked(
  org: string,
  grantKey: string,
  askedMemoKind: string,
  askedBy: string,
  nowIso: string,
): Promise<void> {
  await getOperationalStore()
    .setSessionApproval({
      org,
      sessionId: grantKey,
      kind: askedMemoKind,
      grantedBy: askedBy,
      createdAt: nowIso,
      expiresAt: ROUTINE_GRANT_NO_EXPIRY,
    })
    .catch(() => undefined);
}

export function routinePermissionRefusalClause(state: RoutinePermissionCardState, posted: boolean, permalink?: string): string {
  const at = permalink !== undefined && permalink.length > 0 ? `: ${permalink}` : "";
  switch (state) {
    case "declined":
      return " A person already declined this permission for this routine, so no card was posted — it will not be asked again until the routine's instruction is edited.";
    case "live":
      return ` A permission card for this is already waiting in the routine's own room; nobody has decided it yet${at}.`;
    case "unreadable":
      return " This routine has already asked for this permission. Whether its card is still waiting in the routine's own room could not be read just now.";
    case "absent":
    case "lapsed":
      return posted
        ? ` A permission card for this is now waiting in the routine's own room — approving it lets future runs do this without asking${at}.`
        : "";
    default:
      return "";
  }
}
