import {
  buildTeamsAuth,
  teamsMembershipType,
  teamsMode,
  teamsTrust,
  teamsUserTypeFromMember,
  teamsVisibility,
  type OpenEverywhereTeamsAuth,
  type TeamsIdentityInput,
} from "../agent/channels/teams-identity.js";
import { bindFrom, type BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { resolveMemoryPlan, type MemoryResolveConfig } from "../agent/memory/resolve.js";
import { defineDomain } from "../agent/memory/domain.js";
import { defineMemorySilo } from "../agent/memory/silo.js";

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
  "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG", "OE_TRUST",
]) {
  delete process.env[k];
}

ok(teamsMode("personal") === "dm", "scope personal -> dm");
ok(teamsMode("groupChat") === "mpim", "scope groupChat -> mpim");
ok(teamsMode("channel") === "channel", "scope channel -> channel");
ok(teamsMode("unknown") === "channel", "scope unknown -> channel (default)");
ok(teamsMode(undefined) === "channel", "scope absent -> channel (default)");

ok(teamsVisibility("channel", "standard", "channel") === "public", "standard team channel -> public");
ok(teamsVisibility("channel", "private", "channel") === "private", "private membershipType -> private");
ok(teamsVisibility("channel", "shared", "channel") === "private", "shared membershipType -> private");
ok(teamsVisibility("channel", undefined, "channel") === "private", "FAIL-CLOSED: unknown membershipType -> private");
ok(teamsVisibility("personal", "standard", "dm") === "private", "personal is never public");
ok(teamsVisibility("groupChat", "standard", "mpim") === "private", "groupChat is never public");
ok(teamsVisibility("unknown", undefined, "channel") === "private", "FAIL-CLOSED: unknown scope -> private");

ok(teamsTrust("channel", "shared", "channel", "TEN") === "external", "shared channel -> external (cross-tenant)");
ok(teamsTrust("channel", "standard", "channel", "TEN") === "internal", "standard channel + tenant -> internal");
ok(teamsTrust("channel", undefined, "channel", "TEN") === undefined, "FAIL-CLOSED: unknown membership -> no verdict");
ok(teamsTrust("channel", "standard", "channel", undefined) === undefined, "FAIL-CLOSED: missing tenant -> no verdict");

ok(teamsUserTypeFromMember({ userType: "Guest" }) === "guest", "userType Guest (Graph) -> guest");
ok(teamsUserTypeFromMember({ userRole: "guest" }) === "guest", "userRole guest (Bot roster) -> guest");
ok(teamsUserTypeFromMember({ userType: "Member" }) === "member", "userType Member -> member");
ok(teamsUserTypeFromMember({ userRole: "owner" }) === "member", "userRole owner -> member");
ok(teamsUserTypeFromMember({ userRole: "" }) === undefined, "empty role -> no verdict (fail toward existing tier)");
ok(teamsUserTypeFromMember({}) === undefined, "no role field -> no verdict");
ok(teamsUserTypeFromMember(null) === undefined, "lookup failed (null body) -> no verdict (fail closed, like a Slack users.info error)");
ok(teamsTrust("channel", "standard", "channel", "TEN", "guest") === "external", "guest in a standard channel -> external (demote wins over channel-internal)");
ok(teamsTrust("personal", undefined, "dm", "TEN", "guest") === "external", "guest 1:1 partner -> external (demote wins over personal-silo internal, mirrors Slack)");
ok(teamsTrust("channel", "standard", "channel", "TEN", "member") === "internal", "member in a standard channel -> internal (unchanged)");
ok(teamsTrust("channel", "standard", "channel", "TEN", undefined) === "internal", "unavailable userType in a standard channel -> internal (channel verdict stands, like Slack's channel path)");

ok(teamsMembershipType({ channel: { membershipType: "standard" } }) === "standard", "membershipType read from channelData.channel");
ok(teamsMembershipType({ channel: {} }) === undefined, "membershipType absent -> undefined");
ok(teamsMembershipType({}) === undefined, "no channel key -> undefined");
ok(teamsMembershipType(undefined) === undefined, "defensive on undefined channelData");

function ctxFromAuth(auth: OpenEverywhereTeamsAuth): BindableContext {
  return { channel: { kind: "teams" }, session: { auth: { current: auth } } };
}

interface Resolved {
  auth: OpenEverywhereTeamsAuth;
  binding: ReturnType<typeof bindFrom>;
  partition: ReturnType<typeof resolvePartition>;
}

function dispatch(input: TeamsIdentityInput): Resolved {
  const auth = buildTeamsAuth(input);
  const ctx = ctxFromAuth(auth);
  return { auth, binding: bindFrom(ctx), partition: resolvePartition(ctx) };
}

const orgSilo = defineMemorySilo({ name: "org-brain", provider: "sqlite" });
const pubSilo = defineMemorySilo({ name: "pub-faq", provider: "sqlite", readOnly: true });
const memCfg: MemoryResolveConfig = {
  domains: [
    defineDomain({ name: "org", match: "org", memory: "org-brain" }),
    defineDomain({ name: "public", match: "public", memory: "pub-faq" }),
  ],
  silos: [orgSilo, pubSilo],
};

{
  const { auth, binding, partition } = dispatch({
    userId: "29:user-alice",
    aadObjectId: "aad-alice",
    userName: "Alice",
    tenantId: "TENANT_ACME",
    conversationId: "19:channel-eng@thread.tacv2",
    channelId: "19:channel-eng@thread.tacv2",
    teamId: "19:team-eng@thread.tacv2",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "channel",
    membershipType: teamsMembershipType({ channel: { membershipType: "standard" } }),
  });

  ok(binding.platform === "teams", "A: bindFrom wires platform=teams from channel.kind");
  ok(binding.workspace === "TENANT_ACME", "A: workspace = tenant id");
  ok(binding.surface === "19-channel-eng-thread.tacv2", "A: surface = conversation id (sanitized)");
  ok(binding.mode === "channel" && binding.visibility === "public", "A: standard channel -> channel/public");
  ok(binding.trust === "internal", "A: POSITIVELY-verified standard in-tenant channel -> internal");
  ok(binding.principalId === "29:user-alice", "A: principal = from.id");
  ok(
    JSON.stringify(binding.target) === JSON.stringify({
      serviceUrl: "https://smba.trafficmanager.net/uk/",
      conversationId: "19:channel-eng@thread.tacv2",
      tenantId: "TENANT_ACME",
      channelId: "19:channel-eng@thread.tacv2",
      teamId: "19:team-eng@thread.tacv2",
      conversationType: "channel",
    }),
    "A: post-back target = Bot Connector reference (+ scope fact for the routine dispatcher)",
  );
  ok(partition.workspaceKey === "teams/TENANT_ACME", "A: partition workspaceKey = platform/tenant");
  ok(auth.authenticator === "teams" && auth.principalType === "teams-user", "A: auth principal fields");
  ok(auth.attributes.membership_type === "standard" && auth.attributes.scope === "channel", "A: facts captured as strings");

  const plan = resolveMemoryPlan(binding, partition, memCfg);
  ok(plan.reads.some((r) => r.silo.name === "org-brain"), "A: internal channel plans org-brain reads");
  ok(plan.writes.some((w) => w.silo.name === "org-brain"), "A: internal channel plans org-brain writes");
}

{
  const input: TeamsIdentityInput = {
    userId: "29:user-bob",
    tenantId: "TENANT_ACME",
    conversationId: "19:channel-secret@thread.tacv2",
    channelId: "19:channel-secret@thread.tacv2",
    teamId: "19:team-x@thread.tacv2",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "channel",
    membershipType: teamsMembershipType({ channel: { id: "19:channel-secret@thread.tacv2" } }),
  };
  const { auth, binding, partition } = dispatch(input);

  ok(binding.mode === "channel", "B: still a channel (not a DM)");
  ok(binding.visibility === "private", "B: FAIL-CLOSED — unknown membershipType resolves to private");
  ok(binding.trust === "external", "B: FAIL-CLOSED — unknown membershipType binds EXTERNAL (never internal)");
  ok(auth.attributes.membership_type === undefined, "B: no false membershipType claim when absent");

  const plan = resolveMemoryPlan(binding, partition, memCfg);
  ok(!plan.reads.some((r) => r.silo.name === "org-brain"), "B: ambiguous Teams event NEVER reads the org brain");
  ok(plan.writes.length === 0, "B: ambiguous Teams event never writes shared memory");
  ok(
    plan.reads.length === 1 && plan.reads[0].silo.name === "pub-faq" && plan.reads[0].readOnly === true,
    "B: ambiguous Teams event gets at most read-only public memory",
  );

  process.env.OE_TRUST = "internal";
  ok(dispatch(input).binding.trust === "internal", "B: OE_TRUST=internal vouches for the unverifiable channel (single-tenant opt-in)");
  delete process.env.OE_TRUST;
}

{
  const input: TeamsIdentityInput = {
    userId: "29:user-eve",
    tenantId: "TENANT_ACME",
    conversationId: "19:channel-partner@thread.tacv2",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "channel",
    membershipType: "shared",
  };
  ok(dispatch(input).binding.trust === "external", "B2: Shared Channel (cross-tenant) binds external");
  process.env.OE_TRUST = "internal";
  ok(dispatch(input).binding.trust === "external", "B2: OE_TRUST=internal does NOT override a POSITIVE external verdict");
  delete process.env.OE_TRUST;
}

{
  const { binding } = dispatch({
    userId: "29:user-carol",
    tenantId: "TENANT_ACME",
    conversationId: "a:1on1-carol",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "personal",
  });

  ok(binding.mode === "dm", "C: personal -> dm mode");
  ok(binding.visibility === "private", "C: a personal chat is never public");
  ok(binding.surface === "a-1on1-carol", "C: surface = conversation id (sanitized)");
  ok(binding.principalId === "29:user-carol", "C: principal = the DM caller");
  ok(binding.trust === "external", "C: unverified Teams DM partner fails closed to external");
}

{
  const { binding, partition } = dispatch({
    userId: "29:user-dan",
    tenantId: "TENANT_ACME",
    conversationId: "19:groupchat@thread.v2",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "groupChat",
    membershipType: "standard",
  });

  ok(binding.mode === "mpim", "D: groupChat -> mpim mode");
  ok(binding.visibility === "private", "D: a group chat is never public (even with membershipType=standard)");
  const plan = resolveMemoryPlan(binding, partition, memCfg);
  ok(plan.reads.length === 0 && plan.writes.length === 0, "D: group chat is execution-only (no memory)");
}

{
  const base = { tenantId: "TENANT_ACME", conversationId: "19:standard@thread.v2", channelId: "19:team-chan", teamId: "TEAM_ENG", serviceUrl: "https://smba.trafficmanager.net/uk/", scope: "channel", membershipType: "standard" } as const;
  const guest = dispatch({ userId: "29:guest-eve", ...base, userType: "guest" });
  ok(guest.auth.attributes.user_type === "guest", "E: buildTeamsAuth stows user_type");
  ok(guest.binding.trust === "external", "E: GUEST in a standard channel -> demoted to external (wins over channel-internal)");
  ok(guest.binding.visibility === "public", "E: guest demotion is trust-only — visibility of a standard channel is unchanged");
  const member = dispatch({ userId: "29:member-frank", ...base, userType: "member" });
  ok(member.binding.trust === "internal", "E: MEMBER in a standard channel -> internal (unchanged)");
  const unknown = dispatch({ userId: "29:user-grace", ...base });
  ok(unknown.binding.trust === "internal", "E: UNAVAILABLE signal -> channel verdict stands (internal), matching Slack's channel path");
}

console.log(`✓ teams: ${passed} assertions passed (activity → REAL bindFrom/partition/memory; fail-closed visibility + trust)`);
