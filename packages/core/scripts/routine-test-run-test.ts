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
  ok(testRun.testRunRefusal({ ...base, trigger: { kind: "event" } }) !== null, "refusal: an event routine has no event to test with");
  ok(testRun.testRunRefusal({ ...base, status: "done" }) !== null, "refusal: a finished job is terminal");
  ok(testRun.testRunRefusal({ ...base, surfaceKey: "teams/T/C" }) !== null, "refusal: Slack only for now");
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

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine-test-run: ${passed} assertions passed`);
