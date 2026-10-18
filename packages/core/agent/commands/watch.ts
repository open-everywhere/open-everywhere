import { actingPrincipalId, type SurfaceBinding } from "../identity/binding.js";
import { agentCommandName } from "../identity/bot-name.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { DEFAULT_WATCH_DIAL, WATCH_DIALS, parseWatchDial, type WatchDial } from "../personal-watch/dial.js";
import { auditPersonalWatchRefused, enrollPersonalWatch, readPersonalWatch, setPersonalWatchDial } from "../personal-watch/state.js";
import { personalWatchArmed } from "../personal-watch/watch.js";
import { discoveryOn } from "../personal-watch/discovery.js";

function oeSlash(sub: string): string {
  return `/${agentCommandName()} ${sub}`;
}

export type WatchCommand = { readonly kind: "watch"; readonly action: "status" | WatchDial } | { readonly kind: "error"; readonly message: string };

export function parseWatchTokens(rest: readonly string[]): WatchCommand {
  const [action] = rest;
  if (!action || action === "status") return { kind: "watch", action: "status" };
  const dial = parseWatchDial(action);
  if (dial) return { kind: "watch", action: dial };
  return { kind: "error", message: `I don't know "${action}". Try ${WATCH_DIALS.map((d) => `\`${oeSlash(`watch ${d}`)}\``).join(", ")} or \`${oeSlash("watch")}\`.` };
}

export function watchHelpLine(): string {
  return `• \`${oeSlash("watch more|less|none")}\` — how often I may message you on my own about things that need you, such as two meetings that overlap. \`${oeSlash("watch")}\` shows the current setting.`;
}

const DIAL_LINE: Readonly<Record<WatchDial, string>> = {
  more: "More: I tell you about calendar conflicts up to three days ahead, at most six times a day.",
  less: "Less: I tell you only about calendar conflicts within a day, at most twice a day.",
  none: "None: I do not look, and I do not message you on my own.",
};

export async function runWatch(binding: SurfaceBinding, action: "status" | WatchDial): Promise<string> {
  const acting = actingPrincipalId(binding);
  const principalKey = acting ? tryPrincipalKey(binding.platform, binding.workspace, acting) : undefined;
  if (!principalKey) return "I could not tell who you are from this command, so I changed nothing.";
  const member = binding.trust === "internal";
  if (!member && action !== "none" && action !== "status") {
    const inDm = binding.mode === "dm";
    const where = { org: binding.org, platform: binding.platform, workspace: binding.workspace, surface: binding.surface, principalKey };
    await auditPersonalWatchRefused(where, action, "command", inDm ? "not-member" : "room-unconfirmed");
    return inDm
      ? "The watch is for members of this organisation, so I changed nothing."
      : `I could not confirm that this room is inside the organisation, so I changed nothing. Send \`${oeSlash(`watch ${action}`)}\` in your direct message with me.`;
  }
  const armedNote = personalWatchArmed()
    ? ""
    : discoveryOn()
      ? " Your calendar isn't connected for this yet. I still look for work you repeat each week."
      : " Your calendar isn't connected for this yet, so I don't look until it is.";
  const quiet = " I stay quiet between 20:00 and 07:00 UTC.";
  try {
    if (action === "status") {
      if (member) await enrollPersonalWatch(binding.org, principalKey);
      const read = await readPersonalWatch(binding.org, principalKey);
      if (read.readable && read.state === undefined) return "You have no watch: it is for members of this organisation.";
      if (!read.readable) return "I could not read your setting just now. Until I can, I do not message you on my own. Try again in a moment.";
      const dial = read.state?.dial ?? DEFAULT_WATCH_DIAL;
      const start = read.state?.dialSource === "default" || read.state === undefined ? " That is the start setting." : "";
      const dose = (read.state?.dampening ?? 0) > 0 ? ` You marked messages not useful, so I hold back ${read.state!.dampening} step(s) more than this setting says.` : "";
      return `${DIAL_LINE[dial]}${start}${dose}${quiet}${armedNote} Change it with \`${oeSlash("watch more")}\`, \`${oeSlash("watch less")}\` or \`${oeSlash("watch none")}\`.`;
    }
    const where = { org: binding.org, platform: binding.platform, workspace: binding.workspace, surface: binding.surface, principalKey };
    const r = await setPersonalWatchDial(where, action, "command", undefined, { existingOnly: !member });
    if (!r.written) return "You have no watch: it is for members of this organisation.";
    return `${r.changed ? "Done." : "It was already set."} ${DIAL_LINE[action]}${action === "none" ? "" : quiet}${armedNote}`;
  } catch (err) {
    console.warn(`[open-everywhere:watch] ${action} failed: ${String(err)}`);
    return "I could not change your setting just now. Nothing changed. Try again in a moment.";
  }
}
