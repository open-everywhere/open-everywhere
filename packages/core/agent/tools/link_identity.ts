import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { surfaceKeyOf } from "../access/resolver.js";
import { issueLinkChallenge } from "../identity/link-store.js";
import { linkClaimInstructions, LINK_CHALLENGE_TTL_MS } from "../identity/link-challenge.js";

export default defineTool({
  description:
    "Start linking another account (GitHub, Linear, Slack, …) to the person you are talking to, so their work is attributed to ONE human across surfaces. DM only. Returns a short single-use code plus instructions: the person posts `link <code>` from their OTHER account anywhere this agent can read, and then confirms — in this DM — the account that claimed it. Nothing is linked until that confirmation. Relay the returned instructions verbatim; do not paraphrase the code.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    challengeId: z.string(),
    expiresAt: z.string(),
    instructions: z.string(),
  }),
  approval: never(),
  async execute(_input, ctx) {
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
    const p = resolvePartition(ctx);
    const issued = await issueLinkChallenge({
      org: binding.org,
      platform: binding.platform,
      nativeId: actor,
      surfaceKey: surfaceKeyOf({ platform: p.platform, workspace: p.workspace, channel: p.surface }),
    });
    return {
      challengeId: issued.challenge.id,
      expiresAt: issued.challenge.expiresAt,
      instructions: linkClaimInstructions(issued.code, Math.round(LINK_CHALLENGE_TTL_MS / 60_000)),
    };
  },
});
