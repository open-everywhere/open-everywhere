import assert from "node:assert/strict";
import {
  _resetSurfaceSessionStateForTest,
  markSurfaceSession,
  parkedSurfaceStatus,
  registerSurfaceSessionState,
  type SurfaceSessionStatus,
} from "../agent/channels/surface-session-state.js";
import { noteSessionAttention } from "../agent/status/attention.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";

registerSlackFixtureMapper();

let n = 0;
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("§1 the registry");
{
  _resetSurfaceSessionStateForTest();
  await markSurfaceSession("slack", { channel_id: "D1" }, "processing");
  let thrown = 0;
  registerSurfaceSessionState("slack", async () => {
    thrown += 1;
    throw new Error("vendor down");
  });
  await markSurfaceSession("slack", { channel_id: "D1" }, "active");
  eq(thrown, 1, "the setter ran, threw, and the throw never escaped markSurfaceSession");
  await markSurfaceSession("discord", { channel_id: "D1" }, "active");
  await markSurfaceSession("slack", undefined, "active");
  eq(thrown, 1, "a platform with no setter, or a delivery with no attributes, calls no setter");
  eq(parkedSurfaceStatus(true), "suspended", "a park that waits on a person is suspended");
  eq(parkedSurfaceStatus(false), "active", "any other park is active");
}

console.log("§2 the turn-anchor hook drives it");
{
  _resetSurfaceSessionStateForTest();
  const calls: { readonly status: SurfaceSessionStatus; readonly channel: unknown }[] = [];
  registerSurfaceSessionState("slack", async (attributes, status) => {
    calls.push({ status, channel: attributes.channel_id });
    return String(attributes.agent_session_ts);
  });
  const hook = (await import("../agent/hooks/turn-anchor.js")).default as unknown as {
    events: Record<string, (e: unknown, ctx?: unknown) => Promise<void>>;
  };
  const DM_ATTRS = { team_id: "T1", channel_id: "D1", channel_type: "im", user_id: "U7", agent_session_ts: "1700159720.000100" };
  const ctx = {
    channel: { kind: "slack", continuationToken: "D1:oe-dm:g1" },
    session: { id: "sess-surface-state", auth: { current: { principalId: "U7", principalType: "slack-user", attributes: DM_ATTRS } } },
  };
  const session = new FakeEveContext();
  const turn = async (turnId: string, report?: "needs_input" | "blocked" | "working" | "done"): Promise<void> =>
    inEveContext(session, async () => {
      await hook.events["turn.started"]!({ type: "turn.started", data: { turnId } }, ctx);
      if (report) noteSessionAttention(report);
      await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, ctx);
    });

  await turn("t1", "needs_input");
  eq(calls, [{ status: "processing", channel: "D1" }, { status: "suspended", channel: "D1" }], "a turn that waits on its person: processing, then suspended at the park");

  calls.length = 0;
  await turn("t2");
  eq(calls.map((c) => c.status), ["processing", "active"], "the answer's turn resets it: processing, then active");

  for (const [report, park] of [["blocked", "suspended"], ["working", "active"], ["done", "active"]] as const) {
    calls.length = 0;
    await turn(`t-${report}`, report);
    eq(calls.map((c) => c.status), ["processing", park], `update_status(${report}) parks ${park}`);
  }

  const steered: { readonly status: SurfaceSessionStatus; readonly session: unknown }[] = [];
  registerSurfaceSessionState("slack", async (attributes, status) => {
    steered.push({ status, session: attributes.agent_session_ts });
    return String(attributes.agent_session_ts);
  });
  const ctxB = { ...ctx, session: { ...ctx.session, auth: { current: { ...ctx.session.auth.current, attributes: { ...DM_ATTRS, agent_session_ts: "1700159720.000200" } } } } };
  await inEveContext(new FakeEveContext(), async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "s1" } }, ctx);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, ctxB);
  });
  eq(
    steered,
    [
      { status: "processing", session: "1700159720.000100" },
      { status: "active", session: "1700159720.000200" },
      { status: "active", session: "1700159720.000100" },
    ],
    "a steered second message: the park settles the last message's session AND the one the turn started on",
  );
  steered.length = 0;
  await inEveContext(new FakeEveContext(), async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "s2" } }, ctx);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, ctx);
  });
  eq(steered.map((c) => c.status), ["processing", "active"], "one delivery: the park settles its session once, not twice");
  steered.length = 0;
  const ctxStamped = { ...ctx, session: { ...ctx.session, auth: { current: { ...ctx.session.auth.current, attributes: { ...DM_ATTRS, oe_wake: "w-later" } } } } };
  await inEveContext(new FakeEveContext(), async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "s3" } }, ctx);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, ctxStamped);
  });
  eq(steered.map((c) => c.status), ["processing", "active"], "one conversation whose attribute bag gained a stamp: the park settles it once");
  registerSurfaceSessionState("slack", async (attributes, status) => {
    calls.push({ status, channel: attributes.channel_id });
    return String(attributes.agent_session_ts);
  });
  calls.length = 0;

  calls.length = 0;
  const { workTokenForSeat } = await import("../agent/channels/work.js");
  const { isWorkSessionContext } = await import("../agent/access/work-session.js");
  const work = { ...ctx, channel: { kind: "slack", continuationToken: workTokenForSeat("oe-dom:e2e-unified:win:slack_T1_D1:oe-sup:g1") } };
  eq(isWorkSessionContext(work as never), true, "(precondition) the fixture is the work session's own context");
  await inEveContext(new FakeEveContext(), async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "w1" } }, work);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, work);
  });
  eq(calls, [], "the work session's turn sets no conversation state");

  const child = {
    channel: { kind: "subagent", continuationToken: "D1:oe-dm:g1" },
    session: { id: "sess-surface-state-child", auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { ...DM_ATTRS, oe_platform: "slack" } } } },
  };
  const { isSubagentChildContext } = await import("../agent/identity/binding.js");
  eq(isSubagentChildContext(child as never), true, "(precondition) the fixture is a subagent child's context");
  await inEveContext(new FakeEveContext(), async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "c1" } }, child);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, child);
  });
  eq(calls, [], "a subagent child's turn sets no conversation state");
}

console.log("§3 a platform with no setter touches no session state");
{
  const hook = (await import("../agent/hooks/turn-anchor.js")).default as unknown as {
    events: Record<string, (e: unknown, ctx?: unknown) => Promise<void>>;
  };
  const KEYS = ["open-everywhere.attention.session-state", "open-everywhere.turn-anchor.surface-session"];
  const discordCtx = {
    channel: { kind: "discord", continuationToken: "discord-thread-1" },
    session: { id: "sess-discord", auth: { current: { principalId: "9000", principalType: "discord-user", attributes: { guild_id: "1300", channel_id: "1301" } } } },
  };
  const { channelPlatform } = await import("../agent/identity/binding.js");
  const { hasSurfaceSessionSetter } = await import("../agent/channels/surface-session-state.js");
  eq(channelPlatform(discordCtx as never), "discord", "(precondition) the fixture resolves to Discord");
  eq(hasSurfaceSessionSetter("discord"), false, "(precondition) Discord registered no setter");
  const container = new FakeEveContext();
  await inEveContext(container, async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "d1" } }, discordCtx);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, discordCtx);
  });
  eq(KEYS.filter((k) => container.has({ name: k })), [], "a Discord session's turn and park create none of the feature's slot keys");
  const slackContainer = new FakeEveContext();
  const slackCtx = {
    channel: { kind: "slack", continuationToken: "D1:oe-dm:g1" },
    session: { id: "sess-slack-keys", auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { team_id: "T1", channel_id: "D1", channel_type: "im", user_id: "U7", agent_session_ts: "1.1" } } } },
  };
  await inEveContext(slackContainer, async () => {
    await hook.events["turn.started"]!({ type: "turn.started", data: { turnId: "k1" } }, slackCtx);
    await hook.events["session.waiting"]!({ type: "session.waiting", data: {} }, slackCtx);
  });
  eq(KEYS.filter((k) => slackContainer.has({ name: k })).length, 2, "(positive control) a Slack session that passes the gate carries both keys");
}

_resetSurfaceSessionStateForTest();
console.log(`✅ surface-session-state: ${n} assertions passed`);
