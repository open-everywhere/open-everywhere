export const ROUTINE_GRANT_PREFIX = "oe-routine:";

const KEY_PATTERN = /^oe-routine:([^:]+):g([1-9][0-9]*)$/;

export function routineGrantKeyParts(key: string): { routineId: string; generation: number } | undefined {
  if (!key.startsWith(ROUTINE_GRANT_PREFIX)) return undefined;
  const m = KEY_PATTERN.exec(key);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { routineId: m[1], generation: Number(m[2]) };
}

export function routineGrantKeyIdentity(key: string): string | undefined {
  const parts = routineGrantKeyParts(key);
  return parts === undefined ? undefined : `${ROUTINE_GRANT_PREFIX}${parts.routineId}`;
}
