import assert from "node:assert/strict";
import { lookUpDiscordInvite } from "@open-everywhere/provider-discord/agent/channels/discord-invite.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const GUILD = "111111111111111111";
const VOICE = "222222222222222222";

function fakeFetch(status: number, body: unknown, seen: { url?: string; auth?: string } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.url = String(input);
    seen.auth = new Headers(init?.headers).get("authorization") ?? undefined;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

{
  const seen: { url?: string; auth?: string } = {};
  const r = await lookUpDiscordInvite("aB-c/1", { token: "tkn", fetchFn: fakeFetch(200, { type: 0, guild: { id: GUILD }, channel: { id: VOICE, type: 2 } }, seen) });
  ok(seen.url === "https://discord.com/api/v10/invites/aB-c%2F1", `the lookup asks the invite endpoint with the code encoded (asked ${seen.url})`);
  ok(seen.auth === "Bot tkn", "the lookup sends the bot token in the authorization header");
  ok(r.found === true && r.guildId === GUILD && r.channelId === VOICE && r.channelKind === "voice", "a type-2 channel is a VOICE channel with its server and channel ids");
}
{
  const stage = await lookUpDiscordInvite("abc12", { token: "t", fetchFn: fakeFetch(200, { guild: { id: GUILD }, channel: { id: VOICE, type: 13 } }) });
  ok(stage.found === true && stage.channelKind === "stage", "a type-13 channel is a STAGE channel");
  const text = await lookUpDiscordInvite("abc12", { token: "t", fetchFn: fakeFetch(200, { guild: { id: GUILD }, channel: { id: VOICE, type: 0 } }) });
  ok(text.found === true && text.channelKind === "other", "a text channel is OTHER, never voice (negative control)");
}

{
  const unknown = await lookUpDiscordInvite("gone1", { token: "t", fetchFn: fakeFetch(404, { code: 10006, message: "Unknown Invite" }) });
  ok(unknown.found === false && unknown.why === "unknown", "a 404 is an UNKNOWN invite (expired, revoked or mistyped)");
  const limited = await lookUpDiscordInvite("abc12", { token: "t", fetchFn: fakeFetch(429, {}) });
  ok(limited.found === false && limited.why === "unreachable", "a 429 is UNREACHABLE, not unknown");
  const thrown = await lookUpDiscordInvite("abc12", { token: "t", fetchFn: (async () => { throw new Error("network"); }) as unknown as typeof fetch });
  ok(thrown.found === false && thrown.why === "unreachable", "a network error is UNREACHABLE, and the lookup does not throw");
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  let called = false;
  const noToken = await lookUpDiscordInvite("abc12", { fetchFn: (async () => { called = true; return new Response("{}"); }) as typeof fetch });
  if (savedToken !== undefined) process.env.DISCORD_BOT_TOKEN = savedToken;
  ok(noToken.found === false && noToken.why === "unreachable" && called === false, "with no bot token the lookup makes no request and reads as unreachable");
  const friend = await lookUpDiscordInvite("abc12", { token: "t", fetchFn: fakeFetch(200, { type: 2, inviter: { id: "1" } }) });
  ok(friend.found === false && friend.why === "no-channel", "an invite with no server channel (a friend invite) is NO-CHANNEL");
  const bad = await lookUpDiscordInvite("abc12", { token: "t", fetchFn: fakeFetch(200, { guild: { id: "12" }, channel: { id: VOICE, type: 2 } }) });
  ok(bad.found === false && bad.why === "no-channel", "an answer with a malformed server id is refused, never repaired");
}

{
  const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
  const { resolveMeetingLink } = await import("@open-everywhere/core/agent/meetings/invite.js");
  const before = await resolveMeetingLink("https://discord.gg/abc12");
  ok(!before.ok && before.reason.includes("no Discord connection"), "before the provider registers, an invite is refused with the no-connection reason");
  registerDiscordProvider();
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  const after = await resolveMeetingLink("https://discord.gg/abc12");
  if (savedToken !== undefined) process.env.DISCORD_BOT_TOKEN = savedToken;
  ok(!after.ok && after.reason.includes("couldn't reach Discord"), `🔴 after registerDiscordProvider() the invite reaches the Discord lookup (no token here, so it reads unreachable; got: ${after.ok ? "ok" : after.reason})`);
}

console.log(`✓ discord-invite: ${n} assertions passed`);
