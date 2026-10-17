import { appendAudit } from "../audit/audit.js";
import { noteTestRunBlocked } from "./test-run-state.js";
import {
  describeBlockedCall,
  ROUTINE_TEST_BLOCKED_ACTION,
  testRunBlockedMessage,
  testRunToolVerdict,
  type TestRunStamp,
} from "../routines/test-run.js";

interface ToolLike {
  execute?: (...args: unknown[]) => unknown;
}

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

export function fenceToolsetForTestRun(toolset: Record<string, unknown>, stamp: TestRunStamp, record: BlockedCallRecorder = recordBlockedCall): string[] {
  const fenced: string[] = [];
  for (const [name, raw] of Object.entries(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    const tool = raw as ToolLike;
    if (typeof tool.execute !== "function") {
      if (testRunToolVerdict(name) === "block") {
        delete toolset[name];
        fenced.push(name);
      }
      continue;
    }
    if (name === "connection_execute") {
      const inner = tool.execute.bind(tool);
      tool.execute = async (...args: unknown[]) => {
        if (testRunToolVerdict(name, args[0]) === "run") return inner(...args);
        noteTestRunBlocked();
        await record(stamp, name, args[0]);
        throw new Error(testRunBlockedMessage(name));
      };
      fenced.push(name);
      continue;
    }
    if (testRunToolVerdict(name) === "run") continue;
    tool.execute = async (...args: unknown[]) => {
      noteTestRunBlocked();
      await record(stamp, name, args[0]);
      throw new Error(testRunBlockedMessage(name));
    };
    fenced.push(name);
  }
  return fenced;
}
