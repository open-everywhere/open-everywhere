import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

_setDeploymentIdentityForTest({ org: "acme" });
process.env.DISCORD_BOT_TOKEN = "fixture-bot-token-not-a-secret";

const GUILD_A = "G_ALPHA";
const GUILD_B = "G_BETA";

type Member = { nick?: unknown; user?: { id?: unknown; username?: unknown; global_name?: unknown; bot?: unknown } };

const rosters = new Map<string, Member[]>();
const forbiddenGuilds = new Set<string>();

const searchCalls: { guild: string; query: string; limit: string }[] = [];
const directReads: { guild: string; userId: string }[] = [];
const dmOpens: { recipientId: string }[] = [];
const dmPosts: { channel: string; content: string }[] = [];
let dmOpenStatus = 200;

type StubRes = { ok: boolean; status: number; json: () => Promise<unknown> };
const res = (status: number, body: unknown): StubRes => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function matches(m: Member, q: string): boolean {
  const fields = [typeof m.nick === "string" ? m.nick : "", typeof m.user?.username === "string" ? m.user.username : ""];
  return fields.some((f) => f.length > 0 && f.toLowerCase().startsWith(q.toLowerCase()));
}

const fakeDiscordFetch = (async (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api\/v\d+/, "");

  const search = /^\/guilds\/([^/]+)\/members\/search$/.exec(path);
  if (search && method === "GET") {
    const guild = search[1]!;
    const query = url.searchParams.get("query") ?? "";
    searchCalls.push({ guild, query, limit: url.searchParams.get("limit") ?? "" });
    if (forbiddenGuilds.has(guild)) return res(403, { message: "Missing Access" });
    return res(200, (rosters.get(guild) ?? []).filter((m) => matches(m, query)));
  }

  const member = /^\/guilds\/([^/]+)\/members\/([^/]+)$/.exec(path);
  if (member && method === "GET") {
    const [, guild, userId] = member as unknown as [string, string, string];
    directReads.push({ guild, userId });
    if (forbiddenGuilds.has(guild)) return res(403, { message: "Missing Access" });
    const hit = (rosters.get(guild) ?? []).find((m) => m.user?.id === userId);
    return hit ? res(200, hit) : res(404, { message: "Unknown Member" });
  }

  if (path === "/users/@me/channels" && method === "POST") {
    const recipientId = String(JSON.parse(init?.body ?? "{}").recipient_id ?? "");
    dmOpens.push({ recipientId });
    if (dmOpenStatus !== 200) return res(dmOpenStatus, { message: "Cannot send messages to this user" });
    return res(200, { id: `DM_${recipientId}` });
  }

  const create = /^\/channels\/([^/]+)\/messages$/.exec(path);
  if (create && method === "POST") {
    dmPosts.push({ channel: create[1]!, content: String(JSON.parse(init?.body ?? "{}").content ?? "") });
    return res(200, { id: `msg-${dmPosts.length}` });
  }

  return res(404, {});
}) as unknown as typeof fetch;

await withPatchedFetch(fakeDiscordFetch, async () => {

const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const { hasAccountDirectory, lookupAccountDirectory } = await import("@open-everywhere/core/agent/identity/account-directory.js");
const { canDeliverDirectMessage, dispatchDirectMessage } = await import("@open-everywhere/core/agent/channels/post-arms.js");

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", reach: [`discord/${GUILD_A}/C_ONE`, `discord/${GUILD_B}/C_TWO`] })],
  loadSilos: () => [],
  domainsForSurface: () => ["payments"],
});

ok(hasAccountDirectory("discord") === false, "§1 negative control: no discord account directory is registered before the provider boots");
ok(canDeliverDirectMessage("discord") === false, "§1 negative control: no discord DM arm is registered before the provider boots");

const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
registerDiscordProvider();

ok(hasAccountDirectory("discord") === true, "🔴 §1 REACHABILITY: registerDiscordProvider() registers the account-directory arm — a correct arm nobody registers is dead code");
ok(canDeliverDirectMessage("discord") === true, "🔴 §1 REACHABILITY: registerDiscordProvider() registers the DM-delivery arm — the directory transport needs BOTH");

{
  rosters.set(GUILD_A, [
    { nick: "Ali from payments", user: { id: "U_ALICE", username: "alice", global_name: "Alice Ashton" } },
    { nick: "alicebot", user: { id: "U_BOT", username: "alicebot", bot: true } },
    { user: { id: "   ", username: "aliceblank" } },
    { user: { id: "U_BOB", username: "bob" } },
  ]);
  rosters.set(GUILD_B, [{ nick: "ali", user: { id: "U_ALICE", username: "alice", global_name: "Alice Ashton" } }]);
  searchCalls.length = 0;

  const found = await lookupAccountDirectory("discord", "@ali");

  ok(searchCalls.length === 2, "§2 one search call per DECLARED guild — the guild set is the config's, not every server the bot is in");
  ok(searchCalls.every((c) => c.query === "ali"), "🔴 §2 the leading `@` is stripped before Discord sees the query — a person types their handle the way they see it written, and Discord would match `@ali` against nothing");
  ok(searchCalls.every((c) => c.limit === "25"), "§2 the per-guild limit is sent — core caps the ANSWER at 8 after ranking, so the arm must not be truncated below that first");

  const ids = found.candidates.map((c) => c.nativeId).sort();
  ok(ids.join(",") === "U_ALICE", "🔴 §2 one person in two guilds is ONE candidate, and the bot, the blank id and the non-matching member are all absent");
  const alice = found.candidates.find((c) => c.nativeId === "U_ALICE")!;
  ok(alice.name === "Ali from payments", "§2 the guild NICKNAME lands as `name` — it is the name the people in that server actually see, so it is the name the initiator types");
  ok(alice.handle === "alice", "§2 the global username lands as `handle`");
  ok(found.candidates.every((c) => c.nativeId !== "U_BOT"), "🔴 §2 negative control: a BOT that matches the query is dropped — a link is a statement about a human, and the consent DM would go to something that can never answer");
}

{
  const SNOWFLAKE = "123456789012345678";
  rosters.set(GUILD_A, [{ user: { id: SNOWFLAKE, username: "carol", global_name: "Carol" } }]);
  rosters.set(GUILD_B, []);
  searchCalls.length = 0;
  directReads.length = 0;

  const found = await lookupAccountDirectory("discord", SNOWFLAKE);

  ok(directReads.length === 2, "§3 a snowflake-shaped query also does the DIRECT member read in each guild — Discord's search matches names, never ids");
  ok(found.candidates.length === 1 && found.candidates[0]!.nativeId === SNOWFLAKE, "🔴 §3 pasting a raw account id finds exactly that account — the search alone would have answered nothing");
  ok(directReads.some((r) => r.guild === GUILD_B), "§3 the guild where the id is NOT a member is still asked, and its 404 costs the answer nothing");

  directReads.length = 0;
  await lookupAccountDirectory("discord", "carol");
  ok(directReads.length === 0, "🔴 §3 negative control: a NAME query does no direct-id read — the branch is shape-gated, not always-on");
}

{
  rosters.set(GUILD_A, [{ user: { id: "U_HIDDEN", username: "dave" } }]);
  rosters.set(GUILD_B, [{ user: { id: "U_SEEN", username: "dave2" } }]);
  forbiddenGuilds.add(GUILD_A);

  const found = await lookupAccountDirectory("discord", "dave");

  ok(found.candidates.length === 1 && found.candidates[0]!.nativeId === "U_SEEN", "🔴 §4 a 403 guild contributes nothing and the OTHER guild still answers — one refused server must not delete the whole directory");
  ok(found.candidates.every((c) => c.nativeId !== "U_HIDDEN"), "§4 negative control: the refused guild's member is genuinely absent, not merely unranked");

  forbiddenGuilds.add(GUILD_B);
  const none = await lookupAccountDirectory("discord", "dave");
  ok(none.candidates.length === 0, "🔴 §4 every guild refusing resolves to an EMPTY directory, never a throw — linking degrades to the code flow rather than failing the person's turn");
  forbiddenGuilds.clear();
}

{
  rosters.set(GUILD_A, [{ user: { id: "U_ANY", username: "erin" } }]);
  rosters.set(GUILD_B, []);

  searchCalls.length = 0;
  const blank = await lookupAccountDirectory("discord", "   ");
  ok(blank.candidates.length === 0 && searchCalls.length === 0, "§5 an empty query makes no Discord call and matches nobody");

  const token = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  searchCalls.length = 0;
  const noToken = await lookupAccountDirectory("discord", "erin");
  ok(noToken.candidates.length === 0 && searchCalls.length === 0, "§5 no bot token ⇒ no call and no rows — never a throw on a person's turn");
  process.env.DISCORD_BOT_TOKEN = token;

  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "slack-only", reach: ["slack/T1/C1"] })],
    loadSilos: () => [],
    domainsForSurface: () => ["slack-only"],
  });
  searchCalls.length = 0;
  const noGuilds = await lookupAccountDirectory("discord", "erin");
  ok(noGuilds.candidates.length === 0 && searchCalls.length === 0, "🔴 §5 a config declaring no Discord guild searches NOTHING — the arm can never surface a member of some unrelated server the bot happens to be in");
}

{
  dmOpens.length = 0;
  dmPosts.length = 0;

  const delivery = await dispatchDirectMessage("discord", { principalId: "U_TARGET", text: "somebody asked me to link your account" });

  ok(dmOpens.length === 1 && dmOpens[0]!.recipientId === "U_TARGET", "§6 the arm opens the 1:1 by RECIPIENT id — the caller names WHO, never WHERE");
  ok(dmPosts.length === 1 && dmPosts[0]!.channel === "DM_U_TARGET", "🔴 §6 the message is posted into the channel Discord just returned, not into any channel the caller chose");
  ok(dmPosts[0]!.content === "somebody asked me to link your account", "§6 the text arrives unchanged");
  ok(delivery.surfaceId === "DM_U_TARGET" && delivery.messageId === "msg-1", "§6 the delivery reports the DM channel and message ids — public ids only, safe for an audit row");

  dmOpens.length = 0;
  dmPosts.length = 0;
  dmOpenStatus = 403;
  let threw = false;
  try {
    await dispatchDirectMessage("discord", { principalId: "U_CLOSED", text: "should never be delivered" });
  } catch {
    threw = true;
  }
  ok(threw === true, "🔴 §6 a refused DM OPEN throws — an undelivered consent ask must never read as a delivered one");
  ok(dmPosts.length === 0, "🔴 §6 and NOTHING was posted: the create-message call was never made, so there is no message anywhere to contradict the failure");
  dmOpenStatus = 200;
}

});

console.log(`✓ discord directory + DM transport: ${passed} assertions passed`);
