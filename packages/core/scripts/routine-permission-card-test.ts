import { __setTestValveForTest } from "../agent/testing/test-valves.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

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
__setTestValveForTest("egress-spoof", true);
_setDeploymentIdentityForTest({ org: undefined });

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
overrideSettingsForTest({ approvals: { routineCardWaitSeconds: 0 } });

const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const { registerCardPoster, reapSupersededRoutineCards, requestApproval, resolveApprovalClick, sweepExpiredPendings } = await import("../agent/approvals/flow.js");
const { registerSurfaceMessageOps } = await import("../agent/channels/surface-message-ops.js");
const { consumeRoutineRunPermissionRefusals, noteRoutineRunPermissionRefusal, carryRunRefusalsToRedrive, dropCarriedRunRefusals } = await import("../agent/approvals/card-signal.js");
const { resetTurnClock } = await import("../agent/observability/turn-clock.js");
const { RUN_REFUSAL_HEADING, withRunRefusalBlock } = await import("../agent/routines/report.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { addRoutine, removeRoutine, updateRoutine } = await import("../agent/routines/store.js");
const { routinePermissionKey } = await import("../agent/routines/routine.js");
const { ROUTINE_PERMISSION_NO_EXPIRY, listRoutinePermissions, revokeRoutinePermissions } = await import("../agent/routines/declared-permissions.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { decidedCardBlocks } = await import("../agent/approvals/card.js");
const { ROUTINE_PERMISSION_KIND } = await import("../agent/approvals/routine-permission.js");
const { routinePermissionAskedMemo, routinePermissionDeclinedMemo } = await import("../agent/approvals/session-grant.js");
const {
  declarableRoutinePermission,
  planRoutinePermissionCard,
  readRoutinePermissionCardState,
  routinePermissionKeyParts,
  routinePermissionRefusalClause,
} = await import("../agent/routines/permission-card.js");

class FakeSession {
  private readonly slots = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.slots.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.slots.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.slots.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}
function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}
async function inSession<T>(fn: () => T | Promise<T>): Promise<T> {
  return eveContextStorage().run(new FakeSession(), fn);
}

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
const KEY = routinePermissionKey(routine);

{
  const parts = routinePermissionKeyParts(KEY);
  ok(parts?.routineId === "r-nightly" && parts.generation === 1, "§key: a real routine permission key yields its id and generation");
  ok(routinePermissionKeyParts("slack:T1:C1:12345") === undefined, "§key: a window/session token is NOT a routine key");
  ok(routinePermissionKeyParts("oe-routine:r-nightly") === undefined, "§key: a key with no generation is refused, never defaulted to g1");
  ok(routinePermissionKeyParts("oe-routine:r-nightly:g0") === undefined, "§key: generation 0 is refused — no key is ever minted at g0");
  ok(routinePermissionKeyParts("oe-routine:a:b:g1") === undefined, "§key: an extra segment is refused rather than parsed loosely");
  ok(routinePermissionKeyParts("") === undefined, "§key: the empty string is refused");
}

{
  ok(declarableRoutinePermission("pr.open")?.grantKind === "pr.open", "§vocabulary: pr.open is declarable, and its grant kind is the memo kind the standing read uses");
  ok(declarableRoutinePermission("skill.create") === undefined, "§vocabulary: an injection-gate kind is NOT declarable, so it is never carded");
  ok(declarableRoutinePermission("memory.purge") === undefined, "§vocabulary: memory.purge is not declarable");
  ok(declarableRoutinePermission("spend.set") === undefined, "§vocabulary: a spend verb is not declarable");
  ok(
    declarableRoutinePermission("tool:notion__create_page")?.grantKind === "connector.tool:notion__create_page",
    "§vocabulary: a WRITE-tier connector tool is declarable, and its grant kind is the per-tool kind the fence's lift arm reads",
  );
  ok(
    declarableRoutinePermission("tool:notion__delete_page") === undefined,
    "🔴 §vocabulary: a DELETE-tier connector tool is NOT declarable — the planner applies routines/declared-permissions.ts's own tier test, so a card is refused here even before the fence's guard",
  );
  ok(declarableRoutinePermission("tool:notion") === undefined, "§vocabulary: a connection-shaped declaration names no tool, so it is not declarable");
  ok(declarableRoutinePermission("tool:grant__notion__read") === undefined, "§vocabulary: the RESERVED grant namespace belongs to the credential-grant plane, not this one");
}

{
  const now = () => new Date().toISOString();
  const stateOf = async (key: string, kind: string): Promise<string> => (await readRoutinePermissionCardState(ORG, key, kind, now())).state;
  ok((await stateOf(KEY, "pr.open")) === "absent", "§state: nothing written yet reads as absent");
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionAskedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  ok((await stateOf(KEY, "pr.open")) === "lapsed", "🔴 §state: an ask-memo with NO pending row reads as LAPSED, never live — the memo outlives the card, so it cannot assert one is waiting");
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", now())).cardId === undefined, "§state: and a lapsed read names no card, because it found none");
  ok((await stateOf(KEY, "connector.tool:notion__share_page")) === "absent", "§state: the memo is PER PERMISSION — one tool's card says nothing about another's");
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionDeclinedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  ok((await stateOf(KEY, "pr.open")) === "declined", "§state: a decline WINS over a live ask — a declined permission never re-cards");
  ok((await stateOf("oe-routine:r-nightly:g2", "pr.open")) === "absent", "§state: the rows are generation-scoped — the next generation starts clean");
  await store.revokeSessionApprovals(ORG, KEY);
  ok((await stateOf(KEY, "pr.open")) === "absent", "§state: revoking the routine's rows clears both memos");
}

const baseOffer = {
  org: ORG,
  declaration: "pr.open",
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
  ok((await planRoutinePermissionCard({ ...baseOffer, declaration: "skill.create" })).state === "n/a", "§plan: a non-declarable kind plans nothing");
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
  ok(rows[0]?.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY, "§refusal: the card row carries no clock expiry");
  ok(first.includes("is now waiting in the routine's own room"), "§refusal: the refusal tells the model a card was posted");
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())).state === "live", "§refusal: the ask-memo is written after the post");

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
  ok(granted?.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY, "§click: the standing row has no TTL — the generation is its death mechanism");
  ok(granted?.grantedBy === "U_CLICKER", "§click: the row records the human who armed it");
  ok(line.startsWith("the routine may now use pr open on its own"), "§click: the outcome line names the routine and the permission in plain words");
  ok(!line.includes("r-nightly"), "§click: the outcome line shows no raw routine id");
  ok(
    JSON.stringify(decidedCardBlocks({ ...(row as never as object), status: "approved", decidedBy: "U_CLICKER" } as never, kind!.summarize(args), line).metadata?.event_payload["detail"]).includes("r-nightly"),
    "§click: the decided card's metadata detail still names the routine id",
  );

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
    (await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())).state === "declined",
    "§click: rejecting the card writes the DURABLE decline through the real click path — later fires refuse quietly",
  );
  ok(
    (await planRoutinePermissionCard({ ...baseOffer, declaration: "pr.open" })).state === "declined",
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
    (await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())).state === "lapsed",
    "🔴 §click: an answered card whose answer stuck to NOTHING leaves the memo and no row — lapsed, never live",
  );
  const afterLapse = await planRoutinePermissionCard({ ...baseOffer, declaration: "pr.open" });
  ok(afterLapse.state === "lapsed" && afterLapse.card !== undefined, "🔴 §click: and the planner posts a FRESH card over a lapsed one — OPE-1290's rule that a card posts once the old row is really gone");
  const relapsed = await refuse(proposal);
  ok(relapsed.includes("is now waiting in the routine's own room"), "§click: so the next real fire announces a new card rather than pointing at the dead one");
  ok((await cardsFor(ROUTINE_PERMISSION_KIND)).length === 1, "§click: exactly one — the fresh card, with nothing left of the answered one");
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())).state === "live", "§click: and THAT state is live, because a pending row now says so");
  await store.revokeSessionApprovals(ORG, KEY);
  for (const row of await cardsFor(ROUTINE_PERMISSION_KIND)) {
    await store.decidePendingAction(ORG, row.id, "expired", "system", new Date().toISOString());
  }
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  const cards = () => store.listPendingActions(ORG).then((rs) => rs.filter((r) => r.kind === ROUTINE_PERMISSION_KIND));
  ok((await cards()).length === 0, "§residue: no permission card is pending to start with");

  await refuse({ ...proposal, args: { ...proposal.args, title: "generation one" } });
  const g1 = await cards();
  ok(g1.length === 1 && g1[0]!.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY, "§residue: the generation-1 card is pending with no clock");

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
    expiresAt: ROUTINE_PERMISSION_NO_EXPIRY,
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
  const teamsKey = routinePermissionKey(teamsRoutine);
  const before = (await store.listPendingActions(ORG)).length;
  const threw = await refuse({ ...proposal, args: { ...proposal.args, sessionId: teamsKey }, scopeKey: "teams/T9/CONV9" });
  ok(threw.includes("ask-unattended"), "§room: the Teams fire is still refused");
  ok(!threw.includes("routine's own room"), "§room: and the refusal claims no card");
  ok((await store.listPendingActions(ORG)).length === before, "§room: no card row is minted for a platform with no approval-card path");
  ok(
    (await readRoutinePermissionCardState(ORG, teamsKey, "pr.open", new Date().toISOString())).state === "absent",
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
  const silentKey = routinePermissionKey(silent);
  const plan = await planRoutinePermissionCard({ ...baseOffer, grantKey: silentKey });
  ok(plan.state === "n/a" && plan.card === undefined, "§silent: a silent routine plans no card — its declared silence holds");
  const before = (await cardsFor(ROUTINE_PERMISSION_KIND)).length;
  const threw = await refuse({ ...proposal, args: { ...proposal.args, sessionId: silentKey, title: "silent fire" } });
  ok(threw.includes("ask-unattended"), "§silent: the silent routine's fire is still refused");
  ok(!threw.includes("routine's own room"), "§silent: and the refusal claims no card");
  ok((await cardsFor(ROUTINE_PERMISSION_KIND)).length === before, "§silent: no card row is minted, so an edit_routine declaration is still the way in");
  ok(
    (await readRoutinePermissionCardState(ORG, silentKey, "pr.open", new Date().toISOString())).state === "absent",
    "§silent: and no ask-memo is written",
  );
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  const now = () => new Date().toISOString();
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionAskedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionDeclinedMemo("connector.tool:notion__share_page"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  ok((await listRoutinePermissions(ORG, routine, now())).length === 0, "§readers: markers alone are NOT permissions — list_routines shows none");
  const markerRevoke = await revokeRoutinePermissions(ORG, routine);
  ok(markerRevoke.permissions === 0, "§readers: revoking counts NO permissions, so the tool cannot report authority that was never held");
  ok(markerRevoke.rows === 2, `§readers: but it reports the rows it deleted, so a call that destroyed a human's durable decline still audits (got ${markerRevoke.rows})`);
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", now())).state === "absent", "§readers: the revoke still clears the markers — a revoke is a clean slate and the routine may ask again");

  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: "pr.open", grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  await store.setSessionApproval({ org: ORG, sessionId: KEY, kind: routinePermissionAskedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: now(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  const held = await listRoutinePermissions(ORG, routine, now());
  ok(held.length === 1 && held[0] === "open pull requests", "§readers: a REAL permission beside a marker is still listed, and listed alone");
  const mixedRevoke = await revokeRoutinePermissions(ORG, routine);
  ok(mixedRevoke.permissions === 1, "§readers: the reported count is the PERMISSION, not the permission plus its bookkeeping");
  ok(mixedRevoke.rows === 2, "§readers: while the deleted-row count sees both — two numbers, two questions");
}

{
  const DISCORD_SURFACE = "discord/G1/C_DISCORD";
  const PERMALINK = "https://discord.test/channels/G1/C_DISCORD/999";
  routineDispatch.registerRoutineDispatch("discord", {
    resolveTarget: (r) => {
      const channelId = (r.target as { channelId?: string } | undefined)?.channelId;
      if (!channelId) return null;
      return {
        channel: {} as never,
        target: { channelId },
        mode: "channel",
        attributes: {},
        origin: { platform: "discord", channelId, guildId: "G1" },
      };
    },
  });
  registerCardPoster("discord", async () => undefined);
  let asked: { channelId: string; messageId: string; workspace?: string } | undefined;
  registerSurfaceMessageOps({
    platform: "discord",
    postText: async () => undefined,
    editMessage: async () => undefined,
    permalink: async (ref: { channelId: string; messageId: string; workspace?: string }) => {
      asked = ref;
      return PERMALINK;
    },
  } as never);

  const dRoutine = await addRoutine({ org: ORG, surfaceKey: DISCORD_SURFACE } as never, {
    id: "r-discord",
    org: ORG,
    surfaceKey: DISCORD_SURFACE,
    target: { channelId: "C_DISCORD" },
    trigger: { kind: "cron", cron: "0 4 * * *" },
    prompt: "Every morning, open a pull request that bumps the changelog.",
    createdBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    status: "active",
  } as never);
  const dKey = routinePermissionKey(dRoutine);

  const posted = await refuse({ ...proposal, args: { ...proposal.args, scopeKey: DISCORD_SURFACE, sessionId: dKey }, scopeKey: DISCORD_SURFACE });
  ok(posted.includes("is now waiting in the routine's own room"), "§pointer: the discord fire posts a card and says so");
  ok(posted.includes(PERMALINK), "🔴 §pointer: and the refusal carries the PERMALINK to it — the pointer OPE-1290 asked for");
  ok(asked?.channelId === "C_DISCORD", "§pointer: the reference is addressed at the card's OWN channel, read back off its row");
  ok(asked?.workspace === "G1", "§pointer: with the workspace segment off `postedTo`, which is what a permalink needs beside the ids");
  ok(typeof asked?.messageId === "string" && (asked?.messageId.length ?? 0) > 0, "§pointer: and the message id `setPendingActionMessage` wrote — never an invented one");

  const again = await refuse({ ...proposal, args: { ...proposal.args, scopeKey: DISCORD_SURFACE, sessionId: dKey, title: "second" }, scopeKey: DISCORD_SURFACE });
  ok(again.includes("is already waiting"), "§pointer: the second fire re-points at the live card");
  ok(again.includes(PERMALINK), "🔴 §pointer: and carries the permalink too — the `live` arm resolves it off the row the state was derived from");

  await store.revokeSessionApprovals(ORG, KEY);
  for (const row of await cardsFor(ROUTINE_PERMISSION_KIND)) {
    if (row.channelId === "C_ROOM") await store.decidePendingAction(ORG, row.id, "expired", "system", new Date().toISOString());
  }
  const slackPost = await refuse(proposal);
  ok(slackPost.includes("is now waiting in the routine's own room"), "§pointer: the slack fire still names the room");
  ok(!slackPost.includes("http"), "🔴 §pointer: and quotes NO url — a surface whose lookup failed degrades to the room, never to a guess");
  ok(
    slackPost.includes("A permission card for this is now waiting in the routine's own room \u2014 approving it lets future runs do this without asking."),
    "§pointer: byte-for-byte the pre-OPE-1356 sentence, so the fallback is a fallback and not a rewrite",
  );

  ok(routinePermissionRefusalClause("live", false, "https://x.test/1").endsWith(": https://x.test/1."), "§pointer: the clause appends the url it is given");
  ok(!routinePermissionRefusalClause("live", false, "").includes(":"), "§pointer: an EMPTY permalink is an absent one — never a bare colon");
  ok(!routinePermissionRefusalClause("live", false).includes("http"), "§pointer: and no permalink means no url");
  ok(routinePermissionRefusalClause("declined", false, "https://x.test/1").includes("already declined"), "§pointer: a declined state carries no pointer — there is no card to open");
  ok(!routinePermissionRefusalClause("declined", false, "https://x.test/1").includes("http"), "§pointer: and quotes none");
  ok(routinePermissionRefusalClause("unreadable", false).includes("could not be read"), "§pointer: an unreadable card store SAYS so, and claims nothing about a card");
  const unreadable = routinePermissionRefusalClause("unreadable", false);
  ok(!unreadable.includes("is already waiting") && !unreadable.includes("is now waiting"), "🔴 §pointer: and never ASSERTS one is waiting — the claim a failed read could not earn");
  ok(!unreadable.includes("http"), "§pointer: an unreadable state quotes no url either");
}

{
  const DISCORD_SURFACE = "discord/G1/C_DISCORD";
  const PERMALINK = "https://discord.test/channels/G1/C_DISCORD/999";
  await store.revokeSessionApprovals(ORG, "oe-routine:r-discord:g1");
  for (const row of await cardsFor(ROUTINE_PERMISSION_KIND)) {
    await store.decidePendingAction(ORG, row.id, "expired", "system", new Date().toISOString());
  }

  const quiet = await inSession(async () => {
    await refuse({ ...proposal, args: { ...proposal.args, sessionId: "slack:T1:C1:77" }, channelId: "C_OTHER" });
    return consumeRoutineRunPermissionRefusals();
  });
  ok(quiet.length === 0, "§runreport: a fire with no routine key loses no permission, so the run's ledger stays empty");

  const dKey = "oe-routine:r-discord:g1";
  const first = await inSession(async () => {
    await refuse({ ...proposal, args: { ...proposal.args, scopeKey: DISCORD_SURFACE, sessionId: dKey }, scopeKey: DISCORD_SURFACE });
    return consumeRoutineRunPermissionRefusals();
  });
  ok(first.length === 1, "🔴 §runreport: the real refusal path RECORDS the loss on this run's ledger");
  ok(first[0]?.permission === "open pull requests", "§runreport: named in the same plain language list_routines uses for a live permission");
  ok(first[0]?.card === PERMALINK, "🔴 §runreport: with a POINTER to the still-open card, which is what makes the line actionable");

  const drained = await inSession(async () => consumeRoutineRunPermissionRefusals());
  ok(drained.length === 0, "§runreport: the ledger is read-and-reset, so a second post in the same turn does not repeat the block");

  const twice = await inSession(async () => {
    await refuse({ ...proposal, args: { ...proposal.args, scopeKey: DISCORD_SURFACE, sessionId: dKey, title: "a" }, scopeKey: DISCORD_SURFACE });
    await refuse({ ...proposal, args: { ...proposal.args, scopeKey: DISCORD_SURFACE, sessionId: dKey, title: "b" }, scopeKey: DISCORD_SURFACE });
    return consumeRoutineRunPermissionRefusals();
  });
  ok(twice.length === 1, "§runreport: one line per PERMISSION — a run that hit the same gate twice says it once");

  await store.setSessionApproval({ org: ORG, sessionId: dKey, kind: routinePermissionDeclinedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: new Date().toISOString(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  const declinedRun = await inSession(async () => {
    await refuse({ ...proposal, args: { ...proposal.args, scopeKey: DISCORD_SURFACE, sessionId: dKey, title: "c" }, scopeKey: DISCORD_SURFACE });
    return consumeRoutineRunPermissionRefusals();
  });
  ok(declinedRun.length === 1 && declinedRun[0]?.card === null, "🔴 §runreport: a previously DECLINED permission is still listed, with a null pointer — the run could not do it either");
  await store.revokeSessionApprovals(ORG, dKey);

  await store.revokeSessionApprovals(ORG, dKey);
  await store.setSessionApproval({ org: ORG, sessionId: dKey, kind: routinePermissionAskedMemo("pr.open"), grantedBy: "U_OWNER", createdAt: new Date().toISOString(), expiresAt: ROUTINE_PERMISSION_NO_EXPIRY });
  const blindCardsBefore = (await cardsFor(ROUTINE_PERMISSION_KIND)).length;
  const realList = store.listPendingActions.bind(store);
  (store as { listPendingActions: unknown }).listPendingActions = async (): Promise<never> => {
    throw new Error("card store is down");
  };
  let blind: readonly { permission: string; card: string | null; cardKnown: boolean; cardPosted: boolean; cardCapped: boolean }[];
  try {
    blind = await inSession(async () => {
      await refuse({ ...proposal, args: { ...proposal.args, scopeKey: DISCORD_SURFACE, sessionId: dKey, title: "d" }, scopeKey: DISCORD_SURFACE });
      return consumeRoutineRunPermissionRefusals();
    });
  } finally {
    (store as { listPendingActions: unknown }).listPendingActions = realList;
  }
  const blindCards = (await cardsFor(ROUTINE_PERMISSION_KIND)).length;
  ok(blind.length === 1 && blind[0]?.cardKnown === false, "🔴 §runreport: a run whose card store could not be read records the loss with the card's fate UNKNOWN");
  ok(blindCards === blindCardsBefore, "🔴 §runreport: and an UNREADABLE card store posts NO second card — the whole reason `unreadable` is kept apart from `lapsed`");
  ok(withRunRefusalBlock("body", blind).includes("couldn't check"), "🔴 §runreport: and renders that, never the 'no card is waiting' line that would send its owner to an edit");
  ok(!withRunRefusalBlock("body", blind).includes("no approval request is open"), "🔴 §runreport: …explicitly not that line");
  ok(declinedRun[0]?.cardKnown === true, "§runreport: while a DECLINE knows there is no card, so it says so — the negative control for the arm above");

  const W_CARRY = "wake-carry-1982";
  const carried = await inSession(async () => {
    resetTurnClock("turn_fire_1", Date.now(), "sess-carry");
    noteRoutineRunPermissionRefusal({ permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
    carryRunRefusalsToRedrive(W_CARRY);
    resetTurnClock("turn_fire_1_corrected", Date.now(), "sess-carry");
    return consumeRoutineRunPermissionRefusals(W_CARRY);
  });
  ok(carried.length === 1 && carried[0]?.permission === "use Notion", "🔴 §runreport/CARRY: a ledger handed to a wake's corrective re-drive is readable by the turn that answers THAT wake");

  const wrongWake = await inSession(async () => {
    resetTurnClock("turn_ww_1", Date.now(), "sess-carry");
    noteRoutineRunPermissionRefusal({ permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
    carryRunRefusalsToRedrive(W_CARRY);
    resetTurnClock("turn_ww_2", Date.now(), "sess-carry");
    const other = consumeRoutineRunPermissionRefusals("some-other-wake");
    return [other.length, consumeRoutineRunPermissionRefusals(W_CARRY).length] as const;
  });
  ok(wrongWake[0] === 0, "🔴 §runreport/CARRY: …and a turn answering a DIFFERENT wake reads nothing — one fire's losses never reach another's report");
  ok(wrongWake[1] === 1, "🔴 §runreport/CARRY: …and that unclaimed read did NOT consume it — the wake it was carried for still gets its block");
  const noWake = await inSession(async () => {
    resetTurnClock("turn_nw_1", Date.now(), "sess-carry");
    noteRoutineRunPermissionRefusal({ permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
    carryRunRefusalsToRedrive(W_CARRY);
    resetTurnClock("turn_nw_2", Date.now(), "sess-carry");
    return consumeRoutineRunPermissionRefusals();
  });
  ok(noWake.length === 0, "§runreport/CARRY: …nor does a caller that names no wake, so the old turn-only reading is unchanged where it applies");

  const stranded = await inSession(async () => {
    resetTurnClock("turn_fireA", Date.now(), "sess-job");
    noteRoutineRunPermissionRefusal({ permission: "open pull requests", card: PERMALINK, cardKnown: true, cardPosted: true, cardCapped: false });
    resetTurnClock("turn_fireB", Date.now(), "sess-job");
    carryRunRefusalsToRedrive("wake-fire-B");
    return consumeRoutineRunPermissionRefusals("wake-fire-B");
  });
  ok(stranded.length === 0, "🔴 §runreport/CARRY: a ledger STRANDED by an earlier fire is NOT carried onto a later fire's wake — the carry honours the turn key rather than stepping around it");

  const twiceCarried = await inSession(async () => {
    resetTurnClock("turn_tc_1", Date.now(), "sess-carry");
    noteRoutineRunPermissionRefusal({ permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
    carryRunRefusalsToRedrive(W_CARRY);
    resetTurnClock("turn_tc_2", Date.now(), "sess-carry");
    const one = consumeRoutineRunPermissionRefusals(W_CARRY);
    return [one.length, consumeRoutineRunPermissionRefusals(W_CARRY).length] as const;
  });
  ok(twiceCarried[0] === 1 && twiceCarried[1] === 0, "§runreport/CARRY: read-and-reset holds on the carried read too — the block rides ONE message");

  const exhausted = await inSession(async () => {
    resetTurnClock("turn_ex_1", Date.now(), "sess-carry");
    noteRoutineRunPermissionRefusal({ permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
    carryRunRefusalsToRedrive(W_CARRY);
    dropCarriedRunRefusals(W_CARRY);
    resetTurnClock("turn_ex_2", Date.now(), "sess-carry");
    return consumeRoutineRunPermissionRefusals(W_CARRY);
  });
  ok(exhausted.length === 0, "🔴 §runreport/CARRY: an EXHAUSTED correction drops the carried ledger — it never surfaces on a later turn that happens to name the same wake");

  const liveKept = await inSession(async () => {
    resetTurnClock("turn_live", Date.now(), "sess-carry");
    noteRoutineRunPermissionRefusal({ permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
    dropCarriedRunRefusals(W_CARRY);
    return consumeRoutineRunPermissionRefusals();
  });
  ok(liveKept.length === 1, "🔴 §runreport/CARRY/NEGATIVE CONTROL: dropping a CARRIED ledger leaves a live current-turn one untouched");

  noteRoutineRunPermissionRefusal({ permission: "open pull requests", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
  ok(consumeRoutineRunPermissionRefusals().length === 0, "§runreport: fail-soft outside a session — the ledger never blocks or changes a refusal");

  ok(withRunRefusalBlock("body", []) === "body", "🔴 §runreport: an empty ledger is the IDENTITY function — every ordinary reply is untouched");
  const rendered = withRunRefusalBlock("body", [{ permission: "open pull requests", card: PERMALINK, cardKnown: true, cardPosted: true, cardCapped: false }, { permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false }]);
  ok(rendered.startsWith("body\n\n"), "§runreport: the block is a SUFFIX under a blank line — the answer comes first, the footnote after");
  ok(rendered.includes(RUN_REFUSAL_HEADING), "§runreport: under the host-authored heading, so a reader knows it did not come from the model");
  ok(rendered.includes(`\u2022 open pull requests \u2014 waiting for approval: ${PERMALINK}`), "§runreport: a permission with an open card points at it");
  ok(rendered.includes("use Notion \u2014 no approval request is open"), "§runreport: and one without says so rather than rendering an empty pointer");

  const noPermalink = withRunRefusalBlock("body", [{ permission: "use Notion", card: null, cardKnown: true, cardPosted: true, cardCapped: false }]);
  ok(!noPermalink.includes("slack/"), "\u{1f534} \u00a7runreport: a card with no permalink renders NO room id \u2014 no arm is left that could print the platform triple");
  ok(
    noPermalink.includes("use Notion \u2014 waiting for approval in this routine's channel"),
    "\u{1f534} \u00a7runreport: it names the room in WORDS instead \u2014 the card is posted to the routine's own surface, so that says everything the id did",
  );
  ok(!noPermalink.includes("no approval request is open"), "\u{1f534} \u00a7runreport: and never claims there is NO card \u2014 that line sends an owner to an edit that would destroy it");
  ok(
    withRunRefusalBlock("body", [{ permission: "use Notion", card: PERMALINK, cardKnown: true, cardPosted: true, cardCapped: false }]).includes(PERMALINK),
    "\u00a7runreport: control \u2014 a card that HAS a permalink still points at it",
  );
  await store.revokeSessionApprovals(ORG, dKey);
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
  ok(res.expiresAt !== ROUTINE_PERMISSION_NO_EXPIRY && ttlHours > 23 && ttlHours < 25, `§expiry: an ordinary card is unaffected — it still expires on approvals.ttlHours (got ${ttlHours.toFixed(2)}h)`);
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
  const { plainSummaryForRow } = await import("../agent/approvals/plain-summary.js");
  const bare = plainSummaryForRow((res as unknown as { row: never }).row).replace(/[.!?]$/u, "");
  ok(context === `❌ Rejected by <@U_ADMIN>: ${bare}`, `§click: a hookless kind's decided card is one line — no appended outcome clause (got ${String(context)})`);
  ok(!blocks.text.includes(" · ") && !blocks.text.includes("rejected"), "§click: the literal 'rejected' never shows on the card");
}

{
  const reapRoutine = await addRoutine({ org: ORG, surfaceKey: SURFACE } as never, {
    id: "r-reap",
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C_ROOM" },
    trigger: { kind: "cron", cron: "0 4 * * *" },
    prompt: "Every morning, open a pull request.",
    createdBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    status: "active",
  } as never);
  const reapKey = routinePermissionKey(reapRoutine);
  const fireReap = async (title: string): Promise<void> => {
    await requestApproval(
      {
        org: ORG,
        kind: "pr.open",
        args: { org: ORG, scopeKey: SURFACE, repo: "acme/site", head: title, base: "main", title, body: "", headSha: "aaa", requestedBy: "U_OWNER", tainted: false, sessionId: reapKey },
        scopeKey: SURFACE,
        domain: null,
        requestedBy: "U_OWNER",
        channelId: "C_ELSEWHERE",
        chain: { unattended: true },
      } as never,
      {},
    ).catch(() => undefined);
  };
  const reapCards = async (): Promise<{ id: string; argsJson: string }[]> =>
    (await store.listPendingActions(ORG)).filter((r) => r.kind === ROUTINE_PERMISSION_KIND && r.argsJson.includes(reapKey)) as never;

  await fireReap("reap me");
  const card = (await reapCards())[0];
  ok(card !== undefined, "§reap: the fire posted a card for this generation");

  await reapSupersededRoutineCards(ORG);
  ok((await reapCards()).length === 1, "🔴 §reap: a CURRENT generation's card survives the reap — it never closes a card a click would still honour");
  ok((await store.getPendingAction(ORG, card!.id))?.status === "pending", "§reap: and the row itself is untouched, still pending");

  await updateRoutine(ORG, SURFACE, "r-reap", { promptGeneration: 7 });
  const closed = await sweepExpiredPendings(ORG);
  ok(closed >= 1, `🔴 §reap: THE SWEEP closes the superseded card — the pass is wired into it, not merely correct on its own (closed ${closed})`);
  ok((await reapCards()).length === 0, "🔴 §reap: the card is no longer pending — the room stops holding buttons whose every click refuses");
  const reaped = await store.getPendingAction(ORG, card!.id);
  ok(reaped?.status === "expired" && reaped.decidedBy === "system", "§reap: the row is EXPIRED, decided by the system rather than by a human who never clicked");

  const expiredRows = await readAudit({ org: "acme", action: "approval.expired" });
  ok(expiredRows.filter((r) => (r.detail as { id?: string } | undefined)?.id === card!.id).length === 1, "§reap: exactly one approval.expired row names this card");
  const cause = (expiredRows.find((r) => (r.detail as { id?: string } | undefined)?.id === card!.id)?.detail ?? {}) as { cause?: string; routine?: string };
  ok(cause.cause === "routine-superseded", `🔴 §reap: the cause is NOT "ttl" — no clock ran out, and an operator has to be able to tell the two apart (got ${String(cause.cause)})`);
  ok(cause.routine === "r-reap", "§reap: and the row names the routine whose edit closed it");

  const goneRoutine = await addRoutine({ org: ORG, surfaceKey: SURFACE } as never, {
    id: "r-gone",
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C_ROOM" },
    trigger: { kind: "cron", cron: "0 5 * * *" },
    prompt: "Every evening, open a pull request.",
    createdBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    status: "active",
  } as never);
  const goneKey = routinePermissionKey(goneRoutine);
  await requestApproval(
    {
      org: ORG,
      kind: "pr.open",
      args: { org: ORG, scopeKey: SURFACE, repo: "acme/site", head: "gone", base: "main", title: "gone", body: "", headSha: "ccc", requestedBy: "U_OWNER", tainted: false, sessionId: goneKey },
      scopeKey: SURFACE,
      domain: null,
      requestedBy: "U_OWNER",
      channelId: "C_ELSEWHERE",
      chain: { unattended: true },
    } as never,
    {},
  ).catch(() => undefined);
  const second = (await store.listPendingActions(ORG)).find((r) => r.kind === ROUTINE_PERMISSION_KIND && r.argsJson.includes(goneKey));
  ok(second !== undefined, "§reap: a fresh card is pending for the delete leg");
  ok(await removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-gone"), "§reap: the routine is deleted");
  ok((await reapSupersededRoutineCards(ORG)) >= 1, "§reap: the reap closes the card of a routine that no longer exists");
  ok((await store.getPendingAction(ORG, second!.id))?.status === "expired", "§reap: that card's own row is expired");
  const goneDetail = ((await readAudit({ org: "acme", action: "approval.expired" })).find((r) => (r.detail as { id?: string } | undefined)?.id === second!.id)?.detail ??
    {}) as { cause?: string };
  ok(goneDetail.cause === "routine-deleted", `§reap: with the cause that says WHICH road — deleted, not edited (got ${String(goneDetail.cause)})`);

  const ordinary = await requestApproval(
    {
      org: ORG,
      kind: "pr.open",
      args: { org: ORG, scopeKey: SURFACE, repo: "acme/site", head: "bystander", base: "main", title: "bystander", body: "", headSha: "bbb", requestedBy: "U_OWNER", tainted: false },
      scopeKey: SURFACE,
      domain: null,
      requestedBy: "U_OWNER",
      channelId: "C_ROOM",
      chain: { unattended: false },
    } as never,
    {},
  );
  ok((await reapSupersededRoutineCards(ORG)) === 0, "§reap: with no superseded card left there is nothing to close");
  ok((await store.getPendingAction(ORG, ordinary.id))?.status === "pending", "🔴 §reap: and an ordinary pr.open card is still pending — the reap reads one kind and touches no other");
}

await removeTempDir(tmp);
console.log(`✓ routine permission card: ${passed} assertions passed`);
