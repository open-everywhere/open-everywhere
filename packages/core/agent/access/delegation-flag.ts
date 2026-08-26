import { getSettings } from "../settings/settings.js";

export function oneshotAgentEnabled(): boolean {
  return getSettings().delegation.oneshotAgent;
}

export function backgroundTasksEnabled(): boolean {
  return getSettings().delegation.backgroundTasks;
}
