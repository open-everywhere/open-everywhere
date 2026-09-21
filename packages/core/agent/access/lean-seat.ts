import type { WindowGrain } from "../identity/binding.js";
import { HARNESS_INTERNAL_TOOLS } from "./job-posture.js";

export const LEAN_SEAT_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "edit_reply",
  "no_reply",
  "react",
  "update_status",
  "stand_down",
  "halt",
  "set_dm_delivery",
  "agent",
  "spawn_thread_session",
  "complete_thread",
  "task_cancel",
  "read_channel",
  "read_thread",
]);

export const DM_SEAT_CARVE_IN: ReadonlySet<string> = new Set(["link_identity", "confirm_link", "unlink_identity", "revoke_credential_grant"]);

export type LeanSeatPosture = "lean" | "full";

export interface LeanSeatSignals {
  readonly grain: WindowGrain;
  readonly canDelegate: boolean;
  readonly unattendedFire: boolean;
}

export function resolveLeanSeatPosture(s: LeanSeatSignals): LeanSeatPosture {
  if (s.unattendedFire) return "full";
  if (s.grain !== "standing" && s.grain !== "thread") return "full";
  return s.canDelegate ? "lean" : "full";
}

export function allowedOnLeanSeat(name: string, dmSeat = false): boolean {
  return LEAN_SEAT_TOOLS.has(name) || HARNESS_INTERNAL_TOOLS.has(name) || (dmSeat && DM_SEAT_CARVE_IN.has(name));
}

export function restrictToolsetForLeanSeat(toolset: Record<string, unknown>, dmSeat = false): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(toolset)) {
    if (allowedOnLeanSeat(name, dmSeat)) continue;
    delete toolset[name];
    removed.push(name);
  }
  return removed.sort();
}

export function withheldFromLeanSeat(gated: Readonly<Record<string, readonly string[]>>, ungated: ReadonlySet<string>, dmSeat = false): string[] {
  return [...new Set([...Object.keys(gated), ...ungated])].filter((name) => !allowedOnLeanSeat(name, dmSeat)).sort();
}
