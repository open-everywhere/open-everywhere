import { SETTINGS, getSettings } from "../settings/settings.js";

export const WINDOW_TOPOLOGY_ENABLED: boolean = SETTINGS.window.topology.shipped;

export const OE_WINDOW_TOPOLOGY_ENV: string = SETTINGS.window.topology.env;

export function windowTopologyEnabled(): boolean {
  return getSettings().window.topology;
}
