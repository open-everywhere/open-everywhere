import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalIdOf } from "../access/request.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { waitingOnPerson } from "../status/waiting-on-me.js";

export default defineTool({
  description:
    "List what is waiting on the person you are talking to: every open approval card they can decide or that their own work asked for, and every job or thread that reported itself blocked on them or needing them. " +
    "Each item comes with a plain sentence of what will happen or what is stuck, and a link. DM only, and it only ever reads that person's own queue. " +
    'Call it when they ask "what is waiting on me", "what do you need from me", or "anything to approve". Relay `message` as it comes back — it is written for the person to read.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    count: z.number().int(),
    omitted: z.number().int(),
    message: z.string(),
    items: z.array(
      z.object({
        kind: z.enum(["approval", "attention"]),
        sentence: z.string(),
        status: z.string(),
        where: z.string(),
        link: z.string().optional(),
        since: z.string(),
      }),
    ),
  }),
  approval: never(),
  async execute(_input, ctx) {
    const c = ctx as BindableContext;
    const binding = bindFrom(c);
    if (binding.mode !== "dm") {
      throw new Error(
        `waiting_on_me is DM-only (this conversation is "${binding.mode}") — what waits on somebody is theirs, and only in a 1:1 can this deployment be sure it is talking to them. Ask them to send me a direct message.`,
      );
    }
    const personId = actingPrincipalIdOf(c);
    if (!personId) {
      throw new Error("waiting_on_me needs the person to be here: it reads their own queue, and this turn has no acting person.");
    }
    const queue = await waitingOnPerson({
      org: binding.org,
      platform: binding.platform,
      workspace: binding.workspace,
      personId,
      ...(binding.enterprise ? { enterprise: binding.enterprise } : {}),
    });
    return { count: queue.items.length, omitted: queue.omitted, message: queue.message, items: queue.items.map((i) => ({ ...i })) };
  },
});
