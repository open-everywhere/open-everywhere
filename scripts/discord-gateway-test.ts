
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import {
  relayGate,
  parseRelayPayload,
  authForRelayMessage,
} from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { parseDriverAllowlist, isAllowedDriver, isAllowedSlackDriver } from "@open-everywhere/core/agent/testing/driver-allowlist.js";
import {
  shouldDispatchDiscord,
  isDmChannel,
  discordNativeWake,
  takeTurnStatus,
  splitForDiscord,
  shouldAutoThread,
  autoThreadEnabled,
  statusUxEnabled,
  deriveThreadName,
  dispatchSurfaceFor,
  planCompletion,
  buildGatewayState,
  typingRefreshDue,
  closeTypingGate,
  openTypingGate,
  typingGateOpen,
  typingGateFeed,
  isThreadChannelType,
  nameDropEligible,
  stripLeadingMention,
  type DiscordRelayMessage,
} from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { renderWake } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { discordPostMessage } from "@open-everywhere/provider-discord/agent/channels/discord-post.js";
import { threadParentChannelId, clearDiscordInfoCacheForTest } from "@open-everywhere/provider-discord/agent/channels/discord-channel-info.js";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { domainKeyOf, resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { finalMessageAction, NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/turn-delivery.js";
import type { OpenEverywhereDiscordAuth } from "@open-everywhere/provider-discord/agent/channels/discord-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const k of [
  "OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL",
  "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG", "OE_TRUST",
]) {
  delete process.env[k];
}

const SECRET = "test-relay-secret-never-real";
function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function relayEnvelope(message: Record<string, unknown>): Record<string, unknown> {
  return { source: "discord-gateway-relay", event: "MESSAGE_CREATE", message };
}

{
  const body = JSON.stringify(relayEnvelope({ id: "M1", content: "hi", channelId: "C1", author: { id: "U1", bot: false }, mentionsBot: true }));

  ok(relayGate(sign(body), body, SECRET) === null, "gate: correctly-signed body accepted");

  const wrongKey = relayGate(sign(body, "some-other-secret"), body, SECRET);
  ok(wrongKey?.status === 401, "gate: signature under a different key -> 401");

  const tampered = relayGate(sign(body, SECRET), body + " ", SECRET);
  ok(tampered?.status === 401, "gate: body tampered after signing -> 401");

  ok(relayGate(null, body, SECRET)?.status === 401, "gate: missing signature header -> 401");
  ok(relayGate("not-a-sig", body, SECRET)?.status === 401, "gate: malformed signature header -> 401");
  ok(relayGate("sha256=zzzz", body, SECRET)?.status === 401, "gate: non-hex signature -> 401");

  ok(relayGate(sign(body), body, undefined)?.status === 401, "gate: OE_RELAY_SECRET unset -> 401 (fail-closed)");
  ok(relayGate(sign(body), body, "")?.status === 401, "gate: OE_RELAY_SECRET empty -> 401 (fail-closed)");
}

{
  const parsed = parseRelayPayload(
    relayEnvelope({
      id: "M2",
      content: "<@bot> deploy the thing",
      createdTimestamp: 1234,
      channelId: "C_ENG",
      channelType: 0,
      guildId: "G_ACME",
      author: { id: "U_alice", username: "alice", bot: false },
      mentionsBot: true,
      referencedMessageId: "M_prev",
    }),
  );
  ok(parsed !== null, "parse: valid guild message accepted");
  ok(parsed!.channelId === "C_ENG" && parsed!.guildId === "G_ACME", "parse: channel/guild ids");
  ok(parsed!.channelType === "0", "parse: numeric channelType coerced to string");
  ok(parsed!.mentionsBot === true, "parse: mentionsBot preserved");
  ok(parsed!.referencedMessageId === "M_prev", "parse: referencedMessageId preserved");

  const auth = authForRelayMessage(parsed!);
  ok(auth !== null, "auth: non-bot author produces auth");
  const a = auth as OpenEverywhereDiscordAuth;
  ok(a.authenticator === "discord" && a.principalId === "U_alice", "auth: authenticator + principal");
  ok(
    a.attributes.channel_id === "C_ENG" &&
      a.attributes.guild_id === "G_ACME" &&
      a.attributes.user_id === "U_alice" &&
      a.attributes.channel_type === "0",
    "auth: buildDiscordAuth attribute mapping (channel/guild/user/type)",
  );

  const ctx: BindableContext = { channel: { kind: "discord" }, session: { auth: { current: a } } };
  const binding = bindFrom(ctx);
  const partition = resolvePartition(ctx);
  ok(binding.platform === "discord" && binding.workspace === "G_ACME" && binding.surface === "C_ENG", "identity: workspace=guild, surface=channel");
  ok(binding.mode === "channel" && binding.visibility === "private", "identity: guild text channel -> channel/private (fail-closed)");
  ok(partition.surfaceKey === "discord/G_ACME/C_ENG", "identity: surfaceKey");

  for (const kind of ["discord-gateway", "channel:discord-gateway"]) {
    const sessionCtx: BindableContext = { channel: { kind }, session: { auth: { current: a } } };
    const b = bindFrom(sessionCtx);
    ok(
      b.platform === "discord" && b.workspace === "G_ACME" && b.surface === "C_ENG" && b.mode === "channel",
      `identity: in-session kind "${kind}" aliases to the discord mapper (same binding as route-side)`,
    );
    ok(resolvePartition(sessionCtx).surfaceKey === "discord/G_ACME/C_ENG", `identity: in-session kind "${kind}" -> same surfaceKey as route-side`);
  }
}

{
  const parsed = parseRelayPayload(
    relayEnvelope({ id: "M3", content: "hey", channelId: "D_bob", channelType: 1, author: { id: "U_bob", bot: false }, mentionsBot: false }),
  );
  ok(parsed !== null && parsed!.guildId === undefined, "parse: DM has no guild id");
  const a = authForRelayMessage(parsed!) as OpenEverywhereDiscordAuth;
  const ctx: BindableContext = { channel: { kind: "discord" }, session: { auth: { current: a } } };
  const binding = bindFrom(ctx);
  ok(binding.mode === "dm" && binding.visibility === "private", "identity: DM (type 1) -> dm/private");
  ok(binding.workspace === "U_bob" && binding.surface === "D_bob", "identity: DM keys to the caller's own workspace/surface");
}

{
  const botMsg = parseRelayPayload(
    relayEnvelope({ id: "M4", content: "beep", channelId: "C1", author: { id: "B1", username: "otherbot", bot: true }, mentionsBot: true }),
  );
  ok(botMsg !== null, "parse: a bot-authored message still parses (drop happens at auth)");
  ok(authForRelayMessage(botMsg!) === null, "auth: bot author dropped (null)");

  ok(parseRelayPayload(null) === null, "parse: null -> null");
  ok(parseRelayPayload("nope") === null, "parse: non-object -> null");
  ok(parseRelayPayload({ source: "somethingelse", message: {} }) === null, "parse: wrong source -> null");
  ok(parseRelayPayload(relayEnvelope({ id: "x", content: "c", author: { id: "U", bot: false } })) === null, "parse: missing channelId -> null");
  ok(parseRelayPayload(relayEnvelope({ id: "x", content: "c", channelId: "C1" })) === null, "parse: missing author -> null");
  ok(parseRelayPayload(relayEnvelope({ id: "x", content: "c", channelId: "C1", author: { bot: false } })) === null, "parse: missing author id -> null");
}

{
  ok(shouldDispatchDiscord({ mentionsBot: true, isEngaged: false, isDm: false }) === true, "wake: mention wakes even when not engaged");
  ok(shouldDispatchDiscord({ mentionsBot: false, isEngaged: true, isDm: false }) === true, "wake: engaged channel wakes on a plain reply");
  ok(shouldDispatchDiscord({ mentionsBot: false, isEngaged: false, isDm: false }) === false, "wake: non-mention in a non-engaged channel is dropped");
  ok(shouldDispatchDiscord({ mentionsBot: true, isEngaged: true, isDm: false }) === true, "wake: mention + engaged wakes");
  ok(shouldDispatchDiscord({ mentionsBot: false, isEngaged: false, isDm: true }) === true, "wake: a DM wakes WITHOUT a mention (it's inherently addressed to the bot)");

  ok(isDmChannel("1") === true, "dm: type 1 (DM) is a DM");
  ok(isDmChannel("3") === true, "dm: type 3 (group DM) is a DM");
  ok(isDmChannel("0") === false, "dm: type 0 (guild text) is not a DM");
  ok(isDmChannel("11") === false, "dm: type 11 (public thread) is not a DM");
  ok(isDmChannel(undefined) === false, "dm: unknown channel type is not a DM (fail-safe)");
}

{
  const nativeTrig = (text: string, extra: Record<string, unknown> = {}) => ({ id: "m1", author: "u", authorId: "U1", sentAt: "2026-07-10T10:00:00.000Z", text, ...extra });
  const direct = renderWake(discordNativeWake({ channelId: "c1", isThread: false, isDm: false, addressing: "direct", trigger: nativeTrig("do the thing", { trust: "principal" }) })).message;
  ok(direct === "do the thing", "render: direct address (mention/DM) passes straight through (trusted user input, W4)");
  const woke = renderWake(discordNativeWake({ channelId: "c1", isThread: false, isDm: false, addressing: "thread-follow", trigger: nativeTrig("chatter") })).message;
  ok(woke.includes(NO_REPLY_SENTINEL), "render: non-direct wake carries the NO_REPLY judge preamble");
  ok(woke.includes("<untrusted_external_data") && woke.includes("chatter"), "render: non-direct wake FENCES the untrusted body (P0-3), never raw pass-through");
  ok(woke.includes("<wake reason=") && woke.startsWith("[thread-follow]"), "render: non-direct wake now carries the FULL wake envelope + canonical preamble (commit 3 convergence)");
}

{
  const stripNum = (p: string): string => p.replace(/^\[\d+\/\d+\]\n/, "");
  const numbered = (p: string): boolean => /^\[\d+\/\d+\]\n/.test(p);
  const fenceCount = (p: string): number => p.split("\n").filter((l) => /^\s*```/.test(l)).length;

  ok(splitForDiscord("short").length === 1, "split: short text is one chunk");
  ok(splitForDiscord("a".repeat(2000)).length === 1, "split: exactly 2000 chars is one chunk (no split)");
  const p2001 = splitForDiscord("a".repeat(2001));
  ok(p2001.length === 2, "split: 2001 chars → exactly two parts");
  ok(p2001.every((p) => p.length <= 2000), "split: both parts within the 2000 cap");
  ok(!numbered(p2001[0]), "split: a two-part reply is NOT numbered");

  const long = "a".repeat(4100);
  const parts = splitForDiscord(long);
  ok(parts.every((p) => p.length <= 2000), "split: no chunk exceeds 2000 chars");
  ok(parts.map(stripNum).join("") === long, "split: hard-split loses no content");

  const nl = "x".repeat(1500) + "\n" + "y".repeat(1500);
  const p2 = splitForDiscord(nl);
  ok(p2.length === 2 && p2[0] === "x".repeat(1500) && p2[1] === "y".repeat(1500), "split: prefers the newline boundary (boundary char dropped)");

  const big = "a".repeat(5000);
  const bp = splitForDiscord(big);
  ok(bp.length >= 3, "split: 5000 chars → 3+ parts");
  ok(bp.every(numbered), "split: 3+ parts each carry a [i/N] header");
  ok(bp[0].startsWith("[1/" + bp.length + "]\n"), "split: header numbers from 1 and knows the total");
  ok(bp.every((p) => p.length <= 2000), "split: numbered parts still fit the cap (header reserved)");
  ok(bp.map(stripNum).join("") === big, "split: numbered split preserves every content char");

  const prose = "Hello there. ".repeat(200);
  const sp = splitForDiscord(prose);
  ok(sp.length === 2, "split: prose (no newlines) splits into two");
  ok(stripNum(sp[0]).trimEnd().endsWith("."), "split: prose cuts on a sentence boundary, keeping the period");

  const code = "```ts\n" + "const x = 1;\n".repeat(220) + "```";
  const cp = splitForDiscord(code);
  ok(cp.length >= 2, "split: an over-cap fenced block spans multiple parts");
  ok(cp.every((p) => p.length <= 2000), "split: fenced parts fit the cap");
  ok(cp.every((p) => fenceCount(p) % 2 === 0), "split: every part has BALANCED fences (never a dangling ```)");
  ok(cp.slice(1).every((p) => stripNum(p).startsWith("```ts")), "split: continuation parts RE-OPEN the fence with its language");
  const codeLines = cp.map((p) => (p.match(/const x = 1;/g) ?? []).length).reduce((a, b) => a + b, 0);
  ok(codeLines === 220, "split: no code line is lost across the fence seams");

  const bigParts = splitForDiscord("w".repeat(6100));
  const smallParts = splitForDiscord("w".repeat(2500));
  ok(smallParts.length < bigParts.length, "split: shorter text → fewer parts (an update trims the tail parts)");
  ok(splitForDiscord("w".repeat(1900)).length === 1, "split: an update that shrinks under the cap collapses to one part");
}

{
  const origFetch = globalThis.fetch;
  const origToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  const bodies: Array<{ content: string; message_reference?: { message_id: string } }> = [];
  let seq = 0;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    seq += 1;
    return { ok: true, json: async () => ({ id: `msg-${seq}` }) };
  }) as unknown as typeof fetch;
  try {
    const oneId = await discordPostMessage("chan", "hello", { replyToMessageId: "trigger" });
    ok(bodies.length === 1, "post: within-cap content posts exactly once");
    ok(oneId === "msg-1", "post: returns the posted message id");
    ok(bodies[0].message_reference?.message_id === "trigger", "post: anchors the reply to the trigger");

    bodies.length = 0;
    seq = 0;
    const bigReply = "b".repeat(5000);
    const firstId = await discordPostMessage("chan", bigReply, { replyToMessageId: "trigger" });
    const expectedParts = splitForDiscord(bigReply).length;
    ok(bodies.length === expectedParts, `post: over-cap reply posts all ${expectedParts} parts`);
    ok(firstId === "msg-1", "post: returns the FIRST part's id (the audit/output anchor)");
    ok(bodies[0].message_reference?.message_id === "trigger", "post: only the first part carries the reply anchor");
    ok(bodies.slice(1).every((b) => b.message_reference === undefined), "post: continuation parts carry NO anchor");
    ok(bodies.every((b) => b.content.length <= 2000), "post: every posted part is within Discord's cap");
  } finally {
    globalThis.fetch = origFetch;
    if (origToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = origToken;
  }
}

{
  ok(shouldAutoThread("0", true) === true, "autothread: base guild text (0) → yes");
  ok(shouldAutoThread("5", true) === true, "autothread: announcement (5) → yes");
  ok(shouldAutoThread("10", true) === false, "autothread: news thread (10) → no");
  ok(shouldAutoThread("11", true) === false, "autothread: public thread (11) → no");
  ok(shouldAutoThread("12", true) === false, "autothread: private thread (12) → no");
  ok(shouldAutoThread("1", true) === false, "autothread: DM (1) → no");
  ok(shouldAutoThread("3", true) === false, "autothread: group DM (3) → no");
  ok(shouldAutoThread("15", true) === false, "autothread: forum (15) → no");
  ok(shouldAutoThread(undefined, true) === false, "autothread: unknown type → no (fail-safe)");
  ok(shouldAutoThread("99", true) === false, "autothread: unrecognised type → no");
  ok(shouldAutoThread("0", false) === false, "autothread: disabled → no even for base text");
  ok(shouldAutoThread("5", false) === false, "autothread: disabled → no even for announcement");
}

{
  ok(autoThreadEnabled(undefined) === true, "toggle: unset → on (default)");
  ok(autoThreadEnabled("true") === true, "toggle: 'true' → on");
  ok(autoThreadEnabled("1") === true, "toggle: '1' → on");
  ok(autoThreadEnabled("yes") === true, "toggle: any non-disable value → on");
  ok(autoThreadEnabled("false") === false, "toggle: 'false' → off");
  ok(autoThreadEnabled("0") === false, "toggle: '0' → off");
}

{
  ok(deriveThreadName("<@123456789> deploy the payments service") === "deploy the payments service", "name: strips leading <@id> mention");
  ok(deriveThreadName("<@!123456789> summarise this") === "summarise this", "name: strips leading <@!id> nickname mention");
  ok(deriveThreadName("<@bot>   collapse    the   spaces") === "collapse the spaces", "name: collapses runs of whitespace");
  ok(deriveThreadName("no mention here") === "no mention here", "name: leaves a plain message untouched");

  ok(deriveThreadName("<@123>") === "Conversation with the agent", "name: mention-only → default fallback");
  ok(deriveThreadName("   ") === "Conversation with the agent", "name: whitespace-only → fallback");
  ok(deriveThreadName("<@123>", "Ada") === "Conversation with Ada", "name: fallback uses the provided bot name");

  const long = deriveThreadName("word " + "x".repeat(200));
  ok(long.length <= 100, "name: truncates to ≤100 chars");
  const words = deriveThreadName(Array(60).fill("alpha").join(" "));
  ok(words.length <= 100 && words.endsWith("alpha"), "name: word-boundary truncation keeps whole words + stays ≤100");
  ok(deriveThreadName("z".repeat(150)).length === 100, "name: an unbroken 150-char run hard-cuts to exactly 100");
}

{
  const msg: DiscordRelayMessage = {
    id: "M_trigger",
    content: "<@bot> do the thing",
    channelId: "C_BASE",
    channelType: "0",
    guildId: "G_ACME",
    author: { id: "U_alice", username: "alice", bot: false },
    mentionsBot: true,
  };
  const baseAuth = authForRelayMessage(msg) as OpenEverywhereDiscordAuth;

  const threaded = dispatchSurfaceFor(msg, baseAuth, "T_THREAD");
  ok(threaded.state.channelId === "T_THREAD", "rekey: reply state moves to the thread id");
  ok(threaded.engagementKey === "T_THREAD", "rekey: engagement keys on the thread id");
  ok(threaded.continuationToken === "discord:T_THREAD", "rekey: continuation token scoped to the thread");
  ok(threaded.auth.attributes.channel_id === "T_THREAD", "rekey: identity channel_id = thread id");
  ok(threaded.auth.attributes.channel_type === "11", "rekey: thread auth typed as a public thread (11)");
  ok(threaded.auth.attributes.guild_id === "G_ACME" && threaded.auth.principalId === "U_alice", "rekey: guild + principal preserved");
  const tCtx: BindableContext = { channel: { kind: "discord" }, session: { auth: { current: threaded.auth } } };
  ok(resolvePartition(tCtx).surfaceKey === "discord/G_ACME/T_THREAD", "rekey: thread has its own surfaceKey (silo)");

  const inline = dispatchSurfaceFor(msg, baseAuth, null);
  ok(inline.state.channelId === "C_BASE", "failopen: null thread → reply stays in the base channel");
  ok(inline.engagementKey === "C_BASE", "failopen: null thread → engagement stays on the base channel");
  ok(inline.continuationToken === "discord:C_BASE", "failopen: null thread → base continuation token");
  ok(inline.auth === baseAuth, "failopen: null thread → the original base auth is reused unchanged");
}

{
  ok(statusUxEnabled(undefined) === true, "status-ux: unset → on (default)");
  ok(statusUxEnabled("true") === true, "status-ux: 'true' → on");
  ok(statusUxEnabled("1") === true, "status-ux: '1' → on");
  ok(statusUxEnabled("anything") === true, "status-ux: any non-disable value → on");
  ok(statusUxEnabled("false") === false, "status-ux: 'false' → off");
  ok(statusUxEnabled("0") === false, "status-ux: '0' → off");
}

{
  const postAction = finalMessageAction("stop", "here is the answer");
  const posted = planCompletion({ action: postAction, reactionActive: true });
  ok(posted.reaction === "clear", "plan: postable → remove the 👀 (absence = done; the bot never plants ✅)");
  ok(posted.delivery.kind === "post", "plan: postable → fresh post (never an edit)");
  ok(posted.delivery.kind === "post" && posted.delivery.chunks[0] === "here is the answer", "plan: post carries the reply chunk(s)");

  const long = "a".repeat(2500);
  const multi = planCompletion({ action: finalMessageAction("stop", long), reactionActive: true });
  ok(multi.delivery.kind === "post" && multi.delivery.chunks.length === 2, "plan: an over-2000 reply splits into two post chunks");

  const silent = finalMessageAction("stop", NO_REPLY_SENTINEL);
  const cleared = planCompletion({ action: silent, reactionActive: true });
  ok(cleared.reaction === "clear", "plan: silence → remove 👀 only (no ✅)");
  ok(cleared.delivery.kind === "none", "plan: silence → nothing to deliver");

  const tool = planCompletion({ action: finalMessageAction("tool-calls", null), reactionActive: true });
  ok(tool.reaction === "none" && tool.delivery.kind === "none", "plan: interim tool turn → no reaction, no delivery");

  const untracked = planCompletion({ action: postAction, reactionActive: false });
  ok(untracked.reaction === "none", "plan: untracked turn → no reaction swap");
  ok(untracked.delivery.kind === "post", "plan: untracked turn → plain reply post");
  const untrackedSilent = planCompletion({ action: silent, reactionActive: false });
  ok(untrackedSilent.reaction === "none" && untrackedSilent.delivery.kind === "none", "plan: untracked + silence → nothing, no reaction");

  const carded = planCompletion({ action: postAction, reactionActive: true, cardPostedThisTurn: true });
  ok(carded.delivery.kind === "none", "plan: card posted this turn → model narration suppressed (the card IS the reply)");
  ok(carded.reaction === "clear", "plan: card posted → still counts as answered (👀 clears)");
  const cardedUntracked = planCompletion({ action: postAction, reactionActive: false, cardPostedThisTurn: true });
  ok(cardedUntracked.delivery.kind === "none" && cardedUntracked.reaction === "none", "plan: card posted, untracked → suppressed, reaction untouched");
}

{
  const msg: DiscordRelayMessage = {
    id: "M_trigger",
    content: "<@bot> do the thing",
    channelId: "C_BASE",
    channelType: "0",
    guildId: "G_ACME",
    author: { id: "U_alice", username: "alice", bot: false },
    mentionsBot: true,
  };
  const baseAuth = authForRelayMessage(msg) as OpenEverywhereDiscordAuth;
  const surface = dispatchSurfaceFor(msg, baseAuth, "T_THREAD");

  const state = buildGatewayState({
    replyChannelId: surface.state.channelId,
    original: { channelId: msg.channelId, messageId: msg.id },
  });
  ok(state.channelId === "T_THREAD", "state: reply surface follows the thread re-key");
  ok(state.originalChannelId === "C_BASE", "state: reaction target stays on the ORIGINAL (base) channel");
  ok(state.originalMessageId === "M_trigger", "state: reaction target stays on the ORIGINAL trigger message");

  const off = buildGatewayState({ replyChannelId: "C_BASE", original: undefined });
  ok(off.originalChannelId === undefined && off.originalMessageId === undefined, "state: no thread/UX off → no reaction coords (no swap)");
  ok(off.channelId === "C_BASE", "state: no thread/UX off → base reply surface");
}

{
  const state = new Map<string, number>();
  ok(typingRefreshDue("C1", 1_000, state) === true, "typing: first trigger for a channel is due");
  ok(typingRefreshDue("C1", 3_000, state) === false, "typing: 2s later — indicator still fresh, not due");
  ok(typingRefreshDue("C2", 3_000, state) === true, "typing: another channel throttles independently");
  ok(typingRefreshDue("C1", 8_100, state) === true, "typing: past the refresh window — due again");
  ok(typingRefreshDue("C1", 8_200, state) === false, "typing: the refire reset the clock");
}

{
  const gates = new Set<string>();
  ok(typingGateOpen("C1", gates) === true, "gate: fresh channel — open (addressed turns unaffected)");
  ok(typingGateFeed("C1", "anything", gates) === true, "gate: feeding an ungated channel is a no-op (open)");

  closeTypingGate("C1", gates);
  ok(typingGateOpen("C1", gates) === false, "gate: closed at judged dispatch — no typing");
  ok(typingGateOpen("C2", gates) === true, "gate: channels are independent");
  ok(typingGateFeed("C1", "", gates) === false, "gate: empty stream — undecided, hold");
  ok(typingGateFeed("C1", "  NO", gates) === false, "gate: sentinel prefix (leading whitespace trimmed) — still undecided, hold");
  ok(typingGateFeed("C1", "NO_REP", gates) === false, "gate: longer sentinel prefix — hold");
  ok(typingGateFeed("C1", "NO_REPLY", gates) === false, "gate: the sentinel itself — judged silence, hold forever");
  ok(typingGateFeed("C1", "NO_REPLY — they're talking among themselves", gates) === false, "gate: sentinel + trailing text is still swallowed by isNoReply — hold");
  ok(typingGateOpen("C1", gates) === false, "gate: a silent turn never opens its gate");

  ok(typingGateFeed("C1", "Sure! What do you need?", gates) === true, "gate: text deviating from the sentinel proves a reply — opens");
  ok(typingGateOpen("C1", gates) === true, "gate: once proven, stays open for the rest of the turn");
  ok(typingGateFeed("C1", "NO_REPLY", gates) === true, "gate: after opening, later chunks can never re-close it");

  closeTypingGate("C1", gates);
  ok(typingGateFeed("C1", "no_reply", gates) === true, "gate: lowercase is NOT the sentinel (isNoReply is case-sensitive → it WOULD post) — opens");

  closeTypingGate("C1", gates);
  ok(typingGateFeed("C1", "  Yes, I'm here!", gates) === true, "gate: leading whitespace before a real reply still opens (trimStart mirror)");

  closeTypingGate("C1", gates);
  openTypingGate("C1", gates);
  ok(typingGateOpen("C1", gates) === true, "gate: openTypingGate clears (turn end / addressed dispatch reset)");
}

{
  const state = buildGatewayState({
    replyChannelId: "T_THREAD",
    original: { channelId: "C_BASE", messageId: "M_trigger" },
  });

  const first = takeTurnStatus(state);
  ok(first.original?.channelId === "C_BASE" && first.original?.messageId === "M_trigger", "take: returns the reaction coords");
  ok(state.originalChannelId === undefined && state.originalMessageId === undefined, "take: CLEARS the coords (consume-once)");
  ok(state.channelId === "T_THREAD", "take: leaves the session-stable reply surface untouched");

  const second = takeTurnStatus(state);
  ok(second.original === undefined, "take: second consume is empty — turn 2 can never see turn 1's message");

  const partial = buildGatewayState({ replyChannelId: "C" });
  partial.originalChannelId = "C_BASE";
  ok(takeTurnStatus(partial).original === undefined, "take: partial coords → no reaction target (fail-safe)");
}

{
  const msg: DiscordRelayMessage = {
    id: "M9",
    content: "<@bot> hi",
    channelId: "C_BASE2",
    channelType: "0",
    guildId: "G2",
    author: { id: "U2", bot: false },
    mentionsBot: true,
  };
  const baseAuth = authForRelayMessage(msg) as OpenEverywhereDiscordAuth;
  const inline = dispatchSurfaceFor(msg, baseAuth, null);
  const state = buildGatewayState({
    replyChannelId: inline.state.channelId,
    original: { channelId: msg.channelId, messageId: msg.id },
  });
  ok(state.channelId === "C_BASE2" && state.originalChannelId === "C_BASE2" && state.originalMessageId === "M9", "state: inline reply — reaction + reply both on the base channel/trigger message");
}

{
  ok(isThreadChannelType("10") && isThreadChannelType("11") && isThreadChannelType("12"), "grain: 10/11/12 are threads");
  ok(!isThreadChannelType("0") && !isThreadChannelType("5") && !isThreadChannelType("1") && !isThreadChannelType(undefined), "grain: base/announcement/DM/unknown are not threads");

  const msg: DiscordRelayMessage = {
    id: "M_g1",
    content: "<@bot> cap this channel",
    channelId: "C_BASE3",
    channelType: "0",
    guildId: "G3",
    author: { id: "U3", bot: false },
    mentionsBot: true,
  };
  const baseAuth = authForRelayMessage(msg) as OpenEverywhereDiscordAuth;
  const threaded = dispatchSurfaceFor(msg, baseAuth, "T_NEW");
  ok(threaded.auth.attributes.parent_channel_id === "C_BASE3", "grain: auto-thread re-key stamps the base channel as parent (free — no REST)");
  const tCtx: BindableContext = { channel: { kind: "discord" }, session: { auth: { current: threaded.auth } } };
  const p = resolvePartition(tCtx);
  ok(p.surfaceKey === "discord/G3/T_NEW", "grain: conversational surfaceKey stays the thread");
  ok(p.domainKey === "discord/G3/C_BASE3", "grain: domainKey = the parent channel (domain + spend scope)");
  ok(domainKeyOf(p) === "discord/G3/C_BASE3", "grain: domainKeyOf reads the parent grain");
  const inline = dispatchSurfaceFor(msg, baseAuth, null);
  ok(inline.auth.attributes.parent_channel_id === undefined, "grain: inline path stamps no parent");
  const ip = resolvePartition({ channel: { kind: "discord" }, session: { auth: { current: inline.auth } } });
  ok(domainKeyOf(ip) === ip.surfaceKey, "grain: no parent → domainKeyOf falls back to the surfaceKey");
}

{
  clearDiscordInfoCacheForTest();
  let calls = 0;
  const fakeFetch = (async (url: string | URL | Request) => {
    calls++;
    const u = String(url);
    if (u.endsWith("/channels/T_THREAD")) {
      return new Response(JSON.stringify({ name: "cap this channel", type: 11, parent_id: "C_PARENT" }), { status: 200 });
    }
    if (u.endsWith("/channels/C_PARENT")) {
      return new Response(JSON.stringify({ name: "eng", type: 0, parent_id: "CAT_1" }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const deps = { fetchFn: fakeFetch, token: "test-token" };

  ok((await threadParentChannelId("T_THREAD", deps)) === "C_PARENT", "info: thread → parent channel id");
  ok((await threadParentChannelId("C_PARENT", deps)) === undefined, "info: base channel → no parent (category ignored)");
  ok((await threadParentChannelId("C_MISSING", deps)) === undefined, "info: REST failure → undefined (fail-open to thread grain)");
  const before = calls;
  await threadParentChannelId("T_THREAD", deps);
  ok(calls === before, "info: verdicts are cached — a repeat lookup pays no fetch");
  clearDiscordInfoCacheForTest();
  const noNet = (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
  ok((await threadParentChannelId("T_THREAD", { fetchFn: noNet, token: undefined })) === undefined, "info: no bot token → undefined, no network call");
  clearDiscordInfoCacheForTest();
}

{
  ok(parseDriverAllowlist(undefined).size === 0, "driver: no env → empty allowlist (default off)");
  ok(parseDriverAllowlist("").size === 0, "driver: empty env → empty allowlist");
  const list = parseDriverAllowlist("123:456, 789:012");
  ok(list.has("123:456") && list.has("789:012") && list.size === 2, "driver: comma-separated guild:bot pairs parse");
  ok(parseDriverAllowlist("456").size === 0, "driver: a bare id (no guild pin) is DISCARDED — no bot-everywhere syntax");
  ok(parseDriverAllowlist(":456").size === 0 && parseDriverAllowlist("123:").size === 0, "driver: empty halves are discarded");
  ok(parseDriverAllowlist("g1:bot1").size === 0, "driver: non-snowflake ids are discarded (digits only)");
  ok(parseDriverAllowlist("123:456,garbage,:,999:888").size === 2, "driver: malformed entries drop without poisoning valid ones");

  const mixed = parseDriverAllowlist("123:456,T0EXAMPLE:B0EXBOT0001");
  ok(mixed.has("T0EXAMPLE:B0EXBOT0001") && mixed.has("123:456") && mixed.size === 2, "driver: Slack teamId:botId parses alongside Discord pairs");
  ok(parseDriverAllowlist("t0example:b0exbot0001").size === 0, "driver: lowercase Slack ids are discarded (exact Slack id shape only)");
  ok(parseDriverAllowlist("T0EXAMPLE:U0EXOWNER").size === 0, "driver: a Slack USER id (U…) is discarded — vouch the app's bot record, never a human");
  ok(parseDriverAllowlist("T0EXAMPLE:xoxp-123").size === 0, "driver: token-shaped garbage is discarded");
  ok(isAllowedSlackDriver("T0EXAMPLE", "B0EXBOT0001", mixed) === true, "driver: exact Slack team+bot match accepted");
  ok(isAllowedSlackDriver("T9OTHER", "B0EXBOT0001", mixed) === false, "driver: right Slack bot in the WRONG team → dropped (team pin holds)");
  ok(isAllowedSlackDriver("T0EXAMPLE", "B9OTHER", mixed) === false, "driver: wrong Slack bot in the right team → dropped");
  ok(isAllowedSlackDriver(undefined, "B0EXBOT0001", mixed) === false, "driver: no team id never matches");
  ok(isAllowedSlackDriver("T0EXAMPLE", undefined, mixed) === false, "driver: a message with NO bot_id is not a driver question at all");

  ok(isAllowedDriver("123", "456", list) === true, "driver: exact guild+bot match accepted");
  ok(isAllowedDriver("123", "999", list) === false, "driver: wrong bot in the right guild → dropped");
  ok(isAllowedDriver("999", "456", list) === false, "driver: right bot in the WRONG guild → dropped (guild pin holds)");
  ok(isAllowedDriver(undefined, "456", list) === false, "driver: no guild (a DM) never matches");
  ok(isAllowedDriver("123", "456", new Set()) === false, "driver: empty allowlist → unconditional bot drop (today's behaviour)");

  const prevEnv = process.env.OE_TEST_DRIVER_IDS;
  process.env.OE_TEST_DRIVER_IDS = "555:777";
  const driverMsg = parseRelayPayload(
    relayEnvelope({ id: "m9", content: "hi", channelId: "C9", guildId: "555", author: { id: "777", bot: true } }),
  );
  ok(driverMsg !== null && authForRelayMessage(driverMsg) !== null, "driver: allowlisted bot author builds auth (acts as a user)");
  const otherBot = parseRelayPayload(
    relayEnvelope({ id: "m9", content: "hi", channelId: "C9", guildId: "555", author: { id: "778", bot: true } }),
  );
  ok(otherBot !== null && authForRelayMessage(otherBot) === null, "driver: any OTHER bot still drops while the seam is armed");
  const wrongGuild = parseRelayPayload(
    relayEnvelope({ id: "m9", content: "hi", channelId: "C9", guildId: "556", author: { id: "777", bot: true } }),
  );
  ok(wrongGuild !== null && authForRelayMessage(wrongGuild) === null, "driver: the allowlisted bot outside its pinned guild still drops");
  if (prevEnv === undefined) delete process.env.OE_TEST_DRIVER_IDS;
  else process.env.OE_TEST_DRIVER_IDS = prevEnv;
}

{
  const withBot = parseRelayPayload(
    relayEnvelope({ id: "m1", content: "hi", channelId: "C1", author: { id: "U1", bot: false }, bot: { id: "B1", name: "Test Slack Bot" } }),
  );
  ok(withBot?.botName === "Test Slack Bot", "parse: relayed bot.name surfaces as botName");
  ok(withBot?.botId === "B1", "parse: relayed bot.id surfaces as botId (item-27 attribution field, kept not discarded)");
  const noBot = parseRelayPayload(relayEnvelope({ id: "m1", content: "hi", channelId: "C1", author: { id: "U1", bot: false } }));
  ok(noBot !== null && noBot.botName === undefined, "parse: an older relay (no bot field) parses with botName undefined");
  ok(noBot !== null && noBot.botId === undefined, "parse: an older relay (no bot field) parses with botId undefined");
  const garbageBot = parseRelayPayload(
    relayEnvelope({ id: "m1", content: "hi", channelId: "C1", author: { id: "U1", bot: false }, bot: { id: 42, name: 7 } }),
  );
  ok(garbageBot !== null && garbageBot.botName === undefined, "parse: a garbage bot field degrades to botName undefined (never throws)");
  ok(garbageBot !== null && garbageBot.botId === undefined, "parse: a garbage bot field degrades to botId undefined too");

  const base = {
    mentionsBot: false,
    isDm: false,
    isEngaged: false,
    authorIsBot: false,
    channelType: "0" as string | undefined,
    content: "Test Slack Bot can you check the deploy?",
    botName: "Test Slack Bot" as string | undefined,
  };
  ok(nameDropEligible(base) === true, "name-drop: unengaged guild text channel + name in text is eligible");
  ok(nameDropEligible({ ...base, channelType: "11" }) === true, "name-drop: an UN-engaged thread is eligible (deliberate Slack deviation — threads are Discord's conversation surface)");
  ok(nameDropEligible({ ...base, channelType: "5" }) === true, "name-drop: announcement channels are eligible");
  ok(nameDropEligible({ ...base, mentionsBot: true }) === false, "name-drop: a mention is the mention path's, not eligible");
  ok(nameDropEligible({ ...base, isDm: true, channelType: "1" }) === false, "name-drop: DMs always wake anyway — not eligible");
  ok(nameDropEligible({ ...base, isEngaged: true }) === false, "name-drop: an engaged surface is the engagement path's");
  ok(nameDropEligible({ ...base, authorIsBot: true }) === false, "name-drop: a bot author never triggers (defence in depth)");
  ok(nameDropEligible({ ...base, channelType: "15" }) === false, "name-drop: a forum container is not a conversation surface");
  ok(nameDropEligible({ ...base, channelType: undefined }) === false, "name-drop: unknown channel type fails safe");
  ok(nameDropEligible({ ...base, botName: undefined }) === false, "name-drop: no relayed bot name (older relay) fails closed");
  ok(nameDropEligible({ ...base, content: "unrelated chatter" }) === false, "name-drop: text without the name is not eligible");
  ok(nameDropEligible({ ...base, content: "test slack bot lowercase works" }) === true, "name-drop: the name match is case-insensitive");
  ok(nameDropEligible({ ...base, content: "ATestSlackBotX" }) === false, "name-drop: the name must be a standalone phrase, not a substring");

  const ndTrig = (text: string) => ({ id: "m1", author: "u", authorId: "U1", sentAt: "2026-07-10T10:00:00.000Z", text });
  const turn = renderWake(discordNativeWake({ channelId: "c1", isThread: false, isDm: false, addressing: "name-drop", botName: "Test Slack Bot", trigger: ndTrig("Test Slack Bot help") })).message;
  ok(turn.includes("[name-drop]") && turn.includes('"Test Slack Bot"'), "name-drop turn: preamble names the trigger");
  ok(turn.includes(NO_REPLY_SENTINEL), "name-drop turn: carries the NO_REPLY escape");
  ok(turn.includes("NOT following this channel"), "name-drop turn (base channel): honest that a reply does not engage");
  ok(turn.includes("Test Slack Bot help") && turn.includes("<untrusted_external_data"), "name-drop turn: the body rides FENCED as untrusted data (P0-3)");
  const threadTurn = renderWake(discordNativeWake({ channelId: "t1", parentChannelId: "c1", isThread: true, isDm: false, addressing: "name-drop", botName: "Bot", trigger: ndTrig("help") })).message;
  ok(threadTurn.includes("now following this thread"), "name-drop turn (thread): says the thread IS followed (engaged at dispatch)");
  ok(threadTurn.includes("stand_down"), "name-drop turn (thread): names the stand_down VERB as the undo (OPE-418 — the line used to promise a magic word, which is now false)");
  ok(!threadTurn.includes("NOT following"), "name-drop turn (thread): no contradictory not-following note");

  ok(stripLeadingMention("<@123> stop") === "stop", "stripLeadingMention: bare mention prefix removed");
  ok(stripLeadingMention("<@!99>  stop following") === "stop following", "stripLeadingMention: nickname-form mention + extra space removed");
  ok(stripLeadingMention("stop") === "stop", "stripLeadingMention: no mention → unchanged");
  ok(stripLeadingMention("hey <@123> stop") === "hey <@123> stop", "stripLeadingMention: only a LEADING mention is stripped");
}

{
  const src = readFileSync(fileURLToPath(new URL("../packages/providers/discord/agent/channels/discord-gateway.ts", import.meta.url)), "utf8");
  const gateAt = src.indexOf("await ingressSpendGate(");
  const divertAt = src.indexOf("await divertDiscordWakeToUnifiedWindow(");
  ok(gateAt > 0, "spend-gate order: the ingress calls the SHARED gate (ingressSpendGate), not a hand-rolled copy");
  ok(divertAt > 0, "spend-gate order: the ingress still has a single-window divert to order against");
  ok(gateAt < divertAt, "spend-gate order: the spend gate runs BEFORE the single-window divert — a windowed Discord wake is never diverted ungated");
  ok(
    /=== "declined"\s*\)\s*\{\s*return;/.test(src.slice(gateAt, divertAt)),
    'spend-gate order: a "declined" verdict RETURNS (drops the wake) rather than falling through to the divert',
  );
}

console.log(`✓ discord-gateway: ${passed} assertions passed (HMAC fail-closed, payload→identity, bot drop, wake gate incl. DM + name-drop, reply split, auto-thread decision + toggle + naming + fail-open re-key, status-UX toggle + completion plan + consume-once turn status, thread→parent grain + channel-info cache)`);
