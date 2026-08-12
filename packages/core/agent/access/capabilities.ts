import { SETTINGS, getSettings } from "../settings/settings.js";

export const WINDOW_TOPOLOGY_ENABLED: boolean = SETTINGS.window.topology.shipped;

export function windowTopologyEnabled(): boolean {
  return getSettings().window.topology;
}
