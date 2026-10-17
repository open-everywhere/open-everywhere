import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import {
  auditCursor,
  bootAgent,
  installTeamsJwksStub,
  registerScript,
  rowsSinceCursor,
  seatReply,
  slackDmWake,
  slackTs,
  SLACK_TEAM_ID,
  teamsActivityPost,
  waitFor,
  type ScriptedHandle,
} from "../harness";
import { installSlackWebApiStub, type SlackWebApiStub } from "../slack-web-api";

const live = new Set<ScriptedHandle>();
let stub: SlackWebApiStub | undefined;
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
  stub?.uninstall();
});

const DM_USER_ID = "U0EXOWNER";
const DM = "D0OPE2520THUMBS";
const BOT_USER = "U0OPE2520BOT";

function armSlackStub(): SlackWebApiStub {
  let n = 0;
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER, bot_id: "B0OPE2520BOT", team_id: SLACK_TEAM_ID };
      case "users.info":
        return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope2520-person" } } };
      case "chat.postMessage":
      case "chat.update":
        n += 1;
        return { ok: true, ts: params.get("ts") ?? slackTs(Date.now(), 252_000 + n), channel: params.get("channel") };
      case "agents.sessions.setStatus":
      case "reactions.add":
      case "reactions.remove":
        return { ok: true };
      default:
        return undefined;
    }
  });
}

async function postSlackClick(base: string, payload: Record<string, unknown>, signed: boolean): Promise<{ status: number; body: string }> {
  const { SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../../packages/core/scripts/e2e/synthetic");
  const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("the fork published no Slack signing secret — bootAgent did not run");
  const sig = signSlackRequest(rawBody, secret);
  const res = await fetch(`${base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signed ? { "x-slack-request-timestamp": sig.timestamp, "x-slack-signature": sig.signature } : {}),
    },
    body: rawBody,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

test("a Slack DM answer carries Slack's native thumbs, and a signed click on it writes one reply.feedback row", async () => {
  stub ??= armSlackStub();
  const { base } = await bootAgent({ stubbedProviderTransport: true });

  const script = registerScript({ parent: [seatReply("The launch review is on Friday the 16th.", "ope2520-answer")] });
  live.add(script);
  const res = await slackDmWake({ channelId: DM, userId: DM_USER_ID, text: "when is the launch review?", ts: slackTs(Date.now(), 252_001) });
  expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);

  const post = await waitFor(
    () => stub!.calls.find((c) => c.method === "chat.postMessage" && c.params.get("channel") === DM && (c.params.get("text") ?? "").includes("Friday the 16th")),
    "the answer's chat.postMessage in the DM",
  );
  expect(script.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const blocks = JSON.parse(post.params.get("blocks") ?? "[]") as { type: string; text?: { text?: string }; elements?: { type?: string; action_id?: string }[] }[];
  expect(blocks.map((b) => b.type), "the answer is a section, and the native thumbs sit under it").toEqual(["section", "context_actions"]);
  expect(blocks[0]?.text?.text).toContain("Friday the 16th");
  expect(blocks[1]?.elements?.[0]).toMatchObject({ type: "feedback_buttons", action_id: "oe_feedback" });
  expect(blocks.some((b) => b.type === "context")).toBe(false);

  const messageTs = "1760506740.253000";
  const click = {
    type: "block_actions",
    team: { id: SLACK_TEAM_ID },
    user: { id: DM_USER_ID, team_id: SLACK_TEAM_ID },
    channel: { id: DM },
    message: { ts: messageTs },
    container: { type: "message", message_ts: messageTs, channel_id: DM },
    actions: [{ type: "feedback_buttons", action_id: "oe_feedback", block_id: "fb", value: "down" }],
  };
  const cursor = await auditCursor();
  const unsigned = await postSlackClick(base, click, false);
  expect(unsigned.status, "an unsigned click is refused before any branch").not.toBe(200);
  const signed = await postSlackClick(base, click, true);
  expect(signed.status, `the signed click was not acknowledged: ${signed.body.slice(0, 200)}`).toBe(200);
  const row = await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.feedback"])).find((r) => r.detail?.messageId === messageTs), "the reply.feedback row for the click");
  expect(row.principalId).toBe(DM_USER_ID);
  expect(row.detail).toMatchObject({ surface: "slack", rating: "down", channelId: DM, messageId: messageTs, via: "native" });
  expect((await rowsSinceCursor(cursor, ["reply.feedback"])).filter((r) => r.detail?.messageId === messageTs)).toHaveLength(1);
});

test("a signed Teams feedback-loop click writes one reply.feedback row with the comment's length, never its words", async () => {
  stub ??= armSlackStub();
  await bootAgent({ stubbedProviderTransport: true });
  const jwks = installTeamsJwksStub();
  try {
    const nonce = randomBytes(5).toString("hex");
    const conversationId = `a:it-ope2520-${nonce}`;
    const words = "It cited the wrong page.";
    const cursor = await auditCursor();
    const res = await teamsActivityPost({
      activity: {
        type: "invoke",
        name: "message/submitAction",
        channelId: "msteams",
        id: `it-ope2520-act-${nonce}`,
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        from: { id: `29:it-ope2520-${nonce}`, name: "IT Fixture User" },
        recipient: { id: "28:it-teams-bot", name: "OE Bot" },
        conversation: { id: conversationId, conversationType: "personal", tenantId: `it-ope2520-tenant-${nonce}` },
        channelData: { tenant: { id: `it-ope2520-tenant-${nonce}` } },
        replyToId: `it-ope2520-answer-${nonce}`,
        value: { actionName: "feedback", actionValue: { reaction: "dislike", feedback: JSON.stringify({ feedbackText: words }) } },
      },
    });
    expect(res.status, `the Teams front refused the signed click: ${res.body.slice(0, 300)}`).toBe(200);
    const row = await waitFor(
      async () => (await rowsSinceCursor(cursor, ["reply.feedback"])).find((r) => r.detail?.messageId === `it-ope2520-answer-${nonce}`),
      "the reply.feedback row for the Teams click",
    );
    expect(row.detail).toMatchObject({ surface: "teams", rating: "down", channelId: conversationId, via: "native", comment: true, commentChars: words.length });
    expect(JSON.stringify(row)).not.toContain("wrong page");
  } finally {
    jwks.uninstall();
  }
});
