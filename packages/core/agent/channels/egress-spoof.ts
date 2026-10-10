import { onVercel } from "../access/platform.js";
import { testValveArmed } from "../testing/test-valves.js";

function egressSpoofArmed(): boolean {
  if (!testValveArmed("egress-spoof")) return false;
  if (onVercel()) throw new Error("the egress-spoof test valve is a local-eval seam — refusing on Vercel.");
  return true;
}

export function swallowRoomPost(what: string, idTag: string): string | undefined {
  if (!egressSpoofArmed()) return undefined;
  console.warn(`[oe] egress-spoof: swallowed ${what}`);
  return `spoof-${idTag}-${Date.now()}`;
}

export function swallowRoomOp(what: string): boolean {
  if (!egressSpoofArmed()) return false;
  console.warn(`[oe] egress-spoof: swallowed ${what}`);
  return true;
}
