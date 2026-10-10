process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import {
  registerConfig,
  registerIdentityMapper,
  defineDomain,
  getOperationalStore,
  UNADMITTED_TENANT_DROP_REASON,
  UNMAPPED_WAKE_DROP_REASON,
  resetSettingsForTest,
  _resetDeploymentIdentityForTest,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerOperationalStore, resetOperationalStore } from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { holdRouteWork, routeHoldQuiesced, withSlackRouteHold } from "../agent/channels/slack-route-hold.js";
import { routeSupervisorEvent, type SupervisorRouteDeps, type ParsedMessageEvent } from "../agent/channels/slack-events.js";
import { admitInbound } from "../agent/channels/slack.js";

_resetDeploymentIdentityForTest();
resetSettingsForTest();
for (const k of ["OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL"]) {
  delete process.env[k];
}

const HOME_TEAM = "T0EXAMPLE";
const FOREIGN_TEAM = "T_FOREIGN";
const HOME_CHANNEL = "C0EXCHAN005";
const FOREIGN_CHANNEL = "C0BFOREIGN";
const UNMAPPED_CHANNEL = "C0BUNMAPPED";

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "mapped", reach: [`slack/${HOME_TEAM}/${HOME_CHANNEL}`], memory: "brain" })],
  loadSilos: () => [{ name: "brain", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (surface === HOME_CHANNEL ? ["mapped"] : []),
});

const AUDIT_DELAY_MS = 60;
{
  const real = getOperationalStore();
  registerOperationalStore(
    Object.assign(Object.create(real) as typeof real, {
      appendAudit: async (row: Parameters<typeof real.appendAudit>[0]) => {
        await new Promise((r) => setTimeout(r, AUDIT_DELAY_MS));
        return real.appendAudit(row);
      },
    }),
  );
  resetOperationalStore();
}

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

function fakeCtx() {
  const posts: string[] = [];
  const thread = {
    teamId: null as string | null,
    post: async (text: string) => {
      posts.push(text);
    },
    startTyping: async () => {},
  };
  const slack = {
    channelId: undefined as string | undefined,
    threadTs: undefined as string | undefined,
    request: async () => {
      throw new Error("no live slack in a unit test");
    },
  };
  return { ctx: { thread, slack } as never, posts };
}

const messageIn = (channelId: string, ts: string, teamId: string | undefined, author: { userId: string; isBot: boolean } = { userId: "U_ASKER", isBot: false }, raw: Record<string, unknown> = {}) =>
  ({
    channelId,
    ts,
    threadTs: ts,
    markdown: "hey, what's the deploy story here?",
    author,
    teamId,
    raw: { channel_type: "channel", team: teamId, ...raw },
  }) as never;

async function dropRows(ts: string) {
  const store = getOperationalStore();
  for (let i = 0; i < 20; i++) {
    const rows = await store.readAudit({ org: "default", action: "surface.wake_dropped" });
    const mine = rows.filter((r) => (r.detail as { ts?: unknown } | undefined)?.ts === ts);
    if (mine.length > 0) return mine.map((r) => (r.detail ?? {}) as Record<string, unknown>);
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

async function underRouteHold<T>(fn: () => Promise<T>): Promise<{ result: T; snapshot: Promise<unknown>[]; late: number }> {
  const snapshot: Promise<unknown>[] = [];
  let flushed = false;
  let late = 0;
  let work!: Promise<T>;
  const result = await withSlackRouteHold(() => {
    work = fn();
    if (flushed) late++;
    else snapshot.push(routeHoldQuiesced(work));
    return work;
  });
  flushed = true;
  return { result, snapshot, late };
}

async function rowNow(ts: string): Promise<Record<string, unknown> | undefined> {
  const rows = await getOperationalStore().readAudit({ org: "default", action: "surface.wake_dropped" });
  return rows.map((r) => (r.detail ?? {}) as Record<string, unknown>).find((d) => d.ts === ts);
}

async function rowAfterSnapshot(snapshot: Promise<unknown>[], ts: string): Promise<Record<string, unknown> | undefined> {
  await Promise.allSettled(snapshot);
  const rows = await getOperationalStore().readAudit({ org: "default", action: "surface.wake_dropped" });
  return rows.map((r) => (r.detail ?? {}) as Record<string, unknown>).find((d) => d.ts === ts);
}

{
  const ts = "8001.100";
  const { ctx } = fakeCtx();
  const { result, snapshot, late } = await underRouteHold(() =>
    admitInbound(ctx, messageIn(HOME_CHANNEL, ts, HOME_TEAM, { userId: "U_BOT", isBot: true }, { bot_id: "B_OTHER_APP" }), false),
  );
  eq(result, null, "bot-author drop: the wake really is dropped (the premise the row's arm rests on)");
  eq(snapshot.length, 1, "🔴 bot-author drop: ONE promise is in the snapshot eve takes when the handler resolves — a bare `void` puts nothing there");
  eq(late, 0, "bot-author drop: …and nothing was registered after the flush, which the platform would never have waited on");
  eq((await rowAfterSnapshot(snapshot, ts))?.reason, "bot author is not an allowlisted driver", "bot-author drop: …and awaiting only that snapshot is enough for the row to exist");
}

{
  const ts = "8002.100";
  const { ctx } = fakeCtx();
  const { result, snapshot, late } = await underRouteHold(() => admitInbound(ctx, messageIn(FOREIGN_CHANNEL, ts, FOREIGN_TEAM), false));
  eq(result, null, "tenant drop: the wake is dropped");
  eq(snapshot.length, 1, "🔴 tenant drop: the hold is in the snapshot — this row is the ONLY durable signal a foreign workspace was refused, and nothing is posted back to say so");
  eq(late, 0, "tenant drop: …and nothing was registered too late to be waited on");
  eq((await rowAfterSnapshot(snapshot, ts))?.reason, UNADMITTED_TENANT_DROP_REASON, "tenant drop: …and it is the tenant row");
}

{
  const ts = "8003.100";
  const { ctx, posts } = fakeCtx();
  const { result, snapshot, late } = await underRouteHold(() => admitInbound(ctx, messageIn(UNMAPPED_CHANNEL, ts, undefined), false));
  eq(result, null, "unmapped drop: the wake is dropped");
  ok(posts.length === 1, "unmapped drop: …and the config nudge IS posted (this door is the one that talks back, which is why its row must not be the thing that gets lost)");
  eq(snapshot.length, 1, "🔴 unmapped drop: the audit write is in the snapshot");
  eq(late, 0, "unmapped drop: …and nothing was registered after the flush");
  eq((await rowAfterSnapshot(snapshot, ts))?.reason, UNMAPPED_WAKE_DROP_REASON, "unmapped drop: …and it is the unmapped row");
}

{
  const ts = "8004.100";
  const { ctx } = fakeCtx();
  const { result, snapshot, late } = await underRouteHold(() =>
    admitInbound(ctx, messageIn(HOME_CHANNEL, ts, HOME_TEAM), false, async () => ({ auth: null })),
  );
  eq(result, null, "no-consult drop: an admission with no spend-gate consult is downgraded to a real DROP");
  eq(snapshot.length, 1, "🔴 no-consult drop: its audit write is in the snapshot too — this is the leg that catches a future early-return above the gate, so its row is the one nobody will be looking for");
  eq(late, 0, "no-consult drop: …and nothing was registered after the flush");
  eq((await rowAfterSnapshot(snapshot, ts))?.reason, "admitted without a spend-gate consult — fail-closed", "no-consult drop: …and it is the fail-closed row");
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
  const ts = "8005.100";
  const ev: ParsedMessageEvent = {
    channelId: FOREIGN_CHANNEL,
    ts,
    teamId: FOREIGN_TEAM,
    userId: "U_ASKER",
    text: "anyone home?",
    authoredText: "anyone home?",
    isAppMention: false,
  };
  const wakes: unknown[] = [];
  const { result, snapshot, late } = await underRouteHold(() => routeSupervisorEvent(ev, supervisorDeps(wakes), { directMention: true }));
  eq(result.deliver, false, "engagement door: the foreign workspace's supervisor wake is refused");
  eq(wakes.length, 0, "…and dispatches nothing");
  eq(snapshot.length, 1, "🔴 engagement door: `auditEngagementWakeDropped` reaches the snapshot too — its routes run inside the front route's `waitUntil`, but a `void`-ed write sits OUTSIDE the promise that holds them");
  eq(late, 0, "🔴 engagement door: …and NOTHING was registered after the flush — a fix that called `waitUntil` from the route itself would land here, where eve has already stopped reading");
  eq(await rowNow(ts), undefined, "🔴 engagement door: the row has NOT landed when the route resolves — the write really is deferred, which is what the hold has to cover");
  eq((await rowAfterSnapshot(snapshot, ts))?.reason, UNADMITTED_TENANT_DROP_REASON, "🔴 engagement door: …and awaiting ONLY the platform's snapshot is enough for it to land — a fire-and-forget write is still in flight at this instant");
}

{
  const ts = "8006.100";
  const { ctx } = fakeCtx();
  const { result, snapshot, late } = await underRouteHold(() => admitInbound(ctx, messageIn(HOME_CHANNEL, ts, HOME_TEAM), false));
  ok(result !== null, "CONTROL: the declared workspace's mention is ADMITTED");
  eq(late, 0, "CONTROL: an admitted delivery registers nothing late either");
  await Promise.allSettled(snapshot);
  eq((await dropRows(ts)).length, 0, "🔴 CONTROL: …and writes NO wake_dropped row — the rows above are the DROPS' own, not one every delivery writes");
}

{
  const ts = "8007.100";
  const { ctx } = fakeCtx();
  const outcome = await admitInbound(ctx, messageIn(FOREIGN_CHANNEL, ts, FOREIGN_TEAM), false);
  eq(outcome, null, "CONTROL(no route): the drop is unchanged outside a route");
  eq((await dropRows(ts))[0]?.reason, UNADMITTED_TENANT_DROP_REASON, "🔴 CONTROL(no route): …and the row still lands — `holdRouteWork` hands the promise back when there is nothing to hold, so the call site's own await is what writes it");
}

{
  const boom = Promise.reject(new Error("audit sink is down"));
  const quiesced = await withSlackRouteHold(() => {
    void holdRouteWork(boom).catch(() => {});
    return routeHoldQuiesced(Promise.resolve());
  });
  eq(quiesced, undefined, "🔴 CONTROL(rejecting write): the quiesced promise SETTLES rather than rejecting — an audit sink that is down must not fail the delivery");
}

{
  let settled = false;
  let releaseWork = (): void => {};
  const slowWork = new Promise<void>((r) => (releaseWork = r));
  const quiesced = withSlackRouteHold(() => {
    void holdRouteWork(slowWork);
    return routeHoldQuiesced(Promise.resolve());
  });
  void quiesced.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 30));
  eq(settled, false, "🔴 quiesce: the promise handed to the platform is STILL PENDING while a tracked write is unfinished, though the work it wrapped resolved at once — this is what holds the invocation past the 200");
  releaseWork();
  await quiesced;
  eq(settled, true, "quiesce: …and it resolves once that write settles, rather than holding the invocation to its platform timeout");
}

{
  const t0 = Date.now();
  await withSlackRouteHold(() => routeHoldQuiesced(Promise.resolve()));
  ok(Date.now() - t0 < AUDIT_DELAY_MS, "quiesce CONTROL: a delivery with no tracked write settles at once — the wait above is the WRITE, not the mechanism");
}

console.log(`slack-wake-drop-hold: ${n} assertions passed`);
