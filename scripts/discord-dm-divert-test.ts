import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-discord-dm-divert-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

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
import { renderWake } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import type { UnifiedReceiveTarget } from "@open-everywhere/core/agent/channels/unified.js";
import { RUN_KEY_FETCH_MARKER, HTTP_404_MARKER, PRUNED_DEPLOYMENT_AUDIT_ACTION } from "@open-everywhere/core/agent/channels/stranded-seat.js";
import type { RouteHandlerArgs } from "eve/channels";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

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

async function run(msg: DiscordRelayMessage, opts: { noReceive?: boolean; sendThrows?: Error } = {}) {
  const received: Received[] = [];
  const nativeSends: unknown[] = [];
  let threadAttempts = 0;
  const send = (async (...args: unknown[]) => void nativeSends.push(args)) as unknown as DiscordGatewaySend;
  const capture = ((ch: unknown, target: unknown) => ({
    async send(message: string, options: { auth: unknown }) {
      if (opts.sendThrows) throw opts.sendThrows;
      received.push({ channel: ch, message, target: target as UnifiedReceiveTarget, auth: options.auth as Received["auth"] });
      return {} as never;
    },
  })) as unknown as RouteHandlerArgs["to"];
  let threw: unknown;
  try {
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
  } catch (err) {
    threw = err;
  }
  return { received, nativeSends, threadAttempts, threw };
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
  ok(d.message.startsWith("<wake ") && d.message.endsWith("</wake>"), "🔴 the delivery is the envelope alone — no orientation prose to inherit a literal claim from");
  ok(d.message.includes('addressing="direct-mention"'), "…and `direct-mention` addressing is carried for its MECHANICAL effect (arming the prose bridge)");
  ok(!d.message.includes("the ONLY way your words reach anyone"), "…while the reply MANDATE lives once in the standing Reporting arm, not above every envelope");
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
  await getOperationalStore().rotateChannelSession("default", key, before!.token, ancient);
  const aged = await getOperationalStore().getChannelSession("default", key);

  const CARRIED_WAKE = "any word on the refund?";
  const CARRIED_POST = "chasing payments now";
  await getOperationalStore().appendSessionTail("default", key, aged!.token, {
    kind: "wake", at: new Date(Date.now() - 3_600_000).toISOString(), from: "human", trust: "principal", author: "alice", authorId: "U_ALICE", text: CARRIED_WAKE,
  });
  await getOperationalStore().appendSessionTail("default", key, aged!.token, {
    kind: "post", at: new Date(Date.now() - 3_500_000).toISOString(), from: "self", trust: "relay", author: "self", text: CARRIED_POST,
  });

  const r = await run(dmMsg({ id: "5004", content: "still waiting" }));
  const d = r.received[0]!;
  ok(d.target.token !== aged!.token, "🔴 an EXPIRED DM seat ROTATES on its next wake — the DM thresholds ride (expiry is the primary trigger since OPE-345)");
  const rotated = await getOperationalStore().getChannelSession("default", key);
  eq(rotated!.generation, aged!.generation + 1, "…to generation+1, computed by the store's own atomic upsert");
  eq(d.target.token, rotated!.token, "…and the wake is dispatched to the newly-minted token");
  ok(
    d.message.includes(CARRIED_WAKE) && d.message.includes(CARRIED_POST),
    "🔴 the FRESH generation carries the OUTGOING generation's recorded tail — BOTH what the room said and what the seat replied — so a Discord DM rotation is a rotation, not amnesia",
  );
  ok(d.message.indexOf(CARRIED_WAKE) < d.message.indexOf(CARRIED_POST), "…in true order, so it reads as the conversation it was");
  ok(d.message.indexOf(CARRIED_POST) < d.message.indexOf("still waiting"), "…and both BEFORE the live trigger that woke this generation");
  eq(d.target.context, undefined, "…in the wake ENVELOPE, not as a side-channel context string: the tail renders as messages, like everything else in a wake");
  eq(
    (await getOperationalStore().readSessionTail("default", key, aged!.token)).length,
    0,
    "…and the retired generation's ring is CLEARED once carried",
  );
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
  eq(nw.engagementTier, undefined, "…and no engagement tier (that dial calibrates AMBIENT watching; a DM is always answered)");
  eq(nw.locus.thread, undefined, "…and no thread locus");
  const rendered = renderWake(nw, () => "2026-08-09T12:00:00Z");
  ok(rendered.message.includes('wake-id="wk_1"'), "the rendered envelope carries the wake-id — the only reply route on the unified channel");
}

{
  const boom = new Error("socket hang up");
  const before = new Date().toISOString();
  const r = await run(dmMsg({ id: "5009", content: "are you there" }), { sendThrows: boom });
  eq(r.received.length, 0, "the failed send delivers nothing");
  ok(r.threw !== undefined, "🔴 the divert failure still PROPAGATES — this is an audit ADDITION, not a swallow");

  const rows = (await getOperationalStore().readAudit({ org: "default", action: "surface.wake_failed" })).filter(
    (row) => row.ts >= before,
  );
  eq(rows.length, 1, "🔴 the divert failure writes exactly ONE `surface.wake_failed` row — previously it wrote NONE");
  eq(rows[0]!.platform, "discord", "…on the discord platform");
  eq(rows[0]!.surface, DM_SURFACE, "…keyed to the DM's own surface, so a per-surface audit query finds it");
  const detail = (rows[0]!.detail ?? {}) as Record<string, unknown>;
  ok(String(detail.message).includes("socket hang up"), "…and the row names the real failure, not a generic placeholder");
}

{
  const boom = new Error(`${RUN_KEY_FETCH_MARKER} for wrun_TEST (deployment dpl_TEST): ${HTTP_404_MARKER} Not Found`);
  const throwingSend = (async () => {
    throw boom;
  }) as unknown as DiscordGatewaySend;
  const guildMsg: DiscordRelayMessage = {
    id: "6001",
    content: "<@BOT9> ping",
    channelId: "7002",
    channelType: "0",
    guildId: "G_ACME2",
    author: { id: "U_CAROL", username: "carol", bot: false },
    mentionsBot: true,
    botId: BOT,
  };
  let threw: unknown;
  try {
    await dispatchTurn(guildMsg, authForRelayMessage(guildMsg)!, throwingSend, async () => null, async () => undefined, undefined);
  } catch (err) {
    threw = err;
  }
  ok(threw === boom, "🔴 the native guild send failure still PROPAGATES unchanged — this is an audit ADDITION, not a swallow");

  const strandRows = (await getOperationalStore().readAudit({ org: "default", action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "discord:7002",
  );
  eq(strandRows.length, 1, "🔴 OPE-971: the native guild dispatch's pruned-deployment strand now writes exactly ONE audit row — previously it wrote NONE");
  eq(strandRows[0]!.platform, "discord", "…on the discord platform");
  const detail = (strandRows[0]!.detail ?? {}) as Record<string, unknown>;
  eq(detail.outcome, "not-a-window", "…outcome is `not-a-window`: a plain `discord:<channelId>` token never parses as a window token");
  eq(detail.remedy, "none", "…and the remedy is honestly `none` — no rotatable registry row exists for a native guild session, so no rotation is invented");
}

{
  const transient = new Error("socket hang up");
  const throwingSend = (async () => {
    throw transient;
  }) as unknown as DiscordGatewaySend;
  const guildMsg: DiscordRelayMessage = {
    id: "6002",
    content: "<@BOT9> ping again",
    channelId: "7003",
    channelType: "0",
    guildId: "G_ACME3",
    author: { id: "U_DAVE", username: "dave", bot: false },
    mentionsBot: true,
    botId: BOT,
  };
  let threw: unknown;
  try {
    await dispatchTurn(guildMsg, authForRelayMessage(guildMsg)!, throwingSend, async () => null, async () => undefined, undefined);
  } catch (err) {
    threw = err;
  }
  ok(threw === transient, "the transient failure still propagates unchanged");
  const strandRows = (await getOperationalStore().readAudit({ org: "default", action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).filter(
    (row) => (row.detail as { token?: unknown } | undefined)?.token === "discord:7003",
  );
  eq(strandRows.length, 0, "negative control: a TRANSIENT native guild send failure classifies not-classified and writes NO strand audit row at all");
}

{
  let calls = 0;
  const retryingSend = (async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("refused"), { name: "TooManyRequestsError", retryAfter: 0 });
  }) as unknown as DiscordGatewaySend;
  const guildMsg: DiscordRelayMessage = {
    id: "6003",
    content: "<@BOT9> retry this",
    channelId: "7004",
    channelType: "0",
    guildId: "G_ACME4",
    author: { id: "U_ERIN", username: "erin", bot: false },
    mentionsBot: true,
    botId: BOT,
  };
  await dispatchTurn(guildMsg, authForRelayMessage(guildMsg)!, retryingSend, async () => null, async () => undefined, undefined);
  eq(calls, 2, "🔴 OPE-1881: Discord's real native launch retries one proven 429 and delivers");
  const rows = (await getOperationalStore().readAudit({ org: "default", action: "surface.wake_retry" })).filter((row) => row.surface === "discord/G_ACME4/7004");
  eq(rows.length, 1, "🔴 OPE-1881: Discord records the native refusal under the real guild/channel surface");
  ok(!("wakeId" in ((rows[0]?.detail ?? {}) as Record<string, unknown>)), "🔴 the native Discord row does not fabricate a wakeId");
}

{
  let calls = 0;
  const refusingSend = (async () => {
    calls += 1;
    throw Object.assign(new Error("refused"), { name: "TooManyRequestsError", retryAfter: 0 });
  }) as unknown as DiscordGatewaySend;
  const guildMsg: DiscordRelayMessage = {
    id: "6004",
    content: "<@BOT9> keep retrying",
    channelId: "7005",
    channelType: "0",
    guildId: "G_ACME5",
    author: { id: "U_FRANK", username: "frank", bot: false },
    mentionsBot: true,
    botId: BOT,
  };
  let threw: unknown;
  try {
    await dispatchTurn(guildMsg, authForRelayMessage(guildMsg)!, refusingSend, async () => null, async () => undefined, undefined);
  } catch (err) {
    threw = err;
  }
  eq(calls, 4, "🔴 Discord's native adapter stops at the shared four-attempt bound");
  ok(threw instanceof Error && threw.name === "RateLimitExhaustedError", "🔴 Discord propagates named retry exhaustion through its existing strand-heal catch");
}

console.log(`✓ discord-dm-divert: ${n} assertions passed (DM divert, native failure audit/heal, native 429 retry + controls)`);
