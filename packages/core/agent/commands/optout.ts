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
  return { kind: "error", message: `Unknown "optout" action "${action}" — try "${oeSlash("optout on")}", "${oeSlash("optout off")}" or "${oeSlash("optout")}".` };
}

export function optOutHelpLine(): string {
  return `• \`${oeSlash("optout on|off")}\` — stop (or allow again) the agent acting on your own content: no memory saved from your own turns, and no shortcut from somebody else on your messages. \`${oeSlash("optout")}\` shows the current state.`;
}

const SCOPE_LINE =
  "While it is on, I save no memory from your own turns with me. In a shared conversation, a later turn by somebody else can still save something you said, and what other people tell me is not covered. A question you ask a domain from your DM is not covered yet: the domain can still save it. I also refuse when somebody else hands me one of your messages with a shortcut. Your own requests still work. Admins can see this choice in the audit log.";

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
