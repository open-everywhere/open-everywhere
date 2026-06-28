import {
  buildTeamsAuth,
  teamsMembershipType,
  teamsMode,
  teamsVisibility,
  type OpenEverywhereTeamsAuth,
} from "../agent/channels/teams-identity.js";
import { bindFrom, type BindableContext } from "../agent/identity/binding.js";
import type { SessionMode } from "../agent/access/resolver.js";

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
  "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL",
]) {
  delete process.env[k];
}

function attr(a: OpenEverywhereTeamsAuth["attributes"], key: string): string | undefined {
  const v = a[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
interface MappedIdentity {
  workspace?: string;
  surface?: string;
  mode: SessionMode;
  visibility: "public" | "private";
  principalId?: string;
  target?: Readonly<Record<string, unknown>>;
}
function bindTeams(auth: OpenEverywhereTeamsAuth): MappedIdentity {
  const a = auth.attributes;
  const scope = attr(a, "scope");
  const membershipType = attr(a, "membership_type");
  const mode = teamsMode(scope);
  const conversationId = attr(a, "conversation_id");
  const serviceUrl = attr(a, "service_url");
  return {
    workspace: attr(a, "tenant_id"),
    surface: conversationId,
    mode,
    visibility: teamsVisibility(scope, membershipType, mode),
    principalId: (auth.principalId && auth.principalId.length > 0 ? auth.principalId : undefined) ?? attr(a, "user_id"),
    target: conversationId && serviceUrl
      ? { serviceUrl, conversationId, tenantId: attr(a, "tenant_id"), channelId: attr(a, "channel_id"), teamId: attr(a, "team_id") }
      : undefined,
  };
}

function ctxFromAuth(auth: OpenEverywhereTeamsAuth): BindableContext {
  return { channel: { kind: "teams" }, session: { auth: { current: auth } } };
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

ok(teamsMembershipType({ channel: { membershipType: "standard" } }) === "standard", "membershipType read from channelData.channel");
ok(teamsMembershipType({ channel: {} }) === undefined, "membershipType absent -> undefined");
ok(teamsMembershipType({}) === undefined, "no channel key -> undefined");
ok(teamsMembershipType(undefined) === undefined, "defensive on undefined channelData");

{
  const auth = buildTeamsAuth({
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
  const m = bindTeams(auth);

  ok(bindFrom(ctxFromAuth(auth)).platform === "teams", "A: bindFrom wires platform=teams from channel.kind");
  ok(m.workspace === "TENANT_ACME", "A: workspace = tenant id");
  ok(m.surface === "19:channel-eng@thread.tacv2", "A: surface = conversation id");
  ok(m.mode === "channel" && m.visibility === "public", "A: standard channel -> channel/public");
  ok(m.principalId === "29:user-alice", "A: principal = from.id");
  ok(
    JSON.stringify(m.target) === JSON.stringify({
      serviceUrl: "https://smba.trafficmanager.net/uk/",
      conversationId: "19:channel-eng@thread.tacv2",
      tenantId: "TENANT_ACME",
      channelId: "19:channel-eng@thread.tacv2",
      teamId: "19:team-eng@thread.tacv2",
    }),
    "A: post-back target = Bot Connector reference",
  );
  ok(auth.authenticator === "teams" && auth.principalType === "teams-user", "A: auth principal fields");
  ok(auth.attributes.membership_type === "standard" && auth.attributes.scope === "channel", "A: facts captured as strings");
}

{
  const auth = buildTeamsAuth({
    userId: "29:user-bob",
    tenantId: "TENANT_ACME",
    conversationId: "19:channel-secret@thread.tacv2",
    channelId: "19:channel-secret@thread.tacv2",
    teamId: "19:team-x@thread.tacv2",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "channel",
    membershipType: teamsMembershipType({ channel: { id: "19:channel-secret@thread.tacv2" } }),
  });
  const m = bindTeams(auth);

  ok(m.mode === "channel", "B: still a channel (not a DM)");
  ok(m.visibility === "private", "B: FAIL-CLOSED — unknown membershipType resolves to private");
  ok(auth.attributes.membership_type === undefined, "B: no false membershipType claim when absent");
}

{
  const auth = buildTeamsAuth({
    userId: "29:user-carol",
    tenantId: "TENANT_ACME",
    conversationId: "a:1on1-carol",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "personal",
  });
  const m = bindTeams(auth);

  ok(m.mode === "dm", "C: personal -> dm mode");
  ok(m.visibility === "private", "C: a personal chat is never public");
  ok(m.surface === "a:1on1-carol", "C: surface = conversation id");
  ok(m.principalId === "29:user-carol", "C: principal = the DM caller");
}

{
  const auth = buildTeamsAuth({
    userId: "29:user-dan",
    tenantId: "TENANT_ACME",
    conversationId: "19:groupchat@thread.v2",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "groupChat",
    membershipType: "standard",
  });
  const m = bindTeams(auth);

  ok(m.mode === "mpim", "D: groupChat -> mpim mode");
  ok(m.visibility === "private", "D: a group chat is never public (even with membershipType=standard)");
}

console.log(`✓ teams: ${passed} assertions passed (activity → identity; fail-closed visibility)`);
