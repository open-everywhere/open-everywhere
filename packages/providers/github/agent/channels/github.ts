import type { HttpRouteDefinition, RouteHandlerArgs } from "eve/channels";
import { githubChannel, type GitHubChannel, type GitHubChannelState, type GitHubInboundContext, type GitHubComment, type GitHubInboundResult } from "eve/channels/github";
import { buildGitHubAuth, githubAuthorFacts, githubBotMentioned } from "./github-identity.js";
import {
  githubEngagedAdmits,
  githubEngagedFollowUpReach,
  githubMachineAuthored,
  githubWakeAddressing,
  markGitHubEngaged,
  resolveGitHubEngagement,
  type GitHubEngagementVerdict,
  type GitHubSeamFacts,
} from "./github-engagement.js";
import { parseGitHubStopComment, routeGitHubStopComment } from "./github-stop.js";
import { liveGitHubReactionFeedbackDeps, parseGitHubReactionPollTarget, routeGitHubReactionFeedback } from "./github-reaction-feedback.js";
import {
  classifyGitHubAmbientComment,
  extractGitHubAmbientEvent,
  githubSupervisorToken,
  handleGitHubSupervisorDispatch,
  shouldRotate,
  type GitHubAmbientEvent,
  type GitHubSupervisorDeps,
} from "./github-supervisor.js";
import { extractGitHubInstallationEvent, handleGitHubInstallationDelivery } from "./github-installations.js";
import {
  recordGitHubInstallation,
  forgetGitHubInstallation,
  supervisorGrainFor,
  mintRotationToken,
  claimRuntimeRotation,
  grainUsesUnifiedWindow,
  mintWakeId,
  vendorInstantEventTime,
  spreadVendorTs,
  singleWindowMentionPolicy,
  isVouchedInternal,
  divertInboundToUnifiedWindow,
  finalMessageActionForTurn,
  completeSupervisorTurn,
  consumeSupervisorReplyMark,
  postTerminalProse,
  resolvePartition,
  type ChatAuditPartition,
  auditSupervisorFailure,
  healPrunedDeploymentStrand,
  capabilitiesForPlatform,
  appendAudit,
  ingressSpendGate,
  auditAmbientSkip,
  deploymentOrg,
  resolveWakeTrustFromContext,
  getConfig,
  ambientSupervisorEnabled,
  engagementTierFor,
  getOperationalStore,
  postOnce,
  gateGithubDelivery,
  getSettings,
  fanOutGitHubDelivery,
  resolveExternalPolicy,
  externalPolicyOverrideFor,
  roomIsSilenced,
  withholdsBody,
  EXTERNAL_MENTION_ACK,
  owesSuppressedMentionAck,
  suppressionRendering,
  stampNonMemberChatAuth,
  type IngestedChatMessage,
  type SupervisorGrain,
  type UnifiedWindowWake,
  type EngagementTier,
  type ExternalPolicy,
  carryTailForward,
  type WakeMessageInput,
  recordWakeTail,
  seatCatchUp,
  seatAdmissionFor,
  ENGAGED_FOLLOW_UP_CONTEXT,
  OE_ADDRESSED_ATTR,
} from "@open-everywhere/core/agent/adapter-api.js";

const ROUTE = "/eve/v1/github";
const BOT_NAME = process.env.GITHUB_APP_SLUG;

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

function slog(msg: string): void {
  console.log(`[open-everywhere:github-supervisor] ${msg}`);
}

function ilog(msg: string): void {
  console.log(`[open-everywhere:github-installations] ${msg}`);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

type GitHubSupervisorSessionState = GitHubChannelState & {
  oeSupervisor?: boolean;
  oeUnified?: boolean;
  oeReplyTarget?: { issueNumber: number; owner?: string; repo?: string };
};

function isSupervisorGitHubState(state: unknown): state is GitHubSupervisorSessionState {
  return (state as Record<string, unknown> | undefined)?.["oeSupervisor"] === true;
}

function supervisorSeedState(ev: GitHubAmbientEvent, unified: boolean): GitHubSupervisorSessionState {
  return {
    ...(unified ? { oeUnified: true } : {}),
    baseRef: null,
    baseSha: null,
    checkoutPath: null,
    conversationKind: "issue",
    defaultBranch: null,
    headRef: null,
    headSha: null,
    installationId: ev.installationId ?? null,
    issueNumber: null,
    owner: ev.owner,
    pullRequestNumber: null,
    repo: ev.repo,
    repositoryId: ev.repositoryId ?? 0,
    reviewCommentId: null,
    reviewThreadRootCommentId: null,
    triggeringCommentId: null,
    triggeringUserLogin: null,
    oeSupervisor: true,
  };
}

export function githubAmbientLegKeeps(addressing: string, ambientEnabled: boolean, engagedFollowUp: boolean): boolean {
  if (addressing === "drop") return false;
  return addressing === "direct" || engagedFollowUp || ambientEnabled;
}

export async function githubAmbientLegAdmission(
  addressing: string,
  surfaceKey: string,
  f: GitHubSeamFacts,
): Promise<{ readonly keep: boolean; readonly seam: GitHubEngagementVerdict; readonly engagedFollowUp: boolean }> {
  const seam = await resolveGitHubEngagement(f);
  const engagedFollowUp = seam.kind === "deliver" && githubEngagedFollowUpReach(f).reachable;
  return { keep: githubAmbientLegKeeps(addressing, githubAmbientEnabled(surfaceKey), engagedFollowUp), seam, engagedFollowUp };
}

function githubAmbientEnabled(surfaceKey: string): boolean {
  try {
    return ambientSupervisorEnabled(surfaceKey, getConfig().loadDomains());
  } catch {
    return false;
  }
}

function githubEngagementTier(surfaceKey: string): EngagementTier | undefined {
  try {
    return engagementTierFor(surfaceKey, getConfig().loadDomains());
  } catch {
    return undefined;
  }
}

function githubGrainFor(surfaceKey: string): SupervisorGrain {
  try {
    return supervisorGrainFor(surfaceKey, getConfig().loadDomains());
  } catch {
    return { unified: false, registryKey: surfaceKey };
  }
}

export function shouldSuppressNativeMention(singleWindow: boolean, vouched: boolean): boolean {
  return singleWindowMentionPolicy(singleWindow, true, vouched).suppressNative;
}

function githubRepoVouched(owner: string, repo: string): boolean {
  return isVouchedInternal(`github/${owner}`, `github/${owner}/${repo}`) || process.env.OE_TRUST === "internal";
}

export type GitHubExternalVerdict = "proceed" | "withheld-author" | "silent-room";

export function githubExternalVerdict(input: {
  readonly policy: ExternalPolicy;
  readonly author: IngestedChatMessage;
  readonly surfaceKey: string;
}): GitHubExternalVerdict {
  if (withholdsBody(input.author, input.policy)) return "withheld-author";
  return roomIsSilenced({ room: { surfaceKey: input.surfaceKey }, ingested: [input.author] }, input.policy) ? "silent-room" : "proceed";
}

async function githubExternalSuppressed(
  surfaceKey: string,
  owner: string,
  principalId: string | undefined,
  author: IngestedChatMessage,
  ackPost?: (message: string) => Promise<unknown>,
): Promise<boolean> {
  let policy: ExternalPolicy;
  try {
    policy = resolveExternalPolicy(externalPolicyOverrideFor(surfaceKey, getConfig().loadDomains()));
  } catch {
    policy = resolveExternalPolicy();
  }
  const verdict = githubExternalVerdict({ policy, author, surfaceKey });
  if (verdict === "proceed") return false;
  const acked =
    owesSuppressedMentionAck({ addressed: ackPost !== undefined, alreadyAnswered: false }) &&
    (await ackPost!(EXTERNAL_MENTION_ACK).then(
      () => true,
      () => false,
    ));
  await appendAudit({
    org: deploymentOrg(),
    platform: "github",
    workspace: owner,
    surface: surfaceKey,
    ...(principalId ? { principalId } : {}),
    action: "github.external_policy_suppressed",
    detail: { verdict, ...suppressionRendering(acked) },
  }).catch(() => undefined);
  slog(`suppressed ${surfaceKey}: externalPolicy verdict "${verdict}"${acked ? " — mention ack posted" : ""}`);
  return true;
}

type GitHubSend = (
  payload: { readonly message: string; readonly context?: readonly string[] },
  options: { readonly auth: unknown; readonly continuationToken: string; readonly state?: GitHubChannelState },
) => Promise<unknown>;

function githubSendFrom(from: RouteHandlerArgs<GitHubChannelState>["from"]): GitHubSend {
  return (payload, options) =>
    from(options.continuationToken).send(payload.message, {
      auth: options.auth,
      state: options.state,
      ...(payload.context && payload.context.length > 0 ? { context: payload.context } : {}),
    } as never);
}

export function liveGitHubSupervisorDeps(send: GitHubSend, ev: GitHubAmbientEvent, to?: RouteHandlerArgs["to"]): GitHubSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, owner, repo, atIso) {
      const grain = githubGrainFor(surfaceKey);
      const runtimeChanged = await claimRuntimeRotation({ org, registryKey: grain.registryKey, surfaceKey, atIso });
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, 1, () => githubSupervisorToken(owner, repo, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, tail: [] as readonly WakeMessageInput[] };
      }
      if (shouldRotate(existing, atIso, { runtimeChanged })) {
        const gen = existing.generation + 1;
        const tail = await carryTailForward(org, grain.registryKey, existing.token);
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => githubSupervisorToken(owner, repo, gen)), atIso);
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
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, githubGrainFor(surfaceKey).registryKey, atIso),
    catchUp: (req) => seatCatchUp("github", req, { admit: seatAdmissionFor(req.channelKey) }),
    recordWake: (entry, token, surfaceKey) => recordWakeTail(org, githubGrainFor(surfaceKey).registryKey, token, entry),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, window }) {
      const surfaceKey = `github/${ev.owner}/${ev.repo}`;
      if (window && to) {
        try {
          await divertInboundToUnifiedWindow(to, {
            message,
            context: [...context],
            token,
            window,
            surfaceKey,
            auth: auth as unknown as { attributes?: Record<string, unknown> },
          });
        } catch (err) {
          await auditSupervisorFailure(
            { org: deploymentOrg(), platform: "github", workspace: ev.owner, surface: surfaceKey },
            "surface.wake_failed",
            { message: String(err instanceof Error ? err.message : err).slice(0, 500), wakeId: window.wakeId },
          );
          throw err;
        }
        return;
      }
      const unified = githubGrainFor(surfaceKey).unified;
      try {
        await send(
          { message, context: [...context] },
          { auth: auth as unknown, continuationToken: token, state: supervisorSeedState(ev, unified) },
        );
      } catch (err) {
        await healPrunedDeploymentStrand({ token, registryKey: surfaceKey, surfaceKey, workspace: ev.owner, platform: "github", atIso: new Date().toISOString(), err });
        throw err;
      }
    },
  };
}

async function ambientDelivery(body: string, eventType: string, send: GitHubSend, to?: RouteHandlerArgs["to"]): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return;
  }
  const ev = extractGitHubAmbientEvent(eventType, payload);
  if (!ev) return;
  const surfaceKey = `github/${ev.owner}/${ev.repo}`;
  const authorFacts = githubAuthorFacts({ authorAssociation: ev.comment.authorAssociation, actorType: ev.comment.authorType });
  if (await githubExternalSuppressed(surfaceKey, ev.owner, ev.comment.authorLogin, authorFacts)) {
    return;
  }
  const singleWindow = grainUsesUnifiedWindow(githubGrainFor(surfaceKey));
  const vouched = githubRepoVouched(ev.owner, ev.repo);
  const cls = classifyGitHubAmbientComment(ev.comment, BOT_NAME, { treatMentionAsDirect: singleWindow, vouched });
  if (cls.addressing === "drop") {
    slog(`comment on ${surfaceKey}#${ev.issueNumber} dropped: ${cls.reason} (private=${ev.repoPrivate === true}, vouched=${vouched})`);
    return;
  }
  const seamFacts: GitHubSeamFacts = {
    owner: ev.owner,
    repo: ev.repo,
    number: ev.issueNumber,
    isPrivate: ev.repoPrivate,
    actorLogin: ev.comment.authorLogin ?? "unknown",
    isMention: cls.addressing === "direct",
    authorIsBot: false,
    conversationKind: ev.isPullRequest ? "pull_request" : "issue",
  };
  const admission = await githubAmbientLegAdmission(cls.addressing, surfaceKey, seamFacts);
  const seam = admission.seam;
  if (!admission.keep) {
    await auditAmbientSkip({ platform: "github", workspace: ev.owner, surfaceKey, log: slog });
    return;
  }
  if (seam.kind === "hold" && seam.stopped) {
    slog(`comment on ${surfaceKey}#${ev.issueNumber} suppressed: stood down in ${seam.anchor} — @mention to pull the agent back in`);
    return;
  }
  if (seam.kind === "deliver" && admission.engagedFollowUp && !shouldSuppressNativeMention(singleWindow, vouched)) {
    slog(`comment on ${surfaceKey}#${ev.issueNumber} dropped: engaged container ${seam.anchor} — owned by the native githubChannel path`);
    return;
  }
  const directMention = cls.addressing === "direct";
  const mentionPolicy = singleWindowMentionPolicy(singleWindow, directMention, vouched);
  const auth = buildGitHubAuth({
    owner: ev.owner,
    repo: ev.repo,
    repositoryFullName: ev.repositoryFullName,
    repositoryId: ev.repositoryId,
    isPrivate: ev.repoPrivate,
    conversationKind: ev.isPullRequest ? "pull_request" : "issue",
    issueNumber: ev.isPullRequest ? undefined : ev.issueNumber,
    pullRequestNumber: ev.isPullRequest ? ev.issueNumber : undefined,
    installationId: ev.installationId,
    actorLogin: ev.comment.authorLogin ?? "unknown",
    actorId: ev.comment.authorId,
    actorType: ev.comment.authorType,
    authorAssociation: ev.comment.authorAssociation,
  });
  const wakeTrust = resolveWakeTrustFromContext(
    { channel: { kind: "github" }, session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } } },
    { id: ev.comment.authorLogin, isBot: ev.comment.authorType === "Bot" },
    { principalFallback: true },
  );
  await handleGitHubSupervisorDispatch(
    {
      surfaceKey,
      owner: ev.owner,
      repo: ev.repo,
      issueNumber: ev.issueNumber,
      issueTitle: ev.issueTitle,
      auth,
      admit: seatAdmissionFor(surfaceKey),
      ingested: [authorFacts],
      trigger: {
        id: ev.comment.id ?? "unknown",
        authorLogin: ev.comment.authorLogin,
        sentAt: ev.comment.createdAt ?? new Date().toISOString(),
        text: ev.comment.body ?? "(the comment had no text)",
        trust: wakeTrust,
      },
      engagementTier: githubEngagementTier(surfaceKey),
      unified: githubGrainFor(surfaceKey).unified,
      directMention,
      window: singleWindow && vouched
        ? ({
            wakeId: mintWakeId(),
            origin: {
              platform: "github",
              owner: ev.owner,
              repo: ev.repo,
              issueNumber: ev.issueNumber,
              ...(ev.installationId !== undefined ? { installationId: ev.installationId } : {}),
            },
            ...(mentionPolicy.addressing !== undefined ? { addressing: mentionPolicy.addressing } : {}),
            ...spreadVendorTs(vendorInstantEventTime(ev.comment.createdAt)),
          } satisfies UnifiedWindowWake)
        : undefined,
    },
    liveGitHubSupervisorDeps(send, ev, to),
  );
  await appendAudit({
    org: deploymentOrg(),
    platform: "github",
    workspace: ev.owner,
    surface: surfaceKey,
    principalId: ev.comment.authorLogin,
    action: "github.dispatched",
    detail: {
      addressing: githubWakeAddressing(cls.addressing, admission.engagedFollowUp),
      issueNumber: ev.issueNumber,
      repoPrivate: ev.repoPrivate === true,
      vouched,
    },
  });
  slog(`comment on ${surfaceKey}#${ev.issueNumber} → judged wake dispatched`);
}

async function installationDelivery(body: string, eventType: string): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return;
  }
  const ev = extractGitHubInstallationEvent(eventType, payload);
  if (!ev) return;
  await handleGitHubInstallationDelivery(ev, {
    record: (rec) => recordGitHubInstallation(rec),
    forget: (owner) => forgetGitHubInstallation(owner),
    audit: (action, detail, workspace) => appendAudit({ org: deploymentOrg(), platform: "github", workspace, action, detail }),
    log: (m) => ilog(m),
  });
}

const pristine = githubChannel({ botName: BOT_NAME });
type AdapterEventFn = (data: unknown, adapterCtx: unknown) => unknown;
const defaultEvent = (name: string): AdapterEventFn | undefined =>
  (pristine as unknown as { adapter?: Record<string, AdapterEventFn> }).adapter?.[name];

async function auditNativeGitHubSilence(state: GitHubChannelState, reason: string, replied: boolean, sessionId?: string): Promise<void> {
  slog(`native turn judged silence (${reason}) on ${state.owner}/${state.repo}#${state.issueNumber ?? "?"} — nothing commented`);
  await appendAudit({
    org: deploymentOrg(),
    platform: "github",
    workspace: state.owner,
    surface: `github/${state.owner}/${state.repo}`,
    action: "github.no_reply",
    detail: { issueNumber: state.issueNumber ?? null, reason, replied, route: "native", ...(sessionId ? { sessionId } : {}) },
  }).catch(() => undefined);
}

function nativeGitHubAuditPartition(state: GitHubChannelState): ChatAuditPartition | null {
  if (!state.owner || !state.repo) return null;
  try {
    return resolvePartition({
      channel: { kind: "github" },
      session: {
        auth: {
          current: buildGitHubAuth({
            owner: state.owner,
            repo: state.repo,
            actorLogin: "",
            repositoryId: state.repositoryId,
            conversationKind: state.conversationKind,
          }),
        },
      },
    });
  } catch {
    return null;
  }
}

export const githubOnComment = async (ctx: GitHubInboundContext, comment: GitHubComment): Promise<GitHubInboundResult> => {
    const isMention = githubBotMentioned(comment.body, BOT_NAME, comment.author);
    const seamFacts: GitHubSeamFacts = {
      owner: ctx.repository.owner,
      repo: ctx.repository.name,
      number: ctx.conversation.issueNumber ?? ctx.conversation.pullRequestNumber ?? undefined,
      isPrivate: ctx.repository.private,
      actorLogin: comment.author?.login ?? ctx.sender.login,
      isMention,
      authorIsBot: githubMachineAuthored(comment.author?.login ?? ctx.sender.login, comment.author?.type ?? ctx.sender.type, BOT_NAME),
      conversationKind: ctx.conversation.kind,
    };
    if (!isMention && !(await githubEngagedAdmits(seamFacts))) return null;
    const surfaceKey = `github/${ctx.repository.owner}/${ctx.repository.name}`;
    const authorFacts = githubAuthorFacts({
      authorAssociation: str(comment.raw["author_association"]),
      actorType: comment.author?.type ?? ctx.sender.type,
    });
    if (
      await githubExternalSuppressed(
        surfaceKey,
        ctx.repository.owner,
        comment.author?.login ?? ctx.sender.login,
        authorFacts,
        isMention ? (message) => ctx.thread.post(message) : undefined,
      )
    ) {
      return null;
    }
    if (isMention) await markGitHubEngaged(seamFacts, comment.id);
    if (shouldSuppressNativeMention(grainUsesUnifiedWindow(githubGrainFor(surfaceKey)), githubRepoVouched(ctx.repository.owner, ctx.repository.name))) {
      return null;
    }
    const auth = stampNonMemberChatAuth(
      buildGitHubAuth({
        owner: ctx.repository.owner,
        repo: ctx.repository.name,
        repositoryFullName: ctx.repository.fullName,
        repositoryId: ctx.repository.id,
        isPrivate: ctx.repository.private,
        conversationKind: ctx.conversation.kind,
        issueNumber: ctx.conversation.issueNumber ?? undefined,
        pullRequestNumber: ctx.conversation.pullRequestNumber ?? undefined,
        reviewThreadRootCommentId:
          ctx.conversation.kind === "review_thread" ? (num(comment.raw["in_reply_to_id"]) ?? comment.id) : undefined,
        installationId: ctx.github.installationId,
        actorLogin: comment.author?.login ?? ctx.sender.login,
        actorId: comment.author?.id ?? ctx.sender.id,
        actorType: comment.author?.type ?? ctx.sender.type,
        authorAssociation: str(comment.raw["author_association"]),
      }),
      [authorFacts],
      { surfaceKey },
    );

    if ((await ingressSpendGate({
      bindable: { channel: { kind: "github" as const }, session: { auth: { current: auth as unknown as { attributes?: Readonly<Record<string, string>> } } } },
      door: "mention",
      principalId: comment.author?.login ?? ctx.sender.login,
      post: async (text) => { await ctx.thread.post(text); },
    })) === "declined") {
      return null;
    }

    if (isMention) auth.attributes[OE_ADDRESSED_ATTR] = "1";
    return isMention ? { auth } : { auth, context: [ENGAGED_FOLLOW_UP_CONTEXT] };
};

const native: GitHubChannel = githubChannel({
  botName: BOT_NAME,
  turnPolicy: "queue",
  onComment: githubOnComment,
  events: {
    async "turn.started"(data, channel, ctx) {
      if (!isSupervisorGitHubState(channel.state)) {
        await defaultEvent("turn.started")?.(data, channel);
        return;
      }
      const st = channel.state as GitHubSupervisorSessionState;
      const attrs = ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined;
      const anchor = str(attrs?.issue_number) ?? str(attrs?.pull_request_number);
      const n = anchor !== undefined ? Number(anchor) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        st.oeReplyTarget = undefined;
        return;
      }
      if (st.oeUnified === true) {
        const owner = str(attrs?.owner);
        const repo = str(attrs?.repo);
        st.oeReplyTarget = owner && repo ? { issueNumber: n, owner, repo } : undefined;
        return;
      }
      st.oeReplyTarget = { issueNumber: n };
    },
    async "message.completed"(data, channel, ctx) {
      if (!isSupervisorGitHubState(channel.state)) {
        if (data.finishReason === "tool-calls") {
          await defaultEvent("message.completed")?.(data, channel);
          return;
        }
        const nativeTurnId = (ctx as unknown as { session?: { turn?: { id?: string } } })?.session?.turn?.id;
        const nativeAction = finalMessageActionForTurn(data.finishReason, data.message, nativeTurnId);
        const nativeReplied = consumeSupervisorReplyMark(ctx);
        if (nativeAction.kind === "silent") {
          await auditNativeGitHubSilence(channel.state, nativeAction.reason, nativeReplied, ctx?.session?.id);
          return;
        }
        const nativePartition = nativeGitHubAuditPartition(channel.state);
        const nativeAnchor = channel.state.issueNumber ?? channel.state.pullRequestNumber;
        if (
          nativeAction.kind === "post" &&
          channel.state.conversationKind !== "review_thread" &&
          nativePartition !== null &&
          nativeAnchor !== null
        ) {
          await postTerminalProse(
            {
              platform: "github",
              owner: channel.state.owner,
              repo: channel.state.repo,
              issueNumber: nativeAnchor,
              ...(channel.state.installationId !== null ? { installationId: channel.state.installationId } : {}),
            },
            nativeAction.text,
            {
              org: nativePartition.org,
              platform: nativePartition.platform,
              workspace: nativePartition.workspace,
              surface: nativePartition.surface,
              ...(channel.state.triggeringUserLogin ? { principalId: channel.state.triggeringUserLogin } : {}),
              ...(ctx?.session?.id ? { sessionId: ctx.session.id } : {}),
              ...(nativeTurnId ? { turnId: nativeTurnId } : {}),
              route: "terminal",
            },
          );
          return;
        }
        await defaultEvent("message.completed")?.(data, channel);
        return;
      }
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const st = channel.state as GitHubSupervisorSessionState;
      const target = st.oeReplyTarget;
      const org = deploymentOrg();
      const repliedViaTool = consumeSupervisorReplyMark(ctx);
      const postOwner = st.oeUnified === true ? target?.owner : st.owner;
      const postRepo = st.oeUnified === true ? target?.repo : st.repo;
      const auditOwner = (st.oeUnified === true ? target?.owner : undefined) ?? st.owner;
      const auditRepo = (st.oeUnified === true ? target?.repo : undefined) ?? st.repo;
      await completeSupervisorTurn({
        action,
        ...(sessionId ? { sessionId } : {}),
        repliedViaTool,
        midTurnPost: capabilitiesForPlatform("github").midTurnPost,
        noReplyAction: "github.no_reply",
        repliedAction: "github.replied",
        contextRow: { org, platform: "github", workspace: auditOwner, surface: `github/${auditOwner}/${auditRepo}` },
        repliedRow: { org, platform: "github", workspace: postOwner ?? auditOwner, surface: `github/${postOwner ?? auditOwner}/${postRepo ?? auditRepo}` },
        silentAnchor: { issueNumber: target?.issueNumber ?? null },
        droppedAnchor: { issueNumber: target?.issueNumber },
        repliedAnchor: { issueNumber: target?.issueNumber },
        log: (m) => slog(m),
      });
    },
    async "turn.failed"(data, channel) {
      if (!isSupervisorGitHubState(channel.state)) {
        await defaultEvent("turn.failed")?.(data, channel);
        return;
      }
      const st = channel.state as GitHubSupervisorSessionState;
      slog(`supervisor turn failed on ${st.owner}/${st.repo} (audited, no comment posted)`);
      await auditSupervisorFailure(
        { org: deploymentOrg(), platform: "github", workspace: st.owner, surface: `github/${st.owner}/${st.repo}` },
        "github.supervisor_turn_failed",
        {},
      );
    },
    async "session.failed"(data, channel) {
      if (!isSupervisorGitHubState(channel.state)) {
        await defaultEvent("session.failed")?.(data, channel);
        return;
      }
      const st = channel.state as GitHubSupervisorSessionState;
      slog(`supervisor session failed on ${st.owner}/${st.repo} (audited, no comment posted)`);
      await auditSupervisorFailure(
        { org: deploymentOrg(), platform: "github", workspace: st.owner, surface: `github/${st.owner}/${st.repo}` },
        "github.supervisor_session_failed",
        {},
      );
    },
  },
});

type HttpHandler = HttpRouteDefinition<GitHubChannelState>["handler"];
function wrapRoute(inner: HttpHandler): HttpHandler {
  return async (req, args) => {
    const body = await req.text();
    const rejection = gateGithubDelivery(
      process.env.GITHUB_WEBHOOK_SECRET,
      body,
      req.headers.get("x-hub-signature-256"),
      getSettings().webhooks.allowUnverifiedGithub,
    );
    if (rejection) {
      log(`webhook rejected: ${rejection}`);
      return new Response(rejection, { status: 401 });
    }
    const eventType = req.headers.get("x-github-event") ?? "";
    args.waitUntil(fanOutGitHubDelivery(body, eventType, args.to, req.headers.get("x-github-delivery")));
    const stop = parseGitHubStopComment(body, eventType);
    if (stop) {
      args.waitUntil(
        routeGitHubStopComment(stop, { attachSession: args.attachSession }).then(
          (o) => slog(`stop comment on ${stop.owner}/${stop.repo}#${stop.number}: ${o.stopped ? o.outcome : o.reason}`),
          (err) => slog(`stop leg failed: ${String(err)}`),
        ),
      );
    } else {
      args.waitUntil(ambientDelivery(body, eventType, githubSendFrom(args.from), args.to).catch((err) => slog(`ambient leg failed: ${String(err)}`)));
    }
    args.waitUntil(installationDelivery(body, eventType).catch((err) => ilog(`installation leg failed: ${String(err)}`)));
    const pollTarget = parseGitHubReactionPollTarget(body, eventType);
    if (pollTarget) {
      args.waitUntil(
        routeGitHubReactionFeedback(pollTarget, liveGitHubReactionFeedbackDeps(BOT_NAME)).then(
          (outcomes) => {
            if (outcomes.length > 0) slog(`reaction feedback on ${pollTarget.owner}/${pollTarget.repo}#${pollTarget.number}: ${outcomes.length} recorded`);
          },
          (err) => slog(`reaction feedback leg failed: ${String(err)}`),
        ),
      );
    }
    const cloned = new Request(req.url, { method: "POST", headers: req.headers, body });
    return inner(cloned, args);
  };
}

const routes: GitHubChannel["routes"] = native.routes.map((r) =>
  r.transport !== "websocket" && r.method === "POST" && r.path === ROUTE
    ? { ...r, handler: wrapRoute(r.handler) }
    : r,
);

const channel: GitHubChannel = { ...native, routes };

export default channel;
