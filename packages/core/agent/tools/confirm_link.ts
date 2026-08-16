import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { linkTenantOf } from "../identity/link-tenant.js";
import type { LinkedAccount } from "../identity/link-store.js";
import type { LinkChallengeRow } from "../operational/store.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { getOperationalStore } from "../operational/provider.js";
import { principalKey, tryPrincipalKey } from "../identity/principal-key.js";
import { humanAccountLabel } from "../identity/account-display-name.js";
import { ingestUntrusted } from "../access/untrusted.js";

function claimantLabel(platform: string | undefined, tenant: string | undefined, nativeId: string | undefined): string {
  if (!platform || !nativeId) return "an account this request never recorded";
  return tryPrincipalKey(platform, tenant, nativeId) ?? `the ${platform} account "${nativeId}" (workspace unrecorded)`;
}

async function claimantName(platform: string | undefined, tenant: string | undefined, nativeId: string | undefined): Promise<string> {
  if (!platform || !nativeId) return "an account this request never recorded";
  return humanAccountLabel(platform, nativeId, tenant);
}

function fencedClaimantName(name: string): string {
  return ingestUntrusted(name, { source: "account-display-name" });
}
import { confirmLinkedId, denyLinkChallenge, ratifyLinkChallenge } from "../identity/link-store.js";
import { linkInitiatorRefusal } from "../identity/link-initiator.js";
import { notifyLinkSetMembers } from "../channels/post-arms.js";
import { pendingDirectorySuggestionsFor } from "../identity/directory-sync.js";

function claimantParts(challenge: LinkChallengeRow): { claimantAccount?: { platform: string; tenant: string; nativeId: string }; claimedAt?: string } {
  const composes =
    challenge.claimedPlatform &&
    challenge.claimedNativeId &&
    tryPrincipalKey(challenge.claimedPlatform, challenge.claimedTenant, challenge.claimedNativeId) !== undefined;
  const parts = composes
    ? { claimantAccount: { platform: challenge.claimedPlatform!, tenant: challenge.claimedTenant ?? "", nativeId: challenge.claimedNativeId! } }
    : {};
  return { ...parts, ...(challenge.claimedAt ? { claimedAt: challenge.claimedAt } : {}) };
}

export default defineTool({
  description:
    "Confirm (or deny) an account that belongs to this person — the second half of link_identity, and the one-tap confirmation for accounts an identity-directory sync (Okta) suggested for them. DM only, and only that person may call it. NEVER ask which account claimed their link code — they cannot see it and this tool holds it: a `confirm` with no `acknowledge` writes nothing and NAMES the waiting account (returning its challengeId). Show them `claimantName` (a display name + handle, resolved where possible) rather than `claimant` (a bare principal key nobody can eyeball), then call again with `acknowledge:true` AND that challengeId to commit — both calls in one turn when they have already said yes. Denying writes nothing at all and takes one call. Always name an account to the person before you commit it; if they do not recognise one, deny.",
  inputSchema: z.object({
    decision: z.enum(["confirm", "deny"]).describe("`confirm` links the account(s) to this person; `deny` discards the proposal and writes nothing."),
    acknowledge: z
      .boolean()
      .optional()
      .describe(
        "Set true ONLY after you have the account that claimed the link code in front of you and the person has said it is theirs. Omitted, a `confirm` over a waiting claim writes nothing and returns the claimant instead. Ignored for directory-suggested accounts and for `deny`.",
      ),
    challengeId: z
      .string()
      .optional()
      .describe(
        "Which link request to decide. REQUIRED with `acknowledge: true` — pass back the challengeId the naming call returned, so the commit names the exact claim the person was shown. Also disambiguates when several claims wait (the tool lists them).",
      ),
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
    claimantName: z.string().optional(),
    claimantAccount: z.object({ platform: z.string(), tenant: z.string(), nativeId: z.string() }).optional(),
    claimedAt: z.string().optional(),
    challengeId: z.string().optional(),
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
    const refusal = linkInitiatorRefusal(binding, "confirm a link");
    if (refusal) throw new Error(refusal);

    const store = getOperationalStore();
    await store.expireLinkChallenges(binding.org, new Date().toISOString());
    const tenant = linkTenantOf(binding.platform, binding.workspace);
    const waiting = await store.listLinkChallenges(binding.org, {
      initiatingPlatform: binding.platform,
      initiatingTenant: tenant,
      initiatingNativeId: actor,
      status: "claimed",
    });
    if (waiting.length === 0) {
      return await decideDirectorySuggestions({ org: binding.org, platform: binding.platform, tenant, actor, decision: input.decision, only: input.accounts });
    }

    let challenge = waiting[0]!;
    if (input.challengeId !== undefined) {
      const picked = waiting.find((c) => c.id === input.challengeId);
      if (!picked) throw new Error(`link request "${input.challengeId}" is not one of yours awaiting a decision.`);
      challenge = picked;
    } else if (waiting.length > 1) {
      const lines = await Promise.all(
        waiting.map(async (c) => `  • ${c.id} — claimed by ${fencedClaimantName(await claimantName(c.claimedPlatform, c.claimedTenant, c.claimedNativeId))}`),
      );
      throw new Error(`you have ${waiting.length} link requests awaiting a decision — say which one (challengeId):\n${lines.join("\n")}`);
    }

    if (challenge.initiatingPlatform !== binding.platform || challenge.initiatingTenant !== tenant || challenge.initiatingNativeId !== actor) {
      throw new Error("that link request was not started by you — only its initiator can decide it.");
    }
    const claimant = claimantLabel(challenge.claimedPlatform, challenge.claimedTenant, challenge.claimedNativeId);
    const name = await claimantName(challenge.claimedPlatform, challenge.claimedTenant, challenge.claimedNativeId);
    const fencedName = fencedClaimantName(name);

    if (input.decision === "deny") {
      const denied = await denyLinkChallenge({ org: binding.org, challengeId: challenge.id });
      if (!denied) throw new Error("that link request was already decided.");
      return { decided: "denied", claimant, claimantName: fencedName, ...claimantParts(challenge), note: `Denied — nothing was linked. ${fencedName} does not get your standing.` };
    }

    if (input.acknowledge === true && input.challengeId === undefined) {
      throw new Error(
        "an acknowledged confirm must pass back the challengeId of the claim it acknowledges — " +
          "call confirm_link without `acknowledge` first: it names the waiting claimant and returns the challengeId.",
      );
    }

    if (input.acknowledge !== true) {
      return {
        decided: "awaiting_acknowledgement",
        claimant,
        claimantName: fencedName,
        ...claimantParts(challenge),
        challengeId: challenge.id,
        note:
          `NOTHING IS LINKED YET. ${fencedName} claimed your link code` +
          (challenge.claimedAt ? ` at ${challenge.claimedAt}` : "") +
          `. If the person has ALREADY said this account is theirs, call confirm_link again NOW with ` +
          `acknowledge: true and this challengeId — both calls belong in one turn. Otherwise tell them ` +
          `exactly which account this is and ask whether it is theirs. If they do not recognise it, ` +
          `call confirm_link with decision: "deny" — that writes nothing.`,
      };
    }

    const result = await ratifyLinkChallenge({
      org: binding.org,
      challengeId: challenge.id,
      handle: principalKey(binding.platform, tenant, actor),
    });
    if (!result.ok) throw new Error(result.reason);
    await announceLinkSetGrowth(binding.org, result.linkSetId, claimant, name, { platform: binding.platform, tenant, nativeId: actor });
    return { decided: "confirmed", claimant, claimantName: fencedName, ...claimantParts(challenge), linkSetId: result.linkSetId, note: result.note };
  },
});

async function announceLinkSetGrowth(org: string, linkSetId: string, joined: string, joinedName: string, initiator: LinkedAccount): Promise<void> {
  const n = await notifyLinkSetMembers(
    org,
    linkSetId,
    `${joinedName} was just linked to your identity, so it now speaks as you across the surfaces I ` +
      `can see.\n\nIf that was you, nothing to do. If it was not, remove it now — ask me to unlink ` +
      `${joined} — and tell whoever runs this workspace.`,
    { except: [initiator] },
  );
  if (n > 0) console.log(`[open-everywhere:identity] link-set ${linkSetId} grew by ${joined} — notified ${n} other member account(s).`);
}

async function decideDirectorySuggestions(input: {
  readonly org: string;
  readonly platform: string;
  readonly tenant: string;
  readonly actor: string;
  readonly decision: "confirm" | "deny";
  readonly only?: readonly string[];
}): Promise<{ decided: string; accounts?: string[]; linkSetId?: string; note: string }> {
  const pending = await pendingDirectorySuggestionsFor(input.org, input.platform, input.tenant, input.actor);
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
  const confirmedNames: string[] = [];
  const failed: string[] = [];
  for (const p of chosen) {
    const res = await confirmLinkedId({
      org: input.org,
      account: { platform: p.platform, tenant: p.tenant, nativeId: p.nativeId },
      evidence: { kind: "challenge", challengeId: `dm-confirm:${principalKey(input.platform, input.tenant, input.actor)}` },
    });
    if (res.ok) {
      confirmed.push(p.principal);
      confirmedNames.push(await humanAccountLabel(p.platform, p.nativeId, p.tenant));
    } else failed.push(`${p.principal} (${res.reason})`);
  }
  if (confirmed.length === 0) {
    throw new Error(`could not confirm ${failed.join("; ")}`);
  }
  await announceLinkSetGrowth(input.org, chosen[0]!.linkSetId, confirmed.join(", "), confirmedNames.join(", "), { platform: input.platform, tenant: input.tenant, nativeId: input.actor });
  return {
    decided: "confirmed",
    accounts: confirmed,
    linkSetId: chosen[0]!.linkSetId,
    note:
      `Linked ${confirmed.join(", ")} to you.` +
      (failed.length ? ` Could not link ${failed.join("; ")}.` : ""),
  };
}
