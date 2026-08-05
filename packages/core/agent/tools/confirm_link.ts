import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { getOperationalStore } from "../operational/provider.js";
import { principalKey } from "../identity/principal-key.js";
import { denyLinkChallenge, ratifyLinkChallenge } from "../identity/link-store.js";

export default defineTool({
  description:
    "Confirm (or deny) an account that claimed this person's link code — the second half of link_identity. DM only, and only the person who started the link may call it. Confirming writes the link; denying writes nothing at all. ALWAYS show the claiming account to the person and let THEM decide before calling this — if they do not recognise it, deny.",
  inputSchema: z.object({
    decision: z.enum(["confirm", "deny"]).describe("`confirm` links the claiming account to this person; `deny` discards the claim and writes nothing."),
    challengeId: z
      .string()
      .optional()
      .describe("Which link request to decide. Only needed when this person has more than one claim waiting — the tool names them if so."),
  }),
  outputSchema: z.object({
    decided: z.string(),
    claimant: z.string().optional(),
    linkSetId: z.string().optional(),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    if (binding.mode !== "dm") {
      throw new Error(`confirm_link is DM-only (this conversation is "${binding.mode}") — only the person who started the link may confirm it, and in a shared conversation anyone could.`);
    }
    const actor = actingPrincipalIdOf(ctx);
    if (!actor) {
      throw new Error("confirm_link needs a verified person on this turn — only the human who started the link can confirm it.");
    }

    const store = getOperationalStore();
    await store.expireLinkChallenges(binding.org, new Date().toISOString());
    const waiting = await store.listLinkChallenges(binding.org, {
      initiatingPlatform: binding.platform,
      initiatingNativeId: actor,
      status: "claimed",
    });
    if (waiting.length === 0) {
      throw new Error("no link request of yours is waiting for a decision — either nothing has claimed your code yet, it expired (codes last ~10 minutes), or it was already decided. Start again with link_identity.");
    }

    let challenge = waiting[0]!;
    if (input.challengeId !== undefined) {
      const picked = waiting.find((c) => c.id === input.challengeId);
      if (!picked) throw new Error(`link request "${input.challengeId}" is not one of yours awaiting a decision.`);
      challenge = picked;
    } else if (waiting.length > 1) {
      const list = waiting.map((c) => `  • ${c.id} — claimed by ${principalKey(c.claimedPlatform ?? "?", c.claimedNativeId ?? "?")}`).join("\n");
      throw new Error(`you have ${waiting.length} link requests awaiting a decision — say which one (challengeId):\n${list}`);
    }

    if (challenge.initiatingPlatform !== binding.platform || challenge.initiatingNativeId !== actor) {
      throw new Error("that link request was not started by you — only its initiator can decide it.");
    }
    const claimant = principalKey(challenge.claimedPlatform ?? "?", challenge.claimedNativeId ?? "?");

    if (input.decision === "deny") {
      const denied = await denyLinkChallenge({ org: binding.org, challengeId: challenge.id });
      if (!denied) throw new Error("that link request was already decided.");
      return { decided: "denied", claimant, note: `Denied — nothing was linked. ${claimant} does not get your standing.` };
    }

    const result = await ratifyLinkChallenge({
      org: binding.org,
      challengeId: challenge.id,
      handle: principalKey(binding.platform, actor),
    });
    if (!result.ok) throw new Error(result.reason);
    return { decided: "confirmed", claimant, linkSetId: result.linkSetId, note: result.note };
  },
});
