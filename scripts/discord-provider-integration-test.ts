import assert from "node:assert/strict";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { capabilitiesForPlatform, capabilitiesFor } from "@open-everywhere/core/agent/identity/capabilities.js";
import { resolveMessagePermalink } from "@open-everywhere/core/agent/channels/surface-message-ops.js";
import { nativeMemberCheck } from "@open-everywhere/core/agent/access/native-admin.js";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import reply from "@open-everywhere/core/agent/tools/reply.js";

registerDiscordProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const ctxFor = (kind: string): BindableContext => ({ channel: { kind } }) as unknown as BindableContext;

const m = capabilitiesForPlatform("discord");
ok(m.midTurnPost === true && m.reactions === false, "discord manifest = { midTurnPost: true, reactions: false } once the bundle registers it");
ok(capabilitiesFor(ctxFor("channel:discord")).midTurnPost === true, "namespaced 'channel:discord' resolves the registered discord manifest");
ok(capabilitiesFor(ctxFor("discord-gateway")).midTurnPost === true, "'discord-gateway' aliases to discord and resolves its registered manifest");

type Handler = (input: Record<string, unknown>, ctx: unknown) => { events: unknown } | null;
const armReply = (r: unknown, ctx: unknown): unknown =>
  (r as { events: Record<string, Handler> }).events["session.started"]({}, ctx);
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

console.log(`✓ discord-provider-integration: ${n} assertions passed (capability manifest + namespace/alias resolution + reply arming + message permalink + native member check, composed core + bundle)`);
