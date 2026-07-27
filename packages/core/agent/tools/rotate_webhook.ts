import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { principalIdOf, resolveMode } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { getOperationalStore } from "../operational/provider.js";
import { hasPrivateDeliveryPath } from "./create_webhook.js";
import { revealPageAvailable } from "../webhooks/reveal-page.js";
import { hookAcquisition, isDeletableHookStatus } from "../webhooks/runtime-hook.js";
import { rotateAcquisitionRefusal } from "../webhooks/provisioning.js";
import { webhookScheme } from "../routines/scheme-name.js";

export default defineTool({
  description:
    "Issue a NEW signing secret for a webhook that already exists here, and send it privately as a one-time link. Use when someone lost the secret, thinks it leaked, or is rotating on a schedule. The old secret keeps working for a grace period so whatever is sending doesn't break while they update it. There is deliberately no way to re-show an existing secret — rotating IS the way to recover one. A card is posted for a human to approve first.",
  inputSchema: z.object({
    source: z.string().min(1).describe("Which webhook, by the source name it was set up under (see list_webhooks)."),
  }),
  outputSchema: z.object({
    rotated: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    source: z.string(),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "rotate_webhook");

    if (untrustedIngestedThisTurn()) {
      throw new Error(
        "I've read external content this turn, so I won't re-mint a webhook's signing secret right now — that shouldn't be proposed off something I just read. Ask me again in a fresh message.",
      );
    }

    const mode = resolveMode(ctx);
    if (mode === "mpim") throw new Error("Group DMs are execution-only — rotate from a channel or a DM instead.");

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(`Rotating a webhook secret needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}".`);
    }
    if (!hasPrivateDeliveryPath(binding.platform) || !revealPageAvailable()) {
      throw new Error(
        `I can't hand over a new signing secret from "${binding.platform}" — it needs a surface where I can send you a private message, and a deployment configured to serve one-time links. Rotating without being able to give you the result would just break the webhook.`,
      );
    }

    const p = resolvePartition(ctx);
    const source = input.source.trim().toLowerCase();
    const hook = await getOperationalStore().getWebhookHookBySource(p.org, source);
    if (!hook) {
      throw new Error(`There's no "${source}" webhook here. Use list_webhooks to see what exists, or create_webhook to set one up.`);
    }
    if (isDeletableHookStatus(hook.status)) {
      throw new Error(
        `The "${source}" webhook is ${hook.status} — its setup was started but never finished, so there's no signing secret to rotate yet. Finish setting it up; rotation only applies to a live hook.`,
      );
    }
    if (hook.status !== "active") {
      throw new Error(`There's no active "${source}" webhook here — it's ${hook.status}. Use list_webhooks to see what exists, or create_webhook to set one up.`);
    }

    const acquisition = hookAcquisition(hook);
    const refusal = rotateAcquisitionRefusal(acquisition, hook.source, webhookScheme(hook));
    if (refusal) throw new Error(refusal);

    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) throw new Error("rotate_webhook needs a verified sender — there's no requester to show on the approval card.");
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("rotate_webhook couldn't resolve this channel's id for the approval card — try again from a real channel.");

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "webhook.rotate",
        args: {
          org: p.org,
          id: hook.id,
          source: hook.source,
          ...(hook.scheme && hook.scheme !== hook.source ? { scheme: hook.scheme } : {}),
          ...(acquisition !== "mint" ? { provisioning: acquisition } : {}),
          posture: hook.posture,
          surfaceKey: p.surfaceKey,
          requestedBy,
          platform: binding.platform,
          channelId,
        },
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    return {
      rotated: false,
      pending: true,
      pendingId: posted.id,
      source,
      message: `card posted — rotating the "${source}" webhook's secret, awaiting a human to approve it (pending ${posted.id}). On approval they get a private one-time link with the new secret.`,
    };
  },
});
