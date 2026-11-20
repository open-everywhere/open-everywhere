import assert from "node:assert/strict";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { capabilitiesForPlatform, capabilitiesFor } from "@open-everywhere/core/agent/identity/capabilities.js";
import { resolveMessagePermalink } from "@open-everywhere/core/agent/channels/surface-message-ops.js";
import { nativeMemberCheck } from "@open-everywhere/core/agent/access/native-admin.js";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import reply from "@open-everywhere/core/agent/tools/reply.js";
import { canReceiveJudgedWake } from "@open-everywhere/core/agent/instructions/access.js";
import { classifySessionId } from "@open-everywhere/core/agent/channels/window-key.js";
import { _dynamicResolverForTest } from "@open-everywhere/core/agent/access/window-gated.js";

registerDiscordProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const ctxFor = (kind: string): BindableContext => ({ channel: { kind } }) as unknown as BindableContext;

const m = capabilitiesForPlatform("discord");
ok(m.midTurnPost === true && m.reactions === true, "discord manifest = { midTurnPost: true, reactions: true } once the bundle registers it (OPE-987: react is now wired)");
ok(capabilitiesFor(ctxFor("channel:discord")).midTurnPost === true, "namespaced 'channel:discord' resolves the registered discord manifest");
ok(capabilitiesFor(ctxFor("discord-gateway")).midTurnPost === true, "'discord-gateway' aliases to discord and resolves its registered manifest");

type Handler = (input: Record<string, unknown>, ctx: unknown) => { events: unknown } | null;
const armReply = (r: unknown, ctx: unknown): unknown =>
  _dynamicResolverForTest(r)({}, ctx);
ok(armReply(reply, ctxFor("discord")) !== null, "reply arms on a discord session (midTurnPost manifest present)");
ok(armReply(reply, ctxFor("discord-gateway")) !== null, "reply arms on the discord-gateway alias session");

const bridgedDiscord = bindFrom({
  channel: { kind: "discord-gateway" },
  session: { auth: { current: { authenticator: "discord", principalId: "U_dg", principalType: "discord-user", attributes: { guild_id: "G7", channel_id: "C7", channel_type: "0", user_id: "U_dg" } } } },
} as unknown as BindableContext);
ok(bridgedDiscord.platform === "discord" && bridgedDiscord.workspace === "G7" && bridgedDiscord.surface === "C7",
  "binding-bridge: a 'discord-gateway' stamp reconstitutes the full binding via the registered discord mapper (workspace=guild, surface=channel)");

ok(
  (await resolveMessagePermalink("discord", { channelId: "C7", messageId: "M9", workspace: "G7" })) === "https://discord.com/channels/G7/C7/M9",
  "permalink: a discord channel message composes the canonical /channels/<guild>/<channel>/<message> URL",
);
ok(
  (await resolveMessagePermalink("discord", { channelId: "C7", messageId: "M9", workspace: "U_dm", dm: true })) === "https://discord.com/channels/@me/C7/M9",
  "permalink: 🔴 a DM composes the @me form — a discord DM binds `workspace` to the USER id, and a user id in the guild slot is a URL that looks right and resolves to nothing",
);
ok(
  (await resolveMessagePermalink("discord", { channelId: "C7", messageId: "M9" })) === undefined,
  "permalink: no workspace and not a DM ⇒ undefined, never a guess — the PR body already treats the link as optional",
);
ok((await resolveMessagePermalink("teams", { channelId: "C7", messageId: "M9", workspace: "W1" })) === undefined, "permalink: a surface with no registered ops resolves undefined");

ok(nativeMemberCheck("discord") !== undefined, "native member check: the bundle registers one into core's registry, so a standing question on discord is answerable at all (no core caller today — see access/native-admin.ts)");

const nativeDmCtx: BindableContext = {
  channel: { kind: "discord-gateway", continuationToken: "cse_dm_1" },
  session: { auth: { current: { authenticator: "discord", principalId: "U_dm", principalType: "discord-user", attributes: { channel_id: "DM1", channel_type: "1", user_id: "U_dm" } } } },
} as unknown as BindableContext;
const nativeGroupDmCtx: BindableContext = {
  channel: { kind: "discord-gateway", continuationToken: "cse_gdm_1" },
  session: { auth: { current: { authenticator: "discord", principalId: "U_gdm", principalType: "discord-user", attributes: { channel_id: "GDM1", channel_type: "3", user_id: "U_gdm" } } } },
} as unknown as BindableContext;
const nativeChannelCtx: BindableContext = {
  channel: { kind: "discord-gateway", continuationToken: "cse_ch_1" },
  session: { auth: { current: { authenticator: "discord", principalId: "U_ch", principalType: "discord-user", attributes: { guild_id: "G7", channel_id: "C7", channel_type: "0" } } } },
} as unknown as BindableContext;
ok(classifySessionId("cse_dm_1").kind === "native" && classifySessionId("cse_ch_1").kind === "native", "fixture guard: both a Discord DM and a Discord channel bind off the same blank/native token — only `mode` tells them apart");
ok(bindFrom(nativeDmCtx).mode === "dm", "fixture guard: the registered discord mapper resolves channel_type 1 to mode 'dm'");
ok(bindFrom(nativeGroupDmCtx).mode === "mpim", "fixture guard: the registered discord mapper resolves channel_type 3 to mode 'mpim'");
ok(bindFrom(nativeChannelCtx).mode === "channel", "fixture guard: a guild channel resolves mode 'channel'");
ok(!canReceiveJudgedWake(nativeDmCtx), "🔴 OPE-771: a Discord DM session is false — discord-gateway.ts renders `direct` (raw, no envelope) for every DM message, never a judged wake");
ok(!canReceiveJudgedWake(nativeGroupDmCtx), "🔴 OPE-771: a Discord group-DM session is false for the same reason — `isDm` covers channel_type 3 too");
ok(canReceiveJudgedWake(nativeChannelCtx), "OPE-771: a Discord guild channel/thread session is true — it mixes raw `direct` (on @mention) with judged `thread-follow`/`name-drop`, so it is not 'only ever direct'");

{
  const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
  const { buildResolveRequest } = await import("@open-everywhere/core/agent/access/request.js");
  const { resolveAccess } = await import("@open-everywhere/core/agent/access/resolver.js");
  const { defineMcpServers, mcpServerBindings, mcpServerBundles, mcpServerConnectorCredentials } = await import("@open-everywhere/core/agent/connections/mcp-servers.js");
  const { defineSurface, registerSurfaces } = await import("@open-everywhere/core/agent/identity/trust.js");
  const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
  const servers = defineMcpServers([{ name: "fullstory", url: "https://mcp.fullstory.example/mcp", description: "FullStory sessions." }]);
  const bundles = mcpServerBundles(servers);
  const bindings = mcpServerBindings(servers);
  const catalogues = mcpServerConnectorCredentials(servers);
  registerConfig({
    loadBundles: () => bundles,
    loadBindings: () => bindings,
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const dmCtx = {
    channel: { kind: "discord" },
    session: { auth: { current: { authenticator: "discord", principalId: "U_dm", principalType: "discord-user", attributes: { channel_id: "DM1", channel_type: "1", user_id: "U_dm" } } } },
  } as unknown as BindableContext;
  const reach = () => resolveAccess(buildResolveRequest(dmCtx), bundles, bindings, {}, catalogues).connectors;
  const unvouched = buildResolveRequest(dmCtx);
  ok(unvouched.mode === "dm" && unvouched.callerTrust === "external", "🔴 OPE-2415: an unvouched Discord DM caller carries callerTrust external through the registered mapper");
  ok(reach().length === 0, "🔴 OPE-2415: …and reaches no server granted to oe:everyone");
  registerSurfaces([defineSurface({ key: "discord/G7", trust: "internal" })]);
  ok(reach().length === 0, "OPE-2415: a GUILD vouch does not cover a DM — the DM's workspace is the caller's own user id");
  registerSurfaces([defineSurface({ key: "discord/U_dm", trust: "internal" })]);
  ok(reach().join() === "fullstory", "OPE-2415: a `discord/<userId>` vouch admits that DM caller to oe:everyone");
  registerSurfaces([]);
  overrideSettingsForTest({ identity: { blanketTrust: "internal" } });
  ok(reach().join() === "fullstory", "OPE-2415: identity.blanketTrust internal admits an unvouched Discord DM caller");
  overrideSettingsForTest({ identity: { blanketTrust: "none" } });
  ok(reach().length === 0, "OPE-2415: with the blanket vouch gone, the caller is external again");
}

console.log(`✓ discord-provider-integration: ${n} assertions passed (capability manifest + namespace/alias resolution + reply arming + message permalink + native member check + canReceiveJudgedWake DM/channel split + oe:everyone DM trust, composed core + bundle)`);
