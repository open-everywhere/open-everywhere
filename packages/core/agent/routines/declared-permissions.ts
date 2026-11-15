import { getOperationalStore } from "../operational/provider.js";
import { classifyConnectorOpTier } from "../access/consequence.js";
import { connectorOpTierParts } from "../access/connector-op-gating.js";
import { neverTierDefaultMatch, neverTierMatch } from "../access/never-tier.js";
import {
  ROUTINE_PERMISSION_NO_EXPIRY,
  describeDeclaredPermissionKind,
  isLegacyConnectorOpKind,
  isRoutinePermissionMemoKind,
  routinePermissionKind,
  routinePermissionRefusal,
} from "../approvals/session-grant.js";
import { routinePermissionKey, type Routine } from "./routine.js";

type PermissionedRoutine = Pick<Routine, "id" | "promptGeneration">;

export { ROUTINE_PERMISSION_NO_EXPIRY };

export const MAX_DECLARED_PERMISSIONS = 6;

export function declaredPermissionKinds(declared: readonly string[]): string[] {
  if (declared.length > MAX_DECLARED_PERMISSIONS) {
    throw new Error(
      `A routine may declare at most ${MAX_DECLARED_PERMISSIONS} standing permissions (got ${declared.length}) — declare only what it certainly needs; anything else asks a human when it fires.`,
    );
  }
  const kinds: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    const kind = routinePermissionKind(trimmed);
    if (!kind) {
      const why = routinePermissionRefusal(trimmed);
      throw new Error(
        `"${d}" is not a declarable routine permission${why ? ` — ${why}` : ""}. The whole vocabulary is: "pr.open" (open pull requests) and "tool:<connector tool>" — one row per TOOL, named exactly as the tool is called, e.g. "tool:notion__share_page". A connector slug on its own ("tool:notion") names no tool and is refused. Anything else — deletes included — is never declarable up front and always asks a human when it fires.`,
      );
    }
    const never = namesNeverTierTool(trimmed);
    if (never !== undefined) {
      throw new Error(`"${d}" names a tool that is never allowed: ${never}. No declaration, card or approval can run it, so a routine cannot either.`);
    }
    if (namesUnliftableTool(trimmed)) {
      throw new Error(
        `"${d}" names a tool the fence will never lift, so declaring it would put a promise on the arming card that the runtime does not keep. A DELETE-tier verb refuses on every unattended fire whatever is declared. So does a verb the tier classifier does not recognise, which fails closed to the delete tier — if this op really is an ordinary write, its verb has to be a recognised one (access/consequence.ts CONNECTOR_WRITE_VERBS). Have the routine ask a person for that step.`,
      );
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

const PR_OPEN_DECLARATION = "pr.open";

function declaredToolName(declared: string): string {
  return declared.slice("tool:".length);
}

export function namesUnliftableTool(trimmed: string): boolean {
  if (trimmed === PR_OPEN_DECLARATION) return false;
  const tool = declaredToolName(trimmed);
  return classifyConnectorOpTier(tool) === "destructive" || neverTierDefaultMatch(tool) !== undefined;
}

function namesNeverTierTool(trimmed: string): string | undefined {
  if (trimmed === PR_OPEN_DECLARATION) return undefined;
  const rule = neverTierDefaultMatch(declaredToolName(trimmed));
  return rule === undefined ? undefined : `it ${rule.label} (rule "${rule.id}")`;
}

export function namesBundleRaisedTool(trimmed: string): boolean {
  if (trimmed === PR_OPEN_DECLARATION) return false;
  const tool = declaredToolName(trimmed);
  if (classifyConnectorOpTier(tool) === "destructive" || neverTierDefaultMatch(tool) !== undefined) return false;
  try {
    return connectorOpTierParts(tool).declared === "destructive" || neverTierMatch(tool)?.source === "config";
  } catch {
    return false;
  }
}

function armablePermissionKinds(declared: readonly string[]): string[] {
  const kinds: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    const kind = routinePermissionKind(trimmed);
    if (kind === null || namesUnliftableTool(trimmed) || namesBundleRaisedTool(trimmed)) continue;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

export const ROUTINE_PERMISSION_NEVER_LIFTS_ACTION = "routine.permission_never_lifts";

export const ROUTINE_PERMISSIONS_ARMED_ACTION = "routine.grant";
export const ROUTINE_PERMISSIONS_REVOKED_ACTION = "routine.grants_revoked";

export function unarmedDeclarations(declared: readonly string[], granted: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    const kind = routinePermissionKind(trimmed);
    const armed = kind !== null && !namesUnliftableTool(trimmed) && !namesBundleRaisedTool(trimmed) && granted.includes(kind);
    if (!armed && !out.includes(d)) out.push(d);
  }
  return out;
}

export function describeDeclaredPermissions(declared: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    const kind = routinePermissionKind(trimmed);
    const line =
      kind === null
        ? `unrecognised declaration: "${trimmed}" (grants nothing)`
        : namesUnliftableTool(trimmed)
          ? `the "${declaredToolName(trimmed)}" tool, never lifted on an unattended fire (grants nothing)`
          : namesBundleRaisedTool(trimmed)
            ? `the "${declaredToolName(trimmed)}" tool, which this deployment's bundle configuration raises to the delete tier or the never tier — the fence refuses it on every unattended fire (grants nothing here)`
            : describeDeclaredPermissionKind(kind);
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

export async function armDeclaredRoutinePermissions(input: {
  readonly org: string;
  readonly routine: PermissionedRoutine;
  readonly declared: readonly string[];
  readonly grantedBy: string;
  readonly tainted?: boolean;
  readonly nowIso: string;
}): Promise<string[]> {
  if (input.declared.length === 0) return [];
  const store = getOperationalStore();
  const sessionId = routinePermissionKey(input.routine);
  const written: string[] = [];
  for (const kind of armablePermissionKinds(input.declared)) {
    const done = await store
      .setSessionApproval({
        org: input.org,
        sessionId,
        kind,
        grantedBy: input.grantedBy,
        createdAt: input.nowIso,
        expiresAt: ROUTINE_PERMISSION_NO_EXPIRY,
      })
      .then(() => true)
      .catch(() => false);
    if (done) written.push(kind);
  }
  return written;
}

export function bundleRaisedDeclarations(declared: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    if (routinePermissionKind(trimmed) === null || !namesBundleRaisedTool(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function declaredStandingWrites(declared: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    if (routinePermissionKind(trimmed) === null) continue;
    if (trimmed === PR_OPEN_DECLARATION) {
      if (!out.includes(trimmed)) out.push(trimmed);
      continue;
    }
    const tool = declaredToolName(trimmed);
    let write: boolean;
    try {
      write = classifyConnectorOpTier(tool) !== "read" || connectorOpTierParts(tool).tier !== "read";
    } catch {
      write = true;
    }
    if (write && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

async function livePermissionKinds(org: string, routine: PermissionedRoutine, nowIso: string): Promise<string[]> {
  return await permissionKindsUnderKey(org, routinePermissionKey(routine), nowIso);
}

export async function permissionKindsUnderKey(org: string, permissionKey: string, nowIso: string): Promise<string[]> {
  const rows = await getOperationalStore().listSessionApprovals(org, permissionKey, nowIso).catch(() => []);
  return rows.map((r) => r.kind).filter((k) => !isRoutinePermissionMemoKind(k) && !isLegacyConnectorOpKind(k));
}

export async function routinePermissionKinds(org: string, routine: PermissionedRoutine, nowIso: string): Promise<string[]> {
  return await livePermissionKinds(org, routine, nowIso);
}

export async function listRoutinePermissions(org: string, routine: PermissionedRoutine, nowIso: string): Promise<string[]> {
  return (await livePermissionKinds(org, routine, nowIso)).map(describeDeclaredPermissionKind);
}

export async function revokeRoutinePermissions(
  org: string,
  routine: PermissionedRoutine,
): Promise<{ permissions: number; rows: number }> {
  const permissions = (await livePermissionKinds(org, routine, new Date().toISOString())).length;
  const rows = await getOperationalStore().revokeSessionApprovals(org, routinePermissionKey(routine));
  return { permissions, rows };
}

export async function sweepLegacyConnectorOpRows(org: string): Promise<number> {
  return await getOperationalStore().sweepLegacyConnectorOpRows(org);
}
