import { resolveAudienceFloor, type AudienceFloor, type RoomRoster } from "../access/audience-floor.js";
import type { PendingActionRow } from "./types.js";

export type ClickerFloorRefusal =
  | "audience-floor"
  | "unattested-room"
  | "foreign-room"
  | "guest-clicker";

export type ClickerFloorVerdict =
  | { readonly ok: true; readonly floor: AudienceFloor }
  | { readonly ok: false; readonly reason: ClickerFloorRefusal; readonly floor: AudienceFloor };

export interface ClickerFloorInput {
  readonly floor: AudienceFloor;
  readonly roster: RoomRoster;
  readonly beneficiaryClicker: boolean;
}

export function classifyClickerFloor(input: ClickerFloorInput): ClickerFloorVerdict {
  if (input.roster.resolved && input.floor === "guest") {
    return { ok: false, reason: "audience-floor", floor: input.floor };
  }
  if (input.beneficiaryClicker && !input.roster.resolved) {
    return { ok: false, reason: "unattested-room", floor: input.floor };
  }
  return { ok: true, floor: input.floor };
}

const NO_ADMINS: ReadonlySet<string> = new Set<string>();

export interface ClickerFloorDeps {
  readonly floor?: typeof resolveAudienceFloor;
}

export async function checkClickerFloor(
  surfaceKey: string,
  opts: {
    readonly beneficiaryClicker: boolean;
    readonly clickerIsGuest?: boolean;
  },
  deps: ClickerFloorDeps = {},
): Promise<ClickerFloorVerdict> {
  if (opts.clickerIsGuest === true) return { ok: false, reason: "guest-clicker", floor: "guest" };
  try {
    const resolution = await (deps.floor ?? resolveAudienceFloor)(surfaceKey, NO_ADMINS);
    return classifyClickerFloor({ ...resolution, beneficiaryClicker: opts.beneficiaryClicker });
  } catch (err) {
    console.log(`[open-everywhere:approvals] audience floor unresolvable for ${surfaceKey} (${String(err)}) — clicker floor inert`);
    return { ok: true, floor: "guest" };
  }
}

export function clickRoomMatches(row: PendingActionRow, clickSurfaceKey: string): boolean {
  const segs = clickSurfaceKey.split("/");
  if (segs.length !== 3) return true;
  const channelId = segs[2] as string;
  if (channelId.length === 0) return true;
  return channelId === row.channelId;
}

export function clickerFloorRefusalNotice(reason: ClickerFloorRefusal): string {
  switch (reason) {
    case "audience-floor":
      return "Nothing changed: this channel has people from outside the org, so a decision here doesn't count. Decide it from an internal channel. The request is still open.";
    case "unattested-room":
      return "Nothing changed: approving this sends you a secret, and I couldn't check who is in this channel. Decide it from a channel I can check. The request is still open.";
    case "foreign-room":
      return "Nothing changed: that click didn't come from the channel the card is in. The request is still open.";
    case "guest-clicker":
      return "Nothing changed: I couldn't confirm you are a member of this workspace. A member can decide it. The request is still open.";
  }
}
