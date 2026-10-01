import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAll, runWizard, type StepContext, type WizardIO, type WizardStep } from "../src/engine.js";
import { databaseStep } from "../src/steps/database.js";
import { repoStep } from "../src/steps/repo.js";
import { rosterStep } from "../src/steps/roster.js";
import { verifyStep, verifyVerdict } from "../src/steps/verify.js";

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

{
  const linked = (projectId: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "oe-dbstep-hosted-"));
    if (projectId !== null) {
      mkdirSync(join(dir, ".vercel"), { recursive: true });
      writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ projectId }));
    }
    return dir;
  };

  const local = linked(null);
  try {
    const res = await databaseStep.check({ cwd: local, env: {}, goal: "local" });
    ok(res.satisfied, "databaseStep: unlinked checkout on the local goal stays satisfied (local runs are legitimate)");
    const hostedDefault = await databaseStep.check({ cwd: local, env: {} });
    ok(!hostedDefault.satisfied, "databaseStep: the default (hosted) goal with no database is NOT satisfied, linked or not");
    ok(/DATABASE_URL/.test(hostedDefault.detail) && /OE_OPERATIONAL_PROVIDER=postgres/.test(hostedDefault.detail), "databaseStep: …and it names each missing variable");
    ok(/Marketplace/.test(hostedDefault.next ?? ""), "databaseStep: …and carries the next action (the Vercel Marketplace Neon integration)");
  } finally {
    rmSync(local, { recursive: true, force: true });
  }

  const hosted = linked("prj_abc123");
  try {
    const res = await databaseStep.check({ cwd: hosted, env: {} });
    ok(!res.satisfied, "databaseStep: Vercel-linked checkout on git/sqlite is NOT satisfied");
    ok(/discards|ephemeral|state/i.test(res.detail), "databaseStep: the detail names the consequence, not just the missing var");
    ok(/Missing from \.env\.local and this shell/.test(res.detail) && /vercel env ls/.test(res.detail), "databaseStep: a hosted miss says the value may be set in the Vercel project instead");

    const guide = databaseStep.guide({ cwd: hosted, env: {} });
    ok(/ephemeral|wiped/i.test(guide.summary), "databaseStep: the hosted guide is now reachable and states the ephemerality");

    const allButDb = { prereq: true, repo: true, slack: true, database: false, build: true };
    const verdict = verifyVerdict(allButDb);
    ok(!verdict.satisfied, "verifyVerdict: everything satisfied EXCEPT the state backing is still not ready");
    ok(/durable state backing/.test(verdict.detail), "verifyVerdict: names the durable state backing among what is missing");
    ok(verifyVerdict({ ...allButDb, database: true }).satisfied, "verifyVerdict: flipping only the state backing makes it ready (the term is load-bearing)");

    const wired = await verifyStep.check({ cwd: hosted, env: {} });
    ok(/durable state backing/.test(wired.detail), "verifyStep: the wired check surfaces the state backing for a linked git/sqlite checkout");
  } finally {
    rmSync(hosted, { recursive: true, force: true });
  }

  const ok2 = linked("prj_abc123");
  try {
    const res = await databaseStep.check({
      cwd: ok2,
      env: { OE_MEMORY_PROVIDER: "postgres", OE_OPERATIONAL_PROVIDER: "postgres", DATABASE_URL: "postgres://u:p@h/db" },
    });
    ok(res.satisfied, "databaseStep: linked checkout with postgres + DATABASE_URL is satisfied");
  } finally {
    rmSync(ok2, { recursive: true, force: true });
  }
}

{
  const app = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "oe-repostep-"));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    }
    return dir;
  };
  const CORE_PKG = JSON.stringify({ dependencies: { "@open-everywhere/core": "^1.0.0" } });

  const thin = app({ "package.json": CORE_PKG, "agent/agent.ts": "export default {};", "node_modules/.keep": "" });
  try {
    const res = await repoStep.check({ cwd: thin, env: {} });
    ok(res.satisfied, "repoStep: a thin consumer app with no AGENTS.md is recognised");
  } finally {
    rmSync(thin, { recursive: true, force: true });
  }

  const mono = app({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "agent/agent.ts": "export default {};",
    "node_modules/.keep": "",
  });
  try {
    ok((await repoStep.check({ cwd: mono, env: {} })).satisfied, "repoStep: the workspaces monorepo shape still passes");
  } finally {
    rmSync(mono, { recursive: true, force: true });
  }

  const noEntry = app({ "package.json": CORE_PKG, "node_modules/.keep": "" });
  try {
    const res = await repoStep.check({ cwd: noEntry, env: {} });
    ok(!res.satisfied, "repoStep: a directory with no agent/agent.ts is not an OE app");
    ok(/agent\/agent\.ts/.test(res.detail), "repoStep: says which boot-critical file is missing");
  } finally {
    rmSync(noEntry, { recursive: true, force: true });
  }

  const unrelated = app({ "package.json": JSON.stringify({ dependencies: { express: "^4" } }), "agent/agent.ts": "x", "node_modules/.keep": "" });
  try {
    const res = await repoStep.check({ cwd: unrelated, env: {} });
    ok(!res.satisfied, "repoStep: a package.json that doesn't reach @open-everywhere/core is rejected");
  } finally {
    rmSync(unrelated, { recursive: true, force: true });
  }

  const noDeps = app({ "package.json": CORE_PKG, "agent/agent.ts": "export default {};" });
  try {
    const res = await repoStep.check({ cwd: noDeps, env: {} });
    ok(!res.satisfied && /npm install/.test(res.detail), "repoStep: an uninstalled app is told to run npm install");
  } finally {
    rmSync(noDeps, { recursive: true, force: true });
  }
}

{
  const scaffold = (opts: { readonly config?: boolean; readonly lock?: boolean; readonly oe?: "clean" | "drifted" }) => {
    const dir = mkdtempSync(join(tmpdir(), "oe-rosterstep-"));
    if (opts.config !== false) writeFileSync(join(dir, "roster.config.ts"), "export default {};\n");
    if (opts.lock !== false) writeFileSync(join(dir, "roster.lock.json"), "{}\n");
    if (opts.oe !== undefined) {
      const core = join(dir, "node_modules", "@open-everywhere", "core");
      const bin = join(core, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@open-everywhere/core", bin: { oe: "bin/oe.js" } }));
      writeFileSync(
        join(bin, "oe.js"),
        opts.oe === "clean"
          ? "#!/usr/bin/env node\nconsole.log('ok');\n"
          : "#!/usr/bin/env node\nconsole.error('  - DRIFTED · agent/tools/reply.ts differs from the plan');\nprocess.exit(1);\n",
        { mode: 0o755 },
      );
    }
    return dir;
  };

  const clean = scaffold({ oe: "clean" });
  try {
    const res = await rosterStep.check({ cwd: clean, env: {} });
    ok(res.satisfied, "rosterStep: a materialised tree that matches the declaration is satisfied");
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }

  const drifted = scaffold({ oe: "drifted" });
  try {
    const before = await rosterStep.check({ cwd: drifted, env: {} });
    ok(!before.satisfied, "rosterStep: a tree that differs from the declaration leaves the step unsatisfied");
    ok(/DRIFTED/.test(before.detail), "rosterStep: the detail carries the CLI's own red");
    const auto = await rosterStep.automate!({ cwd: drifted, env: {} }, fakeIO());
    ok(auto.ran && !auto.ok, "rosterStep: automate() ran the build and reported the still-failing re-check honestly");
  } finally {
    rmSync(drifted, { recursive: true, force: true });
  }

  const noConfig = scaffold({ config: false, oe: "clean" });
  try {
    const res = await rosterStep.check({ cwd: noConfig, env: {} });
    ok(!res.satisfied, "rosterStep: a checkout with no roster.config.ts is UNSATISFIED, not vacuously clean");
    ok(/roster\.config\.ts/.test(res.detail), "rosterStep: says which file is missing");
    const auto = await rosterStep.automate!({ cwd: noConfig, env: {} }, fakeIO());
    ok(!auto.ran, "rosterStep: automate() refuses to run anything it cannot justify");
  } finally {
    rmSync(noConfig, { recursive: true, force: true });
  }

  const noLock = scaffold({ lock: false, oe: "clean" });
  try {
    const res = await rosterStep.check({ cwd: noLock, env: {} });
    ok(!res.satisfied, "rosterStep: a checkout with no roster.lock.json has reviewed nothing and is UNSATISFIED");
    ok(/REVIEWED/.test(res.detail), "rosterStep: names the property that is missing, not just the file");
  } finally {
    rmSync(noLock, { recursive: true, force: true });
  }

  const noBin = scaffold({});
  try {
    const res = await rosterStep.check({ cwd: noBin, env: {} });
    ok(!res.satisfied, "rosterStep: with no `oe` CLI the step is UNKNOWN, never clean");
    ok(/npm install/.test(res.detail), "rosterStep: says what to do about it");
  } finally {
    rmSync(noBin, { recursive: true, force: true });
  }
}

{
  const { buildDeployStep } = await import("../src/steps/build-deploy.js");
  const { slackStep } = await import("../src/steps/slack.js");
  const { vercelStep } = await import("../src/steps/vercel.js");
  const { telemetryDisclosureStep } = await import("../src/steps/telemetry-disclosure.js");
  const { envChecklistStep } = await import("../src/steps/env-checklist.js");
  const { nodeVerdict } = await import("../src/steps/prerequisites.js");
  const { probeDeployment, normalizeHost, DEPLOY_PROBE_PATH } = await import("../src/deploy-probe.js");
  const { createServer } = await import("node:http");
  const { HOSTED_MISS_NOTE } = await import("../src/env-file.js");
  const envLocalDetailHasNote = (r: { detail: string }): boolean => r.detail.includes(HOSTED_MISS_NOTE);

  const dir = mkdtempSync(join(tmpdir(), "oe-goal-"));
  try {
    const vHosted = await vercelStep.check({ cwd: dir, env: {} });
    ok(!vHosted.satisfied && vHosted.next === "npx vercel link", "vercelStep: hosted + unlinked is unsatisfied, next = `npx vercel link`");
    ok((await vercelStep.check({ cwd: dir, env: {}, goal: "local" })).satisfied, "vercelStep: the local goal needs no Vercel project (negative control)");

    const sNone = await slackStep.check({ cwd: dir, env: {} });
    ok(!sNone.satisfied && /SLACK_BOT_TOKEN/.test(sNone.detail) && /SLACK_SIGNING_SECRET/.test(sNone.detail), "slackStep: names both missing variables");
    const sOne = await slackStep.check({ cwd: dir, env: { SLACK_BOT_TOKEN: "x" } });
    ok(!sOne.satisfied && /SLACK_SIGNING_SECRET/.test(sOne.detail) && !/SLACK_BOT_TOKEN/.test(sOne.detail), "slackStep: …and only the one still missing");
    ok(typeof sOne.next === "string" && sOne.next.length > 0, "slackStep: …with a next action");
    ok((await slackStep.check({ cwd: dir, env: {}, goal: "local" })).satisfied, "slackStep: optional on the local goal");
    ok((await slackStep.check({ cwd: dir, env: { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" } })).satisfied, "slackStep: satisfied once both are set (negative control)");

    ok(sNone.detail.includes(HOSTED_MISS_NOTE), "slackStep: a hosted miss says the value may be set in the Vercel project instead");
    ok(!envLocalDetailHasNote(await envChecklistStep.check({ cwd: dir, env: {}, goal: "local" })), "envChecklist: a local miss carries no Vercel note");
    ok(envLocalDetailHasNote(await envChecklistStep.check({ cwd: dir, env: {} })), "envChecklist: a hosted miss carries the Vercel note");

    const manifestIn = (lines: readonly string[]): { display_information: { name: string } } =>
      JSON.parse(lines.find((l) => l.trimStart().startsWith("{")) ?? "{}");
    ok(manifestIn(slackStep.guide({ cwd: dir, env: {} }).instructions).display_information.name === "Open Everywhere", "slackStep guide: the default app name");
    ok(
      manifestIn(slackStep.guide({ cwd: dir, env: {}, appName: "Acme Agent" }).instructions).display_information.name === "Acme Agent",
      "slackStep guide: --app-name names the app in the printed manifest",
    );

    const tel = await telemetryDisclosureStep.check({ cwd: dir, env: {} });
    ok(!tel.satisfied && /--decline-telemetry/.test(tel.next ?? "") && /terminal/.test(tel.next ?? ""), "telemetry step: next names the terminal prompt AND the --decline-telemetry flag");

    const envHosted = await envChecklistStep.check({ cwd: dir, env: {} });
    ok(!envHosted.satisfied && !/AI_GATEWAY_API_KEY/.test(envHosted.detail) && /OE_OPERATIONAL_PROVIDER/.test(envHosted.detail), "envChecklist: hosted asks for the store selectors, not a gateway key");
    const envLocal = await envChecklistStep.check({ cwd: dir, env: {}, goal: "local" });
    ok(!envLocal.satisfied && /AI_GATEWAY_API_KEY/.test(envLocal.detail) && !/OE_OPERATIONAL_PROVIDER/.test(envLocal.detail), "envChecklist: local asks for the gateway key, not the selectors");

    ok(!nodeVerdict("20.11.0", ">=24").ok && nodeVerdict("24.19.0", ">=24").ok, "prerequisites: Node is judged against the engines range");
    ok(!nodeVerdict("24.19.0", undefined).ok, "prerequisites: an unreadable range is never a pass");

    ok((await buildDeployStep.check({ cwd: dir, env: {}, goal: "local" })).satisfied, "buildDeploy: satisfied on the local goal (npm run dev builds the tree)");
    const unbuilt = await buildDeployStep.check({ cwd: dir, env: {} });
    ok(!unbuilt.satisfied && unbuilt.next === "npm run build", "buildDeploy: hosted + no build → next = `npm run build`");
    mkdirSync(join(dir, ".output"), { recursive: true });
    writeFileSync(join(dir, ".output", "x"), "built");
    const noHost = await buildDeployStep.check({ cwd: dir, env: {} });
    ok(!noHost.satisfied, "buildDeploy: a build directory alone NEVER satisfies the hosted goal");
    ok(/--host/.test(noHost.next ?? "") && /vercel deploy --prod/.test(noHost.next ?? ""), "buildDeploy: …and next says deploy, then re-run with --host");

    let mode: "slack" | "protected" | "missing" | "broken" = "slack";
    let seen: { method?: string; url?: string } = {};
    const server = createServer((req, res) => {
      seen = { method: req.method, url: req.url };
      if (mode === "slack") res.writeHead(401).end("unauthorized");
      else if (mode === "protected") res.writeHead(401, { "content-type": "text/html" }).end("<html>Authentication Required</html>");
      else if (mode === "missing") res.writeHead(404).end("not found");
      else res.writeHead(500).end("boom");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const up = await buildDeployStep.check({ cwd: dir, env: {}, host: origin });
      ok(up.satisfied, "buildDeploy: a deployment whose Slack route answers 401 unauthorized satisfies the hosted goal");
      ok(/does NOT prove the deployment holds SLACK_SIGNING_SECRET/.test(up.detail) && /Verified/.test(up.detail), "buildDeploy: …and the pass says it does not prove SLACK_SIGNING_SECRET, naming Slack's Verified as the check that does");
      ok(seen.method === "POST" && seen.url === DEPLOY_PROBE_PATH, "probe: one unsigned POST to the Slack route");
      mode = "protected";
      const prot = await probeDeployment(origin);
      ok(!prot.ok && /Deployment Protection/.test(prot.detail), "probe: a 401 that is not the Slack route's (Vercel Deployment Protection) is NOT a pass");
      mode = "missing";
      ok(!(await probeDeployment(origin)).ok, "probe: 404 is not a pass");
      mode = "broken";
      const broken = await probeDeployment(origin);
      ok(!broken.ok && /500/.test(broken.detail), "probe: 5xx is not a pass, and says so");
      const viaEnv = await buildDeployStep.check({ cwd: dir, env: { OE_PUBLIC_BASE_URL: origin } });
      ok(!viaEnv.satisfied && /500/.test(viaEnv.detail), "buildDeploy: OE_PUBLIC_BASE_URL is the host when --host is absent");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    {
      let hits = 0;
      let script: ("500" | "hang" | "401" | "404")[] = [];
      const held: import("node:http").ServerResponse[] = [];
      const cold = createServer((_req, res) => {
        const step = script[hits++] ?? "401";
        if (step === "500") res.writeHead(500).end("boom");
        else if (step === "hang") held.push(res);
        else if (step === "404") res.writeHead(404).end("not found");
        else res.writeHead(401).end("unauthorized");
      });
      await new Promise<void>((r) => cold.listen(0, "127.0.0.1", r));
      const coldOrigin = `http://127.0.0.1:${(cold.address() as { port: number }).port}`;
      const run = async (steps: typeof script) => {
        hits = 0;
        script = steps;
        return probeDeployment(coldOrigin, fetch, 300, 3000);
      };
      try {
        const after500 = await run(["500", "401"]);
        ok(after500.ok && hits === 2, "probe: a 5xx then 401 passes on the one retry");
        ok(/^cold start: the first request got 500/.test(after500.detail), "probe: …and says cold start, naming the first failure");
        const afterHang = await run(["hang", "401"]);
        ok(afterHang.ok && hits === 2 && /^cold start: the first request got no answer/.test(afterHang.detail), "probe: a timeout then 401 passes on the retry, as a cold start");
        const twice = await run(["500", "500"]);
        ok(!twice.ok && hits === 2 && /after one retry/.test(twice.detail), "probe: two 5xx fail, and say a retry ran");
        const notFound = await run(["404", "401"]);
        ok(!notFound.ok && hits === 1, "probe: a 404 is never retried (negative control: a second request cannot fix it)");
        const warm = await run(["401"]);
        ok(warm.ok && hits === 1 && !/cold start/.test(warm.detail), "probe: a first-try pass makes one request and claims no cold start");
      } finally {
        for (const r of held) r.destroy();
        cold.closeAllConnections();
        await new Promise<void>((r) => cold.close(() => r()));
      }
    }
    ok(!(await probeDeployment("http://127.0.0.1:9", fetch, 2000, 2000)).ok, "probe: an unreachable host is not a pass");
    ok(normalizeHost("my-agent.vercel.app/") === "https://my-agent.vercel.app", "normalizeHost: a bare host gets https and loses the path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { quickstartPlan } = await import("@open-everywhere/core/agent/ops/quickstart.js");
  const { registerSlackOps } = await import("@open-everywhere/provider-slack/agent/ops.js");
  registerSlackOps();
  const plan = quickstartPlan("deploy", {});
  const ids = plan.steps.map((s) => s.id);
  ok(ids.includes("slack") && ids.indexOf("slack") < ids.indexOf("env-push"), "deploy plan (real Slack arm): the Slack app step comes before the env push");
  ok(ids.indexOf("slack-urls") > ids.indexOf("deploy") && ids.indexOf("slack-urls") < ids.indexOf("verify"), "deploy plan (real Slack arm): pointing Slack at the host comes after the deploy, before the proof");
  ok(/Retry/.test(plan.steps.find((s) => s.id === "slack-urls")?.detail ?? ""), "deploy plan: the Slack URL step says verification fails until the deploy is up, and to retry");
  const slackStepDetail = plan.steps.find((s) => s.id === "slack")?.detail ?? "";
  ok(/Missing: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET/.test(slackStepDetail), "deploy plan: the Slack step names the missing variables");

  const pushLines = (plan.steps.find((s) => s.id === "env-push")?.command ?? "").split("\n");
  ok(pushLines.some((l) => l.includes("SLACK_BOT_TOKEN")) && pushLines.some((l) => l.includes("SLACK_SIGNING_SECRET")), "deploy plan: the env push carries the Slack variables");
  const templateDir = fileURLToPath(new URL("../template/", import.meta.url));
  const readme = readFileSync(join(templateDir, "README.md"), "utf8");
  const skill = readFileSync(join(templateDir, "claude", "skills", "quickstart-open-everywhere", "SKILL.md"), "utf8");
  for (const line of pushLines) {
    ok(readme.includes(line), `README carries the plan's push command verbatim: ${line.split(" | ")[0]}`);
    const name = /vercel env add (\S+) production/.exec(line)?.[1] ?? "";
    ok(name.length > 0 && skill.includes(name), `the skill names ${name}`);
  }
  for (const absent of ["AI_GATEWAY_API_KEY production", "deploy:verify", "OE_VERCEL_API_TOKEN"]) {
    ok(!pushLines.join("\n").includes(absent) && !readme.includes(`vercel env add ${absent}`), `neither the plan nor the README pushes or runs "${absent}"`);
  }
  const order = ["vercel link", "Storage → Neon", "OE_CREDENTIAL_ENCRYPTION_KEY=", "Create New App", "Vouch your workspace", "admins:", "npm run build", "env:pipe", "vercel deploy --prod", "App Manifest", "--check --host"];
  const at = order.map((needle) => readme.indexOf(needle, readme.indexOf("## Deploy to Vercel with Slack")));
  ok(at.every((i) => i > 0), "README: every hosted step is present");
  ok(at.every((i, k) => k === 0 || at[k - 1]! < i), "README: …in the plan's order (link → Neon → key → Slack app → trust → build → env → deploy → Slack URLs → check)");
}

console.log(`✓ ${n} engine assertions passed`);
