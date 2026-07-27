import type { RouteHandlerArgs } from "eve/channels";
import { bridgeSlackChannel, bridgeConfirmChannelInternal } from "../channels/slack-bridge.js";
import { NO_REPLY_SENTINEL } from "../channels/turn-delivery.js";
import { scopeOverBudget } from "../spend/check.js";
import type { Partition } from "../memory/partition.js";
import { ingestUntrusted } from "../access/untrusted.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { webhookFireAttributes } from "../routines/fire-auth.js";
import { checkFireDisclosure } from "../routines/fire-disclosure.js";
import { divertTriggeredFire, runFireSeatKey, type FireWindowDeps } from "../routines/fire-window.js";
import { mintWakeId } from "../channels/unified-window.js";
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
    ingestUntrusted(rawBody, { source: `webhook:${hook.id}` }),
  ].join("\n");
}

export interface WebhookFireResult {
  readonly fired: boolean;
  readonly reason?: string;
}

export const WEBHOOK_AUDIENCE_FLOOR_REASON =
  'audience floor "guest": the target channel is externally shared (Slack Connect / org-shared) or carries an observed ' +
  "guest member, so a config hook must not fire sender-controlled payload content into it. Point the hook at an internal " +
  "channel, or remove the external members — it resumes by itself on the next delivery.";

export async function fireWebhook(
  hook: WebhookHook,
  rawBody: string,
  args: {
    readonly receive: RouteHandlerArgs["receive"];
    readonly now?: Date;
    readonly confirmInternal?: (channelId: string) => Promise<boolean>;
    readonly fireWindow?: FireWindowDeps;
  },
): Promise<WebhookFireResult> {
  const now = args.now ?? new Date();
  const confirmInternal = args.confirmInternal ?? bridgeConfirmChannelInternal;
  const slackChannel = bridgeSlackChannel();
  if (!slackChannel) {
    emitTelemetry("oe.feature.used", { "oe.feature": "webhook_received", "oe.outcome": "failed" });
    return { fired: false, reason: "no Slack provider registered (registerSlackProvider) — webhook fires target Slack channels" };
  }
  const [, teamId, channelId] = hook.target.split("/");
  const org = webhookOrg();
  const workspaceKey = `slack/${teamId}`;
  const surfaceKey = `${workspaceKey}/${channelId}`;
  const partition: Partition = { org, platform: "slack", workspace: teamId, surface: channelId, workspaceKey, surfaceKey, key: surfaceKey };
  const isDm = channelId.startsWith("D");
  const mode = "channel" as const;

  const disclosure = await checkFireDisclosure(surfaceKey);
  if (!disclosure.ok) {
    emitTelemetry("oe.feature.used", { "oe.feature": "webhook_received", "oe.outcome": "failed" });
    return { fired: false, reason: WEBHOOK_AUDIENCE_FLOOR_REASON };
  }

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
    attributes: webhookFireAttributes(hook.id, teamId, channelId, isDm, internal),
  };

  const message = renderWebhookMessage(hook, rawBody);
  const fireWakeId = mintWakeId();
  const diverted = await divertTriggeredFire(
    args.receive,
    {
      message,
      surfaceKey,
      origin: { platform: "slack", channelId },
      seatKey: runFireSeatKey(fireWakeId),
      auth,
      wakeId: fireWakeId,
    },
    args.fireWindow ?? {},
  );
  if (!diverted) await args.receive(slackChannel, { message, target: { channelId }, auth });
  emitTelemetry("oe.feature.used", { "oe.feature": "webhook_received", "oe.outcome": "ok" });
  return { fired: true };
}
