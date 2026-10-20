import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { IngestedReaction, ReactionSinkDeps } from "@open-everywhere/core/agent/adapter-api.js";

const dir = join(tmpdir(), `open-everywhere-slack-reaction-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.DO_NOT_TRACK = "1";

const { REACTION_FEEDBACK_ACTION } = await import("@open-everywhere/core/agent/adapter-api.js");
const { readAudit } = await import("@open-everywhere/core/agent/adapter-api.js");
const { parseSlackReactionEvent, routeReactionEvent } = await import("../agent/channels/slack-events.js");
const { buildFrontHandler, classifyEnvelope } = await import("../agent/channels/slack-front.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function captureSink(): { deps: ReactionSinkDeps; recorded: IngestedReaction[]; telem: IngestedReaction[] } {
  const recorded: IngestedReaction[] = [];
  const telem: IngestedReaction[] = [];
  return {
    deps: {
      record: async (r) => void recorded.push(r),
      telemetry: (r) => void telem.push(r),
    },
    recorded,
    telem,
  };
}

{
  const env = (event: Record<string, unknown>) => ({ type: "event_callback", team_id: "T1", event_id: "Ev1", event });
  const good = parseSlackReactionEvent(
    env({ type: "reaction_added", user: "U1", reaction: "thumbsup", item_user: "UBOT", item: { type: "message", channel: "C1", ts: "1.1" } }),
  );
  ok(
    good !== null && good.verb === "added" && good.reactorId === "U1" && good.emoji === "thumbsup" && good.channelId === "C1" && good.messageTs === "1.1" && good.itemUser === "UBOT",
    "parseSlack: reaction_added → all fields",
  );
  const removed = parseSlackReactionEvent(env({ type: "reaction_removed", user: "U1", reaction: "x", item: { type: "message", channel: "C1", ts: "1.1" } }));
  ok(removed !== null && removed.verb === "removed" && removed.itemUser === undefined, "parseSlack: reaction_removed → verb removed, item_user optional");
  ok(parseSlackReactionEvent(env({ type: "reaction_added", user: "U1", reaction: "star", item: { type: "file", file: "F1" } })) === null, "parseSlack: non-message item (file) → null");
  ok(parseSlackReactionEvent(env({ type: "reaction_added", user: "U1", reaction: "star", item: { type: "message", channel: "C1" } })) === null, "parseSlack: missing ts → null");
  ok(parseSlackReactionEvent(env({ type: "message", channel: "C1", ts: "1.1" }) as never) === null, "parseSlack: non-reaction event → null");
  ok(parseSlackReactionEvent({ type: "url_verification" } as never) === null, "parseSlack: non-event_callback → null");
}

{
  const env = (event: Record<string, unknown>) => ({ type: "event_callback", team_id: "T1", event_id: "Ev1", event });
  const botReply = parseSlackReactionEvent(env({ type: "reaction_added", user: "UHUMAN", reaction: "thumbsup", item_user: "UBOT", item: { type: "message", channel: "C1", ts: "1.1" } }))!;

  {
    const s = captureSink();
    const out = await routeReactionEvent(botReply, { botIdentity: { userId: "UBOT" }, sink: s.deps });
    ok(out.recorded && out.onBotReply && s.recorded.length === 1 && s.recorded[0].surface === "slack" && s.recorded[0].onBotReply, "routeSlack: reaction on the bot's own reply → recorded");
  }
  {
    const s = captureSink();
    const nonBot = parseSlackReactionEvent(env({ type: "reaction_added", user: "UHUMAN", reaction: "thumbsup", item_user: "UHUMAN2", item: { type: "message", channel: "C1", ts: "1.1" } }))!;
    const out = await routeReactionEvent(nonBot, { botIdentity: { userId: "UBOT" }, sink: s.deps });
    ok(!out.recorded && s.recorded.length === 0 && s.telem.length === 1, "routeSlack: reaction on a NON-bot message → telemetry only");
  }
  {
    const s = captureSink();
    const removed = parseSlackReactionEvent(env({ type: "reaction_removed", user: "UHUMAN", reaction: "thumbsup", item_user: "UBOT", item: { type: "message", channel: "C1", ts: "1.1" } }))!;
    const out = await routeReactionEvent(removed, { botIdentity: { userId: "UBOT" }, sink: s.deps });
    ok(out.recorded && s.recorded[0].verb === "removed", "routeSlack: a removed reaction on a bot reply is handled (verb=removed)");
  }
  {
    const s = captureSink();
    const selfReact = parseSlackReactionEvent(env({ type: "reaction_added", user: "UBOT", reaction: "eyes", item_user: "UHUMAN", item: { type: "message", channel: "C1", ts: "1.1" } }))!;
    const out = await routeReactionEvent(selfReact, { botIdentity: { userId: "UBOT" }, sink: s.deps });
    ok(!out.recorded && s.recorded.length === 0 && s.telem.length === 0, "routeSlack: the BOT's own reaction is ignored entirely (no record, no telemetry)");
  }
  {
    const s = captureSink();
    const out = await routeReactionEvent(botReply, { botIdentity: {}, sink: s.deps });
    ok(!out.recorded && !out.onBotReply && s.telem.length === 1, "routeSlack: unresolved bot identity → fail-safe onBotReply=false (telemetry only)");
  }
}

{
  const JSON_CT = "application/json";
  const ev = (event: Record<string, unknown>) => JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "EvR1", event });

  ok(classifyEnvelope(ev({ type: "reaction_added", item: { type: "message", channel: "C1", ts: "1.1" } }), JSON_CT).kind === "reaction", "classify: reaction_added → reaction");
  ok(classifyEnvelope(ev({ type: "reaction_removed", item: { type: "message", channel: "C1", ts: "1.1" } }), JSON_CT).kind === "reaction", "classify: reaction_removed → reaction");

  const secret = "reaction-secret";
  const nowMs = 1_700_000_000_000;
  const mkReq = (body: string) => {
    const ts = String(Math.floor(nowMs / 1000));
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    return new Request("https://oe.test/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": JSON_CT, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
      body,
    });
  };
  const reactionBody = (over: Record<string, unknown> = {}, eventId = "EvR1") =>
    JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: eventId,
      event: { type: "reaction_added", user: "UHUMAN", reaction: "thumbsup", item_user: "UBOT", item: { type: "message", channel: "C1", ts: "9.9" }, ...over },
    });

  const waits: Array<Promise<unknown>> = [];
  const fakeArgs = { from: () => ({ send: async () => ({}) }), waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const frontOpts = { signingSecret: secret, now: () => nowMs, getBotIdentity: async () => ({ userId: "UBOT" }) };

  const handler = buildFrontHandler(async () => new Response("inner"), frontOpts);
  const body = reactionBody();
  let res = await handler(mkReq(body), fakeArgs as unknown as Parameters<typeof handler>[1]);
  ok(res.status === 200, "front: signed reaction → 200");
  res = await handler(mkReq(body), fakeArgs as unknown as Parameters<typeof handler>[1]);
  ok(res.status === 200, "front: retried reaction (same event_id) → 200");
  await Promise.all(waits);
  const rows = await readAudit({ org: "default", action: REACTION_FEEDBACK_ACTION });
  ok(rows.length === 1, "front: a retried bot-reply reaction is recorded EXACTLY once (deduped)");
  ok(
    rows[0].surface?.startsWith("slack/") === true && rows[0].principalId === "UHUMAN" && rows[0].detail?.emojiClass === "positive" && rows[0].detail?.onBotReply === true && rows[0].detail?.channelId === "C1",
    "front: the feedback row carries surface/reactor/emojiClass/onBotReply (no message text)",
  );

  waits.length = 0;
  const badReq = new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": JSON_CT, "x-slack-request-timestamp": String(Math.floor(nowMs / 1000)), "x-slack-signature": "v0=deadbeef" },
    body: reactionBody({}, "EvR-bad"),
  });
  const badHandler = buildFrontHandler(async () => new Response("inner"), frontOpts);
  const badRes = await badHandler(badReq, fakeArgs as unknown as Parameters<typeof badHandler>[1]);
  ok(badRes.status === 401 && waits.length === 0, "front: bad signature → 401, no ingestion scheduled");

  waits.length = 0;
  const before = (await readAudit({ org: "default", action: REACTION_FEEDBACK_ACTION })).length;
  const malformedHandler = buildFrontHandler(async () => new Response("inner"), frontOpts);
  const malformed = reactionBody({ item: { type: "file", file: "F1" } }, "EvR-malformed");
  const mRes = await malformedHandler(mkReq(malformed), fakeArgs as unknown as Parameters<typeof malformedHandler>[1]);
  await Promise.all(waits);
  const after = (await readAudit({ org: "default", action: REACTION_FEEDBACK_ACTION })).length;
  ok(mRes.status === 200 && after === before, "front: malformed reaction (non-message item) → 200, nothing recorded (fail-soft)");

  waits.length = 0;
  const selfHandler = buildFrontHandler(async () => new Response("inner"), frontOpts);
  const selfBody = reactionBody({ user: "UBOT", item_user: "UHUMAN" }, "EvR-self");
  const sRes = await selfHandler(mkReq(selfBody), fakeArgs as unknown as Parameters<typeof selfHandler>[1]);
  await Promise.all(waits);
  const afterSelf = (await readAudit({ org: "default", action: REACTION_FEEDBACK_ACTION })).length;
  ok(sRes.status === 200 && afterSelf === after, "front: the bot's own reaction is ignored end-to-end (no feedback row)");
}


console.log(`\n✓ slack-reaction-ingest: ${n} assertions passed (Slack parse/route + front dedupe/signature)\n`);
