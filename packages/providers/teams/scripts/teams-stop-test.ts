import assert from "node:assert/strict";
import { parseTeamsReaction, routeTeamsStopReaction, TEAMS_FEEDBACK_SETTLE_TIMEOUT_MS, TEAMS_STOP_REACTION, type TeamsStopDeps } from "../agent/channels/teams-stop.js";
import { buildTeamsFrontHandler, PUBLIC_TEAMS_ROUTE } from "../agent/channels/teams-front.js";
import { bindTeams, buildTeamsAuth } from "../agent/channels/teams-identity.js";
import type { CancelAnchoredTurnInput, CancelResult } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const AGENT = "28:app-id-1";
const HUMAN = "29:human-1";
const CONVERSATION = "19:chain@thread.tacv2";

function reactionActivity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "messageReaction",
    reactionsAdded: [{ type: TEAMS_STOP_REACTION }],
    from: { id: HUMAN, aadObjectId: "aad-1" },
    recipient: { id: AGENT, name: "Test Agent" },
    conversation: { id: CONVERSATION, conversationType: "channel", tenantId: "tenant-1" },
    channelData: { channel: { id: "19:chan@thread.tacv2" }, team: { id: "19:team@thread.tacv2" }, tenant: { id: "tenant-1" } },
    replyToId: "1575667808184",
    ...over,
  };
}

function recordingDeps(): { deps: TeamsStopDeps; calls: CancelAnchoredTurnInput[] } {
  const calls: CancelAnchoredTurnInput[] = [];
  return {
    calls,
    deps: {
      attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
      feedback: { sink: { record: async () => undefined, telemetry: () => undefined } },
      cancel: async (input: CancelAnchoredTurnInput): Promise<CancelResult> => {
        calls.push(input);
        return { outcome: "requested", message: "Standing down — I'll stop this turn where it is." };
      },
    },
  };
}

{
  const rx = parseTeamsReaction(reactionActivity());
  ok(rx !== null, "a messageReaction activity parses");
  ok(rx?.added.includes(TEAMS_STOP_REACTION) === true, "…carrying the added reaction type");
  ok(rx?.reactorId === HUMAN, "…naming who reacted");
  ok(rx?.agentId === AGENT, "…and the agent the reaction landed on (the recipient)");
  ok(rx?.conversationId === CONVERSATION, "…and the conversation, which is the only key it can offer");
  ok(rx?.tenantId === "tenant-1", "…and the tenant");

  ok(parseTeamsReaction({ type: "message", text: "hello" }) === null, "an ordinary message activity is NOT a reaction");
  ok(parseTeamsReaction({ type: "conversationUpdate" }) === null, "a conversationUpdate is NOT a reaction");
  ok(parseTeamsReaction("not an object") === null, "a non-object body yields null, never a throw");
  ok(parseTeamsReaction({ type: "messageReaction", reactionsAdded: "bogus" })?.added.length === 0, "a malformed reactionsAdded contributes nothing rather than throwing");
}

{
  const { deps, calls } = recordingDeps();
  const out = await routeTeamsStopReaction(parseTeamsReaction(reactionActivity())!, deps);
  ok(out.stopped === true, "a human stop reaction on an agent message CANCELS");
  ok(calls.length === 1, "…through exactly one cancelAnchoredTurn call");
  const call = calls[0]!;
  ok(call.platform === "teams", "…stamped platform teams");
  ok(call.via === "reaction", "…stamped via: reaction — the same affordance class as Slack's ✋");
  ok(call.requestedBy === HUMAN, "…naming the person who asked");
  ok(call.query.channelKey === `teams:${CONVERSATION}`, "…keyed on the CONVERSATION");
  ok(call.query.anchorKey === undefined, "…and offering NO anchorKey: replyToId names the agent's message, never the turn's anchor, so that lookup would always miss");
}

{
  const { deps, calls } = recordingDeps();
  ok((await routeTeamsStopReaction(parseTeamsReaction(reactionActivity({ from: { id: AGENT } }))!, deps)).stopped === false, "the AGENT's own reaction never cancels (no self-cancel)");
  ok((await routeTeamsStopReaction(parseTeamsReaction(reactionActivity({ from: { id: "28:another-app" } }))!, deps)).stopped === false, "ANOTHER application's reaction never cancels — `28:` is the Bot Framework's own app prefix");
  ok((await routeTeamsStopReaction(parseTeamsReaction(reactionActivity({ recipient: {} }))!, deps)).stopped === false, "an UNRESOLVED agent id refuses the cancel (fail-closed)");
  ok((await routeTeamsStopReaction(parseTeamsReaction(reactionActivity({ from: {} }))!, deps)).stopped === false, "an UNRESOLVED reactor refuses the cancel (fail-closed)");
  ok((await routeTeamsStopReaction(parseTeamsReaction(reactionActivity({ conversation: {} }))!, deps)).stopped === false, "no conversation refuses — nothing to resolve a turn against");
  ok(calls.length === 0, "none of the five reached the cancel door");

  const control = recordingDeps();
  ok((await routeTeamsStopReaction(parseTeamsReaction(reactionActivity())!, control.deps)).stopped === true, "negative control: the SAME activity from a person DOES cancel");
}

{
  const { deps, calls } = recordingDeps();
  const removal = parseTeamsReaction(reactionActivity({ reactionsAdded: undefined, reactionsRemoved: [{ type: TEAMS_STOP_REACTION }] }))!;
  ok(removal.added.length === 0, "(precondition) a removal carries no ADDED reaction");
  ok((await routeTeamsStopReaction(removal, deps)).stopped === false, "a reaction REMOVAL never cancels");

  for (const other of ["heart", "laugh", "like", "sad", "surprised"]) {
    const rx = parseTeamsReaction(reactionActivity({ reactionsAdded: [{ type: other }] }))!;
    ok((await routeTeamsStopReaction(rx, deps)).stopped === false, `the \`${other}\` reaction never cancels`);
  }
  ok(calls.length === 0, "none of the six reached the cancel door");
}

{
  const forwarded: string[] = [];
  const seen: unknown[] = [];
  const handler = buildTeamsFrontHandler(
    async () => {
      forwarded.push("native");
      return new Response("native");
    },
    {
      verify: async (req) => await req.text(),
      stopReaction: async (rx) => {
        seen.push(rx);
        return { stopped: true, outcome: "requested" };
      },
    },
  );
  const waited: Promise<unknown>[] = [];
  const args = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    to: undefined,
    from: undefined,
  } as unknown as Parameters<typeof handler>[1];

  const res = await handler(new Request(`https://example.test${PUBLIC_TEAMS_ROUTE}`, { method: "POST", body: JSON.stringify(reactionActivity()) }), args);
  await Promise.all(waited);
  ok(res.status === 200, "the front acks a reaction activity");
  ok(seen.length === 1, "🔴 REACHABILITY: the front routes a messageReaction into the stop arm");
  ok(forwarded.length === 0, "…and never forwards it to the native channel, which has nothing to do with it");

  const waited2: Promise<unknown>[] = [];
  const args2 = { ...(args as object), waitUntil: (p: Promise<unknown>) => void waited2.push(p) } as unknown as Parameters<typeof handler>[1];
  await handler(new Request(`https://example.test${PUBLIC_TEAMS_ROUTE}`, { method: "POST", body: JSON.stringify({ type: "conversationUpdate" }) }), args2);
  await Promise.all(waited2);
  ok(seen.length === 1, "negative control: a conversationUpdate does NOT reach the stop arm");
  ok(forwarded.length === 1, "…it forwards to the native channel exactly as before");
}

{
  const bound = bindTeams({
    session: {
      auth: {
        current: buildTeamsAuth({
          userId: HUMAN,
          conversationId: CONVERSATION,
          tenantId: "tenant-1",
          channelId: "19:chan@thread.tacv2",
          teamId: "19:team@thread.tacv2",
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          scope: "channel",
        }),
      },
    },
  });
  assert.equal(bound.anchorChannelId, CONVERSATION);
  ok(bound.anchorChannelId === CONVERSATION, "bindTeams stows the CONVERSATION as the stop registry's container id");
  ok(bound.target?.["channelId"] === "19:chan@thread.tacv2", "…while `target.channelId` keeps holding the Teams CHANNEL, unchanged");
  ok(bound.anchorChannelId !== bound.target?.["channelId"], "🔴 the two are DIFFERENT values — which is why the registry needs its own field");
}

{
  const { deps } = recordingDeps();
  const stuck: TeamsStopDeps = {
    ...deps,
    feedback: { sink: { record: () => new Promise<void>(() => undefined), telemetry: () => undefined } },
  };
  const mixed = parseTeamsReaction(reactionActivity({ reactionsAdded: [{ type: TEAMS_STOP_REACTION }, { type: "like" }] }))!;
  ok(mixed.added.length === 2, "(precondition) the activity carries the stop glyph AND a feedback reaction");

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const verdict = await Promise.race([
    routeTeamsStopReaction(mixed, stuck).then((out) => (out.stopped ? "returned" : "returned-without-stopping")),
    new Promise<"hung">((resolve) => {
      deadline = setTimeout(() => resolve("hung"), TEAMS_FEEDBACK_SETTLE_TIMEOUT_MS * 3);
    }),
  ]);
  clearTimeout(deadline);
  ok(verdict === "returned", `🔴 a feedback sink that never settles does NOT hold the stop arm open (verdict: ${verdict})`);
}

console.log(`\n✓ teams-stop: ${passed} assertions passed (activity parse, the cancel key, the fail-closed reactor guard with negative controls, the five reactions that must not cancel, front reachability, the binding's anchor address, and the bounded feedback settle)`);
