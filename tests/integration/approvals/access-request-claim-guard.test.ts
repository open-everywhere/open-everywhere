import { afterAll, expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  seatReply,
  SLACK_TEAM_ID,
  slackDmWake,
  slackTs,
  waitFor,
} from "../harness";

const BOT_USER_ID = "U0BOTOPE2022";
const OPERATOR_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0OPE2022GUARD";

const CHANNEL_SCOPE_ASK =
  "request access for THIS CHANNEL — a channel-scope access request (target=channel) to widen the e2e-fixture " +
  "connection so it also allows POST. I do not mean my own personal DM access and I do not mean a group grant.";

const FABRICATED_REPLY =
  "I've submitted the channel-scope request for this channel to widen `e2e-fixture` with POST, tied to `e2e-run-ope2022`. " +
  "It's pending the required approval; I'll report the card/status when it returns.";

const WITHHELD_OPENING = "I can't confirm a request has gone in yet";

let tsCounter = 0;

const slack = installSlackWebApiStub((method, params) => {
  switch (method) {
    case "auth.test":
      return { ok: true, user_id: BOT_USER_ID, bot_id: "B0OPE2022BOT", team_id: SLACK_TEAM_ID };
    case "users.info": {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: {
          id,
          name: "ope2022-operator",
          team_id: SLACK_TEAM_ID,
          is_bot: id === BOT_USER_ID,
          is_restricted: false,
          is_ultra_restricted: false,
          is_stranger: false,
          profile: { display_name: "ope2022-operator", real_name: "OPE 2022 Operator" },
        },
      };
    }
    case "conversations.members":
      return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    case "conversations.info":
      return { ok: true, channel: { id: params.get("channel"), name: "ope2022-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } };
    case "conversations.open":
      return { ok: true, channel: { id: DM_CHANNEL_ID } };
    case "conversations.history":
      return { ok: true, messages: [] };
    case "chat.postMessage":
      return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    case "chat.update":
    case "chat.postEphemeral":
      return { ok: true };
    default:
      return undefined;
  }
});
afterAll(() => slack.uninstall());

test("a DM channel-scope ask yields no unfounded submitted claim in the room", async () => {
  await bootAgent({ stubbedProviderTransport: true });

  const cursor = await auditCursor();

  disposeLater(registerScript({ parent: [seatReply(FABRICATED_REPLY, "ope2022-reply")] }));

  const ts = slackTs(Date.now(), 202_200);
  const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: OPERATOR_ID, text: CHANNEL_SCOPE_ASK, ts });
  expect(res.status).toBe(200);

  const posted = await waitFor(() => {
    const call = slack.calls.find((c) => c.method === "chat.postMessage" && (c.params.get("channel") ?? "") === DM_CHANNEL_ID);
    return call === undefined ? undefined : (call.params.get("text") ?? "");
  }, "the seat's DM reply reached chat.postMessage");

  expect(posted).not.toContain("I've submitted");
  expect(posted).not.toContain("submitted the channel-scope request");
  expect(posted).not.toContain("pending the required approval");
  expect(posted).toContain(WITHHELD_OPENING);

  const withheld = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["access_request.claim_withheld"]);
    return rows.length > 0 ? rows : undefined;
  }, "the withheld-claim row landed");
  const detail = (withheld[0]?.detail ?? {}) as Record<string, unknown>;
  expect(detail.shapes).toContain("submitted");
  expect(detail.subjects).toContain("access");
  expect(JSON.stringify(withheld[0])).not.toContain("e2e-run-ope2022");

  const proposed = await rowsSinceCursor(cursor, ["approval.requested"]);
  expect(proposed).toHaveLength(0);
});
