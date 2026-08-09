import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerSlackProvider } from "../agent/register.js";
import { buildFrontHandler, classifyEnvelope, dmFifoKey, ThreadFifo, EventDedupe } from "../agent/channels/slack-front.js";

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

const SEAT_TOKEN = `oe-dom:oe-dm/${SURFACE}:oe-sup:g3-abc123`;

function dmEnvelope(eventId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: TEAM,
    event: { type: "message", channel_type: "im", channel: DM_CHANNEL, user: USER, ts: "1768686402.916000", text: "what's the refund status?", ...over },
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
    seat?: { token: string; generation: number; freshGeneration: boolean; handoffNote: string | null };
    seatThrows?: boolean;
    dmSeatEnabled?: boolean;
    partnerTrust?: "internal" | "external";
    dedupe?: EventDedupe;
    fifo?: SpyFifo;
  } = {},
) {
  const dispatched: Dispatched[] = [];
  const touched: Array<{ org: string; surfaceKey: string }> = [];
  const waits: Array<Promise<unknown>> = [];
  let innerCalled = false;
  const fifo = opts.fifo ?? new SpyFifo();

  const fakeArgs = {
    from: () => ({ send: async () => ({}) }),
    to: (_channel: unknown, target: Dispatched["target"]) => ({
      send: async (message: string, sendOpts: { auth: Dispatched["auth"] }) => {
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
      getBotIdentity: async () => ({ userId: "UBOT" }),
      fifo,
      ...(opts.dedupe ? { dedupe: opts.dedupe } : {}),
      ...(opts.dmSeatEnabled === false ? { dmSeatEnabled: () => false } : {}),
      dmPartnerTrustFor: async () => opts.partnerTrust,
      resolveDmSeat: async (_org, dm, _at) => {
        if (opts.seatThrows) throw new Error("registry down");
        seatCalls.push(dm);
        return (opts.seat ?? { token: SEAT_TOKEN, generation: 3, freshGeneration: false, handoffNote: null }) as never;
      },
      touchDmSeatFn: async (org, surfaceKey) => {
        touched.push({ org, surfaceKey });
      },
    },
  );
  const seatCalls: Array<{ surfaceKey: string; legacyChannelId?: string }> = [];
  const res = await handler(mkReq(body), fakeArgs as unknown as Parameters<typeof handler>[1]);
  const settled = await Promise.allSettled(waits);
  return { dispatched, touched, seatCalls, innerCalled, res, fifo, settled };
}

{
  const d = classifyEnvelope(dmEnvelope("Ev1"), "application/json");
  eq(d.kind, "dm-wake", "🔴 a `message.im` classifies `dm-wake` — the DM window seat owns it (it used to classify `forward`, to eve's native onDirectMessage)");
  eq(classifyEnvelope(JSON.stringify({ type: "event_callback", event: { type: "message", channel_type: "channel", channel: "C1", ts: "1" } }), "application/json").kind, "wake", "a channel message still takes the engagement wake path");
  eq(classifyEnvelope(JSON.stringify({ type: "event_callback", event: { type: "message", channel_type: "mpim", channel: "G1", ts: "1" } }), "application/json").kind, "wake", "🔴 an MPIM (group DM) is UNTOUCHED — it keeps the OPE-306 anchor route until the parity stage");
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
  ok(
    d.message.includes("<untrusted_external_data source=\"slack-message\">"),
    "🔴 the DM body is now `wrapUntrusted`-FENCED like every other surface's inbound text — a strict improvement (eve's native DM dispatch delivered it raw)",
  );
  ok(d.message.includes("what&apos;s the refund status?"), "…with the human's text inside the fence (XML-escaped by the renderer, as on every surface)");
  ok(
    d.message.startsWith("[direct] This is a direct message to you"),
    "🔴 the preamble opens as a DM, NOT as \"you were @mentioned by name in this channel\" — `direct-mention` addressing is carried for its MECHANICAL effect (arming the prose bridge), and the orientation prose must not inherit its literal claim",
  );
  ok(d.message.includes("the ONLY way your words reach anyone"), "…while the reply MANDATE is byte-identical to the mention path's (a DM answer must still come from the `reply` tool)");

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
  ok(vouched.dispatched[0]!.message.includes('trust="peer"'), "an INTERNAL DM partner renders the `peer` trust tier");

  const unverifiable = await runFront(dmEnvelope("Ev5b2"));
  ok(
    unverifiable.dispatched[0]!.message.includes('trust="unauth"'),
    "🔴 an UNVERIFIABLE partner (the lookup failed / no token) falls to `unauth`, not `peer` — the DM path inherits the same fail-closed trust floor every other surface has",
  );
  ok(
    unverifiable.dispatched[0]!.message.includes("<system-note>"),
    "…and the trusted reference-only system note is appended, so the model is TOLD the author is unvouched",
  );
  eq((unverifiable.dispatched[0]!.auth.attributes ?? {})["dm_partner_trust"], undefined, "…while the auth omits dm_partner_trust entirely, so the binding fails closed to the external memory tier");
}

{
  const fresh = await runFront(dmEnvelope("Ev6a"), {
    seat: { token: SEAT_TOKEN, generation: 4, freshGeneration: true, handoffNote: "alice was mid-refund" },
  });
  eq(
    fresh.dispatched[0]!.target.context,
    ["<handoff-from-previous-session>\nalice was mid-refund\n</handoff-from-previous-session>"],
    "a FRESH generation carries the distilled handoff as fenced `context` — the continuity affordance the deleted wrapper provided, now riding the divert",
  );

  const resumed = await runFront(dmEnvelope("Ev6b"), {
    seat: { token: SEAT_TOKEN, generation: 4, freshGeneration: false, handoffNote: "alice was mid-refund" },
  });
  eq(resumed.dispatched[0]!.target.context, undefined, "…a RESUMED generation carries none (the note is a fresh-generation affordance only)");
}

{
  const r = await runFront(dmEnvelope("Ev7", { bot_id: "B123", user: undefined }));
  eq(r.dispatched.length, 0, "a bot-authored DM (our own post arrives as bot_message) wakes nothing");
  ok(!r.innerCalled, "🔴 …and is NOT forwarded: handing eve's native door a turn the DM window owns would open a second, un-rotatable session");
  eq(r.res.status, 200, "it is a plain no-op 200");
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
  const r = await runFront(dmEnvelope("Ev10"), { dmSeatEnabled: false });
  ok(r.innerCalled, "with DM-seat rotation disabled a DM forwards to eve's native dispatch — the fallback a deployment can reach without a redeploy");
  eq(r.dispatched.length, 0, "…and nothing is diverted");
  eq(await r.res.text(), "inner", "…the native handler's response is returned verbatim");
}

console.log(`✓ slack-dm-divert: ${n} assertions passed (classification, window token + fence, addressing, DM auth attrs, dm envelope, handoff context, bot/dedupe/fail-closed/escape-hatch)`);
