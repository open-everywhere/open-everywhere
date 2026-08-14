import {
  buildTeamsAuth,
  teamsMembershipType,
  teamsMode,
  teamsTrust,
  teamsTrustGroup,
  teamsUserTypeFromMember,
  teamsVisibility,
  type OpenEverywhereTeamsAuth,
  type TeamsIdentityInput,
} from "../agent/channels/teams-identity.js";
import { registerTeamsProvider } from "../agent/register.js";
import { teamsWakeOriginCodec, isTrustedTeamsServiceUrl } from "../agent/channels/teams-origin-codec.js";
import { teamsPostArm } from "../agent/channels/teams-post-arm.js";
import { buildTeamsDmWake } from "../agent/channels/teams-supervisor.js";
import {
  buildTeamsFrontHandler,
  teamsAuthorFacts,
  teamsExternalVerdict,
  teamsVendorExternal,
  type TeamsFrontPlan,
} from "../agent/channels/teams-front.js";
import {
  bindFrom,
  resolvePartition,
  resolveMemoryPlan,
  defineDomain,
  defineMemorySilo,
  defineSurface,
  registerSurfaces,
  _resetSurfacesForTest,
  defineAuthorTrust,
  registerAuthorTrust,
  _resetAuthorTrustForTest,
  OE_GRAIN_ATTR,
  type BindableContext,
  type ExternalPolicy,
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
      aadObjectId: "aad-alice",
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
  const RAW_CONV = "19:1on1-frank@thread.v2;messageid=99";
  const GOOD_URL = "https://smba.trafficmanager.net/uk/";

  ok(
    (teamsWakeOriginCodec as { dmOrigin?: unknown }).dmOrigin === undefined,
    "F: the teams codec no longer carries a `dmOrigin` arm — OPE-368 removed the DM delegation anchor it fed, so nothing mints an origin from a binding",
  );

  const { binding: dmBinding } = dispatch({
    userId: "29:user-frank",
    tenantId: "TENANT_ACME",
    conversationId: RAW_CONV,
    serviceUrl: GOOD_URL,
    scope: "personal",
  });
  ok(dmBinding.mode === "dm", "F: a personal-chat activity still binds mode `dm`");
  ok(dmBinding.target?.["conversationId"] === RAW_CONV, "F: the binding's TARGET carries the RAW conversation id (unsanitised through bindFrom) — what the DM divert addresses its window with");
  ok(dmBinding.surface !== RAW_CONV, "F: …while `surface` is seg()-sanitised, so it never was and never is an address");

  const v = (serviceUrl: unknown): boolean => teamsWakeOriginCodec.validate({ serviceUrl, conversationId: RAW_CONV });
  ok(v(GOOD_URL), "F/T1: a real Bot Connector host validates (the refusals below are host-specific, not blanket)");
  ok(!v("https://evil.example/api"), "F/T1: an UN-ALLOWLISTED https host is refused at the stored-row validator");
  ok(!v("http://smba.trafficmanager.net/uk/"), "F/T1: plain http is refused");
  ok(!v("https://smba.trafficmanager.net.evil.example/"), "F/T1: a lookalike-SUFFIX host is refused (the allowlist is dot-anchored, not substring)");
  ok(!v(""), "F/T1: a blank serviceUrl is refused");
  ok(!v(5), "F/T1: a non-string serviceUrl is refused");
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

  const prev = process.env["OE_DM_SEAT_ROTATION"];
  process.env["OE_DM_SEAT_ROTATION"] = "0";
  try {
    const stale = await run(activityBody("personal"));
    ok(stale.dm === 1, "H2: a STALE OE_DM_SEAT_ROTATION=0 in the env no longer disables the DM window — the flag is gone, the divert is unconditional");
    ok(stale.plan === 0 && stale.forward === 0, "H2: …and it still never consults planFor nor forwards to the native path");
  } finally {
    if (prev === undefined) delete process.env["OE_DM_SEAT_ROTATION"];
    else process.env["OE_DM_SEAT_ROTATION"] = prev;
  }
}

{
  ok(teamsTrustGroup("19-eng-team")?.trustGroup === "team:19-eng-team", "I1: teamsTrustGroup composes the `team:<id>` marker — the spelling an operator types into surfaces.ts");
  ok(teamsTrustGroup(undefined) === undefined, "I1: no team id (a personal or group chat) contributes NO rung");
  ok(teamsTrustGroup("has spaces/and:colons") === undefined, "I1: an unsafe team id is REFUSED, never repaired — a repaired segment could collide with a real key");

  const TENANT = "0d1f2e3a-4b5c";
  const TEAM = "19-eng-team-id";
  const activity = (teamId: string | undefined): BindableContext =>
    ({
      channel: { kind: "teams" },
      session: {
        auth: {
          current: buildTeamsAuth({
            userId: "29:user-a",
            tenantId: TENANT,
            conversationId: "19:conv-a@thread.tacv2",
            channelId: "19:chan-a@thread.tacv2",
            ...(teamId ? { teamId } : {}),
            serviceUrl: "https://smba.trafficmanager.net/emea/",
            scope: "channel",
          } as TeamsIdentityInput) as unknown as OpenEverywhereTeamsAuth,
        },
      },
    }) as unknown as BindableContext;

  try {
    registerSurfaces([defineSurface({ key: `teams/${TENANT}/team:${TEAM}`, trust: "public" })]);
    ok(bindFrom(activity(TEAM)).trust === "external", "I2: a `team:<id>` PUBLIC declaration demotes a channel inside that team");
    ok(bindFrom(activity("19-other-team")).trust === "external", "I2: a channel in ANOTHER team is untouched by it — and stays fail-closed external on its own");

    registerSurfaces([defineSurface({ key: `teams/${TENANT}/team:${TEAM}`, trust: "internal" })]);
    ok(bindFrom(activity(TEAM)).trust === "internal", "🔴 I3: a `team:<id>` INTERNAL declaration promotes a channel inside that team — the whole point of the rung");
    ok(bindFrom(activity("19-other-team")).trust === "external", "I3: NEGATIVE CONTROL — a channel in a different team is NOT promoted");
    ok(bindFrom(activity(undefined)).trust === "external", "I3: NEGATIVE CONTROL — an activity with no team id carries no rung and is NOT promoted");

    const withDecl = resolvePartition(activity(TEAM));
    _resetSurfacesForTest();
    const without = resolvePartition(activity(TEAM));
    ok(
      withDecl.surfaceKey === without.surfaceKey && withDecl.workspaceKey === without.workspaceKey,
      "I4: the team rung moves TRUST only — the surface key and workspace key are unchanged, so no memory/spend/audit grain moves",
    );
    ok(without.surfaceKey.split("/").length === 3, "I4: …and the key is still THREE segments — the rung is not a fourth segment");
  } finally {
    _resetSurfacesForTest();
  }
}

{
  const TENANT_J = "TENANT_J";
  const TEAM_J = "TEAM-J";
  const TENANT_KEY = `teams/${TENANT_J}`;
  const INSIDER_J = "29:ada";
  const OUTSIDER_J = "29:vendor-vic";
  const ROOM_J = `${TENANT_KEY}/19-conv-j`;
  const TAINT_ENGAGE: ExternalPolicy = { authorGrain: "taint", roomGrain: "engage" };
  const WITHHOLD: ExternalPolicy = { authorGrain: "withhold", roomGrain: "engage" };
  const SILENT: ExternalPolicy = { authorGrain: "taint", roomGrain: "silent" };

  const jAuth = (teamId: string | undefined): OpenEverywhereTeamsAuth =>
    buildTeamsAuth({
      userId: OUTSIDER_J,
      tenantId: TENANT_J,
      conversationId: "19:conv-j@thread.tacv2",
      ...(teamId ? { teamId } : {}),
      serviceUrl: "https://smba.trafficmanager.net/uk/",
      scope: "channel",
    });
  const facts = teamsAuthorFacts(jAuth(TEAM_J), OUTSIDER_J);
  ok(facts.authorTrust?.tenantKey === TENANT_KEY, "J1: the register question is asked at the TENANT key, built from the tenant id and nothing else");
  ok(facts.authorTrust?.authorId === OUTSIDER_J, "J1: …carrying the author's raw platform id");
  ok(
    JSON.stringify(facts.authorTrust?.memberships) === JSON.stringify([`${TENANT_KEY}/team:${TEAM_J}`]),
    "J1: …and the TEAM as the group rung, in the register's own pattern grammar",
  );
  ok(teamsAuthorFacts(jAuth(undefined), OUTSIDER_J).authorTrust?.memberships === undefined, "J1: a chat with no team contributes NO rung (absent, not empty)");
  ok(teamsAuthorFacts({ attributes: {} }, OUTSIDER_J).authorTrust === undefined, "J1: an unreadable tenant asks NOTHING — no arming key, no question");

  const chanData = (membershipType: string | undefined): Record<string, unknown> => ({
    channel: { id: "19:chan-j", ...(membershipType ? { membershipType } : {}) },
    team: { id: TEAM_J },
  });
  const act = (channelData: Record<string, unknown> | undefined) => ({ channelData }) as unknown as Parameters<typeof teamsVendorExternal>[0];
  ok(teamsVendorExternal(act(chanData("shared"))) === true, "J1: a SHARED channel is the vendor-external verdict — it can hold members from other tenants");
  ok(teamsVendorExternal(act(chanData("standard"))) === false, "J1: negative control: a standard channel is not (=== false)");
  ok(teamsVendorExternal(act(undefined)) === false, "J1: negative control: NO channelData is 'not reported', not evidence (=== false) — this leg fails OPEN");

  const verdict = (policy: ExternalPolicy, authorId: string, addressed: boolean, opts?: { isDm?: boolean; vendorExternal?: boolean }) =>
    teamsExternalVerdict({
      policy,
      author: { trust: "peer", ...teamsAuthorFacts(jAuth(TEAM_J), authorId) },
      addressed,
      isDm: opts?.isDm === true,
      vendorExternal: opts?.vendorExternal === true,
      roomKey: ROOM_J,
    });

  ok(verdict(WITHHOLD, OUTSIDER_J, true) === "proceed", "🔴 J2 UNARMED: `withhold` suppresses NOTHING on an unarmed tenant — silence is never a declaration");
  ok(verdict(SILENT, OUTSIDER_J, false) === "proceed", "🔴 J2 UNARMED + undeclared room: `silent` suppresses nothing either — there is no classification to act on");

  try {
    registerAuthorTrust([defineAuthorTrust({ tenant: TENANT_KEY, internal: [`teams/${INSIDER_J}`] })]);

    ok(verdict(TAINT_ENGAGE, OUTSIDER_J, true) === "proceed", "🔴 J2: on the SHIPPED grains an excluded author still proceeds — an upgrade changes nothing");
    ok(verdict(WITHHOLD, OUTSIDER_J, true) === "withheld-addressed", "J2 BEHAVIOUR 1: an excluded author's @mention or personal chat is owed a PRIVATE notice and nothing else");
    ok(verdict(WITHHOLD, OUTSIDER_J, false) === "withheld-ambient", "J2 BEHAVIOUR 2: an excluded author's ambient message is owed NOTHING — suppressed in silence");
    ok(verdict(WITHHOLD, INSIDER_J, true) === "proceed", "J2 negative control: a DECLARED author proceeds even on `withhold` (=== proceed)");

    ok(verdict(SILENT, OUTSIDER_J, false) === "silent-room", "J2 GUEST-PRESENT: on `silent` an excluded author in the room silences the wake");
    ok(verdict(SILENT, INSIDER_J, false) === "proceed", "J2 negative control: with only declared authors the room is not in the external class (=== proceed)");
    ok(
      verdict(SILENT, INSIDER_J, false, { vendorExternal: true }) === "silent-room",
      "🔴 J2 VENDOR-EXTERNAL: a SHARED CHANNEL silences the room on its own — the leg only Teams and Slack can produce",
    );
    ok(
      verdict(SILENT, INSIDER_J, false, { vendorExternal: true, isDm: true }) === "proceed",
      "🔴 J2: a DM contributes NO room leg (=== proceed) — on a DM the trust plane asks about the PARTNER, not about the room",
    );
    ok(
      teamsExternalVerdict({
        policy: { authorGrain: "withhold", roomGrain: "silent" },
        author: { trust: "peer", ...teamsAuthorFacts(jAuth(TEAM_J), OUTSIDER_J) },
        addressed: true,
        isDm: false,
        vendorExternal: true,
        roomKey: ROOM_J,
      }) === "withheld-addressed",
      "🔴 J2 ORDER: with BOTH grains on, an excluded author gets the AUTHOR verdict — they are owed a notice they can act on, not a room-wide announcement",
    );
    ok(
      verdict(WITHHOLD, OUTSIDER_J, true) === "withheld-addressed" && teamsExternalVerdict({
        policy: WITHHOLD,
        author: { trust: "relay", ...teamsAuthorFacts(jAuth(TEAM_J), OUTSIDER_J) },
        addressed: true,
        isDm: false,
        vendorExternal: false,
        roomKey: ROOM_J,
      }) === "proceed",
      "🔴 J2 negative control: a MACHINE author is NEVER excluded (=== proceed) — withholding every app's posts would be an outage",
    );
  } finally {
    _resetAuthorTrustForTest();
  }
  ok(verdict(WITHHOLD, OUTSIDER_J, true) === "proceed", "J2: the register is disarmed again after the reset");

  {
    const body = JSON.stringify({
      type: "message",
      id: "act-j",
      serviceUrl: "https://smba.trafficmanager.net/uk/",
      from: { id: OUTSIDER_J, name: "Vendor Vic" },
      recipient: { id: "28:bot" },
      conversation: { id: "19:conv-j@thread.v2", conversationType: "channel", tenantId: TENANT_J },
      channelData: { channel: { id: "19:chan-j" }, team: { id: TEAM_J } },
      text: "hello there",
    });
    const run = async (suppress: boolean) => {
      let dm = 0;
      let plan = 0;
      let forward = 0;
      let gated = 0;
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
          dmDivert: async () => {
            dm++;
          },
          externalGate: async () => {
            gated++;
            return suppress;
          },
        },
      );
      const args = { to: {} as never, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as Parameters<typeof handler>[1];
      const res = await handler(new Request("https://oe.test/eve/v1/teams", { method: "POST", body }), args);
      await Promise.all(waits);
      return { dm, plan, forward, gated, status: res.status };
    };

    const suppressed = await run(true);
    ok(suppressed.gated === 1, "J3: the gate runs ONCE per message activity, above both branches");
    ok(suppressed.forward === 0, "🔴 J3: a SUPPRESSED activity is NOT FORWARDED — this is what extends the policy to the native (window-gates-off) path");
    ok(suppressed.plan === 0, "🔴 J3: …and never reaches planFor, so it costs no partition/grain/floor work");
    ok(suppressed.dm === 0, "🔴 J3: …and never reaches the DM divert, so it mints no seat and no session");
    ok(suppressed.status === 200, "J3: it still ACKs 200 — a non-200 would make the Bot Framework redeliver the same activity");

    const proceeded = await run(false);
    ok(
      proceeded.gated === 1 && proceeded.plan === 1 && proceeded.forward === 1 && proceeded.dm === 0,
      "🔴 J3 NEGATIVE CONTROL: a gate that suppresses NOTHING leaves the route byte-identical — planFor runs and the null plan forwards",
    );
  }
}

console.log(`✓ teams: ${passed} assertions passed (activity → REAL bindFrom/partition/memory; fail-closed visibility + trust; the retired DM anchor + the surviving host allowlist; OPE-357 first-class DM window divert, unconditional since OPE-368; OPE-525 external-participant policy)`);
