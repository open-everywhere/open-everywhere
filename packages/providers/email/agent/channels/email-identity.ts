import type { BindableContext, IdentityMapper, RawIdentity } from "@open-everywhere/core/agent/adapter-api.js";

export interface OpenEverywhereEmailAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface EmailIdentityInput {
  readonly inbox: string;
  readonly domain: string;
  readonly surface: string;
  readonly mode: "channel" | "dm";
  readonly trust: "internal" | "external";
  readonly sender: string;
  readonly threadId: string;
  readonly messageId: string;
}

export function buildEmailAuth(input: EmailIdentityInput): OpenEverywhereEmailAuth {
  return {
    authenticator: "email",
    principalId: input.sender,
    principalType: "email-sender",
    attributes: {
      email_inbox: input.inbox,
      email_domain: input.domain,
      email_surface: input.surface,
      email_mode: input.mode,
      email_trust: input.trust,
      email_thread_id: input.threadId,
      email_message_id: input.messageId,
    },
  };
}

function emailThreadAddress(inbox: string, threadId: string): string {
  return `${inbox}/${threadId}`;
}

export function parseEmailThreadAddress(channelId: string): { readonly inbox: string; readonly threadId: string } | undefined {
  const i = channelId.indexOf("/");
  if (i <= 0 || i === channelId.length - 1) return undefined;
  return { inbox: channelId.slice(0, i), threadId: channelId.slice(i + 1) };
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function emailAuthOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function attr(a: AuthAttrs, key: string): string | undefined {
  const v = a?.[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

export const bindEmail: IdentityMapper = (ctx): RawIdentity => {
  const auth = emailAuthOf(ctx);
  const a = auth?.attributes;
  const mode = attr(a, "email_mode") === "dm" ? "dm" : "channel";
  const internal = attr(a, "email_trust") === "internal";
  const inbox = attr(a, "email_inbox");
  const threadId = attr(a, "email_thread_id");
  const messageId = attr(a, "email_message_id");
  const principalId = typeof auth?.principalId === "string" && auth.principalId.length > 0 ? auth.principalId : undefined;
  return {
    workspace: attr(a, "email_domain"),
    surface: attr(a, "email_surface"),
    mode,
    visibility: "private",
    ...(internal ? { trust: "internal" as const, ...(mode === "dm" ? { trustVerified: true } : {}) } : { trust: "external" as const }),
    ...(principalId ? { principalId } : {}),
    ...(inbox && threadId && messageId ? { target: { inbox, threadId, messageId, channelId: emailThreadAddress(inbox, threadId) } } : {}),
  };
};
