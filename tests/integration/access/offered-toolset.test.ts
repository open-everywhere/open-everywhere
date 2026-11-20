import { afterAll, beforeAll, expect, test } from "vitest";
import { randomBytes } from "node:crypto";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { setSeatToolsetStubForTest } from "@open-everywhere/core/agent/access/seat-cut.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  SLACK_TEAM_ID,
  slackDmWake,
  slackTs,
  waitFor,
  waitForChildren,
  webhookDeliveryPost,
  workTaskIdOfCall,
  type RecordedRequest,
  type ScriptedHandle,
  type SeatScript,
} from "../harness";
import { diffOffered, EXPECTED_OFFERED, FILE_WRITE_TOOLS, fileWritesOffered, READ_ONLY_SHAPES, type SeatShape } from "./offered-toolset.expected";

const BOT_MENTION = "<@9000000000000000001>";
const CREATOR = "U0OTSCREATOR";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

beforeAll(async () => {
  let tsCounter = 0;
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: "U0OTSBOT", bot_id: "B0OTSBOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: { id, name: "ots-person", team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ots", real_name: "OTS Person" } },
      };
    }
    if (method === "conversations.members") return { ok: true, members: [CREATOR, "U0OTSBOT"], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "ots", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 2 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
  await bootAgent({ sharedSqlite: true });
});

function firstCall(handle: ScriptedHandle, role: RecordedRequest["role"], sessionId?: string): RecordedRequest | undefined {
  return handle.requests.find((r) => r.role === role && r.stepIndex === 0 && (sessionId === undefined || r.sessionId === sessionId));
}

function assertNoFault(handles: readonly ScriptedHandle[]): void {
  for (const h of handles) expect(h.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`)).toEqual([]);
}

function assertShape(shape: SeatShape, request: RecordedRequest | undefined): void {
  expect(request, `${shape}: no model call was recorded for this shape`).toBeDefined();
  const offered = request!.tools;
  expect(fileWritesOffered(shape, offered), `${shape}: OPE-2684 file-write guard`).toEqual([]);
  expect(diffOffered(shape, offered), `${shape}: OPE-2687 offered list`).toEqual([]);
}

async function forward(callId: string, child: SeatScript["child"], childLastStep: number): Promise<{ dispatched: ScriptedHandle; settlement: ScriptedHandle }> {
  const cursor = await auditCursor();
  const dispatched = disposeLater(registerScript({ parent: [{ calls: [{ tool: "work", input: { message: "do the job" }, id: callId }] }, { say: NO_REPLY_SENTINEL }], child }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} do the job` });
  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${callId}: the dispatch turn's receipt step`);
  const settlement = disposeLater(armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, dispatched, callId, `${callId}: the forward receipt`);
  dispatched.releaseHolds();
  await waitForChildren(dispatched, { count: 1, lastStepIndex: childLastStep, label: `${callId}: the worker serves its whole arm` });
  await awaitWorkResult({ handle: settlement, taskId, label: `${callId}: the seat step that read the worker's result` });
  assertNoFault([dispatched, settlement]);
  dispatched.dispose();
  settlement.dispose();
  return { dispatched, settlement };
}

async function fire(name: string, job: boolean): Promise<RecordedRequest | undefined> {
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const surfaceKey = `slack/T0OTS${name}/C0OTS${name}`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const handle = disposeLater(registerScript({ parent: [{ say: "nothing to report" }], child: [{ say: "nothing to report" }] }));
  await addRoutine(
    { org: "default", platform: "slack", workspace: `T0OTS${name}`, surface: `C0OTS${name}`, workspaceKey: `slack/T0OTS${name}`, surfaceKey, domainKey: surfaceKey, key: surfaceKey },
    {
      id: `r-it-ots-${randomBytes(4).toString("hex")}`,
      org: "default",
      surfaceKey,
      target: { channelId: `C0OTS${name}` },
      trigger: { kind: "once", at: dueAt },
      prompt: "check the queue and note anything stuck",
      createdBy: CREATOR,
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveFailures: 0,
      ...(job ? { sessionMode: "job" as const } : {}),
    },
  );
  expect((await runRoutineDispatchTick()).length, `${name}: the dispatcher tick fired nothing`).toBeGreaterThan(0);
  const request = await waitFor(() => firstCall(handle, "child"), `${name}: the fired worker's first model call`);
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.sequence > request.sequence), `${name}: the seat's result-wake call`);
  assertNoFault([handle]);
  handle.dispose();
  return request;
}

test("lean channel seat and delegated worker — and the worker may write (OPE-2684 negative control)", async () => {
  const { dispatched } = await forward("ots-lean", [{ delayMs: 120_000, say: "the job is done" }], 0);
  assertShape("leanChannelSeat", firstCall(dispatched, "parent"));
  const worker = firstCall(dispatched, "child");
  assertShape("delegatedWorker", worker);
  expect(READ_ONLY_SHAPES.has("delegatedWorker")).toBe(false);
  expect(FILE_WRITE_TOOLS.filter((n) => worker!.tools.includes(n))).toEqual(["bash", "checkout_repo", "edit_file", "write_file"]);
  expect(fileWritesOffered("leanChannelSeat", worker!.tools)).toEqual([
    'leanChannelSeat: read-only seat offered file-write tool "bash"',
    'leanChannelSeat: read-only seat offered file-write tool "checkout_repo"',
    'leanChannelSeat: read-only seat offered file-write tool "edit_file"',
    'leanChannelSeat: read-only seat offered file-write tool "write_file"',
  ]);
});

test("lean DM seat", async () => {
  const handle = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
  const ts = slackTs(Date.now(), 7);
  const res = await slackDmWake({ channelId: "D0OTSDMSEAT", userId: "U0OTSDMOWNER", text: "hello there", ts, eventId: `EvOTSDm${ts.replace(".", "")}` });
  expect(res.status).toBe(200);
  const request = await waitFor(() => firstCall(handle, "parent"), "the DM seat's first model call");
  assertNoFault([handle]);
  handle.dispose();
  assertShape("leanDmSeat", request);
});

test("job wake, restricted (a sessionMode job fire) and open (an ordinary fire)", async () => {
  assertShape("jobWakeRestricted", await fire("J", true));
  assertShape("jobWakeOpen", await fire("O", false));
});

test("halted worker — the halt adds no tool and takes no other", async () => {
  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  const store = getOperationalStore();
  await store.setHalt("default", { orgWide: true }, { setBy: "U-operator" });
  try {
    expect((await store.activeHalts("default")).some((r) => r.address.orgWide === true), "the halt fixture is not armed").toBe(true);
    const cursor = await auditCursor();
    const { dispatched } = await forward("ots-halt", [{ delayMs: 120_000, say: "the job is done" }], 0);
    const policies = await rowsSinceCursor(cursor, ["egress.policy"], { limit: 200 });
    expect(
      policies.some((r) => (r.detail as { summary?: unknown } | undefined)?.summary === "deny-all (break-glass halt)"),
      "no egress pass in the halted drive answered halted",
    ).toBe(true);
    assertShape("haltedWorker", firstCall(dispatched, "child"));
  } finally {
    await store.clearHalt("default", { orgWide: true }, { clearedBy: "U-operator" });
  }
});

test("NEGATIVE CONTROL (OPE-2687) — a tool added to every toolset shows in both recorded lists, as one clear diff line per shape", async () => {
  const EXTRA = "ots_control_extra_tool";
  // The extra tool goes in through the seat cut's stub seam, on the `reply` slot, which both shapes
  // hold. The slot then resolves to a map, so eve mounts the extra tool under its own name.
  const original = setSeatToolsetStubForTest(undefined);
  setSeatToolsetStubForTest((slug, toolset) => {
    original?.(slug, toolset);
    const donor = toolset["reply"];
    if (slug === "reply" && donor !== undefined) toolset[EXTRA] = donor;
  });
  try {
    const { dispatched } = await forward("ots-extra", [{ delayMs: 120_000, say: "the job is done" }], 0);
    for (const [shape, request] of [
      ["leanChannelSeat", firstCall(dispatched, "parent")],
      ["delegatedWorker", firstCall(dispatched, "child")],
    ] as const) {
      expect(request, `${shape}: no model call was recorded`).toBeDefined();
      expect(request!.tools).toContain(EXTRA);
      // The control proves its own line only: exactly one diff line names the extra tool, and it is
      // the "offered" line, whatever else the shape's row already disagrees on.
      const line = `${shape}: offered "${EXTRA}", which the expected list does not hold`;
      expect(diffOffered(shape, request!.tools).filter((l) => l.includes(EXTRA))).toEqual([line]);
    }
  } finally {
    setSeatToolsetStubForTest(original);
  }
});

async function wideAndRemote(wideShape: SeatShape, remoteShape: SeatShape, tag: string, channelId: string): Promise<string | undefined> {
  const wide = disposeLater(registerScript({ parent: [{ say: "hello" }] }));
  await discordMentionWake({ channelId, text: `${BOT_MENTION} hello there ${tag}` });
  const wideRequest = await waitFor(() => firstCall(wide, "parent"), `${wideShape}: the first model call`);
  assertNoFault([wide]);
  wide.dispose();
  assertShape(wideShape, wideRequest);

  const remote = disposeLater(registerScript({ parent: [{ say: "ack" }] }));
  const res = await webhookDeliveryPost({ note: `ots-remote-${tag}` });
  expect(res.status).toBe(200);
  const remoteRequest = await waitFor(() => firstCall(remote, "parent"), `${remoteShape}: the first model call`);
  assertNoFault([remote]);
  remote.dispose();
  assertShape(remoteShape, remoteRequest);
  return remoteRequest.sessionId;
}

test("wide seat and untrusted-remote window (window.topology off), with and without delegation.oneshotAgent", async () => {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const before = { topology: settings.getSettings().window.topology, oneshotAgent: settings.getSettings().delegation.oneshotAgent };
  cleanups.push(() => settings.overrideSettingsForTest({ window: { topology: before.topology }, delegation: { oneshotAgent: before.oneshotAgent } }));
  expect(before.oneshotAgent, "the shipped posture arms the one-shot agent").toBe(true);

  settings.overrideSettingsForTest({ window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);
  const shippedFire = await wideAndRemote("wideSeat", "untrustedRemoteWindow", "a", DISCORD_LISTED_CHANNEL_ID);

  settings.overrideSettingsForTest({ window: { topology: false }, delegation: { oneshotAgent: false } });
  expect(settings.getSettings().delegation.oneshotAgent).toBe(false);
  const noOneshotFire = await wideAndRemote("wideSeatNoOneshot", "untrustedRemoteWindowNoOneshot", "b", "1300000000000000977");
  expect(noOneshotFire, "the second webhook fire resumed the first fire's session").not.toBe(shippedFire);

  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  const store = getOperationalStore();
  await store.setHalt("default", { orgWide: true }, { setBy: "U-operator" });
  try {
    const halted = disposeLater(registerScript({ parent: [{ say: "hello" }] }));
    await discordMentionWake({ channelId: "1300000000000000978", text: `${BOT_MENTION} hello there c` });
    const request = await waitFor(() => firstCall(halted, "parent"), "haltedWideSeatNoOneshot: the first model call");
    assertNoFault([halted]);
    halted.dispose();
    assertShape("haltedWideSeatNoOneshot", request);
    // The halt's `web_search` arm cannot show here: eve offers no `web_search` to the scripted
    // model's provider. `test:seat-cut` §6 pins that arm through the model-call cut.
    expect(diffOffered("haltedWideSeatNoOneshot", EXPECTED_OFFERED.wideSeatNoOneshot)).toEqual([
      'haltedWideSeatNoOneshot: offered "web_fetch", which the expected list does not hold',
    ]);
  } finally {
    await store.clearHalt("default", { orgWide: true }, { clearedBy: "U-operator" });
  }
});
