import assert from "node:assert/strict";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
registerSlackProvider();

process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const { dispatchDirectMessage, canDeliverDirectMessage, directMessageCapablePlatforms } = await import("@open-everywhere/core/agent/channels/post-arms.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
};

interface Call {
  readonly method: string;
  readonly body: string;
}
const calls: Call[] = [];
let openResponse: Record<string, unknown> = { ok: true, channel: { id: "D_ROWAN" } };
let postResponse: Record<string, unknown> = { ok: true, ts: "1712.5000" };
const realFetch = globalThis.fetch;
const resp = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
globalThis.fetch = (async (url: unknown, init: { body?: unknown }) => {
  const u = String(url);
  const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
  const method = u.split("/api/")[1] ?? u;
  calls.push({ method, body });
  if (method === "conversations.open") return resp(openResponse);
  if (method === "chat.postMessage") return resp(postResponse);
  return resp({ ok: false, error: "unexpected_method" });
}) as typeof fetch;

ok(canDeliverDirectMessage("slack"), "the slack post arm declares DM-delivery support");
ok(directMessageCapablePlatforms().includes("slack"), "slack is listed among the DM-capable platforms");

{
  calls.length = 0;
  const delivery = await dispatchDirectMessage("slack", { principalId: "U_ROWAN", text: "Admin-pane output — totals" });
  ok(calls.length === 2, "one conversations.open followed by one chat.postMessage");
  ok(calls[0].method === "conversations.open" && /users=U_ROWAN/.test(calls[0].body), "conversations.open is called with the requester's member id");
  ok(calls[1].method === "chat.postMessage", "the message is posted after the IM is opened");
  ok(/channel=D_ROWAN/.test(calls[1].body), "the post targets the IM channel conversations.open returned — never the asking room");
  ok(/Admin-pane\+output/.test(calls[1].body), "the rendered substance is the post's text");
  ok(!/thread_ts/.test(calls[1].body), "a DM delivery is top-level (no thread anchor from the asking room)");
  ok(delivery.surfaceId === "D_ROWAN" && delivery.messageId === "1712.5000", "the delivery reports the DM surface + message ids");
}

{
  calls.length = 0;
  openResponse = { ok: false, error: "missing_scope" };
  await assert.rejects(
    () => dispatchDirectMessage("slack", { principalId: "U_ROWAN", text: "totals" }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /couldn't open a Slack DM/.test(msg) && /missing_scope/.test(msg) && !/xoxb/.test(msg);
    },
    "a missing im:write scope throws a loud, token-free 'couldn't open a Slack DM' error",
  );
  n++;
  ok(calls.length === 1 && calls[0].method === "conversations.open", "nothing is posted when the IM can't be opened");
  openResponse = { ok: true, channel: { id: "D_ROWAN" } };
}

{
  calls.length = 0;
  postResponse = { ok: false, error: "msg_too_long" };
  await assert.rejects(
    () => dispatchDirectMessage("slack", { principalId: "U_ROWAN", text: "totals" }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /couldn't post the Slack DM/.test(msg) && /msg_too_long/.test(msg) && !/xoxb/.test(msg);
    },
    "a post that doesn't land throws rather than reporting a delivery that never happened",
  );
  n++;
  postResponse = { ok: true, ts: "1712.5000" };
}

await assert.rejects(
  () => dispatchDirectMessage("github", { principalId: "U_ROWAN", text: "totals" }),
  (err: unknown) => err instanceof Error && /no DM-delivery arm for platform "github"/.test(err.message) && /slack/.test(err.message),
  "a provider with no DM arm refuses loudly, naming the providers that do implement it",
);
n++;

globalThis.fetch = realFetch;
console.log(`\n✓ governance DM delivery: ${n} assertions passed (OPE-44 slack conversations.open + chat.postMessage arm)\n`);
