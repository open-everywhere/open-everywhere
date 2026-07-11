import { defineChannel, POST } from "eve/channels";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { finalMessageActionForTurn, supervisorTextDelivery, isSupervisorProseLeak } from "./slack-events.js";
import { getConfig } from "../access/config.js";
import { ambientSupervisorEnabled, engagementTierFor } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { consumeRepliedThisTurn } from "./reply-signal.js";
import { createCommentReply, retrieveBotUser } from "./notion-api.js";
import { handleNotionDelivery, type NotionReplyTarget, type NotionSessionState } from "./notion-webhook.js";
import {
  handleNotionSupervisorDispatch,
  notionSupervisorToken,
  shouldRotate,
  type NotionSupervisorDeps,
  type NotionSupervisorDispatch,
} from "./notion-supervisor.js";
import { supervisorGrainFor, supervisorTokenForGrain, type SupervisorGrain } from "./unified-supervisor.js";

const ROUTE = "/eve/v1/notion";

function log(msg: string): void {
  console.log(`[open-everywhere:notion] ${msg}`);
}

function notionApiKey(): string | undefined {
  const k = process.env.NOTION_API_KEY;
  return k && k.length > 0 ? k : undefined;
}

let botUserCache: Promise<{ id?: string; name?: string }> | undefined;
function resolveBotUser(apiKey: string): () => Promise<{ id?: string; name?: string }> {
  return () => {
    if (!botUserCache) {
      const overrideId = process.env.NOTION_BOT_USER_ID;
      const overrideName = process.env.NOTION_BOT_NAME;
      const named = (u: { id?: string; name?: string }) => ({ id: u.id, name: overrideName && overrideName.length > 0 ? overrideName : u.name });
      botUserCache =
        overrideId && overrideId.length > 0
          ? Promise.resolve(named({ id: overrideId }))
          : retrieveBotUser({ apiKey })
              .then(named)
              .catch((err) => {
                log(`could not resolve bot user (GET /v1/users/me failed): ${String(err)}`);
                return {};
              });
    }
    return botUserCache;
  };
}

export function _resetNotionBotUserCache(): void {
  botUserCache = undefined;
}

function notionAmbientEnabled(surfaceKey: string): boolean {
  try {
    return ambientSupervisorEnabled(surfaceKey, getConfig().loadDomains());
  } catch {
    return false;
  }
}

function notionGrainFor(surfaceKey: string): SupervisorGrain {
  try {
    return supervisorGrainFor(surfaceKey, getConfig().loadDomains());
  } catch {
    return { unified: false, registryKey: surfaceKey };
  }
}

type NotionState = NotionSessionState;

function liveNotionSupervisorDeps(send: SendFn): NotionSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, pageId, atIso) {
      const grain = notionGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, 1, () => notionSupervisorToken(pageId, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      if (shouldRotate(existing, atIso)) {
        const gen = existing.generation + 1;
        const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => notionSupervisorToken(pageId, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      return { token: existing.token, generation: existing.generation, freshGeneration: existing.firstWakeAt == null, handoffNote: existing.handoffNote };
    },
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, notionGrainFor(surfaceKey).registryKey, atIso),
    async forceRotate(surfaceKey, pageId, atIso) {
      const grain = notionGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      const gen = (existing?.generation ?? 0) + 1;
      const row = await store.rotateChannelSession(org, grain.registryKey, supervisorTokenForGrain(grain, gen, () => notionSupervisorToken(pageId, gen)), atIso);
      return { token: row.token, generation: row.generation, handoffNote: row.handoffNote };
    },
    audit: (action, detail) =>
      appendAudit({ org, platform: "notion", workspace: typeof detail.workspaceId === "string" ? detail.workspaceId : "unknown", surface: typeof detail.surfaceKey === "string" ? detail.surfaceKey : undefined, action, detail }),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, state }) {
      await send({ message, context: [...context] }, { auth, continuationToken: token, state });
    },
  };
}

type SendFn = (
  payload: { message: string; context?: string[] },
  opts: { auth: unknown; continuationToken: string; state: NotionState },
) => Promise<void>;

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
      const botUser = resolveBotUser(apiKey ?? "");

      const dispatch = async (d: NotionSupervisorDispatch): Promise<void> => {
        await handleNotionSupervisorDispatch(
          { ...d, unified: notionGrainFor(d.surfaceKey).unified },
          liveNotionSupervisorDeps(send as unknown as SendFn),
        );
        await appendAudit({
          org: deploymentOrg(),
          platform: "notion",
          workspace: d.workspaceId ?? "unknown",
          surface: d.pageId || d.discussionId || "unknown",
          principalId: d.auth.principalId || undefined,
          action: "notion.dispatched",
          detail: { addressing: d.addressing, discussionId: d.discussionId },
        });
      };

      const outcome = await handleNotionDelivery(rawBody, signature, {
        secret: process.env.NOTION_WEBHOOK_SECRET,
        allowUnverified: process.env.OE_ALLOW_UNVERIFIED_NOTION_WEBHOOK === "1",
        apiKey,
        resolveBotUserId: async () => (await botUser()).id,
        resolveBotName: async () => (await botUser()).name,
        ambientEnabled: notionAmbientEnabled,
        engagementTier: (surfaceKey) => engagementTierFor(surfaceKey, getConfig().loadDomains()),
        dispatch,
      });

      if (outcome.action === "handshake") {
        log(
          `subscription handshake received — verification_token (set NOTION_WEBHOOK_SECRET to this AND paste it into Notion's verify form): ${handshakeToken(rawBody)}`,
        );
      } else if (outcome.action === "dispatched") {
        log(`comment.created → dispatched (${outcome.detail})`);
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
    "turn.started"(_data, channel, ctx) {
      const attrs = ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined;
      const s = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
      const discussionId = s(attrs?.discussion_id);
      channel.state.oeReplyTarget = discussionId
        ? ({ discussionId, pageId: s(attrs?.page_id), workspaceId: s(attrs?.workspace_id) } satisfies NotionReplyTarget)
        : undefined;
    },
    async "message.completed"(data, channel) {
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const target = channel.state.oeReplyTarget;
      const discussionId = target?.discussionId;
      const repliedThisTurn = consumeRepliedThisTurn();
      if (action.kind === "silent") {
        await appendAudit({
          org: deploymentOrg(),
          platform: "notion",
          workspace: target?.workspaceId ?? channel.state.workspaceId ?? "unknown",
          surface: target?.pageId ?? channel.state.pageId ?? discussionId ?? "unknown",
          action: "notion.no_reply",
          detail: { discussionId: discussionId ?? channel.state.discussionId, reason: action.reason },
        });
        return;
      }
      if (channel.state.oeUnified === true) {
        const delivery = supervisorTextDelivery(true, capabilitiesForPlatform("notion").midTurnPost);
        if (!delivery.postText) {
          if (isSupervisorProseLeak(true, repliedThisTurn, false)) {
            log(`supervisor message-tool-only: DROPPED terminal prose (judge emitted text without calling reply) — nothing posted (${discussionId ?? "?"})`);
            await appendAudit({
              org: deploymentOrg(),
              platform: "notion",
              workspace: target?.workspaceId ?? channel.state.workspaceId ?? "unknown",
              surface: target?.pageId ?? channel.state.pageId ?? discussionId ?? "unknown",
              action: "turn.supervisor_prose_dropped",
              detail: { discussionId: discussionId ?? null, chars: action.text.length },
            }).catch(() => undefined);
          }
          return;
        }
      }
      const message = action.text;
      const apiKey = notionApiKey();
      if (!discussionId || !apiKey) {
        log(`reply not posted — ${!apiKey ? "NOTION_API_KEY unset" : "no per-turn discussion target (turn.started snapshot empty)"}`);
        return;
      }
      try {
        await createCommentReply({ discussionId, text: message, apiKey });
        await appendAudit({
          org: deploymentOrg(),
          platform: "notion",
          workspace: target?.workspaceId ?? channel.state.workspaceId ?? "unknown",
          surface: target?.pageId ?? channel.state.pageId ?? discussionId,
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
