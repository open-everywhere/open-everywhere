import { expect, test } from "vitest";
import { bootAgent, readAuditRows, runScheduleTask } from "../harness";

test("directory-sync's compiled cron task writes a no-op heartbeat when no provider is armed (the live deployment's own posture)", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await runScheduleTask("schedules/directory-sync.ts");

  const rows = await readAuditRows({ actions: ["identity.directory.sync"], sinceIso });
  expect(rows.length, "the compiled directory-sync task must leave a row behind — silence here is the exact defect OPE-635 names").toBeGreaterThanOrEqual(1);
  expect(rows[0]?.detail?.["outcome"]).toBe("no-op: no provider configured");
});

test("tidy's compiled cron task writes its heartbeat every run, whether or not anything needed tidying", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await runScheduleTask("schedules/tidy.ts");

  const rows = await readAuditRows({ actions: ["memory.tidy_tick"], sinceIso });
  expect(rows.length, "the compiled tidy task must leave a heartbeat row behind on every run").toBeGreaterThanOrEqual(1);
  expect(typeof rows[0]?.detail?.["outcome"]).toBe("string");
});

test("dream-mode3's compiled cron task writes its heartbeat every run, including an empty week", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await runScheduleTask("schedules/dream-mode3.ts");

  const rows = await readAuditRows({ actions: ["dream.mode3_tick"], sinceIso });
  expect(rows.length, "the compiled dream-mode3 task must leave a heartbeat row behind on every run").toBeGreaterThanOrEqual(1);
  expect(typeof rows[0]?.detail?.["outcome"]).toBe("string");
});
