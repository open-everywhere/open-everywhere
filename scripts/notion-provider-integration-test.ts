
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { setRegisteredProviders, capabilitiesForPlatform, readAudit } from "@open-everywhere/core/agent/adapter-api.js";

const dir = join(tmpdir(), `open-everywhere-notion-integration-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.NOTION_CHANNEL_API_KEY = "ntn-test-key";

registerNotionProvider();
registerSlackProvider();
setRegisteredProviders([
  {
    name: "notion",
    connection: "notion",
    allows: ["api-key"],
    credentials: [{ id: "channel-key", type: "api-key", secretRef: "NOTION_CHANNEL_API_KEY", broker: "env", intake: false }],
  },
]);

const reply = (await import("@open-everywhere/core/agent/tools/reply.js")).default;
const { resolveReplyTarget } = await import("@open-everywhere/core/agent/channels/reply-post.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
let notionResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { id: "notion-comment-1" } };
const realFetch = globalThis.fetch;
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
function fakeHttp(): void {
  globalThis.fetch = (async (url: unknown, init: { body?: unknown; method?: string }) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (u.includes("api.notion.com")) return resp(notionResponse.status, notionResponse.body);
    return resp(500, { error: "unexpected host" });
  }) as typeof fetch;
}
function restoreHttp(): void {
  globalThis.fetch = realFetch;
}

function notionCtx(discussionId: string | undefined) {
  return {
    channel: { kind: "notion" },
    session: {
      auth: {
        current: {
          attributes: {
            workspace_id: "W1",
            page_id: "P1",
            ...(discussionId ? { discussion_id: discussionId } : {}),
          },
          principalId: "U3",
          principalType: "notion-user",
        },
      },
    },
  };
}

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ArmedTool {
  readonly description: string;
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
}
const armReply = (tool: unknown, ctx: unknown): ArmedTool | null =>
  (tool as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as ArmedTool | null;

assert.deepStrictEqual(
  capabilitiesForPlatform("notion"),
  { midTurnPost: true, reactions: false },
  "registerNotionProvider registers notion's manifest (midTurnPost wired, no reactions)",
);
n++;

const notionArmed = armReply(reply, { channel: { kind: "notion" } });
ok(notionArmed !== null, "reply arms on a Notion session (mid-turn post via createCommentReply)");
const slackArmed = armReply(reply, { channel: { kind: "slack" } });
ok(slackArmed !== null && slackArmed.description === notionArmed!.description, "reply: ONE description on notion + slack (no per-surface variant)");

{
  const target = resolveReplyTarget(notionCtx("disc-1") as never);
  ok(target?.platform === "notion" && (target as { discussionId: string }).discussionId === "disc-1", "resolveReplyTarget: notion carries the discussion id (the reply anchor)");
  ok(resolveReplyTarget(notionCtx(undefined) as never) === null, "resolveReplyTarget: a discussion-less notion ctx → null (no anchor to post to)");
}

calls = [];
notionResponse = { status: 200, body: { id: "notion-comment-42" } };
fakeHttp();
await inSession(async () => {
  const armed = armReply(reply, notionCtx("disc-1"))!;
  const res = await armed.execute({ text: "notion answer" }, notionCtx("disc-1"));
  ok(res.posted === true && res.id === "notion-comment-42", "reply: on Notion returns the created comment id");
  ok(calls.length === 1 && calls[0].method === "POST" && calls[0].url.includes("api.notion.com") && calls[0].url.endsWith("/v1/comments"), "reply: on Notion POSTs to /v1/comments");
  const payload = JSON.parse(calls[0].body) as { discussion_id?: string; rich_text?: Array<{ text?: { content?: string } }> };
  ok(payload.discussion_id === "disc-1", "reply: on Notion posts into the SAME discussion (the thread it was woken on)");
  ok(payload.rich_text?.[0]?.text?.content === "notion answer", "reply: on Notion carries the model text as rich text");
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.some((r) => r.detail?.platform === "notion" && r.detail?.id === "notion-comment-42"), "reply: audits a reply.post row stamped platform=notion");
});
restoreHttp();

await inSession(async () => {
  const armed = armReply(reply, notionCtx(undefined))!;
  await assert.rejects(() => armed.execute({ text: "x" }, notionCtx(undefined)), /couldn't resolve/, "reply: a Notion ctx with no discussion id throws an honest error");
  n++;
});

{
  const { signNotionBody, buildCommentCreatedEvent } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const { verifyNotionSignature } = await import("@open-everywhere/provider-notion/agent/channels/notion-api.js");
  const secret = "notion-verif-token";
  const raw = JSON.stringify(buildCommentCreatedEvent({ workspaceId: "ws", commentId: "c1", pageId: "p1" }));
  const sig = signNotionBody(secret, raw);
  ok(verifyNotionSignature(secret, raw, sig), "a signed notion forge body verifies against the real verifyNotionSignature");
  ok(!verifyNotionSignature(secret, raw + "x", sig), "a tampered notion body fails verification");
  ok(!verifyNotionSignature("wrong", raw, sig), "the wrong notion secret fails verification");
}

console.log(`\n✓ notion-provider-integration: ${n} assertions passed (manifest row, reply gate, target, execute + audit, no-anchor throw, forge-signer round-trip)`);
