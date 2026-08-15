export const UNREADABLE_WORLD_MESSAGE = "This World allocates event positions the runtime cannot read";

export const SLOT_NUMBERED_MARKER = "not slot-numbered";

export const WORLD_CONTRACT_ERROR_CODE = "WORLD_CONTRACT_ERROR";

export function isUnresumableSessionError(message: unknown, code?: unknown): boolean {
  if (typeof code === "string" && code === WORLD_CONTRACT_ERROR_CODE) return true;
  if (typeof message !== "string" || message.length === 0) return false;
  return message.includes(UNREADABLE_WORLD_MESSAGE) && message.includes(SLOT_NUMBERED_MARKER);
}

export function unresumableAuditDetail(message: unknown, code?: unknown): { unresumable: boolean } {
  return { unresumable: isUnresumableSessionError(message, code) };
}
