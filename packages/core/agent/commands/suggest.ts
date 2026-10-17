import { actingPrincipalId, type SurfaceBinding } from "../identity/binding.js";
import { agentCommandName } from "../identity/bot-name.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { partitionOfBinding } from "../memory/partition.js";
import { discoveryOn } from "../personal-watch/discovery.js";
import { readRoomStop, resumeRoomDiscovery, stopRoomDiscovery } from "../personal-watch/room-discovery.js";

function oeSlash(sub: string): string {
  return `/${agentCommandName()} ${sub}`;
}

export type SuggestCommand = { readonly kind: "suggest"; readonly action: "status" | "on" | "off" } | { readonly kind: "error"; readonly message: string };

export function parseSuggestTokens(rest: readonly string[]): SuggestCommand {
  const [action] = rest;
  if (!action || action === "status") return { kind: "suggest", action: "status" };
  if (action === "on" || action === "off") return { kind: "suggest", action };
  return { kind: "error", message: `I don't know "${action}". Try \`${oeSlash("suggest off")}\`, \`${oeSlash("suggest on")}\` or \`${oeSlash("suggest")}\`.` };
}

export function suggestHelpLine(): string {
  return `• \`${oeSlash("suggest off|on")}\` — stop or allow my routine suggestions where you type it. \`${oeSlash("suggest")}\` shows the setting.`;
}

export async function runSuggest(binding: SurfaceBinding, action: "status" | "on" | "off"): Promise<string> {
  if (binding.mode !== "channel") return `This works in a shared channel. In your DM, \`${oeSlash("watch none")}\` stops what I send you on my own.`;
  const acting = actingPrincipalId(binding);
  const principalKey = acting ? tryPrincipalKey(binding.platform, binding.workspace, acting) : undefined;
  if (!principalKey) return "I could not tell who you are from this command, so I changed nothing.";
  const p = partitionOfBinding(binding);
  const where = { org: binding.org, platform: binding.platform, workspace: binding.workspace, surface: binding.surface, surfaceKey: p.surfaceKey, principalKey };
  const offNote = discoveryOn() ? "" : " Routine suggestions are also off for this whole deployment.";
  try {
    if (action === "status") {
      const stop = await readRoomStop(binding.org, p.surfaceKey);
      if (!stop.readable) return "I could not read the setting here just now. Until I can, I suggest nothing here. Try again in a moment.";
      return stop.stopped
        ? `My routine suggestions are off here. \`${oeSlash("suggest on")}\` turns them back on.${offNote}`
        : `When people here repeat the same work each week, I may suggest a routine for it. \`${oeSlash("suggest off")}\` stops that.${offNote}`;
    }
    if (action === "off") {
      const r = await stopRoomDiscovery(where);
      return r.changed
        ? `Done. I won't suggest routines here. A member can turn them back on with \`${oeSlash("suggest on")}\`.`
        : "My routine suggestions were already off here.";
    }
    if (binding.trust !== "internal") return "Only a member of this organisation can turn suggestions back on, so I changed nothing.";
    const r = await resumeRoomDiscovery(where);
    return r.changed ? `Done. I may suggest a routine here again.${offNote}` : `My routine suggestions were already on here.${offNote}`;
  } catch (err) {
    console.warn(`[open-everywhere:suggest] ${action} failed: ${String(err)}`);
    return "I could not change the setting here just now. Nothing changed. Try again in a moment.";
  }
}
