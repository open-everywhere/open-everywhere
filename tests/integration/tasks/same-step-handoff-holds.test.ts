import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  WAKE_FROM_ENVELOPE,
} from "../harness";

const SLACK_CHANNEL = "C0EXRANDM";
const SLACK_BOT = "U0OPE2793BOT";
const SLACK_MEMBER = "U0OPE2793MEM";

const HANDOFF = "I'll check that and come back here with the figure.";
const CHILD_RESULT = "ope2793 worker result";
const SETTLE_MS = 8_000;

test("a hand-off note in the SAME step as the work call ends the turn, so no model call runs ahead of the worker (OPE-2793)", async () => {
  const threadTs = slackTs(Date.now() - 1_000, 27930);
  const messageTs = slackTs(Date.now(), 27931);

  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2793BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name: id, real_name: id, profile: { display_name: id, real_name: id } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2793", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 8 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 27932) };
    return undefined;
  });
  afterThisTest(() => slack.uninstall());

  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });

  const handle = disposeLater(
    registerScript({
      parent: [
        {
          calls: [
            { tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: HANDOFF, done: false }, id: "ope2793-handoff" },
            { tool: "work", input: { message: "find the figure and report back" }, id: "ope2793-work" },
          ],
        },
        { say: NO_REPLY_SENTINEL },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: 120_000, say: CHILD_RESULT }],
    }),
  );

  const res = await slackMentionWake({
    channelId: SLACK_CHANNEL,
    userId: SLACK_MEMBER,
    text: `<@${SLACK_BOT}> ope2793 what is the figure?`,
    ts: messageTs,
    threadTs,
    eventId: `EvOPE2793${messageTs.replace(".", "")}`,
  });
  expect(res.status, res.body).toBe(200);

  const first = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the dispatch turn's first model call");
  expect(typeof first.turnId, "the dispatch call recorded no turn id, so the same-turn filter below would match every parent call").toBe("string");
  expect(handle.requests.filter((r) => r.fault !== undefined), "a scripted request degraded, so the arms below would read a different run").toEqual([]);

  const note = await waitFor(
    () => handle.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope2793-handoff"),
    "the hand-off note's own result",
  ).catch(() => undefined);
  await waitFor(() => handle.requests.find((r) => r.role === "child"), "the delegated worker's first model call");
  expect(
    slack.calls.some((c) => c.method === "chat.postMessage" && (c.params.get("text") ?? "").includes(HANDOFF)),
    "the hand-off note never reached the room, so this drive did not run the step it pins",
  ).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const sameTurn = handle.requests.filter((r) => r.role === "parent" && r.turnId === first.turnId);
  expect(
    sameTurn.map((r) => r.stepIndex),
    `🔴 the dispatch turn called the model again while its worker was still held${note === undefined ? "" : ` (note result: ${JSON.stringify(note.output).slice(0, 200)})`} — a hand-off note in the same step as \`work\` must end the turn; the \`work\` result arrives later as a new wake`,
  ).toEqual([0]);

  handle.releaseHolds();
}, 600_000);
