import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandlerArgs } from "eve/channels";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-discord-cover-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { resolvePartition } = await import("@open-everywhere/core/agent/adapter-api.js");
const { turnCoverOff, turnCoverOn, readPersonalCover } = await import("@open-everywhere/core/agent/cover/state.js");
const { coveredOnWake } = await import("@open-everywhere/core/agent/cover/wake.js");
const { readableEntries } = await import("@open-everywhere/core/agent/cover/recap.js");
const { postUnifiedReply } = await import("@open-everywhere/core/agent/channels/unified-reply.js");
const { replyAuditFor } = await import("@open-everywhere/core/agent/channels/reply-post.js");
const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
const { divertDiscordWakeToUnifiedWindow, authForRelayMessage, discordMentionedUserIds } = await import(
  "@open-everywhere/provider-discord/agent/channels/discord-gateway.js"
);
const { discordCanView, discordMemberCanViewChannel } = await import("@open-everywhere/provider-discord/agent/approvals/discord-admin.js");
const { buildOeDiscordCommandDefinition, parseDiscordOeCommandOptions } = await import("@open-everywhere/provider-discord/agent/commands/discord-commands.js");
type DiscordViewFacts = import("@open-everywhere/provider-discord/agent/approvals/discord-admin.js").DiscordViewFacts;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

registerDiscordProvider();

const GUILD = "900000000000000001";
const CHANNEL = "900000000000000002";
const PARENT = "900000000000000003";
const BOT = "900000000000000009";
const ANA = "900000000000000011";
const BO = "900000000000000012";
const ROLE_STAFF = "900000000000000021";
const VIEW = String(1 << 10);
const ADMIN = String(1 << 3);

console.log("§1 the mention parser");
ok(
  JSON.stringify(discordMentionedUserIds(`<@${BOT}> hi <@${ANA}> and <@!${BO}>, not <@&${ROLE_STAFF}> or <#${CHANNEL}>`, BOT)) === JSON.stringify([ANA, BO]),
  "the parser keeps both person-mention spellings in order, and drops the bot, a role and a channel",
);

let liveFake: typeof fetch | undefined;
const CY = "900000000000000013";
console.log("§2 the view rule");
{
  const base: DiscordViewFacts = { guildId: GUILD, rolePermissions: new Map([[GUILD, VIEW], [ROLE_STAFF, "0"]]), userId: ANA, memberRoleIds: [], overwrites: [] };
  const ow = (id: string, type: number, allow: string, deny: string) => ({ id, type, allow, deny });
  ok(discordCanView(base), "@everyone holds VIEW_CHANNEL and nothing overrides it: the person can read");
  ok(!discordCanView({ ...base, overwrites: [ow(GUILD, 0, "0", VIEW)] }), "🔴 an @everyone overwrite that denies VIEW_CHANNEL hides the channel");
  ok(discordCanView({ ...base, memberRoleIds: [ROLE_STAFF], overwrites: [ow(GUILD, 0, "0", VIEW), ow(ROLE_STAFF, 0, VIEW, "0")] }), "a role overwrite that allows it opens the channel to that role");
  ok(!discordCanView({ ...base, overwrites: [ow(GUILD, 0, "0", VIEW), ow(ROLE_STAFF, 0, VIEW, "0")] }), "🔴 …and not to a person without that role");
  ok(!discordCanView({ ...base, memberRoleIds: [ROLE_STAFF], overwrites: [ow(ROLE_STAFF, 0, VIEW, "0"), ow(ANA, 1, "0", VIEW)] }), "🔴 the member's own deny overwrite wins over a role's allow");
  ok(!discordCanView({ ...base, rolePermissions: new Map([[GUILD, "0"]]) }), "no VIEW_CHANNEL in the base and no overwrite: the person cannot read");
  ok(discordCanView({ ...base, rolePermissions: new Map([[GUILD, "0"], [ROLE_STAFF, ADMIN]]), memberRoleIds: [ROLE_STAFF], overwrites: [ow(GUILD, 0, "0", VIEW)] }), "ADMINISTRATOR reads every channel, whatever the overwrites say");
  ok(discordCanView({ ...base, ownerId: ANA, rolePermissions: new Map([[GUILD, "0"]]), overwrites: [ow(ANA, 1, "0", VIEW)] }), "the guild owner reads every channel");

  const channels: Record<string, unknown> = {
    [CHANNEL]: { id: CHANNEL, guild_id: GUILD, type: 0, permission_overwrites: [{ id: CY, type: 1, allow: "0", deny: VIEW }] },
    "900000000000000007": { id: "900000000000000007", guild_id: GUILD, type: 11, parent_id: CHANNEL },
    "900000000000000004": { id: "900000000000000004", guild_id: GUILD, type: 11, parent_id: PARENT },
    [PARENT]: { id: PARENT, guild_id: GUILD, type: 0, permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: VIEW }] },
    "900000000000000005": { id: "900000000000000005", guild_id: GUILD, type: 12, parent_id: CHANNEL },
    "900000000000000006": { id: "900000000000000006", guild_id: "900000000000000099", type: 0 },
  };
  const members: Record<string, unknown> = { [ANA]: { user: { id: ANA }, roles: [] }, [CY]: { user: { id: CY }, roles: [] }, [BOT]: { user: { id: BOT, bot: true }, roles: [] } };
  const fakeFetch = (async (url: string) => {
    const path = String(url).replace("https://discord.com/api/v10/", "");
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const miss = { ok: false, status: 404, json: async () => ({}) };
    const m = path.match(/^channels\/(\d+)$/);
    if (m) return channels[m[1]!] ? json(channels[m[1]!]) : miss;
    if (path === `guilds/${GUILD}`) return json({ id: GUILD, owner_id: "900000000000000077", roles: [{ id: GUILD, permissions: VIEW }] });
    const mm = path.match(new RegExp(`^guilds/${GUILD}/members/(\\d+)$`));
    if (mm) return members[mm[1]!] ? json(members[mm[1]!]) : miss;
    return miss;
  }) as unknown as typeof fetch;
  const can = (channel: string, user: string, token: string | undefined = "t") => discordMemberCanViewChannel(GUILD, channel, user, { fetchFn: fakeFetch, ...(token ? { token } : {}) });
  ok(await can(CHANNEL, ANA), "🔴 a member reads a plain channel @everyone can see");
  ok(!(await can("900000000000000004", ANA)), "🔴 a public thread reads as its PARENT, and the parent hides from @everyone");
  ok(await can("900000000000000007", ANA), "🔴 …and a public thread under a channel the person can view confirms them: the parent is followed, not refused");
  ok(!(await can(CHANNEL, CY)), "🔴 a member whose own overwrite denies VIEW_CHANNEL confirms nothing");
  ok(!(await can("900000000000000005", ANA)), "a private thread confirms nobody");
  ok(!(await can("900000000000000006", ANA)), "a channel in another guild confirms nobody");
  ok(!(await can(CHANNEL, BO)), "a person who is not a member (404) confirms nothing");
  ok(!(await can(CHANNEL, BOT)), "a bot account confirms nothing: cover is for people");
  const saved = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  ok(!(await discordMemberCanViewChannel(GUILD, CHANNEL, ANA, { fetchFn: fakeFetch })), "no bot token confirms nothing");
  if (saved !== undefined) process.env.DISCORD_BOT_TOKEN = saved;
  ok(!(await discordMemberCanViewChannel(GUILD, CHANNEL, ANA, { fetchFn: (async () => { throw new Error("network down"); }) as unknown as typeof fetch, token: "t" })), "a transport throw confirms nothing");

  process.env.DISCORD_BOT_TOKEN = "test-token";
  liveFake = fakeFetch;
}

const realFetch = globalThis.fetch;
globalThis.fetch = liveFake!;
try {

  console.log("§3 the room road");
  interface Received {
    readonly message: string;
    readonly target: { readonly token: string; readonly origin: Record<string, unknown> };
    readonly auth: { readonly attributes?: Record<string, unknown> };
  }
  const received: Received[] = [];
  const captureReceive = ((_channel: unknown, rawTarget: unknown) => ({
    async send(message: string, options: { auth: unknown }) {
      received.push({ message, target: rawTarget as Received["target"], auth: options.auth as Received["auth"] });
      return undefined as never;
    },
  })) as unknown as RouteHandlerArgs["to"];

  const msgOf = (id: string, content: string) => ({
    id,
    content,
    channelId: CHANNEL,
    channelType: "0",
    guildId: GUILD,
    author: { id: BO, username: "bo", bot: false },
    mentionsBot: false,
    botId: BOT,
    botName: "OE",
  });
  const firstAuth = authForRelayMessage(msgOf("910000000000000001", "x") as never)!;
  const partition = resolvePartition({ channel: { kind: "discord" as const }, session: { auth: { current: firstAuth as never } } } as never);
  const ORG = partition.org;
  const anaKey = `discord/${ANA}`;
  const grain = { unified: true, registryKey: "oe-domain::cover", domainName: "cover", singleWindow: true as const };
  const drive = async (id: string, content: string): Promise<Received & { wakeId: string }> => {
    const msg = msgOf(id, content);
    await divertDiscordWakeToUnifiedWindow({
      msg: msg as never,
      auth: authForRelayMessage(msg as never) as never,
      partition,
      grain,
      addressing: "channel-watch",
      privacyOk: true,
      receive: captureReceive,
      contextLines: [],
      contextIngestion: [],
    });
    const r = received.at(-1)!;
    return { ...r, wakeId: String(r.auth.attributes?.["oe_wake_id"] ?? "") };
  };
  const strip = (a: Received["auth"]) => {
    const { oe_wake_id: _w, oe_delivery_id: _d, message_id: _m, oe_reply_anchor: _r, ...rest } = a.attributes ?? {};
    return JSON.stringify(rest);
  };

  const baseline = await drive("910000000000000002", `<@${ANA}> is the launch still on Friday?`);
  ok(!baseline.message.includes("Out-of-office cover"), "with cover off, a mention of the person carries no cover note");

  await turnCoverOn({ org: ORG, platform: "discord", workspace: ANA, surface: "dm-ana", principalKey: anaKey }, { via: "command", name: "Ana" }, "2026-10-14T09:00:00.000Z");
  const covered = await drive("910000000000000003", `<@${ANA}> is the launch still on Friday?`);
  ok(covered.wakeId.length > 0, "precondition: the wake carries its host-minted wake id");
  ok(new RegExp(`<system-note>Out-of-office cover: this message mentions person ${ANA}, and they are away with cover on\\.`).test(covered.message), "🔴 the Discord wake carries OE's cover note as a trusted system note");
  ok(!/<system-note>[^<]*\bAna\b/.test(covered.message), "the trusted note names the person by id, never by their chosen display name");
  const pointer = await coveredOnWake(ORG, covered.wakeId);
  ok(pointer !== undefined && pointer.length === 1 && pointer[0]!.principalKey === anaKey, "the pointer the reply choke point reads names the covered person under this wake's id");
  ok(strip(covered.auth) === strip(baseline.auth), "🔴 the cover wake's auth bag is byte-identical to the same wake with cover off: the turn runs as the room");
  ok(!JSON.stringify(covered.auth).includes(ANA), "🔴 the auth bag names nothing of the absent person — they are never the principal");
  {
    const entry = (await readPersonalCover(ORG, anaKey)).state!.entries.at(-1)!;
    ok(entry.wakeId === covered.wakeId && entry.inRoom === true && entry.roomPublic === false, "🔴 Discord's view rule confirms the person can read the channel, and the question is marked in-room");
    ok(entry.channelId === CHANNEL && entry.surfaceKey === partition.surfaceKey && entry.askerName === "bo", "the entry names the channel, the room key and the asker");
    const { shown } = await readableEntries(anaKey, [entry]);
    ok(shown.length === 1, "the recap may show the confirmed question");

    const cyKey = `discord/${CY}`;
    await turnCoverOn({ org: ORG, platform: "discord", workspace: CY, surface: "dm-cy", principalKey: cyKey }, { via: "command", name: "Cy" }, "2026-10-14T09:00:00.000Z");
    const cyWake = await drive("910000000000000006", `<@${CY}> can you check the budget?`);
    ok(cyWake.message.includes("Out-of-office cover"), "precondition: Cy's wake is covered");
    const cyEntry = (await readPersonalCover(ORG, cyKey)).state!.entries.at(-1)!;
    ok(cyEntry.wakeId === cyWake.wakeId && cyEntry.inRoom === undefined, "🔴 a person the channel's overwrite hides from is NOT marked in-room");
    const cyRecap = await readableEntries(cyKey, [cyEntry]);
    ok(cyRecap.shown.length === 0 && cyRecap.leftOut === 1, "🔴 …and the recap leaves their question out and only counts it");
    await turnCoverOff({ org: ORG, platform: "discord", workspace: CY, surface: "dm-cy", principalKey: cyKey }, "command");
  }

  console.log("§4 the reply");
  {
    const posted: string[] = [];
    const origin = { platform: "discord", channelId: CHANNEL, guildId: GUILD } as never;
    const ctx = { channel: { kind: "discord" }, session: { id: "sess-discord-cover", auth: { current: firstAuth } } } as never;
    await postUnifiedReply(origin, "The launch is still on Friday, per this channel.", { postDiscord: async (_o, text) => (posted.push(text), "m-1") }, replyAuditFor(ctx, "tool", covered.wakeId));
    ok(posted[0] === "Cover for Ana, who is away:\nThe launch is still on Friday, per this channel.", `🔴 a Discord reply on a cover wake starts with the HOST's cover label (got ${JSON.stringify(posted[0])})`);
    ok((await readPersonalCover(ORG, anaKey)).state!.entries.at(-1)!.answer === "The launch is still on Friday, per this channel.", "the reply's own text becomes the answer in the recap log");
  }

  console.log("§5 the command");
  {
    const def = buildOeDiscordCommandDefinition() as { options: Array<{ name: string; type: number; description: string; options?: Array<{ name: string; options?: Array<{ name: string; type: number; required?: boolean }> }> }> };
    const group = def.options.find((o) => o.name === "cover");
    ok(group !== undefined && group.type === 2, "🔴 the `/oe` command body declares a `cover` group");
    ok(JSON.stringify(group!.options!.map((o) => o.name)) === JSON.stringify(["on", "off", "status"]), "…with the `on`, `off` and `status` subcommands");
    const until = group!.options!.find((o) => o.name === "on")!.options?.[0];
    ok(until?.name === "until" && until.type === 3 && until.required === false, "`on` takes an optional text `until`");
    ok(group!.description.length <= 100, "the group description fits Discord's 100-character limit");
    const parse = (sub: string, opts?: unknown[]) => parseDiscordOeCommandOptions([{ name: "cover", type: 2, options: [{ name: sub, type: 1, ...(opts ? { options: opts } : {}) }] }]);
    ok(JSON.stringify(parse("on")) === JSON.stringify({ kind: "cover", action: "on" }), "`/oe cover on` parses to core's `on`");
    ok(JSON.stringify(parse("on", [{ name: "until", type: 3, value: "2026-10-21" }])) === JSON.stringify({ kind: "cover", action: "on", until: "2026-10-20T00:00:00.000Z" }), "`/oe cover on until:2026-10-20` carries the end date");
    ok(parse("on", [{ name: "until", type: 3, value: "next week" }]).kind === "error", "a date core cannot read answers core's own error");
    ok(JSON.stringify(parse("off")) === JSON.stringify({ kind: "cover", action: "off" }), "`/oe cover off` parses to core's `off`");
    ok(JSON.stringify(parse("status")) === JSON.stringify({ kind: "cover", action: "status" }), "`/oe cover status` parses to core's status read");
    const suggest = def.options.find((o) => o.name === "suggest");
    ok(suggest?.type === 2 && JSON.stringify(suggest.options!.map((o) => o.name)) === JSON.stringify(["off", "on", "status"]) && suggest.description.length <= 100, "🔴 the `/oe` command body declares a `suggest` group with `off`, `on` and `status`");
    const parseSuggest = (sub: string) => parseDiscordOeCommandOptions([{ name: "suggest", type: 2, options: [{ name: sub, type: 1 }] }]);
    ok(["off", "on", "status"].every((a) => JSON.stringify(parseSuggest(a)) === JSON.stringify({ kind: "suggest", action: a })), "`/oe suggest off|on|status` parses to core's actions");
  }

  console.log("§6 no note");
  ok(!(await drive("910000000000000004", `<@${BO}> any news?`)).message.includes("Out-of-office cover"), "a mention of somebody without cover carries no note");
  await turnCoverOff({ org: ORG, platform: "discord", workspace: ANA, surface: "dm-ana", principalKey: anaKey }, "command");
  ok(!(await drive("910000000000000005", `<@${ANA}> still there?`)).message.includes("Out-of-office cover"), "🔴 after `/oe cover off`, a mention of the person carries no note");

  console.log(`✓ discord-cover: ${n} assertions`);
} finally {
  globalThis.fetch = realFetch;
}
