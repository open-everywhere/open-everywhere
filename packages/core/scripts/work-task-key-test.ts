import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { asSchema } from "ai";
import type { WorkRequestRow, WorkRowStore } from "../agent/channels/work.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-work-task-key-")), "ops.sqlite3");

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ workspace: "dev" });
const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();

const key = await import("../agent/hooks/work-task-key.js");
const work = await import("../agent/channels/work.js");
const { guardTaskContinuations } = await import("../agent/access/worker-continuation.js");
const { noteContinuationTurn } = await import("../agent/access/continuation-turn-state.js");
const { recordWorkRequestsThisTurn, workCallClaimed } = await import("../agent/access/work-request-turn.js");
const { requesterVerdictFor, requesterSeatOf, requesterTierOf } = await import("../agent/access/requester-identity.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveDist = dirname(require.resolve("eve/package.json"));
const eveUrl = (p: string) => pathToFileURL(join(eveDist, p)).href;
const { ContextContainer, contextStorage } = (await import(eveUrl("dist/src/context/container.js"))) as {
  ContextContainer: new () => { set(key: unknown, value: unknown): void };
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { AuthKey } = (await import(eveUrl("dist/src/context/keys.js"))) as { AuthKey: unknown };
const inStep = <T>(stamp: string | undefined, fn: () => T): T => {
  const c = new ContextContainer();
  if (stamp !== undefined) c.set(AuthKey, { attributes: { [work.OE_WORK_REQUEST_ATTR]: stamp } });
  return contextStorage.run(c, fn);
};

const ORIGIN = { platform: "slack", channelId: "C_ROOM", threadTs: "100.1" } as const;
const SEAT_TOKEN = "oe-dom:e2e-unified:win:slack_TW_C_ROOM:oe-sup:g1";
const SEAT_TOKEN_LIVE = "oe-dom:e2e-unified:win:slack_TW_C_ROOM:oe-sup:g2";
const binding = { org: "default", platform: "slack", workspace: "TW", surface: "C_ROOM", mode: "channel", visibility: "private", trust: "internal", principalId: "U_ALICE", target: { channelId: "C_ROOM" } };

function memStore(): WorkRowStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async putTaskResult(_org: string, k: string, json: string) {
      rows.set(k, json);
    },
    async getTaskResult(_org: string, k: string) {
      return rows.get(k) ?? null;
    },
  };
}
function requestRow(requestId: string, principalId: string): WorkRequestRow {
  return {
    requestId,
    seatToken: SEAT_TOKEN,
    wakeId: `wake-${requestId}`,
    origin: ORIGIN,
    surfaceKey: "slack/TW/C_ROOM",
    binding: { ...binding, principalId } as never,
    requester: { kind: "requester", principalId },
    nonMemberWake: false,
    tainted: requestId === "req-alice",
    atIso: "2026-10-06T00:00:00.000Z",
  };
}

console.log("§1 a job is keyed only under its own step's stamp:");
eq(key.workStampVerdict("req-a", "req-a"), { kind: "keyed", requestId: "req-a" }, "the stamp names the joined job ⇒ keyed");
eq(
  key.workStampVerdict("req-a", "req-b"),
  { kind: "needs-reissue", requestId: "req-a", reason: "stamp-names-another-request", stamped: "req-b" },
  "🔴 the stamp names ANOTHER job ⇒ needs-reissue, never a silent key under the wrong job",
);
eq(key.workStampVerdict("req-a", undefined), { kind: "needs-reissue", requestId: "req-a", reason: "stamp-absent" }, "🔴 no stamp ⇒ needs-reissue (fail-closed)");
eq(key.workStampVerdict("req-a", ""), { kind: "needs-reissue", requestId: "req-a", reason: "stamp-absent" }, "an empty stamp is no stamp");

console.log("§2 the gate reads the step's own stamp off eve's context:");
eq(inStep("req-a", () => key.liveWorkRequestStamp()), "req-a", "the step's `oe_work_request`, read off eve's `eve.auth` slot");
eq(inStep(undefined, () => key.liveWorkRequestStamp()), undefined, "a step with no auth carries no stamp");
eq(key.liveWorkRequestStamp(), undefined, "no eve context ⇒ no stamp (and the gate then refuses)");

console.log("§3 W's `agent` validate refuses a job under another step's stamp, before any child starts:");
{
  const taskIdInput = (await import(eveUrl("dist/src/execution/tasks/task-id-input.js"))) as { withTaskIdSchema(schema: unknown): unknown };
  const agentContract = (await import(eveUrl("dist/src/tools/framework/agent-contract.js"))) as { SUBAGENT_TOOL_INPUT_SCHEMA: unknown };
  const toolSchema = (await import(eveUrl("dist/src/tools/schema.js"))) as { serializeInputSchema(s: unknown): unknown; toInputSchema(s: unknown): unknown };
  const agentSchema = () => toolSchema.toInputSchema(toolSchema.serializeInputSchema(taskIdInput.withTaskIdSchema(agentContract.SUBAGENT_TOOL_INPUT_SCHEMA)));
  const at = "2026-10-06T00:00:00.000Z";
  const render = (requestId: string, brief: string) => work.renderWorkRequest({ requestId, brief, origin: ORIGIN, nowIso: at });
  const callIn = (turn: string, delivered: readonly [string, string][], stamp: string | undefined, message: string) =>
    inStep(stamp, async () => {
      noteContinuationTurn({ session: { id: "sess-W", turn: { id: turn } } } as never);
      for (const [id, brief] of delivered) recordWorkRequestsThisTurn(turn, render(id, brief));
      const ts: Record<string, { inputSchema: unknown }> = { agent: { inputSchema: agentSchema() } };
      guardTaskContinuations(ts);
      const r = await asSchema(ts.agent.inputSchema as never).validate!({ message });
      return { verdict: r.success ? "ok" : String((r as { error?: Error }).error?.message), claimed: workCallClaimed(turn, message) };
    });
  eq(await callIn("turn-same", [["req-a", "brief A"]], "req-a", "brief A"), { verdict: "ok", claimed: true }, "the job this step received starts, and its claim holds");
  eq(
    await callIn("turn-steered", [["req-a", "brief A"], ["req-b", "brief B"]], "req-b", "brief A"),
    { verdict: key.WORK_CALL_NEEDS_REISSUE_MESSAGE, claimed: false },
    "🔴 job A, started on the step that received job B, is REFUSED: its child would inherit B's bag. The claim is released, so nothing is keyed",
  );
  eq(await callIn("turn-steered-2", [["req-a", "brief A"], ["req-b", "brief B"]], "req-b", "brief B"), { verdict: "ok", claimed: true }, "…while job B, on its own step, starts");
  eq(
    await callIn("turn-single-late", [["req-a", "a paraphrased brief"]], undefined, "anything"),
    { verdict: key.WORK_CALL_NEEDS_REISSUE_MESSAGE, claimed: false },
    "🔴 a single open job whose step carries NO stamp is refused too (fail-closed): D20's paraphrase join never bypasses the stamp",
  );
  eq(await callIn("turn-none", [], undefined, "a seat's own brief"), { verdict: "ok", claimed: false }, "NEGATIVE CONTROL: a turn that holds no forwarded job (not W) is untouched by the gate");

  const c = new ContextContainer();
  const step = (stamp: string, message: string | undefined, deliver?: [string, string]) =>
    contextStorage.run(c, async () => {
      c.set(AuthKey, { attributes: { [work.OE_WORK_REQUEST_ATTR]: stamp } });
      noteContinuationTurn({ session: { id: "sess-W", turn: { id: "turn-retire" } } } as never);
      if (deliver !== undefined) recordWorkRequestsThisTurn("turn-retire", render(deliver[0], deliver[1]));
      if (message === undefined) return "no call";
      const ts: Record<string, { inputSchema: unknown }> = { agent: { inputSchema: agentSchema() } };
      guardTaskContinuations(ts);
      const r = await asSchema(ts.agent.inputSchema as never).validate!({ message });
      return r.success ? "ok" : String((r as { error?: Error }).error?.message);
    });
  const { WORK_REQUEST_UNJOINABLE_MESSAGE } = await import("../agent/access/work-request-turn.js");
  {
    const c2 = new ContextContainer();
    const at2 = (stamp: string, message: string | undefined, deliver?: [string, string]) =>
      contextStorage.run(c2, async () => {
        c2.set(AuthKey, { attributes: { [work.OE_WORK_REQUEST_ATTR]: stamp } });
        noteContinuationTurn({ session: { id: "sess-W", turn: { id: "turn-same-brief" } } } as never);
        if (deliver !== undefined) recordWorkRequestsThisTurn("turn-same-brief", render(deliver[0], deliver[1]));
        if (message === undefined) return "no call";
        const ts: Record<string, { inputSchema: unknown }> = { agent: { inputSchema: agentSchema() } };
        guardTaskContinuations(ts);
        const r = await asSchema(ts.agent.inputSchema as never).validate!({ message });
        return r.success ? "ok" : String((r as { error?: Error }).error?.message);
      });
    eq(await at2("req-s1", "same brief", ["req-s1", "same brief"]), "ok", "job S1 starts on its own step");
    eq(await at2("req-s2", "same brief", ["req-s2", "same brief"]), "ok", "🔴 job S2, SAME brief, on its own step: joins S2 (the step's own job), not the running S1 — nothing refused, nothing re-sent");
    eq(await at2("req-s2", "same brief"), "ok", "a second validation of S2's call answers the same (re-entrant)");
  }
  {
    const c3 = new ContextContainer();
    const at3 = (stamp: string, message: string, deliver?: [string, string]) =>
      contextStorage.run(c3, async () => {
        c3.set(AuthKey, { attributes: { [work.OE_WORK_REQUEST_ATTR]: stamp } });
        noteContinuationTurn({ session: { id: "sess-W", turn: { id: "turn-repeat" } } } as never);
        if (deliver !== undefined) recordWorkRequestsThisTurn("turn-repeat", render(deliver[0], deliver[1]));
        const ts: Record<string, { inputSchema: unknown }> = { agent: { inputSchema: agentSchema() } };
        guardTaskContinuations(ts);
        const r = await asSchema(ts.agent.inputSchema as never).validate!({ message });
        return r.success ? "ok" : String((r as { error?: Error }).error?.message);
      });
    eq(await at3("req-r1", "brief R1", ["req-r1", "brief R1"]), "ok", "job R1 starts on its own step");
    eq(await at3("req-r2", "brief R1", ["req-r2", "brief R2"]), WORK_REQUEST_UNJOINABLE_MESSAGE, "🔴 a REPEAT of R1's call on R2's step is refused as unjoinable — R1 is running, so it is never retired or re-sent");
    eq(await at3("req-r2", "brief R2"), "ok", "…and R2 still starts on its own step");
  }
  eq(await step("req-1", undefined, ["req-1", "brief A"]), "no call", "job 1's step ends with no call (a steer, or a model that waited)");
  eq(await step("req-2", "brief A", ["req-2", "brief B"]), key.WORK_CALL_NEEDS_REISSUE_MESSAGE, "job 1 on job 2's step: refused and retired");
  eq(await step("req-2", "brief A"), WORK_REQUEST_UNJOINABLE_MESSAGE, "🔴 a RETRY of job 1's brief is refused — it never single-joins job 2, the one live job left");
  eq(await step("req-2", "brief B"), "ok", "job 2 starts on its own step");
  eq(await step("req-1b", "brief A", ["req-1b", "brief A"]), "ok", "🔴 the seat's RE-FORWARD of the same brief (a new request) starts on its own step — no tie with the retired job");
}
{
  const at = "2026-10-06T00:00:00.000Z";
  const render = (requestId: string, brief: string) => work.renderWorkRequest({ requestId, brief, origin: ORIGIN, nowIso: at });
  const taskIdInput = (await import(eveUrl("dist/src/execution/tasks/task-id-input.js"))) as { withTaskIdSchema(schema: unknown): unknown };
  const agentContract = (await import(eveUrl("dist/src/tools/framework/agent-contract.js"))) as { SUBAGENT_TOOL_INPUT_SCHEMA: unknown };
  const toolSchema = (await import(eveUrl("dist/src/tools/schema.js"))) as { serializeInputSchema(s: unknown): unknown; toInputSchema(s: unknown): unknown };
  const c = new ContextContainer();
  const step = (stamp: string, message: string | undefined, deliver?: [string, string]) =>
    contextStorage.run(c, async () => {
      c.set(AuthKey, { attributes: { [work.OE_WORK_REQUEST_ATTR]: stamp } });
      noteContinuationTurn({ session: { id: "sess-W", turn: { id: "turn-redeliver" } } } as never);
      if (deliver !== undefined) recordWorkRequestsThisTurn("turn-redeliver", render(deliver[0], deliver[1]));
      if (message === undefined) return "no call";
      const ts: Record<string, { inputSchema: unknown }> = { agent: { inputSchema: toolSchema.toInputSchema(toolSchema.serializeInputSchema(taskIdInput.withTaskIdSchema(agentContract.SUBAGENT_TOOL_INPUT_SCHEMA))) } };
      guardTaskContinuations(ts);
      const r = await asSchema(ts.agent.inputSchema as never).validate!({ message });
      return r.success ? "ok" : String((r as { error?: Error }).error?.message);
    });
  await step("req-x", undefined, ["req-x", "brief X"]);
  eq(await step("req-y", "brief X", ["req-y", "brief Y"]), key.WORK_CALL_NEEDS_REISSUE_MESSAGE, "job X on job Y's step: refused and retired");
  eq(await step("req-y", "brief Y"), "ok", "job Y starts on its own step");
  eq(await step("req-x", "brief X", ["req-x", "brief X"]), "ok", "🔴 the host's RE-DELIVERY of job X (the same request) reaches a step carrying its own stamp and starts there");
}

console.log("§4 task.started keys each task on its own job, with its own requester:");
{
  const store = memStore();
  await work.rememberWorkRequest(store, "default", requestRow("req-alice", "U_ALICE"));
  await work.rememberWorkRequest(store, "default", requestRow("req-bob", "U_BOB"));
  const audits: Record<string, unknown>[] = [];
  const deps = { org: () => "default", store: () => store, audit: async (r: unknown) => void audits.push(r as Record<string, unknown>) };
  eq(await key.keyWorkTask({ taskId: "agent-1", callId: "c1", workSessionId: "sess-W", joined: "req-alice", stamped: "req-alice" }, deps), { kind: "keyed", requestId: "req-alice" }, "alice's task, on alice's step, is keyed");
  eq(await key.keyWorkTask({ taskId: "agent-2", callId: "c2", workSessionId: "sess-W", joined: "req-bob", stamped: "req-bob" }, deps), { kind: "keyed", requestId: "req-bob" }, "bob's task, on bob's step, is keyed");
  eq(await key.readWorkTaskKey(store, "default", "agent-1"), { requestId: "req-alice", verdict: "keyed" }, "the key row round-trips");
  eq(
    audits.map((a) => [a.action, a.principalId, (a.detail as { taskId?: unknown }).taskId, (a.detail as { requester?: unknown }).requester, (a.detail as { tier?: unknown }).tier]),
    [
      [key.WORK_TASK_KEYED_ACTION, "U_ALICE", "agent-1", "U_ALICE", "child"],
      [key.WORK_TASK_KEYED_ACTION, "U_BOB", "agent-2", "U_BOB", "child"],
    ],
    "🔴 each task's row names ITS OWN requester, from the request row S wrote — two jobs in one W, two people",
  );
  eq(
    await key.keyWorkTask({ taskId: "agent-3", callId: "c3", workSessionId: "sess-W", joined: "req-alice", stamped: "req-bob" }, deps),
    { kind: "needs-reissue", requestId: "req-alice", reason: "stamp-names-another-request", stamped: "req-bob" },
    "🔴 the tripwire: a task whose bag names another job is keyed needs-reissue",
  );
  eq(await key.readWorkTaskKey(store, "default", "agent-3"), { requestId: "req-alice", verdict: "needs-reissue", reason: "stamp-names-another-request" }, "…and its row says so, for the settlement to read");
  eq(await key.readWorkTaskKey(store, "default", "agent-none"), undefined, "no row ⇒ undefined (the settlement treats it as needs-reissue)");
  store.rows.set(key.workTaskKeyKey("agent-bad"), "{not json");
  eq(await key.readWorkTaskKey(store, "default", "agent-bad"), undefined, "a malformed row ⇒ undefined, never a throw");
}

console.log("§5 needs-reissue wakes the asking room's seat once, with no child output:");
{
  const store = memStore();
  await work.rememberWorkRequest(store, "default", requestRow("req-alice", "U_ALICE"));
  const sent: Record<string, unknown>[] = [];
  const cleared: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const deps = {
    org: () => "default",
    store: () => store,
    audit: async (r: unknown) => void audits.push(r as Record<string, unknown>),
    dispatch: async (input: unknown) => {
      sent.push(input as Record<string, unknown>);
      return true;
    },
    mintWakeId: () => "wake-reissue-1",
    markEventSeen: async (_org: string, k: string) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
    clearLedger: async (_org: string, id: string) => void cleared.push(id),
    liveSeat: async (_org: string, recorded: string) => (recorded === SEAT_TOKEN ? SEAT_TOKEN_LIVE : recorded),
  };
  ok(await key.wakeSeatNeedsReissue({ requestId: "req-alice", edge: "validate", reason: "stamp-names-another-request", stamped: "req-bob" }, deps), "the first refusal wakes the seat");
  ok(!(await key.wakeSeatNeedsReissue({ requestId: "req-alice", edge: "task.started", reason: "stamp-names-another-request", taskId: "agent-9" }, deps)), "🔴 a second edge for the SAME request wakes nothing: one notice per job");
  eq(sent.length, 1, "exactly one wake was delivered");
  const w = sent[0]!;
  eq([w.seatToken, w.origin, w.requestId, (w.requester as { principalId?: unknown }).principalId, w.tainted], [SEAT_TOKEN_LIVE, ORIGIN, "req-alice", "U_ALICE", true], "🔴 the wake goes to the LIVE generation of the seat alice's request row names (OPE-2341), and her room, under her authority, with the forward's taint bit");
  const message = String(w.message);
  ok(message.includes("req-alice") && message.includes("NOT run") && message.includes("call `work` once more"), "the validate notice tells the seat the job did not run, and to forward it again");
  const ran = key.renderNeedsReissueNote({ requestId: "req-alice", dispatchWakeId: "wake-req-alice", taskId: "agent-9", edge: "task.started" });
  ok(ran.includes("RAN") && ran.includes("may already have acted") && !ran.includes("NOT run"), "🔴 the TRIPWIRE notice never says the job did not run: the child had started, and OE could not stop it");
  ok(message.includes("wake-req-alice"), "…and carries the address of the wake that asked (the request row's own wake)");
  ok(!message.includes("trust=\"relay\""), "it carries no relayed child output at all");
  const { workSessionLedgerId } = await import("../agent/channels/work-generation.js");
  eq(cleared, [work.workLedgerId("req-alice"), workSessionLedgerId("req-alice")], "D18 and OPE-2341: the seat generation's entry AND W's own entry for the job are freed once the seat holds the notice");
  eq(
    audits.map((a) => (a.detail as { outcome?: unknown }).outcome),
    ["delivered", "replay-skipped"],
    "every edge writes its `work.needs_reissue` row",
  );
  ok(!(await key.wakeSeatNeedsReissue({ requestId: "req-missing", edge: "validate", reason: "stamp-absent" }, deps)), "a request with no row wakes nothing");
  eq((audits.at(-1)!.detail as { outcome?: unknown; why?: unknown }).why, "request-row-missing", "…and says why");
}

console.log("§5b a refused job is re-sent once by the host, then handed to the seat:");
{
  const store = memStore();
  await work.rememberWorkRequest(store, "default", requestRow("req-alice", "U_ALICE"));
  await work.rememberWorkRequest(store, "default", requestRow("req-kept-none", "U_ALICE"));
  const forward = {
    token: "oe-dom:e2e-unified:win:w/slack_TW_C_ROOM:oe-sup:g1",
    requestId: "req-alice",
    message: "<the rendered job>",
    origin: ORIGIN,
    surfaceKey: "slack/TW/C_ROOM",
    binding: binding as never,
    requester: { kind: "requester" as const, principalId: "U_ALICE" },
    nonMemberWake: false,
    seatWakeId: "wake-req-alice",
    tainted: true,
    invokerPosture: "untrusted-remote",
    ownAccountAsk: "ask-ope2328",
    taintKinds: ["web"],
    identity: { ws: "TW" },
  };
  await key.rememberWorkForward(store, "default", forward as never, "2026-10-06T00:00:00.000Z");
  eq(await key.readWorkForward(store, "default", "req-alice"), forward, "the kept forward round-trips WHOLE — identity, taint classes, the SEAT's invoker posture and its own-account ask (OPE-2328) included, so the re-send is the seat's own delivery");
  const resent: unknown[] = [];
  const woke: string[] = [];
  const seen = new Set<string>();
  const deps = {
    org: () => "default",
    store: () => store,
    audit: async () => undefined,
    dispatch: async () => true,
    mintWakeId: () => "w",
    clearLedger: async () => undefined,
    markEventSeen: async (_o: string, k: string) => (seen.has(k) ? false : (seen.add(k), true)),
    redeliver: async (f: unknown) => void resent.push(f),
    wakeSeat: async (i: { requestId: string }) => (woke.push(i.requestId), true),
  };
  eq(await key.reissueWorkRequest({ requestId: "req-alice", reason: "stamp-names-another-request", stamped: "req-bob", deliveryId: "dlv-1" }, deps as never), "redelivered", "🔴 the first refusal: the HOST re-sends the forward");
  eq(resent, [forward], "…the exact forward the seat made, once");
  eq(await key.reissueWorkRequest({ requestId: "req-alice", reason: "stamp-names-another-request", stamped: "req-bob", deliveryId: "dlv-1" }, deps as never), "redelivered", "🔴 the SAME step refusing again (a replay): no second re-send, and NO seat wake — the job must not be forwarded twice");
  eq([resent.length, woke], [1, []], "…one re-send, and nobody woken");
  eq(await key.reissueWorkRequest({ requestId: "req-alice", reason: "stamp-names-another-request", stamped: "req-carol", deliveryId: "dlv-2" }, deps as never), "seat", "🔴 refused in ANOTHER step (the re-send was batched with another forward): no second re-send — the seat is woken");
  eq([resent.length, woke], [1, ["req-alice"]], "one re-send, then one seat wake");
  await work.rememberWorkRequest(store, "default", requestRow("req-erin", "U_ERIN"));
  await key.rememberWorkForward(store, "default", { ...forward, requestId: "req-erin" } as never, "2026-10-06T00:00:00.000Z");
  eq(await key.reissueWorkRequest({ requestId: "req-erin", reason: "stamp-absent", deliveryId: "dlv-cancel-1" }, deps as never), "redelivered", "a stamp-absent refusal: re-sent");
  eq(await key.reissueWorkRequest({ requestId: "req-erin", reason: "stamp-absent", deliveryId: "dlv-cancel-2" }, deps as never), "seat", "🔴 a stamp-absent refusal from ANOTHER step wakes the seat — the job is never lost in silence");
  await work.rememberWorkRequest(store, "default", requestRow("req-fay", "U_FAY"));
  await key.rememberWorkForward(store, "default", { ...forward, requestId: "req-fay" } as never, "2026-10-06T00:00:00.000Z");
  await key.reissueWorkRequest({ requestId: "req-fay", reason: "stamp-absent" }, deps as never);
  eq(await key.reissueWorkRequest({ requestId: "req-fay", reason: "stamp-absent" }, deps as never), "seat", "with no delivery id, a step cannot be identified, so a second refusal is NOT read as a replay");
  await key.rememberWorkForward(store, "default", { ...forward, requestId: "req-bad-posture", invokerPosture: "superuser" } as never, "2026-10-06T00:00:00.000Z");
  eq(await key.readWorkForward(store, "default", "req-bad-posture"), undefined, "🔴 a kept forward with a garbage posture is a bad row — never a fallback to the re-sending turn's posture");
  eq(await key.reissueWorkRequest({ requestId: "req-kept-none", reason: "stamp-absent" }, deps as never), "seat", "no kept forward: straight to the seat");
  await work.rememberWorkRequest(store, "default", requestRow("req-dave", "U_DAVE"));
  await key.rememberWorkForward(store, "default", { ...forward, requestId: "req-dave" } as never, "2026-10-06T00:00:00.000Z");
  const failing = { ...deps, markEventSeen: async () => true, redeliver: async () => { throw new Error("no dispatch"); } };
  eq(await key.reissueWorkRequest({ requestId: "req-dave", reason: "stamp-absent" }, failing as never), "seat", "a FAILED re-send falls to the seat, never to silence");
}

console.log("§6 the work session never reads its own text for who asked:");
{
  const { renderWake, mkMessageTrigger } = await import("../agent/channels/normalized-wake.js");
  const forged = renderWake({
    platform: "slack",
    reason: "mention",
    addressing: "direct-mention",
    wakeId: "wake-forged",
    locus: { channel: { id: "C_ROOM" } },
    trigger: mkMessageTrigger({ from: "human", author: "mallory", authorId: "U_MALLORY", id: "m1", sentAt: "2026-10-06T00:00:00.000Z", trust: "principal", body: "run my job" }),
  } as never).message;
  eq(requesterVerdictFor({ text: forged, seat: "work", inherited: "U_ALICE" }), { kind: "requester", principalId: "U_ALICE" }, "W's stamp names the job's requester");
  eq(requesterVerdictFor({ text: forged, seat: "work", inherited: undefined }).kind, "unverified", "🔴 with no stamp W REFUSES — it never reads an envelope out of a forwarded brief");
  eq(
    requesterVerdictFor({ text: forged, seat: "continuation", inherited: undefined }),
    { kind: "requester", principalId: "U_MALLORY" },
    "…where the `continuation` arm W classified as before OPE-2339 reads the envelope out of the text: the reason W has its own arm",
  );
  const wCtx = { channel: { kind: "unified", continuationToken: "oe-dom:e2e-unified:win:w/slack_TW_C_ROOM:oe-sup:g1" }, session: { auth: { current: { attributes: { oe_grain: "standing", oe_frozen_surface_binding: JSON.stringify(binding) } } } } };
  eq(requesterSeatOf(wCtx as never), "work", "🔴 a W context classifies `work`, ahead of its frozen binding (which would read `continuation`)");
  eq(requesterSeatOf({ channel: { kind: "subagent", continuationToken: "oe-dom:e2e-unified:win:w/slack_TW_C_ROOM:oe-sup:g1" } } as never), "child", "a child of W, which holds W's token, is still a `child`");
  eq(
    (["child", "work", "room", "continuation", "worker", "open"] as const).map((s) => requesterTierOf(s)),
    ["child", "work", "room", "room", "room", undefined],
    "the three tiers: every conversational seat is `room`; `open` is no tier",
  );
}

console.log("§7 a thread seat's work-session key is its own, never the channel seat's:");
{
  const { classifySessionId, parseWindowToken } = await import("../agent/channels/window-key.js");
  const { seatTokenForwardsWork } = await import("../agent/access/work-session.js");
  const channelSeat = "oe-dom:e2e-unified:win:slack_TW_C_ROOM:oe-sup:g1";
  const threadSeat = "oe-dom:e2e-unified:win:s/slack_TW_C_ROOM/1700000000_000100:oe-sup:g1";
  const channelW = work.workTokenForSeat(channelSeat);
  const threadW = work.workTokenForSeat(threadSeat);
  ok(threadW !== undefined && channelW !== undefined && threadW !== channelW, "🔴 the thread seat's W token differs from the channel seat's: a spawned thread never shares the channel's W (ruling Q2)");
  eq(classifySessionId(threadW).kind, "work", "…and it classifies as a work session");
  eq(parseWindowToken(threadW!)?.windowId, "w/s/slack_TW_C_ROOM/1700000000_000100", "…keyed on the thread seat's own window");
  eq(work.workTokenForSeat(threadW!), undefined, "a work session has no work session of its own");
  eq([classifySessionId(threadSeat).kind, seatTokenForwardsWork(threadSeat)], ["thread-seat", true], "🔴 a thread seat forwards to its own work session (ruling Q2)");
  eq(seatTokenForwardsWork(channelSeat), true, "a standing seat forwards");
  eq(seatTokenForwardsWork("oe-dom:it-memory:win:discord_1300000000000000100_1300000000000000101:oe-sup:g1"), true, "🔴 a standing seat on a domain with no work-session config forwards too — no per-domain switch exists");
  const { formatWindowToken, dmWindowKey, isDmAnchorWindowToken, dmAnchorSurfaceForToken } = await import("../agent/channels/window-key.js");
  const dmSeat = formatWindowToken(dmWindowKey("slack/T0EXAMPLE/D0DMSEAT", 1));
  eq([classifySessionId(dmSeat).kind, seatTokenForwardsWork(dmSeat)], ["window", true], "🔴 a DM seat is a window token on the `oe-dm/` pseudo-domain, and it forwards to its own work session");
  const dmW = work.workTokenForSeat(dmSeat);
  eq(parseWindowToken(dmW!)?.domain, "oe-dm/slack/T0EXAMPLE/D0DMSEAT", "🔴 the DM's work session sits on the DM's own anchor, so it reaches the DM's room and nothing wider");
  eq(dmAnchorSurfaceForToken(dmW), "slack/T0EXAMPLE/D0DMSEAT", "…and it admits deliveries to the DM's own surface only");
  eq([classifySessionId(dmW).kind, isDmAnchorWindowToken(dmW), isDmAnchorWindowToken(dmSeat)], ["work", false, true], "🔴 the DM's work session is not mistaken for the DM seat");
  eq(seatTokenForwardsWork(dmW!), false, "a work session does not forward");
  eq(seatTokenForwardsWork(threadW!), false, "a thread seat's work session does not forward");
  eq(seatTokenForwardsWork("oe-dom:e2e-unified:win:t/slack_TW_C_ROOM/1700000000_000100:oe-sup:g1"), false, "a worker leaf does not forward");
}

console.log("§8 the gate's light half refuses on its own, and the heavy half registers the reissue:");
{
  const light = await import("../agent/access/work-step-stamp.js");
  const calls: unknown[] = [];
  eq(
    await light.gateWorkCallStamp("req-a", "req-b", async (i) => (calls.push(i), "redelivered")),
    { kind: "needs-reissue", requestId: "req-a", reason: "stamp-names-another-request", stamped: "req-b" },
    "the gate refuses a mismatched stamp",
  );
  eq(calls, [{ requestId: "req-a", reason: "stamp-names-another-request", stamped: "req-b" }], "…and hands the job to the reissue it was given");
  eq(
    (await light.gateWorkCallStamp("req-a", undefined, null)).kind,
    "needs-reissue",
    "🔴 with NO reissuer the refusal still stands — fail-closed, and logged as an error",
  );
  ok(key.gateWorkCallStamp === light.gateWorkCallStamp, "the heavy module re-exports the one gate");
  ok(light.registeredWorkReissuer() === key.reissueWorkRequest, "🔴 loading hooks/work-task-key.ts registers its reissueWorkRequest with the gate");
}

console.log(`\n✓ work-task-key: ${n} assertions`);
