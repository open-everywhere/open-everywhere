import type { Channel } from "eve/channels";
import type { BindableContext } from "../identity/binding.js";
import { processRegistrySlot } from "../lib/process-registry.js";

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

const bridgeSlot = processRegistrySlot<SlackBridge>("slack-bridge.v1");

export function registerSlackBridge(b: SlackBridge): void {
  bridgeSlot.set(b);
}

export function _resetSlackBridgeForTest(): void {
  bridgeSlot.set(null);
}

export function slackBridge(): SlackBridge | null {
  return bridgeSlot.get();
}

export const bridgeSlackForm: SlackFormFn = async (method, body, token) =>
  bridgeSlot.get() ? bridgeSlot.get()!.form(method, body, token) : undefined;

export const bridgeSlackReadCall: SlackReadCallFn = async (operation, params) => {
  if (!bridgeSlot.get()) throw new Error("no Slack provider is registered — the Slack Web API is unavailable (registerSlackProvider).");
  return bridgeSlot.get()!.readCall(operation, params);
};

export async function bridgeFetchUserDisplayName(userId: string): Promise<string | undefined> {
  return bridgeSlot.get() ? bridgeSlot.get()!.fetchUserDisplayName(userId) : undefined;
}

export async function bridgeFetchChannelDisplayName(channelId: string): Promise<string | undefined> {
  return bridgeSlot.get() ? bridgeSlot.get()!.fetchChannelDisplayName(channelId) : undefined;
}

export async function bridgeBotDisplayName(): Promise<string | undefined> {
  return bridgeSlot.get() ? bridgeSlot.get()!.botDisplayName() : undefined;
}

export async function bridgeConfirmChannelInternal(channelId: string): Promise<boolean> {
  return bridgeSlot.get() ? bridgeSlot.get()!.confirmChannelInternal(channelId) : false;
}

export function bridgePartnerFactsFromInfo(info: unknown, expectedTeamId?: string): { dmPartnerTrust: "internal" | "external" } {
  return bridgeSlot.get() ? bridgeSlot.get()!.partnerFactsFromInfo(info, expectedTeamId) : { dmPartnerTrust: "external" };
}

export function bridgeReadableChannelList(ctx: BindableContext): string[] {
  return bridgeSlot.get() ? bridgeSlot.get()!.readableChannelList(ctx) : [];
}

export function bridgeSlackChannel(): Channel<any, any, any> | undefined {
  return bridgeSlot.get()?.channel;
}
