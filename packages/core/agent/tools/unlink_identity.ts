import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { normalizePlatform } from "../identity/platform.js";
import { unlinkOwnId } from "../identity/link-store.js";

export default defineTool({
  description:
    "Remove a linked account from the caller's own identity link-set — their current account by default, or another account already on their set (platform + nativeId). DM only, and it can only ever touch the caller's OWN set. Takes effect immediately; the account can be linked again later with link_identity.",
  inputSchema: z.object({
    platform: z.string().optional().describe("Platform of the account to unlink (e.g. \"github\"). Omit to unlink the account this person is speaking from."),
    nativeId: z.string().optional().describe("That platform's native account id. Required when `platform` is given."),
  }),
  outputSchema: z.object({
    unlinked: z.string(),
    linkSetId: z.string(),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    if (binding.mode !== "dm") {
      throw new Error(`unlink_identity is DM-only (this conversation is "${binding.mode}") — a person's identity links are theirs to change, and only they can be identified as themselves in a DM.`);
    }
    const actor = actingPrincipalIdOf(ctx);
    if (!actor) {
      throw new Error("unlink_identity needs a verified person on this turn — only the human whose links these are can remove them.");
    }
    if ((input.platform === undefined) !== (input.nativeId === undefined)) {
      throw new Error("unlink_identity needs BOTH platform and nativeId, or neither (which unlinks the account you are speaking from).");
    }
    const target = input.platform !== undefined && input.nativeId !== undefined ? { platform: normalizePlatform(input.platform) ?? input.platform, nativeId: input.nativeId } : undefined;
    const result = await unlinkOwnId({
      org: binding.org,
      actor: { platform: binding.platform, nativeId: actor },
      ...(target ? { target } : {}),
    });
    if (!result.ok) throw new Error(result.reason);
    return { unlinked: target ? `${target.platform}/${target.nativeId}` : `${binding.platform}/${actor}`, linkSetId: result.linkSetId, note: result.note };
  },
});
