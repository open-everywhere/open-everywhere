import { slackForm } from "./slack-events.js";
import { callLinearGraphQL } from "eve/channels/linear";
import { parsePrivateKey, signAppJwt, mintInstallationToken } from "../scm/mint.js";
import { loadGitHubAppConfig } from "../scm/config.js";
import { createCommentReply } from "./notion-api.js";
import { discordPostMessage, splitForDiscord } from "./discord-post.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";

type SlackOrigin = Extract<UnifiedWakeOrigin, { platform: "slack" }>;
type GitHubOrigin = Extract<UnifiedWakeOrigin, { platform: "github" }>;
type LinearOrigin = Extract<UnifiedWakeOrigin, { platform: "linear" }>;
type NotionOrigin = Extract<UnifiedWakeOrigin, { platform: "notion" }>;
type DiscordOrigin = Extract<UnifiedWakeOrigin, { platform: "discord" }>;

export interface UnifiedReplyDeps {
  readonly postSlack?: (origin: SlackOrigin, text: string) => Promise<string>;
  readonly postGitHub?: (origin: GitHubOrigin, text: string) => Promise<string>;
  readonly postLinear?: (origin: LinearOrigin, text: string) => Promise<string>;
  readonly postNotion?: (origin: NotionOrigin, text: string) => Promise<string>;
  readonly postDiscord?: (origin: DiscordOrigin, text: string) => Promise<string>;
}

export async function postUnifiedReply(origin: UnifiedWakeOrigin, text: string, deps: UnifiedReplyDeps = {}): Promise<string> {
  if (origin.platform === "slack") {
    return (deps.postSlack ?? liveSlackPost)(origin, text);
  }
  if (origin.platform === "linear") {
    return (deps.postLinear ?? liveLinearPost)(origin, text);
  }
  if (origin.platform === "notion") {
    return (deps.postNotion ?? liveNotionPost)(origin, text);
  }
  if (origin.platform === "discord") {
    return (deps.postDiscord ?? liveDiscordPost)(origin, text);
  }
  return (deps.postGitHub ?? liveGitHubPost)(origin, text);
}

async function liveDiscordPost(origin: DiscordOrigin, text: string): Promise<string> {
  let first: string | undefined;
  try {
    for (const chunk of splitForDiscord(text)) {
      if (!chunk.trim()) continue;
      const id = await discordPostMessage(origin.channelId, chunk, first === undefined && origin.messageId ? { replyToMessageId: origin.messageId } : undefined);
      first ??= id;
    }
  } catch {
    throw new Error(`unified reply couldn't post to Discord — create-message failed on channel ${origin.channelId}`);
  }
  if (first === undefined) {
    throw new Error(`unified reply couldn't post to Discord — nothing to post (empty reply) for channel ${origin.channelId}`);
  }
  return first;
}

async function liveNotionPost(origin: NotionOrigin, text: string): Promise<string> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error(`unified reply couldn't post to Notion — NOTION_API_KEY is not set (discussion ${origin.discussionId})`);
  }
  let id: string;
  try {
    id = await createCommentReply({ discussionId: origin.discussionId, text, apiKey });
  } catch {
    throw new Error(`unified reply couldn't post to Notion — createCommentReply failed on discussion ${origin.discussionId}`);
  }
  return id || "unknown";
}

async function liveLinearPost(origin: LinearOrigin, text: string): Promise<string> {
  let data: { commentCreate?: { success?: boolean; comment?: { id?: string } } };
  try {
    data = await callLinearGraphQL<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>({
      query: "mutation OeUnifiedReply($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      queryName: "OeUnifiedReply",
      variables: { input: { issueId: origin.issueId, ...(origin.parentId ? { parentId: origin.parentId } : {}), body: text } },
    });
  } catch {
    throw new Error(`unified reply couldn't post to Linear — commentCreate failed on issue ${origin.issueId}`);
  }
  if (data.commentCreate?.success !== true) {
    throw new Error(`unified reply couldn't post to Linear — commentCreate returned no success on issue ${origin.issueId}`);
  }
  return data.commentCreate.comment?.id ?? "unknown";
}

async function liveSlackPost(origin: SlackOrigin, text: string): Promise<string> {
  const body = new URLSearchParams({ channel: origin.channelId, text });
  if (origin.threadTs) body.set("thread_ts", origin.threadTs);
  const res = await slackForm("chat.postMessage", body.toString());
  const ts = typeof res?.ts === "string" ? res.ts : undefined;
  if (res?.ok !== true || !ts) {
    throw new Error(`unified reply couldn't post to Slack — ${(res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  return ts;
}

const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

function githubAppCreds(): { appId: string; privateKeyPem: string; installations: Record<string, string> } | null {
  const scm = loadGitHubAppConfig();
  if (scm) return { appId: scm.clientId ?? scm.appId, privateKeyPem: scm.privateKeyPem, installations: scm.installations };
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKeyPem) return null;
  return { appId, privateKeyPem, installations: {} };
}

async function installationTokenFor(origin: GitHubOrigin): Promise<string> {
  const creds = githubAppCreds();
  if (!creds) {
    throw new Error("unified reply couldn't post to GitHub — no App credentials (set OE_GITHUB_APP_* or GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY).");
  }
  const installationId = origin.installationId !== undefined ? String(origin.installationId) : creds.installations[origin.owner];
  if (!installationId) {
    throw new Error(`unified reply couldn't post to GitHub — no installation id for owner "${origin.owner}" (the wake carried none and OE_GITHUB_INSTALLATIONS has no entry).`);
  }
  const cacheKey = `${installationId} ${origin.repo}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - 5 * 60_000 > Date.now()) return cached.token;
  const jwt = await signAppJwt(parsePrivateKey(creds.privateKeyPem), creds.appId, Math.floor(Date.now() / 1000));
  const minted = await mintInstallationToken({ jwt, installationId, repoNames: [origin.repo], permissions: { issues: "write" } });
  tokenCache.set(cacheKey, { token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) });
  return minted.token;
}

async function liveGitHubPost(origin: GitHubOrigin, text: string): Promise<string> {
  const token = await installationTokenFor(origin);
  const res = await fetch(`https://api.github.com/repos/${origin.owner}/${origin.repo}/issues/${origin.issueNumber}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: text }),
  });
  if (!res.ok) {
    throw new Error(`unified reply couldn't post to GitHub — ${res.status} on ${origin.owner}/${origin.repo}#${origin.issueNumber}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: number };
  return json.id !== undefined ? String(json.id) : "unknown";
}
