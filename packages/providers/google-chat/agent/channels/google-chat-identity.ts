import type { BindableContext, IdentityMapper, RawIdentity } from "@open-everywhere/core/agent/adapter-api.js";

export interface OpenEverywhereGoogleChatAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface GoogleChatIdentityInput {
  readonly workspace: string;
  readonly space: string;
  readonly mode: "channel" | "dm";
  readonly trust: "internal" | "external";
  readonly sender: string;
  readonly thread?: string;
  readonly messageName: string;
}

export function buildGoogleChatAuth(input: GoogleChatIdentityInput): OpenEverywhereGoogleChatAuth {
  return {
    authenticator: "google-chat",
    principalId: input.sender,
    principalType: "google-chat-user",
    attributes: {
      gchat_workspace: input.workspace,
      gchat_space: input.space,
      gchat_surface: input.space.slice(input.space.indexOf("/") + 1),
      gchat_mode: input.mode,
      gchat_trust: input.trust,
      gchat_message: input.messageName,
      ...(input.thread !== undefined ? { gchat_thread: input.thread } : {}),
    },
  };
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function authOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function attr(a: AuthAttrs, key: string): string | undefined {
  const v = a?.[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

export const bindGoogleChat: IdentityMapper = (ctx): RawIdentity => {
  const auth = authOf(ctx);
  const a = auth?.attributes;
  const mode = attr(a, "gchat_mode") === "dm" ? "dm" : "channel";
  const internal = attr(a, "gchat_trust") === "internal";
  const space = attr(a, "gchat_space");
  const thread = attr(a, "gchat_thread");
  const messageName = attr(a, "gchat_message");
  const principalId = typeof auth?.principalId === "string" && auth.principalId.length > 0 ? auth.principalId : undefined;
  return {
    workspace: attr(a, "gchat_workspace"),
    surface: attr(a, "gchat_surface"),
    mode,
    visibility: "private",
    ...(internal ? { trust: "internal" as const, ...(mode === "dm" ? { trustVerified: true } : {}) } : { trust: "external" as const }),
    ...(principalId ? { principalId } : {}),
    ...(space
      ? { target: { space, channelId: space, ...(thread ? { thread } : {}), ...(messageName ? { messageName } : {}) } }
      : {}),
  };
};
