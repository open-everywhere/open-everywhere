import { friendlyPlainText, type BindableContext, type RequesterVerdict } from "@open-everywhere/core/agent/adapter-api.js";
import { callSlackRead } from "./slack-read.js";
import { ACTION_TOKEN_ATTRIBUTE } from "./slack-identity.js";

export const SLACK_PUBLIC_SEARCH_TOOL = "search_slack_public";

export const SLACK_PUBLIC_SEARCH_MAX = 20;

export type SlackSearchCall = (operation: string, params: Record<string, string | number | boolean>) => Promise<{ readonly ok: boolean; readonly [key: string]: unknown }>;

export interface SlackPublicSearchHit {
  readonly channel: string;
  readonly author: string;
  readonly ts: string;
  readonly permalink?: string;
  readonly text: string;
}

export type SlackPublicSearchRefusal =
  | "no-action-token"
  | "requester-mismatch"
  | "requester-unverified"
  | "token-rejected"
  | "missing-scope"
  | "not-available"
  | "error";

export class SlackPublicSearchRefusedError extends Error {
  constructor(
    readonly reason: SlackPublicSearchRefusal,
    message: string,
    readonly requester?: string,
  ) {
    super(message);
    this.name = "SlackPublicSearchRefusedError";
  }
}

const REFUSAL_TEXT: Readonly<Record<SlackPublicSearchRefusal, string>> = {
  "no-action-token":
    "Public-channel search needs the action token Slack attaches to a message that @mentions this app (or a DM to it). " +
    "This turn has none: a routine, a webhook or a message that did not address the app carries no token. " +
    "Tell the person to @mention you with the question, and the search can run on that message.",
  "requester-mismatch":
    "The Slack action token on this turn belongs to a different person's message, so it cannot search for the person who asked. " +
    "Ask them to @mention you with the question themselves.",
  "requester-unverified":
    "This turn cannot say which one person asked, so the search cannot pick whose Slack access to search with. " +
    "Ask the person to @mention you with the question on its own.",
  "token-rejected":
    "Slack refused the action token from the message (it is invalid or has expired; Slack issues one per message and it does not last). " +
    "Ask the person to @mention you again with the question, and search on that new message.",
  "missing-scope":
    "The Slack app lacks the search:read.public scope. An admin must paste the current app manifest into the Slack app and reinstall it; until then public-channel search cannot run.",
  "not-available":
    "Slack's search is not available for this workspace or this person right now (Slack said so). Say that the search could not run.",
  error: "The search failed before it could return results. Say that the search could not run.",
};

const TOKEN_REJECTED = new Set(["invalid_action_token", "token_expired", "token_revoked", "invalid_auth", "not_allowed_token_type"]);

const SCOPE_MISSING = new Set(["missing_scope", "no_permission"]);

function authAttr(ctx: BindableContext, key: string): string | undefined {
  const session = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null; initiator?: { attributes?: Record<string, unknown> } | null } } }).session;
  const attrs = session?.auth?.current?.attributes ?? session?.auth?.initiator?.attributes;
  const raw = attrs?.[key];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function slackSearchCredentialFor(
  ctx: BindableContext,
  asker: RequesterVerdict,
  manyAskers: boolean,
): { readonly token: string; readonly userId: string } | SlackPublicSearchRefusedError {
  const token = authAttr(ctx, ACTION_TOKEN_ATTRIBUTE);
  const userId = authAttr(ctx, "user_id");
  if (token === undefined || userId === undefined) return refusal("no-action-token", userId);
  if (asker.kind === "unverified") return refusal("requester-unverified");
  if (asker.kind === "requester" && asker.principalId !== userId) return refusal("requester-mismatch", asker.principalId);
  if (asker.kind === "none" && manyAskers) return refusal("requester-unverified");
  return { token, userId };
}

function refusal(reason: SlackPublicSearchRefusal, requester?: string): SlackPublicSearchRefusedError {
  return new SlackPublicSearchRefusedError(reason, REFUSAL_TEXT[reason], requester);
}

function refusalForSlackError(err: unknown, requester?: string): SlackPublicSearchRefusedError | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const code = /assistant\.search\.context failed: (\S+)/u.exec(message)?.[1];
  if (code === undefined) return undefined;
  if (TOKEN_REJECTED.has(code)) return refusal("token-rejected", requester);
  if (SCOPE_MISSING.has(code)) return refusal("missing-scope", requester);
  return refusal("not-available", requester);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface SlackPublicSearchAuthor {
  readonly authorId?: string;
  readonly bot?: boolean;
}

async function renderSlackSearchHits(raw: unknown): Promise<{ readonly hits: SlackPublicSearchHit[]; readonly authors: SlackPublicSearchAuthor[] }> {
  const results = (raw as { results?: { messages?: unknown } } | undefined)?.results;
  const messages = Array.isArray(results?.messages) ? (results.messages as Array<Record<string, unknown>>) : [];
  const hits: SlackPublicSearchHit[] = [];
  const authors: SlackPublicSearchAuthor[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const content = str(m.content) ?? str(m.text) ?? "";
    if (content.length === 0) continue;
    const channelName = str(m.channel_name);
    const authorName = str(m.author_name);
    const bot = m.is_author_bot === true || m.is_bot === true;
    hits.push({
      channel: channelName ? `#${channelName.replace(/^#/u, "")}` : "a public channel",
      author: authorName ?? (bot ? "an app" : "a member"),
      ts: str(m.message_ts) ?? str(m.ts) ?? "",
      ...(str(m.permalink) ? { permalink: str(m.permalink) } : {}),
      text: await friendlyPlainText(content, "slack"),
    });
    const authorId = str(m.author_user_id) ?? str(m.user_id);
    authors.push(bot ? { bot: true } : authorId !== undefined ? { authorId } : {});
  }
  return { hits, authors };
}

export function slackSearchParams(query: string, actionToken: string, limit: number): Record<string, string | number | boolean> {
  return {
    query,
    action_token: actionToken,
    channel_types: "public_channel",
    content_types: "messages",
    limit: Math.min(Math.max(1, Math.trunc(limit)), SLACK_PUBLIC_SEARCH_MAX),
  };
}

export async function runSlackPublicSearch(
  ctx: BindableContext,
  query: string,
  limit: number,
  asker: { readonly verdict: RequesterVerdict; readonly manyAskers: boolean },
  call: SlackSearchCall = callSlackRead,
): Promise<{ readonly requester: string; readonly hits: SlackPublicSearchHit[]; readonly authors: SlackPublicSearchAuthor[] }> {
  const cred = slackSearchCredentialFor(ctx, asker.verdict, asker.manyAskers);
  if (cred instanceof SlackPublicSearchRefusedError) throw cred;
  let res: unknown;
  try {
    res = await call("assistant.search.context", slackSearchParams(query, cred.token, limit));
  } catch (err) {
    const mapped = refusalForSlackError(err, cred.userId);
    if (mapped) throw mapped;
    throw err;
  }
  return { requester: cred.userId, ...(await renderSlackSearchHits(res)) };
}
