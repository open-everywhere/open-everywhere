import type { HttpRouteDefinition, RouteHandlerArgs } from "eve/channels";
import { githubChannel, type GitHubChannel, type GitHubChannelState } from "eve/channels/github";
import slack from "./slack.js";
import { buildGitHubAuth, githubBotMentioned } from "./github-identity.js";
import { listAllRoutines } from "../routines/store.js";
import { matchesEvent, normalizeGithubEvent, eventPrompt, gateGithubDelivery, type NormalizedEvent } from "../routines/events.js";
import { ROUTINE_MARKER } from "../routines/routine.js";

const ROUTE = "/eve/v1/github";
const BOT_NAME = process.env.GITHUB_APP_SLUG;

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
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
    args.waitUntil(fanOutDelivery(body, req.headers.get("x-github-event") ?? "", args.receive));
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
