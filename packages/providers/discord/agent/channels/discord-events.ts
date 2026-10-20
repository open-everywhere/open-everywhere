import { POST, type Channel, type RouteHandlerArgs } from "eve/channels";
import { discordPublicKey, verifyDiscordInteraction } from "./discord-front.js";
import { appendAudit, deploymentOrg } from "@open-everywhere/core/agent/adapter-api.js";
import type { AuditDetail } from "@open-everywhere/core/agent/adapter-api.js";

export const PUBLIC_DISCORD_EVENTS_ROUTE = "/eve/v1/discord/events";

const WEBHOOK_TYPE_PING = 0;
const WEBHOOK_TYPE_EVENT = 1;

function elog(msg: string): void {
  console.log(`[open-everywhere:discord-events] ${msg}`);
}

export type DiscordEventDecision =
  | { readonly kind: "ack"; readonly reason: string }
  | { readonly kind: "audit"; readonly action: string; readonly workspace: string; readonly principalId?: string; readonly detail: AuditDetail };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function classifyDiscordEvent(rawBody: string): DiscordEventDecision {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { kind: "ack", reason: "unparseable body" };
  }
  const p = obj(json);
  if (!p) return { kind: "ack", reason: "non-object body" };
  if (p["type"] === WEBHOOK_TYPE_PING) return { kind: "ack", reason: "PING — endpoint verification" };
  if (p["type"] !== WEBHOOK_TYPE_EVENT) return { kind: "ack", reason: `webhook type ${String(p["type"])} — not an event` };

  const event = obj(p["event"]);
  const eventType = str(event?.["type"]);
  if (eventType !== "APPLICATION_AUTHORIZED" && eventType !== "APPLICATION_DEAUTHORIZED") {
    return { kind: "ack", reason: `event ${eventType ?? "?"} — not an install/uninstall` };
  }

  const data = obj(event?.["data"]);
  const guild = obj(data?.["guild"]);
  const guildId = str(guild?.["id"]);
  const userId = str(obj(data?.["user"])?.["id"]);
  const integrationType = typeof data?.["integration_type"] === "number" ? (data["integration_type"] as number) : undefined;
  const scopes = Array.isArray(data?.["scopes"]) ? (data["scopes"] as unknown[]).filter((s): s is string => typeof s === "string") : undefined;

  return {
    kind: "audit",
    action: eventType === "APPLICATION_AUTHORIZED" ? "surface.app_installed" : "surface.app_uninstalled",
    workspace: guildId ?? (integrationType === 1 ? "user-install" : "unknown"),
    ...(userId ? { principalId: userId } : {}),
    detail: {
      event: eventType,
      ...(integrationType !== undefined ? { integrationType } : {}),
      ...(guildId ? { guildId } : {}),
      ...(scopes && scopes.length > 0 ? { scopes } : {}),
      ...(str(event?.["timestamp"]) ? { eventTimestamp: str(event?.["timestamp"]) } : {}),
    },
  };
}

export interface DiscordEventsOptions {
  readonly publicKey?: string;
  readonly now?: () => number;
  readonly audit?: (row: { action: string; workspace: string; principalId?: string; detail: AuditDetail }) => Promise<void>;
}

const ACK = () => new Response(null, { status: 204 });

export function buildDiscordEventsHandler(opts: DiscordEventsOptions = {}): (req: Request, args: RouteHandlerArgs) => Promise<Response> {
  const now = opts.now ?? (() => Date.now());
  const publicKey = () => opts.publicKey ?? discordPublicKey();
  const audit =
    opts.audit ??
    (async (row) => {
      await appendAudit({ org: deploymentOrg(), platform: "discord", workspace: row.workspace, ...(row.principalId ? { principalId: row.principalId } : {}), action: row.action, detail: row.detail });
    });

  return async (req: Request): Promise<Response> => {
    const rawBody = await req.text();
    if (!verifyDiscordInteraction(rawBody, req.headers, publicKey(), now())) {
      return new Response("unauthorized", { status: 401 });
    }
    const decision = classifyDiscordEvent(rawBody);
    if (decision.kind === "ack") {
      elog(`acked: ${decision.reason}`);
      return ACK();
    }
    try {
      await audit({ action: decision.action, workspace: decision.workspace, ...(decision.principalId ? { principalId: decision.principalId } : {}), detail: decision.detail });
      elog(`${decision.detail["event"]} on ${decision.workspace} audited as ${decision.action}`);
    } catch (err) {
      elog(`audit write failed (acked anyway): ${String(err)}`);
    }
    return ACK();
  };
}

export function withDiscordEventsRoute<C extends Channel<any, any, any>>(channel: C, opts: DiscordEventsOptions = {}): C {
  return { ...channel, routes: [POST(PUBLIC_DISCORD_EVENTS_ROUTE, buildDiscordEventsHandler(opts)), ...channel.routes] };
}
