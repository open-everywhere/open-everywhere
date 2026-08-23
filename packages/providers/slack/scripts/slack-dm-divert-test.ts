
process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerSlackProvider } from "../agent/register.js";
import { buildFrontHandler, classifyEnvelope, dmFifoKey, ThreadFifo, EventDedupe } from "../agent/channels/slack-front.js";
import { DM_BOT_AUTHOR_DROP_REASON, DM_DRIVER_ADMIT_REASON } from "../agent/channels/slack-events.js";
import { getOperationalStore, overrideSettingsForTest, type WakeMessageInput } from "@open-everywhere/core/agent/adapter-api.js";

registerSlackProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

const SECRET = "dm-divert-secret";
const NOW_MS = 1_700_000_000_000;
const DM_CHANNEL = "D_ALICE";
const TEAM = "T1";
const USER = "U_ALICE";
const SURFACE = `slack/${TEAM}/${DM_CHANNEL}`;
const MPIM_CHANNEL = "G_TRIAGE";
const SELF_BOT = "B_OE_SELF";
const OTHER_BOT = "B_OTHER_APP";
const MPIM_SURFACE = `slack/${TEAM}/${MPIM_CHANNEL}`;

const SEAT_TOKEN = `oe-dom:oe-dm/${SURFACE}:oe-sup:g3-abc123`;
const MPIM_SEAT_TOKEN = `oe-dom:oe-dm/${MPIM_SURFACE}:oe-sup:g2-def456`;

function dmEnvelope(eventId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: TEAM,
    event: { type: "message", channel_type: "im", channel: DM_CHANNEL, user: USER, ts: "1768686402.916000", text: "what's the refund status?", ...over },
  });
}

function mpimEnvelope(eventId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: TEAM,
    event: { type: "message", channel_type: "mpim", channel: MPIM_CHANNEL, user: USER, ts: "1768686403.100200", text: "can one of you chase order 4417?", ...over },
  });
}

function mentionEnvelope(eventId: string, channel: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: TEAM,
    event: { type: "app_mention", channel, user: USER, ts: "1768686404.300400", text: "<@UBOT> chase order 4417", ...over },
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

interface Dispatched {
  target: { token: string; wakeId: string; origin: Record<string, unknown>; surfaceKey: string; context?: readonly string[] };
  message: string;
  auth: { attributes?: Record<string, unknown> };
}

class SpyFifo extends ThreadFifo {
  readonly keys: string[] = [];
  readonly failures: Array<{ key: string; err: unknown }> = [];
  constructor() {
    super((key, err) => void this.failures.push({ key, err }));
  }
  override enqueue(key: string, run: () => Promise<void>): Promise<void> {
    this.keys.push(key);
    return super.enqueue(key, run);
  }
}

async function runFront(
  body: string,
  opts: {
    seat?: { token: string; generation: number; freshGeneration: boolean; tail: readonly WakeMessageInput[] };
    seatThrows?: boolean;
    partnerTrust?: "internal" | "external";
    dedupe?: EventDedupe;
    fifo?: SpyFifo;
    channelFacts?: { internal: boolean; channelType?: string } | null;
    authorRefuted?: boolean;
    sendThrowsFirst?: Error;
    selfBotId?: string | null;
  } = {},
) {
  const dispatched: Dispatched[] = [];
  const touched: Array<{ org: string; surfaceKey: string }> = [];
  const waits: Array<Promise<unknown>> = [];
  let innerCalled = false;
  const fifo = opts.fifo ?? new SpyFifo();

  let sendAttempts = 0;
  const fakeArgs = {
    from: () => ({ send: async () => ({}) }),
    to: (_channel: unknown, target: Dispatched["target"]) => ({
      send: async (message: string, sendOpts: { auth: Dispatched["auth"] }) => {
        sendAttempts += 1;
        if (sendAttempts === 1 && opts.sendThrowsFirst) throw opts.sendThrowsFirst;
        dispatched.push({ target, message, auth: sendOpts.auth });
        return {};
      },
    }),
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
  };

  const handler = buildFrontHandler(
    async () => {
      innerCalled = true;
      return new Response("inner");
    },
    {
      signingSecret: SECRET,
      now: () => NOW_MS,
      markEventSeen: async () => true,
      getBotIdentity: async () => (opts.selfBotId === null ? { userId: "UBOT" } : { userId: "UBOT", botId: opts.selfBotId ?? SELF_BOT }),
      fifo,
      ...(opts.dedupe ? { dedupe: opts.dedupe } : {}),
      dmPartnerTrustFor: async () => {
        partnerLookups++;
        return opts.partnerTrust;
      },
      channelFactsFor: async (channelId) => {
        factsLookups.push(channelId);
        if (opts.channelFacts === null) return { internal: false };
        if (opts.channelFacts) return opts.channelFacts;
        return channelId === MPIM_CHANNEL ? { internal: true, channelType: "mpim" } : { internal: true, channelType: "channel" };
      },
      authorFactsFor: async (internal: boolean) => {
        authorFactLookups++;
        const refuted = opts.authorRefuted === true;
        return { surfaceInternal: internal && !refuted, refuted };
      },
      resolveDmSeat: async (_org, dm, _at) => {
        if (opts.seatThrows) throw new Error("registry down");
        seatCalls.push(dm);
        const fallback = dm.surfaceKey === MPIM_SURFACE
          ? { token: MPIM_SEAT_TOKEN, generation: 2, freshGeneration: false, tail: [] }
          : { token: SEAT_TOKEN, generation: 3, freshGeneration: false, tail: [] };
        return (opts.seat ?? fallback) as never;
      },
      touchDmSeatFn: async (org, surfaceKey) => {
        touched.push({ org, surfaceKey });
      },
    },
  );
  const seatCalls: Array<{ surfaceKey: string; channelId?: string; legacyChannelId?: string }> = [];
  const factsLookups: string[] = [];
  let partnerLookups = 0;
  let authorFactLookups = 0;
  const res = await handler(mkReq(body), fakeArgs as unknown as Parameters<typeof handler>[1]);
  const settled = await Promise.allSettled(waits);
  return { dispatched, touched, seatCalls, innerCalled, res, fifo, settled, factsLookups, partnerLookups, authorFactLookups, sendAttempts: () => sendAttempts };
}

{
  const d = classifyEnvelope(dmEnvelope("Ev1"), "application/json");
  eq(d.kind, "dm-wake", "🔴 a `message.im` classifies `dm-wake` — the DM window seat owns it (it used to classify `forward`, to eve's native onDirectMessage)");
  eq(classifyEnvelope(JSON.stringify({ type: "event_callback", event: { type: "message", channel_type: "channel", channel: "C1", ts: "1" } }), "application/json").kind, "wake", "a channel message still takes the engagement wake path");
  const mp = classifyEnvelope(JSON.stringify({ type: "event_callback", event: { type: "message", channel_type: "mpim", channel: "G1", ts: "1" } }), "application/json");
  eq(mp.kind, "dm-wake", "🔴 an MPIM (group DM) now classifies `dm-wake` TOO (OPE-351 stage 4) — it used to fall to the engagement path, where shouldNameDropWake refused it on channel_type, so a non-mention message in a group DM woke NOTHING");
  eq(mp.kind === "dm-wake" ? mp.dmKind : undefined, "mpim", "…and the branch carries WHICH family member it is, so the handler needn't re-read channel_type");
  eq(classifyEnvelope(dmEnvelope("EvK"), "application/json").kind === "dm-wake" ? (classifyEnvelope(dmEnvelope("EvK"), "application/json") as { dmKind: string }).dmKind : undefined, "im", "…while a 1:1 still says `im` (the two families are never conflated)");
  eq(classifyEnvelope(JSON.stringify({ type: "url_verification" }), "application/json").kind, "forward", "the challenge handshake still forwards");
}

{
  const r = await runFront(dmEnvelope("Ev2"), { partnerTrust: "internal" });

  ok(!r.innerCalled, "🔴 the DM is NEVER forwarded to eve's native dispatch — one decision on one webhook, so no double turn is possible");
  eq(r.res.status, 200, "the route 200s immediately (the wake continues under waitUntil)");
  eq(r.dispatched.length, 1, "exactly one dispatch into the unified window");

  const d = r.dispatched[0]!;
  eq(d.target.token, SEAT_TOKEN, "the wake is dispatched to the SEAT's token, verbatim (no re-derivation on the way out)");
  ok(d.target.token.startsWith(`oe-dom:oe-dm/${SURFACE}:oe-sup:g`), "…and that token is the DM-window shape — a degenerate window on the `oe-dm/` pseudo-domain, not a bespoke dm-seat token");
  eq(d.target.surfaceKey, SURFACE, "🔴 the divert's surfaceKey MATCHES the surface named inside the token — byte-exact self-consistency is what admits the delivery at both gates, and what fences a DM window to its OWN DM");

  eq(
    (d.auth.attributes ?? {})["oe_addressing"],
    "direct-mention",
    "🔴 `addressing:\"direct-mention\"` is stamped through the divert — this is what arms the unified channel's addressed-prose bridge, without which a DM answer written as prose would be DROPPED",
  );
  ok(typeof d.target.wakeId === "string" && d.target.wakeId.length > 0, "a host-minted wake id rides the dispatch (the id the model echoes to `reply`)");
  eq((d.auth.attributes ?? {})["oe_wake_id"], d.target.wakeId, "…and the same id is stamped on the delivery auth");
  eq(d.target.origin.platform, "slack", "the origin names the surface the reply must go back to");
  eq(d.target.origin.channelId, DM_CHANNEL, "…and the DM channel itself");
  eq(
    d.target.origin.replyAnchorTs,
    undefined,
    "🔴 a top-level DM sets NO replyAnchorTs — the post arm reads `threadTs ?? replyAnchorTs`, so setting one would thread EVERY answer under the question and shatter a 1:1 conversation into one-reply threads (the native path replied flat; behaviour preserved)",
  );
  eq(d.target.origin.threadTs, undefined, "…and no threadTs either, so the answer posts flat in the DM");

  const a = d.auth.attributes ?? {};
  eq(a["channel_id"], DM_CHANNEL, "auth carries the DM channel id");
  eq(a["user_id"], USER, "auth carries the acting user");
  eq(a["team_id"], TEAM, "auth carries the workspace");
  eq(a["channel_type"], "im", "auth carries channel_type=im — a DM is unambiguous");
  eq(a["is_private"], "true", "auth carries is_private=true");
  eq(
    a["oe_grain"],
    "standing",
    "🔴 the rootDmGrainAttrs stamp rides through — this is what NARROWS a DM root's hands (window-tool-gating §D-DM); losing it would silently hand a DM the full kit",
  );
  eq(
    a["dm_partner_trust"],
    "internal",
    "🔴 dm_partner_trust rides through — it gates the DM's SHARED read layer, and an absent attribute silently degrades every DM to the external tier",
  );

  ok(d.message.includes('reason="dm"'), "🔴 the envelope's reason is `dm` — this path is the FIRST producer of that vocabulary value");
  ok(!d.message.includes('reason="mention"'), "…not `mention`: telling a 1:1 DM it was @mentioned is a small lie that costs orientation");
  ok(d.message.includes('trust="principal"'), "the vouched DM partner renders `principal` — a DM is addressed by the shape of the room");
  ok(
    !d.message.includes("<untrusted_external_data source=\"slack-message\">"),
    "🔴 a VOUCHED DM partner's body is NOT fenced (OPE-577 — the fence keys on the author, and a DM partner the gate confirmed is a member)",
  );
  ok(d.message.includes("what&apos;s the refund status?"), "…with the human's text XML-escaped by the renderer, as on every surface");
  ok(d.message.startsWith("<wake ") && d.message.endsWith("</wake>"), "🔴 the delivery is the envelope alone — no orientation prose to inherit a literal claim from");
  ok(d.message.includes('addressing="direct-mention"'), "…and `direct-mention` addressing is carried for its MECHANICAL effect (arming the prose bridge)");
  ok(!d.message.includes("the ONLY way your words reach anyone"), "…while the reply MANDATE lives once in the standing Reporting arm, not above every envelope");

  eq(r.seatCalls[0]?.surfaceKey, SURFACE, "the seat is resolved by SURFACE KEY (what the window token and its row are both keyed on)");
  eq(r.seatCalls[0]?.legacyChannelId, DM_CHANNEL, "…and carries the raw channel id, so the one-time adopt-from-OPE-90 probe can find the legacy row");

  eq(r.touched.length, 1, "the seat touch runs (turnCount/lastWakeAt feed the rotation thresholds)");
  eq(r.touched[0]?.surfaceKey, SURFACE, "…keyed on the surface, i.e. the WINDOW row — the same row the mint wrote");

  eq(r.fifo.keys, [dmFifoKey(DM_CHANNEL)], "the DM serializes on its OWN generation-independent FIFO key");
}

{
  const r = await runFront(dmEnvelope("Ev4b", { thread_ts: "1768685833.000100" }), { partnerTrust: "internal" });
  eq(r.dispatched[0]!.target.origin.threadTs, "1768685833.000100", "a THREADED DM message carries its threadTs, so the reply lands in that thread rather than flat");
  eq(r.dispatched[0]!.target.origin.replyAnchorTs, undefined, "…and still mints no reply anchor (threadTs is the target the post arm reads first)");
}

{
  const r = await runFront(dmEnvelope("Ev5"), { partnerTrust: "internal" });
  const msg = r.dispatched[0]!.message;
  ok(!msg.includes("<previous-body>"), "no edit block on a plain DM");
  eq(
    (msg.match(/<message /g) ?? []).length,
    1,
    "🔴 exactly ONE message in the envelope — a DM wake carries NO backscroll (the seat's own session IS the history, which is why slack.ts skipped loadConversationContext for DMs)",
  );
  eq(r.dispatched[0]!.target.context, undefined, "…and no `context` on a resumed generation");
}

{
  const vouched = await runFront(dmEnvelope("Ev5b1"), { partnerTrust: "internal" });
  ok(vouched.dispatched[0]!.message.includes('trust="principal"'), "an INTERNAL DM partner renders the `principal` trust tier — addressed and vouched");
  ok(
    !vouched.dispatched[0]!.message.includes("<untrusted_external_data"),
    "…and OPE-577 renders that vouched partner's body UNFENCED — the DM is a colleague talking to you",
  );

  const unverifiable = await runFront(dmEnvelope("Ev5b2"));
  ok(
    unverifiable.dispatched[0]!.message.includes('trust="unauth"'),
    "🔴 an UNVERIFIABLE partner (the lookup failed / no token) falls to `unauth`, not `peer` — the DM path inherits the same fail-closed trust floor every other surface has",
  );
  ok(
    unverifiable.dispatched[0]!.message.includes("<untrusted_external_data"),
    "🔴 …so the SAME DM shape from an unverifiable partner KEEPS the fence — the two arms differ only in whether the lookup could vouch for the partner",
  );
  ok(
    unverifiable.dispatched[0]!.message.includes("<system-note>"),
    "…and the trusted reference-only system note is appended, so the model is TOLD the author is unvouched",
  );
  eq((unverifiable.dispatched[0]!.auth.attributes ?? {})["dm_partner_trust"], undefined, "…while the auth omits dm_partner_trust entirely, so the binding fails closed to the external memory tier");
}

{
  const CARRIED = "alice was mid-refund on order 4417";
  const tail = [{ from: "human" as const, author: "U_ALICE", authorId: "U_ALICE", id: "m-prev", sentAt: "2026-02-09T21:34:00Z", trust: "principal" as const, body: CARRIED }];
  const fresh = await runFront(dmEnvelope("Ev6a"), {
    seat: { token: SEAT_TOKEN, generation: 4, freshGeneration: true, tail },
  });
  ok(fresh.dispatched[0]!.message.includes(CARRIED), "a FRESH DM generation carries the recorded tail in its wake envelope");
  ok(fresh.dispatched[0]!.target.context === undefined, "…and NOT as a side-channel `context` string: the tail is rendered as messages, like everything else in a wake");

  const resumed = await runFront(dmEnvelope("Ev6b"), {
    seat: { token: SEAT_TOKEN, generation: 4, freshGeneration: false, tail },
  });
  ok(!resumed.dispatched[0]!.message.includes(CARRIED), "…a RESUMED generation carries none of it (the tail is a fresh-generation affordance only)");

  const coldFresh = await runFront(dmEnvelope("Ev6c"), {
    seat: { token: SEAT_TOKEN, generation: 4, freshGeneration: true, tail: [] },
  });
  ok(!coldFresh.dispatched[0]!.message.includes(CARRIED), "…and a FRESH generation with an EMPTY tail carries none either — the negative control for the fresh arm");
}

{
  const store = getOperationalStore();
  const dropRows = async (ts: string) => {
    const rows = await store.readAudit({ org: "default", action: "surface.wake_dropped" });
    return rows.filter((r) => (r.detail as { ts?: unknown } | undefined)?.ts === ts);
  };

  const FOREIGN_TS = "1768686402.900001";
  const r = await runFront(dmEnvelope("Ev7", { bot_id: OTHER_BOT, ts: FOREIGN_TS }));
  eq(r.dispatched.length, 0, "a bot-authored DM wakes nothing");
  ok(!r.innerCalled, "🔴 …and is NOT forwarded: handing eve's native door a turn the DM window owns would open a second, un-rotatable session");
  eq(r.res.status, 200, "it is a plain no-op 200");

  const rows = await dropRows(FOREIGN_TS);
  eq(rows.length, 1, "🔴 …and the drop writes exactly ONE surface.wake_dropped row — the silent-drop defect (OPE-1022) was that this was ZERO");
  {
    const d = (rows[0]!.detail ?? {}) as Record<string, unknown>;
    eq(d.reason, DM_BOT_AUTHOR_DROP_REASON, "the row names WHY the wake was dropped");
    ok(
      d.reason !== "bot author is not an allowlisted driver",
      "🔴 …and it is NOT the engagement door's reason: the DM door admits no bot author at all, so blaming the allowlist would send the reader to fix a list that was never consulted",
    );
    eq(d.door, "dm", "the row names the ingress door");
    eq(d.dmKind, "im", "…and which DM family member it was");
    eq(d.botId, OTHER_BOT, "the row carries the offending bot record");
    eq(d.channel, DM_CHANNEL, "…and the channel — enough to identify the surface from the audit alone");
    eq(d.team, TEAM, "…and the workspace");
    eq(d.vouchedDriver, false, "…and whether the driver allowlist vouches for this bot (false here — an unknown app)");
  }
  eq(rows[0]!.surface, DM_CHANNEL, "the row is keyed to the DM's OWN surface, so a per-surface audit query finds it");
  eq(rows[0]!.workspace, TEAM, "…under the real workspace, not the `dev` stand-in a partition falls back to when the team never resolved");

  const SELF_TS = "1768686402.900002";
  const echo = await runFront(dmEnvelope("Ev7self", { bot_id: SELF_BOT, ts: SELF_TS }));
  eq(echo.dispatched.length, 0, "OE's own reply echo still wakes nothing");
  eq((await dropRows(SELF_TS)).length, 0, "🔴 …and writes NO row — a row must mean 'somebody else's bot spoke here', or the trail is drowned by our own replies");

  const HUMAN_TS = "1768686402.900003";
  const human = await runFront(dmEnvelope("Ev7human", { ts: HUMAN_TS }));
  eq(human.dispatched.length, 1, "a human-authored DM still wakes the seat (no new gate on the ordinary path)");
  eq((await dropRows(HUMAN_TS)).length, 0, "…and writes NO surface.wake_dropped row — a row must mean a drop");

  const UNRESOLVED_TS = "1768686402.900004";
  await runFront(dmEnvelope("Ev7noid", { bot_id: SELF_BOT, ts: UNRESOLVED_TS }), { selfBotId: null });
  eq((await dropRows(UNRESOLVED_TS)).length, 1, "an unresolvable bot identity fails NOISY — the drop is still counted");

  const MPIM_TS = "1768686403.900005";
  await runFront(mpimEnvelope("Ev7mpim", { bot_id: OTHER_BOT, ts: MPIM_TS }));
  const mpimRows = await dropRows(MPIM_TS);
  eq(mpimRows.length, 1, "a bot-authored GROUP DM is counted at the same door");
  eq(((mpimRows[0]!.detail ?? {}) as Record<string, unknown>).dmKind, "mpim", "…and the row names it as the mpim family member");
}

{
  const store = getOperationalStore();
  const rowsFor = async (action: string, ts: string) => {
    const rows = await store.readAudit({ org: "default", action });
    return rows.filter((r) => (r.detail as { ts?: unknown } | undefined)?.ts === ts);
  };
  const admitRows = (ts: string) => rowsFor("surface.wake_admitted", ts);
  const dropRows = (ts: string) => rowsFor("surface.wake_dropped", ts);

  const DRIVER_BOT = "B0DRIVER99";
  const DRIVER_PAIR = `${TEAM}:${DRIVER_BOT}`;
  const SELF_PAIRABLE = "B0SELF77";

  const arm = (pair: string): void => void overrideSettingsForTest({ wake: { slackDmDriver: pair } });

  arm(DRIVER_PAIR);
  const DRIVER_TS = "1768686402.910001";
  const admitted = await runFront(dmEnvelope("Ev7bDriver", { bot_id: DRIVER_BOT, ts: DRIVER_TS }), { partnerTrust: "internal" });
  eq(admitted.dispatched.length, 1, "🔴 the NAMED driver's bot-authored DM WAKES the seat — this is the whole point: a real Slack delivery drives the DM legs, not a forged envelope");
  ok(!admitted.innerCalled, "…and it is still NOT forwarded to eve's native door — the DM window owns the turn, admitted or not");
  eq(admitted.dispatched[0]!.target.surfaceKey, SURFACE, "…into the DM's OWN window seat, the same one a human DM resolves");

  ok(
    admitted.dispatched[0]!.message.includes('trust="principal"'),
    "🔴 …and the admitted driver's author renders `principal`, IDENTICALLY to the human leg — the driver posts through a human `xoxp` token, so the tier is resolved from that real member id. Not `relay`: the machine floor Slack's bot_id stamp would otherwise impose is what the carve-out removes",
  );
  ok(!admitted.dispatched[0]!.message.includes('trust="relay"'), "…and NOT the `relay` floor — the negative control for the line above");

  const aRows = await admitRows(DRIVER_TS);
  eq(aRows.length, 1, "🔴 an admitted driver DM writes exactly ONE `surface.wake_admitted` row — a door that widened silently would be worse than the silent drop OPE-1022 fixed");
  {
    const d = (aRows[0]!.detail ?? {}) as Record<string, unknown>;
    eq(d.reason, DM_DRIVER_ADMIT_REASON, "the row names the carve-out that let it through");
    eq(d.door, "dm", "…the ingress door");
    eq(d.dmKind, "im", "…which DM family member it was");
    eq(d.botId, DRIVER_BOT, "…the bot record admitted");
    eq(d.team, TEAM, "…and the workspace it was admitted in");
  }
  eq(aRows[0]!.surface, DM_CHANNEL, "the row is keyed to the DM's own surface, so a per-surface audit query finds it");
  eq((await dropRows(DRIVER_TS)).length, 0, "🔴 …and NO `surface.wake_dropped` row — an admitted wake is not also a dropped one, or the trail says both");

  const OTHER_TS = "1768686402.910002";
  const other = await runFront(dmEnvelope("Ev7bOther", { bot_id: OTHER_BOT, ts: OTHER_TS }), { partnerTrust: "internal" });
  eq(other.dispatched.length, 0, "🔴 a DIFFERENT bot in the SAME workspace still wakes nothing — the setting names ONE identity, not 'bots we have heard of'");
  eq((await admitRows(OTHER_TS)).length, 0, "…and writes no admitted row");
  eq((await dropRows(OTHER_TS)).length, 1, "…and still writes its `surface.wake_dropped` row, exactly as before the carve-out existed");

  const FOREIGN_TEAM_TS = "1768686402.910003";
  const foreignTeamEnvelope = JSON.stringify({
    type: "event_callback",
    event_id: "Ev7bForeignTeam",
    team_id: "T9OTHERWS",
    event: { type: "message", channel_type: "im", channel: DM_CHANNEL, user: USER, ts: FOREIGN_TEAM_TS, text: "hello from another workspace", bot_id: DRIVER_BOT },
  });
  const foreignTeam = await runFront(foreignTeamEnvelope, { partnerTrust: "internal" });
  eq(foreignTeam.dispatched.length, 0, "🔴 the SAME bot record posting from a DIFFERENT workspace wakes nothing — the pair pins the identity to one team, so a leaked driver token is only ever a problem in the workspace it was named for");
  eq((await admitRows(FOREIGN_TEAM_TS)).length, 0, "…and writes no admitted row");

  arm(`${TEAM}:${SELF_PAIRABLE}`);
  const SELF_LOOP_TS = "1768686402.910004";
  const selfLoop = await runFront(dmEnvelope("Ev7bSelfLoop", { bot_id: SELF_PAIRABLE, ts: SELF_LOOP_TS }), {
    partnerTrust: "internal",
    selfBotId: SELF_PAIRABLE,
  });
  eq(selfLoop.dispatched.length, 0, "🔴 OE's OWN bot record is NEVER admitted, even named in the setting — its reply echo would otherwise re-wake the seat on every turn, forever");
  eq((await admitRows(SELF_LOOP_TS)).length, 0, "…and writes no admitted row");

  arm(DRIVER_PAIR);
  const HUMAN_ARMED_TS = "1768686402.910005";
  const human = await runFront(dmEnvelope("Ev7bHuman", { ts: HUMAN_ARMED_TS }), { partnerTrust: "internal" });
  eq(human.dispatched.length, 1, "a human-authored DM still wakes with the setting ARMED (no new gate on the ordinary path)");
  eq((await admitRows(HUMAN_ARMED_TS)).length, 0, "🔴 …and writes NO admitted row — the row must mean 'the driver spoke here', or it cannot tell a soak reviewer anything");

  const MPIM_DRIVER_TS = "1768686403.910006";
  const mpimAdmitted = await runFront(mpimEnvelope("Ev7bMpim", { bot_id: DRIVER_BOT, ts: MPIM_DRIVER_TS }));
  eq(mpimAdmitted.dispatched.length, 1, "the named driver's GROUP DM is admitted at the same door");
  eq(((await admitRows(MPIM_DRIVER_TS))[0]?.detail as Record<string, unknown> | undefined)?.dmKind, "mpim", "…and the row names it as the mpim family member");

  arm("");
  const DISARMED_TS = "1768686402.910007";
  const disarmed = await runFront(dmEnvelope("Ev7bDisarmed", { bot_id: DRIVER_BOT, ts: DISARMED_TS }), { partnerTrust: "internal" });
  eq(disarmed.dispatched.length, 0, "🔴 with the setting back at its shipped `\"\"` the SAME driver DM drops again — empty is not 'admit nobody in particular', it is 'admit nobody'");
  eq((await admitRows(DISARMED_TS)).length, 0, "…and writes no admitted row");
  eq((await dropRows(DISARMED_TS)).length, 1, "…and writes the ordinary drop row, so an unconfigured deployment's audit trail is unchanged");
}

{
  const dedupe = new EventDedupe();
  const first = await runFront(dmEnvelope("EvDUP"), { dedupe });
  const second = await runFront(dmEnvelope("EvDUP"), { dedupe });
  eq(first.dispatched.length, 1, "the first delivery wakes the seat");
  eq(second.dispatched.length, 0, "a Slack RETRY (same event_id) does NOT double-wake the DM");
}

{
  const r = await runFront(dmEnvelope("Ev9"), { seatThrows: true });
  eq(r.dispatched.length, 0, "a seat-resolution failure dispatches nothing");
  ok(!r.innerCalled, "🔴 …and does NOT fall back to eve's native send. The OPE-90 wrapper failed OPEN because a native DM was a real, if un-rotated, seat; it no longer is — a native fallback would answer the human from a session with no window row, so this now fails LOUDLY into the FIFO's audited catch instead.");
  eq(r.fifo.failures.length, 1, "…the failure PROPAGATES to the FIFO's loud handler — which the live front route wires to recordWakeFailure (log-ship record + `surface.wake_failed` audit row), so it is a DURABLE signal rather than silence");
  eq(r.fifo.failures[0]?.key, dmFifoKey(DM_CHANNEL), "…reported under the DM's own FIFO key, so the failing conversation is identifiable");
  eq(r.res.status, 200, "…and the webhook still 200s (Slack's retry is the recovery path, not a 5xx storm)");
}

{
  process.env["OE_DM_SEAT_ROTATION"] = "0";
  try {
    const r = await runFront(dmEnvelope("Ev10"));
    ok(!r.innerCalled, "a STALE OE_DM_SEAT_ROTATION=0 no longer forwards a DM to eve's native dispatch — the flag is gone, the divert is unconditional");
    eq(r.dispatched.length, 1, "…the DM still diverts into its own window seat");
  } finally {
    delete process.env["OE_DM_SEAT_ROTATION"];
  }
}

{
  const r = await runFront(mpimEnvelope("Ev11"));

  ok(!r.innerCalled, "a group DM is never forwarded — the mpim window seat owns it");
  eq(r.dispatched.length, 1, "exactly one dispatch into the group DM's own window");
  const d = r.dispatched[0]!;

  eq(d.target.token, MPIM_SEAT_TOKEN, "the wake goes to the mpim's OWN seat token");
  eq(d.target.surfaceKey, MPIM_SURFACE, "🔴 the divert's surfaceKey is the GROUP DM's — matching the surface named inside the token, which is what admits it at both gates and fences it out of every other DM");
  eq(r.fifo.keys, [dmFifoKey(MPIM_CHANNEL)], "the group DM serializes on its own FIFO key");
  eq(r.touched[0]?.surfaceKey, MPIM_SURFACE, "the wake touch lands on the mpim's window row");

  eq(r.seatCalls[0]?.surfaceKey, MPIM_SURFACE, "the seat is resolved by the mpim's surface key");
  eq(r.seatCalls[0]?.channelId, MPIM_CHANNEL, "…carrying the raw channel id, which is what the ROTATION distiller fetches history with");
  eq(
    r.seatCalls[0]?.legacyChannelId,
    undefined,
    "🔴 …and NO legacyChannelId: OPE-90 never minted an `oe-dm-seat::` row for a group DM, so a probe here could only ever miss — and a miss indistinguishable from a store outage would poison the OPE-346 note-loss audit row, which exists to tell those two apart",
  );

  const a = d.auth.attributes ?? {};
  eq(a["channel_type"], "mpim", "🔴 auth carries channel_type=mpim, so `bindSlack` binds mode `mpim` — that is what keeps every mode-keyed carve-out (the lean-seat identity trio, the memory route, the skills refusal) seeing the same mode it saw on the native token");
  eq(a["is_private"], "true", "a group DM has no public form");
  eq(a["oe_grain"], "standing", "the rootDmGrainAttrs stamp rides through — window-tool-gating §D-DM already covered mpim, so the group seat's hands narrow exactly like a 1:1's");
  eq(
    a["dm_partner_trust"],
    undefined,
    "🔴 NO dm_partner_trust on a group DM — it is a singular fact about 'the other person in this DM', a question an mpim has no answer to, and `bindSlack` ignores the attribute for mode `mpim` anyway. Stamping one would be inventing a fact.",
  );
  eq(r.partnerLookups, 0, "…and the users.info lookup is not even attempted (there is no single partner to look up)");
  eq(a["oe_addressing"], "direct-mention", "addressing is still `direct-mention` — the MECHANICAL half (the addressed-prose bridge, the wake-id reply mandate) is identical to a 1:1's");

  ok(d.message.includes('reason="dm"'), "a group DM is a direct-message-EQUIVALENT surface, so it keeps `reason=\"dm\"` rather than minting a new vocabulary value");
  ok(d.message.startsWith("<wake ") && d.message.endsWith("</wake>"), "the delivery is the envelope alone");
  ok(!d.message.includes("everything said here is addressed to you"), "🔴 the 1:1's false-in-a-group claim is nowhere in a group-DM render — the render makes no addressing claim in prose at all");
  ok(d.message.includes('type="mpim"'), "🔴 the room shape reaches the model on the channel type — a group DM is `mpim`, a 1:1 is `im`");
  ok(d.message.includes('trust="principal"'), "the author renders vouched off the SURFACE's confirmed-internal verdict (tag-keyed to `principal` because a DM is addressed), which is what stands in for the partner check a group DM cannot make");
  ok(!d.message.includes("<untrusted_external_data source=\"slack-message\">"), "…and that `peer` verdict carries the body OUTSIDE the fence, like every other surface's member-authored message (OPE-577)");

  eq(d.target.origin.replyAnchorTs, undefined, "🔴 no replyAnchorTs — one seat, one room, one reply placement; splitting it on whether the human typed `<@bot>` would put two geometries in one conversation");
  eq(d.target.origin.threadTs, undefined, "…so a top-level group-DM answer posts flat");
}

{
  const r = await runFront(mpimEnvelope("Ev11b"), { channelFacts: null });
  ok(
    r.dispatched[0]!.message.includes('trust="unauth"'),
    "🔴 an unconfirmable mpim (a workspace without `mpim:read`) renders `unauth`, not `peer` — fail-closed DOWN, and the wake still FIRES rather than being dropped, so the room degrades instead of going deaf",
  );
}

{
  const r = await runFront(mentionEnvelope("Ev12", MPIM_CHANNEL));
  ok(!r.innerCalled, "🔴 the group DM's app_mention is NOT forwarded to eve's native mention path");
  eq(r.dispatched.length, 1, "…it is diverted");
  eq(r.dispatched[0]!.target.token, MPIM_SEAT_TOKEN, "…into the SAME mpim seat the plain-message leg uses — one room, one session");
  eq(r.dispatched[0]!.target.surfaceKey, MPIM_SURFACE, "…on the group DM's own surface");
  eq((r.dispatched[0]!.auth.attributes ?? {})["channel_type"], "mpim", "🔴 the divert is TOLD it is an mpim — an app_mention envelope carries no channel_type, so re-reading the field would have bound mode `channel` and quietly lost every mpim carve-out");
  eq(r.factsLookups[0], MPIM_CHANNEL, "…the channel-type read that made the decision happened, on this channel");
  eq(r.fifo.keys, [dmFifoKey(MPIM_CHANNEL)], "🔴 the mention leg enqueues on the SAME FIFO key as the message leg — a group DM's two entrances can never run concurrently on one seat");
  ok(r.dispatched[0]!.message.includes('type="mpim"') && r.dispatched[0]!.message.includes('reason="dm"'), "…and it renders the same mpim room shape as every other wake in that room");
}

{
  const r = await runFront(mentionEnvelope("Ev12b", "C_PUBLIC"));
  ok(r.innerCalled, "a channel app_mention still forwards to the native mention path — the divert is scoped to mpim, not to 'anything the lookup answers'");
  eq(r.dispatched.length, 0, "…and nothing is diverted");
}

{
  const r = await runFront(mentionEnvelope("Ev12c", MPIM_CHANNEL), { channelFacts: null });
  ok(
    r.innerCalled,
    "🔴 an app_mention whose channel type cannot be resolved forwards to the native path — precisely pre-stage-4 behaviour. A workspace that never granted `mpim:read` degrades (its group-DM mentions run on an un-wakeable native session) rather than going silent.",
  );
  eq(r.dispatched.length, 0, "…nothing is diverted on the unresolved read");
}

{
  process.env["OE_DM_SEAT_ROTATION"] = "0";
  try {
    const r = await runFront(mentionEnvelope("Ev12d", MPIM_CHANNEL));
    ok(!r.innerCalled, "a STALE OE_DM_SEAT_ROTATION=0 no longer forwards a group DM's mention natively — the mention leg's hatch went with the message leg's");
    eq(r.dispatched.length, 1, "…the mention still diverts into the mpim window seat");
    eq(r.factsLookups[0], MPIM_CHANNEL, "…and the `conversations.info` read still runs on this channel, because that read (not a flag) is what proves the mention is an mpim");
  } finally {
    delete process.env["OE_DM_SEAT_ROTATION"];
  }
}

{
  const grouped = await runFront(mpimEnvelope("Ev13a", { text: "<@UBOT> chase order 4417" }));
  eq(
    grouped.dispatched.length,
    0,
    "🔴 a `message.mpim` whose text @mentions the bot is DROPPED — its app_mention sibling owns it (leg 12), and without this drop the room would answer twice",
  );
  ok(!grouped.innerCalled, "…dropped, not forwarded (forwarding would hand eve's native door the very turn the window seat owns)");

  const oneToOne = await runFront(dmEnvelope("Ev13b", { text: "<@UBOT> are you there?" }), { partnerTrust: "internal" });
  eq(
    oneToOne.dispatched.length,
    1,
    "🔴 …and a 1:1 with the SAME text still wakes. The mention branch does not divert an `im`, so nothing else owns a DM's mention-bearing message; suppressing it would turn '@bot are you there?' in a DM into total silence — and whether Slack even fires app_mention inside an `im` is unmeasured here, which is not a bet to take when the failure mode is a deaf DM.",
  );
}

{
  const shipped = await runFront(dmEnvelope("Ev14a"), { partnerTrust: "external" });
  eq(shipped.dispatched.length, 1, "🔴 OPE-525 NEGATIVE CONTROL: on the shipped `taint` grain a REFUTED DM partner still wakes — the feature is opt-in");
  eq(shipped.seatCalls.length, 1, "…and their DM seat is resolved exactly as before");

  try {
    overrideSettingsForTest({ externalPolicy: { authorGrain: "withhold" } });
    const withheld = await runFront(dmEnvelope("Ev14b"), { partnerTrust: "external" });
    eq(withheld.dispatched.length, 0, "🔴 OPE-525: on `withhold` a REFUTED DM partner wakes NOTHING — behaviour 1 owes a private notice and no turn");
    eq(withheld.seatCalls.length, 0, "🔴 OPE-525: …and NO seat is resolved — the gate sits above the seat, so a suppressed DM rotates no generation and consumes no handoff note");
    ok(!withheld.innerCalled, "OPE-525: …and it is dropped, never forwarded to eve's native dispatch");

    const member = await runFront(dmEnvelope("Ev14c"), { partnerTrust: "internal" });
    eq(member.dispatched.length, 1, "OPE-525 negative control: a VOUCHED partner still wakes on `withhold` (=== 1 dispatch)");
    eq(member.seatCalls.length, 1, "…with their seat resolved as usual");

    const unresolved = await runFront(dmEnvelope("Ev14d"));
    eq(unresolved.dispatched.length, 1, "🔴 OPE-525: an UNRESOLVABLE partner probe still wakes (=== 1 dispatch) — absence of evidence is never evidence");
  } finally {
    overrideSettingsForTest({ externalPolicy: { authorGrain: "taint" } });
  }
}

{
  const shipped = await runFront(mentionEnvelope("Ev15a", "C_PUBLIC"), { authorRefuted: true });
  ok(shipped.innerCalled, "🔴 OPE-525 NEGATIVE CONTROL: on the shipped `taint`/`engage` pair a REFUTED author's @mention still forwards to eve's native path");
  eq(shipped.authorFactLookups, 0, "🔴 OPE-525: …and NO `users.info` probe is made — the inert check runs first, so an un-opted-in deployment pays nothing for this gate");

  try {
    overrideSettingsForTest({ externalPolicy: { authorGrain: "withhold" } });
    const withheld = await runFront(mentionEnvelope("Ev15b", "C_PUBLIC"), { authorRefuted: true });
    ok(!withheld.innerCalled, "🔴 OPE-525: on `withhold` a REFUTED author's @mention is NOT forwarded — the last ungated Slack wake path is closed");
    eq(withheld.res.status, 200, "OPE-525: …and Slack still gets its 200, so the event is never redelivered");
    ok(withheld.authorFactLookups > 0, "OPE-525: …the probe DID run, because the policy could suppress");

    const member = await runFront(mentionEnvelope("Ev15c", "C_PUBLIC"), { authorRefuted: false });
    ok(member.innerCalled, "OPE-525 negative control: an UNREFUTED author's @mention still forwards on `withhold` (=== forwarded)");

    const grouped = await runFront(mentionEnvelope("Ev15d", MPIM_CHANNEL), { authorRefuted: true });
    ok(!grouped.innerCalled, "OPE-525 negative control: a group-DM mention is still owned by the mpim divert, not by the forward gate");
  } finally {
    overrideSettingsForTest({ externalPolicy: { authorGrain: "taint" } });
  }
}

{
  const pruned = new Error(
    'Failed to fetch run key for wrun_01AAAAAAAAAAAAAAAAAAAAAAAA (deployment dpl_AAAAAAAAAAAAAAAAAAAAAAAAAAAA): HTTP 404 Not Found — {"error":{"code":"not_found","message":"Deployment not found."}}',
  );
  const r = await runFront(dmEnvelope("Ev16"), { sendThrowsFirst: pruned });
  eq(r.sendAttempts(), 2, "🔴 a pruned-deployment strand is RE-DELIVERED: the DM route sends a SECOND time");
  eq(r.dispatched.length, 1, "…and the member gets exactly ONE wake, not two — only the failed attempt is repeated");
  eq(r.seatCalls.length, 2, "🔴 …the seat is RE-RESOLVED on the retry, which is what lets the marked row rotate into a fresh run");
  eq(r.fifo.failures.length, 0, "…so nothing reaches the FIFO's loud handler: the DM is answered, not audited as a failure");
}
{
  const r = await runFront(dmEnvelope("Ev16b"), { sendThrowsFirst: new Error("socket hang up") });
  eq(r.sendAttempts(), 1, "🔴 negative control: a TRANSIENT send failure is NOT retried");
  eq(r.dispatched.length, 0, "negative control: …nothing is delivered");
  eq(r.seatCalls.length, 1, "negative control: …and the seat is resolved exactly once");
  eq(r.fifo.failures.length, 1, "negative control: …the failure still propagates to the FIFO's loud handler");
}

console.log(`✓ slack-dm-divert: ${n} assertions passed (classification, window token + fence, addressing, DM auth attrs, dm envelope, carried tail, bot/dedupe/fail-closed, no escape hatch (OPE-368), group-DM divert + mention leg + sibling suppression, OPE-1023 named-driver DM carve-out, OPE-525 external-participant policy, OPE-963 pruned-deployment re-delivery)`);
