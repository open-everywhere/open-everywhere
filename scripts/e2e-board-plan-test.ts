import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boardRan,
  boardResultsDir,
  nextStartable,
  planBoard,
  readLastBoard,
  redNowLine,
  renderBoardPlan,
  riskOf,
  riskOrder,
  riskRank,
  runLanes,
  stopsBoard,
  writeBoardRecord,
} from "../packages/core/scripts/e2e/board-plan.js";
import {
  CAPABILITY_RESOURCES,
  LANE_DECLARATIONS,
  laneDeclarationIndex,
  laneDeclarationProblems,
  renderLaneDeclarationProblems,
  type LaneDeclaration,
  type LaneResource,
} from "../packages/core/scripts/e2e/lanes.js";
import { changedAreaScenarios, relevantScenarios, ALWAYS_RELEVANT } from "../packages/core/scripts/e2e/changed-relevant-map.js";
import { renderLegWakeEvidence } from "../packages/core/scripts/e2e/wake-evidence.js";
import { FixtureMissing, GateFailure, ScenarioSkip, SCENARIOS } from "../packages/core/scripts/e2e/scenarios.js";
import { PollTimeout } from "../packages/core/scripts/e2e/poll.js";
import { finishedRun, tsxCommand, type ChildResult } from "./npm-command.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const decl = (rows: LaneDeclaration[]): ReadonlyMap<string, LaneDeclaration> => new Map(rows.map((r) => [r.id, r]));
const safe = (id: string, ...resources: LaneResource[]): LaneDeclaration => ({ id, parallel: "safe", resources });
const serialRow = (id: string): LaneDeclaration => ({ id, parallel: "serial", why: "writes deployment-wide state" });

{
  const problems = laneDeclarationProblems();
  ok(renderLaneDeclarationProblems(problems).length === 0, `the real roster is fully declared — got: ${renderLaneDeclarationProblems(problems).join("; ")}`);
  ok(LANE_DECLARATIONS.length === SCENARIOS.length, `one declaration per leg (${LANE_DECLARATIONS.length} rows, ${SCENARIOS.length} legs)`);

  const roster = [...SCENARIOS, { id: "S-NEW-LEG", requires: [] }];
  const red = laneDeclarationProblems(roster);
  ok(red.missing.length === 1 && red.missing[0] === "S-NEW-LEG", "🔴 the lint is RED on a leg with no declaration, and names it");
  ok(renderLaneDeclarationProblems(red).some((l) => l.includes("S-NEW-LEG")), "…and its rendered line names the leg");

  const under = laneDeclarationProblems([{ id: "X", requires: ["slack", "syntheticDm"] }], [safe("X", "seat:e2e-unified")]);
  ok(under.underDeclared.length === 1 && under.underDeclared[0] === "X:seat:dm", "a safe leg that requires the DM fixture but omits the DM seat is under-declared");
  const serialOk = laneDeclarationProblems([{ id: "X", requires: ["syntheticDm"] }], [serialRow("X")]);
  ok(serialOk.underDeclared.length === 0, "a serial leg needs no resources: it runs alone");

  const twice = laneDeclarationProblems([{ id: "X", requires: [] }], [safe("X", "seat:dm"), safe("X", "seat:dm"), safe("Y", "seat:dm")]);
  ok(twice.duplicate.includes("X") && twice.unknown.includes("Y"), "a leg declared twice and a row for an unknown leg are both refused");
  const empty = laneDeclarationProblems([{ id: "X", requires: [] }, { id: "Z", requires: [] }], [safe("X"), { id: "Z", parallel: "serial", why: " " }]);
  ok(empty.empty.includes("X") && empty.empty.includes("Z"), "a safe row with no resource and a serial row with no reason are both refused");

  const named = new Set(LANE_DECLARATIONS.flatMap((r) => (r.parallel === "safe" ? r.resources : [])));
  for (const [cap, resource] of Object.entries(CAPABILITY_RESOURCES)) {
    if (cap === "slackHalt") continue;
    ok(named.has(resource!), `capability ${cap}'s resource ${resource} is named by a declared leg`);
  }
}

{
  const teams = ["packages/providers/teams/agent/channels/teams.ts"];
  const area = changedAreaScenarios(teams);
  ok(area.includes("J-TEAMS") && area.includes("S-CARD-teams"), "a Teams provider change reaches the Teams legs");
  ok(!area.includes("J1") && !area.includes("S10"), "the changed-area set carries no floor leg the area does not name");
  const relevant = relevantScenarios(teams);
  ok(ALWAYS_RELEVANT.every((id) => relevant.includes(id)), "the selection still unions the whole floor");
  ok(area.every((id) => relevant.includes(id)), "…and every changed-area leg");
}

{
  ok(riskRank({ coversChange: true, redLastBoard: true }) < riskRank({ coversChange: true, redLastBoard: false }), "changed AND red outranks changed");
  ok(riskRank({ coversChange: true, redLastBoard: false }) < riskRank({ coversChange: false, redLastBoard: true }), "changed outranks red last board");
  ok(riskRank({ coversChange: false, redLastBoard: true }) < riskRank({ coversChange: false, redLastBoard: false }), "red last board outranks the rest");
  const legs = ["A", "B", "C", "D", "E"].map((id) => ({ id }));
  const risk = (id: string) => ({ coversChange: id === "D" || id === "B", redLastBoard: id === "D" || id === "E" });
  ok(riskOrder(legs, risk).map((l) => l.id).join(",") === "D,B,E,A,C", "risk order: D (both), B (changed), E (red), then A, C in roster order");
  const viaDiff = riskOf(["packages/providers/teams/x.ts"], { path: "x", reds: new Set(["J1"]), durationsMs: new Map() });
  ok(viaDiff("J-TEAMS").coversChange && !viaDiff("J-TEAMS").redLastBoard, "riskOf reads the diff");
  ok(viaDiff("J1").redLastBoard && !viaDiff("J1").coversChange, "riskOf reads the last board's reds");
}

{
  const d = decl([safe("A", "seat:e2e-unified"), safe("B", "seat:e2e-unified", "seat:dm"), safe("C", "seat:dm"), safe("D", "seat:email"), serialRow("S")]);
  ok(nextStartable(["A", "D"], new Set(), d, 4) === "A", "the head of the queue starts first");
  ok(nextStartable(["B", "D"], new Set(["A"]), d, 4) === "D", "a leg whose seat is taken waits; a later leg on a free seat starts");
  ok(
    nextStartable(["B", "C"], new Set(["A"]), d, 4) === undefined,
    "🔴 RESERVATION: B waits for the unified seat and reserves the DM seat, so C behind it cannot take the DM seat first",
  );
  ok(nextStartable(["S", "D"], new Set(["A"]), d, 4) === undefined, "a serial leg at the head waits for every running leg, and nothing behind it starts");
  ok(nextStartable(["S", "D"], new Set(), d, 4) === "S", "a serial leg starts when nothing runs");
  ok(nextStartable(["D"], new Set(["S"]), d, 4) === undefined, "nothing starts beside a running serial leg");
  ok(nextStartable(["D"], new Set(["A"]), d, 1) === undefined, "the lane cap holds");
  ok(nextStartable(["U", "D"], new Set(["A"]), d, 4) === undefined, "an undeclared leg is treated as serial (fail closed)");
}

{
  const d = decl([
    safe("U1", "seat:e2e-unified"),
    safe("U2", "seat:e2e-unified"),
    safe("M1", "seat:dm"),
    safe("M2", "seat:dm"),
    safe("E1", "seat:email"),
    serialRow("S1"),
  ]);
  const held = new Map<string, string>();
  let live = 0;
  let peak = 0;
  let collision = "";
  const order: string[] = [];
  const shared = new Map<string, readonly string[]>();
  const result = await runLanes(["U1", "M1", "E1", "U2", "M2", "S1"], d, {
    maxLanes: 4,
    stop: () => false,
    run: async (id, overlapping) => {
      order.push(id);
      live++;
      peak = Math.max(peak, live);
      const row = d.get(id)!;
      const resources = row.parallel === "safe" ? row.resources : ["*"];
      for (const r of resources) {
        if (held.has(r) || held.has("*") || (r === "*" && held.size > 0)) collision = `${id} met ${r}`;
        held.set(r, id);
      }
      await new Promise((r) => setTimeout(r, 20));
      for (const r of resources) held.delete(r);
      live--;
      shared.set(id, overlapping());
    },
  });
  ok(collision === "", `no two legs held one resource at once — ${collision}`);
  ok(peak === 3, `three legs on three different seats ran at once — peak ${peak}`);
  ok(result.notStarted.length === 0 && result.started.length === 6, "every leg started");
  ok(order.indexOf("S1") === 5, "the serial leg ran alone, last in its risk position");
  ok((shared.get("U1") ?? []).includes("M1") && (shared.get("U1") ?? []).includes("E1"), "a leg names the legs that shared its window");
  ok((shared.get("S1") ?? []).length === 0, "a serial leg shares its window with nobody");

  let red: string | undefined;
  const finished: string[] = [];
  const stopped = await runLanes(["U1", "M1", "U2", "M2", "E1"], d, {
    maxLanes: 2,
    stop: () => red !== undefined,
    run: async (id) => {
      await new Promise((r) => setTimeout(r, id === "U1" ? 5 : 30));
      if (id === "U1") red ??= id;
      finished.push(id);
    },
  });
  ok(finished.includes("M1"), "a leg already running when the red landed still finished");
  ok(stopped.notStarted.join(",") === "U2,M2,E1", `the legs behind the red never started, in risk order — got ${stopped.notStarted.join(",")}`);

  let threw = false;
  try {
    await runLanes(["U1", "M1"], d, { maxLanes: 2, stop: () => false, run: async (id) => { if (id === "U1") throw new Error("boom"); } });
  } catch (err) {
    threw = err instanceof AggregateError;
  }
  ok(threw, "a leg body that throws does not wedge the board: the runner settles every leg, then reports it");
}

{
  ok(stopsBoard(new GateFailure("wake: turn-1 reply")), "a failed gate in a leg that ran stops the board");
  ok(stopsBoard(new PollTimeout("a bot reply", 180_000)), "a timed-out wait in a leg that ran stops the board");
  ok(stopsBoard(new Error("scenario exceeded its budget")), "any other error in a leg that ran stops the board");
  ok(!stopsBoard(new FixtureMissing("no Teams card fixture")), "🔴 a RED-until-fixture leg does NOT stop the board: its remedy is a fixture");
  ok(!stopsBoard(new ScenarioSkip("no audit reader")), "🔴 a cannot-run leg does NOT stop the board");
}

{
  const plan = planBoard({
    scenarios: SCENARIOS,
    changedPaths: ["packages/providers/teams/agent/channels/teams.ts"],
    lastBoard: { path: "x", reds: new Set(["J-GH", "S-CARD-teams"]), durationsMs: new Map([["J1", 60_000]]) },
    maxLanes: 4,
  });
  const ids = plan.legs.map((l) => l.id);
  ok(ids[0] === "S-CARD-teams", `the leg that covers the change AND was red runs first — got ${ids[0]}`);
  const firstFloor = ids.indexOf("J1");
  ok(ids.indexOf("J-GH") < firstFloor, "a red-last-board floor leg runs before an ordinary floor leg");
  ok(ids.indexOf("J-TEAMS") < ids.indexOf("J-GH"), "a changed leg runs before a red-last-board leg");
  ok(!ids.includes("S-EMAIL-ROOM-REPLY") && plan.notSelected.includes("S-EMAIL-ROOM-REPLY"), "a leg the diff does not reach is not selected");
  ok(plan.legs.find((l) => l.id === "J1")!.estimateMs === 60_000, "the plan estimates with the last board's measured duration");
  ok(plan.legs.some((l) => l.lane > 1), "the plan puts some legs in a second lane");
  ok(plan.wallMs < plan.serialMs, `the planned wall clock beats one-at-a-time — ${plan.wallMs} vs ${plan.serialMs}`);
  const lines = renderBoardPlan(plan);
  ok(lines[0] === "## Board plan", "the plan prints under its own heading");
  ok(lines.some((l) => /^\| 1 \| S-CARD-teams \| covers a change, red last board \| \d+ \|/.test(l)), "row 1 names the leg, its risk and its lane");
  ok(!lines.join("\n").includes("seat:"), "the plan a person reads carries friendly names, never a raw resource id");

  const whole = planBoard({ scenarios: SCENARIOS, maxLanes: 1 });
  ok(whole.legs.length === SCENARIOS.length && whole.wallMs === whole.serialMs, "no diff selects the whole roster, and one lane is one-at-a-time");
  const kept = planBoard({ scenarios: SCENARIOS, maxLanes: 4, changedPaths: ["packages/providers/teams/x.ts"], selectByDiff: false });
  ok(kept.legs.length === SCENARIOS.length && kept.legs[0]!.risk.coversChange, "a scoped release keeps every leg and lets the diff only order them");
}

{
  ok(redNowLine("J1", "wake: turn-1 reply\n  lands") === "E2E-RED J1 — wake: turn-1 reply lands", "the red line has one fixed prefix and one line");
  ok(redNowLine("J1", " ") === "E2E-RED J1 — no reason recorded", "a red line is never bare");

  ok(boardResultsDir() === join(process.cwd(), "scripts/e2e/results"), "the record lands under the runner's cwd, where the absence check below looks");
  ok(
    !boardRan([
      { id: "S-X", surface: "slack", status: "RED", reason: "cannot run — no audit reader" },
      { id: "J1", surface: "slack", status: "FILTERED" },
    ]),
    "🔴 a board whose only started leg could not run did not run, so it writes no record",
  );
  ok(boardRan([{ id: "J1", surface: "slack", status: "RED", durationMs: 5 }]), "a board with one timed leg ran");
  const dir = mkdtempSync(join(tmpdir(), "oe-board-plan-"));
  ok(readLastBoard(dir) === undefined, "an empty results directory has no last board");
  writeBoardRecord([{ id: "OLD", surface: "slack", status: "RED" }], { startedAt: "2026-10-01T00:00:00Z" }, dir);
  await new Promise((r) => setTimeout(r, 5));
  const path = writeBoardRecord(
    [
      { id: "J1", surface: "slack", status: "RED", reason: "a reply that must not be recorded", durationMs: 1234 },
      { id: "J2", surface: "slack", status: "GREEN", durationMs: 99 },
      { id: "S-CARD-teams", surface: "teams", status: "RED", reason: "RED-until-fixture" },
    ],
    { startedAt: "2026-10-02T00:00:00Z" },
    dir,
  );
  const last = readLastBoard(dir)!;
  ok(last.path === path, "the newest record is the last board");
  ok(last.reds.has("J1") && !last.reds.has("OLD") && !last.reds.has("J2"), "the last board's reds are read back");
  ok(last.durationsMs.get("J2") === 99, "…and its durations");
  ok(!last.reds.has("S-CARD-teams"), "🔴 a RED with no duration never ran, so it does not rank as red last board");
  ok(readLastBoard(path)!.reds.has("J1"), "a record can be named by its path");
  const raw = execFileSync("cat", [path], { encoding: "utf8" });
  ok(!raw.includes("must not be recorded"), "the record carries no reason text: a reason can quote a reply");
}

{
  const line = renderLegWakeEvidence({
    legId: "J1",
    surface: "slack",
    sinceIso: "a",
    untilIso: "b",
    status: "RED",
    rows: [],
    windowRows: 0,
    incomplete: false,
    concurrentWith: ["S13", "J-ENGAGED-github"],
  })[0]!;
  ok(line.includes("shared with S13, J-ENGAGED-github"), `a parallel leg's evidence names the legs that shared its window — got ${line}`);
}

{
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const RUNNER = join(REPO, "packages/core/scripts/e2e/runner.ts");
  const dir = mkdtempSync(join(tmpdir(), "oe-board-plan-run-"));
  const record = join(dir, "e2e-board-2026-10-06T00-00-00-000Z.json");
  writeFileSync(record, JSON.stringify({ legs: [{ id: "J-GH", status: "RED", durationMs: 420_000 }] }));
  const run = (args: string[], env: Record<string, string> = {}, cwd?: string): { code: number; out: string } => {
    const [tsx, tsxArgs] = tsxCommand(REPO, [RUNNER, ...args]);
    try {
      const out = execFileSync(tsx, tsxArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", ...env },
        timeout: 120_000,
        ...(cwd ? { cwd } : {}),
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as ChildResult & { stdout?: string; stderr?: string };
      return { code: finishedRun(e, "the e2e runner").status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const r = run(["--plan", "--changed", "packages/providers/teams/agent/channels/teams.ts", "--last-board", record]);
  ok(r.code === 0, `--plan exits 0 — got ${r.code}\n${r.out}`);
  const rows = r.out.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  ok(rows.length > 0 && rows.length < SCENARIOS.length, `the plan lists the selected legs only — ${rows.length} rows`);
  ok(/^\| 1 \| J-TEAMS \| covers a change \|/.test(rows[0] ?? ""), `row 1 is the first changed leg in roster order — got ${rows[0]}`);
  const gh = rows.findIndex((l) => l.includes("| J-GH |"));
  const j1 = rows.findIndex((l) => l.includes("| J1 |"));
  ok(gh !== -1 && gh < j1 && rows[gh]!.includes("red last board"), "the last board's red floor leg runs before J1, and the row says why");
  ok(r.out.includes("last board:") && !r.out.includes("✓ e2e driver pack"), "the plan names the last board and drives nothing");
  ok(!r.out.includes("E2E-RED"), "a plan emits no red line");

  const bad = run(["--plan", "--max-lanes", "0"]);
  ok(bad.code === 1 && bad.out.includes("--max-lanes needs a whole number"), "a lane cap of 0 is refused");
  const noValue = run(["--plan", "--diff-base"]);
  ok(noValue.code === 1 && noValue.out.includes("--diff-base needs a value"), "a value flag with no value is refused, never read as absent");
  const flagAsValue = run(["--changed", "--plan"]);
  ok(flagAsValue.code === 1 && flagAsValue.out.includes("--changed needs a value"), "a value flag never takes the next flag as its value");

  const planIds = (out: string): string[] =>
    out.split("\n").filter((l) => /^\| \d+ \|/.test(l)).map((l) => l.split("|")[2]!.trim());
  const deferred = run(["--plan"]);
  const planned = planIds(deferred.out);
  const rosterIds = SCENARIOS.map((s) => s.id);
  ok(deferred.code === 0 && planned.length === rosterIds.length && rosterIds.every((id) => planned.includes(id)), `the default plan lists every roster leg — ${planned.length} of ${rosterIds.length}`);
  ok(!planned.some((id) => id.startsWith("S-TAINT-")), "🔴 OPE-2726: the plan lists no taint leg");
  ok(planned.includes("S-UNATTENDED-DENY"), "🔴 OPE-2726: the presence-fence leg keeps its place in the plan under its non-taint name");
  ok(SCENARIOS.every((s) => s.expensive !== true), "the roster carries no expensive leg since OPE-2726");
  ok(planIds(run(["--plan", "--include-expensive"]).out).join(",") === planned.join(","), "…so --include-expensive plans the same legs in the same order");
  const runnerSrc = readFileSync(RUNNER, "utf8").replace(/\s+/g, " ");
  ok(
    runnerSrc.includes("return !(scenario.expensive === true && !includeExpensive && !explicitlyNamed);"),
    "🔴 WIRING: the plan's keep() still defers an expensive leg unless --include-expensive is set or the leg is named",
  );
  ok(
    runnerSrc.includes('const includeExpensive = process.argv.includes("--include-expensive") || (process.env.E2E_INCLUDE_EXPENSIVE ?? "").trim() === "1";'),
    "🔴 WIRING: the runner still reads the opt-in from --include-expensive or E2E_INCLUDE_EXPENSIVE=1",
  );
  const smoke = run(["--plan"], { E2E_SUITE: "smoke" });
  const smokeRows = smoke.out.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  ok(smokeRows.length === SCENARIOS.filter((s) => s.smoke === true).length, `a smoke plan lists only the smoke legs — ${smokeRows.length} rows`);

  const both = run(["--plan", "--changed", "a", "--diff-base", "HEAD"]);
  ok(both.code === 1 && both.out.includes("not both"), "--diff-base and --changed together are refused");

  const cwd = mkdtempSync(join(tmpdir(), "oe-board-plan-cwd-"));
  const live = run([], { E2E_RELEASE_SCOPE: "launch" }, cwd);
  const redLines = live.out.split("\n").filter((l) => l.startsWith("E2E-RED "));
  ok(live.code === 1 && redLines.length > 0, `a cannot-run red prints its E2E-RED line — ${redLines.length} line(s)`);
  ok(redLines.every((l) => / — \S/.test(l)), "every red line carries its reason");
  ok(!existsSync(join(cwd, "scripts/e2e/results")), "a board on which no leg ran writes no record for the next board to read");
}

ok(SCENARIOS.every((s) => laneDeclarationIndex().has(s.id)), "the runner's lane index holds every roster leg");

console.log(`✓ e2e board plan: ${n} assertions passed`);
