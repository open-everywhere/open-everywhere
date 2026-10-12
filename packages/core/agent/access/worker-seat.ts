import type { WindowGrain } from "../identity/binding.js";

export const WORKER_WITHHELD_TOOLS: ReadonlySet<string> = new Set<string>([
  "no_reply",
  "stand_down",
  "read_channel",
  "read_thread",
]);

export const WORKER_SEAT_RESERVED_TOOLS: ReadonlySet<string> = new Set<string>([
  "link_identity",
  "confirm_link",
  "unlink_identity",
  "revoke_credential_grant",
  "ask_domain",
  "expect_bot_reply",
]);

export const WORKER_UNMOUNTED_TOOLS: ReadonlySet<string> = new Set<string>([...WORKER_WITHHELD_TOOLS, ...WORKER_SEAT_RESERVED_TOOLS]);

export function chatArmGrain(grain: WindowGrain): boolean {
  return grain === "task";
}

export function allowedOnWorkerSeat(name: string, withheld: ReadonlySet<string> = WORKER_UNMOUNTED_TOOLS): boolean {
  return !withheld.has(name);
}

export function restrictToolsetForWorkerSeat(toolset: Record<string, unknown>, withheld: ReadonlySet<string> = WORKER_UNMOUNTED_TOOLS): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(toolset)) {
    if (allowedOnWorkerSeat(name, withheld)) continue;
    delete toolset[name];
    removed.push(name);
  }
  return removed.sort();
}
