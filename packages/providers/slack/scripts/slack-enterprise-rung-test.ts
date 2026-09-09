process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  registerConfig,
  registerIdentityMapper,
  defineDomain,
  _resetDeploymentIdentityForTest,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildFrontHandler, ThreadFifo } from "../agent/channels/slack-front.js";
import { bindableForSlashCommand } from "../agent/channels/slack-commands.js";
import { bindSlack, forwardedSlackEnterpriseId, withForwardedSlackEnvelope } from "../agent/channels/slack-identity.js";
import { admitInbound } from "../agent/channels/slack.js";

_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST", "OE_TEST_DRIVER_IDS"]) {
  delete process.env[k];
}

const TEAM = "T_SIBLING";
const CHANNEL = "C_SUPPORT";
const OTHER_CHANNEL = "C_OTHER";
const USER = "U_ASKER";
const GRID = "E_GRID";
const OTHER_GRID = "E_OTHER";
const TS = "1769564171.300400";
const OTHER_TS = "1769564199.111000";
const SECRET = "shhh-signing-secret";
const NOW_MS = 1769564200000;

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "support", reach: [`slack/${TEAM}/${CHANNEL}`], memory: "brain" })],
  loadSilos: () => [{ name: "brain", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (surface === CHANNEL ? ["support"] : []),
});

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string): void => {
  assert.deepEqual(actual, expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  n++;
};

const msg = (channelId: string, ts: string) => ({ channelId, ts });

{
  const carried = { enterpriseId: GRID, channelId: CHANNEL, ts: TS };

  withForwardedSlackEnvelope(carried, () => {
    eq(forwardedSlackEnterpriseId(msg(CHANNEL, TS)), GRID, "carrier: the message the envelope described reads the rung back");
    eq(
      forwardedSlackEnterpriseId(msg(OTHER_CHANNEL, TS)),
      undefined,
      "carrier: 🔴 a message in ANOTHER channel reads NOTHING — the carrier answers for one message, not for the process",
    );
    eq(forwardedSlackEnterpriseId(msg(CHANNEL, OTHER_TS)), undefined, "carrier: 🔴 …and neither does another message in the SAME channel");
  });

  eq(forwardedSlackEnterpriseId(msg(CHANNEL, TS)), undefined, "carrier NEGATIVE CONTROL: outside any forward there is no carrier, so the same message reads nothing");
  eq(
    withForwardedSlackEnvelope(undefined, () => forwardedSlackEnterpriseId(msg(CHANNEL, TS))),
    undefined,
    "carrier NEGATIVE CONTROL: an ordinary single-workspace forward stows no carrier — the rung is absent, never empty",
  );

  {
    const order: string[] = [];
    const gate = { release: () => {} };
    const barrier = new Promise<void>((r) => (gate.release = r));

    const first = withForwardedSlackEnvelope({ enterpriseId: GRID, channelId: CHANNEL, ts: TS }, async () => {
      order.push("first:enter");
      await barrier;
      order.push("first:read");
      return forwardedSlackEnterpriseId(msg(CHANNEL, TS));
    });

    const second = withForwardedSlackEnvelope({ enterpriseId: OTHER_GRID, channelId: OTHER_CHANNEL, ts: OTHER_TS }, async () => {
      order.push("second:enter");
      await Promise.resolve();
      const own = forwardedSlackEnterpriseId(msg(OTHER_CHANNEL, OTHER_TS));
      const foreign = forwardedSlackEnterpriseId(msg(CHANNEL, TS));
      gate.release();
      return { own, foreign };
    });

    const outside = forwardedSlackEnterpriseId(msg(CHANNEL, TS));
    const secondResult = await second;
    const firstResult = await first;

    ok(order[0] === "first:enter" && order[1] === "second:enter" && order[2] === "first:read", "concurrency: the two deliveries really did interleave (the second ran to completion inside the first)");
    eq(firstResult, GRID, "concurrency: 🔴 the first delivery still reads its OWN Grid after the second one ran inside it");
    eq(secondResult.own, OTHER_GRID, "concurrency: 🔴 the second delivery reads its own Grid, not the one already in flight");
    eq(secondResult.foreign, undefined, "concurrency: 🔴 …and reading the FIRST delivery's message from inside the second answers nothing — no carrier crosses the boundary");
    eq(outside, undefined, "concurrency: 🔴 code outside both deliveries reads nothing while two carriers are live");
  }
}

function mentionEnvelope(eventId: string, over: Record<string, unknown> = {}, envelopeOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: TEAM,
    ...envelopeOver,
    event: { type: "app_mention", channel: CHANNEL, user: USER, ts: TS, text: "<@UBOT> chase order 4417", ...over },
  });
}

function mkReq(body: string): Request {
  const ts = String(Math.floor(NOW_MS / 1000));
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

async function runForward(body: string, read: () => Promise<void> | void) {
  let openGate = (): void => {};
  const gate = new Promise<void>((r) => (openGate = r));
  let deferred: Promise<void> = Promise.resolve();
  const handler = buildFrontHandler(
    () => {
      deferred = (async () => {
        await gate;
        await read();
      })();
      return Promise.resolve(new Response("inner"));
    },
    {
      signingSecret: SECRET,
      now: () => NOW_MS,
      markEventSeen: async () => true,
      getBotIdentity: async () => ({ userId: "UBOT", botId: "B_OE_SELF" }),
      fifo: new ThreadFifo(() => {}),
      ambientEnabledFor: () => false,
      channelFactsFor: async () => ({ internal: true, channelType: "channel", extShared: false, trustChecked: true }),
      authorFactsFor: async () => ({ surfaceInternal: true, refuted: false }),
    },
  );
  const res = await handler(mkReq(body), { from: () => ({ send: async () => ({}) }), to: () => ({ send: async () => ({}) }), waitUntil: () => {} } as never);
  return { res, resume: (): Promise<void> => (openGate(), deferred) };
}

{
  let seen: string | undefined = "unset";
  const r = await runForward(mentionEnvelope("Ev_grid", {}, { enterprise_id: GRID }), () => {
    seen = forwardedSlackEnterpriseId(msg(CHANNEL, TS));
  });
  eq(r.res.status, 200, "join: the mention was forwarded to the native handler (the ingress under test)");
  eq(seen, "unset", "join: 🔴 the read had NOT run when the route answered — this arm really is the deferred shape eve's `waitUntil` dispatch has, not a synchronous one");
  await r.resume();
  eq(seen, GRID, "join: 🔴 the envelope's `enterprise_id` is READABLE where eve's handler runs — the rung survives a hand-off that discards the envelope");
}

{
  let seen: string | undefined = "unset";
  await (await runForward(mentionEnvelope("Ev_plain"), () => {
    seen = forwardedSlackEnterpriseId(msg(CHANNEL, TS));
  })).resume();
  eq(seen, undefined, "join NEGATIVE CONTROL: an ordinary single-workspace mention carries no rung — so the stamp below is the envelope talking, not the route");
}

{
  let seen: string | undefined = "unset";
  await (await runForward(mentionEnvelope("Ev_mismatch", { channel: OTHER_CHANNEL }, { enterprise_id: GRID }), () => {
    seen = forwardedSlackEnterpriseId(msg(CHANNEL, TS));
  })).resume();
  eq(seen, undefined, "join: 🔴 the carrier answers for the forwarded message alone — another channel's mention reads nothing from it");
}

{
  let release = (): void => {};
  const barrier = new Promise<void>((r) => (release = r));
  let firstSeen: string | undefined = "unset";
  let secondOwn: string | undefined = "unset";

  const first = await runForward(mentionEnvelope("Ev_c1", {}, { enterprise_id: GRID }), async () => {
    await barrier;
    firstSeen = forwardedSlackEnterpriseId(msg(CHANNEL, TS));
  });
  const second = await runForward(mentionEnvelope("Ev_c2", { channel: OTHER_CHANNEL, ts: OTHER_TS }, { enterprise_id: OTHER_GRID }), async () => {
    secondOwn = forwardedSlackEnterpriseId(msg(OTHER_CHANNEL, OTHER_TS));
    release();
  });
  await Promise.all([first.resume(), second.resume()]);

  eq(secondOwn, OTHER_GRID, "join(concurrency): the second forward reads its own Grid while the first is still open");
  eq(firstSeen, GRID, "join(concurrency): 🔴 …and the first still reads ITS own — one Slack process serves both, and neither sees the other's rung");
}

function fakeCtx() {
  return {
    thread: { teamId: null, post: async () => {}, startTyping: async () => {} },
    slack: {
      channelId: undefined,
      threadTs: undefined,
      request: async () => {
        throw new Error("no live slack in a unit test");
      },
    },
  } as never;
}

const inbound = (channelId: string, ts: string) =>
  ({
    channelId,
    ts,
    threadTs: ts,
    markdown: "<@UBOT> chase order 4417",
    text: "<@UBOT> chase order 4417",
    author: { userId: USER, isBot: false },
    teamId: TEAM,
    attachments: [],
    raw: { channel_type: "channel" },
  }) as never;

const attrsOf = async (carrier: Parameters<typeof withForwardedSlackEnvelope>[0], channelId: string, ts: string) => {
  const outcome = await withForwardedSlackEnvelope(carrier, () => admitInbound(fakeCtx(), inbound(channelId, ts), false));
  ok(outcome !== null, "consequence: the mention was ADMITTED (a dropped wake would prove nothing about its auth)");
  return ((outcome as { auth: { attributes?: Record<string, unknown> } | null }).auth?.attributes ?? {}) as Record<string, unknown>;
};

{
  const attrs = await attrsOf({ enterpriseId: GRID, channelId: CHANNEL, ts: TS }, CHANNEL, TS);
  eq(
    attrs["enterprise_id"],
    GRID,
    "consequence: 🔴 the native mention's wake auth carries `enterprise_id` — this is the attribute `bindSlack` reads as the rung above the workspace, so one `slack/E…` line now vouches this room",
  );
  eq(attrs["team_id"], TEAM, "consequence: …beside the workspace it sits under, unchanged");
}

{
  const attrs = await attrsOf(undefined, CHANNEL, TS);
  ok(
    !("enterprise_id" in attrs),
    "consequence NEGATIVE CONTROL: 🔴 a non-Grid mention stamps NO enterprise_id — an ABSENT rung, so a single-workspace install's trust walk is byte-identical to what it was",
  );
}

{
  const attrs = await attrsOf({ enterpriseId: OTHER_GRID, channelId: OTHER_CHANNEL, ts: OTHER_TS }, CHANNEL, TS);
  ok(
    !("enterprise_id" in attrs),
    "consequence: 🔴 a carrier describing ANOTHER message stamps nothing — a rung can only ever widen trust, so it is never applied on a guess",
  );
}

{
  const form = (over: Record<string, string> = {}) =>
    new URLSearchParams({ team_id: TEAM, channel_id: CHANNEL, user_id: USER, command: "/oe", ...over });

  const grid = bindableForSlashCommand(form({ enterprise_id: GRID }));
  const attrs = (b: ReturnType<typeof bindableForSlashCommand>) =>
    (b.session?.auth?.current?.attributes ?? {}) as Record<string, unknown>;

  eq(attrs(grid)["enterprise_id"], GRID, "slash: the `/oe` door reads the Grid off its own `enterprise_id` form field");
  eq(bindSlack(grid).trustEnterprise, GRID, "slash: 🔴 …and it reaches `RawIdentity.trustEnterprise` — the rung the trust walk climbs, the same one every other door feeds");

  const plain = bindableForSlashCommand(form());
  ok(!("enterprise_id" in attrs(plain)), "slash NEGATIVE CONTROL: a single-workspace command stamps NO enterprise_id — an absent rung, not an empty one");
  eq(bindSlack(plain).trustEnterprise, undefined, "slash NEGATIVE CONTROL: 🔴 …so it contributes no rung, and its walk is byte-identical to what it was");
  eq(attrs(plain)["team_id"], TEAM, "slash NEGATIVE CONTROL: the workspace it always carried is untouched");
}

console.log(`✓ slack-enterprise-rung-test: ${n} assertion(s) passed`);
