import { POST, type Channel, type HttpRouteDefinition, type RouteHandlerArgs } from "eve/channels";
import { verifyTeamsRequest, parseTeamsActivity, teamsThreadRootActivityId, type TeamsMessageActivity } from "eve/channels/teams";
import { buildTeamsAuth, teamsMembershipType, type OpenEverywhereTeamsAuth } from "./teams-identity.js";
import {
  planTeamsSingleWindow,
  handleTeamsSingleWindowDispatch,
  teamsSupervisorToken,
  type TeamsSupervisorDeps,
  type TeamsSingleWindowFacts,
} from "./teams-supervisor.js";
import { shouldRotate } from "./slack-events.js";
import { EventDedupe, ThreadFifo } from "./slack-front.js";
import { divertToUnifiedWindow } from "./unified.js";
import { supervisorGrainFor, supervisorTokenForGrain, type SupervisorGrain } from "./unified-supervisor.js";
import type { UnifiedWindowWake } from "./unified-window.js";
import { resolvePartition, domainKeyOf, type Partition } from "../memory/partition.js";
import { engagementTierFor } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { getOperationalStore } from "../operational/provider.js";
import { isVouchedSurface } from "../identity/trust.js";
import { resolveWakeTrustFromContext } from "../identity/wake-trust.js";
import { deploymentOrg, type BindableContext } from "../identity/binding.js";
import { appendAudit } from "../audit/audit.js";

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

export function liveTeamsFrontPlan(a: TeamsMessageActivity): TeamsFrontPlan | null {
  try {
    const auth = authForActivity(a);
    const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
    const surfaceKey = domainKeyOf(partition);
    const grain = supervisorGrainFor(surfaceKey, getConfig().loadDomains());
    if (grain.singleWindow !== true) return null;
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

function liveTeamsSupervisorDeps(plan: TeamsFrontPlan, receive: RouteHandlerArgs["receive"]): TeamsSupervisorDeps {
  const org = plan.partition.org;
  const store = getOperationalStore();
  const grain = plan.grain;
  return {
    async getOrCreateSession(_surfaceKey, channelId, atIso) {
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, 1, () => teamsSupervisorToken(channelId, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      if (shouldRotate(existing, atIso)) {
        const gen = existing.generation + 1;
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => teamsSupervisorToken(channelId, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      return { token: existing.token, generation: existing.generation, freshGeneration: existing.firstWakeAt == null, handoffNote: existing.handoffNote };
    },
    touchSession: (_surfaceKey, atIso) => store.touchChannelSession(org, grain.registryKey, atIso),
    async forceRotate(_surfaceKey, channelId, atIso) {
      const existing = await store.getChannelSession(org, grain.registryKey);
      const gen = (existing?.generation ?? 0) + 1;
      const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => teamsSupervisorToken(channelId, gen)), atIso);
      return { token: row.token, generation: row.generation, handoffNote: row.handoffNote };
    },
    audit: (action, detail) =>
      appendAudit({ org, platform: "teams", workspace: plan.partition.workspace, surface: plan.surfaceKey, action, detail }),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, window }) {
      await divertToUnifiedWindow(receive, {
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
  readonly dispatch?: (a: TeamsMessageActivity, plan: TeamsFrontPlan, receive: RouteHandlerArgs["receive"]) => Promise<void>;
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

async function liveTeamsDispatch(a: TeamsMessageActivity, plan: TeamsFrontPlan, receive: RouteHandlerArgs["receive"]): Promise<void> {
  const wakeCtx: BindableContext = { channel: { kind: "teams" }, session: { auth: { current: plan.auth as unknown as { attributes?: Readonly<Record<string, string>> } } } };
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
      auth: plan.auth,
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
    liveTeamsSupervisorDeps(plan, receive),
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

export function buildTeamsFrontHandler(innerHandler: RouteHandler, opts: TeamsFrontOptions = {}): RouteHandler {
  const verify = opts.verify ?? ((req: Request) => verifyTeamsRequest(req, {}));
  const dedupe = opts.dedupe ?? new EventDedupe();
  const fifo = opts.fifo ?? new ThreadFifo(recordTeamsWakeFailure);
  const now = opts.now ?? (() => Date.now());
  const markEventSeen = opts.markEventSeen ?? liveMarkEventSeen;
  const planFor = opts.planFor ?? liveTeamsFrontPlan;
  const dispatch = opts.dispatch ?? liveTeamsDispatch;

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

    const plan = planFor(activity);
    if (!plan) return forward();

    if (activity.from.id === activity.recipient.id || activity.from.role === "bot" || activity.from.id.startsWith("28:")) {
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
    args.waitUntil(fifo.enqueue(plan.surfaceKey, () => dispatch(activity, plan, args.receive)));
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
