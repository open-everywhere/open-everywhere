import { createHmac } from "node:crypto";
import {
  relayGate,
  parseRelayPayload,
  authForRelayMessage,
  shouldDispatchDiscord,
  isDmChannel,
  renderTurn,
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
  type DiscordRelayMessage,
} from "../agent/channels/discord-gateway.js";
import { bindFrom, type BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { finalMessageAction, NO_REPLY_SENTINEL } from "../agent/channels/slack-events.js";
import type { OpenEverywhereDiscordAuth } from "../agent/channels/discord-identity.js";

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
  ok(renderTurn(true, "do the thing") === "do the thing", "render: direct address (mention/DM) passes straight through (trusted user input)");
  const woke = renderTurn(false, "chatter");
  ok(woke.includes(NO_REPLY_SENTINEL) && woke.endsWith("chatter"), "render: non-direct wake carries the NO_REPLY judge preamble + content");
}

{
  ok(splitForDiscord("short").length === 1, "split: short text is one chunk");

  const long = "a".repeat(4100);
  const parts = splitForDiscord(long);
  ok(parts.every((p) => p.length <= 2000), "split: no chunk exceeds 2000 chars");
  ok(parts.join("") === long, "split: hard-split loses no content");

  const nl = "x".repeat(1500) + "\n" + "y".repeat(1500);
  const p2 = splitForDiscord(nl);
  ok(p2.length === 2 && p2[0] === "x".repeat(1500) && p2[1] === "y".repeat(1500), "split: prefers the newline boundary");
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

console.log(`✓ discord-gateway: ${passed} assertions passed (HMAC fail-closed, payload→identity, bot drop, wake gate incl. DM, reply split, auto-thread decision + toggle + naming + fail-open re-key, status-UX toggle + completion plan + consume-once turn status)`);
