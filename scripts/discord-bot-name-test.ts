import assert from "node:assert/strict";
import {
  discordBotDisplayNameViaRest,
  discordBotDisplayName,
  _resetDiscordBotDisplayNameForTest,
  type DiscordSelfRequester,
} from "@open-everywhere/provider-discord/agent/channels/discord-bot-name.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

function spy(answer: unknown): { req: DiscordSelfRequester; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    req: async () => {
      calls.push(1);
      return answer;
    },
  };
}

{
  const { req } = spy({ username: "oe_bot", global_name: "Open Everywhere" });
  const name = await discordBotDisplayNameViaRest(req);
  eq(name, "Open Everywhere", "🔴 global_name wins over username when both are present");
}

{
  eq(await discordBotDisplayNameViaRest(spy({ username: "oe_bot", global_name: null }).req), "oe_bot", "a null global_name falls back to username — the shape almost every bot account is in");
  eq(await discordBotDisplayNameViaRest(spy({ username: "oe_bot" }).req), "oe_bot", "an absent global_name field falls back to username");
  eq(await discordBotDisplayNameViaRest(spy({ username: "oe_bot", global_name: "   " }).req), "oe_bot", "a whitespace-only global_name falls back to username, not a blank handle");
}

{
  eq(await discordBotDisplayNameViaRest(spy({ username: "  oe_bot  " }).req), "oe_bot", "a padded username is trimmed");
  eq(await discordBotDisplayNameViaRest(spy({ username: "", global_name: "" }).req), undefined, "both fields blank reads undefined");
  eq(await discordBotDisplayNameViaRest(spy({ username: 42, global_name: null }).req), undefined, "🔴 a NON-STRING username reads undefined — the arm never renders a coerced value");
  eq(await discordBotDisplayNameViaRest(spy(null).req), undefined, "a null body reads undefined");
  eq(await discordBotDisplayNameViaRest(spy("not json").req), undefined, "a non-object body reads undefined");
  eq(await discordBotDisplayNameViaRest(spy({ id: "123" }).req), undefined, "a response with neither field reads undefined");
}

{
  const boom: DiscordSelfRequester = async () => {
    throw new Error("bot-display-name: Discord GET /users/@me failed (HTTP 401).");
  };
  eq(await discordBotDisplayNameViaRest(boom), undefined, "🔴 a THROWING request reads undefined — a handle lookup can never fail instruction assembly");
}

{
  delete process.env.DISCORD_BOT_TOKEN;
  _resetDiscordBotDisplayNameForTest();

  const first = discordBotDisplayName();
  const second = discordBotDisplayName();
  ok(first === second, "🔴 the live arm returns the SAME memoised promise on a second call — one resolution per instance, not one per turn");
  eq(await first, undefined, "…and an unconfigured deployment (no bot token) resolves undefined, never a throw into instruction assembly");

  _resetDiscordBotDisplayNameForTest();
  ok(discordBotDisplayName() !== first, "_resetDiscordBotDisplayNameForTest drops the memo, so one test cannot inherit another's");
}

console.log(`discord-bot-name-test: ${n} assertions passed`);
