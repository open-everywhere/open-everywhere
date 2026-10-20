// proves: ROUT-61, ROUT-62

import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  githubInstallationPost,
  rawDiscordRelayHeartbeatPost,
  rowsSinceCursor,
  runScheduleTask,
  waitFor,
} from "./harness";

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

test("a signed GitHub App installation delivery is accepted (200) and writes surface.app_installed with the delivery's own facts", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const owner = `it-gh-owner-${nonce}`;
  const installationId = Date.now() % 1_000_000_000;
  const cursor = await auditCursor();

  const res = await githubInstallationPost({ action: "created", owner, installationId, accountType: "Organization" });
  expect(res.status, `the GitHub front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);

  const row = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["surface.app_installed"]);
    return rows.find((r) => r.workspace === owner);
  }, "the surface.app_installed row for this delivery's owner");

  expect(row.platform).toBe("github");
  expect(row.detail?.installationId).toBe(String(installationId));
  expect(row.detail?.accountType).toBe("Organization");
  expect(row.detail?.action).toBe("created");
});

test("an unsigned GitHub App installation delivery is refused (401) and writes NO surface.app_installed row", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const owner = `it-gh-unsigned-${nonce}`;
  const installationId = Date.now() % 1_000_000_000;
  const cursor = await auditCursor();

  const res = await githubInstallationPost({ action: "created", owner, installationId, signed: false });
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await rowsSinceCursor(cursor, ["surface.app_installed"]);
  expect(rows.find((r) => r.workspace === owner)).toBeUndefined();
});

test("a TAMPERED GitHub App installation delivery (a wrong-but-well-formed signature) is refused (401) and writes NO row", async () => {
  await bootAgent();
  const nonce = randomBytes(6).toString("hex");
  const owner = `it-gh-tampered-${nonce}`;
  const installationId = Date.now() % 1_000_000_000;
  const cursor = await auditCursor();

  const res = await githubInstallationPost({
    action: "created",
    owner,
    installationId,
    signature: "sha256=" + "0".repeat(64),
  });
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await rowsSinceCursor(cursor, ["surface.app_installed"]);
  expect(rows.find((r) => r.workspace === owner)).toBeUndefined();
});

test("directory-sync's compiled cron task writes a no-op heartbeat when no provider is armed (the live deployment's own posture)", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  await runScheduleTask("schedules/directory-sync.ts");

  const rows = await rowsSinceCursor(cursor, ["identity.directory.sync"]);
  expect(rows.length, "the compiled directory-sync task must leave a row behind — silence here is the exact defect OPE-635 names").toBeGreaterThanOrEqual(1);
  expect(rows[0]?.detail?.["outcome"]).toBe("no-op: no provider configured");
});

test("tidy's compiled cron task writes its heartbeat every run, whether or not anything needed tidying", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  await runScheduleTask("schedules/tidy.ts");

  const rows = await rowsSinceCursor(cursor, ["memory.tidy_tick"]);
  expect(rows.length, "the compiled tidy task must leave a heartbeat row behind on every run").toBeGreaterThanOrEqual(1);
  expect(typeof rows[0]?.detail?.["outcome"]).toBe("string");
});

test("dream-mode3's compiled cron task writes its heartbeat every run, including an empty week", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  await runScheduleTask("schedules/dream-mode3.ts");

  const rows = await rowsSinceCursor(cursor, ["dream.mode3_tick"]);
  expect(rows.length, "the compiled dream-mode3 task must leave a heartbeat row behind on every run").toBeGreaterThanOrEqual(1);
  expect(typeof rows[0]?.detail?.["outcome"]).toBe("string");
});
