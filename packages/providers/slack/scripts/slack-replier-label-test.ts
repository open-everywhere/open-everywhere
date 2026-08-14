import assert from "node:assert/strict";
import { slackReplierParams, postSlackMessage, type SlackPostResult } from "../agent/channels/slack-post-arm.js";
import type { ReplierLabel } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

console.log("slackReplierParams:");

const worker: ReplierLabel = { taskLabel: "Fix the deploy pipeline" };

eq(
  slackReplierParams("Open Everywhere", worker),
  { username: "Open Everywhere [Fix the deploy pipeline]" },
  "a resolvable agent name + a worker-turn replier ⇒ the bracketed username override",
);

eq(slackReplierParams("Open Everywhere", undefined), {}, "NEGATIVE CONTROL: a supervisor/bare reply (no replier) gets no username override");
eq(slackReplierParams(undefined, worker), {}, "NEGATIVE CONTROL: an unresolvable agent name fails OPEN — no override rather than a name-less bracket");
eq(slackReplierParams("", worker), {}, "NEGATIVE CONTROL: an empty-string agent name is treated the same as unresolvable");
eq(slackReplierParams("   ", worker), {}, "NEGATIVE CONTROL: a whitespace-only agent name is treated the same as unresolvable");
eq(slackReplierParams(undefined, undefined), {}, "NEGATIVE CONTROL: neither present ⇒ no override");

console.log("postSlackMessage — the retry-on-reject fallback:");

const resolveName = async () => "Open Everywhere";

function scopeRejectingBridge(): { post: (body: URLSearchParams) => Promise<SlackPostResult>; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  return {
    calls,
    post: async (body: URLSearchParams) => {
      calls.push(body);
      if (body.has("username")) return { ok: false, error: "missing_scope" };
      return { ok: true, ts: `ts-${calls.length}` };
    },
  };
}

{
  const bridge = scopeRejectingBridge();
  const base = new URLSearchParams({ channel: "C1", text: "Done." });
  const ts = await postSlackMessage(base, worker, "reply couldn't post to Slack", bridge.post, resolveName);
  ok(typeof ts === "string" && ts.length > 0, "the reply STILL LANDS despite the missing-scope rejection on the first (username-bearing) attempt");
  eq(bridge.calls.length, 2, "the retry happened EXACTLY ONCE (two total calls: the rejected attempt + the bare retry)");
  ok(bridge.calls[0].has("username"), "attempt 1 carried the tier-signal username param");
  ok(!bridge.calls[1].has("username"), "attempt 2 (the retry) is the bare `base` request — no username param");
  eq(bridge.calls[1].get("channel"), "C1", "the retry is otherwise IDENTICAL to base — same channel");
  eq(bridge.calls[1].get("text"), "Done.", "…and the same text — only the tier params were dropped");
}

{
  const alwaysFails = async (): Promise<SlackPostResult> => ({ ok: false, error: "channel_not_found" });
  const base = new URLSearchParams({ channel: "C-missing", text: "Done." });
  await assert.rejects(
    () => postSlackMessage(base, worker, "reply couldn't post to Slack", alwaysFails, resolveName),
    /channel_not_found/,
    "a genuine failure that ALSO fails the bare retry still throws — the fallback never hides a real error",
  );
  n++;
}

{
  let calls = 0;
  const bareTarget = async (body: URLSearchParams): Promise<SlackPostResult> => {
    calls++;
    ok(!body.has("username"), "a bare (no replier) post never carries a username param in the first place");
    return { ok: false, error: "channel_not_found" };
  };
  await assert.rejects(
    () => postSlackMessage(new URLSearchParams({ channel: "C1", text: "Done." }), undefined, "reply couldn't post to Slack", bareTarget, resolveName),
    /channel_not_found/,
    "a bare reply's genuine failure throws immediately",
  );
  n++;
  eq(calls, 1, "…with exactly ONE call — no retry to attempt when there was never a tier param to strip");
}

{
  let calls = 0;
  const alwaysOk = async (): Promise<SlackPostResult> => {
    calls++;
    return { ok: true, ts: "ts-happy" };
  };
  const ts = await postSlackMessage(new URLSearchParams({ channel: "C1", text: "Done." }), worker, "reply couldn't post to Slack", alwaysOk, resolveName);
  eq(ts, "ts-happy", "a successful first attempt returns its own ts");
  eq(calls, 1, "…with exactly ONE call — no retry fires when the scope IS granted and the first post lands");
}

console.log(`slack-replier-label-test: ${n} assertions passed`);
