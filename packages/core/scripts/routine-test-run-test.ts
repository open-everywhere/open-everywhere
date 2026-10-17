import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { overrideSettingsForTest, registerSettings } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-routine-test-run-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
_setDeploymentIdentityForTest({ org: "acme" });
registerSettings({});
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: false } });

const testRun = await import("../agent/routines/test-run.js");
ok(!testRun.testRunFenceMounted(), "mount: before the test-run hook module loads, the fence reads as NOT mounted");
await import("../agent/hooks/routine-test-run.js");
ok(testRun.testRunFenceMounted(), "🔴 mount: loading the test-run hook module marks the fence mounted");
const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { fenceToolsetForTestRun } = await import("../agent/access/test-run-fence.js");
type Routine = import("../agent/routines/routine.js").Routine;
type TestRunStamp = import("../agent/routines/test-run.js").TestRunStamp;

{
  for (const name of testRun.TEST_RUN_OPEN_TOOLS) {
    ok(TOOL_CONSEQUENCE[name] !== undefined, `allow list: "${name}" is a real tool row — a renamed tool must not leave a stale name that allows nothing`);
  }
  for (const read of ["read_thread", "list_routines", "web_search", "connection_search", "reply", "agent"]) {
    ok(testRun.testRunToolVerdict(read) === "run", `verdict: "${read}" runs in a test`);
  }
  for (const write of ["post_message", "create_ticket", "set_state", "dm_person", "open_pull_request", "bash", "write_file", "post_file", "ask_room", "subscribe_pr", "report_run_failed", "record_watch_state", "record_job_state", "complete_job", "record_follow_up", "create_routine", "run_routine_now", "test_routine", "react", "edit_reply", "update_status"]) {
    ok(testRun.testRunToolVerdict(write) === "block", `🔴 verdict: "${write}" is blocked in a test`);
  }
  ok(testRun.testRunToolVerdict("brand_new_tool_nobody_listed") === "block", "🔴 verdict: an unknown tool is blocked — the list is default-deny");
  ok(testRun.testRunToolVerdict("connection_execute", { connection: "notion", tool: "search", input: {} }) === "run", "verdict: a connector READ runs");
  ok(testRun.testRunToolVerdict("connection_execute", { connection: "notion", tool: "create_page", input: {} }) === "block", "🔴 verdict: a connector WRITE is blocked");
  ok(testRun.testRunToolVerdict("connection_execute", { connection: "notion", tool: "delete_page", input: {} }) === "block", "verdict: a connector DELETE is blocked");
  ok(testRun.testRunToolVerdict("connection_execute", { nonsense: true }) === "block", "verdict: an unreadable connector target is blocked");
  ok(testRun.testRunToolVerdict("grant__owner__read") === "block", "🔴 verdict: a reserved grant name is blocked whatever verb it spells");
  ok(testRun.testRunToolVerdict("notion__update_page") === "block" && testRun.testRunToolVerdict("notion__fetch") === "run", "verdict: a qualified connector name is tiered by its verb");

  const post = testRun.describeBlockedCall("post_message", { text: "Morning digest:\n3 incidents open", channel: "C0SECRETID" });
  ok(post.what === "post message: “Morning digest: 3 incidents open”", "describe: a post reads as its words and a one-line quote of its text");
  ok(!post.what.includes("C0SECRETID"), "describe: no raw id from the call reaches the person");
  const page = testRun.describeBlockedCall("connection_execute", { connection: "notion", tool: "create-pages", input: { title: "Weekly notes" } });
  ok(page.what === "create pages on notion: “Weekly notes”", "describe: a connector call names the operation and the connection, with the inner input's quote");
  const long = testRun.describeBlockedCall("post_message", { text: "x".repeat(400) });
  ok(long.what.length < 160 && long.what.endsWith("…”"), "describe: a long quote is cut and the cut is shown");

  const none = testRun.renderTestRunSummary({ routine: "the routine “digest”", blocked: [] });
  ok(none.includes("It tried no writes") && none.includes("nothing was posted outside this thread"), "summary: an empty list is said out loud");
  const two = testRun.renderTestRunSummary({
    routine: "the routine “digest”",
    blocked: [
      { tool: "post_message", what: "post message: “hi”" },
      { tool: "post_message", what: "post message: “hi”" },
      { tool: "create_ticket", what: "create ticket: “Fix it”" },
    ],
  });
  ok(two.includes("these 2 writes") && two.includes("• post message: “hi”") && two.includes("• create ticket: “Fix it”"), "summary: lists each distinct blocked write once");
  const many = testRun.renderTestRunSummary({ routine: "r", blocked: Array.from({ length: 15 }, (_, i) => ({ tool: "t", what: `write ${i}` })) });
  ok(many.includes("…and 3 more."), "summary: a long list is capped and counts the rest");
  ok(testRun.renderTestRunSummary({ routine: "r", blocked: [], failed: true }).includes("stopped with an error"), "summary: a failed turn says so");
  const unreadable = testRun.renderTestRunSummary({ routine: "r", blocked: [], unreadable: true });
  ok(unreadable.includes("could not read") && !unreadable.includes("tried no writes"), "🔴 summary: an unreadable list never reads as \"it tried no writes\"");
  const lost = testRun.renderTestRunSummary({ routine: "r", blocked: [], counted: 2 });
  ok(lost.includes("2 more blocked writes could not be listed") && !lost.includes("tried no writes"), "🔴 summary: blocked calls whose rows were lost are counted, never hidden");

  const base = { status: "active", trigger: { kind: "cron" }, surfaceKey: "slack/T1/C1" };
  ok(testRun.testRunRefusal(base) === null, "refusal: an active Slack clock routine can be tested");
  ok(testRun.testRunRefusal({ ...base, status: "disabled" }) === null, "refusal: a disabled routine can be tested before it is turned back on");
  ok(testRun.testRunRefusal({ ...base, trigger: { kind: "event" } }) === testRun.TEST_RUN_NO_EVENT_REFUSAL, "refusal: an event routine that has matched no event has nothing to replay");
  const kept = testRun.replayEventFor({ source: "hook", event: "build", scope: [{ kind: "container", id: "x" }], fields: {}, summary: "Build 7 failed" } as never, "2026-07-02T11:00:00.000Z");
  ok(testRun.testRunRefusal({ ...base, trigger: { kind: "event" }, lastEvent: kept }) === null, "🔴 refusal: an event routine with a kept event CAN be tested (OPE-2540)");
  ok(testRun.testRunRefusal({ ...base, trigger: { kind: "event" }, lastEvent: { at: "x", event: { nonsense: true } } }) === testRun.TEST_RUN_NO_EVENT_REFUSAL, "refusal: an unreadable kept event reads as no event");
  ok(testRun.replayEventFor({ source: "hook", event: "build", scope: [], fields: {}, summary: "x".repeat(testRun.REPLAY_EVENT_MAX_CHARS) } as never, "t") === undefined, "replay: an event too large to keep is not kept");
  const withActor = testRun.replayEventFor({ source: "hook", event: "build", scope: [{ kind: "container", id: "x" }], fields: {}, summary: "s", actor: { id: "42", handle: "alice" } } as never, "t");
  ok(withActor !== undefined && !("actor" in withActor.event) && !JSON.stringify(withActor).includes("alice"), "🔴 replay: the kept event drops the actor — nothing reads it, so the row does not keep it");
  ok(testRun.testRunRefusal({ ...base, status: "done" }) !== null, "refusal: a finished job is terminal");
  ok(testRun.testRunRefusal({ ...base, surfaceKey: "acmechat/T/C" }) === "a test run is not available on this platform", "refusal: a platform with no test-run arm is refused in words");
  testRun.noteTestRunSurface("acmechat", true);
  ok(testRun.testRunRefusal({ ...base, surfaceKey: "acmechat/T/C" }) === null, "🔴 refusal: a platform whose bundle registers a test-run arm can be tested (OPE-2540)");
  testRun.noteTestRunSurface("acmechat", false);
  ok(testRun.testRunRefusal({ ...base, surfaceKey: "acmechat/T/C" }) !== null, "refusal: …and a re-registration without the arm takes it away");
  const flat = testRun.testRunKickoffText({ routine: "the routine “digest”", askedBy: "<@U1>", threaded: false });
  ok(flat.includes("posts only its answer, in this room") && !flat.includes("thread"), "kickoff: a surface with no threads does not promise a thread");
  const replayLine = testRun.testRunKickoffText({ routine: "r", askedBy: "<@U1>", replay: testRun.replayEventWords({ at: "2026-07-02T11:00:00.000Z", event: { event: "pull_request", action: "<!channel> opened", summary: "s" } as never }), filterSkip: true });
  ok(replayLine.includes("a “pull request channel opened” event from 2026-07-02 11:00 UTC") && !replayLine.includes("<!"), "kickoff: the replayed event is named by its kind and time, with no payload markup");
  ok(replayLine.includes("Its filter would not match that event now"), "kickoff: a filter that no longer matches is told, not obeyed");
  ok(testRun.renderTestRunSummary({ routine: "r", blocked: [], threaded: false }).includes("nothing was posted but its answer"), "summary: a surface with no threads does not claim a thread");
  ok(testRun.testRunOffer(base).includes("test it") && testRun.testRunOffer({ ...base, trigger: { kind: "event" } }) === "", "offer: shown only where a test is possible");
}

const STAMP: TestRunStamp = { testId: "t-0000aaaa", routineId: "r-digest", surfaceKey: "slack/T1/C-TEST", org: "acme" };
{
  const ran: string[] = [];
  const recorded: string[] = [];
  const toolset: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> = {
    post_message: { execute: async () => void ran.push("post_message") },
    read_thread: { execute: async () => (ran.push("read_thread"), "thread text") },
    connection_execute: { execute: async (input) => (ran.push(`connection_execute:${String((input as { tool?: string }).tool)}`), "ok") },
  };
  const fenced = fenceToolsetForTestRun(toolset, STAMP, async (_s, name) => void recorded.push(name));
  ok(fenced.includes("post_message") && !fenced.includes("read_thread"), "fence: the write is fenced and the read is left alone");
  const workflowSet: Record<string, unknown> = { ask_question: { description: "a workflow tool" }, web_search: { type: "provider" } };
  fenceToolsetForTestRun(workflowSet, STAMP, async () => undefined);
  ok(workflowSet["ask_question"] === undefined, "🔴 fence: a blocked tool with no execute (a workflow tool) is removed — a stub could never be reached");
  ok(workflowSet["web_search"] !== undefined, "fence: an allowed tool with no execute is left alone");

  let message = "";
  try {
    await toolset.post_message!.execute({ text: "hello" });
  } catch (e) {
    message = String(e);
  }
  ok(!ran.includes("post_message"), "🔴 fence: the blocked tool's REAL execute never ran");
  ok(message.includes("TEST RUN") && message.includes("did NOT run"), "fence: the model is told the call did not run");
  ok(recorded.includes("post_message"), "🔴 fence: the blocked call is recorded for the summary");
  ok((await toolset.read_thread!.execute({})) === "thread text" && ran.includes("read_thread"), "fence: a read still runs");
  ok((await toolset.connection_execute!.execute({ connection: "notion", tool: "search", input: {} })) === "ok", "fence: a connector read reaches the real execute");
  let connectorBlocked = false;
  try {
    await toolset.connection_execute!.execute({ connection: "notion", tool: "create_page", input: { title: "x" } });
  } catch {
    connectorBlocked = true;
  }
  ok(connectorBlocked && !ran.includes("connection_execute:create_page"), "🔴 fence: a connector write never reaches the real execute");
}

const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { projectToolSet } = await import("../agent/access/untrusted-projection.js");
const { markTestRunSession, currentTestRun } = await import("../agent/access/test-run-state.js");
{
  const run = async (marked: boolean): Promise<boolean> => {
    let ran = false;
    await inEveContext(new FakeEveContext(), async () => {
      if (marked) markTestRunSession(STAMP);
      const toolset: Record<string, unknown> = { post_message: { execute: async () => void (ran = true) } };
      projectToolSet(toolset);
      await (toolset.post_message as { execute: () => Promise<unknown> }).execute().catch(() => undefined);
    });
    return ran;
  };
  ok((await run(false)) === true, "projection: control — outside a test the tool runs");
  ok((await run(true)) === false, "🔴 projection: inside a test session the projection fences the write");
}

const { registerSlackTestBridge, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
const { setPlatformStandInForTest } = await import("../agent/identity/binding.js");
setPlatformStandInForTest("slack");
const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
const { withUnattendedConnectorFence } = await import("../agent/connections/connector-auth.js");
const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");
{
  const ROUTINE = {
    id: "r-fence",
    org: "acme",
    surfaceKey: "slack/T0FENCE/C0FENCE",
    trigger: { kind: "cron", expr: "0 3 * * *" },
    prompt: "post the nightly digest to notion",
    createdBy: "U0CREATOR",
    createdAt: "2026-08-28T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
  } as Routine;
  const fireAttrs = routineFireAttributes(ROUTINE, { team_id: "T0FENCE", channel_id: "C0FENCE", channel_type: "channel" }, "channel", true);
  const ask = async (attrs: Record<string, string>, recorded: string[]) => {
    const fence = withUnattendedConnectorFence(() => "user-approval", { grantExists: async () => true, recordTestBlocked: async (_s, name) => void recorded.push(name) });
    return fence({ toolName: "notion__create_page", approvedTools: new Set<string>(), callId: "c1", toolInput: { title: "x" }, session: { id: "s1", auth: { current: { attributes: attrs } } } } as never);
  };
  const control: string[] = [];
  ok((await ask(fireAttrs, control)) === "not-applicable", "connector: control — an ordinary fire's declared write is lifted");
  const recorded: string[] = [];
  const decision = await ask({ ...fireAttrs, ...testRun.testRunAttrs({ id: "t-fence", requestedBy: "U0ME", requestedAt: "2026-10-14T00:00:00.000Z" }) }, recorded);
  const reason = typeof decision === "object" && decision !== null && "reason" in decision ? String(decision.reason) : "";
  ok(typeof decision === "object" && decision !== null && decision.type === "denied", "🔴 connector: a TEST fire's write is refused even with a declared permission");
  ok(reason.includes("TEST RUN") && !reason.includes("waiting in the routine's own room"), "connector: the refusal is the test's, and claims no card");
  ok(recorded.includes("notion__create_page"), "🔴 connector: the refused write is recorded for the summary");
}

const ORG = "acme";
const CHAN = "C-TEST";
const SURFACE = `slack/T1/${CHAN}`;
const routineStore = await import("../agent/routines/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");

const slackPosts: { channel: string; text: string; thread?: string }[] = [];
let postSeq = 0;
registerSlackTestBridge({
  confirmChannelInternal: async () => true,
  channel: { __fixture: "slack" } as never,
  form: async (method: string, body: string) => {
    if (method === "chat.postMessage") {
      const f = new URLSearchParams(body);
      slackPosts.push({ channel: f.get("channel") ?? "", text: f.get("text") ?? "", ...(f.get("thread_ts") ? { thread: f.get("thread_ts")! } : {}) });
    }
    return { ok: true, ts: `1759836620.${String(++postSeq).padStart(6, "0")}` };
  },
});

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "Post the open incident count.",
    createdBy: "U-OWNER",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2099-01-01T00:00:00.000Z",
    ...over,
  };
}

const testTool = (await import("../agent/tools/test_routine.js")).default;
const humanCtx = {
  channel: { kind: "slack" },
  session: { auth: { current: { attributes: { team_id: "T1", channel_id: CHAN, channel_type: "channel", is_ext_shared: "false", trust_checked: "true" }, principalId: "U-ASKER", principalType: "slack-user" } } },
} as never;
const fireCtx = {
  channel: { kind: "slack" },
  session: { auth: { current: { attributes: { team_id: "T1", channel_id: CHAN, channel_type: "channel", [ROUTINE_MARKER.id]: "r-digest" }, principalType: "service" } } },
} as never;
{
  await routineStore.addRoutine({} as never, routine({ id: "r-digest", fireCount: 4, attention: { runs: 7 }, lastRunAt: "2026-07-01T09:00:00.000Z" }));
  await routineStore.addRoutine({} as never, routine({ id: "r-event", trigger: { kind: "event", source: "github" } as never, nextRunAt: null }));

  let refusedFire = false;
  try {
    await testTool.execute({ id: "r-digest" } as never, fireCtx);
  } catch (e) {
    refusedFire = /verified sender/.test(String(e));
  }
  ok(refusedFire, "🔴 tool: a routine FIRE cannot start a test — no acting sender");
  ok((await routineStore.getRoutine(ORG, SURFACE, "r-digest"))?.testRun === undefined, "tool: …and wrote no request");

  const event = (await testTool.execute({ id: "r-event" } as never, humanCtx)) as { queued: boolean; message: string };
  ok(!event.queued && event.message.includes("event"), "tool: an event routine is refused in plain words");
  ok(!event.message.includes("r-event"), "tool: the refusal names the routine in words, not by id");

  const out = (await testTool.execute({ id: "r-digest" } as never, humanCtx)) as { queued: boolean; message: string };
  ok(out.queued, "🔴 tool: a person's request is queued");
  const stamped = await routineStore.getRoutine(ORG, SURFACE, "r-digest");
  ok(stamped?.testRun?.requestedBy === "U-ASKER" && /^t-[0-9a-f]{8}$/.test(stamped.testRun.id), "tool: the request names the asker and an OE-minted test id");
  ok(stamped?.nextRunAt === "2099-01-01T00:00:00.000Z", "tool: the schedule is untouched");
  const again = (await testTool.execute({ id: "r-digest" } as never, humanCtx)) as { queued: boolean };
  ok(!again.queued, "tool: a second request inside one tick is refused");
  const rows = await readAudit({ org: ORG, action: testRun.ROUTINE_TEST_REQUESTED_ACTION });
  ok(rows.some((r) => (r.detail as Record<string, unknown>)?.["id"] === "r-digest" && r.principalId === "U-ASKER"), "tool: the request is audited with the real requester");
}

const dispatch = await import("../agent/schedules/dispatch.js");
const sends: { target: Record<string, unknown>; message: string; attrs: Record<string, string> }[] = [];
const recordingTo = ((_channel: unknown, target: Record<string, unknown>) => ({
  send: async (message: string, opts: { auth: { attributes: Record<string, string> } }) => {
    sends.push({ target, message, attrs: opts.auth.attributes });
  },
})) as never;

async function tick(now: Date): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({ now, to: recordingTo, waitUntil: (p: Promise<unknown>) => void pending.push(p), appAuth: { attributes: {} } } as never);
  await Promise.all(pending);
}

let testThread = "";
let testAttrs: Record<string, string> = {};
{
  const before = await routineStore.getRoutine(ORG, SURFACE, "r-digest");
  const testId = before!.testRun!.id;
  await tick(new Date("2026-07-02T12:00:00.000Z"));

  const root = slackPosts.find((p) => p.channel === CHAN && p.thread === undefined && p.text.startsWith("🧪 Test run of"));
  ok(root !== undefined, "🔴 e2e: the test posts a host-written thread root in the routine's own room");
  ok(root!.text.includes("<@U-ASKER>") && root!.text.includes("blocks every write") && !root!.text.includes("r-digest"), "e2e: the root names the asker and the fence, in words");
  ok(sends.length === 1, "🔴 e2e: exactly one fire — the routine is NOT due, so this is the test");
  const send = sends[0]!;
  testThread = String(send.target["threadTs"] ?? "");
  testAttrs = send.attrs;
  ok(send.target["channelId"] === CHAN && testThread.length > 0, "e2e: the fire goes into a thread of the routine's own room");
  ok(send.attrs[testRun.ROUTINE_TEST_ATTR] === testId && send.attrs[testRun.ROUTINE_TEST_BY_ATTR] === "U-ASKER", "🔴 e2e: the fire carries the host-set test stamp");
  ok(send.attrs["thread_ts"] === testThread, "e2e: the bag names the same thread the delivery does");
  ok(send.attrs[ROUTINE_MARKER.id] === "r-digest", "e2e: it is the routine's own fire bag, so it binds as the real run would");
  ok(send.message.includes("Post the open incident count."), "e2e: the real fire message");

  const after = await routineStore.getRoutine(ORG, SURFACE, "r-digest");
  ok(after?.testRun === undefined, "e2e: the request is consumed");
  ok(after?.nextRunAt === before?.nextRunAt && after?.lastRunAt === before?.lastRunAt, "🔴 e2e: the schedule and the last run do not move");
  ok(after?.fireCount === 4 && after?.attention?.runs === 7 && after?.lastOutcome === before?.lastOutcome, "🔴 e2e: no fire count, no check-in count, no outcome");
  const fired = await readAudit({ org: ORG, action: testRun.ROUTINE_TEST_FIRED_ACTION });
  ok(fired.some((r) => (r.detail as Record<string, unknown>)?.["test"] === testId && (r.detail as Record<string, unknown>)?.["started"] === true), "e2e: the start is audited");

  await tick(new Date("2026-07-02T12:10:00.000Z"));
  ok(sends.length === 1, "e2e: the next tick starts no second test");

  await routineStore.updateRoutine(ORG, SURFACE, "r-event", { testRun: { id: "t-0000beef", requestedBy: "U-ASKER", requestedAt: "2026-07-02T12:00:00.000Z" } });
  await tick(new Date("2026-07-02T12:20:00.000Z"));
  ok(sends.length === 1, "e2e: an untestable routine does not fire");
  ok(slackPosts.some((p) => p.text.includes("did not start") && p.text.includes("event")), "e2e: …and the room is told why, in words");

  const { dispatchTestRuns } = await import("../agent/schedules/routine-test-run.js");
  await routineStore.updateRoutine(ORG, SURFACE, "r-digest", { testRun: { id: "t-0000c0de", requestedBy: "U-ASKER", requestedAt: "2026-07-02T12:00:00.000Z" } });
  const run = (membership: boolean) =>
    dispatchTestRuns([{ ...(routine({ id: "r-digest" })), testRun: { id: membership ? "t-0000feed" : "t-0000c0de", requestedBy: "U-ASKER", requestedAt: "2026-07-02T12:00:00.000Z" } }], {
      to: recordingTo,
      waitUntil: () => undefined,
      appAuth: { attributes: {} } as never,
      now: new Date("2026-07-02T12:30:00.000Z"),
      cap: 3,
      confirmRoomMembership: async () => membership,
      confirmCreatorActive: async () => true,
    } as never);
  const gone = await run(false);
  ok(gone.fired === 0 && gone.refused === 1 && sends.length === 1, "🔴 e2e: a creator no longer in the room gets no test fire");
  ok(slackPosts.some((p) => p.text.includes("can no longer run it in this room")), "e2e: …and the room is told why");

  await routineStore.updateRoutine(ORG, SURFACE, "r-digest", { testRun: { id: "t-0000feed", requestedBy: "U-ASKER", requestedAt: "2026-07-02T12:00:00.000Z" } });
  const [a, b] = await Promise.all([run(true), run(true)]);
  ok(a.fired + b.fired === 1, `🔴 e2e: two overlapping ticks start ONE test (fired ${a.fired} + ${b.fired})`);
}

const testHook = (await import("../agent/hooks/routine-test-run.js")).default;
const { SCHEDULE_APP_AUTHENTICATOR, SCHEDULE_APP_PRINCIPAL_ID, SCHEDULE_APP_PRINCIPAL_TYPE } = await import("../agent/identity/binding.js");
const { recordBlockedCall } = await import("../agent/access/test-run-fence.js");
function fireTurnCtx(attrs: Record<string, string>): never {
  return {
    channel: { kind: "slack" },
    session: {
      id: "sess-test",
      auth: { current: { attributes: attrs, authenticator: SCHEDULE_APP_AUTHENTICATOR, principalId: SCHEDULE_APP_PRINCIPAL_ID, principalType: SCHEDULE_APP_PRINCIPAL_TYPE } },
    },
  } as never;
}
{
  const stamp = testRun.routineTestStamped(testAttrs)!;
  ok(stamp.routineId === "r-digest" && stamp.surfaceKey === SURFACE, "hook: the stamp reads back the routine it belongs to");
  const session = new FakeEveContext();
  const ctx = fireTurnCtx(testAttrs);
  let marked: TestRunStamp | null = null;
  await inEveContext(session, async () => {
    await testHook.events!["turn.started"]!({} as never, ctx);
    marked = currentTestRun();
  });
  ok(marked !== null && (marked as TestRunStamp).testId === stamp.testId, "🔴 hook: a test turn marks its session for the fence");

  await recordBlockedCall(stamp, "post_message", { text: "3 incidents open" });
  await recordBlockedCall(stamp, "connection_execute", { connection: "linear", tool: "create_issue", input: { title: "Follow up" } });
  const postsBefore = slackPosts.length;
  await inEveContext(session, async () => {
    await testHook.events!["turn.completed"]!({} as never, ctx);
  });
  const summary = slackPosts.slice(postsBefore).find((p) => p.thread === testThread);
  ok(summary !== undefined, "🔴 hook: the turn end posts the summary into the test thread");
  ok(summary!.text.includes("post message: “3 incidents open”") && summary!.text.includes("create issue on linear: “Follow up”"), "🔴 hook: the summary lists the writes it blocked");
  ok(!summary!.text.includes("r-digest") && !summary!.text.includes(stamp.testId), "hook: the summary names no raw id");
  await inEveContext(session, async () => {
    await testHook.events!["turn.completed"]!({} as never, ctx);
  });
  ok(slackPosts.slice(postsBefore).filter((p) => p.thread === testThread).length === 1, "hook: a second turn end posts no second summary");

  const { postTestRunSummary } = await import("../agent/hooks/routine-test-run.js");
  const unreadableText = await postTestRunSummary({ ...testAttrs, [testRun.ROUTINE_TEST_ATTR]: "t-0000dead" }, false, {
    post: async () => ({ ok: true }),
    read: async () => {
      throw new Error("store down");
    },
  });
  ok(unreadableText !== undefined && unreadableText.includes("could not read") && !unreadableText.includes("tried no writes"), "🔴 hook: an unreadable log is said, not hidden");
  const latched = await postTestRunSummary({ ...testAttrs, [testRun.ROUTINE_TEST_ATTR]: "t-0000dead" }, false, { post: async () => ({ ok: true }), read: async () => [] });
  ok(latched === undefined, "🔴 hook: the summary latch is on the store — a second post for the same test posts nothing");

  const plain = { ...testAttrs };
  delete plain[testRun.ROUTINE_TEST_ATTR];
  const plainPosts = slackPosts.length;
  let plainMarked: TestRunStamp | null = STAMP;
  await inEveContext(new FakeEveContext(), async () => {
    await testHook.events!["turn.started"]!({} as never, fireTurnCtx(plain));
    plainMarked = currentTestRun();
    await testHook.events!["turn.completed"]!({} as never, fireTurnCtx(plain));
  });
  ok(plainMarked === null && slackPosts.length === plainPosts, "hook: control — an ordinary fire is neither marked nor summarised");
}

const outcomeHook = (await import("../agent/hooks/routine-outcome.js")).default;
const { ROUTINE_AUDIT } = await import("../agent/routines/fire-audit.js");
{
  const fold = async (attrs: Record<string, string>): Promise<void> => {
    await inEveContext(new FakeEveContext(), async () => {
      await outcomeHook.events!["turn.started"]!({} as never, fireTurnCtx(attrs));
      await outcomeHook.events!["turn.failed"]!({} as never, fireTurnCtx(attrs));
    });
  };
  const firesFor = async () => (await readAudit({ org: ORG, action: ROUTINE_AUDIT.fire })).filter((r) => (r.detail as Record<string, unknown>)?.["routineId"] === "r-digest").length;
  const before = await firesFor();
  await fold(testAttrs);
  ok((await firesFor()) === before, "🔴 fold: a FAILED test turn writes no routine.fire row");
  ok((await routineStore.getRoutine(ORG, SURFACE, "r-digest"))?.consecutiveFailures === 0, "🔴 fold: …and no failure strike");
  const plain = { ...testAttrs };
  delete plain[testRun.ROUTINE_TEST_ATTR];
  await fold(plain);
  ok((await routineStore.getRoutine(ORG, SURFACE, "r-digest"))?.consecutiveFailures === 1, "fold: control — the same failed turn WITHOUT the stamp is a strike");
}

{
  testRun._setTestRunFenceMountedForTest(false);
  const base = { status: "active", trigger: { kind: "cron" }, surfaceKey: "slack/T1/C1" };
  ok(testRun.testRunRefusal(base) === testRun.TEST_RUN_UNFENCED_REFUSAL, "🔴 unmounted: a testable routine is refused when nothing can fence its writes");
  ok(testRun.testRunOffer(base) === "", "🔴 unmounted: the create and edit replies offer no test");

  const asked = (await testTool.execute({ id: "r-digest" } as never, humanCtx)) as { queued: boolean; message: string };
  ok(!asked.queued && asked.message.includes("block a test's writes"), "🔴 unmounted: the tool queues no test, and says why in words");
  ok(!asked.message.includes("r-digest") && !asked.message.includes("routine-test-run"), "unmounted: the refusal names no raw id and no roster key");
  ok((await routineStore.getRoutine(ORG, SURFACE, "r-digest"))?.testRun === undefined, "unmounted: …and writes no request");

  const sendsBefore = sends.length;
  const postsBefore = slackPosts.length;
  await routineStore.updateRoutine(ORG, SURFACE, "r-digest", { testRun: { id: "t-00000a11", requestedBy: "U-ASKER", requestedAt: "2026-07-02T13:00:00.000Z" } });
  await tick(new Date("2026-07-02T13:00:00.000Z"));
  ok(sends.length === sendsBefore, "🔴 unmounted: the dispatcher starts NO test fire, so no write runs unfenced");
  const told = slackPosts.slice(postsBefore);
  ok(told.some((p) => p.channel === CHAN && p.thread === undefined && p.text.includes("did not start") && p.text.includes("block a test's writes")), "🔴 unmounted: the room is told why, in words");
  ok(!told.some((p) => p.text.startsWith("🧪 Test run of")), "unmounted: no test thread root posts");
  ok(!told.some((p) => p.text.includes("r-digest") || p.text.includes("t-00000a11")), "unmounted: the room line names no raw id");
  ok((await routineStore.getRoutine(ORG, SURFACE, "r-digest"))?.testRun === undefined, "unmounted: the request is consumed, so the room is told once");
  const why = await readAudit({ org: ORG, action: testRun.ROUTINE_TEST_FIRED_ACTION });
  ok(why.some((r) => (r.detail as Record<string, unknown>)?.["test"] === "t-00000a11" && (r.detail as Record<string, unknown>)?.["started"] === false && (r.detail as Record<string, unknown>)?.["reason"] === "fence-unmounted"), "unmounted: the refusal is audited with its own reason");

  testRun._setTestRunFenceMountedForTest(true);
  await routineStore.updateRoutine(ORG, SURFACE, "r-digest", { testRun: { id: "t-00000a12", requestedBy: "U-ASKER", requestedAt: "2026-07-02T13:10:00.000Z" } });
  await tick(new Date("2026-07-02T13:10:00.000Z"));
  ok(sends.length === sendsBefore + 1 && sends.at(-1)!.attrs[testRun.ROUTINE_TEST_ATTR] === "t-00000a12", "control: with the hook mounted, the same request starts its test");
}

const { registerEventNormalizer } = await import("../agent/routines/event-model.js");
const { admitTrigger } = await import("../agent/routines/ingress.js");
const { dispatchTestRuns } = await import("../agent/schedules/routine-test-run.js");
const REPLAY_SENTINEL = "Build 7 of acme/web failed on main";
{
  registerEventNormalizer({
    source: "build-hook",
    matchKeys: ["status"],
    scopeKeys: [],
    scopeKinds: ["container"],
    resolvesActor: false,
    normalize: (d: { readonly source: string; readonly body: string }) => {
      const body = JSON.parse(d.body) as { status?: string };
      return { source: d.source, event: "build", action: "finished", scope: [{ kind: "container", id: "acme/web" }], fields: { status: body.status ?? "" }, summary: REPLAY_SENTINEL };
    },
  } as never);
  const EV_ID = "r-build";
  await routineStore.addRoutine({} as never, routine({ id: EV_ID, trigger: { kind: "event", source: "build-hook", jq: '.fields.status == "failed"' } as never, nextRunAt: null, prompt: "Explain the failed build." }));

  const before = (await testTool.execute({ id: EV_ID } as never, humanCtx)) as { queued: boolean; message: string };
  ok(!before.queued && before.message.includes("has not matched an event yet"), "🔴 event: before any event, the test is refused in words — there is nothing to replay");

  const deliver = async (status: string, grant: "allow" | "refuse", at: string): Promise<void> => {
    await admitTrigger(
      { source: "build-hook", scheme: "build-hook", headers: {}, body: JSON.stringify({ status }), receivedAt: at, readableBy: [{ level: "org" }] } as never,
      {
        to: (() => ({ send: async () => undefined })) as never,
        org: ORG,
        now: () => new Date(at),
        grant: {
          resolve: () => {
            if (grant === "refuse") throw new Error("no grant");
            return {} as never;
          },
        },
      } as never,
    );
  };
  await deliver("failed", "refuse", "2026-07-02T14:00:00.000Z");
  ok((await routineStore.getRoutine(ORG, SURFACE, EV_ID))?.lastEvent === undefined, "🔴 event: an event the read grant refuses is NOT kept for a replay");
  await deliver("passed", "allow", "2026-07-02T14:01:00.000Z");
  ok((await routineStore.getRoutine(ORG, SURFACE, EV_ID))?.lastEvent === undefined, "event: an event the filter does not match is not kept");
  await deliver("failed", "allow", "2026-07-02T14:02:00.000Z");
  const keptRow = await routineStore.getRoutine(ORG, SURFACE, EV_ID);
  ok(keptRow?.lastEvent?.event.summary === REPLAY_SENTINEL && keptRow.lastEvent.at === "2026-07-02T14:02:00.000Z", "🔴 event: the fan-out keeps the matched, granted event on the row (OPE-2540)");

  const queued = (await testTool.execute({ id: EV_ID } as never, humanCtx)) as { queued: boolean };
  ok(queued.queued, "🔴 event: with a kept event, the test is queued");
  const evSends: { target: Record<string, unknown>; message: string; attrs: Record<string, string> }[] = [];
  const evTo = ((_c: unknown, target: Record<string, unknown>) => ({
    send: async (message: string, opts: { auth: { attributes: Record<string, string> } }) => void evSends.push({ target, message, attrs: opts.auth.attributes }),
  })) as never;
  const buildHook = { id: "build-hook", source: "build-hook", readableBy: [{ level: "org" }] };
  const runEvent = async (over: Record<string, unknown> = {}) =>
    dispatchTestRuns([(await routineStore.getRoutine(ORG, SURFACE, EV_ID))!], {
      to: evTo,
      waitUntil: () => undefined,
      appAuth: { attributes: {} } as never,
      now: new Date("2026-07-02T14:10:00.000Z"),
      cap: 3,
      confirmRoomMembership: async () => true,
      confirmCreatorActive: async () => true,
      eventGrant: { resolve: () => ({}) as never },
      webhooks: () => [buildHook],
      ...over,
    } as never);
  const postsBefore = slackPosts.length;
  const res = await runEvent();
  ok(res.fired === 1 && evSends.length === 1, "🔴 event: the test fires once");
  const evRoot = slackPosts.slice(postsBefore).find((p) => p.text.startsWith("🧪 Test run of"));
  ok(evRoot !== undefined && evRoot.text.includes("It replays the last event the routine matched: a “build finished” event from 2026-07-02 14:02 UTC"), "🔴 event: the thread root names the event it replays, by kind and time");
  ok(!evRoot!.text.includes(REPLAY_SENTINEL) && !evRoot!.text.includes("filter would not match"), "event: the root carries no payload text, and the filter still matches");
  ok(evSends[0]!.message.includes(REPLAY_SENTINEL) && evSends[0]!.message.includes("Explain the failed build."), "🔴 event: the fire message is the event plane's prompt over the kept event");
  ok(evSends[0]!.attrs[testRun.ROUTINE_TEST_ATTR] !== undefined && evSends[0]!.attrs["thread_ts"] === evSends[0]!.target["threadTs"], "event: the fire carries the test stamp, and the bag names the thread the delivery does");
  const { OE_TAINTED_FIRE_ATTR } = await import("../agent/access/taint-signal.js");
  ok(evSends[0]!.attrs[OE_TAINTED_FIRE_ATTR] !== undefined, "🔴 event: a replayed event is an outside party's text, so the fire carries the taint stamp");
  const evAfter = await routineStore.getRoutine(ORG, SURFACE, EV_ID);
  ok(evAfter?.testRun === undefined && evAfter?.lastEvent !== undefined && evAfter?.lastRunAt === undefined, "event: the request is consumed, the kept event stays, and no run is recorded");
  const replayed = await readAudit({ org: ORG, action: testRun.ROUTINE_TEST_FIRED_ACTION });
  ok(replayed.some((r) => (r.detail as Record<string, unknown>)?.["id"] === EV_ID && (r.detail as Record<string, unknown>)?.["replayed"] === true), "event: the start is audited as a replay");

  const ask = async (): Promise<void> => {
    await routineStore.updateRoutine(ORG, SURFACE, EV_ID, { testRun: { id: `t-${Math.random().toString(16).slice(2, 10)}`, requestedBy: "U-ASKER", requestedAt: "2026-07-02T14:10:00.000Z" } });
  };
  await ask();
  const sendsBefore = evSends.length;
  const revoked = await runEvent({ eventGrant: { resolve: () => { throw new Error("revoked"); } } });
  ok(revoked.refused === 1 && evSends.length === sendsBefore, "🔴 event: a revoked read grant refuses the replay — nothing fires");
  ok(slackPosts.some((p) => p.text.includes("can no longer read the event it would replay")), "event: …and the room is told why, in words");
  await ask();
  const gone = await runEvent({ webhooks: () => [] });
  ok(gone.refused === 1 && evSends.length === sendsBefore, "🔴 event: a config hook that is gone refuses the replay");
  ok(slackPosts.some((p) => p.text.includes("the hook its event came from is no longer configured")), "event: …and the room is told why, in words");
  await ask();
  const narrowed = await runEvent({ webhooks: () => [{ ...buildHook, readableBy: [] }] });
  ok(narrowed.refused === 1 && evSends.length === sendsBefore, "🔴 event: a hook whose readableBy was narrowed refuses the replay — the frozen declaration does not grant");
  await ask();
  const triggerOnly = await runEvent({ webhooks: () => [{ ...buildHook, posture: "trigger-only" }] });
  ok(triggerOnly.refused === 1 && evSends.length === sendsBefore, "🔴 event: a hook flipped to trigger-only refuses the replay of a payload-bearing event");
  const posture = await readAudit({ org: ORG, action: testRun.ROUTINE_TEST_FIRED_ACTION });
  ok(posture.some((r) => (r.detail as Record<string, unknown>)?.["reason"] === "posture-changed"), "event: the posture refusal is audited with its own reason");
  await ask();
  const guests = await runEvent({ disclosure: { floor: async () => ({ roster: { resolved: true }, floor: "guest" }) } });
  ok(guests.refused === 1 && evSends.length === sendsBefore, "🔴 event: a room whose audience may not see the event gets no replay");
  await routineStore.updateRoutine(ORG, SURFACE, EV_ID, { trigger: { kind: "event", source: "build-hook", jq: '.fields.status == "passed"' } as never });
  await ask();
  const p2 = slackPosts.length;
  const unmatched = await runEvent();
  ok(unmatched.fired === 1 && slackPosts.slice(p2).some((p) => p.text.includes("Its filter would not match that event now")), "event: a filter that no longer matches the kept event is told in the root, and the test still runs");
}

const { registerRoutineDispatch } = await import("../agent/schedules/routine-dispatch.js");
{
  const armPosts: { channel: string; text: string; anchor?: string }[] = [];
  let seq = 0;
  registerRoutineDispatch("acmechat", {
    resolveTarget: (r) => ({ channel: { __fixture: "acmechat" } as never, target: { channelId: String(r.target?.["channelId"] ?? "") }, mode: "channel", attributes: { channel_id: String(r.target?.["channelId"] ?? "") } }),
    testRun: {
      post: async (dest, text, anchor) => {
        armPosts.push({ channel: String((dest.target as { channelId: string }).channelId), text, ...(anchor !== undefined ? { anchor } : {}) });
        return `m-${++seq}`;
      },
      target: (dest, anchor) => ({ channelId: (dest.target as { channelId: string }).channelId, conversationId: anchor }),
    },
  });
  const AC_SURFACE = "acmechat/W1/R1";
  await routineStore.addRoutine({} as never, routine({ id: "r-acme", surfaceKey: AC_SURFACE, target: { channelId: "R1" } }));
  await routineStore.updateRoutine(ORG, AC_SURFACE, "r-acme", { testRun: { id: "t-0000ac01", requestedBy: "U-ASKER", requestedAt: "2026-07-02T15:00:00.000Z" } });
  const sendsBefore = sends.length;
  const slackBefore = slackPosts.length;
  await tick(new Date("2026-07-02T15:00:00.000Z"));
  const root = armPosts.find((p) => p.text.startsWith("🧪 Test run of"));
  ok(root !== undefined && root.anchor === undefined && root.channel === "R1", "🔴 surface: the bundle's arm posts the opening post, at the top level of the routine's own room");
  ok(root!.text.includes("posts only its answer, in this room") && !root!.text.includes("thread"), "surface: the opening post makes no thread promise");
  ok(slackPosts.length === slackBefore, "surface: nothing posts through Slack");
  ok(sends.length === sendsBefore + 1, "🔴 surface: the test fires once");
  const fire = sends.at(-1)!;
  ok(fire.target["conversationId"] === "m-1" && fire.target["channelId"] === "R1", "🔴 surface: the fire is anchored on the opening post (a session of its own), through the arm's target");
  ok(fire.attrs[testRun.ROUTINE_TEST_ANCHOR_ATTR] === "m-1" && fire.attrs["thread_ts"] === undefined, "surface: the bag carries the anchor, and no Slack thread stamp");
  ok(fire.attrs["channel_id"] === "R1" && fire.attrs[ROUTINE_MARKER.id] === "r-acme", "🔴 surface: the bag is the routine's own bag, so the test binds to the routine's own room");

  const { postTestRunSummary } = await import("../agent/hooks/routine-test-run.js");
  const text = await postTestRunSummary(fire.attrs, false, { read: async () => [{ tool: "post_message", what: "post message: “hi”" }] });
  const summary = armPosts.find((p) => p.anchor === "m-1");
  ok(text !== undefined && summary !== undefined && summary.text === text, "🔴 surface: the summary posts beside the opening post, through the bundle's arm");
  ok(summary!.text.includes("post message: “hi”") && !summary!.text.includes("r-acme"), "surface: the summary lists the blocked write, with no raw id");

  const latchAttrs = { ...fire.attrs, [testRun.ROUTINE_TEST_ATTR]: "t-0000ac09" };
  const missed = await postTestRunSummary(latchAttrs, false, { read: async () => [], surface: async () => undefined });
  ok(missed === undefined, "surface: an unresolvable room posts no summary");
  const retried: string[] = [];
  const retry = await postTestRunSummary(latchAttrs, false, { read: async () => [], surface: async () => ({ routine: "the routine", post: async (_a, t) => (retried.push(t), true) }) });
  ok(retry !== undefined && retried.length === 1, "🔴 surface: …and the latch is not spent, so the next turn end posts the summary");

  const hookAttrs = { ...fire.attrs, [testRun.ROUTINE_TEST_ATTR]: "t-0000ac0a" };
  const hookSession = new FakeEveContext();
  const kept = (await routineStore.getRoutine(ORG, AC_SURFACE, "r-acme"))!;
  await routineStore.removeRoutine({ org: ORG, surfaceKey: AC_SURFACE } as never, "r-acme");
  const before1 = armPosts.length;
  await inEveContext(hookSession, async () => {
    await testHook.events!["turn.completed"]!({} as never, fireTurnCtx(hookAttrs));
  });
  ok(armPosts.length === before1, "surface: a turn end whose routine row cannot be read posts no summary");
  await routineStore.addRoutine({} as never, kept);
  await inEveContext(hookSession, async () => {
    await testHook.events!["turn.completed"]!({} as never, fireTurnCtx(hookAttrs));
  });
  ok(armPosts.slice(before1).some((p) => p.anchor === "m-1" && p.text.startsWith("🧪 Test run of")), "🔴 surface: …and the next turn end of the same test session posts it");

  await routineStore.updateRoutine(ORG, AC_SURFACE, "r-acme", { status: "done", testRun: { id: "t-0000ac02", requestedBy: "U-ASKER", requestedAt: "2026-07-02T15:10:00.000Z" } });
  await tick(new Date("2026-07-02T15:10:00.000Z"));
  ok(armPosts.some((p) => p.text.includes("did not start") && p.text.includes("finished job")), "surface: a refusal is told in the routine's room through the arm");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine-test-run: ${passed} assertions passed`);
