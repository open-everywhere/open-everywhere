import { appendAudit } from "./audit.js";
import { auditSurfaceModeStamp, bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";

export const CROSS_ROOM_SEND_ACTION = "channel.cross_room_send";

interface CrossRoomSendContext {
  readonly to?: (channel: unknown, target: unknown) => { send(message: unknown, options?: unknown): Promise<unknown> };
}

export interface CrossRoomSend {
  readonly channel: unknown;
  readonly channelName: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly message: unknown;
  readonly options?: unknown;
}

function targetIds(target: Readonly<Record<string, unknown>>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(target)) if (typeof value === "string") ids[key] = value;
  return ids;
}

function sourceRoom(ctx: unknown): { org: string; platform: string; workspace: string; surface?: string; principalId?: string } & ReturnType<typeof auditSurfaceModeStamp> {
  try {
    const p = resolvePartition(ctx as BindableContext);
    const binding = bindFrom(ctx as BindableContext);
    return { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface, ...auditSurfaceModeStamp(binding), principalId: binding.principalId };
  } catch {
    return { org: deploymentOrg(), platform: "unknown", workspace: "unknown" };
  }
}

export async function auditedCrossRoomSend(ctx: unknown, send: CrossRoomSend): Promise<unknown> {
  const to = (ctx as CrossRoomSendContext | null | undefined)?.to;
  if (typeof to !== "function") {
    throw new Error("auditedCrossRoomSend: this tool context has no ctx.to — eve adds it in 0.85.0, and this deployment's eve is older.");
  }
  const room = sourceRoom(ctx);
  await appendAudit({
    ...room,
    action: CROSS_ROOM_SEND_ACTION,
    detail: {
      sourcePlatform: room.platform,
      sourceWorkspace: room.workspace,
      ...(room.surface !== undefined ? { sourceSurface: room.surface } : {}),
      targetChannel: send.channelName,
      target: targetIds(send.target),
    },
  });
  return to.call(ctx, send.channel, send.target).send(send.message, send.options);
}
