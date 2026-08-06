export function defaultAgentModelId(): string {
  return process.env.OE_FORCE_MODEL?.trim() || process.env.OE_PRIMARY_MODEL?.trim() || "deepseek/deepseek-v4-flash-0731";
}
