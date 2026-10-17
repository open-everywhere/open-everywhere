import { POST, type Channel, type HttpRouteDefinition, type RouteHandlerArgs } from "eve/channels";
import { verifyTeamsRequest, parseTeamsActivity, teamsThreadRootActivityId, isTeamsInputResponseActivity, type TeamsMessageActivity } from "eve/channels/teams";
import { sendTeamsActivityBackedOff } from "./teams-connector.js";
import { isTeamsChannelActivity } from "./teams-origin-codec.js";
import {
  buildTeamsAuth,
  teamsMembershipType,
  teamsTrustGroup,
  teamsUserTypeFromMember,
  withTeamsUserType,
  type OpenEverywhereTeamsAuth,
} from "./teams-identity.js";
import { resolveTeamsUserType, teamsIsHomeTenant, teamsRosterHasMember, teamsServiceUrlRosterProbe, type TeamsRosterProbe } from "./teams-roster.js";
import { recordTeamsConversationReference, teamsChannelGrainConversationId, teamsReplyChainRoot } from "./teams-conversation-ref.js";
import { parseTeamsReaction, routeTeamsStopReaction, type TeamsReactionActivity, type TeamsStopOutcome } from "./teams-stop.js";
import { parseTeamsFeedbackInvoke, routeTeamsFeedbackInvoke } from "./teams-reply-feedback.js";
import {
  clearTeamsRoomStop,
  markTeamsEngaged,
  markTeamsRoomWatched,
  resolveTeamsEngagement,
  teamsMachineAuthored,
  teamsRoomWatchStopped,
  type TeamsEngagementVerdict,
} from "./teams-engagement.js";
import { teamsGraphTeamId } from "./teams-graph-team-id.js";
import { resolveTeamsNameDrop } from "./teams-name-drop.js";
import { parseTeamsOeCommand } from "./teams-commands.js";
import { liveTeamsChannelIntro, liveTeamsFirstContactIntro, parseTeamsBotAdded, type TeamsBotAddedUpdate, type TeamsIntroOutcome } from "./teams-intro.js";
import { handleTeamsApprovalInvoke, parseTeamsApprovalInvoke, type TeamsApprovalInvoke, type TeamsInvokeResponseBody } from "../approvals/teams-flow.js";
import {
  planTeamsSingleWindow,
  handleTeamsSingleWindowDispatch,
  teamsMentionedPersonIds,
  teamsSupervisorToken,
  buildTeamsDmWake,
  type TeamsCoverFacts,
  type TeamsSupervisorDeps,
  type TeamsSingleWindowFacts,
} from "./teams-supervisor.js";
import {
  commandFailureText,
  shouldRotate,
  EventDedupe,
  ThreadFifo,
  divertToUnifiedWindow,
  divertInboundToUnifiedWindow,
  supervisorGrainFor,
  mintRotationToken,
  claimRuntimeRotation,
  stampMintedRuntime,
  grainUsesUnifiedWindow,
  resolvePartition,
  domainKeyOf,
  engagementTierFor,
  getConfig,
  getOperationalStore,
  isVouchedSurface,
  trustGroupKeyFor,
  resolveWakeTrustFromContext,
  stampNonMemberChatAuth,
  deploymentOrg,
  appendAudit,
  getOrCreateDmSeat,
  touchDmSeat,
  renderWake,
  mintWakeId,
  resolveExternalPolicy,
  externalPolicyOverrideFor,
  externalPolicyIsInert,
  withholdsBody,
  roomIsSilenced,
  silentRoomNotice,
  silentNoticeKey,
  EXTERNAL_SENDER_NOTICE,
  EXTERNAL_MENTION_ACK,
  owesSuppressedMentionAck,
  suppressionRendering,
  type ExternalPolicy,
  type IngestedChatMessage,
  type AuthorTrustQuery,
  type SupervisorGrain,
  type UnifiedWindowWake,
  type UnifiedWakeOrigin,
  type Partition,
  type BindableContext,
  carryTailForward,
  type WakeMessageInput,
  recordWakeTail,
  tailAuthorGrain,
  dmWindowRegistryKey,
  type AttachSessionForCancel,
  RateLimitExhaustedError,
  receiptEventTime,
  spreadVendorTs,
  seatCatchUp,
  getSettings,
  bindFrom,
  auditSurfaceModeStamp,
  auditSurfaceModeFrom,
  runOeCommand,
  oeSlash,
  type OeCommand,
} from "@open-everywhere/core/agent/adapter-api.js";

type RouteHandler = (req: Request, args: RouteHandlerArgs) => Promise<Response>;

export const PUBLIC_TEAMS_ROUTE = "/eve/v1/teams";
export const INTERNAL_TEAMS_ROUTE = "/eve/v1/teams/native";

function tlog(msg: string): void {
  console.log(`[open-everywhere:teams-front] ${msg}`);
}

export interface TeamsFrontPlan {
  readonly window: UnifiedWindowWake;
  readonly surfaceKey: string;
  readonly partition: Partition;
  readonly grain: SupervisorGrain;
  readonly auth: OpenEverywhereTeamsAuth;
}

function teamsAttrs(auth: unknown): Record<string, unknown> {
  const a = (auth as { attributes?: unknown } | null)?.attributes;
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

function teamsAuthorRefuted(auth: unknown): boolean {
  const a = teamsAttrs(auth);
  return teamsUserTypeFromMember({ userType: a["user_type"] ?? a["userType"] }) === "guest";
}

function teamsRoomGroupKey(auth: unknown): { readonly groupKey?: string } {
  const a = teamsAttrs(auth);
  const tenant = a["tenant_id"] ?? a["tenantId"];
  const group = teamsTrustGroup(typeof (a["team_id"] ?? a["teamId"]) === "string" ? String(a["team_id"] ?? a["teamId"]) : undefined);
  if (typeof tenant !== "string" || tenant.length === 0 || !group) return {};
  return { groupKey: `teams/${tenant}/${group.trustGroup}` };
}

function authForActivity(a: TeamsMessageActivity): OpenEverywhereTeamsAuth {
  return buildTeamsAuth({
    userId: a.from.id,
    aadObjectId: a.from.aadObjectId,
    userName: a.from.name,
    tenantId: a.tenantId ?? a.conversation.tenantId,
    conversationId: a.conversation.id,
    channelId: a.teamsChannelId,
    teamId: a.teamId,
    serviceUrl: a.serviceUrl,
    scope: a.scope,
    membershipType: teamsMembershipType(a.channelData),
  });
}

export type TeamsRosterProbeFor = (activity: TeamsMessageActivity) => TeamsRosterProbe | undefined;

async function teamsAuthWithUserType<A extends OpenEverywhereTeamsAuth>(
  auth: A,
  a: TeamsMessageActivity,
  probeFor?: TeamsRosterProbeFor,
): Promise<A> {
  const factory: TeamsRosterProbeFor = probeFor ?? ((activity) => teamsServiceUrlRosterProbe(activity.serviceUrl));
  try {
    const userType = await resolveTeamsUserType(factory(a), a.conversation.id, a.from.id);
    const homeTenant = userType === "member" ? await teamsIsHomeTenant(a.tenantId ?? a.conversation.tenantId) : undefined;
    return withTeamsUserType(auth, userType, homeTenant);
  } catch {
    return auth;
  }
}

function teamsExternalPolicyForRoom(roomKey: string): ExternalPolicy {
  try {
    return resolveExternalPolicy(externalPolicyOverrideFor(roomKey, getConfig().loadDomains()));
  } catch {
    return resolveExternalPolicy();
  }
}

export function teamsAuthorFacts(auth: unknown, authorId: string | undefined): { readonly authorTrust?: AuthorTrustQuery } {
  const a = teamsAttrs(auth);
  const tenant = a["tenant_id"] ?? a["tenantId"];
  if (typeof tenant !== "string" || tenant.length === 0) return {};
  const group = teamsTrustGroup(typeof (a["team_id"] ?? a["teamId"]) === "string" ? String(a["team_id"] ?? a["teamId"]) : undefined);
  return {
    authorTrust: {
      tenantKey: `teams/${tenant}`,
      ...(authorId ? { authorId } : {}),
      ...(group ? { memberships: [`teams/${tenant}/${group.trustGroup}`] } : {}),
    },
  };
}

export function teamsVendorExternal(a: TeamsMessageActivity): boolean {
  return teamsMembershipType(a.channelData) === "shared";
}

export type TeamsExternalVerdict = "proceed" | "withheld-addressed" | "withheld-ambient" | "silent-room";

export function teamsExternalVerdict(input: {
  readonly policy: ExternalPolicy;
  readonly author: IngestedChatMessage;
  readonly addressed: boolean;
  readonly isDm: boolean;
  readonly vendorExternal: boolean;
  readonly roomKey: string;
  readonly groupKey?: string;
}): TeamsExternalVerdict {
  if (withholdsBody(input.author, input.policy)) return input.addressed ? "withheld-addressed" : "withheld-ambient";
  const room = input.isDm ? { dm: true } : { surfaceKey: input.roomKey, ...(input.groupKey === undefined ? {} : { groupKey: input.groupKey }) };
  return roomIsSilenced(
    { room, ...(input.vendorExternal ? { vendorExternal: true } : {}), ingested: [input.author] },
    input.policy,
  )
    ? "silent-room"
    : "proceed";
}

async function postTeamsNotice(a: TeamsMessageActivity, text: string): Promise<boolean> {
  try {
    await sendTeamsActivityBackedOff(
      { serviceUrl: a.serviceUrl, conversationId: a.conversation.id, body: { type: "message", text } },
      { retry: { maxAttempts: 2, capMs: 2_000 } },
    );
    return true;
  } catch (err) {
    if (err instanceof RateLimitExhaustedError) {
      console.warn(`[open-everywhere:teams] rate limited: conversations.activities.send gave up after ${err.attempts} attempts (waited ${err.waitedMs} ms)`);
    }
    return false;
  }
}

async function postTeamsExternalSenderNotice(a: TeamsMessageActivity): Promise<boolean> {
  if (a.scope !== "personal") return false;
  return await postTeamsNotice(a, EXTERNAL_SENDER_NOTICE);
}

async function announceTeamsSilentRoom(a: TeamsMessageActivity, org: string, surfaceKey: string): Promise<boolean> {
  if (!org) return false;
  try {
    const won = await getOperationalStore().claimNotice(org, silentNoticeKey(surfaceKey, "suppressed-wake"), new Date().toISOString());
    if (!won) return false;
  } catch {
    return false;
  }
  return await postTeamsNotice(a, silentRoomNotice("suppressed-wake"));
}

export async function liveTeamsExternalGate(a: TeamsMessageActivity, probeFor?: TeamsRosterProbeFor): Promise<boolean> {
  const isDm = a.scope === "personal" || a.scope === "groupChat";
  let auth: OpenEverywhereTeamsAuth;
  let partition: Partition;
  let roomKey: string;
  let auditMode: ReturnType<typeof auditSurfaceModeFrom>;
  try {
    auth = authForActivity(a);
    partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
    auditMode = auditSurfaceModeFrom({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
    roomKey = isDm ? partition.surfaceKey : domainKeyOf(partition);
  } catch {
    return false;
  }
  const policy = teamsExternalPolicyForRoom(roomKey);
  if (!externalPolicyIsInert(policy)) auth = await teamsAuthWithUserType(auth, a, probeFor);
  const trust = resolveWakeTrustFromContext(
    { channel: { kind: "teams" }, session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } } },
    { id: a.from.id, isBot: false },
    { principalFallback: true },
  );
  const addressed = a.isBotMentioned === true || a.scope === "personal";
  const verdict = teamsExternalVerdict({
    policy,
    author: { trust, refuted: teamsAuthorRefuted(auth), ...teamsAuthorFacts(auth, a.from.id) },
    addressed,
    isDm,
    vendorExternal: teamsVendorExternal(a),
    roomKey,
    ...teamsRoomGroupKey(auth),
  });
  if (verdict === "proceed") return false;
  let alreadyAnswered = false;
  if (verdict === "withheld-addressed") alreadyAnswered = await postTeamsExternalSenderNotice(a).catch(() => false);
  if (verdict === "silent-room") alreadyAnswered = await announceTeamsSilentRoom(a, partition.org, roomKey).catch(() => false);
  const acked =
    owesSuppressedMentionAck({ addressed, alreadyAnswered }) && (await postTeamsNotice(a, EXTERNAL_MENTION_ACK).catch(() => false));
  await appendAudit({
    org: partition.org || deploymentOrg(),
    platform: "teams",
    workspace: partition.workspace,
    surface: roomKey,
    ...auditMode,
    principalId: a.from.id,
    action: "teams.external_policy_suppressed",
    detail: { verdict, conversationId: a.conversation.id, ...suppressionRendering(acked) },
  }).catch(() => undefined);
  tlog(`suppressed ${roomKey}: externalPolicy verdict "${verdict}"`);
  return true;
}

function liveTeamsFrontPlan(a: TeamsMessageActivity): TeamsFrontPlan | null {
  try {
    const auth = authForActivity(a);
    const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
    const surfaceKey = domainKeyOf(partition);
    const grain = supervisorGrainFor(surfaceKey, getConfig().loadDomains());
    if (!grainUsesUnifiedWindow(grain)) return null;
    const tenantId = a.tenantId ?? a.conversation.tenantId;
    const groupKey = trustGroupKeyFor(partition.workspaceKey, teamsTrustGroup(a.teamId)?.trustGroup);
    const facts: TeamsSingleWindowFacts = {
      scope: a.scope,
      membershipType: teamsMembershipType(a.channelData),
      tenantId,
      vouched:
        isVouchedSurface(partition.surfaceKey, { containerKey: surfaceKey, ...(groupKey === undefined ? {} : { groupKey }) }) ||
        getSettings().identity.blanketTrust === "internal",
    };
    const window = planTeamsSingleWindow(true, a.isBotMentioned, facts, {
      serviceUrl: a.serviceUrl,
      conversationId: a.conversation.id,
      replyToActivityId: teamsThreadRootActivityId(a) ?? undefined,
      tenantId,
      ...spreadVendorTs(receiptEventTime(Date.now())),
    });
    if (!window) return null;
    return { window, surfaceKey, partition, grain, auth };
  } catch {
    return null;
  }
}

export function liveTeamsSupervisorDeps(plan: TeamsFrontPlan, to: RouteHandlerArgs["to"]): TeamsSupervisorDeps {
  const org = plan.partition.org;
  const store = getOperationalStore();
  const grain = plan.grain;
  return {
    async getOrCreateSession(_surfaceKey, channelId, atIso) {
      const runtimeChanged = await claimRuntimeRotation({ org, registryKey: grain.registryKey, surfaceKey: plan.surfaceKey, domainName: grain.domainName, atIso });
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, 1, () => teamsSupervisorToken(channelId, 1)), atIso);
        await stampMintedRuntime({ org, registryKey: grain.registryKey, surfaceKey: plan.surfaceKey, domainName: grain.domainName, atIso });
        return { token: row.token, generation: row.generation, freshGeneration: true, tail: [] as readonly WakeMessageInput[] };
      }
      if (shouldRotate(existing, atIso, { runtimeChanged })) {
        const gen = existing.generation + 1;
        const tail = await carryTailForward(org, grain.registryKey, existing.token);
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => teamsSupervisorToken(channelId, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, tail };
      }
      return {
        token: existing.token,
        generation: existing.generation,
        freshGeneration: existing.firstWakeAt == null,
        tail: [] as readonly WakeMessageInput[],
        lastWakeAt: existing.lastWakeAt ?? null,
      };
    },
    touchSession: (_surfaceKey, atIso) => store.touchChannelSession(org, grain.registryKey, atIso),
    catchUp: (req) => seatCatchUp("teams", req),
    recordWake: (entry, token) => recordWakeTail(org, grain.registryKey, token, entry),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, window }) {
      await divertInboundToUnifiedWindow(to, {
        message,
        ...(context.length > 0 ? { context } : {}),
        token,
        window,
        surfaceKey: plan.surfaceKey,
        auth: auth as unknown as { attributes?: Record<string, unknown> },
      });
    },
  };
}

export interface TeamsOeCommandDeps {
  readonly run?: typeof runOeCommand;
  readonly send?: (input: { readonly serviceUrl: string; readonly conversationId: string; readonly body: unknown }) => Promise<unknown>;
  readonly probeFor?: TeamsRosterProbeFor;
  readonly audit?: typeof appendAudit;
}

export async function liveTeamsOeCommand(
  a: TeamsMessageActivity,
  command: OeCommand,
  attachSession: AttachSessionForCancel | undefined,
  deps: TeamsOeCommandDeps = {},
): Promise<void> {
  let text: string;
  try {
    const auth = await teamsAuthWithUserType(authForActivity(a), a, deps.probeFor);
    const binding = bindFrom({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
    await (deps.audit ?? appendAudit)({
      org: binding.org,
      platform: "teams",
      workspace: binding.workspace,
      surface: `${binding.platform}/${binding.workspace}/${binding.surface}`,
      ...auditSurfaceModeStamp(binding),
      principalId: a.from.id,
      action: "teams.oe_command",
      detail: { command: command.kind, conversationId: a.conversation.id },
    }).catch(() => undefined);
    text = await (deps.run ?? runOeCommand)(command, binding, attachSession ? { attachSession } : {});
  } catch (err) {
    console.error(`[open-everywhere:teams-front] "${oeSlash()}" command failed softly: ${String(err)}`);
    text = commandFailureText(err);
  }
  if (text.length === 0) return;
  try {
    await (deps.send ?? sendTeamsActivityBackedOff)({ serviceUrl: a.serviceUrl, conversationId: a.conversation.id, body: { type: "message", text } });
  } catch (err) {
    tlog(`"${oeSlash()}" answer could not be posted in ${a.conversation.id}: ${String(err)}`);
  }
}

export interface TeamsFrontOptions {
  readonly verify?: (req: Request) => Promise<string>;
  readonly dedupe?: EventDedupe;
  readonly fifo?: ThreadFifo;
  readonly now?: () => number;
  readonly markEventSeen?: (org: string, key: string, atIso: string) => Promise<boolean>;
  readonly planFor?: (a: TeamsMessageActivity) => TeamsFrontPlan | null;
  readonly dispatch?: (a: TeamsMessageActivity, plan: TeamsFrontPlan, to: RouteHandlerArgs["to"]) => Promise<void>;
  readonly dmDivert?: (a: TeamsMessageActivity, auth: OpenEverywhereTeamsAuth, partition: Partition, to: RouteHandlerArgs["to"]) => Promise<void>;
  readonly externalGate?: (a: TeamsMessageActivity) => Promise<boolean>;
  readonly stopReaction?: (rx: TeamsReactionActivity, attachSession: AttachSessionForCancel) => Promise<TeamsStopOutcome>;
  readonly engagementSeam?: (a: TeamsMessageActivity, machineAuthored: boolean) => Promise<TeamsEngagementVerdict>;
  readonly markEngaged?: (a: TeamsMessageActivity) => Promise<string | null>;
  readonly roomStopped?: (partition: Partition) => Promise<boolean>;
  readonly markRoomWatched?: (partition: Partition, atIso: string) => Promise<void>;
  readonly clearRoomStop?: (partition: Partition, atIso: string, engagedBy: string) => Promise<void>;
  readonly approvalInvoke?: (invoke: TeamsApprovalInvoke, waitUntil: (p: Promise<unknown>) => void) => Promise<TeamsInvokeResponseBody>;
  readonly oeCommand?: (a: TeamsMessageActivity, command: OeCommand, attachSession: AttachSessionForCancel | undefined) => Promise<void>;
  readonly channelIntro?: (update: TeamsBotAddedUpdate) => Promise<TeamsIntroOutcome>;
  readonly firstContactIntro?: (a: TeamsMessageActivity) => Promise<TeamsIntroOutcome>;
}

const OK = () => new Response("ok");
const NOT_TEAMS = () => new Response("this bot serves the Microsoft Teams channel only", { status: 403 });

function describeChannelId(parsed: unknown): string {
  const v = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["channelId"] : undefined;
  return typeof v === "string" ? JSON.stringify(v.slice(0, 40)) : "absent";
}

export function guardTeamsChannelOnly(inner: RouteHandler): RouteHandler {
  return async (req: Request, args: RouteHandlerArgs): Promise<Response> => {
    const rawBody = await req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && !isTeamsChannelActivity(parsed)) {
      tlog(`refused a non-Teams activity on the internal route (channelId ${describeChannelId(parsed)})`);
      return NOT_TEAMS();
    }
    return inner(new Request(req.url, { method: "POST", headers: req.headers, body: rawBody }), args);
  };
}

const DEDUPE_TTL_MS = 10 * 60_000;
let warnedDedupeStore = false;
async function liveMarkEventSeen(org: string, key: string, atIso: string): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, DEDUPE_TTL_MS);
  } catch (err) {
    if (!warnedDedupeStore) {
      warnedDedupeStore = true;
      console.warn(`[open-everywhere:teams-front] durable dedupe unavailable — in-memory only: ${String(err)}`);
    }
    return true;
  }
}

function recordTeamsWakeFailure(key: string, err: unknown): void {
  void appendAudit({
    org: deploymentOrg(),
    platform: "teams",
    workspace: key.split("/")[1] ?? "unknown",
    surface: key,
    action: "surface.wake_failed",
    detail: { fifoKey: key, message: String(err instanceof Error ? err.message : err).slice(0, 500) },
  }).catch(() => undefined);
}

export function teamsCoverFacts(a: TeamsMessageActivity, partition: Partition, probeFor?: TeamsRosterProbeFor): TeamsCoverFacts {
  const factory: TeamsRosterProbeFor = probeFor ?? ((activity) => teamsServiceUrlRosterProbe(activity.serviceUrl));
  const probe = teamsMembershipType(a.channelData) === "standard" && a.teamId ? factory(a) : undefined;
  return {
    org: partition.org,
    workspace: partition.workspace,
    surface: partition.surface,
    mentionedIds: teamsMentionedPersonIds(a.mentions, a.recipient.id),
    ...(probe && a.teamId ? { confirmInRoom: (id: string) => teamsRosterHasMember(probe, a.teamId, id) } : {}),
  };
}

export async function liveTeamsDispatch(
  a: TeamsMessageActivity,
  plan: TeamsFrontPlan,
  to: RouteHandlerArgs["to"],
  probeFor?: TeamsRosterProbeFor,
  nameDropFor: (a: TeamsMessageActivity, partition: Partition) => Promise<boolean> = (activity, partition) => resolveTeamsNameDrop(activity, partition, "seat"),
): Promise<void> {
  const auth = await teamsAuthWithUserType(plan.auth, a, probeFor);
  const wakeCtx: BindableContext = { channel: { kind: "teams" }, session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } } };
  const trust = resolveWakeTrustFromContext(wakeCtx, { id: a.from.id, isBot: false }, { principalFallback: true });
  let engagementTier: ReturnType<typeof engagementTierFor> | undefined;
  try {
    engagementTier = engagementTierFor(plan.surfaceKey, getConfig().loadDomains());
  } catch {
    engagementTier = undefined;
  }
  const graphTeamId = await teamsGraphTeamId(a.teamId, a.serviceUrl);
  const replyChainRootId = teamsReplyChainRoot(a.conversation.id);
  const directMention = plan.window.addressing === "direct-mention";
  const nameDrop = directMention ? false : await nameDropFor(a, plan.partition).catch(() => false);
  const triggerFacts: IngestedChatMessage = { trust, refuted: teamsAuthorRefuted(auth), ...teamsAuthorFacts(auth, a.from.id) };
  await handleTeamsSingleWindowDispatch(
    {
      surfaceKey: plan.surfaceKey,
      containerKey: plan.partition.surfaceKey,
      channelId: a.teamsChannelId ?? teamsChannelGrainConversationId(a.conversation.id),
      ...(graphTeamId ? { teamId: graphTeamId } : {}),
      ...(!graphTeamId && a.teamId ? { teamAddressUnresolved: true } : {}),
      auth: stampNonMemberChatAuth(auth, [triggerFacts], {
        surfaceKey: plan.surfaceKey,
        ...teamsRoomGroupKey(auth),
      }),
      ingested: [triggerFacts],
      trigger: {
        id: a.id,
        authorId: a.from.id,
        authorName: a.from.name,
        sentAt: new Date().toISOString(),
        text: a.text || "(the message had no text)",
        trust,
      },
      ...(a.replyToId ? { threadRootId: teamsThreadRootActivityId(a) ?? a.replyToId } : {}),
      ...(replyChainRootId ? { replyChainRootId } : {}),
      engagementTier,
      ...(nameDrop ? { nameDrop: true } : {}),
      window: plan.window,
      cover: teamsCoverFacts(a, plan.partition, probeFor),
    },
    liveTeamsSupervisorDeps(plan, to),
  );
  await appendAudit({
    org: plan.partition.org,
    platform: "teams",
    workspace: plan.partition.workspace,
    surface: plan.surfaceKey,
    ...auditSurfaceModeFrom({ channel: { kind: "teams" }, session: { auth: { current: auth } } }),
    principalId: a.from.id,
    action: "teams.dispatched",
    detail: { addressing: plan.window.addressing ?? (nameDrop ? "name-drop" : "channel-watch"), conversationId: a.conversation.id },
  }).catch(() => undefined);
}

export async function liveTeamsDmDivert(
  a: TeamsMessageActivity,
  capturedAuth: OpenEverywhereTeamsAuth,
  partition: Partition,
  to: RouteHandlerArgs["to"],
  probeFor?: TeamsRosterProbeFor,
): Promise<void> {
  const auth = await teamsAuthWithUserType(capturedAuth, a, probeFor);
  const org = partition.org;
  const atIso = new Date().toISOString();
  const surfaceKey = partition.surfaceKey;
  const conversationId = a.conversation.id;

  const seat = await getOrCreateDmSeat(org, { surfaceKey }, atIso);

  const wakeCtx: BindableContext = {
    channel: { kind: "teams" },
    session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } },
  };
  const trust = resolveWakeTrustFromContext(wakeCtx, { id: a.from.id, isBot: false }, { principalFallback: true });
  const wakeId = mintWakeId();

  const origin: UnifiedWakeOrigin = { platform: "teams", serviceUrl: a.serviceUrl, conversationId };

  const rendered = renderWake(
    buildTeamsDmWake({
      conversationId,
      wakeId,
      ...(seat.freshGeneration && seat.tail.length > 0 ? { tail: seat.tail } : {}),
      trigger: {
        id: a.id || "unknown",
        author: a.from.name ?? a.from.id,
        authorId: a.from.id,
        sentAt: atIso,
        text: a.text || "(the message had no text)",
        trust,
      },
    }),
  );
  await divertToUnifiedWindow(to, {
    message: rendered.message,
    ...(rendered.context && rendered.context.length > 0 ? { context: rendered.context } : {}),
    token: seat.token,
    window: { wakeId, origin, addressing: "direct-mention", ...spreadVendorTs(receiptEventTime(Date.now())) } satisfies UnifiedWindowWake,
    surfaceKey,
    auth: stampNonMemberChatAuth(
      auth as unknown as { attributes?: Record<string, unknown> },
      [{ trust, refuted: teamsAuthorRefuted(auth), ...teamsAuthorFacts(auth, a.from.id) }],
      { dm: true },
    ),
  });
  await touchDmSeat(org, surfaceKey, atIso).catch(() => undefined);
  await recordWakeTail(org, dmWindowRegistryKey(surfaceKey), seat.token, {
    kind: "wake",
    at: atIso,
    from: "human",
    trust,
    ...tailAuthorGrain({ trust, refuted: teamsAuthorRefuted(auth), ...teamsAuthorFacts(auth, a.from.id) }),
    author: a.from.name ?? a.from.id,
    authorId: a.from.id,
    id: a.id || "unknown",
    platform: "teams",
    container: surfaceKey,
    text: a.text ?? "",
  });
  await appendAudit({
    org,
    platform: "teams",
    workspace: partition.workspace,
    surface: surfaceKey,
    ...auditSurfaceModeFrom({ channel: { kind: "teams" }, session: { auth: { current: auth } } }),
    principalId: a.from.id,
    action: "teams.dispatched",
    detail: { addressing: "direct-mention", dmWindow: true, conversationId },
  }).catch(() => undefined);
}

export function buildTeamsFrontHandler(innerHandler: RouteHandler, opts: TeamsFrontOptions = {}): RouteHandler {
  const verify = opts.verify ?? ((req: Request) => verifyTeamsRequest(req, {}));
  const dedupe = opts.dedupe ?? new EventDedupe();
  const fifo = opts.fifo ?? new ThreadFifo(recordTeamsWakeFailure);
  const now = opts.now ?? (() => Date.now());
  const markEventSeen = opts.markEventSeen ?? liveMarkEventSeen;
  const planFor = opts.planFor ?? liveTeamsFrontPlan;
  const dispatch = opts.dispatch ?? liveTeamsDispatch;
  const dmDivert = opts.dmDivert ?? liveTeamsDmDivert;
  const externalGate = opts.externalGate ?? liveTeamsExternalGate;
  const stopReaction = opts.stopReaction ?? ((rx: TeamsReactionActivity, attachSession: AttachSessionForCancel) => routeTeamsStopReaction(rx, { attachSession }));
  const engagementSeam = opts.engagementSeam ?? resolveTeamsEngagement;
  const markEngaged = opts.markEngaged ?? ((a: TeamsMessageActivity) => markTeamsEngaged(a));
  const roomStopped = opts.roomStopped ?? teamsRoomWatchStopped;
  const markRoomWatched = opts.markRoomWatched ?? markTeamsRoomWatched;
  const clearRoomStop = opts.clearRoomStop ?? clearTeamsRoomStop;
  const approvalInvoke = opts.approvalInvoke ?? ((invoke: TeamsApprovalInvoke, waitUntil: (p: Promise<unknown>) => void) => handleTeamsApprovalInvoke(invoke, { waitUntil }));
  const oeCommand = opts.oeCommand ?? ((a: TeamsMessageActivity, command: OeCommand, attachSession: AttachSessionForCancel | undefined) => liveTeamsOeCommand(a, command, attachSession));
  const channelIntro = opts.channelIntro ?? ((update: TeamsBotAddedUpdate) => liveTeamsChannelIntro(update));
  const firstContactIntro = opts.firstContactIntro ?? liveTeamsFirstContactIntro;

  return async (req: Request, args: RouteHandlerArgs): Promise<Response> => {
    let rawBody: string;
    try {
      rawBody = await verify(req);
    } catch {
      return new Response("unauthorized", { status: 401 });
    }
    const forward = (): Promise<Response> => {
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
      return innerHandler(forwarded, args);
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return forward();
    }
    if (!isTeamsChannelActivity(parsed)) {
      tlog(`refused a non-Teams activity (channelId ${describeChannelId(parsed)})`);
      return NOT_TEAMS();
    }
    const reaction = parseTeamsReaction(parsed);
    if (reaction) {
      args.waitUntil(
        stopReaction(reaction, args.attachSession).then(
          (o) => tlog(`reaction in ${reaction.conversationId ?? "?"}: ${o.stopped ? o.outcome : o.reason}`),
          (err) => tlog(`stop leg failed: ${String(err)}`),
        ),
      );
      return OK();
    }

    const feedbackClick = parseTeamsFeedbackInvoke(parsed);
    if (feedbackClick) {
      args.waitUntil(
        routeTeamsFeedbackInvoke(feedbackClick).then(
          (recorded) => tlog(`thumbs ${feedbackClick.rating} in ${feedbackClick.conversationId}: ${recorded ? "recorded" : "not recorded"}`),
          (err) => tlog(`thumbs leg failed: ${String(err)}`),
        ),
      );
      return new Response("{}", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    const activity = parseTeamsActivity(parsed);

    const tap = parseTeamsApprovalInvoke(activity);
    if (tap) {
      const body = await approvalInvoke(tap, (p) => args.waitUntil(p));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    if (activity?.type === "conversationUpdate") {
      const added = parseTeamsBotAdded(activity);
      if (added) {
        args.waitUntil(
          channelIntro(added).then(
            (o) => tlog(`bot added to ${added.conversationId}: intro ${o.posted ? "posted" : `not posted (${o.reason})`}`),
            (err) => tlog(`intro leg failed: ${String(err)}`),
          ),
        );
      }
      return forward();
    }

    if (!activity || activity.type !== "message") {
      return forward();
    }

    const machineAuthored = teamsMachineAuthored(activity);

    if (!machineAuthored && (await externalGate(activity))) return OK();

    if (!machineAuthored) {
      args.waitUntil(
        recordTeamsConversationReference({
          scope: activity.scope,
          tenantId: activity.tenantId ?? activity.conversation.tenantId,
          conversationId: activity.conversation.id,
          serviceUrl: activity.serviceUrl,
          userId: activity.from.id,
          teamId: activity.teamId,
        }),
      );
    }

    const command = machineAuthored ? null : parseTeamsOeCommand(activity.text, activity.isBotMentioned === true || activity.scope === "personal");
    if (command) {
      const commandKey = `teams-oe:${activity.conversation.id}:${activity.id}`;
      if (dedupe.seen(commandKey, now())) return OK();
      dedupe.mark(commandKey, now());
      if (!(await markEventSeen(deploymentOrg(), commandKey, new Date(now()).toISOString()))) return OK();
      tlog(`activity ${activity.id} in ${activity.conversation.id}: "${oeSlash()}" ${command.kind} — answered with no model turn`);
      args.waitUntil(oeCommand(activity, command, args.attachSession).catch((err) => tlog(`"${oeSlash()}" command failed: ${String(err)}`)));
      return OK();
    }

    if (!machineAuthored && activity.scope === "channel" && activity.isBotMentioned === true) {
      args.waitUntil(
        firstContactIntro(activity).then(
          (o) => (o.posted ? tlog(`first contact in ${activity.conversation.id}: intro posted`) : undefined),
          (err) => tlog(`first-contact intro failed: ${String(err)}`),
        ),
      );
    }

    const seam: TeamsEngagementVerdict | null = machineAuthored ? null : await engagementSeam(activity, machineAuthored);
    if (seam?.kind === "engage") {
      const engageKey = `teams-engage:${activity.conversation.id}:${activity.id}`;
      if (!dedupe.seen(engageKey, now())) {
        dedupe.mark(engageKey, now());
        if (await markEventSeen(seam.org, engageKey, new Date(now()).toISOString())) await markEngaged(activity);
      }
    }
    if (seam?.kind === "hold" && seam.stopped) {
      if (isTeamsInputResponseActivity(activity)) {
        tlog(`activity ${activity.id} in ${activity.conversation.id}: stood down, but this is an answer to a parked question — forwarded`);
        return forward();
      }
      tlog(`activity ${activity.id} in ${activity.conversation.id}: stood down here — suppressed on BOTH legs until an @mention`);
      return OK();
    }

    if (activity.scope === "personal" || activity.scope === "groupChat") {
      if (machineAuthored) return OK();
      if (seam?.kind === "hold") {
        if (isTeamsInputResponseActivity(activity)) {
          tlog(`activity ${activity.id} in ${activity.conversation.id}: group chat not engaged, but this is an answer to a parked question — forwarded`);
          return forward();
        }
        tlog(`activity ${activity.id} in ${activity.conversation.id}: group chat not engaged — ${seam.reason}`);
        return OK();
      }
      const dmKey = `teams:${activity.conversation.id}:${activity.id}`;
      if (dedupe.seen(dmKey, now())) return OK();
      dedupe.mark(dmKey, now());
      let dm: { auth: OpenEverywhereTeamsAuth; partition: Partition } | null;
      try {
        const auth = authForActivity(activity);
        const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
        dm = { auth, partition };
      } catch {
        dm = null;
      }
      if (!dm) return forward();
      const { auth: dmAuth, partition: dmPartition } = dm;
      if (!(await markEventSeen(dmPartition.org, dmKey, new Date(now()).toISOString()))) return OK();
      tlog(`activity ${activity.id} on ${dmPartition.surfaceKey}: DM — diverting to its own first-class DM window`);
      args.waitUntil(fifo.enqueue(dmPartition.surfaceKey, () => dmDivert(activity, dmAuth, dmPartition, args.to)));
      return OK();
    }

    const plan = planFor(activity);
    if (!plan) return forward();

    if (machineAuthored) {
      tlog(`activity ${activity.id} on ${plan.surfaceKey}: bot/self-authored — dropped (single-window surface, relay is Phase 2)`);
      return OK();
    }

    const addressedHere = plan.window.addressing === "direct-mention";
    if (addressedHere) {
      await clearRoomStop(plan.partition, new Date(now()).toISOString(), activity.id).catch(() => undefined);
    } else if (await roomStopped(plan.partition)) {
      if (isTeamsInputResponseActivity(activity)) {
        tlog(`activity ${activity.id} on ${plan.surfaceKey}: room stood down, but this is an answer to a parked question — forwarded`);
        return forward();
      }
      tlog(`activity ${activity.id} on ${plan.surfaceKey}: this room was stood down — ambient wake suppressed until an @mention`);
      return OK();
    }

    const key = `teams:${activity.conversation.id}:${activity.id}`;
    if (dedupe.seen(key, now())) return OK();
    dedupe.mark(key, now());
    if (!(await markEventSeen(plan.partition.org, key, new Date(now()).toISOString()))) return OK();

    tlog(
      `activity ${activity.id} on ${plan.surfaceKey}: single-window — diverting to the unified supervisor ` +
        `(${plan.window.addressing === "direct-mention" ? "addressed @mention; native forward suppressed" : "ambient channel-watch"})`,
    );
    if (!addressedHere) args.waitUntil(markRoomWatched(plan.partition, new Date(now()).toISOString()).catch(() => undefined));
    args.waitUntil(fifo.enqueue(plan.surfaceKey, () => dispatch(activity, plan, args.to)));
    return OK();
  };
}

export function frontTeamsChannel<C extends Channel<any, any, any>>(inner: C, opts: TeamsFrontOptions = {}): C {
  const innerPost = inner.routes.find(
    (r): r is HttpRouteDefinition<any> => r.method === "POST" && r.path === INTERNAL_TEAMS_ROUTE,
  );
  if (!innerPost) {
    throw new Error(
      `frontTeamsChannel: wrapped teamsChannel must be built with route: "${INTERNAL_TEAMS_ROUTE}" ` +
        `(found paths: ${inner.routes.map((r) => r.path).join(", ")})`,
    );
  }
  const front = buildTeamsFrontHandler(innerPost.handler, opts);
  const guardedInner = inner.routes.map((r) => (r === innerPost ? { ...innerPost, handler: guardTeamsChannelOnly(innerPost.handler) } : r));
  return { ...inner, routes: [POST(PUBLIC_TEAMS_ROUTE, front), ...guardedInner] };
}
