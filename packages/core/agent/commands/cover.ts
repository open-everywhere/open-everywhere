import { accountProfileFor, sanitizeFragment } from "../identity/account-display-name.js";
import { actingPrincipalId, type SurfaceBinding } from "../identity/binding.js";
import { agentCommandName } from "../identity/bot-name.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { coverLive, readPersonalCover, turnCoverOff, turnCoverOn } from "../cover/state.js";

function oeSlash(sub: string): string {
  return `/${agentCommandName()} ${sub}`;
}

const COVER_MAX_DAYS = 90;

export type CoverCommand =
  | { readonly kind: "cover"; readonly action: "status" | "off" }
  | { readonly kind: "cover"; readonly action: "on"; readonly until?: string }
  | { readonly kind: "error"; readonly message: string };

export function parseCoverTokens(rest: readonly string[]): CoverCommand {
  const [action, word, date, ...extra] = rest;
  if (!action || action === "status") return { kind: "cover", action: "status" };
  if (action === "off") return { kind: "cover", action: "off" };
  if (action === "on") {
    if (word === undefined) return { kind: "cover", action: "on" };
    if (word === "until" && date !== undefined && extra.length === 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
      return { kind: "cover", action: "on", until: `${date}T00:00:00.000Z` };
    }
    return { kind: "error", message: `Give the date you are back as year-month-day, for example \`${oeSlash("cover on until 2026-10-21")}\`.` };
  }
  return { kind: "error", message: `I don't know "${action}". Try \`${oeSlash("cover on")}\`, \`${oeSlash("cover off")}\` or \`${oeSlash("cover")}\`.` };
}

export function coverHelpLine(): string {
  return `• \`${oeSlash("cover on|off")}\` — while you are away, I answer questions people ask you in my channels, marked as cover, and send you a recap when you are back. Add \`until 2026-10-21\` to end it on a date.`;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const WHAT_COVER_DOES =
  "When someone mentions you in a channel I am in, I answer from what that channel already knows, and I mark the answer as cover. I never promise or decide anything for you.";

export async function runCover(binding: SurfaceBinding, cmd: Extract<CoverCommand, { kind: "cover" }>, now = new Date()): Promise<string> {
  const acting = actingPrincipalId(binding);
  const principalKey = acting ? tryPrincipalKey(binding.platform, binding.workspace, acting) : undefined;
  if (!principalKey || !acting) return "I could not tell who you are from this command, so I changed nothing.";
  const where = { org: binding.org, platform: binding.platform, workspace: binding.workspace, surface: binding.surface, principalKey };
  const until = cmd.action === "on" ? cmd.until : undefined;
  try {
    if (cmd.action === "status") {
      const read = await readPersonalCover(binding.org, principalKey);
      if (!read.readable) return "I could not read your setting just now. Until I can, I answer for nobody. Try again in a moment.";
      const s = read.state;
      if (!coverLive(s, now)) {
        const pending = s?.recapDue === true ? ` Your recap of ${s.entries.length} question${s.entries.length === 1 ? "" : "s"} is on its way to this DM.` : "";
        return `Cover is off.${pending} Turn it on with \`${oeSlash("cover on")}\` in your DM with me.`;
      }
      const until = s?.until !== undefined ? ` until ${longDate(s.until)}` : "";
      const asked = s!.entries.length;
      return `Cover is on${until}. ${asked === 0 ? "Nobody has asked for you yet." : `I have covered ${asked} question${asked === 1 ? "" : "s"} so far.`} Turn it off with \`${oeSlash("cover off")}\`.`;
    }
    if (cmd.action === "off") {
      const r = await turnCoverOff(where, "command", now.toISOString());
      if (!r.wasOn) return "Cover was already off. Nothing changed.";
      return r.questions > 0
        ? `Cover is off. I'll send you a recap of the ${r.questions} question${r.questions === 1 ? "" : "s"} I covered in your DM within a few minutes.`
        : "Cover is off. Nobody asked for you while it was on.";
    }
    if (binding.mode !== "dm") return `Turn cover on from your direct message with me, so it stays your own choice. \`${oeSlash("cover off")}\` works anywhere.`;
    if (binding.trust !== "internal") return "Cover is for members of this organisation, so I changed nothing.";
    if (until !== undefined) {
      const end = Date.parse(until);
      if (end <= now.getTime()) return "That date has already started. Give the first day you are back.";
      if (end - now.getTime() > COVER_MAX_DAYS * 24 * 60 * 60 * 1000) return `Give a date within ${COVER_MAX_DAYS} days.`;
    }
    const profile = await accountProfileFor(binding.platform, acting, binding.workspace).catch(() => undefined);
    const rawName = profile?.name ?? profile?.handle;
    const name = rawName ? sanitizeFragment(rawName) : undefined;
    const r = await turnCoverOn(where, { ...(until !== undefined ? { until } : {}), ...(name ? { name } : {}), via: "command" }, now.toISOString());
    const untilWords = until !== undefined ? ` until ${longDate(until)}` : "";
    return `${r.changed ? "Done." : "It was already on."} Cover is on${untilWords}. ${WHAT_COVER_DOES} Turn it off with \`${oeSlash("cover off")}\`, and I send you a recap here.`;
  } catch (err) {
    console.warn(`[open-everywhere:cover] ${cmd.action} failed: ${String(err)}`);
    return "I could not change your setting just now. Nothing changed. Try again in a moment.";
  }
}
