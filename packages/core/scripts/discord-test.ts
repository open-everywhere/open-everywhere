import {
  buildDiscordAuth,
  discordMode,
  discordVisibility,
  discordMemberPendingFromRaw,
  discordTrust,
  threadParentFromRawChannel,
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

ok(discordMemberPendingFromRaw({ member: { pending: true } }) === true, "member.pending true read from raw");
ok(discordMemberPendingFromRaw({ member: { pending: false } }) === false, "member.pending false read from raw");
ok(discordMemberPendingFromRaw({ member: {} }) === undefined, "member without pending -> undefined (no verdict)");
ok(discordMemberPendingFromRaw({}) === undefined, "no member (DM / older payload) -> undefined");
ok(discordTrust("true") === "external", "pending member -> external (demote, wins over vouch)");
ok(discordTrust("false") === undefined, "non-pending member -> no verdict (a guild member is not proof of internal)");
ok(discordTrust(undefined) === undefined, "unknown pending -> no verdict (fail toward existing tier)");

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
  parentChannelId?: string;
  memberPending?: boolean;
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

{
  const { binding, partition } = dispatch({
    userId: "U_alice", guildId: "G_ACME", channelId: "T_THREAD9", channelType: "11", parentChannelId: "C_ENG",
  });
  ok(binding.surface === "T_THREAD9", "F: conversational surface stays the THREAD id");
  ok(binding.domainSurface === "C_ENG", "F: domainSurface = the parent channel (domain/spend grain)");
  ok(partition.surfaceKey === "discord/G_ACME/T_THREAD9", "F: surfaceKey stays thread-grain (sessions/memory paths)");
  ok(partition.domainKey === "discord/G_ACME/C_ENG", "F: domainKey resolves to the parent channel");

  const base = dispatch({ userId: "U_alice", guildId: "G_ACME", channelId: "C_ENG", channelType: "0" });
  ok(base.binding.domainSurface === undefined, "F: no parent stamped → no domainSurface");
  ok(base.partition.domainKey === base.partition.surfaceKey, "F: no parent → domainKey === surfaceKey");
  const self = dispatch({ userId: "U_alice", guildId: "G_ACME", channelId: "C_ENG", channelType: "0", parentChannelId: "C_ENG" });
  ok(self.binding.domainSurface === undefined, "F: parent == surface → dropped (no degenerate grain)");
}

{
  ok(threadParentFromRawChannel({ channel: { type: 11, parent_id: "C_ENG" } }) === "C_ENG", "G: public thread (11) → parent_id");
  ok(threadParentFromRawChannel({ channel: { type: 12, parent_id: "C_ENG" } }) === "C_ENG", "G: private thread (12) → parent_id");
  ok(threadParentFromRawChannel({ channel: { type: 0, parent_id: "CAT_9" } }) === undefined, "G: base channel's parent_id is its CATEGORY — never a grain anchor");
  ok(threadParentFromRawChannel({ channel: { type: 11 } }) === undefined, "G: thread with no parent_id → undefined (fail-open)");
  ok(threadParentFromRawChannel({ channel: { type: 11, parent_id: 42 } }) === undefined, "G: non-string parent_id → undefined (defensive)");
  ok(threadParentFromRawChannel({}) === undefined, "G: no channel partial → undefined");
}

{
  process.env.OE_TRUST = "internal";
  const pending = dispatch({ userId: "U_eve", guildId: "G_ACME", channelId: "C_ENG", channelType: "0", memberPending: true });
  ok(pending.binding.trust === "external", "H: PENDING member -> external (screening incomplete; demotion overrides OE_TRUST=internal)");
  const member = dispatch({ userId: "U_frank", guildId: "G_ACME", channelId: "C_ENG", channelType: "0", memberPending: false });
  ok(member.binding.trust === "internal", "H: non-pending member -> internal (rides the vouch, unchanged)");
  const unknown = dispatch({ userId: "U_grace", guildId: "G_ACME", channelId: "C_ENG", channelType: "0" });
  ok(unknown.binding.trust === "internal", "H: no pending signal -> vouch stands (fail toward the existing tier, like Slack's channel path)");
  delete process.env.OE_TRUST;
}

console.log(`✓ discord: ${passed} assertions passed (interaction fields → identity + memory; fail-closed + DM isolation + thread→parent grain)`);
