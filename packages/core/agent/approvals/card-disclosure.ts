import { resolveAudienceFloor, type AudienceFloor, type RoomRoster } from "../access/audience-floor.js";

export type CardDisclosureVerdict =
  | { readonly ok: true; readonly floor: AudienceFloor }
  | { readonly ok: false; readonly reason: "audience-floor"; readonly floor: AudienceFloor };

export interface CardDisclosureInput {
  readonly floor: AudienceFloor;
  readonly roster: RoomRoster;
}

export function classifyCardDisclosure(input: CardDisclosureInput): CardDisclosureVerdict {
  if (input.roster.resolved && input.floor === "guest") {
    return { ok: false, reason: "audience-floor", floor: input.floor };
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

export function cardDisclosureRefusalNotice(): string {
  return (
    "I can't put an approval card in this channel. Its audience floor resolved to \"guest\" — the " +
    "platform reports it as externally shared, or carrying an observed guest — and an approval card " +
    "spells out exactly what would execute, so posting one here would show that to people outside " +
    "your org. Nothing about the action is in this message, deliberately. Ask me again in a channel " +
    "that isn't shared outside your org (or remove the external members) and it will work as normal."
  );
}
