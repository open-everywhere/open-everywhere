import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let failures = 0;
function check(label: string, ok: boolean): void {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}`);
  }
}

const dir = join(tmpdir(), `open-everywhere-delegation-floor-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { FLOOR_ASKS, DELEGATION_TOOL_NAME, scoreFloorTurn, summariseFloorRun } = await import("./eval/delegation-floor-offline.js");
const { DELEGATION_FLOOR, renderWorkerCapabilityIndex } = await import("../agent/access/worker-capabilities.js");
const { WORKER_ONLY_TOOLS_STANDING } = await import("../agent/access/worker-capability-index.generated.js");
const { readAudit } = await import("../agent/audit/audit.js");
const spawnTaint = await import("../agent/hooks/spawn-taint.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;

{
  const block = renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent");
  check("§1 the rendered index is non-empty on the `agent` route", block.length > 0);
  check("🔴 §1 the rendered index CARRIES the floor verbatim — prose nobody is shown enforces nothing", block.includes(DELEGATION_FLOOR));
  const push = "all but trivial work belongs in a worker";
  check("§1 the push sentence the floor answers is still in the block", block.includes(push));
  check(
    "🔴 §1 the floor sits AFTER the sentence that caused the defect, so a seat reading the push reaches the definition",
    block.includes(push) && block.indexOf(push) < block.indexOf(DELEGATION_FLOOR),
  );
  check(
    "§1 the floor names the test the seat has to apply, in the seat's own terms",
    DELEGATION_FLOOR.includes("ONE call answers the ask"),
  );
  check("🔴 §1/CONTROL: route \"none\" renders NOTHING, floor included", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "none") === "");
}

{
  const persist = FLOOR_ASKS.find((a) => a.id === "persist-one-line");
  check("§2 the run's own one-line persist ask is in the pool", persist !== undefined);
  const routeAsk = FLOOR_ASKS.find((a) => a.id === "route-multi-step-pr");
  check("§2 …and so is a control ask that MUST be routed", routeAsk !== undefined);

  if (persist && routeAsk) {
    const bad = scoreFloorTurn(persist, [{ name: DELEGATION_TOOL_NAME }, { name: "reply" }]);
    check("🔴 §2 the one-line persist ask, DELEGATED → belowFloor", bad.belowFloor);
    check("§2 …and not counted as a missed route", bad.missedRoute === false);

    const good = scoreFloorTurn(persist, [{ name: "remember" }, { name: "reply" }]);
    check("🔴 §2 the same ask answered with ONE call of the seat's own → NOT belowFloor", good.belowFloor === false);
    check("§2 …and the scorer says it did not delegate", good.delegated === false);

    const lazy = scoreFloorTurn(routeAsk, [{ name: "reply" }]);
    check("🔴 §2 real work NOT delegated → missedRoute. A prompt that suppressed delegation outright would fail here", lazy.missedRoute);
    const routed = scoreFloorTurn(routeAsk, [{ name: DELEGATION_TOOL_NAME }, { name: "reply" }]);
    check("§2 …and the same work routed scores clean on both counters", routed.missedRoute === false && routed.belowFloor === false);
  }

  const summary = summariseFloorRun(FLOOR_ASKS.map((ask) => ({ ask, score: scoreFloorTurn(ask, [{ name: DELEGATION_TOOL_NAME }]) })));
  check(
    "🔴 §2 a run that delegates EVERYTHING reports every floor ask below the floor and no missed route — the soak's own shape",
    summary.belowFloor === summary.floorAsks && summary.floorAsks > 0 && summary.missedRoute === 0,
  );
  const summaryNone = summariseFloorRun(FLOOR_ASKS.map((ask) => ({ ask, score: scoreFloorTurn(ask, [{ name: "reply" }]) })));
  check(
    "🔴 §2 …and a run that delegates NOTHING inverts both numbers. The two summaries differing is what makes the pool two-sided",
    summaryNone.belowFloor === 0 && summaryNone.missedRoute === summaryNone.routeAsks && summaryNone.routeAsks > 0,
  );
}

{
  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const absUrl = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(absUrl("dist/src/context/container.js"));
  const { SessionKey } = await import(absUrl("dist/src/context/keys.js"));

  const hooks = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
  const dispatchHook = hooks["action.result"]!;
  const startedHook = hooks["task.started"]!;
  const turnStarted = hooks["turn.started"]!;

  const ctxFor = (turnId: string): BindableContext =>
    ({
      channel: { kind: "channel:unified", continuationToken: "unified:tok" },
      session: {
        id: "delegation-floor-test",
        turn: { id: turnId, sequence: 1 },
        auth: { current: { attributes: { oe_platform: "slack", oe_grain: "standing", oe_wake_id: "w1", channel_id: "C1", team_id: "T1" }, principalId: "U1", principalType: "slack-user" } },
      },
      agent: { name: "oe", nodeId: "__root__" },
    }) as unknown as BindableContext;

  const delegationRows = async (): Promise<number> => {
    const rows = await readAudit({ org: "acme" });
    return rows.filter((r) => typeof r.action === "string" && r.action.startsWith("delegation.")).length;
  };

  const container = new ContextContainer();
  container.set(SessionKey, { sessionId: "delegation-floor-test", auth: null, turn: 1, parent: undefined });
  await contextStorage.run(container, async () => {
    await turnStarted({}, ctxFor("turn_floor_a"));
    await dispatchHook(
      { data: { result: { callId: "call_a", kind: "tool-result", toolName: "remember", output: { ok: true } } } },
      ctxFor("turn_floor_a"),
    );
    check("🔴 §3 a turn that answered with ONE call of its own leaves NO `delegation.*` row — the assertion OPE-1766 asks for", (await delegationRows()) === 0);

    await turnStarted({}, ctxFor("turn_floor_b"));
    await startedHook(
      { data: { callId: "call_b", kind: "agent", name: DELEGATION_TOOL_NAME, taskId: "agent-floorbbbbcccc", turnId: "turn_floor_b" } },
      ctxFor("turn_floor_b"),
    );
    check("🔴 §3/CONTROL: a real `agent` dispatch through `task.started` DOES write one — so the leg above measures the floor, not a dead hook", (await delegationRows()) > 0);
  });
}

if (failures > 0) {
  console.error(`delegation-floor-scoring: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("delegation-floor-scoring: all checks passed");
