import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import {
  auditCursor,
  bootAgent,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackInteractivityPost,
  slackMentionWake,
  slackTs,
  waitFor,
  type ScriptedHandle,
  type SlackWebApiStub,
} from "../harness";

const BOT_USER_ID = "U0BOTSELF01";
const BOT_ID = "B0BOTSELF01";
const MEMBER_A = "U0OPE2348A";
const MEMBER_B = "U0OPE2348B";
const CHANNEL_ID = `C0Q${randomBytes(4).toString("hex").toUpperCase()}`;
const REPLY_TEXT = "ope2348 slack: going with staging";

const cleanups: (() => void)[] = [];
let topologyBefore: boolean | undefined;
afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  if (topologyBefore !== undefined) settings.overrideSettingsForTest({ window: { topology: topologyBefore } });
});

let tsCounter = 300;
function userInfo(id: string, name: string): Record<string, unknown> {
  return { ok: true, user: { id, name, team_id: SLACK_TEAM_ID, real_name: name, profile: { display_name: name, real_name: name } } };
}

async function armSeams(): Promise<SlackWebApiStub> {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  topologyBefore ??= settings.getSettings().window.topology;
  settings.overrideSettingsForTest({ window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);
  const installed = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
      case "users.info": {
        const user = params.get("user") ?? "";
        if (user === BOT_USER_ID) return userInfo(BOT_USER_ID, "ottobot");
        if (user === MEMBER_A) return userInfo(MEMBER_A, "ope2348-asker");
        if (user === MEMBER_B) return userInfo(MEMBER_B, "ope2348-clicker");
        return undefined;
      }
      case "conversations.members":
        return { ok: true, members: [MEMBER_A, MEMBER_B], response_metadata: { next_cursor: "" } };
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it-ope2348",
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
      case "conversations.replies":
        return { ok: true, messages: [] };
      case "chat.postMessage":
      case "chat.postEphemeral":
      case "chat.update":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      default:
        return undefined;
    }
  });
  cleanups.push(() => installed.uninstall());
  return installed;
}

interface PostedWidget {
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly blockId?: string;
  readonly element: { readonly type: string; readonly action_id: string; readonly value?: string; readonly options?: readonly { readonly text?: unknown; readonly value: string }[] };
}
function findWidget(stub: SlackWebApiStub, fromIndex: number): PostedWidget | undefined {
  for (const call of stub.calls.slice(fromIndex)) {
    if (call.method !== "chat.postMessage") continue;
    const raw = call.params.get("blocks");
    if (!raw) continue;
    let blocks: unknown;
    try {
      blocks = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as { type?: string; block_id?: string; elements?: PostedWidget["element"][] }[]) {
      for (const el of b.elements ?? []) {
        if (typeof el.action_id === "string" && el.action_id.startsWith("eve_input:")) {
          return { messageTs: "", threadTs: call.params.get("thread_ts") ?? undefined, ...(b.block_id ? { blockId: b.block_id } : {}), element: el };
        }
      }
    }
  }
  return undefined;
}

test("🔴 member B's button answer on member A's held question leaves the turn running as A", async () => {
  const stub = await armSeams();
  const cursor = await auditCursor();
  const handle: ScriptedHandle = registerScript({
    parent: [
      {
        calls: [
          {
            tool: "ask_question",
            input: {
              question: "ope2348 slack: staging or the shared bucket?",
              options: [
                { label: "Use staging", description: "Write the report into the staging bucket." },
                { label: "Use the shared bucket", description: "Write the report into the shared bucket." },
              ],
            },
            id: "ope2348-slack-ask",
          },
        ],
      },
      { calls: [{ tool: "reply", input: { text: REPLY_TEXT }, id: "ope2348-slack-reply" }] },
      { say: "done" },
    ],
  });
  cleanups.push(() => handle.dispose());

  const ts = slackTs(Date.now(), (tsCounter += 1));
  const callsBefore = stub.calls.length;
  const res = await slackMentionWake({ channelId: CHANNEL_ID, userId: MEMBER_A, text: `<@${BOT_USER_ID}> ope2348 which bucket?`, ts, eventId: `EvOpe2348${ts.replace(".", "")}` });
  expect(res.status, res.body.slice(0, 200)).toBe(200);

  const first = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "member A's native turn");
  expect(first.tools, "the native seat offers ask_question").toContain("ask_question");

  let widget: PostedWidget;
  try {
    widget = await waitFor(() => findWidget(stub, callsBefore), "eve's question widget posted into the thread", 90_000);
  } catch (err) {
    console.log(`[ope2348] slack calls: ${JSON.stringify(stub.calls.slice(callsBefore).map((c) => ({ m: c.method, p: [...c.params.keys()], b: (c.params.get("blocks") ?? "").slice(0, 300) })))}`);
    throw err;
  }
  const option = widget.element.options?.[0];
  const action: Record<string, unknown> = {
    type: widget.element.type,
    action_id: widget.element.action_id,
    ...(widget.blockId ? { block_id: widget.blockId } : {}),
    ...(widget.element.value !== undefined ? { value: widget.element.value } : {}),
    ...(option ? { selected_option: option } : {}),
    action_ts: `${Math.floor(Date.now() / 1000)}.000001`,
  };
  const threadTs = widget.threadTs ?? ts;
  const click = await slackInteractivityPost({
    type: "block_actions",
    user: { id: MEMBER_B, username: "ope2348-clicker", name: "ope2348-clicker", team_id: SLACK_TEAM_ID },
    api_app_id: "A_E2E",
    token: "e2e",
    trigger_id: `${Date.now()}.e2e`,
    team: { id: SLACK_TEAM_ID },
    channel: { id: CHANNEL_ID },
    container: { type: "message", message_ts: threadTs, channel_id: CHANNEL_ID, is_ephemeral: false },
    message: { ts: threadTs, thread_ts: threadTs, type: "message", blocks: [] },
    response_url: "https://hooks.slack.com/actions/E2E/synthetic/unused",
    actions: [action],
  });
  expect(click.status, click.body.slice(0, 200)).toBe(200);

  const resumed = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "ask_question")),
    "the resumed step that read member B's answer",
  );
  const answered = resumed.toolResults.find((t) => t.name === "ask_question");
  expect((answered!.output as { status?: unknown }).status).toBe("answered");

  const post = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.detail?.chars === REPLY_TEXT.length);
  }, "the resumed turn's reply.post row");
  expect(String(post.principalId ?? ""), "the resumed turn runs as the ASKER").toContain(MEMBER_A);
  expect(String(post.principalId ?? ""), "…never as the clicker").not.toContain(MEMBER_B);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
