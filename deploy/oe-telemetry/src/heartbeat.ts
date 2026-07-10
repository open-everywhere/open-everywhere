import type { NeonQueryFunction } from "@neondatabase/serverless";
import { HEARTBEAT_EVENT_NAME } from "./schema.js";

export const HEARTBEAT_WINDOW_MS = 6 * 60 * 60 * 1000;

export { HEARTBEAT_EVENT_NAME };

export function heartbeatWindowKey(now: number, windowMs: number = HEARTBEAT_WINDOW_MS): number {
  return Math.floor(now / windowMs);
}

export async function isHeartbeatDuplicate(
  sqlFn: NeonQueryFunction<false, false>,
  instanceId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const windowKey = heartbeatWindowKey(now);
  const rows = (await sqlFn`
    INSERT INTO heartbeat_dedupe (instance_id, window_key)
    VALUES (${instanceId}, ${windowKey})
    ON CONFLICT (instance_id, window_key) DO NOTHING
    RETURNING instance_id
  `) as { instance_id: string }[];
  return rows.length === 0;
}
