import { afterEach, expect, test } from "vitest";
import { __resetRedeliveryStormGuardForTest, redeliveryRecoveryNote, waitFor } from "./harness";
import { REDELIVERY_SIGNATURE, REDELIVERY_STORM_THRESHOLD, RedeliveryStormGuard } from "./redelivery-storm-guard";

const SYNTHETIC_MARKER = "[oe-test-fixture redelivery-storm-guard.test.ts] SYNTHETIC — the block below is this test's fixture, NOT eve";

function composedStormLine(runId: string, stepId: string): string {
  return (
    `${SYNTHETIC_MARKER}\n` +
    `[workflow-sdk] ${REDELIVERY_SIGNATURE} — a previous delivery crashed mid-body and this redelivery is recovering them\n` +
    `  run    ${runId}\n` +
    `  stepIds ["${stepId}"]\n`
  );
}

test("does not trip below the threshold", () => {
  const guard = new RedeliveryStormGuard();
  for (let i = 0; i < REDELIVERY_STORM_THRESHOLD - 1; i++) guard.observe(REDELIVERY_SIGNATURE);
  expect(guard.tripped()).toBeUndefined();
});

test("trips once the threshold is crossed", () => {
  const guard = new RedeliveryStormGuard();
  for (let i = 0; i < REDELIVERY_STORM_THRESHOLD; i++) guard.observe(REDELIVERY_SIGNATURE);
  const verdict = guard.tripped();
  expect(verdict).toBeDefined();
  expect(verdict?.count).toBe(REDELIVERY_STORM_THRESHOLD);
});

test("ignores ordinary log noise — negative control against false positives", () => {
  const guard = new RedeliveryStormGuard();
  for (let i = 0; i < REDELIVERY_STORM_THRESHOLD * 10; i++) {
    guard.observe(`[workflow-sdk] step_created runId=wrun_${i} — nothing to do with a storm`);
  }
  expect(guard.tripped()).toBeUndefined();
});

test("counts every occurrence within a single chunk, not once per observe() call", () => {
  const guard = new RedeliveryStormGuard();
  const oneChunk = Array.from({ length: REDELIVERY_STORM_THRESHOLD }, () => REDELIVERY_SIGNATURE).join("\n");
  guard.observe(oneChunk);
  expect(guard.tripped()?.count).toBe(REDELIVERY_STORM_THRESHOLD);
});

test("best-effort extracts the runId and stepIds off a realistically composed block", () => {
  const guard = new RedeliveryStormGuard();
  for (let i = 0; i < REDELIVERY_STORM_THRESHOLD; i++) guard.observe(composedStormLine("wrun_abc123", "step_xyz789"));
  const verdict = guard.tripped();
  expect(verdict?.runId).toBe("wrun_abc123");
  expect(verdict?.stepIds).toBe('["step_xyz789"]');
});

test("an un-parseable block still trips on the substring alone — extraction is a bonus, not load-bearing", () => {
  const guard = new RedeliveryStormGuard();
  for (let i = 0; i < REDELIVERY_STORM_THRESHOLD; i++) guard.observe(`totally reflowed future format :: ${REDELIVERY_SIGNATURE}`);
  const verdict = guard.tripped();
  expect(verdict).toBeDefined();
  expect(verdict?.runId).toBeUndefined();
});

afterEach(() => {
  __resetRedeliveryStormGuardForTest();
});

test("a genuine timeout with no storm reports the plain waitFor message", async () => {
  expect(redeliveryRecoveryNote()).toBe("");
  await expect(waitFor(() => undefined, "a probe that never resolves", 300)).rejects.toThrowError(
    new Error("timed out after 300ms waiting for: a probe that never resolves"),
  );
});

test("a sub-threshold recovery count does NOT trip the storm verdict but IS named on an ordinary timeout", async () => {
  const below = 3;
  expect(below).toBeLessThan(REDELIVERY_STORM_THRESHOLD);
  for (let i = 0; i < below; i++) process.stderr.write(composedStormLine("wrun_sub", "step_sub"));

  const note = redeliveryRecoveryNote();
  expect(note).toContain(`${below} inline-step recovery log line(s)`);
  expect(note).toContain("OPE-465");

  let message: string | undefined;
  try {
    await waitFor(() => undefined, "a probe that never resolves", 300);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toBeDefined();
  expect(String(message)).toContain("timed out after 300ms");
  expect(String(message)).not.toContain("REDELIVERY STORM");
  expect(String(message)).toContain(`${below} inline-step recovery log line(s)`);
});

test("a synthetic redelivery storm trips waitFor in low seconds, not the full ceiling, with a distinguishing message", async () => {
  for (let i = 0; i < REDELIVERY_STORM_THRESHOLD; i++) {
    process.stderr.write(composedStormLine("wrun_it_test", "step_it_test"));
  }
  const start = Date.now();
  await expect(waitFor(() => undefined, "a turn poisoned by a synthetic storm", 20_000)).rejects.toThrow(/REDELIVERY STORM \(OPE-559\)/);
  const elapsedMs = Date.now() - start;
  expect(elapsedMs).toBeLessThan(5_000);
});
