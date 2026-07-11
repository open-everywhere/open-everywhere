import type { HttpRouteDefinition, RouteHandlerArgs, SendFn } from "eve/channels";
import { githubChannel, type GitHubChannel, type GitHubChannelState } from "eve/channels/github";
import slack from "./slack.js";
import { buildGitHubAuth, githubBotMentioned } from "./github-identity.js";
import {
  classifyGitHubAmbientComment,
  extractGitHubAmbientEvent,
  githubSupervisorToken,
  handleGitHubSupervisorDispatch,
  shouldRotate,
  type GitHubAmbientEvent,
  type GitHubSupervisorDeps,
} from "./github-supervisor.js";
import { supervisorGrainFor, supervisorTokenForGrain, type SupervisorGrain } from "./unified-supervisor.js";
import { mintWakeId, type UnifiedWindowWake } from "./unified-window.js";
import { divertToUnifiedWindow } from "./unified.js";
import { finalMessageActionForTurn, supervisorTextDelivery } from "./slack-events.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { resolveWakeTrustFromContext } from "../identity/wake-trust.js";
import { getConfig } from "../access/config.js";
import { ambientSupervisorEnabled, engagementTierFor, type EngagementTier } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { postOnce, outboundKey } from "../operational/post-once.js";
import { listAllRoutines } from "../routines/store.js";
import { matchesEvent, normalizeGithubEvent, eventPrompt, gateGithubDelivery, type NormalizedEvent } from "../routines/events.js";
import { ROUTINE_MARKER } from "../routines/routine.js";

const ROUTE = "/eve/v1/github";
const BOT_NAME = process.env.GITHUB_APP_SLUG;

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

function slog(msg: string): void {
  console.log(`[open-everywhere:github-supervisor] ${msg}`);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function fanOut(ev: NormalizedEvent, receive: RouteHandlerArgs["receive"]): Promise<void> {
  const matches = (await listAllRoutines()).filter((r) => r.status === "active" && matchesEvent(r, ev));
  let fired = 0;
  for (const r of matches) {
    const platform = r.surfaceKey.split("/")[0];
    const channelId = r.target?.["channelId"];
    if (platform !== "slack" || typeof channelId !== "string") {
      log(`event ${ev.summary} matched ${r.id} but its surface has no wired channel — skipped`);
      continue;
    }
    const auth = {
      authenticator: "github",
      principalType: "service",
      principalId: "github:webhook",
      attributes: { [ROUTINE_MARKER.id]: r.id, [ROUTINE_MARKER.surface]: r.surfaceKey, [ROUTINE_MARKER.org]: r.org },
    };
    await receive(slack, { message: eventPrompt(r, ev), target: { channelId }, auth });
    fired++;
  }
  if (matches.length > 0) log(`event "${ev.summary}": ${matches.length} matched -> ${fired} fired`);
}

async function fanOutDelivery(body: string, eventType: string, receive: RouteHandlerArgs["receive"]): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return;
  }
  const ev = normalizeGithubEvent(eventType, payload);
  if (ev) await fanOut(ev, receive);
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

export function shouldSuppressNativeMention(singleWindow: boolean, isPrivate: boolean | undefined): boolean {
  return singleWindow && isPrivate === true;
}

function liveGitHubSupervisorDeps(send: SendFn<GitHubChannelState>, ev: GitHubAmbientEvent, receive?: RouteHandlerArgs["receive"]): GitHubSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, owner, repo, atIso) {
      const grain = githubGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, 1, () => githubSupervisorToken(owner, repo, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      if (shouldRotate(existing, atIso)) {
        const gen = existing.generation + 1;
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => githubSupervisorToken(owner, repo, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      return { token: existing.token, generation: existing.generation, freshGeneration: existing.firstWakeAt == null, handoffNote: existing.handoffNote };
    },
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, githubGrainFor(surfaceKey).registryKey, atIso),
    async forceRotate(surfaceKey, owner, repo, atIso) {
      const grain = githubGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      const gen = (existing?.generation ?? 0) + 1;
      const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => githubSupervisorToken(owner, repo, gen)), atIso);
      return { token: row.token, generation: row.generation, handoffNote: row.handoffNote };
    },
    audit: (action, detail) =>
      appendAudit({ org, platform: "github", workspace: ev.owner, surface: typeof detail.surfaceKey === "string" ? detail.surfaceKey : undefined, action, detail }),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, window }) {
      if (window && receive) {
        await divertToUnifiedWindow(receive, {
          message,
          context: [...context],
          token,
          window,
          surfaceKey: `github/${ev.owner}/${ev.repo}`,
          auth: auth as unknown as { attributes?: Record<string, unknown> },
        });
        return;
      }
      const unified = githubGrainFor(`github/${ev.owner}/${ev.repo}`).unified;
      await send(
        { message, context: [...context] },
        { auth: auth as unknown as Parameters<SendFn<GitHubChannelState>>[1]["auth"], continuationToken: token, state: supervisorSeedState(ev, unified) },
      );
    },
  };
}

async function ambientDelivery(body: string, eventType: string, send: SendFn<GitHubChannelState>, receive?: RouteHandlerArgs["receive"]): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return;
  }
  const ev = extractGitHubAmbientEvent(eventType, payload);
  if (!ev) return;
  const surfaceKey = `github/${ev.owner}/${ev.repo}`;
  if (!githubAmbientEnabled(surfaceKey)) return;
  const singleWindow = githubGrainFor(surfaceKey).singleWindow === true;
  const cls = classifyGitHubAmbientComment(ev.comment, BOT_NAME, { treatMentionAsDirect: singleWindow });
  if (cls.addressing === "drop") {
    slog(`comment on ${surfaceKey}#${ev.issueNumber} dropped: ${cls.reason}`);
    return;
  }
  const directMention = cls.addressing === "direct";
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
      window: singleWindow
        ? ({
            wakeId: mintWakeId(),
            origin: {
              platform: "github",
              owner: ev.owner,
              repo: ev.repo,
              issueNumber: ev.issueNumber,
              ...(ev.installationId !== undefined ? { installationId: ev.installationId } : {}),
            },
          } satisfies UnifiedWindowWake)
        : undefined,
    },
    liveGitHubSupervisorDeps(send, ev, receive),
  );
  await appendAudit({
    org: deploymentOrg(),
    platform: "github",
    workspace: ev.owner,
    surface: surfaceKey,
    principalId: ev.comment.authorLogin,
    action: "github.dispatched",
    detail: { addressing: cls.addressing, issueNumber: ev.issueNumber },
  });
  slog(`comment on ${surfaceKey}#${ev.issueNumber} → judged wake dispatched`);
}

const pristine = githubChannel({ botName: BOT_NAME });
type AdapterEventFn = (data: unknown, adapterCtx: unknown) => unknown;
const defaultEvent = (name: string): AdapterEventFn | undefined =>
  (pristine as unknown as { adapter?: Record<string, AdapterEventFn> }).adapter?.[name];

const native: GitHubChannel = githubChannel({
  botName: BOT_NAME,
  onComment: (ctx, comment) => {
    if (!githubBotMentioned(comment.body, BOT_NAME, comment.author)) return null;
    const surfaceKey = `github/${ctx.repository.owner}/${ctx.repository.name}`;
    if (shouldSuppressNativeMention(githubGrainFor(surfaceKey).singleWindow === true, ctx.repository.private)) {
      return null;
    }
    const auth = buildGitHubAuth({
      owner: ctx.repository.owner,
      repo: ctx.repository.name,
      repositoryFullName: ctx.repository.fullName,
      repositoryId: ctx.repository.id,
      isPrivate: ctx.repository.private,
      conversationKind: ctx.conversation.kind,
      issueNumber: ctx.conversation.issueNumber ?? undefined,
      pullRequestNumber: ctx.conversation.pullRequestNumber ?? undefined,
      installationId: ctx.github.installationId,
      actorLogin: comment.author?.login ?? ctx.sender.login,
      actorId: comment.author?.id ?? ctx.sender.id,
      actorType: comment.author?.type ?? ctx.sender.type,
      authorAssociation: str(comment.raw["author_association"]),
    });
    return { auth };
  },
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
    async "message.completed"(data, channel) {
      if (!isSupervisorGitHubState(channel.state)) {
        await defaultEvent("message.completed")?.(data, channel);
        return;
      }
      const st = channel.state as GitHubSupervisorSessionState;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const target = st.oeReplyTarget;
      const org = deploymentOrg();
      const postOwner = st.oeUnified === true ? target?.owner : st.owner;
      const postRepo = st.oeUnified === true ? target?.repo : st.repo;
      const auditOwner = (st.oeUnified === true ? target?.owner : undefined) ?? st.owner;
      const auditRepo = (st.oeUnified === true ? target?.repo : undefined) ?? st.repo;
      if (action.kind === "silent") {
        await appendAudit({
          org,
          platform: "github",
          workspace: auditOwner,
          surface: `github/${auditOwner}/${auditRepo}`,
          action: "github.no_reply",
          detail: { issueNumber: target?.issueNumber ?? null, reason: action.reason },
        });
        return;
      }
      if (!target || !postOwner || !postRepo) {
        slog(`reply not posted — no per-turn ${!target ? "issue" : "repo"} target (turn.started snapshot empty); FAIL SAFE`);
        return;
      }
      const delivery = supervisorTextDelivery(true, capabilitiesForPlatform("github").midTurnPost);
      if (!delivery.postText) {
        slog(`supervisor message-tool-only: DROPPED terminal prose (reply must come from the reply tool) — nothing posted (${postOwner}/${postRepo}#${target.issueNumber})`);
        await appendAudit({
          org,
          platform: "github",
          workspace: auditOwner,
          surface: `github/${auditOwner}/${auditRepo}`,
          action: "turn.supervisor_prose_dropped",
          detail: { issueNumber: target.issueNumber, chars: action.text.length },
        }).catch(() => undefined);
        return;
      }
      try {
        await postOnce({
          org,
          key: outboundKey({
            surface: "github",
            channel: `${postOwner}/${postRepo}`,
            threadTs: `#${target.issueNumber}`,
            action: "github.supervisor-reply",
            payload: action.text,
          }),
          run: () =>
            channel.github.request({
              method: "POST",
              path: `/repos/${postOwner}/${postRepo}/issues/${target.issueNumber}/comments`,
              body: { body: action.text },
            }),
        });
        await appendAudit({
          org,
          platform: "github",
          workspace: postOwner,
          surface: `github/${postOwner}/${postRepo}`,
          action: "github.replied",
          detail: { issueNumber: target.issueNumber, chars: action.text.length },
        });
      } catch (err) {
        slog(`reply delivery failed: ${String(err)}`);
      }
    },
    async "turn.failed"(data, channel) {
      if (!isSupervisorGitHubState(channel.state)) {
        await defaultEvent("turn.failed")?.(data, channel);
        return;
      }
      const st = channel.state as GitHubSupervisorSessionState;
      slog(`supervisor turn failed on ${st.owner}/${st.repo} (audited, no comment posted)`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "github",
        workspace: st.owner,
        surface: `github/${st.owner}/${st.repo}`,
        action: "github.supervisor_turn_failed",
        detail: {},
      }).catch(() => undefined);
    },
    async "session.failed"(data, channel) {
      if (!isSupervisorGitHubState(channel.state)) {
        await defaultEvent("session.failed")?.(data, channel);
        return;
      }
      const st = channel.state as GitHubSupervisorSessionState;
      slog(`supervisor session failed on ${st.owner}/${st.repo} (audited, no comment posted; next wake force-rotates)`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "github",
        workspace: st.owner,
        surface: `github/${st.owner}/${st.repo}`,
        action: "github.supervisor_session_failed",
        detail: {},
      }).catch(() => undefined);
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
      process.env.OE_ALLOW_UNVERIFIED_GITHUB_WEBHOOK === "1",
    );
    if (rejection) {
      log(`webhook rejected: ${rejection}`);
      return new Response(rejection, { status: 401 });
    }
    const eventType = req.headers.get("x-github-event") ?? "";
    args.waitUntil(fanOutDelivery(body, eventType, args.receive));
    args.waitUntil(ambientDelivery(body, eventType, args.send, args.receive).catch((err) => slog(`ambient leg failed: ${String(err)}`)));
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
