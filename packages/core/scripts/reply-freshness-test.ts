import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-reply-freshness-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId, WAKE_TARGET_TTL_MS } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { replyFreshness, staleReplyRefusalMessage, REPLY_STALE_REFUSAL_REASON, REPLY_FORCED_AUDIT_REASON, MAX_NEWER_WAKES } =
  await import("../agent/channels/reply-freshness.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);

const posted: { channel: string; text: string }[] = [];
registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
    return { ok: true, ts: `ts-${posted.length}` } as never;
  },
});
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: DOMAIN, reach: [SURFACE], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? [DOMAIN] : []),
});

const store = getOperationalStore();

const replyTool = (await import("../agent/tools/reply.js")).default;
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const arm = (ctx: unknown): Armed | null => (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "reply-freshness-test",
      turn: { id: turnId },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_wake_id: turnWake, oe_window_token: TOKEN, channel_id: CHAN, team_id: "T1" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  } as unknown as BindableContext;
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "reply-freshness-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  opts: { readonly force?: boolean; readonly done?: boolean } = {},
): Promise<{ posted?: boolean; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: opts.done ?? true, force: opts.force ?? false }, ctx)
    .then((r) => r as { posted?: boolean; note?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wakeAt(channelId: string, atIso: string, opts: { readonly inbound?: boolean } = {}): Promise<string> {
  const id = mintWakeId();
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId };
  await registerUnifiedWakeTarget(store, ORG, id, origin, atIso, TOKEN, opts.inbound ?? true);
  return id;
}

const t = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

const rowsFor = async (action: string, wakeId: string): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action }))
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d["wakeId"] === wakeId);

{
  const inTurn = newSession();
  const w = await wakeAt("C_FRESH", t(-1000));
  const before = posted.length;

  const out = await inTurn(() => callReply(w, "turn_100", w, "Nothing raced, so this lands."));
  ok(out.posted === true, "§1: with no newer message the reply POSTS — the gate bites only when a race actually happened");
  ok(posted.length === before + 1, "§1/ROOM: the answer reached the room");
  ok((await rowsFor("reply.refused", w)).length === 0, "§1/AUDIT: no refusal row — the happy path is silent, not merely permitted");

  const w2 = await wakeAt("C_FRESH2", t(-1000));
  const forcedFresh = await inTurn(() => callReply(w2, "turn_100", w2, "Forced, but nothing to override.", { force: true }));
  ok(forcedFresh.posted === true, "§1: `force: true` on a fresh conversation posts exactly like an ordinary reply");
  ok((await rowsFor("reply.forced", w2)).length === 0, "§1/AUDIT: …and writes NO `reply.forced` row — an override row means an override HAPPENED");
}

{
  const inTurn = newSession();
  const seen = await wakeAt("C_BURST", t(-5000));
  const newer = await wakeAt("C_BURST", t(-1000));
  const before = posted.length;

  const out = await inTurn(() => callReply(seen, "turn_200", seen, "The sync is at 3pm."));
  ok(typeof out.error === "string", "§2: the send is REFUSED when the conversation has moved past what the model has seen");
  ok(out.posted !== true, "§2: …and it reports no post");
  ok(posted.length === before, "§2/ROOM: NOTHING reached the room. This is the assertion OPE-767 exists for");
  ok(out.error!.includes("moved on"), "§2/COPY: refused with the staleness steer, not some incidental error");
  ok(out.error!.includes("1 newer message"), "§2/COPY: the copy reports HOW MANY newer messages there are");
  ok(out.error!.includes("no_reply"), "§2/COPY: …and steers to ending the turn, which is what lets the queued wake be answered together with this one");
  ok(out.error!.includes("force"), "§2/COPY: …and names the override valve, so a time-critical post is never trapped");
  ok(!out.error!.includes(newer), "🔴 §2/COPY: the copy NEVER names the newer wake's id — the model was not shown that wake (the OPE-182 non-disclosure rule)");

  const refused = await rowsFor("reply.refused", seen);
  ok(refused.length === 1, "§2/AUDIT: the refusal is a ROW, not an absence");
  ok(refused[0]["reason"] === REPLY_STALE_REFUSAL_REASON, "§2/AUDIT: under its own reason, so staleness is countable apart from every other refusal shape");
  ok(refused[0]["route"] === "tool", "§2/AUDIT: route stamped, matching the reply.post join shape");
  ok(!JSON.stringify(refused[0]).includes("3pm"), "§2/AUDIT: the attempted TEXT never reaches the audit detail");
}

{
  const inTurn = newSession();
  const seen = await wakeAt("C_ONCE", t(-5000));
  await wakeAt("C_ONCE", t(-1000));
  const before = posted.length;

  const first = await inTurn(() => callReply(seen, "turn_300", seen, "First try."));
  ok(typeof first.error === "string", "§3: the first send is refused");
  ok(posted.length === before, "§3/ROOM: …and posts nothing");

  const second = await inTurn(() => callReply(seen, "turn_300", seen, "Deliberate re-send."));
  ok(second.posted === true, "§3: the SAME call again in the SAME turn POSTS — refuse → redeliver → refuse can never cycle");
  ok(posted.length === before + 1, "§3/ROOM: the re-send reached the room");
  ok((await rowsFor("reply.refused", seen)).length === 1, "§3/AUDIT: exactly ONE refusal row for the wake — the gate refuses once, it does not re-refuse silently");
}

{
  const inTurn = newSession();
  const seen = await wakeAt("C_FORCE", t(-5000));
  await wakeAt("C_FORCE", t(-1000));
  const before = posted.length;

  const out = await inTurn(() => callReply(seen, "turn_400", seen, "Paging on-call NOW.", { force: true }));
  ok(out.posted === true, "§4: `force: true` posts on the FIRST call, without spending a refusal first");
  ok(posted.length === before + 1, "§4/ROOM: the forced message reached the room");
  ok(posted[posted.length - 1].text.includes("on-call"), "§4/ROOM: …and it is the model's own text, unaltered");
  ok((await rowsFor("reply.refused", seen)).length === 0, "§4/AUDIT: a force writes no refusal row — nothing was refused");

  const forced = await rowsFor("reply.forced", seen);
  ok(forced.length === 1, "§4/AUDIT: the override is a ROW an operator can count against the refusals");
  ok(forced[0]["reason"] === REPLY_FORCED_AUDIT_REASON, "§4/AUDIT: under its own reason");
  ok(!JSON.stringify(forced[0]).includes("on-call"), "§4/AUDIT: the message TEXT never reaches the audit detail");
}

{
  const inTurn = newSession();
  const seen = await wakeAt("C_MINE", t(-5000));
  await wakeAt("C_THEIRS", t(-1000));
  const before = posted.length;

  const out = await inTurn(() => callReply(seen, "turn_500", seen, "Answering my own room."));
  ok(out.posted === true, "§5: a newer message in a SIBLING conversation never delays this one — the gate keys on the conversation, not the window");
  ok(posted.length === before + 1, "§5/ROOM: the answer reached the room");

  const inTurn2 = newSession();
  const seen2 = await wakeAt("C_MINE2", t(-5000));
  await wakeAt("C_MINE2", t(-1000));
  const refusedOut = await inTurn2(() => callReply(seen2, "turn_501", seen2, "Should be refused."));
  ok(typeof refusedOut.error === "string", "§5/CONTROL: the SAME shape with the newer wake in THIS conversation IS refused — §5 is not passing vacuously");
}

{
  const inTurn = newSession();
  const older = await wakeAt("C_COAL", t(-5000));
  const newest = await wakeAt("C_COAL", t(-1000));
  const before = posted.length;

  const out = await inTurn(() => callReply(newest, "turn_600", older, "Answering the first of two."));
  ok(out.posted === true, "🔴 §6: answering the OLDER wake of a coalesced turn POSTS — the turn wake anchors what the model has seen");
  ok(posted.length === before + 1, "§6/ROOM: the answer reached the room");
  ok((await rowsFor("reply.refused", older)).length === 0, "§6/AUDIT: no refusal — a gate that refused every multi-wake turn is the false-refusal shape that killed OPE-47's version");

  const inTurn3 = newSession();
  const first = await wakeAt("C_COAL3", t(-9000));
  await wakeAt("C_COAL3", t(-6000));
  const last = await wakeAt("C_COAL3", t(-3000));
  const before3 = posted.length;

  const out3 = await inTurn3(() => callReply(last, "turn_601", first, "Answering the first of three."));
  ok(out3.posted === true, "🔴 §6/ANCHOR: a THREE-wake coalesced turn still posts — the middle sibling sits at or before `max(inputAt, turnAt)`, so it is not newer");
  ok(posted.length === before3 + 1, "§6/ANCHOR/ROOM: the answer reached the room");

  const inTurn4 = newSession();
  const a = await wakeAt("C_COAL4", t(-9000));
  await wakeAt("C_COAL4", t(-6000));
  const c = await wakeAt("C_COAL4", t(-3000));
  await wakeAt("C_COAL4", t(-1000));
  const out4 = await inTurn4(() => callReply(c, "turn_602", a, "Should be refused."));
  ok(typeof out4.error === "string", "§6/CONTROL: one arrival AFTER the whole coalesced set IS refused — the anchor bounds the count, it does not switch it off");
  ok(out4.error!.includes("1 newer message"), "§6/CONTROL: …and exactly ONE message counts as newer, not the two coalesced siblings as well");
}

{
  const inTurn = newSession();
  const seen = await wakeAt("C_DONE", t(-5000));
  const newer = await wakeAt("C_DONE", t(-1000));
  await store.markUnifiedWakeAnswered(ORG, newer, new Date().toISOString(), "turn_prev");
  const before = posted.length;

  const out = await inTurn(() => callReply(seen, "turn_700", seen, "The newer one is already answered."));
  ok(out.posted === true, "§7: an ANSWERED newer wake is not pending, so it never refuses a reply — the room already heard about it");
  ok(posted.length === before + 1, "§7/ROOM: the answer reached the room");

  const old = await wakeAt("C_TTL", t(-2 * WAKE_TARGET_TTL_MS));
  const stale = await wakeAt("C_TTL", t(-WAKE_TARGET_TTL_MS - 60_000));
  const target: UnifiedWakeOrigin = { platform: "slack", channelId: "C_TTL" };
  const past = await replyFreshness(store, ORG, { target, windowToken: TOKEN, inputWake: old, turnWake: old });
  ok(past.stale === false, "§7/TTL: a past-TTL newer wake does NOT count as staleness (the gate carries its own read-time bound)");
  const inTtl = await replyFreshness(store, ORG, { target, windowToken: TOKEN, inputWake: old, turnWake: old }, Date.parse(stale) + 60_000);
  ok(inTtl.stale === true, "§7/TTL: the SAME row DOES count when `now` sits inside the window — the bound is the clock, not the row");
}

{
  const target: UnifiedWakeOrigin = { platform: "slack", channelId: "C_OPEN" };
  const seen = await wakeAt("C_OPEN", t(-5000));
  await wakeAt("C_OPEN", t(-1000));

  const armed = await replyFreshness(store, ORG, { target, windowToken: TOKEN, inputWake: seen, turnWake: seen });
  ok(armed.stale === true, "§8/CONTROL: the real store reports this conversation as stale");

  const throwing = {
    getUnifiedWakeRecord: store.getUnifiedWakeRecord.bind(store),
    listPendingUnifiedWakes: async () => {
      throw new Error("store down");
    },
  };
  const down = await replyFreshness(throwing, ORG, { target, windowToken: TOKEN, inputWake: seen, turnWake: seen });
  ok(down.stale === false, "§8: an unreadable store turns the gate OFF — a lost answer is worse than a stale one");

  const noAnchor = await replyFreshness(store, ORG, { target, windowToken: TOKEN, inputWake: "no-such-wake", turnWake: "no-such-wake" });
  ok(noAnchor.stale === false, "§8: with NO provable stamp for any wake the model was shown, the gate is OFF — otherwise every pending row would look newer and every reply would refuse");

  const noToken = await replyFreshness(store, ORG, { target, windowToken: undefined, inputWake: seen, turnWake: seen });
  ok(noToken.stale === false, "§8: no resolvable window token ⇒ the gate is silently unavailable (honest degrade, no new refusal class)");

  const noRecord = {
    getUnifiedWakeRecord: async () => {
      throw new Error("record read down");
    },
    listPendingUnifiedWakes: store.listPendingUnifiedWakes.bind(store),
  };
  const anchorDown = await replyFreshness(noRecord, ORG, { target, windowToken: TOKEN, inputWake: seen, turnWake: seen });
  ok(anchorDown.stale === false, "§8: an unreadable ANCHOR read is the same fail-open — the gate never guesses that a reply is stale");
}

{
  const capped = staleReplyRefusalMessage({ stale: true, newer: MAX_NEWER_WAKES, capped: true });
  ok(capped.includes(`at least ${MAX_NEWER_WAKES}`), "§9: past the cap the count is honest about being a floor, not a total");
  const one = staleReplyRefusalMessage({ stale: true, newer: 1, capped: false });
  ok(one.includes("1 newer message arrived"), "§9: a single message reads as one message, not as a count with a plural bug");
  const many = staleReplyRefusalMessage({ stale: true, newer: 3, capped: false });
  ok(many.includes("3 newer messages"), "§9: several read as several");
  ok(many.includes("DISCOURAGED, not blocked"), "🔴 §9: the override valve is named as DISCOURAGED, never as a plain instruction");
  ok(many.includes("ignores the newest messages"), "🔴 §9: …and the copy says what taking it COSTS");
  ok(!many.includes("anyway"), "🔴 §9: the pre-ruling invitation wording (\"…to post it anyway\") is GONE");
  ok(many.includes("force: true"), "§9: the valve itself is still named — the gate is a speed bump, never a wall");
}

{
  const inTurn = newSession();
  const ask = await wakeAt("C_DELEG", t(-5000));
  await wakeAt("C_DELEG", t(-1000), { inbound: false });
  const before = posted.length;

  const out = await inTurn(() => callReply(ask, "turn_1000", ask, "Working on it — the worker will report.", { done: false }));
  ok(out.posted === true, "🔴 §10: a wake the DEPLOYMENT minted for itself never counts as a newer message — a delegating turn's hand-off note must still post");
  ok(posted.length === before + 1, "§10/ROOM: the hand-off note reached the room");
  ok((await rowsFor("reply.refused", ask)).length === 0, "§10/AUDIT: and no refusal was recorded");

  const inTurn2 = newSession();
  const ask2 = await wakeAt("C_DELEG2", t(-5000));
  await wakeAt("C_DELEG2", t(-1000), { inbound: true });
  const refused = await inTurn2(() => callReply(ask2, "turn_1001", ask2, "Should be refused.", { done: false }));
  ok(typeof refused.error === "string", "§10/CONTROL: the SAME shape with an INBOUND newer wake IS refused — `inbound` is the only difference and it decides");
  ok((await rowsFor("reply.refused", ask2)).length === 1, "§10/CONTROL: …and it is recorded, so the two legs differ in outcome and not merely in wording");

  const inTurn3 = newSession();
  const ask3 = await wakeAt("C_STICKY", t(-5000));
  const human = await wakeAt("C_STICKY", t(-1000), { inbound: true });
  await registerUnifiedWakeTarget(store, ORG, human, { platform: "slack", channelId: "C_STICKY" }, t(-500), TOKEN, false);
  const stillStale = await inTurn3(() => callReply(ask3, "turn_1002", ask3, "Should still be refused."));
  ok(typeof stillStale.error === "string", "🔴 §10/STICKY: an INTERNAL re-register of a human's wake does NOT clear `inbound` — the redrive cannot silence the gate");
}

console.log(`✓ reply freshness gate: ${passed} assertions passed`);
