import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  afterThisTest,
  auditCursor,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  type AuditRow,
} from "../harness";

const CHANNEL = "C0OPE2572NAT";
const SURFACE_KEY = `slack/${SLACK_TEAM_ID}/${CHANNEL}`;
const BOT_USER_ID = "U0BOTSELF01";
const MEMBER_USER_ID = "U0OPE2572MEM";
const GUEST_USER_ID = "U0OPE2572GST";
const CREATOR_USER_ID = "U0OPE2572CRT";

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function userInfo(id: string, guest: boolean): Record<string, unknown> {
  return {
    ok: true,
    user: { id, name: id, team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: guest, is_ultra_restricted: false, is_stranger: false, real_name: id, profile: { display_name: id, real_name: id } },
  };
}

test("a GUEST's native reply in a report thread is stamped and does not clear the check-in count; a member's does", async () => {
  let tsCounter = 2572;
  const slack = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: "B0BOTSELF01", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const user = params.get("user");
        if (user === MEMBER_USER_ID) return userInfo(MEMBER_USER_ID, false);
        if (user === GUEST_USER_ID) return userInfo(GUEST_USER_ID, true);
        return undefined;
      }
      case "conversations.info":
        return { ok: true, channel: { id: params.get("channel"), name: "it-ope2572", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 } };
      case "conversations.members":
        return { ok: true, members: [MEMBER_USER_ID, GUEST_USER_ID, CREATOR_USER_ID], response_metadata: { next_cursor: "" } };
      case "conversations.history":
      case "conversations.replies":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      case "reactions.add":
      case "reactions.remove":
        return { ok: true };
      default:
        return undefined;
    }
  });
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const before = settings.getSettings();
  const topologyBefore = before.window.topology;
  const policyBefore = { authorGrain: before.externalPolicy.authorGrain, roomGrain: before.externalPolicy.roomGrain };
  afterThisTest(() => settings.overrideSettingsForTest({ window: { topology: topologyBefore }, externalPolicy: policyBefore }));
  settings.overrideSettingsForTest({ window: { topology: false }, externalPolicy: { authorGrain: "taint", roomGrain: "engage" } });
  try {
    const cursor = await auditCursor();
    const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
    const id = `r-it-2572-${randomBytes(4).toString("hex")}`;
    await addRoutine(
      { org: "default", platform: "slack", workspace: SLACK_TEAM_ID, surface: CHANNEL, workspaceKey: `slack/${SLACK_TEAM_ID}`, surfaceKey: SURFACE_KEY, domainKey: SURFACE_KEY, key: SURFACE_KEY },
      {
        id,
        org: "default",
        surfaceKey: SURFACE_KEY,
        target: { channelId: CHANNEL },
        trigger: { kind: "interval", everyMinutes: 60 },
        prompt: "ope2572 post the open incident count",
        createdBy: CREATOR_USER_ID,
        status: "active",
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        promptGeneration: 1,
        consecutiveFailures: 0,
        attention: { runs: 40 },
      },
    );

    const reportText = "ope2572 four incidents are open";
    const reportScript = registerScript({ parent: [{ calls: [{ tool: "reply", input: { text: reportText }, id: "ope2572-report" }] }, { say: NO_REPLY_SENTINEL }] });
    afterThisTest(() => reportScript.dispose());
    await runRoutineDispatchTick();
    const report = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["reply.post"], { limit: 200 });
      return rows.find((r) => r.surface === CHANNEL && detailOf(r).chars === reportText.length);
    }, "the native fire's reply.post row for the routine's report", 150_000);
    const reportTs = String(detailOf(report).id);
    expect((await getRoutine("default", SURFACE_KEY, id))?.attention?.runs, "precondition: the fire counted one more run").toBe(41);
    reportScript.dispose();

    disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
    const guestCursor = await auditCursor();
    const guestTs = slackTs(Date.now(), (tsCounter += 1));
    const guestRes = await slackMentionWake({ channelId: CHANNEL, userId: GUEST_USER_ID, text: `<@${BOT_USER_ID}> four is fine`, ts: guestTs, threadTs: reportTs, eventId: `EvOpe2572G${guestTs.replace(".", "")}` });
    expect(guestRes.status).toBe(200);
    await waitFor(async () => {
      const rows = await rowsSinceCursor(guestCursor, ["reply.no_reply_observed"], { limit: 200 });
      return rows.find((r) => r.surface === CHANNEL);
    }, "the guest's native turn to end on the sentinel", 150_000);
    const afterGuest = await rowsSinceCursor(guestCursor, ["routine.checkin"], { limit: 200 });
    expect(afterGuest.filter((r) => detailOf(r).id === id), "🔴 a GUEST's native reply checked in — the native door did not stamp the guest").toEqual([]);
    expect((await getRoutine("default", SURFACE_KEY, id))?.attention?.runs, "🔴 a GUEST's native reply cleared the routine's check-in count").toBe(41);

    const memberTs = slackTs(Date.now(), (tsCounter += 1));
    const memberRes = await slackMentionWake({ channelId: CHANNEL, userId: MEMBER_USER_ID, text: `<@${BOT_USER_ID}> thanks, four is fine`, ts: memberTs, threadTs: reportTs, eventId: `EvOpe2572M${memberTs.replace(".", "")}` });
    expect(memberRes.status).toBe(200);
    const checkIn = await waitFor(async () => {
      const rows = await rowsSinceCursor(guestCursor, ["routine.checkin"], { limit: 200 });
      return rows.find((r) => detailOf(r).id === id);
    }, "the routine.checkin row the member's native reply writes", 150_000);
    expect(detailOf(checkIn).via).toBe("reply");
    expect((await getRoutine("default", SURFACE_KEY, id))?.attention, "the member's native reply cleared the count").toBeUndefined();
  } finally {
    slack.uninstall();
  }
});
