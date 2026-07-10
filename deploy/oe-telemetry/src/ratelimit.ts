import type { NeonQueryFunction } from "@neondatabase/serverless";

export const RATE_LIMIT_PER_INSTANCE_PER_HOUR = 1000;

export function hourBucketKey(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

export async function checkAndIncrementInstanceRateLimit(
  sqlFn: NeonQueryFunction<false, false>,
  instanceId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const bucket = hourBucketKey(now);
  const rows = (await sqlFn`
    INSERT INTO rate_counter (instance_id, hour_bucket, count)
    VALUES (${instanceId}, ${bucket}, 1)
    ON CONFLICT (instance_id, hour_bucket)
    DO UPDATE SET count = rate_counter.count + 1
    RETURNING count
  `) as { count: number }[];
  const count = rows[0]?.count ?? 1;
  return count <= RATE_LIMIT_PER_INSTANCE_PER_HOUR;
}
