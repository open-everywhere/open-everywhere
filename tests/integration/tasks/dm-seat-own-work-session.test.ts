import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { parseWindowToken } from "@open-everywhere/core/agent/channels/window-key.js";

import {
  afterThisTest,
  armSettlement,
  auditCursor,
  bootAgent,
  consumeSettlement,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackDmWake,
  slackTs,
  waitFor,
  waitForAuditRows,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const OWNER_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0OPE2350DMSEAT";
const BOT_USER_ID = "U0OPE2350DMBOT";
const CHILD_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const BRIEF = "ope2350 dm job: look in my notion for the handbook";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

let tsCounter = 23500;

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: BOT_USER_ID, bot_id: "B0OPE2350DMBOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: { id, name: "ope2350-owner", team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope2350-owner", real_name: "OPE 2350 Owner" } },
      };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "ope2350-dm", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 2 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

test("🔴 a DM seat forwards its job to the DM's OWN work session, whose worker holds the owner's own-account plane, and the seat's turn never waits", async () => {
  armSlack();
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ connectors: { userPrincipal: true } });
  expect(settings.getSettings().connectors.userPrincipal, "the per-user plane is not armed").toBe(true);
  const cursor = await auditCursor();

  const dm = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: BRIEF }, id: "ope2350-dm-work" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: CHILD_HOLD_MS, calls: [{ tool: "connection_search", input: { query: "handbook" }, id: "ope2350-dm-search" }] }, { say: "ope2350 dm job result" }],
    }),
  );
  afterThisTest(() => dm.releaseHolds());

  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: OWNER_ID, text: "ope2350 look in my notion", ts, eventId: `EvOPE2350Dm${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the DM wake: ${res.body.slice(0, 200)}`).toBe(200);

  const seatFirst = await waitFor(() => dm.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the DM seat's turn");
  expect(seatFirst.tools, "🔴 the DM seat holds the forward verb").toContain("work");
  expect(seatFirst.tools, "🔴 the DM seat holds no native `agent`: a child inside its own turn is the hold").not.toContain("agent");
  await waitFor(() => dm.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the DM seat's turn to serve its last step (it forwarded and ended)", TURN_END_CEILING_MS);
  const child = await waitFor(() => dm.requests.find((r) => r.role === "child" && promptOf(r).includes(BRIEF)), "the DM job's worker's first (held) model call");
  expect(await rowsSinceCursor(cursor, ["delegation.task_settled", "delegation.task_failed"], { limit: 50 }), "the job settled before the seat's turn ended — this run measured no hold").toEqual([]);
  const taskId = await workTaskIdOfCall(cursor, dm, "ope2350-dm-work", "the DM job");
  assertNoFault(dm, "the DM seat's turn");

  const forwarded = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 50 });
    return rows.length > 0 ? rows : undefined;
  }, "the DM seat's work.forwarded row");
  expect(forwarded, "one forward, from the DM seat").toHaveLength(1);
  const w = parseWindowToken(String(detailOf(forwarded[0]).workToken ?? ""));
  expect(w?.domain.startsWith("oe-dm/"), "🔴 the DM's job left the DM's own anchor").toBe(true);
  expect(w?.windowId, "🔴 the DM's job did not run in the DM's own work session").toBe(`w/${w?.domain}`);
  expect(detailOf(forwarded[0]).seatSessionId, "the forward did not come from the DM seat's own session").toBe(seatFirst.sessionId);

  const started = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 50 })).find((r) => detailOf(r).task === taskId);
  expect(started, "the DM job's task_started row").toBeDefined();
  const startedSession = detailOf(started).session;
  expect(startedSession, "the task_started row names no session — the checks below would compare nothing").toEqual(expect.stringMatching(/.+/));
  expect(detailOf(started).request, "🔴 the task started for a request other than this seat's forward").toBe(detailOf(forwarded[0]).requestId);
  expect(startedSession, "🔴 the DM job's task started in the DM seat's own session — the seat held the job").not.toBe(seatFirst.sessionId);
  expect(child.sessionId, "the worker ran in the DM seat's own session").not.toBe(seatFirst.sessionId);

  const closing = disposeLater(armSettlement(dm, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  dm.releaseHolds();

  const use = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(cursor, ["connector.use"])).find((r) => detailOf(r).connection === "notion"),
    label: "the DM job's worker's notion connector.use row",
    actions: ["connector.use"],
    cursor,
  });
  expect(detailOf(use).mode, "🔴 the DM's work-session worker did not bind the DM").toBe("dm");
  const mints = await waitForAuditRows({
    probe: async () => {
      const rows = (await rowsSinceCursor(cursor, ["connector.mint"])).filter((r) => detailOf(r).connector === "notion");
      return rows.length > 0 ? rows : undefined;
    },
    label: "the DM job's worker's notion connector.mint row",
    actions: ["connector.mint"],
    cursor,
  });
  expect(mints.map((r) => detailOf(r).subject), "🔴 the DM's work-session worker minted for something other than the DM owner").toEqual(mints.map(() => "user"));
  expect((await rowsSinceCursor(cursor, ["connector.refused"])).filter((r) => detailOf(r).connection === "notion"), "the owner's own notion was refused to the DM's worker").toEqual([]);

  const read = await consumeSettlement({ armed: closing, dispatched: dm, taskId, label: "the DM seat's result wake" });
  expect(read.sessionId, "🔴 the result woke a seat other than the DM seat").toBe(seatFirst.sessionId);
  expect(read.turnId, "the result was read in the forwarding turn").not.toBe(seatFirst.turnId);
  const wake = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 50 })).filter((r) => detailOf(r).outcome === "delivered");
    return rows.length > 0 ? rows : undefined;
  }, "the delivered work.result_wake row");
  expect(wake.map((r) => detailOf(r).taskId), "one delivered result wake, for the DM job").toEqual([taskId]);
  assertNoFault(closing, "the DM seat's result turn");
});
