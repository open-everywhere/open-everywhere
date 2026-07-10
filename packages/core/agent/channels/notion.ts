import { defineChannel, POST } from "eve/channels";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { finalMessageActionForTurn } from "./slack-events.js";
import { createCommentReply, retrieveBotUser } from "./notion-api.js";
import { handleNotionDelivery, type NotionDispatchArgs } from "./notion-webhook.js";

const ROUTE = "/eve/v1/notion";

function log(msg: string): void {
  console.log(`[open-everywhere:notion] ${msg}`);
}

function notionApiKey(): string | undefined {
  const k = process.env.NOTION_API_KEY;
  return k && k.length > 0 ? k : undefined;
}

let botUserCache: Promise<string | undefined> | undefined;
function resolveBotUserId(apiKey: string): () => Promise<string | undefined> {
  return () => {
    const override = process.env.NOTION_BOT_USER_ID;
    if (override && override.length > 0) return Promise.resolve(override);
    if (!botUserCache) {
      botUserCache = retrieveBotUser({ apiKey })
        .then((u) => u.id)
        .catch((err) => {
          log(`could not resolve bot user id (GET /v1/users/me failed): ${String(err)}`);
          return undefined;
        });
    }
    return botUserCache;
  };
}

export function _resetNotionBotUserCache(): void {
  botUserCache = undefined;
}

interface NotionState {
  discussionId: string | null;
  pageId: string | null;
  workspaceId: string | null;
}

export default defineChannel<NotionState, { state: NotionState }>({
  kindHint: "notion",
  state: { discussionId: null, pageId: null, workspaceId: null },
  context(state) {
    return { state };
  },
  routes: [
    POST(ROUTE, async (req, { send, waitUntil }) => {
      const rawBody = await req.text();
      const signature = req.headers.get("x-notion-signature");
      const apiKey = notionApiKey();

      const dispatch = async (args: NotionDispatchArgs): Promise<void> => {
        await send(
          { message: args.message, context: [...args.context] },
          {
            auth: args.auth,
            continuationToken: args.continuationToken,
            state: { discussionId: args.state.discussionId, pageId: args.state.pageId, workspaceId: args.state.workspaceId },
          },
        );
        const a = args.auth.attributes;
        await appendAudit({
          org: deploymentOrg(),
          platform: "notion",
          workspace: a.workspace_id ?? "unknown",
          surface: a.page_id ?? args.state.discussionId ?? "unknown",
          principalId: args.auth.principalId || undefined,
          action: "notion.dispatched",
          detail: { commentId: a.comment_id, discussionId: args.state.discussionId },
        });
      };

      const outcome = await handleNotionDelivery(rawBody, signature, {
        secret: process.env.NOTION_WEBHOOK_SECRET,
        allowUnverified: process.env.OE_ALLOW_UNVERIFIED_NOTION_WEBHOOK === "1",
        apiKey,
        resolveBotUserId: resolveBotUserId(apiKey ?? ""),
        dispatch,
      });

      if (outcome.action === "handshake") {
        log(
          `subscription handshake received — verification_token (set NOTION_WEBHOOK_SECRET to this AND paste it into Notion's verify form): ${handshakeToken(rawBody)}`,
        );
      } else if (outcome.action === "dispatched") {
        log(`comment.created → dispatched`);
      } else if (outcome.action === "rejected") {
        log(`delivery rejected (${outcome.status}): ${outcome.detail}`);
        waitUntil(
          appendAudit({
            org: deploymentOrg(),
            platform: "notion",
            workspace: "unknown",
            action: "notion.rejected",
            detail: { status: outcome.status, reason: outcome.detail },
          }),
        );
      } else {
        log(`delivery ${outcome.action}${outcome.detail ? ` (${outcome.detail})` : ""}`);
      }

      return new Response(outcome.body, { status: outcome.status });
    }),
  ],
  events: {
    async "message.completed"(data, channel) {
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind !== "post") return;
      const message = action.text;
      const discussionId = channel.state.discussionId;
      const apiKey = notionApiKey();
      if (!discussionId || !apiKey) {
        log(`reply not posted — ${!apiKey ? "NOTION_API_KEY unset" : "no discussion_id on session state"}`);
        return;
      }
      try {
        await createCommentReply({ discussionId, text: message, apiKey });
        await appendAudit({
          org: deploymentOrg(),
          platform: "notion",
          workspace: channel.state.workspaceId ?? "unknown",
          surface: channel.state.pageId ?? discussionId,
          action: "notion.replied",
          detail: { discussionId, chars: message.length },
        });
      } catch (err) {
        log(`reply delivery failed: ${String(err)}`);
      }
    },
  },
});

function handshakeToken(rawBody: string): string {
  try {
    const t = (JSON.parse(rawBody) as { verification_token?: unknown }).verification_token;
    return typeof t === "string" ? t : "(unparseable)";
  } catch {
    return "(unparseable)";
  }
}
