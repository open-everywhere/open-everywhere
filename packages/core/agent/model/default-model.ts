import { getSettings, type AgentSettings } from "../settings/settings.js";

let registeredDefault: string | undefined;

export function registerDefaultAgentModelId(id: string): void {
  registeredDefault = id;
}

export function _resetDefaultAgentModelIdForTest(): void {
  registeredDefault = undefined;
}

export function defaultAgentModelId(models: AgentSettings["models"] = getSettings().models): string {
  return models.force || models.primary || registeredDefault || "openai/gpt-6-luna";
}
