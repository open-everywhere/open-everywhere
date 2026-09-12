import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import {
  bootAgent,
  installSlackWebApiStub,
  readAuditRows,
  registerScript,
  SLACK_NAME_DROP_CHANNEL_ID,
  SLACK_TEAM_ID,
  slackMessageEventPost,
  slackTs,
  waitFor,
  type ScriptedHandle,
  type SlackWebApiStub,
} from "../harness";

const BOT_USER_ID = "U0BOTSELF890";
const BOT_ID = "B0BOTSELF890";
const BOT_DISPLAY_NAME = "ope890bot";

const TRIGGER_USER_ID = "U0MEMBER890";

let stub: SlackWebApiStub | undefined;
const cleanups: (() => void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

function userInfo(id: string, name: string): Record<string, unknown> {
  return { ok: true, user: { id, name, team_id: SLACK_TEAM_ID, real_name: name, profile: { display_name: name, real_name: name } } };
}

async function armSeams(): Promise<void> {
  await bootAgent();
  if (stub) return;
  const installed = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
      case "users.info": {
        const user = params.get("user") ?? "";
        if (user === BOT_USER_ID) return userInfo(BOT_USER_ID, BOT_DISPLAY_NAME);
        if (user === TRIGGER_USER_ID) return userInfo(TRIGGER_USER_ID, "trigger-member-890");
        return undefined;
      }
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it-ope890",
            is_channel: true,
            is_private: false,
            is_ext_shared: false,
            is_org_shared: false,
            is_shared: false,
            is_pending_ext_shared: false,
            num_members: 9,
          },
        };
      case "conversations.history":
        return { ok: true, messages: [] };
      default:
        return undefined;
    }
  });
  stub = installed;
  cleanups.push(() => installed.uninstall());
}

test("Slack NAME-DROP wake that ends in the bare NO_REPLY sentinel writes an UNGATED reply.no_reply_observed row (route: sentinel, audit.silences OFF)", async () => {
  await armSeams();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  settings.overrideSettingsForTest({ audit: { silences: false } });
  expect(settings.getSettings().audit.silences).toBe(false);

  const handle: ScriptedHandle = registerScript({
    parent: [{ say: NO_REPLY_SENTINEL }],
  });
  try {
    const at = Date.now();
    const ts = slackTs(at, 1);
    const res = await slackMessageEventPost({
      channelId: SLACK_NAME_DROP_CHANNEL_ID,
      userId: TRIGGER_USER_ID,
      text: `hey ${BOT_DISPLAY_NAME}, ope890 stay quiet on this one`,
      ts,
      eventId: `EvND890${ts.replace(".", "")}`,
    });
    expect(res.status, `the Slack front refused the message event: ${res.body.slice(0, 200)}`).toBe(200);

    await waitFor(() => handle.requests.find((r) => r.stepIndex === 0), "the name-drop wake's turn", 180_000);

    const sinceIso = new Date(at - 2_000).toISOString();
    const namesThisRoom = (surface: string | undefined): boolean => (surface ?? "").includes(SLACK_NAME_DROP_CHANNEL_ID);
    const observed = await waitFor(
      async () => {
        const rows = await readAuditRows({ actions: ["reply.no_reply_observed"], sinceIso, limit: 50 });
        return rows.find((r) => namesThisRoom(r.surface));
      },
      "a reply.no_reply_observed row for the name-drop wake's sentinel silence",
      120_000,
    );
    expect(observed.platform, "the seat road writes the row on the standing window, not on a native per-thread Slack session").toBe("unified");
    expect(observed.workspace, "the row names the seat's own window domain, not a stand-in").toBe("org");
    expect(observed.detail?.route, "the sentinel route's row is marked route: sentinel, distinct from the tool row's `reason`").toBe("sentinel");
    expect(observed.detail?.reason, "the sentinel carries no closed reason the way the tool call does").toBeUndefined();
    expect(typeof observed.detail?.wakeId, "a standing-seat sentinel row carries the wake id").toBe("string");

    const gated = await readAuditRows({ actions: ["reply.no_reply"], sinceIso, limit: 50 });
    expect(gated.find((r) => namesThisRoom(r.surface)), "the gated reply.no_reply row must be ABSENT with audit.silences OFF").toBeUndefined();
  } finally {
    handle.dispose();
  }
}, 300_000);
