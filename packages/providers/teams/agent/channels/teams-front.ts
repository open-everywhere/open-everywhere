import { POST, type Channel, type HttpRouteDefinition, type RouteHandlerArgs } from "eve/channels";
import {
  verifyTeamsRequest,
  parseTeamsActivity,
  teamsThreadRootActivityId,
  sendTeamsActivity,
  type TeamsMessageActivity,
} from "eve/channels/teams";
import {
  buildTeamsAuth,
  teamsMembershipType,
  teamsTrustGroup,
  teamsUserTypeFromMember,
  withTeamsUserType,
  type OpenEverywhereTeamsAuth,
} from "./teams-identity.js";
import { resolveTeamsUserType, teamsServiceUrlRosterProbe, type TeamsRosterProbe } from "./teams-roster.js";
import {
  planTeamsSingleWindow,
  handleTeamsSingleWindowDispatch,
  teamsSupervisorToken,
  buildTeamsDmWake,
  distillTeamsRotationHandoff,
  type TeamsSupervisorDeps,
  type TeamsSingleWindowFacts,
} from "./teams-supervisor.js";
import {
  shouldRotate,
  EventDedupe,
  ThreadFifo,
  divertToUnifiedWindow,
  supervisorGrainFor,
  mintRotationToken,
  grainUsesUnifiedWindow,
  resolvePartition,
  domainKeyOf,
  engagementTierFor,
  getConfig,
  getOperationalStore,
  isVouchedSurface,
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
  type ExternalPolicy,
  type IngestedChatMessage,
  type AuthorTrustQuery,
  type SupervisorGrain,
  type UnifiedWindowWake,
  type UnifiedWakeOrigin,
  type Partition,
  type BindableContext,
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

export async function teamsAuthWithUserType<A extends OpenEverywhereTeamsAuth>(
  auth: A,
  a: TeamsMessageActivity,
  probeFor?: TeamsRosterProbeFor,
): Promise<A> {
  const factory: TeamsRosterProbeFor = probeFor ?? ((activity) => teamsServiceUrlRosterProbe(activity.serviceUrl));
  try {
    return withTeamsUserType(auth, await resolveTeamsUserType(factory(a), a.conversation.id, a.from.id));
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

async function postTeamsNotice(a: TeamsMessageActivity, text: string): Promise<void> {
  try {
    await sendTeamsActivity({ serviceUrl: a.serviceUrl, conversationId: a.conversation.id, body: { type: "message", text } });
  } catch {
  }
}

async function postTeamsExternalSenderNotice(a: TeamsMessageActivity): Promise<void> {
  if (a.scope !== "personal") return;
  await postTeamsNotice(a, EXTERNAL_SENDER_NOTICE);
}

async function announceTeamsSilentRoom(a: TeamsMessageActivity, org: string, surfaceKey: string): Promise<void> {
  if (!org) return;
  try {
    const won = await getOperationalStore().claimNotice(org, silentNoticeKey(surfaceKey, "suppressed-wake"), new Date().toISOString());
    if (!won) return;
  } catch {
    return;
  }
  await postTeamsNotice(a, silentRoomNotice("suppressed-wake"));
}

export async function liveTeamsExternalGate(a: TeamsMessageActivity, probeFor?: TeamsRosterProbeFor): Promise<boolean> {
  const isDm = a.scope === "personal" || a.scope === "groupChat";
  let auth: OpenEverywhereTeamsAuth;
  let partition: Partition;
  let roomKey: string;
  try {
    auth = authForActivity(a);
    partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
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
  const verdict = teamsExternalVerdict({
    policy,
    author: { trust, refuted: teamsAuthorRefuted(auth), ...teamsAuthorFacts(auth, a.from.id) },
    addressed: a.isBotMentioned === true || a.scope === "personal",
    isDm,
    vendorExternal: teamsVendorExternal(a),
    roomKey,
    ...teamsRoomGroupKey(auth),
  });
  if (verdict === "proceed") return false;
  if (verdict === "withheld-addressed") await postTeamsExternalSenderNotice(a).catch(() => undefined);
  if (verdict === "silent-room") await announceTeamsSilentRoom(a, partition.org, roomKey).catch(() => undefined);
  await appendAudit({
    org: partition.org || deploymentOrg(),
    platform: "teams",
    workspace: partition.workspace,
    surface: roomKey,
    principalId: a.from.id,
    action: "teams.external_policy_suppressed",
    detail: { verdict, conversationId: a.conversation.id },
  }).catch(() => undefined);
  tlog(`suppressed ${roomKey}: externalPolicy verdict "${verdict}"`);
  return true;
}

export function liveTeamsFrontPlan(a: TeamsMessageActivity): TeamsFrontPlan | null {
  try {
    const auth = authForActivity(a);
    const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
    const surfaceKey = domainKeyOf(partition);
    const grain = supervisorGrainFor(surfaceKey, getConfig().loadDomains());
    if (!grainUsesUnifiedWindow(grain)) return null;
    const tenantId = a.tenantId ?? a.conversation.tenantId;
    const facts: TeamsSingleWindowFacts = {
      scope: a.scope,
      membershipType: teamsMembershipType(a.channelData),
      tenantId,
      vouched: isVouchedSurface(surfaceKey) || process.env.OE_TRUST === "internal",
    };
    const window = planTeamsSingleWindow(true, a.isBotMentioned, facts, {
      serviceUrl: a.serviceUrl,
      conversationId: a.conversation.id,
      replyToActivityId: teamsThreadRootActivityId(a) ?? undefined,
      tenantId,
    });
    if (!window) return null;
    return { window, surfaceKey, partition, grain, auth };
  } catch {
    return null;
  }
}

function liveTeamsSupervisorDeps(plan: TeamsFrontPlan, to: RouteHandlerArgs["to"]): TeamsSupervisorDeps {
  const org = plan.partition.org;
  const store = getOperationalStore();
  const grain = plan.grain;
  return {
    async getOrCreateSession(_surfaceKey, channelId, atIso) {
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, 1, () => teamsSupervisorToken(channelId, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      if (shouldRotate(existing, atIso)) {
        const gen = existing.generation + 1;
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => teamsSupervisorToken(channelId, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      return { token: existing.token, generation: existing.generation, freshGeneration: existing.firstWakeAt == null, handoffNote: existing.handoffNote };
    },
    touchSession: (_surfaceKey, atIso) => store.touchChannelSession(org, grain.registryKey, atIso),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, window }) {
      await divertToUnifiedWindow(to, {
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
}

const OK = () => new Response("ok");

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

export async function liveTeamsDispatch(
  a: TeamsMessageActivity,
  plan: TeamsFrontPlan,
  to: RouteHandlerArgs["to"],
  probeFor?: TeamsRosterProbeFor,
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
  await handleTeamsSingleWindowDispatch(
    {
      surfaceKey: plan.surfaceKey,
      channelId: a.teamsChannelId ?? a.conversation.id,
      auth: stampNonMemberChatAuth(auth, [{ trust, refuted: teamsAuthorRefuted(auth), ...teamsAuthorFacts(auth, a.from.id) }], {
        surfaceKey: plan.surfaceKey,
        ...teamsRoomGroupKey(auth),
      }),
      trigger: {
        id: a.id,
        authorId: a.from.id,
        authorName: a.from.name,
        sentAt: new Date().toISOString(),
        text: a.text || "(the message had no text)",
        trust,
      },
      ...(a.replyToId ? { threadRootId: teamsThreadRootActivityId(a) ?? a.replyToId } : {}),
      engagementTier,
      window: plan.window,
    },
    liveTeamsSupervisorDeps(plan, to),
  );
  await appendAudit({
    org: plan.partition.org,
    platform: "teams",
    workspace: plan.partition.workspace,
    surface: plan.surfaceKey,
    principalId: a.from.id,
    action: "teams.dispatched",
    detail: { addressing: plan.window.addressing ?? "channel-watch", conversationId: a.conversation.id },
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

  const seat = await getOrCreateDmSeat(org, { surfaceKey }, atIso, {
    distillHandoff: (scope, outgoing) => distillTeamsRotationHandoff(scope, outgoing, org),
  });

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
      ...(seat.freshGeneration && seat.handoffNote ? { handoffNote: seat.handoffNote, handoffFromGeneration: Math.max(seat.generation - 1, 0) } : {}),
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
    window: { wakeId, origin, addressing: "direct-mention" } satisfies UnifiedWindowWake,
    surfaceKey,
    auth: stampNonMemberChatAuth(
      auth as unknown as { attributes?: Record<string, unknown> },
      [{ trust, refuted: teamsAuthorRefuted(auth), ...teamsAuthorFacts(auth, a.from.id) }],
      { dm: true },
    ),
  });
  await touchDmSeat(org, surfaceKey, atIso).catch(() => undefined);
  await appendAudit({
    org,
    platform: "teams",
    workspace: partition.workspace,
    surface: surfaceKey,
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
    const activity = parseTeamsActivity(parsed);
    if (!activity || activity.type !== "message") {
      return forward();
    }

    const machineAuthored = activity.from.id === activity.recipient.id || activity.from.role === "bot" || activity.from.id.startsWith("28:");

    if (!machineAuthored && (await externalGate(activity))) return OK();

    if (activity.scope === "personal" || activity.scope === "groupChat") {
      if (machineAuthored) return OK();
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

    const key = `teams:${activity.conversation.id}:${activity.id}`;
    if (dedupe.seen(key, now())) return OK();
    dedupe.mark(key, now());
    if (!(await markEventSeen(plan.partition.org, key, new Date(now()).toISOString()))) return OK();

    tlog(
      `activity ${activity.id} on ${plan.surfaceKey}: single-window — diverting to the unified supervisor ` +
        `(${plan.window.addressing === "direct-mention" ? "addressed @mention; native forward suppressed" : "ambient channel-watch"})`,
    );
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
  return { ...inner, routes: [POST(PUBLIC_TEAMS_ROUTE, front), ...inner.routes] };
}
