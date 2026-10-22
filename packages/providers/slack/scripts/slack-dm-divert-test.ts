process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerSlackProvider } from "../agent/register.js";
import { buildFrontHandler, classifyEnvelope, dmFifoKey, ThreadFifo, EventDedupe, recordWakeFailure, type FrontOptions } from "../agent/channels/slack-front.js";
import { withSlackVoiceClips } from "../agent/channels/slack-voice-clips.js";
import {
  DM_BOT_AUTHOR_DROP_REASON,
  DM_DRIVER_ADMIT_REASON,
  isUnchangedSlackEdit,
  parseMessageEvent,
  slackWakeAuthorFacts,
  type SlackMemberProbe,
  slackForm,
} from "../agent/channels/slack-events.js";
import { partnerFactsFromInfo } from "../agent/channels/slack-identity.js";
import {
  getOperationalStore,
  overrideSettingsForTest,
  markUndeliveredAfterHeal,
  isUndeliveredAfterHeal,
  registerSurfaces,
  defineSurface,
  type WakeMessageInput,
  hearVoiceClips,
  MAX_VOICE_CLIP_BYTES,
  markThreadEngaged,
  markThreadStopped,
  resolvePartition,
  shouldDeliverReply,
} from "@open-everywhere/core/agent/adapter-api.js";

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

function mpimEnvelope(eventId: string, over: Record<string, unknown> = {}, envelopeOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: TEAM,
    ...envelopeOver,
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
    channelFacts?: { internal: boolean; channelType?: string; extShared?: boolean; trustChecked?: boolean } | null;
    authorRefuted?: boolean;
    authorUserInfo?: Record<string, unknown>;
    sendThrowsFirst?: Error;
    sendThrowsAlways?: Error;
    selfBotId?: string | null;
    extra?: Partial<FrontOptions>;
    request?: Request;
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
        if (opts.sendThrowsAlways) throw opts.sendThrowsAlways;
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
        return channelId === MPIM_CHANNEL
          ? { internal: true, channelType: "mpim", extShared: false, trustChecked: true }
          : { internal: true, channelType: "channel", extShared: false, trustChecked: true };
      },
      authorFactsFor: async (internal: boolean, userId?: string, teamId?: string) => {
        authorFactLookups++;
        const probe: SlackMemberProbe = async (_u, probeTeamId) =>
          opts.authorUserInfo !== undefined
            ? partnerFactsFromInfo({ user: opts.authorUserInfo }, probeTeamId).dmPartnerTrust === "internal"
            : opts.authorRefuted === undefined
              ? undefined
              : !opts.authorRefuted;
        return slackWakeAuthorFacts(internal, userId, teamId, probe);
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
      ...opts.extra,
    },
  );
  const seatCalls: Array<{ surfaceKey: string; channelId?: string; legacyChannelId?: string }> = [];
  const factsLookups: string[] = [];
  let partnerLookups = 0;
  let authorFactLookups = 0;
  const res = await handler(opts.request ?? mkReq(body), fakeArgs as unknown as Parameters<typeof handler>[1]);
  const settled = await Promise.allSettled(waits);
  return { dispatched, touched, seatCalls, innerCalled, res, fifo, settled, factsLookups, partnerLookups, authorFactLookups, sendAttempts: () => sendAttempts };
}

overrideSettingsForTest({ externalPolicy: { authorGrain: "taint", roomGrain: "engage" } });

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
    !d.message.includes("<untrusted_external_data"),
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

  const DRIVER_BOT_2 = "B0DRIVER88";
  const DRIVER_PAIR_2 = `${TEAM}:${DRIVER_BOT_2}`;

  const arm = (pairs: readonly string[] | string): void =>
    void overrideSettingsForTest({
      wake: { e2eDrivers: (typeof pairs === "string" ? [pairs] : pairs).filter((p) => p !== "").map((principal) => ({ surface: "slack" as const, principal })) },
    });

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
  eq(other.dispatched.length, 0, "🔴 a DIFFERENT bot in the SAME workspace still wakes nothing — the setting names identities, not 'bots we have heard of'");
  eq((await admitRows(OTHER_TS)).length, 0, "…and writes no admitted row");
  eq((await dropRows(OTHER_TS)).length, 1, "…and still writes its `surface.wake_dropped` row, exactly as before the carve-out existed");

  arm([DRIVER_PAIR, DRIVER_PAIR_2]);

  const LISTED_1_TS = "1768686402.910010";
  const listed1 = await runFront(dmEnvelope("Ev7bListed1", { bot_id: DRIVER_BOT, ts: LISTED_1_TS }), { partnerTrust: "internal" });
  eq(listed1.dispatched.length, 1, "🔴 the FIRST listed driver identity is admitted from a LIST — the one-pair spelling's behaviour survives the widening to a list");
  eq((await admitRows(LISTED_1_TS)).length, 1, "…and writes its `surface.wake_admitted` row");

  const LISTED_2_TS = "1768686402.910020";
  const listed2 = await runFront(dmEnvelope("Ev7bListed2", { bot_id: DRIVER_BOT_2, ts: LISTED_2_TS }), { partnerTrust: "internal" });
  eq(listed2.dispatched.length, 1, "🔴 the SECOND listed driver identity is ALSO admitted — this is the live-run drop, and it is the whole point of the list");
  eq(listed2.dispatched[0]!.target.surfaceKey, SURFACE, "…into the DM's OWN window seat, the same one the first driver resolves");
  {
    const rows = await admitRows(LISTED_2_TS);
    eq(rows.length, 1, "…and writes exactly ONE `surface.wake_admitted` row");
    eq((rows[0]!.detail as Record<string, unknown>).botId, DRIVER_BOT_2, "…naming the SECOND bot record, so a soak review can tell the two drivers apart");
  }

  const UNLISTED_TS = "1768686402.910030";
  const unlisted = await runFront(dmEnvelope("Ev7bUnlisted", { bot_id: OTHER_BOT, ts: UNLISTED_TS }), { partnerTrust: "internal" });
  eq(unlisted.dispatched.length, 0, "🔴 an UNLISTED bot is still refused with TWO identities listed — a longer list must not become 'any bot in this workspace'");
  eq((await admitRows(UNLISTED_TS)).length, 0, "…and writes no admitted row");
  eq((await dropRows(UNLISTED_TS)).length, 1, "…and still writes its ordinary `surface.wake_dropped` row");

  arm(DRIVER_PAIR);
  const COMPAT_TS = "1768686402.910040";
  const compat = await runFront(dmEnvelope("Ev7bCompat", { bot_id: DRIVER_BOT, ts: COMPAT_TS }), { partnerTrust: "internal" });
  eq(compat.dispatched.length, 1, "a ONE-ENTRY roll admits the single identity it names");
  const COMPAT_OTHER_TS = "1768686402.910050";
  const compatOther = await runFront(dmEnvelope("Ev7bCompatOther", { bot_id: DRIVER_BOT_2, ts: COMPAT_OTHER_TS }), { partnerTrust: "internal" });
  eq(compatOther.dispatched.length, 0, "🔴 …and admits NOTHING ELSE — the negative control that keeps the line above from passing on an open door");

  overrideSettingsForTest({ wake: { e2eDrivers: [{ surface: "discord", principal: DRIVER_PAIR }] } });
  const FOREIGN_SURFACE_TS = "1768686402.910070";
  const foreignSurface = await runFront(dmEnvelope("Ev7bForeignSurface", { bot_id: DRIVER_BOT, ts: FOREIGN_SURFACE_TS }), { partnerTrust: "internal" });
  eq(foreignSurface.dispatched.length, 0, "🔴 the same principal declared on ANOTHER surface wakes nothing at the Slack DM door — the entry's `surface` is matched, not decoration");
  eq((await admitRows(FOREIGN_SURFACE_TS)).length, 0, "…and writes no admitted row");
  eq((await dropRows(FOREIGN_SURFACE_TS)).length, 1, "…and writes the ordinary drop row, exactly as an unconfigured deployment does");

  arm([]);
  const EMPTY_LIST_TS = "1768686402.910060";
  const emptyList = await runFront(dmEnvelope("Ev7bEmptyList", { bot_id: DRIVER_BOT, ts: EMPTY_LIST_TS }), { partnerTrust: "internal" });
  eq(emptyList.dispatched.length, 0, "🔴 an EMPTY LIST admits nobody — it is the shipped posture, not 'admit nobody in particular'");
  eq((await admitRows(EMPTY_LIST_TS)).length, 0, "…and writes no admitted row");
  eq((await dropRows(EMPTY_LIST_TS)).length, 1, "…and STILL writes its ordinary `surface.wake_dropped` row — the posture claim is 'byte-identical, audit row included', so the row is part of what empty means");

  arm(DRIVER_PAIR);

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

  arm([]);
  const DISARMED_TS = "1768686402.910007";
  const disarmed = await runFront(dmEnvelope("Ev7bDisarmed", { bot_id: DRIVER_BOT, ts: DISARMED_TS }), { partnerTrust: "internal" });
  eq(disarmed.dispatched.length, 0, "🔴 with the setting back at its shipped `[]` the SAME driver DM drops again — empty is not 'admit nobody in particular', it is 'admit nobody'");
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
  ok(!d.message.includes("<untrusted_external_data"), "…and that member-grade verdict carries the body OUTSIDE the fence, like every other surface's member-authored message (OPE-577)");

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
  const guest = await runFront(mpimEnvelope("Ev11c-guest"), { authorRefuted: true });
  const guestAttrs = guest.dispatched[0]!.auth.attributes ?? {};
  eq(guest.dispatched.length, 1, "a refuted author's group DM still WAKES — the mark is carriage, never a suppression");
  eq(
    guestAttrs["oe_chat_nonmember"],
    "true",
    "🔴 OPE-1486: a GUEST who WRITES in a group DM stamps `oe_chat_nonmember` — the same per-user membership probe a channel's author leg uses, so the member plane refuses a personal credential on this turn",
  );
  ok(guest.authorFactLookups > 0, "…and the probe actually ran on the mpim leg (a stamp with no lookup would be a fabricated verdict)");

  const member = await runFront(mpimEnvelope("Ev11c-member"), { authorRefuted: false });
  eq(
    (member.dispatched[0]!.auth.attributes ?? {})["oe_chat_nonmember"],
    undefined,
    "🔴 NEGATIVE CONTROL: a MEMBER's message in the SAME group DM leaves `oe_chat_nonmember` ABSENT — the mark is the author's, not the room's, so it cannot be an always-on bit",
  );

  const unresolvable = await runFront(mpimEnvelope("Ev11c-unknown"));
  eq(
    (unresolvable.dispatched[0]!.auth.attributes ?? {})["oe_chat_nonmember"],
    undefined,
    "🔴 NEGATIVE CONTROL: an UNRESOLVABLE probe leaves the attribute absent — the leg fails OPEN like the channel's, because failing closed here would mark every group-DM wake in a workspace without `users:read`",
  );

  ok(
    guest.dispatched[0]!.message.includes('trust="principal"'),
    "🔴 …the WAKE TIER is UNCHANGED by the refutation — the room's confirmed-internal verdict still decides it, so an invited guest in an addressed room is still answered",
  );
  ok(
    guest.dispatched[0]!.message.includes('<untrusted_external_data'),
    "🔴 OPE-1486: …while a REFUTED author's body is rendered INSIDE the untrusted fence even at that member-grade tier — the one-way fence backstop (`WakeMessageInput.refuted`). Without it a guest's text would reach the model unfenced in a group DM, which is the one room where the tier and the refutation come apart.",
  );
  ok(
    !member.dispatched[0]!.message.includes('<untrusted_external_data'),
    "🔴 NEGATIVE CONTROL: a MEMBER's body in the same room is NOT fenced — the backstop keys on the refutation, so it cannot be an always-on fence",
  );
  ok(
    !unresolvable.dispatched[0]!.message.includes('<untrusted_external_data'),
    "🔴 NEGATIVE CONTROL: an UNRESOLVABLE probe does not fence either — the backstop fails OPEN with the rest of the leg",
  );
}

{
  const GRID_MEMBER = { team_id: "T_SIBLING", enterprise_user: { enterprise_id: "E_GRID" } };
  const attrsOf = (r: Awaited<ReturnType<typeof runFront>>) => r.dispatched[0]!.auth.attributes ?? {};

  registerSurfaces([]);
  const undeclared = await runFront(mpimEnvelope("Ev11grid-undeclared"), { authorUserInfo: GRID_MEMBER });
  eq(
    attrsOf(undeclared)["oe_chat_nonmember"],
    "true",
    "🔴 NEGATIVE CONTROL: with the Grid UNDECLARED, a sibling workspace's member writing in the group DM is marked a guest — absence infers non-member, which is the ruling's other half",
  );

  registerSurfaces([defineSurface({ key: "slack/E_GRID", trust: "internal" })]);
  const declared = await runFront(mpimEnvelope("Ev11grid-declared"), { authorUserInfo: GRID_MEMBER });
  eq(
    attrsOf(declared)["oe_chat_nonmember"],
    undefined,
    "🔴 OPE-1508: ONE `slack/E_GRID` declaration vouches the sibling workspace, so a Grid colleague writing in the group DM leaves `oe_chat_nonmember` ABSENT — the Grid home-team defect is closed",
  );
  ok(
    !declared.dispatched[0]!.message.includes("<untrusted_external_data"),
    "…and their words are no longer fenced as a stranger's — the refutation drove the render too",
  );
  ok(
    undeclared.dispatched[0]!.message.includes("<untrusted_external_data"),
    "NEGATIVE CONTROL: the undeclared sibling's words ARE fenced — one refutation still feeds the stamp and the render together",
  );

  const gridGuest = await runFront(mpimEnvelope("Ev11grid-guest"), {
    authorUserInfo: { ...GRID_MEMBER, is_restricted: true },
  });
  eq(
    attrsOf(gridGuest)["oe_chat_nonmember"],
    "true",
    "🔴 a multi-channel GUEST in the vouched sibling workspace is still marked — the enterprise line vouches workspaces, not the people inside them",
  );

  registerSurfaces([]);
  const ownApp = await runFront(mpimEnvelope("Ev11grid-ownbot"), { authorUserInfo: { team_id: TEAM, is_bot: true } });
  eq(
    attrsOf(ownApp)["oe_chat_nonmember"],
    undefined,
    "🔴 OPE-1508: the WORKSPACE'S OWN APP writing in a group DM is a MEMBER — `is_bot` no longer refutes on its own, which is what marked the admitted e2e driver a guest",
  );
  const foreignApp = await runFront(mpimEnvelope("Ev11grid-foreignbot"), {
    authorUserInfo: { team_id: "T_ELSEWHERE", is_bot: true },
  });
  eq(
    attrsOf(foreignApp)["oe_chat_nonmember"],
    "true",
    "🔴 NEGATIVE CONTROL: a FOREIGN app in the same room is still a guest — the bot rule is the rung walk, not a blanket admission",
  );
  registerSurfaces([]);
}

{
  const grid = await runFront(mpimEnvelope("Ev11stamp-grid", {}, { enterprise_id: "E_GRID" }));
  eq(
    (grid.dispatched[0]!.auth.attributes ?? {})["enterprise_id"],
    "E_GRID",
    "🔴 OPE-1508: a group-DM wake in an Enterprise Grid stamps `enterprise_id` from the event envelope — the binding's route to the rung above the workspace",
  );
  const plain = await runFront(mpimEnvelope("Ev11stamp-plain"));
  eq(
    (plain.dispatched[0]!.auth.attributes ?? {})["enterprise_id"],
    undefined,
    "🔴 NEGATIVE CONTROL: an ordinary single-workspace group DM stamps NO enterprise_id — an absent rung, so its trust walk is byte-identical to what it was",
  );
}

{
  const ordinary = await runFront(mpimEnvelope("Ev11d-int"));
  const oa = ordinary.dispatched[0]!.auth.attributes ?? {};
  eq(oa["is_ext_shared"], "false", "🔴 OPE-1486: an ordinary group DM stamps the platform's own sharing verdict onto its auth — the attribute `bindSlack` reads through `slackTrust`");
  eq(oa["trust_checked"], "true", "…with the checked stamp beside it, exactly as a channel wake stamps the pair");

  const connect = await runFront(mpimEnvelope("Ev11d-ext"), { channelFacts: { internal: false, channelType: "mpim", extShared: true, trustChecked: true } });
  eq(
    (connect.dispatched[0]!.auth.attributes ?? {})["is_ext_shared"],
    "true",
    "🔴 OPE-1486: a SLACK CONNECT group DM stamps `is_ext_shared=true`, which is what demotes `binding.trust` to `external` and takes the room out of the member plane under a workspace-wide `internal` declaration",
  );

  const degraded = await runFront(mpimEnvelope("Ev11d-noscope"), { channelFacts: null });
  const da = degraded.dispatched[0]!.auth.attributes ?? {};
  eq(da["is_ext_shared"], undefined, "🔴 NEGATIVE CONTROL: a workspace without `mpim:read` stamps NO sharing attribute — the probe answered nothing, and absence never demotes");
  eq(da["trust_checked"], undefined, "…and no checked stamp either, so `slackTrust` reads the same unchecked mpim it read before");
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
  const optOut = await runFront(dmEnvelope("Ev14a"), { partnerTrust: "external" });
  eq(optOut.dispatched.length, 1, "🔴 OPE-525 NEGATIVE CONTROL: on the `taint` opt-out grain a REFUTED DM partner still wakes");
  eq(optOut.seatCalls.length, 1, "…and their DM seat is resolved exactly as before");

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
  const optOut = await runFront(mentionEnvelope("Ev15a", "C_PUBLIC"), { authorRefuted: true });
  ok(optOut.innerCalled, "🔴 OPE-525 NEGATIVE CONTROL: on the `taint`/`engage` opt-out pair a REFUTED author's @mention still forwards to eve's native path");
  eq(optOut.authorFactLookups, 0, "🔴 OPE-525: …and NO `users.info` probe is made — the inert check runs first, so an opted-out deployment pays nothing for this gate");

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
    eq(grouped.dispatched.length, 0, "🔴 OPE-1486: on `withhold` a REFUTED author's GROUP-DM mention is suppressed by the mpim divert's own author gate — the group DM was the last room this grain could not reach");
    const groupedMember = await runFront(mentionEnvelope("Ev15e", MPIM_CHANNEL), { authorRefuted: false });
    eq(groupedMember.dispatched.length, 1, "🔴 NEGATIVE CONTROL: an UNREFUTED author's group-DM mention still diverts on `withhold` — the gate reads the author, not the room shape");
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

{
  const pruned = new Error(
    'Failed to fetch run key for wrun_01BBBBBBBBBBBBBBBBBBBBBBBB (deployment dpl_BBBBBBBBBBBBBBBBBBBBBBBBBBBB): HTTP 404 Not Found — {"error":{"code":"not_found","message":"Deployment not found."}}',
  );
  const r = await runFront(dmEnvelope("Ev17"), { sendThrowsAlways: pruned });
  eq(r.sendAttempts(), 2, "🔴 the retry still fires exactly once (unchanged from the single-failure class)");
  eq(r.dispatched.length, 0, "…and the member gets NO answer — both attempts died");
  eq(r.seatCalls.length, 2, "…the seat was still re-resolved for the retry");
  eq(r.fifo.failures.length, 1, "…the SECOND failure propagates to the FIFO's loud handler exactly as any other failure does");
  ok(
    isUndeliveredAfterHeal(r.fifo.failures[0]?.err),
    "🔴 …and the error the FIFO receives is TAGGED — the surface's own recorder can tell this class apart from an ordinary send failure",
  );

  const store = getOperationalStore();
  const untaggedKey = `Cope970untagged:oe-dm`;
  recordWakeFailure(untaggedKey, new Error("socket hang up"));
  await new Promise((res) => setTimeout(res, 0));
  const untaggedRows = (await store.readAudit({ org: "default", action: "surface.wake_failed" })).filter(
    (row) => (row.detail as Record<string, unknown> | undefined)?.fifoKey === untaggedKey,
  );
  eq(untaggedRows.length, 1, "recordWakeFailure still writes exactly one row for an ordinary failure");
  eq((untaggedRows[0]!.detail as Record<string, unknown>).reason, undefined, "…and an ORDINARY failure carries NO `reason` field — negative control");

  const taggedKey = `Cope970tagged:oe-dm`;
  const taggedErr = new Error("Failed to fetch run key for wrun_x (deployment dpl_x): HTTP 404 Not Found");
  markUndeliveredAfterHeal(taggedErr);
  recordWakeFailure(taggedKey, taggedErr);
  await new Promise((res) => setTimeout(res, 0));
  const taggedRows = (await store.readAudit({ org: "default", action: "surface.wake_failed" })).filter(
    (row) => (row.detail as Record<string, unknown> | undefined)?.fifoKey === taggedKey,
  );
  eq(taggedRows.length, 1, "recordWakeFailure writes exactly one row for the OPE-970 class too");
  eq(
    (taggedRows[0]!.detail as Record<string, unknown>).reason,
    "pruned-deployment-heal-retry-failed",
    "🔴 …and THIS row carries its OWN reason — an operator (or a future member-facing read) can tell 'the seat is fine now but this message was lost' from an ordinary blip without reading raw message text",
  );
}

{
  const CLIP_URL = "https://files.slack.com/files-pri/T1-F_CLIP/audio_message.webm";
  const clipFile = { id: "F_CLIP", name: "audio_message.webm", mimetype: "audio/webm", url_private: CLIP_URL };
  const pulled: Array<{ url: string; max: number }> = [];
  const mediaTypes: string[] = [];
  let hearCalls = 0;
  const hear = (ev: Parameters<typeof withSlackVoiceClips>[0]) => {
    hearCalls++;
    return withSlackVoiceClips(ev, {
      pull: async (_ctx, ref, max) => (pulled.push({ url: ref.urlPrivate, max }), new Uint8Array([1, 2, 3])),
      hear: (input) =>
        hearVoiceClips({
          ...input,
          transcriber: async (c) => (mediaTypes.push(c.mediaType), { text: "chase order 4417 please", model: "lab/stt" }),
          enabled: true,
          overBudget: async () => false,
          record: async () => {},
          audit: async () => {},
        }),
    });
  };

  const r = await runFront(dmEnvelope("EvVoice1", { ts: "1768686433.000100", text: "", subtype: "file_share", files: [clipFile] }), { partnerTrust: "internal", extra: { hearVoiceClips: hear } });
  eq(r.dispatched.length, 1, "🔴 a DM that is only a voice clip WAKES the DM seat");
  ok(r.dispatched[0]!.message.includes("[voice clip] chase order 4417 please"), "🔴 …and the wake carries the clip's transcript as the person's message");
  ok(!r.dispatched[0]!.message.includes("file_share"), "…as a plain message");
  eq(pulled, [{ url: CLIP_URL, max: MAX_VOICE_CLIP_BYTES }], "the clip is fetched from the EVENT's own url_private, under the size cap");
  eq(mediaTypes, ["audio/webm"], "…and sent to speech-to-text with the event's media type");

  const both = await runFront(dmEnvelope("EvVoice2", { ts: "1768686433.000200", text: "context below", subtype: "file_share", files: [clipFile] }), { partnerTrust: "internal", extra: { hearVoiceClips: hear } });
  const msg = both.dispatched[0]!.message;
  ok(msg.includes("context below") && msg.indexOf("context below") < msg.indexOf("[voice clip] chase order 4417 please"), "typed text first, then the transcript");

  {
    const sessionCalls: URLSearchParams[] = [];
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    const hadToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-dm-divert-title-test";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      seen.push(href);
      if (href.endsWith("/agents.sessions.setStatus") || href.endsWith("/assistant.threads.setStatus")) sessionCalls.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await runFront(dmEnvelope("EvVoiceTitle1", { ts: "1768686434.000100", text: "", subtype: "file_share", files: [clipFile] }), { partnerTrust: "internal", extra: { hearVoiceClips: hear } });
      await runFront(dmEnvelope("EvVoiceTitle2", { ts: "1768686434.000200", text: "Plan the launch review", subtype: "file_share", files: [clipFile] }), { partnerTrust: "internal", extra: { hearVoiceClips: hear } });
      await slackForm("auth.test", "");
      ok(seen.some((h) => h.endsWith("/auth.test")), `the stub sees a call sent through slackForm (saw ${seen.length})`);
      eq(sessionCalls.length, 0, "🔴 a top-level DM message sends no session or status call — OE opens no agent session and sets no title (OPE-2668)");
    } finally {
      globalThis.fetch = realFetch;
      if (hadToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = hadToken;
    }
  }

  const failing = (ev: Parameters<typeof withSlackVoiceClips>[0]) =>
    withSlackVoiceClips(ev, {
      pull: async () => new Uint8Array([1]),
      hear: (input) => hearVoiceClips({ ...input, transcriber: async () => { throw new Error("both routes down"); }, enabled: true, overBudget: async () => false, audit: async () => {} }),
    });
  const failed = await runFront(dmEnvelope("EvVoice3", { ts: "1768686433.000300", text: "", subtype: "file_share", files: [clipFile] }), { partnerTrust: "internal", extra: { hearVoiceClips: failing } });
  eq(failed.dispatched.length, 1, "a clip that cannot be transcribed still wakes the seat");
  ok(failed.dispatched[0]!.message.includes("[voice clip — could not be transcribed]"), "…with one line saying the clip was not heard");

  hearCalls = 0;
  const channelClip = JSON.stringify({
    type: "event_callback",
    event_id: "EvVoice4",
    team_id: TEAM,
    event: { type: "message", channel_type: "channel", channel: "C_ROOM", user: USER, ts: "1768686433.000400", text: "", subtype: "file_share", files: [clipFile] },
  });
  await runFront(channelClip, { partnerTrust: "internal", extra: { hearVoiceClips: hear, ambientEnabledFor: () => true, seatedSurfaceFor: () => true } });
  eq(hearCalls, 0, "🔴 an unaddressed channel clip is NEVER heard — a room's audio reaches speech-to-text only when someone pointed it at the agent");

  hearCalls = 0;
  await runFront(mentionEnvelope("EvVoice5", "C_ROOM", { ts: "1768686433.000500", files: [clipFile] }), {
    partnerTrust: "internal",
    extra: { hearVoiceClips: hear, ambientEnabledFor: () => false, seatedSurfaceFor: () => true, mentionPolicyFor: async () => ({ suppressNative: true, addressing: "direct-mention" as const }) },
  });
  eq(hearCalls, 1, "an @mention diverted to the seat hears its clip");

  hearCalls = 0;
  const mpimMention = await runFront(mentionEnvelope("EvVoice6", MPIM_CHANNEL, { ts: "1768686433.000600", files: [clipFile] }), { partnerTrust: "internal", extra: { hearVoiceClips: hear } });
  eq(hearCalls, 1, "a group-DM @mention hears its clip");
  ok(mpimMention.dispatched.some((d) => d.message.includes("[voice clip] chase order 4417 please")), "🔴 …and the group-DM seat's wake carries the transcript");
  hearCalls = 0;
  await runFront(mentionEnvelope("EvVoice7", MPIM_CHANNEL, { ts: "1768686433.000700", bot_id: OTHER_BOT, files: [clipFile] }), { partnerTrust: "internal", extra: { hearVoiceClips: hear } });
  eq(hearCalls, 0, "🔴 a BOT's group-DM @mention is never heard — no download, no speech-to-text call, no spend");

  const ROOM = "C_VOICE_ROOM";
  const roomP = resolvePartition({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: TEAM, channel_id: ROOM, channel_type: "channel" }, principalId: USER, principalType: "slack-user" } } },
  } as never);
  const threadClip = (eventId: string, threadTs: string, ts: string) =>
    JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      team_id: TEAM,
      event: { type: "message", channel_type: "channel", channel: ROOM, user: USER, ts, thread_ts: threadTs, text: "", subtype: "file_share", files: [clipFile] },
    });
  const HELD = "1768686533.000100";
  const STOPPED = "1768686533.000200";
  const WATCHED = "1768686533.000300";
  await markThreadEngaged(roomP, HELD, new Date(NOW_MS).toISOString(), { participating: true });
  await markThreadEngaged(roomP, STOPPED, new Date(NOW_MS).toISOString(), { participating: true });
  await markThreadStopped(roomP, STOPPED);
  await markThreadEngaged(roomP, WATCHED, new Date(NOW_MS).toISOString());
  for (const seated of [true, false]) {
    const road = seated ? "seat road" : "unseated engaged-thread road";
    const extra = { hearVoiceClips: hear, ambientEnabledFor: () => false, seatedSurfaceFor: () => seated };
    hearCalls = 0;
    await runFront(threadClip(`EvVoiceHeld${road}`, HELD, seated ? "1768686534.000100" : "1768686535.000100"), { partnerTrust: "internal", extra });
    eq(hearCalls, 1, `${road}: a clip in a thread the agent HOLDS is heard`);
    hearCalls = 0;
    await runFront(
      JSON.stringify({ type: "event_callback", event_id: `EvVoiceTyped${road}`, team_id: TEAM, event: { type: "message", channel_type: "channel", channel: ROOM, user: USER, ts: seated ? "1768686534.000400" : "1768686535.000400", thread_ts: HELD, text: "typed only" } }),
      { partnerTrust: "internal", extra },
    );
    eq(hearCalls, 0, `${road}: a message with NO clip never enters the voice step (no extra store read on the hot path)`);
    hearCalls = 0;
    await runFront(threadClip(`EvVoiceStopped${road}`, STOPPED, seated ? "1768686534.000200" : "1768686535.000200"), { partnerTrust: "internal", extra });
    eq(hearCalls, 0, `🔴 ${road}: a clip in a STOOD-DOWN thread is never heard — the road drops it, so it must not be downloaded or billed`);
    hearCalls = 0;
    await runFront(threadClip(`EvVoiceWatched${road}`, WATCHED, seated ? "1768686534.000300" : "1768686535.000300"), { partnerTrust: "internal", extra });
    eq(hearCalls, 1, `${road}: a clip in a name-drop WATCHER thread is heard, as the same words typed there would reach the agent`);
    if (seated) {
      hearCalls = 0;
      await runFront(threadClip(`EvVoiceShared${road}`, HELD, "1768686534.000500"), { partnerTrust: "internal", channelFacts: { internal: false, channelType: "channel", extShared: true, trustChecked: true }, extra });
      eq(hearCalls, 0, `🔴 ${road}: a clip in a held thread of a room that is NOT confirmed internal is never heard — the seat drops that wake, so the audio must not leave`);
      hearCalls = 0;
      await runFront(threadClip(`EvVoiceInfoDown${road}`, HELD, "1768686534.000600"), {
        partnerTrust: "internal",
        extra: { ...extra, channelFactsFor: async () => { throw new Error("conversations.info down"); } },
      });
      eq(hearCalls, 0, `${road}: an unreadable room (conversations.info throws) is not confirmed internal, so its clip is not heard (fail-closed)`);
    }
  }
  const heardThread = await withSlackVoiceClips(
    { channelId: ROOM, ts: "9.1", threadTs: HELD, teamId: TEAM, userId: USER, subtype: "file_share", text: "", authoredText: "", isAppMention: false, attachments: [{ kind: "file", id: "F_CLIP", mimeType: "audio/webm", url: CLIP_URL }] },
    { hear: async () => [{ heard: true, text: "status?" }] },
  );
  ok(shouldDeliverReply({ subtype: heardThread.subtype, authorIsBot: false, isAppMention: false, inThread: true, isEngaged: true, stopped: false } as never).deliver, "🔴 the heard `file_share` passes `shouldDeliverReply`, which drops any subtype");
  ok(!shouldDeliverReply({ subtype: "file_share", authorIsBot: false, isAppMention: false, inThread: true, isEngaged: true, stopped: false } as never).deliver, "…while the raw upload does not (the negative control)");

  const base = { channelId: "D1", ts: "1.1", text: "", authoredText: "", isAppMention: false, attachments: [{ kind: "file" as const, id: "F", mimeType: "audio/webm", url: CLIP_URL }] };
  const okHear = async () => [{ heard: true as const, text: "hello" }];
  const plain = await withSlackVoiceClips({ ...base, subtype: "file_share" }, { hear: okHear });
  eq([plain.subtype, plain.text, plain.authoredText], [undefined, "[voice clip] hello", "[voice clip] hello"], "🔴 a heard `file_share` is a plain message, so the thread gates (which drop every subtype) admit it");
  let editHears = 0;
  const edit = { ...base, subtype: "message_changed" };
  ok((await withSlackVoiceClips(edit, { hear: async () => (editHears++, [{ heard: true as const, text: "again" }]) })) === edit && editHears === 0, "🔴 an EDIT of a clip message is not heard again — no second download or bill for the same audio");
  const untouched = { ...base, subtype: "file_share" };
  ok((await withSlackVoiceClips(untouched, { hear: async () => { throw new Error("boom"); } })) === untouched, "a failing step gives the message back unchanged");
  const noClip = { ...base, attachments: [{ kind: "image" as const, id: "I", mimeType: "image/png" }] };
  ok((await withSlackVoiceClips(noClip, { hear: async () => { throw new Error("must not run"); } })) === noClip, "a message with no clip is not touched");
}

{
  const ORIGINAL_TS = "1775897187.348000";
  const editEnvelope = (eventId: string, noticeTs: string, after: Record<string, unknown>, before: Record<string, unknown> | undefined, over: Record<string, unknown> = {}): string =>
    dmEnvelope(eventId, {
      subtype: "message_changed",
      hidden: true,
      ts: noticeTs,
      text: undefined,
      user: undefined,
      message: { type: "message", user: USER, ts: ORIGINAL_TS, text: "what's the refund status?", ...after },
      ...(before === undefined ? {} : { previous_message: { type: "message", user: USER, ts: ORIGINAL_TS, text: "what's the refund status?", ...before } }),
      ...over,
    });

  const same = { text: "hi", files: [{ id: "F1", name: "a.m4a" }] };
  ok(isUnchangedSlackEdit({ ...same, assistant_app_thread: { title: "hi" } }, same), "🔴 an edit that adds only metadata (Slack's session title) changes nothing");
  ok(!isUnchangedSlackEdit({ ...same, text: "hi there" }, same), "…a change in the typed words is a real edit");
  ok(!isUnchangedSlackEdit({ ...same, files: [{ id: "F2", name: "b.m4a" }] }, same), "…a different file is a real edit");
  ok(!isUnchangedSlackEdit({ ...same, files: [{ id: "F1", mode: "tombstone" }] }, same), "…a deleted file (same id, `mode: \"tombstone\"`) is a real edit");
  ok(isUnchangedSlackEdit({ text: "hi", files: [{ id: "F1", mode: "hosted" }] }, { text: "hi", files: [{ id: "F1" }] }), "…while a non-tombstone `mode` that only one copy carries changes nothing");
  ok(!isUnchangedSlackEdit({ text: "hi", attachments: [{ is_share: true, text: "quoted words" }] }, { text: "hi" }), "…a newly quoted message is a real edit (the inbound text grows)");
  ok(!isUnchangedSlackEdit({ text: "hi" }, {}), "…and a notice with no pre-edit text to compare is treated as a real edit (fail toward the wake)");

  const parsed = parseMessageEvent(JSON.parse(editEnvelope("Ev16p", "1775897187.003900", {}, {})));
  eq(parsed?.unchangedEdit, true, "the parse marks a metadata-only `message_changed`");
  eq(parseMessageEvent(JSON.parse(dmEnvelope("Ev16q")))?.unchangedEdit, undefined, "…and leaves a plain message unmarked");

  const meta = await runFront(editEnvelope("Ev16a", "1775897187.003900", { assistant_app_thread: { title: "refund status" } }, {}), { partnerTrust: "internal" });
  eq(meta.dispatched.length, 0, "🔴 a metadata-only edit of the person's DM message wakes NOTHING — it is not a new message, so it must not make the real answer stale");
  ok(!meta.innerCalled, "…and it is not forwarded to eve's native door either");
  eq(meta.res.status, 200, "…and Slack still gets its 200");

  const real = await runFront(editEnvelope("Ev16b", "1775897210.004100", { text: "what's the refund status for order 4417?" }, {}), { partnerTrust: "internal" });
  eq(real.dispatched.length, 1, "🔴 NEGATIVE CONTROL: a REAL edit (new words) still wakes the seat");
  ok(real.dispatched[0]!.message.includes("order 4417"), "…with the post-edit words");

  const noPrev = await runFront(editEnvelope("Ev16c", "1775897211.004300", {}, undefined), { partnerTrust: "internal" });
  eq(noPrev.dispatched.length, 1, "a `message_changed` with no `previous_message` still wakes — the rule never guesses an edit away");

  const DRIVER_BOT = "B0DRIVER99";
  overrideSettingsForTest({ wake: { e2eDrivers: [{ surface: "slack" as const, principal: `${TEAM}:${DRIVER_BOT}` }] } });
  const store = getOperationalStore();
  const admitted = async (ts: string) =>
    (await store.readAudit({ org: "default", action: "surface.wake_admitted" })).filter((r) => (r.detail as { ts?: unknown } | undefined)?.ts === ts);
  const driverTs = "1775897192.004100";
  const driverMeta = await runFront(editEnvelope("Ev16d", driverTs, { bot_id: DRIVER_BOT }, { bot_id: DRIVER_BOT }), { partnerTrust: "internal" });
  eq(driverMeta.dispatched.length, 0, "🔴 the driver's metadata-only edit wakes nothing either — the drop sits ABOVE the driver carve-out");
  eq((await admitted(driverTs)).length, 0, "…and writes no `surface.wake_admitted` row");
  const typedTs = "1775897220.111111";
  const typed = await runFront(dmEnvelope("Ev16e", { bot_id: DRIVER_BOT, ts: typedTs }), { partnerTrust: "internal" });
  eq(typed.dispatched.length, 1, "CONTROL: the driver's typed DM still wakes");
  eq(((await admitted(typedTs))[0]?.detail as Record<string, unknown> | undefined)?.["subtype"], null, "…and its admission row now names the subtype (null for a typed message), so the next red needs no inference");
  overrideSettingsForTest({ wake: { e2eDrivers: [] } });

  let channelSeen = 0;
  const countSeen: Partial<FrontOptions> = { markEventSeen: async () => (channelSeen++, true) };
  const chanEdit = (eventId: string, after: Record<string, unknown>) =>
    JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      team_id: TEAM,
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C0CHAN1",
        subtype: "message_changed",
        hidden: true,
        ts: "1775897320.004000",
        message: { type: "message", user: USER, ts: "1775897319.100000", thread_ts: "1775896620.000100", text: "see the doc", ...after },
        previous_message: { type: "message", user: USER, ts: "1775897319.100000", thread_ts: "1775896620.000100", text: "see the doc" },
      },
    });
  await runFront(chanEdit("Ev16f", { attachments: [{ title: "Doc", title_link: "https://example.com" }] }), { extra: countSeen });
  eq(channelSeen, 0, "🔴 a metadata-only edit in a channel (a link unfurl) stops before the dedupe write — no wake candidate");
  await runFront(chanEdit("Ev16g", { text: "see the NEW doc" }), { extra: countSeen });
  eq(channelSeen, 1, "NEGATIVE CONTROL: a real channel edit reaches the dedupe write, the first step of every wake");
}

{
  const signsOf = (r: Awaited<ReturnType<typeof runFront>>) => (r.dispatched[0]?.auth.attributes ?? {})["working_signs_ts"];
  const formReq = (payload: Record<string, unknown>): Request => {
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const ts = String(Math.floor(NOW_MS / 1000));
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
    return new Request("https://oe.test/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
      body,
    });
  };
  const runForm = (payload: Record<string, unknown>, opts: Parameters<typeof runFront>[1] = {}) => runFront("", { ...opts, request: formReq(payload) });

  const top = await runFront(dmEnvelope("Ev18a"), { partnerTrust: "internal" });
  eq(signsOf(top), "1768686402.916000", "a top-level 1:1 message stamps its own ts: the 👀 lands on the message the person sent");
  const threaded = await runFront(dmEnvelope("Ev18b", { thread_ts: "1768685833.000100" }), { partnerTrust: "internal" });
  eq(signsOf(threaded), "1768685833.000100", "a threaded 1:1 message stamps its thread root, the root the mention door's 👀 uses");
  const group = await runFront(mpimEnvelope("Ev18c"));
  eq(signsOf(group), "1768686403.100200", "🔴 a group-DM message stamps its own ts — before OPE-2632 a group DM showed no sign at all");
  const mention = await runFront(mentionEnvelope("Ev18d", MPIM_CHANNEL));
  eq(signsOf(mention), "1768686404.300400", "a group-DM @mention stamps its own ts too");

  const press = (message: Record<string, unknown>) => ({
    type: "block_actions",
    team: { id: TEAM },
    user: { id: USER, team_id: TEAM },
    channel: { id: DM_CHANNEL },
    message: { ts: "1768686413.000200", text: "Your meetings are on Thursday.", blocks: [], ...message },
    container: { type: "message", message_ts: "1768686413.000200", channel_id: DM_CHANNEL },
    actions: [{ type: "button", action_id: "oe_followup:0", block_id: "oe_followups", value: "Show Friday too" }],
  });
  const threadedPress = await runForm(press({ thread_ts: "1768685833.000300" }), { partnerTrust: "internal" });
  eq(threadedPress.dispatched.length, 1, "(precondition) a threaded follow-up press wakes the DM seat");
  eq(signsOf(threadedPress), "1768685833.000300", "🔴 a follow-up press inside a thread stamps the thread root, a real message: its turn shows the signs there");
  const topPress = await runForm(press({}), { partnerTrust: "internal" });
  eq(topPress.dispatched.length, 1, "(precondition) a top-level follow-up press wakes the DM seat");
  eq(signsOf(topPress), undefined, "NEGATIVE CONTROL: a top-level press stamps nothing — its minted ts names no message");

  const shortcut = await runForm(
    {
      type: "message_action",
      callback_id: "oe_message_shortcut",
      trigger_id: "trig-18",
      team: { id: TEAM },
      user: { id: USER, username: "u" },
      channel: { id: DM_CHANNEL },
      response_url: "https://hooks.slack.test/actions/x",
      message: { type: "message", user: USER, ts: "1768686423.000400", text: "the refund for order 4417 never landed" },
    },
    { partnerTrust: "internal", channelFacts: { internal: true, channelType: "im" } },
  );
  eq(shortcut.dispatched.length, 1, "(precondition) a DM message shortcut wakes the DM seat");
  eq(signsOf(shortcut), undefined, "NEGATIVE CONTROL: a shortcut stamps nothing — its minted ts names no message");
}

console.log(`✓ slack-dm-divert: ${n} assertions passed (OPE-2577 unchanged-edit drop, classification, window token + fence, addressing, DM auth attrs, dm envelope, carried tail, bot/dedupe/fail-closed, no escape hatch (OPE-368), group-DM divert + mention leg + sibling suppression, OPE-1023 named-driver DM carve-out, OPE-525 external-participant policy, OPE-963 pruned-deployment re-delivery, OPE-970 undelivered-after-heal reason, OPE-2524 voice clips)`);
