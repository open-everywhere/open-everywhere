import assert from "node:assert/strict";
import { resolveDiscordDeclaredTarget, resolveDiscordTarget } from "@open-everywhere/provider-discord/agent/channels/discord-dispatch-target.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { resolveDeclaredTarget } from "@open-everywhere/core/agent/schedules/routine-dispatch.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const GUILD = "1300000000000000100";
const OTHER_GUILD = "1300000000000000999";
const CHANNEL = "1300000000000000200";
const USER = "300000000000000104";

{
  const room = await resolveDiscordDeclaredTarget({ kind: "room", platform: "discord", workspace: GUILD, surface: CHANNEL }, { channelGuild: async () => GUILD });
  ok(room.ok, `room: a channel confirmed in the named guild resolves (got ${JSON.stringify(room)})`);
  if (!room.ok) throw new Error("unreachable");
  ok(room.facts.surfaceKey === `discord/${GUILD}/${CHANNEL}`, "room: the surface key is discord/<guild>/<channel>");
  const dest = resolveDiscordTarget(room.facts as never);
  ok(dest !== null && dest.mode === "channel", "room: the routine resolver binds a CHANNEL");
  ok(dest?.origin !== undefined && (dest.origin as { guildId?: string }).guildId === GUILD, "room: the stored guild id is the guild evidence that mints a guild wake origin");
}

{
  const wrong = await resolveDiscordDeclaredTarget({ kind: "room", platform: "discord", workspace: GUILD, surface: CHANNEL }, { channelGuild: async () => OTHER_GUILD });
  ok(!wrong.ok && wrong.reason.includes(`is in guild ${OTHER_GUILD}, not guild ${GUILD}`), "🔴 room: a channel in ANOTHER guild is refused");
  ok(!wrong.ok && wrong.reason.includes(`discord/${OTHER_GUILD}/${CHANNEL}`), "room: the refusal names the corrected target");
  const unknown = await resolveDiscordDeclaredTarget({ kind: "room", platform: "discord", workspace: GUILD, surface: CHANNEL }, { channelGuild: async () => undefined });
  ok(!unknown.ok && unknown.reason.includes("did not confirm"), "room: a channel Discord will not confirm is refused, not guessed");
}

{
  const opened: string[] = [];
  const person = await resolveDiscordDeclaredTarget(
    { kind: "person", platform: "discord", principalId: USER },
    { openDm: async (id) => (opened.push(id), "DM_CHANNEL_1") },
  );
  ok(opened.length === 1 && opened[0] === USER, "person: the resolver opens the DM with the named user");
  ok(person.ok, `person: resolves (got ${JSON.stringify(person)})`);
  if (!person.ok) throw new Error("unreachable");
  ok(person.facts.surfaceKey === `discord/${USER}/DM_CHANNEL_1`, "person: the workspace segment is the user id, as bindDiscord derives for a DM");
  const dest = resolveDiscordTarget(person.facts as never);
  ok(dest !== null && dest.mode === "dm", "person: the routine resolver binds a DM");
  ok((dest?.origin as { dm?: boolean } | undefined)?.dm === true, "person: the wake origin is the DM variant, never a guild-shaped one");

  const refused = await resolveDiscordDeclaredTarget(
    { kind: "person", platform: "discord", principalId: USER },
    {
      openDm: async () => {
        throw new Error("Discord could not open a DM channel (403)");
      },
    },
  );
  ok(!refused.ok && refused.reason.includes("(403)") && refused.reason.includes("allow direct messages"), "person: a DM Discord refuses comes back as a refusal that names the fix");
}

{
  const before = await resolveDeclaredTarget({ kind: "room", platform: "discord", workspace: GUILD, surface: CHANNEL });
  ok(!before.ok && before.reason.includes('no provider on this deployment resolves a declared target on "discord"'), "seam: before registration, core has no Discord arm");
  registerDiscordProvider();
  delete process.env.DISCORD_BOT_TOKEN;
  const after = await resolveDeclaredTarget({ kind: "room", platform: "discord", workspace: GUILD, surface: CHANNEL });
  ok(!after.ok && after.reason.includes("did not confirm"), "seam: after registerDiscordProvider, core reaches the bundle's arm (here it refuses: no bot token, so no guild check can pass)");
}

console.log(`✓ discord-declared-target: ${n} assertions passed`);
