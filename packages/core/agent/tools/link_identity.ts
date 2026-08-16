import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { surfaceKeyOf } from "../access/resolver.js";
import { issueLinkChallenge } from "../identity/link-store.js";
import { linkInitiatorRefusal } from "../identity/link-initiator.js";
import { linkClaimInstructions, LINK_CHALLENGE_TTL_MS } from "../identity/link-challenge.js";
import { linkConsentAsk, linkConsentPendingInstructions } from "../identity/link-flow.js";
import { hasAccountDirectory, lookupAccountDirectory, accountDirectoryPlatforms, DIRECTORY_MAX_CANDIDATES } from "../identity/account-directory.js";
import { accountProfileFor, humanAccountLabel } from "../identity/account-display-name.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { canDeliverDirectMessage, dispatchDirectMessage } from "../channels/post-arms.js";
import { linkTenantOf, tryLinkTenantOf } from "../identity/link-tenant.js";
import { ingestUntrusted } from "../access/untrusted.js";

const TTL_MINUTES = Math.round(LINK_CHALLENGE_TTL_MS / 60_000);

function fenced(text: string): string {
  return ingestUntrusted(text, { source: "account-display-name" });
}

export default defineTool({
  description:
    "Start linking another account (GitHub, Linear, Slack, …) to the person you are talking to, so their work is attributed to ONE human across surfaces. DM only, and nothing is linked by this call. THREE WAYS TO CALL IT. (1) `{platform, query}` — SEARCH that platform's user directory for the person's other account and return candidates; show them the names and let them pick. (2) `{platform, nativeId}` — ask that exact account to consent, in its own DM; you then finalize with confirm_link once it answers. (3) `{}` — the fallback: returns a short single-use code the person posts as `link <code>` from their other account. Ways 1 and 2 fall back to way 3 by themselves when the platform has no directory or no DM delivery, and say so. Relay the returned instructions verbatim; do not paraphrase a code.",
  inputSchema: z.object({
    platform: z
      .string()
      .optional()
      .describe("The platform the OTHER account is on (`github`, `slack`, `linear`, …). Needed for a directory search or a directory ask; omit for the code fallback."),
    query: z.string().optional().describe("A name or handle to search that platform's user directory for. Returns candidates and writes nothing."),
    nativeId: z
      .string()
      .optional()
      .describe("The exact account id to ask, taken from a `query` search's candidates. Sends that account a consent request in its own DM. Never invent one — search first."),
  }),
  outputSchema: z.object({
    decided: z.string(),
    challengeId: z.string().optional(),
    expiresAt: z.string().optional(),
    candidates: z.array(z.object({ nativeId: z.string(), label: z.string() })).optional(),
    truncated: z.boolean().optional(),
    target: z.string().optional(),
    instructions: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    if (binding.mode !== "dm") {
      throw new Error(
        `link_identity is DM-only (this conversation is "${binding.mode}"). Linking identities ends with a confirmation that only the person themselves may answer, and in a ${binding.mode === "mpim" ? "group DM" : "channel"} anyone present could answer it. Ask them to DM me.`,
      );
    }
    const actor = actingPrincipalIdOf(ctx);
    if (!actor) {
      throw new Error("link_identity needs a verified person on this turn — a link is a statement about a human, and there is nobody here to make it.");
    }
    const refusal = linkInitiatorRefusal(binding, "start a link");
    if (refusal) throw new Error(refusal);
    const p = resolvePartition(ctx);
    const surfaceKey = surfaceKeyOf({ platform: p.platform, workspace: p.workspace, channel: p.surface });

    const platform = input.platform?.trim();
    const query = input.query?.trim();
    const nativeId = input.nativeId?.trim();

    const shortfall = platform ? directoryShortfall(platform) : "no platform named";
    if (!platform || (!query && !nativeId) || shortfall) {
      return await issueCodeChallenge({
        org: binding.org,
        platform: binding.platform,
        tenant: binding.workspace,
        nativeId: actor,
        surfaceKey,
        why: platform && (query || nativeId) ? `I can't look ${platform} accounts up: ${shortfall}.` : undefined,
      });
    }

    const targetTenant = platform === binding.platform ? linkTenantOf(platform, binding.workspace) : tryLinkTenantOf(platform);
    if (targetTenant === undefined) {
      return await issueCodeChallenge({
        org: binding.org,
        platform: binding.platform,
        tenant: binding.workspace,
        nativeId: actor,
        surfaceKey,
        why: `I can't tell which ${platform} workspace to look in — this deployment serves more than one.`,
      });
    }
    if (!nativeId) {
      const found = await lookupAccountDirectory(platform, query!, targetTenant || undefined);
      if (found.candidates.length === 0) {
        return {
          decided: "search",
          candidates: [],
          truncated: false,
          instructions:
            `No ${platform} account matched that. Ask them how their name or handle is spelled there and search again — ` +
            `or start the code flow instead by calling link_identity with no arguments.`,
        };
      }
      const candidates = await Promise.all(
        found.candidates.map(async (c) => ({ nativeId: c.nativeId, label: fenced(await humanAccountLabel(platform, c.nativeId, targetTenant || undefined)) })),
      );
      return {
        decided: "search",
        candidates,
        truncated: found.truncated,
        instructions:
          `Nothing is linked and nothing has been asked yet. Show them these ${platform} accounts and let them pick ONE, then ` +
          `call link_identity again with that account's nativeId. A name proves nothing on its own — the account itself has to agree.` +
          (found.truncated ? ` More than ${DIRECTORY_MAX_CANDIDATES} matched; ask for a fuller name if none of these is right.` : ""),
      };
    }

    if (platform === binding.platform && targetTenant === linkTenantOf(binding.platform, binding.workspace) && nativeId === actor) {
      throw new Error("that is the account you are speaking from — linking joins two DIFFERENT accounts. Name the other one.");
    }
    const targetName = await humanAccountLabel(platform, nativeId, targetTenant || undefined);
    const issued = await issueLinkChallenge({
      org: binding.org,
      platform: binding.platform,
      tenant: binding.workspace,
      nativeId: actor,
      surfaceKey,
      transport: "directory",
      target: { platform, tenant: targetTenant, nativeId },
    });
    const initiatorAnchor = accountAnchor(binding.platform, binding.workspace, actor);
    const initiatorProfile = await accountProfileFor(binding.platform, actor, binding.workspace);
    const initiatorName = profileName(initiatorProfile);
    try {
      await dispatchDirectMessage(platform, {
        principalId: nativeId,
        text: linkConsentAsk({
          initiatorAnchor,
          ...(initiatorName ? { initiatorName } : {}),
          targetAnchor: accountAnchor(platform, targetTenant, nativeId),
          ttlMinutes: TTL_MINUTES,
        }),
      });
    } catch (err) {
      console.log(`[open-everywhere:identity] link request ${issued.challenge.id}: the consent ask could not be delivered: ${String(err)}`);
      throw new Error(
        `I could not DM that ${platform} account, so nobody can consent to the request — it will expire on its own and nothing was linked. ` +
          `Try the code flow instead: call link_identity with no arguments.`,
      );
    }
    return {
      decided: "awaiting_consent",
      challengeId: issued.challenge.id,
      expiresAt: issued.challenge.expiresAt,
      target: fenced(targetName),
      instructions: linkConsentPendingInstructions(targetName, TTL_MINUTES),
    };
  },
});

function accountAnchor(platform: string, tenant: string | undefined, nativeId: string): string {
  return tryPrincipalKey(platform, tenant, nativeId) ?? `the ${platform} account "${nativeId}"`;
}

function profileName(profile: { readonly name?: string; readonly handle?: string } | undefined): string | undefined {
  if (!profile) return undefined;
  if (profile.name && profile.handle && profile.name !== profile.handle) return `${profile.name} (@${profile.handle})`;
  return profile.name ?? (profile.handle ? `@${profile.handle}` : undefined);
}

function directoryShortfall(platform: string): string | undefined {
  if (!hasAccountDirectory(platform)) {
    const have = accountDirectoryPlatforms();
    return `I have no user directory for it${have.length ? ` (I do for: ${have.join(", ")})` : ""}`;
  }
  if (!canDeliverDirectMessage(platform)) return "I have no way to DM an account there, so nobody could consent privately";
  return undefined;
}

async function issueCodeChallenge(input: {
  readonly org: string;
  readonly platform: string;
  readonly tenant?: string;
  readonly nativeId: string;
  readonly surfaceKey: string;
  readonly why?: string;
}): Promise<{ decided: string; challengeId: string; expiresAt: string; instructions: string }> {
  const issued = await issueLinkChallenge({
    org: input.org,
    platform: input.platform,
    ...(input.tenant ? { tenant: input.tenant } : {}),
    nativeId: input.nativeId,
    surfaceKey: input.surfaceKey,
  });
  if (!issued.code) throw new Error("internal: the code transport issued no code.");
  return {
    decided: "code",
    challengeId: issued.challenge.id,
    expiresAt: issued.challenge.expiresAt,
    instructions: (input.why ? `${input.why} Use the code instead.\n\n` : "") + linkClaimInstructions(issued.code, TTL_MINUTES),
  };
}
