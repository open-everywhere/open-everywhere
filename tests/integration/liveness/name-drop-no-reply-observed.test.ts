import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import {
  awaitWindowQuiet,
  auditCursor,
  bootAgent,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_NAME_DROP_CHANNEL_ID,
  SLACK_TEAM_ID,
  slackMessageEventPost,
  slackTs,
  waitFor,
  type ScriptedHandle,
  type SlackWebApiStub,
} from "../harness";

const BOT_USER_ID = "U0BOTSELF649";
const BOT_ID = "B0BOTSELF649";
const BOT_DISPLAY_NAME = "ope649bot";

const TRIGGER_USER_ID = "U0MEMBER649";

let stub: SlackWebApiStub | undefined;
const cleanups: (() => void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
  (await import("@open-everywhere/core/agent/audit/audit.js")).setSilenceAuditForTest(false);
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
        if (user === TRIGGER_USER_ID) return userInfo(TRIGGER_USER_ID, "trigger-member-649");
        return undefined;
      }
      case "conversations.members":
        return { ok: true, members: [], response_metadata: { next_cursor: "" } };
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it-ope649",
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

test("Slack NAME-DROP wake that ends in no_reply writes an UNGATED reply.no_reply_observed row (the silence-audit switch OFF)", async () => {
  await armSeams();
  const silenceAudit = await import("@open-everywhere/core/agent/audit/audit.js");
  silenceAudit.setSilenceAuditForTest(false);
  expect(silenceAudit.auditSilencesEnabled()).toBe(false);

  const callId = `ope649-nd-${randomUUID()}`;
  const handle: ScriptedHandle = registerScript({
    parent: [{ calls: [{ tool: "no_reply", input: { reason: "not_relevant" }, id: callId }] }, { say: "noted" }],
  });
  try {
    const at = Date.now();
    const ts = slackTs(at, 1);
    const cursor = await auditCursor();
    const res = await slackMessageEventPost({
      channelId: SLACK_NAME_DROP_CHANNEL_ID,
      userId: TRIGGER_USER_ID,
      text: `hey ${BOT_DISPLAY_NAME}, ope649 stay quiet on this one`,
      ts,
      eventId: `EvND649${ts.replace(".", "")}`,
    });
    expect(res.status, `the Slack front refused the message event: ${res.body.slice(0, 200)}`).toBe(200);

    const outcome = await waitFor(
      async () => {
        const refusedStep = handle.requests.find((r) => r.stepIndex === 1);
        if (refusedStep !== undefined) return { refused: refusedStep.toolResults.find((t) => t.id === callId) } as const;
        const rows = await rowsSinceCursor(cursor, ["reply.no_reply_observed"], { limit: 50 });
        const row = rows.find((r) => r.platform === "slack" && r.surface === SLACK_NAME_DROP_CHANNEL_ID);
        return row === undefined ? undefined : ({ row } as const);
      },
      "a reply.no_reply_observed row for the name-drop wake's silence (or the step a refusal would serve)",
      180_000,
    );
    expect("refused" in outcome ? `the name-drop wake's no_reply TOOL was refused: ${JSON.stringify(outcome.refused?.output)}` : "accepted").toBe("accepted");
    const observed = (outcome as { readonly row: Awaited<ReturnType<typeof rowsSinceCursor>>[number] }).row;
    await awaitWindowQuiet();
    expect(handle.requests.some((r) => r.stepIndex >= 1), "a step after the accepted no_reply was requested").toBe(false);
    expect(observed.workspace, "the row names the real Slack team, not an env stand-in").toBe(SLACK_TEAM_ID);
    expect(observed.detail?.reason).toBe("not_relevant");
    expect(observed.detail?.explanation, "the minimal row carries no free-text explanation").toBeUndefined();

    const gated = await rowsSinceCursor(cursor, ["reply.no_reply"], { limit: 50 });
    expect(
      gated.find((r) => r.platform === "slack" && r.surface === SLACK_NAME_DROP_CHANNEL_ID),
      "the gated reply.no_reply row must be ABSENT with the silence-audit switch OFF — otherwise this run does not prove the new row is independently ungated",
    ).toBeUndefined();
  } finally {
    handle.dispose();
  }
}, 300_000);
