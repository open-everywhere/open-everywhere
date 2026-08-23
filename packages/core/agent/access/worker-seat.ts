import type { WindowGrain } from "../identity/binding.js";

export const WORKER_WITHHELD_TOOLS: ReadonlySet<string> = new Set<string>(["no_reply", "stand_down", "read_channel", "read_thread"]);

export function chatArmGrain(grain: WindowGrain): boolean {
  return grain === "task";
}

export function allowedOnWorkerSeat(name: string, withheld: ReadonlySet<string> = WORKER_WITHHELD_TOOLS): boolean {
  return !withheld.has(name);
}

export function restrictToolsetForWorkerSeat(toolset: Record<string, unknown>, withheld: ReadonlySet<string> = WORKER_WITHHELD_TOOLS): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(toolset)) {
    if (allowedOnWorkerSeat(name, withheld)) continue;
    delete toolset[name];
    removed.push(name);
  }
  return removed.sort();
}
