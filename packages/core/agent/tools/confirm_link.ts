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
import { confirmLinkedId, consentLinkChallenge, denyLinkChallenge, ratifyLinkChallenge } from "../identity/link-store.js";
import { linkInitiatorRefusal } from "../identity/link-initiator.js";
import { canDeliverDirectMessage, dispatchDirectMessage, notifyLinkSetMembers } from "../channels/post-arms.js";
import { pendingDirectorySuggestionsFor } from "../identity/directory-sync.js";
import { asLinkTransport, codeBackDecision, codeBackInstructions, consentGate, finalizeGate } from "../identity/link-flow.js";
import { mintLinkCode } from "../identity/link-challenge.js";
import { getSettings } from "../settings/settings.js";

type Waiting = { readonly role: "finalize" | "consent"; readonly challenge: LinkChallengeRow };

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
    "Answer whatever identity question is waiting for this person — finalize a link THEY started, consent to one somebody asked of THEIR account, or accept an account an identity-directory sync (Okta) suggested. DM only, and only that person may call it. NEVER ask which account is involved — they cannot see it and this tool holds it: a `confirm` with no `acknowledge` writes nothing and NAMES the waiting account (returning its challengeId). Show them the resolved name rather than the bare principal key, then call again with `acknowledge:true` AND that challengeId — both calls in one turn when they have already said yes. Some links additionally need `code`: the second code I posted back to the other account, which the person has to read there and give you; `acknowledge` alone will not finish those. Denying writes nothing at all and takes one call. Always name an account to the person before you commit it; if they do not recognise one, deny.",
  inputSchema: z.object({
    decision: z.enum(["confirm", "deny"]).describe("`confirm` links the account(s) to this person; `deny` discards the proposal and writes nothing."),
    acknowledge: z
      .boolean()
      .optional()
      .describe(
        "Set true ONLY after you have the account in front of you and the person has said it is theirs. Omitted, a `confirm` over a waiting request writes nothing and names the account instead. Ignored for directory-suggested accounts and for `deny`.",
      ),
    code: z
      .string()
      .optional()
      .describe(
        "The SECOND code, when one was issued: I posted it back to the other account, and the person has to read it there and tell you. Required to finalize those links — `acknowledge` alone is refused. Never guess one; the naming call says whether a code is needed.",
      ),
    challengeId: z
      .string()
      .optional()
      .describe(
        "Which request to decide. REQUIRED with `acknowledge: true` or `code` — pass back the challengeId the naming call returned, so the commit names the exact request the person was shown. Also disambiguates when several wait (the tool lists them).",
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
    role: z.string().optional(),
    initiatorName: z.string().optional(),
    codeBack: z.string().optional(),
    needsCode: z.boolean().optional(),
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
    const [initiated, aimedAtMe] = await Promise.all([
      store.listLinkChallenges(binding.org, { initiatingPlatform: binding.platform, initiatingTenant: tenant, initiatingNativeId: actor, status: "claimed" }),
      store.listLinkChallenges(binding.org, { targetPlatform: binding.platform, targetTenant: tenant, targetNativeId: actor, status: "pending" }),
    ]);
    const waiting: readonly Waiting[] = [
      ...initiated.map((challenge) => ({ role: "finalize" as const, challenge })),
      ...aimedAtMe.map((challenge) => ({ role: "consent" as const, challenge })),
    ];
    if (waiting.length === 0) {
      return await decideDirectorySuggestions({ org: binding.org, platform: binding.platform, tenant, actor, decision: input.decision, only: input.accounts });
    }

    let picked = waiting[0]!;
    if (input.challengeId !== undefined) {
      const found = waiting.find((w) => w.challenge.id === input.challengeId);
      if (!found) throw new Error(`link request "${input.challengeId}" is not one of yours awaiting a decision.`);
      picked = found;
    } else if (waiting.length > 1) {
      const lines = await Promise.all(waiting.map(async (w) => `  • ${w.challenge.id} — ${await describeWaiting(w)}`));
      throw new Error(`you have ${waiting.length} identity requests awaiting a decision — say which one (challengeId):\n${lines.join("\n")}`);
    }

    if (picked.role === "consent") {
      return await decideConsent({ org: binding.org, platform: binding.platform, tenant, actor, challenge: picked.challenge, input });
    }
    const challenge = picked.challenge;
    if (challenge.initiatingPlatform !== binding.platform || challenge.initiatingTenant !== tenant || challenge.initiatingNativeId !== actor) {
      throw new Error("that link request was not started by you — only its initiator can decide it.");
    }
    const claimant = claimantLabel(challenge.claimedPlatform, challenge.claimedTenant, challenge.claimedNativeId);
    const name = await claimantName(challenge.claimedPlatform, challenge.claimedTenant, challenge.claimedNativeId);
    const fencedName = fencedClaimantName(name);

    if (input.decision === "deny") {
      const denied = await denyLinkChallenge({ org: binding.org, challengeId: challenge.id });
      if (!denied) throw new Error("that link request was already decided.");
      return { decided: "denied", role: "finalize", claimant, claimantName: fencedName, ...claimantParts(challenge), note: `Denied — nothing was linked. ${fencedName} does not get your standing.` };
    }

    const needsCode = challenge.backNonceHash !== undefined;
    const verdict = finalizeGate({ backNonceHash: challenge.backNonceHash, acknowledge: input.acknowledge, code: input.code, challengeId: input.challengeId });
    if (verdict.kind === "refuse") throw new Error(verdict.reason);
    if (verdict.kind === "peek") {
      return {
        decided: "awaiting_acknowledgement",
        role: "finalize",
        claimant,
        claimantName: fencedName,
        needsCode,
        ...claimantParts(challenge),
        challengeId: challenge.id,
        note:
          `NOTHING IS LINKED YET. ${fencedName} claimed your link code` +
          (challenge.claimedAt ? ` at ${challenge.claimedAt}` : "") +
          (needsCode
            ? `. To finish, I need the SECOND code I posted back to that account — the person has to read ` +
              `it there and tell you. Call confirm_link again with that code and this challengeId. ` +
              `acknowledge alone will not finish this one. If they do not recognise the account, call ` +
              `confirm_link with decision: "deny" — that writes nothing.`
            : `. If the person has ALREADY said this account is theirs, call confirm_link again NOW with ` +
              `acknowledge: true and this challengeId — both calls belong in one turn. Otherwise tell them ` +
              `exactly which account this is and ask whether it is theirs. If they do not recognise it, ` +
              `call confirm_link with decision: "deny" — that writes nothing.`),
      };
    }

    const result = await ratifyLinkChallenge({
      org: binding.org,
      challengeId: challenge.id,
      handle: principalKey(binding.platform, tenant, actor),
    });
    if (!result.ok) throw new Error(result.reason);
    await announceLinkSetGrowth(binding.org, result.linkSetId, claimant, name, { platform: binding.platform, tenant, nativeId: actor });
    return { decided: "confirmed", role: "finalize", claimant, claimantName: fencedName, ...claimantParts(challenge), linkSetId: result.linkSetId, note: result.note };
  },
});

async function describeWaiting(w: Waiting): Promise<string> {
  if (w.role === "consent") {
    const who = await claimantName(w.challenge.initiatingPlatform, w.challenge.initiatingTenant, w.challenge.initiatingNativeId);
    return `${fencedClaimantName(who)} asked to link YOUR account to theirs`;
  }
  const who = await claimantName(w.challenge.claimedPlatform, w.challenge.claimedTenant, w.challenge.claimedNativeId);
  return `you started this — ${fencedClaimantName(who)} claimed your link code`;
}

async function decideConsent(args: {
  readonly org: string;
  readonly platform: string;
  readonly tenant: string;
  readonly actor: string;
  readonly challenge: LinkChallengeRow;
  readonly input: { readonly decision: "confirm" | "deny"; readonly acknowledge?: boolean; readonly challengeId?: string; readonly code?: string };
}): Promise<{ decided: string; role: string; initiatorName?: string; codeBack?: string; challengeId?: string; note: string }> {
  const c = args.challenge;
  const who = fencedClaimantName(await claimantName(c.initiatingPlatform, c.initiatingTenant, c.initiatingNativeId));

  if (args.input.decision === "deny") {
    const denied = await denyLinkChallenge({ org: args.org, challengeId: c.id, from: ["pending"] });
    if (!denied) throw new Error("that request was already decided or has expired.");
    return { decided: "denied", role: "consent", initiatorName: who, note: `Declined — nothing was linked, and ${who} does not get your account.` };
  }

  const verdict = consentGate({ acknowledge: args.input.acknowledge, challengeId: args.input.challengeId, code: args.input.code });
  if (verdict.kind === "refuse") throw new Error(verdict.reason);
  if (verdict.kind === "peek") {
    return {
      decided: "awaiting_acknowledgement",
      role: "consent",
      initiatorName: who,
      challengeId: c.id,
      note:
        `NOTHING IS LINKED YET, and nothing will be unless you agree. ${who} says this account is also ` +
        `theirs and asked me to link the two. Tell the person exactly who that is and ask whether it is ` +
        `them. If it is, call confirm_link again with acknowledge: true and this challengeId. If they do ` +
        `not recognise that person, call confirm_link with decision: "deny" — that writes nothing.`,
    };
  }

  const decision = codeBackDecision({
    transport: asLinkTransport(c.transport),
    knobArmed: getSettings().identityLinking.codeBack,
    deliverable: true,
  });
  const backCode = decision.mint ? mintLinkCode() : undefined;
  const consented = await consentLinkChallenge({
    org: args.org,
    challengeId: c.id,
    consenter: { platform: args.platform, tenant: args.tenant, nativeId: args.actor },
    ...(backCode ? { backCode } : {}),
  });
  if (!consented) throw new Error("that request is no longer open — it was already answered, or it expired. Ask them to start it again.");

  if (canDeliverDirectMessage(c.initiatingPlatform)) {
    const consenterName = await claimantName(args.platform, args.tenant, args.actor);
    await dispatchDirectMessage(c.initiatingPlatform, {
      principalId: c.initiatingNativeId,
      text:
        `${consenterName} agreed to the link you asked for.\n\n` +
        (backCode
          ? `Ask them for the code I gave them and tell me here to finish it. Nothing is linked until you do.`
          : `Tell me here to finish it. Nothing is linked until you do.`),
    }).catch((err: unknown) => console.log(`[open-everywhere:identity] consent notice for ${c.id} could not be delivered: ${String(err)}`));
  }

  return {
    decided: "consented",
    role: "consent",
    initiatorName: who,
    ...(backCode ? { codeBack: backCode } : {}),
    challengeId: c.id,
    note: backCode
      ? `Consent recorded. Nothing is linked yet. Show them this exactly: ${codeBackInstructions(backCode)}`
      : `Consent recorded. Nothing is linked yet — ${who} has to finish it on their side, and I have told them so.`,
  };
}

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
