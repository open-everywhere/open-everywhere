process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";
import {
  registerConfig,
  registerIdentityMapper,
  defineDomain,
  getOperationalStore,
  UNADMITTED_TENANT_DROP_REASON,
  MULTI_TENANT_ENV,
  _resetDeploymentIdentityForTest,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildFrontHandler, ThreadFifo } from "../agent/channels/slack-front.js";
import slackCommandsChannel, { bindableForSlashCommand } from "../agent/channels/slack-commands.js";
import { routeSupervisorEvent, type SupervisorRouteDeps } from "../agent/channels/slack-events.js";
import { bindSlack, forwardedSlackEnterpriseId, withForwardedSlackEnvelope } from "../agent/channels/slack-identity.js";
import { parseSlackShortcutPayload, shortcutMessageEvent } from "../agent/channels/slack-shortcut.js";
import { slackTenantAdmission } from "../agent/channels/slack-tenant-fence.js";
import { admitInbound } from "../agent/channels/slack.js";

_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST", "OE_TEST_DRIVER_IDS", MULTI_TENANT_ENV]) {
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

let declaredDomains = [defineDomain({ name: "support", reach: [`slack/${TEAM}/${CHANNEL}`], memory: "brain" })];

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => declaredDomains,
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

const FOREIGN_TEAM = "T_FOREIGN";
const FOREIGN_CHANNEL = "C_FOREIGN";

async function droppedRows(ts: string): Promise<Record<string, unknown>[]> {
  const store = getOperationalStore();
  for (let i = 0; i < 20; i++) {
    const rows = await store.readAudit({ org: "default", action: "surface.wake_dropped" });
    const mine = rows.filter((r) => (r.detail as { ts?: unknown } | undefined)?.ts === ts);
    if (mine.length > 0) return mine.map((r) => (r.detail ?? {}) as Record<string, unknown>);
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

const inboundFrom = (channelId: string, ts: string, teamId: string) =>
  ({
    channelId,
    ts,
    threadTs: ts,
    markdown: "<@UBOT> chase order 4417",
    text: "<@UBOT> chase order 4417",
    author: { userId: USER, isBot: false },
    teamId,
    attachments: [],
    raw: { channel_type: "channel" },
  }) as never;

{
  const ts = "9101.100";
  const outcome = await withForwardedSlackEnvelope({ enterpriseId: OTHER_GRID, channelId: FOREIGN_CHANNEL, ts }, () =>
    admitInbound(fakeCtx(), inboundFrom(FOREIGN_CHANNEL, ts, FOREIGN_TEAM), false),
  );
  eq(outcome, null, "refusal(mention): 🔴 a mention forwarded from a FOREIGN enterprise's workspace is DROPPED — eve dispatches no turn, so nothing binds, matches a roster or resolves a credential under an aliasing identity");

  const rows = await droppedRows(ts);
  eq(rows.length, 1, "refusal(mention): …and the operator gets exactly ONE surface.wake_dropped row (a silent drop is unreadable in a webhook process)");
  eq(rows[0]?.reason, UNADMITTED_TENANT_DROP_REASON, "refusal(mention): the row names WHY through the one greppable reason string");
  eq(rows[0]?.door, "mention", "refusal(mention): …which door refused it");
  eq(rows[0]?.team, FOREIGN_TEAM, "refusal(mention): …and WHICH workspace — the fact the decision turned on, since the fence reads the workspace and not the Grid");
}

{
  const ts = "9102.100";
  const attrs = await attrsOf({ enterpriseId: OTHER_GRID, channelId: CHANNEL, ts }, CHANNEL, ts);
  eq(
    attrs["enterprise_id"],
    OTHER_GRID,
    "refusal(mention) CONTROL: 🔴 an ADMITTED workspace carrying a FOREIGN enterprise_id is still ADMITTED, and the foreign rung is stamped verbatim — admission reads the workspace, and the rung only ever reaches a declaration the operator wrote",
  );
  eq((await droppedRows(ts)).length, 0, "refusal(mention) CONTROL: …and no wake_dropped row is written for it");
}

{
  const supervisorDeps = (wakes: unknown[]): SupervisorRouteDeps => ({
    confirmInternalWithMeta: async () => ({ internal: true, memberCount: 12 }),
    getOrCreateSession: async (_org, _sk, channelId) => ({ token: `${channelId}:oe-sup:g1`, generation: 1, freshGeneration: false, tail: [] }),
    touchSession: async () => {},
    wake: async (input) => {
      wakes.push(input);
    },
    now: () => "2026-03-12T14:44:00Z",
  });

  const shortcutPayload = (channelId: string, ts: string, over: Record<string, unknown>) => ({
    type: "message_action",
    callback_id: "escalate",
    trigger_id: `TRG_${ts}`,
    user: { id: USER },
    channel: { id: channelId },
    message: { ts, text: "the order never shipped", user: "U_AUTHOR" },
    ...over,
  });

  const spellings: { readonly name: string; readonly over: Record<string, unknown> }[] = [
    { name: "enterprise object", over: { enterprise: { id: OTHER_GRID }, team: { id: FOREIGN_TEAM } } },
    { name: "enterprise_id string", over: { enterprise_id: OTHER_GRID, team: { id: FOREIGN_TEAM } } },
    { name: "team.enterprise_id", over: { team: { id: FOREIGN_TEAM, enterprise_id: OTHER_GRID } } },
  ];

  let i = 0;
  for (const spelling of spellings) {
    const ts = `92${i++}0.100`;
    const sc = parseSlackShortcutPayload(shortcutPayload(FOREIGN_CHANNEL, ts, spelling.over));
    ok(sc !== null, `refusal(shortcut/${spelling.name}): the payload parses to a shortcut at all (a null here would make the refusal below vacuous)`);
    eq(sc!.enterpriseId, OTHER_GRID, `refusal(shortcut/${spelling.name}): 🔴 the foreign Grid is READ off this spelling — so the refusal below is a refusal of a delivery we could see the Grid on, never an accident of a lost rung`);
    eq(sc!.teamId, FOREIGN_TEAM, `refusal(shortcut/${spelling.name}): …beside the foreign workspace the fence reads`);

    const sev = shortcutMessageEvent(sc!, FOREIGN_CHANNEL, "channel", 1769564200000);
    const wakes: unknown[] = [];
    const out = await routeSupervisorEvent(sev, supervisorDeps(wakes), { directMention: true });
    eq(out.deliver, false, `refusal(shortcut/${spelling.name}): 🔴 the shortcut is REFUSED — the interactivity door is not a way around the fence the Events API doors carry`);
    eq(out.reason, UNADMITTED_TENANT_DROP_REASON, `refusal(shortcut/${spelling.name}): …for the tenant reason, not some other gate`);
    eq(wakes.length, 0, `refusal(shortcut/${spelling.name}): …and NO wake was dispatched, which is the property that matters`);

    const rows = await droppedRows(ts);
    eq(rows.length, 1, `refusal(shortcut/${spelling.name}): the operator gets one surface.wake_dropped row`);
    eq(rows[0]?.reason, UNADMITTED_TENANT_DROP_REASON, `refusal(shortcut/${spelling.name}): naming the same greppable reason`);
    eq(rows[0]?.team, FOREIGN_TEAM, `refusal(shortcut/${spelling.name}): …and the workspace it refused`);
  }

  {
    const ts = "9299.100";
    const sc = parseSlackShortcutPayload(shortcutPayload(CHANNEL, ts, { enterprise: { id: OTHER_GRID }, team: { id: TEAM } }));
    const sev = shortcutMessageEvent(sc!, CHANNEL, "channel", 1769564200000);
    const wakes: unknown[] = [];
    const out = await routeSupervisorEvent(sev, supervisorDeps(wakes), { directMention: true });
    ok(out.deliver && wakes.length === 1, "refusal(shortcut) CONTROL: the same shortcut from the ADMITTED workspace WAKES — the fence refuses a workspace, never the door");
    eq((await droppedRows(ts)).length, 0, "refusal(shortcut) CONTROL: …and writes no wake_dropped row");
  }

  {
    const previous = declaredDomains;
    declaredDomains = [
      ...previous,
      defineDomain({ name: "org", match: "org", memory: "brain", admins: [`slack/${GRID}/${USER}`, `slack/${GRID}/U_AUTHOR`] }),
    ];
    try {
      const tierOf = async (ts: string, over: Record<string, unknown>): Promise<string> => {
        const sc = parseSlackShortcutPayload(shortcutPayload(CHANNEL, ts, over));
        const wakes: unknown[] = [];
        const tailStore = getOperationalStore();
        const tailKey = `slack/${TEAM}/${CHANNEL}`;
        const tailToken = `${CHANNEL}:oe-sup:g1`;
        const before = (await tailStore.readSessionTail("default", tailKey, tailToken)).length;
        const out = await routeSupervisorEvent(shortcutMessageEvent(sc!, CHANNEL, "channel", 1769564200000), supervisorDeps(wakes), { directMention: true });
        ok(out.deliver && wakes.length === 1, `grid admin (${ts}): the shortcut wakes at all (a dropped wake would prove nothing about its tier)`);
        const rows = await tailStore.readSessionTail("default", tailKey, tailToken);
        ok(rows.length === before + 1, `grid admin (${ts}): the wake recorded exactly one tail row`);
        return String((rows[rows.length - 1] as { trust?: unknown }).trust);
      };
      eq(await tierOf("9297.100", { enterprise: { id: GRID }, team: { id: TEAM } }), "principal", "🔴 OPE-2400: a Grid admin key grades the wake `principal` when the event names that Grid");
      eq(await tierOf("9296.100", { team: { id: TEAM } }), "peer", "🔴 OPE-2400 NEGATIVE CONTROL: …and `peer` when the event names no Grid");
    } finally {
      declaredDomains = previous;
    }
  }

  {
    const ts = "9298.100";
    const sc = parseSlackShortcutPayload(shortcutPayload(FOREIGN_CHANNEL, ts, { enterprise: { id: OTHER_GRID } }));
    eq(sc!.enterpriseId, OTHER_GRID, "refusal(shortcut/org-wide): an org-wide payload names the foreign Grid…");
    eq(sc!.teamId, undefined, "refusal(shortcut/org-wide): …and names NO workspace — so the refusal below turns on the enterprise alone");
    eq(
      slackTenantAdmission(sc!.teamId, sc!.enterpriseId),
      "unadmitted",
      "refusal(shortcut/org-wide): 🔴 the tenant fence REFUSES it — a foreign enterprise with no workspace still names a tenant this deployment never declared",
    );

    const sev = shortcutMessageEvent(sc!, FOREIGN_CHANNEL, "channel", 1769564200000);
    eq(sev.teamId, undefined, "refusal(shortcut/org-wide): the mapped event carries no workspace…");
    eq(sev.enterpriseId, OTHER_GRID, "refusal(shortcut/org-wide): …and carries the Grid, which is the rung the door reads");
    const wakes: unknown[] = [];
    const out = await routeSupervisorEvent(sev, supervisorDeps(wakes), { directMention: true });
    eq(out.deliver, false, "refusal(shortcut/org-wide): 🔴 the supervisor door REFUSES the org-wide delivery — no turn runs under an identity we cannot place");
    eq(out.reason, UNADMITTED_TENANT_DROP_REASON, "refusal(shortcut/org-wide): …for the tenant reason, not some other gate");
    eq(wakes.length, 0, "refusal(shortcut/org-wide): …and NO wake was dispatched");
    eq((await droppedRows(ts))[0]?.reason, UNADMITTED_TENANT_DROP_REASON, "refusal(shortcut/org-wide): the operator gets the same greppable row");
  }

  {
    const previous = declaredDomains;
    declaredDomains = [defineDomain({ name: "org-wide", reach: [`slack/${GRID}/${CHANNEL}`], memory: "brain" })];
    const sc = parseSlackShortcutPayload(shortcutPayload(CHANNEL, "9297.100", { enterprise: { id: GRID } }));
    const sev = shortcutMessageEvent(sc!, CHANNEL, "channel", 1769564200000);
    const wakes: unknown[] = [];
    const out = await routeSupervisorEvent(sev, supervisorDeps(wakes), { directMention: true });
    ok(out.deliver && wakes.length === 1, "refusal(shortcut/org-wide) CONTROL: the same workspace-less shape from a DECLARED Grid WAKES — declaring `slack/E…/<channel>` is what admits an org-wide install");
    declaredDomains = previous;
  }
}

{
  const routeDef = (
    slackCommandsChannel as unknown as {
      routes: readonly { method: string; path: string; handler: (req: Request, args: RouteHandlerArgs) => Promise<Response> }[];
    }
  ).routes[0]!;

  const previousSecret = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = SECRET;

  const commandRequest = (body: string): Request => {
    const ts = String(Math.floor(Date.now() / 1000));
    return new Request("https://oe.test/eve/v1/slack/commands", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
      },
      body,
    });
  };
  const slashBody = (teamId: string, channelId: string, enterpriseId?: string) =>
    new URLSearchParams({ command: "/oe", text: "status", team_id: teamId, channel_id: channelId, user_id: USER, ...(enterpriseId ? { enterprise_id: enterpriseId } : {}) }).toString();

  const routeArgs = (deferred: Promise<unknown>[]): RouteHandlerArgs =>
    ({ waitUntil: (p: Promise<unknown>) => deferred.push(p) }) as unknown as RouteHandlerArgs;

  {
    const deferred: Promise<unknown>[] = [];
    const res = await routeDef.handler(commandRequest(slashBody(FOREIGN_TEAM, FOREIGN_CHANNEL, OTHER_GRID)), routeArgs(deferred));
    eq(res.status, 200, "refusal(slash): the refusal answers 200 — Slack must not retry a delivery we decided against");
    eq(await res.text(), "", "refusal(slash): 🔴 …with an EMPTY body: the operator gets the signal and the foreign workspace learns nothing, the same posture every wake door's silent drop takes");
    eq(deferred.length, 1, "refusal(slash): 🔴 the audit write was handed to `waitUntil`, not fired and forgotten — the response goes back at once, so a bare promise would race the serverless freeze and lose the only durable signal this refusal has");
    await Promise.all(deferred);

    const store = getOperationalStore();
    let refusal: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !refusal; i++) {
      const rows = await store.readAudit({ org: "default", action: "surface.wake_dropped" });
      refusal = rows.map((r) => (r.detail ?? {}) as Record<string, unknown>).find((d) => d.door === "slash-command");
      if (!refusal) await new Promise((r) => setTimeout(r, 10));
    }
    ok(refusal !== undefined, "refusal(slash): the refusal writes a surface.wake_dropped row naming the slash-command door");
    eq(refusal?.reason, UNADMITTED_TENANT_DROP_REASON, "refusal(slash): …with the same greppable reason every other door writes");
    eq(refusal?.team, FOREIGN_TEAM, "refusal(slash): …and the workspace it refused");
  }

  {
    const deferred: Promise<unknown>[] = [];
    const res = await routeDef.handler(commandRequest(slashBody(TEAM, CHANNEL, OTHER_GRID)), routeArgs(deferred));
    eq(res.status, 200, "refusal(slash) CONTROL: the admitted workspace's `/oe status` still answers 200");
    eq(deferred.length, 0, "refusal(slash) CONTROL: …deferring NOTHING — an admitted command writes no drop row, so the count above is the refusal's own");
    const body = (await res.json()) as { response_type?: string; text?: string };
    eq(body.response_type, "ephemeral", "refusal(slash) CONTROL: …with a real ephemeral answer, not the refusal's empty body");
    ok((body.text ?? "").length > 0, "refusal(slash) CONTROL: …carrying rendered command output");
  }

  if (previousSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = previousSecret;
}

console.log(`✓ slack-enterprise-rung-test: ${n} assertion(s) passed`);
