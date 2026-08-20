import {
  linearChannel,
  callLinearGraphQL,
  createLinearAgentActivity,
  parseLinearWebhookEvent,
  type LinearApiOptions,
  type LinearAgentSessionEvent,
  type LinearChannelCredentials,
  type LinearChannel,
  type LinearChannelState,
  type LinearSessionContext,
  type LinearInboundResult,
} from "eve/channels/linear";
import type { HttpRouteDefinition, RouteHandlerArgs } from "eve/channels";
import { buildLinearAuth, linearAuthorFacts, teamFactsFromTeam, userGuestFromUser } from "./linear-identity.js";
import { linearAppActorCredentials, linearAppForOrg, linearCredentialsForOrg } from "./linear-credentials.js";
import { linearWebhookVerifier } from "./linear-webhook-verify.js";
import { LINEAR_EVENT_SOURCE, LINEAR_DELIVERY_ID_HEADER } from "./linear-event-normalizer.js";
import {
  classifyLinearAmbientComment,
  extractLinearCommentSignal,
  linearSupervisorToken,
  linearAgentSessionSignal,
  routeLinearAgentSession,
  handleLinearSupervisorDispatch,
  shouldRotate,
  isLinearDirectSelfAuthored,
  type LinearSupervisorDeps,
} from "./linear-supervisor.js";
import {
  supervisorGrainFor,
  mintRotationToken,
  claimRuntimeRotation,
  grainUsesUnifiedWindow,
  mintWakeId,
  divertToUnifiedWindow,
  finalMessageActionForTurn,
  silentRoutineThisTurn,
  completeSupervisorTurn,
  consumeSupervisorReplyMark,
  capabilitiesForPlatform,
  auditSupervisorFailure,
  appendAudit,
  ingressSpendGate,
  auditAmbientSkip,
  deploymentOrg,
  resolveWakeTrustFromContext,
  isVouchedInternal,
  getConfig,
  ambientSupervisorEnabled,
  engagementTierFor,
  liveMemoryDeltaDep,
  getOperationalStore,
  admitTrigger,
  replierLabelFromAuthAttributes,
  withReplierPrefix,
  resolveExternalPolicy,
  externalPolicyOverrideFor,
  roomIsSilenced,
  withholdsBody,
  stampNonMemberChatAuth,
  type SupervisorGrain,
  type UnifiedWindowWake,
  type EngagementTier,
  type ReplierLabel,
  type ExternalPolicy,
  type IngestedChatMessage,
  dmTrustTtlMs,
  carryTailForward,
  type WakeMessageInput,
  recordWakeTail,
} from "@open-everywhere/core/agent/adapter-api.js";

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
  opts?: { readonly api?: LinearApiOptions; readonly credentials?: LinearChannelCredentials; readonly organizationId?: string },
): Promise<boolean | undefined> {
  if (!teamId) return undefined;
  try {
    const data = await callLinearGraphQL<{ team?: { private?: boolean } }>({
      api: opts?.api,
      credentials: opts?.credentials ?? linearCredentialsForOrg(opts?.organizationId),
      query: "query TeamPrivacy($id: String!) { team(id: $id) { private } }",
      queryName: "TeamPrivacy",
      variables: { id: teamId },
    });
    return teamFactsFromTeam(data).isPrivate;
  } catch {
    return undefined;
  }
}

export async function enrichIssueTeam(
  issueId: string | undefined,
  opts?: { readonly api?: LinearApiOptions; readonly credentials?: LinearChannelCredentials; readonly organizationId?: string },
): Promise<{ readonly teamId: string; readonly isPrivate: boolean | undefined } | undefined> {
  if (!issueId) return undefined;
  try {
    const d = await callLinearGraphQL<{ issue?: { team?: { id?: string; private?: boolean } } }>({
      api: opts?.api,
      credentials: opts?.credentials ?? linearCredentialsForOrg(opts?.organizationId),
      query: "query OeIssueTeam($id: String!) { issue(id: $id) { team { id private } } }",
      queryName: "OeIssueTeam",
      variables: { id: issueId },
    });
    const team = d.issue?.team;
    const teamId = str(team?.id);
    if (!teamId) return undefined;
    return { teamId, isPrivate: typeof team?.private === "boolean" ? team.private : undefined };
  } catch {
    return undefined;
  }
}

const linearGuestCache = new Map<string, { guest: boolean; at: number }>();

export async function enrichUserGuest(
  userId: string | undefined,
  opts?: { readonly api?: LinearApiOptions; readonly credentials?: LinearChannelCredentials; readonly organizationId?: string },
): Promise<boolean | undefined> {
  if (!userId) return undefined;
  const hit = linearGuestCache.get(userId);
  if (hit && Date.now() - hit.at < dmTrustTtlMs()) return hit.guest;
  try {
    const d = await callLinearGraphQL<{ user?: { guest?: boolean } }>({
      api: opts?.api,
      credentials: opts?.credentials ?? (linearAppForOrg(opts?.organizationId) ? linearCredentialsForOrg(opts?.organizationId) : undefined),
      query: "query OeUserGuest($id: String!) { user(id: $id) { guest } }",
      queryName: "OeUserGuest",
      variables: { id: userId },
    });
    const guest = userGuestFromUser(d.user).guest;
    if (typeof guest === "boolean") linearGuestCache.set(userId, { guest, at: Date.now() });
    return guest;
  } catch {
    return undefined;
  }
}

export function _resetLinearGuestCache(): void {
  linearGuestCache.clear();
}

const viewerCache = new Map<string, Promise<{ id?: string; name?: string }>>();
function resolveViewer(organizationId?: string): Promise<{ id?: string; name?: string }> {
  const key = organizationId ?? "";
  const cached = viewerCache.get(key);
  if (cached) return cached;
  const registered = linearAppForOrg(organizationId) !== undefined;
  const overrideId = registered ? undefined : process.env.LINEAR_APP_USER_ID;
  const overrideName = registered ? undefined : process.env.LINEAR_APP_NAME;
  const resolved =
    overrideId && overrideName
      ? Promise.resolve({ id: overrideId, name: overrideName })
      : callLinearGraphQL<{ viewer?: { id?: string; name?: string; displayName?: string } }>({
          credentials: linearCredentialsForOrg(organizationId),
          query: "query OeViewer { viewer { id name displayName } }",
          queryName: "OeViewer",
        })
          .then((d) => ({ id: str(d.viewer?.id), name: str(d.viewer?.displayName) ?? str(d.viewer?.name) }))
          .catch((err) => {
            slog(`could not resolve app viewer (query OeViewer failed): ${String(err)}`);
            return {};
          });
  viewerCache.set(key, resolved);
  return resolved;
}

export function _resetLinearViewerCache(): void {
  viewerCache.clear();
}

interface EnrichedLinearComment {
  readonly id: string;
  readonly body?: string;
  readonly createdAt?: string;
  readonly authorId?: string;
  readonly authorName?: string;
  readonly authorGuest?: boolean;
  readonly parentId?: string;
  readonly parentAuthorId?: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
  readonly issueTitle?: string;
  readonly teamId?: string;
  readonly teamPrivate?: boolean;
}

async function enrichComment(commentId: string, organizationId?: string): Promise<EnrichedLinearComment | undefined> {
  try {
    const d = await callLinearGraphQL<{
      comment?: {
        id?: string;
        body?: string;
        createdAt?: string;
        user?: { id?: string; name?: string; displayName?: string; guest?: boolean };
        parent?: { id?: string; user?: { id?: string } };
        issue?: { id?: string; identifier?: string; title?: string; team?: { id?: string; private?: boolean } };
      };
    }>({
      credentials: linearCredentialsForOrg(organizationId),
      query:
        "query OeAmbientComment($id: String!) { comment(id: $id) { id body createdAt " +
        "user { id name displayName guest } parent { id user { id } } " +
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
      authorGuest: userGuestFromUser(c.user).guest,
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

function linearTeamVouched(organizationId: string, teamId: string): boolean {
  return isVouchedInternal(`linear/${organizationId}`, `linear/${organizationId}/${teamId}`) || process.env.OE_TRUST === "internal";
}

export type LinearExternalVerdict = "proceed" | "withheld-author" | "silent-room";

export function linearExternalVerdict(input: {
  readonly policy: ExternalPolicy;
  readonly surfaceKey?: string;
  readonly author?: IngestedChatMessage;
}): LinearExternalVerdict {
  if (input.author !== undefined && withholdsBody(input.author, input.policy)) return "withheld-author";
  if (input.surfaceKey === undefined) return "proceed";
  const ingested = input.author === undefined ? [] : [input.author];
  return roomIsSilenced({ room: { surfaceKey: input.surfaceKey }, ingested }, input.policy) ? "silent-room" : "proceed";
}

async function linearExternalSuppressed(
  surfaceKey: string | undefined,
  organizationId: string | undefined,
  principalId: string | undefined,
  author?: IngestedChatMessage,
): Promise<Exclude<LinearExternalVerdict, "proceed"> | undefined> {
  let policy: ExternalPolicy;
  try {
    policy = resolveExternalPolicy(externalPolicyOverrideFor(surfaceKey, getConfig().loadDomains()));
  } catch {
    policy = resolveExternalPolicy();
  }
  const verdict = linearExternalVerdict({
    policy,
    ...(surfaceKey === undefined ? {} : { surfaceKey }),
    ...(author === undefined ? {} : { author }),
  });
  if (verdict === "proceed") return undefined;
  await appendAudit({
    org: deploymentOrg(),
    platform: "linear",
    workspace: organizationId ?? "unknown",
    ...(surfaceKey === undefined ? {} : { surface: surfaceKey }),
    ...(principalId ? { principalId } : {}),
    action: "linear.external_policy_suppressed",
    detail: { verdict },
  }).catch(() => undefined);
  slog(`suppressed ${surfaceKey ?? `linear/${organizationId ?? "unknown"}/<team unresolved>`}: externalPolicy verdict "${verdict}"`);
  return verdict;
}

function linearSilentCloseStatus(verdict: Exclude<LinearExternalVerdict, "proceed">): string {
  return verdict === "silent-room" ? "(no reply — this room is set up as an external space)" : "(no reply)";
}

async function silentlyCloseLinearAgentSession(
  agentSessionId: string,
  verdict: Exclude<LinearExternalVerdict, "proceed">,
  organizationId?: string,
): Promise<void> {
  await createLinearAgentActivity({
    credentials: linearCredentialsForOrg(organizationId),
    activity: { agentSessionId, content: { type: "thought", body: linearSilentCloseStatus(verdict) }, ephemeral: true, signal: "stop" },
  }).catch((err) => slog(`external-policy session close failed (session ${agentSessionId}): ${String(err)}`));
}

type LinearSend = (
  payload: { readonly message: string; readonly context?: readonly string[] },
  options: { readonly auth: unknown; readonly continuationToken: string; readonly state?: LinearChannelState },
) => Promise<unknown>;

function linearSendFrom(from: RouteHandlerArgs<LinearChannelState>["from"]): LinearSend {
  return (payload, options) =>
    from(options.continuationToken).send(payload.message, {
      auth: options.auth,
      state: options.state,
      ...(payload.context && payload.context.length > 0 ? { context: payload.context } : {}),
    } as never);
}

function liveLinearSupervisorDeps(
  send: LinearSend,
  teamId: string,
  organizationId: string,
  to?: RouteHandlerArgs["to"],
): LinearSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, team, atIso) {
      const grain = linearGrainFor(surfaceKey);
      const runtimeChanged = await claimRuntimeRotation({ org, registryKey: grain.registryKey, surfaceKey, atIso });
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, 1, () => linearSupervisorToken(team, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, tail: [] as readonly WakeMessageInput[] };
      }
      if (shouldRotate(existing, atIso, { runtimeChanged })) {
        const gen = existing.generation + 1;
        const tail = await carryTailForward(org, grain.registryKey, existing.token);
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => linearSupervisorToken(team, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, tail };
      }
      const fresh = existing.firstWakeAt == null;
      return { token: existing.token, generation: existing.generation, freshGeneration: fresh, tail: [] as readonly WakeMessageInput[], ...(fresh ? {} : { lastWakeAt: existing.lastWakeAt }) };
    },
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, linearGrainFor(surfaceKey).registryKey, atIso),
    recordWake: (entry, token, surfaceKey) => recordWakeTail(org, linearGrainFor(surfaceKey).registryKey, token, entry),
    memoryDelta: liveMemoryDeltaDep(org, `linear/${organizationId}/${teamId}`),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, window }) {
      if (window && to) {
        await divertToUnifiedWindow(to, {
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
        { auth: auth as unknown, continuationToken: token, state: supervisorSeedState(teamId, organizationId, unified) },
      );
    },
  };
}

async function ambientDelivery(body: string, headers: Headers, send: LinearSend, to?: RouteHandlerArgs["to"]): Promise<void> {
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
  const c = await enrichComment(signal.commentId, signal.organizationId);
  if (!c || !c.teamId || !c.issueId) return;
  const surfaceKey = `linear/${signal.organizationId}/${c.teamId}`;
  const authorFacts = linearAuthorFacts(c.authorGuest);
  if (await linearExternalSuppressed(surfaceKey, signal.organizationId, c.authorId, authorFacts)) return;
  if (!linearAmbientEnabled(surfaceKey)) {
    await auditAmbientSkip({ platform: "linear", workspace: signal.organizationId, surfaceKey, log: slog });
    return;
  }
  const viewer = await resolveViewer(signal.organizationId);
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
    guest: c.authorGuest,
    isPrivate: c.teamPrivate,
    commentId: c.id,
    parentCommentId: c.parentId,
  });
  const wakeTrust = resolveWakeTrustFromContext(
    { channel: { kind: "linear" }, session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } } },
    { id: c.authorId, isBot: false },
    { principalFallback: true },
  );
  const singleWindow = grainUsesUnifiedWindow(linearGrainFor(surfaceKey));
  const ambientVouched = singleWindow && !!to && linearTeamVouched(signal.organizationId, c.teamId);
  const ambientWindow: UnifiedWindowWake | undefined = ambientVouched
    ? {
        wakeId: mintWakeId(),
        origin: {
          platform: "linear",
          ambient: true,
          issueId: c.issueId,
          ...(c.parentId ? { parentId: c.parentId } : {}),
          ...(signal.organizationId ? { organizationId: signal.organizationId } : {}),
        },
      }
    : undefined;
  await handleLinearSupervisorDispatch(
    {
      surfaceKey,
      teamId: c.teamId,
      issueId: c.issueId,
      issueIdentifier: c.issueIdentifier,
      issueTitle: c.issueTitle,
      auth,
      ingested: [authorFacts],
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
      window: ambientWindow,
    },
    liveLinearSupervisorDeps(send, c.teamId, signal.organizationId, to),
  );
  await appendAudit({
    org: deploymentOrg(),
    platform: "linear",
    workspace: signal.organizationId,
    surface: surfaceKey,
    principalId: c.authorId,
    action: "linear.dispatched",
    detail: { addressing: cls.addressing, issueId: c.issueId, teamPrivate: c.teamPrivate === true, vouched: linearTeamVouched(signal.organizationId, c.teamId), diverted: ambientWindow !== undefined },
  });
  slog(`comment on ${surfaceKey} (${c.issueIdentifier ?? c.issueId}) → judged wake dispatched`);
}

export const LINEAR_MENTION_HANDOFF_TEXT =
  "Working on it — the org's cross-surface agent is answering; the reply will land here in a moment.";

export const LINEAR_MENTION_DIVERT_FAILED_TEXT =
  "Open Everywhere couldn't route this mention to the org's cross-surface agent — please mention me again to retry.";

interface MentionRoutingVerdict {
  readonly routing: ReturnType<typeof routeLinearAgentSession>;
  readonly teamId?: string;
  readonly isPrivate?: boolean;
}

const mentionRoutingMemo = new Map<string, Promise<MentionRoutingVerdict>>();

function deliveryMemoKey(event: LinearAgentSessionEvent): string | undefined {
  const did = event.delivery?.id;
  if (typeof did === "string" && did.length > 0) return `d:${did}`;
  const sid = typeof event.agentSession?.id === "string" ? event.agentSession.id : undefined;
  if (!sid) return undefined;
  const act = event.action ?? "";
  const promptC = event.agentActivity?.sourceCommentId ?? "";
  const srcC = event.agentSession?.sourceCommentId ?? event.agentSession?.commentId ?? "";
  return `s:${sid}:${act}:${promptC}:${srcC}`;
}

function agentSessionIssueId(event: LinearAgentSessionEvent): string | undefined {
  const s = event.agentSession;
  return str(s.issueId) ?? str(s.issue?.id);
}

export async function computeMentionRouting(event: LinearAgentSessionEvent, teamId: string | undefined): Promise<MentionRoutingVerdict> {
  const sig = linearAgentSessionSignal(event, teamId);
  let resolvedTeamId = sig.teamId;
  let enrichedPrivate: boolean | undefined;
  let enrichedTeam = false;
  if (!resolvedTeamId) {
    const t = await enrichIssueTeam(agentSessionIssueId(event), { organizationId: sig.organizationId });
    resolvedTeamId = t?.teamId;
    enrichedPrivate = t?.isPrivate;
    enrichedTeam = t !== undefined;
  }
  const routingSig = resolvedTeamId === sig.teamId ? sig : { ...sig, teamId: resolvedTeamId };
  const sk = routingSig.organizationId && resolvedTeamId ? `linear/${routingSig.organizationId}/${resolvedTeamId}` : undefined;
  const singleWindow = sk ? grainUsesUnifiedWindow(linearGrainFor(sk)) : false;
  const vouched = singleWindow && !!routingSig.organizationId && !!resolvedTeamId && linearTeamVouched(routingSig.organizationId, resolvedTeamId);
  const isPrivate = enrichedTeam
    ? enrichedPrivate
    : singleWindow
      ? await enrichTeamPrivacy(resolvedTeamId, { organizationId: routingSig.organizationId })
      : undefined;
  if (singleWindow && sk) slog(`agent-session routing ${sk}: singleWindow, vouched=${vouched}, teamPrivate=${isPrivate === true} (signal) → ${vouched ? "may divert" : "native"}`);
  return {
    routing: routeLinearAgentSession(routingSig, singleWindow, vouched),
    ...(resolvedTeamId === undefined ? {} : { teamId: resolvedTeamId }),
    isPrivate,
  };
}

function mentionRoutingFor(event: LinearAgentSessionEvent, teamId: string | undefined): Promise<MentionRoutingVerdict> {
  const key = deliveryMemoKey(event);
  const compute = (): Promise<MentionRoutingVerdict> => computeMentionRouting(event, teamId).catch(() => ({ routing: "native" as const }));
  if (!key) return compute();
  const existing = mentionRoutingMemo.get(key);
  if (existing) return existing;
  const p = compute();
  mentionRoutingMemo.set(key, p);
  if (mentionRoutingMemo.size > 512) {
    const oldest = mentionRoutingMemo.keys().next().value;
    if (oldest !== undefined) mentionRoutingMemo.delete(oldest);
  }
  return p;
}

async function mentionSessionDelivery(body: string, headers: Headers, send: LinearSend, to?: RouteHandlerArgs["to"]): Promise<void> {
  let event: ReturnType<typeof parseLinearWebhookEvent>;
  try {
    event = parseLinearWebhookEvent({ body, headers });
  } catch {
    return;
  }
  if (!event || event.kind !== "agent_session") return;
  const teamId = teamIdFromRaw(event.raw);
  const verdict = await mentionRoutingFor(event, teamId);
  if (verdict.routing !== "suppress-and-divert") return;
  const sig = linearAgentSessionSignal(event, teamId);
  const agentSessionId = sig.agentSessionId!;
  const organizationId = sig.organizationId!;
  const roomTeamId = sig.teamId ?? verdict.teamId;
  const surfaceKey = roomTeamId ? `linear/${organizationId}/${roomTeamId}` : undefined;
  const roomVerdict = await linearExternalSuppressed(surfaceKey, organizationId, undefined);
  if (roomVerdict) {
    await silentlyCloseLinearAgentSession(agentSessionId, roomVerdict, organizationId);
    return;
  }
  const triggerCommentId = sig.action === "prompted" ? sig.promptSourceCommentId : sig.sourceCommentId;
  try {
    if (!to) throw new Error("no cross-channel dispatch on this route (cannot reach the unified window)");
    if (!triggerCommentId) throw new Error("suppress-and-divert with no trigger comment id (unreachable — the router requires one)");
    const c = await enrichComment(triggerCommentId, organizationId);
    if (!c || !c.teamId || !c.issueId) throw new Error("mention-comment enrichment failed (no issue/team anchor)");
    const viewer = await resolveViewer(organizationId);
    if (isLinearDirectSelfAuthored(c.authorId, viewer)) {
      slog(`@mention on linear/${organizationId}/${c.teamId} (${c.issueIdentifier ?? c.issueId}) dropped: self-authored comment (our own reply) — session ${agentSessionId}`);
      return;
    }
    const authorFacts = linearAuthorFacts(c.authorGuest);
    const authorVerdict = await linearExternalSuppressed(
      `linear/${organizationId}/${c.teamId}`,
      organizationId,
      c.authorId,
      authorFacts,
    );
    if (authorVerdict) {
      await silentlyCloseLinearAgentSession(agentSessionId, authorVerdict, organizationId);
      return;
    }
    const grain = linearGrainFor(`linear/${organizationId}/${c.teamId}`);
    if (!grainUsesUnifiedWindow(grain)) throw new Error("no single-context window (crossSurface/solo) holds for the enriched team (config raced or team mismatch)");
    const vouched = linearTeamVouched(organizationId, c.teamId);
    slog(`mention divert linear/${organizationId}/${c.teamId} (${c.issueIdentifier ?? c.issueId}): vouched=${vouched}, teamPrivate=${c.teamPrivate === true} (signal)`);
    if (!vouched) throw new Error("enriched team is not operator-vouched internal (M1 window floor) — refusing the divert");
    const auth = buildLinearAuth({
      agentSessionId,
      organizationId,
      teamId: c.teamId,
      issueId: c.issueId,
      issueIdentifier: c.issueIdentifier,
      principalId: c.authorId,
      guest: c.authorGuest,
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
        surfaceKey: `linear/${organizationId}/${c.teamId}`,
        teamId: c.teamId,
        issueId: c.issueId,
        issueIdentifier: c.issueIdentifier,
        issueTitle: c.issueTitle,
        auth,
        ingested: [authorFacts],
        trigger: {
          id: c.id,
          authorId: c.authorId,
          authorName: c.authorName,
          sentAt: c.createdAt ?? new Date().toISOString(),
          text: c.body ?? "(the comment had no text)",
          trust: wakeTrust,
        },
        unified: grain.unified,
        directMention: true,
        window: {
          wakeId: mintWakeId(),
          origin: { platform: "linear", agentSessionId, issueId: c.issueId, parentId: c.parentId ?? c.id, ...(organizationId ? { organizationId } : {}) },
          addressing: "direct-mention",
        } satisfies UnifiedWindowWake,
      },
      liveLinearSupervisorDeps(send, c.teamId, organizationId, to),
    );
    await appendAudit({
      org: deploymentOrg(),
      platform: "linear",
      workspace: organizationId,
      surface: `linear/${organizationId}/${c.teamId}`,
      principalId: c.authorId,
      action: "linear.dispatched",
      detail: { addressing: "direct", issueId: c.issueId, agentSessionId },
    });
    await createLinearAgentActivity({ credentials: linearCredentialsForOrg(organizationId), activity: { agentSessionId, content: { type: "thought", body: LINEAR_MENTION_HANDOFF_TEXT } } }).catch((err) =>
      slog(`mention hand-off activity failed (dispatch already succeeded): ${String(err)}`),
    );
    slog(`@mention on linear/${organizationId}/${c.teamId} (${c.issueIdentifier ?? c.issueId}) → addressed direct-mention wake diverted to the unified window`);
  } catch (err) {
    slog(`single-window mention divert FAILED (session ${agentSessionId}): ${String(err)}`);
    await appendAudit({
      org: deploymentOrg(),
      platform: "linear",
      workspace: organizationId,
      ...(surfaceKey === undefined ? {} : { surface: surfaceKey }),
      action: "linear.mention_divert_failed",
      detail: { agentSessionId, error: String(err).slice(0, 300) },
    }).catch(() => undefined);
    await createLinearAgentActivity({ credentials: linearCredentialsForOrg(organizationId), activity: { agentSessionId, content: { type: "error", body: LINEAR_MENTION_DIVERT_FAILED_TEXT } } }).catch(() => undefined);
  }
}

const pristineByOrg = new Map<string, LinearChannel>();
function buildPristine(key: string): LinearChannel {
  const pristine = linearChannel({ credentials: key === "" ? linearAppActorCredentials : linearCredentialsForOrg(key) });
  return pristine;
}
function pristineFor(organizationId: string | undefined): LinearChannel {
  const key = organizationId ?? "";
  let channel = pristineByOrg.get(key);
  if (channel === undefined) {
    channel = buildPristine(key);
    pristineByOrg.set(key, channel);
  }
  return channel;
}
export function _resetLinearPristineChannels(): void {
  pristineByOrg.clear();
}
type AdapterEventFn = (data: unknown, adapterCtx: unknown, sessionCtx?: unknown) => unknown;
const defaultEvent = (name: string, organizationId?: string): AdapterEventFn | undefined =>
  (pristineFor(organizationId) as unknown as { adapter?: Record<string, AdapterEventFn> }).adapter?.[name];

function nativeOrgOf(state: LinearChannelState): string | undefined {
  const stamped = (state as unknown as Record<string, unknown>).oeOrganizationId;
  if (typeof stamped === "string" && stamped.length > 0) return stamped;
  const fromEve = state.organizationId;
  return typeof fromEve === "string" && fromEve.length > 0 ? fromEve : undefined;
}

export const linearOnAgentSession = async (_ctx: LinearSessionContext, event: LinearAgentSessionEvent): Promise<LinearInboundResult> => {
    const s = event.agentSession;
    const agentSessionId = s.id;
    if (!agentSessionId) return null;

    const rawTeamId = teamIdFromRaw(event.raw);

    const verdict = await mentionRoutingFor(event, rawTeamId);
    if (verdict.routing === "suppress-and-divert") return null;

    const teamId = rawTeamId ?? verdict.teamId;

    const nativeOrganizationId = event.organizationId ?? s.organizationId ?? undefined;
    if (typeof nativeOrganizationId === "string" && nativeOrganizationId && teamId) {
      const surfaceKey = `linear/${nativeOrganizationId}/${teamId}`;
      const roomVerdict = await linearExternalSuppressed(surfaceKey, nativeOrganizationId, undefined);
      if (roomVerdict) {
        await silentlyCloseLinearAgentSession(agentSessionId, roomVerdict, event.organizationId);
        return null;
      }
    }

    const isPrivate = verdict.isPrivate ?? (rawTeamId === undefined ? undefined : await enrichTeamPrivacy(rawTeamId, { organizationId: event.organizationId }));

    const creatorId = s.creator?.id ?? s.creatorId ?? event.appUserId ?? undefined;
    const guest = await enrichUserGuest(creatorId, { organizationId: event.organizationId });
    const authorFacts = linearAuthorFacts(guest);
    const nativeOrg = typeof nativeOrganizationId === "string" && nativeOrganizationId ? nativeOrganizationId : undefined;
    const nativeSurfaceKey = nativeOrg !== undefined && teamId ? `linear/${nativeOrg}/${teamId}` : undefined;

    {
      const authorVerdict = await linearExternalSuppressed(nativeSurfaceKey, nativeOrg, creatorId, authorFacts);
      if (authorVerdict) {
        await silentlyCloseLinearAgentSession(agentSessionId, authorVerdict, event.organizationId);
        return null;
      }
    }

    const auth = stampNonMemberChatAuth(
      buildLinearAuth({
        agentSessionId,
        organizationId: event.organizationId ?? s.organizationId ?? undefined,
        teamId,
        issueId: s.issueId ?? s.issue?.id ?? undefined,
        issueIdentifier: s.issue?.identifier ?? undefined,
        principalId: creatorId,
        guest,
        isPrivate,
      }),
      [authorFacts],
      nativeSurfaceKey === undefined ? {} : { surfaceKey: nativeSurfaceKey },
    );

    const refuse = async (text: string): Promise<void> => {
      await createLinearAgentActivity({ credentials: linearCredentialsForOrg(event.organizationId), activity: { agentSessionId, content: { type: "error", body: text } } });
    };
    if ((await ingressSpendGate({
      bindable: { channel: { kind: "linear" as const }, session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } } },
      door: "mention",
      ...(creatorId !== undefined ? { principalId: creatorId } : {}),
      post: refuse,
    })) === "declined") {
      return null;
    }

    return { auth };
};

const native: LinearChannel = linearChannel({
  credentials: { ...linearAppActorCredentials, webhookVerifier: linearWebhookVerifier },
  turnPolicy: "queue",
  onAgentSession: linearOnAgentSession,
  events: {
    async "turn.started"(data, channel, ctx) {
      if (!isSupervisorLinearState(channel.state)) {
        const nativeAttrs = ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined;
        (channel.state as unknown as Record<string, unknown>).oeReplierLabel = replierLabelFromAuthAttributes(nativeAttrs);
        const wakeOrg = str(nativeAttrs?.organization_id);
        if (wakeOrg) (channel.state as unknown as Record<string, unknown>).oeOrganizationId = wakeOrg;
        await defaultEvent("turn.started", nativeOrgOf(channel.state))?.(data, channel);
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
      if (!isSupervisorLinearState(channel.state)) await defaultEvent("actions.requested", nativeOrgOf(channel.state))?.(data, channel);
    },
    async "input.requested"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("input.requested", nativeOrgOf(channel.state))?.(data, channel);
        return;
      }
      slog("supervisor turn requested input — unsupported on a judged ambient turn; ignored");
    },
    async "authorization.required"(data, channel, ctx) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("authorization.required", nativeOrgOf(channel.state))?.(data, channel, ctx);
        return;
      }
      slog("supervisor turn requested authorization — there is no agent session to elicit into; ignored");
    },
    async "authorization.completed"(data, channel, ctx) {
      if (!isSupervisorLinearState(channel.state)) await defaultEvent("authorization.completed", nativeOrgOf(channel.state))?.(data, channel, ctx);
    },
    async "message.completed"(data, channel, ctx) {
      if (!isSupervisorLinearState(channel.state)) {
        if (silentRoutineThisTurn()) return;
        const nativeLabel = (channel.state as unknown as Record<string, unknown>).oeReplierLabel as ReplierLabel | undefined;
        const forwarded =
          data.finishReason !== "tool-calls" && data.message !== null && nativeLabel
            ? { ...data, message: withReplierPrefix(data.message, nativeLabel) }
            : data;
        await defaultEvent("message.completed", nativeOrgOf(channel.state))?.(forwarded, channel);
        return;
      }
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const st = channel.state as LinearSupervisorSessionState;
      const target = st.oeReplyTarget;
      const org = deploymentOrg();
      const repliedViaTool = consumeSupervisorReplyMark(ctx);
      const auditTeamId = (st.oeUnified === true ? target?.teamId : undefined) ?? st.oeTeamId;
      const auditOrgId = (st.oeUnified === true ? target?.organizationId : undefined) ?? st.organizationId;
      const surface = auditTeamId ? `linear/${auditOrgId ?? "unknown"}/${auditTeamId}` : undefined;
      const row = { org, platform: "linear", workspace: auditOrgId ?? "unknown", surface };
      await completeSupervisorTurn({
        action,
        ...(sessionId ? { sessionId } : {}),
        repliedViaTool,
        midTurnPost: capabilitiesForPlatform("linear").midTurnPost,
        noReplyAction: "linear.no_reply",
        repliedAction: "linear.replied",
        contextRow: row,
        repliedRow: row,
        silentAnchor: { issueId: target?.issueId ?? null },
        droppedAnchor: { issueId: target?.issueId },
        repliedAnchor: { issueId: target?.issueId, parentId: target?.parentId ?? null },
        log: (m) => slog(m),
      });
    },
    async "turn.failed"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("turn.failed", nativeOrgOf(channel.state))?.(data, channel);
        return;
      }
      const st = channel.state as LinearSupervisorSessionState;
      slog(`supervisor turn failed on team ${st.oeTeamId ?? "unknown"} (audited, nothing posted)`);
      await auditSupervisorFailure(
        { org: deploymentOrg(), platform: "linear", workspace: st.organizationId ?? "unknown" },
        "linear.supervisor_turn_failed",
        { teamId: st.oeTeamId ?? null },
      );
    },
    async "session.failed"(data, channel) {
      if (!isSupervisorLinearState(channel.state)) {
        await defaultEvent("session.failed", nativeOrgOf(channel.state))?.(data, channel);
        return;
      }
      const st = channel.state as LinearSupervisorSessionState;
      slog(`supervisor session failed on team ${st.oeTeamId ?? "unknown"} (audited)`);
      await auditSupervisorFailure(
        { org: deploymentOrg(), platform: "linear", workspace: st.organizationId ?? "unknown" },
        "linear.supervisor_session_failed",
        { teamId: st.oeTeamId ?? null },
      );
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
      args.waitUntil(ambientDelivery(body, req.headers, linearSendFrom(args.from), args.to).catch((err) => slog(`ambient leg failed: ${String(err)}`)));
      args.waitUntil(mentionSessionDelivery(body, req.headers, linearSendFrom(args.from), args.to).catch((err) => slog(`mention leg failed: ${String(err)}`)));
      const deliveryId = req.headers.get(LINEAR_DELIVERY_ID_HEADER) ?? undefined;
      args.waitUntil(
        admitTrigger(
          {
            source: LINEAR_EVENT_SOURCE,
            headers: {},
            body,
            receivedAt: new Date().toISOString(),
            ...(deliveryId ? { deliveryId } : {}),
          },
          { to: args.to },
        ).then(
          (report) => {
            if (report.matched > 0) slog(`event plane: ${report.matched} matched -> ${report.fired} fired, ${report.skipped} skipped`);
          },
          (err) => slog(`event plane: admitTrigger threw (routing lost for this delivery): ${String(err)}`),
        ),
      );
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
