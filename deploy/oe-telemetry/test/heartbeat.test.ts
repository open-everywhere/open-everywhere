import assert from "node:assert/strict";
import { heartbeatWindowKey, isHeartbeatDuplicate, HEARTBEAT_WINDOW_MS, HEARTBEAT_EVENT_NAME } from "../src/heartbeat.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  ok(HEARTBEAT_EVENT_NAME === "oe.instance.heartbeat", "dedupe is keyed to the heartbeat event name from schema.ts");

  const t0 = 0;
  const t1 = HEARTBEAT_WINDOW_MS - 1;
  const t2 = HEARTBEAT_WINDOW_MS;
  const t3 = HEARTBEAT_WINDOW_MS * 2 + 5;

  ok(heartbeatWindowKey(t0) === 0, "epoch 0 is window 0");
  ok(heartbeatWindowKey(t1) === 0, "one ms before the window boundary is still window 0");
  ok(heartbeatWindowKey(t2) === 1, "exactly at the window boundary rolls to window 1");
  ok(heartbeatWindowKey(t3) === 2, "well into a later window computes the right window index");

  const a = 1_800_000_000_000;
  const b = a + HEARTBEAT_WINDOW_MS + 1;
  ok(heartbeatWindowKey(a) !== heartbeatWindowKey(b), "timestamps more than one window apart never collide");

  const c = a + 1000;
  ok(heartbeatWindowKey(a) === heartbeatWindowKey(c), "timestamps within the same window collide (that's the point)");
}

{
  const claimed = new Set<string>();
  const fakeSql = (async (_strings: TemplateStringsArray, instanceId: string, windowKey: number) => {
    const key = `${instanceId}:${windowKey}`;
    if (claimed.has(key)) return [];
    claimed.add(key);
    return [{ instance_id: instanceId }];
  }) as unknown as Parameters<typeof isHeartbeatDuplicate>[0];

  const now = 1_800_000_000_000;
  const firstCall = await isHeartbeatDuplicate(fakeSql, "instance-a", now);
  ok(firstCall === false, "the first heartbeat in a window is NOT a duplicate");

  const secondCall = await isHeartbeatDuplicate(fakeSql, "instance-a", now + 1000);
  ok(secondCall === true, "a second heartbeat in the SAME window IS a duplicate");

  const otherInstance = await isHeartbeatDuplicate(fakeSql, "instance-b", now);
  ok(otherInstance === false, "a different instance in the same window is independent (not a duplicate)");

  const laterWindow = await isHeartbeatDuplicate(fakeSql, "instance-a", now + HEARTBEAT_WINDOW_MS + 1);
  ok(laterWindow === false, "the SAME instance in the NEXT window is not a duplicate");
}

console.log(`heartbeat.test.ts: ${n} assertions passed`);
