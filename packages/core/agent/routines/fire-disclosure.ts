import { resolveAudienceFloor, type AudienceFloor, type RoomRoster } from "../access/audience-floor.js";
import { postUnifiedReply } from "../channels/unified-reply.js";
import type { UnifiedWakeOrigin } from "../channels/unified-window.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

export type FireDisclosureVerdict =
  | { readonly ok: true; readonly floor: AudienceFloor }
  | { readonly ok: false; readonly reason: "audience-floor"; readonly floor: AudienceFloor };

export interface FireDisclosureInput {
  readonly floor: AudienceFloor;
  readonly roster: RoomRoster;
}

export function classifyFireDisclosure(input: FireDisclosureInput): FireDisclosureVerdict {
  if (input.roster.resolved && input.floor === "guest") {
    return { ok: false, reason: "audience-floor", floor: input.floor };
  }
  return { ok: true, floor: input.floor };
}

const NO_ADMINS: ReadonlySet<string> = new Set<string>();

export interface FireDisclosureDeps {
  readonly floor?: typeof resolveAudienceFloor;
}

export async function checkFireDisclosure(surfaceKey: string, deps: FireDisclosureDeps = {}): Promise<FireDisclosureVerdict> {
  try {
    const resolution = await (deps.floor ?? resolveAudienceFloor)(surfaceKey, NO_ADMINS);
    return classifyFireDisclosure(resolution);
  } catch (err) {
    log(`audience floor unresolvable for ${surfaceKey} (${String(err)}) — fire disclosure inert`);
    return { ok: true, floor: "guest" };
  }
}

export function fireWithheldNoticeText(_routineId: string): string {
  return (
    `🔒 A routine in this channel has an update, but I can't post it here because this channel ` +
    `includes guests or people from outside your organisation. Move the routine to an internal ` +
    `channel, or remove those members, and its updates start again.`
  );
}

export interface FireWithheldNoticeDeps {
  readonly post?: (origin: UnifiedWakeOrigin, text: string) => Promise<string>;
}

export async function announceFireWithheld(
  routineId: string,
  surfaceKey: string,
  origin: UnifiedWakeOrigin | undefined,
  deps: FireWithheldNoticeDeps = {},
): Promise<boolean> {
  if (!origin) {
    log(`withheld-fire notice SKIPPED for ${routineId} [${surfaceKey}] — no post-back origin for this surface (audit row still written)`);
    return false;
  }
  try {
    await (deps.post ?? postUnifiedReply)(origin, fireWithheldNoticeText(routineId));
    log(`withheld-fire notice posted for ${routineId} [${surfaceKey}]`);
    return true;
  } catch (err) {
    log(`withheld-fire notice FAILED for ${routineId} [${surfaceKey}]: ${String(err)}`);
    return false;
  }
}
