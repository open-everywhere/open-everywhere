export const ROUTINE_PERMISSION_PREFIX = "oe-routine:";

const KEY_PATTERN = /^oe-routine:([^:]+):g([1-9][0-9]*)$/;

export function routinePermissionKeyParts(key: string): { routineId: string; generation: number } | undefined {
  if (!key.startsWith(ROUTINE_PERMISSION_PREFIX)) return undefined;
  const m = KEY_PATTERN.exec(key);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { routineId: m[1], generation: Number(m[2]) };
}

export function routinePermissionKeyIdentity(key: string): string | undefined {
  const parts = routinePermissionKeyParts(key);
  return parts === undefined ? undefined : `${ROUTINE_PERMISSION_PREFIX}${parts.routineId}`;
}
