export type MeetingPlatform = "meet" | "teams" | "zoom";

export interface ParsedMeetingLink {
  readonly platform: MeetingPlatform;
  readonly host: string;
  readonly roomId: string;
  readonly tenantId?: string;
  readonly organizerId?: string;
  readonly url: string;
}

export type MeetingLinkResult = { readonly ok: true; readonly link: ParsedMeetingLink } | { readonly ok: false; readonly reason: string };

export const PLATFORM_HOSTS: Readonly<Record<MeetingPlatform, readonly string[]>> = {
  meet: ["meet.google.com"],
  teams: ["teams.microsoft.com", "teams.live.com"],
  zoom: ["zoom.us"],
};

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ZOOM_ID = /^\d{9,11}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function platformOf(host: string): MeetingPlatform | undefined {
  if (PLATFORM_HOSTS.meet.includes(host)) return "meet";
  if (PLATFORM_HOSTS.teams.includes(host)) return "teams";
  if (host === "zoom.us" || /^[a-z0-9-]+\.zoom\.us$/.test(host)) return "zoom";
  return undefined;
}

export function parseMeetingLink(raw: string): MeetingLinkResult {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "that is not a meeting link I can read — paste the full https:// link from the invite" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "a meeting link must start with https://" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "a meeting link must not carry a user name or password" };
  if (url.port !== "") return { ok: false, reason: "a meeting link must not name a port" };
  const host = url.hostname.toLowerCase();
  const platform = platformOf(host);
  if (platform === undefined) {
    return { ok: false, reason: `I only join Google Meet, Microsoft Teams and Zoom meetings, and "${host}" is none of them` };
  }
  if (platform === "meet") {
    const code = url.pathname.replace(/^\//, "").replace(/\/$/, "").toLowerCase();
    if (!MEET_CODE.test(code)) return { ok: false, reason: "that Google Meet link has no meeting code (it looks like abc-defg-hij)" };
    return { ok: true, link: { platform, host, roomId: code, url: `https://${host}/${code}` } };
  }
  if (platform === "teams") {
    const parts = url.pathname.split("/").filter((p) => p.length > 0);
    if (parts[0] === "l" && parts[1] === "meetup-join" && parts[2] !== undefined) {
      const roomId = decodeURIComponent(parts[2]);
      let tenantId: string | undefined;
      let organizerId: string | undefined;
      const context = url.searchParams.get("context");
      if (context !== null) {
        try {
          const parsed = JSON.parse(context) as { Tid?: unknown; Oid?: unknown };
          if (typeof parsed.Tid === "string" && GUID.test(parsed.Tid)) tenantId = parsed.Tid.toLowerCase();
          if (typeof parsed.Oid === "string" && GUID.test(parsed.Oid)) organizerId = parsed.Oid.toLowerCase();
        } catch {
        }
      }
      return {
        ok: true,
        link: { platform, host, roomId, ...(tenantId !== undefined ? { tenantId } : {}), ...(organizerId !== undefined ? { organizerId } : {}), url: url.toString() },
      };
    }
    if (parts[0] === "meet" && parts[1] !== undefined && /^\d{6,20}$/.test(parts[1])) {
      return { ok: true, link: { platform, host, roomId: parts[1], url: url.toString() } };
    }
    return { ok: false, reason: "that Microsoft Teams link is not a meeting join link — copy \"Join the meeting now\" from the invite" };
  }
  const m = /^\/(?:j|wc\/join|wc)\/(\d+)(?:\/join)?\/?$/.exec(url.pathname);
  const roomId = m?.[1];
  if (roomId === undefined || !ZOOM_ID.test(roomId)) {
    return { ok: false, reason: "that Zoom link has no meeting number (it looks like zoom.us/j/123456789)" };
  }
  return { ok: true, link: { platform, host, roomId, url: url.toString() } };
}

export function platformLabel(platform: MeetingPlatform): string {
  return platform === "meet" ? "Google Meet" : platform === "teams" ? "Microsoft Teams" : "Zoom";
}
