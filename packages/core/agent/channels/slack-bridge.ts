import type { Channel } from "eve/channels";
import type { BindableContext } from "../identity/binding.js";

export type SlackFormFn = (method: string, body: string, token?: string) => Promise<Record<string, unknown> | undefined>;

export type SlackReadCallFn = (
  operation: string,
  params: Record<string, string | number | boolean>,
) => Promise<{ readonly ok: boolean; readonly error?: string; readonly [key: string]: unknown }>;

export interface SlackBridge {
  readonly form: SlackFormFn;
  readonly readCall: SlackReadCallFn;
  readonly fetchUserDisplayName: (userId: string) => Promise<string | undefined>;
  readonly fetchChannelDisplayName: (channelId: string) => Promise<string | undefined>;
  readonly botDisplayName: () => Promise<string | undefined>;
  readonly confirmChannelInternal: (channelId: string) => Promise<boolean>;
  readonly partnerFactsFromInfo: (info: unknown, expectedTeamId?: string) => { dmPartnerTrust: "internal" | "external" };
  readonly readableChannelList: (ctx: BindableContext) => string[];
  readonly channel: Channel<any, any, any>;
}

let bridge: SlackBridge | null = null;

export function registerSlackBridge(b: SlackBridge): void {
  bridge = b;
}

export function _resetSlackBridgeForTest(): void {
  bridge = null;
}

export function slackBridge(): SlackBridge | null {
  return bridge;
}

export const bridgeSlackForm: SlackFormFn = async (method, body, token) =>
  bridge ? bridge.form(method, body, token) : undefined;

export const bridgeSlackReadCall: SlackReadCallFn = async (operation, params) => {
  if (!bridge) throw new Error("no Slack provider is registered — the Slack Web API is unavailable (registerSlackProvider).");
  return bridge.readCall(operation, params);
};

export async function bridgeFetchUserDisplayName(userId: string): Promise<string | undefined> {
  return bridge ? bridge.fetchUserDisplayName(userId) : undefined;
}

export async function bridgeFetchChannelDisplayName(channelId: string): Promise<string | undefined> {
  return bridge ? bridge.fetchChannelDisplayName(channelId) : undefined;
}

export async function bridgeBotDisplayName(): Promise<string | undefined> {
  return bridge ? bridge.botDisplayName() : undefined;
}

export async function bridgeConfirmChannelInternal(channelId: string): Promise<boolean> {
  return bridge ? bridge.confirmChannelInternal(channelId) : false;
}

export function bridgePartnerFactsFromInfo(info: unknown, expectedTeamId?: string): { dmPartnerTrust: "internal" | "external" } {
  return bridge ? bridge.partnerFactsFromInfo(info, expectedTeamId) : { dmPartnerTrust: "external" };
}

export function bridgeReadableChannelList(ctx: BindableContext): string[] {
  return bridge ? bridge.readableChannelList(ctx) : [];
}

export function bridgeSlackChannel(): Channel<any, any, any> | undefined {
  return bridge?.channel;
}
