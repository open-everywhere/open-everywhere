import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalIdOf } from "../access/request.js";
import { ownerGrantListText, ownerLiveGrants, revokeOwnerGrants } from "../access/credential-grant-revoke.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { resolvePartition } from "../memory/partition.js";

export default defineTool({
  description:
    "List, or END, the credential grants the person you are talking to is lending — the grants that let another conversation spend THEIR own connector account. " +
    "DM only, and it only ever reaches that person's own grants. Call it with `list` first: it answers with a numbered list, and the numbers are what `end` takes. " +
    "Ending a grant is immediate and cannot be undone, and its next call on the borrowed tool is refused. I also try to tell the conversation that held it — my answer says when I could not reach one, so relay that too. " +
    "Relay the answer as it comes back — it is written for the person to read.",
  inputSchema: z.object({
    action: z.enum(["list", "end"]).describe("`list` reads what they are lending and changes nothing. `end` revokes."),
    all: z
      .boolean()
      .optional()
      .describe("For `end` only: end EVERY grant they are lending. Use it only when they said to end all of them, never as a shortcut for one."),
    which: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        "For `end` only: the numbers from the list you just read, for example [1] or [1, 3]. " +
          "Read the list in this same turn and take the numbers from it — never a number they or you remember from earlier. " +
          "🔴 NAME EVERY NUMBER YOU MEAN IN ONE CALL. The numbers are positions in the live list, so ending one RENUMBERS the rest: " +
          "a second `end` using the first list's numbers would end a grant nobody named, and a revoke cannot be undone. " +
          "If you do call it again, use the numbers printed in the previous call's own answer.",
      ),
  }),
  outputSchema: z.object({
    ended: z.number(),
    live: z.number(),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const c = ctx as BindableContext;
    const binding = bindFrom(c);
    if (binding.mode !== "dm") {
      throw new Error(
        `revoke_credential_grant is DM-only (this conversation is "${binding.mode}") — which conversations somebody lends their credential to is theirs, ` +
          "and only in a 1:1 can this deployment be sure it is talking to them. Ask them to send me a direct message.",
      );
    }
    const actor = actingPrincipalIdOf(c);
    if (actor === undefined) {
      throw new Error("revoke_credential_grant needs a verified person on this turn — only the person whose credential a grant spends can end it.");
    }
    const p = resolvePartition(c);
    const ownerKey = tryPrincipalKey(p.platform, p.workspace, actor);
    if (ownerKey === undefined) {
      throw new Error(
        "I cannot tell which workspace this account belongs to, so I cannot look up what you are lending. Nothing was changed. Ask whoever runs this deployment to check the surface configuration.",
      );
    }
    const nowMs = Date.now();
    const stamps = { org: p.org, platform: p.platform, workspace: p.workspace, ...(p.surface === undefined ? {} : { surface: p.surface }) };

    if (input.action === "list") {
      const holdings = await ownerLiveGrants(p.org, ownerKey, nowMs);
      return { ended: 0, live: holdings.length, message: ownerGrantListText(holdings) };
    }
    const wantsAll = input.all === true;
    const numbered = input.which ?? [];
    if (wantsAll === (numbered.length > 0)) {
      throw new Error(
        "To end a grant, give either the numbers from the list (`which`) or `all: true` — one of the two, never both and never neither. Read the list first.",
      );
    }
    const outcome = await revokeOwnerGrants(stamps, ownerKey, wantsAll ? undefined : numbered, nowMs);
    return { ended: outcome.ended.length, live: outcome.remaining.length, message: outcome.text };
  },
});
