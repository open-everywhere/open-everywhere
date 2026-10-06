process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import {
  ROUTINE_PERMISSION_PREFIX,
  ROUTINE_MARKER,
  nextPromptGeneration,
  routinePermissionGeneration,
  routinePermissionKey,
  routinePermissionKeyStamped,
  type Routine,
} from "../agent/routines/routine.js";
import {
  MAX_DECLARED_PERMISSIONS,
  ROUTINE_PERMISSION_NO_EXPIRY,
  ROUTINE_PERMISSION_NEVER_LIFTS_ACTION,
  declaredPermissionKinds,
  describeDeclaredPermissions,
  armDeclaredRoutinePermissions,
  listRoutinePermissions,
  revokeRoutinePermissions,
  sweepLegacyConnectorOpRows,
  unarmedDeclarations,
} from "../agent/routines/declared-permissions.js";
import {
  connectorSessionKind,
  connectorToolPermissionKind,
  describeDeclaredPermissionKind,
  describeLegacyConnectorOpKind,
  grantButtonLabel,
  pendingCardExpiryClause,
  grantReach,
  routinePermissionKind,
  sessionGrantKind,
} from "../agent/approvals/session-grant.js";
import { isReservedNamespaceTool } from "../agent/access/consequence.js";
import { permissionLines, type RoutineCreateArgs } from "../agent/approvals/routine-create.js";
import { actionKind } from "../agent/approvals/actions.js";
import { routineFireAttributes } from "../agent/routines/fire-auth.js";
import { proposingGrantKey } from "../agent/identity/binding.js";
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
  const key = routinePermissionKey(ROUTINE);
  ok(key.startsWith(ROUTINE_PERMISSION_PREFIX), "a routine permission key carries the routine namespace");
  ok(key === `${ROUTINE_PERMISSION_PREFIX}${ROUTINE.id}:g1`, "an un-edited routine keys on generation 1");
  ok(routinePermissionKey({ ...ROUTINE, promptGeneration: 4 }) === `${ROUTINE_PERMISSION_PREFIX}${ROUTINE.id}:g4`, "the key embeds the live generation");
  for (const g of [0, -3, 1.5, Number.NaN] as number[]) {
    ok(routinePermissionGeneration({ promptGeneration: g }) === 1, `generation ${g} reads as 1`);
  }
  let r: Pick<Routine, "promptGeneration"> = {};
  const seen = new Set<number>();
  for (let i = 0; i < 5; i++) {
    const next = nextPromptGeneration(r);
    ok(next > routinePermissionGeneration(r) && !seen.has(next), "each edit moves strictly forward to an unused generation");
    seen.add(next);
    r = { promptGeneration: next };
  }
  ok(grantReach(routinePermissionKey(ROUTINE)) === "routine", "session-grant.ts recognises a real routine key as standing");
  ok(grantReach("oe-dom:eng:win:slack/T1/C1:oe-sup:g1") === undefined, "a window token is NOT read as a routine key, and grants nothing (OPE-2363)");
  ok(grantReach(undefined) === undefined, "an absent key reaches nothing");
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

  for (const declaration of ["pr.open", "tool:notion__share_page", "tool:linear__create_issue"]) {
    const kind = routinePermissionKind(declaration);
    ok(kind !== null, `${declaration} is declarable`);
    ok(!/grant/i.test(describeDeclaredPermissionKind(kind!)), `describeDeclaredPermissionKind never says "grant" (${declaration})`);
  }
  ok(describeDeclaredPermissionKind("pr.open") === "open pull requests", "pr.open renders in plain language");
  ok(
    describeDeclaredPermissionKind(connectorToolPermissionKind("notion__share_page")) === 'use the "notion__share_page" tool',
    "a per-tool row renders the TOOL, which is what the human is being asked to buy",
  );
  const legacy = describeDeclaredPermissionKind(connectorSessionKind("notion"));
  ok(legacy.includes("legacy") && !legacy.startsWith("write to notion"), "a stored LEGACY row renders as the inert record it is, never as a live connector write");
  ok(legacy.includes("notion"), "…and still names it, because a row hidden from the reader is worse than an ugly one");
  ok(legacy === describeLegacyConnectorOpKind(connectorSessionKind("notion")), "the legacy arm IS a SEPARATE renderer, delegated to rather than re-spelled inside the routine plane's own");
  ok(/per-connector/.test(legacy) && !/session/i.test(legacy), "…and it names the retired GRAIN, not a plane — the remedy for a stored one is on the routine plane");
  ok(describeDeclaredPermissionKind("something.new") === "something.new", "an unrecognised grain renders VERBATIM — a row is never hidden from the reader");
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
  const written = await armDeclaredRoutinePermissions({
    org: ORG,
    routine: ROUTINE,
    declared: ["pr.open", "tool:notion__share_page"],
    grantedBy: "U_CLICKER",
    tainted: false,
    nowIso: NOW,
  });
  ok(JSON.stringify(written) === JSON.stringify(["pr.open", connectorToolPermissionKind("notion__share_page")]), "arming writes exactly the declared rows");
  const held = await listRoutinePermissions(ORG, ROUTINE, NOW);
  ok(JSON.stringify(held) === JSON.stringify([connectorToolPermissionKind("notion__share_page"), "pr.open"].map(describeDeclaredPermissionKind)), "the standing set is READABLE (kind-ascending)");
  const row = await getOperationalStore().getSessionApproval(ORG, routinePermissionKey(ROUTINE), "pr.open", NOW);
  ok(row?.grantedBy === "U_CLICKER", "the permission is attributed to the human who CLICKED, not to the proposing model");
  ok(row?.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY, "a declared permission carries no TTL — its death is the generation key + revoke, never a silent expiry");
  await getOperationalStore().setSessionApproval({ org: ORG, sessionId: "some-other-session", kind: "pr.open", grantedBy: "U", createdAt: NOW, expiresAt: NOW });
  ok((await listRoutinePermissions(ORG, ROUTINE, NOW)).length === 2, "the standing set survives another write's prune-on-write GC");

  const taintedRoutine = { ...ROUTINE, id: "r-tainted1" };
  const none = await armDeclaredRoutinePermissions({
    org: ORG,
    routine: taintedRoutine,
    declared: ["pr.open", "tool:notion__share_page"],
    grantedBy: "U_CLICKER",
    tainted: true,
    nowIso: NOW,
  });
  ok(none.length === 0, "a routine proposed in a TAINTED turn is armed with NOTHING, even when a human arms it");
  ok((await listRoutinePermissions(ORG, taintedRoutine, NOW)).length === 0, "…and holds no standing set at all");
}

{
  const edited = { ...ROUTINE, id: "r-edited01" };
  await armDeclaredRoutinePermissions({ org: ORG, routine: edited, declared: ["pr.open"], grantedBy: "U_CLICKER", tainted: false, nowIso: NOW });
  await getOperationalStore().setSessionApproval({
    org: ORG,
    sessionId: routinePermissionKey(edited),
    kind: connectorToolPermissionKind("linear__create_issue"),
    grantedBy: "U_NIGHT",
    createdAt: NOW,
    expiresAt: ROUTINE_PERMISSION_NO_EXPIRY,
  });
  ok((await listRoutinePermissions(ORG, edited, NOW)).length === 2, "the routine holds a declared AND an accumulated permission");

  const afterEdit = { ...edited, promptGeneration: nextPromptGeneration(edited) };
  ok((await listRoutinePermissions(ORG, afterEdit, NOW)).length === 0, "an EDIT invalidates the WHOLE set — declared and accumulated — with no sweep");
  ok((await getOperationalStore().getSessionApproval(ORG, routinePermissionKey(afterEdit), "pr.open", NOW)) === null, "…so the run-time consult misses too: 'grant it pr.open, then rewrite the prompt' inherits nothing");
  ok((await listRoutinePermissions(ORG, edited, NOW)).length === 2, "the old generation's rows are simply unreachable, not swept");
}

{
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: "C1", surfaceKey: ROUTINE.surfaceKey } as unknown as Partition;
  const live = { ...ROUTINE, id: "r-revoke01" };
  await addRoutine(partition, live);
  await armDeclaredRoutinePermissions({ org: ORG, routine: live, declared: ["pr.open", "tool:notion__share_page"], grantedBy: "U_CLICKER", tainted: false, nowIso: NOW });
  ok((await listRoutinePermissions(ORG, live, NOW)).length === 2, "the routine holds a standing set");

  const revoked = await revokeRoutinePermissions(ORG, live);
  ok(revoked.permissions === 2 && revoked.rows === 2, "revoking withdraws every declared permission under the key");
  ok((await listRoutinePermissions(ORG, live, NOW)).length === 0, "…and the standing set is empty afterwards");
  const still = await getRoutine(ORG, live.surfaceKey, live.id);
  ok(still !== null && still.status === "active" && still.prompt === live.prompt, "the ROUTINE is untouched — revoking authority is not cancelling the work");
  ok(routinePermissionGeneration(still!) === 1, "…and its generation is unchanged, so a durable job's seat is NOT rotated by a revoke");
  const twice = await revokeRoutinePermissions(ORG, live);
  ok(twice.permissions === 0 && twice.rows === 0, "revoking twice is a no-op on both counts");
}

{
  const attrs = routineFireAttributes(ROUTINE, { team_id: "T1", channel_id: "C1" }, "channel", false);
  ok(attrs[ROUTINE_MARKER.permissionKey] === routinePermissionKey(ROUTINE), "a fire is stamped with the routine's grant key, host-set off the STORED row");
  ok(routineFireAttributes({ ...ROUTINE, promptGeneration: 3 }, {}, "channel", false)[ROUTINE_MARKER.permissionKey] === routinePermissionKey({ ...ROUTINE, promptGeneration: 3 }), "…carrying the row's live generation, so an edit re-keys the next fire");

  const ctxWith = (attributes: Record<string, string>) => ({
    session: { auth: { current: { principalId: "", attributes } } },
    channel: { continuationToken: "oe-dom:eng:win:slack/T1/C1:oe-sup:g1" },
  });
  ok(proposingGrantKey(ctxWith(attrs) as never) === routinePermissionKey(ROUTINE), "a FIRE proposes under the ROUTINE's key, not its throwaway session — the one swap both consult sites and the click path ride");
  ok(proposingGrantKey(ctxWith({}) as never) === undefined, "a turn with no fire stamp and no acting person keeps no grant — it never keys on its window token");
  ok(proposingGrantKey(ctxWith({ [ROUTINE_MARKER.permissionKey]: "slack/T1/C1" }) as never) === undefined, "a stamp WITHOUT the routine namespace is ignored — the key cannot be redirected at an arbitrary session");
  ok(routinePermissionKeyStamped({ [ROUTINE_MARKER.permissionKey]: "nonsense" }) === undefined, "…and the reader itself refuses a non-namespaced value");
}

{
  ok(grantButtonLabel({ argsJson: JSON.stringify({ sessionId: routinePermissionKey(ROUTINE) }) }, 24) === "Approve for this routine (up to 24 h)", "a ROUTINE-keyed frozen arg maps to the STANDING wording (the label rule, not a live card)");
  for (const [what, argsJson] of [
    ["a thread key", JSON.stringify({ sessionId: "oe-grant:slack/T1/C1:thread:1718884080.000100" })],
    ["a DM key", JSON.stringify({ sessionId: "oe-grant:slack/T1/D1:dm" })],
    ["a legacy window-token key", JSON.stringify({ sessionId: "oe-dom:eng:win:slack/T1/C1:oe-sup:g1" })],
    ["unparseable frozen args", "{"],
    ["an args bag with no key", "{}"],
  ] as const) {
    ok(grantButtonLabel({ argsJson }, 24) === undefined, `🔴 OPE-2363: ${what} offers NO middle button`);
  }
  ok(pendingCardExpiryClause(ROUTINE_PERMISSION_NO_EXPIRY) === "no expiry — ends when the routine's instruction is edited or the routine is deleted", "a no-clock row's footer names the routine generation, not the year 9999");
  ok(pendingCardExpiryClause("2026-01-28T17:16:00Z") === "expires 2026-01-28T17:16:00Z", "a clocked row's footer is unchanged");
}

{
  const legacyCard = { ...ROUTINE, id: "r-frozen01" };
  const written = await armDeclaredRoutinePermissions({
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
  const UPPER = "acme__API_post";
  ok(routinePermissionKind(`tool:${UPPER}`) === connectorToolPermissionKind(UPPER), "a tool name with an UPPERCASE segment is declarable");
  ok(
    JSON.stringify(declaredPermissionKinds([`tool:${UPPER}`])) === JSON.stringify([connectorToolPermissionKind(UPPER)]),
    "…and survives the propose-time gate as one row",
  );
  ok(
    routinePermissionKind(`tool:${UPPER}`) !== routinePermissionKind("tool:acme__api_post"),
    "🔴 the kind is CASE-SENSITIVE — declaring `acme__API_post` cannot lift `acme__api_post`, so the widening reaches exactly matching names and nothing else",
  );
  ok(routinePermissionKind(`tool:${UPPER}`)?.includes(UPPER) === true, "…and the memo kind carries the tool name byte-for-byte, as the fence will compare it");

  ok(
    describeDeclaredPermissions([`tool:${UPPER}`]).some((l) => l.includes(`use the "${UPPER}" tool`)),
    "🔴 …and the card renders it as a real permission, not as a delete-tier refusal — the tier classifier case-folds the verb, so `API_post` classifies `write` exactly as `api_post` does",
  );

  for (const spelling of ["tool:Grant__U0OWNER__send", "tool:GRANT__U0OWNER__send", "tool:grant__U0OWNER__send"]) {
    ok(routinePermissionKind(spelling) === null, `🔴 "${spelling}" is refused — the credential-grant namespace is matched case-INSENSITIVELY`);
  }
  ok(routinePermissionKind("tool:grants__U0OWNER__send") !== null, "…while a connection genuinely called `grants` is untouched — the match is the whole segment, never a prefix");

  const spaced = await throwsAsync(() => declaredPermissionKinds(["tool:notion__share page"]), "a bad segment is still refused");
  ok(spaced.includes("share page"), "🔴 the refusal NAMES the offending segment");
  ok(spaced.includes("letters, digits"), "…and states the charset the segment must satisfy");
  const slug = await throwsAsync(() => declaredPermissionKinds(["tool:notion"]), "a bare slug is still refused");
  ok(slug.includes("single segment"), "🔴 …and a slug-shaped declaration is told THAT, not the charset rule");
  const reserved = await throwsAsync(() => declaredPermissionKinds(["tool:grant__U0OWNER__send"]), "the reserved namespace is still refused");
  ok(reserved.includes("reserved namespace"), "🔴 …and the reserved-namespace refusal names its own reason");
  ok(reserved.includes("pr.open"), "…while every refusal still recites the legal vocabulary after the reason");
}

{
  const store = getOperationalStore();
  const swept = { ...ROUTINE, id: "r-sweep001" };
  const key = routinePermissionKey(swept);
  const row = (sessionId: string, kind: string) => ({ org: ORG, sessionId, kind, grantedBy: "U", createdAt: NOW, expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });

  await store.setSessionApproval(row(key, "connector.op:notion"));
  await store.setSessionApproval(row(key, "connector.op:linear"));
  await store.setSessionApproval(row(key, connectorToolPermissionKind("notion__share_page")));
  await store.setSessionApproval(row("some-session-token", "connector.op:notion"));

  const held = await listRoutinePermissions(ORG, swept, NOW);
  ok(held.length === 1, `an inert connector.op: row is not one of the routine's permissions (saw ${JSON.stringify(held)})`);
  ok(
    !held.some((line) => line === describeLegacyConnectorOpKind(connectorSessionKind("notion"))),
    "…so a human is never told a routine holds a permission that lifts nothing",
  );

  const removed = await sweepLegacyConnectorOpRows(ORG);
  ok(removed === 2, `the sweep removes exactly the inert routine rows (removed ${removed})`);
  ok((await store.listSessionApprovals(ORG, key, NOW)).map((r) => r.kind).join(",") === connectorToolPermissionKind("notion__share_page"), "…and the LIVE per-tool grant under the same key survives");
  ok((await store.listSessionApprovals(ORG, "some-session-token", NOW)).length === 1, "…and a legacy-shaped row under a NON-routine key is not this defect, so it survives too");

  const again = await sweepLegacyConnectorOpRows(ORG);
  ok(again === 0, "sweeping twice removes nothing — the one-shot is idempotent");
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineBundle } = await import("../agent/access/bundle.js");
  const RAISED = "acme__share_report";
  const PLAIN = "acme__update_report";

  const { namesBundleRaisedTool, namesUnliftableTool } = await import("../agent/routines/declared-permissions.js");
  ok(!namesBundleRaisedTool(`tool:${RAISED}`), "with no bundle registered, nothing is bundle-raised");
  ok(describeDeclaredPermissions([`tool:${RAISED}`])[0]?.includes(`use the "${RAISED}" tool`) === true, "…and the card calls it an ordinary usable tool");

  registerConfig({
    loadBundles: () => [
      defineBundle({
        name: "acme-raised",
        connectors: [{ name: "acme", credential: "k", contentOrigin: "external" }],
        connectorOps: [{ connector: "acme", destructive: ["share_report"] }],
      }),
    ],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  ok(!namesUnliftableTool(`tool:${RAISED}`), "🔴 the STATIC classifier still calls it a write — which is why the propose-time gate lets it through");
  ok(namesBundleRaisedTool(`tool:${RAISED}`), "🔴 …while THIS deployment's bundle raises it to the delete tier, so the fence refuses it on every fire");
  ok(!namesBundleRaisedTool(`tool:${PLAIN}`), "…and an unnamed op on the same connector is untouched");
  ok(!namesBundleRaisedTool("pr.open"), "…and `pr.open` names no connector tool at all");

  ok(
    JSON.stringify(declaredPermissionKinds([`tool:${RAISED}`])) === JSON.stringify([connectorToolPermissionKind(RAISED)]),
    "🔴 the model-facing gate still ACCEPTS it — the throw stays deployment-independent, which is the whole reason it reads the static tier",
  );

  const line = describeDeclaredPermissions([`tool:${RAISED}`])[0] ?? "";
  ok(line.includes(RAISED), "the arming card still NAMES the declaration — a hidden row is worse than an ugly one");
  ok(line.includes("grants nothing here"), "🔴 …and says it grants nothing on THIS deployment, so the human reads the truth before they click");
  ok(line.includes("bundle configuration"), "…and says WHY, so it reads as a deployment fact rather than a property of the verb");
  const plainLine = describeDeclaredPermissions([`tool:${PLAIN}`])[0] ?? "";
  ok(
    plainLine.includes(`use the "${PLAIN}" tool`) && !plainLine.includes("grants nothing"),
    "…while an unraised write on the same connector still renders as a real permission (asserted POSITIVELY: a bare `!includes` would pass on an empty line)",
  );

  const raisedRoutine: Routine = { ...ROUTINE, id: "r-raised01" };
  const written = await armDeclaredRoutinePermissions({
    org: ORG,
    routine: raisedRoutine,
    declared: [`tool:${RAISED}`, `tool:${PLAIN}`],
    grantedBy: "U0HUMAN",
    tainted: false,
    nowIso: NOW,
  });
  ok(!written.includes(connectorToolPermissionKind(RAISED)), "🔴 the arming click writes NO row for a bundle-raised tool");
  ok(written.includes(connectorToolPermissionKind(PLAIN)), "…and still writes the one beside it, so the skip is the raise and not the whole card");
  ok(
    unarmedDeclarations([`tool:${RAISED}`, `tool:${PLAIN}`], written).includes(`tool:${RAISED}`),
    "🔴 …and the arming OUTCOME names it as NOT armed, rather than letting the human believe it is live",
  );
  ok(!unarmedDeclarations([`tool:${RAISED}`, `tool:${PLAIN}`], written).includes(`tool:${PLAIN}`), "…without dragging the armed declaration into that clause");

  const { bundleRaisedDeclarations } = await import("../agent/routines/declared-permissions.js");
  ok(
    JSON.stringify(bundleRaisedDeclarations([`tool:${RAISED}`, `tool:${PLAIN}`, "pr.open"])) === JSON.stringify([`tool:${RAISED}`]),
    "🔴 the caller is handed exactly the raised declarations — not the armable ones beside them, and not `pr.open`",
  );
  ok(JSON.stringify(bundleRaisedDeclarations([`tool:${PLAIN}`])) === JSON.stringify([]), "…and nothing at all when no declaration is raised, so the row is not written on an ordinary arm");

  {
    const { readAudit } = await import("../agent/audit/audit.js");
    const raisedPartition = { org: ORG, platform: "slack", workspace: "T1", surface: "C_RAISED", surfaceKey: "slack/T1/C_RAISED" } as unknown as Partition;
    const createKind = actionKind("routine.create");
    ok(createKind !== undefined, "the routine.create action kind is registered for the arming drive below");
    const armCard = (permissions: readonly string[], tainted: boolean): Promise<string> =>
      (createKind as { execute(a: RoutineCreateArgs, by: string): Promise<string> }).execute(
        {
          org: ORG,
          partition: raisedPartition,
          surfaceKey: "slack/T1/C_RAISED",
          target: { channelId: "C_RAISED" },
          trigger: ROUTINE.trigger,
          prompt: ROUTINE.prompt,
          createdBy: "U_AUTHOR",
          ...(tainted ? { tainted: true } : {}),
          permissions,
        },
        "U_CLICKER",
      );
    const neverLifts = async (): Promise<Record<string, unknown>[]> =>
      (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === ROUTINE_PERMISSION_NEVER_LIFTS_ACTION).map((r) => r.detail as Record<string, unknown>);

    ok((await neverLifts()).length === 0, "wiring precondition: no `never lifts` row exists yet, so a green below cannot be vacuous");

    const plainOutcome = await armCard([`tool:${PLAIN}`], false);
    ok((await neverLifts()).length === 0, "🔴 an arm with no raised declaration writes NO `never lifts` row");
    ok(plainOutcome.includes("standing permission to"), "…and that card really did arm, so the control is a control and not a failed click");

    const raisedOutcome = await armCard([`tool:${RAISED}`, `tool:${PLAIN}`], false);
    const rows = await neverLifts();
    ok(rows.length === 1, "🔴 arming a card carrying a config-raised declaration writes EXACTLY ONE `never lifts` row — the durable record this ticket exists for");
    ok(rows[0]?.["declaration"] === `tool:${RAISED}`, "…naming the declaration an operator has to read to fix it");
    ok(rows[0]?.["reason"] === "bundle-declared-destructive", "…and WHY, in the vocabulary of the config that decided it");
    ok(rows[0]?.["id"] === undefined || typeof rows[0]["id"] === "string", "…joined to the routine it was armed for");
    ok(raisedOutcome.includes(`NOT armed: "tool:${RAISED}"`), "🔴 …and the sentence the human reads names it as NOT armed, driven end to end rather than derived");
    ok(raisedOutcome.includes(`standing permission to`) && !raisedOutcome.includes(`NOT armed: "tool:${PLAIN}"`), "…while the armable declaration beside it still arms and is not dragged into the clause");

    const taintedOutcome = await armCard([`tool:${RAISED}`], true);
    ok((await neverLifts()).length === 1, "🔴 a TAINTED arm writes no `never lifts` row — the reason is taint, and the row must not claim otherwise");
    ok(taintedOutcome.includes("read external content"), "…and the outcome sentence gives the real reason instead");
  }

  const { declarableRoutinePermission } = await import("../agent/routines/permission-card.js");
  ok(declarableRoutinePermission(`tool:${RAISED}`) === undefined, "🔴 no permission card is planned for a bundle-raised tool — the click could only ever be theatre");
  ok(declarableRoutinePermission(`tool:${PLAIN}`)?.grantKind === connectorToolPermissionKind(PLAIN), "…while the unraised op on the same connector still cards");
}

console.log(`✓ routine-declared-permissions: ${passed} assertions passed`);
