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
import { finalMessageActionForTurn } from "./slack-events.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
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
  oeReplyTarget?: { issueNumber: number };
};

function isSupervisorGitHubState(state: unknown): state is GitHubSupervisorSessionState {
  return (state as Record<string, unknown> | undefined)?.["oeSupervisor"] === true;
}

function supervisorSeedState(ev: GitHubAmbientEvent): GitHubSupervisorSessionState {
  return {
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

function liveGitHubSupervisorDeps(send: SendFn<GitHubChannelState>, ev: GitHubAmbientEvent): GitHubSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, owner, repo, atIso) {
      const existing = await store.getChannelSession(org, surfaceKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, surfaceKey, githubSupervisorToken(owner, repo, 1), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      if (shouldRotate(existing, atIso)) {
        const row = await store.rotateChannelSession(org, surfaceKey, githubSupervisorToken(owner, repo, existing.generation + 1), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      return { token: existing.token, generation: existing.generation, freshGeneration: existing.firstWakeAt == null, handoffNote: existing.handoffNote };
    },
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, surfaceKey, atIso),
    async forceRotate(surfaceKey, owner, repo, atIso) {
      const existing = await store.getChannelSession(org, surfaceKey);
      const row = await store.rotateChannelSession(org, surfaceKey, githubSupervisorToken(owner, repo, (existing?.generation ?? 0) + 1), atIso);
      return { token: row.token, generation: row.generation, handoffNote: row.handoffNote };
    },
    audit: (action, detail) =>
      appendAudit({ org, platform: "github", workspace: ev.owner, surface: typeof detail.surfaceKey === "string" ? detail.surfaceKey : undefined, action, detail }),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context }) {
      await send(
        { message, context: [...context] },
        { auth: auth as unknown as Parameters<SendFn<GitHubChannelState>>[1]["auth"], continuationToken: token, state: supervisorSeedState(ev) },
      );
    },
  };
}

async function ambientDelivery(body: string, eventType: string, send: SendFn<GitHubChannelState>): Promise<void> {
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
  const cls = classifyGitHubAmbientComment(ev.comment, BOT_NAME);
  if (cls.addressing === "drop") {
    slog(`comment on ${surfaceKey}#${ev.issueNumber} dropped: ${cls.reason}`);
    return;
  }
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
      },
      engagementTier: githubEngagementTier(surfaceKey),
    },
    liveGitHubSupervisorDeps(send, ev),
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
      st.oeReplyTarget = Number.isFinite(n) && n > 0 ? { issueNumber: n } : undefined;
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
      if (action.kind === "silent") {
        await appendAudit({
          org,
          platform: "github",
          workspace: st.owner,
          surface: `github/${st.owner}/${st.repo}`,
          action: "github.no_reply",
          detail: { issueNumber: target?.issueNumber ?? null, reason: action.reason },
        });
        return;
      }
      if (!target) {
        slog(`reply not posted — no per-turn issue target (turn.started snapshot empty); FAIL SAFE`);
        return;
      }
      try {
        await postOnce({
          org,
          key: outboundKey({
            surface: "github",
            channel: `${st.owner}/${st.repo}`,
            threadTs: `#${target.issueNumber}`,
            action: "github.supervisor-reply",
            payload: action.text,
          }),
          run: () =>
            channel.github.request({
              method: "POST",
              path: `/repos/${st.owner}/${st.repo}/issues/${target.issueNumber}/comments`,
              body: { body: action.text },
            }),
        });
        await appendAudit({
          org,
          platform: "github",
          workspace: st.owner,
          surface: `github/${st.owner}/${st.repo}`,
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
    args.waitUntil(ambientDelivery(body, eventType, args.send).catch((err) => slog(`ambient leg failed: ${String(err)}`)));
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
