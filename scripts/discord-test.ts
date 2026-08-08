import {
  buildDiscordAuth,
  discordMode,
  discordVisibility,
  discordMemberPendingFromRaw,
  discordTrust,
  threadParentFromRawChannel,
  type OpenEverywhereDiscordAuth,
} from "@open-everywhere/provider-discord/agent/channels/discord-identity.js";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { discordWakeOriginCodec } from "@open-everywhere/provider-discord/agent/channels/discord-origin-codec.js";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();

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

{
  const arm = discordWakeOriginCodec.dmOrigin;
  ok(typeof arm === "function", "I: the discord codec REGISTERS a dmOrigin arm");

  const { binding: dmBinding } = dispatch({ userId: "U_bob", channelId: "D_bob", channelType: "1" });
  const minted = arm?.({ surface: dmBinding.surface, mode: "dm", target: dmBinding.target });
  ok(JSON.stringify(minted) === JSON.stringify({ platform: "discord", channelId: "D_bob", dm: true }), "I: mints the DM VARIANT from target.channelId — a positive dm:true, never a guildless guild-shape");
  ok(discordWakeOriginCodec.validate(minted as unknown as Record<string, unknown>), "I: …and the minted origin is exactly what the validator's DM branch admits");
  const { binding: groupBinding } = dispatch({ userId: "U_bob", channelId: "G_grp", channelType: "3" });
  ok(groupBinding.mode === "mpim" && arm?.({ surface: groupBinding.surface, mode: "mpim", target: groupBinding.target })?.channelId === "G_grp", "I: a GROUP DM (type 3 ⇒ mpim) resolves an anchor too");

  const { binding: chanBinding } = dispatch({ userId: "U_alice", guildId: "G_ACME", channelId: "C_ENG", channelType: "0" });
  ok(chanBinding.mode === "channel", "I: the guild fixture really is channel-mode");
  ok(arm?.({ surface: chanBinding.surface, mode: "channel" as unknown as "dm", target: chanBinding.target }) === undefined, "I: a CHANNEL binding yields NO anchor");
  ok(arm?.({ surface: "D_x", mode: "dm" }) === undefined, "I: no target ⇒ no anchor (sourced from `target`, never from `surface`)");
  ok(arm?.({ surface: "D_x", mode: "dm", target: {} }) === undefined, "I: a target with no channelId ⇒ no anchor");
  ok(arm?.({ surface: "D_x", mode: "dm", target: { channelId: "" } }) === undefined, "I: a BLANK channelId ⇒ no anchor");
  ok(arm?.({ surface: "D_x", mode: "dm", target: { channelId: 5 } }) === undefined, "I: a non-string channelId ⇒ no anchor");

  const v = (o: Record<string, unknown>): boolean => discordWakeOriginCodec.validate(o);
  ok(v({ channelId: "C1", guildId: "G1" }), "I/XOR: the GUILD shape is unchanged — non-empty guildId, no dm");
  ok(v({ channelId: "D1", dm: true }), "I/XOR: the DM shape needs a positive dm:true");
  ok(!v({ channelId: "D1", dm: true, guildId: "G1" }), "I/XOR: BOTH is invalid — a DM row may never acquire guild authority (guild-keyed threadRef/engagement/vouch keys)");
  ok(!v({ channelId: "D1" }), "I/XOR: NEITHER is invalid — a guildless origin is still never admitted BY OMISSION (D1, unchanged)");
  ok(!v({ channelId: "D1", dm: false }), "I/XOR: dm:false is not a shape");
  ok(!v({ channelId: "D1", dm: true, autoThreadName: "x" }), "I/D4: autoThreadName is forbidden on a DM origin — its reply-leg branch writes guild-keyed engagement rows");
  ok(v({ channelId: "C1", guildId: "G1", autoThreadName: "x" }), "I/D4: …and still allowed on the guild shape (nothing was taken away)");

  const dmRef = discordWakeOriginCodec.threadRef({ platform: "discord", channelId: "C_SAME", dm: true });
  const guildRef = discordWakeOriginCodec.threadRef({ platform: "discord", channelId: "C_SAME", guildId: "123456789012345678" });
  ok(dmRef.channelKey === "discord/dm/C_SAME", "I: the DM threadRef is namespaced on a literal `dm` segment");
  ok(dmRef.channelKey !== guildRef.channelKey, "I: …which a snowflake guild id can never produce — the two namespaces are disjoint on the same channel id");
  ok(discordWakeOriginCodec.isThreadScoped({ platform: "discord", channelId: "C_SAME", dm: true }) === false, "I: a DM origin is never thread-scoped (no threads in a DM)");
  ok(discordWakeOriginCodec.containerId({ platform: "discord", channelId: "C_SAME", dm: true }) === "C_SAME", "I: containerId is the channel id on both shapes");
}

console.log(`✓ discord: ${passed} assertions passed (interaction fields → identity + memory; fail-closed + DM isolation + thread→parent grain + the DM origin variant)`);
