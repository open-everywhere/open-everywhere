import { appendAudit } from "../audit/audit.js";
import { describeBlockedCall, ROUTINE_TEST_BLOCKED_ACTION, type TestRunStamp } from "../routines/test-run.js";

export type BlockedCallRecorder = (stamp: TestRunStamp, toolName: string, input: unknown) => Promise<void>;

export async function recordBlockedCall(stamp: TestRunStamp, toolName: string, input: unknown): Promise<void> {
  try {
    const [platform = "unknown", workspace = "unknown", surface] = stamp.surfaceKey.split("/");
    const described = describeBlockedCall(toolName, input);
    await appendAudit({
      org: stamp.org,
      platform,
      workspace,
      ...(surface !== undefined && surface.length > 0 ? { surface } : {}),
      action: ROUTINE_TEST_BLOCKED_ACTION,
      detail: { routine: stamp.routineId, test: stamp.testId, tool: described.tool, what: described.what },
    });
  } catch {
  }
}
