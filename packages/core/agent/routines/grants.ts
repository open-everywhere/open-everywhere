import { getOperationalStore } from "../operational/provider.js";
import { classifyConnectorOpTier } from "../access/consequence.js";
import { describeGrantKind, isLegacyConnectorGrantKind, isRoutinePermissionMemoKind, routinePermissionKind } from "../approvals/session-grant.js";
import { routineGrantKey, type Routine } from "./routine.js";

type GrantedRoutine = Pick<Routine, "id" | "promptGeneration">;

export const ROUTINE_GRANT_NO_EXPIRY = "9999-12-31T23:59:59.999Z";

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
      throw new Error(
        `"${d}" is not a declarable routine permission. The whole vocabulary is: "pr.open" (open pull requests) and "tool:<connector tool>" — one row per TOOL, named exactly as the tool is called, e.g. "tool:notion__share_page". A connector slug on its own ("tool:notion") names no tool and is refused. Anything else — deletes included — is never declarable up front and always asks a human when it fires.`,
      );
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
  return classifyConnectorOpTier(declaredToolName(trimmed)) === "destructive";
}

function armablePermissionKinds(declared: readonly string[]): string[] {
  const kinds: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    const kind = routinePermissionKind(trimmed);
    if (kind === null || namesUnliftableTool(trimmed)) continue;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

export function unarmedDeclarations(declared: readonly string[], granted: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of declared) {
    const trimmed = d.trim();
    const kind = routinePermissionKind(trimmed);
    const armed = kind !== null && !namesUnliftableTool(trimmed) && granted.includes(kind);
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
          : describeGrantKind(kind);
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

export async function grantDeclaredRoutinePermissions(input: {
  readonly org: string;
  readonly routine: GrantedRoutine;
  readonly declared: readonly string[];
  readonly grantedBy: string;
  readonly tainted: boolean;
  readonly nowIso: string;
}): Promise<string[]> {
  if (input.tainted || input.declared.length === 0) return [];
  const store = getOperationalStore();
  const sessionId = routineGrantKey(input.routine);
  const written: string[] = [];
  for (const kind of armablePermissionKinds(input.declared)) {
    const done = await store
      .setSessionApproval({
        org: input.org,
        sessionId,
        kind,
        grantedBy: input.grantedBy,
        createdAt: input.nowIso,
        expiresAt: ROUTINE_GRANT_NO_EXPIRY,
      })
      .then(() => true)
      .catch(() => false);
    if (done) written.push(kind);
  }
  return written;
}

async function liveGrantKinds(org: string, routine: GrantedRoutine, nowIso: string): Promise<string[]> {
  const rows = await getOperationalStore()
    .listSessionApprovals(org, routineGrantKey(routine), nowIso)
    .catch(() => []);
  return rows.map((r) => r.kind).filter((k) => !isRoutinePermissionMemoKind(k) && !isLegacyConnectorGrantKind(k));
}

export async function listRoutinePermissions(org: string, routine: GrantedRoutine, nowIso: string): Promise<string[]> {
  return (await liveGrantKinds(org, routine, nowIso)).map(describeGrantKind);
}

export async function revokeRoutinePermissions(
  org: string,
  routine: GrantedRoutine,
): Promise<{ grants: number; rows: number }> {
  const grants = (await liveGrantKinds(org, routine, new Date().toISOString())).length;
  const rows = await getOperationalStore().revokeSessionApprovals(org, routineGrantKey(routine));
  return { grants, rows };
}

export async function sweepLegacyConnectorGrants(org: string): Promise<number> {
  return await getOperationalStore().sweepLegacyConnectorGrants(org);
}
