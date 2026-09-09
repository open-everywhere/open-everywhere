import { AsyncLocalStorage } from "node:async_hooks";
import {
  declaredWorkspaceTrust,
  rootDmGrainAttrs,
  surfaceKeySegment,
  type BindableContext,
  type IdentityMapper,
  type RawIdentity,
  type SessionMode,
  type Visibility,
} from "@open-everywhere/core/agent/adapter-api.js";

export interface OpenEverywhereSlackAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface SlackIdentityInput {
  readonly userId: string;
  readonly teamId?: string;
  readonly enterpriseId?: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly channelType?: string;
  readonly isPrivate?: boolean;
  readonly isExternal?: boolean;
  readonly trustChecked?: boolean;
  readonly dmPartnerTrust?: "internal" | "external";
}

export function buildSlackAuth(input: SlackIdentityInput): OpenEverywhereSlackAuth {
  const attributes: Record<string, string> = {
    channel_id: input.channelId,
    user_id: input.userId,
  };
  if (input.teamId) attributes.team_id = input.teamId;
  if (input.enterpriseId) attributes.enterprise_id = input.enterpriseId;
  if (input.threadTs) attributes.thread_ts = input.threadTs;
  if (input.channelType) attributes.channel_type = input.channelType;
  if (typeof input.isPrivate === "boolean") attributes.is_private = String(input.isPrivate);
  if (typeof input.isExternal === "boolean") attributes.is_ext_shared = String(input.isExternal);
  if (typeof input.trustChecked === "boolean") attributes.trust_checked = String(input.trustChecked);
  if (input.dmPartnerTrust) attributes.dm_partner_trust = input.dmPartnerTrust;
  const isDmFamily = input.channelType === "im" || input.channelType === "mpim" || (input.channelType === undefined && input.channelId.startsWith("D"));
  Object.assign(attributes, rootDmGrainAttrs(isDmFamily));
  return { authenticator: "slack", principalId: input.userId, principalType: "slack-user", attributes };
}

export interface ForwardedSlackEnvelope {
  readonly enterpriseId: string;
  readonly channelId: string;
  readonly ts: string;
}

const forwardedEnvelope = new AsyncLocalStorage<ForwardedSlackEnvelope>();

export function withForwardedSlackEnvelope<T>(envelope: ForwardedSlackEnvelope | undefined, fn: () => T): T {
  return envelope === undefined ? fn() : forwardedEnvelope.run(envelope, fn);
}

export function forwardedSlackEnterpriseId(message: { readonly channelId: string; readonly ts: string }): string | undefined {
  const carried = forwardedEnvelope.getStore();
  if (!carried) return undefined;
  return carried.channelId === message.channelId && carried.ts === message.ts ? carried.enterpriseId : undefined;
}

export interface ChannelFacts {
  readonly channelType?: string;
  readonly isPrivate?: boolean;
  readonly isExternal?: boolean;
  readonly trustChecked?: boolean;
  readonly appInChannel?: boolean;
  readonly dmPartnerTrust?: "internal" | "external";
}

function enterpriseIdOfUser(u: Record<string, unknown>): string | undefined {
  const eu = u["enterprise_user"];
  if (!eu || typeof eu !== "object") return undefined;
  const id = (eu as Record<string, unknown>)["enterprise_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function slackWorkspaceVouched(teamId: string | undefined, enterpriseId: string | undefined): boolean {
  const team = surfaceKeySegment(teamId);
  if (team.length === 0) return false;
  const enterprise = surfaceKeySegment(enterpriseId);
  return (
    declaredWorkspaceTrust(`slack/${team}`, enterprise.length === 0 ? undefined : `slack/${enterprise}`) === "internal"
  );
}

export function partnerFactsFromInfo(info: unknown, expectedTeamId?: string): { dmPartnerTrust: "internal" | "external" } {
  const u = (info as { user?: Record<string, unknown> } | null)?.user;
  if (!u || typeof u !== "object") return { dmPartnerTrust: "external" };
  const guestOrStranger = Boolean(u["is_restricted"] || u["is_ultra_restricted"] || u["is_stranger"]);
  const deleted = Boolean(u["deleted"]);
  const homeTeamId = typeof u["team_id"] === "string" ? (u["team_id"] as string) : undefined;
  const ownWorkspace = expectedTeamId !== undefined && expectedTeamId.length > 0 && homeTeamId === expectedTeamId;
  const admittedWorkspace = ownWorkspace || slackWorkspaceVouched(homeTeamId, enterpriseIdOfUser(u));
  const internal = !guestOrStranger && !deleted && admittedWorkspace;
  return { dmPartnerTrust: internal ? "internal" : "external" };
}

export function channelFactsFromRaw(raw: Record<string, unknown>): ChannelFacts {
  const channelType = typeof raw["channel_type"] === "string" ? (raw["channel_type"] as string) : undefined;
  return { channelType };
}

export function channelFactsFromInfo(info: unknown): ChannelFacts {
  const ch = (info as { channel?: Record<string, unknown> } | null)?.channel;
  if (!ch || typeof ch !== "object") return {};
  const isPrivate = typeof ch["is_private"] === "boolean" ? (ch["is_private"] as boolean) : undefined;
  const isExternal = Boolean(
    ch["is_ext_shared"] || ch["is_org_shared"] || ch["is_shared"] || ch["is_pending_ext_shared"],
  );
  let channelType: string | undefined;
  if (ch["is_im"]) channelType = "im";
  else if (ch["is_mpim"]) channelType = "mpim";
  else if (ch["is_group"] || ch["is_private"]) channelType = "group";
  else if (ch["is_channel"]) channelType = "channel";
  const appInChannel = typeof ch["is_member"] === "boolean" ? (ch["is_member"] as boolean) : undefined;
  return { channelType, isPrivate, isExternal, trustChecked: true, ...(appInChannel === undefined ? {} : { appInChannel }) };
}

export function appCanReadConversation(facts: ChannelFacts): boolean {
  if (facts.trustChecked !== true) return false;
  if (facts.channelType === "im" || facts.channelType === "mpim") return true;
  return facts.appInChannel === true;
}

type Trust = NonNullable<RawIdentity["trust"]>;

export function slackMode(channelType: string | undefined, channelId: string | undefined): SessionMode {
  if (channelType === "im") return "dm";
  if (channelType === "mpim") return "mpim";
  if (channelType === "channel" || channelType === "group") return "channel";
  if (channelId && channelId.startsWith("D")) return "dm";
  return "channel";
}

export function slackVisibility(
  channelType: string | undefined,
  isPrivate: string | undefined,
  mode: SessionMode,
): Visibility {
  if (isPrivate === "true") return "private";
  if (isPrivate === "false") return "public";
  if (mode === "dm" || mode === "mpim") return "private";
  if (channelType === "channel") return "public";
  return "private";
}

export function slackTrust(
  isExternal: string | undefined,
  trustChecked: string | undefined,
  mode: SessionMode,
): Trust {
  if (mode === "dm") return "internal";
  if (isExternal === "true") return "external";
  if (mode === "mpim") return "internal";
  if (trustChecked !== "true") return "external";
  return "internal";
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function slackAuthOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function slackAttr(a: AuthAttrs, keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

function slackAuthPrincipalId(ctx: BindableContext): string | undefined {
  const pid = slackAuthOf(ctx)?.principalId;
  return pid && pid.length > 0 ? pid : undefined;
}

function rawSlackPrincipal(pid: string | undefined): string | undefined {
  if (!pid || !pid.startsWith("slack:")) return pid;
  const last = pid.slice(pid.lastIndexOf(":") + 1);
  return last.length > 0 ? last : undefined;
}

export const bindSlack: IdentityMapper = (ctx): RawIdentity => {
  const a = slackAuthOf(ctx)?.attributes;
  const channelId = slackAttr(a, ["channel_id", "channelId"]);
  const channelType = slackAttr(a, ["channel_type", "channelType"]);
  const isPrivate = slackAttr(a, ["is_private", "isPrivate"]);
  const mode = slackMode(channelType, channelId);
  const dmRaw = slackAttr(a, ["dm_partner_trust", "dmPartnerTrust"]);
  const dmPartnerTrust: Trust | undefined = dmRaw === "internal" || dmRaw === "external" ? dmRaw : undefined;
  return {
    workspace: slackAttr(a, ["team_id", "teamId"]),
    trustEnterprise: slackAttr(a, ["enterprise_id", "enterpriseId"]),
    surface: channelId,
    mode,
    visibility: slackVisibility(channelType, isPrivate, mode),
    trust: mode === "dm" ? dmPartnerTrust : slackTrust(slackAttr(a, ["is_ext_shared", "isExtShared"]), slackAttr(a, ["trust_checked", "trustChecked"]), mode),
    trustVerified: mode === "dm" ? dmPartnerTrust !== undefined : undefined,
    principalId: rawSlackPrincipal(slackAuthPrincipalId(ctx)) ?? slackAttr(a, ["user_id", "userId"]),
    target: channelId ? { channelId } : undefined,
    threadTs: slackAttr(a, ["thread_ts", "threadTs"]) ?? slackAttr(a, ["oe_reply_anchor", "oeReplyAnchor"]),
  };
};
