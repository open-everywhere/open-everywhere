import { onVercel } from "../access/platform.js";

function egressSpoofArmed(): boolean {
  if (process.env.OE_EGRESS_SPOOF !== "1") return false;
  if (onVercel()) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
  return true;
}

export function swallowRoomPost(what: string, idTag: string): string | undefined {
  if (!egressSpoofArmed()) return undefined;
  console.warn(`[oe] OE_EGRESS_SPOOF: swallowed ${what}`);
  return `spoof-${idTag}-${Date.now()}`;
}

export function swallowRoomOp(what: string): boolean {
  if (!egressSpoofArmed()) return false;
  console.warn(`[oe] OE_EGRESS_SPOOF: swallowed ${what}`);
  return true;
}
