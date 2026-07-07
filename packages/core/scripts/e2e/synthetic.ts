import { createHmac } from "node:crypto";
import type { SyntheticConfig } from "./env.js";

export const SYNTHETIC_SLACK_ROUTE = "/eve/v1/slack";
export const SYNTHETIC_COMMANDS_ROUTE = "/eve/v1/slack/commands";
export const APPROVAL_PREFIX = "oe_approval:";

export interface SlackSignature {
  readonly timestamp: string;
  readonly signature: string;
}

export function signSlackRequest(rawBody: string, signingSecret: string, nowMs: number = Date.now()): SlackSignature {
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return { timestamp, signature };
}

export interface ApprovalClickInput {
  readonly pendingId: string;
  readonly decision: "approve" | "reject";
  readonly userId: string;
  readonly channelId: string;
  readonly messageTs: string;
}

export function buildApprovalClickPayload(input: ApprovalClickInput): Record<string, unknown> {
  return {
    type: "block_actions",
    user: { id: input.userId },
    channel: { id: input.channelId },
    message: { ts: input.messageTs },
    actions: [{ action_id: `${APPROVAL_PREFIX}${input.decision}:${input.pendingId}`, type: "button" }],
  };
}

export function encodeInteractionBody(payload: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export interface SlashCommandInput {
  readonly text: string;
  readonly userId: string;
  readonly channelId: string;
  readonly teamId?: string;
}

export function buildSlashCommandBody(input: SlashCommandInput): string {
  return new URLSearchParams({
    command: "/oe",
    text: input.text,
    user_id: input.userId,
    channel_id: input.channelId,
    team_id: input.teamId ?? "",
  }).toString();
}

export interface SyntheticResult {
  readonly status: number;
  readonly body: string;
  readonly label: "synthetic click" | "synthetic command";
}

export class SyntheticSlack {
  constructor(private readonly cfg: SyntheticConfig) {}

  private async signedPost(route: string, rawBody: string, label: SyntheticResult["label"]): Promise<SyntheticResult> {
    const { timestamp, signature } = signSlackRequest(rawBody, this.cfg.signingSecret);
    const res = await fetch(`${this.cfg.targetUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });
    return { status: res.status, body: await res.text(), label };
  }

  async click(input: Omit<ApprovalClickInput, "userId" | "channelId"> & { userId?: string; channelId?: string }): Promise<SyntheticResult> {
    const payload = buildApprovalClickPayload({
      ...input,
      userId: input.userId ?? this.cfg.adminUserId,
      channelId: input.channelId ?? this.cfg.channel,
    });
    return this.signedPost(SYNTHETIC_SLACK_ROUTE, encodeInteractionBody(payload), "synthetic click");
  }

  async slash(text: string): Promise<SyntheticResult> {
    const body = buildSlashCommandBody({ text, userId: this.cfg.adminUserId, channelId: this.cfg.channel });
    return this.signedPost(SYNTHETIC_COMMANDS_ROUTE, body, "synthetic command");
  }
}
