let registeredDefault: string | undefined;

export function registerDefaultAgentModelId(id: string): void {
  registeredDefault = id;
}

export function _resetDefaultAgentModelIdForTest(): void {
  registeredDefault = undefined;
}

export function defaultAgentModelId(): string {
  return (
    process.env.OE_FORCE_MODEL?.trim() ||
    process.env.OE_PRIMARY_MODEL?.trim() ||
    registeredDefault ||
    "openai/gpt-5.6-luna"
  );
}
