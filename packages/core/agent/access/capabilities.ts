export const WINDOW_TOPOLOGY_ENABLED: boolean = false;

export const OE_WINDOW_TOPOLOGY_ENV = "OE_WINDOW_TOPOLOGY";

export function windowTopologyEnabled(): boolean {
  const raw = process.env[OE_WINDOW_TOPOLOGY_ENV];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  }
  return WINDOW_TOPOLOGY_ENABLED;
}
