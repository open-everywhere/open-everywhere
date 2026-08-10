import { SETTINGS, getSettings } from "../settings/settings.js";

export const OE_ONESHOT_AGENT_ENV: string = SETTINGS.delegation.oneshotAgent.env;

export function oneshotAgentEnabled(): boolean {
  return getSettings().delegation.oneshotAgent;
}
