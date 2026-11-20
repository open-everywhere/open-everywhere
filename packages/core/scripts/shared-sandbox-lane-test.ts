import assert from "node:assert/strict";

const { inLaneSandbox, inSandboxLane, sandboxLaneKey, sandboxLanesHeldForTest, SANDBOX_LANE_WAIT_CEILING_MS } = await import("../agent/sandbox/shared-sandbox-lane.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const PENDING = Symbol("pending");
const settledWithin = async <T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> =>
  await Promise.race([p, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))]);

/**
 * A shared sandbox with the hazard the lane exists for: a `run` that starts while another `run`
 * is still open never returns, as an overlapping call on the in-process just-bash backend can.
 */
function hazardousSandbox(): { run(input: { command: string }): Promise<{ stdout: string }>; readTextFile(input: { path: string }): Promise<string>; readonly label: string; overlaps: number } {
  let open = 0;
  const sandbox = {
    label: "shared-box",
    overlaps: 0,
    async run(input: { command: string }): Promise<{ stdout: string }> {
      open += 1;
      if (open > 1) {
        sandbox.overlaps += 1;
        return await new Promise<{ stdout: string }>(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 20));
      open -= 1;
      return { stdout: input.command };
    },
    async readTextFile(input: { path: string }): Promise<string> {
      return `content of ${input.path}`;
    },
  };
  return sandbox;
}

console.log("§1 the lane key names the session that owns the shared sandbox:");
eq(sandboxLaneKey({ session: { id: "child-a", parent: { sessionId: "work-w", rootSessionId: "work-w" } } }), "work-w", "🔴 a child keys on its delegation root, which owns the shared sandbox");
eq(sandboxLaneKey({ session: { id: "grandchild", parent: { sessionId: "child-a", rootSessionId: "work-w" } } }), "work-w", "…and so does a child of a child: the root, not the direct parent");
eq(sandboxLaneKey({ session: { id: "child-b", parent: { sessionId: "work-w" } } }), "work-w", "a parent with no root id falls back to the direct parent");
eq(sandboxLaneKey({ session: { id: "work-w" } }), "work-w", "🔴 the owning session keys on itself, so it shares the lane with its children");
eq(sandboxLaneKey({ session: { id: "work-w", parent: null } }), "work-w", "…also with a null parent");
eq(sandboxLaneKey({}), undefined, "no session ⇒ no lane");
eq(sandboxLaneKey(undefined), undefined, "no context ⇒ no lane, never a throw");

console.log("§2 two sibling children's overlapping calls on one shared sandbox both return:");
{
  const box = hazardousSandbox();
  const childA = inLaneSandbox(sandboxLaneKey({ session: { id: "child-a", parent: { rootSessionId: "work-w" } } }), box);
  const childB = inLaneSandbox(sandboxLaneKey({ session: { id: "child-b", parent: { rootSessionId: "work-w" } } }), box);
  const both = Promise.all([childA.run({ command: "find a" }), childB.run({ command: "find b" })]);
  const out = await settledWithin(both, 2_000);
  ok(out !== PENDING, "🔴 THE SECOND CHILD'S CALL RETURNS: the lane runs the two calls one at a time, so neither hangs");
  eq(out === PENDING ? undefined : out.map((r) => r.stdout), ["find a", "find b"], "…in the order they arrived, each with its own result");
  eq(box.overlaps, 0, "…and the sandbox never saw two calls at once");
  eq(sandboxLanesHeldForTest(), 0, "the lane is released once its last call returns");
}

console.log("§2n NEGATIVE CONTROL: the same two calls with no lane overlap, and one never returns:");
{
  const box = hazardousSandbox();
  const out = await settledWithin(Promise.all([box.run({ command: "find a" }), box.run({ command: "find b" })]), 300);
  eq(out, PENDING, "🔴 without the lane the second overlapping call hangs: the hazard the fake models is real in the fake");
  eq(box.overlaps, 1, "…because the sandbox saw two calls at once");
}

console.log("§3 calls in different lanes do not wait on each other:");
{
  const order: string[] = [];
  let releaseA: () => void = () => undefined;
  const blockedA = inSandboxLane("work-a", async () => {
    await new Promise<void>((r) => {
      releaseA = r;
    });
    order.push("a");
  });
  const b = await settledWithin(
    inSandboxLane("work-b", async () => {
      order.push("b");
      return "b";
    }),
    500,
  );
  eq(b, "b", "🔴 NEGATIVE CONTROL: a call for another work session's sandbox runs while the first lane is held");
  releaseA();
  await blockedA;
  eq(order, ["b", "a"], "…so the lane serialises one shared sandbox only");
}

console.log("§4 a call that never returns holds its lane only up to the ceiling:");
{
  void inSandboxLane("work-hung", async () => await new Promise<void>(() => undefined), 100);
  const next = await settledWithin(inSandboxLane("work-hung", async () => "next", 100), 2_000);
  eq(next, "next", "🔴 the next call runs after the ceiling, so one hung call cannot stall every later hook on that sandbox");
  eq(SANDBOX_LANE_WAIT_CEILING_MS, 30_000, "the shipped ceiling is the 30 seconds the agent-and-loop page states");
}

console.log("§5 the wrapper changes only the file and command calls:");
{
  const box = hazardousSandbox();
  const laned = inLaneSandbox("work-w", box);
  eq(laned.label, "shared-box", "a plain property reads through");
  eq(await laned.readTextFile({ path: "memory/x.md" }), "content of memory/x.md", "a laned method still returns the sandbox's own result");
  const failing = inLaneSandbox("work-fail", {
    async run(): Promise<never> {
      throw new Error("command failed");
    },
  });
  await assert.rejects(() => failing.run(), /command failed/, "a call that throws still throws to its caller");
  n++;
  eq(await settledWithin(inSandboxLane("work-fail", async () => "after"), 500), "after", "…and the lane runs the next call after it");
  eq(inLaneSandbox(undefined, box), box, "no lane key ⇒ the sandbox itself, unwrapped");
  eq(inLaneSandbox("work-w", null), null, "a null sandbox comes back as null");
}

console.log(`\n✓ shared-sandbox-lane: ${n} assertions`);
