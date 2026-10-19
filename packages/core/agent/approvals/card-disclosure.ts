import { resolveAudienceFloor, type AudienceFloor, type RoomRoster, type RoomShape } from "../access/audience-floor.js";

export type CardDisclosureVerdict =
  | { readonly ok: true; readonly floor: AudienceFloor }
  | { readonly ok: false; readonly reason: "audience-floor"; readonly floor: AudienceFloor; readonly room?: RoomShape };

export interface CardDisclosureInput {
  readonly floor: AudienceFloor;
  readonly roster: RoomRoster;
}

export function classifyCardDisclosure(input: CardDisclosureInput): CardDisclosureVerdict {
  if (input.roster.resolved && input.floor === "guest") {
    return { ok: false, reason: "audience-floor", floor: input.floor, ...(input.roster.room === undefined ? {} : { room: input.roster.room }) };
  }
  return { ok: true, floor: input.floor };
}

const NO_ADMINS: ReadonlySet<string> = new Set<string>();

export interface CardDisclosureDeps {
  readonly floor?: typeof resolveAudienceFloor;
}

export async function checkCardDisclosure(surfaceKey: string, deps: CardDisclosureDeps = {}): Promise<CardDisclosureVerdict> {
  try {
    const resolution = await (deps.floor ?? resolveAudienceFloor)(surfaceKey, NO_ADMINS);
    return classifyCardDisclosure(resolution);
  } catch (err) {
    console.log(`[open-everywhere:approvals] audience floor unresolvable for ${surfaceKey} (${String(err)}) — card disclosure inert`);
    return { ok: true, floor: "guest" };
  }
}

export function cardDisclosureRefusalNotice(room?: RoomShape): string {
  if (room === "dm") {
    return (
      "I can't put an approval card in this DM. The platform reports it as shared outside your org, or " +
      "the person in it as a guest, and an approval card spells out exactly what would execute. " +
      "Nothing about the action is in this message, deliberately. A member of your org can ask me " +
      "for it in their own DM, or in a channel that isn't shared outside your org."
    );
  }
  const where = room === "group-dm" ? "group DM" : "channel";
  return (
    `I can't put an approval card in this ${where}. Its audience floor resolved to "guest" — the ` +
    "platform reports it as externally shared, or carrying an observed guest — and an approval card " +
    "spells out exactly what would execute, so posting one here would show that to people outside " +
    `your org. Nothing about the action is in this message, deliberately. Ask me again in a ${where} ` +
    "that isn't shared outside your org (or remove the external members) and it will work as normal."
  );
}
