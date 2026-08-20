import { POST, type Channel, type HttpRouteDefinition, type RouteHandlerArgs } from "eve/channels";
import { verifyDiscordSignature } from "eve/channels/discord";
import { OE_DISCORD_APPROVAL_PREFIX } from "../approvals/discord-card.js";
import { handleDiscordApprovalInteraction, type DiscordInteractionResponse } from "../approvals/discord-flow.js";
import { LINK_CONSENT_CLICK_PREFIX } from "@open-everywhere/core/agent/adapter-api.js";
import { handleDiscordLinkConsentInteraction } from "../identity/discord-link-consent.js";
import { OE_COMMAND_NAME, type AttachSessionForCancel } from "@open-everywhere/core/agent/adapter-api.js";
import { handleDiscordOeCommandInteraction } from "../commands/discord-commands.js";

type RouteHandler = (req: Request, args: RouteHandlerArgs) => Promise<Response>;

export const PUBLIC_DISCORD_ROUTE = "/eve/v1/discord";
export const INTERNAL_DISCORD_ROUTE = "/eve/v1/discord/interaction";

const DISCORD_MAX_SKEW_SECONDS = 60 * 5;

export function verifyDiscordInteraction(
  rawBody: string,
  headers: Headers,
  publicKey: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const signature = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (!publicKey || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > DISCORD_MAX_SKEW_SECONDS) return false;
  return verifyDiscordSignature({ body: rawBody, publicKey, signature, timestamp });
}

export type DiscordFrontDecision =
  | { readonly kind: "forward"; readonly reason: string }
  | { readonly kind: "approval-click"; readonly reason: string; readonly interaction: unknown }
  | { readonly kind: "link-consent-click"; readonly reason: string; readonly interaction: unknown }
  | { readonly kind: "oe-command"; readonly reason: string; readonly interaction: unknown };

export function classifyDiscordInteraction(rawBody: string): DiscordFrontDecision {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { kind: "forward", reason: "unparseable body — let discordChannel answer it" };
  }
  if (typeof json !== "object" || json === null) {
    return { kind: "forward", reason: "non-object body — let discordChannel answer it" };
  }
  const p = json as Record<string, unknown>;
  if (p.type === 2) {
    const data = typeof p.data === "object" && p.data !== null ? (p.data as Record<string, unknown>) : undefined;
    const name = typeof data?.name === "string" ? data.name : undefined;
    if (name === OE_COMMAND_NAME) {
      return { kind: "oe-command", reason: `"/${OE_COMMAND_NAME}" command — ours, zero-inference, never forwarded`, interaction: json };
    }
    return { kind: "forward", reason: `application command "${name ?? "?"}" — not ours, discordChannel dispatches it` };
  }
  if (p.type !== 3) {
    return { kind: "forward", reason: `interaction type ${String(p.type)} — not a component click` };
  }
  const data = typeof p.data === "object" && p.data !== null ? (p.data as Record<string, unknown>) : undefined;
  const customId = typeof data?.custom_id === "string" ? data.custom_id : undefined;
  if (customId?.startsWith(OE_DISCORD_APPROVAL_PREFIX)) {
    return { kind: "approval-click", reason: "oe-approval: component click — ours, never forwarded", interaction: json };
  }
  if (customId?.startsWith(LINK_CONSENT_CLICK_PREFIX)) {
    return { kind: "link-consent-click", reason: "oe-link: component click — ours, never forwarded", interaction: json };
  }
  return { kind: "forward", reason: "component click — eve's HITL owns it" };
}

export interface DiscordFrontOptions {
  readonly publicKey?: string;
  readonly now?: () => number;
  readonly handleApprovalInteraction?: (raw: unknown) => Promise<DiscordInteractionResponse | null>;
  readonly handleLinkConsentInteraction?: (raw: unknown) => Promise<DiscordInteractionResponse | null>;
  readonly handleOeCommand?: (raw: unknown, attachSession?: AttachSessionForCancel) => Promise<DiscordInteractionResponse | null>;
}

function interactionJson(body: DiscordInteractionResponse): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export function buildDiscordFrontHandler(innerHandler: RouteHandler, opts: DiscordFrontOptions = {}): RouteHandler {
  const now = opts.now ?? (() => Date.now());
  const publicKey = () => opts.publicKey ?? process.env.DISCORD_PUBLIC_KEY;
  const handleClick = opts.handleApprovalInteraction ?? handleDiscordApprovalInteraction;
  const handleLinkConsent = opts.handleLinkConsentInteraction ?? handleDiscordLinkConsentInteraction;
  const handleOeCommand = opts.handleOeCommand ?? handleDiscordOeCommandInteraction;

  return async (req: Request, args: RouteHandlerArgs): Promise<Response> => {
    const rawBody = await req.text();
    if (!verifyDiscordInteraction(rawBody, req.headers, publicKey(), now())) {
      return new Response("unauthorized", { status: 401 });
    }
    const decision = classifyDiscordInteraction(rawBody);

    if (decision.kind === "approval-click") {
      const response = await handleClick(decision.interaction);
      if (response) return interactionJson(response);
    }

    if (decision.kind === "link-consent-click") {
      const response = await handleLinkConsent(decision.interaction);
      if (response) return interactionJson(response);
    }

    if (decision.kind === "oe-command") {
      const response = await handleOeCommand(decision.interaction, args.attachSession);
      if (response) return interactionJson(response);
    }

    const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
    return innerHandler(forwarded, args);
  };
}

export function frontDiscordChannel<C extends Channel<any, any, any>>(inner: C, opts: DiscordFrontOptions = {}): C {
  const innerPost = inner.routes.find(
    (r): r is HttpRouteDefinition<any> => r.method === "POST" && r.path === INTERNAL_DISCORD_ROUTE,
  );
  if (!innerPost) {
    throw new Error(
      `frontDiscordChannel: wrapped discordChannel must be built with route: "${INTERNAL_DISCORD_ROUTE}" ` +
        `(found paths: ${inner.routes.map((r) => r.path).join(", ")})`,
    );
  }
  const front = buildDiscordFrontHandler(innerPost.handler, opts);
  return { ...inner, routes: [POST(PUBLIC_DISCORD_ROUTE, front), ...inner.routes] };
}
