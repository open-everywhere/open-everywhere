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
      return (
        "I didn't apply that: this channel's audience floor resolved to \"guest\" — it's externally shared, " +
        "or carries an observed guest/external member — so a decision made here can't stand in for one made " +
        "inside the org. The request is still pending; decide it from an internal channel and it will apply."
      );
    case "unattested-room":
      return (
        "I didn't apply that: approving it would hand YOU a live signing secret, and I couldn't verify who " +
        "is in this channel (the membership list didn't resolve). The request is still pending; decide it " +
        "from a channel whose membership I can read and it will apply."
      );
    case "foreign-room":
      return "I didn't apply that: this click didn't come from the channel the card was posted in. The request is still pending.";
    case "guest-clicker":
      return (
        "I didn't apply that: you could not be confirmed as a member of this workspace, so this decision " +
        "can't be made on the org's behalf. The request is still pending; a confirmed member of the org " +
        "can decide it and it will apply."
      );
  }
}
