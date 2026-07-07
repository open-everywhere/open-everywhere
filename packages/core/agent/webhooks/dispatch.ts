import type { RouteHandlerArgs } from "eve/channels";
import slack from "../channels/slack.js";
import { confirmChannelInternal, NO_REPLY_SENTINEL } from "../channels/slack-events.js";
import { scopeOverBudget } from "../spend/check.js";
import type { Partition } from "../memory/partition.js";
import { wrapUntrusted } from "../access/untrusted.js";
import { emitTelemetry } from "../observability/telemetry.js";
import type { WebhookHook } from "./config.js";

export function webhookOrg(): string {
  return process.env.OE_ORG?.trim() || "default";
}

export function renderWebhookMessage(hook: WebhookHook, rawBody: string): string {
  return [
    `[webhook] The "${hook.id}" webhook just fired. Judge whether this warrants a reply in this ` +
      `channel: if the payload doesn't need action, comment, or acknowledgement, output exactly ` +
      `${NO_REPLY_SENTINEL} and nothing else — nothing will be posted.`,
    "",
    hook.instruction,
    "",
    wrapUntrusted(rawBody, { source: `webhook:${hook.id}` }),
  ].join("\n");
}

export interface WebhookFireResult {
  readonly fired: boolean;
  readonly reason?: string;
}

export async function fireWebhook(
  hook: WebhookHook,
  rawBody: string,
  args: {
    readonly receive: RouteHandlerArgs["receive"];
    readonly now?: Date;
    readonly confirmInternal?: (channelId: string) => Promise<boolean>;
  },
): Promise<WebhookFireResult> {
  const now = args.now ?? new Date();
  const confirmInternal = args.confirmInternal ?? confirmChannelInternal;
  const [, teamId, channelId] = hook.target.split("/");
  const org = webhookOrg();
  const workspaceKey = `slack/${teamId}`;
  const surfaceKey = `${workspaceKey}/${channelId}`;
  const partition: Partition = { org, platform: "slack", workspace: teamId, surface: channelId, workspaceKey, surfaceKey, key: surfaceKey };
  const mode = "channel" as const;

  try {
    const verdict = await scopeOverBudget(partition, mode, now.toISOString());
    if (verdict.over) {
      emitTelemetry("oe.feature.used", { "oe.feature": "webhook_received", "oe.outcome": "failed" });
      return { fired: false, reason: verdict.reason ?? "over budget" };
    }
  } catch {
  }

  const internal = await confirmInternal(channelId).catch(() => false);

  const auth = {
    authenticator: "webhook",
    principalType: "service",
    principalId: `webhook:${hook.id}`,
    attributes: {
      team_id: teamId,
      channel_id: channelId,
      channel_type: "channel",
      ...(internal ? { is_ext_shared: "false", trust_checked: "true" } : {}),
      open_everywhere_webhook_id: hook.id,
    },
  };

  await args.receive(slack, { message: renderWebhookMessage(hook, rawBody), target: { channelId }, auth });
  emitTelemetry("oe.feature.used", { "oe.feature": "webhook_received", "oe.outcome": "ok" });
  return { fired: true };
}
