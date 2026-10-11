import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { actingPrincipalIdOf, resolveMode, unattendedOf } from "../access/request.js";
import { bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { requireEmailSenderConfig, emailSenderSentence, EMAIL_SENDERS_DEFAULT_PATH } from "../approvals/email-sender.js";
import { emailPolicy, findEmailInbox, isOwnInbox, type EmailPolicy } from "../email/policy.js";
import { emailDomainOf, normalizeEmailAddress, normalizeSenderRule, senderRuleMatches } from "../email/address.js";
import { nonMemberWake } from "./propose_mcp_server.js";

export function emailSenderAudienceRefusal(binding: Pick<SurfaceBinding, "trust">, opts: { readonly nonMember: boolean; readonly actingPrincipal: string | undefined }): string | undefined {
  if (binding.trust === "external") {
    return "this conversation is external (a shared channel, a guest, an outside account, mail from outside the org, or a mail whose reply reaches someone outside the org), and an allowed sender reaches this deployment's agent by email — so I can't propose one from here. Ask an internal person to propose it, or an admin to add it to agent/email/senders.ts by hand.";
  }
  if (opts.nonMember) return "a message from someone outside the workspace woke this turn, so I can't propose a new email sender from it. Ask again in a conversation with members only.";
  // principal-gate: presence — a proposal opens a config PR in a real person's name, and a triggered fire has nobody here to read the card or own the ask.
  if (opts.actingPrincipal === undefined) {
    return "propose_email_sender needs a person in the conversation — a triggered routine fire has no acting sender, so it may not open a config PR in anyone's name. Ask a person here to request it.";
  }
  return undefined;
}

export function emailSenderInputCheck(policy: EmailPolicy, rawInbox: string, rawSender: string): { readonly inbox: string; readonly sender: string } | { readonly refusal: string } {
  const inbox = normalizeEmailAddress(rawInbox);
  const box = inbox ? findEmailInbox(policy, inbox) : undefined;
  if (!inbox || !box) {
    const rooms = policy.inboxes.filter((b) => b.kind === "room").map((b) => b.address);
    return { refusal: `"${rawInbox}" is not one of this deployment's inboxes.${rooms.length > 0 ? ` The room inboxes are: ${rooms.join(", ")}.` : " No room inbox is declared in agent/email/policy.ts."}` };
  }
  if (box.kind !== "room") return { refusal: `${inbox} is a personal inbox: it has no sender list. A person reaches it when agent/identity/principals.ts declares their address (ids.email), which is a separate change.` };
  const sender = normalizeSenderRule(rawSender);
  if (!sender) return { refusal: `"${rawSender}" is not an email address or a "*@domain" rule.` };
  if (!sender.startsWith("*@") && isOwnInbox(policy, sender)) return { refusal: `${sender} is one of my own inboxes — allowing it would let me mail myself in a loop.` };
  if (sender.startsWith("*@") && policy.inboxes.some((b) => emailDomainOf(b.address) === sender.slice(2))) {
    return { refusal: `${sender} would admit my own inbox domain, so my own mail could wake me. Name the addresses instead.` };
  }
  if (box.allowedSenders.some((r) => r === sender || (!sender.startsWith("*@") && senderRuleMatches(r, sender)))) {
    return { refusal: `${sender} can already email ${inbox} — nothing to add.` };
  }
  return { inbox, sender };
}

export default defineTool({
  description:
    "Propose letting a new sender email one of this deployment's ROOM inboxes — the answer to \"let partner@example.com email launch@\". Mail from anyone not on an inbox's list is refused unread, and nobody gets an automatic reply, so this is how an outside party is admitted. " +
    "This does NOT allow anyone yet. It posts a card; approving it opens a pull request on the deployment's config repo that adds ONE line to agent/email/senders.ts, for an admin to merge. `sender` is an exact address or \"*@domain\" (that exact domain only). Refused in an external or guest conversation, and for a personal inbox. The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    inbox: z.string().min(3).describe("The room inbox, e.g. \"launch@agent.acme.com\"."),
    sender: z.string().min(3).describe('An exact address ("partner@example.com") or a whole domain ("*@example.com").'),
    why: z.string().min(1).max(300).describe("Why this sender may write — shown on the card and in the pull request."),
  }),
  outputSchema: z.object({
    proposed: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "propose_email_sender");
    if (resolveMode(ctx) === "mpim") throw new Error("Group DMs are execution-only — propose an email sender from a channel or a DM instead.");

    const binding = bindFrom(ctx);
    const requestedBy = actingPrincipalIdOf(ctx);
    const refusal = emailSenderAudienceRefusal(binding, { nonMember: nonMemberWake(ctx), actingPrincipal: requestedBy });
    if (refusal !== undefined) throw new Error(refusal);

    const checked = emailSenderInputCheck(emailPolicy(), input.inbox, input.sender);
    if ("refusal" in checked) throw new Error(checked.refusal);

    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "propose that email sender"));
    const venue = venueResult.venue;
    const cfg = requireEmailSenderConfig();

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("propose_email_sender couldn't resolve this conversation's id — try again from a real channel or DM.");
    const why = input.why.trim().replace(/\s+/g, " ");

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "email.sender",
        args: {
          org: p.org,
          scopeKey: proposeScopeKey,
          requestId: randomUUID(),
          inbox: checked.inbox,
          sender: checked.sender,
          why,
          requestedBy: requestedBy!,
          channelId,
          threadTs: binding.threadTs ?? null,
          configRepo: cfg.configRepo,
        },
        scopeKey: proposeScopeKey,
        domain: null,
        requestedBy: requestedBy!,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const sentence = emailSenderSentence(checked);
    if (posted.autoApproved) {
      return {
        proposed: true,
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        message: `${autoApprovedNote(`PR against ${cfg.configRepo} to ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`, posted.autoApproved)} Nothing is allowed until an admin merges it.`,
      };
    }
    return {
      proposed: true,
      pending: true,
      pendingId: posted.id,
      message: `${cardPostedPrefix(venue)} — approving it opens a PR against ${cfg.configRepo} adding one line to ${EMAIL_SENDERS_DEFAULT_PATH}: ${sentence} (pending ${posted.id}). Nothing is allowed until an admin merges it.${cardPostedTail(venue, "approve it", posted)}`,
    };
  },
});
