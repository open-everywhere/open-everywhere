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

const CHANNEL = "C0OPE2558NAT";
const SURFACE_KEY = `slack/${SLACK_TEAM_ID}/${CHANNEL}`;
const BOT_USER_ID = "U0BOTSELF01";
const MEMBER_USER_ID = "U0OPE2558MEM";
const CREATOR_USER_ID = "U0OPE2558CRT";

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("a member's reply in a NATIVE fire's report thread clears the routine's check-in count", async () => {
  let tsCounter = 2558;
  const slack = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: "B0BOTSELF01", team_id: SLACK_TEAM_ID };
      case "users.info":
        return params.get("user") === MEMBER_USER_ID
          ? { ok: true, user: { id: MEMBER_USER_ID, name: "ope2558-member", team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, real_name: "ope2558-member", profile: { display_name: "ope2558-member", real_name: "ope2558-member" } } }
          : undefined;
      case "conversations.info":
        return { ok: true, channel: { id: params.get("channel"), name: "it-ope2558", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 } };
      case "conversations.members":
        return { ok: true, members: [MEMBER_USER_ID, CREATOR_USER_ID], response_metadata: { next_cursor: "" } };
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
  const topologyBefore = settings.getSettings().window.topology;
  afterThisTest(() => settings.overrideSettingsForTest({ window: { topology: topologyBefore } }));
  settings.overrideSettingsForTest({ window: { topology: false } });
  try {
    const cursor = await auditCursor();
    const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
    const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
    const id = `r-it-2558-${randomBytes(4).toString("hex")}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await addRoutine(
      { org: "default", platform: "slack", workspace: SLACK_TEAM_ID, surface: CHANNEL, workspaceKey: `slack/${SLACK_TEAM_ID}`, surfaceKey: SURFACE_KEY, domainKey: SURFACE_KEY, key: SURFACE_KEY },
      {
        id,
        org: "default",
        surfaceKey: SURFACE_KEY,
        target: { channelId: CHANNEL },
        trigger: { kind: "interval", everyMinutes: 60 },
        prompt: "ope2558 post the open incident count",
        createdBy: CREATOR_USER_ID,
        status: "active",
        nextRunAt: dueAt,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        promptGeneration: 1,
        consecutiveFailures: 0,
        attention: { runs: 40 },
      },
    );

    const reportText = "ope2558 three incidents are open";
    const reportScript = registerScript({ parent: [{ calls: [{ tool: "reply", input: { text: reportText }, id: "ope2558-report" }] }, { say: NO_REPLY_SENTINEL }] });
    afterThisTest(() => reportScript.dispose());
    await runRoutineDispatchTick();

    const report = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["reply.post"], { limit: 200 });
      return rows.find((r) => r.surface === CHANNEL && detailOf(r).chars === reportText.length);
    }, "the native fire's reply.post row for the routine's report", 150_000);
    const reportTs = String(detailOf(report).id);
    expect(detailOf(report).wakeId, "precondition: the per-surface door, which carries no wake").toBeUndefined();
    expect((await getRoutine("default", SURFACE_KEY, id))?.attention?.runs, "precondition: the fire counted one more run").toBe(41);

    const thread = await getOperationalStore().getRoutineReportThread("default", `slack/${CHANNEL}`, reportTs, new Date().toISOString());
    expect(thread?.routineId, "🔴 the native report's post recorded no thread for the routine — the fire bag did not reach the per-surface reply door").toBe(id);

    reportScript.dispose();
    disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
    const ts = slackTs(Date.now(), (tsCounter += 1));
    const res = await slackMentionWake({ channelId: CHANNEL, userId: MEMBER_USER_ID, text: `<@${BOT_USER_ID}> thanks, three is fine`, ts, threadTs: reportTs, eventId: `EvOpe2558${ts.replace(".", "")}` });
    expect(res.status).toBe(200);

    const checkIn = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["routine.checkin"], { limit: 200 });
      return rows.find((r) => detailOf(r).id === id);
    }, "the routine.checkin row the member's native reply writes", 150_000);
    expect(detailOf(checkIn).via).toBe("reply");
    expect(detailOf(checkIn).runs).toBe(41);
    const after = await getRoutine("default", SURFACE_KEY, id);
    expect(after?.attention, "🔴 the member's native reply did not clear the routine's check-in count").toBeUndefined();
    expect(after?.status).toBe("active");
  } finally {
    slack.uninstall();
  }
});
