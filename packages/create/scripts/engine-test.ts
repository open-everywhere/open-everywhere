import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAll, runWizard, type StepContext, type WizardIO, type WizardStep } from "../src/engine.js";
import { databaseStep } from "../src/steps/database.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ctx: StepContext = { cwd: "/fake", env: {} };

function fakeIO(): WizardIO & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (line: string) => {
      printed.push(line);
    },
    ask: async () => "",
    askSecret: async () => "",
    confirm: async () => true,
  };
}

function step(overrides: Partial<WizardStep> & { id: string }): WizardStep {
  return {
    title: overrides.id,
    check: () => ({ satisfied: false, detail: "unsatisfied" }),
    guide: () => ({ summary: "guide", instructions: [] }),
    ...overrides,
  };
}

{
  let guideCalls = 0;
  const satisfiedStep = step({ id: "a", check: () => ({ satisfied: true, detail: "ok" }) });
  const unsatisfiedStep = step({
    id: "b",
    check: () => ({ satisfied: false, detail: "nope" }),
    guide: () => {
      guideCalls++;
      return { summary: "x", instructions: [] };
    },
  });

  const summary = await checkAll([satisfiedStep, unsatisfiedStep], ctx);
  ok(summary.satisfiedCount === 1, "checkAll: counts satisfied steps");
  ok(summary.total === 2, "checkAll: total is the step count");
  ok(!summary.allSatisfied, "checkAll: not all satisfied when one isn't");
  ok(guideCalls === 0, "checkAll: NEVER calls guide() — pure status only");
}

{
  let guideCalled = false;
  let automateCalled = false;
  const satisfiedStep = step({
    id: "satisfied",
    check: () => ({ satisfied: true, detail: "already done" }),
    guide: () => {
      guideCalled = true;
      return { summary: "should not print", instructions: [] };
    },
    automate: async () => {
      automateCalled = true;
      return { ran: true, ok: true, detail: "should not run" };
    },
  });

  const io = fakeIO();
  const summary = await runWizard([satisfiedStep], ctx, io);
  ok(!guideCalled, "runWizard: a satisfied step's guide() is never called");
  ok(!automateCalled, "runWizard: a satisfied step's automate() is never called");
  ok(summary.results[0].outcome === "satisfied", 'runWizard: outcome is "satisfied"');
  ok(io.printed.some((l) => l.includes("already done")), "runWizard: the satisfied detail is reported");
}

{
  const guideOnlyStep = step({ id: "guide-only", guide: () => ({ summary: "do the thing", instructions: ["step 1"] }) });
  const io = fakeIO();
  const summary = await runWizard([guideOnlyStep], ctx, io);
  ok(summary.results[0].outcome === "guided", 'runWizard: no automate() → outcome "guided"');
  ok(io.printed.some((l) => l.includes("do the thing")), "runWizard: guide summary is printed");
  ok(io.printed.some((l) => l.includes("step 1")), "runWizard: guide instructions are printed");
}

{
  const declineStep = step({
    id: "decline",
    automate: async () => ({ ran: false, ok: false, detail: "user said no" }),
  });
  const summary = await runWizard([declineStep], ctx, fakeIO());
  ok(summary.results[0].outcome === "declined", 'runWizard: automate() ran:false → outcome "declined"');
}

{
  let satisfied = false;
  const fixableStep = step({
    id: "fixable",
    check: () => ({ satisfied, detail: satisfied ? "fixed" : "broken" }),
    automate: async () => {
      satisfied = true;
      return { ran: true, ok: true, detail: "fixed it" };
    },
  });
  const summary = await runWizard([fixableStep], ctx, fakeIO());
  ok(summary.results[0].outcome === "automated", 'runWizard: automate() fixes it → outcome "automated"');
  ok(summary.results[0].check.satisfied, "runWizard: the re-check after automate() reflects the fix");
  ok(summary.allSatisfied, "runWizard: summary reflects the post-automate state");
}

{
  const stubbornStep = step({
    id: "stubborn",
    automate: async () => ({ ran: true, ok: false, detail: "tried, failed" }),
  });
  const summary = await runWizard([stubbornStep], ctx, fakeIO());
  ok(summary.results[0].outcome === "guided", "runWizard: automate() ran but check() still fails → outcome stays guided, not automated");
  ok(!summary.results[0].check.satisfied, "runWizard: an ineffective automate() leaves the step unsatisfied");
}

{
  const throwingCheckStep = step({
    id: "throws-check",
    check: () => {
      throw new Error("boom");
    },
    automate: async () => ({ ran: true, ok: true, detail: "n/a" }),
  });
  const throwingAutomateStep = step({
    id: "throws-automate",
    automate: async () => {
      throw new Error("kaboom");
    },
  });
  const summary = await runWizard([throwingCheckStep, throwingAutomateStep], ctx, fakeIO());
  ok(summary.results.length === 2, "runWizard: a throwing step doesn't abort the rest of the run");
  ok(!summary.results[0].check.satisfied, "runWizard: a throwing check() is reported as unsatisfied, not a crash");
  ok(summary.results[1].outcome === "declined", "runWizard: a throwing automate() is treated as a failed/declined action, not a crash");
  ok(!!summary.results[1].automate?.detail.includes("automation failed"), "runWizard: the throw's message is captured in the automate result");
}

{
  let external = false;
  let automateInvocations = 0;
  const realWorldStep = step({
    id: "real-world",
    check: () => ({ satisfied: external, detail: external ? "present" : "absent" }),
    automate: async () => {
      automateInvocations++;
      external = true;
      return { ran: true, ok: true, detail: "set it" };
    },
  });

  const first = await runWizard([realWorldStep], ctx, fakeIO());
  ok(first.results[0].outcome === "automated", "resume: first run automates the missing piece");
  ok(automateInvocations === 1, "resume: automate() ran exactly once on the first pass");

  const second = await checkAll([realWorldStep], ctx);
  ok(second.allSatisfied, "resume: a second, independent check() sees the real-world state as already satisfied");

  const third = await runWizard([realWorldStep], ctx, fakeIO());
  ok(third.results[0].outcome === "satisfied", "resume: re-running the wizard skips an already-satisfied step");
  ok(automateInvocations === 1, "resume: automate() is NOT re-invoked once the step is satisfied");
}

function scriptedIO(confirms: boolean[], secret: string): WizardIO & { printed: string[] } {
  const printed: string[] = [];
  let ci = 0;
  return {
    printed,
    print: (line: string) => void printed.push(line),
    ask: async () => "",
    askSecret: async () => secret,
    confirm: async () => confirms[ci++] ?? false,
  };
}
const OWNER = "postgres://neondb_owner:ownerpass@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require";
{
  const dir = mkdtempSync(join(tmpdir(), "oe-dbstep-tworole-"));
  try {
    const io = scriptedIO([true, true], OWNER);
    const res = await databaseStep.automate!({ cwd: dir, env: {} }, io);
    ok(res.ran && res.ok, "databaseStep two-role: reports ran+ok");
    const envText = readFileSync(join(dir, ".env.local"), "utf-8");
    ok(/DATABASE_URL=postgres:\/\/oe_runtime:/.test(envText), "databaseStep two-role: DATABASE_URL points at the oe_runtime runtime role");
    ok(envText.includes("OE_DB_OWNER_URL=") && envText.includes("neondb_owner:ownerpass@"), "databaseStep two-role: the owner URL is parked as OE_DB_OWNER_URL");
    ok(!envText.includes("neondb_owner:ownerpass@ep-x") || envText.split("neondb_owner:ownerpass@").length === 2, "databaseStep two-role: the owner credential appears only in the parked owner var, not DATABASE_URL");
    ok(io.printed.some((l) => l.includes("CREATE ROLE oe_runtime LOGIN PASSWORD")), "databaseStep two-role: prints the CREATE ROLE provisioning SQL");
    ok(io.printed.some((l) => l.includes("shown ONCE")), "databaseStep two-role: prints the generated password once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = mkdtempSync(join(tmpdir(), "oe-dbstep-single-"));
  try {
    const res = await databaseStep.automate!({ cwd: dir2, env: {} }, scriptedIO([true, false], OWNER));
    ok(res.ran && res.ok, "databaseStep single-role: reports ran+ok");
    const envText = readFileSync(join(dir2, ".env.local"), "utf-8");
    ok(envText.includes(`DATABASE_URL=${OWNER}`), "databaseStep single-role: DATABASE_URL is the owner string");
    ok(!envText.includes("OE_DB_OWNER_URL"), "databaseStep single-role: no OE_DB_OWNER_URL parked (single-role posture)");
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }

  const dir3 = mkdtempSync(join(tmpdir(), "oe-dbstep-skip-"));
  try {
    const res = await databaseStep.automate!({ cwd: dir3, env: {} }, scriptedIO([false], ""));
    ok(!res.ran, "databaseStep skip: hosted=no does nothing (local git/sqlite backing)");
  } finally {
    rmSync(dir3, { recursive: true, force: true });
  }
}

console.log(`✓ ${n} engine assertions passed`);
