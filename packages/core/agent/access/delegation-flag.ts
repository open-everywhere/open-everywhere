import { getSettings } from "../settings/settings.js";

export function oneshotAgentEnabled(): boolean {
  return getSettings().delegation.oneshotAgent;
}

export function nativeSubagentEnabled(): boolean {
  return getSettings().delegation.nativeSubagent;
}
