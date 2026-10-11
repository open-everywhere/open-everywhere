import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { unattendedOf } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { autoApprovedNote, requestApproval } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { cardPostedPrefix, cardPostedTail, checkApprovalVenue } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { postSurfaceTextStrict } from "../channels/surface-message-ops.js";
import { BoxUnavailableError } from "../sandbox/long-lived-box.js";
import { browserHalted, ensureBrowserOpen, takeOver } from "../personal-browser/lifecycle.js";
import { browserHostsFor, browserOwnerFor } from "../personal-browser/ask.js";
import { issueWatchLink } from "../personal-browser/viewer.js";
import type { BrowserHandbackArgs } from "../approvals/personal-browser.js";

export default defineTool({
  description:
    "Give the person the controls of their OWN browser (the one my_browser drives), for a step only they may do: signing in, a 2FA or one-time code, a CAPTCHA, a payment, or a decision. " +
    "I send them a private link in this DM to their live browser and a card to hand the controls back. Until they hand back, every my_browser action is refused — so stop browsing and wait for their decision. DM only.",
  inputSchema: z.object({
    reason: z.string().min(1).max(200).describe("What the person needs to do, in a few words: \"sign in to your mail\", \"type the code from your phone\"."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string(),
    pendingId: z.string().optional(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered the hand-back card: no card was posted. It cannot hand anything back here (the card executes for the owner's own click only)."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "my_browser_handoff");
    const owner = browserOwnerFor(ctx);
    if (await browserHalted({ org: owner.org, partition: owner.partition, principalId: owner.principalId })) {
      throw new Error("a halt covers this conversation, so I won't use your browser until it is lifted");
    }
    let opened;
    try {
      opened = await ensureBrowserOpen(owner, await browserHostsFor(ctx));
    } catch (err) {
      if (err instanceof BoxUnavailableError) throw new Error(`I can't open a browser on this deployment: ${err.message}`);
      throw err;
    }
    const link = await issueWatchLink(owner);
    if (link === undefined) throw new Error("this deployment can't make a private link to your browser (it has no page signing key, OE_INTAKE_PAGE_SIGNING_KEY, or no public URL), so I can't hand you the controls");
    const reason = input.reason.trim();
    await takeOver(owner.org, owner.person, "agent", {}, reason);
    await postSurfaceTextStrict(owner.platform, {
      channelId: owner.dmChannelId,
      text: `You have the controls of your browser: ${reason}. Open it here (the link works once, for 10 minutes — don't forward it): ${link.url}`,
    });
    const startedNote = opened.started ? "I started your browser (your earlier logins are still in it). " : "";
    const binding = bindFrom(ctx);
    const p = owner.partition;
    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult || !venueResult.venue.sameRoom) {
      return { ok: true, message: `${startedNote}I gave you the controls and sent you a private link in this DM. When you're done, press "Hand back to the agent" on the page and tell me here to carry on.` };
    }
    const venue = venueResult.venue;
    const args: BrowserHandbackArgs = { org: owner.org, person: owner.person, principalId: owner.principalId, reason };
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "browser.personal.handback",
        args,
        scopeKey: await proposalScopeKey(ctx, p),
        domain: null,
        requestedBy: owner.principalId,
        channelId: venue.channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );
    if (posted.autoApproved) {
      return { ok: true, autoApproved: true, pendingId: posted.id, message: autoApprovedNote("handing the browser's controls back to me", posted.autoApproved) };
    }
    return {
      ok: true,
      pendingId: posted.id,
      message: `${startedNote}I gave you the controls and sent you a private link in this DM. ${cardPostedPrefix(venue)} — I won't touch the browser until you approve the hand-back card (pending ${posted.id}) or press Hand back on the page. Wait for that before any more browser actions.${cardPostedTail(venue, "approve it when you're done", posted)}`,
    };
  },
});
