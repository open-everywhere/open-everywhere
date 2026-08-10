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
import { registerTeamsProvider } from "../agent/register.js";
import { teamsWakeOriginCodec, isTrustedTeamsServiceUrl } from "../agent/channels/teams-origin-codec.js";
import { teamsPostArm } from "../agent/channels/teams-post-arm.js";
import { buildTeamsDmWake } from "../agent/channels/teams-supervisor.js";
import { buildTeamsFrontHandler, type TeamsFrontPlan } from "../agent/channels/teams-front.js";
import {
  bindFrom,
  resolvePartition,
  resolveMemoryPlan,
  defineDomain,
  defineMemorySilo,
  OE_GRAIN_ATTR,
  type BindableContext,
  type MemoryResolveConfig,
} from "@open-everywhere/core/agent/adapter-api.js";

registerTeamsProvider();

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

{
  const teamsDm = buildTeamsAuth({ userId: "U1", conversationId: "conv1", tenantId: "ten1", scope: "personal" });
  const teamsChan = buildTeamsAuth({ userId: "U1", conversationId: "conv1", tenantId: "ten1", scope: "channel", channelId: "ch1", teamId: "team1" });
  const teamsGroup = buildTeamsAuth({ userId: "U1", conversationId: "conv1", tenantId: "ten1", scope: "groupChat" });
  ok(teamsDm.attributes[OE_GRAIN_ATTR] === "standing", "buildTeamsAuth(personal) stamps oe_grain=standing");
  ok(!(OE_GRAIN_ATTR in teamsChan.attributes), "buildTeamsAuth(channel) does NOT stamp a grain");
  ok(teamsGroup.attributes[OE_GRAIN_ATTR] === "standing", "buildTeamsAuth(groupChat ⇒ mpim) stamps oe_grain=standing (widened)");
}

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

{
  const arm = teamsWakeOriginCodec.dmOrigin;
  ok(typeof arm === "function", "F: the teams codec REGISTERS a dmOrigin arm (the OPE-315 parity landing)");

  const RAW_CONV = "19:1on1-frank@thread.v2;messageid=99";
  const GOOD_URL = "https://smba.trafficmanager.net/uk/";
  const { binding: dmBinding } = dispatch({
    userId: "29:user-frank",
    tenantId: "TENANT_ACME",
    conversationId: RAW_CONV,
    serviceUrl: GOOD_URL,
    scope: "personal",
  });
  ok(dmBinding.mode === "dm", "F: the fixture really is a dm-mode binding");
  ok(dmBinding.target?.["conversationId"] === RAW_CONV, "F: the binding's TARGET carries the RAW conversation id (unsanitised through bindFrom)");
  ok(dmBinding.surface !== RAW_CONV, "F: …while `surface` is seg()-sanitised — which is exactly why the arm may not read it");

  const slice = { surface: dmBinding.surface, threadTs: dmBinding.threadTs, mode: "dm" as const, target: dmBinding.target };
  const minted = arm?.(slice);
  ok(
    JSON.stringify(minted) === JSON.stringify({ platform: "teams", serviceUrl: GOOD_URL, conversationId: RAW_CONV }),
    "F: the arm mints {platform, serviceUrl, conversationId} straight off the target — no replyToActivityId (a personal chat has no reply chain), no tenantId (audit-only)",
  );
  ok(minted !== undefined && teamsWakeOriginCodec.validate(minted as unknown as Record<string, unknown>), "F: the minted origin passes the STORED-ROW validator unchanged (one shape, one contract)");

  const diverged = arm?.({ surface: "some-other-sanitised-surface", mode: "dm", target: { serviceUrl: GOOD_URL, conversationId: RAW_CONV } });
  ok(diverged?.conversationId === RAW_CONV, "F: the arm reads the TARGET, never the surface (pinned by diverging the two)");

  const groupMint = arm?.({ surface: "19-groupchat-thread.v2", mode: "mpim", target: { serviceUrl: GOOD_URL, conversationId: "19:groupchat@thread.v2" } });
  ok(groupMint?.conversationId === "19:groupchat@thread.v2", "F: a GROUP chat (mpim) resolves an anchor too");

  ok(arm?.({ surface: "s", mode: "dm" }) === undefined, "F: NO target at all ⇒ undefined");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: GOOD_URL } }) === undefined, "F: missing conversationId ⇒ undefined");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: GOOD_URL, conversationId: "" } }) === undefined, "F: BLANK conversationId ⇒ undefined");
  ok(arm?.({ surface: "s", mode: "dm", target: { conversationId: RAW_CONV } }) === undefined, "F: missing serviceUrl ⇒ undefined");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: "", conversationId: RAW_CONV } }) === undefined, "F: BLANK serviceUrl ⇒ undefined");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: 5, conversationId: RAW_CONV } }) === undefined, "F: non-string serviceUrl ⇒ undefined");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: GOOD_URL, conversationId: 5 } }) === undefined, "F: non-string conversationId ⇒ undefined");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: "https://evil.example/api", conversationId: RAW_CONV } }) === undefined, "F/T1: an UN-ALLOWLISTED https host ⇒ no anchor (fail closed at MINT, not at reply)");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: "http://smba.trafficmanager.net/uk/", conversationId: RAW_CONV } }) === undefined, "F/T1: plain http ⇒ no anchor");
  ok(arm?.({ surface: "s", mode: "dm", target: { serviceUrl: "https://smba.trafficmanager.net.evil.example/", conversationId: RAW_CONV } }) === undefined, "F/T1: a lookalike-SUFFIX host ⇒ no anchor");
  ok(arm?.({ surface: "s", mode: "channel" as unknown as "dm", target: { serviceUrl: GOOD_URL, conversationId: RAW_CONV } }) === undefined, "F: a CHANNEL mode ⇒ no anchor (the arm refuses on its own account)");
}

{
  const prevAppId = process.env.MICROSOFT_APP_ID;
  process.env.MICROSOFT_APP_ID = "app-id-for-the-test";
  try {
    const EVIL = "https://evil.example/api";
    const dispatchReply = teamsPostArm.dispatchReply;
    ok(typeof dispatchReply === "function", "G/T4: the teams post arm HAS a mid-turn dispatch path (the one this check guards)");
    let message = "";
    try {
      await dispatchReply?.({ platform: "teams", serviceUrl: EVIL, conversationId: "19:conv@thread.v2" }, "leak me");
      ok(false, "G/T4: dispatchTeamsReply must REFUSE an un-allowlisted serviceUrl");
    } catch (e) {
      message = String((e as Error).message);
    }
    ok(message.includes("not a Bot Framework host"), "G/T4: …and it refuses for the RIGHT reason (the host allowlist, not a transport failure)");
    ok(!message.includes(EVIL), "G/T4: the error is host-free (never echo the attacker-supplied endpoint back)");
    ok(!/password|secret|token|bearer/i.test(message), "G/T4: …and token-free, mirroring liveTeamsPost's defensive parity");
    ok(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net/uk/"), "G/T4: the same predicate ADMITS a real Bot Connector host (the refusal is host-specific)");
  } finally {
    if (prevAppId === undefined) delete process.env.MICROSOFT_APP_ID;
    else process.env.MICROSOFT_APP_ID = prevAppId;
  }
}

{
  const w = buildTeamsDmWake({
    conversationId: "19:1on1@thread.v2",
    wakeId: "wk-1",
    trigger: { id: "act-1", author: "Frank", authorId: "29:frank", sentAt: "2026-08-10T00:00:00Z", text: "hello" },
  });
  ok(w.platform === "teams", "H1: platform teams");
  ok(w.reason === "dm", "H1: reason is `dm` (the SURFACE SHAPE, not `mention` — core opens with the DM sentence)");
  ok(w.addressing === "direct-mention", "H1: addressing is `direct-mention` ALWAYS (a DM is always answered; arms the addressed-prose bridge)");
  ok(w.unifiedDisclosure === undefined, "H1: NO unifiedDisclosure (a DM window sees exactly one surface — no cross-surface fan-in to disclose)");
  ok(w.engagementTier === undefined, "H1: NO engagementTier (the ambient dial does not apply to an always-answered DM)");
  ok(w.locus?.channel?.id === "19:1on1@thread.v2" && w.locus?.channel?.platform === undefined, "H1: locus is the DM conversation, with NO platform address stamp (one surface)");
  ok(w.trigger.kind === "message", "H1: message trigger");
  ok(w.trigger.kind === "message" && w.trigger.message.mention === true, "H1: mention:true (the response-obligation flag, as Slack/Discord carry it)");
  ok(w.trigger.kind === "message" && w.trigger.message.from === "human", "H1: from:human (bot/self authors are dropped upstream)");
  ok(w.trigger.kind === "message" && w.trigger.message.trust === "principal", "H1: trust defaults to `principal` (a DM partner is the seat's principal)");
  const wOverride = buildTeamsDmWake({
    conversationId: "19:1on1@thread.v2",
    wakeId: "wk-2",
    trigger: { id: "act-2", author: "Frank", authorId: "29:frank", sentAt: "2026-08-10T00:00:00Z", text: "hi", trust: "relay" },
  });
  ok(wOverride.trigger.kind === "message" && wOverride.trigger.message.trust === "relay", "H1: an explicit trust tier overrides the principal default (the live dispatch resolves it)");
  const wHandoff = buildTeamsDmWake({
    conversationId: "19:1on1@thread.v2",
    wakeId: "wk-3",
    handoffNote: "open ask: ship the report",
    handoffFromGeneration: 4,
    trigger: { id: "act-3", author: "Frank", authorId: "29:frank", sentAt: "2026-08-10T00:00:00Z", text: "?" },
  });
  ok(wHandoff.handoff?.note === "open ask: ship the report" && wHandoff.handoff?.fromGeneration === 4, "H1: a fresh generation carries the rotation handoff note (the ONLY thing it carries — no backscroll)");
}

{
  const GOOD_URL = "https://smba.trafficmanager.net/uk/";
  const activityBody = (scope: "personal" | "groupChat" | "channel"): string => {
    const conversationType = scope;
    const conversation: Record<string, unknown> = { id: "19:conv-h@thread.v2", conversationType, tenantId: "TENANT_H" };
    const base: Record<string, unknown> = {
      type: "message",
      id: `act-${scope}`,
      serviceUrl: GOOD_URL,
      from: { id: "29:user-h", name: "Hazel" },
      recipient: { id: "28:bot" },
      conversation,
      text: "hello there",
    };
    if (scope === "channel") base.channelData = { channel: { id: "19:team-chan" }, team: { id: "TEAM_H" } };
    return JSON.stringify(base);
  };

  async function run(body: string): Promise<{ dm: number; dmSurface?: string; plan: number; forward: number }> {
    let dm = 0;
    let dmSurface: string | undefined;
    let plan = 0;
    let forward = 0;
    const waits: Promise<unknown>[] = [];
    const handler = buildTeamsFrontHandler(
      async () => {
        forward++;
        return new Response("native");
      },
      {
        verify: async () => body,
        markEventSeen: async () => true,
        planFor: (): TeamsFrontPlan | null => {
          plan++;
          return null;
        },
        dmDivert: async (_a, _auth, partition) => {
          dm++;
          dmSurface = partition.surfaceKey;
        },
      },
    );
    const args = { to: {} as never, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as Parameters<typeof handler>[1];
    await handler(new Request("https://oe.test/eve/v1/teams", { method: "POST", body }), args);
    await Promise.all(waits);
    return { dm, dmSurface, plan, forward };
  }

  const personal = await run(activityBody("personal"));
  ok(personal.dm === 1, "H2: a PERSONAL chat diverts to its own DM window (dmDivert called once)");
  ok(personal.plan === 0, "H2: …and NEVER consults planFor / the shared-window privacy floor (the DM branch sits before it)");
  ok(personal.forward === 0, "H2: …and is not forwarded to the native channel");
  ok(personal.dmSurface?.startsWith("teams/TENANT_H/") === true, "H2: the DM window is keyed on the DM's OWN surface key (real bindFrom → resolvePartition)");

  const group = await run(activityBody("groupChat"));
  ok(group.dm === 1 && group.plan === 0 && group.forward === 0, "H2: a GROUP chat diverts on the same terms (the predicate covers personal + groupChat, the Slack mpim parity)");

  const channel = await run(activityBody("channel"));
  ok(channel.dm === 0, "H2: a CHANNEL activity does NOT take the DM branch");
  ok(channel.plan === 1, "H2: …it reaches planFor (the shared single-window path), unchanged");
  ok(channel.forward === 1, "H2: …and forwards here because this fixture's planFor returns null (byte-identical native fallback)");

  const prev = process.env.OE_DM_SEAT_ROTATION;
  process.env.OE_DM_SEAT_ROTATION = "0";
  try {
    const off = await run(activityBody("personal"));
    ok(off.dm === 0, "H2: with OE_DM_SEAT_ROTATION=0 the DM does NOT divert (fail-closed to native)");
    ok(off.plan === 1 && off.forward === 1, "H2: …it takes the ordinary planFor→forward native path, byte-identical to pre-OPE-357");
  } finally {
    if (prev === undefined) delete process.env.OE_DM_SEAT_ROTATION;
    else process.env.OE_DM_SEAT_ROTATION = prev;
  }
}

console.log(`✓ teams: ${passed} assertions passed (activity → REAL bindFrom/partition/memory; fail-closed visibility + trust; DM delegation anchor + the mid-turn host allowlist; OPE-357 first-class DM window divert)`);
