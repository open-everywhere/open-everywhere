import { afterAll, expect, test } from "vitest";

import { auditCursor, bootAgent, registerScript, rowsSinceCursor, seatReply, slackDmWake, slackTs, SLACK_TEAM_ID, waitFor, type ScriptedHandle } from "../harness";
import { installSlackWebApiStub, type SlackWebApiStub } from "../slack-web-api";

const live = new Set<ScriptedHandle>();
let stub: SlackWebApiStub | undefined;
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
  stub?.uninstall();
});

const DM_USER_ID = "U0EXOWNER";
const DM = "D0OPE2577EDIT";
const SURFACE_KEY = `slack/${SLACK_TEAM_ID}/${DM}`;
const TEXT = "what is six times seven?";
const HOLD_MS = 60_000;

test("a metadata-only edit of the person's DM message, arriving while the turn runs, wakes nothing and leaves the answer fresh", async () => {
  const { base } = await bootAgent();
  stub ??= installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: "U0OPE2577BOT", bot_id: "B0OPE2577BOT", team_id: SLACK_TEAM_ID };
      case "users.info":
        return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope2577-person" } } };
      case "agents.sessions.setStatus":
        return { ok: true, status: params.get("status") };
      default:
        return undefined;
    }
  });
  const cursor = await auditCursor();
  const handle = registerScript({ parent: [{ ...seatReply("42", "ope2577-answer"), delayMs: HOLD_MS }] });
  live.add(handle);

  const rootTs = slackTs(Date.now(), 257_701);
  const res = await slackDmWake({ channelId: DM, userId: DM_USER_ID, text: TEXT, ts: rootTs });
  expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the held answer step");

  const { SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../../packages/core/scripts/e2e/synthetic");
  const noticeTs = `${rootTs.split(".")[0]}.003900`;
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: SLACK_TEAM_ID,
    event_id: `EvOPE2577Edit${noticeTs.replace(".", "")}`,
    event_time: Math.floor(Number.parseFloat(noticeTs)),
    event: {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: DM,
      channel_type: "im",
      ts: noticeTs,
      event_ts: noticeTs,
      message: { type: "message", user: DM_USER_ID, text: TEXT, ts: rootTs, team: SLACK_TEAM_ID, assistant_app_thread: { title: TEXT } },
      previous_message: { type: "message", user: DM_USER_ID, text: TEXT, ts: rootTs, team: SLACK_TEAM_ID },
    },
  });
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("the fork published no Slack signing secret — bootAgent did not run");
  const sig = signSlackRequest(rawBody, secret);
  const edit = await fetch(`${base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": sig.timestamp, "x-slack-signature": sig.signature },
    body: rawBody,
    signal: AbortSignal.timeout(60_000),
  });
  expect(edit.status, "Slack still gets its 200 for the edit").toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  handle.releaseHolds();

  const verdict = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["reply.post", "reply.refused"])).filter((r) => r.surface === DM);
    return rows.length > 0 ? rows : undefined;
  }, "the answer's reply.post or reply.refused row on the DM");
  expect(
    verdict.filter((r) => r.action === "reply.refused").map((r) => r.detail?.reason),
    "🔴 the answer to the person's real message is NOT refused — the metadata edit is not a newer message",
  ).toEqual([]);
  expect(verdict.filter((r) => r.action === "reply.post"), "the answer posts once").toHaveLength(1);

  const ingress = (await rowsSinceCursor(cursor, ["wake.ingress"])).filter((r) => r.detail?.surfaceKey === SURFACE_KEY);
  expect(ingress, `🔴 exactly one wake on the DM — the person's message, never the edit (${JSON.stringify(ingress.map((r) => r.detail?.vendorTs))})`).toHaveLength(1);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(new Set(handle.requests.filter((r) => r.role === "parent").map((r) => r.turnId)).size, "the seat ran one turn").toBe(1);
});
