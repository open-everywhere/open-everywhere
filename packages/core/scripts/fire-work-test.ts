import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-fire-work-")), "ops.sqlite3");

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ org: undefined });
const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
overrideSettingsForTest({ delegation: { oneshotAgent: true } });
overrideSettingsForTest({ window: { topology: true } });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const fireWork = await import("../agent/routines/fire-work.js");
const { fireFoldOutcome, foldWorkFire } = await import("../agent/routines/fire-work-fold.js");
const { notifyLostWorkRequests } = await import("../agent/channels/work-loss.js");
const fireWindow = await import("../agent/routines/fire-window.js");
const work = await import("../agent/channels/work.js");
const { bindingForDivert, workResultAttributes } = await import("../agent/channels/unified.js");
const { parseWindowToken, isWorkWindowToken, classifySessionId, formatWindowToken } = await import("../agent/channels/window-key.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
const { webhookFireAttributes, WEBHOOK_MARKER_ATTR } = await import("../agent/routines/fire-auth.js");
const { FIRE_UNATTENDED_ATTR, FIRE_PRINCIPAL_ATTR, WORK_FIRE_CREATOR_ATTR, SCHEDULE_APP_PRINCIPAL_ID } = await import("../agent/identity/binding.js");
const { OE_FROZEN_SURFACE_BINDING_ATTR } = await import("../agent/identity/frozen-surface-binding.internal.js");
const { replyAuditFor } = await import("../agent/channels/reply-post.js");
const { OE_REQUESTER_ATTR, OE_REQUESTER_CANDIDATES_ATTR, REQUESTER_UNVERIFIED } = await import("../agent/access/requester-identity.js");
const { INVOKER_POSTURE_ATTR } = await import("../agent/access/invoker-posture.js");
const { wakeSeatNeedsReissue } = await import("../agent/hooks/work-task-key.js");
const { mintWakeId } = await import("../agent/channels/unified-window.js");

type Domain = import("../agent/memory/domain.js").Domain;
type FireWorkDeps = import("../agent/routines/fire-work.js").FireWorkDeps;
type Forward = Parameters<FireWorkDeps["dispatch"]>[0];

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "default";
const TEAM = "T_FWORK";
const CHAN = "C_FWORK";
const SURFACE = `slack/${TEAM}/${CHAN}`;
const PLAIN_CHAN = "C_FPLAIN";
const PLAIN_SURFACE = `slack/${TEAM}/${PLAIN_CHAN}`;
const LONELY_SURFACE = `slack/${TEAM}/C_FLONELY`;

const SLACK_CHANNEL = { __fixture: "slack" } as never;
registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });
registerSlackFixtureCodec();
registerSlackFixtureMapper();

const workDomain = defineDomain({ name: "fwork", reach: [SURFACE], ambientSupervisor: true, mode: "unified" });
const plainDomain = defineDomain({ name: "fplain", reach: [PLAIN_SURFACE], ambientSupervisor: true, mode: "unified" });
const DOMAINS: readonly Domain[] = [workDomain, plainDomain];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? ["fwork"] : surface === PLAIN_CHAN ? ["fplain"] : []),
});
const ORIGIN = { platform: "slack", channelId: CHAN } as const;
const store = getOperationalStore();

function routineBag(over: Record<string, string> = {}): Record<string, string> {
  return {
    team_id: TEAM,
    channel_id: CHAN,
    channel_type: "channel",
    [FIRE_UNATTENDED_ATTR]: "true",
    [ROUTINE_MARKER.id]: "r-fwork-1",
    [ROUTINE_MARKER.surface]: SURFACE,
    [ROUTINE_MARKER.org]: ORG,
    [ROUTINE_MARKER.permissionKey]: "oe-routine-perm:r-fwork-1:g1",
    ...over,
  };
}

function fakeDeps(): { deps: FireWorkDeps; sent: { forward: Forward; receive: unknown }[]; ledger: [string, string][]; cleared: string[] } {
  const sent: { forward: Forward; receive: unknown }[] = [];
  const ledger: [string, string][] = [];
  const cleared: string[] = [];
  const deps: FireWorkDeps = {
    org: ORG,
    store,
    dispatch: (async (forward: Forward, receive?: unknown) => {
      sent.push({ forward, receive });
    }) as FireWorkDeps["dispatch"],
    resolveWork: async ({ seatToken }) => ({ token: work.workTokenForSeat(seatToken) as string, generation: 1, minted: true }),
    noteLedger: async (_org, token, id) => {
      ledger.push([token, id]);
    },
    clearLedger: async (_org, id) => {
      cleared.push(id);
    },
    notifyLost: async () => 0,
    binding: bindingForDivert,
    audit: async () => undefined,
    now: () => "2026-10-06T06:00:00.000Z",
  };
  return { deps, sent, ledger, cleared };
}

const RECEIVE = (() => ({ send: async () => ({}) })) as never;

{
  const plan = fireWork.planFireWork({ surfaceKey: SURFACE, origin: ORIGIN, domains: DOMAINS, seatRowToken: undefined, armed: true });
  ok(plan !== null, "§1 a windowed domain plans a W forward");
  const seat = parseWindowToken(plan!.seatToken);
  eq([seat?.domain, seat?.generation], ["fwork", 1], "§1 D13: with no seat row, the seat token is generation 1 derived from config");
  eq(classifySessionId(plan!.seatToken).kind, "window", "§1 the derived seat token is a standing window token");
  ok(isWorkWindowToken(plan!.workToken), "§1 the plan names W's token");
  eq(plan!.workToken, work.workTokenForSeat(plan!.seatToken), "§1 W derives from the seat token, as a seat's forward derives it");
  const plainPlan = fireWork.planFireWork({ surfaceKey: PLAIN_SURFACE, origin: { platform: "slack", channelId: PLAIN_CHAN }, domains: DOMAINS, seatRowToken: undefined, armed: true });
  eq(parseWindowToken(plainPlan?.seatToken ?? "")?.domain, "fplain", "§1 🔴 EVERY windowed domain plans a W forward — there is no switch to leave off");
  ok(fireWork.planFireWork({ surfaceKey: SURFACE, origin: ORIGIN, domains: DOMAINS, seatRowToken: undefined, armed: false }) === null, "§1 a disarmed deployment plans nothing");
  ok(fireWork.planFireWork({ surfaceKey: LONELY_SURFACE, origin: { platform: "slack", channelId: "C_FLONELY" }, domains: DOMAINS, seatRowToken: undefined, armed: true }) === null, "§1 a surface outside every domain plans nothing");
  const rowToken = formatWindowToken({ domain: "fwork", windowId: "fwork", generation: 3 });
  const withRow = fireWork.planFireWork({ surfaceKey: SURFACE, origin: ORIGIN, domains: DOMAINS, seatRowToken: rowToken, armed: true });
  eq(withRow?.seatToken, rowToken, "§1 the seat row's token is used for the same window");
  const foreign = fireWork.planFireWork({ surfaceKey: SURFACE, origin: ORIGIN, domains: DOMAINS, seatRowToken: formatWindowToken({ domain: "fplain", windowId: "fplain", generation: 2 }), armed: true });
  eq(foreign?.seatToken, plan!.seatToken, "§1 a row for ANOTHER window is ignored; config decides");
}

const PLAN = fireWork.planFireWork({ surfaceKey: SURFACE, origin: ORIGIN, domains: DOMAINS, seatRowToken: undefined, armed: true })!;
{
  const { deps, sent, ledger } = fakeDeps();
  const wakeId = mintWakeId();
  const bag = { ...routineBag(), [OE_REQUESTER_ATTR]: "U_SOMEONE", [OE_REQUESTER_CANDIDATES_ATTR]: '["U_A","U_B"]' };
  const forwarded = await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "Post the digest.", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: bag }, wakeId }, deps);
  ok(forwarded, "§2 the fire forwards");
  eq(sent.length, 1, "§2 one delivery");
  const f = sent[0]!.forward;
  ok(sent[0]!.receive === RECEIVE, "§2 the delivery rides the fire's own live `to`");
  eq(f.token, PLAN.workToken, "§2 the delivery is addressed to W");
  eq(f.requester, fireWork.FIRE_REQUESTER, "§2 the requester names nobody");
  ok(f.fireAttributes !== undefined, "§2 the fire's bag rides");
  eq(f.fireAttributes?.[ROUTINE_MARKER.id], "r-fwork-1", "§2 the routine marker rides");
  eq(f.fireAttributes?.[FIRE_UNATTENDED_ATTR], "true", "§2 the unattended stamp rides");
  eq(f.fireAttributes?.[ROUTINE_MARKER.permissionKey], "oe-routine-perm:r-fwork-1:g1", "§2 the routine's declared-permission key rides — its reach is the routine's");
  ok(!(OE_REQUESTER_ATTR in (f.fireAttributes ?? {})), "§2 🔴 a forwarded person's requester stamp does NOT ride");
  ok(!(OE_REQUESTER_CANDIDATES_ATTR in (f.fireAttributes ?? {})), "§2 🔴 a forwarded candidate set does NOT ride");
  eq(f.seatWakeId, wakeId, "§2 the report address is the fire's own wake");
  eq(f.invokerPosture, "unattended-fire", "§3 a clock fire forwards unattended-fire");
  ok(work.parseWorkRequests(f.message).length === 1 && work.parseWorkRequests(f.message)[0]!.brief === "Post the digest.", "§2 the brief is the fire's prompt, in one request block");
  const row = await work.readWorkRequest(store, ORG, f.requestId);
  ok(row !== undefined, "§2 the request row is written");
  eq(row?.wakeId, wakeId, "§2 the row's answer address is the fire's wake id");
  eq(row?.seatToken, PLAN.seatToken, "§2 the row names the domain seat");
  eq(row?.fire, { owesRoom: true, manual: false, marker: { id: "r-fwork-1", surfaceKey: SURFACE, org: ORG }, posture: "unattended-fire" }, "§2 the row's fire half, posture included");
  eq(row?.requester, fireWork.FIRE_REQUESTER, "§2 the row's requester names nobody");
  ok(row !== undefined && !("requesterAsks" in row), "§2 🔴 a fire carries no requester ask, so its child's judge sees no requester message (OPE-2370)");
  eq([row?.binding.platform, row?.binding.workspace, row?.binding.surface], ["slack", TEAM, CHAN], "§2 the binding is the routine's own surface");
  eq(JSON.parse(JSON.stringify(f.binding)), row?.binding, "§2 the delivery and the row name ONE binding");
  ok(ledger.some(([t, id]) => t === PLAN.seatToken && id === work.workLedgerId(f.requestId)), "§2 a routine that owes the room holds the seat generation (D18)");
  ok(ledger.some(([t, id]) => t === PLAN.workToken && id.endsWith(f.requestId)), "§2 W owes the job");

  const posture = async (auth: { authenticator?: string; principalId?: string; attributes: Record<string, string> }): Promise<unknown> => {
    const d = fakeDeps();
    await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "x", surfaceKey: SURFACE, origin: ORIGIN, auth, wakeId: mintWakeId() }, d.deps);
    return d.sent[0]?.forward.invokerPosture;
  };
  eq(await posture({ authenticator: "webhook", principalId: "webhook:h1", attributes: webhookFireAttributes("h1", TEAM, CHAN, false, true) }), "untrusted-remote", "§3 a webhook fire forwards untrusted-remote");
  eq(await posture({ principalId: "github:webhook", attributes: routineBag() }), "untrusted-remote", "§3 🔴 an event-subscription fire forwards untrusted-remote (its principal id does not ride)");
  eq(await posture({ attributes: routineBag({ [ROUTINE_MARKER.manual]: "true" }) }), "attended-fire", "§3 a manual run forwards attended-fire");
  eq(await posture({ attributes: routineBag({ [INVOKER_POSTURE_ATTR]: "untrusted-remote" }) }), "untrusted-remote", "§3 a stamped narrower posture only tightens");
  ok(WEBHOOK_MARKER_ATTR.length > 0, "§3 fixture sanity");
}

{
  const { deps, sent, ledger } = fakeDeps();
  await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "watch", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag({ [ROUTINE_MARKER.silent]: "true" }) }, wakeId: mintWakeId() }, deps);
  const f = sent[0]!.forward;
  const row = await work.readWorkRequest(store, ORG, f.requestId);
  eq(row?.fire?.owesRoom, false, "§4 a silent routine owes the room nothing");
  ok(!ledger.some(([, id]) => id === work.workLedgerId(f.requestId)), "§4 a silent routine notes no seat-ledger entry");
}

{
  const { deps, sent } = fakeDeps();
  const wakeId = mintWakeId();
  const input = { message: "once", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag() }, wakeId };
  await fireWork.forwardFireToWork(RECEIVE, PLAN, input, deps);
  await fireWork.forwardFireToWork(RECEIVE, PLAN, input, deps);
  eq(sent.length, 1, "§5 a replayed forward of the same fire delivers once");
  const other = fakeDeps();
  await fireWork.forwardFireToWork(RECEIVE, PLAN, { ...input, wakeId: mintWakeId() }, other.deps);
  eq(other.sent.length, 1, "§5 a different fire is a different job");
}

{
  const { deps, sent } = fakeDeps();
  const wakeId = mintWakeId();
  const bare = { [FIRE_UNATTENDED_ATTR]: "true", [ROUTINE_MARKER.id]: "r-x", [ROUTINE_MARKER.surface]: SURFACE };
  const forwarded = await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "x", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: bare }, wakeId }, deps);
  eq(forwarded, false, "§6 a bag with no platform identity does not forward");
  eq(sent.length, 0, "§6 nothing is delivered");
  eq(await work.readWorkRequest(store, ORG, work.workRequestIdFor(`fire:${wakeId}`)), undefined, "§6 no request row is written");
}

{
  const { deps, sent } = fakeDeps();
  await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "r", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag() }, wakeId: mintWakeId() }, deps);
  const requestId = sent[0]!.forward.requestId;
  const raw = JSON.parse((await store.getTaskResult(ORG, work.workRequestKey(requestId)))!) as Record<string, unknown>;
  for (const [label, fire] of [
    ["no owesRoom", { manual: false }],
    ["a string owesRoom", { owesRoom: "true", manual: false }],
    ["a marker with no id", { owesRoom: true, manual: false, marker: { surfaceKey: SURFACE, org: ORG } }],
    ["a scalar", "fire"],
    ["an unknown posture", { owesRoom: true, manual: false, posture: "root" }],
    ["an empty creator", { owesRoom: true, manual: false, creator: "" }],
  ] as const) {
    await store.putTaskResult(ORG, work.workRequestKey(requestId), JSON.stringify({ ...raw, fire }), new Date().toISOString(), 60_000);
    eq(await work.readWorkRequest(store, ORG, requestId), undefined, `§7 a malformed fire half (${label}) reads as NO row`);
  }
  const seatRow = { ...raw };
  delete seatRow.fire;
  await store.putTaskResult(ORG, work.workRequestKey(requestId), JSON.stringify(seatRow), new Date().toISOString(), 60_000);
  eq((await work.readWorkRequest(store, ORG, requestId))?.fire, undefined, "§7 a seat's row has no fire half");
}

{
  const note = work.renderWorkResultNote({ requestId: "q1", taskId: "agent-1", status: "completed", dispatchWakeId: "w-fire-1", fire: true });
  ok(note.includes("trigger"), "§8 the fire note says a trigger ran it");
  ok(!note.includes("people who asked are waiting"), "§8 the fire note claims no one is waiting");
  ok(note.includes("for wake w-fire-1"), "§8 the fire note names the fire's wake");
  ok(note.includes("no_reply"), "§8 the fire note leaves silence open");
  const seat = work.renderWorkResultNote({ requestId: "q1", taskId: "agent-1", status: "completed", dispatchWakeId: "w-seat-1" });
  ok(seat.includes("people who asked are waiting"), "§8 a seat's note is unchanged");
}

{
  const calls: unknown[] = [];
  const fold = (async (opts: unknown) => {
    calls.push(opts);
    return { folded: true } as never;
  }) as NonNullable<Parameters<typeof foldWorkFire>[2]>["fold"];
  const base = { seatToken: PLAN.seatToken, wakeId: "w", origin: ORIGIN, surfaceKey: SURFACE, binding: {} as never, requester: fireWork.FIRE_REQUESTER, nonMemberWake: false, tainted: false, atIso: "x" };
  await foldWorkFire({ ...base, requestId: mintWakeId(), fire: { owesRoom: true, manual: true, marker: { id: "r1", surfaceKey: SURFACE, org: ORG } } }, "ok", { fold, org: ORG });
  eq(calls, [{ marker: { id: "r1", surfaceKey: SURFACE, org: ORG }, sessionOutcome: "ok", manual: true }], "§9 a fire's run folds onto its routine");
  await foldWorkFire({ ...base, requestId: mintWakeId(), fire: { owesRoom: true, manual: false, marker: { id: "r2", surfaceKey: SURFACE, org: ORG } } }, "failed", { fold, org: ORG, sessionId: "sess-w-1" });
  eq(calls[1], { marker: { id: "r2", surfaceKey: SURFACE, org: ORG }, sessionOutcome: "failed", manual: false, sessionId: "sess-w-1" }, "§9 the fold names the work session, so it writes the routine.fire join row");
  calls.length = 1;
  await foldWorkFire({ ...base, requestId: mintWakeId(), fire: { owesRoom: true, manual: false } }, "failed", { fold, org: ORG });
  eq(calls.length, 1, "§9 a config webhook (no marker) folds nothing");
  await foldWorkFire({ ...base, requestId: mintWakeId() }, "failed", { fold, org: ORG });
  eq(calls.length, 1, "§9 a seat's job folds nothing");
  const once = { ...base, requestId: mintWakeId(), fire: { owesRoom: true, manual: false, marker: { id: "r3", surfaceKey: SURFACE, org: ORG } } };
  const first = await foldWorkFire(once, "failed", { fold, org: ORG });
  const late = await foldWorkFire(once, "ok", { fold, org: ORG, sessionId: "sess-w-2" });
  eq([first, late], [true, false], "§9 🔴 a fire folded as lost does not fold again when its late result settles");
  eq(calls.filter((c) => (c as { marker: { id: string } }).marker.id === "r3").length, 1, "§9 one run, one fold");
}

{
  const { deps, sent } = fakeDeps();
  await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "lost", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag() }, wakeId: mintWakeId() }, deps);
  const requestId = sent[0]!.forward.requestId;
  const woken: unknown[] = [];
  const folds: unknown[] = [];
  const cleared: string[] = [];
  const ttls: number[] = [];
  const reissueDeps = {
    markEventSeen: async (org: string, key: string, at: string, ttl: number) => {
      ttls.push(ttl);
      return store.markEventSeen(org, key, at, ttl);
    },
    org: () => ORG,
    store: () => store,
    audit: async () => undefined,
    dispatch: async (input: unknown) => {
      woken.push(input);
      return true;
    },
    mintWakeId,
    clearLedger: async (_org: string, id: string) => {
      cleared.push(id);
    },
    foldFire: (async (_row: unknown, outcome: unknown) => {
      folds.push(outcome);
    }) as never,
  };
  const first = await wakeSeatNeedsReissue({ requestId, edge: "validate", reason: "stamp-names-another-request", stamped: "other" }, reissueDeps);
  const second = await wakeSeatNeedsReissue({ requestId, edge: "task.started", reason: "stamp-names-another-request", stamped: "other" }, reissueDeps);
  eq([first, second], [false, false], "§10 a lost fire wakes no seat");
  eq(woken, [], "§10 🔴 no needs-reissue wake reaches a seat for a fire");
  eq(folds, ["failed"], "§10 a lost fire folds `failed`, once");
  ok(cleared.includes(work.workLedgerId(requestId)), "§10 the seat-ledger entry clears");
  ok(ttls.length > 0 && ttls.every((t) => t >= work.WORK_RESULT_DEDUPE_TTL_MS), "§10 🔴 the lost-fire claim is the LONG one: the two guard edges can reach one fire minutes apart");
}

{
  const { deps, sent } = fakeDeps();
  await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "rotated away", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag({ [ROUTINE_MARKER.silent]: "true" }) }, wakeId: mintWakeId() }, deps);
  const requestId = sent[0]!.forward.requestId;
  const woken: unknown[] = [];
  const folds: unknown[] = [];
  const rows: unknown[] = [];
  const lostDeps = {
    store,
    dispatch: (async (input: unknown) => {
      woken.push(input);
      return true;
    }) as never,
    audit: (async (row: unknown) => {
      rows.push(row);
    }) as never,
    foldFire: (async (_row: unknown, outcome: unknown) => {
      folds.push(outcome);
    }) as never,
  };
  const n1 = await notifyLostWorkRequests({ org: ORG, requestIds: [requestId], reason: "work-session runtime-changed", workToken: PLAN.workToken }, lostDeps);
  await notifyLostWorkRequests({ org: ORG, requestIds: [requestId], reason: "work-session runtime-changed", workToken: PLAN.workToken }, lostDeps);
  eq(n1, 0, "§12 a lost fire sends no seat wake");
  eq(woken, [], "§12 🔴 a silent routine's lost fire wakes NO seat");
  eq(folds, ["failed"], "§12 a lost fire folds `failed`, once");
  ok(rows.some((r) => (r as { detail?: { outcome?: unknown } }).detail?.outcome === "fire-lost"), "§12 the loss is rowed as a lost fire");
}

{
  const common = { requestId: "q-14", requester: fireWork.FIRE_REQUESTER, nonMemberWake: false, tainted: true };
  eq(workResultAttributes({ ...common, invokerPosture: "untrusted-remote" })[INVOKER_POSTURE_ATTR], "untrusted-remote", "§14 🔴 a webhook fire's result wake stamps its posture on the seat's turn");
  ok(!(INVOKER_POSTURE_ATTR in workResultAttributes(common)), "§14 a seat's job's result wake stamps no posture");
}

{
  const { notifyRefusedWorkRequest } = await import("../agent/channels/work-loss.js");
  const { a2aInboundIdentityAttributes } = await import("../agent/a2a/inbound/platform.js");
  const { readA2aInboundTask, writeA2aInboundTask } = await import("../agent/a2a/inbound/task-store.js");
  const { TaskState } = await import("@a2a-js/sdk");
  const entries: readonly [string, (requestId: string, rows: unknown[]) => Promise<unknown>][] = [
    ["lost", (requestId, rows) => notifyLostWorkRequests({ org: ORG, requestIds: [requestId], reason: "work-session runtime-changed", workToken: PLAN.workToken }, { store, dispatch: (async () => true) as never, audit: (async (r: unknown) => void rows.push(r)) as never, foldFire: (async () => undefined) as never })],
    ["refused", (requestId, rows) => notifyRefusedWorkRequest({ org: ORG, requestId, taskId: "agent-x", reason: "task-working" }, { store, dispatch: (async () => true) as never, audit: (async (r: unknown) => void rows.push(r)) as never, foldFire: (async () => undefined) as never })],
    [
      "withheld",
      (requestId, rows) =>
        wakeSeatNeedsReissue(
          { requestId, edge: "validate", reason: "stamp-names-another-request", stamped: "other" },
          { org: () => ORG, store: () => store, audit: async (r: unknown) => void rows.push(r), dispatch: async () => true, mintWakeId, clearLedger: async () => undefined, foldFire: (async () => undefined) as never },
        ),
    ],
  ];
  for (const [label, run] of entries) {
    const taskId = `t-${label}-${mintWakeId().slice(0, 8)}`;
    const { deps: fixedClock, sent } = fakeDeps();
    const deps = { ...fixedClock, now: () => new Date().toISOString() };
    await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "a2a", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag(a2aInboundIdentityAttributes("c16", taskId)) }, wakeId: mintWakeId() }, deps);
    const requestId = sent[0]!.forward.requestId;
    const now = new Date().toISOString();
    await writeA2aInboundTask(store, ORG, "c16", { id: taskId, contextId: "c", status: { state: TaskState.TASK_STATE_WORKING, timestamp: now, message: undefined }, artifacts: [], history: [], metadata: {} }, now);
    const rows: unknown[] = [];
    await run(requestId, rows);
    await run(requestId, rows);
    eq((await readA2aInboundTask(store, ORG, "c16", taskId))?.status?.state, TaskState.TASK_STATE_FAILED, `§16 🔴 a ${label} inbound job ends its A2A task failed`);
    eq(rows.filter((r) => (r as { action?: unknown }).action === "a2a.inbound_answered").length, 1, `§16 the ${label} branch answers the task ONCE across a replay`);
  }
}

{
  const { deps, sent } = fakeDeps();
  await fireWork.forwardFireToWork(RECEIVE, PLAN, { message: "c", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag({ [FIRE_PRINCIPAL_ATTR]: "U_CREATOR" }) }, wakeId: mintWakeId() }, deps);
  const row = await work.readWorkRequest(store, ORG, sent[0]!.forward.requestId);
  eq(row?.fire?.creator, "U_CREATOR", "§15 the request row's fire half names the routine's attested creator");
  const common = { requestId: "q-15", requester: fireWork.FIRE_REQUESTER, nonMemberWake: false, tainted: false };
  const attrs = workResultAttributes({ ...common, fireCreator: "U_CREATOR" });
  eq(attrs[WORK_FIRE_CREATOR_ATTR], "U_CREATOR", "§15 🔴 a fire's result wake names its creator");
  ok(!(FIRE_PRINCIPAL_ATTR in attrs) && !(FIRE_UNATTENDED_ATTR in attrs), "§15 🔴 …and carries NO fire stamp, so the seat's turn does not bind as the creator");
  ok(!(WORK_FIRE_CREATOR_ATTR in workResultAttributes(common)), "§15 a seat's job's result wake names no creator");
  const seatCtx = (a: Record<string, string>) => ({ channel: { kind: "unified" }, session: { id: "s-15", auth: { current: { attributes: { team_id: TEAM, channel_id: CHAN, channel_type: "channel", ...a } } } } }) as never;
  const withCreator = replyAuditFor(seatCtx({ [WORK_FIRE_CREATOR_ATTR]: "U_CREATOR" }), "tool");
  const without = replyAuditFor(seatCtx({}), "tool");
  eq(withCreator.creatorId, "U_CREATOR", "§15 🔴 the reply audit on a fire's result wake names the creator (OPE-660)");
  eq(withCreator.principalId, without.principalId, "§15 …and its author is the binding's, exactly as without the attribute");
  eq(without.creatorId, undefined, "§15 an ordinary turn names no creator");
  const fireBinding = { org: ORG, platform: "slack", workspace: TEAM, surface: CHAN, mode: "channel", visibility: "public", trust: "internal", principalId: "U_CREATOR", principalAttested: true, target: { channelId: CHAN } };
  const resultCtx = (binding: Record<string, unknown>, extra: Record<string, string> = {}) =>
    ({ channel: { kind: "unified" }, session: { id: "s-15r", auth: { current: { attributes: { [work.OE_WORK_RESULT_ATTR]: "q-15", [OE_FROZEN_SURFACE_BINDING_ATTR]: JSON.stringify(binding), ...extra } } } } }) as never;
  const fireReport = replyAuditFor(resultCtx(fireBinding, { [WORK_FIRE_CREATOR_ATTR]: "U_CREATOR" }), "tool");
  eq([fireReport.platform, fireReport.workspace, fireReport.surface], ["slack", TEAM, CHAN], "§15 🔴 a fire's result-wake reply files under the ROUTINE's surface, never the fallback partition");
  eq(fireReport.principalId, SCHEDULE_APP_PRINCIPAL_ID, "§15 🔴 …its author is the schedule principal (OPE-660), never the creator");
  eq(fireReport.creatorId, "U_CREATOR", "§15 …and the creator rides the detail");
  const jobReport = replyAuditFor(resultCtx({ ...fireBinding, principalId: "U_ASKER", principalAttested: undefined }), "tool");
  eq([jobReport.surface, jobReport.principalId], [CHAN, "U_ASKER"], "§15 a job's result-wake reply files under the asker's surface, authored as the asker");
  const noStamp = replyAuditFor(({ channel: { kind: "unified" }, session: { id: "s-15n", auth: { current: { attributes: { [OE_FROZEN_SURFACE_BINDING_ATTR]: JSON.stringify(fireBinding) } } } } }) as never, "tool");
  ok(noStamp.surface !== CHAN || noStamp.principalId !== SCHEDULE_APP_PRINCIPAL_ID, "§15 a frozen binding WITHOUT the result-wake stamp does not take this road");
}

{
  eq(fireFoldOutcome("completed", false), "ok", "§13 a completed fire folds ok");
  eq(fireFoldOutcome("failed", false), "failed", "§13 a failed fire folds failed");
  eq(fireFoldOutcome("cancelled", false), undefined, "§13 🔴 a cancelled fire folds NOTHING — an ok would reset its failure streak");
  eq(fireFoldOutcome("completed", true), "failed", "§13 a host-stopped fire folds failed, whatever eve settled it as");
  eq(fireFoldOutcome("cancelled", true), "failed", "§13 a host stop that eve settled cancelled still folds failed");
  eq(fireFoldOutcome("completed", false, true), undefined, "§13 🔴 a fire stopped by `cancel_work` that eve settled `completed` folds NOTHING (slice F's redeemed ticket)");
  eq(fireFoldOutcome("failed", false, true), "failed", "§13 a redeemed ticket never turns a failure into a cancel");
}

{
  const { deps, sent } = fakeDeps();
  const wakeId = mintWakeId();
  const fake = { org: ORG, armed: true, loadDomains: () => DOMAINS, registryStore: store, work: deps };
  const diverted = await fireWindow.divertTriggeredFire(RECEIVE, { message: "m", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag() }, wakeId }, fake);
  ok(diverted, "§11 the fire is handled");
  eq(sent.length, 1, "§11 a fire forwards to W");
  const plain = fakeDeps();
  const plainWake = mintWakeId();
  const plainHandled = await fireWindow.divertTriggeredFire(
    RECEIVE,
    {
      message: "m",
      surfaceKey: PLAIN_SURFACE,
      origin: { platform: "slack", channelId: PLAIN_CHAN },
      auth: { attributes: routineBag({ channel_id: PLAIN_CHAN, [ROUTINE_MARKER.surface]: PLAIN_SURFACE }) },
      wakeId: plainWake,
    },
    { ...fake, work: plain.deps },
  );
  ok(plainHandled, "§11 the second domain's fire is handled");
  eq(plain.sent.length, 1, "§11 🔴 a fire on a second windowed domain forwards to ITS W too (no switch)");
  const bare = fakeDeps();
  const bareWake = mintWakeId();
  const bareBag = routineBag();
  delete bareBag["team_id"];
  delete bareBag["channel_id"];
  delete bareBag["channel_type"];
  const bareHandled = await fireWindow.divertTriggeredFire(RECEIVE, { message: "m", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: bareBag }, wakeId: bareWake }, { ...fake, work: bare.deps });
  eq(bare.sent.length, 0, "§11 a fire whose auth names no surface does not forward");
  eq(bareHandled, false, "§11 🔴 …and is NOT handled here: the caller keeps its native send (no thread seat)");
  ok(REQUESTER_UNVERIFIED.length > 0, "§11 fixture sanity");
}

{
  const { workSessionLedgerId } = await import("../agent/channels/work-generation.js");
  const { DispatchNotDeliveredError } = await import("../agent/channels/self-dispatch.js");
  const NEW_W = "oe-dom:fwork:win:w/fwork:oe-sup:g4-c3c3c3";
  let failWith: Error | undefined = new DispatchNotDeliveredError("unified continuation binding does not match its durable origin");
  const { deps, sent, ledger, cleared } = fakeDeps();
  const failing: FireWorkDeps = {
    ...deps,
    resolveWork: async () => ({ token: NEW_W, generation: 4, rotated: { from: PLAN.workToken, trigger: "runtime-changed" as const, lostRequestIds: [], lostTaskIds: [], drainingRequestIds: [], drainingTaskIds: [] } }),
    dispatch: (async (forward: Forward, receive?: unknown) => {
      if (failWith !== undefined) throw failWith;
      sent.push({ forward, receive });
    }) as FireWorkDeps["dispatch"],
  };
  const wakeId = mintWakeId();
  const input = { message: "a fire into a rotated W", surfaceKey: SURFACE, origin: ORIGIN, auth: { attributes: routineBag() }, wakeId };
  await assert.rejects(() => fireWork.forwardFireToWork(RECEIVE, PLAN, input, failing), /binding does not match/);
  n++;
  const requestId = work.workRequestIdFor(`fire:${wakeId}`);
  ok(ledger.some(([, id]) => id === work.workLedgerId(requestId)), "§17 fixture: the fire noted the seat's ledger before its delivery");
  ok(cleared.includes(work.workLedgerId(requestId)), "§17 🔴 a definite delivery failure gives back the SEAT's entry, so the seat can rotate");
  ok(cleared.includes(workSessionLedgerId(requestId)), "§17 🔴 …and W's own entry");
  failWith = undefined;
  await fireWork.forwardFireToWork(RECEIVE, PLAN, input, failing);
  eq(sent.filter((s) => s.forward.requestId === requestId).length, 1, "§17 🔴 a re-delivered fire reaches W: the failed attempt gave its once-only claim back");
  failWith = new Error("aborted");
  const wake2 = mintWakeId();
  const before = cleared.length;
  await assert.rejects(() => fireWork.forwardFireToWork(RECEIVE, PLAN, { ...input, wakeId: wake2 }, failing), /aborted/);
  n++;
  eq(cleared.length, before, "§17 🔴 a throw with no proof of non-delivery gives back nothing");
  failWith = undefined;
  await fireWork.forwardFireToWork(RECEIVE, PLAN, { ...input, wakeId: wake2 }, failing);
  eq(sent.filter((s) => s.forward.requestId === work.workRequestIdFor(`fire:${wake2}`)).length, 0, "§17 🔴 …and keeps the claim, so a second delivery cannot start the fire twice");
}

console.log(`fire-work-test: ${n} assertions passed`);
process.exit(0);
