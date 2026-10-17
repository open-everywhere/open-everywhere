import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-work-surface-wait-")), "ops.sqlite3");

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ workspace: "dev" });
const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const surface = await import("../agent/channels/surface-session-state.js");
const wait = await import("../agent/channels/work-surface-wait.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");

let n = 0;
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const DM_ATTRS = { team_id: "T1", channel_id: "D1", channel_type: "im", user_id: "U7", agent_session_ts: "1700159720.000100", oe_wake: "w-1" };
const dmCtx = (attributes: Record<string, unknown> = DM_ATTRS) => ({
  channel: { kind: "slack", continuationToken: "D1:oe-dm:g1" },
  session: { id: "sess-job-wait", auth: { current: { principalId: "U7", principalType: "slack-user", attributes } } },
});
const PINNER: import("../agent/channels/surface-session-state.js").SurfaceSessionPinner = (a) =>
  a.channel_type === "im" && typeof a.agent_session_ts === "string" && typeof a.channel_id === "string"
    ? { id: `${a.channel_id}:${a.agent_session_ts}`, attributes: { channel_id: a.channel_id, channel_type: "im", agent_session_ts: a.agent_session_ts } }
    : undefined;
const SETTER = async (a: Readonly<Record<string, unknown>>) => (typeof a.agent_session_ts === "string" ? `${String(a.channel_id)}:${a.agent_session_ts}` : undefined);
const PIN = { platform: "slack", id: "D1:1700159720.000100", attributes: { channel_id: "D1", channel_type: "im", agent_session_ts: "1700159720.000100" } };

function fakeDeps() {
  const rows = new Map<string, string>();
  const marks: { readonly id: string; readonly status: string }[] = [];
  const audits: Record<string, unknown>[] = [];
  const deps: import("../agent/channels/work-surface-wait.js").WorkWaitDeps = {
    org: () => "org-1",
    store: () => ({
      putTaskResult: async (_o, k, json) => void rows.set(k, json),
      getTaskResult: async (_o, k) => rows.get(k) ?? null,
      deleteTaskResult: async (_o, k) => rows.delete(k),
    }),
    mark: async (pin, status) => void marks.push({ id: pin.id, status }),
    audit: async (row) => void audits.push(row.detail ?? {}),
    now: () => new Date("2026-10-14T12:00:00.000Z"),
  };
  return { rows, marks, audits, deps };
}

console.log("§1 the pin");
{
  surface._resetSurfaceSessionStateForTest();
  eq(surface.pinSurfaceSession(surface.surfaceTurnOf(dmCtx())), undefined, "no setter registered: no surface turn, no pin");
  surface.registerSurfaceSessionState("slack", SETTER);
  eq(surface.pinSurfaceSession(surface.surfaceTurnOf(dmCtx())), undefined, "a setter with no pinner: no pin");
  surface.registerSurfaceSessionState("slack", SETTER, PINNER);
  eq(surface.pinSurfaceSession(surface.surfaceTurnOf(dmCtx())), PIN, "a stamped DM delivery pins its session: ids only, never the wake stamp");
  eq(surface.pinSurfaceSession(surface.surfaceTurnOf(dmCtx({ team_id: "T1", channel_id: "D1", channel_type: "im", oe_work_result: "r-1" }))), undefined, "a result wake's bag names no session, so it pins nothing");
  surface.registerSurfaceSessionState("slack", SETTER, () => {
    throw new Error("bad pinner");
  });
  eq(surface.pinSurfaceSession(surface.surfaceTurnOf(dmCtx())), undefined, "a throwing pinner never escapes");
  surface.registerSurfaceSessionState("slack", SETTER, PINNER);
}

console.log("§2 the decision");
{
  const base = { signInResumable: false, asked: false, status: "completed", stopped: false, cancelRedeemed: false };
  eq(wait.settledJobWaitReason(base), undefined, "a job that asked nothing waits on nobody");
  eq(wait.settledJobWaitReason({ ...base, asked: true }), "asked", "a completed job whose worker asked the room waits for the answer");
  eq(wait.settledJobWaitReason({ ...base, signInResumable: true }), "sign-in", "a job that can resume after a sign-in waits for it");
  eq(wait.settledJobWaitReason({ ...base, asked: true, status: "failed" }), undefined, "a failed job waits on nobody, even after a question");
  eq(wait.settledJobWaitReason({ ...base, asked: true, status: "cancelled" }), undefined, "a cancelled job waits on nobody");
  eq(wait.settledJobWaitReason({ ...base, asked: true, stopped: true }), undefined, "a job the host stopped waits on nobody");
  eq(wait.settledJobWaitReason({ ...base, asked: true, cancelRedeemed: true }), undefined, "a 'completed' job whose cancel ticket was redeemed is a stop, and waits on nobody");
}

console.log("§3 the rows");
{
  const { rows, marks, audits, deps } = fakeDeps();
  eq(await wait.noteJobForwarded({ requestId: "req-1", ctx: dmCtx() }, deps), PIN, "the forward pins the DM session it came from");
  eq(marks, [], "a fresh forward sets nothing");
  eq(await wait.noteJobForwarded({ requestId: "req-x", ctx: { channel: { kind: "discord" }, session: { auth: { current: { attributes: {} } } } } }, deps), undefined, "a forward no surface pins records nothing");
  eq([...rows.keys()].filter((k) => k.includes("req-x")), [], "and writes no row");

  await wait.noteJobSettledWait({ requestId: "req-1", taskId: "task-1", waits: "asked" }, deps);
  eq(marks, [{ id: PIN.id, status: "suspended" }], "a waiting settlement sets the DM session suspended");
  eq(await wait.readWaitingJobs(deps.store(), "org-1", PIN, deps.now()), [{ requestId: "req-1", taskId: "task-1", atIso: "2026-10-14T12:00:00.000Z" }], "and lists the job on the session, since its settlement");
  eq(audits.at(-1), { requestId: "req-1", taskId: "task-1", state: "suspended", reason: "asked" }, "the audit row carries ids, the state and the reason: never text");
  await wait.noteJobSettledWait({ requestId: "req-1", taskId: "task-1", waits: "asked" }, deps);
  eq((await wait.readWaitingJobs(deps.store(), "org-1", PIN, deps.now())).length, 1, "a replay keeps one entry per task");

  await wait.noteJobForwarded({ requestId: "req-2", ctx: dmCtx() }, deps);
  marks.length = 0;
  await wait.noteJobSettledWait({ requestId: "req-2", taskId: "task-2", waits: undefined }, deps);
  eq(marks, [], "a sibling job that settles without a question sets nothing");
  eq((await wait.readWaitingJobs(deps.store(), "org-1", PIN, deps.now())).length, 1, "and the first job still waits");

  await wait.noteJobForwarded({ requestId: "req-3", openingRequestId: "req-1", taskId: "task-1", ctx: dmCtx() }, deps);
  eq(await wait.readWaitingJobs(deps.store(), "org-1", PIN, deps.now()), [], "the continuation moves the job on: it leaves the list");
  eq(marks, [], "the forwarding turn's own park settles the session, so the forward sets nothing");
  eq(audits.at(-1), { requestId: "req-3", taskId: "task-1", state: "moved-on", left: "none", set: "none" }, "the move-on audit row");

  await wait.noteJobSettledWait({ requestId: "req-3", taskId: "task-1", waits: "sign-in" }, deps);
  eq(marks.at(-1), { id: PIN.id, status: "suspended" }, "a job waiting on a sign-in sets the session suspended");
  marks.length = 0;
  const resumeCtx = dmCtx({ team_id: "T1", channel_id: "D1", channel_type: "im", oe_work_result: "r-1" });
  eq(await wait.noteJobForwarded({ requestId: "req-4", openingRequestId: "req-3", taskId: "task-1", ctx: resumeCtx }, deps), PIN, "a continuation from a turn with no pin inherits the opening request's conversation");
  eq(marks, [{ id: PIN.id, status: "active" }], "no turn of the conversation runs, so the move-on sets it active");
  marks.length = 0;
  await wait.noteJobForwarded({ requestId: "req-5", openingRequestId: "req-4", taskId: "task-1", ctx: resumeCtx }, deps);
  eq(marks, [], "moving on a task that does not wait sets nothing");
  await wait.noteJobSettledWait({ requestId: "req-5", taskId: "task-1", waits: "asked" }, deps);
  marks.length = 0;
  const otherSession = dmCtx({ ...DM_ATTRS, agent_session_ts: "1700159720.000900" });
  await wait.noteJobForwarded({ requestId: "req-6", openingRequestId: "req-5", taskId: "task-1", ctx: otherSession }, deps);
  eq(await wait.readWaitingJobs(deps.store(), "org-1", PIN, deps.now()), [], "an answer from another agent session moves the job on in the session it waits in");
  eq(marks, [{ id: PIN.id, status: "active" }], "and sets that session active, because the forwarding turn shows another session");

  await wait.noteJobSettledWait({ requestId: "req-1", taskId: "task-old", waits: "asked" }, deps);
  const later = { ...deps, now: () => new Date("2026-10-14T17:00:00.000Z") };
  await wait.noteJobSettledWait({ requestId: "req-2", taskId: "task-new", waits: "asked" }, later);
  const muchLater = new Date("2026-10-14T19:00:00.000Z");
  eq((await wait.readWaitingJobs(deps.store(), "org-1", PIN, muchLater)).map((j) => j.taskId), ["task-new"], "an entry older than 6 hours reads as gone, though a sibling's write kept the row alive");
  eq(await wait.conversationHasWaitingJob(PIN, { ...deps, now: () => new Date("2026-10-15T00:00:00.000Z") }), false, "and once every entry is older than 6 hours, the conversation waits on nothing");
  await deps.store().deleteTaskResult("org-1", `oe-surface-wait:slack:${PIN.id}`);
  marks.length = 0;

  await wait.noteJobSettledWait({ requestId: "req-unknown", taskId: "task-9", waits: "asked" }, deps);
  eq(marks, [], "a job with no recorded conversation sets nothing");
}

console.log("§4 the real turn-anchor hook's park");
{
  surface._resetSurfaceSessionStateForTest();
  const calls: string[] = [];
  surface.registerSurfaceSessionState("slack", async (a, status) => {
    calls.push(status);
    return SETTER(a);
  }, PINNER);
  const hook = (await import("../agent/hooks/turn-anchor.js")).default as unknown as { events: Record<string, (e: unknown, ctx?: unknown) => Promise<void>> };
  const turn = (id: string) =>
    inEveContext(new FakeEveContext(), async () => {
      await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: id } }, dmCtx());
      await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, dmCtx());
    });
  const live: import("../agent/channels/work-surface-wait.js").WorkWaitDeps = { ...fakeDeps().deps, org: deploymentOrg, store: getOperationalStore, mark: async () => undefined, now: () => new Date() };
  await turn("p0");
  eq(calls, ["processing", "active"], "(baseline) a turn with no waiting job parks active");
  await wait.noteJobForwarded({ requestId: "hreq-1", ctx: dmCtx() }, live);
  await wait.noteJobSettledWait({ requestId: "hreq-1", taskId: "htask-1", waits: "asked" }, live);
  calls.length = 0;
  await turn("p1");
  eq(calls, ["processing", "suspended"], "🔴 while a forwarded job waits, a turn that reports nothing still parks suspended");
  surface.registerSurfaceSessionState("slack", async (a, status) => {
    calls.push(status);
    return SETTER(a);
  });
  calls.length = 0;
  await turn("p2");
  eq(calls, ["processing", "active"], "with no pinner, the park reads no job wait");
  surface.registerSurfaceSessionState("slack", async (a, status) => {
    calls.push(status);
    return SETTER(a);
  }, PINNER);
  calls.length = 0;
  await inEveContext(new FakeEveContext(), async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "p3" } }, dmCtx());
    await wait.noteJobForwarded({ requestId: "hreq-2", openingRequestId: "hreq-1", taskId: "htask-1", ctx: dmCtx() }, live);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, dmCtx());
  });
  eq(calls, ["processing", "active"], "the turn that forwards the answer parks active");

  const steered: { readonly status: string; readonly session: unknown }[] = [];
  surface.registerSurfaceSessionState("slack", async (a, status) => {
    steered.push({ status, session: a.agent_session_ts });
    return SETTER(a);
  }, PINNER);
  await wait.noteJobForwarded({ requestId: "hreq-3", ctx: dmCtx() }, live);
  await wait.noteJobSettledWait({ requestId: "hreq-3", taskId: "htask-3", waits: "asked" }, live);
  const ctxB = dmCtx({ ...DM_ATTRS, agent_session_ts: "1700159720.000200" });
  await inEveContext(new FakeEveContext(), async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "p4" } }, dmCtx());
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, ctxB);
  });
  eq(
    steered,
    [
      { status: "processing", session: "1700159720.000100" },
      { status: "active", session: "1700159720.000200" },
      { status: "suspended", session: "1700159720.000100" },
    ],
    "the session with no job parks active, and the session the turn started on, where a job waits, parks suspended",
  );
}

console.log("§5 the worker's mark");
{
  const { deps } = fakeDeps();
  const store = deps.store();
  eq(await wait.rememberWorkAsked(dmCtx() as never, store), false, "a seat is not a work-session child: no mark");
  const token = "subagent:sess-w:call-1";
  await store.putTaskResult("org-1", `oe-work-asked:${token}`, "{}", "", 1000);
  eq(await wait.readWorkAsked("org-1", token, store), true, "a settlement reads the delegation's mark");
  eq(await wait.readWorkAsked("org-1", "not-a-token", store), false, "a malformed delegation key reads nothing");
  await wait.forgetWorkAsked("org-1", token, store);
  eq(await wait.readWorkAsked("org-1", token, store), false, "the settlement forgets it, so a later continuation does not read it");
}

console.log("§6 the wiring");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = (rel: string) => readFileSync(join(here, "..", rel), "utf8");
  const askRoom = src("agent/tools/ask_room.ts");
  eq(/await postOnce\([\s\S]*?\);\s*[\s\S]{0,400}await rememberWorkAsked\(c\);/.test(askRoom), true, "ask_room marks the delegation AFTER its post");
  const workTool = src("agent/tools/work.ts");
  eq(/await rememberWorkRequest\([\s\S]*?\}\);[\s\S]{0,600}await noteJobForwarded\(\{ requestId, ctx: c,/.test(workTool), true, "the forward records the conversation right after the request row");
  const spawn = src("agent/hooks/spawn-taint.ts");
  eq(/run: async \(\) => \{[\s\S]*?if \(silentFire\) return;\s*(?:\/\/[^\n]*\n\s*)*if \(row\.fire === undefined\) \{\s*const waits = settledJobWaitReason\([\s\S]*?await noteJobSettledWait\([\s\S]*?delivered = await dispatchWorkResult\(/.test(spawn), true, "W's settlement writes the wait inside the once-guard, for a seat's job only, BEFORE the result wake");
  eq(spawn.indexOf("await noteJobSettledWait(") < spawn.indexOf("await settleSignIn("), true, "the wait is written before the sign-in resume can wake the seat");
  eq(/if \(ran && childToken !== undefined && asked\) await forgetWorkAsked\(org, childToken\);/.test(spawn), true, "W's settlement forgets the worker's mark once it ran");
  const anchor = src("agent/hooks/turn-anchor.ts");
  eq(/parkedSurfaceStatus\(needsPerson \|\| \(await conversationHasWaitingJob\(pinSurfaceSession\(turn\)\)\)\)/.test(anchor), true, "the park reads the conversation's waiting jobs");
}

surface._resetSurfaceSessionStateForTest();
console.log(`✅ work-surface-wait: ${n} assertions passed`);
