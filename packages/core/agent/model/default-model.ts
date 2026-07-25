export function defaultAgentModelId(): string {
  return process.env.OE_FORCE_MODEL?.trim() || process.env.OE_PRIMARY_MODEL?.trim() || "zai/glm-5.2";
}
