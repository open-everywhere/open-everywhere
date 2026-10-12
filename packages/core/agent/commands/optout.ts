import { actingPrincipalId, type SurfaceBinding } from "../identity/binding.js";
import { clearPersonOptOut, readPersonOptOut, setPersonOptOut } from "../identity/person-opt-out.js";
import { agentCommandName } from "../identity/bot-name.js";

function oeSlash(sub: string): string {
  return `/${agentCommandName()} ${sub}`;
}

export type OptOutCommand = { readonly kind: "optout"; readonly action: "status" | "on" | "off" } | { readonly kind: "error"; readonly message: string };

export function parseOptOutTokens(rest: readonly string[]): OptOutCommand {
  const [action] = rest;
  if (!action || action === "status") return { kind: "optout", action: "status" };
  if (action === "on" || action === "off") return { kind: "optout", action };
  return { kind: "error", message: `I don't know "${action}". Try \`${oeSlash("optout on")}\`, \`${oeSlash("optout off")}\` or \`${oeSlash("optout")}\`.` };
}

export function optOutHelpLine(): string {
  return `• \`${oeSlash("optout on|off")}\` — stop me saving memory from your own messages to me, or allow it again. \`${oeSlash("optout")}\` shows your setting.`;
}

const SCOPE_LINE =
  "While it's on, I don't save anything from your own messages to me, and I refuse when someone else uses a message shortcut on one of your messages. Your own requests still work. In a shared conversation, someone else's later message can still lead me to save something you said. It doesn't cover what other people tell me, or questions you send to a domain from your DM. Admins can see this setting.";

export async function runOptOut(binding: SurfaceBinding, action: "status" | "on" | "off"): Promise<string> {
  const principalKey = actingPrincipalId(binding);
  if (!principalKey) return "I could not tell who you are from this command, so I changed nothing.";
  const where = { org: binding.org, platform: binding.platform, workspace: binding.workspace, surface: binding.surface, principalKey };
  try {
    if (action === "status") {
      const state = await readPersonOptOut(binding.org, principalKey);
      if (!state.readable) return "I could not read your setting just now. Until I can, I treat it as on. Try again in a moment.";
      return state.optedOut
        ? `Your opt-out is on (since ${state.since?.slice(0, 10) ?? "an unknown date"}). ${SCOPE_LINE} \`${oeSlash("optout off")}\` turns it off.`
        : `Your opt-out is off. \`${oeSlash("optout on")}\` turns it on. ${SCOPE_LINE}`;
    }
    if (action === "on") {
      const r = await setPersonOptOut(where, "command");
      return r === "set" ? `Your opt-out is now on. ${SCOPE_LINE}` : `Your opt-out was already on. ${SCOPE_LINE}`;
    }
    const r = await clearPersonOptOut(where, "command");
    return r === "cleared" ? "Your opt-out is now off. I can remember things from our conversations again." : "Your opt-out was already off.";
  } catch (err) {
    console.warn(`[open-everywhere:optout] ${action} failed: ${String(err)}`);
    return "I could not change your setting just now. Nothing changed. Try again in a moment.";
  }
}
