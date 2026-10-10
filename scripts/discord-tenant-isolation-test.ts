import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { buildDiscordAuth, type OpenEverywhereDiscordAuth } from "@open-everywhere/provider-discord/agent/channels/discord-identity.js";
import {
  isMisplacedDriver,
  authForRelayMessage,
  type DiscordRelayMessage,
} from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { bindFrom, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { registerSurfaces, defineSurface, _resetSurfacesForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { parseDriverAllowlist } from "@open-everywhere/core/agent/testing/driver-allowlist.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
  delete process.env[k];
}

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
  memberPending?: boolean;
}): Resolved {
  const auth = buildDiscordAuth(input);
  return { binding: bindFrom(ctxFromAuth(auth)), partition: resolvePartition(ctxFromAuth(auth)) };
}

{
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "discord/G_TENANT_A", trust: "internal" })]);

  const tenantA = dispatch({ userId: "U_alice", guildId: "G_TENANT_A", channelId: "C_A", channelType: "0" });
  ok(tenantA.binding.trust === "internal", "A1: the vouched tenant's member rides the register vouch to internal");

  const tenantB = dispatch({ userId: "U_mallory", guildId: "G_TENANT_B", channelId: "C_B", channelType: "0" });
  ok(
    tenantB.binding.trust === "external",
    "A2: an UNVOUCHED guild — never registered, OE_TRUST unset — defaults to external (fail-closed, not an accident of missing config)",
  );
  ok(tenantA.partition.workspaceKey !== tenantB.partition.workspaceKey, "A3: the two tenants' memory partitions are disjoint keys");
  ok(tenantB.partition.workspaceKey === "discord/G_TENANT_B", "A3b: tenant B's own key is guild-scoped, never borrowed from A");

  overrideSettingsForTest({ identity: { blanketTrust: "internal" } });
  const tenantBBlanket = dispatch({ userId: "U_mallory", guildId: "G_TENANT_B", channelId: "C_B", channelType: "0" });
  ok(
    tenantBBlanket.binding.trust === "internal",
    "A4 (negative control): WITH OE_TRUST=internal, the SAME unvouched guild B crosses into internal — proving A2 exercises a real branch, not a default that can never be false",
  );
  overrideSettingsForTest({ identity: { blanketTrust: "none" } });
  const tenantBRestored = dispatch({ userId: "U_mallory", guildId: "G_TENANT_B", channelId: "C_B", channelType: "0" });
  ok(tenantBRestored.binding.trust === "external", "A5: restoring the baseline (OE_TRUST unset) restores the fail-closed default");

  _resetSurfacesForTest();
}

{
  const GUILD_A = "111111111111111111";
  const GUILD_B = "222222222222222222";
  const DRIVER_BOT = "999999999999999999";
  const OTHER_BOT = "888888888888888888";
  const allowlist = parseDriverAllowlist(`${GUILD_A}:${DRIVER_BOT}`);

  function relayMsg(guildId: string, botId: string): DiscordRelayMessage {
    return {
      id: "1",
      content: "hello from a driver",
      channelId: "333333333333333333",
      guildId,
      author: { id: botId, bot: true },
      mentionsBot: false,
    };
  }

  overrideSettingsForTest({ wake: { driverAllowlist: [`${GUILD_A}:${DRIVER_BOT}`] } });
  const homeMsg = relayMsg(GUILD_A, DRIVER_BOT);
  ok(authForRelayMessage(homeMsg) !== null, "B1: the driver credential IS admitted as a user in the guild it's pinned to");
  ok(!isMisplacedDriver(GUILD_A, DRIVER_BOT, allowlist), "B1b: pinned-here is never classified a misplacement");

  const strangerMsg = relayMsg(GUILD_B, DRIVER_BOT);
  ok(authForRelayMessage(strangerMsg) === null, "B2: the SAME driver credential is REFUSED admission when it claims a guild it isn't pinned to");
  ok(isMisplacedDriver(GUILD_B, DRIVER_BOT, allowlist), "B2b: …and IS classified as a misplaced driver — this is what earns the named audit row");
  overrideSettingsForTest({ wake: { driverAllowlist: [] } });

  ok(!isMisplacedDriver(GUILD_B, OTHER_BOT, allowlist), "B3 (negative control): an unrelated bot id is NOT a misplaced driver — no audit noise for ordinary bot chatter");

  ok(!isMisplacedDriver(GUILD_B, "777777777777777777", allowlist), "B4: a driver id with no pin anywhere is not a misplacement either — it is ordinary unadmitted noise");
}

console.log(`✓ discord-tenant-isolation: ${passed} assertions passed (per-guild trust isolation + the OE_TRUST blanket risk, with negative controls + driver-credential guild pinning, now audited)`);
