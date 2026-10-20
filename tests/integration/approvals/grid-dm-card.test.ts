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
const CONNECT_MEMBER_ID = "U0OPE2640CXM";
const CONNECT_DM = "D0OPE2640CX";
const PROPOSE_MEMBER_ID = "U0OPE2640MBR";
const PROPOSE_DM = "D0OPE2640DM";

const DM_PARTNER: Readonly<Record<string, string>> = { [MEMBER_DM]: MEMBER_ID, [PROPOSE_DM]: PROPOSE_MEMBER_ID, [CONNECT_DM]: CONNECT_MEMBER_ID };

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
      return { ok: true, members: [DM_PARTNER[params.get("channel") ?? ""] ?? MEMBER_ID, BOT_USER_ID], response_metadata: { next_cursor: "" } };
    case "conversations.info": {
      const channel = params.get("channel") ?? "";
      const user = DM_PARTNER[channel] ?? MEMBER_ID;
      if (channel === CONNECT_DM) return { ok: true, channel: { id: channel, is_im: true, user, is_org_shared: false, is_shared: true, is_ext_shared: true, is_pending_ext_shared: false } };
      return { ok: true, channel: { id: channel, is_im: true, user, is_org_shared: true, is_shared: true, is_ext_shared: false, is_pending_ext_shared: false } };
    }
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

function mcpProposeInput(name: string): Record<string, unknown> {
  return {
    name,
    url: `https://mcp.${name}.example.com/mcp`,
    description: `The ${name} fixture's hosted MCP server (OPE-2640).`,
    docUrls: [`https://docs.${name}.example.com/mcp`],
    reason: "a member asked for it in their own DM",
  };
}

async function proposeMcpServerInDm(input: { readonly channelId: string; readonly userId: string; readonly name: string; readonly tag: string }) {
  process.env.OE_ACCESS_ADMIN_CHANNEL = "C_IT_ADMIN_FAKE";
  process.env.OE_ACCESS_CONFIG_REPO = "example-owner/open-everywhere-it-fixture";
  try {
    await bootAgent({ stubbedProviderTransport: true, sharedSqlite: true });
    const settings = await import("@open-everywhere/core/agent/settings/settings.js");
    settings.overrideSettingsForTest({ approvals: { judgeMode: "off" } });
    const floor = await import("@open-everywhere/core/agent/access/audience-floor.js");
    floor._resetAudienceFloorCacheForTest();

    const ask = `please add the ${input.name} MCP server (${input.tag})`;
    const child = [{ delayMs: CHILD_HOLD_MS, calls: [{ tool: "propose_mcp_server", input: mcpProposeInput(input.name), id: `${input.tag}-propose` }] }, { say: "proposed" }];
    const handle = disposeLater(
      registerScript({
        parent: [{ calls: [{ tool: "work", input: { message: ask }, id: `${input.tag}-work` }] }, { say: NO_REPLY_SENTINEL }],
        child,
      }),
    );
    const postMark = slack.calls.length;
    const cursor = await auditCursor();
    const ts = slackTs(Date.now(), (tsCounter += 1));
    const res = await slackDmWake({ channelId: input.channelId, userId: input.userId, text: ask, ts, eventId: `Ev${input.tag}${ts.replace(".", "")}` });
    expect(res.status, `the Slack front refused the DM wake: ${res.body.slice(0, 200)}`).toBe(200);

    await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the DM seat's receipt step");
    const taskId = await workTaskIdOfCall(cursor, handle, `${input.tag}-work`, "the DM job");
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
        return got.some((r) => detailOf(r).kind === "mcp-server.propose") ? got : undefined;
      },
      label: "the MCP-server proposal's approval.requested or approval.denied row",
      actions: ACTIONS,
      cursor,
      kind: "mcp-server.propose",
    });
    const mine = rows.filter((r) => detailOf(r).kind === "mcp-server.propose");
    return {
      denied: mine.filter((r) => r.action === "approval.denied" && detailOf(r).at === "propose"),
      requested: mine.filter((r) => r.action === "approval.requested"),
      buttons: approvalButtons(postMark, input.channelId).map((a) => a.split(":")[1]),
    };
  } finally {
    delete process.env.OE_ACCESS_ADMIN_CHANNEL;
    delete process.env.OE_ACCESS_CONFIG_REPO;
  }
}

test("🔴 a full member can propose an MCP server from their 1:1 DM on Enterprise Grid, and the card posts there (OPE-2640)", async () => {
  const got = await proposeMcpServerInDm({ channelId: PROPOSE_DM, userId: PROPOSE_MEMBER_ID, name: "ope2640grid", tag: "OPE2640g" });
  expect(got.denied.map((r) => detailOf(r).reason), "🔴 no propose-time refusal: is_org_shared / is_shared do not floor a full member's DM to guest").toEqual([]);
  expect(got.requested, "exactly one mcp-server.propose card was minted").toHaveLength(1);
  expect(got.buttons, "🔴 the mcp-server.propose card Slack received in the DM carries Approve and Reject").toEqual(expect.arrayContaining(["approve", "reject"]));
});

test("a Slack Connect 1:1 DM still refuses the MCP-server propose card (OPE-2640 negative control)", async () => {
  const got = await proposeMcpServerInDm({ channelId: CONNECT_DM, userId: CONNECT_MEMBER_ID, name: "ope2640connect", tag: "OPE2640c" });
  expect(got.denied.map((r) => detailOf(r).reason), "the Connect bit is an observed outside party: the card-disclosure floor refuses at propose").toEqual(["audience-floor"]);
  expect(got.requested, "no card was minted").toEqual([]);
  expect(got.buttons, "Slack received no approval buttons in the Connect DM").toEqual([]);
});
