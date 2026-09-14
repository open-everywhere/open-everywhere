import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { personAddress, readDmAudience, resumeDmAudience, stopDmAudience } from "../channels/dm-audience.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

export function isOneToOneDm(ctx: BindableContext): boolean {
  try {
    return bindFrom(ctx).mode === "dm";
  } catch {
    return false;
  }
}

const setDmDeliveryEntry = defineTool({
  description:
    "Turn the direct messages THIS agent starts with the person you are talking to on or off, at " +
    "their request. Call it with deliver:false the moment they ask you to stop DMing them, however " +
    "they phrase it — no configuration overrides their choice, and it holds until they ask you back. " +
    "Call it with deliver:true only when they ask you to start again. It changes nothing about this " +
    "conversation: they can always message you here and you always answer. After calling it, say in " +
    "one short line what you did.",
  inputSchema: z.object({
    deliver: z
      .boolean()
      .describe("false = stop starting direct messages with this person. true = they asked you to start again."),
    reason: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("One short phrase for the trail — how the ask was made. Never their message text."),
  }),
  outputSchema: z.object({ delivering: z.boolean(), changed: z.boolean(), note: z.string() }),
  async execute(input, ctx) {
    const c = ctx as BindableContext;
    const binding = bindFrom(c);
    if (binding.mode !== "dm") {
      throw new Error(
        "set_dm_delivery: this only works in a one-to-one direct message, so nothing was changed — reply that you could NOT change it here, and ask them to tell you in their own DM with you.",
      );
    }
    const actor = actingPrincipalIdOf(c);
    if (!actor) {
      throw new Error(
        "set_dm_delivery: this turn carries no verified person, so nothing was changed — reply that you could NOT change it, and that they should ask again or ask an admin.",
      );
    }
    const p = resolvePartition(c);
    const address = personAddress(binding.platform, actor);
    const subject = { org: p.org, address, platform: binding.platform, workspace: binding.workspace, principalId: actor };

    if (!input.deliver) {
      const { changed } = await stopDmAudience({ ...subject, at: new Date().toISOString() });
      return {
        delivering: false,
        changed,
        note: changed
          ?
            "Done — you will not start another direct message with them, and no configuration lifts that. Two things still reach them: an alert about their own account, and an answer to something they asked for themselves. They can also message you here whenever they want, and you still answer."
          : "They had already stopped it, and it is still stopped. Say so plainly rather than implying you just changed something.",
      };
    }

    const { changed } = await resumeDmAudience(subject);
    if (!changed) {
      const state = await readDmAudience(p.org, address);
      return {
        delivering: !state.stopped,
        changed: false,
        note: "They had not stopped you, so nothing changed — you could already start a direct message with them when there is a reason to.",
      };
    }
    return {
      delivering: true,
      changed: true,
      note: "Done — they lifted their own stop, so you may start a direct message with them again when there is a reason to.",
    };
  },
});
preRegisterDynamicEntry("set_dm_delivery", "_single", setDmDeliveryEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => (isOneToOneDm(ctx as BindableContext) ? setDmDeliveryEntry : null),
  },
});
