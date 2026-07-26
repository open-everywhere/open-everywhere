import { getOperationalStore } from "../operational/provider.js";
import { describeGrantKind, routinePermissionKind } from "../approvals/session-grant.js";
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
    const kind = routinePermissionKind(d.trim());
    if (!kind) {
      throw new Error(
        `"${d}" is not a declarable routine permission. The whole vocabulary is: "pr.open" (open pull requests) and "connector:<slug>" (write to that connector, e.g. "connector:notion"). Anything else — deletes included — is never grantable up front and always asks a human when it fires.`,
      );
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

export function describeDeclaredPermissions(declared: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of declared) {
    const kind = routinePermissionKind(d.trim());
    if (kind && !out.includes(describeGrantKind(kind))) out.push(describeGrantKind(kind));
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
  for (const kind of declaredPermissionKinds(input.declared)) {
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

export async function listRoutinePermissions(org: string, routine: GrantedRoutine, nowIso: string): Promise<string[]> {
  const rows = await getOperationalStore()
    .listSessionApprovals(org, routineGrantKey(routine), nowIso)
    .catch(() => []);
  return rows.map((r) => describeGrantKind(r.kind));
}

export async function revokeRoutinePermissions(org: string, routine: GrantedRoutine): Promise<number> {
  return getOperationalStore().revokeSessionApprovals(org, routineGrantKey(routine));
}
