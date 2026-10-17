import { admitProviderRegistration } from "../access/provider-selection.js";
import { discordInviteCode, parseMeetingLink, type MeetingLinkResult } from "./link.js";

export type MeetingInviteLookup =
  | { readonly found: true; readonly guildId: string; readonly channelId: string; readonly channelKind: "voice" | "stage" | "other" }
  | { readonly found: false; readonly why: "unknown" | "no-channel" | "unreachable" };

export type MeetingInviteResolver = (code: string) => Promise<MeetingInviteLookup>;

const INVITE_RESOLVERS = new Map<"discord", MeetingInviteResolver>();

export function registerMeetingInviteResolver(platform: "discord", resolver: MeetingInviteResolver): void {
  if (!admitProviderRegistration(platform, "meeting-invite-resolver")) return;
  INVITE_RESOLVERS.set(platform, resolver);
}

export function resetMeetingInviteResolversForTest(): void {
  INVITE_RESOLVERS.clear();
}

const COPY_LINK = "right-click the voice channel, choose \"Copy Link\", and paste that";

export function inviteRefusal(why: "no-resolver" | "unknown" | "no-channel" | "unreachable" | "stage" | "other"): string {
  switch (why) {
    case "no-resolver":
      return `that is a Discord invite link, and this deployment has no Discord connection to look it up — ${COPY_LINK}`;
    case "unknown":
      return `that Discord invite has expired or does not exist — make a new one, or ${COPY_LINK}`;
    case "no-channel":
      return `that Discord invite is not to a server's voice channel — ${COPY_LINK}`;
    case "unreachable":
      return `I couldn't reach Discord to look that invite up just now — try again in a minute, or ${COPY_LINK}`;
    case "stage":
      return "that Discord invite is to a stage channel, and the notetaker joins voice channels only";
    case "other":
      return "that Discord invite is to a text channel, not a voice channel — invite me to the voice channel you want recorded";
  }
}

export async function resolveMeetingLink(raw: string, resolvers: ReadonlyMap<"discord", MeetingInviteResolver> = INVITE_RESOLVERS): Promise<MeetingLinkResult> {
  const code = discordInviteCode(raw);
  if (code === undefined) return parseMeetingLink(raw);
  const resolver = resolvers.get("discord");
  if (resolver === undefined) return { ok: false, reason: inviteRefusal("no-resolver") };
  let found: MeetingInviteLookup;
  try {
    found = await resolver(code);
  } catch {
    found = { found: false, why: "unreachable" };
  }
  if (!found.found) return { ok: false, reason: inviteRefusal(found.why) };
  if (found.channelKind !== "voice") return { ok: false, reason: inviteRefusal(found.channelKind) };
  const parsed = parseMeetingLink(`https://discord.com/channels/${found.guildId}/${found.channelId}`);
  return parsed.ok ? parsed : { ok: false, reason: inviteRefusal("unreachable") };
}
