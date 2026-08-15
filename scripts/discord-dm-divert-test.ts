import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-discord-dm-divert-")), "ops.sqlite3");
delete process.env.OE_ORG;

import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import {
  dispatchTurn,
  authForRelayMessage,
  buildDiscordDmWake,
  type DiscordRelayMessage,
  type DiscordGatewaySend,
} from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { dmWindowRegistryKey } from "@open-everywhere/core/agent/channels/unified-supervisor.js";
import { dmAnchorSurfaceForToken, dmAnchorDomain } from "@open-everywhere/core/agent/channels/window-key.js";
import { wakeOriginCodec } from "@open-everywhere/core/agent/channels/wake-origin-codec.js";
import { registerHandoffCompletion } from "@open-everywhere/core/agent/model/rotation-handoff.js";
import { renderWake } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import type { UnifiedReceiveTarget } from "@open-everywhere/core/agent/channels/unified.js";
import type { RouteHandlerArgs } from "eve/channels";

registerDiscordProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

const DM_CHANNEL = "9001";
const GROUP_DM_CHANNEL = "9003";
const USER = "U_ALICE_777";
const BOT = "BOT9";
const DM_SURFACE = `discord/${USER}/${DM_CHANNEL}`;

const dmMsg = (over: Partial<DiscordRelayMessage> = {}): DiscordRelayMessage => ({
  id: "5001",
  content: "what's the refund status?",
  channelId: DM_CHANNEL,
  channelType: "1",
  author: { id: USER, username: "alice", bot: false },
  mentionsBot: false,
  botId: BOT,
  ...over,
});

interface Received {
  channel: unknown;
  message: string;
  target: UnifiedReceiveTarget;
  auth: { attributes?: Record<string, unknown> };
}

async function run(msg: DiscordRelayMessage, opts: { noReceive?: boolean } = {}) {
  const received: Received[] = [];
  const nativeSends: unknown[] = [];
  let threadAttempts = 0;
  const send = (async (...args: unknown[]) => void nativeSends.push(args)) as unknown as DiscordGatewaySend;
  const capture = ((ch: unknown, target: unknown) => ({
    async send(message: string, options: { auth: unknown }) {
      received.push({ channel: ch, message, target: target as UnifiedReceiveTarget, auth: options.auth as Received["auth"] });
      return {} as never;
    },
  })) as unknown as RouteHandlerArgs["to"];
  await dispatchTurn(
    msg,
    authForRelayMessage(msg)!,
    send,
    async () => {
      threadAttempts++;
      return null;
    },
    async () => undefined,
    opts.noReceive ? undefined : capture,
  );
  return { received, nativeSends, threadAttempts };
}

{
  const r = await run(dmMsg());
  eq(r.nativeSends.length, 0, "🔴 a DM is NEVER dispatched on the native per-channel session — one decision, so no double turn is possible");
  eq(r.threadAttempts, 0, "…and no auto-thread is attempted (a DM has no threads, and the divert returns before that block anyway)");
  eq(r.received.length, 1, "exactly one dispatch into the unified channel");

  const d = r.received[0]!;
  ok(
    d.target.token.startsWith(`oe-dom:${dmAnchorDomain(DM_SURFACE)}:oe-sup:g`),
    `the wake is dispatched to a DM WINDOW token on the DM's own pseudo-domain — got ${d.target.token}`,
  );
  eq(d.target.surfaceKey, DM_SURFACE, "the divert's surfaceKey is the DM's own surface (workspace = the caller's user id — a DM has no guild)");
  eq(
    dmAnchorSurfaceForToken(d.target.token),
    DM_SURFACE,
    "🔴 the admission seam recovers EXACTLY this surface from the token — a DM window is deliverable to ITS OWN DM and nowhere else",
  );

  eq(d.target.origin.platform, "discord", "the frozen origin names the surface the reply goes back to");
  eq((d.target.origin as { channelId?: string }).channelId, DM_CHANNEL, "…and the DM channel itself");
  eq((d.target.origin as { dm?: boolean }).dm, true, "🔴 it is the POSITIVE `dm:true` variant, never a guildless guild-shape (OPE-315's discriminant)");
  eq((d.target.origin as { guildId?: string }).guildId, undefined, "…carries NO guildId — the XOR the validator enforces in the impersonation direction");
  eq((d.target.origin as { autoThreadName?: string }).autoThreadName, undefined, "…and NO autoThreadName (its reply-leg branch writes guild-keyed engagement rows — D4)");
  eq(
    (d.target.origin as { messageId?: string }).messageId,
    undefined,
    "🔴 no messageId either: the native DM path replied with a PLAIN post, so the answer stays unanchored across the re-seat rather than quietly threading under the question (the Slack divert's replyAnchorTs reasoning)",
  );
  ok(wakeOriginCodec("discord")!.validate(d.target.origin as never), "🔴 the REGISTERED Discord codec VALIDATES the origin this path mints — the reply leg re-validates it fail-closed on read");
  ok(
    !wakeOriginCodec("discord")!.validate({ ...(d.target.origin as object), guildId: "G1" } as never),
    "…and REFUSES the same origin with a guildId bolted on (a DM-shaped row must never acquire guild authority)",
  );

  const a = d.auth.attributes ?? {};
  eq(a["oe_addressing"], "direct-mention", "🔴 `direct-mention` is stamped through the divert — this arms the unified channel's addressed-prose bridge");
  ok(typeof d.target.wakeId === "string" && d.target.wakeId.length > 0, "a host-minted wake id rides the dispatch (the id the model echoes to `reply`)");
  eq(a["oe_wake_id"], d.target.wakeId, "…and the same id is stamped on the delivery auth");

  eq(a["channel_id"], DM_CHANNEL, "auth carries the DM channel id");
  eq(a["user_id"], USER, "auth carries the acting user");
  eq(a["channel_type"], "1", "auth carries channel_type=1 (Discord's DM enum)");
  eq(a["guild_id"], undefined, "…and no guild_id: a DM genuinely has none, and a fabricated one is how a DM would reach guild-keyed authority");
  eq(
    a["oe_grain"],
    "standing",
    "🔴 the rootDmGrainAttrs stamp rides through — it NARROWS a DM root's hands (window-tool-gating §D-DM); losing it would silently hand a DM the full kit",
  );

  ok(d.message.includes('reason="dm"'), "🔴 the envelope's reason is `dm` — the surface shape, not `mention`");
  ok(!d.message.includes('reason="mention"'), "…telling a DM it was @mentioned in a channel is a small lie that costs orientation");
  ok(
    d.message.startsWith("[direct] This is a direct message to you"),
    "🔴 the preamble opens as a DM — `direct-mention` addressing is carried for its MECHANICAL effect, and the orientation prose must not inherit its literal claim",
  );
  ok(d.message.includes("the ONLY way your words reach anyone"), "…while the reply MANDATE is the mention path's, byte-identical (the answer must come from `reply`)");
  ok(d.message.includes("<untrusted_external_data"), "🔴 the DM body is `wrapUntrusted`-FENCED like every other surface's inbound text");
  ok(d.message.includes("refund status"), "…with the human's text inside the fence");
  eq((d.message.match(/<message /g) ?? []).length, 1, "🔴 exactly ONE message in the envelope — a DM wake carries NO backscroll (the seat's own session IS the history)");
  eq(d.target.context, undefined, "…and no `context` on a first, un-rotated generation with nothing to hand off");
}

{
  const first = await run(dmMsg({ id: "5002", content: "any update?" }));
  const second = await run(dmMsg({ id: "5003", content: "and one more thing" }));
  eq(
    first.received[0]!.target.token,
    second.received[0]!.target.token,
    "🔴 consecutive DM wakes RESUME one seat — the token comes from a durable channel_session row, not a per-wake mint (a re-mint would fork the session every message)",
  );
  const row = await getOperationalStore().getChannelSession("default", dmWindowRegistryKey(DM_SURFACE));
  ok(row !== null, "the seat is held in the DM window's own registry row");
  eq(row!.token, second.received[0]!.target.token, "…and the row's token IS the token dispatched (no re-derivation on the way out)");
}

{
  const key = dmWindowRegistryKey(DM_SURFACE);
  const before = await getOperationalStore().getChannelSession("default", key);
  const ancient = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
  await getOperationalStore().rotateChannelSession("default", key, before!.token, ancient, "alice was mid-refund");
  const aged = await getOperationalStore().getChannelSession("default", key);

  registerHandoffCompletion(async () => "Open asks: the refund. Owners: alice. Norms: (none). In flight: (none).");
  try {
    const r = await run(dmMsg({ id: "5004", content: "still waiting" }));
    const d = r.received[0]!;
    ok(d.target.token !== aged!.token, "🔴 an EXPIRED DM seat ROTATES on its next wake — the DM thresholds ride (expiry is the primary trigger since OPE-345)");
    const rotated = await getOperationalStore().getChannelSession("default", key);
    eq(rotated!.generation, aged!.generation + 1, "…to generation+1, computed by the store's own atomic upsert");
    eq(d.target.token, rotated!.token, "…and the wake is dispatched to the newly-minted token");
    ok(
      d.message.includes(`<handoff-note from-generation="${aged!.generation}">`) && d.message.includes("Open asks: the refund. Owners: alice."),
      "🔴 the FRESH generation carries the DISTILLED handoff, IN THE ENVELOPE — a Discord DM rotation is a rotation, not amnesia (the whole reason the distiller exists on this surface)",
    );
    eq(d.target.context, undefined, "…and NOT as a side-channel context string — the envelope's own `<handoff-note>` is the labelled home for it");
  } finally {
    registerHandoffCompletion(null);
  }
}

{
  const r = await run(dmMsg({ id: "5005", channelId: GROUP_DM_CHANNEL, channelType: "3", content: "hi both" }));
  eq(r.nativeSends.length, 0, "a group DM diverts too — Discord has ONE DM predicate (types 1 and 3) and both are standing grains");
  const surface = `discord/${USER}/${GROUP_DM_CHANNEL}`;
  eq(r.received[0]!.target.surfaceKey, surface, "…keyed on its OWN surface, so a group DM's window is fenced to the group DM and never to the 1:1");
  ok(r.received[0]!.target.token.startsWith(`oe-dom:${dmAnchorDomain(surface)}:oe-sup:g`), "…on its own pseudo-domain");
  eq((r.received[0]!.target.origin as { dm?: boolean }).dm, true, "…with the same DM-variant origin the divert mints for a 1:1");
}

{
  process.env["OE_DM_SEAT_ROTATION"] = "0";
  try {
    const r = await run(dmMsg({ id: "5006" }));
    eq(r.received.length, 1, "a STALE OE_DM_SEAT_ROTATION=0 no longer disables the DM window — the flag is gone, the divert is unconditional");
    eq(r.nativeSends.length, 0, "…and the DM does NOT fall back to eve's native per-channel session");
  } finally {
    delete process.env["OE_DM_SEAT_ROTATION"];
  }

  const noReceive = await run(dmMsg({ id: "5007" }), { noReceive: true });
  eq(noReceive.received.length, 0, "no cross-channel `to` (an older caller) diverts nothing");
  eq(noReceive.nativeSends.length, 1, "…and falls through to the native path fail-closed, byte-identical to today");
}

{
  const r = await run({
    id: "5008",
    content: "<@BOT9> what's the deploy window?",
    channelId: "7001",
    channelType: "0",
    guildId: "G_ACME",
    author: { id: "U_BOB", username: "bob", bot: false },
    mentionsBot: true,
    botId: BOT,
  });
  eq(r.received.length, 0, "🔴 a guild @mention does NOT take the DM arm — an un-vouched guild channel stays on the native path (its own privacy floor decides, unchanged)");
  eq(r.nativeSends.length, 1, "…and is dispatched natively exactly as before");
}

{
  const nw = buildDiscordDmWake({
    channelId: DM_CHANNEL,
    wakeId: "wk_1",
    trigger: { id: "m1", author: "alice", authorId: USER, sentAt: "2026-08-09T12:00:00Z", text: "hello", trust: "principal" as const },
  });
  eq(nw.reason, "dm", "the builder emits reason `dm`");
  eq(nw.addressing, "direct-mention", "…with `direct-mention` addressing (semantically true AND mechanically load-bearing)");
  eq(nw.unifiedDisclosure, undefined, "🔴 NO cross-surface disclosure: a DM window is degenerate — there is no fan-in to disclose, and claiming one would be false");
  eq(nw.engagementTier, undefined, "…and no engagement tier (that dial calibrates AMBIENT watching; a DM is always answered)");
  eq(nw.locus.thread, undefined, "…and no thread locus");
  eq(nw.locus.channel.platform, undefined, "…and no platform address stamp (this window sees exactly one surface)");
  const rendered = renderWake(nw, () => "2026-08-09T12:00:00Z");
  ok(rendered.message.includes('wake-id="wk_1"'), "the rendered envelope carries the wake-id — the only reply route on the unified channel");
}

console.log(`✓ discord-dm-divert: ${n} assertions passed (divert + fence, DM origin/codec, auth attrs, dm envelope, resume, rotation handoff, group DM, escape hatches, guild untouched, builder)`);
