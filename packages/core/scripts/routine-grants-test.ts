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
  sweepLegacyConnectorGrants,
  unarmedDeclarations,
} from "../agent/routines/grants.js";
import {
  connectorSessionKind,
  connectorToolPermissionKind,
  describeGrantKind,
  grantButtonLabel,
  grantLifetime,
  routinePermissionKind,
  sessionGrantKind,
} from "../agent/approvals/session-grant.js";
import { isReservedNamespaceTool } from "../agent/access/consequence.js";
import { permissionLines, type RoutineCreateArgs } from "../agent/approvals/routine-create.js";
import { actionKind } from "../agent/approvals/actions.js";
import { routineFireAttributes } from "../agent/routines/fire-auth.js";
import { proposingSessionId } from "../agent/identity/binding.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { addRoutine, getRoutine } from "../agent/routines/store.js";
import type { Partition } from "../agent/memory/partition.js";

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
    JSON.stringify(declaredPermissionKinds(["pr.open", "tool:notion__share_page"])) === JSON.stringify(["pr.open", connectorToolPermissionKind("notion__share_page")]),
    "the two declarable permissions map onto pr.open and ONE named tool",
  );
  ok(
    JSON.stringify(declaredPermissionKinds(["tool:notion__share_page", "tool:notion__share_page"])) === JSON.stringify([connectorToolPermissionKind("notion__share_page")]),
    "duplicates collapse",
  );
  ok(
    JSON.stringify(declaredPermissionKinds(["tool:notion__share_page", "tool:notion__invite_user"])).includes("notion__invite_user"),
    "two tools on the same connection are two separate rows, never one class",
  );
  ok(declaredPermissionKinds([]).length === 0, "declaring nothing is legal (the default)");

  for (const bad of [
    "delete",
    "connector:notion",
    "tool:notion",
    "connector.op:notion",
    "connector.tool:notion__share_page",
    "tool:",
    "tool:Notion__Share_Page",
    "tool:notion__share page",
    "tool:notion__a:b",
    "tool:notion___share_page",
    "tool:grant__U0OWNER__send",
    "skill.create",
    "memory.purge",
    "spend.set",
    "pr.merge",
    "",
  ]) {
    ok(routinePermissionKind(bad) === null, `"${bad}" is not a declarable permission`);
  }
  ok(isReservedNamespaceTool("grant__U0OWNER__send"), "…and that name really is the reserved namespace, per access/consequence.ts");
  ok(!isReservedNamespaceTool("notion__share_page"), "…while an ordinary connector op is not");

  const err = await throwsAsync(() => declaredPermissionKinds(["tool:notion__share_page", "delete"]), "an undeclarable permission is refused at propose time");
  ok(err.includes("pr.open") && err.includes("tool:notion__share_page"), "the refusal names the whole legal vocabulary, with the per-tool shape");

  ok(routinePermissionKind("tool:notion__delete_page") !== null, "the SHAPE of a delete-tier tool is well-formed (which is why the tier check below is needed)");
  const destructive = await throwsAsync(() => declaredPermissionKinds(["tool:notion__delete_page"]), "a delete-tier tool is refused at propose time");
  ok(destructive.includes("DELETE-tier") && destructive.includes("never lift"), "…and the refusal says why, so the author can fix it");

  const capped = await throwsAsync(
    () => declaredPermissionKinds(Array.from({ length: MAX_DECLARED_PERMISSIONS + 1 }, (_, i) => `tool:notion__create_c${i}`)),
    "a shotgun declaration past the card-readability cap is refused",
  );
  ok(capped.includes(String(MAX_DECLARED_PERMISSIONS)), "the cap refusal names the cap");

  ok(describeGrantKind("pr.open") === "open pull requests", "pr.open renders in plain language");
  ok(
    describeGrantKind(connectorToolPermissionKind("notion__share_page")) === 'use the "notion__share_page" tool',
    "a per-tool row renders the TOOL, which is what the human is being asked to buy",
  );
  const legacy = describeGrantKind(connectorSessionKind("notion"));
  ok(legacy.includes("legacy") && !legacy.startsWith("write to notion"), "a stored LEGACY row renders as the inert record it is, never as a live connector write");
  ok(legacy.includes("notion"), "…and still names it, because a row hidden from the reader is worse than an ugly one");
  ok(describeGrantKind("something.new") === "something.new", "an unrecognised grain renders VERBATIM — a row is never hidden from the reader");
  ok(
    JSON.stringify(describeDeclaredPermissions(["pr.open", "tool:notion__share_page"])) === JSON.stringify(["open pull requests", 'use the "notion__share_page" tool']),
    "the declared set renders in order",
  );

  const legacyOnly = describeDeclaredPermissions(["connector:notion"]);
  ok(legacyOnly.length === 1, "an unmappable frozen declaration still gets a line — the empty list is what hid it from the reader");
  ok(legacyOnly[0].includes("unrecognised declaration") && legacyOnly[0].includes("connector:notion"), "…and the line NAMES the frozen text, so the human can see what the model asked for");
  ok(legacyOnly[0].includes("grants nothing"), "…while promising nothing, because this build cannot map it onto any row");
  const armedCard = permissionLines({ permissions: ["connector:notion"], tainted: false });
  ok(armedCard.length === 1, "the CARD itself now carries that line — the drop was invisible one layer up, which is where it mattered");

  ok(armedCard[0].includes("may, without asking") && armedCard[0].includes("connector:notion"), "ARMED frame: the card names the frozen declaration");
  ok(armedCard[0].includes("grants nothing"), "…and says it buys nothing, so 'may, without asking' cannot be read as authority");
  const taintedCard = permissionLines({ permissions: ["connector:notion"], tainted: true });
  ok(taintedCard.length === 1, "TAINTED frame: an unmappable declaration on a poisoned card is rendered, not hidden");
  ok(taintedCard[0].includes("connector:notion"), "…and it names what the model ASKED for, rather than reporting the ask as empty");
  ok(!taintedCard[0].includes("permission to nothing"), "…and the composed sentence never says the model asked for NOTHING, which is the false reading a bare-'nothing' lead produced");
  ok(taintedCard[0].includes("NOT granted"), "…while still saying nothing was granted");

  const unliftable = describeDeclaredPermissions(["tool:notion__delete_page"]);
  ok(unliftable[0] !== 'use the "notion__delete_page" tool', "…but NOT the live-authority wording, which no row backs");
  ok(unliftable[0].includes("notion__delete_page") && unliftable[0].includes("never lifted") && unliftable[0].includes("grants nothing"), "…it says the tool is never lifted and grants nothing, and still names it");

  const mixed = describeDeclaredPermissions(["pr.open", "connector:notion", "tool:notion__delete_page", "tool:notion__share_page"]);
  ok(mixed.length === 4, "every declaration gets exactly one line, in the declaration's order");
  ok(mixed[0] === "open pull requests" && mixed[3] === 'use the "notion__share_page" tool', "the two ARMABLE rows still render as live authority — the fix under-promises the others, it does not blanket the card");
  ok(!mixed[0].includes("grants nothing") && !mixed[3].includes("grants nothing"), "…negative control: the grants-nothing qualifier is NOT stamped on rows that do arm");
}

{
  ok(permissionLines({}).length === 0, "a routine that declares nothing adds NO line (the card is unchanged)");
  const line = permissionLines({ permissions: ["pr.open", "tool:notion__share_page"], tainted: false })[0];
  ok(line.includes("open pull requests") && line.includes("notion__share_page"), "the card names each permission in plain language, and names the TOOL");
  ok(line.includes("anything else will ask you first"), "the card states the fallback: everything else still gates");
  const taintedLine = permissionLines({ permissions: ["pr.open"], tainted: true })[0];
  ok(taintedLine.includes("NOT granted"), "a TAINTED proposal's card says the declaration is refused, rather than hiding it");
}

{
  const written = await grantDeclaredRoutinePermissions({
    org: ORG,
    routine: ROUTINE,
    declared: ["pr.open", "tool:notion__share_page"],
    grantedBy: "U_CLICKER",
    tainted: false,
    nowIso: NOW,
  });
  ok(JSON.stringify(written) === JSON.stringify(["pr.open", connectorToolPermissionKind("notion__share_page")]), "arming writes exactly the declared rows");
  const held = await listRoutinePermissions(ORG, ROUTINE, NOW);
  ok(JSON.stringify(held) === JSON.stringify([connectorToolPermissionKind("notion__share_page"), "pr.open"].map(describeGrantKind)), "the standing set is READABLE (kind-ascending)");
  const row = await getOperationalStore().getSessionApproval(ORG, routineGrantKey(ROUTINE), "pr.open", NOW);
  ok(row?.grantedBy === "U_CLICKER", "the grant is attributed to the human who CLICKED, not to the proposing model");
  ok(row?.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "a routine grant carries no TTL — its death is the generation key + revoke, never a silent expiry");
  await getOperationalStore().setSessionApproval({ org: ORG, sessionId: "some-other-session", kind: "pr.open", grantedBy: "U", createdAt: NOW, expiresAt: NOW });
  ok((await listRoutinePermissions(ORG, ROUTINE, NOW)).length === 2, "the standing set survives another write's prune-on-write GC");

  const taintedRoutine = { ...ROUTINE, id: "r-tainted1" };
  const none = await grantDeclaredRoutinePermissions({
    org: ORG,
    routine: taintedRoutine,
    declared: ["pr.open", "tool:notion__share_page"],
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
    kind: connectorToolPermissionKind("linear__create_issue"),
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
  await grantDeclaredRoutinePermissions({ org: ORG, routine: live, declared: ["pr.open", "tool:notion__share_page"], grantedBy: "U_CLICKER", tainted: false, nowIso: NOW });
  ok((await listRoutinePermissions(ORG, live, NOW)).length === 2, "the routine holds a standing set");

  const revoked = await revokeRoutinePermissions(ORG, live);
  ok(revoked.grants === 2 && revoked.rows === 2, "revoking withdraws every grant under the key");
  ok((await listRoutinePermissions(ORG, live, NOW)).length === 0, "…and the standing set is empty afterwards");
  const still = await getRoutine(ORG, live.surfaceKey, live.id);
  ok(still !== null && still.status === "active" && still.prompt === live.prompt, "the ROUTINE is untouched — revoking authority is not cancelling the work");
  ok(routineGrantGeneration(still!) === 1, "…and its generation is unchanged, so a durable job's seat is NOT rotated by a revoke");
  const twice = await revokeRoutinePermissions(ORG, live);
  ok(twice.grants === 0 && twice.rows === 0, "revoking twice is a no-op on both counts");
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
  ok(grantButtonLabel({ argsJson: JSON.stringify({ sessionId: routineGrantKey(ROUTINE) }) }) === "Approve for this routine (standing)", "a ROUTINE-keyed frozen arg maps to the STANDING wording (the label rule, not a live card)");
  ok(grantButtonLabel({ argsJson: JSON.stringify({ sessionId: "oe-dom:eng:win:slack/T1/C1:oe-sup:g1" }) }) === "Approve for session", "a human turn's card is unchanged");
  ok(grantButtonLabel({ argsJson: "{" }) === "Approve for session", "unparseable frozen args fall back to the conservative wording");
  ok(grantButtonLabel({ argsJson: "{}" }) === "Approve for session", "so does an args bag with no session at all");
}

{
  const legacyCard = { ...ROUTINE, id: "r-frozen01" };
  const written = await grantDeclaredRoutinePermissions({
    org: ORG,
    routine: legacyCard,
    declared: ["pr.open", "connector:notion"],
    grantedBy: "U_CLICKER",
    tainted: false,
    nowIso: NOW,
  });
  ok(JSON.stringify(written) === JSON.stringify(["pr.open"]), "a frozen LEGACY declaration is SKIPPED at arm time, and the rest of the card still arms");
  ok((await listRoutinePermissions(ORG, legacyCard, NOW)).length === 1, "…so exactly one row is live, and no legacy row is written");
  ok(JSON.stringify(unarmedDeclarations(["pr.open", "connector:notion"], written)) === JSON.stringify(["connector:notion"]), "…and the skipped declaration is named, never dropped in silence");
  ok(unarmedDeclarations(["pr.open", "tool:notion__share_page"], ["pr.open", connectorToolPermissionKind("notion__share_page")]).length === 0, "control: a set this build DOES accept, all of it written, names nothing as unarmed");
  ok(JSON.stringify(unarmedDeclarations(["tool:notion__delete_page"], [])) === JSON.stringify(["tool:notion__delete_page"]), "a delete-tier tool is unarmed as well as undeclarable");
  ok(
    JSON.stringify(unarmedDeclarations(["pr.open", "connector:notion"], [])) === JSON.stringify(["pr.open", "connector:notion"]),
    "a TAINTED card arms NOTHING, so every declaration is named — not just the one the vocabulary rejects",
  );
  ok(
    JSON.stringify(unarmedDeclarations(["pr.open", "tool:notion__share_page"], ["pr.open"])) === JSON.stringify(["tool:notion__share_page"]),
    "a declaration whose row write FAILED is named too",
  );
  await throwsAsync(() => declaredPermissionKinds(["connector:notion"]), "propose time still REFUSES the legacy spelling outright (tolerance is arm-time only)");
  const unknownVerb = await throwsAsync(() => declaredPermissionKinds(["tool:notion__frobnicate"]), "an unrecognised verb is refused (it fails closed to the delete tier)");
  ok(unknownVerb.includes("does not recognise"), "…and the refusal names the unrecognised-verb case, not only the delete case");
}

{
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: "C1", surfaceKey: ROUTINE.surfaceKey } as unknown as Partition;
  const create = actionKind("routine.create");
  ok(create !== undefined && create.kind === "routine.create", "the routine.create action kind is registered");
  const click = (permissions: readonly string[], tainted: boolean): Promise<string> =>
    (create as { execute(a: RoutineCreateArgs, by: string): Promise<string> }).execute(
      {
        org: ORG,
        partition,
        surfaceKey: ROUTINE.surfaceKey,
        target: { channelId: "C1" },
        trigger: ROUTINE.trigger,
        prompt: ROUTINE.prompt,
        createdBy: "U_AUTHOR",
        ...(tainted ? { tainted: true } : {}),
        permissions,
      },
      "U_CLICKER",
    );

  const mixed = await click(["pr.open", "connector:notion"], false);
  ok(mixed.includes("standing permission to"), "the armed half of a frozen card is reported as standing");
  ok(mixed.includes(`NOT armed: "connector:notion"`), "…and the half this build cannot arm is NAMED in the outcome the human reads");
  ok(!mixed.includes(`NOT armed: "pr.open"`), "…without dragging the armed declaration into the refusal");
  ok(mixed.includes("asks a person"), "…and says what happens instead when the routine reaches that step");

  const tainted = await click(["pr.open", "connector:notion"], true);
  ok(!tainted.includes("standing permission to"), "a TAINTED proposal reports no standing permission at all");
  ok(tainted.includes(`NOT armed: "pr.open" · "connector:notion"`), "…and names EVERY declaration, not only the one the vocabulary rejects");
  ok(tainted.includes("read external content"), "…and gives the reason, so the human is not left inferring a vocabulary problem");

  const clean = await click(["pr.open", "tool:notion__share_page"], false);
  ok(clean.includes("standing permission to"), "a fully armable card reports its standing set");
  ok(!clean.includes("NOT armed"), "…and says nothing about anything being unarmed");
}

{
  const store = getOperationalStore();
  const swept = { ...ROUTINE, id: "r-sweep001" };
  const key = routineGrantKey(swept);
  const row = (sessionId: string, kind: string) => ({ org: ORG, sessionId, kind, grantedBy: "U", createdAt: NOW, expiresAt: ROUTINE_GRANT_NO_EXPIRY });

  await store.setSessionApproval(row(key, "connector.op:notion"));
  await store.setSessionApproval(row(key, "connector.op:linear"));
  await store.setSessionApproval(row(key, connectorToolPermissionKind("notion__share_page")));
  await store.setSessionApproval(row("some-session-token", "connector.op:notion"));

  const held = await listRoutinePermissions(ORG, swept, NOW);
  ok(held.length === 1, `an inert connector.op: row is not one of the routine's permissions (saw ${JSON.stringify(held)})`);
  ok(
    !held.some((line) => line.includes("legacy row that lifts no tool")),
    "…so a human is never told a routine holds a permission that lifts nothing",
  );

  const removed = await sweepLegacyConnectorGrants(ORG);
  ok(removed === 2, `the sweep removes exactly the inert routine rows (removed ${removed})`);
  ok((await store.listSessionApprovals(ORG, key, NOW)).map((r) => r.kind).join(",") === connectorToolPermissionKind("notion__share_page"), "…and the LIVE per-tool grant under the same key survives");
  ok((await store.listSessionApprovals(ORG, "some-session-token", NOW)).length === 1, "…and a legacy-shaped row under a NON-routine key is not this defect, so it survives too");

  const again = await sweepLegacyConnectorGrants(ORG);
  ok(again === 0, "sweeping twice removes nothing — the one-shot is idempotent");
}

console.log(`✓ routine-grants: ${passed} assertions passed`);
