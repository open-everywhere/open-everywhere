import { expect, test } from "vitest";
import {
  afterThisTest,
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  WAKE_FROM_ENVELOPE,
  type RecordedRequest,
} from "../harness";

const SLACK_CHANNEL = "C0EXRANDM";
const SLACK_BOT = "U0OPE2263BOT";
const SLACK_MEMBER = "U0OPE2263MEM";

const BRIEF = "ope2263-brief-dm-secret-9f3a1c: the partner said in their DM that the invoice is disputed";
const PENDING_REPLY = "I have started a worker and will report back here.";
const CHILD_RESULT = "ope2263 worker result";
const DISPATCH_CALL = "ope2263-dispatch";

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

test("a Slack seat's delegation keeps the worker brief out of the room, and posts nothing the reply plane did not author", async () => {
  const threadTs = slackTs(Date.now() - 1_000, 22630);
  const messageTs = slackTs(Date.now(), 22631);

  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2263BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: {
          id,
          team_id: SLACK_TEAM_ID,
          name: id === SLACK_BOT ? "ottobot" : "ope2263-member",
          real_name: id,
          profile: { display_name: id === SLACK_BOT ? "ottobot" : "ope2263-member", real_name: id },
        },
      };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: {
          id: params.get("channel"),
          name: "it-ope2263-random",
          is_channel: true,
          is_private: false,
          is_ext_shared: false,
          is_org_shared: false,
          is_shared: false,
          is_pending_ext_shared: false,
          num_members: 8,
        },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 22632) };
    return undefined;
  });
  afterThisTest(() => slack.uninstall());

  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const cursor = await auditCursor();

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: BRIEF }, id: DISPATCH_CALL }] },
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: PENDING_REPLY, done: false }, id: "ope2263-pending" }] },
      ],
      child: [{ delayMs: 120_000, say: CHILD_RESULT }],
    }),
  );

  const res = await slackMentionWake({
    channelId: SLACK_CHANNEL,
    userId: SLACK_MEMBER,
    text: `<@${SLACK_BOT}> ope2263 please delegate this`,
    ts: messageTs,
    threadTs,
    eventId: `EvOPE2263${messageTs.replace(".", "")}`,
  });
  expect(res.status, res.body).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn to reach its terminal step");

  expect(
    handle.requests.filter((r) => r.fault !== undefined),
    "a scripted request degraded instead of answering the script — the arms below would be reading a different run",
  ).toEqual([]);

  const worker = await waitFor(() => handle.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the delegated worker's first model call");
  expect(typeof worker.sessionId, "the worker's call recorded no session id, so the separation below would prove nothing").toBe("string");
  expect(worker.sessionId).not.toBe(handle.requests.find((r) => r.role === "parent")?.sessionId);
  expect(promptOf(worker), "the worker never received the brief, so the room-absence assertions below would be vacuous").toContain(BRIEF);

  const postsHere = await waitFor(() => {
    const hits = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.get("channel") === SLACK_CHANNEL);
    return hits.length > 0 ? hits : undefined;
  }, `a chat.postMessage to ${SLACK_CHANNEL} — without one, "nothing leaked" is a fact about a dead transport`);
  expect(
    postsHere.some((c) => (c.params.get("text") ?? "").includes(PENDING_REPLY)),
    "no post carried the seat's own reply text, so the transport is not the one this drive used",
  ).toBe(true);

  await awaitWindowQuiet();

  const leaking = slack.calls
    .map((c) => ({ method: c.method, body: [...c.params.entries()].map(([k, v]) => `${k}=${v}`).join("&") }))
    .filter((c) => c.body.includes(BRIEF));
  expect(
    leaking.map((c) => `${c.method}: ${c.body.slice(0, 300)}`),
    "🔴 the worker's BRIEF left the host on a Slack call — a delegation is rendering its brief into the room, which on a seat that read a DM is a DM-content leak with no refusal and no audit row",
  ).toEqual([]);

  const replyRows = (await rowsSinceCursor(cursor, ["reply.post"], { limit: 300 })).filter((r) => (r.surface ?? "").includes(SLACK_CHANNEL));
  const postsAtCheck = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.get("channel") === SLACK_CHANNEL);
  expect(
    postsAtCheck.length,
    `🔴 the room received ${postsAtCheck.length} chat.postMessage call(s) but the reply plane authored ${replyRows.length}. ` +
      `A post with no reply.post row behind it did not come through Open Everywhere's reply choke point, so it was fenced by nothing. ` +
      `Posted texts: ${JSON.stringify(postsAtCheck.map((c) => (c.params.get("text") ?? "").slice(0, 120)))}`,
  ).toBe(replyRows.length);
}, 600_000);
