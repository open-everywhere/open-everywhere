import assert from "node:assert/strict";
import extendTool, {
  extendSessionSandboxes,
  maxExtendMinutes,
  type ExtendDeps,
} from "../agent/sandbox/extend-workspace-time.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  ok(typeof extendTool === "object" && extendTool !== null, "default export is a tool definition");
  ok(typeof (extendTool as { execute?: unknown }).execute === "function", "tool has an execute()");
}

{
  delete process.env.OE_SANDBOX_EXTEND_MAX_MIN;
  ok(maxExtendMinutes() === 120, "cap defaults to 120 minutes");
  process.env.OE_SANDBOX_EXTEND_MAX_MIN = "45";
  ok(maxExtendMinutes() === 45, "OE_SANDBOX_EXTEND_MAX_MIN overrides the cap");
  process.env.OE_SANDBOX_EXTEND_MAX_MIN = "junk";
  ok(maxExtendMinutes() === 120, "unparseable cap falls back to the default");
  delete process.env.OE_SANDBOX_EXTEND_MAX_MIN;
}

{
  const calls: Array<{ name: string; ms: number }> = [];
  const deps: ExtendDeps = {
    list: async (sessionId) => {
      ok(sessionId === "sess-1", "list queried with the session id");
      return [
        { name: "sbx-live", status: "running" },
        { name: "sbx-done", status: "stopped" },
      ];
    },
    extend: async (name, ms) => {
      calls.push({ name, ms });
    },
  };
  const { extended, clampedTo } = await extendSessionSandboxes("sess-1", 15, deps);
  ok(calls.length === 1 && calls[0].name === "sbx-live", "only the running sandbox is extended");
  ok(calls[0].ms === 15 * 60_000, "minutes converted to milliseconds");
  ok(extended.length === 1 && clampedTo === 15, "reports what was extended, unclamped when under the cap");
}

{
  const calls: number[] = [];
  const deps: ExtendDeps = {
    list: async () => [{ name: "sbx", status: "running" }],
    extend: async (_name, ms) => {
      calls.push(ms);
    },
  };
  const { clampedTo } = await extendSessionSandboxes("s", 999, deps);
  ok(clampedTo === 120 && calls[0] === 120 * 60_000, "999-minute request clamps to the 120-min cap");
  const low = await extendSessionSandboxes("s", 0, deps);
  ok(low.clampedTo === 1, "zero/negative requests clamp up to 1 minute");
}

{
  const deps: ExtendDeps = {
    list: async () => [{ name: "sbx-done", status: "stopped" }],
    extend: async () => {
      throw new Error("must not be called");
    },
  };
  const { extended } = await extendSessionSandboxes("s", 30, deps);
  ok(extended.length === 0, "stopped-only session → nothing extended, nothing thrown");
}

console.log(`\n✓ sandbox-extend: ${n} assertions passed (tool shape, cap, running-only, no-op path)\n`);
