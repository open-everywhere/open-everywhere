import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestedReaction, ReactionSinkDeps } from "@open-everywhere/core/agent/adapter-api.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-teams-reaction-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.DO_NOT_TRACK = "1";

const { REACTION_FEEDBACK_ACTION, classifyEmoji, deploymentOrg, readAudit } = await import("@open-everywhere/core/agent/adapter-api.js");
const { parseTeamsReaction, routeTeamsStopReaction, TEAMS_STOP_REACTION } = await import("../agent/channels/teams-stop.js");
const { routeTeamsReactionFeedback } = await import("../agent/channels/teams-reaction-feedback.js");
const { buildTeamsFrontHandler, PUBLIC_TEAMS_ROUTE } = await import("../agent/channels/teams-front.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const AGENT = "28:app-id-1";
const HUMAN = "29:human-1";
const CONVERSATION = "19:chain@thread.tacv2";
const AGENT_MESSAGE = "1575667808184";

function reactionActivity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "messageReaction",
    channelId: "msteams",
    reactionsAdded: [{ type: "like" }],
    from: { id: HUMAN, aadObjectId: "aad-1" },
    recipient: { id: AGENT, name: "Test Agent" },
    conversation: { id: CONVERSATION, conversationType: "channel", tenantId: "tenant-1" },
    channelData: { channel: { id: "19:chan@thread.tacv2" }, team: { id: "19:team@thread.tacv2" }, tenant: { id: "tenant-1" } },
    replyToId: AGENT_MESSAGE,
    ...over,
  };
}

function captureSink(): { deps: { sink: ReactionSinkDeps }; recorded: IngestedReaction[]; telem: IngestedReaction[] } {
  const recorded: IngestedReaction[] = [];
  const telem: IngestedReaction[] = [];
  return {
    deps: { sink: { record: async (r) => void recorded.push(r), telemetry: (r) => void telem.push(r) } },
    recorded,
    telem,
  };
}

{
  const rx = parseTeamsReaction(reactionActivity({ reactionsRemoved: [{ type: "HEART" }] }));
  ok(rx?.added.join() === "like", "the parse carries the added reaction type");
  ok(rx?.removed.join() === "heart", "…and the REMOVED types, lower-cased like the added ones");
  ok(rx?.replyToId === AGENT_MESSAGE, "…and replyToId, the agent's own message the reaction landed on");

  const bare = parseTeamsReaction(reactionActivity({ replyToId: undefined, reactionsRemoved: undefined }));
  ok(bare?.removed.length === 0, "negative control: no reactionsRemoved yields an EMPTY list, never undefined");
  ok(bare?.replyToId === undefined, "negative control: no replyToId is absent, never an empty string");
  ok(parseTeamsReaction({ type: "messageReaction", reactionsRemoved: "bogus" })?.removed.length === 0, "a malformed reactionsRemoved contributes nothing rather than throwing");
}

{
  const s = captureSink();
  const rx = parseTeamsReaction(reactionActivity())!;
  const outcomes = await routeTeamsReactionFeedback(rx, s.deps);
  ok(outcomes.length === 1, "one added reaction yields one outcome");
  ok(outcomes[0]!.recorded === true, "…and it is RECORDED — the reaction landed on the agent's own message");
  ok(s.recorded.length === 1 && s.telem.length === 1, "…through both sinks: the durable record and the telemetry");
  const r = s.recorded[0]!;
  ok(r.surface === "teams", "the row names the teams surface");
  ok(r.reactorId === HUMAN && r.emoji === "like" && r.verb === "added", "…the reactor, the glyph and the verb");
  ok(r.target.channelId === CONVERSATION && r.target.messageId === AGENT_MESSAGE, "…and both message refs");
  ok(r.org.length > 0 && r.workspace.length > 0 && r.surfaceKey.length > 0, "…on resolved partition coordinates");

  const s2 = captureSink();
  const anonymous = parseTeamsReaction(reactionActivity({ replyToId: undefined }))!;
  const out2 = await routeTeamsReactionFeedback(anonymous, s2.deps);
  ok(out2[0]?.recorded === false, "negative control: no replyToId ⇒ telemetry only, never a feedback row");
  ok(s2.recorded.length === 0 && s2.telem.length === 1, "…the telemetry still fires; only the durable write is withheld");
}

{
  const s = captureSink();
  const self = parseTeamsReaction(reactionActivity({ from: { id: AGENT } }))!;
  ok((await routeTeamsReactionFeedback(self, s.deps)).length === 0, "the agent's own reaction (recipient id) is ignored");
  ok(s.recorded.length === 0 && s.telem.length === 0, "…and reaches neither sink");

  const otherBot = parseTeamsReaction(reactionActivity({ from: { id: "28:some-other-app" } }))!;
  ok((await routeTeamsReactionFeedback(otherBot, s.deps)).length === 0, "any `28:` application id is a bot, whatever the recipient says");

  const control = captureSink();
  ok((await routeTeamsReactionFeedback(parseTeamsReaction(reactionActivity())!, control.deps))[0]?.recorded === true, "negative control: the same activity from a person IS recorded");

  const noReactor = parseTeamsReaction(reactionActivity({ from: undefined }))!;
  ok((await routeTeamsReactionFeedback(noReactor, s.deps)).length === 0, "no reactor id ⇒ nothing to attribute, nothing ingested");
  const noConversation = parseTeamsReaction(reactionActivity({ conversation: undefined }))!;
  ok((await routeTeamsReactionFeedback(noConversation, s.deps)).length === 0, "no conversation ⇒ the surface cannot be keyed, nothing ingested");
}

{
  const s = captureSink();
  const stopAdded = parseTeamsReaction(reactionActivity({ reactionsAdded: [{ type: TEAMS_STOP_REACTION }] }))!;
  const out = await routeTeamsStopReaction(stopAdded, {
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    feedback: s.deps,
    cancel: async () => ({ outcome: "requested", message: "standing down" }),
  });
  ok(out.stopped === true, "an ADDED stop reaction still cancels");
  ok(s.recorded.length === 0 && s.telem.length === 0, "🔴 …and never reaches the feedback arm — a mechanism is not a sentiment");

  const s2 = captureSink();
  const stopRemoved = parseTeamsReaction(reactionActivity({ reactionsAdded: undefined, reactionsRemoved: [{ type: TEAMS_STOP_REACTION }] }))!;
  const out2 = await routeTeamsStopReaction(stopRemoved, {
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    feedback: s2.deps,
    cancel: async () => ({ outcome: "requested", message: "standing down" }),
  });
  ok(out2.stopped === false, "a REMOVED stop reaction cancels nothing");
  ok(s2.recorded.length === 1 && s2.recorded[0]!.verb === "removed", "…and is recorded as an ordinary retraction");

  const s4 = captureSink();
  const mixed = parseTeamsReaction(reactionActivity({ reactionsAdded: [{ type: TEAMS_STOP_REACTION }, { type: "like" }], reactionsRemoved: [{ type: "heart" }] }))!;
  const out4 = await routeTeamsStopReaction(mixed, {
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    feedback: s4.deps,
    cancel: async () => ({ outcome: "requested", message: "standing down" }),
  });
  await out4.feedback;
  ok(out4.stopped === true, "a mixed activity carrying the stop glyph still cancels");
  ok(s4.recorded.length === 2, "🔴 …and its OTHER reactions are still recorded — the split is per reaction, not per activity");
  ok(s4.recorded.map((r) => r.emoji).join() === "like,heart", "…the added `like` and the removed `heart`, never the stop glyph itself");

  const s3 = captureSink();
  await routeTeamsStopReaction(parseTeamsReaction(reactionActivity())!, {
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    feedback: s3.deps,
  });
  ok(s3.recorded.length === 1, "🔴 the stop entry point fans a non-stop reaction out to the feedback arm");
}

{
  const recorded: IngestedReaction[] = [];
  let tick = 0;
  let cancelledAt = 0;
  let recordedAt = 0;
  const slow: { sink: ReactionSinkDeps } = {
    sink: {
      record: async (r) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        recordedAt = ++tick;
        recorded.push(r);
      },
      telemetry: () => undefined,
    },
  };

  const mixed = parseTeamsReaction(reactionActivity({ reactionsAdded: [{ type: TEAMS_STOP_REACTION }, { type: "like" }] }))!;
  const out = await routeTeamsStopReaction(mixed, {
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    feedback: slow,
    cancel: async () => {
      cancelledAt = ++tick;
      return { outcome: "requested", message: "standing down" };
    },
  });
  ok(out.stopped === true, "a mixed activity still cancels with the feedback sink still writing");
  ok(cancelledAt === 1, "🔴 …the cancel ran FIRST — a SLOW feedback row never costs a person their stop");
  ok(recorded.length === 1 && recorded[0]!.emoji === "like", "🔴 …and the arm returned with the durable row already written — a suspending host cannot drop it");
  ok(recordedAt === 2, "…the row landed AFTER the cancel, which is the whole ordering");

  await out.feedback;
  ok(recorded.length === 1, "negative control: the rider was already settled — awaiting it records nothing further");
}

{
  ok(classifyEmoji("like") === "positive", "teams `like` buckets positive — the commonest reaction this surface has");
  ok(classifyEmoji("heart") === "positive", "teams `heart` buckets positive");
  ok(classifyEmoji("laugh") === "positive", "teams `laugh` buckets positive");
  ok(classifyEmoji("sad") === "negative", "teams `sad` buckets negative");
  ok(classifyEmoji("angry") === "negative", "teams `angry` buckets negative");
  ok(classifyEmoji("surprised") === "other", "negative control: teams `surprised` stays `other` — surprise is not sentiment");
}

{
  const before = (await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION })).length;
  const forwarded: string[] = [];
  const handler = buildTeamsFrontHandler(
    async () => {
      forwarded.push("native");
      return new Response("native");
    },
    { verify: async (req) => await req.text() },
  );
  const waited: Promise<unknown>[] = [];
  const args = {
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    to: undefined,
    from: undefined,
  } as unknown as Parameters<typeof handler>[1];

  const res = await handler(new Request(`https://example.test${PUBLIC_TEAMS_ROUTE}`, { method: "POST", body: JSON.stringify(reactionActivity()) }), args);
  await Promise.all(waited);
  ok(res.status === 200, "the front acks the reaction activity");
  ok(forwarded.length === 0, "…and never forwards it to the native channel");

  const rows = await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION });
  ok(rows.length === before + 1, "🔴 REACHABILITY: the real front drives a Teams reaction to a durable audit row");
  const detail = rows[0]!.detail as Record<string, unknown>;
  ok(detail["surface"] === "teams" && detail["emoji"] === "like", "…naming the surface and the glyph");
  ok(detail["messageId"] === AGENT_MESSAGE && detail["onBotReply"] === true, "…the agent's own message, marked as the feedback case");
  ok(rows[0]!.principalId === HUMAN, "…and the person who reacted");

  const waited2: Promise<unknown>[] = [];
  const args2 = { ...(args as object), waitUntil: (p: Promise<unknown>) => void waited2.push(p) } as unknown as Parameters<typeof handler>[1];
  await handler(new Request(`https://example.test${PUBLIC_TEAMS_ROUTE}`, { method: "POST", body: JSON.stringify({ type: "conversationUpdate", channelId: "msteams" }) }), args2);
  await Promise.all(waited2);
  ok((await readAudit({ org: deploymentOrg(), action: REACTION_FEEDBACK_ACTION })).length === before + 1, "negative control: a conversationUpdate records nothing");
}

await removeTempDir(dir);
console.log(`✓ teams reaction-feedback: ${n} assertions`);
