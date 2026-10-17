import {
  mkMessageTrigger,
  readCappedBody,
  renderWake,
  stampNonMemberChatAuth,
  type IngestedChatMessage,
  type NormalizedWake,
  type UnifiedWakeOrigin,
  type WakeMessageInput,
  type WakeTrust,
} from "@open-everywhere/core/agent/adapter-api.js";
import { googleChatSurfaceKey, type GoogleChatPolicy } from "../policy.js";
import { verifyGoogleChatToken, type GoogleChatVerifyDeps } from "./google-chat-auth.js";
import { buildGoogleChatAuth, type OpenEverywhereGoogleChatAuth } from "./google-chat-identity.js";
import { isMessageNameIn, isSpaceName, isThreadNameIn } from "./google-chat-rest.js";
import type { AuditDetail } from "@open-everywhere/core/agent/adapter-api.js";

type GoogleChatOrigin = Extract<UnifiedWakeOrigin, { platform: "google-chat" }>;

const GOOGLE_CHAT_MAX_INBOUND_CHARS = 20_000;

export type GoogleChatRefusal = "group-chat" | "dm-off" | "external-dm" | "no-domain";

export type GoogleChatFrontOutcome =
  | { readonly kind: "not-configured" }
  | { readonly kind: "unauthorized"; readonly reason: string }
  | { readonly kind: "ignored"; readonly why: string }
  | { readonly kind: "duplicate" }
  | { readonly kind: "refused"; readonly reason: GoogleChatRefusal }
  | { readonly kind: "admitted"; readonly route: "room" | "dm"; readonly surfaceKey: string };

export interface GoogleChatMessageEvent {
  readonly space: string;
  readonly spaceKind: "space" | "dm" | "group";
  readonly messageName: string;
  readonly thread?: string;
  readonly threadReply: boolean;
  readonly sender: string;
  readonly senderName?: string;
  readonly domainId?: string;
  readonly text: string;
  readonly addressed: boolean;
  readonly createTime: string;
}

export interface GoogleChatWakePlan {
  readonly surfaceKey: string;
  readonly route: "room" | "dm";
  readonly auth: OpenEverywhereGoogleChatAuth;
  readonly origin: GoogleChatOrigin;
  readonly trigger: WakeMessageInput;
  readonly trust: "internal" | "external";
  readonly ingested: readonly IngestedChatMessage[];
  readonly event: GoogleChatMessageEvent;
}

export interface GoogleChatFrontDeps extends GoogleChatVerifyDeps {
  readonly policy: () => GoogleChatPolicy;
  readonly markSeen: (key: string) => Promise<boolean>;
  readonly roomHasSeat: (surfaceKey: string) => boolean;
  readonly wakeTrust: (auth: OpenEverywhereGoogleChatAuth, sender: string) => WakeTrust;
  readonly dispatchRoom: (plan: GoogleChatWakePlan) => Promise<void>;
  readonly dispatchDm: (plan: GoogleChatWakePlan) => Promise<void>;
  readonly audit: (row: { readonly action: string; readonly workspace: string; readonly surface?: string; readonly principalId?: string; readonly detail: AuditDetail }) => Promise<void>;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function parseGoogleChatEvent(rawBody: string): { readonly event: GoogleChatMessageEvent } | { readonly ignored: string } {
  let j: unknown;
  try {
    j = JSON.parse(rawBody);
  } catch {
    return { ignored: "not-json" };
  }
  const e = rec(j);
  if (!e || e["type"] !== "MESSAGE") return { ignored: "not-a-message" };
  const space = rec(e["space"]);
  const message = rec(e["message"]);
  const sender = rec(message?.["sender"]);
  const spaceName = space?.["name"];
  if (!space || !isSpaceName(spaceName) || !message) return { ignored: "malformed" };
  const messageName = message["name"];
  if (!isMessageNameIn(messageName, spaceName)) return { ignored: "malformed" };
  const threadName = rec(message["thread"])?.["name"];
  if (threadName !== undefined && !isThreadNameIn(threadName, spaceName)) return { ignored: "malformed" };
  if (sender?.["type"] !== "HUMAN") return { ignored: "not-a-human" };
  const senderName = str(sender["name"]);
  if (senderName === undefined || !/^users\/[A-Za-z0-9_-]{1,128}$/u.test(senderName)) return { ignored: "malformed" };
  const spaceType = str(space["spaceType"]) ?? (space["type"] === "DM" ? "DIRECT_MESSAGE" : "SPACE");
  const spaceKind: GoogleChatMessageEvent["spaceKind"] =
    spaceType === "DIRECT_MESSAGE" ? (space["singleUserBotDm"] === true ? "dm" : "group") : spaceType === "GROUP_CHAT" ? "group" : "space";
  const annotations = Array.isArray(message["annotations"]) ? message["annotations"] : [];
  const mentionsApp = annotations.some((a) => {
    const an = rec(a);
    return an?.["type"] === "USER_MENTION" && rec(rec(an["userMention"])?.["user"])?.["type"] === "BOT";
  });
  const slash = rec(message["slashCommand"]) !== undefined;
  const text = (str(message["argumentText"]) ?? str(message["text"]) ?? "").trim();
  const domainId = str(sender["domainId"]);
  const displayName = str(sender["displayName"]);
  return {
    event: {
      space: spaceName,
      spaceKind,
      messageName,
      ...(threadName !== undefined ? { thread: threadName } : {}),
      threadReply: message["threadReply"] === true && threadName !== undefined,
      sender: senderName,
      ...(displayName !== undefined ? { senderName: displayName } : {}),
      ...(domainId !== undefined ? { domainId } : {}),
      text,
      addressed: mentionsApp || slash,
      createTime: str(message["createTime"]) ?? str(e["eventTime"]) ?? new Date(0).toISOString(),
    },
  };
}

function googleChatSenderTrust(policy: GoogleChatPolicy, domainId: string | undefined): "internal" | "external" {
  return domainId !== undefined && policy.internalDomainIds.includes(domainId) ? "internal" : "external";
}

function planGoogleChatWake(
  input: { readonly event: GoogleChatMessageEvent; readonly policy: GoogleChatPolicy; readonly route: "room" | "dm" },
  wakeTrust: GoogleChatFrontDeps["wakeTrust"],
): GoogleChatWakePlan {
  const { event, policy, route } = input;
  const trustTier = googleChatSenderTrust(policy, event.domainId);
  const surfaceKey = googleChatSurfaceKey(policy, event.space);
  const base = buildGoogleChatAuth({
    workspace: policy.workspace,
    space: event.space,
    mode: route === "dm" ? "dm" : "channel",
    trust: trustTier,
    sender: event.sender,
    ...(event.thread !== undefined ? { thread: event.thread } : {}),
    messageName: event.messageName,
  });
  const trust = wakeTrust(base, event.sender);
  const ingested: IngestedChatMessage[] = [{ trust, refuted: trustTier === "external" }];
  const auth = stampNonMemberChatAuth(base as OpenEverywhereGoogleChatAuth & { attributes: Record<string, unknown> }, ingested, route === "dm" ? { dm: true } : { surfaceKey }) as OpenEverywhereGoogleChatAuth;
  const body =
    event.text === ""
      ? "(the message had no text)"
      : event.text.length > GOOGLE_CHAT_MAX_INBOUND_CHARS
        ? `${event.text.slice(0, GOOGLE_CHAT_MAX_INBOUND_CHARS)}\n[… the message was cut at ${GOOGLE_CHAT_MAX_INBOUND_CHARS} characters]`
        : event.text;
  return {
    surfaceKey,
    route,
    auth,
    origin: {
      platform: "google-chat",
      workspace: policy.workspace,
      space: event.space,
      ...(event.thread !== undefined ? { thread: event.thread } : {}),
      messageName: event.messageName,
      ...(event.threadReply ? { threadReply: true as const } : {}),
    },
    trigger: {
      from: "human",
      author: event.senderName ?? event.sender,
      authorId: event.sender,
      id: event.messageName,
      sentAt: event.createTime,
      trust,
      mention: true,
      body,
    },
    trust: trustTier,
    ingested,
    event,
  };
}

function buildGoogleChatWake(plan: GoogleChatWakePlan, wakeId: string, tail?: readonly WakeMessageInput[]): NormalizedWake {
  return {
    platform: "google-chat",
    reason: plan.route === "dm" ? "dm" : "mention",
    addressing: "direct-mention",
    containerNoun: "space",
    wakeId,
    locus: { channel: { id: plan.origin.space }, ...(plan.origin.thread !== undefined ? { thread: { ts: plan.origin.thread } } : {}) },
    backscroll: tail && tail.length > 0 ? tail : undefined,
    trigger: mkMessageTrigger(plan.trigger),
  };
}

export function renderGoogleChatWake(plan: GoogleChatWakePlan, wakeId: string, tail?: readonly WakeMessageInput[]): { message: string; context: readonly string[] } {
  const r = renderWake(buildGoogleChatWake(plan, wakeId, tail));
  return { message: r.message, context: r.context ?? [] };
}

async function verifyGoogleChatDelivery(
  authorization: string | undefined,
  deps: Pick<GoogleChatFrontDeps, "policy" | "chatSystemKeys" | "googleOidcKeys">,
): Promise<{ readonly ok: true; readonly policy: GoogleChatPolicy } | { readonly ok: false; readonly outcome: GoogleChatFrontOutcome }> {
  const policy = deps.policy();
  if (!policy.enabled || policy.audience === null) return { ok: false, outcome: { kind: "not-configured" } };
  const verdict = await verifyGoogleChatToken(authorization, policy.audience, deps);
  if (!verdict.ok) return { ok: false, outcome: { kind: "unauthorized", reason: verdict.reason } };
  return { ok: true, policy };
}

async function processVerifiedGoogleChatEvent(policy: GoogleChatPolicy, rawBody: string, deps: GoogleChatFrontDeps): Promise<GoogleChatFrontOutcome> {
  const parsed = parseGoogleChatEvent(rawBody);
  if ("ignored" in parsed) return { kind: "ignored", why: parsed.ignored };
  const event = parsed.event;
  if (event.spaceKind === "space" && !event.addressed) return { kind: "ignored", why: "not-addressed" };
  if (!(await deps.markSeen(`google-chat:${event.messageName}`))) return { kind: "duplicate" };

  const surfaceKey = googleChatSurfaceKey(policy, event.space);
  const refuse = async (reason: GoogleChatRefusal): Promise<GoogleChatFrontOutcome> => {
    await deps.audit({
      action: "google-chat.refused",
      workspace: policy.workspace,
      surface: surfaceKey,
      principalId: event.sender,
      detail: { reason, space: event.space, domainId: event.domainId ?? null },
    });
    return { kind: "refused", reason };
  };
  if (event.spaceKind === "group") return refuse("group-chat");
  const route: "room" | "dm" = event.spaceKind === "dm" ? "dm" : "room";
  if (route === "dm") {
    if (!policy.directMessages) return refuse("dm-off");
    if (googleChatSenderTrust(policy, event.domainId) !== "internal") return refuse("external-dm");
  } else if (!deps.roomHasSeat(surfaceKey)) {
    return refuse("no-domain");
  }

  const plan = planGoogleChatWake({ event, policy, route }, deps.wakeTrust);
  if (route === "room") await deps.dispatchRoom(plan);
  else await deps.dispatchDm(plan);
  await deps.audit({
    action: "google-chat.admitted",
    workspace: policy.workspace,
    surface: plan.surfaceKey,
    principalId: event.sender,
    detail: { space: event.space, route, trust: plan.trust, domainId: event.domainId ?? null, threadReply: event.threadReply },
  });
  return { kind: "admitted", route, surfaceKey: plan.surfaceKey };
}

export async function handleGoogleChatDelivery(authorization: string | undefined, rawBody: string, deps: GoogleChatFrontDeps): Promise<GoogleChatFrontOutcome> {
  const v = await verifyGoogleChatDelivery(authorization, deps);
  if (!v.ok) return v.outcome;
  return processVerifiedGoogleChatEvent(v.policy, rawBody, deps);
}

export const GOOGLE_CHAT_INGRESS_MAX_BODY_BYTES = 512 * 1024;

export async function handleGoogleChatRequest(
  req: Request,
  waitUntil: (p: Promise<unknown>) => void,
  deps: GoogleChatFrontDeps,
  hooks: { readonly log?: (msg: string) => void; readonly onFailure?: (err: unknown, policy: GoogleChatPolicy) => Promise<void> } = {},
): Promise<Response> {
  const log = hooks.log ?? (() => undefined);
  const verified = await verifyGoogleChatDelivery(req.headers.get("authorization") ?? undefined, deps);
  if (!verified.ok) {
    if (verified.outcome.kind === "unauthorized") {
      log(`delivery refused (401): ${verified.outcome.reason}`);
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("google chat surface not configured", { status: 503 });
  }
  const read = await readCappedBody(req, GOOGLE_CHAT_INGRESS_MAX_BODY_BYTES);
  if ("tooLarge" in read) return new Response(`payload exceeds ${GOOGLE_CHAT_INGRESS_MAX_BODY_BYTES} bytes`, { status: 413 });
  waitUntil(
    processVerifiedGoogleChatEvent(verified.policy, read.body, deps)
      .then((outcome) =>
        log(
          `event ${outcome.kind}${outcome.kind === "refused" ? ` (${outcome.reason})` : outcome.kind === "admitted" ? ` → ${outcome.route} ${outcome.surfaceKey}` : outcome.kind === "ignored" ? ` (${outcome.why})` : ""}`,
        ),
      )
      .catch(async (err: unknown) => {
        log(`event FAILED after the ack: ${err instanceof Error ? err.name : "error"}`);
        await hooks.onFailure?.(err, verified.policy);
      }),
  );
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}
