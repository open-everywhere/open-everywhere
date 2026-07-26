process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import {
  ROUTINE_GRANT_PREFIX,
  ROUTINE_MARKER,
  nextPromptGeneration,
  routineGrantGeneration,
  routineGrantKey,
  routineGrantKeyStamped,
  type Routine,
} from "../agent/routines/routine.js";
import {
  MAX_DECLARED_PERMISSIONS,
  ROUTINE_GRANT_NO_EXPIRY,
  declaredPermissionKinds,
  describeDeclaredPermissions,
  grantDeclaredRoutinePermissions,
  listRoutinePermissions,
  revokeRoutinePermissions,
} from "../agent/routines/grants.js";
import { connectorSessionKind, describeGrantKind, grantButtonLabel, grantLifetime, routinePermissionKind, sessionGrantKind } from "../agent/approvals/session-grant.js";
import { permissionLines } from "../agent/approvals/routine-create.js";
import { routineFireAttributes } from "../agent/routines/fire-auth.js";
import { proposingSessionId } from "../agent/identity/binding.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { addRoutine, getRoutine } from "../agent/routines/store.js";
import type { Partition } from "../agent/memory/partition.js";
import { surfaceExecutorApproval, type ExecutorApprovalContext } from "../agent/connections/executor-approval-bridge.js";
import { requestApproval } from "../agent/approvals/flow.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function throwsAsync(fn: () => unknown, label: string): Promise<string> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (e) {
    msg = String(e);
  }
  ok(msg !== null, label);
  return msg ?? "";
}

const ORG = "default";
const ROUTINE: Routine = {
  id: "r-1a2b3c4d",
  org: ORG,
  surfaceKey: "slack/T1/C1",
  trigger: { kind: "cron", expr: "0 3 * * *" },
  prompt: "read the triage queue and comment on each new ticket",
  createdAt: "2026-07-26T00:00:00.000Z",
  status: "active",
  consecutiveFailures: 0,
};
const NOW = "2026-03-30T11:30:00.000Z";

{
  const key = routineGrantKey(ROUTINE);
  ok(key.startsWith(ROUTINE_GRANT_PREFIX), "a routine grant key carries the routine namespace");
  ok(key === `${ROUTINE_GRANT_PREFIX}${ROUTINE.id}:g1`, "an un-edited routine keys on generation 1");
  ok(routineGrantKey({ ...ROUTINE, promptGeneration: 4 }) === `${ROUTINE_GRANT_PREFIX}${ROUTINE.id}:g4`, "the key embeds the live generation");
  for (const g of [0, -3, 1.5, Number.NaN] as number[]) {
    ok(routineGrantGeneration({ promptGeneration: g }) === 1, `generation ${g} reads as 1`);
  }
  let r: Pick<Routine, "promptGeneration"> = {};
  const seen = new Set<number>();
  for (let i = 0; i < 5; i++) {
    const next = nextPromptGeneration(r);
    ok(next > routineGrantGeneration(r) && !seen.has(next), "each edit moves strictly forward to an unused generation");
    seen.add(next);
    r = { promptGeneration: next };
  }
  ok(grantLifetime(routineGrantKey(ROUTINE)) === "routine", "session-grant.ts recognises a real routine key as standing");
  ok(grantLifetime("oe-dom:eng:win:slack/T1/C1:oe-sup:g1") === "session", "a window token is NOT read as a routine key");
  ok(grantLifetime(undefined) === "session", "an unknown key falls back to the session (pre-OPE-152) meaning");
}

{
  ok(
    JSON.stringify(declaredPermissionKinds(["pr.open", "connector:notion"])) === JSON.stringify(["pr.open", connectorSessionKind("notion")]),
    "the two declarable permissions map onto the two real grant grains",
  );
  ok(JSON.stringify(declaredPermissionKinds(["connector:notion", "connector:notion"])) === JSON.stringify([connectorSessionKind("notion")]), "duplicates collapse");
  ok(declaredPermissionKinds([]).length === 0, "declaring nothing is legal (the default)");

  for (const bad of [
    "delete",
    "notion__notion_delete_page",
    "connector.op:notion",
    "executor.op",
    "connector:",
    "connector:Notion",
    "connector:no tion",
    "connector:a:b",
    "skill.create",
    "memory.remember",
    "spend.set",
    "pr.merge",
    "",
  ]) {
    ok(routinePermissionKind(bad) === null, `"${bad}" is not a declarable permission`);
  }
  const err = await throwsAsync(() => declaredPermissionKinds(["connector:notion", "delete"]), "an undeclarable permission is refused at propose time");
  ok(err.includes("pr.open") && err.includes("connector:<slug>"), "the refusal names the whole legal vocabulary");
  const capped = await throwsAsync(
    () => declaredPermissionKinds(Array.from({ length: MAX_DECLARED_PERMISSIONS + 1 }, (_, i) => `connector:c${i}`)),
    "a shotgun declaration past the card-readability cap is refused",
  );
  ok(capped.includes(String(MAX_DECLARED_PERMISSIONS)), "the cap refusal names the cap");

  ok(describeGrantKind("pr.open") === "open pull requests", "pr.open renders in plain language");
  ok(describeGrantKind(connectorSessionKind("notion")) === "write to notion", "a connector grant renders in plain language");
  ok(describeGrantKind("something.new") === "something.new", "an unrecognised grain renders VERBATIM — a grant is never hidden from the reader");
  ok(JSON.stringify(describeDeclaredPermissions(["pr.open", "connector:notion"])) === JSON.stringify(["open pull requests", "write to notion"]), "the declared set renders in order");
}

{
  ok(permissionLines({}).length === 0, "a routine that declares nothing adds NO line (the card is unchanged)");
  const line = permissionLines({ permissions: ["pr.open", "connector:notion"], tainted: false })[0];
  ok(line.includes("open pull requests") && line.includes("write to notion"), "the card names each permission in plain language");
  ok(line.includes("anything else will ask you first"), "the card states the fallback: everything else still gates");
  const taintedLine = permissionLines({ permissions: ["pr.open"], tainted: true })[0];
  ok(taintedLine.includes("NOT granted"), "a TAINTED proposal's card says the declaration is refused, rather than hiding it");
}

{
  const written = await grantDeclaredRoutinePermissions({
    org: ORG,
    routine: ROUTINE,
    declared: ["pr.open", "connector:notion"],
    grantedBy: "U_CLICKER",
    tainted: false,
    nowIso: NOW,
  });
  ok(JSON.stringify(written) === JSON.stringify(["pr.open", connectorSessionKind("notion")]), "arming writes exactly the declared grains");
  const held = await listRoutinePermissions(ORG, ROUTINE, NOW);
  ok(JSON.stringify(held) === JSON.stringify([connectorSessionKind("notion"), "pr.open"].map(describeGrantKind)), "the standing set is READABLE (kind-ascending)");
  const row = await getOperationalStore().getSessionApproval(ORG, routineGrantKey(ROUTINE), "pr.open", NOW);
  ok(row?.grantedBy === "U_CLICKER", "the grant is attributed to the human who CLICKED, not to the proposing model");
  ok(row?.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "a routine grant carries no TTL — its death is the generation key + revoke, never a silent expiry");
  await getOperationalStore().setSessionApproval({ org: ORG, sessionId: "some-other-session", kind: "pr.open", grantedBy: "U", createdAt: NOW, expiresAt: NOW });
  ok((await listRoutinePermissions(ORG, ROUTINE, NOW)).length === 2, "the standing set survives another write's prune-on-write GC");

  const taintedRoutine = { ...ROUTINE, id: "r-tainted1" };
  const none = await grantDeclaredRoutinePermissions({
    org: ORG,
    routine: taintedRoutine,
    declared: ["pr.open", "connector:notion"],
    grantedBy: "U_CLICKER",
    tainted: true,
    nowIso: NOW,
  });
  ok(none.length === 0, "a routine proposed in a TAINTED turn is granted NOTHING, even when a human arms it");
  ok((await listRoutinePermissions(ORG, taintedRoutine, NOW)).length === 0, "…and holds no standing set at all");
}

{
  const edited = { ...ROUTINE, id: "r-edited01" };
  await grantDeclaredRoutinePermissions({ org: ORG, routine: edited, declared: ["pr.open"], grantedBy: "U_CLICKER", tainted: false, nowIso: NOW });
  await getOperationalStore().setSessionApproval({
    org: ORG,
    sessionId: routineGrantKey(edited),
    kind: connectorSessionKind("linear"),
    grantedBy: "U_NIGHT",
    createdAt: NOW,
    expiresAt: ROUTINE_GRANT_NO_EXPIRY,
  });
  ok((await listRoutinePermissions(ORG, edited, NOW)).length === 2, "the routine holds a declared AND an accumulated grant");

  const afterEdit = { ...edited, promptGeneration: nextPromptGeneration(edited) };
  ok((await listRoutinePermissions(ORG, afterEdit, NOW)).length === 0, "an EDIT invalidates the WHOLE set — declared and accumulated — with no sweep");
  ok((await getOperationalStore().getSessionApproval(ORG, routineGrantKey(afterEdit), "pr.open", NOW)) === null, "…so the run-time consult misses too: 'grant it pr.open, then rewrite the prompt' inherits nothing");
  ok((await listRoutinePermissions(ORG, edited, NOW)).length === 2, "the old generation's rows are simply unreachable, not swept");
}

{
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: "C1", surfaceKey: ROUTINE.surfaceKey } as unknown as Partition;
  const live = { ...ROUTINE, id: "r-revoke01" };
  await addRoutine(partition, live);
  await grantDeclaredRoutinePermissions({ org: ORG, routine: live, declared: ["pr.open", "connector:notion"], grantedBy: "U_CLICKER", tainted: false, nowIso: NOW });
  ok((await listRoutinePermissions(ORG, live, NOW)).length === 2, "the routine holds a standing set");

  const revoked = await revokeRoutinePermissions(ORG, live);
  ok(revoked === 2, "revoking withdraws every grant under the key");
  ok((await listRoutinePermissions(ORG, live, NOW)).length === 0, "…and the standing set is empty afterwards");
  const still = await getRoutine(ORG, live.surfaceKey, live.id);
  ok(still !== null && still.status === "active" && still.prompt === live.prompt, "the ROUTINE is untouched — revoking authority is not cancelling the work");
  ok(routineGrantGeneration(still!) === 1, "…and its generation is unchanged, so a durable job's seat is NOT rotated by a revoke");
  ok((await revokeRoutinePermissions(ORG, live)) === 0, "revoking twice is a no-op");
}

{
  const attrs = routineFireAttributes(ROUTINE, { team_id: "T1", channel_id: "C1" }, "channel", false);
  ok(attrs[ROUTINE_MARKER.grant] === routineGrantKey(ROUTINE), "a fire is stamped with the routine's grant key, host-set off the STORED row");
  ok(routineFireAttributes({ ...ROUTINE, promptGeneration: 3 }, {}, "channel", false)[ROUTINE_MARKER.grant] === routineGrantKey({ ...ROUTINE, promptGeneration: 3 }), "…carrying the row's live generation, so an edit re-keys the next fire");

  const ctxWith = (attributes: Record<string, string>) => ({
    session: { auth: { current: { principalId: "", attributes } } },
    channel: { continuationToken: "oe-dom:eng:win:slack/T1/C1:oe-sup:g1" },
  });
  ok(proposingSessionId(ctxWith(attrs) as never) === routineGrantKey(ROUTINE), "a FIRE proposes under the ROUTINE's key, not its throwaway session — the one swap both consult sites and the click path ride");
  ok(proposingSessionId(ctxWith({}) as never) === "oe-dom:eng:win:slack/T1/C1:oe-sup:g1", "an ordinary human turn is untouched: it still keys on its window token");
  ok(proposingSessionId(ctxWith({ [ROUTINE_MARKER.grant]: "slack/T1/C1" }) as never) === "oe-dom:eng:win:slack/T1/C1:oe-sup:g1", "a stamp WITHOUT the routine namespace is ignored — the key cannot be redirected at an arbitrary session");
  ok(routineGrantKeyStamped({ [ROUTINE_MARKER.grant]: "nonsense" }) === undefined, "…and the reader itself refuses a non-namespaced value");
}

{
  const key = routineGrantKey(ROUTINE);
  const frozen = (over: Record<string, unknown>) => ({ kind: "executor.op", argsJson: JSON.stringify({ tier: "write", tainted: false, connector: "notion", sessionId: key, ...over }) });
  ok(sessionGrantKind(frozen({})) === connectorSessionKind("notion"), "a WRITE proposed by a fire is grantable — under the per-connector grain, unchanged");
  ok(sessionGrantKind(frozen({ tier: "destructive" })) === null, "🔴 DESTRUCTIVE-NEVER carries onto the routine-keyed path");
  ok(sessionGrantKind(frozen({ tainted: true })) === null, "🔴 TAINTED-NEVER carries onto the routine-keyed path");

  await getOperationalStore().setSessionApproval({ org: ORG, sessionId: key, kind: connectorSessionKind("notion"), grantedBy: "U_NIGHT", createdAt: NOW, expiresAt: ROUTINE_GRANT_NO_EXPIRY });
  const context: ExecutorApprovalContext = {
    org: ORG,
    scopeKey: ROUTINE.surfaceKey,
    connector: "notion",
    op: "notion_create_page",
    callArgs: { title: "nightly" },
    executionId: "exec_night",
    requestedBy: "U_REQ",
    channelId: "C1",
    threadTs: null,
    postedTo: ROUTINE.surfaceKey,
    domain: null,
    platform: "slack",
    sessionId: key,
  };
  const run = async (over: Partial<ExecutorApprovalContext>) => {
    let mints = 0;
    let resumes = 0;
    const mint = (async () => {
      mints++;
      return { id: `pend-${mints}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    }) as unknown as typeof requestApproval;
    await surfaceExecutorApproval({ ...context, ...over }, {
      requestApproval: mint,
      resume: async () => {
        resumes++;
        return "resumed";
      },
      audit: (async () => undefined) as never,
      now: () => NOW,
    });
    return { mints, resumes };
  };
  const granted = await run({ tier: "write" });
  ok(granted.resumes === 1 && granted.mints === 0, "THE POINT: a granted write lands UNATTENDED at 03:00 — no card, no stall");
  const destructive = await run({ tier: "destructive" });
  ok(destructive.mints === 1 && destructive.resumes === 0, "🔴 a DESTRUCTIVE op still cards, standing grant or not");
  const tainted = await run({ tier: "write", tainted: true });
  ok(tainted.mints === 1 && tainted.resumes === 0, "🔴 a fire that ingested untrusted content still cards, standing grant or not");
  const other = await run({ tier: "write", connector: "linear" });
  ok(other.mints === 1 && other.resumes === 0, "a Notion grant does not authorise a Linear write");
  await revokeRoutinePermissions(ORG, ROUTINE);
  const afterRevoke = await run({ tier: "write" });
  ok(afterRevoke.mints === 1 && afterRevoke.resumes === 0, "after a revoke the same write CARDS again");
}

{
  ok(grantButtonLabel({ argsJson: JSON.stringify({ sessionId: routineGrantKey(ROUTINE) }) }) === "Approve for this routine (standing)", "a fire's card offers a STANDING grant, and says so");
  ok(grantButtonLabel({ argsJson: JSON.stringify({ sessionId: "oe-dom:eng:win:slack/T1/C1:oe-sup:g1" }) }) === "Approve for session", "a human turn's card is unchanged");
  ok(grantButtonLabel({ argsJson: "{" }) === "Approve for session", "unparseable frozen args fall back to the conservative wording");
  ok(grantButtonLabel({ argsJson: "{}" }) === "Approve for session", "so does an args bag with no session at all");
}

console.log(`✓ routine-grants: ${passed} assertions passed`);
