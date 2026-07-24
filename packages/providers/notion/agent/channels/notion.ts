import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import {
  appendAudit,
  deploymentOrg,
  resolveWakeTrustFromContext,
  finalMessageActionForTurn,
  completeSupervisorTurn,
  getConfig,
  ambientSupervisorEnabled,
  engagementTierFor,
  liveMemoryDeltaDep,
  getOperationalStore,
  capabilitiesForPlatform,
  consumeRepliedThisTurn,
  isVouchedInternal,
  supervisorGrainFor,
  mintRotationToken,
  grainUsesUnifiedWindow,
  divertToUnifiedWindow,
  type SupervisorGrain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { createCommentReply, resolveNotionApiKey, retrieveBotUser } from "./notion-api.js";
import { notionWorkspaceKey } from "./notion-identity.js";
import { handleNotionDelivery, type NotionReplyTarget, type NotionSessionState } from "./notion-webhook.js";
import {
  handleNotionSupervisorDispatch,
  notionSupervisorToken,
  planNotionSingleWindow,
  shouldRotate,
  type NotionSupervisorDeps,
  type NotionSupervisorDispatch,
  type NotionWakeMessage,
} from "./notion-supervisor.js";

const ROUTE = "/eve/v1/notion";

function log(msg: string): void {
  console.log(`[open-everywhere:notion] ${msg}`);
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

function liveNotionSupervisorDeps(send: SendFn, surfaceKey: string, receive?: RouteHandlerArgs["receive"]): NotionSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, pageId, atIso) {
      const grain = notionGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, 1, () => notionSupervisorToken(pageId, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      if (shouldRotate(existing, atIso)) {
        const gen = existing.generation + 1;
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => notionSupervisorToken(pageId, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
      }
      const fresh = existing.firstWakeAt == null;
      return { token: existing.token, generation: existing.generation, freshGeneration: fresh, handoffNote: existing.handoffNote, ...(fresh ? {} : { lastWakeAt: existing.lastWakeAt }) };
    },
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, notionGrainFor(surfaceKey).registryKey, atIso),
    async forceRotate(surfaceKey, pageId, atIso) {
      const grain = notionGrainFor(surfaceKey);
      const existing = await store.getChannelSession(org, grain.registryKey);
      const gen = (existing?.generation ?? 0) + 1;
      const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => notionSupervisorToken(pageId, gen)), atIso);
      return { token: row.token, generation: row.generation, handoffNote: row.handoffNote };
    },
    audit: (action, detail) =>
      appendAudit({ org, platform: "notion", workspace: typeof detail.workspaceId === "string" ? detail.workspaceId : "unknown", surface: typeof detail.surfaceKey === "string" ? detail.surfaceKey : undefined, action, detail }),
    memoryDelta: liveMemoryDeltaDep(org, surfaceKey),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, state, window }) {
      if (window) {
        if (!receive) throw new Error("notion single-window wake has no cross-channel receive — refusing (would post an unregistered wake-id)");
        await divertToUnifiedWindow(receive, {
          message,
          context: [...context],
          token,
          window,
          surfaceKey,
          auth: auth as unknown as { attributes?: Record<string, unknown> },
        });
        return;
      }
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
    POST(ROUTE, async (req, { send, waitUntil, receive }) => {
      const rawBody = await req.text();
      const signature = req.headers.get("x-notion-signature");
      const apiKey = await resolveNotionApiKey();
      const botUser = resolveBotUser(apiKey ?? "");

      const dispatch = async (d: NotionSupervisorDispatch): Promise<void> => {
        const grain = notionGrainFor(d.surfaceKey);
        const usesWindow = grainUsesUnifiedWindow(grain);
        const privacyOk =
          usesWindow &&
          (isVouchedInternal(notionWorkspaceKey(d.workspaceId ?? "unknown"), d.surfaceKey) || process.env.OE_TRUST === "internal");
        const window = usesWindow
          ? planNotionSingleWindow(true, d.addressing === "direct", privacyOk, {
              discussionId: d.discussionId,
              pageId: d.pageId || undefined,
              workspaceId: d.workspaceId,
            })
          : undefined;
        const wakeCtx = { channel: { kind: "notion" }, session: { auth: { current: d.auth as unknown as { attributes?: Readonly<Record<string, string>> } } } };
        const trustOf = (m: NotionWakeMessage) =>
          m.from === "human" && m.authorId ? resolveWakeTrustFromContext(wakeCtx, { id: m.authorId, isBot: false }) : ("relay" as const);
        await handleNotionSupervisorDispatch(
          {
            ...d,
            unified: grain.unified,
            window,
            ...(window?.addressing === "direct-mention" ? { directMention: true } : {}),
            trigger: { ...d.trigger, trust: trustOf(d.trigger) },
            threadComments: d.threadComments.map((m) => ({ ...m, trust: trustOf(m) })),
          },
          liveNotionSupervisorDeps(send as unknown as SendFn, d.surfaceKey, receive),
        );
        await appendAudit({
          org: deploymentOrg(),
          platform: "notion",
          workspace: d.workspaceId ?? "unknown",
          surface: d.pageId || d.discussionId || "unknown",
          principalId: d.auth.principalId || undefined,
          action: "notion.dispatched",
          detail: { addressing: d.addressing, discussionId: d.discussionId, ...(window ? { singleWindow: true } : {}) },
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
    async "message.completed"(data, channel, ctx) {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const target = channel.state.oeReplyTarget;
      const discussionId = target?.discussionId;
      const repliedThisTurn = consumeRepliedThisTurn();
      const org = deploymentOrg();
      const workspace = target?.workspaceId ?? channel.state.workspaceId ?? "unknown";
      await completeSupervisorTurn({
        action,
        ...(sessionId ? { sessionId } : {}),
        hasTarget: !!discussionId,
        midTurnPost: channel.state.oeUnified === true ? capabilitiesForPlatform("notion").midTurnPost : false,
        proseLeak: { repliedThisTurn },
        noReplyAction: "notion.no_reply",
        repliedAction: "notion.replied",
        contextRow: { org, platform: "notion", workspace, surface: target?.pageId ?? channel.state.pageId ?? discussionId ?? "unknown" },
        repliedRow: { org, platform: "notion", workspace, surface: target?.pageId ?? channel.state.pageId ?? discussionId },
        silentAnchor: { discussionId: discussionId ?? channel.state.discussionId },
        droppedAnchor: { discussionId: discussionId ?? null },
        repliedAnchor: { discussionId },
        post: async (text) => {
          const apiKey = await resolveNotionApiKey();
          if (!apiKey) throw new Error("reply couldn't post to Notion — NOTION_CHANNEL_API_KEY is not set.");
          await createCommentReply({ discussionId: discussionId!, text, apiKey });
        },
        log: (m) => log(m),
      });
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
