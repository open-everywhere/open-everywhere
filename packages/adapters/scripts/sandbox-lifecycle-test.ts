import assert from "node:assert/strict";
import lifecycleHook, {
  shouldStop,
  stopAfterTurnEnabled,
  stopSessionSandboxes,
  type SandboxLifecycleDeps,
} from "../agent/sandbox/vercel-lifecycle.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const events = lifecycleHook.events ?? {};
  for (const key of ["turn.completed", "turn.failed", "session.completed", "session.failed"]) {
    ok(typeof (events as Record<string, unknown>)[key] === "function", `hook subscribes to ${key}`);
  }
}

{
  ok(shouldStop("running"), "running → stop");
  ok(shouldStop("pending"), "pending → stop");
  for (const s of ["stopped", "stopping", "snapshotting", "failed", "aborted"]) {
    ok(!shouldStop(s), `${s} → leave alone`);
  }
}

{
  delete process.env.OE_SANDBOX_STOP_AFTER_TURN;
  ok(stopAfterTurnEnabled(), "enabled by default");
  process.env.OE_SANDBOX_STOP_AFTER_TURN = "0";
  ok(!stopAfterTurnEnabled(), "OE_SANDBOX_STOP_AFTER_TURN=0 disables");
  process.env.OE_SANDBOX_STOP_AFTER_TURN = "1";
  ok(stopAfterTurnEnabled(), "OE_SANDBOX_STOP_AFTER_TURN=1 keeps it on");
  delete process.env.OE_SANDBOX_STOP_AFTER_TURN;
}

{
  const stops: string[] = [];
  const deps: SandboxLifecycleDeps = {
    list: async (sessionId) => {
      ok(sessionId === "sess-1", "list is queried with the session id");
      return [
        { name: "sbx-main", status: "running", createdAt: 1_000 },
        { name: "sbx-old", status: "stopped", createdAt: 1_000 },
        { name: "sbx-mid", status: "snapshotting", createdAt: 1_000 },
      ];
    },
    stop: async (name) => {
      stops.push(name);
    },
  };
  const stopped = await stopSessionSandboxes("sess-1", deps);
  ok(stops.length === 1 && stops[0] === "sbx-main", "only the running sandbox is stopped");
  ok(stopped.length === 1 && stopped[0].name === "sbx-main", "stopped names are reported");
}

{
  const stops: string[] = [];
  const deps: SandboxLifecycleDeps = {
    list: async () => [
      { name: "sbx-a", status: "running", createdAt: 1_000 },
      { name: "sbx-b", status: "running", createdAt: 1_000 },
    ],
    stop: async (name) => {
      if (name === "sbx-a") throw new Error("transient API error");
      stops.push(name);
    },
  };
  const stopped = await stopSessionSandboxes("sess-2", deps);
  ok(stops.length === 1 && stops[0] === "sbx-b", "a failed stop doesn't block the next sandbox");
  ok(stopped.length === 1 && stopped[0].name === "sbx-b", "only the successful stop is reported");
}

{
  const deps: SandboxLifecycleDeps = {
    list: async () => [],
    stop: async () => {
      throw new Error("must not be called");
    },
  };
  const stopped = await stopSessionSandboxes("sess-3", deps);
  ok(stopped.length === 0, "no tagged sandboxes → nothing stopped, nothing thrown");
}

{
  const deps: SandboxLifecycleDeps = {
    list: async () => [{ name: "sbx-timed", status: "running", createdAt: 10_000 }],
    stop: async () => {},
  };
  const stopped = await stopSessionSandboxes("sess-4", deps, () => 10_000 + 45_000);
  ok(stopped.length === 1 && stopped[0].sandboxSeconds === 45, "sandboxSeconds = (now - createdAt) via the injected clock");
}

{
  const deps: SandboxLifecycleDeps = {
    list: async () => [{ name: "sbx-skew", status: "running", createdAt: 10_000 }],
    stop: async () => {},
  };
  const stopped = await stopSessionSandboxes("sess-5", deps, () => 9_000);
  ok(stopped[0].sandboxSeconds === 0, "sandboxSeconds clamps at 0 rather than going negative");
}

console.log(`\n✓ sandbox-lifecycle: ${n} assertions passed (hook shape, stop decisions, fail-soft, enable flag, runtime-seconds)\n`);
