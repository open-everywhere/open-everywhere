import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-routine-permission-card-"));
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_EGRESS_SPOOF = "1";
delete process.env.OE_ORG;

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const { requestApproval, resolveApprovalClick } = await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { addRoutine, updateRoutine } = await import("../agent/routines/store.js");
const { routineGrantKey } = await import("../agent/routines/routine.js");
const { ROUTINE_GRANT_NO_EXPIRY, listRoutinePermissions, revokeRoutinePermissions } = await import("../agent/routines/grants.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { decidedCardBlocks } = await import("../agent/approvals/card.js");
const { ROUTINE_PERMISSION_KIND } = await import("../agent/approvals/routine-permission.js");
const { routinePermissionAskedMemo, routinePermissionDeclinedMemo } = await import("../agent/approvals/session-grant.js");
const {
  declarableRoutinePermission,
  planRoutinePermissionCard,
  readRoutinePermissionCardState,
  routineGrantKeyParts,
  routinePermissionRefusalClause,
} = await import("../agent/routines/permission-card.js");

const ORG = "acme";
const SURFACE = "slack/T1/C_ROOM";
const store = getOperationalStore();

routineDispatch.registerRoutineDispatch("slack", {
  resolveTarget: (r) => {
    const channelId = (r.target as { channelId?: string } | undefined)?.channelId;
    if (!channelId) return null;
    return {
      channel: {} as never,
      target: { channelId },
      mode: "channel",
      attributes: {},
      origin: { platform: "slack", channelId },
    };
  },
});

const routine = await addRoutine(
  { org: ORG, surfaceKey: SURFACE } as never,
  {
    id: "r-nightly",
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C_ROOM" },
    trigger: { kind: "cron", cron: "0 3 * * *" },
    prompt: "Every night, open a pull request that bumps the changelog.",
    createdBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    status: "active",
  } as never,
);
const KEY = routineGrantKey(routine);

{
  const parts = routineGrantKeyParts(KEY);
  ok(parts?.routineId === "r-nightly" && parts.generation === 1, "§key: a real routine grant key yields its id and generation");
  ok(routineGrantKeyParts("slack:T1:C1:12345") === undefined, "§key: a window/session token is NOT a routine key");
  ok(routineGrantKeyParts("oe-routine:r-nightly") === undefined, "§key: a key with no generation is refused, never defaulted to g1");
  ok(routineGrantKeyParts("oe-routine:r-nightly:g0") === undefined, "§key: generation 0 is refused — no key is ever minted at g0");
  ok(routineGrantKeyParts("oe-routine:a:b:g1") === undefined, "§key: an extra segment is refused rather than parsed loosely");
  ok(routineGrantKeyParts("") === undefined, "§key: the empty string is refused");
}

{
  ok(declarableRoutinePermission("pr.open")?.grantKind === "pr.open", "§vocabulary: pr.open is declarable, and its grant kind is the memo kind the standing read uses");
  ok(declarableRoutinePermission("skill.create") === undefined, "§vocabulary: an injection-gate kind is NOT declarable, so it is never carded");
  ok(declarableRoutinePermission("memory.purge") === undefined, "§vocabulary: memory.purge is not declarable");
  ok(declarableRoutinePermission("spend.set") === undefined, "§vocabulary: a spend verb is not declarable");
}

{
  const now = () => new Date().toISOString();
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", now())) === "absent", "§state: nothing written yet reads as absent");
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionAskedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_GRANT_NO_EXPIRY });
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", now())) === "live", "§state: an ask-memo reads as a live card");
  ok((await readRoutinePermissionCardState(ORG, KEY, "connector.tool:notion__share_page", now())) === "absent", "§state: the memo is PER PERMISSION — one tool's card says nothing about another's");
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionDeclinedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_GRANT_NO_EXPIRY });
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", now())) === "declined", "§state: a decline WINS over a live ask — a declined permission never re-cards");
  ok((await readRoutinePermissionCardState(ORG, "oe-routine:r-nightly:g2", "pr.open", now())) === "absent", "§state: the rows are generation-scoped — the next generation starts clean");
  await store.revokeSessionApprovals(ORG, KEY);
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", now())) === "absent", "§state: revoking the routine's rows clears both memos");
}

const baseOffer = {
  org: ORG,
  actionKind: "pr.open",
  grantKey: KEY,
  scopeKey: SURFACE,
  domain: null,
  requestedBy: "U_OWNER",
  tainted: false,
  nowIso: new Date().toISOString(),
};
{
  const plan = await planRoutinePermissionCard(baseOffer);
  ok(plan.state === "absent" && plan.card !== undefined, "§plan: a first refusal on a declarable kind plans a card");
  ok(plan.card?.kind === ROUTINE_PERMISSION_KIND, "§plan: the card is the routine.permission kind");
  ok(plan.card?.channelId === "C_ROOM", "§plan: the card is aimed at the ROUTINE's own room, not the proposing venue");
  ok(plan.card?.noClockExpiry === true, "§plan: the card asks for no clock — the routine generation is its bound");
  ok(plan.card?.threadTs === null, "§plan: the card posts top level, not into a fire's thread");
  const args = plan.card?.args as { grantKey?: string; grantKind?: string; declaration?: string; prompt?: string };
  ok(args.grantKey === KEY && args.grantKind === "pr.open" && args.declaration === "pr.open", "§plan: the frozen args name the generation key and the row a click writes");
  ok((args.prompt ?? "").includes("bumps the changelog"), "§plan: the card shows the instruction the permission would serve");
  ok((plan.card?.summaryLines ?? []).join(" ").includes("declining is remembered"), "§plan: the card says out loud that a decline is durable");

  ok((await planRoutinePermissionCard({ ...baseOffer, tainted: true })).state === "n/a", "§plan: a TAINTED turn plans nothing — no standing grant is ever asked for off fetched content");
  ok((await planRoutinePermissionCard({ ...baseOffer, actionKind: "skill.create" })).state === "n/a", "§plan: a non-declarable kind plans nothing");
  ok((await planRoutinePermissionCard({ ...baseOffer, grantKey: "slack:T1:C1:9" })).state === "n/a", "§plan: a non-routine grant key plans nothing");
  ok((await planRoutinePermissionCard({ ...baseOffer, grantKey: "oe-routine:r-missing:g1" })).state === "n/a", "§plan: a key naming no stored routine plans nothing rather than guessing a room");
  ok((await planRoutinePermissionCard({ ...baseOffer, org: "other-org" })).state === "n/a", "§plan: the routine lookup is org-scoped");
}

const proposal = {
  org: ORG,
  kind: "pr.open",
  args: { org: ORG, scopeKey: SURFACE, repo: "acme/site", head: "bump", base: "main", title: "bump", body: "", headSha: "abc", requestedBy: "U_OWNER", tainted: false, sessionId: KEY },
  scopeKey: SURFACE,
  domain: null,
  requestedBy: "U_OWNER",
  channelId: "C_ELSEWHERE",
  chain: { unattended: true },
};
async function refuse(input: unknown): Promise<string> {
  try {
    await requestApproval(input as never, {});
    return "";
  } catch (e) {
    return String(e);
  }
}
const cardsFor = async (kind: string): Promise<{ id: string; expiresAt: string; channelId: string; argsJson: string }[]> =>
  (await store.listPendingActions(ORG)).filter((r) => r.kind === kind) as never;
{
  const first = await refuse(proposal);
  ok(first.includes("ask-unattended"), "§refusal: the run is STILL refused — the card decides the next run, never this one");
  const rows = await cardsFor(ROUTINE_PERMISSION_KIND);
  ok(rows.length === 1, "§refusal: one permission card row landed");
  ok(rows[0]?.channelId === "C_ROOM", "§refusal: it landed in the ROUTINE's room, not the room the refused proposal named");
  ok(rows[0]?.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "§refusal: the card row carries no clock expiry");
  ok(first.includes("is now waiting in the routine's own room"), "§refusal: the refusal tells the model a card was posted");
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())) === "live", "§refusal: the ask-memo is written after the post");

  const second = await refuse(proposal);
  ok(second.includes("ask-unattended"), "§refusal: the second fire is refused too");
  ok((await cardsFor(ROUTINE_PERMISSION_KIND)).length === 1, "§refusal: ONE card per permission per generation — no second card is posted");
  ok(second.includes("is already waiting"), "§refusal: the second refusal names the live card instead of claiming a fresh one");

  const plain = await refuse({ ...proposal, args: { ...proposal.args, sessionId: "slack:T1:C1:77" }, channelId: "C_OTHER" });
  ok(plain.includes("ask-unattended") && !plain.includes("routine's own room"), "§refusal: a fire with no routine key gets the byte-identical old refusal");
  ok((await cardsFor(ROUTINE_PERMISSION_KIND)).length === 1, "§refusal: and it mints no card");
}

{
  const kind = actionKind(ROUTINE_PERMISSION_KIND);
  ok(kind?.policy === "member", "§click: the card's bar is `member`, matching the creation card that declares the same row");
  ok(typeof kind?.declined === "function", "§click: the kind declares the durable-decline hook");

  const row = (await cardsFor(ROUTINE_PERMISSION_KIND))[0]!;
  const args = JSON.parse(row.argsJson) as never;

  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 2 });
  let staleErr = "";
  try {
    await kind!.execute(args, "U_CLICKER");
  } catch (e) {
    staleErr = String(e);
  }
  ok(staleErr.includes("has been edited"), "§click: a click on a card posted before an edit REFUSES — this is what makes a card with no clock safe");
  ok((await store.getSessionApproval(ORG, KEY, "pr.open", new Date().toISOString())) === null, "§click: and it armed NOTHING");

  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 1 });
  const line = await kind!.execute(args, "U_CLICKER");
  const granted = await store.getSessionApproval(ORG, KEY, "pr.open", new Date().toISOString());
  ok(granted !== null, "§click: approve writes exactly the standing row open_pull_request's session skip reads");
  ok(granted?.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "§click: the standing row has no TTL — the generation is its death mechanism");
  ok(granted?.grantedBy === "U_CLICKER", "§click: the row records the human who armed it");
  ok(line.includes("r-nightly"), "§click: the outcome line names the routine");

  const res = await resolveApprovalClick({ org: ORG, id: row.id, clickerId: "U_CLICKER", decision: "reject" } as never);
  ok(res.outcome === "decided", "§click: the reject decides the card");
  ok((res as { executed?: string }).executed === "none", "§click: a reject runs no execute");
  const declineLine = (res as { outcomeLine?: string }).outcomeLine ?? "";
  ok(declineLine.includes("will not ask"), "§click: the decline's own line comes back as the outcome line, so a human is told what was recorded");
  ok(
    decidedCardBlocks((res as unknown as { row: never }).row, (res as { summaryLines: string[] }).summaryLines, declineLine).text.includes(declineLine),
    "§click: and the decided card RENDERS it — a hook whose result were discarded would promise durability nobody could read",
  );
  ok(
    (await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())) === "declined",
    "§click: rejecting the card writes the DURABLE decline through the real click path — later fires refuse quietly",
  );
  ok(
    (await planRoutinePermissionCard({ ...baseOffer, actionKind: "pr.open" })).state === "declined",
    "§click: and the planner will not post a fresh card over a declined one",
  );

  await store.revokeSessionApprovals(ORG, KEY);
  await refuse({ ...proposal, args: { ...proposal.args, title: "before the edit" } });
  const staleRow = (await cardsFor(ROUTINE_PERMISSION_KIND))[0]!;
  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 3 });
  const staleRes = await resolveApprovalClick({ org: ORG, id: staleRow.id, clickerId: "U_CLICKER", decision: "reject" } as never);
  ok(staleRes.outcome === "decided", "§click: a superseded card is STILL clickable — nothing pre-expired it out from under the human");
  const staleLine = (staleRes as { outcomeLine?: string }).outcomeLine ?? "";
  ok(staleLine.includes("nothing was remembered"), "§click: and the decline reports that it recorded nothing");
  ok(staleLine.includes("has been edited"), "§click: naming the reason, so the clicker can act on it");
  ok(
    decidedCardBlocks((staleRes as unknown as { row: never }).row, (staleRes as { summaryLines: string[] }).summaryLines, staleLine).text.includes(staleLine),
    "§click: and the decided card RENDERS it rather than showing a bare 'Rejected' the human would read as success",
  );
  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 1 });
  ok(
    (await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())) === "live",
    "§click: the stale decline wrote no decline row, so the live generation is free to ask again",
  );
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  const cards = () => store.listPendingActions(ORG).then((rs) => rs.filter((r) => r.kind === ROUTINE_PERMISSION_KIND));
  ok((await cards()).length === 0, "§residue: no permission card is pending to start with");

  await refuse({ ...proposal, args: { ...proposal.args, title: "generation one" } });
  const g1 = await cards();
  ok(g1.length === 1 && g1[0]!.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "§residue: the generation-1 card is pending with no clock");

  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 4 });
  const liveKey = "oe-routine:r-nightly:g4";
  ok((await refuse({ ...proposal, args: { ...proposal.args, sessionId: liveKey, title: "generation four" } })).includes("ask-unattended"), "§residue: the fire on the new generation is refused");
  const both = await cards();
  ok(both.length === 2, "§residue: BOTH rows are pending — the superseded one is not silently expired");
  ok(
    (await store.getPendingAction(ORG, g1[0]!.id))?.status === "pending",
    "§residue: the old card keeps its buttons, so a click on it reaches the kind and is told the routine has been edited",
  );
  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 1 });
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  await store.setSessionApproval({
    org: ORG,
    sessionId: KEY,
    kind: routinePermissionDeclinedMemo("pr.open"),
    grantedBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    expiresAt: ROUTINE_GRANT_NO_EXPIRY,
  });
  const before = (await cardsFor(ROUTINE_PERMISSION_KIND)).length;
  const quiet = await refuse({ ...proposal, args: { ...proposal.args, title: "bump again" } });
  ok(quiet.includes("already declined this permission"), "§refusal: a declined permission refuses with the honest sentence, not a bare gate error");
  ok((await cardsFor(ROUTINE_PERMISSION_KIND)).length === before, "§refusal: and posts no card at all");
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  routineDispatch.registerRoutineDispatch("teams", {
    resolveTarget: (r) => ({
      channel: {} as never,
      target: { channelId: (r.target as { channelId?: string } | undefined)?.channelId ?? "" },
      mode: "channel",
      attributes: {},
    }),
  });
  const teamsRoutine = await addRoutine({ org: ORG, surfaceKey: "teams/T9/CONV9" } as never, {
    id: "r-teams",
    org: ORG,
    surfaceKey: "teams/T9/CONV9",
    target: { channelId: "19:abc@thread.tacv2" },
    trigger: { kind: "cron", cron: "0 3 * * *" },
    prompt: "Nightly, open a pull request.",
    createdBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    status: "active",
  } as never);
  const teamsKey = routineGrantKey(teamsRoutine);
  const before = (await store.listPendingActions(ORG)).length;
  const threw = await refuse({ ...proposal, args: { ...proposal.args, sessionId: teamsKey }, scopeKey: "teams/T9/CONV9" });
  ok(threw.includes("ask-unattended"), "§room: the Teams fire is still refused");
  ok(!threw.includes("routine's own room"), "§room: and the refusal claims no card");
  ok((await store.listPendingActions(ORG)).length === before, "§room: no card row is minted for a platform with no approval-card path");
  ok(
    (await readRoutinePermissionCardState(ORG, teamsKey, "pr.open", new Date().toISOString())) === "absent",
    "§room: and no ask-memo is written, so nothing is silently suppressed",
  );
}

{
  const silent = await addRoutine({ org: ORG, surfaceKey: SURFACE } as never, {
    id: "r-silent",
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C_ROOM" },
    trigger: { kind: "cron", cron: "0 3 * * *" },
    report: { kind: "silent" },
    prompt: "Nightly, open a pull request and say nothing.",
    createdBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    status: "active",
  } as never);
  const silentKey = routineGrantKey(silent);
  const plan = await planRoutinePermissionCard({ ...baseOffer, grantKey: silentKey });
  ok(plan.state === "n/a" && plan.card === undefined, "§silent: a silent routine plans no card — its declared silence holds");
  const before = (await cardsFor(ROUTINE_PERMISSION_KIND)).length;
  const threw = await refuse({ ...proposal, args: { ...proposal.args, sessionId: silentKey, title: "silent fire" } });
  ok(threw.includes("ask-unattended"), "§silent: the silent routine's fire is still refused");
  ok(!threw.includes("routine's own room"), "§silent: and the refusal claims no card");
  ok((await cardsFor(ROUTINE_PERMISSION_KIND)).length === before, "§silent: no card row is minted, so an edit_routine grant is still the way in");
  ok(
    (await readRoutinePermissionCardState(ORG, silentKey, "pr.open", new Date().toISOString())) === "absent",
    "§silent: and no ask-memo is written",
  );
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  const now = () => new Date().toISOString();
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionAskedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_GRANT_NO_EXPIRY });
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionDeclinedMemo("connector.tool:notion__share_page"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_GRANT_NO_EXPIRY });
  ok((await listRoutinePermissions(ORG, routine, now())).length === 0, "§readers: markers alone are NOT permissions — list_routines shows none");
  const markerRevoke = await revokeRoutinePermissions(ORG, routine);
  ok(markerRevoke.grants === 0, "§readers: revoking counts NO grants, so the tool cannot report authority that was never held");
  ok(markerRevoke.rows === 2, `§readers: but it reports the rows it deleted, so a call that destroyed a human's durable decline still audits (got ${markerRevoke.rows})`);
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", now())) === "absent", "§readers: the revoke still clears the markers — a revoke is a clean slate and the routine may ask again");

  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: "pr.open", grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_GRANT_NO_EXPIRY });
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionAskedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_GRANT_NO_EXPIRY });
  const held = await listRoutinePermissions(ORG, routine, now());
  ok(held.length === 1 && held[0] === "open pull requests", "§readers: a REAL grant beside a marker is still listed, and listed alone");
  const mixedRevoke = await revokeRoutinePermissions(ORG, routine);
  ok(mixedRevoke.grants === 1, "§readers: the reported count is the GRANT, not the grant plus its bookkeeping");
  ok(mixedRevoke.rows === 2, "§readers: while the deleted-row count sees both — two numbers, two questions");
}

{
  const clause = routinePermissionRefusalClause("n/a", false);
  ok(clause === "", "§expiry: the n/a state says NOTHING — it must never describe a card that was not considered");
  ok(routinePermissionRefusalClause("absent", false) === "", "§expiry: a card that failed to post is not announced either");
  ok(routinePermissionRefusalClause("absent", true).includes("now waiting"), "§expiry: a posted card is");

  const res = await requestApproval(
    {
      org: ORG,
      kind: "pr.open",
      args: { org: ORG, scopeKey: SURFACE, repo: "acme/site", head: "attended", base: "main", title: "attended", body: "", headSha: "def", requestedBy: "U_OWNER", tainted: false },
      scopeKey: SURFACE,
      domain: null,
      requestedBy: "U_OWNER",
      channelId: "C_ROOM",
      chain: { unattended: false },
    } as never,
    {},
  );
  const ttlHours = (Date.parse(res.expiresAt) - Date.now()) / 3_600_000;
  ok(res.expiresAt !== ROUTINE_GRANT_NO_EXPIRY && ttlHours > 23 && ttlHours < 25, `§expiry: an ordinary card is unaffected — it still expires on approvals.ttlHours (got ${ttlHours.toFixed(2)}h)`);
}

{
  const prRow = (await store.listPendingActions(ORG)).find((r) => r.kind === "pr.open" && r.status === "pending");
  ok(prRow !== undefined, "§click: the attended pr.open card is pending");
  const res = await resolveApprovalClick({
    org: ORG,
    id: prRow!.id,
    clickerId: "U_ADMIN",
    decision: "reject",
    isAdmin: true,
    isMember: true,
  } as never);
  ok(res.outcome === "decided", "§click: a reject on a hookless kind still decides");
  ok((res as { outcomeLine?: string }).outcomeLine === "rejected", "§click: and its outcome line is the literal 'rejected' — the renderers stay byte-identical for every kind without the hook");
  const blocks = decidedCardBlocks((res as unknown as { row: never }).row, (res as { summaryLines: string[] }).summaryLines, "rejected");
  const context = blocks.text.split("\n").at(-1);
  ok(context === "❌ Rejected by <@U_ADMIN>", `§click: a hookless kind's decided card is byte-identical — no appended outcome clause (got ${String(context)})`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ routine permission card: ${passed} assertions passed`);
