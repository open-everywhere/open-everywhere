import {
  linearChannel,
  callLinearGraphQL,
  parseLinearWebhookEvent,
  type LinearApiOptions,
  type LinearChannelCredentials,
  type LinearChannel,
  type LinearChannelState,
} from "eve/channels/linear";
import type { HttpRouteDefinition, RouteHandlerArgs, SendFn } from "eve/channels";
import { buildLinearAuth, teamFactsFromTeam } from "./linear-identity.js";
import {
  classifyLinearAmbientComment,
  extractLinearCommentSignal,
  linearSupervisorToken,
  handleLinearSupervisorDispatch,
  shouldRotate,
  type LinearSupervisorDeps,
} from "./linear-supervisor.js";
import { supervisorGrainFor, supervisorTokenForGrain, type SupervisorGrain } from "./unified-supervisor.js";
import { mintWakeId, type UnifiedWindowWake } from "./unified-window.js";
import { divertToUnifiedWindow } from "./unified.js";
import { finalMessageActionForTurn, supervisorTextDelivery } from "./slack-events.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { resolveWakeTrustFromContext } from "../identity/wake-trust.js";
import { getConfig } from "../access/config.js";
import { ambientSupervisorEnabled, engagementTierFor, type EngagementTier } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { postOnce, outboundKey } from "../operational/post-once.js";

const ROUTE = "/eve/v1/linear";

function slog(msg: string): void {
  console.log(`[open-everywhere:linear-supervisor] ${msg}`);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}
function teamIdFromRaw(raw: unknown): string | undefined {
  for (const base of [pick(raw, "agentSession"), pick(raw, "data"), raw]) {
    const id = str(pick(pick(pick(base, "issue"), "team"), "id"));
    if (id) return id;
  }
  return undefined;
}

export async function enrichTeamPrivacy(
  teamId: string | undefined,
  opts?: { readonly api?: LinearApiOptions; readonly credentials?: LinearChannelCredentials },
): Promise<boolean | undefined> {
  if (!teamId) return undefined;
  try {
    const data = await callLinearGraphQL<{ team?: { private?: boolean } }>({
      api: opts?.api,
      credentials: opts?.credentials,
      query: "query TeamPrivacy($id: String!) { team(id: $id) { private } }",
      queryName: "TeamPrivacy",
      variables: { id: teamId },
    });
    return teamFactsFromTeam(data).isPrivate;
  } catch {
    return undefined;
  }
}

let viewerCache: Promise<{ id?: string; name?: string }> | undefined;
function resolveViewer(): Promise<{ id?: string; name?: string }> {
  if (!viewerCache) {
    const overrideId = process.env.LINEAR_APP_USER_ID;
    const overrideName = process.env.LINEAR_APP_NAME;
    viewerCache =
      overrideId && overrideName
        ? Promise.resolve({ id: overrideId, name: overrideName })
        : callLinearGraphQL<{ viewer?: { id?: string; name?: string; displayName?: string } }>({
            query: "query OeViewer { viewer { id name displayName } }",
            queryName: "OeViewer",
          })
            .then((d) => ({ id: str(d.viewer?.id), name: str(d.viewer?.displayName) ?? str(d.viewer?.name) }))
            .catch((err) => {
              slog(`could not resolve app viewer (query OeViewer failed): ${String(err)}`);
              return {};
            });
  }
  return viewerCache;
}

export function _resetLinearViewerCache(): void {
  viewerCache = undefined;
}

interface EnrichedLinearComment {
  readonly id: string;
  readonly body?: string;
  readonly createdAt?: string;
  readonly authorId?: string;
  readonly authorName?: string;
  readonly parentId?: string;
  readonly parentAuthorId?: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
  readonly issueTitle?: string;
  readonly teamId?: string;
  readonly teamPrivate?: boolean;
}

async function enrichComment(commentId: string): Promise<EnrichedLinearComment | undefined> {
  try {
    const d = await callLinearGraphQL<{
      comment?: {
        id?: string;
        body?: string;
        createdAt?: string;
        user?: { id?: string; name?: string; displayName?: string };
        parent?: { id?: string; user?: { id?: string } };
        issue?: { id?: string; identifier?: string; title?: string; team?: { id?: string; private?: boolean } };
      };
    }>({
      query:
        "query OeAmbientComment($id: String!) { comment(id: $id) { id body createdAt " +
        "user { id name displayName } parent { id user { id } } " +
        "issue { id identifier title team { id private } } } }",
      queryName: "OeAmbientComment",
      variables: { id: commentId },
    });
    const c = d.comment;
    if (!c?.id) return undefined;
    return {
      id: c.id,
      body: str(c.body),
      createdAt: str(c.createdAt),
      authorId: str(c.user?.id),
      authorName: str(c.user?.displayName) ?? str(c.user?.name),
      parentId: str(c.parent?.id),
      parentAuthorId: str(c.parent?.user?.id),
      issueId: str(c.issue?.id),
      issueIdentifier: str(c.issue?.identifier),
      issueTitle: str(c.issue?.title),
      teamId: str(c.issue?.team?.id),
      teamPrivate: typeof c.issue?.team?.private === "boolean" ? c.issue.team.private : undefined,
    };
  } catch {
    return undefined;
  }
}

type LinearSupervisorSessionState = LinearChannelState & {
  oeSupervisor?: boolean;
  oeUnified?: boolean;
  oeTeamId?: string;
  oeReplyTarget?: { issueId: string; parentId?: string; teamId?: string; organizationId?: string };
};

function isSupervisorLinearState(state: unknown): state is LinearSupervisorSessionState {
  return (state as Record<string, unknown> | undefined)?.["oeSupervisor"] === true;
}

function supervisorSeedState(teamId: string, organizationId: string, unified: boolean): LinearSupervisorSessionState {
  return { agentSessionId: null, organizationId, oeSupervisor: true, oeTeamId: teamId, ...(unified ? { oeUnified: true } : {}) };
}

function linearAmbientEnabled(surfaceKey: string): boolean {
  try {
    return ambientSupervisorEnabled(surfaceKey, getConfig().loadDomains());
  } catch {
    return false;
  }
}
function linearEngagementTier(surfaceKey: string): EngagementTier | undefined {
  try {
    return engagementTierFor(surfaceKey, getConfig().loadDomains());
  } catch {
    return undefined;
  }
}

function linearGrainFor(surfaceKey: string): SupervisorGrain {
  try {
    return supervisorGrainFor(surfaceKey, getConfig().loadDomains());
  } catch {
    return { unified: false, registryKey: surfaceKey };
  }
}

function liveLinearSupervisorDeps(
  send: SendFn<LinearChannelState>,
  teamId: string,
  organizationId: string,
  receive?: RouteHandlerArgs["receive"],
): LinearSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, team, atIso) {
      const grain = linearGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, 1, () => linearSupervisorToken(team, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      if (shouldRotate(existing, atIso)) {
        const gen = existing.generation + 1;
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => linearSupervisorToken(team, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      return { token: existing.token, generation: existing.generation, freshGeneration: existing.firstWakeAt == null, handoffNote: existing.handoffNote };
    },
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, linearGrainFor(surfaceKey).registryKey, atIso),
    async forceRotate(surfaceKey, team, atIso) {
      const grain = linearGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      const gen = (existing?.generation ?? 0) + 1;
      const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => linearSupervisorToken(team, gen)), atIso);
      return { token: row.token, generation: row.generation, handoffNote: row.handoffNote };
    },
    audit: (action, detail) =>
      appendAudit({ org, platform: "linear", workspace: organizationId, surface: typeof detail.surfaceKey === "string" ? detail.surfaceKey : undefined, action, detail }),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, window }) {
      if (window && receive) {
        await divertToUnifiedWindow(receive, {
          message,
          context: [...context],
          token,
          window,
          surfaceKey: `linear/${organizationId}/${teamId}`,
          auth: auth as unknown as { attributes?: Record<string, unknown> },
        });
        return;
      }
      const unified = linearGrainFor(`linear/${organizationId}/${teamId}`).unified;
      await send(
        { message, context: [...context] },
        { auth: auth as unknown as Parameters<SendFn<LinearChannelState>>[1]["auth"], continuationToken: token, state: supervisorSeedState(teamId, organizationId, unified) },
      );
    },
  };
}

async function ambientDelivery(body: string, headers: Headers, send: SendFn<LinearChannelState>, receive?: RouteHandlerArgs["receive"]): Promise<void> {
  let event: ReturnType<typeof parseLinearWebhookEvent>;
  try {
    event = parseLinearWebhookEvent({ body, headers });
  } catch {
    return;
  }
  if (!event) return;
  const signal = extractLinearCommentSignal(event);
  if (!signal) return;
  if (!signal.organizationId) return;
  const c = await enrichComment(signal.commentId);
  if (!c || !c.teamId || !c.issueId) return;
  const surfaceKey = `linear/${signal.organizationId}/${c.teamId}`;
  if (!linearAmbientEnabled(surfaceKey)) return;
  const viewer = await resolveViewer();
  const cls = classifyLinearAmbientComment(
    { body: c.body, authorId: c.authorId, parentAuthorId: c.parentAuthorId },
    viewer,
  );
  if (cls.addressing === "drop") {
    slog(`comment on ${surfaceKey} (${c.issueIdentifier ?? c.issueId}) dropped: ${cls.reason}`);
    return;
  }
  const auth = buildLinearAuth({
    organizationId: signal.organizationId,
    teamId: c.teamId,
    issueId: c.issueId,
    issueIdentifier: c.issueIdentifier,
    principalId: c.authorId,
    isPrivate: c.teamPrivate,
    commentId: c.id,
    parentCommentId: c.parentId,
  });
  const wakeTrust = resolveWakeTrustFromContext(
    { channel: { kind: "linear" }, session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } } },
    { id: c.authorId, isBot: false },
    { principalFallback: true },
  );
  await handleLinearSupervisorDispatch(
    {
      surfaceKey,
      teamId: c.teamId,
      issueId: c.issueId,
      issueIdentifier: c.issueIdentifier,
      issueTitle: c.issueTitle,
      auth,
      trigger: {
        id: c.id,
        authorId: c.authorId,
        authorName: c.authorName,
        sentAt: c.createdAt ?? new Date().toISOString(),
        text: c.body ?? "(the comment had no text)",
        trust: wakeTrust,
      },
      engagementTier: linearEngagementTier(surfaceKey),
      unified: linearGrainFor(surfaceKey).unified,
      window:
        linearGrainFor(surfaceKey).singleWindow === true
          ? ({
              wakeId: mintWakeId(),
              origin: {
                platform: "linear",
                issueId: c.issueId,
                parentId: c.parentId ?? c.id,
              },
            } satisfies UnifiedWindowWake)
          : undefined,
    },
    liveLinearSupervisorDeps(send, c.teamId, signal.organizationId, receive),
  );
  await appendAudit({
    org: deploymentOrg(),
    platform: "linear",
    workspace: signal.organizationId,
    surface: surfaceKey,
    principalId: c.authorId,
    action: "linear.dispatched",
    detail: { addressing: cls.addressing, issueId: c.issueId },
  });
  slog(`comment on ${surfaceKey} (${c.issueIdentifier ?? c.issueId}) → judged wake dispatched`);
}

const pristine = linearChannel({});
type AdapterEventFn = (data: unknown, adapterCtx: unknown) => unknown;
const defaultEvent = (name: string): AdapterEventFn | undefined =>
  (pristine as unknown as { adapter?: Record<string, AdapterEventFn> }).adapter?.[name];

const native: LinearChannel = linearChannel({
  onAgentSession: async (_ctx, event) => {
    const s = event.agentSession;
    const agentSessionId = s.id;
    if (!agentSessionId) return null;

    const teamId = teamIdFromRaw(event.raw);
    const isPrivate = await enrichTeamPrivacy(teamId);

    const auth = buildLinearAuth({
      agentSessionId,
      organizationId: event.organizationId ?? s.organizationId ?? undefined,
      teamId,
      issueId: s.issueId ?? s.issue?.id ?? undefined,
      issueIdentifier: s.issue?.identifier ?? undefined,
      principalId: s.creator?.id ?? s.creatorId ?? event.appUserId ?? undefined,
      isPrivate,
    });
    return { auth };
  },
  events: {
    async "turn.started"(data, channel, ctx) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("turn.started")?.(data, channel);
        return;
      }
      const st = channel.state as LinearSupervisorSessionState;
      const attrs = ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined;
      const issueId = str(attrs?.issue_id);
      const commentId = str(attrs?.comment_id);
      const parentId = str(attrs?.parent_comment_id);
      st.oeReplyTarget =
        issueId && (parentId ?? commentId)
          ? {
              issueId,
              parentId: parentId ?? commentId,
              ...(st.oeUnified === true ? { teamId: str(attrs?.team_id), organizationId: str(attrs?.organization_id) } : {}),
            }
          : undefined;
    },
    async "actions.requested"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) await defaultEvent("actions.requested")?.(data, channel);
    },
    async "input.requested"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("input.requested")?.(data, channel);
        return;
      }
      slog("supervisor turn requested input — unsupported on a judged ambient turn; ignored");
    },
    async "message.completed"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("message.completed")?.(data, channel);
        return;
      }
      const st = channel.state as LinearSupervisorSessionState;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const target = st.oeReplyTarget;
      const org = deploymentOrg();
      const auditTeamId = (st.oeUnified === true ? target?.teamId : undefined) ?? st.oeTeamId;
      const auditOrgId = (st.oeUnified === true ? target?.organizationId : undefined) ?? st.organizationId;
      const surface = auditTeamId ? `linear/${auditOrgId ?? "unknown"}/${auditTeamId}` : undefined;
      if (action.kind === "silent") {
        await appendAudit({
          org,
          platform: "linear",
          workspace: auditOrgId ?? "unknown",
          surface,
          action: "linear.no_reply",
          detail: { issueId: target?.issueId ?? null, reason: action.reason },
        });
        return;
      }
      if (!target) {
        slog("reply not posted — no per-turn thread target (turn.started snapshot empty); FAIL SAFE");
        return;
      }
      const delivery = supervisorTextDelivery(true, false);
      if (!delivery.postText) {
        slog(`supervisor message-tool-only: DROPPED terminal prose — nothing posted (issue ${target.issueId})`);
        await appendAudit({
          org,
          platform: "linear",
          workspace: auditOrgId ?? "unknown",
          surface,
          action: "turn.supervisor_prose_dropped",
          detail: { issueId: target.issueId, chars: action.text.length },
        }).catch(() => undefined);
        return;
      }
      try {
        await postOnce({
          org,
          key: outboundKey({
            surface: "linear",
            channel: auditTeamId ?? "",
            threadTs: target.parentId ?? target.issueId,
            action: "linear.supervisor-reply",
            payload: action.text,
          }),
          run: () =>
            callLinearGraphQL<{ commentCreate?: { success?: boolean } }>({
              query: "mutation OeAmbientReply($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
              queryName: "OeAmbientReply",
              variables: { input: { issueId: target.issueId, ...(target.parentId ? { parentId: target.parentId } : {}), body: action.text } },
            }),
        });
        await appendAudit({
          org,
          platform: "linear",
          workspace: auditOrgId ?? "unknown",
          surface,
          action: "linear.replied",
          detail: { issueId: target.issueId, parentId: target.parentId ?? null, chars: action.text.length },
        });
      } catch (err) {
        slog(`reply delivery failed: ${String(err)}`);
      }
    },
    async "turn.failed"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("turn.failed")?.(data, channel);
        return;
      }
      const st = channel.state as LinearSupervisorSessionState;
      slog(`supervisor turn failed on team ${st.oeTeamId ?? "unknown"} (audited, nothing posted)`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "linear",
        workspace: st.organizationId ?? "unknown",
        action: "linear.supervisor_turn_failed",
        detail: { teamId: st.oeTeamId ?? null },
      }).catch(() => undefined);
    },
    async "session.failed"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("session.failed")?.(data, channel);
        return;
      }
      const st = channel.state as LinearSupervisorSessionState;
      slog(`supervisor session failed on team ${st.oeTeamId ?? "unknown"} (audited; next wake force-rotates)`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "linear",
        workspace: st.organizationId ?? "unknown",
        action: "linear.supervisor_session_failed",
        detail: { teamId: st.oeTeamId ?? null },
      }).catch(() => undefined);
    },
  },
});

type HttpHandler = HttpRouteDefinition<LinearChannelState>["handler"];
function wrapRoute(inner: HttpHandler): HttpHandler {
  return async (req, args) => {
    const body = await req.text();
    const cloned = new Request(req.url, { method: "POST", headers: req.headers, body });
    const res = await inner(cloned, args);
    if (res.ok) {
      args.waitUntil(ambientDelivery(body, req.headers, args.send, args.receive).catch((err) => slog(`ambient leg failed: ${String(err)}`)));
    }
    return res;
  };
}

const routes: LinearChannel["routes"] = native.routes.map((r) =>
  r.transport !== "websocket" && r.method === "POST" && r.path === ROUTE
    ? { ...r, handler: wrapRoute(r.handler) }
    : r,
);

const channel: LinearChannel = { ...native, routes };

export default channel;
