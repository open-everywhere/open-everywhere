import { expect, test } from "vitest";
import { auditCursor, bootAgent, rowsSinceCursor, runScheduleTask } from "../harness";

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
