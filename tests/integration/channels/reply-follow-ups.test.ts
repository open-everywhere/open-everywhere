import { afterAll, expect, test } from "vitest";

import { auditCursor, bootAgent, disposeLater, registerScript, rowsSinceCursor, slackDmWake, slackTs, SLACK_TEAM_ID, waitFor, WAKE_FROM_ENVELOPE, type ScriptedStep } from "../harness";
import { installSlackWebApiStub, type SlackWebApiStub } from "../slack-web-api";

let stub: SlackWebApiStub | undefined;
afterAll(() => {
  stub?.uninstall();
});

const DM_USER_ID = "U0EXOWNER";
const DM = "D0OPE2516NEXT";
const BOT_USER = "U0OPE2516BOT";
const NEXT = ["Show Friday too", "Move the 2pm"];

function replyWithFollowUps(text: string, followUps: readonly string[], id: string): ScriptedStep {
  return { calls: [{ tool: "reply", input: { text, wake: WAKE_FROM_ENVELOPE, followUps }, id }] };
}

function armSlackStub(): SlackWebApiStub {
  let n = 0;
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER, bot_id: "B0OPE2516BOT", team_id: SLACK_TEAM_ID };
      case "users.info":
        return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope2516-person" } } };
      case "chat.postMessage":
      case "chat.update":
        n += 1;
        return { ok: true, ts: params.get("ts") ?? slackTs(Date.now(), 251_600 + n), channel: params.get("channel") };
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

type Block = { type?: string; block_id?: string; elements?: { type?: string; action_id?: string; value?: string; text?: string | { text?: string } }[] };

test("a Slack DM answer carries its follow-up buttons, and a signed press wakes the DM seat with the button's text", async () => {
  stub ??= armSlackStub();
  const { base } = await bootAgent({ stubbedProviderTransport: true });

  const first = disposeLater(registerScript({ parent: [replyWithFollowUps("You have three meetings on Thursday.", NEXT, "ope2516-answer")] }));
  const res = await slackDmWake({ channelId: DM, userId: DM_USER_ID, text: "what is on my calendar thursday?", ts: slackTs(Date.now(), 251_601) });
  expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);
  const post = await waitFor(
    () => stub!.calls.find((c) => c.method === "chat.postMessage" && c.params.get("channel") === DM && (c.params.get("text") ?? "").includes("three meetings")),
    "the answer's chat.postMessage in the DM",
  );
  expect(first.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const blocks = JSON.parse(post.params.get("blocks") ?? "[]") as Block[];
  expect(blocks.map((b) => b.type), "the answer, its thumbs, then the follow-up row").toEqual(["section", "context_actions", "actions"]);
  const row = blocks[2]!;
  expect(row.block_id).toBe("oe_followups");
  expect(row.elements?.map((e) => [e.action_id, e.value, typeof e.text === "object" ? e.text?.text : e.text])).toEqual([
    ["oe_followup:0", NEXT[0], NEXT[0]],
    ["oe_followup:1", NEXT[1], NEXT[1]],
  ]);
  first.dispose();

  const answerTs = "1760506740.251000";
  const press = {
    type: "block_actions",
    team: { id: SLACK_TEAM_ID },
    user: { id: DM_USER_ID, team_id: SLACK_TEAM_ID },
    channel: { id: DM },
    message: { ts: answerTs, text: "You have three meetings on Thursday.", blocks },
    container: { type: "message", message_ts: answerTs, channel_id: DM },
    actions: [{ type: "button", action_id: "oe_followup:0", block_id: "oe_followups", value: NEXT[0] }],
  };
  const second = disposeLater(registerScript({ parent: [replyWithFollowUps("Friday is clear all day.", [], "ope2516-next")] }));
  const unsigned = await postSlackClick(base, press, false);
  expect(unsigned.status, "an unsigned press is refused before any branch").not.toBe(200);
  const signed = await postSlackClick(base, press, true);
  expect(signed.status, `the signed press was not acknowledged: ${signed.body.slice(0, 200)}`).toBe(200);
  expect(signed.body, "the acknowledgement is an empty 200").toBe("");

  const rewrite = await waitFor(() => stub!.calls.find((c) => c.method === "chat.update" && c.params.get("channel") === DM && c.params.get("ts") === answerTs), "the answer's rewrite after the press");
  const rewritten = JSON.parse(rewrite.params.get("blocks") ?? "[]") as Block[];
  expect(rewritten.some((b) => b.block_id === "oe_followups"), "the rewrite removes the follow-up row").toBe(false);
  expect(rewritten[rewritten.length - 1]).toMatchObject({ type: "context", elements: [{ type: "plain_text", text: `↳ You asked: ${NEXT[0]}` }] });

  const nextPost = await waitFor(
    () => stub!.calls.find((c) => c.method === "chat.postMessage" && c.params.get("channel") === DM && (c.params.get("text") ?? "").includes("Friday is clear")),
    "the answer to the follow-up, in the same DM",
  );
  expect(nextPost).toBeDefined();
  expect(second.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const userTexts = second.requests.flatMap((r) => r.messages.filter((m) => m.role === "user").map((m) => m.text));
  expect(userTexts.some((t) => t.includes(NEXT[0]!)), "the seat's turn reads the button's text as the person's message").toBe(true);

  const callsBefore = second.requests.length;
  const again = await postSlackClick(base, { ...press, actions: [{ type: "button", action_id: "oe_followup:1", block_id: "oe_followups", value: NEXT[1] }] }, true);
  expect(again.status).toBe(200);
  await new Promise((r) => setTimeout(r, 3_000));
  expect(second.requests.length, "a second press on one answer starts no turn").toBe(callsBefore);
  expect(stub!.calls.filter((c) => c.method === "chat.update" && c.params.get("ts") === answerTs), "…and rewrites nothing").toHaveLength(1);
});

test("a signed follow-up press from an undeclared workspace is fenced first: no rewrite, no turn", async () => {
  stub ??= armSlackStub();
  const { base } = await bootAgent({ stubbedProviderTransport: true });
  const foreignTeam = "T0OPE2516FOREIGN";
  const answerTs = "1760506740.252000";
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "An answer." } },
    { type: "actions", block_id: "oe_followups", elements: [{ type: "button", action_id: "oe_followup:0", value: NEXT[0], text: { type: "plain_text", text: NEXT[0] } }] },
  ];
  const watch = disposeLater(registerScript({ parent: [replyWithFollowUps("This must never post.", [], "ope2516-foreign")] }));
  const cursor = await auditCursor();
  const res = await postSlackClick(
    base,
    {
      type: "block_actions",
      team: { id: foreignTeam },
      user: { id: "U0FOREIGNER", team_id: foreignTeam },
      channel: { id: DM },
      message: { ts: answerTs, text: "An answer.", blocks },
      container: { type: "message", message_ts: answerTs, channel_id: DM },
      actions: [{ type: "button", action_id: "oe_followup:0", block_id: "oe_followups", value: NEXT[0] }],
    },
    true,
  );
  expect(res.status, "the foreign press still gets the empty 200 an interactivity route owes").toBe(200);
  const row = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["surface.wake_dropped"])).find((r) => r.detail?.door === "followup-click"),
    "the tenant fence's surface.wake_dropped row for the follow-up press",
  );
  expect(row.detail).toMatchObject({ door: "followup-click", team: foreignTeam });
  await new Promise((r) => setTimeout(r, 3_000));
  expect(stub!.calls.filter((c) => c.method === "chat.update" && c.params.get("ts") === answerTs), "a fenced press rewrites nothing").toHaveLength(0);
  expect(watch.requests, "a fenced press starts no turn").toHaveLength(0);
});
