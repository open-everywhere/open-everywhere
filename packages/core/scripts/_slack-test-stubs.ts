import { callSlackApi } from "eve/channels/slack";
import { registerSlackBridge, bridgeBotDisplayName, slackBridge, type SlackBridge } from "../agent/channels/slack-bridge.js";
import { registerBotDisplayName } from "../agent/identity/bot-display-name.js";
import { registerPostArm } from "../agent/channels/post-arms.js";
import { registerIdentityMapper } from "../agent/identity/binding.js";
import { registerCapabilityManifest } from "../agent/identity/capabilities.js";
import { registerWakeOriginCodec } from "../agent/channels/wake-origin-codec.js";
import type { UnifiedWakeOrigin } from "../agent/channels/unified-window.js";

export async function testSlackForm(
  method: string,
  body: string,
  token: string | undefined = process.env.SLACK_BOT_TOKEN,
): Promise<Record<string, unknown> | undefined> {
  if (!token) return undefined;
  try {
    return (await callSlackApi({
      botToken: token,
      operation: method,
      body: Object.fromEntries(new URLSearchParams(body)),
    })) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function testSlackReadCall(
  operation: string,
  params: Record<string, string | number | boolean>,
): Promise<{ readonly ok: boolean; readonly error?: string; readonly [key: string]: unknown }> {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not set — the Slack read tools need the bot token to call the Web API.");
  }
  const json = (await callSlackApi({ botToken: undefined, operation, body: params })) as {
    readonly ok: boolean;
    readonly error?: string;
    readonly [key: string]: unknown;
  };
  if (!json.ok) throw new Error(`Slack ${operation} failed: ${json.error ?? "unknown error"}`);
  return json;
}

export function registerSlackTestBridge(overrides: Partial<SlackBridge> = {}): void {
  registerBotDisplayName("slack", () => bridgeBotDisplayName());
  registerSlackBridge({
    form: testSlackForm,
    readCall: testSlackReadCall,
    fetchUserDisplayName: async () => undefined,
    fetchChannelDisplayName: async () => undefined,
    botDisplayName: async () => undefined,
    confirmChannelInternal: async () => false,
    partnerFactsFromInfo: () => ({ dmPartnerTrust: "external" }),
    readableChannelList: () => [],
    channel: {} as never,
    ...overrides,
  });
}

export function registerSlackFixtureManifest(): void {
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
}

export function testPartnerFactsFromInfo(info: unknown, expectedTeamId?: string): { dmPartnerTrust: "internal" | "external" } {
  const u = (info as { user?: Record<string, unknown> } | null)?.user;
  if (!u || typeof u !== "object") return { dmPartnerTrust: "external" };
  const guestOrStranger = Boolean(u["is_restricted"] || u["is_ultra_restricted"] || u["is_stranger"]);
  const deletedOrBot = Boolean(u["deleted"] || u["is_bot"]);
  const sameTeam = expectedTeamId ? u["team_id"] === expectedTeamId : true;
  const internal = !guestOrStranger && !deletedOrBot && sameTeam;
  return { dmPartnerTrust: internal ? "internal" : "external" };
}

export function registerSlackFixtureCodec(): void {
  type SlackOrigin = Extract<UnifiedWakeOrigin, { platform: "slack" }>;
  const noColon = (s: string): string => s.replace(/:/g, "_");
  registerWakeOriginCodec("slack", {
    validate: (o: SlackOrigin) =>
      typeof o.channelId === "string" &&
      o.channelId.length > 0 &&
      (o.threadTs === undefined || typeof o.threadTs === "string") &&
      (o.replyAnchorTs === undefined || typeof o.replyAnchorTs === "string"),
    threadRef: (origin: SlackOrigin) => ({ channelKey: noColon(`slack/${origin.channelId}`), threadKey: noColon(origin.threadTs ?? origin.channelId) }),
    isThreadScoped: (origin: SlackOrigin) => typeof origin.threadTs === "string" && origin.threadTs.length > 0,
    containerId: (origin: SlackOrigin) => origin.channelId,
  });
}

export function registerSlackFixturePostArm(): void {
  type SlackTarget = { platform: "slack"; channelId: string; threadTs?: string };
  type SlackOriginLike = { channelId: string; threadTs?: string; replyAnchorTs?: string };
  const post = async (channelId: string, threadTs: string | undefined, text: string, label: string): Promise<string> => {
    const body = new URLSearchParams({ channel: channelId, text });
    if (threadTs) body.set("thread_ts", threadTs);
    const bridge = slackBridge();
    const res = bridge ? await bridge.form("chat.postMessage", body.toString()) : undefined;
    const ts = typeof res?.ts === "string" ? res.ts : undefined;
    if (res?.ok !== true || !ts) {
      throw new Error(`${label} couldn't post to Slack — ${(res?.error as string) ?? "no ts returned (check the bot token)"}`);
    }
    return ts;
  };
  registerPostArm({
    platform: "slack",
    resolveTarget: (bag) => {
      const channelId = bag.str("channelId");
      return channelId ? { platform: "slack", channelId, threadTs: bag.threadTs } : null;
    },
    dispatchReply: (target, text) => {
      const t = target as SlackTarget;
      return post(t.channelId, t.threadTs, text, "reply");
    },
    dispatchUnified: (origin, text, deps) => {
      const o = origin as unknown as SlackOriginLike;
      const live = (deps as { postSlack?: (origin: unknown, text: string) => Promise<string> }).postSlack;
      if (live) return live(origin as never, text);
      return post(o.channelId, o.threadTs ?? o.replyAnchorTs, text, "unified reply");
    },
    describeRedriveTarget: (origin) => {
      const o = origin as unknown as SlackOriginLike;
      return `slack ${o.threadTs ? `thread in ${o.channelId}` : `channel ${o.channelId}`}`;
    },
    redriveContainerId: (origin) => (origin as unknown as SlackOriginLike).channelId,
  });
}

export function registerSlackFixtureMapper(): void {
  registerIdentityMapper("slack", (c) => {
    const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
    const channelId = a["channel_id"];
    const mode = a["channel_type"] === "im" ? "dm" : a["channel_type"] === "mpim" ? "mpim" : "channel";
    const dmRaw = a["dm_partner_trust"];
    const dmPartnerTrust = dmRaw === "internal" || dmRaw === "external" ? dmRaw : undefined;
    const channelTrust = a["is_ext_shared"] === "true" ? "external" : a["trust_checked"] !== "true" ? "external" : "internal";
    const trust = mode === "dm" ? dmPartnerTrust : channelTrust;
    const trustVerified = mode === "dm" ? dmPartnerTrust !== undefined : undefined;
    const visibility =
      a["is_private"] === "true" ? "private"
      : a["is_private"] === "false" ? "public"
      : mode === "dm" || mode === "mpim" ? "private"
      : a["channel_type"] === "channel" ? "public"
      : "private";
    return {
      workspace: a["team_id"],
      surface: channelId,
      mode,
      visibility,
      trust,
      trustVerified,
      principalId: c.session?.auth?.current?.principalId || a["user_id"] || undefined,
      target: channelId ? { channelId } : undefined,
      threadTs: a["thread_ts"] ?? a["oe_reply_anchor"],
    };
  });
}
