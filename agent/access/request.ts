import { resolvePartition } from "../memory/partition.js";
import type { ResolveRequest, SessionMode } from "./resolver.js";

interface CtxLike {
  readonly session?: {
    readonly auth?: {
      readonly current?: { readonly principalId?: string } | null;
    } | null;
  };
  readonly channel?: {
    readonly kind?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

const MODES: ReadonlySet<string> = new Set(["channel", "dm", "mpim"]);

export function resolveMode(ctx: CtxLike): SessionMode {
  const fromMeta = ctx.channel?.metadata?.["mode"];
  if (typeof fromMeta === "string" && MODES.has(fromMeta)) return fromMeta as SessionMode;
  const fromEnv = process.env.OE_MODE;
  if (fromEnv && MODES.has(fromEnv)) return fromEnv as SessionMode;
  return "channel";
}

export function principalIdOf(ctx: CtxLike): string | undefined {
  return ctx.session?.auth?.current?.principalId ?? process.env.OE_PRINCIPAL ?? undefined;
}

export function buildResolveRequest(ctx: CtxLike & Parameters<typeof resolvePartition>[0]): ResolveRequest {
  const p = resolvePartition(ctx);
  return {
    mode: resolveMode(ctx),
    platform: p.platform,
    workspace: p.workspace,
    channel: p.channel,
    principalId: principalIdOf(ctx),
  };
}
