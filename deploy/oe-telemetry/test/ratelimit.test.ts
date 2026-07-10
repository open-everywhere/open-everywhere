import assert from "node:assert/strict";
import { hourBucketKey, checkAndIncrementInstanceRateLimit, RATE_LIMIT_PER_INSTANCE_PER_HOUR } from "../src/ratelimit.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const t = Date.parse("2026-07-07T21:34:56.000Z");
  ok(hourBucketKey(t) === "2026-07-07T21", "hour bucket truncates to the hour, UTC");

  const sameHourLater = Date.parse("2026-07-07T21:59:59.000Z");
  ok(hourBucketKey(t) === hourBucketKey(sameHourLater), "two timestamps in the same hour share a bucket");

  const nextHour = Date.parse("2026-07-07T22:00:00.000Z");
  ok(hourBucketKey(t) !== hourBucketKey(nextHour), "the next hour is a different bucket");
}

{
  const counters = new Map<string, number>();
  const fakeSql = (async (_strings: TemplateStringsArray, instanceId: string, bucket: string) => {
    const key = `${instanceId}:${bucket}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return [{ count: next }];
  }) as unknown as Parameters<typeof checkAndIncrementInstanceRateLimit>[0];

  const now = Date.parse("2026-07-07T21:00:00.000Z");

  const first = await checkAndIncrementInstanceRateLimit(fakeSql, "instance-a", now);
  ok(first === true, "the first request in an hour is within the limit");

  for (let i = 1; i < RATE_LIMIT_PER_INSTANCE_PER_HOUR; i++) {
    await checkAndIncrementInstanceRateLimit(fakeSql, "instance-a", now);
  }
  const atCap = await checkAndIncrementInstanceRateLimit(fakeSql, "instance-a", now);
  ok(atCap === false, "the request that pushes the count over the cap is rejected");

  const otherInstance = await checkAndIncrementInstanceRateLimit(fakeSql, "instance-b", now);
  ok(otherInstance === true, "a different instance has its own independent counter");
}

console.log(`ratelimit.test.ts: ${n} assertions passed`);
