import {
  buildDiscordAuth,
  discordMode,
  discordVisibility,
  type OpenEverywhereDiscordAuth,
} from "../agent/channels/discord-identity.js";
import { bindFrom, type BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";

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
  "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG",
]) {
  delete process.env[k];
}

ok(discordMode("1", undefined) === "dm", "channel_type 1 (DM) -> dm");
ok(discordMode("3", undefined) === "mpim", "channel_type 3 (group DM) -> mpim");
ok(discordMode("0", "G1") === "channel", "guild text channel -> channel");
ok(discordMode("11", "G1") === "channel", "guild thread (11) -> channel");
ok(discordMode(undefined, "G1") === "channel", "guild present, type unknown -> channel");
ok(discordMode(undefined, undefined) === "dm", "no guild, type unknown -> dm");

ok(discordVisibility(undefined, "dm") === "private", "dm is never public");
ok(discordVisibility(undefined, "mpim") === "private", "group DM is never public");
ok(discordVisibility(undefined, "channel") === "private", "FAIL-CLOSED: guild channel, unknown @everyone -> private");
ok(discordVisibility("true", "channel") === "public", "explicit @everyone-readable guild channel -> public");
ok(discordVisibility("true", "dm") === "private", "a DM stays private even if a public flag leaks in");

function ctxFromAuth(auth: OpenEverywhereDiscordAuth): BindableContext {
  return { channel: { kind: "discord" }, session: { auth: { current: auth } } };
}

interface Resolved {
  binding: ReturnType<typeof bindFrom>;
  partition: ReturnType<typeof resolvePartition>;
}

function dispatch(input: {
  userId: string;
  guildId?: string;
  channelId: string;
  channelType?: string;
  everyoneCanView?: boolean;
}): Resolved {
  const auth = buildDiscordAuth(input);
  const ctx = ctxFromAuth(auth);
  return { binding: bindFrom(ctx), partition: resolvePartition(ctx) };
}

{
  const { binding, partition } = dispatch({
    userId: "U_alice", guildId: "G_ACME", channelId: "C_ENG", channelType: "0",
  });
  ok(binding.platform === "discord", "A: platform = discord");
  ok(binding.workspace === "G_ACME" && binding.surface === "C_ENG", "A: workspace=guild, surface=channel");
  ok(binding.mode === "channel", "A: guild text channel -> channel mode");
  ok(binding.visibility === "private", "A: FAIL-CLOSED — guild channel with no @everyone signal -> private");
  ok(binding.principalId === "U_alice", "A: principal from user id");
  ok(
    JSON.stringify(binding.target) === JSON.stringify({ channelId: "C_ENG", guildId: "G_ACME", channelType: "0" }),
    "A: post-back target = { channelId } + raw guild/type facts for the routine dispatcher's fire-time re-stamp",
  );
  ok(partition.workspaceKey === "discord/G_ACME", "A: workspaceKey");
  ok(partition.surfaceKey === "discord/G_ACME/C_ENG", "A: surfaceKey");
}

{
  const { binding } = dispatch({
    userId: "U_alice", guildId: "G_ACME", channelId: "C_PUBLIC", channelType: "0", everyoneCanView: true,
  });
  ok(binding.mode === "channel", "B: still a channel");
  ok(binding.visibility === "public", "B: explicit @everyone-readable -> public (feeds workspace brain)");
}

{
  const { binding, partition } = dispatch({
    userId: "U_bob", channelId: "D_bob", channelType: "1",
  });
  ok(binding.mode === "dm", "C: DM (type 1) -> dm mode");
  ok(binding.visibility === "private", "C: a DM is never public");
  ok(binding.workspace === "U_bob", "C: DM keys to the caller's own workspace (no guild)");
  ok(binding.surface === "D_bob", "C: DM surface = the DM channel id");
  ok(binding.principalId === "U_bob", "C: principal = the DM caller");
  ok(partition.surfaceKey === "discord/U_bob/D_bob", "C: DM has its own surface partition");
}

{
  const { binding } = dispatch({
    userId: "U_carol", channelId: "GDM_1", channelType: "3",
  });
  ok(binding.mode === "mpim", "D: group DM (type 3) -> mpim mode");
  ok(binding.visibility === "private", "D: a group DM is never public");
}

{
  const { binding } = dispatch({
    userId: "U_alice", guildId: "G_ACME", channelId: "C_MYSTERY",
  });
  ok(binding.mode === "channel", "E: guild present, type unknown -> channel");
  ok(binding.visibility === "private", "E: FAIL-CLOSED — unknown type/visibility -> private");
}

console.log(`✓ discord: ${passed} assertions passed (interaction fields → identity + memory; fail-closed + DM isolation)`);
