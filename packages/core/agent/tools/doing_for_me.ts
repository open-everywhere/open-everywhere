import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalIdOf } from "../access/request.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { doingForPerson, renderDoingMessage } from "../status/doing-for-me.js";

export default defineTool({
  description:
    "List everything I do on my own for the person you are talking to: the routines and watches they set up, my watch over their calendar, the credential grants they lend, the rules they confirmed, and the approval cards and jobs waiting on them. " +
    "DM only, and it only ever reads that person's own list. " +
    'Call it when they ask "what are you doing for me", "what have I set up", "what do you do on my behalf", or "show me my routines". Relay `message` as it comes back — it is written for the person to read.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    count: z.number().int(),
    message: z.string(),
    items: z.array(
      z.object({
        kind: z.enum(["routine", "watch", "grant", "rule", "waiting"]),
        label: z.string(),
        text: z.string(),
        state: z.enum(["on", "paused"]),
      }),
    ),
  }),
  approval: never(),
  async execute(_input, ctx) {
    const c = ctx as BindableContext;
    const binding = bindFrom(c);
    if (binding.mode !== "dm") {
      throw new Error(
        `doing_for_me is DM-only (this conversation is "${binding.mode}") — what I do for somebody is theirs, and only in a 1:1 can this deployment be sure it is talking to them. Ask them to send me a direct message.`,
      );
    }
    // principal-gate: presence — a HUMAN must be here, acting. Their identity IS the query key, so an unattended fire (no acting principal) reads nothing.
    const personId = actingPrincipalIdOf(c);
    if (!personId) {
      throw new Error("doing_for_me needs the person to be here: it reads their own list, and this turn has no acting person.");
    }
    const p = resolvePartition(c);
    const list = await doingForPerson({
      org: binding.org,
      platform: binding.platform,
      workspace: binding.workspace,
      personId,
      dmSurfaceKey: p.surfaceKey,
      trust: binding.trust === "internal" ? "internal" : "external",
      ...(binding.enterprise ? { enterprise: binding.enterprise } : {}),
    });
    return {
      count: list.items.length,
      message: renderDoingMessage(list, binding.platform),
      items: list.items.map((i) => ({ kind: i.kind, label: i.label, text: i.text, state: i.state })),
    };
  },
});
