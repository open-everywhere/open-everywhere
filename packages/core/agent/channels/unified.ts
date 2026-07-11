import { defineChannel, GET } from "eve/channels";
import type { Session, RouteHandlerArgs } from "eve/channels";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg, currentWakeId, currentTurnAddressing, type BindableContext } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { crossSurfaceWindowEnabled } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { registerUnifiedWakeTarget, resolveUnifiedWakeTarget, isUnifiedWakeOrigin, stampUnifiedWindowAuth, shouldBridgeAddressedProse, type UnifiedWakeOrigin, type UnifiedWindowWake } from "./unified-window.js";
import { postUnifiedReply } from "./unified-reply.js";
import { unifiedDomainFromToken, unifiedDomainSessionKey, isUnifiedSupervisorToken } from "./unified-supervisor.js";
import { finalMessageActionForTurn } from "./slack-events.js";
import { consumeRepliedThisTurn } from "./reply-signal.js";

function ulog(msg: string): void {
  console.log(`[open-everywhere:unified] ${msg}`);
}

export interface UnifiedReceiveTarget {
  readonly token: string;
  readonly wakeId: string;
  readonly origin: UnifiedWakeOrigin;
  readonly surfaceKey: string;
  readonly context?: readonly string[];
}

function windowEnabledFor(surfaceKey: string): boolean {
  try {
    return crossSurfaceWindowEnabled(surfaceKey, getConfig().loadDomains());
  } catch {
    return false;
  }
}

function auditLabels(rawToken: string): { workspace: string; surface: string | undefined } {
  const domain = unifiedDomainFromToken(rawToken);
  return { workspace: domain ?? "unknown", surface: domain ? unifiedDomainSessionKey(domain) : undefined };
}

const channel = defineChannel<undefined, void, UnifiedReceiveTarget>({
  routes: [GET("/eve/v1/unified", async () => new Response("not found", { status: 404 }))],
  kindHint: "unified",
  async receive(input, { send }): Promise<Session> {
    const t = input.target as Partial<UnifiedReceiveTarget> | undefined;
    if (
      !t ||
      typeof t.token !== "string" ||
      !isUnifiedSupervisorToken(t.token) ||
      typeof t.wakeId !== "string" ||
      t.wakeId.length === 0 ||
      typeof t.surfaceKey !== "string" ||
      !isUnifiedWakeOrigin(t.origin)
    ) {
      throw new Error("unified receive: malformed target (host dispatch bug) — refusing the wake");
    }
    if (!windowEnabledFor(t.surfaceKey)) {
      throw new Error(`unified receive: crossSurfaceWindow is not enabled for ${t.surfaceKey} — refusing the wake (fail-closed)`);
    }
    const org = deploymentOrg();
    await registerUnifiedWakeTarget(getOperationalStore(), org, t.wakeId, t.origin, new Date().toISOString());
    ulog(`wake ${t.wakeId} from ${t.surfaceKey} → ${t.token} (origin ${t.origin.platform})`);
    return send(
      { message: input.message, ...(t.context && t.context.length > 0 ? { context: [...t.context] } : {}) },
      { auth: input.auth, continuationToken: t.token },
    );
  },
  events: {
    async "message.completed"(data, channel, ctx) {
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const replied = consumeRepliedThisTurn();
      const org = deploymentOrg();
      const { workspace, surface } = auditLabels(channel.continuationToken);
      if (action.kind === "silent") {
        await appendAudit({
          org,
          platform: "unified",
          workspace,
          surface,
          action: "unified.no_reply",
          detail: { reason: action.reason, replied },
        }).catch(() => undefined);
        return;
      }
      const bind = { session: ctx.session } as unknown as BindableContext;
      if (shouldBridgeAddressedProse(currentTurnAddressing(bind), replied)) {
        const wakeId = currentWakeId(bind);
        const origin = wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId).catch(() => null) : null;
        if (origin) {
          try {
            const id = await postUnifiedReply(origin, action.text);
            ulog(`addressed-mention bridge: delivered terminal prose (${action.text.length} chars) to ${origin.platform} — id ${id}`);
            await appendAudit({
              org,
              platform: "unified",
              workspace,
              surface,
              action: "turn.direct_mention_prose_delivered",
              detail: { chars: action.text.length, platform: origin.platform },
            }).catch(() => undefined);
            return;
          } catch (err) {
            ulog(`addressed-mention bridge: post failed, dropping prose (audited): ${String(err).slice(0, 200)}`);
          }
        }
      }
      ulog(`message-tool-only: DROPPED terminal prose (${action.text.length} chars; replied=${replied}) — replies must come from the reply tool`);
      await appendAudit({
        org,
        platform: "unified",
        workspace,
        surface,
        action: "turn.supervisor_prose_dropped",
        detail: { chars: action.text.length, replied },
      }).catch(() => undefined);
    },
    async "turn.failed"(data, channel) {
      const { workspace, surface } = auditLabels(channel.continuationToken);
      ulog(`supervisor turn failed on domain ${workspace} (audited, nothing posted): ${data.message}`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "unified",
        workspace,
        surface,
        action: "unified.supervisor_turn_failed",
        detail: { message: String(data.message).slice(0, 500) },
      }).catch(() => undefined);
    },
    async "session.failed"(data, channel) {
      const { workspace, surface } = auditLabels(channel.continuationToken);
      ulog(`supervisor session failed on domain ${workspace} (audited, nothing posted; next wake force-rotates): ${data.message}`);
      await appendAudit({
        org: deploymentOrg(),
        platform: "unified",
        workspace,
        surface,
        action: "unified.supervisor_session_failed",
        detail: { message: String(data.message).slice(0, 500) },
      }).catch(() => undefined);
    },
  },
});

export default channel;

export async function divertToUnifiedWindow(
  receive: RouteHandlerArgs["receive"],
  input: {
    readonly message: string;
    readonly context?: readonly string[];
    readonly token: string;
    readonly window: UnifiedWindowWake;
    readonly surfaceKey: string;
    readonly auth: { attributes?: Record<string, unknown> };
  },
): Promise<void> {
  const auth = stampUnifiedWindowAuth(input.auth, input.window.origin.platform, input.window.wakeId, input.window.addressing);
  const target: UnifiedReceiveTarget = {
    token: input.token,
    wakeId: input.window.wakeId,
    origin: input.window.origin,
    surfaceKey: input.surfaceKey,
    ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
  };
  await receive(channel, { message: input.message, target, auth: auth as Parameters<RouteHandlerArgs["receive"]>[1]["auth"] });
}
