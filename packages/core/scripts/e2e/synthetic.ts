import { createHmac } from "node:crypto";
import type { SyntheticConfig, SyntheticDmConfig } from "./env.js";

export const SYNTHETIC_SLACK_ROUTE = "/eve/v1/slack";
export const SYNTHETIC_COMMANDS_ROUTE = "/eve/v1/slack/commands";
export const APPROVAL_PREFIX = "oe_approval:";
export const CONNECT_ACTION_PREFIX = "oe_connect:";
export const SETKEY_MODAL_CALLBACK = "oe_setkey_modal";
export const SETKEY_INPUT_BLOCK = "oe_setkey_secret_block";
export const SETKEY_INPUT_ACTION = "oe_setkey_secret_input";

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
  readonly decision: "approve" | "reject" | "approve_session";
  readonly userId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly org: string;
  readonly teamId?: string;
}

export function buildApprovalClickPayload(input: ApprovalClickInput): Record<string, unknown> {
  return {
    type: "block_actions",
    user: { id: input.userId },
    channel: { id: input.channelId },
    message: { ts: input.messageTs },
    ...(input.teamId ? { team: { id: input.teamId } } : {}),
    actions: [{ action_id: `${APPROVAL_PREFIX}${input.decision}:${input.pendingId}`, type: "button", value: input.org }],
  };
}

export function encodeInteractionBody(payload: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export interface BlockActionClickInput {
  readonly actionId: string;
  readonly blockId?: string;
  readonly value?: string;
  readonly buttonText?: string;
  readonly userId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
}

export function buildBlockActionPayload(input: BlockActionClickInput): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    type: "block_actions",
    user: { id: input.userId, team_id: input.teamId },
    api_app_id: "A_E2E",
    token: "e2e",
    trigger_id: `${Date.now()}.e2e`,
    team: { id: input.teamId },
    channel: { id: input.channelId },
    container: { type: "message", message_ts: input.messageTs, channel_id: input.channelId, is_ephemeral: false },
    message: { ts: input.messageTs, ...(input.threadTs ? { thread_ts: input.threadTs } : {}), type: "message" },
    response_url: "https://hooks.slack.com/actions/E2E/synthetic/unused",
    actions: [
      {
        type: "button",
        action_id: input.actionId,
        ...(input.blockId ? { block_id: input.blockId } : {}),
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.buttonText ? { text: { type: "plain_text", text: input.buttonText } } : {}),
        action_ts: `${nowSec}.000001`,
      },
    ],
  };
}

export interface ConnectClickInput {
  readonly provider: string;
  readonly credentialType: "api-key" | "service-oauth" | "user-oauth";
  readonly userId: string;
  readonly channelId: string;
  readonly teamId: string;
  readonly org: string;
}

export function buildConnectClickPayload(input: ConnectClickInput): Record<string, unknown> {
  return {
    type: "block_actions",
    user: { id: input.userId },
    channel: { id: input.channelId },
    team: { id: input.teamId },
    actions: [{ action_id: `${CONNECT_ACTION_PREFIX}${input.provider}:${input.credentialType}`, type: "button", value: input.org }],
  };
}

export interface SetKeySubmissionInput {
  readonly org: string;
  readonly intakeId: string;
  readonly channelId: string;
  readonly value: string;
  readonly userId: string;
  readonly teamId: string;
}

export function buildSetKeySubmissionPayload(input: SetKeySubmissionInput): Record<string, unknown> {
  return {
    type: "view_submission",
    user: { id: input.userId },
    team: { id: input.teamId },
    view: {
      callback_id: SETKEY_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ org: input.org, id: input.intakeId, channelId: input.channelId }),
      state: { values: { [SETKEY_INPUT_BLOCK]: { [SETKEY_INPUT_ACTION]: { value: input.value } } } },
    },
  };
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

export function syntheticSlackTs(nowMs: number = Date.now()): string {
  return `${Math.floor(nowMs / 1000)}.${String(nowMs % 1000).padStart(3, "0")}000`;
}

export interface DmEventInput {
  readonly text: string;
  readonly channelId: string;
  readonly userId: string;
  readonly teamId: string;
  readonly ts: string;
  readonly eventId?: string;
}

export function buildDmEventEnvelope(input: DmEventInput): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: input.teamId,
    event_id: input.eventId ?? `EvE2E${input.ts.replace(".", "")}`,
    event_time: Math.floor(Number.parseFloat(input.ts)),
    event: {
      type: "message",
      channel_type: "im",
      channel: input.channelId,
      user: input.userId,
      text: input.text,
      ts: input.ts,
      event_ts: input.ts,
      team: input.teamId,
    },
  };
}

export interface ChannelMentionInput {
  readonly text: string;
  readonly channelId: string;
  readonly userId: string;
  readonly teamId: string;
  readonly ts: string;
  readonly eventId?: string;
}

export function buildChannelMentionEnvelope(input: ChannelMentionInput): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: input.teamId,
    event_id: input.eventId ?? `EvE2EM${input.ts.replace(".", "")}`,
    event_time: Math.floor(Number.parseFloat(input.ts)),
    event: {
      type: "app_mention",
      channel: input.channelId,
      user: input.userId,
      text: input.text,
      ts: input.ts,
      event_ts: input.ts,
      team: input.teamId,
    },
  };
}

export interface SyntheticResult {
  readonly status: number;
  readonly body: string;
  readonly label: "synthetic click" | "synthetic command" | "synthetic DM" | "synthetic mention";
}

export class SyntheticSlack {
  constructor(private readonly cfg: SyntheticConfig) {}

  get adminUserId(): string {
    return this.cfg.adminUserId;
  }

  get org(): string {
    return this.cfg.org;
  }

  private async signedPost(
    route: string,
    rawBody: string,
    label: SyntheticResult["label"],
    contentType = "application/x-www-form-urlencoded",
  ): Promise<SyntheticResult> {
    const { timestamp, signature } = signSlackRequest(rawBody, this.cfg.signingSecret);
    const res = await fetch(`${this.cfg.targetUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });
    return { status: res.status, body: await res.text(), label };
  }

  async click(
    input: Omit<ApprovalClickInput, "userId" | "channelId" | "org"> & { userId?: string; channelId?: string; org?: string },
  ): Promise<SyntheticResult> {
    const payload = buildApprovalClickPayload({
      ...input,
      userId: input.userId ?? this.cfg.adminUserId,
      channelId: input.channelId ?? this.cfg.channel,
      org: input.org ?? this.cfg.org,
    });
    return this.signedPost(SYNTHETIC_SLACK_ROUTE, encodeInteractionBody(payload), "synthetic click");
  }

  async clickBlockAction(
    input: Omit<BlockActionClickInput, "userId" | "channelId"> & { userId?: string; channelId?: string },
  ): Promise<SyntheticResult> {
    const payload = buildBlockActionPayload({
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

  async channelMention(input: { text: string; userId: string; teamId: string; ts: string }): Promise<SyntheticResult> {
    const rawBody = JSON.stringify(buildChannelMentionEnvelope({ ...input, channelId: this.cfg.channel }));
    return this.signedPost(SYNTHETIC_SLACK_ROUTE, rawBody, "synthetic mention", "application/json");
  }

  async connectClick(input: Omit<ConnectClickInput, "userId" | "org"> & { userId?: string; org?: string }): Promise<SyntheticResult> {
    const payload = buildConnectClickPayload({ ...input, userId: input.userId ?? this.cfg.adminUserId, org: input.org ?? this.cfg.org });
    return this.signedPost(SYNTHETIC_SLACK_ROUTE, encodeInteractionBody(payload), "synthetic click");
  }

  async setKeySubmit(input: Omit<SetKeySubmissionInput, "userId"> & { userId?: string }): Promise<SyntheticResult> {
    const payload = buildSetKeySubmissionPayload({ ...input, userId: input.userId ?? this.cfg.adminUserId });
    return this.signedPost(SYNTHETIC_SLACK_ROUTE, encodeInteractionBody(payload), "synthetic click");
  }
}

export class SyntheticDm {
  constructor(private readonly cfg: SyntheticDmConfig) {}

  get dmChannel(): string {
    return this.cfg.dmChannel;
  }

  async message(input: { text: string; userId: string; teamId: string; ts: string; channelId?: string }): Promise<SyntheticResult> {
    const rawBody = JSON.stringify(buildDmEventEnvelope({ ...input, channelId: input.channelId ?? this.cfg.dmChannel }));
    const { timestamp, signature } = signSlackRequest(rawBody, this.cfg.signingSecret);
    const res = await fetch(`${this.cfg.targetUrl}${SYNTHETIC_SLACK_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });
    return { status: res.status, body: await res.text(), label: "synthetic DM" };
  }
}
