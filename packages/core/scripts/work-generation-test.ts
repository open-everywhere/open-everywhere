process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerSlackFixtureCodec } from "./_slack-test-stubs.js";
import { readAudit } from "../agent/audit/audit.js";
import { deploymentOrg } from "../agent/identity/binding.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import {
  continuationRoute,
  currentSeatToken,
  currentWorkToken,
  isSameWorkSession,
  markWorkSessionDead,
  workSessionMarkedDead,
  requestIdOfWorkSessionLedgerId,
  resolveWorkGeneration,
  retireFailedWorkSession,
  workRegistryKey,
  workSessionIdle,
  workSessionLedgerId,
  workSessionSandboxState,
  workTokenHoldingTask,
  WORK_ROTATED_ACTION,
  WORK_ROTATION_DEFERRED_ACTION,
  WORK_SESSION_FAILED_ACTION,
  WORK_REQUEST_LOST_ACTION,
} from "../agent/channels/work-generation.js";
import { notifyLostWorkRequests, notifyRefusedWorkRequest, refusedFollowUpText, WORK_REQUEST_REFUSED_ACTION } from "../agent/channels/work-loss.js";
import { handleSessionLimitPark, parkRotateDelta } from "../agent/channels/session-park.js";
import { noteGenerationDelegation, generationOwedTaskIds, __pendingGenerationRetirementsForTest, __resetGenerationRetirementsForTest } from "../agent/channels/generation-retirement.js";
import { rememberWorkRequest, workLedgerId, workTokenForSeat, type WorkRequestRow } from "../agent/channels/work.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { delegatedProvenanceKey, settleDelegatedReads } from "../agent/channels/delegated-provenance.js";
import { connectorReadsThisTurn } from "../agent/channels/reply-provenance.js";

registerSlackFixtureCodec();

let n = 0;
const ok = (cond: unknown, label: string): void => {
  assert.ok(cond, label);
  n += 1;
};

const ORG = "org-ope2341";
const store = getOperationalStore();
const SEAT_G3 = "oe-dom:e2e-unified:win:discord/111/222:oe-sup:g3-abc123";
const SEAT_G4 = "oe-dom:e2e-unified:win:discord/111/222:oe-sup:g4-def456";
const W_G1 = "oe-dom:e2e-unified:win:w/discord/111/222:oe-sup:g1";
const W_KEY = unifiedDomainSessionKey("w/discord/111/222");
const SURFACE = "discord/111/222";
const BASE_MS = Math.floor(Date.now() / 60_000) * 60_000;
const at = (minutes: number): string => new Date(BASE_MS + minutes * 60_000).toISOString();
const det = (runtimeChanged = false) => ({ claimRuntime: async () => runtimeChanged, stampRuntime: async () => undefined, salt: (t: string) => `${t}-aaaaaa` });

{
  ok(workRegistryKey(SEAT_G3) === W_KEY, "W's registry key derives from the seat's WINDOW, not its generation");
  ok(workRegistryKey(SEAT_G4) === W_KEY, "…so a seat rotation keys the SAME W row (W outlives the seat, ruling Q6)");
  ok(workRegistryKey(W_G1) === undefined, "a W token has no work session of its own");
  ok(workTokenForSeat(SEAT_G3) === W_G1, "slice A's pure address is generation 1, whatever the seat generation");
  ok(isSameWorkSession(W_G1, "oe-dom:e2e-unified:win:w/discord/111/222:oe-sup:g7-0a0a0a"), "🔴 identity is generation-blind: W at g7 is the same work session as its g1 address");
  ok(!isSameWorkSession(W_G1, "oe-dom:e2e-unified:win:w/discord/111/999:oe-sup:g1"), "…and another seat's W is not");
  ok(!isSameWorkSession(SEAT_G3, SEAT_G3), "…and a SEAT token is never a work session");
  ok((await currentWorkToken(ORG, SEAT_G3, store)) === W_G1, "with no W row yet, the read-only address is slice A's generation-1 token");
  ok((await currentWorkToken(ORG, SEAT_G3, {})) === W_G1, "…and a store with no registry answers the same, never throws");
}

{
  __resetGenerationRetirementsForTest();
  const first = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G3, surfaceKey: SURFACE, atIso: at(0) }, det());
  ok(first.minted === true && first.generation === 1, "the first forward MINTS W's row at generation 1");
  ok(first.token === W_G1, "🔴 …with slice A's UNSALTED token, so a W slice A already started is adopted with its sandbox, not orphaned");
  const resumed = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: at(1) }, det());
  ok(resumed.token === W_G1 && resumed.minted === undefined && resumed.rotated === undefined, "🔴 a forward from a ROTATED seat resumes the SAME W generation (the seat's rotation does not rotate W)");
  ok((await currentWorkToken(ORG, SEAT_G4, store)) === W_G1, "the read-only address now reads W's row");

  for (let i = 0; i < 2000; i++) await store.touchChannelSession(ORG, W_KEY, at(2));
  await noteGenerationDelegation(ORG, W_G1, workSessionLedgerId("req-busy"), store);
  const deferred = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: at(3) }, det());
  ok(deferred.deferred?.trigger === "turn-backstop" && deferred.deferred.owed === 1, "🔴 a SOFT rotation is DEFERRED while W owes a job (reset only when idle, ruling Q6)");
  ok(deferred.token === W_G1 && deferred.rotated === undefined, "…and the job reaches the W that holds the workspace");
  ok((await readAudit({ org: ORG })).some((r) => r.action === WORK_ROTATION_DEFERRED_ACTION), "…and the deferral is audited");

  await (await import("../agent/channels/generation-retirement.js")).clearGenerationDelegation(ORG, workSessionLedgerId("req-busy"), store);
  const soft = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: at(4) }, det());
  ok(soft.rotated?.trigger === "turn-backstop" && soft.generation === 2, "an IDLE W rotates on the soft rung");
  ok(soft.token === "oe-dom:e2e-unified:win:w/discord/111/222:oe-sup:g2-aaaaaa", "…to a SALTED generation 2");
  ok(soft.rotated?.lostRequestIds.length === 0, "…and an idle rotation loses no job");
  ok(__pendingGenerationRetirementsForTest().some((p) => p.token === W_G1 && p.registryKey === W_KEY), "…and the outgoing W is noted for the retirement drain");
  ok((await readAudit({ org: ORG })).some((r) => r.action === WORK_ROTATED_ACTION && r.detail?.["from"] === W_G1), "…and the rotation is audited");

  const g2 = soft.token;
  await noteGenerationDelegation(ORG, g2, workSessionLedgerId("req-lost"), store);
  await noteGenerationDelegation(ORG, g2, "agent-task-1", store);
  await store.bumpChannelSessionUsage(ORG, W_KEY, g2, parkRotateDelta());
  const busy = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: at(5) }, det());
  ok(busy.deferred !== undefined && busy.deferred.owed === 2 && busy.rotated === undefined && busy.token === g2, "🔴 a busy W whose MEASURED counter passed the park delta DEFERS: only an explicit dead marker makes the hard rung");
  ok(!(await workSessionMarkedDead(ORG, g2, store)), "…because no park or failure marked it");
  await markWorkSessionDead(ORG, g2, "parked", store);
  ok(await workSessionMarkedDead(ORG, g2, store), "the park's explicit marker reads as dead");
  const hard = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: at(5) }, det());
  ok(hard.rotated?.trigger === "parked" && hard.generation === 3, "🔴 a PARKED W rotates at the next forward even though it owes work — a parked W never steps again");
  ok(hard.rotated?.lostRequestIds.join() === "req-lost" && hard.rotated.lostTaskIds.join() === "agent-task-1", "…and the rotation names the job and the task it lost");

  await noteGenerationDelegation(ORG, hard.token, workSessionLedgerId("req-runtime"), store);
  const runtime = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: at(6) }, det(true));
  ok(runtime.rotated?.trigger === "runtime-changed" && runtime.generation === 4, "🔴 a runtime change rotates W at once, even while W owes a job");
  ok(
    runtime.rotated?.lostRequestIds.length === 0 && runtime.rotated.lostTaskIds.length === 0 && runtime.rotated.drainingRequestIds.join() === "req-runtime",
    "🔴 OPE-2377: …and LOSES nothing: the old W still runs on its own deployment, so its job is DRAINING, never lost",
  );
  ok(runtime.runtime === "rotated", "…and the forward's verdict says the job reached a rotated, fresh W");
  const runtimeRow = (await readAudit({ org: ORG })).find((r) => r.action === WORK_ROTATED_ACTION && r.detail?.["trigger"] === "runtime-changed");
  ok(runtimeRow?.detail?.["drainingRequests"] === 1 && runtimeRow.detail["lostRequests"] === 0, "…and the rotation row counts the draining job, and no lost one");
  ok((await generationOwedTaskIds(ORG, hard.token, store)).includes(workSessionLedgerId("req-runtime")), "…and the outgoing W still owes it, so the retirement drain leaves that W alone until it settles");
  const quiet = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: at(7) }, det());
  ok(quiet.rotated === undefined && quiet.deferred === undefined && quiet.token === runtime.token, "negative control: a fresh generation with no rung resumes");
  const weekLater = at(7 * 24 * 60);
  const later = await resolveWorkGeneration({ org: ORG, seatToken: SEAT_G4, surfaceKey: SURFACE, atIso: weekLater }, det());
  ok(later.rotated === undefined && later.token === runtime.token, "🔴 W has no expiry or quiet-gap rung: a week-idle W keeps its workspace (§2.18 names tokens, turns and the runtime)");
  ok((await workTokenHoldingTask(ORG, SEAT_G4, "agent-task-1", store)) === g2, "a cancel reaches the W generation that RUNS the task, even after W rotated");
  ok((await workTokenHoldingTask(ORG, SEAT_G4, "agent-unknown", store)) === runtime.token, "…and an unknown task falls back to W's current generation");
}

{
  const seatKey = unifiedDomainSessionKey("discord/111/222");
  ok((await currentSeatToken(ORG, SEAT_G3, store)) === SEAT_G3, "with no seat row, the recorded token stands (slice A's answer)");
  await store.rotateChannelSession(ORG, seatKey, SEAT_G3, at(0));
  await store.rotateChannelSession(ORG, seatKey, SEAT_G4, at(1));
  ok((await currentSeatToken(ORG, SEAT_G3, store)) === SEAT_G4, "🔴 a seat that rotated mid-job is woken on its CURRENT generation, not the retired one the forward recorded");
  ok((await currentSeatToken(ORG, `unified:${SEAT_G3}`, store)) === SEAT_G4, "…and the eve-namespaced spelling resolves the same");
  await store.rotateChannelSession(ORG, unifiedDomainSessionKey("other"), "oe-dom:e2e-unified:win:other:oe-sup:g1", at(0));
  const other = "oe-dom:e2e-unified:win:other:oe-sup:g1";
  ok((await currentSeatToken(ORG, other, store)) === other, "another window's row never answers for this one");
  ok((await currentSeatToken(ORG, W_G1, store)) === W_G1, "a W token is never re-addressed as a seat");
  const broken = { getChannelSession: async () => { throw new Error("store down"); } };
  ok((await currentSeatToken(ORG, SEAT_G3, broken)) === SEAT_G3, "a store error falls back to the recorded token, never throws");
}

{
  const W = "oe-dom:e2e-unified:win:w/idle-probe:oe-sup:g1";
  ok((await workSessionIdle(ORG, W, store)).idle === true, "a W that owes nothing is idle");
  await noteGenerationDelegation(ORG, W, workSessionLedgerId("req-pending"), store);
  const busy = await workSessionIdle(ORG, W, store);
  ok(busy.idle === false && busy.owed.join() === workSessionLedgerId("req-pending"), "🔴 a forwarded job whose task has not started yet keeps W busy");
  const broken = { getTaskResult: async () => { throw new Error("store down"); } };
  ok((await workSessionIdle(ORG, W, broken)).idle === false, "🔴 an unreadable ledger reads as BUSY (fail closed: never stop a VM under a job)");
  const seatCtx = { channel: { kind: "unified", continuationToken: `unified:${SEAT_G3}` }, session: { id: "s-seat" } };
  ok((await workSessionSandboxState(seatCtx as never, store)).work === false, "a seat is not a work session: its stop rule is unchanged");
  const wCtx = { channel: { kind: "unified", continuationToken: `unified:${W}` }, session: { id: "s-w" } };
  const before = await workSessionSandboxState(wCtx as never, store);
  ok(before.work === true && before.idle === true, "W's context reads the DEPLOYMENT org's ledger, which owes nothing yet");
  await noteGenerationDelegation(deploymentOrg(), W, workSessionLedgerId("req-pending"), store);
  const st = await workSessionSandboxState(wCtx as never, store);
  ok(st.work === true && st.idle === false && st.token === W, "W's context reads W's own ledger, under its own bare token");
}

{
  const seatKey = unifiedDomainSessionKey("discord/111/222");
  const seatBefore = (await store.getChannelSession(ORG, seatKey))!;
  const wRow = (await store.getChannelSession(ORG, W_KEY))!;
  const out = await handleSessionLimitPark(
    { org: ORG, platform: "unified", workspace: "e2e-unified", surface: "x", domainKey: SURFACE, token: wRow.token },
    { kind: "input", limit: 30_000_000, usedTokens: 30_000_001, requestId: "s:limit:input:30000001" },
  );
  ok(out.tier === "work" && out.remedy === "rotate_on_next_wake" && out.registryKey === W_KEY, "🔴 a W park retires W's OWN row (tier=work)");
  const seatAfter = (await store.getChannelSession(ORG, seatKey))!;
  ok(seatAfter.token === seatBefore.token && seatAfter.generation === seatBefore.generation && (seatAfter.inputTokensTotal ?? 0) === (seatBefore.inputTokensTotal ?? 0), "🔴 …and the SEAT's row, generation and counter are untouched: work cannot park the room (§2.7)");
  ok(Number((await store.getChannelSession(ORG, W_KEY))!.inputTokensTotal) >= parkRotateDelta(), "…and W's own counter carries the park's saturating delta");
  const seatPark = await handleSessionLimitPark(
    { org: ORG, platform: "unified", workspace: "e2e-unified", surface: "x", domainKey: SURFACE, token: seatAfter.token },
    { kind: "input", requestId: "s2:limit:input:1" },
  );
  ok(seatPark.tier === "seat" && seatPark.registryKey === seatKey, "negative control: a seat park still retires the seat's row");
}

{
  const seat = "oe-dom:e2e-unified:win:d9seat:oe-sup:g1";
  const g = await resolveWorkGeneration({ org: ORG, seatToken: seat, surfaceKey: SURFACE, atIso: at(0) }, det());
  await noteGenerationDelegation(ORG, g.token, workSessionLedgerId("req-d9"), store);
  const out = await retireFailedWorkSession({ org: ORG, token: `unified:${g.token}`, code: "COMPACTION_EMPTY" }, { store });
  ok(out.retired && out.lostRequestIds.join() === "req-d9", "🔴 a FAILED W is retired, and its owed jobs are named for the room notice");
  ok((await readAudit({ org: ORG })).some((r) => r.action === WORK_SESSION_FAILED_ACTION && r.detail?.["code"] === "COMPACTION_EMPTY"), "…and the failure is audited with eve's code");
  const next = await resolveWorkGeneration({ org: ORG, seatToken: seat, surfaceKey: SURFACE, atIso: at(1) }, det());
  ok(next.rotated?.trigger === "parked" && next.generation === 2, "…so the next forward re-mints W (a new session and sandbox)");
  ok((await retireFailedWorkSession({ org: ORG, token: seat }, { store })).retired === false, "a SEAT's failure is not this remedy's");
}

{
  const seatKey = unifiedDomainSessionKey("discord/111/222");
  const row: WorkRequestRow = {
    requestId: "req-notice",
    seatToken: SEAT_G3,
    wakeId: "11111111-1111-4111-8111-111111111111",
    origin: { platform: "slack", channelId: "C_ROOM", threadTs: "100.1" },
    surfaceKey: SURFACE,
    binding: { principalId: "discord/u1" } as never,
    requester: { kind: "requester", principalId: "discord/u1" } as never,
    nonMemberWake: false,
    atIso: at(0),
  };
  await rememberWorkRequest(store, ORG, row);
  await noteGenerationDelegation(ORG, SEAT_G3, workLedgerId("req-notice"), store);
  const W = "oe-dom:e2e-unified:win:w/discord/111/222:oe-sup:g9-bbbbbb";
  await noteGenerationDelegation(ORG, W, workSessionLedgerId("req-notice"), store);
  const sent: { seatToken: string; requestId: string; message: string }[] = [];
  const dispatch = async (input: { seatToken: string; requestId: string; message: string }) => {
    sent.push(input);
    return true;
  };
  const count = await notifyLostWorkRequests({ org: ORG, requestIds: ["req-notice", "req-missing"], reason: "work-session parked", workToken: W }, { store, dispatch: dispatch as never });
  ok(count === 1 && sent.length === 1, "one lost job, one notice; a request with no row sends nothing");
  ok(sent[0]!.seatToken === (await store.getChannelSession(ORG, seatKey))!.token, "🔴 the notice reaches the seat generation live NOW");
  ok(sent[0]!.message.includes("FAILED") && sent[0]!.message.includes("was reset (work-session parked)"), "…as a FAILED result in OE's own words, naming the reason");
  ok((await generationOwedTaskIds(ORG, SEAT_G3, store)).length === 0, "…the seat no longer owes the job (D18 cleared)");
  ok((await generationOwedTaskIds(ORG, W, store)).length === 0, "…and W's ledger no longer holds it");
  const again = await notifyLostWorkRequests({ org: ORG, requestIds: ["req-notice"], reason: "work-session failed", workToken: W }, { store, dispatch: dispatch as never });
  ok(again === 0 && sent.length === 1, "🔴 ONCE per request: the park hook and the next forward cannot both notify the same loss");
  const rows = (await readAudit({ org: ORG })).filter((r) => r.action === WORK_REQUEST_LOST_ACTION);
  ok(rows.some((r) => r.detail?.["outcome"] === "notified") && rows.some((r) => r.detail?.["outcome"] === "replay-skipped") && rows.some((r) => r.detail?.["why"] === "request-row-missing"), "every outcome writes its audit row");
  ok(requestIdOfWorkSessionLedgerId(workSessionLedgerId("r1")) === "r1" && requestIdOfWorkSessionLedgerId("agent-1") === undefined && workSessionLedgerId("r1") !== workLedgerId("r1"), "W's ledger id is distinct from the seat's D18 id, so the two never share a reverse pointer");
}

{
  const seatKey = unifiedDomainSessionKey("discord/111/222");
  const row: WorkRequestRow = {
    requestId: "req-refused",
    seatToken: SEAT_G3,
    wakeId: "22222222-2222-4222-8222-222222222222",
    origin: { platform: "slack", channelId: "C_ROOM", threadTs: "100.2" },
    surfaceKey: SURFACE,
    binding: { principalId: "discord/u1" } as never,
    requester: { kind: "requester", principalId: "discord/u1" } as never,
    nonMemberWake: false,
    atIso: at(0),
  };
  await rememberWorkRequest(store, ORG, row);
  await noteGenerationDelegation(ORG, SEAT_G3, workLedgerId("req-refused"), store);
  const W = "oe-dom:e2e-unified:win:w/discord/111/222:oe-sup:g9-cccccc";
  await noteGenerationDelegation(ORG, W, workSessionLedgerId("req-refused"), store);
  const sent: { seatToken: string; requestId: string; message: string }[] = [];
  const dispatch = async (input: { seatToken: string; requestId: string; message: string }) => {
    sent.push(input);
    return true;
  };
  ok((await generationOwedTaskIds(ORG, SEAT_G3, store)).includes(workLedgerId("req-refused")), "⑦b precondition: the seat owes the forwarded follow-up");
  const woke = await notifyRefusedWorkRequest({ org: ORG, requestId: "req-refused", taskId: "agent-busy-1", reason: "task-working" }, { store, dispatch: dispatch as never });
  ok(woke === true && sent.length === 1 && sent[0]!.requestId === "req-refused", "🔴 ⑦b a W-side refusal wakes the seat ONCE, for that request");
  ok(sent[0]!.seatToken === (await store.getChannelSession(ORG, seatKey))!.token, "⑦b …on the seat generation live NOW");
  ok(sent[0]!.message.includes("FAILED") && sent[0]!.message.includes("did not run this follow-up") && sent[0]!.message.includes("still working on an earlier message"), "⑦b …as a FAILED result that says the follow-up was not run, and why");
  ok((await generationOwedTaskIds(ORG, SEAT_G3, store)).length === 0, "⑦b …the seat no longer owes the job (D18 cleared)");
  ok((await generationOwedTaskIds(ORG, W, store)).length === 0, "⑦b …and W's ledger no longer holds it");
  const again = await notifyRefusedWorkRequest({ org: ORG, requestId: "req-refused", taskId: "agent-busy-1", reason: "task-working" }, { store, dispatch: dispatch as never });
  ok(again === false && sent.length === 1, "🔴 ⑦b ONCE per request: a replayed refusal sends nothing more");
  const none = await notifyRefusedWorkRequest({ org: ORG, requestId: "req-refused-missing", taskId: "agent-busy-1", reason: "no-provenance" }, { store, dispatch: dispatch as never });
  ok(none === false && sent.length === 1, "⑦b a request with no row sends nothing");
  const rows = (await readAudit({ org: ORG })).filter((r) => r.action === WORK_REQUEST_REFUSED_ACTION);
  ok(rows.some((r) => r.detail?.["outcome"] === "notified" && r.detail?.["reason"] === "task-working") && rows.some((r) => r.detail?.["outcome"] === "replay-skipped") && rows.some((r) => r.detail?.["why"] === "request-row-missing"), "⑦b every outcome writes its work.request_refused row");
  ok(typeof (await import("../agent/access/work-refusal-notice.js")).registeredContinuationRefusalNotifier() === "function", "🔴 ⑦b loading channels/work-loss.ts registers the notice with the fence's light half — without it a W-side refusal stays silent");
  ok(refusedFollowUpText("t1", "cross-room").includes("different conversation") && refusedFollowUpText("t1", "no-provenance").includes("as a new job"), "⑦b the text names what the seat can do for each reason");
}

{
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
    ContextContainer: new () => unknown;
    contextStorage: { run<T>(c: unknown, fn: () => T): T };
  };
  const inStep = <T>(fn: () => T): T => contextStorage.run(new ContextContainer(), fn);
  const child = "subagent:sess-w:call-replay";
  const reach = { proof: "wake" as const, wakeId: "22222222-2222-4222-8222-222222222222" };
  const seed = () => store.putTaskResult(ORG, delegatedProvenanceKey(child), JSON.stringify({ reads: [{ connection: "github", op: "issues.read" }] }), at(0), 60_000);
  const spend = (turnId: string, replayKey?: string) =>
    inStep(async () => {
      const out = await settleDelegatedReads({ org: ORG, childToken: child, sessionId: "sess-seat", turnId, reach, ...(replayKey !== undefined ? { replayKey } : {}) });
      return { out, noted: connectorReadsThisTurn(turnId).length };
    });

  await seed();
  const plain1 = await spend("turn-r");
  const plain2 = await spend("turn-r");
  ok(plain1.noted === 1 && plain1.out.carried === 1, "the first execution of the spend notes the worker's read for the reply footer");
  ok(plain2.noted === 0, "🔴 PINNED: the PLAIN spend under-attributes a redelivered step — the row is spent and the fresh step notes nothing (the base settle edge keeps this)");

  await seed();
  const key = "sess-seat:turn-r";
  const first = await spend("turn-r", key);
  const replay = await spend("turn-r", key);
  ok(first.noted === 1, "the keyed spend notes the read on the first execution");
  ok(replay.noted === 1 && replay.out.carried === 1, "🔴 OPE-2341: a REDELIVERED step of the SAME turn re-notes the read, so the reply's provenance footer is whole");
  const other = await spend("turn-other", "sess-seat:turn-other");
  ok(other.noted === 0 && other.out.found === 0, "🔴 …and any OTHER turn still finds the row spent: the replay key never re-opens it for another reply");
  const raw = JSON.parse((await store.getTaskResult(ORG, delegatedProvenanceKey(child)))!) as { reads: unknown[] };
  ok(Array.isArray(raw.reads) && raw.reads.length === 0, "the spent row's live `reads` is empty, so every reader that parses it sees a spent row, as before");
}

{
  const parkHook = (await import("../agent/hooks/session-park.js")).default;
  const onInput = (parkHook.events ?? {})["interaction.opened"] as (e: unknown, c: unknown) => Promise<void>;
  const W = "oe-dom:e2e-unified:win:w/hook-park-probe:oe-sup:g1";
  const org = deploymentOrg();
  await rememberWorkRequest(store, org, {
    requestId: "req-hook-park",
    seatToken: "oe-dom:e2e-unified:win:hook-park-probe:oe-sup:g1",
    wakeId: "33333333-3333-4333-8333-333333333333",
    origin: { platform: "slack", channelId: "C_ROOM", threadTs: "100.1" },
    surfaceKey: SURFACE,
    binding: { principalId: "discord/u1" } as never,
    requester: { kind: "requester", principalId: "discord/u1" } as never,
    nonMemberWake: false,
    atIso: at(0),
  });
  await noteGenerationDelegation(org, W, workSessionLedgerId("req-hook-park"), store);
  const park = { interactionId: "sess-w:0:limit:usage:0", subject: { turnId: "t1" }, request: { kind: "budget", prompt: "This session has hit its usage limit." } };
  const ctx = { channel: { kind: "unified", continuationToken: `unified:${W}` }, session: { id: "sess-w-hook" } };
  await onInput({ type: "interaction.opened", data: park }, ctx);
  ok(await workSessionMarkedDead(org, W, store), "🔴 a W park whose remedy is NOT rotate_on_next_wake (no registry row) still marks W dead");
  const lostRows = (await readAudit({ org })).filter((r) => r.action === WORK_REQUEST_LOST_ACTION && r.detail?.["requestId"] === "req-hook-park");
  ok(lostRows.length === 1, "🔴 …and its owed job gets exactly one lost-job attempt (delivery itself needs a live dispatch, which this process has none of)");
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { claimRuntimeRotation } = await import("../agent/channels/runtime-rotation.js");
  const { dmWindowKey, formatWindowToken } = await import("../agent/channels/window-key.js");
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "e2e-unified", reach: ["discord/111/222"], ambientSupervisor: true })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const org = "org-ope2377";
  const live = (codeFingerprint: string) => ({ codeFingerprint, salt: (t: string) => `${t}-${codeFingerprint}` });
  const forward = (seatToken: string, surfaceKey: string, minute: number, build: string) => resolveWorkGeneration({ org, seatToken, surfaceKey, atIso: at(minute) }, live(build));

  const DM_SURFACE = "slack/T0EXAMPLE/D0DMSTALE";
  const DM_SEAT = `${formatWindowToken(dmWindowKey(DM_SURFACE, 301))}-abc123`;
  const minted = await forward(DM_SEAT, DM_SURFACE, 0, "build-A");
  ok(minted.minted === true && minted.runtime === "minted", "a DM conversation's first forward mints its W on build A");
  const same = await forward(DM_SEAT, DM_SURFACE, 1, "build-A");
  ok(same.token === minted.token && same.rotated === undefined && same.runtime === "current", "🔴 NEGATIVE CONTROL: the same build resumes the SAME work session, and says it runs this code");
  await noteGenerationDelegation(org, minted.token, workSessionLedgerId("req-in-flight"), store);
  const deployed = await forward(DM_SEAT, DM_SURFACE, 2, "build-B");
  ok(
    deployed.rotated?.trigger === "runtime-changed" && deployed.token !== minted.token && deployed.runtime === "rotated",
    "🔴 OPE-2377: after a deploy, a DM's forward goes to a NEW work session on the new build (before the fix the `oe-dm/` grain read failed and W kept build A's code)",
  );
  ok(deployed.rotated?.drainingRequestIds.join() === "req-in-flight" && deployed.rotated.lostRequestIds.length === 0, "🔴 …and the job the old W holds is draining, not lost");
  const after = await forward(DM_SEAT, DM_SURFACE, 3, "build-B");
  ok(after.token === deployed.token && after.rotated === undefined && after.runtime === "current", "…and one work session per conversation holds: the next forward on build B joins the new W");

  const OLD_SURFACE = "slack/T0EXAMPLE/D0DMOLD";
  const OLD_SEAT = `${formatWindowToken(dmWindowKey(OLD_SURFACE, 7))}-abc123`;
  const oldKey = workRegistryKey(OLD_SEAT)!;
  const oldW = workTokenForSeat(OLD_SEAT)!;
  await store.rotateChannelSession(org, oldKey, oldW, at(0));
  await store.touchChannelSession(org, oldKey, at(0));
  const healed = await forward(OLD_SEAT, OLD_SURFACE, 4, "build-B");
  ok(healed.rotated?.trigger === "runtime-changed" && healed.rotated.from === oldW && healed.runtime === "rotated", "🔴 a W row with no recorded code ROTATES on the next forward (fail toward a fresh session)");
  const healedAgain = await forward(OLD_SEAT, OLD_SURFACE, 5, "build-B");
  ok(healedAgain.token === healed.token && healedAgain.rotated === undefined, "…once: the fresh W is stamped with this code and resumes");
  const RACE_SURFACE = "slack/T0EXAMPLE/D0DMRACE";
  const RACE_SEAT = `${formatWindowToken(dmWindowKey(RACE_SURFACE, 1))}-abc123`;
  await store.rotateChannelSession(org, workRegistryKey(RACE_SEAT)!, workTokenForSeat(RACE_SEAT)!, at(0));
  const racer = await forward(RACE_SEAT, RACE_SURFACE, 4, "build-B");
  ok(racer.rotated === undefined && racer.token === workTokenForSeat(RACE_SEAT) && racer.runtime === "current", "🔴 NEGATIVE CONTROL: an unstamped W row that has served NO forward is adopted, so a concurrent first forward joins the same W");
  const seatKey = "oe-dm-seat::slack/T0EXAMPLE/D0DMSEATONLY";
  await store.rotateChannelSession(org, seatKey, "seat-token-g1", at(0));
  const seatRotated = await claimRuntimeRotation({ org, registryKey: seatKey, surfaceKey: "slack/T0EXAMPLE/D0DMSEATONLY", atIso: at(0) }, { store, codeFingerprint: "build-B" });
  ok(seatRotated === false, "NEGATIVE CONTROL: a seat row with no recorded code is still ADOPTED, never rotated");

  const DOM_SEAT = "oe-dom:e2e-unified:win:discord/333/444:oe-sup:g2-abc123";
  const domMinted = await forward(DOM_SEAT, "discord/333/444", 6, "build-A");
  const domSame = await forward(DOM_SEAT, "discord/333/444", 7, "build-A");
  ok(domMinted.minted === true && domSame.token === domMinted.token && domSame.runtime === "current", "a declared domain's W resumes on the same build");
  const domDeployed = await forward(DOM_SEAT, "discord/333/444", 8, "build-B");
  ok(domDeployed.rotated?.trigger === "runtime-changed" && domDeployed.token !== domMinted.token, "…and rotates on a new build");
}

{
  const org = "org-ope2377-dead";
  const SEAT = "oe-dom:e2e-unified:win:discord/555/666:oe-sup:g1-abc123";
  const first = await resolveWorkGeneration({ org, seatToken: SEAT, surfaceKey: "discord/555/666", atIso: at(0) }, det());
  await noteGenerationDelegation(org, first.token, workSessionLedgerId("req-dead"), store);
  await markWorkSessionDead(org, first.token, "parked", store);
  const both = await resolveWorkGeneration({ org, seatToken: SEAT, surfaceKey: "discord/555/666", atIso: at(1) }, det(true));
  ok(both.rotated?.trigger === "parked" && both.rotated.lostRequestIds.join() === "req-dead" && both.rotated.drainingRequestIds.length === 0, "🔴 a PARKED W can never drain, so its job is lost (and the room told) even when the code changed as well");
}

{
  const org = "org-ope2378";
  const SEAT = "oe-dom:e2e-unified:oe-sup:g1";
  const old = "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g2-aaaaaa";
  const cur = "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g3-bbbbbb";
  const otherW = "oe-dom:e2e-unified:win:w/other-room:oe-sup:g2-cccccc";
  ok(workTokenForSeat(SEAT) !== undefined && isSameWorkSession(old, workTokenForSeat(SEAT)) && isSameWorkSession(cur, old), "the fixture's tokens name ONE work session in two generations");
  const route = (holdingToken: string | undefined) => continuationRoute({ org, holdingToken, currentToken: cur }, store);
  ok((await route(cur)).kind === "current", "a task in W's CURRENT generation goes to the current W");
  ok((await route(undefined)).kind === "current", "a task with no recorded generation goes to the current W, as before");
  ok((await route(otherW)).kind === "current", "a generation of ANOTHER work session is never chosen");
  const idle = await route(old);
  ok(idle.kind === "ended" && idle.reason === "idle" && idle.from === old, "🔴 an older generation that owes nothing is ENDED (idle): the follow-up starts as a new job");
  await noteGenerationDelegation(org, old, workSessionLedgerId("req-draining"), store);
  const holding = await route(old);
  ok(holding.kind === "holding" && holding.token === old, "🔴 an older generation that still RUNS a job holds the task: the follow-up goes there");
  ok((await route(`unified:${old}`)).kind === "holding", "…and an eve-prefixed recorded token reads the same");
  await markWorkSessionDead(org, old, "failed", store);
  const dead = await route(old);
  ok(dead.kind === "ended" && dead.reason === "dead", "🔴 a parked or failed older generation is ENDED (dead), even while its ledger owes");
  const broken = { getTaskResult: async (_o: string, key: string) => (key.startsWith("oe-work-dead:") ? null : Promise.reject(new Error("store down"))) };
  const unread = await continuationRoute({ org, holdingToken: "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g4-dddddd", currentToken: cur }, broken as never);
  ok(unread.kind === "ended" && unread.reason === "unreadable", "🔴 an unreadable ledger is ENDED (unreadable), never HOLDING");
}
console.log(`work-generation-test: ${n} assertions passed`);
