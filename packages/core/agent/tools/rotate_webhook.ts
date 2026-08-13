import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalIdOf, resolveMode, unattendedOf } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { requestApproval, postedToSurfaceKey, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { revealPageAvailable } from "../webhooks/reveal-page.js";

export function hasPrivateDeliveryPath(platform: string): boolean {
  return platform === "slack";
}
import { getConfig } from "../access/config.js";
import { configHookPosture, findWebhook } from "../webhooks/config.js";

export default defineTool({
  description:
    "Issue a signing secret for a webhook that exists here, and send it privately as a one-time link. Use when someone lost the secret, thinks it leaked, is rotating on a schedule, or when a newly declared webhook needs its FIRST secret so it can start authenticating — that last case needs no redeploy. There is deliberately no way to re-show an existing secret; issuing a new one IS the way to recover from a lost one. A card is posted for a human to approve first, and it says exactly what stops working and when.",
  inputSchema: z.object({
    source: z.string().min(1).describe("Which webhook — the name it is listed under (see list_webhooks)."),
  }),
  outputSchema: z.object({
    rotated: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    source: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "rotate_webhook");

    const mode = resolveMode(ctx);
    if (mode === "mpim") throw new Error("Group DMs are execution-only — rotate from a channel or a DM instead.");

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(`Rotating a webhook secret needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}".`);
    }
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("rotate_webhook needs a verified sender — a triggered routine fire has no acting sender (only the creator it is attributed to), and there is nobody in a fire to hand a fresh signing secret to. Ask a person in this conversation to rotate it.");
    }
    if (!hasPrivateDeliveryPath(binding.platform) || !revealPageAvailable()) {
      throw new Error(
        `I can't hand over a new signing secret from "${binding.platform}" — it needs a surface where I can send you a private message, and a deployment configured to serve one-time links. Rotating without being able to give you the result would just break the webhook.`,
      );
    }

    const p = resolvePartition(ctx);
    const id = input.source.trim().toLowerCase();
    const declared = findWebhook(getConfig().loadWebhooks?.() ?? [], id);
    if (!declared) {
      throw new Error(`There's no "${id}" webhook declared here. Use list_webhooks to see what exists, or declare_webhook to propose a new one.`);
    }
    if (declared.broker !== "db") {
      const ref = typeof declared.secretRef === "string" ? declared.secretRef : declared.secretRef[0];
      throw new Error(
        `The "${declared.id}" webhook keeps its secret outside this deployment (broker "${declared.broker}"), so I can't issue one for it. ` +
          `An operator sets ${declared.broker === "env" ? `the environment variable \`${ref}\`` : `ref \`${ref}\``} and redeploys. ` +
          `If you'd rather issue it from here in future, its declaration needs changing to \`broker: "db"\` — that's a PR, and I can propose one.`,
      );
    }

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("rotate_webhook couldn't resolve this channel's id for the approval card — try again from a real channel.");

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "webhook.rotate",
        args: {
          org: p.org,
          hookId: declared.id,
          posture: configHookPosture(declared),
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
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(binding.platform),
    );

    const subject = `issuing a fresh signing secret for the "${declared.id}" webhook`;
    if (posted.autoApproved) {
      return {
        rotated: true,
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        source: declared.id,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      rotated: false,
      pending: true,
      pendingId: posted.id,
      source: declared.id,
      message: `card posted — ${subject}, awaiting a human to approve it (pending ${posted.id}). On approval they get a private one-time link with it; nothing needs redeploying.`,
    };
  },
});
