import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
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
  waitForChildren,
  workTaskIdOfCall,
  type AuditRow,
} from "../harness";

const MEMBER_ID = "U0OPE2630MBR";
const BOT_USER_ID = "U0OPE2630BOT";
const MEMBER_DM = "D0OPE2630DM";
const GRID_ID = "E0OPE2630GRID";

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;
const CHILD_HOLD_MS = 120_000;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

let tsCounter = 263_000;

const slack = installSlackWebApiStub((method, params) => {
  switch (method) {
    case "auth.test":
      return { ok: true, user_id: BOT_USER_ID, bot_id: "B0OPE2630BOT", team_id: SLACK_TEAM_ID };
    case "users.info": {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: {
          id,
          name: `ope2630-${id}`,
          team_id: SLACK_TEAM_ID,
          enterprise_user: { enterprise_id: GRID_ID },
          is_bot: id === BOT_USER_ID,
          is_restricted: false,
          is_ultra_restricted: false,
          is_stranger: false,
          profile: { display_name: `ope2630-${id}`, real_name: `OPE 2630 ${id}` },
        },
      };
    }
    case "conversations.members":
      return { ok: true, members: [MEMBER_ID, BOT_USER_ID], response_metadata: { next_cursor: "" } };
    case "conversations.info":
      return {
        ok: true,
        channel: { id: params.get("channel"), is_im: true, user: MEMBER_ID, is_org_shared: true, is_shared: true, is_ext_shared: false, is_pending_ext_shared: false },
      };
    case "conversations.history":
    case "conversations.replies":
      return { ok: true, messages: [] };
    case "chat.postMessage":
      return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    case "chat.update":
    case "chat.postEphemeral":
    case "reactions.add":
    case "reactions.remove":
    case "assistant.threads.setStatus":
      return { ok: true };
    default:
      return undefined;
  }
});
cleanups.push(() => slack.uninstall());

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function approvalButtons(postMark: number, channelId: string): string[] {
  const out: string[] = [];
  for (const call of slack.calls.slice(postMark)) {
    if (call.method !== "chat.postMessage" || call.params.get("channel") !== channelId) continue;
    const raw = call.params.get("blocks");
    if (raw === null) continue;
    const blocks = JSON.parse(raw) as { type?: string; elements?: { action_id: string }[] }[];
    for (const b of blocks) if (b.type === "actions") for (const e of b.elements ?? []) if (e.action_id.startsWith("oe_approval:")) out.push(e.action_id);
  }
  return out;
}

test("🔴 a full member's 1:1 DM on Enterprise Grid hosts the approval card (OPE-2630)", async () => {
  await bootAgent({ stubbedProviderTransport: true, sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  const floor = await import("@open-everywhere/core/agent/access/audience-floor.js");
  floor._resetAudienceFloorCacheForTest();

  const prompt = "post the build summary every weekday morning (ope2630)";
  const child = [{ delayMs: CHILD_HOLD_MS, calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: "g1-routine" }] }, { say: "proposed" }];
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: `set up this routine: ${prompt}` }, id: "g1-work" }] }, { say: NO_REPLY_SENTINEL }],
      child,
    }),
  );
  const postMark = slack.calls.length;
  const cursor = await auditCursor();
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: MEMBER_DM, userId: MEMBER_ID, text: `please ${prompt}`, ts, eventId: `EvOPE2630g1${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the DM wake: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the DM seat's receipt step");
  const taskId = await workTaskIdOfCall(cursor, handle, "g1-work", "the DM job");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: child.length - 1, label: "the worker's terminal step" });
  await consumeSettlement({ armed: settlement, dispatched: handle, taskId, label: "the DM seat's result wake" });
  settlement.dispose();
  expect(handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`), "a scripted step degraded").toEqual([]);

  const ACTIONS = ["approval.requested", "approval.denied"] as const;
  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, ACTIONS);
      return got.some((r) => detailOf(r).kind === "routine.create") ? got : undefined;
    },
    label: "the routine proposal's approval.requested or approval.denied row",
    actions: ACTIONS,
    cursor,
    kind: "routine.create",
  });
  const denied = rows.filter((r) => r.action === "approval.denied" && detailOf(r).at === "propose");
  expect(denied.map((r) => detailOf(r).reason), "🔴 no propose-time refusal: is_org_shared / is_shared do not floor a full member's DM to guest").toEqual([]);
  const requested = rows.filter((r) => r.action === "approval.requested" && detailOf(r).kind === "routine.create");
  expect(requested, "exactly one card was minted").toHaveLength(1);
  const buttons = approvalButtons(postMark, MEMBER_DM).map((a) => a.split(":")[1]);
  expect(buttons, "🔴 the card Slack received in the DM carries Approve and Reject").toEqual(expect.arrayContaining(["approve", "reject"]));
});
