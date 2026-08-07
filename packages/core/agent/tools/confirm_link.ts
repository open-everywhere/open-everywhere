import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { getOperationalStore } from "../operational/provider.js";
import { principalKey } from "../identity/principal-key.js";
import { confirmLinkedId, denyLinkChallenge, ratifyLinkChallenge } from "../identity/link-store.js";
import { pendingDirectorySuggestionsFor } from "../identity/directory-sync.js";

export default defineTool({
  description:
    "Confirm (or deny) an account that belongs to this person — the second half of link_identity, and the one-tap confirmation for accounts an identity-directory sync (Okta) suggested for them. DM only, and only that person may call it. Confirming writes the link; denying writes nothing at all. ALWAYS show the account(s) to the person and let THEM decide before calling this — if they do not recognise one, deny.",
  inputSchema: z.object({
    decision: z.enum(["confirm", "deny"]).describe("`confirm` links the account(s) to this person; `deny` discards the proposal and writes nothing."),
    challengeId: z
      .string()
      .optional()
      .describe("Which link request to decide. Only needed when this person has more than one claim waiting — the tool names them if so."),
    accounts: z
      .array(z.string())
      .optional()
      .describe(
        "Only for directory-suggested accounts: which ones to confirm, as principal keys (\"github/octocat\"). Omit only when exactly one account is waiting, or when denying — confirming several at once REQUIRES naming them, and the tool refuses (listing them) if you do not. Ignored when a link code claim is waiting.",
      ),
  }),
  outputSchema: z.object({
    decided: z.string(),
    claimant: z.string().optional(),
    accounts: z.array(z.string()).optional(),
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
      return await decideDirectorySuggestions({ org: binding.org, platform: binding.platform, actor, decision: input.decision, only: input.accounts });
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

async function decideDirectorySuggestions(input: {
  readonly org: string;
  readonly platform: string;
  readonly actor: string;
  readonly decision: "confirm" | "deny";
  readonly only?: readonly string[];
}): Promise<{ decided: string; accounts?: string[]; linkSetId?: string; note: string }> {
  const pending = await pendingDirectorySuggestionsFor(input.org, input.platform, input.actor);
  if (pending.length === 0) {
    throw new Error(
      "nothing of yours is waiting for a decision — no link code has been claimed (codes last ~10 minutes) and no identity-directory sync has suggested an account for you. Start a link yourself with link_identity.",
    );
  }
  if (!input.only?.length && input.decision === "confirm" && pending.length > 1) {
    throw new Error(
      `${pending.length} accounts are waiting for your decision — name the ones you recognise ` +
        `(accounts: ["github/octocat"]). A blanket yes over several accounts is the one shape that ` +
        `could confirm an account you were never shown. Waiting on: ${pending.map((p) => p.principal).join(", ")}.`,
    );
  }
  const chosen = input.only?.length
    ? pending.filter((p) => input.only!.some((want) => want.trim().toLowerCase() === p.principal.toLowerCase()))
    : pending;
  if (chosen.length === 0) {
    throw new Error(`none of those accounts is waiting for your decision. Suggested for you: ${pending.map((p) => p.principal).join(", ")}.`);
  }
  const named = chosen.map((p) => p.principal);

  if (input.decision === "deny") {
    return {
      decided: "denied",
      accounts: named,
      note:
        `Declined — nothing was linked. ${named.join(", ")} still has no standing as you. ` +
        `The suggestion stays on file and the directory may propose it again; use unlink_identity to detach an account for good.`,
    };
  }

  const confirmed: string[] = [];
  const failed: string[] = [];
  for (const p of chosen) {
    const res = await confirmLinkedId({
      org: input.org,
      account: { platform: p.platform, nativeId: p.nativeId },
      evidence: { kind: "challenge", challengeId: `dm-confirm:${principalKey(input.platform, input.actor)}` },
    });
    if (res.ok) confirmed.push(p.principal);
    else failed.push(`${p.principal} (${res.reason})`);
  }
  if (confirmed.length === 0) {
    throw new Error(`could not confirm ${failed.join("; ")}`);
  }
  return {
    decided: "confirmed",
    accounts: confirmed,
    linkSetId: chosen[0]!.linkSetId,
    note:
      `Linked ${confirmed.join(", ")} to you.` +
      (failed.length ? ` Could not link ${failed.join("; ")}.` : ""),
  };
}
