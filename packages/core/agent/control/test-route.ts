import type { RouteHandlerArgs } from "eve/channels";
import { parseServiceTokenEntries, verifyServiceToken } from "./auth.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { crossSurfaceWindowEnabled } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { unifiedDomainSessionKey } from "../channels/unified-supervisor.js";
import { mintWakeId, isUnifiedWakeOrigin, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { renderWake, mkMessageTrigger, type NormalizedWake, type WakeAddressing } from "../channels/normalized-wake.js";
import type { WakeReason, WakeTrust, WakeParticipant } from "../channels/wake-envelope.js";
import { divertToUnifiedWindow } from "../channels/unified.js";

export const CONTROL_TEST_WAKE_PATH = "/control/v1/test/wake";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function testWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OE_TEST_WAKE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export interface TestWakeRequest {
  readonly domain: string;
  readonly platform: UnifiedWakeOrigin["platform"];
  readonly surfaceKey: string;
  readonly addressing?: WakeAddressing;
  readonly reason?: WakeReason;
  readonly text: string;
  readonly author?: string;
  readonly authorId?: string;
  readonly trust?: WakeTrust;
  readonly mention?: boolean;
  readonly origin: UnifiedWakeOrigin;
  readonly authAttributes?: Readonly<Record<string, string>>;
  readonly containerNoun?: string;
  readonly engagementTier?: "aggressive" | "neutral" | "reserved";
  readonly unifiedDisclosure?: boolean;
  readonly participants?: readonly WakeParticipant[];
  readonly channelType?: string;
  readonly threadTs?: string;
}

function attrsFromSurfaceKey(platform: string, surfaceKey: string): Record<string, string> {
  const parts = surfaceKey.split("/");
  const workspace = parts[1] ?? "";
  const surface = parts.slice(2).join("/");
  switch (platform) {
    case "slack":
      return { team_id: workspace, channel_id: surface, channel_type: "channel", is_private: "false" };
    case "discord":
      return { guild_id: workspace, channel_id: surface };
    case "github":
      return { owner: workspace, repo: surface };
    case "linear":
      return { organization_id: workspace, team_id: surface };
    case "notion":
      return { workspace_id: workspace, page_id: surface };
    case "teams":
      return { tenant_id: workspace, conversation_id: surface };
    default:
      return { workspace_id: workspace, surface_id: surface };
  }
}

function defaultReason(addressing: WakeAddressing): WakeReason {
  if (addressing === "direct" || addressing === "direct-mention") return "mention";
  if (addressing === "thread-follow") return "thread-activity";
  return "channel-activity";
}

function defaultContainerNoun(platform: string): string | undefined {
  switch (platform) {
    case "notion": return "doc";
    case "linear": return "team";
    case "github": return "repo";
    default: return undefined;
  }
}

export async function handleTestWakeInjection(req: Request, receive: RouteHandlerArgs["receive"]): Promise<Response> {
  const entries = parseServiceTokenEntries(process.env.OE_CONTROL_READ_TOKENS);
  if (!testWakeEnabled() || entries.length === 0) return new Response("not found", { status: 404 });

  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const identity = match ? verifyServiceToken(match[1], entries) : null;
  if (!identity) return json(401, { error: "unauthorized: missing or invalid bearer token" });

  let body: Partial<TestWakeRequest>;
  try {
    body = (await req.json()) as Partial<TestWakeRequest>;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const domain = typeof body.domain === "string" ? body.domain.trim() : "";
  const platform = body.platform;
  const surfaceKey = typeof body.surfaceKey === "string" ? body.surfaceKey.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!domain || !platform || !surfaceKey || text.length === 0) {
    return json(400, { error: "expected body: { domain, platform, surfaceKey, text, origin, … }" });
  }
  if (!isUnifiedWakeOrigin(body.origin)) {
    return json(400, { error: "invalid or missing `origin` (must be a valid UnifiedWakeOrigin for the platform)" });
  }
  const origin = body.origin;
  if (origin.platform !== platform) {
    return json(400, { error: `origin.platform "${origin.platform}" != platform "${platform}"` });
  }

  let windowOk = false;
  try {
    windowOk = crossSurfaceWindowEnabled(surfaceKey, getConfig().loadDomains());
  } catch {
    windowOk = false;
  }
  if (!windowOk) {
    return json(400, { error: `crossSurfaceWindow is not enabled for surfaceKey "${surfaceKey}" — refusing (fail-closed)` });
  }

  const org = deploymentOrg();
  const store = getOperationalStore();
  const sessionRow = await store.getChannelSession(org, unifiedDomainSessionKey(domain)).catch(() => null);
  const token = sessionRow?.token;
  if (!token) {
    return json(400, { error: `no unified session for domain "${domain}" — rotate/seed the window first (channel_session row absent)` });
  }

  const addressing: WakeAddressing = body.addressing ?? "channel-watch";
  const reason: WakeReason = body.reason ?? defaultReason(addressing);
  const wakeId = mintWakeId();
  const containerId = surfaceKey.split("/").slice(2).join("/") || surfaceKey;
  const containerNoun = body.containerNoun ?? defaultContainerNoun(platform);
  const unifiedDisclosure = body.unifiedDisclosure ?? true;
  const nw: NormalizedWake = {
    platform,
    reason,
    addressing,
    wakeId,
    ...(containerNoun !== undefined ? { containerNoun } : {}),
    ...(body.engagementTier !== undefined ? { engagementTier: body.engagementTier } : {}),
    unifiedDisclosure,
    ...(body.participants !== undefined ? { participants: body.participants } : {}),
    locus: {
      channel: { id: containerId, platform, ...(body.channelType !== undefined ? { type: body.channelType } : {}) },
      ...(body.threadTs !== undefined ? { thread: { ts: body.threadTs } } : {}),
    },
    trigger: mkMessageTrigger({
      from: "human",
      author: body.author ?? "tester",
      ...(body.authorId !== undefined ? { authorId: body.authorId } : {}),
      id: `test-${wakeId}`,
      sentAt: new Date().toISOString(),
      trust: (body.trust ?? "peer") as WakeTrust,
      ...(body.mention !== undefined ? { mention: body.mention } : {}),
      body: text,
    }),
  };
  const rendered = renderWake(nw);

  const authAttributes = { ...attrsFromSurfaceKey(platform, surfaceKey), ...(body.authAttributes ?? {}) };

  await appendAudit({
    org,
    platform: "control",
    workspace: "control",
    principalId: identity.subject,
    action: "control.service_call",
    detail: { service: identity.subject, view: "test_wake", domain, injectedPlatform: platform, surfaceKey, addressing, wakeId },
  }).catch(() => undefined);

  try {
    await divertToUnifiedWindow(receive, {
      message: rendered.message,
      ...(rendered.context && rendered.context.length > 0 ? { context: rendered.context } : {}),
      token,
      window: { wakeId, origin, ...(addressing === "direct-mention" ? { addressing: "direct-mention" } : {}) },
      surfaceKey,
      auth: { attributes: authAttributes },
    });
  } catch (err) {
    return json(500, { error: `injection failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  return json(200, { ok: true, wakeId, token, domain, platform, surfaceKey, addressing, messageChars: rendered.message.length });
}
