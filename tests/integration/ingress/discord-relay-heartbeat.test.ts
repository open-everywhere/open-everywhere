import { expect, test } from "vitest";
import { auditCursor, bootAgent, rawDiscordRelayHeartbeatPost, rowsSinceCursor } from "../harness";

test("OPE-775: a signed relay heartbeat writes a discord.heartbeat audit row on the real host", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const relayId = `it-relay-${Date.now()}`;

  const res = await rawDiscordRelayHeartbeatPost({ relayId });
  expect(res.status, "the mounted route classifies + acks a heartbeat with 200").toBe(200);
  expect(res.text.trim()).toBe("ok");

  const rows = await rowsSinceCursor(cursor, ["discord.heartbeat"]);
  const row = rows.find((r) => r.principalId === relayId);
  expect(row, "the heartbeat leaves an audit row behind, attributed to the relay that sent it — this IS the OPE-775 signal").toBeDefined();
  expect(row?.workspace).toBe("relay");
  expect(row?.surface).toBe("heartbeat");
  expect(row?.detail?.["relayId"]).toBe(relayId);
  expect(typeof row?.detail?.["sentAtIso"]).toBe("string");
  expect(Object.keys(row?.detail ?? {}).sort()).toEqual(["relayId", "sentAtIso"]);
});

test("OPE-775: a heartbeat mints no session, no wake, no reply — no discord.dispatched row is attributable to it", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const relayId = `it-relay-nowake-${Date.now()}`;

  const res = await rawDiscordRelayHeartbeatPost({ relayId });
  expect(res.status).toBe(200);

  const dispatched = await rowsSinceCursor(cursor, ["discord.dispatched"]);
  const attributable = dispatched.some((r) => JSON.stringify(r.detail ?? {}).includes(relayId));
  expect(attributable, "a heartbeat request must never be attributable to a discord.dispatched row").toBe(false);
});

test("OPE-775: an UNSIGNED heartbeat is refused 401 — the relay HMAC gate covers every payload shape", async () => {
  await bootAgent();
  const res = await rawDiscordRelayHeartbeatPost({ relayId: "it-relay-unsigned" }, null);
  expect(res.status, "no signature header -> fail-closed, same as an unsigned message").toBe(401);
});

test("OPE-775: a heartbeat signed with the WRONG secret is refused 401", async () => {
  await bootAgent();
  const res = await rawDiscordRelayHeartbeatPost({ relayId: "it-relay-wrongkey" }, "sha256=0000000000000000000000000000000000000000000000000000000000000000");
  expect(res.status).toBe(401);
});
